// Dead-man's-switch heartbeat to an external monitor (e.g. Healthchecks.io, free tier).
// Why: log lines and in-process alerts die with the process. If Fly (or the worker) is down, an
// external service that EXPECTS a ping every few minutes still raises the alarm.
//
// url = HEARTBEAT_URL, e.g. https://hc-ping.com/<uuid>. Not set = heartbeat off (all calls are no-ops).
//   ok()   -> GET HEARTBEAT_URL        after each successful journal read (at most once per 60 s)
//   fail() -> HEARTBEAT_URL/fail       when the worker is stale (no successful read for 1 h); POST with the reason
// A state change (ok -> fail, fail -> ok) is sent at once; repeats of the same state are throttled.
// Never throws, never logs the URL (the UUID in it is the only "password" of the check).

import { createLogger, redactString, type Logger } from './log.js';

/** Repeats of the same state are sent at most this often. */
const MIN_INTERVAL_MS = 60_000;
const TIMEOUT_MS = 10_000;

export type FetchLike = (url: string, init?: { method?: string; signal?: AbortSignal; body?: string }) => Promise<{ ok: boolean; status: number }>;

export interface HeartbeatOptions {
  url: string | null | undefined;
  fetch?: FetchLike;
  now?: () => number;
  log?: Logger;
}

export class Heartbeat {
  readonly enabled: boolean;
  private readonly url: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly log: Logger;
  private lastState: 'ok' | 'fail' | null = null;
  private lastSentAt = 0;
  private inFlight: Promise<boolean> | null = null;

  constructor(opts: HeartbeatOptions) {
    // HEARTBEAT_URL is checked to be a URL by loadConfig.
    this.url = (opts.url?.trim() ?? '').replace(/\/+$/, '');
    this.enabled = this.url !== '';
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? createLogger('heartbeat');
  }

  /** Call after each successful journal read. Returns true if a ping was sent and accepted. */
  ok(): Promise<boolean> {
    return this.send('ok');
  }

  /** Call when the worker is stale (the StaleAlerter fires). `reason` is sent as the POST body (redacted, max 1000 chars). */
  fail(reason?: string): Promise<boolean> {
    return this.send('fail', reason);
  }

  private async send(state: 'ok' | 'fail', body?: string): Promise<boolean> {
    if (!this.enabled) return false;
    const t = this.now();
    if (state === this.lastState && t - this.lastSentAt < MIN_INTERVAL_MS) return false;
    if (this.inFlight) return false; // one ping at a time; the next read will try again
    this.lastState = state;
    this.lastSentAt = t;
    const target = state === 'ok' ? this.url : `${this.url}/fail`;
    this.inFlight = (async () => {
      try {
        const res = await this.fetchFn(target, {
          method: body ? 'POST' : 'GET',
          body: body === undefined ? undefined : redactString(body).slice(0, 1000),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) this.log.warn('heartbeat_failed', `heartbeat ${state} ping answered ${res.status}`);
        return res.ok;
      } catch (e) {
        this.log.warn('heartbeat_failed', `heartbeat ${state} ping failed: ${(e as Error).message}`);
        // allow a retry on the next call instead of waiting a full interval
        this.lastSentAt = 0;
        return false;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}
