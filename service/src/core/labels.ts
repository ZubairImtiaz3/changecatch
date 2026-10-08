import type { LabelDefinition, Store } from '../store/db.js';
import { categoryIsStructural, type StructuralCheck } from './pairing.js';
import type { AssociationEntry, LabelRef } from './types.js';

/** Fetches all label definitions for one direction of an object pair (e.g. 0-3 -> 0-1). Injected; does HTTP elsewhere. */
export type LabelFetcher = (portalId: number, fromObjectTypeId: string, toObjectTypeId: string) => Promise<LabelDefinition[]>;

export interface LabelLookup {
  /** null = known type with no label (e.g. HUBSPOT_DEFINED default). */
  label: string | null;
  category: string;
}

export interface LabelCache {
  /** Returns undefined only if the type id is still unknown after a refresh. */
  get(portalId: number, fromObjectTypeId: string, toObjectTypeId: string, associationTypeId: number): Promise<LabelLookup | undefined>;
}

export interface LabelCacheConfig {
  /** Cached rows older than this are refreshed on next use. */
  ttlMs: number;
  /** Don't refetch the same pair more often than this when a type id is missing (avoids hammering on deleted labels). */
  minRefetchMs: number;
}

export const DEFAULT_LABEL_CACHE_CONFIG: LabelCacheConfig = {
  ttlMs: 24 * 60 * 60 * 1000,
  minRefetchMs: 60_000,
};

export class StoreLabelCache implements LabelCache {
  private inflight = new Map<string, Promise<void>>();

  constructor(
    private store: Store,
    private fetcher: LabelFetcher,
    private config: LabelCacheConfig = DEFAULT_LABEL_CACHE_CONFIG,
    private now: () => number = Date.now,
  ) {}

  async get(portalId: number, fromType: string, toType: string, typeId: number): Promise<LabelLookup | undefined> {
    const row = this.store.getLabel(portalId, fromType, toType, typeId);
    const t = this.now();
    if (row && t - row.fetchedAt < this.config.ttlMs) return { label: row.label, category: row.category };

    const lastFetch = this.store.getLabelsFetchedAt(portalId, fromType, toType);
    const mayFetch = lastFetch === null || t - lastFetch >= this.config.minRefetchMs;
    if (mayFetch) await this.refresh(portalId, fromType, toType);

    const fresh = this.store.getLabel(portalId, fromType, toType, typeId);
    return fresh && { label: fresh.label, category: fresh.category };
  }

  /** One fetch per pair at a time, even with concurrent callers. */
  refresh(portalId: number, fromType: string, toType: string): Promise<void> {
    const k = `${portalId}|${fromType}|${toType}`;
    let p = this.inflight.get(k);
    if (!p) {
      p = this.fetcher(portalId, fromType, toType)
        .then((defs) => this.store.replaceLabels(portalId, fromType, toType, defs, this.now()))
        .finally(() => this.inflight.delete(k));
      this.inflight.set(k, p);
    }
    return p;
  }
}

/**
 * Builds the sync `isStructural` check that pairing needs, by looking up every distinct association
 * type in `entries` up front (pairing itself is pure and sync).
 * Rule (real journal data, 2026-10-30): label === null -> structural, whatever the category (custom object pairs
 * use USER_DEFINED for their unlabeled default). Unknown type -> fall back to HUBSPOT_DEFINED.
 */
export async function buildStructuralCheck(entries: AssociationEntry[], labels: LabelCache): Promise<StructuralCheck> {
  const keyOf = (portalId: number, r: LabelRef) => `${portalId}|${r.fromObjectTypeId}|${r.toObjectTypeId}|${r.associationTypeId}`;
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
