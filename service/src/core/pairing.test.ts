import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PAIRING_CONFIG, pairAssociations, type PairingConfig } from './pairing.js';
import type { AssociationEntry, PairedChange } from './types.js';
import { ADD, CONTACT, DEAL, entry, REM, SUB, T0, UD } from './testutil.js';

// Deal -> Contact: 3 = default (HUBSPOT_DEFINED), 101 = Influencer, 102 = Decision maker.
// Contact -> Deal (reverse direction): 4 = default, 201 / 202 = same labels.
const SENTINEL_PORTAL = 999;

/** Run pairing with a far-later unrelated event so every real cluster counts as closed. */
function pairClosed(entries: AssociationEntry[], cfg: Partial<PairingConfig> = {}): PairedChange[] {
  const sentinel = entry({ portalId: SENTINEL_PORTAL, at: 600_000 });
  const r = pairAssociations([...entries, sentinel], [], T0 + 700_000, { ...DEFAULT_PAIRING_CONFIG, ...cfg });
  return r.changes.filter((c) => c.portalId !== SENTINEL_PORTAL);
}

const ids = (refs: { associationTypeId: number }[]) => refs.map((r) => r.associationTypeId).sort();

test('label swap: REMOVED old + ADDED new -> one LABEL_CHANGED', () => {
  const out = pairClosed([
    entry({ action: REM, typeId: 101, category: UD, at: 0 }),
    entry({ action: ADD, typeId: 102, category: UD, at: 300 }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].changeType, 'LABEL_CHANGED');
  assert.deepEqual(ids(out[0].removed), [101]);
  assert.deepEqual(ids(out[0].added), [102]);
  assert.equal(out[0].associationCategory, 'USER_DEFINED');
  assert.equal(out[0].sourceKeys.length, 2);
});

test('add a second label to an existing link -> LABEL_CHANGED by default', () => {
  const out = pairClosed([entry({ action: ADD, typeId: 102, category: UD })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].changeType, 'LABEL_CHANGED');
  assert.deepEqual(ids(out[0].added), [102]);
  assert.deepEqual(out[0].removed, []);
});

test('add a second label -> ADDED when labelOnlyAddedAs = ADDED', () => {
  const out = pairClosed([entry({ action: ADD, typeId: 102, category: UD })], { labelOnlyAddedAs: 'ADDED' });
  assert.equal(out[0].changeType, 'ADDED');
});

test('remove one of two labels (link stays) -> LABEL_CHANGED', () => {
  const out = pairClosed([entry({ action: REM, typeId: 101, category: UD })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].changeType, 'LABEL_CHANGED');
  assert.deepEqual(ids(out[0].removed), [101]);
  assert.equal(pairClosed([entry({ action: REM, typeId: 101, category: UD })], { labelOnlyRemovedAs: 'REMOVED' })[0].changeType, 'REMOVED');
});

test('full unlink: HUBSPOT_DEFINED + labels REMOVED -> one REMOVED', () => {
  const out = pairClosed([
    entry({ action: REM, typeId: 3, at: 0 }),
    entry({ action: REM, typeId: 101, category: UD, at: 10 }),
    entry({ action: REM, typeId: 102, category: UD, at: 20 }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].changeType, 'REMOVED');
  assert.deepEqual(ids(out[0].removed), [101, 102]);
});

test('full unlink of an unlabeled association -> REMOVED, category HUBSPOT_DEFINED', () => {
  const out = pairClosed([entry({ action: REM, typeId: 3 })]);
  assert.equal(out[0].changeType, 'REMOVED');
  assert.equal(out[0].associationCategory, 'HUBSPOT_DEFINED');
});

test('new association with a label -> one ADDED carrying the label', () => {
  const out = pairClosed([
    entry({ action: ADD, typeId: 3, at: 0 }),
    entry({ action: ADD, typeId: 101, category: UD, at: 5 }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].changeType, 'ADDED');
  assert.deepEqual(ids(out[0].added), [101]);
});

test('reversed direction: REMOVED A->B + ADDED B->A still pairs', () => {
  const out = pairClosed([
    entry({ action: REM, typeId: 101, category: UD, from: [DEAL, 1], to: [CONTACT, 2], at: 0 }),
    entry({ action: ADD, typeId: 202, category: UD, from: [CONTACT, 2], to: [DEAL, 1], at: 100 }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].changeType, 'LABEL_CHANGED');
  assert.equal(out[0].fromObjectTypeId, DEAL);
  assert.equal(out[0].added[0].fromObjectTypeId, CONTACT, 'label ref keeps its own direction');
});

test('mirror events in both directions collapse into one change', () => {
  const out = pairClosed([
    entry({ action: REM, typeId: 101, category: UD, from: [DEAL, 1], to: [CONTACT, 2], at: 0 }),
    entry({ action: REM, typeId: 201, category: UD, from: [CONTACT, 2], to: [DEAL, 1], at: 0 }),
    entry({ action: ADD, typeId: 102, category: UD, from: [DEAL, 1], to: [CONTACT, 2], at: 50 }),
    entry({ action: ADD, typeId: 202, category: UD, from: [CONTACT, 2], to: [DEAL, 1], at: 50 }),
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(ids(out[0].removed), [101]);
  assert.deepEqual(ids(out[0].added), [102]);
  assert.equal(out[0].sourceKeys.length, 4, 'dropped mirrors are still marked handled');
});

test('unrelated events interleaved do not pair with each other', () => {
  const out = pairClosed([
    entry({ action: REM, typeId: 101, category: UD, to: [CONTACT, 2], at: 0 }),
    entry({ action: ADD, typeId: 3, to: [CONTACT, 7], at: 100 }),
    entry({ action: REM, typeId: 101, category: UD, portalId: 222, at: 150 }), // same ids, other portal
    entry({ action: ADD, typeId: 102, category: UD, to: [CONTACT, 2], at: 200 }),
  ]);
  assert.equal(out.length, 3);
  const swap = out.find((c) => c.portalId === 111 && c.toObjectId === '2')!;
  assert.equal(swap.changeType, 'LABEL_CHANGED');
  assert.equal(out.find((c) => c.toObjectId === '7')!.changeType, 'ADDED');
  assert.equal(out.find((c) => c.portalId === 222)!.changeType, 'LABEL_CHANGED');
});

test('out of window: REMOVED and ADDED 10s apart are two separate changes', () => {
  const out = pairClosed([
    entry({ action: REM, typeId: 101, category: UD, at: 0 }),
    entry({ action: ADD, typeId: 102, category: UD, at: 10_000 }),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(ids(out[0].removed), [101]);
  assert.deepEqual(ids(out[1].added), [102]);
});

test('window is configurable', () => {
  const out = pairClosed(
    [entry({ action: REM, typeId: 101, category: UD, at: 0 }), entry({ action: ADD, typeId: 102, category: UD, at: 10_000 })],
    { windowMs: 15_000 },
  );
  assert.equal(out.length, 1);
});

test('remove + re-add of the same label cancels out (no change)', () => {
  const out = pairClosed([
    entry({ action: REM, typeId: 101, category: UD, at: 0 }),
    entry({ action: ADD, typeId: 101, category: UD, at: 100 }),
  ]);
  assert.equal(out.length, 0);
});

test("'label' mode: unlabeled -> labeled is a LABEL_CHANGED; full unlink is still REMOVED", () => {
  const swap = pairClosed(
    [entry({ action: REM, typeId: 3, at: 0 }), entry({ action: ADD, typeId: 101, category: UD, at: 100 })],
    { structuralMode: 'label' },
  );
  assert.equal(swap[0].changeType, 'LABEL_CHANGED');
  assert.deepEqual(ids(swap[0].removed), [3]);

  const unlink = pairClosed(
    [entry({ action: REM, typeId: 3 }), entry({ action: REM, typeId: 101, category: UD, at: 5 })],
    { structuralMode: 'label' },
  );
  assert.equal(unlink[0].changeType, 'REMOVED');

  const link = pairClosed([entry({ action: ADD, typeId: 3 })], { structuralMode: 'label' });
  assert.equal(link[0].changeType, 'ADDED');
});

test("'structural' mode: HUBSPOT_DEFINED REMOVED is never paired with a label ADDED", () => {
  const out = pairClosed([entry({ action: REM, typeId: 3, at: 0 }), entry({ action: ADD, typeId: 101, category: UD, at: 100 })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].changeType, 'REMOVED');
});

test('custom object pair works the same way', () => {
  const out = pairClosed([
    entry({ action: REM, typeId: 17, category: UD, from: [SUB, 5], to: [CONTACT, 2], at: 0 }),
    entry({ action: ADD, typeId: 18, category: UD, from: [SUB, 5], to: [CONTACT, 2], at: 50 }),
  ]);
  assert.equal(out[0].changeType, 'LABEL_CHANGED');
  assert.equal(out[0].fromObjectTypeId, SUB);
});

// ---------- holding across batches ----------

test('event at end of batch is held as pending, not emitted early', () => {
  const now = T0 + 1_000; // wall clock 1 s after the event: inside its deadline
  const r = pairAssociations([entry({ action: REM, typeId: 101, category: UD })], [], now, DEFAULT_PAIRING_CONFIG);
  assert.equal(r.changes.length, 0);
  assert.equal(r.stillPending.length, 1);
  assert.equal(r.stillPending[0].holdUntil, now + DEFAULT_PAIRING_CONFIG.maxHoldMs);
});

test('cross-batch pairing: pending REMOVED + next batch ADDED -> one LABEL_CHANGED', () => {
  const first = pairAssociations([entry({ action: REM, typeId: 101, category: UD, at: 0 })], [], T0 + 500);
  assert.equal(first.stillPending.length, 1);

  const second = pairAssociations(
    [entry({ action: ADD, typeId: 102, category: UD, at: 800 }), entry({ portalId: 5, at: 20_000 })],
    first.stillPending,
    T0 + 60_000,
  );
  const mine = second.changes.filter((c) => c.portalId === 111);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].changeType, 'LABEL_CHANGED');
  assert.deepEqual(ids(mine[0].removed), [101]);
  assert.deepEqual(ids(mine[0].added), [102]);
});

test('maxHold safety cap: released after holdUntil even while catching up (deadline not usable)', () => {
  const backlog = { caughtUp: false };
  const first = pairAssociations([entry({ action: REM, typeId: 101, category: UD })], [], T0 + 1_000, DEFAULT_PAIRING_CONFIG, -Infinity, undefined, backlog);
  const stillHeld = pairAssociations([], first.stillPending, T0 + 1_000 + 10_000, DEFAULT_PAIRING_CONFIG, -Infinity, undefined, backlog);
  assert.equal(stillHeld.changes.length, 0);
  assert.equal(stillHeld.stillPending[0].holdUntil, first.stillPending[0].holdUntil, 'holdUntil does not slide');

  const released = pairAssociations([], first.stillPending, first.stillPending[0].holdUntil, DEFAULT_PAIRING_CONFIG, -Infinity, undefined, backlog);
  assert.equal(released.changes.length, 1);
  assert.equal(released.stillPending.length, 0);
});

test('cluster is emitted at once when the stream has moved past its window', () => {
  const r = pairAssociations(
    [entry({ action: ADD, typeId: 3, at: 0 }), entry({ portalId: 5, at: 2_000 + 2_000 })],
    [],
    T0 + 4_500, // wall clock: the 0 ms cluster's deadline (6 s) has NOT passed; the stream watermark closes it
  );
  assert.equal(r.changes.filter((c) => c.portalId === 111).length, 1);
  // The sentinel itself is the newest event, so it is held.
  assert.equal(r.stillPending.length, 1);
  assert.equal(r.stillPending[0].entry.event.portalId, 5);
});

// ---------- wall-clock deadline (latency work 2026-10-30) ----------

const W = DEFAULT_PAIRING_CONFIG.windowMs + DEFAULT_PAIRING_CONFIG.publishDelaySlackMs; // 2000 + 4000

test('defaults: window 2000 ms, publish slack 4000 ms (UI halves 33 ms apart, API 108 ms)', () => {
  assert.equal(DEFAULT_PAIRING_CONFIG.windowMs, 2000);
  assert.equal(DEFAULT_PAIRING_CONFIG.publishDelaySlackMs, 4000);
});

test('UI label edit (33 ms apart) with NO later events is released at newest occurredAt + window + slack', () => {
  const pair = [entry({ action: REM, typeId: 101, category: UD, at: 0 }), entry({ action: ADD, typeId: 102, category: UD, at: 33 })];
  // First read: 2 s after the edit (HubSpot's publish delay). Held, with a wake-up time.
  const r1 = pairAssociations(pair, [], T0 + 2_000);
  assert.equal(r1.changes.length, 0);
  assert.equal(r1.stillPending.length, 2);
  assert.equal(r1.nextReleaseAt, T0 + 33 + W, 'deadline = newest occurredAt + window + slack');

  // 1 ms before the deadline: still held.
  const r2 = pairAssociations([], r1.stillPending, T0 + 33 + W - 1);
  assert.equal(r2.changes.length, 0);

  // At the deadline: one LABEL_CHANGED, nothing else needed in the stream.
  const r3 = pairAssociations([], r1.stillPending, r1.nextReleaseAt!);
  assert.equal(r3.changes.length, 1);
  assert.equal(r3.changes[0].changeType, 'LABEL_CHANGED');
  assert.deepEqual(ids(r3.changes[0].removed), [101]);
  assert.deepEqual(ids(r3.changes[0].added), [102]);
  assert.equal(r3.stillPending.length, 0);
  assert.equal(r3.nextReleaseAt, null);
});

test('API label change: halves 108 ms apart in different reads still pair before the deadline', () => {
  const r1 = pairAssociations([entry({ action: ADD, typeId: 102, category: UD, at: 0 })], [], T0 + 1_500);
  assert.equal(r1.nextReleaseAt, T0 + W);
  const r2 = pairAssociations([entry({ action: REM, typeId: 101, category: UD, at: 108 })], r1.stillPending, T0 + 3_000);
  assert.equal(r2.changes.length, 0, 'both halves held together');
  assert.equal(r2.nextReleaseAt, T0 + 108 + W, 'deadline follows the newest event');
  const r3 = pairAssociations([], r2.stillPending, T0 + 108 + W);
  assert.equal(r3.changes.length, 1);
  assert.equal(r3.changes[0].changeType, 'LABEL_CHANGED');
});

test('backlog catch-up (caughtUp=false): the wall-clock deadline does not release', () => {
  const r = pairAssociations([entry({ action: REM, typeId: 101, category: UD, at: 0 })], [], T0 + 600_000, DEFAULT_PAIRING_CONFIG, -Infinity, undefined, {
    caughtUp: false,
  });
  assert.equal(r.changes.length, 0, 'a partner may be in the next (unread) file');
  assert.equal(r.stillPending.length, 1);
});

test('nextReleaseAt is the earliest of all held clusters (min of deadline and holdUntil)', () => {
  const r = pairAssociations(
    [entry({ action: ADD, typeId: 3, at: 0 }), entry({ action: ADD, typeId: 3, to: [CONTACT, 9], at: 1_000 })],
    [],
    T0 + 1_200,
  );
  assert.equal(r.stillPending.length, 2);
  assert.equal(r.nextReleaseAt, T0 + W);
  const capped = pairAssociations([entry({ action: ADD, typeId: 3, at: 0 })], [], T0 + 100, { ...DEFAULT_PAIRING_CONFIG, maxHoldMs: 1_000 });
  assert.equal(capped.nextReleaseAt, T0 + 1_100, 'maxHold cap is earlier than the deadline');
});
