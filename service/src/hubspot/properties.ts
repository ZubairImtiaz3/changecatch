// HubSpot client for the ChangeCatch property group + properties (definitions: src/core/contract.ts), created per
// object type in the customer's portal.
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
// Scopes: crm.schemas.<object>.write (core/contract.ts scopesFor).
// The docs list no 409 for duplicates, so we check existence with a read first instead of relying on an error.

import {
  CHANGECATCH_PROPERTIES,
  CUSTOM_OBJECT_SCOPES,
  FIXED_OPTIONS,
  GROUP_LABEL,
  GROUP_NAME,
  isCustomObjectType,
  scopesFor,
  STAMP_PROPS,
  STANDARD_OBJECT_NAMES,
  SYNCED_ENUM_PROPERTY_NAMES,
  type PropertyDefinition,
  type PropertyOption,
} from '../core/contract.js';
import { desiredSyncedOptions, MAX_OPTIONS, mergeOptions, otherTypesFor, type LabelSource } from '../core/label-options.js';
import type { WatchedPair } from '../core/types.js';
import { listCustomObjectTypes } from './object-types.js';
import { HUBSPOT_API_VERSION as V, hsRequest, HubSpotError, type PortalAuth } from '../lib/http.js';
import { createLogger } from '../obs/log.js';
import { LabelListCache } from './labels.js';
import { batchErrorFor, type BatchError } from './batch.js';

const log = createLogger('properties');

type PropertyStatus =
  | 'created'
  | 'exists'
  | 'exists-mismatch'
  | 'updated'
  | 'error';

export interface SetupReport {
  objectType: string;
  group: PropertyStatus;
  properties: { name: string; status: PropertyStatus; detail?: string }[];
  /** Set when the object type needs a scope the install did not grant. */
  missingScope?: string;
  error?: string;
  /** Why this report is a failure (see failureOf); unset when every property is usable. */
  failure?: string;
}

/**
 * One line saying why stamps could be refused: a missing scope, a whole-call error, or the first property that is in
 * error or exists with another type (a stamp on a property of the wrong type is refused by HubSpot). undefined = usable.
 */
function failureOf(r: { error?: string; missingScope?: string; properties: { name: string; status: PropertyStatus; detail?: string }[] }): string | undefined {
  if (r.missingScope) return `missing scope ${r.missingScope}`;
  if (r.error) return r.error;
  const bad = r.properties.find((p) => p.status === 'error' || p.status === 'exists-mismatch');
  return bad && `${bad.name}: ${bad.detail ?? bad.status}`;
}

function withFailure<T extends Parameters<typeof failureOf>[0]>(r: T): T & { failure?: string } {
  const failure = failureOf(r);
  return failure === undefined ? r : { ...r, failure };
}

interface ExistingProperty {
  name: string;
  type: string;
  fieldType?: string;
  groupName: string;
  options?: PropertyOption[];
}

/** Every property on the object type, in one GET (readProperties' fallback). */
async function listProperties(auth: PortalAuth, objectType: string): Promise<ExistingProperty[]> {
  const res = await hsRequest<{ results: ExistingProperty[] }>(`/crm/properties/${V}/${encodeURIComponent(objectType)}`, { ...auth });
  return res?.results ?? [];
}

/**
 * Read only the named properties (one call). Names that don't exist are simply absent from the result.
 * Falls back to the full list (one GET) if the batch endpoint rejects the call with a 4xx other than 401/403/429.
 */
async function readProperties(auth: PortalAuth, objectType: string, names: string[]): Promise<ExistingProperty[]> {
  const want = new Set(names);
  try {
    const res = await hsRequest<{ results?: ExistingProperty[] }>(`/crm/properties/${V}/${encodeURIComponent(objectType)}/batch/read`, {
      method: 'POST',
      ...auth,
      body: { archived: false, dataSensitivity: 'non_sensitive', inputs: names.map((name) => ({ name })) },
    });
    return (res?.results ?? []).filter((p) => want.has(p.name));
  } catch (e) {
    if (e instanceof HubSpotError && e.status >= 400 && e.status < 500 && ![401, 403, 429].includes(e.status)) {
      return (await listProperties(auth, objectType)).filter((p) => want.has(p.name));
    }
    throw e;
  }
}

interface BatchCreateResult {
  created: string[];
  failed: { name: string; error: string }[];
}

/** Create several properties in ONE call. Handles 207: per-name results. A whole-call error is thrown. */
async function createProperties(auth: PortalAuth, objectType: string, defs: PropertyDefinition[]): Promise<BatchCreateResult> {
  if (defs.length === 0) return { created: [], failed: [] };
  const res = await hsRequest<{ results?: { name: string }[]; errors?: BatchError[] }>(
    `/crm/properties/${V}/${encodeURIComponent(objectType)}/batch/create`,
    { method: 'POST', ...auth, body: { inputs: defs } },
  );
  const ok = new Set((res?.results ?? []).map((r) => r.name));
  const errs = res?.errors ?? [];
  const out: BatchCreateResult = { created: [], failed: [] };
  for (const d of defs) {
    if (ok.has(d.name)) {
      out.created.push(d.name);
      continue;
    }
    const err = batchErrorFor(errs, d.name);
    out.failed.push({ name: d.name, error: err ? `${err.category ?? 'ERROR'}: ${err.message ?? ''}` : 'not in batch create results' });
  }
  return out;
}

async function listGroups(auth: PortalAuth, objectType: string): Promise<{ name: string }[]> {
  const res = await hsRequest<{ results: { name: string }[] }>(`/crm/properties/${V}/${encodeURIComponent(objectType)}/groups`, { ...auth });
  return res?.results ?? [];
}

/**
 * Make sure the "changecatch" group and all 7 properties exist on one object type. Idempotent: existing ones are skipped.
 * A 403 on create is reported as a missing schema scope (for 2-xxx: crm.schemas.custom.write).
 */
export async function ensureChangeCatchProperties(auth: PortalAuth, objectType: string): Promise<SetupReport> {
  return withFailure(await ensureProperties(auth, objectType));
}

async function ensureProperties(auth: PortalAuth, objectType: string): Promise<SetupReport> {
  const report: SetupReport = { objectType, group: 'exists', properties: [] };
  const path = `/crm/properties/${V}/${encodeURIComponent(objectType)}`;
  const on403 = (e: unknown) => {
    if (e instanceof HubSpotError && e.status === 403) {
      report.missingScope = scopesFor(objectType).schemaWrite;
      return true;
    }
    return false;
  };

  let existing: Map<string, ExistingProperty>;
  try {
    const [groups, props] = await Promise.all([
      listGroups(auth, objectType),
      readProperties(auth, objectType, CHANGECATCH_PROPERTIES.map((d) => d.name)),
    ]);
    report.group = groups.some((g) => g.name === GROUP_NAME) ? 'exists' : 'created';
    existing = new Map(props.map((p) => [p.name, p]));
  } catch (e) {
    if (e instanceof HubSpotError && e.status === 403) {
      report.missingScope = isCustomObjectType(objectType) ? `${CUSTOM_OBJECT_SCOPES.schemaRead} (or ${CUSTOM_OBJECT_SCOPES.objectRead})` : (scopesFor(objectType).read ?? `read scope for ${objectType}`);
    }
    report.error = e instanceof Error ? e.message : String(e);
    return report;
  }

  if (report.group === 'created') {
    try {
      await hsRequest(`${path}/groups`, { method: 'POST', ...auth, body: { name: GROUP_NAME, label: GROUP_LABEL, displayOrder: -1 } });
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
    if (hit && SYNCED_ENUM_PROPERTY_NAMES.includes(d.name)) {
      // More options are added by the option sync (createLabelOptionSync).
      const r = await upsertLabelProperty(auth, objectType, d, d.options ?? FIXED_OPTIONS, hit);
      if (r.forbidden) report.missingScope = scopesFor(objectType).schemaWrite;
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
    toCreate.push(d);
  }

  if (toCreate.length) {
    try {
      const r = await createProperties(auth, objectType, toCreate);
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

// ---------- dropdown properties: create + option sync ----------

export interface LabelPropertyResult {
  name: string;
  status: PropertyStatus;
  /** Option values added. */
  added: string[];
  detail?: string;
  /** HubSpot answered 403 (a schema write scope is missing). */
  forbidden?: true;
}

/**
 * Bring one dropdown property (label checkboxes, change type, other object type) to d.type + d.fieldType with at least
 * `desired` options.
 *  - missing          -> create (POST) with `desired`
 *  - other type       -> reported as exists-mismatch, left alone (never changed in place)
 *  - right type       -> PATCH options only if some are missing / hidden / renamed (existing ones are kept)
 */
async function upsertLabelProperty(
  auth: PortalAuth,
  objectType: string,
  d: PropertyDefinition,
  desired: PropertyOption[],
  hit: ExistingProperty | undefined,
): Promise<LabelPropertyResult> {
  const path = `/crm/properties/${V}/${encodeURIComponent(objectType)}`;
  const fail = (e: unknown): LabelPropertyResult => ({
    name: d.name,
    status: 'error',
    added: [],
    detail: e instanceof Error ? e.message : String(e),
    ...(e instanceof HubSpotError && e.status === 403 ? { forbidden: true as const } : {}),
  });

  if (!hit) {
    try {
      await hsRequest(path, { method: 'POST', ...auth, body: { ...d, options: desired } });
      return { name: d.name, status: 'created', added: desired.map((o) => o.value) };
    } catch (e) {
      return fail(e);
    }
  }

  if (hit.type !== d.type || hit.fieldType !== d.fieldType)
    return { name: d.name, status: 'exists-mismatch', added: [], detail: `existing ${hit.type}/${hit.fieldType ?? '?'}, expected ${d.type}/${d.fieldType}` };
  const merged = mergeOptions(hit.options ?? [], desired);
  if (merged.options.length > MAX_OPTIONS)
    return { name: d.name, status: 'error', added: [], detail: `${merged.options.length} options is over the ${MAX_OPTIONS} limit` };
  if (!merged.changed) return { name: d.name, status: 'exists', added: [] };
  try {
    await hsRequest(`${path}/${encodeURIComponent(d.name)}`, { method: 'PATCH', ...auth, body: { options: merged.options } });
    return { name: d.name, status: 'updated', added: merged.added };
  } catch (e) {
    return fail(e);
  }
}

/** Display names for object type ids: standard names, plus custom object singular labels when readable. */
async function objectTypeNames(auth: PortalAuth, ids: string[]): Promise<Record<string, string>> {
  const names: Record<string, string> = { ...STANDARD_OBJECT_NAMES };
  if (ids.some(isCustomObjectType)) {
    try {
      for (const t of await listCustomObjectTypes(auth)) names[t.objectTypeId] = t.singular;
    } catch (e) {
      // Option labels fall back to the raw type id; option values (the ids) are unaffected.
      log.warn('object_names_failed', `custom object names not readable: ${e instanceof Error ? e.message : String(e)}`);
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
  /** Why the dropdowns are not usable (failureOf; labelErrors are not counted). */
  failure?: string;
}

export type SyncLabelOptions = (auth: PortalAuth, objectTypeId: string, watchedPairs: WatchedPair[]) => Promise<LabelSyncReport>;

/**
 * Make the dropdowns on `objectTypeId` hold every value a stamp can write: the 3 label properties get an option for
 * every label toward every watched other type (type ids in the direction objectTypeId -> other; a mirror stamp
 * translates its labels to this direction, see resolve.ts mirrorKeysOf), changecatch_other_object_type gets every
 * other type, and changecatch_change_type its 3 values. Idempotent and additive: only PATCHes when an option is missing,
 * hidden or renamed (a label renamed in HubSpot keeps its value; only the display text changes). Never removes options.
 * Concurrent calls for the same portal + object type share one run when it covers the caller's other types; otherwise
 * the caller's run starts after it.
 * Called BEFORE a value can be stamped (a value that is not an option makes HubSpot reject the record update): by the
 * worker's onUnknownLabel hook on the first event of each type id per object pair (labeled or not) and on a rename,
 * and by the installer when a custom-object pair starts being watched (its type is not a starting option).
 * Uses the customer's OAuth token. Scopes: one CRM read scope (labels) + crm.schemas.<object>.write (PATCH).
 * One instance per process (api main, worker main): it owns the label-read cache and the in-flight runs.
 */
export function createLabelOptionSync(): SyncLabelOptions {
  // The label reads: the same direction is often read for several object types in a row.
  const labelLists = new LabelListCache();
  // The latest run per portal + object type, and the other types it covers.
  const inflight = new Map<string, { others: Set<string>; done: Promise<LabelSyncReport> }>();
  return (auth, objectTypeId, watchedPairs) => {
    const key = `${auth.portalId}|${objectTypeId}`;
    const others = otherTypesFor(objectTypeId, watchedPairs);
    const running = inflight.get(key);
    if (running && others.every((o) => running.others.has(o))) return running.done;
    // A running sync that misses some of our other types: ours runs after it (never two PATCHes of one list at once).
    const done = (running ? running.done.catch(() => undefined) : Promise.resolve())
      .then(() => runLabelSync(labelLists, auth, objectTypeId, watchedPairs))
      .finally(() => {
        if (inflight.get(key) === entry) inflight.delete(key);
      });
    const entry = { others: new Set(others), done };
    inflight.set(key, entry);
    return done;
  };
}

async function runLabelSync(
  labelLists: LabelListCache,
  auth: PortalAuth,
  objectTypeId: string,
  watchedPairs: WatchedPair[],
): Promise<LabelSyncReport> {
  const { portalId } = auth;
  const others = otherTypesFor(objectTypeId, watchedPairs);
  const report: LabelSyncReport = { portalId, objectTypeId, otherObjectTypeIds: others, options: [], properties: [], labelErrors: [] };
  const names = await objectTypeNames(auth, others);

  const sources: LabelSource[] = [];
  for (const other of others) {
    try {
      // Only this direction: option values use its type ids.
      const { results } = await labelLists.get(auth, objectTypeId, other);
      sources.push({
        otherObjectTypeId: other,
        otherObjectName: names[other] ?? other,
        labels: results.map((r) => ({ typeId: r.typeId, label: r.label, category: r.category })),
      });
    } catch (e) {
      report.labelErrors.push({ from: objectTypeId, to: other, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const desired = desiredSyncedOptions(others, sources, names);
  report.options = desired[STAMP_PROPS.labelsCurrent];

  let existing: Map<string, ExistingProperty>;
  try {
    existing = new Map((await readProperties(auth, objectTypeId, SYNCED_ENUM_PROPERTY_NAMES)).map((p) => [p.name, p]));
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    return withFailure(report);
  }
  for (const d of CHANGECATCH_PROPERTIES.filter((x) => SYNCED_ENUM_PROPERTY_NAMES.includes(x.name))) {
    report.properties.push(await upsertLabelProperty(auth, objectTypeId, d, desired[d.name], existing.get(d.name)));
  }
  return withFailure(report);
}
