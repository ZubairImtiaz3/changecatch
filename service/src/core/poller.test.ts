import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../store/db.js';
import { StoreLabelCache } from './labels.js';
import { delayAfter, runOnce, type JournalReadResult, type RunDeps } from './poller.js';
import type { AppEventOccurrence, JournalFile } from './types.js';
import { ADD, CONTACT, DEAL, ev, file, REM, T0, UD } from './testutil.js';

const LABELS = [
  { associationTypeId: 3, label: null, category: 'HUBSPOT_DEFINED' },
  { associationTypeId: 101, label: 'Influencer', category: UD },
  { associationTypeId: 102, label: 'Decision maker', category: UD },
];

/** A fake journal: files in order; reads return everything after the given offset, up to `limit` files. */
function fakeJournal(files: JournalFile[], limit = 100) {
  const reads: (string | null)[] = [];
  const readJournal = async (after: string | null): Promise<JournalReadResult> => {
    reads.push(after);
    const start = after === null ? 0 : files.findIndex((f) => f.offset === after) + 1;
    const batch = files.slice(start, start + limit);
    return { files: batch, nextOffset: batch.at(-1)?.offset ?? null, full: batch.length === limit };
  };
  return { readJournal, reads, files };
}

function setup(files: JournalFile[], opts: { limit?: number; failSends?: number[] } = {}) {
  const store = new Store(':memory:');
  store.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
  // Wall clock just after the newest event most tests use (40 s), so that event is still within its
  // pairing deadline (occurredAt + window + publish slack) and is held.
  let now = T0 + 41_000;
  const labels = new StoreLabelCache(store, async () => LABELS, undefined, () => now);
  const journal = fakeJournal(files, opts.limit);
  const sent: AppEventOccurrence[][] = [];
  let sendCall = 0;
  const deps: RunDeps = {
    readJournal: journal.readJournal,
    sendOccurrences: async (batch) => {
      sendCall++;
      if (opts.failSends?.includes(sendCall)) throw new Error('send failed (simulated 500)');
      sent.push(batch);
    },
    store,
    labels,
    now: () => now,
  };
  return { store, deps, sent, journal, advance: (ms: number) => (now += ms) };
}

const flat = (sent: AppEventOccurrence[][]) => sent.flat();

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
  const occ = flat(s.sent);
  assert.equal(occ.length, 2);
  assert.equal(occ[0].properties.change_type, 'ADDED');
  assert.equal(occ[0].properties.labels_current, 'Influencer');
  assert.equal(occ[1].properties.change_type, 'LABEL_CHANGED');
  assert.equal(occ[1].properties.label_before, 'Influencer');
  assert.equal(occ[1].properties.label_after, 'Decision maker');
  assert.equal(occ[1].properties.labels_current, 'Decision maker');
  assert.equal(s.store.getOffset(), 'f3');
  assert.ok(s.store.getLastSuccessfulReadAt());
  assert.equal(s.store.getMetrics(111)?.eventsProcessed, 5);
});

test('runOnce: second label added uses known state for labelBefore', async () => {
  const s = setup([
    file('f1', [ev({ action: ADD, typeId: 3, at: 0 }), ev({ action: ADD, typeId: 101, category: UD, at: 1 })]),
    file('f2', [ev({ action: ADD, typeId: 102, category: UD, at: 20_000 })]),
    file('f3', [ev({ portalId: 5, at: 40_000 })]),
  ]);
  await runOnce(s.deps);
  const second = flat(s.sent)[1];
  assert.equal(second.properties.change_type, 'LABEL_CHANGED');
  assert.equal(second.properties.label_before, 'Influencer');
  assert.equal(second.properties.label_after, 'Decision maker, Influencer');
});

test('runOnce: offset NOT advanced when send fails; retry sends once and advances', async () => {
  const s = setup(
    [file('f1', [ev({ action: REM, typeId: 3, at: 0 })]), file('f2', [ev({ portalId: 5, at: 30_000 })])],
    { failSends: [1] },
  );
  await assert.rejects(runOnce(s.deps), /send failed/);
  assert.equal(s.store.getOffset(), null);
  assert.equal(s.store.getLastSuccessfulReadAt(), null);
  assert.equal(s.store.getConsecutiveErrors(), 1);
  assert.match(s.store.getLastError()!.message, /send failed/);
  assert.equal(delayAfter(s.store, null), 5_000);

  const r = await runOnce(s.deps);
  assert.equal(r.offset, 'f2');
  assert.equal(flat(s.sent).length, 1);
  assert.equal(flat(s.sent)[0].properties.change_type, 'REMOVED');
  assert.equal(s.store.getConsecutiveErrors(), 0);
});

test('runOnce: batches already accepted before a failure are not re-sent', async () => {
  // 600 separate unlinks -> 2 batches (500 + 100). Second batch fails the first time.
  const events = Array.from({ length: 600 }, (_, i) => ev({ action: REM, typeId: 3, to: [CONTACT, 1000 + i], at: i }));
  const s = setup([file('f1', events), file('f2', [ev({ portalId: 5, at: 60_000 })])], { failSends: [2] });
  await assert.rejects(runOnce(s.deps));
  assert.equal(flat(s.sent).length, 500);
  assert.equal(s.store.getOffset(), null);

  await runOnce(s.deps);
  const all = flat(s.sent);
  assert.equal(all.length, 600);
  assert.equal(new Set(all.map((o) => o.id)).size, 600, 'no duplicates');
  assert.equal(s.store.getOffset(), 'f2');
});

test('runOnce: re-reading the same files after a crash emits nothing new', async () => {
  const files = [file('f1', [ev({ action: REM, typeId: 3, at: 0 })]), file('f2', [ev({ portalId: 5, at: 30_000 })])];
  const s = setup(files);
  await runOnce(s.deps);
  s.store.db.exec('DELETE FROM journal_offset'); // simulate offset lost / re-read from earliest
  await runOnce(s.deps);
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
  assert.equal(delayAfter(s.store, r1), 0, 'full batch -> read again immediately');
  assert.equal(r1.pending, 1);
  assert.equal(s.store.getOffset(), 'f1', 'offset advances; the held event lives in pending_pairs');
  assert.equal(flat(s.sent).length, 0);

  await runOnce(s.deps);
  await runOnce(s.deps);
  const occ = flat(s.sent);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].properties.change_type, 'LABEL_CHANGED');
  assert.equal(occ[0].properties.label_before, 'Influencer');
  assert.equal(occ[0].properties.label_after, 'Decision maker');
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
  assert.equal(flat(s.sent)[0].properties.change_type, 'LABEL_CHANGED');
  assert.equal(r.pending, 0);
  assert.equal(r.nextReleaseAt, null);
  assert.equal(delayAfter(s.store, r), 3_000, 'empty read -> steady poll interval, no long back-off');
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
  assert.equal(delayAfter(s.store, r1), 0, 'full batch -> read again immediately');
  await runOnce(s.deps); // f2 (full again)
  await runOnce(s.deps); // empty: caught up -> deadline releases
  const occ = flat(s.sent);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].properties.change_type, 'LABEL_CHANGED');
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
  assert.equal(s.store.getOffset(), 'f1');
});
