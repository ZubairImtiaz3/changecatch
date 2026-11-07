// Wiring of src/obs into the worker: structured logs (+ redaction), heartbeat timing, one log line per failure or
// alert (no second copy through an error reporter).
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ev, file } from '../../test/fixtures/journal.js';
import { memoryLogger } from '../../test/fixtures/log.js';
import { closeWorkerHarnesses, workerHarness } from '../../test/fixtures/worker.js';
import type { JournalReadResult } from '../core/poller.js';
import { HubSpotError } from '../lib/http.js';
import { Heartbeat } from '../obs/heartbeat.js';
import { isStale, STALE_AFTER_MS } from './health.js';
import { LabelHoldError } from '../core/labels.js';

afterEach(closeWorkerHarnesses);

const SECRET_PAT = 'pat-' + 'na1-1a2b3c4d-5e6f-7a8b-9c0d-112233445566';
const SECRET_BEARER = 'Bearer CJTq9bXyMBIHAAEAQAAAARjKsfI2IMXvsx4o9qMBMhSb2LHbM0aT1dXl0Z3Q6NoXkZ8';

const empty = async (): Promise<JournalReadResult> => ({ files: [], nextOffset: null, full: false });

// ---------------------------------------------------------------- logs

test('worker logs: JSON shape (level, ts, component, event, fields), secrets redacted on the failure path', async () => {
  const mem = memoryLogger('worker', 'debug');
  const clock = { t: Date.now() };
  const { worker } = workerHarness({
    clock,
    log: mem.log,
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
  // Unexpected failure -> exactly one error line, with the error (stack) attached.
  const errorLines = mem.records.filter((r) => r.level === 'error');
  assert.deepEqual(errorLines.map((r) => r.event), ['journal_run_failed']);
  assert.equal((rec.error as { message: string }).message.includes('[REDACTED]'), true);
});

test('worker logs: a successful read logs event journal_read with numeric fields', async () => {
  const mem = memoryLogger('worker', 'debug');
  const clock = { t: Date.now() };
  const { worker } = workerHarness({
    clock,
    log: mem.log,
    readJournal: async () => ({ files: [file('o1', [ev()])], nextOffset: 'o1', full: false }),
  });
  await worker.readOnce();
  const rec = mem.records.find((r) => r.event === 'journal_read');
  assert.ok(rec);
  assert.equal(rec.level, 'info');
  assert.equal(rec.files, 1);
  assert.equal(rec.offset, 'o1');
});

test('expected states (held labels) are logged as warn, never as an error', async () => {
  const mem = memoryLogger('worker', 'debug');
  const { worker } = workerHarness({
    clock: { t: Date.now() },
    log: mem.log,
    readJournal: async () => {
      throw new LabelHoldError('111|0-3|0-1|101', 'labels down');
    },
  });
  await worker.readOnce();
  assert.equal(mem.records.find((r) => r.event === 'batch_held')?.level, 'warn');
  assert.equal(mem.records.filter((r) => r.level === 'error').length, 0);
});

// ---------------------------------------------------------------- alerts

test('stale alert from the worker loop: one line per alert', async () => {
  const mem = memoryLogger('worker', 'debug');
  const clock = { t: Date.now() };
  const { runUntil } = workerHarness({
    clock,
    log: mem.log,
    readJournal: async () => {
      throw HubSpotError.fromStatus(503, {}, 'journal down');
    },
  });
  await runUntil(clock.t + 62 * 60_000);
  const stale = mem.records.filter((r) => r.event === 'alert' && r.alert === 'worker_stale');
  assert.equal(stale.length, 1, 'fired once in 62 min (repeats every 15 min after the first at 60 min)');
  assert.equal(stale[0].level, 'error');
  assert.match(stale[0].msg, /no successful journal read/);
  assert.equal(mem.lines.filter((l) => l.includes('no successful journal read')).length, 1, 'no second copy of the alert');
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
  const w1 = workerHarness({
    clock,
    pulse,
    readJournal: async () => {
      if (failing) throw HubSpotError.fromStatus(503, {}, 'down');
      return empty();
    },
  });

  // Phase 1: 10 min of successful reads every ~3 s -> about one ping a minute, never closer than 60 s.
  await w1.runUntil(clock.t + 10 * 60_000);
  const ok1 = pings.filter((p) => p.url === 'https://hc.example/ping/uuid');
  assert.ok(ok1.length >= 9 && ok1.length <= 11, `~10 ok pings in 10 min, got ${ok1.length}`);
  for (let i = 1; i < ok1.length; i++) assert.ok(ok1[i].at - ok1[i - 1].at >= 60_000, 'ok pings >= 60 s apart');
  assert.equal(pings.filter((p) => p.url.endsWith('/fail')).length, 0);

  // Phase 2: reads fail. No ok pings; /fail only once the last success is 1 h old.
  failing = true;
  const lastOk = clock.t;
  const n0 = pings.length;
  const w2 = workerHarness({ clock, pulse, readJournal: async () => { throw HubSpotError.fromStatus(503, {}, 'down'); } });
  w2.store.journal.setLastSuccessfulReadAt(lastOk);
  await w2.runUntil(clock.t + 75 * 60_000);
  const phase2 = pings.slice(n0);
  assert.equal(phase2.filter((p) => !p.url.endsWith('/fail')).length, 0, 'no ok ping while failing');
  const fails = phase2.filter((p) => p.url.endsWith('/fail'));
  assert.ok(fails.length >= 1, 'fail ping sent');
  assert.ok(fails[0].at - lastOk >= 60 * 60_000, 'not before 1 h without a successful read');
  assert.ok(fails[0].at - lastOk < 62 * 60_000, 'promptly after 1 h');
  for (let i = 1; i < fails.length; i++) assert.ok(fails[i].at - fails[i - 1].at >= 60_000, 'fail pings throttled');

  // Phase 3: a successful read -> an ok ping right away (state change is not throttled).
  const t3 = clock.t;
  const w3 = workerHarness({ clock, pulse, readJournal: empty });
  await w3.worker.readOnce();
  const last = pings.at(-1)!;
  assert.equal(last.url, 'https://hc.example/ping/uuid');
  assert.equal(last.at, t3);
  assert.ok(start < t3);
});


test('isStale after 1 h without a successful read (from DB creation if never read)', () => {
  assert.equal(isStale(1_000, 0, 1_000 + 59 * 60_000, STALE_AFTER_MS), false);
  assert.equal(isStale(1_000, 0, 1_000 + 60 * 60_000, STALE_AFTER_MS), true);
  assert.equal(isStale(null, 5_000, 5_000 + 60 * 60_000, STALE_AFTER_MS), true);
});
