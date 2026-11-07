import { labelPairKey } from './keys.js';
import { categoryIsStructural, type StructuralCheck } from './pairing.js';
import type { AssociationEntry, LabelDefinition, LabelRef } from './types.js';

/** Fetches all label definitions for one direction of an object pair (e.g. 0-3 -> 0-1). Injected; does HTTP elsewhere. */
export type LabelFetcher = (portalId: number, fromObjectTypeId: string, toObjectTypeId: string) => Promise<LabelDefinition[]>;

export interface LabelLookup {
  /** null = known type with no label (e.g. HUBSPOT_DEFINED default). */
  label: string | null;
  category: string;
}

/** Label lookups. The worker's implementation is src/worker/label-guard.ts (store-backed, holds instead of guessing). */
export interface LabelCache {
  /**
   * undefined = give up on this type id (the caller stamps it as unresolved). Throws LabelHoldError while the name
   * cannot be known yet: the poller then parks that portal's entries and retries them on the next run.
   */
  get(portalId: number, fromObjectTypeId: string, toObjectTypeId: string, associationTypeId: number): Promise<LabelLookup | undefined>;
  /**
   * The type id of the label named `label` in the direction from -> to (refreshing once if not cached). Used only to
   * translate a label to the other direction for mirror stamps (type ids are per direction). undefined = no unique match
   * (e.g. a paired label like "Manager"/"Employee", whose two sides have different names).
   */
  findByName(portalId: number, fromObjectTypeId: string, toObjectTypeId: string, label: string): Promise<number | undefined>;
}

/** A label lookup that cannot be answered yet (fetch failed, type id not visible yet, option sync failed). */
export class LabelHoldError extends Error {
  constructor(public holdKey: string, detail: string) {
    super(`Label lookup held (${holdKey}): ${detail}`);
    this.name = 'LabelHoldError';
  }
}

/**
 * Builds the sync `isStructural` check that pairing needs, by looking up every distinct association
 * type in `entries` up front (pairing itself is pure and sync).
 * Rule (real journal data, 2026-10-30): label === null -> structural, whatever the category (custom object pairs
 * use USER_DEFINED for their unlabeled default). Unknown type -> fall back to HUBSPOT_DEFINED.
 */
export async function buildStructuralCheck(entries: AssociationEntry[], labels: LabelCache): Promise<StructuralCheck> {
  const keyOf = (portalId: number, r: LabelRef) => labelPairKey(portalId, r.fromObjectTypeId, r.toObjectTypeId, r.associationTypeId);
  const known = new Map<string, boolean>();
  const todo = new Map<string, { portalId: number; ref: LabelRef }>();
  for (const { event: e } of entries) {
    const r: LabelRef = {
      fromObjectTypeId: e.fromObjectTypeId,
      toObjectTypeId: e.toObjectTypeId,
      associationTypeId: e.associationTypeId,
      associationCategory: e.associationCategory,
    };
    todo.set(keyOf(e.portalId, r), { portalId: e.portalId, ref: r });
  }
  for (const [k, { portalId, ref: r }] of todo) {
    const hit = await labels.get(portalId, r.fromObjectTypeId, r.toObjectTypeId, r.associationTypeId);
    if (hit) known.set(k, hit.label === null);
  }
  return (portalId, r) => known.get(keyOf(portalId, r)) ?? categoryIsStructural(portalId, r);
}
