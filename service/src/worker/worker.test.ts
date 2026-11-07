import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { alertsOf, memoryLogger } from '../../test/fixtures/log.js';
import { ADD, batchOf, CONTACT, DEAL, ev, fakeJournalApi, fetchEntry, file, REM, T0, UD } from '../../test/fixtures/journal.js';
import { LABELS } from '../../test/fixtures/labels.js';
import { closeWorkerHarnesses, workerHarness } from '../../test/fixtures/worker.js';
import { ChangeCatchMetrics } from '../obs/metrics.js';
import { Store } from '../store/db.js';
import type { JournalReadResult } from '../core/poller.js';
import type { StampUpdate } from '../core/stamp.js';
import { HubSpotError } from '../lib/http.js';
import { TokenRevokedError } from '../hubspot/portal-tokens.js';
import { LABEL_TTL_MS } from './label-guard.js';
import { JournalPartialError, makeJournalReader } from './journal-reader.js';
import { healthSnapshot, StaleAlerter, startHealthServer } from './health.js';

afterEach(closeWorkerHarnesses);

const quiet = memoryLogger().log;
/** change_log rows of deal 1 (portal 111). */
const logged = (s: Store) => s.changes.changesForRecords(111, DEAL, ['1'], 0);
const down = (n: number) => { if (n === 1) throw HubSpotError.fromStatus(503, {}, 'down'); return undefined; };

// ---------------------------------------------------------------- offset vs stamping

test('worker: a 5xx on stamping does NOT hold the shared offset; the persisted queue retries', async () => {
  const s = workerHarness({
    files: [file('f1', [ev({ action: ADD, typeId: 3, at: 0 })]), file('f2', [ev({ portalId: 5, at: 40_000 })])],
    respond: down,
  });
  assert.ok(await s.step());
  assert.equal(s.store.journal.getOffset(), 'f2', 'offset moved on');
  assert.equal(s.calls.length, 1);
  assert.equal(s.store.stamps.queueSize(), 1, 'the failed stamp waits for its retry');
  assert.equal(logged(s.store).length, 1, 'change_log written before stamping');
  s.clock.t += 5_000;
  await s.worker.drainQueue();
  assert.equal(s.calls.length, 2);
  assert.equal(s.store.stamps.queueSize(), 0);
  assert.equal(s.metrics.registry.get('stamps_sent', { portal: 111 }), 1);
  // A re-read (offset lost) never stamps it again.
  s.rereadFromStart();
  await s.step();
  assert.equal(s.calls.length, 2);
});

test('worker: stamps_coalesced (log + metric) is emitted only after the run commits', async () => {
  const mem = memoryLogger();
  const burst = [2, 3, 4, 5, 6, 7].map((c, i) => ev({ action: ADD, typeId: 3, to: [CONTACT, c], at: i * 1000 }));
  const s = workerHarness({ files: [file('f1', burst), file('f2', [ev({ portalId: 5, at: 40_000 })])], log: mem.log });
  const coalescedLogs = () => mem.records.filter((r) => r.event === 'stamps_coalesced');
  const setOffset = s.store.journal.setOffset.bind(s.store.journal);
  s.store.journal.setOffset = () => { throw new Error('CRASH in the final commit'); };
  assert.equal(await s.worker.readOnce(), null, 'the run failed');
  assert.equal(s.metrics.registry.total('stamps_coalesced'), 0, 'nothing counted for a rolled-back run');
  assert.equal(coalescedLogs().length, 0);
  s.store.journal.setOffset = setOffset;
  const r = await s.worker.readOnce();
  assert.ok(r && r.coalesced > 0, `coalesced ${r?.coalesced}`);
  assert.equal(s.metrics.registry.total('stamps_coalesced'), r.coalesced);
  assert.deepEqual(coalescedLogs().map((x) => x.n), [r.coalesced]);
});

// ---------------------------------------------------------------- label failures park the portal

test('worker: label fetch failure parks the portal\'s entries; nothing guessed, nothing stamped until labels AND the option sync work', async () => {
  let fail = true;
  const hooks: string[] = [];
  let hookFails = 1;
  const s = workerHarness({
    files: [file('f1', [ev({ action: ADD, typeId: 3, at: 0 }), ev({ action: ADD, typeId: 101, category: UD, at: 1 })]), file('f2', [ev({ portalId: 5, at: 40_000 })])],
    fetchLabels: async () => {
      if (fail) throw HubSpotError.fromStatus(502, {}, 'labels down');
      return LABELS;
    },
    beforeSync: (p, t) => {
      hooks.push(`${p}|${t}`);
      if (hookFails-- > 0) throw new Error('option sync failed');
    },
  });
  assert.deepEqual((await s.step())!.parkedPortals, [111]);
  assert.equal(logged(s.store).length, 0);
  assert.equal(s.calls.length, 0);
  assert.equal(s.store.labels.listLabelHolds().length, 1);
  assert.match(s.store.metrics.listPortalErrors().find((e) => e.portalId === 111)!.message, /labels down/);

  // Labels come back, but the option-sync hook fails once: still parked.
  fail = false;
  assert.deepEqual((await s.step())!.parkedPortals, [111]);
  assert.equal(logged(s.store).length, 0);
  assert.deepEqual(hooks, ['111|0-3']);

  // Hook works now: processed with the right name.
  s.clock.t += 60_000;
  assert.deepEqual((await s.step())!.parkedPortals, []);
  s.clock.t += 60_000;
  await s.step();
  assert.equal(hooks.length, 2);
  assert.equal(s.store.labels.listLabelHolds().length, 0);
  assert.equal(s.calls.length, 1);
  const [stamped] = s.calls[0].props;
  assert.equal(stamped.changecatch_labels_current, '0-1:101', 'Influencer (type 101) as its option value');
});

test('worker: unknown label type is parked, then given up after the max hold (fallback name)', async () => {
  const s = workerHarness({ files: [file('f1', [ev({ action: ADD, typeId: 3, at: 0 }), ev({ action: ADD, typeId: 999, category: UD, at: 1 })]), file('f2', [ev({ portalId: 5, at: 40_000 })])] });
  assert.deepEqual((await s.step())!.parkedPortals, [111]);
  assert.equal(logged(s.store).length, 0);
  s.clock.t += 31 * 60_000;
  await s.step();
  s.clock.t += 60_000;
  await s.step();
  // The fallback value itself is formatted by src/core/stamp.ts (label options); we only check it went through.
  assert.deepEqual(s.calls.map((c) => c.types), [['ADDED']]);
  assert.equal(s.store.labels.listLabelHolds().length, 1, 'hold stays visible on /health');
});

test('worker: one portal\'s label failure PARKS only that portal; the offset moves on; parked entries are retried', async () => {
  let fail111 = true;
  const s = workerHarness({
    files: [
      file('f1', [ev({ action: ADD, typeId: 101, category: UD, at: 0 })]), // portal 111 (labels fail)
      file('f2', [ev({ portalId: 333, action: ADD, typeId: 3, at: 1_000 })]), // portal 333 (fine)
      file('f3', [ev({ portalId: 5, at: 40_000 })]), // moves the stream past the pairing window
    ],
    installed: [111, 333],
    fetchLabels: async (p) => {
      if (p === 111 && fail111) throw HubSpotError.fromStatus(502, {}, 'labels down');
      return LABELS;
    },
  });
  const r1 = await s.step();
  assert.ok(r1, 'run succeeds');
  assert.deepEqual(r1.parkedPortals, [111]);
  assert.equal(s.store.journal.getOffset(), 'f3', 'offset moved on for everyone');
  assert.equal(s.store.entries.parkedCount(), 1);
  assert.deepEqual(s.calls.map((c) => c.types), [['ADDED']], 'portal 333 stamped');
  assert.match(s.store.metrics.listPortalErrors().find((e) => e.portalId === 111)!.message, /parked/);

  // Still failing: stays parked, nothing lost, nothing stamped.
  assert.deepEqual((await s.step())!.parkedPortals, [111]);
  assert.equal(s.store.entries.parkedCount(), 1);

  // Labels back: the parked entry is processed with the right name.
  fail111 = false;
  s.clock.t += 60_000;
  const r3 = await s.step();
  assert.deepEqual(r3!.parkedPortals, []);
  assert.equal(s.store.entries.parkedCount(), 0, 'unparked (now in the normal pairing window)');
  s.clock.t += 60_000;
  await s.step();
  assert.equal(s.calls.length, 2);
  const [stamped] = s.calls[1].props;
  assert.equal(stamped.changecatch_labels_after, '0-1:101', 'Influencer (type 101)');
});

test('worker: a parked entry whose pair is no longer watched (uninstall wiped the pairs) is dropped', async () => {
  const s = workerHarness({
    files: [file('f1', [ev({ action: ADD, typeId: 101, category: UD, at: 0 })])],
    fetchLabels: async () => { throw HubSpotError.fromStatus(502, {}, 'labels down'); },
  });
  await s.step();
  assert.equal(s.store.entries.parkedCount(), 1);
  s.portals.setWatchedPairs(111, []);
  await s.step();
  assert.equal(s.store.entries.parkedCount(), 0);
  assert.equal(s.calls.length, 0);
});

// ---------------------------------------------------------------- persisted spacing queue

test('stamp queue: spacing survives a restart; delayed stamps are not lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-worker-'));
  const dbPath = join(dir, 'db.sqlite');
  try {
    const clock = { t: T0 + 60_000 };
    const files = [
      file('f1', [ev({ action: ADD, typeId: 3, at: 0 })]),
      file('f2', [ev({ action: REM, typeId: 3, at: 10_000 })]), // same deal + contact: 2nd stamp on deal 1
      file('f3', [ev({ portalId: 5, at: 40_000 })]),
    ];
    const a = workerHarness({ files, dbPath, clock });
    assert.ok(await a.step());
    assert.equal(a.store.journal.getOffset(), 'f3', 'a stamp waiting for its slot does not block the offset');
    assert.deepEqual(a.calls.map((c) => c.types), [['ADDED']]);
    assert.equal(a.store.stamps.queueSize(), 1);
    assert.equal(a.store.stamps.nextDueAt(), clock.t + 3000);
    a.close(); // "crash"

    clock.t += 1000;
    const b = workerHarness({ dbPath, clock });
    await b.worker.drainQueue();
    assert.equal(b.calls.length, 0, 'not due yet after restart');
    clock.t += 2000;
    await b.worker.drainQueue();
    assert.deepEqual(b.calls.map((c) => c.types), [['REMOVED']]);
    assert.equal(b.store.stamps.queueSize(), 0);

    // Persisted last-stamp time: a new change 1 s later is spaced 3 s after the last stamp.
    clock.t += 1000;
    const upd: StampUpdate = { portalId: 111, objectTypeId: DEAL, objectId: '1', occurredAtMs: clock.t, properties: { changecatch_last_change_id: 'x1' } as StampUpdate['properties'] };
    b.queue.enqueue([upd]);
    assert.equal(b.store.stamps.nextDueAt(), clock.t + 2000);

    // Per-portal spacing from the settings page (portals.stamp_spacing_seconds).
    b.portals.setStampSpacingSeconds(111, 10, clock.t);
    const upd2 = { ...upd, objectId: '77', properties: { changecatch_last_change_id: 'x2' } as StampUpdate['properties'] };
    const upd3 = { ...upd2, occurredAtMs: clock.t + 1, properties: { changecatch_last_change_id: 'x3' } as StampUpdate['properties'] };
    b.queue.enqueue([upd2, upd3]);
    const q = b.store.stamps.queuedFor('111|0-3|77');
    assert.equal(q[1].notBefore - q[0].notBefore, 10_000);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stamp queue: a portal without a token is dropped (not retried, not blocking)', async () => {
  const s = workerHarness();
  s.queue.enqueue([{ portalId: 222, objectTypeId: DEAL, objectId: '1', occurredAtMs: T0, properties: { changecatch_last_change_id: 'z' } as StampUpdate['properties'] }]);
  const r = await s.queue.drain();
  assert.equal(r.dropped.length, 1);
  assert.equal(s.store.stamps.queueSize(), 0);
  assert.equal(s.metrics.portalCounts().get(222)?.stampsDropped, 1);
});

// ---------------------------------------------------------------- journal reader: 204, latest, 207

test('journal reader: first start uses latest (not earliest); 204 = empty', async () => {
  const store = new Store(':memory:');
  const api = fakeJournalApi({ batches: [undefined], latest: fetchEntry('01a0') });
  const read = makeJournalReader(api, { store, log: quiet });
  const r1 = await read(null);
  assert.deepEqual(api.calls, ['latest']);
  assert.equal(r1.nextOffset, '01a0');
  const r2 = await read('01a0');
  assert.deepEqual(r2, { files: [], nextOffset: null, full: false });
});

test('journal reader: HTTP 207 keeps only entries before the first failed offset, skips after the limit', async () => {
  const store = new Store(':memory:');
  let now = T0;
  const api = fakeJournalApi({
    batches: [
      batchOf(['01a1', '01a2', '01a4'], ['01a3']),
      batchOf(['01a4'], ['01a3']),
      batchOf(['01a4'], ['01a3']),
      { ...batchOf(['01a1']), numErrors: 1, errors: [{ status: 'PRESIGNING_ERROR', message: 'no context' }] },
    ],
  });
  const read = makeJournalReader(api, { store, log: quiet, now: () => now });

  const r1 = await read('01a0');
  assert.deepEqual(r1.files.map((f) => f.offset), ['01a1', '01a2']);
  assert.equal(r1.nextOffset, '01a2', 'never jumps over the failed entry');
  assert.equal(r1.full, true, 'read again soon');
  assert.equal(JSON.parse(store.journal.getState('journal_fail')!).offset, '01a3', 'the failing entry is remembered');

  await assert.rejects(read('01a2'), JournalPartialError, 'failed entry first: nothing to process, retry later');

  now += 31 * 60_000;
  const r3 = await read('01a2');
  assert.deepEqual(r3.files.map((f) => f.offset), ['01a4'], 'skipped after failing for 30+ min');
  assert.equal(store.journal.getState('journal_fail'), undefined, 'cleared once skipped');

  // An error without an offset: we can't tell what failed, so nothing is processed.
  await assert.rejects(read('01a0'), /failed offset unknown/);
});

test('journal reader: a failed entry that later succeeds leaves no journal_fail state behind', async () => {
  const store = new Store(':memory:');
  const api = fakeJournalApi({ batches: [batchOf(['01a1'], ['01a2']), batchOf(['01a2', '01a3'])] });
  const read = makeJournalReader(api, { store, log: quiet });
  await read('01a0');
  assert.ok(store.journal.getState('journal_fail'));
  const r = await read('01a1');
  assert.deepEqual(r.files.map((f) => f.offset), ['01a2', '01a3']);
  assert.equal(store.journal.getState('journal_fail'), undefined);
});

test('journal reader: 404 on batch-next (expired offset) restarts from earliest with an alert and counts data_loss{offset_expired}', async () => {
  const store = new Store(':memory:');
  const { log, records } = memoryLogger('journal');
  const api = fakeJournalApi({ batches: [batchOf(['01b1', '01b2'])] });
  api.batchNext = async (off) => {
    api.calls.push(`next:${off}`);
    throw HubSpotError.fromStatus(404, {}, 'offset not found');
  };
  const metrics = new ChangeCatchMetrics();
  const read = makeJournalReader(api, { store, log, metrics });
  const r = await read('00old');
  assert.deepEqual(api.calls, ['next:00old', 'batchEarliest']);
  assert.deepEqual(r.files.map((f) => f.offset), ['01b1', '01b2']);
  assert.match(alertsOf(records, 'offset_expired')[0], /journal offset 00old is gone/);
  assert.match(store.journal.getLastError()!.message, /journal offset 00old expired \(404\)/);
  assert.equal(metrics.registry.get('data_loss', { reason: 'offset_expired', portal: 'app' }), 1);
  // Other errors still throw (offset kept).
  api.batchNext = async () => { throw HubSpotError.fromStatus(500, {}, 'boom'); };
  await assert.rejects(read('01b2'), /boom/);
});

test('worker: a 207 partial read advances the offset only to the last good file', async () => {
  const api = fakeJournalApi({ batches: [batchOf(['01a1', '01a2', '01a4'], ['01a3'])] });
  let read!: (after: string | null) => Promise<JournalReadResult>;
  const s = workerHarness({ readJournal: (after) => read(after) });
  read = makeJournalReader(api, { store: s.store, log: quiet });
  s.store.journal.setOffset('01a0');
  const r = await s.worker.readOnce();
  assert.equal(r?.offset, '01a2');
  assert.equal(r?.batchFull, true);
});

// ---------------------------------------------------------------- shutdown

test('worker: stop() lets the batch in progress finish and persist its offset', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const inRead = new Promise<void>((r) => (started = r));
  const s = workerHarness({
    readJournal: async () => {
      started();
      await gate;
      return { files: [file('f1', [])], nextOffset: 'f1', full: false };
    },
  });
  const loop = s.worker.run();
  await inRead;
  const stopped = s.worker.stop();
  release();
  await stopped;
  await loop;
  assert.equal(s.store.journal.getOffset(), 'f1', 'offset of the finished batch saved');
  assert.equal(s.reads.length, 1, 'no new read after stop');
});

test('worker: stop() wakes the loop from its sleep', async () => {
  const s = workerHarness({ realSleep: true, clock: { t: Date.now() } });
  const loop = s.worker.run();
  await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  await s.worker.stop();
  await loop;
  assert.ok(Date.now() - t0 < 1000);
});

// ---------------------------------------------------------------- health

test('health: 200 when fresh, 503 + alert line when no successful read for 1 h', async () => {
  const store = new Store(':memory:');
  let now = Date.now();
  const metrics = new ChangeCatchMetrics();
  const server = await startHealthServer({
    port: 0,
    host: '127.0.0.1',
    healthToken: 'sekret',
    metrics,
    snapshot: () => healthSnapshot(store, now, { startedAt: now, metrics }),
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
  try {
    store.journal.setLastSuccessfulReadAt(now);
    metrics.changesProcessed(111, 1);
    metrics.stampsSent(111, 1, [500]);
    let res = await fetch(url);
    assert.equal(res.status, 200);
    const pub = (await res.json()) as any;
    assert.equal(pub.status, 'ok');
    assert.equal(pub.portals, undefined, 'no portal ids without the token');
    assert.equal(pub.totals.portals, 1);
    assert.ok(!/portalId|portal=/.test(JSON.stringify(pub)), 'portal ids not leaked');
    assert.equal((await (await fetch(url, { headers: { 'x-health-token': 'wrong' } })).json() as any).portals, undefined);
    assert.equal(pub.metrics.stamps_sent, 1, 'per-portal metrics summed');
    assert.equal(pub.totals.changesEmitted, 1);
    const body = (await (await fetch(url, { headers: { 'x-health-token': 'sekret' } })).json()) as any;
    assert.equal(body.portals[0].portalId, 111);
    assert.equal(body.portals[0].stampsSent, 1);
    assert.equal(body.metrics.stamps_sent['portal=111'], 1);
    const prom = await (await fetch(url.replace('/health', '/metrics'))).text();
    assert.match(prom, /changecatch_stamps_sent_total 1\n/);
    assert.doesNotMatch(prom, /portal=/, 'no portal ids in public /metrics');

    now += 61 * 60_000;
    res = await fetch(url);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as any).status, 'stale');

    const mem = memoryLogger('health');
    const alerter = new StaleAlerter(mem.log, 15 * 60_000);
    assert.equal(alerter.check(store, now), true);
    alerter.check(store, now + 1000);
    assert.equal(alertsOf(mem.records, 'worker_stale').length, 1, 'not repeated within 15 min');
    store.journal.setLastSuccessfulReadAt(now + 2000);
    assert.equal(alerter.check(store, now + 2000), false);
    assert.deepEqual(mem.records.map((r) => r.event), ['alert', 'alert_cleared']);
    assert.equal((await fetch(url.replace('/health', '/nope'))).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------- latency (fake clock, 2026-10-30)

test('loop: a UI label edit with NO later events is stamped at occurredAt + window + slack (wakes exactly then)', async () => {
  // Halves 33 ms apart in one file. First read 2 s after the edit (HubSpot publish delay).
  const s = workerHarness({
    files: [file('f1', [ev({ action: REM, typeId: 101, category: UD, at: 0 }), ev({ action: ADD, typeId: 102, category: UD, at: 33 })])],
    clock: { t: T0 + 2_000 },
  });
  await s.runUntil(T0 + 20_000);
  const deadline = T0 + 33 + 2_000 + 4_000;
  assert.equal(s.calls.length, 1, 'stamped once');
  assert.deepEqual(s.calls[0].types, ['LABEL_CHANGED']);
  assert.equal(s.calls[0].at, deadline, 'stamped exactly at the hold deadline, not at the next poll or a later event');
  assert.ok(s.wakes.includes(deadline), 'the loop woke exactly at the deadline');
  assert.deepEqual(s.wakes.slice(0, 2), [T0 + 5_000, deadline], 'poll at +3 s, then the deadline (earlier than the next poll)');
  const st = s.metrics.latency()!;
  assert.equal(st.count, 1);
  assert.equal(st.p50, deadline - T0 - 33, 'occurredAt (newest half) -> stamped');
  assert.ok(st.p95! <= 10_000, 'within the 10 s target');
});

test('loop: polls every 3 s when idle (no long back-off)', async () => {
  const s = workerHarness({ clock: { t: T0 } });
  await s.runUntil(T0 + 15_000);
  assert.deepEqual(s.wakes, [3, 6, 9, 12, 15].map((n) => T0 + n * 1000));
  assert.equal(s.reads.length, 5, 'one read per wake-up before the stop (the stop wake does not read)');
});

test('loop: a due stamp (spacing slot) is flushed on its own wake-up WITHOUT a journal read', async () => {
  // Link then unlink of the same record 2.5 s apart -> two changes for one record; spacing 3 s.
  const s = workerHarness({
    files: [file('f1', [ev({ action: ADD, typeId: 3, at: 0 }), ev({ action: REM, typeId: 3, at: 2_500 })])],
    clock: { t: T0 + 10_000 },
    env: { JOURNAL_POLL_MS: '60000' },
  });
  await s.runUntil(T0 + 20_000);
  assert.deepEqual(s.calls.map((c) => [c.at, c.types[0]]), [[T0 + 10_000, 'ADDED'], [T0 + 13_000, 'REMOVED']]);
  assert.equal(s.reads.length, 1, 'only the first read; the second stamp went out on the queue wake-up');
  assert.equal(s.wakes[0], T0 + 13_000);
});

test('loop: a 429 with >100 due rows defers the whole portal; the loop sleeps until retryAfter (no 0 ms spin)', async () => {
  const s = workerHarness({
    clock: { t: T0 },
    env: { JOURNAL_POLL_MS: '60000' },
    respond: (n) => {
      if (n === 1) throw new HubSpotError('throttled', 'portal:111 throttled', { retryAfterMs: 30_000, scope: 'portal' });
      return undefined;
    },
  });
  const upd = (i: number): StampUpdate => ({
    portalId: 111, objectTypeId: DEAL, objectId: String(i + 1), occurredAtMs: T0,
    properties: { changecatch_last_change_id: `t${i}`, changecatch_change_type: 'ADDED' } as StampUpdate['properties'],
  });
  s.queue.enqueue(Array.from({ length: 150 }, (_, i) => upd(i)));
  await s.runUntil(T0 + 45_000);
  assert.deepEqual(s.calls.map((c) => [c.at, c.ids.length]), [[T0, 100], [T0 + 30_000, 100], [T0 + 30_000, 50]], 'one 429, nothing until retryAfter, then all');
  assert.ok(s.wakes.every((w, i) => i === 0 || w > s.wakes[i - 1]), 'every sleep moves the clock');
  assert.equal(s.wakes[0], T0 + 30_000, 'first wake-up exactly at retryAfter');
});

test('loop: full batch re-reads immediately; failures back off exponentially, separately from polling', async () => {
  let n = 0;
  const s = workerHarness({
    clock: { t: T0 },
    readJournal: async () => {
      n++;
      if (n <= 3) throw new Error('journal 503');
      if (n === 4) return { files: [file('f1', [])], nextOffset: 'f1', full: true };
      return { files: [], nextOffset: null, full: false };
    },
  });
  const readTimes: number[] = [];
  const orig = s.worker.readOnce.bind(s.worker);
  s.worker.readOnce = async () => {
    readTimes.push(s.clock.t);
    return orig();
  };
  await s.runUntil(T0 + 40_000);
  // fail @0 -> +5 s, fail @5 -> +10 s, fail @15 -> +20 s, ok+full @35 -> at once, empty @35 -> +3 s ...
  assert.deepEqual(readTimes.slice(0, 6), [0, 5_000, 15_000, 35_000, 35_000, 38_000].map((x) => T0 + x));
  assert.equal(s.worker.consecutiveErrors, 0);
});

test('stamp queue: one log line per stamped change with its end-to-end latency; /health shows p50/p95', async () => {
  const { log, records } = memoryLogger('stamp');
  const s = workerHarness({
    files: [file('f1', [ev({ action: ADD, typeId: 3, at: 0 }), ev({ action: ADD, typeId: 3, from: [DEAL, 5], to: [CONTACT, 9], at: 0 })])],
    clock: { t: T0 + 7_000 },
    log,
  });
  await s.step();
  const stamped = records.filter((r) => r.event === 'stamp_sent').map((r) => r.msg);
  assert.equal(stamped.length, 2);
  assert.match(stamped[0], /^stamped portal 111 0-3\/(1|5) ADDED change \S+: 7\.0s after occurredAt$/);
  const h = healthSnapshot(s.store, s.clock.t, { startedAt: T0, metrics: s.metrics });
  assert.equal(h.latency?.count, 2);
  assert.equal(h.latency?.totalSamples, 2);
  assert.equal(h.latency?.p50Ms, 7_000);
  assert.equal(h.latency?.p95Ms, 7_000);
});


// ---------------------------------------------------------------- dropdown options (HubSpot refuses a value that is not one)

test('worker: a stale cached label whose option was never synced is NOT stamped when the refresh fails (token revoked); held until the sync works', async () => {
  let revoked = true;
  const s = workerHarness({
    files: [file('f1', [ev({ action: ADD, typeId: 3, at: 0 }), ev({ action: ADD, typeId: 101, category: UD, at: 1 })]), file('f2', [ev({ portalId: 5, at: 40_000 })])],
    fetchLabels: async (p) => {
      if (revoked) throw new TokenRevokedError(p, T0);
      return LABELS;
    },
  });
  // Known from yesterday (older than the TTL), but never announced on this object type (e.g. markers cleared after a
  // refused stamp, or mirroring just switched on).
  s.store.labels.replaceLabels(111, DEAL, CONTACT, LABELS, s.clock.t - 2 * LABEL_TTL_MS);
  const first = await s.step();
  assert.deepEqual(s.invalidOptions, [], 'nothing stamped with a value that is not an option (simulated HubSpot options)');
  assert.deepEqual(first!.parkedPortals, [111], 'held: the option sync could not run');
  assert.equal(s.calls.length, 0);

  revoked = false;
  s.clock.t += 60_000;
  await s.step();
  s.clock.t += 60_000;
  await s.step();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].props[0].changecatch_labels_current, '0-1:101');
  assert.ok(s.options.has(111, DEAL, 'changecatch_labels_current', '0-1:101'));
});

test('worker: a stamp refused as "not an option" clears the markers, re-syncs the options and retries (no dead letter)', async () => {
  const s = workerHarness({
    files: [
      file('f1', [ev({ action: ADD, typeId: 3, at: 0 }), ev({ action: ADD, typeId: 101, category: UD, at: 1 })]),
      file('f2', [ev({ action: ADD, typeId: 102, category: UD, at: 30_000 })]),
      file('f3', [ev({ portalId: 5, at: 80_000 })]),
    ],
    expectInvalidOptions: true,
  });
  s.clock.t = T0 + 20_000;
  await s.step(); // f1: first event of the pair -> options synced, ADDED stamped
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.store.labels.getSyncedTypeIds(111, DEAL, CONTACT), [3, 101, 102]);

  // An admin deletes ChangeCatch's options in HubSpot: our markers still say "synced".
  s.options.remove(111, DEAL, 'changecatch_labels_current', ['0-1:101', '0-1:102']);
  s.options.remove(111, DEAL, 'changecatch_labels_after', ['0-1:101', '0-1:102']);
  s.options.remove(111, DEAL, 'changecatch_labels_before', ['0-1:101', '0-1:102']);
  s.clock.t = T0 + 120_000;
  await s.step(); // f2 + f3: LABEL_CHANGED refused (INVALID_OPTION) -> markers cleared, options re-synced, retry queued
  assert.equal(s.calls.length, 2);
  const refused = s.invalidOptions.length;
  assert.ok(refused > 0);
  assert.ok(s.invalidOptions.every((v) => /0-3\/1 changecatch_labels_\w+=0-1:10[12]/.test(v)), s.invalidOptions.join(' | '));
  assert.deepEqual(s.store.labels.getSyncedTypeIds(111, DEAL, CONTACT), [], 'markers cleared: the next event announces again');
  assert.ok(s.options.has(111, DEAL, 'changecatch_labels_current', '0-1:102'), 're-synced');
  assert.equal(s.store.stamps.queueSize(), 1, 'kept for a retry, not dead-lettered');

  s.clock.t += 10 * 60_000;
  await s.worker.drainQueue();
  assert.equal(s.calls.length, 3);
  assert.equal(s.store.stamps.queueSize(), 0);
  assert.equal(s.store.stamps.deadLetterCounts().get(111) ?? 0, 0);
  assert.equal(s.invalidOptions.length, refused, 'the retry was accepted');
});
