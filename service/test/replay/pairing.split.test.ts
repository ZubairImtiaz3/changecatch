// Regression: load test `mixed` (2026-10-30). Under load ONE user action is split over several journal files that
// the worker sees seconds apart, already past the occurredAt deadline. Shapes copied from the real journal:
// Deal->Contact typeIds 3 = unlabeled (HUBSPOT_DEFINED), 247 Decision maker, 249 Influencer, 251 Billing contact;
// a full unlink = REMOVED 3 + REMOVED <label> with the IDENTICAL occurredAt, a labeled link = ADDED 3 + ADDED <label>.
// Real case: deal 6180121709 / contact 182106, REMOVED 3 in file 01a18af2-ca35 (seen +7.6 s), REMOVED 251 in file
// 01a18af2-d82a (seen +13.6 s) -> was REMOVED + LABEL_CHANGED "(unknown)".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PAIRING_CONFIG, mayBeHalf, pairAssociations, categoryIsStructural, type PairingConfig, type PairingInput } from '../../src/core/pairing.js';
import type { JournalReadResult } from '../../src/core/poller.js';
import type { AssociationAction, AssociationEntry, JournalFile } from '../../src/core/types.js';
import { entryKey } from '../../src/core/dedupe.js';
import { ADD, CONTACT, DEAL, ev, HD, REM, T0, UD, uuid7 } from '../fixtures/journal.js';
import { DEAL_CONTACT_LABELS } from '../fixtures/labels.js';
import { replayRig } from '../fixtures/replay.js';

/** pairAssociations with the test defaults: default config, category-only structural check, caught up. */
const pair = (i: Omit<PairingInput, 'config' | 'isStructural' | 'caughtUp'> & Partial<PairingInput>) =>
  pairAssociations({ config: DEFAULT_PAIRING_CONFIG, isStructural: categoryIsStructural, caughtUp: true, ...i });

const PORTAL = 1000001;
// These tests pin the split-hold MECHANISM at the 15 s it had when they were written (default is now 4 s; later halves
// are handled by late-half absorption, see absorb.test.ts).
const CFG: PairingConfig = { ...DEFAULT_PAIRING_CONFIG, splitHoldMs: 15_000 };
const SPLIT = CFG.splitHoldMs;

const structural = (_p: number, r: { associationTypeId: number }) => r.associationTypeId === 3;

const dealEv = (action: AssociationAction, typeId: number, at: number, dealId = 6180121709, contactId = 182106) =>
  ev({ portalId: PORTAL, action, typeId, category: typeId === 3 ? HD : UD, from: [DEAL, dealId], to: [CONTACT, contactId], at });

function entryIn(fileOffset: string, action: AssociationAction, typeId: number, at: number): AssociationEntry {
  const e = dealEv(action, typeId, at);
  return { event: e, fileOffset, key: entryKey(fileOffset, e), occurredAtMs: Date.parse(e.occurredAt) };
}

// ---------- pure pairing ----------

test('mayBeHalf: only structural, or only one label action, may be half; structural+label or a swap is whole', () => {
  const f = uuid7(T0);
  const half = (...es: AssociationEntry[]) => mayBeHalf(es, structural);
  assert.equal(half(entryIn(f, REM, 3, 0)), true);
  assert.equal(half(entryIn(f, REM, 251, 0)), true);
  assert.equal(half(entryIn(f, ADD, 249, 0)), true);
  assert.equal(half(entryIn(f, ADD, 3, 0)), true);
  assert.equal(half(entryIn(f, REM, 3, 0), entryIn(f, REM, 251, 0)), false);
  assert.equal(half(entryIn(f, ADD, 3, 0), entryIn(f, ADD, 249, 0)), false);
  assert.equal(half(entryIn(f, REM, 249, 0), entryIn(f, ADD, 247, 33)), false);
});

for (const order of ['structural first', 'label first'] as const) {
  test(`unlink split over two files, first one read PAST the occurredAt deadline (${order}) -> one REMOVED`, () => {
    const fileA = uuid7(T0 + 1_494);
    const fileB = uuid7(T0 + 5_415);
    const [typeA, typeB] = order === 'structural first' ? [3, 251] : [251, 3];
    // Read 1 at +7.6 s (deadline = +6 s already passed): only file A is visible.
    const r1 = pair({ entries: [entryIn(fileA, REM, typeA, 0)], pending: [], now: T0 + 7_600, config: CFG, isStructural: structural });
    assert.equal(r1.changes.length, 0, 'half cluster is held, not released alone');
    assert.equal(r1.nextReleaseAt, T0 + 1_494 + SPLIT);
    // Read 2 at +13.6 s: the partner arrives.
    const r2 = pair({ entries: [entryIn(fileB, REM, typeB, 0)], pending: r1.stillPending, now: T0 + 13_600, config: CFG, isStructural: structural });
    assert.equal(r2.changes.length, 1);
    assert.equal(r2.changes[0].changeType, 'REMOVED');
    assert.deepEqual(r2.changes[0].removed.map((r) => r.associationTypeId), [251]);
    assert.equal(r2.stillPending.length, 0);
  });
}

test('labeled link split over two files -> one ADDED', () => {
  const r1 = pair({ entries: [entryIn(uuid7(T0 + 1_400), ADD, 3, 0)], pending: [], now: T0 + 7_600, config: CFG, isStructural: structural });
  assert.equal(r1.changes.length, 0);
  const r2 = pair({ entries: [entryIn(uuid7(T0 + 4_900), ADD, 249, 0)], pending: r1.stillPending, now: T0 + 13_600, config: CFG, isStructural: structural });
  assert.equal(r2.changes.length, 1);
  assert.equal(r2.changes[0].changeType, 'ADDED');
  assert.deepEqual(r2.changes[0].added.map((r) => r.associationTypeId), [249]);
});

test('whole cluster (structural + label in one file) is NOT delayed by the split hold', () => {
  const f = uuid7(T0 + 1_500);
  const r = pair({ entries: [entryIn(f, REM, 3, 0), entryIn(f, REM, 251, 0)], pending: [], now: T0 + 6_000, config: CFG, isStructural: structural });
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].changeType, 'REMOVED');
});

test('unlabeled unlink with no partner is released at file publish time + splitHoldMs', () => {
  const pub = T0 + 1_500;
  const r1 = pair({ entries: [entryIn(uuid7(pub), REM, 3, 0)], pending: [], now: T0 + 7_000, config: CFG, isStructural: structural });
  assert.equal(r1.nextReleaseAt, pub + SPLIT);
  assert.equal(pair({ entries: [], pending: r1.stillPending, now: pub + SPLIT - 1, config: CFG, isStructural: structural }).changes.length, 0);
  const r2 = pair({ entries: [], pending: r1.stillPending, now: pub + SPLIT, config: CFG, isStructural: structural });
  assert.equal(r2.changes.length, 1);
  assert.equal(r2.changes[0].changeType, 'REMOVED');
});

test('backlog (caughtUp=false): a half cluster is released once a file splitHoldMs newer has been read', () => {
  const far = T0 + 3_600_000; // wall clock says nothing while catching up
  const half = entryIn(uuid7(T0 + 1_500), REM, 3, 0);
  const near = { ...entryIn(uuid7(T0 + 1_500 + SPLIT - 1), ADD, 3, 30_000), event: { ...dealEv(ADD, 3, 30_000, 1, 2) } };
  const r1 = pair({ entries: [half, near], pending: [], now: far, config: CFG, isStructural: structural, caughtUp: false });
  assert.equal(r1.changes.length, 0, 'newest file read is not yet splitHoldMs past');
  const later = { ...entryIn(uuid7(T0 + 1_500 + SPLIT), ADD, 3, 31_000), event: { ...dealEv(ADD, 3, 31_000, 1, 3) } };
  const r2 = pair({ entries: [later], pending: r1.stillPending, now: far, config: CFG, isStructural: structural, caughtUp: false });
  assert.ok(r2.changes.some((c) => c.fromObjectId === '6180121709' && c.changeType === 'REMOVED'));
});

test('splitHoldMs = 0 turns the split hold off (old behaviour: split unlink -> REMOVED + LABEL_CHANGED)', () => {
  const cfg: PairingConfig = { ...DEFAULT_PAIRING_CONFIG, splitHoldMs: 0 };
  const r1 = pair({ entries: [entryIn(uuid7(T0 + 1_494), REM, 3, 0)], pending: [], now: T0 + 7_600, config: cfg, isStructural: categoryIsStructural });
  assert.equal(r1.changes.length, 1, 'released alone: this is the bug the default prevents');
});

// ---------- end to end: runOnce + label state + stamps ----------

async function e2e(unlinkOrder: 'structural first' | 'label first') {
  const rig = replayRig({ portal: PORTAL, labels: DEAL_CONTACT_LABELS, delivery: 'immediate', env: { PAIRING_SPLIT_HOLD_MS: String(CFG.splitHoldMs) } });
  const mk = (pub: number, evs: ReturnType<typeof dealEv>[]): JournalFile => ({ offset: uuid7(pub), journalEvents: evs });
  const [first, second] = unlinkOrder === 'structural first' ? [3, 251] : [251, 3];
  // Each read returns the next scripted batch; reads that HubSpot has nothing for return [].
  const reads: { at: number; files: JournalFile[] }[] = [
    // A labeled link a minute earlier, in two files read together (one ADDED).
    { at: T0 - 50_000, files: [mk(T0 - 58_600, [dealEv(ADD, 3, -60_000)]), mk(T0 - 58_200, [dealEv(ADD, 251, -60_000)])] },
    { at: T0 + 7_600, files: [mk(T0 + 1_494, [dealEv(REM, first, 0)])] },
    { at: T0 + 10_600, files: [] },
    { at: T0 + 13_600, files: [mk(T0 + 5_415, [dealEv(REM, second, 0)])] },
    { at: T0 + 30_000, files: [] },
  ];
  let i = 0;
  const readJournal = async (): Promise<JournalReadResult> => {
    const files = reads[i++].files;
    return { files, nextOffset: files.at(-1)?.offset ?? null, full: false };
  };
  for (const r of reads) {
    rig.clock.t = r.at;
    await rig.run(readJournal);
  }
  return { stamps: rig.sent.map((s) => [s.properties.changecatch_change_type, s.properties.changecatch_labels_current]), store: rig.store };
}

for (const order of ['structural first', 'label first'] as const) {
  test(`runOnce: link-with-label then a split unlink (${order}) -> exactly ADDED then ONE REMOVED "(none)"`, async () => {
    const { stamps, store } = await e2e(order);
    assert.deepEqual(stamps, [
      ['ADDED', '0-1:251'], // Billing contact = type 251
      ['REMOVED', 'none'],
    ]);
    assert.equal(store.entries.loadPending().length, 0);
  });
}
