// Wiring of src/obs into the worker: structured logs (+ redaction), heartbeat timing, error reporter on alerts,
// HTTP metrics through the fetch wrapper, and data_loss counters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../store/db.js';
import { file } from '../core/testutil.js';
import type { JournalReadResult } from '../core/poller.js';
import { HttpError } from '../lib/http.js';
import { memoryLogger } from '../obs/log.js';
import { Errors, type ErrorContext, type ErrorReporter } from '../obs/errors.js';
import { Heartbeat } from '../obs/heartbeat.js';
import { ChangeCatchMetrics } from '../obs/metrics.js';
import { apiFamily, classifiedLog, instrumentFetch, legacyLog } from '../obs/wiring.js';
import { LabelHoldError } from './label-guard.js';
import { StampQueue } from './stamp-queue.js';
import { StaleAlerter } from './health.js';
import { Worker } from './main.js';
import { makeJournalReader, type JournalApi } from './journal-reader.js';

const quiet = () => {};
const SECRET_PAT = 'pat-' + 'na1-1a2b3c4d-5e6f-7a8b-9c0d-112233445566';
const SECRET_BEARER = 'Bearer CJTq9bXyMBIHAAEAQAAAARjKsfI2IMXvsx4o9qMBMhSb2LHbM0aT1dXl0Z3Q6NoXkZ8';

class FakeReporter implements ErrorReporter {
  readonly name = 'fake';
  exceptions: { err: unknown; ctx: ErrorContext }[] = [];
  messages: { msg: string; ctx: ErrorContext }[] = [];
  captureException(err: unknown, ctx: ErrorContext): void {
    this.exceptions.push({ err, ctx });
  }
  captureMessage(msg: string, ctx: ErrorContext): void {
    this.messages.push({ msg, ctx });
  }
  async flush(): Promise<boolean> {
    return true;
  }
}

function makeWorker(o: {
  clock: { t: number };
  readJournal: (after: string | null) => Promise<JournalReadResult>;
  log?: ReturnType<typeof legacyLog>;
  errors?: Errors;
  pulse?: Heartbeat;
  alerter?: StaleAlerter;
  stopAfterMs?: number;
  verbose?: boolean;
}) {
  const store = new Store(':memory:');
  const now = () => o.clock.t;
  const queue = new StampQueue({ store, tokens: { getAccessToken: async () => 'tok' }, now, log: quiet, sendBatches: async (u) => u.map((x) => ({ update: x, ok: true as const })) });
  let worker: Worker;
  const end = o.clock.t + (o.stopAfterMs ?? 0);
  worker = new Worker({
    store,
    readJournal: o.readJournal,
    labels: { get: async () => { throw new Error('not used'); } } as never,
    queue,
    now,
    log: o.log ?? quiet,
    errors: o.errors,
    pulse: o.pulse,
    alerter: o.alerter ?? new StaleAlerter(15 * 60_000, quiet),
    verbose: o.verbose,
    sleep: async (ms) => {
      o.clock.t += ms;
      if (o.clock.t >= end) void worker.stop();
    },
  });
  return { worker, store };
}

const empty = async (): Promise<JournalReadResult> => ({ files: [], nextOffset: null, full: false });

// ---------------------------------------------------------------- logs

test('worker logs: JSON shape (level, ts, component, event, fields), secrets redacted on the failure path', async () => {
  const mem = memoryLogger('worker', 'debug');
  const reporter = new FakeReporter();
  const errs = new Errors({ reporter });
  const clock = { t: Date.now() };
  const { worker } = makeWorker({
    clock,
    log: legacyLog(mem.log, { errors: errs }),
    errors: errs,
    readJournal: async () => {
      throw new Error(`GET /webhooks-journal/journal/2026-03/batch failed: Authorization: ${SECRET_BEARER} token=${SECRET_PAT}`);
    },
  });
  await worker.readOnce();
  const rec = mem.records.find((r) => r.event === 'journal_run_failed');
  assert.ok(rec, 'journal_run_failed logged');
  assert.equal(rec.level, 'error');
  assert.equal(rec.component, 'worker');
  assert.match(rec.ts, /^\d{4}-\d\d-\d\dT/);
  for (const line of mem.lines) {
    assert.doesNotMatch(line, /CJTq9bXy|pat-na1-1a2b/, 'no secret in any log line');
    assert.doesNotThrow(() => JSON.parse(line));
  }
  assert.match(mem.lines.join('\n'), /\[REDACTED\]/);
  // Unexpected failure -> reported once, with component + op.
  assert.equal(reporter.exceptions.length, 1);
  assert.equal(reporter.exceptions[0].ctx.op, 'journal_run');
  assert.equal(reporter.exceptions[0].ctx.component, 'worker');
});

test('worker logs: a successful read logs event journal_read with numeric fields', async () => {
  const mem = memoryLogger('worker', 'debug');
  const clock = { t: Date.now() };
  const { worker } = makeWorker({
    clock,
    log: legacyLog(mem.log, { errors: null }),
    verbose: true,
    readJournal: async () => ({ files: [file('o1', [])], nextOffset: 'o1', full: false }),
  });
  await worker.readOnce();
  const rec = mem.records.find((r) => r.event === 'journal_read');
  assert.ok(rec);
  assert.equal(rec.level, 'info');
  assert.equal(rec.files, 1);
  assert.equal(rec.offset, 'o1');
});

test('expected states (held labels) are logged as warn and NOT reported', async () => {
  const mem = memoryLogger('worker', 'debug');
  const reporter = new FakeReporter();
  const errs = new Errors({ reporter });
  const { worker } = makeWorker({
    clock: { t: Date.now() },
    log: legacyLog(mem.log, { errors: errs }),
    errors: errs,
    readJournal: async () => {
      throw new LabelHoldError('111|0-3|0-1|101', 'labels down');
    },
  });
  await worker.readOnce();
  assert.equal(mem.records.find((r) => r.event === 'batch_held')?.level, 'warn');
  assert.equal(reporter.exceptions.length + reporter.messages.length, 0);
});

// ---------------------------------------------------------------- alerts -> reporter

test('[ALERT] lines become level=error event=alert with portalId, and call the reporter (redacted, throttled)', () => {
  const mem = memoryLogger('stamp', 'debug');
  const reporter = new FakeReporter();
  const errs = new Errors({ reporter, now: () => 0 });
  const log = legacyLog(mem.log, { errors: errs });
  log('warn', `[ALERT] portal 4242: token revoked/invalid; PAUSED: ${SECRET_PAT}`);
  log('warn', `[ALERT] portal 4242: token revoked/invalid; PAUSED: ${SECRET_PAT}`); // same shape: throttled
  log('info', '[ALERT-CLEARED] journal reads are succeeding again');
  const [a, , cleared] = mem.records;
  assert.equal(a.level, 'error');
  assert.equal(a.event, 'alert');
  assert.equal(a.portalId, 4242);
  assert.doesNotMatch(a.msg, /\[ALERT\]|pat-na1/);
  assert.equal(cleared.level, 'info');
  assert.equal(cleared.event, 'alert_cleared');
  assert.equal(reporter.messages.length, 1, 'reported once (repeat throttled)');
  assert.equal(reporter.messages[0].ctx.op, 'alert');
  assert.equal(reporter.messages[0].ctx.portalId, 4242);
  assert.equal(reporter.messages[0].ctx.component, 'stamp');
});

test('stale alert from the worker loop reaches the reporter', async () => {
  const mem = memoryLogger('worker', 'debug');
  const reporter = new FakeReporter();
  const errs = new Errors({ reporter });
  const clock = { t: Date.now() };
  const log = legacyLog(mem.log, { errors: errs });
  const { worker } = makeWorker({
    clock,
    log,
    errors: errs,
    alerter: new StaleAlerter(15 * 60_000, (m) => log('error', m)),
    stopAfterMs: 62 * 60_000,
    readJournal: async () => {
      throw new HttpError(503, {}, 'journal down');
    },
  });
  await worker.run();
  assert.ok(reporter.messages.some((m) => m.ctx.op === 'alert' && /no successful journal read/.test(m.msg)));
  assert.ok(mem.records.some((r) => r.event === 'alert' && r.level === 'error'));
});

test('app server lines: level + event from the text; failures reported', () => {
  const mem = memoryLogger('app', 'debug');
  const reporter = new FakeReporter();
  const log = classifiedLog(mem.log, { errors: new Errors({ reporter }), fallbackEvent: 'app' });
  log('oauth[ab12]: install for portal 77 (install)');
  log('settings[cd34]: rejected signature (v3: stale)');
  log(`install[ef56]: provisioning failed: refresh_token=${SECRET_PAT}`);
  assert.deepEqual(mem.records.map((r) => [r.level, r.event]), [['info', 'oauth'], ['warn', 'settings'], ['error', 'install']]);
  assert.equal(mem.records[0].portalId, 77);
  assert.equal(reporter.messages.length, 1);
  assert.equal(reporter.messages[0].ctx.op, 'install');
  assert.doesNotMatch(mem.lines.join('\n'), /pat-na1-1a2b/);
});

// ---------------------------------------------------------------- heartbeat timing

test('heartbeat: ok after successful reads at most once a minute; /fail when stale; ok again at once on recovery', async () => {
  const clock = { t: Date.now() };
  const pings: { at: number; url: string }[] = [];
  const pulse = new Heartbeat({
    url: 'https://hc.example/ping/uuid',
    now: () => clock.t,
    fetch: async (url) => {
      pings.push({ at: clock.t, url });
      return { ok: true, status: 200 };
    },
    log: memoryLogger('heartbeat').log,
  });
  const start = clock.t;
  let failing = false;
  const { worker } = makeWorker({
    clock,
    pulse,
    readJournal: async () => {
      if (failing) throw new HttpError(503, {}, 'down');
      return empty();
    },
    stopAfterMs: 10 * 60_000,
  });

  // Phase 1: 10 min of successful reads every ~3 s -> about one ping a minute, never closer than 60 s.
  await worker.run();
  const ok1 = pings.filter((p) => p.url === 'https://hc.example/ping/uuid');
  assert.ok(ok1.length >= 9 && ok1.length <= 11, `~10 ok pings in 10 min, got ${ok1.length}`);
  for (let i = 1; i < ok1.length; i++) assert.ok(ok1[i].at - ok1[i - 1].at >= 60_000, 'ok pings >= 60 s apart');
  assert.equal(pings.filter((p) => p.url.endsWith('/fail')).length, 0);

  // Phase 2: reads fail. No ok pings; /fail only once the last success is 1 h old.
  failing = true;
  const lastOk = clock.t;
  const n0 = pings.length;
  const w2 = makeWorker({ clock, pulse, errors: new Errors({ reporter: new FakeReporter() }), readJournal: async () => { throw new HttpError(503, {}, 'down'); }, stopAfterMs: 75 * 60_000 });
  w2.store.setLastSuccessfulReadAt(lastOk);
  await w2.worker.run();
  const phase2 = pings.slice(n0);
  assert.equal(phase2.filter((p) => !p.url.endsWith('/fail')).length, 0, 'no ok ping while failing');
  const fails = phase2.filter((p) => p.url.endsWith('/fail'));
  assert.ok(fails.length >= 1, 'fail ping sent');
  assert.ok(fails[0].at - lastOk >= 60 * 60_000, 'not before 1 h without a successful read');
  assert.ok(fails[0].at - lastOk < 62 * 60_000, 'promptly after 1 h');
  for (let i = 1; i < fails.length; i++) assert.ok(fails[i].at - fails[i - 1].at >= 60_000, 'fail pings throttled');

  // Phase 3: a successful read -> an ok ping right away (state change is not throttled).
  const t3 = clock.t;
  const w3 = makeWorker({ clock, pulse, readJournal: empty });
  await w3.worker.readOnce();
  const last = pings.at(-1)!;
  assert.equal(last.url, 'https://hc.example/ping/uuid');
  assert.equal(last.at, t3);
  assert.ok(start < t3);
});

// ---------------------------------------------------------------- metrics wiring

test('instrumentFetch: http_requests by api, http_errors by status, rate_limited on 429; other hosts ignored', async () => {
  const metrics = new ChangeCatchMetrics();
  const statuses = new Map<string, number>([
    ['https://api.hubapi.com/webhooks-journal/journal/2026-03/batch/next', 200],
    ['https://api.hubapi.com/crm/objects/2026-03/deals/batch/update', 429],
    ['https://api.hubapi.com/oauth/v3/token', 401],
  ]);
  const target = {
    fetch: (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes('network')) throw new TypeError('fetch failed');
      return new Response('', { status: statuses.get(u) ?? 200 });
    }) as typeof fetch,
  };
  const restore = instrumentFetch(metrics, { target, portalForToken: (t) => (t === 'tok-111' ? 111 : undefined) });
  await target.fetch('https://api.hubapi.com/webhooks-journal/journal/2026-03/batch/next');
  await target.fetch('https://api.hubapi.com/crm/objects/2026-03/deals/batch/update', { headers: { Authorization: 'Bearer tok-111' } });
  await target.fetch('https://api.hubapi.com/oauth/v3/token');
  await target.fetch('https://hc-ping.com/uuid');
  await assert.rejects(target.fetch('https://api.hubapi.com/crm/network'));
  restore();
  const g = (n: string, l: Record<string, string | number>) => metrics.registry.get(n, l);
  assert.equal(g('http_requests', { api: 'journal' }), 1);
  assert.equal(g('http_requests', { api: 'crm' }), 2);
  assert.equal(g('http_requests', { api: 'oauth' }), 1);
  assert.equal(g('http_errors', { status: '429' }), 1);
  assert.equal(g('http_errors', { status: '401' }), 1);
  assert.equal(g('http_errors', { status: 'network' }), 1);
  assert.equal(g('rate_limited', { portal: 111 }), 1);
  assert.equal(apiFamily(new URL('https://hc-ping.com/x')), null);
  assert.equal(apiFamily(new URL('https://hubspot-journal.s3.us-east-1.amazonaws.com/f')), 'journal');
  assert.equal(apiFamily(new URL('https://api.hubapi.com/webhooks-journal/subscriptions/2026-03')), 'subscriptions');
});

test('journal reader: expired offset counts data_loss{reason=journal_gap}', async () => {
  const store = new Store(':memory:');
  const metrics = new ChangeCatchMetrics();
  const api = {
    latest: async () => null,
    batchNext: async () => {
      throw new HttpError(404, {}, 'gone');
    },
    batchEarliest: async () => undefined,
    download: async () => {
      throw new Error('unused');
    },
  } as unknown as JournalApi;
  const read = makeJournalReader(api, { store, log: quiet, metrics });
  await read('old');
  assert.equal(metrics.registry.get('data_loss', { reason: 'journal_gap', portal: 'app' }), 1);
});
