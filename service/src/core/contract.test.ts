// Frozen HubSpot-facing contract (D7). Every internal name and option VALUE below is referenced by customers'
// workflows once installed: HubSpot can't rename a property, and a changed option value breaks filters.
// This test pins them byte-for-byte. If it fails, you are changing a live contract: don't, unless it is a
// display-only text (label/description) and you mean it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildObjectTypeOptions,
  CHANGE_TYPE_OPTIONS,
  CHANGECATCH_PROPERTIES,
  FIXED_OPTIONS,
  GROUP_LABEL,
  GROUP_NAME,
  isCustomObjectType,
  NONE,
  scopesFor,
  STAMP_PROPS,
  STANDARD_OBJECT_NAMES,
  STANDARD_OBJECTS,
  STANDARD_OTHER_TYPES,
  UNKNOWN,
} from './contract.js';
import { formatLabelValues, labelOptionValue, MULTI_SEPARATOR } from './label-options.js';

const same = (actual: unknown, expected: unknown) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));

test('contract: the 7 property internal names', () => {
  same(STAMP_PROPS, {
    changeId: 'changecatch_last_change_id',
    changeType: 'changecatch_change_type',
    otherObjectType: 'changecatch_other_object_type',
    otherRecordId: 'changecatch_other_record_id',
    labelBefore: 'changecatch_labels_before',
    labelAfter: 'changecatch_labels_after',
    labelsCurrent: 'changecatch_labels_current',
  });
});

test('contract: property group', () => {
  same([GROUP_NAME, GROUP_LABEL], ['changecatch', 'ChangeCatch']);
});

test('contract: property definitions as created in HubSpot (names, labels, descriptions, types, options)', () => {
  same(CHANGECATCH_PROPERTIES, EXPECTED_PROPERTIES);
});

test('contract: change_type, none/unknown option values + labels', () => {
  same(CHANGE_TYPE_OPTIONS, [
    { label: 'Added', value: 'ADDED', displayOrder: 0, hidden: false },
    { label: 'Removed', value: 'REMOVED', displayOrder: 1, hidden: false },
    { label: 'Label changed', value: 'LABEL_CHANGED', displayOrder: 2, hidden: false },
  ]);
  same([NONE, UNKNOWN, MULTI_SEPARATOR], ['none', 'unknown', ';']);
  same(FIXED_OPTIONS, [
    { label: '(none)', value: 'none', displayOrder: 0, hidden: false },
    { label: '(unknown)', value: 'unknown', displayOrder: 1, hidden: false },
  ]);
});

test('contract: label option value format `${otherTypeId}:${typeId}`', () => {
  same(labelOptionValue('0-1', 279), '0-1:279');
  same(labelOptionValue('2-123', '5'), '2-123:5');
  same(formatLabelValues(['281', '279'], '0-1'), '0-1:279;0-1:281');
});

test('contract: other_object_type option values (standard set incl. 0-5 Ticket, custom = its type id)', () => {
  same(STANDARD_OTHER_TYPES, ['0-1', '0-2', '0-3', '0-5']);
  same(
    buildObjectTypeOptions([...STANDARD_OTHER_TYPES, '2-77'], { ...STANDARD_OBJECT_NAMES, '2-77': 'Car' }).map((o) => [o.value, o.label]),
    [['2-77', 'Car'], ['0-2', 'Company'], ['0-1', 'Contact'], ['0-3', 'Deal'], ['0-5', 'Ticket']],
  );
});

test('contract: schema write scope per object type; tickets are unsupported (no scope, never a made-up one)', () => {
  same(['0-1', '0-2', '0-3', '2-77', '0-5'].map((t) => scopesFor(t).schemaWrite), [
    'crm.schemas.contacts.write',
    'crm.schemas.companies.write',
    'crm.schemas.deals.write',
    'crm.schemas.custom.write',
    undefined,
  ]);
  same(STANDARD_OBJECTS.filter((o) => o.supported).map((o) => o.objectTypeId), ['0-1', '0-2', '0-3']);
});

test('contract: custom object type ids are 2-xxx', () => {
  same(['2-77', '0-3', '0-5'].map(isCustomObjectType), [true, false, false]);
});

const EXPECTED_PROPERTIES = [
  {
    "name": "changecatch_last_change_id",
    "label": "ChangeCatch: last change ID",
    "description": "Set by ChangeCatch. Gets a new value on every association change. Use \"Property value changed\" on this property as the workflow trigger.",
    "type": "string",
    "fieldType": "text",
    "groupName": "changecatch",
    "displayOrder": 1,
    "formField": false
  },
  {
    "name": "changecatch_change_type",
    "label": "ChangeCatch: change type",
    "description": "Set by ChangeCatch. Added, Removed or Label changed.",
    "type": "enumeration",
    "fieldType": "select",
    "groupName": "changecatch",
    "displayOrder": 2,
    "formField": false,
    "options": [
      {
        "label": "Added",
        "value": "ADDED",
        "displayOrder": 0,
        "hidden": false
      },
      {
        "label": "Removed",
        "value": "REMOVED",
        "displayOrder": 1,
        "hidden": false
      },
      {
        "label": "Label changed",
        "value": "LABEL_CHANGED",
        "displayOrder": 2,
        "hidden": false
      }
    ]
  },
  {
    "name": "changecatch_other_object_type",
    "label": "ChangeCatch: other object type",
    "description": "Set by ChangeCatch. The type of the record on the other side of the association.",
    "type": "enumeration",
    "fieldType": "select",
    "groupName": "changecatch",
    "displayOrder": 3,
    "formField": false,
    "options": [
      {
        "label": "Company",
        "value": "0-2",
        "displayOrder": 0,
        "hidden": false
      },
      {
        "label": "Contact",
        "value": "0-1",
        "displayOrder": 1,
        "hidden": false
      },
      {
        "label": "Deal",
        "value": "0-3",
        "displayOrder": 2,
        "hidden": false
      },
      {
        "label": "Ticket",
        "value": "0-5",
        "displayOrder": 3,
        "hidden": false
      }
    ]
  },
  {
    "name": "changecatch_other_record_id",
    "label": "ChangeCatch: other record ID",
    "description": "Set by ChangeCatch. The ID of the record on the other side of the association.",
    "type": "string",
    "fieldType": "text",
    "groupName": "changecatch",
    "displayOrder": 4,
    "formField": false
  },
  {
    "name": "changecatch_labels_before",
    "label": "ChangeCatch: labels before",
    "description": "Set by ChangeCatch. Labels before the change. \"(none)\" if there were none, \"(unknown)\" if ChangeCatch could not tell. Pick labels from the list. \"Billing contact (Contact)\" = the \"Billing contact\" label toward a contact.",
    "type": "enumeration",
    "fieldType": "checkbox",
    "groupName": "changecatch",
    "displayOrder": 5,
    "formField": false,
    "options": [
      {
        "label": "(none)",
        "value": "none",
        "displayOrder": 0,
        "hidden": false
      },
      {
        "label": "(unknown)",
        "value": "unknown",
        "displayOrder": 1,
        "hidden": false
      }
    ]
  },
  {
    "name": "changecatch_labels_after",
    "label": "ChangeCatch: labels after",
    "description": "Set by ChangeCatch. Labels after the change. \"(none)\" if there are none, \"(unknown)\" if ChangeCatch could not tell. Pick labels from the list. \"Billing contact (Contact)\" = the \"Billing contact\" label toward a contact.",
    "type": "enumeration",
    "fieldType": "checkbox",
    "groupName": "changecatch",
    "displayOrder": 6,
    "formField": false,
    "options": [
      {
        "label": "(none)",
        "value": "none",
        "displayOrder": 0,
        "hidden": false
      },
      {
        "label": "(unknown)",
        "value": "unknown",
        "displayOrder": 1,
        "hidden": false
      }
    ]
  },
  {
    "name": "changecatch_labels_current",
    "label": "ChangeCatch: current labels",
    "description": "Set by ChangeCatch. All labels on the association now. \"(none)\" if there are none. Pick labels from the list. \"Billing contact (Contact)\" = the \"Billing contact\" label toward a contact.",
    "type": "enumeration",
    "fieldType": "checkbox",
    "groupName": "changecatch",
    "displayOrder": 7,
    "formField": false,
    "options": [
      {
        "label": "(none)",
        "value": "none",
        "displayOrder": 0,
        "hidden": false
      },
      {
        "label": "(unknown)",
        "value": "unknown",
        "displayOrder": 1,
        "hidden": false
      }
    ]
  }
];
