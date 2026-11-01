import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryLogger, redact, redactString, REDACTED } from './log.js';
import { ChangeCatchMetrics, MetricsRegistry, M, OVERFLOW_VALUE, offsetTimeMs, statusLabel } from './metrics.js';
import { Errors, fingerprintOf, initErrorReporting, LogReporter, SentryReporter, type ErrorReporter } from './errors.js';
import { Heartbeat } from './heartbeat.js';

// ------------------------------------------------------------------ log

const SECRETS = {
  bearer: 'Bearer CJSP5qf1MhICAQEYxI3cBCDQ9vQJKIqDZTIUa2Vk0jL3yQh8fFQ2XlFzEXAMPLE',
  pat: 'pat-' + 'na1-11111111-2222-3333-4444-555555555555',
  refresh: 'na1-6a2b-1c3d-4e5f-8a9b-0c1d2e3f4a5b',
  hex: 'a3f5c8e1d2b4a6978877665544332211ffeeddcc',
  b64: 'dGhpcyBpcyBhIHNlY3JldCBrZXkgZm9yIHRlc3RpbmcgMTIzNDU2Nzg5MA==',
  jwt: 'eyJhbGciOiJIUzI1NiJ9' + '.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
};

test('redactString hides bearer, pat-, refresh tokens, hex, base64, JWT, query secrets', () => {
  for (const [kind, s] of Object.entries(SECRETS)) {
    const out = redactString(`before ${s} after`);
    const core = kind === 'bearer' ? s.slice('Bearer '.length) : s;
    assert.ok(!out.includes(core), `${kind} leaked: ${out}`);
    assert.ok(out.includes(REDACTED), `${kind} not marked: ${out}`);
  }
  const url = redactString('POST /oauth/v3/token?grant_type=refresh_token&refresh_token=abc123&client_secret=shh');
  assert.ok(!url.includes('abc123') && !url.includes('shh'), url);
  assert.ok(url.includes('grant_type=refresh_token'));
  const json = redactString('{"access_token":"xyz-short","expires_in":1800}');
  assert.ok(!json.includes('xyz-short') && json.includes('"expires_in":1800'), json);
  const dsn = redactString('https://abcdef@o123.ingest.sentry.io/456');
  assert.ok(!dsn.includes('abcdef@'), dsn);
});

test('redactString keeps ordinary values: journal offsets (UUIDs), ids, paths, type ids', () => {
  const s = 'offset 01a18abd-74f4-7049-9366-d6a284ab7e87 portal 1234567 /crm/objects/2026-03/0-3/batch/update 2-12345678 code=ECONN';
  assert.equal(redactString(s.replace(' code=ECONN', '')), s.replace(' code=ECONN', ''));
});

test('redact() hides secret keys deeply and keeps error codes', () => {
  const out = redact({
    portalId: 1,
    accessToken: 'short',
    nested: { refresh_token: 'x', HUBSPOT_CLIENT_SECRET: 'y', headers: { Authorization: 'Bearer abc' } },
    code: 'ECONNRESET',
    status: 429,
    list: [{ token: 't' }],
  }) as any;
  assert.equal(out.accessToken, REDACTED);
  assert.equal(out.nested.refresh_token, REDACTED);
  assert.equal(out.nested.HUBSPOT_CLIENT_SECRET, REDACTED);
  assert.equal(out.nested.headers.Authorization, REDACTED);
  assert.equal(out.list[0].token, REDACTED);
  assert.equal(out.code, 'ECONNRESET');
  assert.equal(out.status, 429);
  assert.equal((redact({ code: 'a1b2-c3d4-oauth-code' }) as any).code, REDACTED);
  const cyc: any = { a: 1 };
  cyc.self = cyc;
  assert.equal((redact(cyc) as any).self, '[circular]');
});

test('logger writes one JSON line with the standard shape, redacted, honours level', () => {
  const { log, records, lines } = memoryLogger('worker', 'info');
  log.debug('noise', 'hidden');
  log.child({ portalId: 42 }).info('stamp_sent', `sent with ${SECRETS.bearer}`, { token: 'tkn', n: 3, err: new Error(`bad ${SECRETS.pat}`) });
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.level, 'info');
  assert.equal(rec.component, 'worker');
  assert.equal(rec.portalId, 42);
  assert.equal(rec.event, 'stamp_sent');
  assert.match(rec.ts, /^\d{4}-\d\d-\d\dT/);
  assert.equal(rec.token, REDACTED);
  assert.equal(rec.n, 3);
  for (const s of [SECRETS.pat, SECRETS.bearer.slice(7)]) assert.ok(!lines[0].includes(s), 'secret leaked into log line');
  assert.equal(records[0].msg.includes(REDACTED), true);
});

test('logger legacy adapter fits the existing (level, msg) callbacks', () => {
  const { log, records } = memoryLogger('worker');
  log.asLegacy('worker_log')('warn', 'batch HELD');
  assert.equal(records[0].level, 'warn');
  assert.equal(records[0].event, 'worker_log');
});

// ------------------------------------------------------------------ metrics

test('counters, gauges, histograms with percentiles', () => {
  const r = new MetricsRegistry();
  r.inc('c', 2, { portal: 1 });
  r.inc('c', 3, { portal: 1 });
  r.inc('c', -5, { portal: 1 }); // ignored
  r.set('g', 7);
  r.add('g', -2);
  for (let i = 1; i <= 100; i++) r.observe('h', i);
  assert.equal(r.get('c', { portal: 1 }), 5);
  assert.equal(r.get('g'), 5);
  const h = r.histogram('h')!;
  assert.deepEqual([h.p50, h.p95, h.p99, h.count, h.sum], [50, 95, 99, 100, 5050]);
  assert.throws(() => r.set('c', 1), /is a counter/);
});

test('cardinality is bounded: extra label sets fold into _other', () => {
  const r = new MetricsRegistry({ maxSeriesPerMetric: 3 });
  for (let p = 1; p <= 10; p++) r.inc('changes', 1, { portal: p });
  const s = r.snapshot().find((m) => m.name === 'changes')!;
  assert.equal(s.series.length, 4); // 3 real + 1 overflow
  assert.equal(r.get('changes', { portal: OVERFLOW_VALUE }), 7);
  assert.equal(r.total('changes'), 10);
  assert.equal(r.get('metrics_series_overflow', { metric: 'changes' }), 7);
});

test('histogram window is bounded', () => {
  const r = new MetricsRegistry({ histogramWindow: 10 });
  for (let i = 0; i < 1000; i++) r.observe('h', i);
  const h = r.histogram('h')!;
  assert.equal(h.windowCount, 10);
  assert.equal(h.count, 1000);
  assert.equal(h.p50, 994);
});

test('Prometheus export format', () => {
  let now = 1_000_000;
  const m = new ChangeCatchMetrics(new MetricsRegistry({ now: () => now }));
  m.journalRunOk({ files: 2, events: 5, newestOccurredAtMs: now - 4000 });
  m.changesProcessed(1234567, 3);
  m.stampsSent(1234567, 2, [1200, 3400]);
  m.httpError(429);
  m.httpError(418);
  m.rateLimited(1234567);
  m.setStampQueueDepth(new Map([[1234567, 4]]));
  m.dataLoss('dead_letter', 1, 1234567);
  now += 30_000;
  const txt = m.toPrometheus();
  assert.match(txt, /# TYPE changecatch_changes_processed_total counter\nchangecatch_changes_processed_total\{portal="1234567"\} 3\n/);
  assert.match(txt, /changecatch_journal_lag_seconds 4\n/);
  assert.match(txt, /changecatch_journal_offset_age_seconds 30\n/);
  assert.match(txt, /changecatch_journal_last_success_timestamp_seconds 1000\n/);
  assert.match(txt, /# TYPE changecatch_e2e_latency_ms summary/);
  assert.match(txt, /changecatch_e2e_latency_ms\{quantile="0.95"\} 3400/);
  assert.match(txt, /changecatch_e2e_latency_ms_count 2/);
  assert.match(txt, /changecatch_http_errors_total\{status="429"\} 1/);
  assert.match(txt, /changecatch_http_errors_total\{status="4xx"\} 1/);
  assert.match(txt, /changecatch_stamp_queue_depth\{portal="1234567"\} 4/);
  assert.match(txt, /changecatch_data_loss_total\{portal="1234567",reason="dead_letter"\} 1/);
  for (const line of txt.trim().split('\n')) assert.match(line, /^(# (HELP|TYPE) \S+ .+|[a-z0-9_]+(\{[^}]*\})? [-+0-9.eInfNa]+)$/, line);
});

test('JSON snapshot for /health; queue depth resets portals that drained; forgetPortal', () => {
  const m = new ChangeCatchMetrics();
  m.setStampQueueDepth({ 1: 5, 2: 3 });
  m.setStampQueueDepth({ 2: 1 });
  assert.equal(m.registry.get(M.stampQueueDepth, { portal: 1 }), 0);
  m.stampsSent(1, 3, [10]);
  const j = m.toJSON() as any;
  assert.equal(j.stamp_queue_depth['portal=2'], 1);
  assert.equal(j.stamp_queue_depth._total, 1);
  assert.equal(j.e2e_latency_ms.count, 1);
  m.forgetPortal(1);
  assert.equal(m.registry.get(M.stampsSent, { portal: 1 }), undefined);
  assert.equal(JSON.parse(JSON.stringify(j)).stamps_sent['portal=1'], 3);
});

test('journal lag is 0 when caught up and nothing new was read', () => {
  const m = new ChangeCatchMetrics();
  m.journalRunOk({ newestOccurredAtMs: Date.now() - 60_000 });
  assert.ok(m.registry.get(M.journalLagSeconds)! >= 59);
  m.journalRunOk({ events: 0, caughtUp: true });
  assert.equal(m.registry.get(M.journalLagSeconds), 0);
  assert.equal(statusLabel(undefined), 'network');
});

test('offset age comes from the UUIDv7 time inside the offset', () => {
  assert.equal(new Date(offsetTimeMs('01a18abd-74f4-7049-9366-d6a284ab7e87')!).toISOString(), '2026-10-30T02:57:14.484Z');
  assert.equal(offsetTimeMs('not-an-offset'), null);
  const t0 = offsetTimeMs('01a18abd-74f4-7049-9366-d6a284ab7e87')!;
  const m = new ChangeCatchMetrics(new MetricsRegistry({ now: () => t0 + 120_000 }));
  m.journalRunOk({ offset: '01a18abd-74f4-7049-9366-d6a284ab7e87', caughtUp: false });
  assert.equal(m.registry.snapshot().find((x) => x.name === M.journalOffsetAgeSeconds)!.series[0].value, 120);
  assert.equal(m.registry.get(M.journalCaughtUp), 0);
});

// ------------------------------------------------------------------ errors

class FakeReporter implements ErrorReporter {
  readonly name = 'fake';
  calls: { err: unknown; ctx: any }[] = [];
  captureException(err: unknown, ctx: any) {
    this.calls.push({ err, ctx });
  }
  captureMessage(msg: string, ctx: any) {
    this.calls.push({ err: msg, ctx });
  }
  async flush() {
    return true;
  }
}

test('errors are throttled per fingerprint and report the suppressed count', () => {
  let now = 0;
  const rep = new FakeReporter();
  const e = new Errors({ reporter: rep, dedupeWindowMs: 1000, now: () => now });
  assert.equal(e.capture(new Error('portal 1 failed 429'), { op: 'stamp' }), true);
  assert.equal(e.capture(new Error('portal 2 failed 503'), { op: 'stamp' }), false); // same shape
  assert.equal(e.capture(new Error('other thing'), { op: 'stamp' }), true);
  now = 2000;
  assert.equal(e.capture(new Error('portal 3 failed 500'), { op: 'stamp' }), true);
  assert.equal(rep.calls.length, 3);
  assert.equal(rep.calls[2].ctx.extra.suppressedSinceLast, 1);
  assert.equal(fingerprintOf(new Error('x 12'), { op: 'a' }), fingerprintOf(new Error('x 99'), { op: 'a' }));
});

test('Sentry reporter redacts error text and extras', () => {
  const sent: any = { extras: null, err: null, tags: {} };
  const fake = {
    init() {},
    withScope(cb: any) {
      cb({ setTag: (k: string, v: string) => (sent.tags[k] = v), setExtras: (x: any) => (sent.extras = x), setFingerprint() {}, setLevel() {} });
    },
    captureException(err: unknown) {
      sent.err = err;
      return 'id';
    },
    captureMessage() {
      return 'id';
    },
    async flush() {
      return true;
    },
  };
  new SentryReporter(fake).captureException(new Error(`oops ${SECRETS.bearer}`), { portalId: 5, extra: { refreshToken: 'r', n: 1 } });
  assert.ok(!(sent.err as Error).message.includes(SECRETS.bearer.slice(7)));
  assert.equal(sent.extras.refreshToken, REDACTED);
  assert.equal(sent.tags.portalId, '5');
});

test('initErrorReporting: no DSN -> log; DSN without package -> log + warning; DSN with package -> sentry', async () => {
  const { log, records } = memoryLogger('errors');
  const target = new Errors();
  assert.equal(await initErrorReporting({ env: {}, log, target }), 'log');
  assert.ok(target.reporter instanceof LogReporter);
  const missing = async () => {
    throw new Error("Cannot find package '@sentry/node'");
  };
  assert.equal(await initErrorReporting({ env: { SENTRY_DSN: 'https://k@o1.ingest.sentry.io/2' }, log, target, load: missing }), 'log');
  assert.ok(records.some((r) => r.level === 'warn' && r.msg.includes('add @sentry/node')));
  let initOpts: any;
  const fakeMod = { init: (o: any) => (initOpts = o), withScope() {}, captureException: () => '', captureMessage: () => '', flush: async () => true };
  assert.equal(await initErrorReporting({ env: { SENTRY_DSN: 'https://k@o1.ingest.sentry.io/2' }, log, target, load: async () => fakeMod }), 'sentry');
  assert.equal(initOpts.sendDefaultPii, false);
  assert.equal(initOpts.beforeSend({ request: { headers: { authorization: 'Bearer x' } } }).request.headers.authorization, REDACTED);
});

// ------------------------------------------------------------------ heartbeat

test('heartbeat: off without URL; ok throttled to 60 s; fail goes to /fail at once; never throws', async () => {
  assert.equal(new Heartbeat({ url: '' }).enabled, false);
  assert.equal(await new Heartbeat({ url: null }).ok(), false);
  let now = 0;
  const calls: { url: string; method?: string; body?: string }[] = [];
  let fail = false;
  const hb = new Heartbeat({
    url: 'https://hc-ping.com/abc/',
    now: () => now,
    fetch: async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body });
      if (fail) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200 };
    },
    log: memoryLogger('hb').log,
  });
  assert.equal(await hb.ok(), true);
  now = 30_000;
  assert.equal(await hb.ok(), false); // throttled
  assert.equal(await hb.fail(`stale; ${SECRETS.pat}`), true); // state change: sent at once
  assert.equal(calls[1].url, 'https://hc-ping.com/abc/fail');
  assert.ok(!calls[1].body!.includes(SECRETS.pat));
  now = 40_000;
  assert.equal(await hb.ok(), true); // back to ok: sent at once
  now = 200_000;
  fail = true;
  assert.equal(await hb.ok(), false); // network error swallowed
  fail = false;
  now = 200_001;
  assert.equal(await hb.ok(), true); // retried right away after a failure
  assert.deepEqual(calls.map((c) => c.url.endsWith('/fail')), [false, true, false, false, false]);
});
