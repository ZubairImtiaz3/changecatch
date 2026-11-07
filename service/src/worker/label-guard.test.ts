// Label guard: when it asks for the dropdown options to be synced (onUnknownLabel) before anything is stamped.
// Since label values are type-id keyed (naming review 2026-11-07), the sync must also run on the FIRST event of a pair
// even if it carries no label (changecatch_other_object_type needs that pair's option), and again when a label is
// renamed in HubSpot (same type id, new display text).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StoreLabelCache } from '../core/labels.js';
import { CONTACT, DEAL, T0 } from '../core/testutil.js';
import type { LabelDefinition } from '../store/db.js';
import { Store } from '../store/db.js';
import { GuardedLabelCache, LabelHoldError } from './label-guard.js';

const UD = 'USER_DEFINED', HD = 'HUBSPOT_DEFINED';
const DAY = 86_400_000;

function setup(hookFails = false) {
  const store = new Store(':memory:');
  const clock = { t: T0 };
  let defs: LabelDefinition[] = [
    { associationTypeId: 3, label: null, category: HD },
    { associationTypeId: 101, label: 'Influencer', category: UD },
  ];
  const inner = new StoreLabelCache(store, async () => defs, undefined, () => clock.t);
  const hooks: string[] = [];
  const guard = new GuardedLabelCache(inner, {
    store,
    now: () => clock.t,
    log: () => {},
    onUnknownLabel: async (p, f, t) => {
      hooks.push(`${p}|${f}|${t}`);
      if (hookFails) throw new Error('schema 503');
    },
  });
  return { store, clock, guard, hooks, setDefs: (d: LabelDefinition[]) => (defs = d) };
}

test('label guard: the first event of a pair announces it even without a label (unlabeled link)', async () => {
  const s = setup();
  assert.deepEqual(await s.guard.get(111, DEAL, CONTACT, 3), { label: null, category: HD });
  assert.deepEqual(s.hooks, [`111|${DEAL}|${CONTACT}`], 'first sight of the pair -> options synced before the stamp');
  await s.guard.get(111, DEAL, CONTACT, 3);
  await s.guard.get(111, DEAL, CONTACT, 101);
  assert.equal(s.hooks.length, 1, 'every type id known at that sync is marked: no more syncs');
  await s.guard.get(222, DEAL, CONTACT, 3);
  assert.equal(s.hooks.length, 2, 'per portal');
  s.store.close();
});

test('label guard: a new label created later is announced once', async () => {
  const s = setup();
  await s.guard.get(111, DEAL, CONTACT, 101);
  s.setDefs([
    { associationTypeId: 3, label: null, category: HD },
    { associationTypeId: 101, label: 'Influencer', category: UD },
    { associationTypeId: 102, label: 'Decision maker', category: UD },
  ]);
  s.clock.t += 61_000; // past the min refetch gap: an unknown id triggers a refresh
  assert.equal((await s.guard.get(111, DEAL, CONTACT, 102))?.label, 'Decision maker');
  assert.equal(s.hooks.length, 2);
  await s.guard.get(111, DEAL, CONTACT, 102);
  assert.equal(s.hooks.length, 2);
  s.store.close();
});

test('label guard: a label renamed in HubSpot is announced again (option text update), once', async () => {
  const s = setup();
  await s.guard.get(111, DEAL, CONTACT, 101);
  assert.equal(s.hooks.length, 1);
  s.setDefs([
    { associationTypeId: 3, label: null, category: HD },
    { associationTypeId: 101, label: 'Buyer', category: UD },
  ]);
  s.clock.t += DAY + 1; // cache TTL passed: the next lookup refreshes and sees the new name
  assert.equal((await s.guard.get(111, DEAL, CONTACT, 101))?.label, 'Buyer');
  assert.equal(s.hooks.length, 2, 'rename -> sync, so the option keeps its value and gets the new text');
  await s.guard.get(111, DEAL, CONTACT, 101);
  assert.equal(s.hooks.length, 2, 'not again for the same name');
  s.store.close();
});

test('label guard: a failing sync HOLDS (nothing is stamped with a value that is not an option yet)', async () => {
  const s = setup(true);
  await assert.rejects(s.guard.get(111, DEAL, CONTACT, 3), LabelHoldError);
  assert.equal(s.store.listLabelHolds().length, 1);
  s.store.close();
});

test('label guard: findByName passes through to the cache (mirror translation), whitespace-insensitive, unique only', async () => {
  const s = setup();
  s.store.replaceLabels(111, CONTACT, DEAL, [
    { associationTypeId: 4, label: null, category: HD },
    { associationTypeId: 201, label: 'Influencer', category: UD },
    { associationTypeId: 202, label: 'Twin', category: UD },
    { associationTypeId: 203, label: 'Twin', category: UD },
  ], s.clock.t);
  assert.equal(await s.guard.findByName(111, CONTACT, DEAL, '  Influencer '), 201);
  assert.equal(await s.guard.findByName(111, CONTACT, DEAL, 'Twin'), undefined, 'two matches: no guess');
  assert.equal(await s.guard.findByName(111, CONTACT, DEAL, 'Employee'), undefined, 'paired label with another name: no match');
  s.store.close();
});
