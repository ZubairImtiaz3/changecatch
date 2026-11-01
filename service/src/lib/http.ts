// Shared HTTP helper for all HubSpot calls.
// - Every call goes through the shared rate limiter (./rate-limiter.ts):
//     portal OAuth token  -> that portal's bucket (100 / 10 s by default)
//     /webhooks-journal/journal/...       -> 'journal' bucket (80/s)
//     /webhooks-journal/subscriptions/... -> 'subscriptions' bucket (50/s HubSpot, 40/s here)
//     /oauth/... token calls, presigned file downloads, unknown tokens -> not limited
// - Request timeout per attempt (HTTP_TIMEOUT_MS, default 20 s). A timeout is retried like a network error.
// - 429: honours Retry-After AND pauses that bucket for the same time, so only that portal (or app-level stream)
//   waits; other portals continue. For a PORTAL call, if the wait is longer than HS_PORTAL_MAX_WAIT_MS
//   (default 10 s) we do not wait inline: we throw RetryLaterError (an HttpError with status 429 and
//   retryAfterMs), so a serial worker loop is never stuck behind one throttled portal.
// - 5xx / network / timeout: retried with exponential backoff.
// - Never logs tokens: only method, path and status (structured logger, component "http").
// - Metrics: NOT counted here. src/obs/wiring.ts instrumentFetch() wraps fetch and counts every attempt,
//   so adding counters here would double count.

import { createLogger, type Logger } from '../obs/log.js';
import { getRateLimiter, keyName, portalIdForToken, RateLimitWaitError, type RateKey } from './rate-limiter.js';

export const HUBSPOT_API = 'https://api.hubapi.com';
const HUBSPOT_HOSTS = new Set(['api.hubapi.com', 'api.hubspot.com']);

export interface RequestOpts {
  method?: string;
  token?: string; // bearer token (client-credentials OR customer OAuth; caller decides)
  body?: unknown;
  form?: Record<string, string>; // x-www-form-urlencoded body
  query?: Record<string, string | number | boolean | undefined>;
  retries?: number;
  /** Per-attempt timeout. Default HTTP_TIMEOUT_MS or 20 000. */
  timeoutMs?: number;
  /** Force a bucket. Default: derived from the path / token (see top of file). 'none' = not limited. */
  rateKey?: RateKey | 'none';
  /** Shortcut for rateKey: { portalId }. */
  portalId?: number;
  /** Portal calls only: longest we wait inline for a slot or a 429 pause before throwing RetryLaterError. */
  maxWaitMs?: number;
}

export class HttpError extends Error {
  constructor(public status: number, public body: unknown, msg: string) {
    super(msg);
  }
}

/**
 * A portal is rate limited (HubSpot 429, or our own limiter is full) for longer than we wait inline.
 * status is 429 so existing "retry later" handling (stamp queue, poller) applies. Use retryAfterMs as the defer time.
 */
export class RetryLaterError extends HttpError {
  constructor(public readonly retryAfterMs: number, body: unknown, msg: string) {
    super(429, body, msg);
    this.name = 'RetryLaterError';
  }
}

export class TimeoutError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TimeoutError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let log: Logger = createLogger('http');
/** Swap the http logger (tests). Returns a function that restores the previous one. */
export function setHttpLogger(l: Logger): () => void {
  const prev = log;
  log = l;
  return () => {
    log = prev;
  };
}

function envMs(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Retry-After is seconds or an HTTP date. Returns ms, or undefined. */
export function parseRetryAfter(v: string | null, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - now) : undefined;
}

/** Which limiter bucket a request uses, or null for none. */
export function rateKeyFor(url: URL, opts: Pick<RequestOpts, 'rateKey' | 'portalId' | 'token'>): RateKey | null {
  if (opts.rateKey === 'none') return null;
  if (opts.rateKey) return opts.rateKey;
  if (opts.portalId !== undefined) return { portalId: opts.portalId };
  if (!HUBSPOT_HOSTS.has(url.host)) return null; // presigned journal files etc.
  const p = url.pathname;
  if (p.startsWith('/webhooks-journal/journal/')) return 'journal';
  if (p.startsWith('/webhooks-journal/subscriptions/')) return 'subscriptions';
  if (p.startsWith('/oauth/')) return null;
  const portalId = portalIdForToken(opts.token);
  return portalId !== undefined ? { portalId } : null;
}

export async function hsRequest<T = any>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { method = 'GET', token, body, form, query, retries = 4 } = opts;
  const url = new URL(path.startsWith('http') ? path : HUBSPOT_API + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const timeoutMs = opts.timeoutMs ?? envMs('HTTP_TIMEOUT_MS', 20_000);
  const key = rateKeyFor(url, opts);
  const isPortal = key !== null && typeof key !== 'string';
  const maxWaitMs = isPortal ? (opts.maxWaitMs ?? envMs('HS_PORTAL_MAX_WAIT_MS', 10_000)) : undefined;
  const limiter = getRateLimiter();

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: string | undefined;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  for (let attempt = 0; ; attempt++) {
    if (key) {
      try {
        await limiter.acquire(key, { maxWaitMs });
      } catch (e) {
        if (e instanceof RateLimitWaitError)
          throw new RetryLaterError(e.waitMs, undefined, `${method} ${url.pathname}: ${e.message}`);
        throw e;
      }
    }

    let res: Response;
    let text: string;
    try {
      // The signal also covers reading the body.
      const signal = AbortSignal.timeout(timeoutMs);
      res = await fetch(url, { method, headers, body: payload, signal });
      text = await res.text();
    } catch (e) {
      // Network-level failure (DNS, reset) or our timeout: retry with backoff. Seen live as "fetch failed".
      const timedOut = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
      const err = timedOut ? new TimeoutError(`${method} ${url.pathname} timed out after ${timeoutMs}ms`) : (e as Error);
      if (attempt >= retries) throw err;
      const wait = Math.min(30_000, 500 * 2 ** attempt);
      log.warn(
        'http_retry',
        `${method} ${url.pathname} -> ${timedOut ? 'timeout' : `network error (${err.message})`}, retry in ${wait}ms`,
        { method, path: url.pathname, reason: timedOut ? 'timeout' : 'network', attempt: attempt + 1, retryInMs: wait },
      );
      await sleep(wait);
      continue;
    }
    let data: any = text;
    try { data = text ? JSON.parse(text) : undefined; } catch { /* keep raw text */ }

    if (res.ok) return data as T;
    const errMsg = `${method} ${url.pathname} failed with ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`;

    if (res.status === 429) {
      const wait = parseRetryAfter(res.headers.get('retry-after')) ?? Math.min(30_000, 1000 * 2 ** attempt);
      if (key) limiter.pause(key, wait); // only this bucket waits; other portals keep going
      if (attempt >= retries) throw isPortal ? new RetryLaterError(wait, data, errMsg) : new HttpError(429, data, errMsg);
      if (isPortal && maxWaitMs !== undefined && wait > maxWaitMs) throw new RetryLaterError(wait, data, errMsg);
      log.warn('http_retry', `${method} ${url.pathname} -> 429 (${key ? keyName(key) : 'unlimited'}), retry in ${wait}ms`, {
        method, path: url.pathname, status: 429, reason: 'rate_limited', bucket: key ? keyName(key) : 'unlimited',
        ...(isPortal ? { portalId: (key as { portalId: number }).portalId } : {}), attempt: attempt + 1, retryInMs: wait,
      });
      if (!key) await sleep(wait); // with a key, the next acquire() waits for the pause
      continue;
    }
    if (res.status >= 500 && attempt < retries) {
      const wait = Math.min(30_000, 500 * 2 ** attempt);
      log.warn('http_retry', `${method} ${url.pathname} -> ${res.status}, retry in ${wait}ms`, {
        method, path: url.pathname, status: res.status, reason: 'server_error', attempt: attempt + 1, retryInMs: wait,
      });
      await sleep(wait);
      continue;
    }
    throw new HttpError(res.status, data, errMsg);
  }
}
