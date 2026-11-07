// Crash safety of held pairing halves (pre-launch test #1 follow-up: "66 held for pairing" vs an empty pending_pairs).
//
// Held entries (pending clusters, split-hold halves) are written by store.replacePending in the SAME transaction as
// store.setOffset (runOnce, poller.ts). These tests kill the "process" at different points (the Store is closed and
// reopened from the same SQLite file, all in-memory state is thrown away) and check that the held half still
// completes into exactly ONE change with the right labels.

import { memoryLogger } from '../../test/fixtures/log.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store/db.js';
import { runOnce, type RunDeps } from './poller.js';
import type { StampUpdate } from './stamp.js';
import type { JournalFile } from './types.js';
import { ADD, CONTACT, DEAL, ev, fakeJournal, file, REM, T0, UD, uuid7 } from '../../test/fixtures/journal.js';
import { fixedLabelCache, LABELS } from '../../test/fixtures/labels.js';
import { activePairsOn } from '../../test/fixtures/worker.js';
import { StampQueue } from '../worker/stamp-queue.js';

type CrashPoint = 'none' | 'in-send' | 'after-send' | 'in-commit' | 'after-commit';

/**
 * One "process": a Store opened on the DB file + a runOnce wired to a fake journal and a stamp sink (a fake that
 * records into `stamps`, or with `stamps` null the real persisted StampQueue).
 */
function boot(dbFile: string, journal: JournalFile[], stamps: StampUpdate[] | null, clock: { t: number }) {
  const store = new Store(dbFile);
  const { portals, watchedPairs } = activePairsOn(store);
  const labels = fixedLabelCache(LABELS);
  let crash: CrashPoint = 'none';
  const realTx = store.transaction.bind(store) as (fn: () => unknown) => unknown;
  // Crash injection around the final transaction of runOnce (the one that saves the offset).
  let depth = 0; // nested transactions (the queue's own) run inside the outer one: only the outer one crashes
  (store as unknown as { transaction: (fn: () => unknown) => unknown }).transaction = (fn) => {
    if (depth > 0) return realTx(fn);
    if (crash === 'after-send') throw new Error('CRASH before the offset commit');
    const before = store.journal.getOffset();
    depth++;
    let r: unknown;
    try {
      r = realTx(() => {
        const out = fn();
        if (crash === 'in-commit' && store.journal.getOffset() !== before) throw new Error('CRASH in the final (offset) commit');
        return out;
      });
    } finally {
      depth--;
    }
    if (crash === 'after-commit' && store.journal.getOffset() !== before) throw new Error('CRASH right after the offset commit');
    return r;
  };
  const queue = new StampQueue({
    store,
    revoked: { listRevoked: () => [] },
    spacingFor: () => 0,
    now: () => clock.t,
    log: memoryLogger().log,
    sendBatches: async (us) => us.map((update) => ({ update, kind: 'ok' as const })),
  });
  const { readJournal } = fakeJournal(journal);
  const deps: RunDeps = {
    readJournal,
    enqueueStamps: (updates) => {
      if (crash === 'in-send') throw new Error('CRASH while stamping');
      if (!stamps) return queue.enqueue(updates);
      stamps.push(...updates);
      return updates;
    },
    store,
    labels,
    now: () => clock.t,
    watchedPairs,
    log: memoryLogger().log,
  };
  return {
    store,
    queue,
    portals,
    run: (c: CrashPoint = 'none') => {
      crash = c;
      return runOnce(deps);
    },
  };
}

/** change_log of deal 1, oldest first. */
function changeRows(store: Store) {
  return store.changes.changesForRecords(111, DEAL, ['1'], 0).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.changeId.localeCompare(b.changeId));
}

function withDb(fn: (dbFile: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-crash-'));
    try {
      await fn(join(dir, 'worker.db'));
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows: a file still open after a failed assertion */
      }
    }
  };
}

// Label swap split over two journal files: the REMOVED half is held (pending) when run 1 commits its offset.
for (const second of ['none', 'in-send', 'after-send', 'after-commit'] as const) {
  test(
    `crash after the offset commit with a held half, then restart (second run crash: ${second}) -> one LABEL_CHANGED`,
    withDb(async (dbFile) => {
      const journal: JournalFile[] = [
        file('f1', [ev({ action: ADD, typeId: 3, at: 0 }), ev({ action: ADD, typeId: 101, category: UD, at: 0 })]),
        file('f2', [ev({ action: REM, typeId: 101, category: UD, at: 20_000 })]),
      ];
      const stamps: StampUpdate[] = [];
      const clock = { t: T0 + 20_500 }; // f2's cluster is inside its deadline -> held
      let p = boot(dbFile, journal, stamps, clock);
      p.portals.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);

      // Run 1 dies right AFTER its transaction committed (offset f2 + the held half).
      await assert.rejects(p.run('after-commit'), /right after the offset commit/);
      assert.equal(p.store.journal.getOffset(), 'f2');
      p.store.close();

      // Restart: nothing in memory survives; the held half must come back from the DB.
      p = boot(dbFile, journal, stamps, clock);
      assert.equal(p.store.entries.loadPending().length, 1, 'held half persisted with the offset');
      assert.equal(p.store.journal.getOffset(), 'f2');

      // The partner half arrives in a later file; optionally the restarted worker crashes once more.
      journal.push(file('f3', [ev({ action: ADD, typeId: 102, category: UD, at: 20_100 })]));
      clock.t = T0 + 40_000; // deadline passed -> released
      if (second !== 'none') {
        await assert.rejects(p.run(second), /CRASH/);
        if (second === 'after-commit') {
          // Committed: the change is done; nothing to re-read.
        } else {
          assert.equal(p.store.journal.getOffset(), 'f2', 'offset not advanced by a crashed run');
          assert.equal(p.store.entries.loadPending().length, 1, 'held half still there');
        }
        p.store.close();
        p = boot(dbFile, journal, stamps, clock);
      }
      await p.run();

      assert.equal(p.store.journal.getOffset(), 'f3');
      assert.equal(p.store.entries.loadPending().length, 0);
      const rows = changeRows(p.store);
      assert.deepEqual(
        rows.map((r) => [r.changeType, r.labelBefore, r.labelAfter, r.labelsCurrent]),
        [
          ['ADDED', 'none', '0-1:101', '0-1:101'],
          ['LABEL_CHANGED', '0-1:101', '0-1:102', '0-1:102'],
        ],
        'exactly one change for the held pair, with the right labels',
      );
      // One stamp per change id: no duplicate delivery across the crashes.
      const ids = stamps.map((s) => s.properties.changecatch_last_change_id);
      assert.equal(new Set(ids).size, ids.length, 'no duplicate stamps');
      assert.equal(ids.length, 2);
      p.store.close();
    }),
  );
}

test(
  'crash after the offset commit with a SPLIT-HOLD half (structural unlink first, label half in a later file) -> one REMOVED',
  withDb(async (dbFile) => {
    const pub = T0 + 2_000; // journal file publish times (UUIDv7)
    const journal: JournalFile[] = [
      file(uuid7(T0 - 60_000, 1), [ev({ action: ADD, typeId: 3, at: -60_000 }), ev({ action: ADD, typeId: 101, category: UD, at: -60_000 })]),
      // One unlink split over two files (identical occurredAt): structural half first.
      file(uuid7(pub, 2), [ev({ action: REM, typeId: 3, at: 0 })]),
    ];
    const stamps: StampUpdate[] = [];
    const clock = { t: pub + 1_000 }; // inside the 4 s split hold
    let p = boot(dbFile, journal, stamps, clock);
    p.portals.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);

    await assert.rejects(p.run('after-commit'), /right after the offset commit/);
    p.store.close();

    p = boot(dbFile, journal, stamps, clock);
    assert.equal(p.store.entries.loadPending().length, 1, 'split-hold half persisted with the offset');
    journal.push(file(uuid7(pub + 2_500, 3), [ev({ action: REM, typeId: 101, category: UD, at: 0 })]));
    clock.t = pub + 10_000;
    await p.run();

    assert.equal(p.store.entries.loadPending().length, 0);
    assert.deepEqual(
      changeRows(p.store).map((r) => [r.changeType, r.labelBefore, r.labelsCurrent]),
      [
        ['ADDED', 'none', '0-1:101'],
        ['REMOVED', '0-1:101', 'none'],
      ],
    );
    p.store.close();
  }),
);

for (const crash of ['in-send', 'after-send', 'in-commit'] as const) {
  test(
    `a failed final commit (${crash}) leaves no queued stamps and no change_log rows from that run; the re-run queues exactly one stamp per change`,
    withDb(async (dbFile) => {
      const journal: JournalFile[] = [
        file('f1', [ev({ action: REM, typeId: 3, at: 0 }), ev({ action: ADD, typeId: 3, from: [DEAL, 7], to: [CONTACT, 9], at: 1_000 })]),
        file('f2', [ev({ portalId: 5, at: 40_000 })]),
      ];
      const clock = { t: T0 + 60_000 };
      let p = boot(dbFile, journal, null, clock);
      p.portals.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);

      await assert.rejects(p.run(crash), /CRASH/);
      assert.equal(p.store.journal.getOffset(), null, 'offset not saved');
      assert.equal(p.store.stamps.queueSize(), 0, 'no queued stamps from the failed run');
      assert.equal(p.store.portalFootprint(111).change_log, 0, 'no orphan change_log rows from the failed run');
      p.store.close();

      p = boot(dbFile, journal, null, clock);
      const r = await p.run();
      assert.equal(r.offset, 'f2');
      const queued = p.store.stamps.queueSize();
      assert.ok(r.changesEmitted === 2 && queued >= 2, `${queued} queued for ${r.changesEmitted} change(s)`);
      const drained = await p.queue.drain();
      const keys = drained.sent.map((u) => `${u.objectTypeId}|${u.objectId}|${u.properties.changecatch_last_change_id}`);
      assert.equal(keys.length, queued);
      assert.equal(new Set(keys).size, keys.length, 'exactly one stamp per change and record');
      assert.equal(p.store.stamps.queueSize(), 0);

      // Nothing new: a third run queues nothing.
      await p.run();
      assert.equal(p.store.stamps.queueSize(), 0);
      p.store.close();
    }),
  );
}
