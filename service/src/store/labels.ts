// Label state per portal: label definitions per object pair (label_cache + label_cache_fetches), held lookups
// (label_holds), known label sets per record pair (association_labels) and dropdown-sync markers (labels_synced).
// Used by the worker's label cache (src/worker/label-guard.ts) and, as core's LabelStateReader, by resolve.ts.
// Schema in schema.ts.

import type { LabelDefinition } from '../core/types.js';
import type { Db } from './sqlite.js';

/** Known label sets per record pair. Older than this = we stop remembering (labels before become "(unknown)"). */
export const ASSOCIATION_LABELS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * Label definitions per object pair (label_cache). Dropped when not re-fetched for this long; the next event for that
 * pair is a cache miss and re-fetches them (one API call). Keeps label names of portals that stopped using a pair from
 * living forever.
 */
export const LABEL_CACHE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Hot statements, used as-is below and planned by store.test.ts (EXPLAIN QUERY PLAN). */
export const LABEL_SQL = {
  getLabel: 'SELECT label, category, fetched_at FROM label_cache WHERE portal_id = ? AND from_type = ? AND to_type = ? AND type_id = ?',
} as const;

type Row = Record<string, number | string | null>;

/** One cached label definition row (label_cache). */
export interface LabelRow {
  label: string | null;
  category: string;
  fetchedAt: number;
}

export class LabelStore {
  constructor(private readonly c: Db) {}

  // --- label_cache ---
  getLabel(portalId: number, fromType: string, toType: string, typeId: number): LabelRow | undefined {
    const row = this.c.stmt(LABEL_SQL.getLabel)
      .get(portalId, fromType, toType, typeId) as { label: string | null; category: string; fetched_at: number } | undefined;
    return row && { label: row.label, category: row.category, fetchedAt: row.fetched_at };
  }
  /** Replace the cached definitions for one object pair (direction matters). */
  replaceLabels(portalId: number, fromType: string, toType: string, defs: LabelDefinition[], now: number): void {
    this.c.transaction(() => {
      this.c.stmt('DELETE FROM label_cache WHERE portal_id = ? AND from_type = ? AND to_type = ?').run(portalId, fromType, toType);
      const ins = this.c.stmt('INSERT INTO label_cache (portal_id, from_type, to_type, type_id, label, category, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const d of defs) ins.run(portalId, fromType, toType, d.associationTypeId, d.label, d.category, now);
      this.c.stmt('INSERT INTO label_cache_fetches (portal_id, from_type, to_type, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET fetched_at = excluded.fetched_at')
        .run(portalId, fromType, toType, now);
    });
  }
  /**
   * TTL: drop label definitions (and their fetch marker) not re-fetched for maxAgeMs. replaceLabels writes both with
   * the same timestamp, so a pair is dropped as a whole and the next lookup re-fetches it. Indexed + chunked.
   */
  pruneLabelCache(now: number = Date.now(), maxAgeMs: number = LABEL_CACHE_RETENTION_MS): number {
    const cutoff = now - maxAgeMs;
    return this.c.pruneOlderThan('label_cache_fetches', 'fetched_at', cutoff) + this.c.pruneOlderThan('label_cache', 'fetched_at', cutoff);
  }
  /** All cached definitions for one object pair (direction matters). */
  listLabels(portalId: number, fromType: string, toType: string): LabelDefinition[] {
    const rows = this.c.stmt('SELECT type_id, label, category FROM label_cache WHERE portal_id = ? AND from_type = ? AND to_type = ? ORDER BY type_id')
      .all(portalId, fromType, toType) as { type_id: number; label: string | null; category: string }[];
    return rows.map((r) => ({ associationTypeId: Number(r.type_id), label: r.label, category: r.category }));
  }
  getLabelsFetchedAt(portalId: number, fromType: string, toType: string): number | null {
    const row = this.c.stmt('SELECT fetched_at FROM label_cache_fetches WHERE portal_id = ? AND from_type = ? AND to_type = ?')
      .get(portalId, fromType, toType) as { fetched_at: number } | undefined;
    return row?.fetched_at ?? null;
  }

  // --- labels_synced (type ids whose dropdown options were synced for one object pair; scope 'mirror' = STAMP_MIRROR on) ---
  getSyncedTypeIds(portalId: number, fromType: string, toType: string, scope = ''): number[] {
    const r = this.c.stmt('SELECT type_ids_json FROM labels_synced WHERE portal_id = ? AND scope = ? AND from_type = ? AND to_type = ?')
      .get(portalId, scope, fromType, toType) as { type_ids_json: string } | undefined;
    return r ? (JSON.parse(r.type_ids_json) as number[]) : [];
  }
  setSyncedTypeIds(portalId: number, fromType: string, toType: string, typeIds: number[], scope = ''): void {
    this.c.stmt(
      `INSERT INTO labels_synced (portal_id, scope, from_type, to_type, type_ids_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(portal_id, scope, from_type, to_type) DO UPDATE SET type_ids_json = excluded.type_ids_json`,
    ).run(portalId, scope, fromType, toType, JSON.stringify(typeIds));
  }
  /** Forget every marker that touches this object type (either side, all scopes): its next event announces again. */
  clearSyncedFor(portalId: number, objectType: string): number {
    return Number(this.c.stmt('DELETE FROM labels_synced WHERE portal_id = ? AND (from_type = ? OR to_type = ?)').run(portalId, objectType, objectType).changes);
  }

  // --- label_holds ---
  /** Start (or keep) a hold. Returns when the failures started. */
  noteLabelHold(key: string, now: number, error: string): number {
    this.c.stmt('INSERT INTO label_holds (hold_key, first_failed_at, last_error) VALUES (?, ?, ?) ON CONFLICT(hold_key) DO UPDATE SET last_error = excluded.last_error')
      .run(key, now, error.slice(0, 500));
    return Number((this.c.stmt('SELECT first_failed_at FROM label_holds WHERE hold_key = ?').get(key) as { first_failed_at: number }).first_failed_at);
  }
  clearLabelHold(key: string): void {
    this.c.stmt('DELETE FROM label_holds WHERE hold_key = ?').run(key);
  }
  listLabelHolds(): { key: string; firstFailedAt: number; lastError: string | null }[] {
    return (this.c.stmt('SELECT * FROM label_holds ORDER BY first_failed_at').all() as Row[]).map((r) => ({
      key: String(r.hold_key),
      firstFailedAt: Number(r.first_failed_at),
      lastError: r.last_error === null ? null : String(r.last_error),
    }));
  }

  // --- association_labels (known label state per record pair) ---
  getAssociationLabels(pairKey: string): string[] | undefined {
    const row = this.c.stmt('SELECT labels_json FROM association_labels WHERE pair_key = ?').get(pairKey) as { labels_json: string } | undefined;
    return row ? JSON.parse(row.labels_json) : undefined;
  }
  setAssociationLabels(pairKey: string, labels: string[], now: number): void {
    this.c.stmt('INSERT INTO association_labels (pair_key, labels_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(pair_key) DO UPDATE SET labels_json = excluded.labels_json, updated_at = excluded.updated_at')
      .run(pairKey, JSON.stringify(labels), now);
  }
  deleteAssociationLabels(pairKey: string): void {
    this.c.stmt('DELETE FROM association_labels WHERE pair_key = ?').run(pairKey);
  }
  pruneAssociationLabels(now: number = Date.now(), maxAgeMs: number = ASSOCIATION_LABELS_RETENTION_MS): number {
    return this.c.pruneOlderThan('association_labels', 'updated_at', now - maxAgeMs);
  }
}
