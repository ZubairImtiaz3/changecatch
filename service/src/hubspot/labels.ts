// Association label definitions (typeId -> label) for one direction of an object pair.
// Uses the CUSTOMER's OAuth token. Date-based version only (no v4).
//
// Docs (checked 2026-10-30):
//   https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associations-schema/guide#retrieve-association-labels
//   https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associations-schema/labels/get-associations-label
// GET /crm/associations/2026-09/{fromObjectType}/{toObjectType}/labels
//   -> { results: [{ category: "HUBSPOT_DEFINED" | "USER_DEFINED", typeId: number, label: string | null }] }
// Scope: any one CRM object read scope (e.g. crm.objects.deals.read) is accepted by this endpoint.
// Note: typeIds are per DIRECTION. Deal->Contact and Contact->Deal have different typeIds for the same label.

import { hsRequest } from '../lib/http.js';
import { portalIdForToken } from '../lib/rate-limiter.js';
import type { LabelDefinition } from '../store/db.js';

export const ASSOCIATIONS_VERSION = '2026-09';

export interface RawLabel {
  category: string;
  typeId: number;
  label: string | null;
}

/**
 * Fresh read (no cache). The result is also written to the in-memory label cache below, when we know the token's
 * portal (src/lib/rate-limiter.ts token registry), so a sync right after the worker's lookup costs no extra call.
 */
export async function listLabelsRaw(token: string, fromObjectType: string, toObjectType: string): Promise<{ results: RawLabel[] }> {
  // GET /crm/associations/2026-09/{fromObjectType}/{toObjectType}/labels
  // https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associations-schema/labels/get-associations-label
  const res = await hsRequest<{ results: RawLabel[] }>(
    `/crm/associations/${ASSOCIATIONS_VERSION}/${encodeURIComponent(fromObjectType)}/${encodeURIComponent(toObjectType)}/labels`,
    { token },
  );
  const portalId = portalIdForToken(token);
  if (portalId !== undefined) labelCache.set(cacheKey(portalId, fromObjectType, toObjectType), { at: Date.now(), value: res });
  return res;
}

// ---------- in-memory cache: one entry per (portal, fromType, toType) ----------
// Label definitions change rarely. The worker's durable cache is the store (label_definitions) and it only calls
// listLabels when a typeId is unknown. This cache is for the property/option sync (both directions, per object type,
// possibly for both sides of a pair) so the same definitions are fetched once, not once per object type or event.

/** Default max age for cached label lists. Short, because a sync usually runs BECAUSE a label was just added. */
export const LABEL_CACHE_MAX_AGE_MS = 10_000;
const labelCache = new Map<string, { at: number; value: { results: RawLabel[] } }>();
const labelInflight = new Map<string, Promise<{ results: RawLabel[] }>>();
const cacheKey = (portalId: number, from: string, to: string) => `${portalId}|${from}|${to}`;

/**
 * Label definitions for (portal, from, to), served from memory when younger than maxAgeMs.
 * Concurrent misses for the same key share one request. forceRefresh skips the cache (still single-flight).
 */
export async function getLabelsCached(
  token: string,
  portalId: number,
  fromObjectType: string,
  toObjectType: string,
  opts: { maxAgeMs?: number; forceRefresh?: boolean; now?: () => number; fetch?: typeof listLabelsRaw } = {},
): Promise<{ results: RawLabel[] }> {
  const now = opts.now ?? Date.now;
  const k = cacheKey(portalId, fromObjectType, toObjectType);
  const hit = labelCache.get(k);
  if (!opts.forceRefresh && hit && now() - hit.at <= (opts.maxAgeMs ?? LABEL_CACHE_MAX_AGE_MS)) return hit.value;
  const pending = labelInflight.get(k);
  if (pending) return pending;
  const p = (async () => {
    try {
      const value = await (opts.fetch ?? listLabelsRaw)(token, fromObjectType, toObjectType);
      labelCache.set(k, { at: now(), value });
      return value;
    } finally {
      labelInflight.delete(k);
    }
  })();
  labelInflight.set(k, p);
  return p;
}

/** Drop cached labels for one portal (uninstall, settings change) or all. */
export function clearLabelCache(portalId?: number): void {
  if (portalId === undefined) return labelCache.clear();
  for (const k of labelCache.keys()) if (k.startsWith(`${portalId}|`)) labelCache.delete(k);
}

/** Same data, in the shape the store / label cache uses. */
export async function listLabels(token: string, fromObjectType: string, toObjectType: string): Promise<LabelDefinition[]> {
  const { results } = await listLabelsRaw(token, fromObjectType, toObjectType);
  return results.map((r) => ({ associationTypeId: r.typeId, label: r.label, category: r.category }));
}

/** typeId -> label (null = unlabeled default). */
export function toLabelMap(defs: LabelDefinition[]): Map<number, LabelDefinition> {
  return new Map(defs.map((d) => [d.associationTypeId, d]));
}
