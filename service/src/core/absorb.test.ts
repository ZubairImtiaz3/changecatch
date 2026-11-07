// Pure decision table for late-half absorption (planLateHalf). The real-data replays live in test/replay/absorb.test.ts.
// Labels are keys as the pipeline carries them: type ids (Deal->Contact 247 Decision maker, 249 Influencer, 251 Billing contact).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLateHalf } from './absorb.js';
import { CONTACT, T0 } from '../../test/fixtures/journal.js';

const PORTAL = 1000001;

test('planLateHalf decision table', () => {
  const E = (changeType: 'ADDED' | 'REMOVED' | 'LABEL_CHANGED', o: Partial<{ before: string[]; after: string[]; removed: string[]; added: string[] }> = {}) => ({
    actionKey: 'k', recordKey: 'r', portalId: PORTAL, changeId: 'c', changeType, otherTypeId: CONTACT,
    labelsBefore: o.before, labelsAfter: o.after, removed: o.removed ?? [], added: o.added ?? [], occurredAtMs: T0,
  });
  // Unlink, structural first: late label REMOVED is absorbed.
  assert.deepEqual(planLateHalf(E('REMOVED', { before: ['251'], after: [] }), 0, ['251'], []), { kind: 'absorb' });
  // Link, structural first: late label ADDED amends.
  assert.deepEqual(planLateHalf(E('ADDED', { before: [], after: [] }), 0, [], ['249']), {
    kind: 'amend', type: 'ADDED', before: [], after: ['249'], current: ['249'], removed: [], added: ['249'],
  });
  // Unlink, label first: late REMOVED 3 converts to REMOVED with the labels from before.
  assert.deepEqual(planLateHalf(E('LABEL_CHANGED', { before: ['251'], after: [], removed: ['251'] }), -1, [], []), {
    kind: 'convert', type: 'REMOVED', before: ['251'], after: [], current: [], removed: ['251'], added: [],
  });
  // Link, label first: late ADDED 3 converts to ADDED.
  assert.equal(planLateHalf(E('LABEL_CHANGED', { added: ['249'] }), 1, [], [])?.kind, 'convert');
  // Not a late half of the same action: a re-link after an unlink, or a label swap after a link.
  assert.equal(planLateHalf(E('REMOVED'), 1, [], ['249']), null);
  assert.equal(planLateHalf(E('ADDED', { after: ['249'] }), 0, ['249'], ['247']), null);
});
