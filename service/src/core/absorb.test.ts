// Pure decision table for late-half absorption (planLateHalf). The real-data replays live in test/replay/absorb.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLateHalf } from './absorb.js';
import { CONTACT, T0 } from './testutil.js';

const PORTAL = 1000001;

test('planLateHalf decision table', () => {
  const E = (changeType: 'ADDED' | 'REMOVED' | 'LABEL_CHANGED', o: Partial<{ before: string[]; after: string[]; removed: string[]; added: string[] }> = {}) => ({
    actionKey: 'k', recordKey: 'r', portalId: PORTAL, changeId: 'c', changeType, otherTypeId: CONTACT,
    labelsBefore: o.before, labelsAfter: o.after, removed: o.removed ?? [], added: o.added ?? [], occurredAtMs: T0,
  });
  // Unlink, structural first: late label REMOVED is absorbed.
  assert.deepEqual(planLateHalf(E('REMOVED', { before: ['Billing contact'], after: [] }), 0, ['Billing contact'], []), { kind: 'absorb' });
  // Link, structural first: late label ADDED amends.
  assert.deepEqual(planLateHalf(E('ADDED', { before: [], after: [] }), 0, [], ['Influencer']), {
    kind: 'amend', type: 'ADDED', before: [], after: ['Influencer'], current: ['Influencer'], removed: [], added: ['Influencer'],
  });
  // Unlink, label first: late REMOVED 3 converts to REMOVED with the labels from before.
  assert.deepEqual(planLateHalf(E('LABEL_CHANGED', { before: ['Billing contact'], after: [], removed: ['Billing contact'] }), -1, [], []), {
    kind: 'convert', type: 'REMOVED', before: ['Billing contact'], after: [], current: [], removed: ['Billing contact'], added: [],
  });
  // Link, label first: late ADDED 3 converts to ADDED.
  assert.equal(planLateHalf(E('LABEL_CHANGED', { added: ['Influencer'] }), 1, [], [])?.kind, 'convert');
  // Not a late half of the same action: a re-link after an unlink, or a label swap after a link.
  assert.equal(planLateHalf(E('REMOVED'), 1, [], ['Influencer']), null);
  assert.equal(planLateHalf(E('ADDED', { after: ['Influencer'] }), 0, ['Influencer'], ['Decision maker']), null);
});
