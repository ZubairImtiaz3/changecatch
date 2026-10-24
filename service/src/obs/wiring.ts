// Glue between the obs building blocks and the processes (worker, app server):
//  - legacyLog(): turns the existing `(level, msg)` callbacks into structured log records, and sends every
//    `[ALERT] ...` line to the error reporter (level=error, event=alert).
//  - instrumentFetch(): wraps globalThis.fetch so every HubSpot request (and journal file download) is counted
//    in http_requests / http_errors / rate_limited, without the HTTP helper needing to know about metrics.

import { errors as defaultErrors, type Errors } from './errors.js';
import type { Logger, LogLevel } from './log.js';
import type { ChangeCatchMetrics } from './metrics.js';

/** The callback shape used across src/worker: level + message, optional event name and fields. */
export type LegacyLog = (level: 'info' | 'warn' | 'error', msg: string, event?: string, fields?: Record<string, unknown>) => void;

const ALERT = /^\s*\[ALERT\]\s*/;
const ALERT_CLEARED = /^\s*\[ALERT-CLEARED\]\s*/;
const PORTAL = /\bportal (\d{1,12})\b/;

/**
 * Adapter: `(level, msg, event?, fields?)` -> structured logger.
 * - `[ALERT] x`         -> level error, event "alert", msg "x", and reported via errors.message().
 * - `[ALERT-CLEARED] x` -> level info, event "alert_cleared".
 * - "portal 123" in the message fills the portalId field when the caller did not set one.
 */
export function legacyLog(log: Logger, opts: { errors?: Errors | null; event?: string } = {}): LegacyLog {
  const errs = opts.errors === undefined ? defaultErrors : opts.errors;
  return (level, msg, event, fields = {}) => {
    let lvl: LogLevel = level;
    let ev = event ?? opts.event;
    let text = msg;
    const alert = ALERT.test(text);
    if (alert) {
      text = text.replace(ALERT, '');
      lvl = 'error';
      ev = 'alert';
    } else if (ALERT_CLEARED.test(text)) {
      text = text.replace(ALERT_CLEARED, '');
      lvl = 'info';
      ev = 'alert_cleared';
    }
    const f: Record<string, unknown> = { ...fields };
    if (f.portalId === undefined) {
      const m = PORTAL.exec(text);
      if (m) f.portalId = Number(m[1]);
    }
    log.log(lvl, ev, text, f);
    if (alert && errs) {
      errs.message(text, {
        component: log.component,
        op: 'alert',
        level: 'error',
        ...(typeof f.portalId === 'number' ? { portalId: f.portalId } : {}),
      });
    }
  };
}

/** `(msg) => void` variant (installer, lifecycle hooks). */
export function legacyInfoLog(log: Logger, opts: { errors?: Errors | null; event?: string } = {}): (msg: string) => void {
  const l = legacyLog(log, opts);
  return (msg) => l('info', msg);
}

// ---------------------------------------------------------------------------------------------
// HTTP metrics via a fetch wrapper
// ---------------------------------------------------------------------------------------------

const HUBSPOT_HOSTS = new Set(['api.hubapi.com', 'api.hubspot.com']);

export type ApiFamily = 'journal' | 'crm' | 'oauth' | 'subscriptions' | 'other';

/**
 * Which `api` label a request gets, or null when it is not a HubSpot call (heartbeat pings, Sentry, ...).
 * Presigned journal file downloads (S3) count as `journal`.
 */
export function apiFamily(url: URL): ApiFamily | null {
  if (HUBSPOT_HOSTS.has(url.host)) {
    const p = url.pathname;
    if (p.startsWith('/webhooks-journal/subscriptions/')) return 'subscriptions';
    if (p.startsWith('/webhooks-journal/')) return 'journal';
    if (p.startsWith('/oauth/')) return 'oauth';
    if (p.startsWith('/crm/')) return 'crm';
    return 'other';
  }
  if (url.protocol === 'https:' && /(^|\.)amazonaws\.com$/.test(url.hostname)) return 'journal';
  return null;
}

function urlOf(input: unknown): URL | null {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    if (input && typeof (input as { url?: unknown }).url === 'string') return new URL((input as { url: string }).url);
  } catch {
    /* not a URL */
  }
  return null;
}

function bearerOf(init: unknown): string | undefined {
  const h = (init as { headers?: unknown } | undefined)?.headers;
  if (!h) return undefined;
  let v: string | null | undefined;
  if (typeof (h as Headers).get === 'function') v = (h as Headers).get('authorization');
  else if (Array.isArray(h)) v = h.find(([k]) => String(k).toLowerCase() === 'authorization')?.[1];
  else for (const [k, val] of Object.entries(h as Record<string, string>)) if (k.toLowerCase() === 'authorization') v = val;
  const m = v ? /^Bearer\s+(.+)$/i.exec(v) : null;
  return m?.[1];
}

export interface InstrumentFetchOptions {
  /** Map a bearer token to its portal (for rate_limited{portal}). Unknown = app-level ("app"). */
  portalForToken?: (token: string | undefined) => number | undefined;
  /** The object to patch. Default globalThis (tests pass their own). */
  target?: { fetch: typeof fetch };
}

/**
 * Wrap `fetch` so HubSpot calls are counted. Returns a function that restores the original.
 * Per request: http_requests{api}. Status >= 400: http_errors{status}. 429: also rate_limited{portal}.
 * Thrown fetch: http_errors{status="timeout"|"network"}.
 * Local rate-limiter deferrals never reach fetch; the stamp queue counts those in rate_limited.
 */
export function instrumentFetch(metrics: ChangeCatchMetrics, opts: InstrumentFetchOptions = {}): () => void {
  const target = opts.target ?? (globalThis as unknown as { fetch: typeof fetch });
  const original = target.fetch;
  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = urlOf(input);
    const api = url ? apiFamily(url) : null;
    if (!api) return original(input, init);
    metrics.httpRequest(api);
    try {
      const res = await original(input, init);
      if (res.status >= 400) {
        metrics.httpError(res.status);
        if (res.status === 429) metrics.rateLimited(opts.portalForToken?.(bearerOf(init)));
      }
      return res;
    } catch (e) {
      const name = (e as Error)?.name;
      metrics.httpError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
      throw e;
    }
  }) as typeof fetch;
  target.fetch = wrapped;
  return () => {
    if (target.fetch === wrapped) target.fetch = original;
  };
}

// ---------------------------------------------------------------------------------------------
// App server: `(msg) => void` lines with a `route[ref]: ...` prefix
// ---------------------------------------------------------------------------------------------

const ERROR_WORDS = /\b(unhandled|failed|FAILED|fatal)\b/;
const WARN_WORDS = /\b(rejected|refusing|returned error|missing|MISSING|WARNING)\b/;

/**
 * Adapter for the app server's `(msg) => void` callbacks, which carry no level.
 * - Level from the text: "failed" / "unhandled" -> error, "rejected" / "refusing" / "MISSING" -> warn, else info.
 * - `event` from the `route[ref]:` prefix (oauth, settings, install, unhandled), else `fallbackEvent`.
 * - Error-level lines (and `[ALERT]`) are sent to the error reporter with op = that event.
 */
export function classifiedLog(log: Logger, opts: { errors?: Errors | null; fallbackEvent?: string } = {}): (msg: string) => void {
  const errs = opts.errors === undefined ? defaultErrors : opts.errors;
  const base = legacyLog(log, { errors: errs });
  return (msg) => {
    if (ALERT.test(msg) || ALERT_CLEARED.test(msg)) return base('info', msg);
    const m = /^\s*([a-z][a-z0-9_-]*)\[[^\]]*\]/i.exec(msg);
    const event = m?.[1].toLowerCase() ?? opts.fallbackEvent;
    const level = ERROR_WORDS.test(msg) ? 'error' : WARN_WORDS.test(msg) ? 'warn' : 'info';
    base(level, msg, event);
    if (level === 'error' && errs) {
      const pm = PORTAL.exec(msg);
      errs.message(msg, { component: log.component, op: event ?? 'error', level: 'error', ...(pm ? { portalId: Number(pm[1]) } : {}) });
    }
  };
}
