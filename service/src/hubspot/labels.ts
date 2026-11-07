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

import { HUBSPOT_API_VERSION, hsRequest, type PortalAuth } from '../lib/http.js';
import type { LabelDefinition } from '../core/types.js';
import { labelPairKey } from '../core/keys.js';

export interface RawLabel {
  category: string;
  typeId: number;
  label: string | null;
}

type LabelList = { results: RawLabel[] };

/** Fresh read (no cache). */
export async function listLabelsRaw(auth: PortalAuth, fromObjectType: string, toObjectType: string): Promise<LabelList> {
  return hsRequest<LabelList>(
    `/crm/associations/${HUBSPOT_API_VERSION}/${encodeURIComponent(fromObjectType)}/${encodeURIComponent(toObjectType)}/labels`,
    { ...auth },
  );
}

/** Same data, in the shape the store / label cache uses. */
export async function listLabels(auth: PortalAuth, fromObjectType: string, toObjectType: string): Promise<LabelDefinition[]> {
  const { results } = await listLabelsRaw(auth, fromObjectType, toObjectType);
  return results.map((r) => ({ associationTypeId: r.typeId, label: r.label, category: r.category }));
}

/**
 * Short-lived label lists per (portal, from, to), owned by the caller that creates it. Concurrent misses for the same
 * key share one request. The worker's durable label cache is the store (label_definitions); this one only spares the
 * dropdown option sync repeat reads of the same direction.
 */
export class LabelListCache {
  private readonly entries = new Map<string, { at: number; value: LabelList }>();
  private readonly inflight = new Map<string, Promise<LabelList>>();

  /** maxAgeMs is short because a sync usually runs BECAUSE a label was just added. */
  constructor(
    private readonly opts: { fetch?: typeof listLabelsRaw; now?: () => number; maxAgeMs?: number } = {},
  ) {}

  get(auth: PortalAuth, fromObjectType: string, toObjectType: string): Promise<LabelList> {
    const now = this.opts.now ?? Date.now;
    const k = labelPairKey(auth.portalId, fromObjectType, toObjectType);
    const hit = this.entries.get(k);
    if (hit && now() - hit.at <= (this.opts.maxAgeMs ?? 10_000)) return Promise.resolve(hit.value);
    const pending = this.inflight.get(k);
    if (pending) return pending;
    const p = (this.opts.fetch ?? listLabelsRaw)(auth, fromObjectType, toObjectType)
      .then((value) => {
        this.entries.set(k, { at: now(), value });
        return value;
      })
      .finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }
}
