import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../store/db.js';
import { HttpError } from '../lib/http.js';
import { Stamper, type BatchUpdateResponse } from '../hubspot/stamp.js';
import { StoreLabelCache } from './labels.js';
import { runOnce, type JournalReadResult } from './poller.js';
import {
  changeIdFor,
  deliveryModeFromEnv,
  formatLabels,
  NONE,
  planStampBatches,
  planStampSlots,
  planStampWaves,
  recordKey,
  toChangeRecords,
  toStampUpdate,
  UNKNOWN,
  type StampUpdate,
} from './stamp.js';
import type { JournalFile, NormalizedChange } from './types.js';
import { ADD, CONTACT, DEAL, ev, file, REM, SUB, T0, UD } from './testutil.js';

function change(o: Partial<NormalizedChange> = {}): NormalizedChange {
  return {
    portalId: 111,
    changeType: 'LABEL_CHANGED',
    fromObjectTypeId: DEAL,
    fromObjectId: '5',
    toObjectTypeId: CONTACT,
    toObjectId: '7',
    labelBefore: ['Influencer'],
    labelAfter: ['Decision maker'],
    labelsCurrent: ['Decision maker'],
    associationCategory: UD,
    occurredAt: new Date(T0).toISOString(),
    sourceOffsets: ['f1'],
    sourceKeys: ['k2', 'k1'],
    ...o,
  };
}

// ---------- pure mapping ----------

test('formatLabels: joins with "; ", (none) for empty, (unknown) for undefined', () => {
  assert.equal(formatLabels(['A', 'B']), 'A; B');
  assert.equal(formatLabels([]), NONE);
  assert.equal(formatLabels(['  ']), NONE);
  assert.equal(formatLabels(undefined), UNKNOWN);
  assert.equal(formatLabels(undefined, NONE), NONE);
});

test('deliveryModeFromEnv: default stamp, rejects junk', () => {
  assert.equal(deliveryModeFromEnv(undefined), 'stamp');
  assert.equal(deliveryModeFromEnv(''), 'stamp');
  assert.equal(deliveryModeFromEnv('APP_EVENTS'), 'app_events');
  assert.throws(() => deliveryModeFromEnv('webhooks'));
});

test('changeIdFor: deterministic, time-prefixed, differs per target and per change', () => {
  const c = change();
  const id = changeIdFor(c, DEAL, '5');
  assert.match(id, new RegExp(`^${T0}-[0-9a-f]{10}$`));
  assert.equal(id, changeIdFor(change({ sourceKeys: ['k1', 'k2'] }), DEAL, '5'), 'key order does not matter');
  assert.notEqual(id, changeIdFor(c, CONTACT, '7'));
  assert.notEqual(id, changeIdFor(change({ sourceKeys: ['k3'] }), DEAL, '5'));
  assert.notEqual(id, changeIdFor(change({ portalId: 222 }), DEAL, '5'));
});

test('toChangeRecords: LABEL_CHANGED onto the from record, other side named', () => {
  const [r, ...rest] = toChangeRecords(change());
  assert.equal(rest.length, 0, 'no mirror by default');
  assert.equal(r.objectTypeId, DEAL);
  assert.equal(r.objectId, '5');
  assert.equal(r.otherObjectType, 'Contact');
  assert.equal(r.otherRecordId, '7');
  // Option values of the multi-checkbox label properties: `${otherObjectTypeId}:${label}`.
  assert.equal(r.labelBefore, '0-1:Influencer');
  assert.equal(r.labelAfter, '0-1:Decision maker');
  assert.equal(r.labelsCurrent, '0-1:Decision maker');
});

test('toChangeRecords: mirror swaps sides; custom object type id written as-is', () => {
  const recs = toChangeRecords(change({ fromObjectTypeId: SUB, fromObjectId: '9' }), { mirrorOnOtherRecord: true });
  assert.equal(recs.length, 2);
  assert.equal(recs[0].otherObjectType, 'Contact');
  assert.deepEqual([recs[1].objectTypeId, recs[1].objectId, recs[1].otherObjectType, recs[1].otherRecordId], [CONTACT, '7', SUB, '9']);
  assert.notEqual(recs[0].changeId, recs[1].changeId);
});

test('toChangeRecords: ADDED has (none) before; REMOVED has (none) after and current', () => {
  const [a] = toChangeRecords(change({ changeType: 'ADDED', labelBefore: undefined, labelAfter: ['X'], labelsCurrent: ['X'] }));
  assert.deepEqual([a.labelBefore, a.labelAfter, a.labelsCurrent], [NONE, '0-1:X', '0-1:X']);
  const [r] = toChangeRecords(change({ changeType: 'REMOVED', labelBefore: ['X', 'Y'], labelAfter: undefined, labelsCurrent: [] }));
  assert.deepEqual([r.labelBefore, r.labelAfter, r.labelsCurrent], ['0-1:X;0-1:Y', NONE, NONE]);
  const [u] = toChangeRecords(change({ labelBefore: undefined, labelAfter: ['Y'], labelsCurrent: undefined }));
  assert.deepEqual([u.labelBefore, u.labelAfter, u.labelsCurrent], [UNKNOWN, '0-1:Y', UNKNOWN], 'unknown state is not faked as (none)');
});

test('toChangeRecords: mirror record gets values keyed by the other side', () => {
  const [, m] = toChangeRecords(change(), { mirrorOnOtherRecord: true });
  assert.equal(m.objectTypeId, CONTACT);
  assert.equal(m.labelAfter, '0-3:Decision maker');
});

test('toStampUpdate: all 7 properties, every value a non-empty string', () => {
  const u = toStampUpdate(toChangeRecords(change())[0]);
  assert.equal(Object.keys(u.properties).length, 7);
  for (const v of Object.values(u.properties)) assert.ok(typeof v === 'string' && v.length > 0);
  assert.ok(!('changecatch_last_change_at' in u.properties), 'cut in D5');
  assert.equal(u.properties.changecatch_change_type, 'LABEL_CHANGED');
  assert.equal(u.occurredAtMs, T0);
});

// ---------- spacing ----------

const upd = (id: string, at: number, portalId = 111): StampUpdate => ({
  portalId,
  objectTypeId: DEAL,
  objectId: id,
  occurredAtMs: at,
  properties: { changecatch_last_change_id: `${at}-${id}` } as StampUpdate['properties'],
});

test('planStampWaves: distinct records go in one wave now', () => {
  const w = planStampWaves([upd('1', 1), upd('2', 2)], () => undefined, 1000, 3000);
  assert.equal(w.length, 1);
  assert.equal(w[0].notBefore, 1000);
});

test('planStampWaves: same record twice -> 2 waves, spaced, in occurredAt order', () => {
  const w = planStampWaves([upd('1', 50), upd('2', 1), upd('1', 10)], () => undefined, 1000, 3000);
  assert.equal(w.length, 2);
  assert.deepEqual(w[0].updates.map((u) => u.occurredAtMs), [1, 10]);
  assert.deepEqual(w[1].updates.map((u) => u.occurredAtMs), [50]);
  assert.equal(w[1].notBefore, 4000);
});

test('planStampWaves: respects the last stamp from an earlier call', () => {
  const last = new Map([[recordKey(upd('1', 0)), 900]]);
  const w = planStampWaves([upd('1', 5)], (k) => last.get(k), 1000, 3000);
  assert.equal(w[0].notBefore, 3900);
});

test('planStampWaves (C1): a busy record does not delay other records', () => {
  // Record A already has a queued tail 600 s out (folded into lastStampAt, as the old enqueue did).
  const busyKey = recordKey(upd('A', 0));
  const w = planStampWaves([upd('A', 1), upd('B', 2), upd('C', 3)], (k) => (k === busyKey ? 600_000 : undefined), 1000, 3000);
  assert.deepEqual(w.map((x) => [x.notBefore, x.updates.map((u) => u.objectId)]), [[1000, ['B', 'C']], [603_000, ['A']]]);
});

test('planStampSlots (C1): 200 changes on one record + 100 single changes elsewhere, fake clock', () => {
  const now = 10_000;
  const hot = Array.from({ length: 200 }, (_, i) => upd('hot', 5_000 - i)); // reversed input order
  const others = Array.from({ length: 100 }, (_, i) => upd(`o${i}`, 100 + i));
  const slots = planStampSlots([...hot, ...others], () => undefined, now, 3000);
  const other = slots.filter((s) => s.update.objectId !== 'hot');
  assert.equal(other.length, 100);
  assert.ok(other.every((s) => s.notBefore === now), 'other records are stamped now');
  const h = slots.filter((s) => s.update.objectId === 'hot');
  for (let i = 1; i < h.length; i++) {
    assert.ok(h[i].update.occurredAtMs > h[i - 1].update.occurredAtMs, 'per-record order kept');
    assert.equal(h[i].notBefore - h[i - 1].notBefore, 3000, 'spaced');
  }
  assert.equal(h[0].notBefore, now);
  const batches = planStampBatches(slots);
  assert.equal(batches[0].notBefore, now);
  assert.equal(batches[0].updates.length, 100, 'chunked to 100');
  assert.equal(batches[1].notBefore, now);
  assert.equal(batches[1].updates.length, 1);
  assert.ok(batches.slice(2).every((b) => b.updates.length === 1 && b.updates[0].objectId === 'hot'));
});

test('planStampBatches: same notBefore only, per (portal, objectType), one update per record', () => {
  const c = (id: string, at: number): StampUpdate => ({ ...upd(id, at), objectTypeId: CONTACT });
  const slots = [
    { notBefore: 5, update: upd('1', 1) },
    { notBefore: 5, update: c('1', 1) },
    { notBefore: 5, update: upd('2', 1, 222) },
    { notBefore: 5, update: upd('1', 2) }, // same record again at the same time (spacing 0) -> next batch
    { notBefore: 9, update: upd('3', 3) },
  ];
  const b = planStampBatches(slots);
  assert.deepEqual(
    b.map((x) => [x.notBefore, x.portalId, x.objectTypeId, x.updates.map((u) => `${u.objectId}@${u.occurredAtMs}`)]),
    [
      [5, 111, DEAL, ['1@1']],
      [5, 111, CONTACT, ['1@1']],
      [5, 222, DEAL, ['2@1']],
      [5, 111, DEAL, ['1@2']],
      [9, 111, DEAL, ['3@3']],
    ],
  );
});

// ---------- Stamper (HTTP faked) ----------

function fakeStamper(respond?: (objectType: string, ids: string[], call: number) => BatchUpdateResponse | Promise<BatchUpdateResponse>) {
  let now = T0;
  const calls: { objectType: string; ids: string[]; at: number; token: string }[] = [];
  const sleeps: number[] = [];
  const st = new Stamper({
    getToken: async (p, o) => `tok-${p}${o?.forceRefresh ? '-fresh' : ''}`,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    log: () => {},
    batchUpdate: async (token, objectType, inputs) => {
      calls.push({ objectType, ids: inputs.map((i) => i.id), at: now, token });
      return respond ? respond(objectType, inputs.map((i) => i.id), calls.length) : { status: 'COMPLETE', results: inputs.map((i) => ({ id: i.id })) };
    },
  });
  return { st, calls, sleeps, advance: (ms: number) => (now += ms) };
}

test('Stamper: chunks at 100 and spaces repeat stamps on one record by 3s', async () => {
  const f = fakeStamper();
  const many = Array.from({ length: 150 }, (_, i) => upd(String(i), i));
  const delivered: StampUpdate[] = [];
  const out = await f.st.send([...many, upd('0', 1000)], (d) => delivered.push(...d));
  assert.deepEqual(f.calls.map((c) => c.ids.length), [100, 50, 1]);
  assert.deepEqual(f.sleeps, [3000]);
  assert.equal(out.sent, 151);
  assert.equal(delivered.length, 151);
  // Record 0 was last stamped at T0+3000; a new call 1s later waits the remaining 2s.
  f.advance(1000);
  await f.st.send([upd('0', 2000)]);
  assert.deepEqual(f.sleeps, [3000, 2000]);
});

test('Stamper: 401 refreshes the token once; other 4xx drops; 5xx throws', async () => {
  const a = fakeStamper((_t, _ids, call) => {
    if (call === 1) throw new HttpError(401, {}, '401');
    return { status: 'COMPLETE', results: [{ id: '1' }] };
  });
  assert.equal((await a.st.send([upd('1', 1)])).sent, 1);
  assert.equal(a.calls[1].token, 'tok-111-fresh');

  const b = fakeStamper(() => {
    throw new HttpError(400, {}, 'PROPERTY_DOESNT_EXIST');
  });
  const ob = await b.st.send([upd('1', 1), upd('2', 2)]);
  assert.equal(ob.sent, 0);
  assert.equal(ob.dropped.length, 2);

  const c = fakeStamper(() => {
    throw new HttpError(503, {}, 'down');
  });
  await assert.rejects(c.st.send([upd('1', 1)]), /down/);
});

test('Stamper: per-record errors in a 2xx response drop only that record', async () => {
  const f = fakeStamper(() => ({ status: 'COMPLETE', results: [{ id: '1' }], numErrors: 1, errors: [{ category: 'OBJECT_NOT_FOUND', message: 'gone', context: { ids: ['2'] } }] }));
  const out = await f.st.send([upd('1', 1), upd('2', 2)]);
  assert.equal(out.sent, 1);
  assert.equal(out.dropped[0].update.objectId, '2');
  assert.match(out.dropped[0].reason, /OBJECT_NOT_FOUND/);
});

// ---------- store ----------

test('store: saveChanges is idempotent, getChange is scoped by portal, prune after 30 days', () => {
  const store = new Store(':memory:');
  const [r] = toChangeRecords(change());
  store.saveChanges([r], T0);
  store.saveChanges([{ ...r, labelAfter: 'changed' }], T0 + 1);
  const got = store.getChange(111, r.changeId);
  assert.equal(got?.labelAfter, '0-1:Decision maker', 'first write wins');
  assert.equal(got?.createdAt, T0);
  assert.equal(store.getChange(222, r.changeId), undefined, 'other portal cannot read it');
  assert.equal(store.pruneChangeLog(T0 + 29 * 86_400_000), 0);
  assert.equal(store.pruneChangeLog(T0 + 31 * 86_400_000), 1);
  assert.equal(store.getChange(111, r.changeId), undefined);
});

// ---------- poller in stamp mode ----------

const LABELS = [
  { associationTypeId: 3, label: null, category: 'HUBSPOT_DEFINED' },
  { associationTypeId: 101, label: 'Influencer', category: UD },
  { associationTypeId: 102, label: 'Decision maker', category: UD },
];

function stampSetup(files: JournalFile[], failCalls: number[] = []) {
  const store = new Store(':memory:');
  store.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
  // Wall clock just after the newest test event (40 s): it is still inside its pairing deadline, so it is held.
  const now = T0 + 41_000;
  const labels = new StoreLabelCache(store, async () => LABELS, undefined, () => now);
  const readJournal = async (after: string | null): Promise<JournalReadResult> => {
    const start = after === null ? 0 : files.findIndex((f) => f.offset === after) + 1;
    const batch = files.slice(start);
    return { files: batch, nextOffset: batch.at(-1)?.offset ?? null, full: false };
  };
  const stamped: StampUpdate[][] = [];
  const seenInLog: boolean[] = [];
  let call = 0;
  const deps = {
    readJournal,
    store,
    labels,
    now: () => now,
    sendStamps: async (updates: StampUpdate[], onDelivered: (d: StampUpdate[]) => void) => {
      call++;
      for (const u of updates) seenInLog.push(!!store.getChange(u.portalId, u.properties.changecatch_last_change_id!));
      if (failCalls.includes(call)) throw new Error('stamp failed (simulated 503)');
      stamped.push(updates);
      onDelivered(updates);
    },
  };
  return { store, deps, stamped, seenInLog };
}

test('runOnce (stamp): label swap stamps the deal, change_log saved before stamping', async () => {
  const s = stampSetup([
    file('f1', [ev({ action: ADD, typeId: 3, at: 0 }), ev({ action: ADD, typeId: 101, category: UD, at: 1 })]),
    file('f2', [ev({ action: REM, typeId: 101, category: UD, at: 20_000 }), ev({ action: ADD, typeId: 102, category: UD, at: 20_200 })]),
    file('f3', [ev({ action: ADD, typeId: 3, to: [CONTACT, 9], at: 40_000 })]),
  ]);
  const r = await runOnce(s.deps);
  const ups = s.stamped.flat();
  assert.equal(ups.length, 2);
  assert.equal(r.occurrencesSent, 2);
  assert.ok(s.seenInLog.every(Boolean), 'every change id was in change_log before the stamp');
  const last = ups[1];
  assert.equal(last.objectTypeId, DEAL);
  assert.equal(last.properties.changecatch_change_type, 'LABEL_CHANGED');
  assert.equal(last.properties.changecatch_label_before, '0-1:Influencer');
  assert.equal(last.properties.changecatch_label_after, '0-1:Decision maker');
  const logged = s.store.getChange(111, last.properties.changecatch_last_change_id!);
  assert.equal(logged?.otherRecordId, '2');
  assert.equal(s.store.getOffset(), 'f3');
});

test('runOnce (stamp): failed stamp keeps the offset; retry stamps once', async () => {
  const s = stampSetup([file('f1', [ev({ action: ADD, typeId: 3, at: 0 })]), file('f2', [ev({ action: ADD, typeId: 3, to: [CONTACT, 9], at: 40_000 })])], [1]);
  await assert.rejects(runOnce(s.deps), /stamp failed/);
  assert.equal(s.store.getOffset(), null);
  await runOnce(s.deps);
  await runOnce(s.deps);
  assert.equal(s.stamped.flat().length, 1, 'stamped exactly once');
  assert.equal(s.store.getOffset(), 'f2');
});
