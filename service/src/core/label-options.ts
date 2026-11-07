// Option sets + value formatting for the 3 label properties (changecatch_labels_before / _after / _current).
// The label properties are enumeration + checkbox ("multiple checkboxes"), so a record value is a set of option values.
//
// Docs (checked 2026-10-30):
//   Multi-checkbox values are ";"-separated with no spaces (properties guide, "enumeration" type):
//     https://developers.hubspot.com/docs/api-reference/latest/crm/properties/guide.md
//   Limits: 5,000 options or 512,000 bytes per property; 3,000 chars per option (label + value + description):
//     https://knowledge.hubspot.com/properties/property-field-types-in-hubspot
//
// Option value design (naming review 2026-11-07, docs/decisions.md):
//   value = `${otherObjectTypeId}:${associationTypeId}`  e.g. "0-1:279"
//   label = `${label name} (${other object name})`        e.g. "Billing contact (Contact)"
// The associationTypeId is the label's id in the direction stamped record -> other record. Ids never change, so a
// label renamed in HubSpot keeps its option value (customers' workflow filters keep matching); the sync only updates
// the option's display text. One option per (other type, label) lets an admin pick exactly the label they mean in a
// single filter. Option VALUES are frozen once customers install: never change this format.
// The pipeline carries label KEYS (resolve.ts labelKeysOf): the type id as a string, UNLABELED_KEY for the structural
// default link, or "type N" when the id could not be resolved.
//
// Pure: no HTTP. The sync (GET + PATCH) lives in src/hubspot/properties.ts; the fixed options in ./contract.ts.

import {
  buildObjectTypeOptions,
  CHANGE_TYPE_OPTIONS,
  FIXED_OPTIONS,
  LABEL_PROPERTY_NAMES,
  NONE,
  STAMP_PROPS,
  STANDARD_OTHER_TYPES,
  UNKNOWN,
  type PropertyOption,
} from './contract.js';

/** HubSpot's multi-checkbox separator. No spaces. */
export const MULTI_SEPARATOR = ';';

// --- label keys (what the pipeline carries per label) ---
/** The key of a structural (unlabeled) type. It is not a real label, so it is dropped when stamping. */
export const UNLABELED_KEY = 'unlabeled';
/** The key of a resolved label: its association type id (direction from -> to) as a string. */
export const typeIdKey = (associationTypeId: number): string => String(associationTypeId);
/** The key of a label whose name could not be resolved ("?" = no translation to the mirror direction). Stamped "unknown". */
export const unresolvedKey = (associationTypeId: number | '?'): string => `type ${associationTypeId}`;
/** True for a resolved label key (a type id); false for UNLABELED_KEY and unresolved keys. */
export const isTypeIdKey = (key: string): boolean => /^\d+$/.test(key);

export const MAX_OPTIONS = 5000;

/** A label name trimmed, inner whitespace collapsed (case kept): for display and for the mirror translation by name. */
export const normLabelName = (s: string): string => s.trim().replace(/\s+/g, ' ');

/** The option value for one label seen from the stamped record, towards `otherObjectTypeId`. */
export function labelOptionValue(otherObjectTypeId: string, associationTypeId: number | string): string {
  return `${otherObjectTypeId}:${associationTypeId}`;
}

export function labelOptionLabel(otherObjectName: string, labelName: string): string {
  return `${normLabelName(labelName)} (${otherObjectName})`;
}

/**
 * Label keys -> the property value: sorted option values joined with ";".
 * undefined -> `whenUndefined` (default "unknown"); no real labels -> "none".
 * The unlabeled key is dropped; an unresolved "type 123" (anything that isn't a type id) becomes "unknown".
 */
export function formatLabelValues(labels: string[] | undefined, otherObjectTypeId: string, whenUndefined: string = UNKNOWN): string {
  if (labels === undefined) return whenUndefined;
  const out = new Set<string>();
  for (const raw of labels) {
    const l = raw.trim();
    if (l === '' || l === UNLABELED_KEY) continue;
    out.add(isTypeIdKey(l) ? labelOptionValue(otherObjectTypeId, l) : UNKNOWN);
  }
  return out.size === 0 ? NONE : [...out].sort().join(MULTI_SEPARATOR);
}

/** A property value -> its option values. */
export function splitValues(value: string | null | undefined): string[] {
  return (value ?? '').split(MULTI_SEPARATOR).map((v) => v.trim()).filter(Boolean);
}

/** Label definitions toward one other object type, in the direction stamped object -> other object. */
export interface LabelSource {
  otherObjectTypeId: string;
  otherObjectName: string;
  labels: { typeId: number; label: string | null; category: string }[];
}

/**
 * Desired option set for one object type: "(none)", "(unknown)", then every named label (USER_DEFINED and named
 * HUBSPOT_DEFINED ones like "Primary") per other object type, sorted by object name then label. Null labels are skipped.
 */
/**
 * The options each synced dropdown (SYNCED_ENUM_PROPERTY_NAMES) on one object type must hold: the change types, every
 * standard + watched other type, and one option per label toward the watched other types (`sources`).
 * `names`: display names of the other types (labels of changecatch_other_object_type options).
 */
export function desiredSyncedOptions(others: string[], sources: LabelSource[], names: Record<string, string>): Record<string, PropertyOption[]> {
  const labels = buildLabelOptions(sources);
  return {
    [STAMP_PROPS.changeType]: CHANGE_TYPE_OPTIONS,
    [STAMP_PROPS.otherObjectType]: buildObjectTypeOptions([...STANDARD_OTHER_TYPES, ...others], names),
    ...Object.fromEntries(LABEL_PROPERTY_NAMES.map((n) => [n, labels])),
  };
}

export function buildLabelOptions(sources: LabelSource[]): PropertyOption[] {
  const byValue = new Map<string, { label: string; sort: string }>();
  for (const s of sources) {
    for (const l of s.labels) {
      if (l.label === null || normLabelName(l.label) === '') continue;
      const value = labelOptionValue(s.otherObjectTypeId, l.typeId);
      if (!byValue.has(value))
        byValue.set(value, { label: labelOptionLabel(s.otherObjectName, l.label), sort: `${s.otherObjectName}\u0000${normLabelName(l.label).toLowerCase()}` });
    }
  }
  const labelled = [...byValue.entries()].sort((a, b) => (a[1].sort < b[1].sort ? -1 : a[1].sort > b[1].sort ? 1 : 0));
  return [
    ...FIXED_OPTIONS.map((o) => ({ ...o })),
    ...labelled.map(([value, v], i) => ({ label: v.label, value, displayOrder: FIXED_OPTIONS.length + i, hidden: false })),
  ];
}

export interface MergeResult {
  options: PropertyOption[];
  /** Values that were missing and are appended. */
  added: string[];
  /** Values that existed but were hidden, and are shown again. */
  unhidden: string[];
  /** Values whose display text changed (a label or object renamed in HubSpot). The value itself never changes. */
  relabelled: string[];
  changed: boolean;
}

/**
 * PATCH replaces the whole options list ("Provided fields will be overwritten"), so we send existing + missing.
 * Never removes an option: records may still hold it (deleted labels). Updates the display text of an option whose
 * label was renamed (same value = same association type id).
 */
export function mergeOptions(existing: PropertyOption[], desired: PropertyOption[]): MergeResult {
  const have = new Map(existing.map((o) => [o.value, o]));
  const want = new Map(desired.map((d) => [d.value, d]));
  const unhidden: string[] = [];
  const relabelled: string[] = [];
  const options = existing.map((o) => {
    const d = want.get(o.value);
    const next = { ...o };
    if (d && o.hidden) {
      unhidden.push(o.value);
      next.hidden = false;
    }
    if (d && d.label !== o.label) {
      relabelled.push(o.value);
      next.label = d.label;
    }
    return next;
  });
  let order = options.reduce((m, o) => Math.max(m, o.displayOrder), -1) + 1;
  const added: string[] = [];
  for (const d of desired) {
    if (have.has(d.value)) continue;
    options.push({ ...d, displayOrder: order++ });
    added.push(d.value);
  }
  return { options, added, unhidden, relabelled, changed: added.length > 0 || unhidden.length > 0 || relabelled.length > 0 };
}

/** Other object types this object type is associated with, among the watched pairs (either side). */
export function otherTypesFor(objectTypeId: string, pairs: { objectTypeId: string; associatedObjectTypeId: string }[]): string[] {
  const out = new Set<string>();
  for (const p of pairs) {
    if (p.objectTypeId === objectTypeId) out.add(p.associatedObjectTypeId);
    if (p.associatedObjectTypeId === objectTypeId) out.add(p.objectTypeId);
  }
  return [...out].sort();
}
