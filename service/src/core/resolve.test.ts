// resolve.ts: labels are carried as type-id keys (naming review 2026-11-07), names on the side, and translated to the
// other direction for mirror stamps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LabelCache } from './labels.js';
import { normLabelName } from './labels.js';
import { labelKeysOf, resolveChanges } from './resolve.js';
import { toChangeRecords } from './stamp.js';
import type { PairedChange } from './types.js';
import { CONTACT, DEAL, T0 } from './testutil.js';

const UD = 'USER_DEFINED', HD = 'HUBSPOT_DEFINED';

// Deal -> Contact and Contact -> Deal ids differ per direction. "Manager"/"Employee" is a PAIRED label: each side has
// its own name, so it can't be translated by name.
const DEFS: Record<string, { typeId: number; label: string | null; category: string }[]> = {
  [`${DEAL}>${CONTACT}`]: [
    { typeId: 3, label: null, category: HD },
    { typeId: 101, label: 'Decision maker', category: UD },
    { typeId: 105, label: 'Manager', category: UD },
  ],
  [`${CONTACT}>${DEAL}`]: [
    { typeId: 4, label: null, category: HD },
    { typeId: 201, label: 'Decision maker', category: UD },
    { typeId: 206, label: 'Employee', category: UD },
  ],
};

const labels: LabelCache = {
  async get(_p, from, to, typeId) {
    const d = DEFS[`${from}>${to}`]?.find((x) => x.typeId === typeId);
    return d && { label: d.label, category: d.category };
  },
  async findByName(_p, from, to, label) {
    const hits = (DEFS[`${from}>${to}`] ?? []).filter((x) => x.label !== null && normLabelName(x.label) === normLabelName(label));
    return hits.length === 1 ? hits[0].typeId : undefined;
  },
};

const ref = (associationTypeId: number) => ({ fromObjectTypeId: DEAL, toObjectTypeId: CONTACT, associationTypeId, associationCategory: UD });
const paired = (changeType: PairedChange['changeType'], added: number[], removed: number[] = []): PairedChange => ({
  portalId: 111, changeType, fromObjectTypeId: DEAL, fromObjectId: '1', toObjectTypeId: CONTACT, toObjectId: '2',
  added: added.map(ref), removed: removed.map(ref), associationCategory: UD,
  occurredAt: new Date(T0).toISOString(), sourceKeys: [`k${changeType}${added}${removed}`], sourceOffsets: ['f'],
});

test('labelKeysOf: type ids as keys, unlabeled structural type, unresolved ids, names on the side', async () => {
  const r = await labelKeysOf(paired('ADDED', [3, 101, 999]), labels);
  assert.deepEqual(r.added, ['101', 'type 999', 'unlabeled']);
  assert.deepEqual(r.names, { '101': 'Decision maker' });
});

test('resolveChanges: keys in the label sets and state; labelNames for logs / app events; no mirror keys unless asked', async () => {
  const state = new Map<string, string[]>();
  const { changes, stateUpdates } = await resolveChanges([paired('ADDED', [3, 101])], labels, { getAssociationLabels: (k) => state.get(k) });
  assert.deepEqual(changes[0].labelsCurrent, ['101', 'unlabeled']);
  assert.deepEqual([...stateUpdates.values()], [['101', 'unlabeled']], 'stored state holds keys');
  assert.deepEqual(changes[0].labelNames, { '101': 'Decision maker' });
  assert.equal(changes[0].mirrorLabelKeys, undefined);
});

test('resolveChanges (mirror): normal labels translate by name to the to -> from id; a paired label stays untranslated', async () => {
  const state = new Map<string, string[]>();
  const { changes } = await resolveChanges([paired('ADDED', [3, 101, 105])], labels, { getAssociationLabels: (k) => state.get(k) }, {
    unlabeledName: 'unlabeled',
    mirror: true,
  });
  assert.deepEqual(changes[0].mirrorLabelKeys, { '101': '201' }, '"Manager" has no "Manager" on the contact side');
  const [deal, contact] = toChangeRecords(changes[0], { mirrorOnOtherRecord: true });
  assert.equal(deal.labelsCurrent, '0-1:101;0-1:105');
  assert.equal(contact.labelsCurrent, '0-3:201;unknown', 'the paired label is "unknown" on the mirror record, never the deal-side id');
});

test('resolveChanges: a label edit uses the known state (keys) for labels before', async () => {
  const state = new Map<string, string[]>();
  const first = await resolveChanges([paired('ADDED', [3, 101])], labels, { getAssociationLabels: (k) => state.get(k) });
  for (const [k, v] of first.stateUpdates) if (v) state.set(k, v);
  const { changes } = await resolveChanges([paired('LABEL_CHANGED', [105], [101])], labels, { getAssociationLabels: (k) => state.get(k) });
  assert.deepEqual(changes[0].labelBefore, ['101', 'unlabeled']);
  assert.deepEqual(changes[0].labelAfter, ['105', 'unlabeled']);
  assert.deepEqual(changes[0].labelNames, { '101': 'Decision maker', '105': 'Manager' }, 'names for keys from state too');
  const [r] = toChangeRecords(changes[0]);
  assert.deepEqual([r.labelBefore, r.labelAfter], ['0-1:101', '0-1:105']);
});
