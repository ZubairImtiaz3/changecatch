import { memoryLogger } from '../../test/fixtures/log.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../store/db.js';
import { LabelHoldError, type LabelCache } from './labels.js';
import { runOnce, type RunDeps } from './poller.js';
import type { StampUpdate } from './stamp.js';
import type { JournalFile } from './types.js';
import { ADD, CONTACT, DEAL, ev, fakeJournal, file, REM, T0, UD } from '../../test/fixtures/journal.js';
import { fixedLabelCache, LABELS } from '../../test/fixtures/labels.js';
import { activePairsOn } from '../../test/fixtures/worker.js';

/** The sink takes every update (the real queue enqueues them inside runOnce's transaction); `failCalls` throw before taking any. */
function setup(files: JournalFile[], opts: { limit?: number; failCalls?: number[] } = {}) {
  const store = new Store(':memory:');
  const { portals, watchedPairs } = activePairsOn(store);
  portals.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
  // Wall clock just after the newest event most tests use (40 s), so that event is still within its
  // pairing deadline (occurredAt + window + publish slack) and is held.
  let now = T0 + 41_000;
  const labels = fixedLabelCache(LABELS);
  const journal = fakeJournal(files, opts.limit ?? 100);
  const sent: StampUpdate[][] = [];
  const inChangeLog: boolean[] = [];
  let callNo = 0;
  const deps: RunDeps = {
    readJournal: journal.readJournal,
    enqueueStamps: (updates) => {
      if (opts.failCalls?.includes(++callNo)) throw new Error('send failed (simulated enqueue failure)');
      for (const u of updates) inChangeLog.push(!!store.changes.getChange(u.portalId, u.properties.changecatch_last_change_id!));
      sent.push(updates);
      return updates;
    },
    store,
    labels,
    now: () => now,
    watchedPairs,
    log: memoryLogger().log,
  };
  return { store, deps, sent, inChangeLog, journal, advance: (ms: number) => (now += ms) };
}

/** Stamped property sets, in send order. Label values are `${otherObjectTypeId}:${associationTypeId}` option values. */
const flat = (sent: StampUpdate[][]) => sent.flat().map((u) => u.properties);

test('runOnce: label swap end to end, then offset persisted', async () => {
  const s = setup([
    file('f1', [ev({ action: ADD, typeId: 3, at: 0 }), ev({ action: ADD, typeId: 101, category: UD, at: 1 })]),
    file('f2', [ev({ action: REM, typeId: 101, category: UD, at: 20_000 }), ev({ action: ADD, typeId: 102, category: UD, at: 20_200 })]),
    file('f3', [ev({ action: ADD, typeId: 3, to: [CONTACT, 9], at: 40_000 })]), // moves the stream past f2's window
  ]);
  const r = await runOnce(s.deps);
  assert.equal(r.eventsRead, 5);
  assert.equal(r.offset, 'f3');
  assert.equal(r.pending, 1, 'newest event held for a possible partner');
  assert.equal(r.delivered, 2);
  const occ = flat(s.sent);
  assert.equal(occ.length, 2);
  assert.equal(occ[0].changecatch_change_type, 'ADDED');
  assert.equal(occ[0].changecatch_labels_current, '0-1:101');
  assert.equal(occ[1].changecatch_change_type, 'LABEL_CHANGED');
  assert.equal(occ[1].changecatch_labels_before, '0-1:101');
  assert.equal(occ[1].changecatch_labels_after, '0-1:102');
  assert.equal(occ[1].changecatch_labels_current, '0-1:102');
  assert.equal(occ[1].changecatch_other_object_type, CONTACT);
  assert.ok(s.inChangeLog.every(Boolean), 'every change id was in change_log before its stamp');
  assert.equal(s.store.changes.getChange(111, occ[1].changecatch_last_change_id!)?.otherRecordId, '2');
  assert.equal(s.store.journal.getOffset(), 'f3');
  assert.ok(s.store.journal.getLastSuccessfulReadAt());
});

test('runOnce: only the pairs from deps.watchedPairs are processed (saved but inactive pairs are dropped)', async () => {
  const s = setup([file('f1', [ev({ action: ADD, typeId: 3, at: 0 })]), file('f2', [ev({ action: ADD, typeId: 3, to: [CONTACT, 9], at: 40_000 })])]);
  const r = await runOnce({ ...s.deps, watchedPairs: () => [] });
  assert.equal(r.offset, 'f2');
  assert.equal(r.changesEmitted, 0);
  assert.deepEqual(s.sent, []);
});

test('runOnce: second label added uses known state for labelBefore', async () => {
  const s = setup([
    file('f1', [ev({ action: ADD, typeId: 3, at: 0 }), ev({ action: ADD, typeId: 101, category: UD, at: 1 })]),
    file('f2', [ev({ action: ADD, typeId: 102, category: UD, at: 20_000 })]),
    file('f3', [ev({ portalId: 5, at: 40_000 })]),
  ]);
  await runOnce(s.deps);
  const second = flat(s.sent)[1];
  assert.equal(second.changecatch_change_type, 'LABEL_CHANGED');
  assert.equal(second.changecatch_labels_before, '0-1:101');
  assert.equal(second.changecatch_labels_after, '0-1:101;0-1:102');
});

test('runOnce: offset NOT advanced when send fails; retry sends once and advances', async () => {
  const s = setup(
    [file('f1', [ev({ action: REM, typeId: 3, at: 0 })]), file('f2', [ev({ portalId: 5, at: 30_000 })])],
    { failCalls: [1] },
  );
  await assert.rejects(runOnce(s.deps), /send failed/);
  assert.equal(s.store.journal.getOffset(), null);
  assert.equal(s.store.journal.getLastSuccessfulReadAt(), null);

  const r = await runOnce(s.deps);
  assert.equal(r.offset, 'f2');
  assert.equal(flat(s.sent).length, 1);
  assert.equal(flat(s.sent)[0].changecatch_change_type, 'REMOVED');
});

test('runOnce: re-reading the same files after a crash emits nothing new', async () => {
  const files = [file('f1', [ev({ action: REM, typeId: 3, at: 0 })]), file('f2', [ev({ portalId: 5, at: 30_000 })])];
  const s = setup(files);
  await runOnce(s.deps);
  await runOnce({ ...s.deps, readJournal: () => s.journal.readJournal(null) }); // offset lost: re-read from earliest
  assert.equal(flat(s.sent).length, 1);
});

test('runOnce: pending pair is completed by the next run (cross-batch)', async () => {
  const files = [
    file('f1', [ev({ action: REM, typeId: 101, category: UD, at: 0 })]),
    file('f2', [ev({ action: ADD, typeId: 102, category: UD, at: 900 })]),
    file('f3', [ev({ portalId: 5, at: 30_000 })]),
  ];
  const s = setup(files, { limit: 1 });
  const r1 = await runOnce(s.deps);
  assert.equal(r1.batchFull, true);
  assert.equal(r1.pending, 1);
  assert.equal(s.store.journal.getOffset(), 'f1', 'offset advances; the held event lives in pending_pairs');
  assert.equal(flat(s.sent).length, 0);

  await runOnce(s.deps);
  await runOnce(s.deps);
  const occ = flat(s.sent);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].changecatch_change_type, 'LABEL_CHANGED');
  assert.equal(occ[0].changecatch_labels_before, '0-1:101');
  assert.equal(occ[0].changecatch_labels_after, '0-1:102');
});

test('runOnce: held label-edit pair is released at its deadline on an otherwise empty stream', async () => {
  // UI label edit: both halves 33 ms apart in ONE file; nothing else happens afterwards.
  const s = setup([file('f1', [ev({ action: REM, typeId: 101, category: UD, at: 40_000 }), ev({ action: ADD, typeId: 102, category: UD, at: 40_033 })])]);
  const r1 = await runOnce(s.deps); // wall clock 41 s
  assert.equal(flat(s.sent).length, 0);
  assert.equal(r1.pending, 2);
  assert.equal(r1.nextReleaseAt, T0 + 40_033 + 2_000 + 4_000, 'newest occurredAt + window + publish slack');
  s.advance(r1.nextReleaseAt! - (T0 + 41_000) - 1);
  assert.equal((await runOnce(s.deps)).pending, 2, '1 ms early: still held');
  s.advance(1);
  const r = await runOnce(s.deps);
  assert.equal(r.eventsRead, 0);
  assert.equal(flat(s.sent).length, 1);
  assert.equal(flat(s.sent)[0].changecatch_change_type, 'LABEL_CHANGED');
  assert.equal(r.pending, 0);
  assert.equal(r.nextReleaseAt, null);
});

test('runOnce: a full batch does not release by wall clock (backlog); the partner in the next file still pairs', async () => {
  // Old backlog: wall clock is minutes later, halves split across two files, reads limited to 1 file.
  const s = setup(
    [
      file('f1', [ev({ action: REM, typeId: 101, category: UD, at: 0 })]),
      file('f2', [ev({ action: ADD, typeId: 102, category: UD, at: 108 })]),
    ],
    { limit: 1 },
  );
  s.advance(600_000);
  const r1 = await runOnce(s.deps);
  assert.equal(r1.batchFull, true);
  assert.equal(r1.pending, 1, 'held although its deadline passed long ago');
  await runOnce(s.deps); // f2 (full again)
  await runOnce(s.deps); // empty: caught up -> deadline releases
  const occ = flat(s.sent);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].changecatch_change_type, 'LABEL_CHANGED');
});

test('runOnce: events for pairs the portal does not watch are dropped but still marked handled', async () => {
  const s = setup([
    file('f1', [ev({ action: ADD, typeId: 1, from: ['0-2', 1], to: [CONTACT, 2], at: 0 }), ev({ portalId: 333, action: ADD, at: 1 })]),
    file('f2', [ev({ portalId: 5, at: 30_000 })]),
  ]);
  const r = await runOnce(s.deps);
  assert.equal(flat(s.sent).length, 0);
  assert.equal(r.offset, 'f2');
});

test('runOnce: non-association events go to onOtherEvent', async () => {
  const f = file('f1', []);
  f.journalEvents.push({ type: 'app_lifecycle_event', action: 'APP_UNINSTALL', portalId: 111 });
  const s = setup([f]);
  const seen: string[] = [];
  s.deps.onOtherEvent = (e) => void seen.push(String(e.action));
  await runOnce(s.deps);
  assert.deepEqual(seen, ['APP_UNINSTALL']);
  assert.equal(s.store.journal.getOffset(), 'f1');
});

test('runOnce (mirror): a held to -> from label lookup parks only that portal; the rest is stamped and the offset moves on', async () => {
  const store = new Store(':memory:');
  const { portals, watchedPairs } = activePairsOn(store);
  for (const p of [111, 333]) portals.setWatchedPairs(p, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
  const base = fixedLabelCache(LABELS);
  let hold111 = true;
  const labels: LabelCache = {
    get: base.get,
    async findByName(p, f, t, name) {
      if (p === 111 && hold111) throw new LabelHoldError(`${p}|${f}|${t}`, 'contact -> deal labels unreadable');
      return base.findByName(p, f, t, name);
    },
  };
  const stamps: StampUpdate[] = [];
  const journal = fakeJournal([
    file('f1', [ev({ action: ADD, typeId: 101, category: UD, at: 0 }), ev({ portalId: 333, action: ADD, typeId: 101, category: UD, at: 0 })]),
    file('f2', [ev({ portalId: 5, at: 40_000 })]),
  ]);
  const deps: RunDeps = {
    readJournal: journal.readJournal,
    enqueueStamps: (u) => {
      stamps.push(...u);
      return u;
    },
    store,
    labels,
    now: () => T0 + 60_000,
    watchedPairs,
    log: memoryLogger().log,
    config: { mirror: true },
  };
  const r = await runOnce(deps);
  assert.deepEqual(r.parkedPortals, [111]);
  assert.equal(r.offset, 'f2');
  assert.deepEqual([...new Set(stamps.map((u) => u.portalId))], [333], 'portal 333 stamped (deal + mirrored contact)');
  assert.equal(stamps.length, 2);

  hold111 = false;
  const r2 = await runOnce(deps);
  assert.deepEqual(r2.parkedPortals, []);
  assert.equal(stamps.filter((u) => u.portalId === 111).length, 2, 'parked entries retried: deal + mirrored contact');
});
