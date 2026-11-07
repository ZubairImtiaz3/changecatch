// Real journal sequences captured from a HubSpot test portal on 2026-10-30 (custom-object and Deal<->Contact label-edit runs).
// One direction only (from = the subscribed object), all isPrimary:false, steps ~25 s apart.
// Replayed through the worker (buildWorker) on the stamp path: asserts the stamped properties and the change_log rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LabelDefinition } from '../../src/core/types.js';
import { buildStructuralCheck, type LabelCache } from '../../src/core/labels.js';
import { categoryIsStructural, DEFAULT_PAIRING_CONFIG, pairAssociations, type PairingInput } from '../../src/core/pairing.js';
import { NONE } from '../../src/core/contract.js';
import type { JournalAssociationEntry, JournalFile } from '../../src/core/types.js';
import { ADD, CONTACT, DEAL, entry, ev, fakeJournal, file, HD, REM, T0, UD } from '../fixtures/journal.js';
import { DEAL_CONTACT_LABELS } from '../fixtures/labels.js';
import { replayRig } from '../fixtures/replay.js';

/** pairAssociations with the test defaults: default config, category-only structural check, caught up. */
const pair = (i: Omit<PairingInput, 'config' | 'isStructural' | 'caughtUp'> & Partial<PairingInput>) =>
  pairAssociations({ config: DEFAULT_PAIRING_CONFIG, isStructural: categoryIsStructural, caughtUp: true, ...i });

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
  const rig = replayRig({
    portal: 111,
    pairs: [
      { objectTypeId: DEAL, associatedObjectTypeId: CONTACT },
      { objectTypeId: PETS, associatedObjectTypeId: CONTACT },
      { objectTypeId: CAR, associatedObjectTypeId: CONTACT },
    ],
    labels: async (_p, f, t) => DEFS[`${f}>${t}`] ?? [],
    delivery: 'immediate',
    clock: { t: T0 + 30 * STEP },
  });
  const files: JournalFile[] = STEPS.map((evs, i) => file(`f${String(i).padStart(2, '0')}`, evs));
  const { readJournal } = fakeJournal(files, limit);
  return { store: rig.store, labels: rig.labels, run: () => rig.run(readJournal), sent: rig.sent, now: rig.clock.t };
}

// Label values are option values `${otherObjectTypeId}:${associationTypeId}` (Deal->Contact: 247 Decision maker,
// 249 Influencer, 251 Billing contact; Car->Contact: 127 Test). Unset = "none".
type Expected = { obj: string; change: string; before?: string; after?: string; current?: string; category: string };
const INF = '0-1:249', DM = '0-1:247', BC = '0-1:251', TEST = '0-1:127';

const EXPECTED: Expected[] = [
  { obj: DEAL, change: 'ADDED', category: HD }, // 1
  { obj: DEAL, change: 'LABEL_CHANGED', after: INF, current: INF, category: UD }, // 2 (before: none)
  { obj: DEAL, change: 'LABEL_CHANGED', before: INF, after: DM, current: DM, category: UD }, // 3
  { obj: DEAL, change: 'LABEL_CHANGED', before: DM, after: `${DM};${BC}`, current: `${DM};${BC}`, category: UD }, // 4
  { obj: DEAL, change: 'LABEL_CHANGED', before: `${DM};${BC}`, after: DM, current: DM, category: UD }, // 5
  { obj: DEAL, change: 'REMOVED', before: DM, category: UD }, // 6
  { obj: DEAL, change: 'ADDED', after: INF, current: INF, category: UD }, // 7
  { obj: DEAL, change: 'REMOVED', before: INF, category: UD }, // 8
  { obj: PETS, change: 'ADDED', category: UD },
  { obj: PETS, change: 'REMOVED', category: UD },
  { obj: CAR, change: 'ADDED', after: TEST, current: TEST, category: UD },
  { obj: CAR, change: 'LABEL_CHANGED', before: TEST, category: UD }, // label set now empty
  { obj: CAR, change: 'REMOVED', category: UD },
];

/** One change as stamped (properties) or as logged (change_log), in one shape. */
type Row = { obj: string; change: string; before: string; after: string; current: string; changeId: string };
const stampRows = (s: ReturnType<typeof setup>): Row[] =>
  s.sent.map(({ objectTypeId, properties: p }) => ({
    obj: objectTypeId, change: p.changecatch_change_type!, before: p.changecatch_labels_before!, after: p.changecatch_labels_after!,
    current: p.changecatch_labels_current!, changeId: p.changecatch_last_change_id!,
  }));
const RECORDS: [string, string][] = [[DEAL, '1'], [PETS, '10'], [CAR, '20']];
const logRows = (s: ReturnType<typeof setup>): Row[] =>
  RECORDS.flatMap(([t, id]) => s.store.changes.changesForRecords(111, t, [id], 0))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .map((r) => ({ obj: r.objectTypeId, change: r.changeType, before: r.labelBefore, after: r.labelAfter, current: r.labelsCurrent, changeId: r.changeId }));

function check(rows: Row[], s: ReturnType<typeof setup>) {
  assert.equal(rows.length, EXPECTED.length, JSON.stringify(rows.map((r) => [r.obj, r.change])));
  assert.equal(new Set(rows.map((r) => r.changeId)).size, rows.length, 'each change once');
  rows.forEach((r, i) => {
    const x = EXPECTED[i];
    const msg = `change #${i + 1}: ${JSON.stringify(r)}`;
    assert.equal(r.obj, x.obj, msg);
    assert.equal(r.change, x.change, msg);
    assert.equal(r.before, x.before ?? NONE, msg);
    assert.equal(r.after, x.after ?? NONE, msg);
    assert.equal(r.current, x.current ?? NONE, msg);
    assert.equal(s.store.changes.getChange(111, r.changeId)?.associationCategory, x.category, msg);
  });
}

test('real sequences end to end (one read): every change logged; each record ends on its last change', async () => {
  const s = setup();
  await s.run();
  const logged = logRows(s);
  check(logged, s);
  // One read = a burst per record: the stamp queue coalesces it (oldest + newest stamped), so check the end state.
  for (const [t] of RECORDS) {
    const last = logged.filter((r) => r.obj === t).at(-1)!;
    const stamped = stampRows(s).filter((r) => r.obj === t);
    assert.equal(stamped.at(-1)!.changeId, last.changeId, `${t} shows its last change`);
    assert.equal(new Set(stamped.map((r) => r.changeId)).size, stamped.length, 'never stamped twice');
  }
});

test('real sequences end to end (one file per read, cross-batch): every change logged AND stamped once', async () => {
  const s = setup(1);
  for (let i = 0; i < STEPS.length + 1; i++) await s.run();
  check(logRows(s), s);
  check(stampRows(s), s);
});

test('step 3: ADDED arrives before REMOVED -> still one LABEL_CHANGED', async () => {
  const entries = [entry({ action: ADD, typeId: 247, category: UD, at: 0 }), entry({ action: REM, typeId: 249, category: UD, at: 108 })];
  const r = pair({ entries: [...entries, entry({ portalId: 5, at: 60_000 })], pending: [], now: T0 + 120_000 });
  const mine = r.changes.filter((c) => c.portalId === 111);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].changeType, 'LABEL_CHANGED');
  assert.deepEqual(mine[0].removed.map((x) => x.associationTypeId), [249]);
  assert.deepEqual(mine[0].added.map((x) => x.associationTypeId), [247]);
});

test('UI label edit: REMOVED arrives 33 ms BEFORE ADDED -> still one LABEL_CHANGED', async () => {
  // Captured from a HubSpot UI edit, Influencer -> Decision maker, 2026-10-30 00:44:24.335 / .368.
  const entries = [entry({ action: REM, typeId: 249, category: UD, at: 0 }), entry({ action: ADD, typeId: 247, category: UD, at: 33 })];
  const r = pair({ entries: [...entries, entry({ portalId: 5, at: 60_000 })], pending: [], now: T0 + 120_000 });
  const mine = r.changes.filter((c) => c.portalId === 111);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].changeType, 'LABEL_CHANGED');
  assert.deepEqual(mine[0].removed.map((x) => x.associationTypeId), [249]);
  assert.deepEqual(mine[0].added.map((x) => x.associationTypeId), [247]);
});

test('custom object: category-only fallback would misread the USER_DEFINED default; label rule gets it right', async () => {
  const link = [entry({ action: ADD, typeId: 163, category: UD, from: [PETS, 10], to: [CONTACT, 2] }), entry({ portalId: 5, at: 60_000 })];
  const wrong = pair({ entries: link, pending: [], now: T0 + 120_000, isStructural: categoryIsStructural });
  assert.equal(wrong.changes.find((c) => c.portalId === 111)!.changeType, 'LABEL_CHANGED');

  const s = setup();
  const isStructural = await buildStructuralCheck(link, s.labels);
  const right = pair({ entries: link, pending: [], now: T0 + 120_000, isStructural });
  assert.equal(right.changes.find((c) => c.portalId === 111)!.changeType, 'ADDED');
});

test('buildStructuralCheck: unknown type id falls back to HUBSPOT_DEFINED category', async () => {
  const empty: LabelCache = { get: async () => undefined, findByName: async () => undefined };
  const e = [entry({ typeId: 999, category: HD }), entry({ typeId: 998, category: UD })];
  const check = await buildStructuralCheck(e, empty);
  const r = (typeId: number, category: string) => ({ fromObjectTypeId: DEAL, toObjectTypeId: CONTACT, associationTypeId: typeId, associationCategory: category });
  assert.equal(check(111, r(999, HD)), true);
  assert.equal(check(111, r(998, UD)), false);
});
