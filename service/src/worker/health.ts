// Worker monitoring: a JSON snapshot, HTTP /health (JSON) and /metrics (Prometheus text), and the "stale" alert
// (alert if there was no successful journal read for 1 hour; the journal keeps only ~3 days).
//
// Privacy (security review): by default /health and /metrics show AGGREGATE numbers only, no portal ids.
// A per-portal breakdown is returned only when the request carries `x-health-token` equal to env HEALTH_TOKEN
// (constant-time compare). With HEALTH_TOKEN unset, the breakdown is never shown.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { isStale, STALE_AFTER_MS } from '../core/poller.js';
import { createLogger } from '../obs/log.js';
import { legacyInfoLog } from '../obs/wiring.js';
import type { BucketStats } from '../lib/rate-limiter.js';
import { PROMETHEUS_CONTENT_TYPE, type ChangeCatchMetrics, type MetricSnapshot } from '../obs/metrics.js';
import type { PortalMetrics, Store } from '../store/db.js';
import type { LatencyStats } from './latency.js';
import type { WorkerTables } from './worker-tables.js';

type PortalRowOut = Omit<PortalMetrics, 'lastEventAt' | 'lastErrorAt'> & {
  lastEventAt: string | null;
  lastErrorAt: string | null;
  queued?: number;
  deadLetters?: number;
  paused?: { since: string; reason: string | null } | null;
};

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

export interface HealthSnapshot {
  status: 'ok' | 'stale';
  now: string;
  startedAt: string;
  lastSuccessfulReadAt: string | null;
  staleAfterMs: number;
  offset: string | null;
  consecutiveErrors: number;
  lastError: { message: string; at: string } | null;
  stampQueue: { size: number; nextDueAt: string | null };
  /** End-to-end latency (occurredAt -> stamped) of the most recent stamps in this process. null = not wired. */
  latency: LatencyStats | null;
  totals: HealthTotals;
  /** Metrics registry JSON (portal labels removed unless the request is authorised). */
  metrics?: Record<string, unknown>;
  workerLock?: { pid: number; host: string; heartbeatAt: string; mine: boolean } | null;
  /** Rate limiter buckets: app-level ones always; portal buckets only when authorised. */
  rateLimiter?: Record<string, BucketStats>;
  // ---- per-portal detail: only with a valid x-health-token
  labelHolds?: { key: string; since: string; lastError: string | null }[];
  portals?: PortalRowOut[];
  lifecycleRetries?: { portalId: number; attempts: number; nextAt: string; lastError: string | null }[];
}

export interface HealthExtras {
  tables?: WorkerTables;
  metrics?: ChangeCatchMetrics;
  rateLimiter?: () => Record<string, BucketStats>;
}

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/** Full snapshot (with per-portal detail). Servers pass it through publicHealth() unless the caller is authorised. */
export function healthSnapshot(
  store: Store,
  now: number,
  startedAt: number,
  staleAfterMs = STALE_AFTER_MS,
  latency: LatencyStats | null = null,
  extras: HealthExtras = {},
): HealthSnapshot {
  const err = store.getLastError();
  const metrics = store.listMetrics();
  const t = extras.tables;
  const depth = t?.queueDepthByPortal() ?? new Map<number, number>();
  const dead = t?.deadLetterCounts() ?? new Map<number, number>();
  const pauses = new Map((t?.listPauses() ?? []).map((p) => [p.portalId, p]));
  const retries = t?.listLifecycleRetries() ?? [];
  const holds = store.listLabelHolds();
  const lock = t?.lockInfo();
  const sum = (f: (m: PortalMetrics) => number) => metrics.reduce((a, m) => a + f(m), 0);
  return {
    status: isStale(store, now, staleAfterMs) ? 'stale' : 'ok',
    now: iso(now)!,
    startedAt: iso(startedAt)!,
    lastSuccessfulReadAt: iso(store.getLastSuccessfulReadAt()),
    staleAfterMs,
    offset: store.getOffset(),
    consecutiveErrors: store.getConsecutiveErrors(),
    lastError: err && { message: err.message, at: iso(err.at)! },
    stampQueue: { size: store.queueSize(), nextDueAt: iso(store.nextStampDueAt()) },
    latency,
    totals: {
      portals: metrics.length,
      portalsWithErrors: metrics.filter((m) => m.lastError).length,
      eventsProcessed: sum((m) => m.eventsProcessed),
      changesEmitted: sum((m) => m.changesEmitted),
      stampsSent: sum((m) => m.stampsSent),
      stampsDropped: sum((m) => m.stampsDropped),
      deadLetters: [...dead.values()].reduce((a, b) => a + b, 0),
      pausedPortals: pauses.size,
      lifecycleRetries: retries.length,
      parkedEntries: store.parkedCount(),
      labelHolds: holds.length,
    },
    metrics: extras.metrics?.toJSON(),
    workerLock: lock === undefined ? undefined : lock && { pid: lock.pid, host: lock.host, heartbeatAt: iso(lock.heartbeatAt)!, mine: lock.mine },
    rateLimiter: extras.rateLimiter?.(),
    labelHolds: holds.map((h) => ({ key: h.key, since: iso(h.firstFailedAt)!, lastError: h.lastError })),
    portals: metrics.map((m) => {
      const p = pauses.get(m.portalId);
      return {
        ...m,
        lastEventAt: iso(m.lastEventAt),
        lastErrorAt: iso(m.lastErrorAt),
        ...(t ? { queued: depth.get(m.portalId) ?? 0, deadLetters: dead.get(m.portalId) ?? 0, paused: p ? { since: iso(p.since)!, reason: p.reason } : null } : {}),
      };
    }),
    lifecycleRetries: retries.map((r) => ({ portalId: r.portalId, attempts: r.attempts, nextAt: iso(r.nextAt)!, lastError: r.lastError })),
  };
}

/** Aggregate-only view: no portal ids anywhere (errors can mention a portal, so they are reduced to their time). */
export function publicHealth(s: HealthSnapshot): HealthSnapshot {
  const { labelHolds: _h, portals: _p, lifecycleRetries: _r, ...rest } = s;
  return {
    ...rest,
    lastError: s.lastError && { message: 'hidden (send x-health-token for details)', at: s.lastError.at },
    metrics: s.metrics && stripPortalJson(s.metrics),
    rateLimiter: s.rateLimiter && Object.fromEntries(Object.entries(s.rateLimiter).filter(([k]) => !k.startsWith('portal:'))),
  };
}

function stripPortalJson(m: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).some((x) => /(^|,)portal=/.test(x))) {
      const total = (v as Record<string, unknown>)._total;
      out[k] = total !== undefined ? { _total: total } : '(per-portal; send x-health-token)';
    } else out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- Prometheus

const fmtNum = (v: number) => (Number.isFinite(v) ? String(v) : v > 0 ? '+Inf' : v < 0 ? '-Inf' : 'NaN');
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
function fmtLabels(labels: Record<string, string | number>): string {
  const keys = Object.keys(labels).sort();
  return keys.length ? `{${keys.map((k) => `${k}="${esc(String(labels[k]))}"`).join(',')}}` : '';
}

/**
 * Prometheus text from a registry snapshot. dropLabel = "portal": that label is removed and counters/gauges are
 * summed over it (histograms with that label are skipped), so no portal id is exported.
 */
export function prometheusText(snapshot: MetricSnapshot[], opts: { dropLabel?: string; prefix?: string } = {}): string {
  const prefix = opts.prefix ?? 'changecatch_';
  const lines: string[] = [];
  for (const m of snapshot) {
    if (!m.series.length) continue;
    const base = prefix + m.name;
    const name = m.kind === 'counter' && !base.endsWith('_total') ? `${base}_total` : base;
    const rows: { labels: Record<string, string | number>; value?: number; stats?: NonNullable<MetricSnapshot['series'][number]['stats']> }[] = [];
    if (opts.dropLabel) {
      const agg = new Map<string, { labels: Record<string, string | number>; value: number }>();
      for (const s of m.series) {
        if (!(opts.dropLabel in s.labels)) {
          rows.push(s as never);
          continue;
        }
        if (s.stats) continue;
        const { [opts.dropLabel]: _drop, ...rest } = s.labels;
        const key = fmtLabels(rest);
        const a = agg.get(key) ?? agg.set(key, { labels: rest, value: 0 }).get(key)!;
        a.value += s.value ?? 0;
      }
      rows.push(...agg.values());
    } else rows.push(...(m.series as never[]));
    if (!rows.length) continue;
    if (m.help) lines.push(`# HELP ${name} ${m.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`);
    lines.push(`# TYPE ${name} ${m.kind === 'histogram' ? 'summary' : m.kind}`);
    for (const s of rows) {
      if (s.stats) {
        for (const [q, v] of [['0.5', s.stats.p50], ['0.95', s.stats.p95], ['0.99', s.stats.p99]] as const)
          if (v !== null) lines.push(`${name}${fmtLabels({ ...s.labels, quantile: q })} ${fmtNum(v)}`);
        lines.push(`${name}_sum${fmtLabels(s.labels)} ${fmtNum(s.stats.sum)}`);
        lines.push(`${name}_count${fmtLabels(s.labels)} ${fmtNum(s.stats.count)}`);
      } else lines.push(`${name}${fmtLabels(s.labels)} ${fmtNum(s.value ?? 0)}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Worker gauges computed at scrape time from the DB (queue, dead letters, pauses, lifecycle retries, parked). */
export function registerWorkerGauges(metrics: ChangeCatchMetrics, store: Store, tables: WorkerTables): void {
  const r = metrics.registry;
  r.defineComputedGauge('dead_letters', 'Stamps in the dead-letter table, per portal', () =>
    [...tables.deadLetterCounts()].map(([p, n]) => ({ labels: { portal: p }, value: n })),
  );
  r.defineComputedGauge('portals_paused', 'Portals paused because their token is revoked/invalid', () => tables.listPauses().length);
  r.defineComputedGauge('lifecycle_retries_pending', 'Install/uninstall handling waiting for a retry', () => tables.listLifecycleRetries().length);
  r.defineComputedGauge('parked_entries', 'Association entries parked (label lookup held), all portals', () => store.parkedCount());
  r.defineComputedGauge('stamp_queue_size', 'Stamps waiting in the queue, all portals', () => store.queueSize());
  r.define('stamps_coalesced', 'counter', 'Stamps folded into a later stamp on the same record (COALESCE_MODE=latest)');
}

// ---------------------------------------------------------------- HTTP server

/** True if the request carries x-health-token equal to `token` (constant time). Never true when token is unset. */
export function isAuthorised(req: Pick<IncomingMessage, 'headers'>, token: string | undefined): boolean {
  if (!token) return false;
  const got = req.headers['x-health-token'];
  const v = Array.isArray(got) ? got[0] : got;
  if (typeof v !== 'string') return false;
  const a = Buffer.from(v);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * GET /health (or /healthz) -> 200 JSON when fine, 503 JSON when stale.
 * GET /metrics -> Prometheus text (needs `metrics`).
 * Per-portal detail only with a valid x-health-token (healthToken, default env HEALTH_TOKEN). Anything else -> 404.
 */
export function startHealthServer(opts: {
  port: number;
  host?: string;
  snapshot: () => HealthSnapshot;
  metrics?: ChangeCatchMetrics;
  healthToken?: string;
}): Promise<Server> {
  const token = opts.healthToken ?? (process.env.HEALTH_TOKEN || undefined);
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const authed = isAuthorised(req, token);
    if (req.method === 'GET' && path === '/metrics' && opts.metrics) {
      try {
        const body = prometheusText(opts.metrics.registry.snapshot(), authed ? {} : { dropLabel: 'portal' });
        res.writeHead(200, { 'content-type': PROMETHEUS_CONTENT_TYPE }).end(body);
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
      if (!authed) body = publicHealth(body);
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

/** Logs one "[ALERT]" line when the worker goes stale, then at most every repeatMs while it stays stale. */
export class StaleAlerter {
  private lastAlertAt: number | null = null;
  constructor(
    private repeatMs = 15 * 60 * 1000,
    private log: (msg: string) => void = legacyInfoLog(createLogger('health')),
    /** Side effects when the alert fires / clears (heartbeat /fail ping). Never allowed to throw. */
    private hooks: { onAlert?: (msg: string) => void; onClear?: () => void } = {},
  ) {}

  check(store: Store, now: number, staleAfterMs = STALE_AFTER_MS): boolean {
    if (!isStale(store, now, staleAfterMs)) {
      if (this.lastAlertAt !== null) {
        this.log(`[ALERT-CLEARED] journal reads are succeeding again`);
        try {
          this.hooks.onClear?.();
        } catch {
          /* monitoring must not break the loop */
        }
      }
      this.lastAlertAt = null;
      return false;
    }
    if (this.lastAlertAt === null || now - this.lastAlertAt >= this.repeatMs) {
      const last = store.getLastSuccessfulReadAt();
      const err = store.getLastError();
      const msg =
        `[ALERT] ChangeCatch worker: no successful journal read since ${last ? new Date(last).toISOString() : 'start'}` +
        ` (limit ${Math.round(staleAfterMs / 60000)} min). Journal data is kept only ~3 days.` +
        (err ? ` Last error: ${err.message}` : '');
      this.log(msg);
      try {
        this.hooks.onAlert?.(msg);
      } catch {
        /* monitoring must not break the loop */
      }
      this.lastAlertAt = now;
    }
    return true;
  }
}
