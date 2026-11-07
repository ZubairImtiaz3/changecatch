import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NONE, UNKNOWN } from './contract.js';
import { changeIdFor, toChangeRecords, toStampUpdate } from './stamp.js';
import type { NormalizedChange } from './types.js';
import { CONTACT, DEAL, SUB, T0, UD } from '../../test/fixtures/journal.js';

function change(o: Partial<NormalizedChange> = {}): NormalizedChange {
  return {
    portalId: 111,
    changeType: 'LABEL_CHANGED',
    fromObjectTypeId: DEAL,
    fromObjectId: '5',
    toObjectTypeId: CONTACT,
    toObjectId: '7',
    // Label keys = association type ids (deal -> contact): 101 Influencer, 102 Decision maker.
    labelBefore: ['101'],
    labelAfter: ['102'],
    labelsCurrent: ['102'],
    associationCategory: UD,
    occurredAt: new Date(T0).toISOString(),
    sourceOffsets: ['f1'],
    sourceKeys: ['k2', 'k1'],
    ...o,
  };
}

// ---------- pure mapping ----------

test('changeIdFor: deterministic, time-prefixed, differs per target and per change', () => {
  const c = change();
  const id = changeIdFor(c, DEAL, '5');
  assert.match(id, new RegExp(`^${T0}-[0-9a-f]{10}$`));
  assert.equal(id, changeIdFor(change({ sourceKeys: ['k1', 'k2'] }), DEAL, '5'), 'key order does not matter');
  assert.notEqual(id, changeIdFor(c, CONTACT, '7'));
  assert.notEqual(id, changeIdFor(change({ sourceKeys: ['k3'] }), DEAL, '5'));
  assert.notEqual(id, changeIdFor(change({ portalId: 222 }), DEAL, '5'));
});

test('toChangeRecords: LABEL_CHANGED onto the from record; other object type = its type id', () => {
  const [r, ...rest] = toChangeRecords(change(), false);
  assert.equal(rest.length, 0, 'no mirror by default');
  assert.equal(r.objectTypeId, DEAL);
  assert.equal(r.objectId, '5');
  assert.equal(r.otherObjectType, CONTACT, 'changecatch_other_object_type stores the stable type id (option value)');
  assert.equal(r.otherRecordId, '7');
  // Option values of the multi-checkbox label properties: `${otherObjectTypeId}:${associationTypeId}`.
  assert.equal(r.labelBefore, '0-1:101');
  assert.equal(r.labelAfter, '0-1:102');
  assert.equal(r.labelsCurrent, '0-1:102');
});

test('toChangeRecords: mirror swaps sides; custom object type id written as-is', () => {
  const recs = toChangeRecords(change({ fromObjectTypeId: SUB, fromObjectId: '9' }), true);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].otherObjectType, CONTACT);
  assert.deepEqual([recs[1].objectTypeId, recs[1].objectId, recs[1].otherObjectType, recs[1].otherRecordId], [CONTACT, '7', SUB, '9']);
  assert.notEqual(recs[0].changeId, recs[1].changeId);
});

test('toChangeRecords: ADDED has none before; REMOVED has none after and current', () => {
  const [a] = toChangeRecords(change({ changeType: 'ADDED', labelBefore: undefined, labelAfter: ['201'], labelsCurrent: ['201'] }), false);
  assert.deepEqual([a.labelBefore, a.labelAfter, a.labelsCurrent], [NONE, '0-1:201', '0-1:201']);
  const [r] = toChangeRecords(change({ changeType: 'REMOVED', labelBefore: ['201', '202'], labelAfter: undefined, labelsCurrent: [] }), false);
  assert.deepEqual([r.labelBefore, r.labelAfter, r.labelsCurrent], ['0-1:201;0-1:202', NONE, NONE]);
  const [u] = toChangeRecords(change({ labelBefore: undefined, labelAfter: ['202'], labelsCurrent: undefined }), false);
  assert.deepEqual([u.labelBefore, u.labelAfter, u.labelsCurrent], [UNKNOWN, '0-1:202', UNKNOWN], 'unknown state is not faked as none');
  const [s] = toChangeRecords(change({ changeType: 'ADDED', labelBefore: undefined, labelAfter: ['unlabeled'], labelsCurrent: ['unlabeled'] }), false);
  assert.deepEqual([s.labelAfter, s.labelsCurrent], [NONE, NONE], 'the structural link is not a label');
});

test('toChangeRecords: mirror record uses the to -> from type ids (mirrorLabelKeys), keyed by the other side', () => {
  // contact -> deal ids for the same labels: 111 Influencer, 112 Decision maker.
  const [, m] = toChangeRecords(change({ mirrorLabelKeys: { '101': '111', '102': '112' } }), true);
  assert.equal(m.objectTypeId, CONTACT);
  assert.equal(m.otherObjectType, DEAL);
  assert.deepEqual([m.labelBefore, m.labelAfter, m.labelsCurrent], ['0-3:111', '0-3:112', '0-3:112']);
});

test('toChangeRecords: a mirror label with no translation (paired label) is "unknown", never the wrong direction id', () => {
  const [f, m] = toChangeRecords(change({ mirrorLabelKeys: { '101': '111' } }), true);
  assert.deepEqual([f.labelBefore, f.labelAfter], ['0-1:101', '0-1:102'], 'the from record is unaffected');
  assert.deepEqual([m.labelBefore, m.labelAfter, m.labelsCurrent], ['0-3:111', UNKNOWN, UNKNOWN]);
  const [, none] = toChangeRecords(change(), true);
  assert.deepEqual([none.labelBefore, none.labelAfter], [UNKNOWN, UNKNOWN], 'no translations at all -> unknown');
});

test('toStampUpdate: all 7 properties, every value a non-empty string', () => {
  const u = toStampUpdate(toChangeRecords(change(), false)[0]);
  assert.equal(Object.keys(u.properties).length, 7);
  for (const v of Object.values(u.properties)) assert.ok(typeof v === 'string' && v.length > 0);
  assert.ok(!('changecatch_last_change_at' in u.properties), 'cut in D5');
  assert.equal(u.properties.changecatch_change_type, 'LABEL_CHANGED');
  assert.equal(u.occurredAtMs, T0);
});
