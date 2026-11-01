// Real journal sequences captured from a HubSpot test portal on 2026-10-30 (custom-object and Deal<->Contact label-edit runs).
// One direction only (from = the subscribed object), all isPrimary:false, steps ~25 s apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type LabelDefinition } from '../../src/store/db.js';
import { buildStructuralCheck, StoreLabelCache, type LabelCache } from '../../src/core/labels.js';
import { categoryIsStructural, DEFAULT_PAIRING_CONFIG, pairAssociations } from '../../src/core/pairing.js';
import { runOnce, type JournalReadResult } from '../../src/core/poller.js';
import type { AppEventOccurrence, JournalAssociationEntry, JournalFile } from '../../src/core/types.js';
import { ADD, CONTACT, DEAL, entry, ev, file, REM, T0, UD } from '../../src/core/testutil.js';
import { DEAL_CONTACT_LABELS, HD } from '../fixtures/deal-contact-labels.js';

const PETS = '2-23488212';
const CAR = '2-8929543';
const STEP = 25_000;

const DEFS: Record<string, LabelDefinition[]> = {
  [`${DEAL}>${CONTACT}`]: DEAL_CONTACT_LABELS,
  [`${PETS}>${CONTACT}`]: [{ associationTypeId: 163, label: null, category: UD }],
  [`${CAR}>${CONTACT}`]: [
    { associationTypeId: 125, label: null, category: UD },
    { associationTypeId: 127, label: 'Test', category: UD },
  ],
};

const deal = (action: typeof ADD | typeof REM, typeId: number, at: number) =>
  ev({ action, typeId, category: typeId === 3 ? HD : UD, from: [DEAL, 1], to: [CONTACT, 2], at });
const pets = (action: typeof ADD | typeof REM, at: number) => ev({ action, typeId: 163, category: UD, from: [PETS, 10], to: [CONTACT, 2], at });
const car = (action: typeof ADD | typeof REM, typeId: number, at: number) =>
  ev({ action, typeId, category: UD, from: [CAR, 20], to: [CONTACT, 3], at });

/** Each step in its own journal file, in the order HubSpot delivered them. */
const STEPS: JournalAssociationEntry[][] = [
  /* 1 link unlabeled           */ [deal(ADD, 3, 1 * STEP)],
  /* 2 add Influencer           */ [deal(ADD, 249, 2 * STEP)],
  /* 3 Influencer -> Decision   */ [deal(ADD, 247, 3 * STEP), deal(REM, 249, 3 * STEP + 108)],
  /* 4 add Billing contact      */ [deal(ADD, 251, 4 * STEP)],
  /* 5 remove Billing contact   */ [deal(REM, 251, 5 * STEP)],
  /* 6 full unlink              */ [deal(REM, 3, 6 * STEP), deal(REM, 247, 6 * STEP)],
  /* 7 new link with Influencer */ [deal(ADD, 3, 7 * STEP), deal(ADD, 249, 7 * STEP)],
  /* 8 unlink                   */ [deal(REM, 3, 8 * STEP), deal(REM, 249, 8 * STEP)],
  /* pets link                  */ [pets(ADD, 9 * STEP)],
  /* pets unlink                */ [pets(REM, 10 * STEP)],
  /* car link with "Test"       */ [car(ADD, 127, 11 * STEP), car(ADD, 125, 11 * STEP)],
  /* car remove label only      */ [car(REM, 127, 12 * STEP)],
  /* car unlink                 */ [car(REM, 125, 13 * STEP)],
  /* unrelated, closes the rest */ [ev({ portalId: 5, at: 20 * STEP })],
];

function setup(limit = 100) {
  const store = new Store(':memory:');
  store.setWatchedPairs(111, [
    { objectTypeId: DEAL, associatedObjectTypeId: CONTACT },
    { objectTypeId: PETS, associatedObjectTypeId: CONTACT },
    { objectTypeId: CAR, associatedObjectTypeId: CONTACT },
  ]);
  const now = T0 + 30 * STEP;
  const labels = new StoreLabelCache(store, async (_p, f, t) => DEFS[`${f}>${t}`] ?? [], undefined, () => now);
  const files: JournalFile[] = STEPS.map((evs, i) => file(`f${String(i).padStart(2, '0')}`, evs));
  const readJournal = async (after: string | null): Promise<JournalReadResult> => {
    const start = after === null ? 0 : files.findIndex((f) => f.offset === after) + 1;
    const batch = files.slice(start, start + limit);
    return { files: batch, nextOffset: batch.at(-1)?.offset ?? null, full: batch.length === limit };
  };
  const sent: AppEventOccurrence[] = [];
  return { store, labels, readJournal, sent, now };
}

type Expected = { obj: string; change: string; before?: string; after?: string; current?: string; category: string };

const EXPECTED: Expected[] = [
  { obj: DEAL, change: 'ADDED', category: HD }, // 1
  { obj: DEAL, change: 'LABEL_CHANGED', after: 'Influencer', current: 'Influencer', category: UD }, // 2 (before: none)
  { obj: DEAL, change: 'LABEL_CHANGED', before: 'Influencer', after: 'Decision maker', current: 'Decision maker', category: UD }, // 3
  { obj: DEAL, change: 'LABEL_CHANGED', before: 'Decision maker', after: 'Billing contact, Decision maker', current: 'Billing contact, Decision maker', category: UD }, // 4
  { obj: DEAL, change: 'LABEL_CHANGED', before: 'Billing contact, Decision maker', after: 'Decision maker', current: 'Decision maker', category: UD }, // 5
  { obj: DEAL, change: 'REMOVED', before: 'Decision maker', category: UD }, // 6
  { obj: DEAL, change: 'ADDED', after: 'Influencer', current: 'Influencer', category: UD }, // 7
  { obj: DEAL, change: 'REMOVED', before: 'Influencer', category: UD }, // 8
  { obj: PETS, change: 'ADDED', category: UD },
  { obj: PETS, change: 'REMOVED', category: UD },
  { obj: CAR, change: 'ADDED', after: 'Test', current: 'Test', category: UD },
  { obj: CAR, change: 'LABEL_CHANGED', before: 'Test', current: undefined, category: UD }, // label set now empty
  { obj: CAR, change: 'REMOVED', category: UD },
];

function check(sent: AppEventOccurrence[]) {
  assert.equal(sent.length, EXPECTED.length, JSON.stringify(sent.map((o) => [o.objectTypeId, o.properties.change_type])));
  sent.forEach((o, i) => {
    const x = EXPECTED[i];
    const p = o.properties;
    const msg = `occurrence #${i + 1}: ${JSON.stringify(p)}`;
    assert.equal(o.objectTypeId, x.obj, msg);
    assert.equal(p.change_type, x.change, msg);
    assert.equal(p.label_before, x.before, msg);
    assert.equal(p.label_after, x.after, msg);
    assert.equal(p.labels_current, x.current, msg);
    assert.equal(p.association_category, x.category, msg);
  });
}

test('real sequences end to end via runOnce (one read)', async () => {
  const s = setup();
  await runOnce({ readJournal: s.readJournal, sendOccurrences: async (b) => void s.sent.push(...b), store: s.store, labels: s.labels, now: () => s.now });
  check(s.sent);
});

test('real sequences end to end via runOnce (one file per read, cross-batch)', async () => {
  const s = setup(1);
  for (let i = 0; i < STEPS.length + 1; i++)
    await runOnce({ readJournal: s.readJournal, sendOccurrences: async (b) => void s.sent.push(...b), store: s.store, labels: s.labels, now: () => s.now });
  check(s.sent);
});

test('step 3: ADDED arrives before REMOVED -> still one LABEL_CHANGED', async () => {
  const entries = [entry({ action: ADD, typeId: 247, category: UD, at: 0 }), entry({ action: REM, typeId: 249, category: UD, at: 108 })];
  const r = pairAssociations([...entries, entry({ portalId: 5, at: 60_000 })], [], T0 + 120_000);
  const mine = r.changes.filter((c) => c.portalId === 111);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].changeType, 'LABEL_CHANGED');
  assert.deepEqual(mine[0].removed.map((x) => x.associationTypeId), [249]);
  assert.deepEqual(mine[0].added.map((x) => x.associationTypeId), [247]);
});

test('UI label edit: REMOVED arrives 33 ms BEFORE ADDED -> still one LABEL_CHANGED', async () => {
  // Captured from a HubSpot UI edit, Influencer -> Decision maker, 2026-10-30 00:44:24.335 / .368.
  const entries = [entry({ action: REM, typeId: 249, category: UD, at: 0 }), entry({ action: ADD, typeId: 247, category: UD, at: 33 })];
  const r = pairAssociations([...entries, entry({ portalId: 5, at: 60_000 })], [], T0 + 120_000);
  const mine = r.changes.filter((c) => c.portalId === 111);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].changeType, 'LABEL_CHANGED');
  assert.deepEqual(mine[0].removed.map((x) => x.associationTypeId), [249]);
  assert.deepEqual(mine[0].added.map((x) => x.associationTypeId), [247]);
});

test('custom object: category-only fallback would misread the USER_DEFINED default; label rule gets it right', async () => {
  const link = [entry({ action: ADD, typeId: 163, category: UD, from: [PETS, 10], to: [CONTACT, 2] }), entry({ portalId: 5, at: 60_000 })];
  const wrong = pairAssociations(link, [], T0 + 120_000, DEFAULT_PAIRING_CONFIG, -Infinity, categoryIsStructural);
  assert.equal(wrong.changes.find((c) => c.portalId === 111)!.changeType, 'LABEL_CHANGED');

  const s = setup();
  const isStructural = await buildStructuralCheck(link, s.labels);
  const right = pairAssociations(link, [], T0 + 120_000, DEFAULT_PAIRING_CONFIG, -Infinity, isStructural);
  assert.equal(right.changes.find((c) => c.portalId === 111)!.changeType, 'ADDED');
});

test('buildStructuralCheck: unknown type id falls back to HUBSPOT_DEFINED category', async () => {
  const empty: LabelCache = { get: async () => undefined };
  const e = [entry({ typeId: 999, category: HD }), entry({ typeId: 998, category: UD })];
  const check = await buildStructuralCheck(e, empty);
  const r = (typeId: number, category: string) => ({ fromObjectTypeId: DEAL, toObjectTypeId: CONTACT, associationTypeId: typeId, associationCategory: category });
  assert.equal(check(111, r(999, HD)), true);
  assert.equal(check(111, r(998, UD)), false);
});
