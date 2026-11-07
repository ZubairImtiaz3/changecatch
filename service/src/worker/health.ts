// Worker monitoring: a JSON snapshot, HTTP /health (JSON) and /metrics (Prometheus text), and the "stale" alert
// (alert if there was no successful journal read for 1 hour; the journal keeps only ~3 days).
//
// Counts come from the in-memory metrics (src/obs/metrics.ts): they start at 0 when the worker starts. The DB gives
// only state: offset, last successful read, queue, dead letters, pauses, label holds, the last error per portal.
//
// Privacy: by default /health and /metrics show AGGREGATE numbers only, no portal ids.
// A per-portal breakdown is returned only when the request carries `x-health-token` equal to HEALTH_TOKEN
// (constant-time compare). With HEALTH_TOKEN unset, the breakdown is never shown.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AlertThrottle } from '../obs/alerts.js';
import type { Logger } from '../obs/log.js';
import type { RateLimiterStats } from '../lib/rate-limiter.js';
import { compareOffsets, offsetTimeMs } from '../core/journal-offset.js';
import { M, PROMETHEUS_CONTENT_TYPE, type ChangeCatchMetrics } from '../obs/metrics.js';
import { JOURNAL_OFFSET_MAX_AGE_MS, OFFSET_CHECK_EVERY_MS, readOffsetCheck } from './journal-reader.js';
import type { Store } from '../store/db.js';

export interface PortalRowOut {
  portalId: number;
  changesEmitted: number;
  stampsSent: number;
  /** Dead-lettered stamps (refused by HubSpot, or retries ran out). */
  stampsDropped: number;
  lastError: string | null;
  lastErrorAt: string | null;
  queued: number;
  deadLetters: number;
  paused: { since: string; reason: string | null } | null;
}

/** Counts are since the worker started. */
export interface HealthTotals {
  portals: number;
  portalsWithErrors: number;
  eventsProcessed: number;
  changesEmitted: number;
  stampsSent: number;
  stampsDropped: number;
  deadLetters: number;
  pausedPortals: number;
  lifecycleRetries: number;
  parkedEntries: number;
  labelHolds: number;
}

/** occurredAt -> stamped, from the e2e_latency_ms histogram (most recent stamps of this process). */
export interface LatencyStats {
  /** Samples in the percentile window. */
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  /** Stamps measured since the worker started. */
  totalSamples: number;
}

export interface HealthSnapshot {
  /** stale = no successful read for 1 h; degraded = reads succeed but the offset is too old / far behind latest. */
  status: 'ok' | 'degraded' | 'stale';
  /** Age of the stored offset (UUIDv7 time), seconds. null = no offset / not a UUIDv7. Aggregate only. */
  offsetAgeSeconds: number | null;
  offsetMaxAgeSeconds: number;
  /** Why status is "degraded" (no portal ids). */
  degradedReason?: string;
  now: string;
  startedAt: string;
  lastSuccessfulReadAt: string | null;
  staleAfterMs: number;
  offset: string | null;
  /** Failed journal runs in a row (the worker's back-off counter). */
  consecutiveErrors: number;
  lastError: { message: string; at: string } | null;
  stampQueue: { size: number; nextDueAt: string | null };
  /** HubSpot 429 and 5xx responses since the worker started (http_errors, all portals). */
  httpErrors: { status429: number; status5xx: number };
  latency: LatencyStats | null;
  totals: HealthTotals;
  /** Metrics registry JSON (per-portal metrics summed unless the request is authorised). */
  metrics?: Record<string, unknown>;
  workerLock: { pid: number; host: string; heartbeatAt: string; mine: boolean } | null;
  /** Rate limiter buckets: app-level ones always; portal buckets only when authorised. */
  rateLimiter?: Partial<RateLimiterStats>;
  // ---- per-portal detail: only with a valid x-health-token
  labelHolds?: { key: string; since: string; lastError: string | null }[];
  portals?: PortalRowOut[];
  lifecycleRetries?: { portalId: number; attempts: number; nextAt: string; lastError: string | null }[];
}

export interface HealthOptions {
  /** Default: now. */
  startedAt?: number;
  /** Worker.consecutiveErrors. */
  consecutiveErrors?: number;
  metrics?: ChangeCatchMetrics;
  rateLimiter?: () => RateLimiterStats;
}

/**
 * Offset freshness for /health. Degraded when:
 *  - the stored offset is older than maxAge, unless a recent earliest/latest check (journal-reader) showed we
 *    are simply caught up on a quiet journal; or
 *  - the last check saw `latest` more than maxAge ahead of the stored offset.
 */
export function offsetHealth(
  store: Store,
  now: number,
  maxAgeMs: number,
): { offsetAgeSeconds: number | null; degradedReason: string | null } {
  const off = store.journal.getOffset();
  const ot = off ? offsetTimeMs(off) : null;
  if (!off || ot === null) return { offsetAgeSeconds: null, degradedReason: null };
  const ageMs = Math.max(0, now - ot);
  const c = readOffsetCheck(store);
  const check = c && c.offset === off ? c : null;
  if (check?.expired) return { offsetAgeSeconds: ageMs / 1000, degradedReason: 'journal offset expired' };
  const latestT = check?.latest ? offsetTimeMs(check.latest) : null;
  if (latestT !== null && latestT - ot > maxAgeMs)
    return { offsetAgeSeconds: ageMs / 1000, degradedReason: 'stored offset is far behind the journal latest' };
  if (ageMs > maxAgeMs) {
    const caughtUp =
      !!check && now - check.at <= 2 * OFFSET_CHECK_EVERY_MS && (!check.latest || compareOffsets(check.latest, off) <= 0);
    if (!caughtUp) return { offsetAgeSeconds: ageMs / 1000, degradedReason: 'stored journal offset is older than JOURNAL_OFFSET_MAX_AGE_MS' };
  }
  return { offsetAgeSeconds: ageMs / 1000, degradedReason: null };
}

/** No successful journal read for this long = stale (alert; /health 503). The journal keeps only ~3 days. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

/** True if there was no successful read for maxAgeMs. Counts from `since` (DB creation) if never read. */
export function isStale(lastSuccessAt: number | null, since: number, now: number, maxAgeMs: number): boolean {
  return now - (lastSuccessAt ?? since) >= maxAgeMs;
}

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

const storeStale = (store: Store, now: number, staleAfterMs: number) =>
  isStale(store.journal.getLastSuccessfulReadAt(), store.journal.getCreatedAt(), now, staleAfterMs);

type Counts = { changes: number; stampsSent: number; stampsDropped: number };

/** Full snapshot (with per-portal detail). Servers pass it through publicHealth() unless the caller is authorised. */
export function healthSnapshot(store: Store, now: number, o: HealthOptions): HealthSnapshot {
  const err = store.journal.getLastError();
  const m = o.metrics;
  const counts = m?.portalCounts() ?? new Map<number, Counts>();
  const portalErrors = new Map(store.metrics.listPortalErrors().map((e) => [e.portalId, e]));
  const depth = store.stamps.queueDepthByPortal();
  const dead = store.stamps.deadLetterCounts();
  const pauses = new Map(store.stamps.listPauses().map((p) => [p.portalId, p]));
  const retries = store.worker.listLifecycleRetries();
  const holds = store.labels.listLabelHolds();
  const lock = store.worker.lockInfo();
  const portalIds = [...new Set([...counts.keys(), ...portalErrors.keys()])].sort((a, b) => a - b);
  const sum = (f: (c: Counts) => number) => [...counts.values()].reduce((a, c) => a + f(c), 0);
  const oh = offsetHealth(store, now, JOURNAL_OFFSET_MAX_AGE_MS);
  const lat = m?.latency();
  return {
    status: storeStale(store, now, STALE_AFTER_MS) ? 'stale' : oh.degradedReason ? 'degraded' : 'ok',
    ...(oh.degradedReason ? { degradedReason: oh.degradedReason } : {}),
    offsetAgeSeconds: oh.offsetAgeSeconds === null ? null : Math.round(oh.offsetAgeSeconds),
    offsetMaxAgeSeconds: Math.round(JOURNAL_OFFSET_MAX_AGE_MS / 1000),
    now: iso(now)!,
    startedAt: iso(o.startedAt ?? now)!,
    lastSuccessfulReadAt: iso(store.journal.getLastSuccessfulReadAt()),
    staleAfterMs: STALE_AFTER_MS,
    offset: store.journal.getOffset(),
    consecutiveErrors: o.consecutiveErrors ?? 0,
    lastError: err && { message: err.message, at: iso(err.at)! },
    stampQueue: { size: store.stamps.queueSize(), nextDueAt: iso(store.stamps.nextDueAt()) },
    httpErrors: m?.httpErrorCounts() ?? { status429: 0, status5xx: 0 },
    latency: lat ? { count: lat.windowCount, p50Ms: lat.p50, p95Ms: lat.p95, maxMs: lat.max, totalSamples: lat.count } : null,
    totals: {
      portals: portalIds.length,
      portalsWithErrors: portalErrors.size,
      eventsProcessed: m?.registry.total(M.eventsRead) ?? 0,
      changesEmitted: sum((c) => c.changes),
      stampsSent: sum((c) => c.stampsSent),
      stampsDropped: sum((c) => c.stampsDropped),
      deadLetters: [...dead.values()].reduce((a, b) => a + b, 0),
      pausedPortals: pauses.size,
      lifecycleRetries: retries.length,
      parkedEntries: store.entries.parkedCount(),
      labelHolds: holds.length,
    },
    metrics: m?.toJSON(),
    workerLock: lock && { pid: lock.pid, host: lock.host, heartbeatAt: iso(lock.heartbeatAt)!, mine: lock.mine },
    rateLimiter: o.rateLimiter?.(),
    labelHolds: holds.map((h) => ({ key: h.key, since: iso(h.firstFailedAt)!, lastError: h.lastError })),
    portals: portalIds.map((portalId) => {
      const c = counts.get(portalId);
      const e = portalErrors.get(portalId);
      const p = pauses.get(portalId);
      return {
        portalId,
        changesEmitted: c?.changes ?? 0,
        stampsSent: c?.stampsSent ?? 0,
        stampsDropped: c?.stampsDropped ?? 0,
        lastError: e?.message ?? null,
        lastErrorAt: iso(e?.at),
        queued: depth.get(portalId) ?? 0,
        deadLetters: dead.get(portalId) ?? 0,
        paused: p ? { since: iso(p.since)!, reason: p.reason } : null,
      };
    }),
    lifecycleRetries: retries.map((r) => ({ portalId: r.portalId, attempts: r.attempts, nextAt: iso(r.nextAt)!, lastError: r.lastError })),
  };
}

/**
 * Aggregate-only view: no portal ids anywhere (errors can mention a portal, so they are reduced to their time).
 * `metrics` = the registry behind the snapshot; its public view replaces the snapshot's metrics.
 */
export function publicHealth(s: HealthSnapshot, metrics?: ChangeCatchMetrics): HealthSnapshot {
  const { labelHolds: _h, portals: _p, lifecycleRetries: _r, metrics: _m, ...rest } = s;
  return {
    ...rest,
    lastError: s.lastError && { message: 'hidden (send x-health-token for details)', at: s.lastError.at },
    ...(metrics ? { metrics: metrics.toJSON(true) } : {}),
    rateLimiter: s.rateLimiter && { app: s.rateLimiter.app },
  };
}

/** Worker gauges computed at scrape time from the DB (dead letters, pauses, lifecycle retries, parked). */
export function registerWorkerGauges(metrics: ChangeCatchMetrics, store: Store): void {
  const r = metrics.registry;
  r.defineComputedGauge(
    M.deadLetters,
    'Stamps in the dead-letter table, per portal',
    () => [...store.stamps.deadLetterCounts()].map(([p, n]) => ({ labels: { portal: p }, value: n })),
    { perPortal: true },
  );
  r.defineComputedGauge(M.portalsPaused, 'Portals paused because their token is revoked/invalid', () => store.stamps.listPauses().length);
  r.defineComputedGauge(M.lifecycleRetriesPending, 'Uninstall cleanups in HubSpot waiting for a retry', () => store.worker.listLifecycleRetries().length);
  r.defineComputedGauge(M.parkedEntries, 'Association entries parked (label lookup held), all portals', () => store.entries.parkedCount());
}

// ---------------------------------------------------------------- HTTP server

/** Request header that unlocks the per-portal detail (value = HEALTH_TOKEN). */
export const HEALTH_TOKEN_HEADER = 'x-health-token';

/** True if the request carries HEALTH_TOKEN_HEADER equal to `token` (constant time). Never true when token is unset. */
export function isAuthorised(req: Pick<IncomingMessage, 'headers'>, token: string | undefined): boolean {
  if (!token) return false;
  const got = req.headers[HEALTH_TOKEN_HEADER];
  const v = Array.isArray(got) ? got[0] : got;
  if (typeof v !== 'string') return false;
  const a = Buffer.from(v);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * GET /health (or /healthz) -> 200 JSON when fine, 503 JSON when stale or degraded (offset expired / too old).
 * GET /metrics -> Prometheus text (needs `metrics`).
 * Per-portal detail only with a valid x-health-token (healthToken = HEALTH_TOKEN; unset = never). Anything else -> 404.
 */
export function startHealthServer(opts: {
  port: number;
  host?: string;
  snapshot: () => HealthSnapshot;
  metrics?: ChangeCatchMetrics;
  healthToken: string | undefined;
}): Promise<Server> {
  const token = opts.healthToken;
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const authed = isAuthorised(req, token);
    if (req.method === 'GET' && path === '/metrics' && opts.metrics) {
      try {
        res.writeHead(200, { 'content-type': PROMETHEUS_CONTENT_TYPE }).end(opts.metrics.toPrometheus(!authed));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain' }).end(`error: ${(e as Error).message}`);
      }
      return;
    }
    if (req.method !== 'GET' || (path !== '/health' && path !== '/healthz')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    let body: HealthSnapshot;
    try {
      body = opts.snapshot();
      if (!authed) body = publicHealth(body, opts.metrics);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message }));
      return;
    }
    res.writeHead(body.status === 'ok' ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(body, null, 2));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => resolve(server));
  });
}

/** Alert "worker_stale" when the worker goes stale, then at most every repeatMs while it stays stale. */
export class StaleAlerter {
  private readonly throttle: AlertThrottle<'stale'>;
  constructor(
    private readonly log: Logger,
    repeatMs = 15 * 60 * 1000,
  ) {
    this.throttle = new AlertThrottle(repeatMs);
  }

  /** true while stale. */
  check(store: Store, now: number): boolean {
    if (!storeStale(store, now, STALE_AFTER_MS)) {
      if (this.throttle.clear('stale')) this.log.alertCleared('worker_stale', 'journal reads are succeeding again');
      return false;
    }
    if (this.throttle.fire('stale', now)) {
      const last = store.journal.getLastSuccessfulReadAt();
      const err = store.journal.getLastError();
      this.log.alert(
        'worker_stale',
        `ChangeCatch worker: no successful journal read since ${last ? new Date(last).toISOString() : 'start'}` +
          ` (limit ${Math.round(STALE_AFTER_MS / 60000)} min). Journal data is kept only ~3 days.` +
          (err ? ` Last error: ${err.message}` : ''),
      );
    }
    return true;
  }
}
