// The one way out to HubSpot: every API call (hsRequest), and hsFetch for the journal file download
// (hubspot/journal.ts downloadJournalFile). Buckets and HubSpot's limits: src/lib/rate-limiter.ts.
// - 429: honours Retry-After AND pauses that bucket for the same time, so only that portal (or app-level stream)
//   waits; other portals continue. A PORTAL call that would wait longer than HS_PORTAL_MAX_WAIT_MS throws
//   HubSpotError 'throttled' instead, so a serial worker loop is never stuck behind one throttled portal.
// - Every failure is a HubSpotError with a `kind`. Callers check the kind, never the message text.
// - Never logs tokens: only method, path and status.

import { createLogger, type Logger } from '../obs/log.js';
import type { ApiFamily, ChangeCatchMetrics } from '../obs/metrics.js';
import { backoffMs } from './backoff.js';
import { getRateLimiter, keyName, RateLimiter, setRateLimiter, type AppBucket, type RateKey } from './rate-limiter.js';

/** Date-based API version for every HubSpot endpoint we call. Never v4 / OAuth v1 (CLAUDE.md, fixed constraints). */
export const HUBSPOT_API_VERSION = '2026-09';
const HUBSPOT_API = 'https://api.hubapi.com';
// The token docs' curl examples use host api.hubspot.com (checked 2026-11-07):
// https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens
export const HUBSPOT_TOKEN_URL = `https://api.hubspot.com/oauth/${HUBSPOT_API_VERSION}/token`;

const HUBSPOT_HOSTS = new Set(['api.hubapi.com', 'api.hubspot.com']);

/** Metrics `api` label of a call without an app bucket, or null when the host is not HubSpot (not counted). */
function apiOf(url: URL): ApiFamily | null {
  if (!HUBSPOT_HOSTS.has(url.host)) return null;
  if (url.pathname.startsWith('/oauth/')) return 'oauth';
  if (url.pathname.startsWith('/crm/')) return 'crm';
  return 'other';
}

// ---------------------------------------------------------------- errors

/**
 * throttled    HubSpot 429 (scope 'portal' or 'app') or our own limiter is full ('limiter'). Retry after retryAfterMs.
 * transient    5xx, network error or timeout, still failing after the inline retries. Retry later.
 * unauthorized 401: the access token was rejected.
 * refused      any other 4xx: HubSpot will not do this. status + body say why.
 */
export type HubSpotErrorKind = 'throttled' | 'transient' | 'unauthorized' | 'refused';
export type ThrottleScope = 'portal' | 'app' | 'limiter';

export class HubSpotError extends Error {
  /** HTTP status; 0 when there was no response (network, timeout, our limiter). */
  readonly status: number;
  readonly body: unknown;
  /** throttled only. */
  readonly retryAfterMs?: number;
  /** throttled only. */
  readonly scope?: ThrottleScope;

  constructor(
    readonly kind: HubSpotErrorKind,
    message: string,
    o: { status?: number; body?: unknown; retryAfterMs?: number; scope?: ThrottleScope } = {},
  ) {
    super(message);
    this.name = 'HubSpotError';
    this.status = o.status ?? 0;
    this.body = o.body;
    if (o.retryAfterMs !== undefined) this.retryAfterMs = o.retryAfterMs;
    if (o.scope !== undefined) this.scope = o.scope;
  }

  /** The error for a final non-2xx response other than 429 (hsRequest builds 429 errors itself). */
  static fromStatus(status: number, body: unknown, message: string): HubSpotError {
    const kind: HubSpotErrorKind = status === 401 ? 'unauthorized' : status >= 500 ? 'transient' : 'refused';
    return new HubSpotError(kind, message, { status, body });
  }
}

// ---------------------------------------------------------------- process setup

let log: Logger = createLogger('http');

export type HttpMetrics = Pick<ChangeCatchMetrics, 'httpRequest' | 'httpError' | 'rateLimited'>;
let metrics: HttpMetrics | null = null;

/**
 * Once per process (lib/process.ts startProcess): the per-portal rate of the shared limiter (undefined =
 * HS_PORTAL_RATE_PER_10S) and the metrics every HubSpot attempt is counted in (null = not counted).
 */
export function configureHttp(o: { portalRatePer10s?: number | undefined; metrics?: HttpMetrics | null; log?: Logger }): void {
  setRateLimiter(new RateLimiter(o.portalRatePer10s));
  metrics = o.metrics ?? null;
  log = o.log?.child({ component: 'http' }) ?? createLogger('http');
}

// ---------------------------------------------------------------- shared helpers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per-attempt timeout. A timeout is retried like a network error. */
const HTTP_TIMEOUT_MS = 20_000;
/** A portal call that would wait longer than this for the limiter (or a 429 pause) is deferred ('throttled'). */
const HS_PORTAL_MAX_WAIT_MS = 10_000;

/** Retry-After is seconds or an HTTP date. Returns ms, or undefined. */
export function parseRetryAfter(v: string | null, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - now) : undefined;
}

export type Attempt<T> = { ok: true; res: Response; data: T } | { ok: false; timedOut: boolean; error: HubSpotError };

/**
 * One attempt: fetch + read the body under one timeout, counted in the metrics under `api` (null = not counted).
 * No response, or a network error / timeout while reading the body, = a 'transient' error. Any other error thrown
 * by `read` (the journal download's size cap) is rethrown.
 */
export async function hsFetch<T>(
  url: URL,
  init: RequestInit & { method: string },
  o: { api: ApiFamily | null; portalId?: number | undefined; timeoutMs: number; read: (res: Response) => Promise<T> },
): Promise<Attempt<T>> {
  const { api, portalId, timeoutMs } = o;
  if (api) metrics?.httpRequest(api);
  const failed = (e: unknown): Attempt<T> => {
    // Seen live as "fetch failed" (DNS, reset).
    const timedOut = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
    if (api) metrics?.httpError(timedOut ? 'timeout' : 'network');
    const what = timedOut ? `timed out after ${timeoutMs}ms` : `network error (${(e as Error)?.message})`;
    return { ok: false, timedOut, error: new HubSpotError('transient', `${init.method} ${url.pathname} ${what}`) };
  };
  let res: Response;
  try {
    // The signal also covers reading the body.
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return failed(e);
  }
  if (res.status >= 400 && api) {
    metrics?.httpError(res.status);
    if (res.status === 429) metrics?.rateLimited(portalId);
  }
  try {
    return { ok: true, res, data: await o.read(res) };
  } catch (e) {
    const name = (e as Error)?.name;
    if (e instanceof TypeError || name === 'TimeoutError' || name === 'AbortError') return failed(e);
    throw e;
  }
}

// ---------------------------------------------------------------- API calls

/** A customer-portal call: the portal's OAuth token plus the portal it belongs to. Spread into RequestOpts. */
export type PortalAuth = { portalId: number; token: string };

export interface RequestOpts {
  method?: string;
  token?: string; // bearer token (client-credentials OR customer OAuth; caller decides)
  body?: unknown;
  form?: Record<string, string>; // x-www-form-urlencoded body
  query?: Record<string, string | number | boolean | undefined>;
  retries?: number;
  /** The customer portal this call is for: picks its rate-limit bucket. Pass it on every customer-portal call. */
  portalId?: number;
  /** App-level journal calls (hubspot/journal.ts): the rate bucket, also the metrics `api` label. */
  bucket?: AppBucket;
}

export async function hsRequest<T = any>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { method = 'GET', token, body, form, query, retries = 4 } = opts;
  const url = new URL(path.startsWith('http') ? path : HUBSPOT_API + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const { portalId } = opts;
  const key: RateKey | null = portalId !== undefined ? { portalId } : (opts.bucket ?? null);
  const api = opts.bucket ?? apiOf(url);
  const maxWaitMs = portalId !== undefined ? HS_PORTAL_MAX_WAIT_MS : undefined;
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

  for (let n = 0; ; n++) {
    if (key) {
      const wait = limiter.waitMs(key);
      if (maxWaitMs !== undefined && wait > maxWaitMs) {
        metrics?.rateLimited(portalId);
        throw new HubSpotError('throttled', `${method} ${url.pathname}: rate limit: ${keyName(key)} is throttled for about ${Math.ceil(wait / 1000)}s`, {
          retryAfterMs: wait,
          scope: 'limiter',
        });
      }
      await limiter.acquire(key);
    }

    const a = await hsFetch(url, { method, headers, body: payload }, { api, portalId, timeoutMs: HTTP_TIMEOUT_MS, read: (r) => r.text() });
    if (!a.ok) {
      if (n >= retries) throw a.error;
      const wait = backoffMs(n, 500, 30_000);
      log.warn('http_retry', `${a.error.message}, retry in ${wait}ms`, {
        method, path: url.pathname, reason: a.timedOut ? 'timeout' : 'network', attempt: n + 1, retryInMs: wait,
      });
      await sleep(wait);
      continue;
    }
    const { res, data: text } = a;
    let data: any = text;
    try { data = text ? JSON.parse(text) : undefined; } catch { /* keep raw text */ }

    if (res.ok) return data as T;
    const errMsg = `${method} ${url.pathname} failed with ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`;

    if (res.status === 429) {
      const wait = parseRetryAfter(res.headers.get('retry-after')) ?? backoffMs(n, 1000, 30_000);
      if (key) limiter.pause(key, wait); // only this bucket waits; other portals keep going
      if (n >= retries || (maxWaitMs !== undefined && wait > maxWaitMs))
        throw new HubSpotError('throttled', errMsg, { status: 429, body: data, retryAfterMs: wait, scope: portalId !== undefined ? 'portal' : 'app' });
      log.warn('http_retry', `${method} ${url.pathname} -> 429 (${key ? keyName(key) : 'unlimited'}), retry in ${wait}ms`, {
        method, path: url.pathname, status: 429, reason: 'rate_limited', bucket: key ? keyName(key) : 'unlimited',
        ...(portalId !== undefined ? { portalId } : {}), attempt: n + 1, retryInMs: wait,
      });
      if (!key) await sleep(wait); // with a key, the next acquire() waits for the pause
      continue;
    }
    if (res.status >= 500 && n < retries) {
      const wait = backoffMs(n, 500, 30_000);
      log.warn('http_retry', `${method} ${url.pathname} -> ${res.status}, retry in ${wait}ms`, {
        method, path: url.pathname, status: res.status, reason: 'server_error', attempt: n + 1, retryInMs: wait,
      });
      await sleep(wait);
      continue;
    }
    throw HubSpotError.fromStatus(res.status, data, errMsg);
  }
}
