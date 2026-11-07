// Shared rate limiter for every HubSpot call (marketplace apps get 110 requests / 10 s per installed account).
//
// Buckets:
//   - one per installed portal, for every call made with that portal's OAuth token
//     (stamping, property create/update/option sync, label reads, object-type reads, installer calls).
//     HubSpot limit for marketplace OAuth apps: 110 requests / 10 s PER INSTALLED ACCOUNT.
//     Here: 100 / 10 s (HS_PORTAL_RATE_PER_10S) to leave headroom.
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
// Which bucket a request uses is decided in src/lib/http.ts hsRequest: the call's portalId, else its app bucket
// (hubspot/journal.ts passes 'journal' or 'subscriptions'), else none.

/** App-level rate bucket of a journal-family call (hubspot/journal.ts passes it as RequestOpts.bucket). */
export type AppBucket = 'journal' | 'subscriptions';

export type RateKey = { portalId: number } | AppBucket;

interface BucketConfig {
  limit: number;
  windowMs: number;
}

interface Waiter {
  resolve: () => void;
}

/** Live buckets: app-level ones by name ("journal", "subscriptions"), portal ones by portal id. */
export interface RateLimiterStats {
  app: Record<string, BucketStats>;
  portals: Record<number, BucketStats>;
}

interface Bucket {
  cfg: BucketConfig;
  /** Set for a portal bucket. */
  portalId?: number;
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

/** Requests per 10 s per installed portal (HubSpot's limit is 110). */
export const HS_PORTAL_RATE_PER_10S = 100;
/** HubSpot's per-portal window: requests per 10 s. */
const PORTAL_WINDOW_MS = 10_000;

export function keyName(key: RateKey): string {
  return typeof key === 'string' ? key : `portal:${key.portalId}`;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly portalCfg: BucketConfig;
  private readonly appCfg: Record<AppBucket, BucketConfig> = {
    journal: { limit: 80, windowMs: 1_000 },
    subscriptions: { limit: 40, windowMs: 1_000 },
  };
  private acquires = 0;

  /** `portalRatePer10s` = requests per 10 s per portal (HS_PORTAL_RATE_PER_10S). */
  constructor(portalRatePer10s: number = HS_PORTAL_RATE_PER_10S) {
    this.portalCfg = { limit: portalRatePer10s, windowMs: PORTAL_WINDOW_MS };
  }

  /** Wait for a slot in this key's bucket. Resolves in FIFO order per key. */
  acquire(key: RateKey): Promise<void> {
    if (++this.acquires % 1000 === 0) this.sweep();
    const b = this.bucket(key);
    return new Promise<void>((resolve) => {
      b.waiters.push({ resolve });
      this.pump(b);
    });
  }

  /** About how long a new acquire() for this key would wait (0 = a slot is free now). */
  waitMs(key: RateKey): number {
    return this.estimateWaitMs(this.bucket(key));
  }

  /** Stop admitting calls for this key for `ms` (after a 429). Other keys are not affected. */
  pause(key: RateKey, ms: number): void {
    const b = this.bucket(key);
    b.pausedUntil = Math.max(b.pausedUntil, Date.now() + ms);
    this.pump(b);
  }

  /** Snapshot of every live bucket. */
  stats(): RateLimiterStats {
    const now = Date.now();
    const out: RateLimiterStats = { app: {}, portals: {} };
    for (const [k, b] of this.buckets) {
      this.trim(b, now);
      const target: Record<string | number, BucketStats> = b.portalId === undefined ? out.app : out.portals;
      target[b.portalId ?? k] = {
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
      b = { cfg, starts: [], waiters: [], pausedUntil: 0, ...(typeof key === 'string' ? {} : { portalId: key.portalId }) };
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
    const now = Date.now();
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
      const now = Date.now();
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
    }, Math.max(1, at - Date.now()));
    b.timer.unref?.();
  }

  /** Drop idle buckets (no queue, nothing in the window, not paused) so 1000s of portals don't pile up. */
  private sweep(): void {
    const now = Date.now();
    for (const [k, b] of this.buckets) {
      this.trim(b, now);
      if (!b.waiters.length && !b.starts.length && b.pausedUntil <= now && !b.timer) this.buckets.delete(k);
    }
  }
}

// ---------- process-wide instance ----------

let shared: RateLimiter | undefined;

/** The process-wide limiter. Throws if configureHttp (lib/process.ts startProcess) was not called. */
export function getRateLimiter(): RateLimiter {
  if (!shared) throw new Error('rate limiter not configured: call startProcess (lib/process.ts) or configureHttp first');
  return shared;
}

/** Replace the process-wide limiter: only configureHttp (lib/http.ts) calls this. */
export function setRateLimiter(limiter: RateLimiter): void {
  shared = limiter;
}
