// The HubSpot-facing contract: the ChangeCatch property group + 7 properties created in every customer portal, and
// the object types ChangeCatch knows. ONE owner for these facts; everything else imports them.
//
// FROZEN once customers install (D7, naming review 2026-11-07, docs/decisions.md): internal names (`changecatch_` +
// snake_case) and option VALUES. HubSpot can't rename a property and customers' workflows reference both.
// Labels ("ChangeCatch: ..." in sentence case), descriptions and option labels are display text and may change.
// Pinned byte-for-byte by contract.test.ts.
//
// Property types (guide, checked 2026-10-30): https://developers.hubspot.com/docs/api-reference/latest/crm/properties/guide.md
// Pure: no HTTP. The HubSpot client is src/hubspot/properties.ts.

export const STAMP_PROPS = {
  changeId: 'changecatch_last_change_id',
  changeType: 'changecatch_change_type',
  otherObjectType: 'changecatch_other_object_type',
  otherRecordId: 'changecatch_other_record_id',
  labelBefore: 'changecatch_labels_before',
  labelAfter: 'changecatch_labels_after',
  labelsCurrent: 'changecatch_labels_current',
} as const;

export type StampPropertyName = (typeof STAMP_PROPS)[keyof typeof STAMP_PROPS];

export const GROUP_NAME = 'changecatch';
export const GROUP_LABEL = 'ChangeCatch';

export interface PropertyOption {
  label: string;
  value: string;
  displayOrder: number;
  hidden: boolean;
}

/** Written instead of "" so workflow filters ("is any of (none)") work. Shown as "(none)". */
export const NONE = 'none';
/** Written when we genuinely don't know (e.g. a label edit on a pair we never saw being created). Shown as "(unknown)". */
export const UNKNOWN = 'unknown';

/** The fixed options of the 3 label properties; label options (`${otherTypeId}:${typeId}`, label-options.ts) are added by the sync. */
export const FIXED_OPTIONS: PropertyOption[] = [
  { label: '(none)', value: NONE, displayOrder: 0, hidden: false },
  { label: '(unknown)', value: UNKNOWN, displayOrder: 1, hidden: false },
];

export const CHANGE_TYPE_OPTIONS: PropertyOption[] = [
  { label: 'Added', value: 'ADDED', displayOrder: 0, hidden: false },
  { label: 'Removed', value: 'REMOVED', displayOrder: 1, hidden: false },
  { label: 'Label changed', value: 'LABEL_CHANGED', displayOrder: 2, hidden: false },
];

// ---------- object types ----------

export interface StandardObject {
  objectTypeId: string;
  singular: string;
  plural: string;
  /** Pair orientation (pairs.ts): lower rank = the side we subscribe on. Custom objects rank 0. */
  rank: number;
  /** The app has scopes for it: watchable in settings, properties can be created and records stamped. */
  supported: boolean;
  readScope?: string;
  writeScope?: string;
  schemaWriteScope?: string;
}

/**
 * Standard objects. Ticket (0-5) is NOT supported (the app has no ticket scopes), but "0-5" stays an option value of
 * changecatch_other_object_type: it was created that way in installed portals and option values are frozen.
 * The scopes here are the app's required scopes (install/scopes.ts builds APP_SCOPES from them).
 */
export const STANDARD_OBJECTS: readonly StandardObject[] = [
  {
    objectTypeId: '0-1', singular: 'Contact', plural: 'Contacts', rank: 4, supported: true,
    readScope: 'crm.objects.contacts.read', writeScope: 'crm.objects.contacts.write', schemaWriteScope: 'crm.schemas.contacts.write',
  },
  {
    objectTypeId: '0-2', singular: 'Company', plural: 'Companies', rank: 3, supported: true,
    readScope: 'crm.objects.companies.read', writeScope: 'crm.objects.companies.write', schemaWriteScope: 'crm.schemas.companies.write',
  },
  {
    objectTypeId: '0-3', singular: 'Deal', plural: 'Deals', rank: 1, supported: true,
    readScope: 'crm.objects.deals.read', writeScope: 'crm.objects.deals.write', schemaWriteScope: 'crm.schemas.deals.write',
  },
  { objectTypeId: '0-5', singular: 'Ticket', plural: 'Tickets', rank: 2, supported: false },
];

/** Custom-object scopes: read is optional, write is conditionally required (decision D3, install/scopes.ts). */
export const CUSTOM_OBJECT_SCOPES = {
  objectRead: 'crm.objects.custom.read',
  schemaRead: 'crm.schemas.custom.read',
  objectWrite: 'crm.objects.custom.write',
  schemaWrite: 'crm.schemas.custom.write',
} as const;

export const isCustomObjectType = (objectTypeId: string): boolean => objectTypeId.startsWith('2-');

export const standardObject = (objectTypeId: string): StandardObject | undefined =>
  STANDARD_OBJECTS.find((o) => o.objectTypeId === objectTypeId);

/** Scopes needed for one object type; undefined fields = the app has no such scope (e.g. tickets). */
export function scopesFor(objectTypeId: string): { read?: string; write?: string; schemaWrite?: string } {
  if (isCustomObjectType(objectTypeId)) {
    const c = CUSTOM_OBJECT_SCOPES;
    return { read: c.schemaRead, write: c.objectWrite, schemaWrite: c.schemaWrite };
  }
  const o = standardObject(objectTypeId);
  return { read: o?.readScope, write: o?.writeScope, schemaWrite: o?.schemaWriteScope };
}

/** Display names of the standard objects (custom names come from HubSpot: hubspot/object-types.ts). */
export const STANDARD_OBJECT_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  STANDARD_OBJECTS.map((o) => [o.objectTypeId, o.singular]),
);

// ---------- property definitions ----------

export interface PropertyDefinition {
  name: string;
  label: string;
  description: string;
  type: 'string' | 'datetime' | 'enumeration' | 'number';
  fieldType: 'text' | 'date' | 'select' | 'checkbox' | 'number';
  groupName: string;
  displayOrder: number;
  formField: boolean;
  options?: PropertyOption[];
}

/** changecatch_other_object_type options: value = object type id (stable), label = its display name. */
export function buildObjectTypeOptions(otherTypeIds: string[], names: Record<string, string>): PropertyOption[] {
  return [...new Set(otherTypeIds)]
    .sort((a, b) => (names[a] ?? a).localeCompare(names[b] ?? b))
    .map((id, i) => ({ label: names[id] ?? id, value: id, displayOrder: i, hidden: false }));
}

/** Option values of changecatch_other_object_type that every portal gets; custom types are added by the sync. */
export const STANDARD_OTHER_TYPES: string[] = STANDARD_OBJECTS.map((o) => o.objectTypeId);

const prop = (
  name: string,
  label: string,
  description: string,
  type: 'string' | 'enumeration',
  displayOrder: number,
  options?: PropertyOption[],
  fieldType?: PropertyDefinition['fieldType'],
): PropertyDefinition => ({
  name,
  label,
  description,
  type,
  fieldType: fieldType ?? (type === 'string' ? 'text' : 'select'),
  groupName: GROUP_NAME,
  displayOrder,
  formField: false,
  ...(options ? { options: options.map((o) => ({ ...o })) } : {}),
});

/**
 * The 3 label properties are "multiple checkboxes" (enumeration + checkbox): several labels can change at once,
 * values are ";"-separated, and workflow filters can match "is any of" / "is all of" the options.
 */
export const LABEL_PROPERTY_NAMES: string[] = [STAMP_PROPS.labelBefore, STAMP_PROPS.labelAfter, STAMP_PROPS.labelsCurrent];
const LABEL_HELP = 'Pick labels from the list. "Billing contact (Contact)" = the "Billing contact" label toward a contact.';

/** Properties whose options the sync keeps up to date (label + type dropdowns). */
export const SYNCED_ENUM_PROPERTY_NAMES: string[] = [STAMP_PROPS.changeType, STAMP_PROPS.otherObjectType, ...LABEL_PROPERTY_NAMES];

/**
 * The 7 ChangeCatch properties, the same set on every object type (decision D5, 2026-10-30: trimmed from 9). Earlier
 * builds created other names (changecatch_last_change_at, changecatch_changes_since_last_stamp,
 * changecatch_label_before/_after); copies in installed portals are left alone (never deleted).
 */
export const CHANGECATCH_PROPERTIES: PropertyDefinition[] = [
  prop(STAMP_PROPS.changeId, 'ChangeCatch: last change ID',
    'Set by ChangeCatch. Gets a new value on every association change. Use "Property value changed" on this property as the workflow trigger.', 'string', 1),
  prop(STAMP_PROPS.changeType, 'ChangeCatch: change type', 'Set by ChangeCatch. Added, Removed or Label changed.', 'enumeration', 2,
    CHANGE_TYPE_OPTIONS),
  prop(STAMP_PROPS.otherObjectType, 'ChangeCatch: other object type', 'Set by ChangeCatch. The type of the record on the other side of the association.', 'enumeration', 3,
    buildObjectTypeOptions(STANDARD_OTHER_TYPES, STANDARD_OBJECT_NAMES)),
  prop(STAMP_PROPS.otherRecordId, 'ChangeCatch: other record ID', 'Set by ChangeCatch. The ID of the record on the other side of the association.', 'string', 4),
  prop(STAMP_PROPS.labelBefore, 'ChangeCatch: labels before',
    `Set by ChangeCatch. Labels before the change. "(none)" if there were none, "(unknown)" if ChangeCatch could not tell. ${LABEL_HELP}`,
    'enumeration', 5, FIXED_OPTIONS, 'checkbox'),
  prop(STAMP_PROPS.labelAfter, 'ChangeCatch: labels after',
    `Set by ChangeCatch. Labels after the change. "(none)" if there are none, "(unknown)" if ChangeCatch could not tell. ${LABEL_HELP}`,
    'enumeration', 6, FIXED_OPTIONS, 'checkbox'),
  prop(STAMP_PROPS.labelsCurrent, 'ChangeCatch: current labels',
    `Set by ChangeCatch. All labels on the association now. "(none)" if there are none. ${LABEL_HELP}`,
    'enumeration', 7, FIXED_OPTIONS, 'checkbox'),
];
