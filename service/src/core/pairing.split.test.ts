// Regression: load test `mixed` (2026-10-30). Under load ONE user action is split over several journal files that
// the worker sees seconds apart, already past the occurredAt deadline. Shapes copied from the real journal:
// Deal->Contact typeIds 3 = unlabeled (HUBSPOT_DEFINED), 247 Decision maker, 249 Influencer, 251 Billing contact;
// a full unlink = REMOVED 3 + REMOVED <label> with the IDENTICAL occurredAt, a labeled link = ADDED 3 + ADDED <label>.
// Real case: deal 6180121709 / contact 182106, REMOVED 3 in file 01a18af2-ca35 (seen +7.6 s), REMOVED 251 in file
// 01a18af2-d82a (seen +13.6 s) -> was REMOVED + LABEL_CHANGED "(unknown)".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type LabelDefinition } from '../store/db.js';
import { StoreLabelCache } from './labels.js';
import { DEFAULT_PAIRING_CONFIG, mayBeHalf, offsetTimeMs, pairAssociations, categoryIsStructural, type PairingConfig } from './pairing.js';
import { runOnce, type JournalReadResult } from './poller.js';
import type { AssociationAction, AssociationEntry, JournalFile } from './types.js';
import type { StampUpdate } from './stamp.js';
import { entryKey } from './dedupe.js';
import { ADD, CONTACT, DEAL, ev, REM, T0, UD } from './testutil.js';

const HD = 'HUBSPOT_DEFINED';
const PORTAL = 1000001;
// These tests pin the split-hold MECHANISM at the 15 s it had when they were written (default is now 4 s; later halves
// are handled by late-half absorption, see absorb.test.ts).
const CFG: PairingConfig = { ...DEFAULT_PAIRING_CONFIG, splitHoldMs: 15_000 };
const SPLIT = CFG.splitHoldMs;

const DEFS: LabelDefinition[] = [
  { associationTypeId: 3, label: null, category: HD },
  { associationTypeId: 247, label: 'Decision maker', category: UD },
  { associationTypeId: 249, label: 'Influencer', category: UD },
  { associationTypeId: 251, label: 'Billing contact', category: UD },
];
const structural = (_p: number, r: { associationTypeId: number }) => r.associationTypeId === 3;

/** A UUIDv7 journal offset whose time part is `ms` (like HubSpot's). */
let seq = 0;
function uuid7(ms: number): string {
  const h = ms.toString(16).padStart(12, '0');
  const s = (++seq).toString(16).padStart(3, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${s}-8000-000000000000`;
}

const dealEv = (action: AssociationAction, typeId: number, at: number, dealId = 6180121709, contactId = 182106) =>
  ev({ portalId: PORTAL, action, typeId, category: typeId === 3 ? HD : UD, from: [DEAL, dealId], to: [CONTACT, contactId], at });

function entryIn(fileOffset: string, action: AssociationAction, typeId: number, at: number): AssociationEntry {
  const e = dealEv(action, typeId, at);
  return { event: e, fileOffset, key: entryKey(fileOffset, e), occurredAtMs: Date.parse(e.occurredAt) };
}

// ---------- pure pairing ----------

test('offsetTimeMs reads the publish time from a real journal offset; NaN for non-UUIDv7', () => {
  assert.equal(new Date(offsetTimeMs('01a18af2-c8d9-747f-b864-1d114b2ad220')).toISOString(), '2026-10-30T03:55:29.369Z');
  assert.ok(Number.isNaN(offsetTimeMs('file-000001')));
});

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
    const r1 = pairAssociations([entryIn(fileA, REM, typeA, 0)], [], T0 + 7_600, CFG, -Infinity, structural);
    assert.equal(r1.changes.length, 0, 'half cluster is held, not released alone');
    assert.equal(r1.nextReleaseAt, T0 + 1_494 + SPLIT);
    // Read 2 at +13.6 s: the partner arrives.
    const r2 = pairAssociations([entryIn(fileB, REM, typeB, 0)], r1.stillPending, T0 + 13_600, CFG, -Infinity, structural);
    assert.equal(r2.changes.length, 1);
    assert.equal(r2.changes[0].changeType, 'REMOVED');
    assert.deepEqual(r2.changes[0].removed.map((r) => r.associationTypeId), [251]);
    assert.equal(r2.stillPending.length, 0);
  });
}

test('labeled link split over two files -> one ADDED', () => {
  const r1 = pairAssociations([entryIn(uuid7(T0 + 1_400), ADD, 3, 0)], [], T0 + 7_600, CFG, -Infinity, structural);
  assert.equal(r1.changes.length, 0);
  const r2 = pairAssociations([entryIn(uuid7(T0 + 4_900), ADD, 249, 0)], r1.stillPending, T0 + 13_600, CFG, -Infinity, structural);
  assert.equal(r2.changes.length, 1);
  assert.equal(r2.changes[0].changeType, 'ADDED');
  assert.deepEqual(r2.changes[0].added.map((r) => r.associationTypeId), [249]);
});

test('whole cluster (structural + label in one file) is NOT delayed by the split hold', () => {
  const f = uuid7(T0 + 1_500);
  const r = pairAssociations([entryIn(f, REM, 3, 0), entryIn(f, REM, 251, 0)], [], T0 + 6_000, CFG, -Infinity, structural);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].changeType, 'REMOVED');
});

test('unlabeled unlink with no partner is released at file publish time + splitHoldMs', () => {
  const pub = T0 + 1_500;
  const r1 = pairAssociations([entryIn(uuid7(pub), REM, 3, 0)], [], T0 + 7_000, CFG, -Infinity, structural);
  assert.equal(r1.nextReleaseAt, pub + SPLIT);
  assert.equal(pairAssociations([], r1.stillPending, pub + SPLIT - 1, CFG, -Infinity, structural).changes.length, 0);
  const r2 = pairAssociations([], r1.stillPending, pub + SPLIT, CFG, -Infinity, structural);
  assert.equal(r2.changes.length, 1);
  assert.equal(r2.changes[0].changeType, 'REMOVED');
});

test('backlog (caughtUp=false): a half cluster is released once a file splitHoldMs newer has been read', () => {
  const backlog = { caughtUp: false };
  const far = T0 + 3_600_000; // wall clock says nothing while catching up
  const half = entryIn(uuid7(T0 + 1_500), REM, 3, 0);
  const near = { ...entryIn(uuid7(T0 + 1_500 + SPLIT - 1), ADD, 3, 30_000), event: { ...dealEv(ADD, 3, 30_000, 1, 2) } };
  const r1 = pairAssociations([half, near], [], far, CFG, -Infinity, structural, backlog);
  assert.equal(r1.changes.length, 0, 'newest file read is not yet splitHoldMs past');
  const later = { ...entryIn(uuid7(T0 + 1_500 + SPLIT), ADD, 3, 31_000), event: { ...dealEv(ADD, 3, 31_000, 1, 3) } };
  const r2 = pairAssociations([later], r1.stillPending, far, CFG, -Infinity, structural, backlog);
  assert.ok(r2.changes.some((c) => c.fromObjectId === '6180121709' && c.changeType === 'REMOVED'));
});

test('splitHoldMs = 0 turns the split hold off (old behaviour: split unlink -> REMOVED + LABEL_CHANGED)', () => {
  const cfg: PairingConfig = { ...DEFAULT_PAIRING_CONFIG, splitHoldMs: 0 };
  const r1 = pairAssociations([entryIn(uuid7(T0 + 1_494), REM, 3, 0)], [], T0 + 7_600, cfg, -Infinity, categoryIsStructural);
  assert.equal(r1.changes.length, 1, 'released alone: this is the bug the default prevents');
});

// ---------- end to end: runOnce + label state + stamps ----------

async function e2e(unlinkOrder: 'structural first' | 'label first') {
  const store = new Store(':memory:');
  store.setWatchedPairs(PORTAL, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
  let now = T0 - 60_000;
  const labels = new StoreLabelCache(store, async (_p, f, t) => (f === DEAL && t === CONTACT ? DEFS : []), undefined, () => now);
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
  const stamps: StampUpdate[] = [];
  for (const r of reads) {
    now = r.at;
    await runOnce({
      readJournal,
      sendStamps: async (u, onDelivered) => {
        stamps.push(...u);
        onDelivered(u);
      },
      store,
      labels,
      now: () => now,
      config: { pairing: CFG },
    });
  }
  return { stamps: stamps.map((s) => [s.properties.changecatch_change_type, s.properties.changecatch_labels_current]), store };
}

for (const order of ['structural first', 'label first'] as const) {
  test(`runOnce: link-with-label then a split unlink (${order}) -> exactly ADDED then ONE REMOVED "(none)"`, async () => {
    const { stamps, store } = await e2e(order);
    assert.deepEqual(stamps, [
      ['ADDED', '0-1:Billing contact'],
      ['REMOVED', '(none)'],
    ]);
    assert.equal(store.loadPending().length, 0);
  });
}
