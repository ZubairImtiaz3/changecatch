// Crash safety of held pairing halves (pre-launch test #1 follow-up: "66 held for pairing" vs an empty pending_pairs).
//
// Held entries (pending clusters, split-hold halves) are written by store.replacePending in the SAME transaction as
// store.setOffset (runOnce, poller.ts). These tests kill the "process" at different points (the Store is closed and
// reopened from the same SQLite file, all in-memory state is thrown away) and check that the held half still
// completes into exactly ONE change with the right labels.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store/db.js';
import { StoreLabelCache } from './labels.js';
import { runOnce, type JournalReadResult, type RunDeps } from './poller.js';
import type { StampUpdate } from './stamp.js';
import type { JournalFile } from './types.js';
import { ADD, CONTACT, DEAL, ev, file, REM, T0, UD } from './testutil.js';

const LABELS = [
  { associationTypeId: 3, label: null, category: 'HUBSPOT_DEFINED' },
  { associationTypeId: 101, label: 'Influencer', category: UD },
  { associationTypeId: 102, label: 'Decision maker', category: UD },
];

/** UUIDv7-shaped journal offset whose first 48 bits are `ms` (pairing reads the publish time from it). */
function uuid7(ms: number, n: number): string {
  const h = ms.toString(16).padStart(12, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

type CrashPoint = 'none' | 'in-send' | 'after-send' | 'after-commit';

/** One "process": a Store opened on the DB file + a runOnce wired to a fake journal and a stamp sink. */
function boot(dbFile: string, journal: JournalFile[], stamps: StampUpdate[], clock: { t: number }) {
  const store = new Store(dbFile);
  const labels = new StoreLabelCache(store, async () => LABELS, undefined, () => clock.t);
  let crash: CrashPoint = 'none';
  const realTx = store.transaction.bind(store) as (fn: () => unknown) => unknown;
  // Crash injection around the final transaction of runOnce (the one that saves the offset).
  (store as unknown as { transaction: (fn: () => unknown) => unknown }).transaction = (fn) => {
    if (crash === 'after-send') throw new Error('CRASH before the offset commit');
    const before = store.getOffset();
    const r = realTx(fn);
    if (crash === 'after-commit' && store.getOffset() !== before) throw new Error('CRASH right after the offset commit');
    return r;
  };
  const readJournal = async (after: string | null): Promise<JournalReadResult> => {
    const start = after === null ? 0 : journal.findIndex((f) => f.offset === after) + 1;
    const batch = journal.slice(start);
    return { files: batch, nextOffset: batch.at(-1)?.offset ?? null, full: false };
  };
  const deps: RunDeps = {
    readJournal,
    sendStamps: async (updates, onDelivered) => {
      if (crash === 'in-send') throw new Error('CRASH while stamping');
      stamps.push(...updates);
      onDelivered(updates);
    },
    store,
    labels,
    now: () => clock.t,
    config: { deliveryMode: 'stamp' },
  };
  return {
    store,
    run: (c: CrashPoint = 'none') => {
      crash = c;
      return runOnce(deps);
    },
  };
}

function changeRows(store: Store) {
  return store.db
    .prepare('SELECT change_type, label_before, label_after, labels_current, occurred_at FROM change_log ORDER BY occurred_at, change_id')
    .all() as { change_type: string; label_before: string; label_after: string; labels_current: string; occurred_at: string }[];
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
      p.store.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);

      // Run 1 dies right AFTER its transaction committed (offset f2 + the held half).
      await assert.rejects(p.run('after-commit'), /right after the offset commit/);
      assert.equal(p.store.getOffset(), 'f2');
      p.store.close();

      // Restart: nothing in memory survives; the held half must come back from the DB.
      p = boot(dbFile, journal, stamps, clock);
      assert.equal(p.store.loadPending().length, 1, 'held half persisted with the offset');
      assert.equal(p.store.getOffset(), 'f2');

      // The partner half arrives in a later file; optionally the restarted worker crashes once more.
      journal.push(file('f3', [ev({ action: ADD, typeId: 102, category: UD, at: 20_100 })]));
      clock.t = T0 + 40_000; // deadline passed -> released
      if (second !== 'none') {
        await assert.rejects(p.run(second), /CRASH/);
        if (second === 'after-commit') {
          // Committed: the change is done; nothing to re-read.
        } else {
          assert.equal(p.store.getOffset(), 'f2', 'offset not advanced by a crashed run');
          assert.equal(p.store.loadPending().length, 1, 'held half still there');
        }
        p.store.close();
        p = boot(dbFile, journal, stamps, clock);
      }
      await p.run();

      assert.equal(p.store.getOffset(), 'f3');
      assert.equal(p.store.loadPending().length, 0);
      const rows = changeRows(p.store);
      assert.deepEqual(
        rows.map((r) => [r.change_type, r.label_before, r.label_after, r.labels_current]),
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
    p.store.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);

    await assert.rejects(p.run('after-commit'), /right after the offset commit/);
    p.store.close();

    p = boot(dbFile, journal, stamps, clock);
    assert.equal(p.store.loadPending().length, 1, 'split-hold half persisted with the offset');
    journal.push(file(uuid7(pub + 2_500, 3), [ev({ action: REM, typeId: 101, category: UD, at: 0 })]));
    clock.t = pub + 10_000;
    await p.run();

    assert.equal(p.store.loadPending().length, 0);
    assert.deepEqual(
      changeRows(p.store).map((r) => [r.change_type, r.label_before, r.labels_current]),
      [
        ['ADDED', 'none', '0-1:101'],
        ['REMOVED', '0-1:101', 'none'],
      ],
    );
    p.store.close();
  }),
);
