// Shared rate limiter for every HubSpot call (marketplace apps get 110 requests / 10 s per installed account).
//
// Buckets:
//   - one per installed portal, for every call made with that portal's OAuth token
//     (stamping, property create/update/option sync, label reads, object-type reads, installer calls).
//     HubSpot limit for marketplace OAuth apps: 110 requests / 10 s PER INSTALLED ACCOUNT.
//     Default here: 100 / 10 s (HS_PORTAL_RATE_PER_10S) to leave headroom.
//   - 'journal'       : Webhooks Journal reads (client-credentials token). HubSpot: 100 req/s per app. We use 80/s.
//   - 'subscriptions' : journal subscription management. HubSpot: 50 req/s per app. We use 40/s.
//   Source: https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines
//           https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/guide
//
// Algorithm: a SLIDING WINDOW (at most `limit` request starts in any trailing `windowMs`), not a refilling
// token bucket. A token bucket with capacity C and refill C/window can start up to 2C requests inside one window
// (a full burst plus the refill), which would break HubSpot's 110/10 s rule. The sliding window cannot.
//
// IN-PROCESS ONLY. We run one machine; the worker and the app server are separate processes on it, and each has
// its own limiter. The app server makes very few portal calls (install, settings page), which the 10% headroom
// covers. If we ever run more than one worker process, this must move to a shared store (e.g. SQLite/Redis).
//
// Fairness: each bucket has its own FIFO queue and its own timer, so a throttled portal (full window, or paused
// after a 429) never delays another portal's calls.
//
// Which bucket a request uses is decided in src/lib/http.ts. For portal calls it looks the bearer token up in the
// token registry below; token providers call registerPortalToken() whenever they hand out a new access token.

export type RateKey = { portalId: number } | 'journal' | 'subscriptions';

export interface BucketConfig {
  limit: number;
  windowMs: number;
}

export interface RateLimiterOptions {
  portal?: BucketConfig;
  journal?: BucketConfig;
  subscriptions?: BucketConfig;
  now?: () => number;
}

/** Thrown by acquire() when the caller would wait longer than maxWaitMs. Nothing was queued. */
export class RateLimitWaitError extends Error {
  constructor(public readonly key: string, public readonly waitMs: number) {
    super(`rate limit: ${key} is throttled for about ${Math.ceil(waitMs / 1000)}s`);
    this.name = 'RateLimitWaitError';
  }
}

interface Waiter {
  resolve: () => void;
}

interface Bucket {
  cfg: BucketConfig;
  /** Start times inside the current window, oldest first. */
  starts: number[];
  waiters: Waiter[];
  pausedUntil: number;
  timer?: ReturnType<typeof setTimeout>;
  timerAt?: number;
}

export interface BucketStats {
  queued: number;
  inWindow: number;
  limit: number;
  windowMs: number;
  pausedForMs: number;
}

function numEnv(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function keyName(key: RateKey): string {
  return typeof key === 'string' ? key : `portal:${key.portalId}`;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly portalCfg: BucketConfig;
  private readonly appCfg: Record<'journal' | 'subscriptions', BucketConfig>;
  private readonly now: () => number;
  private acquires = 0;

  constructor(opts: RateLimiterOptions = {}) {
    this.portalCfg = opts.portal ?? { limit: numEnv('HS_PORTAL_RATE_PER_10S') ?? 100, windowMs: 10_000 };
    this.appCfg = {
      journal: opts.journal ?? { limit: 80, windowMs: 1_000 },
      subscriptions: opts.subscriptions ?? { limit: 40, windowMs: 1_000 },
    };
    this.now = opts.now ?? Date.now;
  }

  /**
   * Wait for a slot in this key's bucket. Resolves in FIFO order per key.
   * maxWaitMs: if the estimated wait is longer, throw RateLimitWaitError at once instead of queueing.
   */
  acquire(key: RateKey, opts: { maxWaitMs?: number } = {}): Promise<void> {
    if (++this.acquires % 1000 === 0) this.sweep();
    const b = this.bucket(key);
    if (opts.maxWaitMs !== undefined) {
      const wait = this.estimateWaitMs(b);
      if (wait > opts.maxWaitMs) return Promise.reject(new RateLimitWaitError(keyName(key), wait));
    }
    return new Promise<void>((resolve) => {
      b.waiters.push({ resolve });
      this.pump(b);
    });
  }

  /** Stop admitting calls for this key for `ms` (after a 429). Other keys are not affected. */
  pause(key: RateKey, ms: number): void {
    const b = this.bucket(key);
    b.pausedUntil = Math.max(b.pausedUntil, this.now() + ms);
    this.pump(b);
  }

  /** Estimated wait (ms) for a new call on this key right now. */
  waitMs(key: RateKey): number {
    return this.estimateWaitMs(this.bucket(key));
  }

  /** Calls waiting for a slot for this portal (for /health). */
  queueDepth(portalId: number): number {
    return this.buckets.get(keyName({ portalId }))?.waiters.length ?? 0;
  }

  /** Snapshot of every live bucket, keyed by "portal:<id>", "journal", "subscriptions". */
  stats(): Record<string, BucketStats> {
    const now = this.now();
    const out: Record<string, BucketStats> = {};
    for (const [k, b] of this.buckets) {
      this.trim(b, now);
      out[k] = {
        queued: b.waiters.length,
        inWindow: b.starts.length,
        limit: b.cfg.limit,
        windowMs: b.cfg.windowMs,
        pausedForMs: Math.max(0, b.pausedUntil - now),
      };
    }
    return out;
  }

  private bucket(key: RateKey): Bucket {
    const k = keyName(key);
    let b = this.buckets.get(k);
    if (!b) {
      const cfg = typeof key === 'string' ? this.appCfg[key] : this.portalCfg;
      b = { cfg, starts: [], waiters: [], pausedUntil: 0 };
      this.buckets.set(k, b);
    }
    return b;
  }

  private trim(b: Bucket, now: number): void {
    const cutoff = now - b.cfg.windowMs;
    let i = 0;
    while (i < b.starts.length && b.starts[i] <= cutoff) i++;
    if (i) b.starts.splice(0, i);
  }

  private estimateWaitMs(b: Bucket): number {
    const now = this.now();
    this.trim(b, now);
    const paused = Math.max(0, b.pausedUntil - now);
    const pos = b.starts.length + b.waiters.length; // slots taken before us
    if (pos < b.cfg.limit) return paused;
    const over = pos - b.cfg.limit;
    const slot =
      over < b.starts.length
        ? b.starts[over] + b.cfg.windowMs - now
        : b.cfg.windowMs * (1 + Math.floor((over - b.starts.length) / b.cfg.limit));
    return Math.max(paused, slot);
  }

  private pump(b: Bucket): void {
    while (b.waiters.length) {
      const now = this.now();
      this.trim(b, now);
      if (b.pausedUntil > now) return this.wake(b, b.pausedUntil);
      if (b.starts.length >= b.cfg.limit) return this.wake(b, b.starts[0] + b.cfg.windowMs);
      b.starts.push(now);
      b.waiters.shift()!.resolve();
    }
  }

  private wake(b: Bucket, at: number): void {
    if (b.timer && b.timerAt !== undefined && b.timerAt <= at) return; // an earlier (or same) wake-up is set
    if (b.timer) clearTimeout(b.timer);
    b.timerAt = at;
    b.timer = setTimeout(() => {
      b.timer = undefined;
      b.timerAt = undefined;
      this.pump(b);
    }, Math.max(1, at - this.now()));
    b.timer.unref?.();
  }

  /** Drop idle buckets (no queue, nothing in the window, not paused) so 1000s of portals don't pile up. */
  private sweep(): void {
    const now = this.now();
    for (const [k, b] of this.buckets) {
      this.trim(b, now);
      if (!b.waiters.length && !b.starts.length && b.pausedUntil <= now && !b.timer) this.buckets.delete(k);
    }
  }
}

// ---------- process-wide instance ----------

let shared: RateLimiter | undefined;

export function getRateLimiter(): RateLimiter {
  return (shared ??= new RateLimiter());
}

/** Replace the shared limiter (tests, or a custom config at startup). */
export function setRateLimiter(l: RateLimiter): void {
  shared = l;
}

/** Calls waiting for a slot for this portal. For /health. */
export function portalQueueDepth(portalId: number): number {
  return getRateLimiter().queueDepth(portalId);
}

/** All buckets (portal + app-level). For /health. */
export function rateLimiterStats(): Record<string, BucketStats> {
  return getRateLimiter().stats();
}

// ---------- token -> portal registry ----------
// Lets http.ts put a call into the right portal bucket without every function taking a portalId.
// Keeps the last few tokens per portal (an old one can still be in flight just after a refresh).

const KEEP_TOKENS_PER_PORTAL = 3;
const tokenToPortal = new Map<string, number>();
const portalTokens = new Map<number, string[]>();

export function registerPortalToken(token: string, portalId: number): void {
  if (!token || tokenToPortal.get(token) === portalId) return;
  tokenToPortal.set(token, portalId);
  const list = portalTokens.get(portalId) ?? [];
  list.push(token);
  while (list.length > KEEP_TOKENS_PER_PORTAL) tokenToPortal.delete(list.shift()!);
  portalTokens.set(portalId, list);
}

export function portalIdForToken(token: string | undefined): number | undefined {
  return token ? tokenToPortal.get(token) : undefined;
}

/** On uninstall. */
export function forgetPortalTokens(portalId: number): void {
  for (const t of portalTokens.get(portalId) ?? []) tokenToPortal.delete(t);
  portalTokens.delete(portalId);
}
