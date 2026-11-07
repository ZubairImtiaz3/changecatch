import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLabelOptions,
  buildObjectTypeOptions,
  formatLabelValues,
  labelOptionValue,
  mergeOptions,
  NONE,
  otherTypesFor,
  splitValues,
  UNKNOWN,
  UNLABELED_KEY,
  type LabelSource,
} from './label-options.js';

const UD = 'USER_DEFINED';
const HD = 'HUBSPOT_DEFINED';

// Label definitions in the direction stamped object (a deal) -> other object. typeIds are that direction's ids.
const SOURCES: LabelSource[] = [
  {
    otherObjectTypeId: '0-1',
    otherObjectName: 'Contact',
    labels: [
      { typeId: 3, label: null, category: HD },
      { typeId: 279, label: 'Influencer', category: UD },
      { typeId: 281, label: 'Billing contact', category: UD },
      { typeId: 279, label: 'Influencer', category: UD }, // duplicate definition: one option
    ],
  },
  {
    otherObjectTypeId: '0-2',
    otherObjectName: 'Company',
    labels: [
      { typeId: 5, label: 'Primary', category: HD },
      { typeId: 341, label: 'Billing contact', category: UD },
    ],
  },
];

test('buildLabelOptions: fixed options first, one option per (other type, type id), nulls skipped, sorted by name', () => {
  const opts = buildLabelOptions(SOURCES);
  assert.deepEqual(
    opts.map((o) => [o.value, o.label]),
    [
      [NONE, '(none)'],
      [UNKNOWN, '(unknown)'],
      ['0-2:341', 'Billing contact (Company)'],
      ['0-2:5', 'Primary (Company)'],
      ['0-1:281', 'Billing contact (Contact)'],
      ['0-1:279', 'Influencer (Contact)'],
    ],
  );
  assert.deepEqual(opts.map((o) => o.displayOrder), [0, 1, 2, 3, 4, 5]);
  assert.ok(opts.every((o) => o.hidden === false));
  assert.equal(new Set(opts.map((o) => o.label)).size, opts.length, 'labels are unique too');
});

test('formatLabelValues: type-id keys -> option values exactly, ";"-joined, sorted, deduped', () => {
  const opts = new Set(buildLabelOptions(SOURCES).map((o) => o.value));
  const v = formatLabelValues(['279', '281', '279'], '0-1');
  assert.equal(v, '0-1:279;0-1:281');
  assert.ok(splitValues(v).every((x) => opts.has(x)), 'every value is an option');
  assert.equal(formatLabelValues(['341'], '0-2'), '0-2:341');
  assert.equal(labelOptionValue('0-1', 279), '0-1:279');
});

test('formatLabelValues: none, unknown, the unlabeled key and unresolved type ids', () => {
  assert.equal(formatLabelValues([], '0-1'), NONE);
  assert.equal(formatLabelValues(['  ', UNLABELED_KEY], '0-1'), NONE);
  assert.equal(formatLabelValues(undefined, '0-1'), UNKNOWN);
  assert.equal(formatLabelValues(undefined, '0-1', NONE), NONE);
  assert.equal(formatLabelValues(['type 123', '279'], '0-1'), '0-1:279;unknown');
  assert.equal(formatLabelValues(['type ?'], '0-1'), UNKNOWN, 'an untranslated mirror key is unknown, never a wrong label');
  assert.equal(formatLabelValues(['Influencer'], '0-1'), UNKNOWN, 'a name (old format) is never written as a value');
});

test('label names with ";" or odd spacing only affect the display text, never the value', () => {
  const [, , o] = buildLabelOptions([
    { otherObjectTypeId: '0-1', otherObjectName: 'Contact', labels: [{ typeId: 9, label: '  A;B   c ', category: UD }] },
  ]);
  assert.equal(o.value, '0-1:9');
  assert.equal(o.label, 'A;B c (Contact)');
});

test('splitValues', () => {
  assert.deepEqual(splitValues('a;b;'), ['a', 'b']);
  assert.deepEqual(splitValues(';a'), ['a']);
  assert.deepEqual(splitValues(null), []);
});

test('mergeOptions: keeps existing (even unknown ones), appends missing, unhides, no-op when equal', () => {
  const desired = buildLabelOptions(SOURCES);
  const existing = [
    { label: '(none)', value: NONE, displayOrder: 0, hidden: false },
    { label: 'Deleted label (Contact)', value: '0-1:999', displayOrder: 7, hidden: false },
    { label: 'Influencer (Contact)', value: '0-1:279', displayOrder: 8, hidden: true },
  ];
  const m = mergeOptions(existing, desired);
  assert.ok(m.changed);
  assert.deepEqual(m.unhidden, ['0-1:279']);
  assert.deepEqual(m.relabelled, []);
  assert.deepEqual(m.added, [UNKNOWN, '0-2:341', '0-2:5', '0-1:281']);
  assert.ok(m.options.some((o) => o.value === '0-1:999'), 'never removes');
  assert.deepEqual(m.options.slice(3).map((o) => o.displayOrder), [9, 10, 11, 12]);
  const again = mergeOptions(m.options, desired);
  assert.equal(again.changed, false);
  assert.equal(again.options.length, m.options.length);
});

test('mergeOptions: a label renamed in HubSpot keeps its value (workflow filters keep matching), only the text changes', () => {
  const existing = [
    { label: '(none)', value: NONE, displayOrder: 0, hidden: false },
    { label: '(unknown)', value: UNKNOWN, displayOrder: 1, hidden: false },
    { label: 'Decision maker (Contact)', value: '0-1:279', displayOrder: 2, hidden: false },
  ];
  const renamed = buildLabelOptions([
    { otherObjectTypeId: '0-1', otherObjectName: 'Contact', labels: [{ typeId: 279, label: 'Buyer', category: UD }] },
  ]);
  const m = mergeOptions(existing, renamed);
  assert.ok(m.changed);
  assert.deepEqual(m.relabelled, ['0-1:279']);
  assert.deepEqual(m.added, []);
  assert.equal(m.options.length, 3, 'no new option for a rename');
  const o = m.options.find((x) => x.value === '0-1:279')!;
  assert.equal(o.label, 'Buyer (Contact)');
  assert.equal(o.displayOrder, 2, 'position kept');
  assert.equal(mergeOptions(m.options, renamed).changed, false);
});

test('buildObjectTypeOptions: value = type id, label = name, sorted by name, deduped, unknown names fall back to the id', () => {
  const opts = buildObjectTypeOptions(['0-3', '0-1', '2-77', '0-1'], { '0-1': 'Contact', '0-3': 'Deal', '2-77': 'Car' });
  assert.deepEqual(
    opts.map((o) => [o.value, o.label, o.displayOrder]),
    [
      ['2-77', 'Car', 0],
      ['0-1', 'Contact', 1],
      ['0-3', 'Deal', 2],
    ],
  );
  assert.deepEqual(buildObjectTypeOptions(['2-5'], {}).map((o) => [o.value, o.label]), [['2-5', '2-5']]);
});

test('mergeOptions: a custom object renamed keeps its other_object_type value', () => {
  const before = buildObjectTypeOptions(['0-1', '2-77'], { '0-1': 'Contact', '2-77': 'Car' });
  const after = buildObjectTypeOptions(['0-1', '2-77'], { '0-1': 'Contact', '2-77': 'Vehicle' });
  const m = mergeOptions(before, after);
  assert.deepEqual(m.relabelled, ['2-77']);
  assert.deepEqual(m.added, []);
  assert.equal(m.options.find((o) => o.value === '2-77')!.label, 'Vehicle');
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
