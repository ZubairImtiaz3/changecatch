import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLabelOptions,
  formatLabelValues,
  labelOptionValue,
  mergeOptions,
  NONE,
  otherTypesFor,
  splitValues,
  UNKNOWN,
  type LabelSource,
} from './label-options.js';

const UD = 'USER_DEFINED';
const HD = 'HUBSPOT_DEFINED';

const SOURCES: LabelSource[] = [
  {
    otherObjectTypeId: '0-1',
    otherObjectName: 'Contact',
    labels: [
      { label: null, category: HD },
      { label: 'Influencer', category: UD },
      { label: 'Billing contact', category: UD },
      { label: 'Influencer', category: UD }, // same label from the other direction
    ],
  },
  {
    otherObjectTypeId: '0-2',
    otherObjectName: 'Company',
    labels: [
      { label: 'Primary', category: HD },
      { label: 'Billing contact', category: UD },
    ],
  },
];

test('buildLabelOptions: fixed options first, one option per (other type, label), nulls skipped, sorted', () => {
  const opts = buildLabelOptions(SOURCES);
  assert.deepEqual(
    opts.map((o) => [o.value, o.label]),
    [
      [NONE, NONE],
      [UNKNOWN, UNKNOWN],
      ['0-2:Billing contact', 'Billing contact (Company)'],
      ['0-2:Primary', 'Primary (Company)'],
      ['0-1:Billing contact', 'Billing contact (Contact)'],
      ['0-1:Influencer', 'Influencer (Contact)'],
    ],
  );
  assert.deepEqual(opts.map((o) => o.displayOrder), [0, 1, 2, 3, 4, 5]);
  assert.ok(opts.every((o) => o.hidden === false));
  assert.equal(new Set(opts.map((o) => o.label)).size, opts.length, 'labels are unique too');
});

test('formatLabelValues: values match option values exactly, ";"-joined, sorted, deduped', () => {
  const opts = new Set(buildLabelOptions(SOURCES).map((o) => o.value));
  const v = formatLabelValues(['Influencer', 'Billing contact', 'Influencer'], '0-1');
  assert.equal(v, '0-1:Billing contact;0-1:Influencer');
  assert.ok(splitValues(v).every((x) => opts.has(x)), 'every value is an option');
  assert.equal(formatLabelValues(['Billing contact'], '0-2'), '0-2:Billing contact');
});

test('formatLabelValues: (none), (unknown), Unlabeled and unresolved type ids', () => {
  assert.equal(formatLabelValues([], '0-1'), NONE);
  assert.equal(formatLabelValues(['  ', 'Unlabeled'], '0-1'), NONE);
  assert.equal(formatLabelValues(undefined, '0-1'), UNKNOWN);
  assert.equal(formatLabelValues(undefined, '0-1', NONE), NONE);
  assert.equal(formatLabelValues(['type 123', 'Influencer'], '0-1'), '(unknown);0-1:Influencer');
});

test('a ";" inside a label cannot split the value', () => {
  assert.equal(labelOptionValue('0-1', ' A;B '), '0-1:A,B');
  assert.equal(formatLabelValues(['A;B'], '0-1'), '0-1:A,B');
  const [, , o] = buildLabelOptions([{ otherObjectTypeId: '0-1', otherObjectName: 'Contact', labels: [{ label: 'A;B', category: UD }] }]);
  assert.equal(o.value, '0-1:A,B');
});

test('splitValues', () => {
  assert.deepEqual(splitValues('a;b;'), ['a', 'b']);
  assert.deepEqual(splitValues(';a'), ['a']);
  assert.deepEqual(splitValues(null), []);
});

test('mergeOptions: keeps existing (even unknown ones), appends missing, unhides, no-op when equal', () => {
  const desired = buildLabelOptions(SOURCES);
  const existing = [
    { label: NONE, value: NONE, displayOrder: 0, hidden: false },
    { label: 'Old name (Contact)', value: '0-1:Old name', displayOrder: 7, hidden: false },
    { label: 'Influencer (Contact)', value: '0-1:Influencer', displayOrder: 8, hidden: true },
  ];
  const m = mergeOptions(existing, desired);
  assert.ok(m.changed);
  assert.deepEqual(m.unhidden, ['0-1:Influencer']);
  assert.deepEqual(m.added, [UNKNOWN, '0-2:Billing contact', '0-2:Primary', '0-1:Billing contact']);
  assert.ok(m.options.some((o) => o.value === '0-1:Old name'), 'never removes');
  assert.deepEqual(m.options.slice(3).map((o) => o.displayOrder), [9, 10, 11, 12]);
  const again = mergeOptions(m.options, desired);
  assert.equal(again.changed, false);
  assert.equal(again.options.length, m.options.length);
});

test('otherTypesFor: both sides of watched pairs', () => {
  const pairs = [
    { objectTypeId: '0-3', associatedObjectTypeId: '0-1' },
    { objectTypeId: '2-9', associatedObjectTypeId: '0-1' },
    { objectTypeId: '0-3', associatedObjectTypeId: '0-2' },
  ];
  assert.deepEqual(otherTypesFor('0-1', pairs), ['0-3', '2-9']);
  assert.deepEqual(otherTypesFor('0-3', pairs), ['0-1', '0-2']);
  assert.deepEqual(otherTypesFor('0-5', pairs), []);
});
