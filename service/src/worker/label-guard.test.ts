// Label guard: when it asks for the dropdown options to be synced (onUnknownLabel) before anything is stamped.
// Since label values are type-id keyed (naming review 2026-11-07), the sync must also run on the FIRST event of a pair
// even if it carries no label (changecatch_other_object_type needs that pair's option), and again when a label is
// renamed in HubSpot (same type id, new display text).
import { memoryLogger } from '../../test/fixtures/log.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LabelHoldError, type LabelFetcher } from '../core/labels.js';
import { CONTACT, DEAL, T0 } from '../../test/fixtures/journal.js';
import type { LabelDefinition } from '../core/types.js';
import { TokenRevokedError } from '../hubspot/portal-tokens.js';
import { Store } from '../store/db.js';
import { GuardedLabelCache, LABEL_MIN_REFETCH_MS, LABEL_TTL_MS } from './label-guard.js';

const UD = 'USER_DEFINED', HD = 'HUBSPOT_DEFINED';
const DAY = 86_400_000;

function setup(hookFails = false) {
  const store = new Store(':memory:');
  const clock = { t: T0 };
  let defs: LabelDefinition[] = [
    { associationTypeId: 3, label: null, category: HD },
    { associationTypeId: 101, label: 'Influencer', category: UD },
  ];
  const hooks: string[] = [];
  const guard = new GuardedLabelCache({
    store: store.labels,
    fetch: async () => defs,
    mirror: false,
    now: () => clock.t,
    log: memoryLogger().log,
    onUnknownLabel: async (p, f, t) => {
      hooks.push(`${p}|${f}|${t}`);
      if (hookFails) throw new Error('schema 503');
      return true;
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
  assert.equal(s.store.labels.listLabelHolds().length, 1);
  s.store.close();
});

test('label guard: refresh fails (token revoked) with a stale cached row -> the cached name is used ONLY once announced', async () => {
  const store = new Store(':memory:');
  const clock = { t: T0 };
  let fetchFails = false;
  let syncFails = false;
  const hooks: string[] = [];
  const guard = new GuardedLabelCache({
    store: store.labels,
    fetch: async () => {
      if (fetchFails) throw new TokenRevokedError(111, T0);
      return [{ associationTypeId: 101, label: 'Influencer', category: UD }];
    },
    mirror: false,
    now: () => clock.t,
    log: memoryLogger().log,
    onUnknownLabel: async (p, f, t) => {
      hooks.push(`${p}|${f}|${t}`);
      if (syncFails) throw new TokenRevokedError(111, T0);
      return true;
    },
  });
  assert.equal((await guard.get(111, DEAL, CONTACT, 101))?.label, 'Influencer');
  clock.t += LABEL_TTL_MS + DAY; // the cached row is stale now
  fetchFails = syncFails = true;
  assert.equal((await guard.get(111, DEAL, CONTACT, 101))?.label, 'Influencer', 'announced before: the stale name is fine');
  assert.equal(hooks.length, 1);

  // The markers are gone (a stamp was refused as "not an option" -> cleared): the stale name must NOT be stamped
  // before its option is synced again. The sync fails too -> HOLD.
  store.labels.clearSyncedFor(111, DEAL);
  clock.t += LABEL_MIN_REFETCH_MS;
  await assert.rejects(guard.get(111, DEAL, CONTACT, 101), LabelHoldError);
  assert.equal(hooks.length, 2, 'the announce check ran despite the failed refresh');
  syncFails = false;
  assert.equal((await guard.get(111, DEAL, CONTACT, 101))?.label, 'Influencer', 'option synced: stamped with the cached name');
  assert.deepEqual(store.labels.getSyncedTypeIds(111, DEAL, CONTACT), [101]);
  store.close();
});

test('label guard: "announced" is recorded only after a real sync (portal not installed -> no record, no hold)', async () => {
  const store = new Store(':memory:');
  let installed = false;
  const hooks: number[] = [];
  const guard = new GuardedLabelCache({
    store: store.labels,
    fetch: async () => [{ associationTypeId: 101, label: 'Influencer', category: UD }],
    mirror: false,
    now: () => T0,
    log: memoryLogger().log,
    onUnknownLabel: async (p) => (hooks.push(p), installed),
  });
  assert.equal((await guard.get(111, DEAL, CONTACT, 101))?.label, 'Influencer', 'not held');
  assert.deepEqual(store.labels.getSyncedTypeIds(111, DEAL, CONTACT), [], 'nothing recorded');
  installed = true; // reinstalled: the next event still announces
  await guard.get(111, DEAL, CONTACT, 101);
  assert.equal(hooks.length, 2);
  assert.deepEqual(store.labels.getSyncedTypeIds(111, DEAL, CONTACT), [101]);
  store.close();
});

test('label cache: findByName (mirror translation), whitespace-insensitive, unique only', async () => {
  const s = setup();
  s.store.labels.replaceLabels(111, CONTACT, DEAL, [
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

// ---------- fetch, TTL, refetch limit ----------

function counted(defs: Record<string, LabelDefinition[]>) {
  const store = new Store(':memory:');
  const clock = { t: T0 };
  const calls: string[] = [];
  const fetch: LabelFetcher = async (p, f, t) => {
    calls.push(`${p}|${f}|${t}`);
    return defs[`${f}>${t}`] ?? [];
  };
  const cache = new GuardedLabelCache({ store: store.labels, fetch, mirror: false, onUnknownLabel: async () => true, now: () => clock.t, log: memoryLogger().log });
  return { store, clock, calls, cache };
}

test('label cache fetches on miss, then serves from the store until the TTL passes', async () => {
  const s = counted({ [`${DEAL}>${CONTACT}`]: [{ associationTypeId: 101, label: 'Influencer', category: UD }, { associationTypeId: 3, label: null, category: HD }] });
  assert.deepEqual(await s.cache.get(111, DEAL, CONTACT, 101), { label: 'Influencer', category: UD });
  assert.deepEqual(await s.cache.get(111, DEAL, CONTACT, 3), { label: null, category: HD });
  assert.equal(s.calls.length, 1);
  s.clock.t += LABEL_TTL_MS;
  await s.cache.get(111, DEAL, CONTACT, 101);
  assert.equal(s.calls.length, 2);
  s.store.close();
});

test('label cache refreshes when a type id is unknown (new label created) but rate-limits refetches (held meanwhile)', async () => {
  const defs = { [`${DEAL}>${CONTACT}`]: [{ associationTypeId: 101, label: 'Influencer', category: UD }] };
  const s = counted(defs);
  await s.cache.get(111, DEAL, CONTACT, 101);
  defs[`${DEAL}>${CONTACT}`].push({ associationTypeId: 102, label: 'Decision maker', category: UD });
  await assert.rejects(s.cache.get(111, DEAL, CONTACT, 102), LabelHoldError, 'within the refetch limit: no refetch, held');
  assert.equal(s.calls.length, 1);
  s.clock.t += LABEL_MIN_REFETCH_MS;
  assert.deepEqual(await s.cache.get(111, DEAL, CONTACT, 102), { label: 'Decision maker', category: UD });
  assert.equal(s.calls.length, 2);
  s.store.close();
});

test('label cache shares one in-flight fetch between concurrent callers, keyed per portal', async () => {
  const s = counted({ [`${DEAL}>${CONTACT}`]: [{ associationTypeId: 101, label: 'Influencer', category: UD }] });
  await Promise.all([s.cache.get(111, DEAL, CONTACT, 101), s.cache.get(111, DEAL, CONTACT, 101)]);
  assert.equal(s.calls.length, 1);
  await s.cache.get(222, DEAL, CONTACT, 101);
  assert.equal(s.calls.length, 2);
  s.store.close();
});

test('label cache: mirroring keeps its own "announced" markers, so switching it on announces every label again', async () => {
  const store = new Store(':memory:');
  const hooks: boolean[] = [];
  const make = (mirror: boolean) => new GuardedLabelCache({
    store: store.labels, fetch: async () => [{ associationTypeId: 101, label: 'Influencer', category: UD }], mirror,
    onUnknownLabel: async () => (hooks.push(mirror), true), now: () => T0, log: memoryLogger().log,
  });
  await make(false).get(111, DEAL, CONTACT, 101);
  await make(false).get(111, DEAL, CONTACT, 101);
  await make(true).get(111, DEAL, CONTACT, 101);
  assert.deepEqual(hooks, [false, true]);
  store.close();
});
