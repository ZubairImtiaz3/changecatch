// Option sets + value formatting for the 3 label properties (changecatch_label_before / _after / labels_current).
// They are enumeration + checkbox ("multiple checkboxes") properties, so a record value is a set of option values.
//
// Docs (checked 2026-10-30):
//   Multi-checkbox values are ";"-separated with no spaces (properties guide, "enumeration" type):
//     https://developers.hubspot.com/docs/api-reference/latest/crm/properties/guide.md
//   Limits: 5,000 options or 512,000 bytes per property; 3,000 chars per option (label + value + description):
//     https://knowledge.hubspot.com/properties/property-field-types-in-hubspot
//
// Option value design (decision log D4 follow-up):
//   value = `${otherObjectTypeId}:${label name}`  e.g. "0-1:Billing contact"
//   label = `${label name} (${other object name})` e.g. "Billing contact (Contact)"
// Why: the same label text can exist on two pairs (Deal->Contact "Billing contact" and Deal->Company
// "Billing contact"). One option per pair lets an admin pick exactly the one they mean in a single filter,
// without also filtering on changecatch_other_object_type. The type id prefix is stable (object names can be renamed).
// We key by label NAME, not typeId, because the stamp pipeline only carries names (resolve.ts). A renamed label
// gets a new option; the old one is kept (records may still hold it).
//
// Pure: no HTTP. The sync (GET + PATCH) lives in src/hubspot/properties.ts.

/** Written instead of "" so workflow filters ("is any of (none)") work. */
export const NONE = '(none)';
/** Written when we genuinely don't know (e.g. a label edit on a pair we never saw being created). */
export const UNKNOWN = '(unknown)';
/** HubSpot's multi-checkbox separator. No spaces. */
export const MULTI_SEPARATOR = ';';
/** resolve.ts names a structural (unlabeled) type like this. It is not a real label, so it is dropped. */
export const UNLABELED_NAME = 'Unlabeled';
/** resolve.ts writes `type 123` when a type id is still unknown after a label refresh. */
const UNRESOLVED_TYPE = /^type \d+$/;

export const MAX_OPTIONS = 5000;

export interface PropertyOption {
  label: string;
  value: string;
  displayOrder: number;
  hidden: boolean;
}

export const FIXED_OPTIONS: PropertyOption[] = [
  { label: NONE, value: NONE, displayOrder: 0, hidden: false },
  { label: UNKNOWN, value: UNKNOWN, displayOrder: 1, hidden: false },
];

/** ";" would split one label into two values, so it is replaced. */
const clean = (s: string) => s.trim().replace(/;/g, ',').replace(/\s+/g, ' ');

/** The option value for one label seen from the stamped record, towards `otherObjectTypeId`. */
export function labelOptionValue(otherObjectTypeId: string, labelName: string): string {
  return `${otherObjectTypeId}:${clean(labelName)}`;
}

export function labelOptionLabel(otherObjectName: string, labelName: string): string {
  return `${clean(labelName)} (${otherObjectName})`;
}

/**
 * Label names -> the property value: sorted option values joined with ";".
 * undefined -> `whenUndefined` (default "(unknown)"); no real labels -> "(none)".
 * "Unlabeled" is dropped; an unresolved "type 123" becomes "(unknown)" (it can't match an option).
 */
export function formatLabelValues(labels: string[] | undefined, otherObjectTypeId: string, whenUndefined: string = UNKNOWN): string {
  if (labels === undefined) return whenUndefined;
  const out = new Set<string>();
  for (const raw of labels) {
    const l = clean(raw);
    if (l === '' || l === UNLABELED_NAME) continue;
    out.add(UNRESOLVED_TYPE.test(l) ? UNKNOWN : labelOptionValue(otherObjectTypeId, l));
  }
  return out.size === 0 ? NONE : [...out].sort().join(MULTI_SEPARATOR);
}

/** A property value -> its option values. */
export function splitValues(value: string | null | undefined): string[] {
  return (value ?? '').split(MULTI_SEPARATOR).map((v) => v.trim()).filter(Boolean);
}

/** Label definitions toward one other object type (from the labels endpoint, either direction). */
export interface LabelSource {
  otherObjectTypeId: string;
  otherObjectName: string;
  labels: { label: string | null; category: string }[];
}

/**
 * Desired option set for one object type: "(none)", "(unknown)", then every named label (USER_DEFINED and named
 * HUBSPOT_DEFINED ones like "Primary") per other object type, sorted by object name then label. Null labels are skipped.
 */
export function buildLabelOptions(sources: LabelSource[]): PropertyOption[] {
  const byValue = new Map<string, { label: string; sort: string }>();
  for (const s of sources) {
    for (const l of s.labels) {
      if (l.label === null || clean(l.label) === '' || clean(l.label) === UNLABELED_NAME) continue;
      const value = labelOptionValue(s.otherObjectTypeId, l.label);
      if (!byValue.has(value))
        byValue.set(value, { label: labelOptionLabel(s.otherObjectName, l.label), sort: `${s.otherObjectName}\u0000${clean(l.label).toLowerCase()}` });
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
  changed: boolean;
}

/**
 * PATCH replaces the whole options list ("Provided fields will be overwritten"), so we send existing + missing.
 * Never removes an option: records may still hold it (deleted or renamed labels).
 */
export function mergeOptions(existing: PropertyOption[], desired: PropertyOption[]): MergeResult {
  const have = new Map(existing.map((o) => [o.value, o]));
  const unhidden: string[] = [];
  const options = existing.map((o) => {
    if (o.hidden && desired.some((d) => d.value === o.value)) {
      unhidden.push(o.value);
      return { ...o, hidden: false };
    }
    return { ...o };
  });
  let order = options.reduce((m, o) => Math.max(m, o.displayOrder), -1) + 1;
  const added: string[] = [];
  for (const d of desired) {
    if (have.has(d.value)) continue;
    options.push({ ...d, displayOrder: order++ });
    added.push(d.value);
  }
  return { options, added, unhidden, changed: added.length > 0 || unhidden.length > 0 };
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
