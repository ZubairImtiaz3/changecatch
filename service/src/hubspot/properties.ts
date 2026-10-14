// ChangeCatch property group + properties, created per object type in the customer's portal.
// Uses the customer's OAuth token (NOT the client credentials token).
//
// Docs (checked 2026-10-30, all date-based 2026-09):
//   Guide (type/fieldType pairs, datetime accepts epoch ms):
//     https://developers.hubspot.com/docs/api-reference/latest/crm/properties/guide.md
//   Create property  POST /crm/properties/2026-09/{objectType}
//     https://developers.hubspot.com/docs/api-reference/latest/crm/properties/create-property.md
//   Read properties  GET  /crm/properties/2026-09/{objectType}
//     https://developers.hubspot.com/docs/api-reference/latest/crm/properties/get-properties.md
//   Create group     POST /crm/properties/2026-09/{objectType}/groups
//     https://developers.hubspot.com/docs/api-reference/latest/crm/properties/property-groups/create-property.md
//   Read groups      GET  /crm/properties/2026-09/{objectType}/groups
//     https://developers.hubspot.com/docs/api-reference/latest/crm/properties/property-groups/get-properties.md
//   Update property  PATCH /crm/properties/2026-09/{objectType}/{propertyName}  ("Provided fields will be overwritten":
//     an `options` array REPLACES the whole list, so we always send existing + new options)
//     https://developers.hubspot.com/docs/api-reference/latest/crm/properties/update-property.md
//   Changing a text property to multiple checkboxes is allowed (KB: "a dropdown option will be created for every unique
//     text value"; "changing an existing property's field type can invalidate current values"):
//     https://knowledge.hubspot.com/properties/create-and-edit-properties
//   Custom object names  GET /crm-object-schemas/2026-09/schemas
//     https://developers.hubspot.com/docs/api-reference/latest/crm/objects/schemas/guide#retrieve-existing-custom-object-schemas
//   objectType may be an objectTypeId (0-1, 0-3, 2-xxx):
//     https://developers.hubspot.com/docs/api-reference/latest/crm/using-object-apis.md
//   Batch read       POST /crm/properties/2026-09/{objectType}/batch/read
//     body { archived: false, dataSensitivity: "non_sensitive", inputs: [{ name }] } (all 3 fields required by the
//     OpenAPI schema); 200 BatchResponseProperty or 207 with errors[]
//     https://developers.hubspot.com/docs/api-reference/latest/crm/properties/batch/get-properties.md
//   Batch create     POST /crm/properties/2026-09/{objectType}/batch/create  body { inputs: [PropertyCreate] }
//     201, or 207 with errors[]
//     https://developers.hubspot.com/docs/api-reference/latest/crm/properties/batch/create-properties.md
//   UNCONFIRMED live: whether batch/read returns 207 or a whole-call error when a name does not exist. We treat
//   "not in results" as missing, and fall back to the full GET list if the batch read itself fails with a 4xx.
// Scopes: crm.schemas.{contacts|companies|deals}.write for standard objects, crm.schemas.custom.write for 2-xxx.
// The docs list no 409 for duplicates, so we check existence with a read first instead of relying on an error.
// Call budget per object type (install): 1 group GET + 1 batch read + (1 group POST) + 1 batch create + 1 PATCH per
// label property that needs a migration. Option sync: label reads (cached, src/hubspot/labels.ts) + 1 property read
// + at most 1 PATCH per label property (only when an option is missing; options diffed locally).

import {
  buildLabelOptions,
  FIXED_OPTIONS,
  MAX_OPTIONS,
  mergeOptions,
  otherTypesFor,
  type LabelSource,
  type PropertyOption,
} from '../core/label-options.js';
import { STAMP_PROPS, STANDARD_OBJECT_NAMES } from '../core/stamp.js';
import type { WatchedPair } from '../core/types.js';
import { HttpError, hsRequest } from '../lib/http.js';
import { getLabelsCached } from './labels.js';

const V = '2026-09';
export const GROUP_NAME = 'changecatch';
export const GROUP_LABEL = 'ChangeCatch';

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

const def = (
  name: string,
  label: string,
  description: string,
  type: PropertyDefinition['type'],
  displayOrder: number,
  options?: string[] | PropertyOption[],
  fieldType?: PropertyDefinition['fieldType'],
): PropertyDefinition => ({
  name,
  label,
  description,
  type,
  fieldType: fieldType ?? (type === 'string' ? 'text' : type === 'datetime' ? 'date' : 'select'),
  groupName: GROUP_NAME,
  displayOrder,
  formField: false,
  ...(options
    ? { options: options.map((v, i) => (typeof v === 'string' ? { label: v, value: v, displayOrder: i, hidden: false } : { ...v })) }
    : {}),
});

/**
 * The 3 label properties are "multiple checkboxes" (enumeration + checkbox): several labels can change at once,
 * values are ";"-separated, and workflow filters can match "is any of" / "is all of" the options.
 * Options = (none), (unknown) + one per (other object type, label), synced by syncLabelOptions.
 */
export const LABEL_PROPERTY_NAMES: string[] = [STAMP_PROPS.labelBefore, STAMP_PROPS.labelAfter, STAMP_PROPS.labelsCurrent];
const LABEL_HELP = 'Pick labels from the list. "Billing contact (Contact)" = the "Billing contact" label toward a contact.';

/**
 * The 7 ChangeCatch properties. Same set on every object type. Earlier builds created 9;
 * changecatch_last_change_at and changecatch_changes_since_last_stamp are no longer created. Copies that already exist
 * in installed portals are left alone (never deleted).
 */
export const CHANGECATCH_PROPERTIES: PropertyDefinition[] = [
  def(STAMP_PROPS.changeId, 'ChangeCatch: last change ID',
    'Set by ChangeCatch. Gets a new value on every association change. Use "Property value changed" on this property as the workflow trigger.', 'string', 1),
  def(STAMP_PROPS.changeType, 'ChangeCatch: change type', 'Set by ChangeCatch. ADDED, REMOVED or LABEL_CHANGED.', 'enumeration', 2,
    ['ADDED', 'REMOVED', 'LABEL_CHANGED']),
  def(STAMP_PROPS.otherObjectType, 'ChangeCatch: other object type', 'Set by ChangeCatch. The type of the record on the other side of the association.', 'string', 3),
  def(STAMP_PROPS.otherRecordId, 'ChangeCatch: other record ID', 'Set by ChangeCatch. The ID of the record on the other side of the association.', 'string', 4),
  def(STAMP_PROPS.labelBefore, 'ChangeCatch: labels before',
    `Set by ChangeCatch. Labels before the change. "(none)" if there were none, "(unknown)" if ChangeCatch could not tell. ${LABEL_HELP}`,
    'enumeration', 5, FIXED_OPTIONS, 'checkbox'),
  def(STAMP_PROPS.labelAfter, 'ChangeCatch: labels after',
    `Set by ChangeCatch. Labels after the change. "(none)" if there are none, "(unknown)" if ChangeCatch could not tell. ${LABEL_HELP}`,
    'enumeration', 6, FIXED_OPTIONS, 'checkbox'),
  def(STAMP_PROPS.labelsCurrent, 'ChangeCatch: current labels',
    `Set by ChangeCatch. All labels on the association now. "(none)" if there are none. ${LABEL_HELP}`,
    'enumeration', 7, FIXED_OPTIONS, 'checkbox'),
];

export type PropertyStatus =
  | 'created'
  | 'exists'
  | 'would-create'
  | 'exists-mismatch'
  | 'would-migrate'
  | 'migrated'
  | 'would-update'
  | 'updated'
  | 'error';

export interface SetupReport {
  objectType: string;
  group: PropertyStatus;
  properties: { name: string; status: PropertyStatus; detail?: string }[];
  /** Set when the object type needs a scope the install did not grant. */
  missingScope?: string;
  error?: string;
}

export function schemaWriteScopeFor(objectType: string): string {
  if (objectType.startsWith('2-')) return 'crm.schemas.custom.write';
  return (
    { '0-1': 'crm.schemas.contacts.write', '0-2': 'crm.schemas.companies.write', '0-3': 'crm.schemas.deals.write' }[objectType] ??
    `crm.schemas.<${objectType}>.write`
  );
}

interface ExistingProperty {
  name: string;
  type: string;
  fieldType?: string;
  groupName: string;
  options?: PropertyOption[];
}

/**
 * Every property on the object type, in one GET. Used by the label option sync (one call per sync, no per-property
 * reads). readProperties (batch/read) is lighter, but the option sync keeps this call for now because the worker's
 * tests (src/worker/hooks.test.ts) stub exactly this endpoint; switch it once those stubs know batch/read.
 */
export async function listProperties(token: string, objectType: string): Promise<ExistingProperty[]> {
  const res = await hsRequest<{ results: ExistingProperty[] }>(`/crm/properties/${V}/${encodeURIComponent(objectType)}`, { token });
  return res?.results ?? [];
}

/**
 * Read only the named properties (one call). Names that don't exist are simply absent from the result.
 * Falls back to the full list (one GET) if the batch endpoint rejects the call with a 4xx other than 401/403/429.
 */
export async function readProperties(token: string, objectType: string, names: string[]): Promise<ExistingProperty[]> {
  const want = new Set(names);
  try {
    const res = await hsRequest<{ results?: ExistingProperty[] }>(`/crm/properties/${V}/${encodeURIComponent(objectType)}/batch/read`, {
      method: 'POST',
      token,
      body: { archived: false, dataSensitivity: 'non_sensitive', inputs: names.map((name) => ({ name })) },
    });
    return (res?.results ?? []).filter((p) => want.has(p.name));
  } catch (e) {
    if (e instanceof HttpError && e.status >= 400 && e.status < 500 && ![401, 403, 429].includes(e.status)) {
      return (await listProperties(token, objectType)).filter((p) => want.has(p.name));
    }
    throw e;
  }
}

export interface BatchCreateResult {
  created: string[];
  failed: { name: string; error: string }[];
}

type BatchError = { message?: string; category?: string; context?: Record<string, unknown> };

/** Create several properties in ONE call. Handles 207: per-name results. A whole-call error is thrown. */
export async function createProperties(token: string, objectType: string, defs: PropertyDefinition[]): Promise<BatchCreateResult> {
  if (defs.length === 0) return { created: [], failed: [] };
  const res = await hsRequest<{ results?: { name: string }[]; errors?: BatchError[] }>(
    `/crm/properties/${V}/${encodeURIComponent(objectType)}/batch/create`,
    { method: 'POST', token, body: { inputs: defs } },
  );
  const ok = new Set((res?.results ?? []).map((r) => r.name));
  const errs = res?.errors ?? [];
  const out: BatchCreateResult = { created: [], failed: [] };
  for (const d of defs) {
    if (ok.has(d.name)) {
      out.created.push(d.name);
      continue;
    }
    const err = errs.find((e) => JSON.stringify(e.context ?? {}).includes(`"${d.name}"`) || (e.message ?? '').includes(d.name)) ?? errs[0];
    out.failed.push({ name: d.name, error: err ? `${err.category ?? 'ERROR'}: ${err.message ?? ''}` : 'not in batch create results' });
  }
  return out;
}

export async function listGroups(token: string, objectType: string): Promise<{ name: string }[]> {
  const res = await hsRequest<{ results: { name: string }[] }>(`/crm/properties/${V}/${encodeURIComponent(objectType)}/groups`, { token });
  return res?.results ?? [];
}

/**
 * Make sure the "changecatch" group and all 7 properties exist on one object type. Idempotent: existing ones are skipped.
 * dryRun = only read, report what would be created.
 * A 403 on create is reported as a missing schema scope (for 2-xxx: crm.schemas.custom.write).
 */
export async function ensureChangeCatchProperties(token: string, objectType: string, opts: { dryRun: boolean }): Promise<SetupReport> {
  const report: SetupReport = { objectType, group: 'exists', properties: [] };
  const path = `/crm/properties/${V}/${encodeURIComponent(objectType)}`;
  const on403 = (e: unknown) => {
    if (e instanceof HttpError && e.status === 403) {
      report.missingScope = schemaWriteScopeFor(objectType);
      return true;
    }
    return false;
  };

  let existing: Map<string, ExistingProperty>;
  try {
    const [groups, props] = await Promise.all([
      listGroups(token, objectType),
      readProperties(token, objectType, CHANGECATCH_PROPERTIES.map((d) => d.name)),
    ]);
    report.group = groups.some((g) => g.name === GROUP_NAME) ? 'exists' : opts.dryRun ? 'would-create' : 'created';
    existing = new Map(props.map((p) => [p.name, p]));
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) {
      report.missingScope = objectType.startsWith('2-') ? 'crm.schemas.custom.read (or crm.objects.custom.read)' : `read scope for ${objectType}`;
    }
    report.error = e instanceof Error ? e.message : String(e);
    return report;
  }

  if (report.group === 'created') {
    try {
      await hsRequest(`${path}/groups`, { method: 'POST', token, body: { name: GROUP_NAME, label: GROUP_LABEL, displayOrder: -1 } });
    } catch (e) {
      report.group = 'error';
      on403(e);
      report.error = e instanceof Error ? e.message : String(e);
      return report; // properties need the group
    }
  }

  const toCreate: PropertyDefinition[] = [];
  for (const d of CHANGECATCH_PROPERTIES) {
    const hit = existing.get(d.name);
    if (hit && LABEL_PROPERTY_NAMES.includes(d.name)) {
      // Old free-text version (or wrong fieldType): migrate in place. Label options are added by syncLabelOptions.
      const r = await upsertLabelProperty(token, objectType, d, FIXED_OPTIONS, hit, opts.dryRun);
      if (r.status === 'error' && r.detail?.includes(' 403')) report.missingScope = schemaWriteScopeFor(objectType);
      report.properties.push({ name: d.name, status: r.status, ...(r.detail ? { detail: r.detail } : {}) });
      continue;
    }
    if (hit) {
      const ok = hit.type === d.type;
      report.properties.push({
        name: d.name,
        status: ok ? 'exists' : 'exists-mismatch',
        ...(ok ? {} : { detail: `existing type ${hit.type}, expected ${d.type}` }),
      });
      continue;
    }
    if (opts.dryRun) report.properties.push({ name: d.name, status: 'would-create' });
    else toCreate.push(d);
  }

  if (toCreate.length) {
    // ONE batch create for every missing property (was one POST each).
    try {
      const r = await createProperties(token, objectType, toCreate);
      for (const name of r.created) report.properties.push({ name, status: 'created' });
      for (const f of r.failed) report.properties.push({ name: f.name, status: 'error', detail: f.error });
    } catch (e) {
      on403(e);
      const detail = e instanceof Error ? e.message : String(e);
      for (const d of toCreate) report.properties.push({ name: d.name, status: 'error', detail });
    }
    const order = new Map(CHANGECATCH_PROPERTIES.map((d, i) => [d.name, i]));
    report.properties.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  }
  return report;
}

// ---------- label properties: migration + option sync ----------

export interface LabelPropertyResult {
  name: string;
  status: PropertyStatus;
  /** Option values added (or that would be added). */
  added: string[];
  detail?: string;
}

/**
 * Bring one label property to enumeration + checkbox with at least `desired` options.
 *  - missing                      -> create (POST) with `desired`
 *  - string / other fieldType     -> migrate in place (PATCH type + fieldType + options). Old free-text values become invalid.
 *  - enumeration + checkbox       -> PATCH options only if some are missing (existing options are always kept)
 * dryRun = report only.
 */
export async function upsertLabelProperty(
  token: string,
  objectType: string,
  d: PropertyDefinition,
  desired: PropertyOption[],
  hit: ExistingProperty | undefined,
  dryRun: boolean,
): Promise<LabelPropertyResult> {
  const path = `/crm/properties/${V}/${encodeURIComponent(objectType)}`;
  const fail = (e: unknown): LabelPropertyResult => ({ name: d.name, status: 'error', added: [], detail: e instanceof Error ? e.message : String(e) });

  if (!hit) {
    if (dryRun) return { name: d.name, status: 'would-create', added: desired.map((o) => o.value) };
    try {
      await hsRequest(path, { method: 'POST', token, body: { ...d, options: desired } });
      return { name: d.name, status: 'created', added: desired.map((o) => o.value) };
    } catch (e) {
      return fail(e);
    }
  }

  const isTarget = hit.type === 'enumeration' && hit.fieldType === 'checkbox';
  // A text property has no options. An enumeration with another fieldType keeps its options.
  const merged = mergeOptions(hit.type === 'enumeration' ? (hit.options ?? []) : [], desired);
  if (merged.options.length > MAX_OPTIONS)
    return { name: d.name, status: 'error', added: [], detail: `${merged.options.length} options is over the ${MAX_OPTIONS} limit` };
  if (isTarget && !merged.changed) return { name: d.name, status: 'exists', added: [] };

  const migrate = !isTarget;
  const detail = migrate ? `existing ${hit.type}/${hit.fieldType ?? '?'} -> enumeration/checkbox` : undefined;
  if (dryRun) return { name: d.name, status: migrate ? 'would-migrate' : 'would-update', added: merged.added, ...(detail ? { detail } : {}) };

  const body = migrate
    ? { type: d.type, fieldType: d.fieldType, label: d.label, description: d.description, options: merged.options }
    : { options: merged.options };
  try {
    // PATCH /crm/properties/2026-09/{objectType}/{propertyName}
    // https://developers.hubspot.com/docs/api-reference/latest/crm/properties/update-property.md
    await hsRequest(`${path}/${encodeURIComponent(d.name)}`, { method: 'PATCH', token, body });
    return { name: d.name, status: migrate ? 'migrated' : 'updated', added: merged.added, ...(detail ? { detail } : {}) };
  } catch (e) {
    return fail(e);
  }
}

/** Display names for object type ids: standard names, plus custom object singular labels when readable. */
export async function objectTypeNames(token: string, ids: string[]): Promise<Record<string, string>> {
  const names: Record<string, string> = { ...STANDARD_OBJECT_NAMES };
  if (ids.some((id) => id.startsWith('2-') && !names[id])) {
    try {
      // GET /crm-object-schemas/2026-09/schemas (needs crm.schemas.custom.read; on failure we fall back to the raw id)
      const res = await hsRequest<{ results: { objectTypeId: string; name?: string; labels?: { singular?: string } }[] }>(
        '/crm-object-schemas/2026-09/schemas',
        { token },
      );
      for (const s of res?.results ?? []) names[s.objectTypeId] = s.labels?.singular ?? s.name ?? s.objectTypeId;
    } catch {
      /* raw ids are fine as a fallback */
    }
  }
  return names;
}

export interface LabelSyncReport {
  portalId: number;
  objectTypeId: string;
  otherObjectTypeIds: string[];
  /** Desired options (fixed + every label toward the other types). */
  options: PropertyOption[];
  properties: LabelPropertyResult[];
  /** Label endpoints that failed (e.g. a pair that no longer exists). Their labels are simply not added. */
  labelErrors: { from: string; to: string; error: string }[];
  error?: string;
}

export interface LabelSyncOptions {
  dryRun?: boolean;
  /** Pre-resolved names (skips the schemas call). */
  objectTypeNames?: Record<string, string>;
}

const syncInflight = new Map<string, Promise<LabelSyncReport>>();

/**
 * Make the 3 label properties on `objectTypeId` hold an option for every label toward every watched other type.
 * Reads labels in BOTH directions (typeIds and paired label names are per direction, and a mirror stamp uses the
 * other direction's names). Idempotent and additive: only PATCHes when an option is missing. Never removes options.
 * Concurrent calls for the same portal + object type share one run.
 * Call it on install / settings change, and from the worker's onUnknownLabel hook BEFORE stamping a new label
 * (a value that is not an option makes HubSpot reject the record update).
 * Uses the customer's OAuth token. Scopes: one CRM read scope (labels) + crm.schemas.<object>.write (PATCH).
 */
export function syncLabelOptions(
  token: string,
  portalId: number,
  objectTypeId: string,
  watchedPairs: WatchedPair[],
  opts: LabelSyncOptions = {},
): Promise<LabelSyncReport> {
  const key = `${portalId}|${objectTypeId}|${opts.dryRun ? 'dry' : 'apply'}`;
  const running = syncInflight.get(key);
  if (running) return running;
  const p = runLabelSync(token, portalId, objectTypeId, watchedPairs, opts).finally(() => syncInflight.delete(key));
  syncInflight.set(key, p);
  return p;
}

async function runLabelSync(
  token: string,
  portalId: number,
  objectTypeId: string,
  watchedPairs: WatchedPair[],
  opts: LabelSyncOptions,
): Promise<LabelSyncReport> {
  const others = otherTypesFor(objectTypeId, watchedPairs);
  const report: LabelSyncReport = { portalId, objectTypeId, otherObjectTypeIds: others, options: [], properties: [], labelErrors: [] };
  const names = opts.objectTypeNames ?? (await objectTypeNames(token, others));

  const sources: LabelSource[] = [];
  for (const other of others) {
    const labels: LabelSource['labels'] = [];
    for (const [from, to] of [[objectTypeId, other], [other, objectTypeId]]) {
      try {
        // Cached per (portal, from, to): a sync for both sides of a pair reads each direction once.
        const { results } = await getLabelsCached(token, portalId, from, to);
        labels.push(...results.map((r) => ({ label: r.label, category: r.category })));
      } catch (e) {
        report.labelErrors.push({ from, to, error: e instanceof Error ? e.message : String(e) });
      }
    }
    sources.push({ otherObjectTypeId: other, otherObjectName: names[other] ?? other, labels });
  }
  report.options = buildLabelOptions(sources);

  let existing: Map<string, ExistingProperty>;
  try {
    existing = new Map((await listProperties(token, objectTypeId)).map((p) => [p.name, p]));
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    return report;
  }
  for (const d of CHANGECATCH_PROPERTIES.filter((x) => LABEL_PROPERTY_NAMES.includes(x.name))) {
    report.properties.push(await upsertLabelProperty(token, objectTypeId, d, report.options, existing.get(d.name), !!opts.dryRun));
  }
  return report;
}
