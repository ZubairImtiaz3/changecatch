// resolve.ts: labels are carried as type-id keys (naming review 2026-11-07) and translated to the other direction for
// mirror stamps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelKeysOf, resolveChanges } from './resolve.js';
import { toChangeRecords } from './stamp.js';
import type { PairedChange } from './types.js';
import { CONTACT, DEAL, HD, UD } from '../../test/fixtures/journal.js';
import { defsLabelCache, pairedChange, type Defs } from '../../test/fixtures/labels.js';


// Deal -> Contact and Contact -> Deal ids differ per direction. "Manager"/"Employee" is a PAIRED label: each side has
// its own name, so it can't be translated by name.
const DEFS: Defs = {
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

const labels = defsLabelCache(DEFS);
const paired = (changeType: PairedChange['changeType'], added: number[], removed: number[] = []) => pairedChange(changeType, added, removed);

test('labelKeysOf: type ids as keys, unlabeled structural type, unresolved ids, names on the side', async () => {
  const r = await labelKeysOf(paired('ADDED', [3, 101, 999]), labels);
  assert.deepEqual(r.added, ['101', 'type 999', 'unlabeled']);
  assert.deepEqual(r.names, { '101': 'Decision maker' });
});

test('resolveChanges: keys in the label sets and state; no mirror keys unless asked', async () => {
  const state = new Map<string, string[]>();
  const { changes, stateUpdates } = await resolveChanges([paired('ADDED', [3, 101])], labels, { getAssociationLabels: (k) => state.get(k) }, false);
  assert.deepEqual(changes[0].labelsCurrent, ['101', 'unlabeled']);
  assert.deepEqual([...stateUpdates.values()], [['101', 'unlabeled']], 'stored state holds keys');
  assert.equal(changes[0].mirrorLabelKeys, undefined);
});

test('resolveChanges (mirror): normal labels translate by name to the to -> from id; a paired label stays untranslated', async () => {
  const state = new Map<string, string[]>();
  const { changes } = await resolveChanges([paired('ADDED', [3, 101, 105])], labels, { getAssociationLabels: (k) => state.get(k) }, true);
  assert.deepEqual(changes[0].mirrorLabelKeys, { '101': '201' }, '"Manager" has no "Manager" on the contact side');
  const [deal, contact] = toChangeRecords(changes[0], true);
  assert.equal(deal.labelsCurrent, '0-1:101;0-1:105');
  assert.equal(contact.labelsCurrent, '0-3:201;unknown', 'the paired label is "unknown" on the mirror record, never the deal-side id');
});

test('resolveChanges: a label edit uses the known state (keys) for labels before', async () => {
  const state = new Map<string, string[]>();
  const first = await resolveChanges([paired('ADDED', [3, 101])], labels, { getAssociationLabels: (k) => state.get(k) }, false);
  for (const [k, v] of first.stateUpdates) if (v) state.set(k, v);
  const { changes } = await resolveChanges([paired('LABEL_CHANGED', [105], [101])], labels, { getAssociationLabels: (k) => state.get(k) }, false);
  assert.deepEqual(changes[0].labelBefore, ['101', 'unlabeled']);
  assert.deepEqual(changes[0].labelAfter, ['105', 'unlabeled']);
  const [r] = toChangeRecords(changes[0], false);
  assert.deepEqual([r.labelBefore, r.labelAfter], ['0-1:101', '0-1:105']);
});

test('resolveChanges (mirror): a label known only from stored state is translated too', async () => {
  const state = new Map<string, string[]>();
  const first = await resolveChanges([paired('ADDED', [3, 101])], labels, { getAssociationLabels: (k) => state.get(k) }, false);
  for (const [k, v] of first.stateUpdates) if (v) state.set(k, v);
  const { changes } = await resolveChanges([paired('LABEL_CHANGED', [105])], labels, { getAssociationLabels: (k) => state.get(k) }, true);
  assert.deepEqual(changes[0].labelBefore, ['101', 'unlabeled']);
  assert.deepEqual(changes[0].mirrorLabelKeys, { '101': '201' }, '"Decision maker" came from state, not from this event');
});
