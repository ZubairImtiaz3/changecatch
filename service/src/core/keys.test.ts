// Pins every stored key format byte for byte: existing rows (association_labels, emitted_actions, stamp_queue,
// stamp_last, label_holds, seen_events) must keep matching without a data migration. Portal key ranges: store.test.ts purgePortal.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SENT_PREFIX, STAMP_PREFIX, actionKey, labelPairKey, pairKey, recordKey,
} from './keys.js';

test('keys: stored formats are byte-identical to the shipped ones', () => {
  assert.equal(pairKey(111, '0-3', 5, '0-1', '7'), '111|0-1:7|0-3:5');
  assert.equal(pairKey(111, '0-1', '7', '0-3', 5), '111|0-1:7|0-3:5', 'direction-insensitive');
  assert.equal(actionKey('111|0-1:7|0-3:5', 1730000000000), '111|0-1:7|0-3:5|1730000000000');
  assert.equal(recordKey({ portalId: 111, objectTypeId: '0-3', objectId: '5' }), '111|0-3|5');
  assert.equal(labelPairKey(111, '0-3', '0-1'), '111|0-3|0-1');
  assert.equal(labelPairKey(111, '0-3', '0-1', 279), '111|0-3|0-1|279');
  assert.equal(STAMP_PREFIX, 'stamp:');
  assert.equal(SENT_PREFIX, 'stamp-sent:');
});
