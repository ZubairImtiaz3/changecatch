// In-process metrics: counters, gauges and histograms (p50/p95/p99), keyed by name + labels.
// No dependencies. Two outputs:
//   - toPrometheus(): Prometheus text format, for a GET /metrics endpoint (Fly.io scrapes it for free).
//   - snapshot(): plain JSON, to embed in /health.
//
// Cardinality is bounded: each metric keeps at most `maxSeriesPerMetric` label sets. Past that, new
// label sets are folded into one series whose label values are all "_other", and
// `metrics_series_overflow_total{metric}` counts how often that happened. So 10k portals can't blow up
// memory or the metrics bill.
//
// The ChangeCatch metric names are standardised in `M` and wrapped by `ChangeCatchMetrics` below.
// See docs/observability.md for where each one is recorded.

export type Labels = Record<string, string | number>;
export type MetricKind = 'counter' | 'gauge' | 'histogram';

export interface HistogramStats {
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  /** Percentiles over the most recent `windowSize` samples (nearest rank). */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** Samples currently in the window. */
  windowCount: number;
}

export interface SeriesSnapshot {
  labels: Labels;
  value?: number;
  stats?: HistogramStats;
}

export interface MetricSnapshot {
  name: string;
  kind: MetricKind;
  help: string;
  series: SeriesSnapshot[];
}

export interface RegistryOptions {
  maxSeriesPerMetric?: number;
  /** Samples kept per histogram series for percentiles. */
  histogramWindow?: number;
  now?: () => number;
}

export const OVERFLOW_VALUE = '_other';

/** Nearest-rank percentile of a sorted array. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

class Reservoir {
  private buf: number[] = [];
  private next = 0;
  count = 0;
  sum = 0;
  min: number | null = null;
  max: number | null = null;
  constructor(private readonly capacity: number) {}
  observe(v: number): void {
    if (this.buf.length < this.capacity) this.buf.push(v);
    else this.buf[this.next] = v;
    this.next = (this.next + 1) % this.capacity;
    this.count++;
    this.sum += v;
    this.min = this.min === null ? v : Math.min(this.min, v);
    this.max = this.max === null ? v : Math.max(this.max, v);
  }
  stats(): HistogramStats {
    const s = [...this.buf].sort((a, b) => a - b);
    return {
      count: this.count,
      sum: this.sum,
      min: this.min,
      max: this.max,
      p50: percentile(s, 50),
      p95: percentile(s, 95),
      p99: percentile(s, 99),
      windowCount: s.length,
    };
  }
}

interface Series {
  labels: Labels;
  value: number;
  hist?: Reservoir;
}

interface MetricDef {
  name: string;
  kind: MetricKind;
  help: string;
  series: Map<string, Series>;
  /** Computed at read time (e.g. "seconds since X"). Overrides stored series when set. */
  collect?: () => number | { labels: Labels; value: number }[] | null;
}

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${String(labels[k])}`).join(',');
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, MetricDef>();
  private readonly maxSeries: number;
  private readonly histWindow: number;
  readonly now: () => number;

  constructor(opts: RegistryOptions = {}) {
    this.maxSeries = opts.maxSeriesPerMetric ?? 250;
    this.histWindow = opts.histogramWindow ?? 2048;
    this.now = opts.now ?? Date.now;
    this.define('metrics_series_overflow', 'counter', 'Label sets folded into "_other" because a metric hit its series cap');
  }

  /** Declare a metric (idempotent). Using an undeclared name auto-declares it with empty help. */
  define(name: string, kind: MetricKind, help = ''): this {
    if (!NAME_RE.test(name)) throw new Error(`bad metric name: ${name}`);
    const m = this.metrics.get(name);
    if (m && m.kind !== kind) throw new Error(`metric ${name} is a ${m.kind}, not a ${kind}`);
    if (!m) this.metrics.set(name, { name, kind, help, series: new Map() });
    else if (help && !m.help) m.help = help;
    return this;
  }

  /** Gauge whose value is computed when read (snapshot/export). Return null to emit nothing. */
  defineComputedGauge(name: string, help: string, collect: NonNullable<MetricDef['collect']>): this {
    this.define(name, 'gauge', help);
    this.metrics.get(name)!.collect = collect;
    return this;
  }

  private series(name: string, kind: MetricKind, labels: Labels): Series {
    this.define(name, kind);
    const m = this.metrics.get(name)!;
    for (const k of Object.keys(labels)) if (!LABEL_RE.test(k)) throw new Error(`bad label name: ${k}`);
    let key = labelKey(labels);
    let s = m.series.get(key);
    if (s) return s;
    if (m.series.size >= this.maxSeries) {
      const folded: Labels = {};
      for (const k of Object.keys(labels)) folded[k] = OVERFLOW_VALUE;
      key = labelKey(folded);
      labels = folded;
      s = m.series.get(key);
      if (name !== 'metrics_series_overflow') this.inc('metrics_series_overflow', 1, { metric: name });
      if (s) return s;
    }
    s = { labels: { ...labels }, value: 0, hist: kind === 'histogram' ? new Reservoir(this.histWindow) : undefined };
    m.series.set(key, s);
    return s;
  }

  inc(name: string, by = 1, labels: Labels = {}): void {
    if (!(by >= 0) || !Number.isFinite(by)) return; // counters only go up; ignore NaN/negatives
    this.series(name, 'counter', labels).value += by;
  }

  set(name: string, value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) return;
    this.series(name, 'gauge', labels).value = value;
  }

  add(name: string, by: number, labels: Labels = {}): void {
    if (!Number.isFinite(by)) return;
    this.series(name, 'gauge', labels).value += by;
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) return;
    this.series(name, 'histogram', labels).hist!.observe(value);
  }

  /** Remove one label set (e.g. a portal that uninstalled). */
  remove(name: string, labels: Labels): void {
    this.metrics.get(name)?.series.delete(labelKey(labels));
  }

  /** Remove every series that has this label value (e.g. all `portal=123` series on uninstall). */
  removeWhere(label: string, value: string | number): void {
    for (const m of this.metrics.values())
      for (const [k, s] of m.series) if (String(s.labels[label]) === String(value)) m.series.delete(k);
  }

  get(name: string, labels: Labels = {}): number | undefined {
    return this.metrics.get(name)?.series.get(labelKey(labels))?.value;
  }

  /** Sum of a counter/gauge over all its label sets. */
  total(name: string): number {
    let t = 0;
    for (const s of this.metrics.get(name)?.series.values() ?? []) t += s.value;
    return t;
  }

  histogram(name: string, labels: Labels = {}): HistogramStats | undefined {
    return this.metrics.get(name)?.series.get(labelKey(labels))?.hist?.stats();
  }

  snapshot(): MetricSnapshot[] {
    const out: MetricSnapshot[] = [];
    for (const m of [...this.metrics.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      let series: SeriesSnapshot[];
      if (m.collect) {
        const v = safeCollect(m.collect);
        series = v === null ? [] : typeof v === 'number' ? [{ labels: {}, value: v }] : v.map((x) => ({ labels: x.labels, value: x.value }));
      } else {
        series = [...m.series.values()].map((s) => (s.hist ? { labels: { ...s.labels }, stats: s.hist.stats() } : { labels: { ...s.labels }, value: s.value }));
      }
      out.push({ name: m.name, kind: m.kind, help: m.help, series });
    }
    return out;
  }

  /**
   * Compact JSON for /health: { name: value } when unlabelled, { name: { "portal=1": value } } when labelled,
   * histograms as their stats. `perLabelLimit` keeps only the biggest N series per metric (by value / count).
   */
  toJSON(perLabelLimit = 20): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const m of this.snapshot()) {
      if (!m.series.length) continue;
      const unlabelled = m.series.length === 1 && Object.keys(m.series[0].labels).length === 0;
      if (unlabelled) {
        out[m.name] = m.series[0].stats ?? m.series[0].value;
        continue;
      }
      const sorted = [...m.series].sort((a, b) => (b.stats?.count ?? b.value ?? 0) - (a.stats?.count ?? a.value ?? 0));
      const obj: Record<string, unknown> = {};
      for (const s of sorted.slice(0, perLabelLimit)) obj[labelKey(s.labels) || '_'] = s.stats ?? s.value;
      if (sorted.length > perLabelLimit) obj._truncated = sorted.length - perLabelLimit;
      if (m.kind !== 'histogram') obj._total = m.series.reduce((t, s) => t + (s.value ?? 0), 0);
      out[m.name] = obj;
    }
    return out;
  }

  /**
   * Prometheus text exposition format (version 0.0.4).
   * Counters get a `_total` suffix; histograms are exported as `summary` (quantiles computed here).
   */
  toPrometheus(prefix = 'changecatch_'): string {
    const lines: string[] = [];
    for (const m of this.snapshot()) {
      if (!m.series.length) continue;
      const base = prefix + m.name;
      const name = m.kind === 'counter' && !base.endsWith('_total') ? `${base}_total` : base;
      if (m.help) lines.push(`# HELP ${name} ${escapeHelp(m.help)}`);
      lines.push(`# TYPE ${name} ${m.kind === 'histogram' ? 'summary' : m.kind}`);
      for (const s of m.series) {
        if (s.stats) {
          for (const [q, v] of [['0.5', s.stats.p50], ['0.95', s.stats.p95], ['0.99', s.stats.p99]] as const)
            if (v !== null) lines.push(`${name}${fmtLabels({ ...s.labels, quantile: q })} ${fmtNum(v)}`);
          lines.push(`${name}_sum${fmtLabels(s.labels)} ${fmtNum(s.stats.sum)}`);
          lines.push(`${name}_count${fmtLabels(s.labels)} ${fmtNum(s.stats.count)}`);
        } else {
          lines.push(`${name}${fmtLabels(s.labels)} ${fmtNum(s.value ?? 0)}`);
        }
      }
    }
    return lines.join('\n') + '\n';
  }

  reset(): void {
    for (const m of this.metrics.values()) m.series.clear();
  }
}

function safeCollect(f: NonNullable<MetricDef['collect']>): ReturnType<typeof f> {
  try {
    return f();
  } catch {
    return null;
  }
}

const escapeHelp = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
const escapeLabel = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const fmtNum = (v: number) => (Number.isFinite(v) ? String(v) : v > 0 ? '+Inf' : v < 0 ? '-Inf' : 'NaN');
function fmtLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (!keys.length) return '';
  return `{${keys.map((k) => `${k}="${escapeLabel(String(labels[k]))}"`).join(',')}}`;
}

// ---------------------------------------------------------------------------------------------
// ChangeCatch standard metrics
// ---------------------------------------------------------------------------------------------

/** The standard metric names. Prometheus adds the `changecatch_` prefix (and `_total` on counters). */
export const M = {
  journalLagSeconds: 'journal_lag_seconds',
  journalOffsetAgeSeconds: 'journal_offset_age_seconds',
  journalReadAgeSeconds: 'journal_read_age_seconds',
  journalCaughtUp: 'journal_caught_up', // 1 = last batch was not full, 0 = backlog
  journalLastSuccessTs: 'journal_last_success_timestamp_seconds',
  journalReads: 'journal_reads', // {result="ok"|"error"}
  filesRead: 'files_read',
  eventsRead: 'events_read',
  changesProcessed: 'changes_processed', // {portal}
  stampsSent: 'stamps_sent', // {portal}
  stampsFailed: 'stamps_failed', // {portal, reason="retry"|"gave_up"|"dropped"}
  stampQueueDepth: 'stamp_queue_depth', // {portal}
  e2eLatencyMs: 'e2e_latency_ms',
  httpRequests: 'http_requests', // {api}
  httpErrors: 'http_errors', // {status}
  rateLimited: 'rate_limited', // {portal}
  tokenRefreshes: 'token_refreshes', // {result="ok"|"revoked"|"error"}
  dataLoss: 'data_loss', // {reason="dead_letter"|"skipped_entries"|"stamp_dropped"|"journal_gap"|"offset_expired"|"park_dropped"}
} as const;

/**
 * Journal offsets are UUIDv7 (e.g. 01a18abd-74f4-7…), whose first 48 bits are a Unix ms
 * timestamp: the time HubSpot wrote that entry. Returns null for anything else.
 */
export function offsetTimeMs(offset: string): number | null {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(offset.trim());
  if (!m) return null;
  const t = parseInt(m[1] + m[2], 16);
  return t > 1_500_000_000_000 && t < 4_000_000_000_000 ? t : null;
}

/** HTTP statuses kept as their own label value; everything else is bucketed ("4xx", "5xx", "network"). */
const KNOWN_STATUSES = new Set([400, 401, 403, 404, 409, 423, 429, 500, 502, 503, 504]);

export function statusLabel(status: number | string | undefined): string {
  if (typeof status === 'string') return status === 'timeout' || status === 'network' ? status : 'other';
  if (status === undefined || !Number.isFinite(status) || status === 0) return 'network';
  if (KNOWN_STATUSES.has(status)) return String(status);
  return `${Math.floor(status / 100)}xx`;
}

/**
 * Typed wrapper so the worker and the app server record the same names with the same labels.
 * Create one per process (`const metrics = new ChangeCatchMetrics()`), pass it down as a dep.
 */
export class ChangeCatchMetrics {
  readonly registry: MetricsRegistry;
  private lastSuccessAt: number | null = null;
  private offsetTimeMs: number | null = null;

  constructor(registry: MetricsRegistry = new MetricsRegistry()) {
    const r = (this.registry = registry);
    r.define(M.journalLagSeconds, 'gauge', 'Seconds between now and occurredAt of the newest event processed in the last read (0 when caught up)');
    r.defineComputedGauge(M.journalOffsetAgeSeconds, 'Seconds between now and the time inside the saved offset (UUIDv7), or since it was saved', () =>
      this.offsetTimeMs === null ? null : Math.max(0, (r.now() - this.offsetTimeMs) / 1000),
    );
    r.defineComputedGauge(M.journalReadAgeSeconds, 'Seconds since the last successful journal read', () =>
      this.lastSuccessAt === null ? null : Math.max(0, (r.now() - this.lastSuccessAt) / 1000),
    );
    r.define(M.journalCaughtUp, 'gauge', '1 when the last journal batch was not full (no backlog), else 0');
    r.defineComputedGauge(M.journalLastSuccessTs, 'Unix time (s) of the last successful journal read', () =>
      this.lastSuccessAt === null ? null : this.lastSuccessAt / 1000,
    );
    r.define(M.journalReads, 'counter', 'Journal read runs by result');
    r.define(M.filesRead, 'counter', 'Journal files downloaded');
    r.define(M.eventsRead, 'counter', 'Journal events read');
    r.define(M.changesProcessed, 'counter', 'Association changes produced, per portal');
    r.define(M.stampsSent, 'counter', 'Records stamped (CRM batch update accepted), per portal');
    r.define(M.stampsFailed, 'counter', 'Stamps that failed, per portal and reason');
    r.define(M.stampQueueDepth, 'gauge', 'Stamps waiting in the queue, per portal');
    r.define(M.e2eLatencyMs, 'histogram', 'occurredAt -> stamp accepted, milliseconds');
    r.define(M.httpRequests, 'counter', 'HubSpot HTTP requests by API family');
    r.define(M.httpErrors, 'counter', 'HubSpot HTTP errors by status');
    r.define(M.rateLimited, 'counter', '429s or local rate-limiter waits, per portal');
    r.define(M.tokenRefreshes, 'counter', 'Customer OAuth access-token refresh calls to HubSpot, by result (ok | revoked | error)');
    r.define(M.dataLoss, 'counter', 'Changes that will never be stamped (dead-lettered, skipped journal entries, dropped stamps, journal gaps, dropped parked entries)');
  }

  /**
   * After a successful journal run (the offset was saved).
   * `newestOccurredAtMs` = occurredAt of the newest event processed in this run; omit when the run read nothing.
   * `caughtUp` = the batch was not full (no known backlog). Then lag is 0 when nothing new arrived.
   */
  journalRunOk(r: {
    files?: number;
    events?: number;
    newestOccurredAtMs?: number | null;
    /** The offset saved by this run. Its UUIDv7 time drives journal_offset_age_seconds. */
    offset?: string | null;
    offsetSaved?: boolean;
    caughtUp?: boolean;
  }): void {
    const now = this.registry.now();
    this.lastSuccessAt = now;
    if (r.offsetSaved !== false) this.offsetTimeMs = (r.offset ? offsetTimeMs(r.offset) : null) ?? now;
    if (r.caughtUp !== undefined) this.registry.set(M.journalCaughtUp, r.caughtUp ? 1 : 0);
    this.registry.inc(M.journalReads, 1, { result: 'ok' });
    if (r.files) this.registry.inc(M.filesRead, r.files);
    if (r.events) this.registry.inc(M.eventsRead, r.events);
    if (r.newestOccurredAtMs) this.registry.set(M.journalLagSeconds, Math.max(0, (now - r.newestOccurredAtMs) / 1000));
    else if (r.caughtUp !== false) this.registry.set(M.journalLagSeconds, 0);
  }

  journalRunFailed(): void {
    this.registry.inc(M.journalReads, 1, { result: 'error' });
  }

  /** Restore "last success" / "offset saved" times from the store at startup, so ages survive restarts. */
  restore(r: { lastSuccessfulReadAt?: number | null; offset?: string | null }): void {
    if (r.lastSuccessfulReadAt) this.lastSuccessAt = r.lastSuccessfulReadAt;
    const t = (r.offset ? offsetTimeMs(r.offset) : null) ?? r.lastSuccessfulReadAt ?? null;
    if (t) this.offsetTimeMs = t;
  }

  changesProcessed(portalId: number, n = 1): void {
    this.registry.inc(M.changesProcessed, n, { portal: portalId });
  }

  stampsSent(portalId: number, n: number, latenciesMs: number[] = []): void {
    this.registry.inc(M.stampsSent, n, { portal: portalId });
    for (const ms of latenciesMs) this.registry.observe(M.e2eLatencyMs, Math.max(0, ms));
  }

  stampsFailed(portalId: number, n: number, reason: 'retry' | 'gave_up' | 'dropped'): void {
    this.registry.inc(M.stampsFailed, n, { portal: portalId, reason });
  }

  /** Replace all per-portal queue depths (call after each drain with the store's per-portal counts). */
  setStampQueueDepth(depths: Map<number, number> | Record<number, number>): void {
    const entries = depths instanceof Map ? [...depths] : Object.entries(depths).map(([k, v]) => [Number(k), v] as const);
    const live = new Set(entries.map(([p]) => String(p)));
    for (const s of this.registry.snapshot().find((m) => m.name === M.stampQueueDepth)?.series ?? [])
      if (!live.has(String(s.labels.portal))) this.registry.set(M.stampQueueDepth, 0, s.labels);
    for (const [p, v] of entries) this.registry.set(M.stampQueueDepth, v, { portal: p });
  }

  httpRequest(api: 'journal' | 'crm' | 'oauth' | 'subscriptions' | 'other'): void {
    this.registry.inc(M.httpRequests, 1, { api });
  }

  httpError(status: number | 'timeout' | 'network' | undefined): void {
    this.registry.inc(M.httpErrors, 1, { status: statusLabel(status) });
  }

  /** One customer access-token refresh call to HubSpot (callers that joined it via single-flight are not counted). */
  tokenRefresh(result: 'ok' | 'revoked' | 'error'): void {
    this.registry.inc(M.tokenRefreshes, 1, { result });
  }

  /** portalId undefined = app-level (journal/subscriptions) limit. */
  rateLimited(portalId?: number): void {
    this.registry.inc(M.rateLimited, 1, { portal: portalId ?? 'app' });
  }

  /**
   * Something that should have become a stamp never will. Any increase should page someone.
   * reason: dead_letter (gave up after retries), skipped_entries (journal entries we could not parse/process),
   * stamp_dropped (CRM rejected the record, e.g. deleted), journal_gap (offset expired: >3 days behind, HTTP 404),
   * offset_expired (offset expired but HubSpot returned an EMPTY read; detected via earliest).
   */
  dataLoss(reason: 'dead_letter' | 'skipped_entries' | 'stamp_dropped' | 'journal_gap' | 'offset_expired' | 'park_dropped', n = 1, portalId?: number): void {
    if (n > 0) this.registry.inc(M.dataLoss, n, { reason, portal: portalId ?? 'app' });
  }

  /** Drop every series for a portal (on uninstall). */
  forgetPortal(portalId: number): void {
    this.registry.removeWhere('portal', portalId);
  }

  /** JSON for /health. */
  toJSON(): Record<string, unknown> {
    return this.registry.toJSON();
  }

  toPrometheus(): string {
    return this.registry.toPrometheus();
  }
}

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
