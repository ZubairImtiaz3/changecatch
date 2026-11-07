// Journal entries held between runs: pending_pairs (a half waiting for its partner) and parked_entries (per-portal
// parking while a label lookup is held). Both store the entry with core's row codec. Schema in schema.ts.

import { decodeEntry, encodeEntry, type AssociationEntry, type PendingEntry } from '../core/types.js';
import type { Db } from './sqlite.js';

/** Hot statements, used as-is below and planned by store.test.ts (EXPLAIN QUERY PLAN). */
export const ENTRY_SQL = {
  loadParked: 'SELECT entry_json, parked_at FROM parked_entries ORDER BY parked_at, key',
} as const;

export class EntryStore {
  constructor(private readonly c: Db) {}

  // --- pending_pairs ---
  loadPending(): PendingEntry[] {
    const rows = this.c.stmt('SELECT entry_json, hold_until FROM pending_pairs').all() as { entry_json: string; hold_until: number }[];
    return rows.map((r) => ({ entry: decodeEntry(r.entry_json), holdUntil: r.hold_until }));
  }
  replacePending(list: PendingEntry[]): void {
    this.c.transaction(() => {
      this.c.raw.exec('DELETE FROM pending_pairs');
      const ins = this.c.stmt('INSERT OR REPLACE INTO pending_pairs (key, entry_json, hold_until) VALUES (?, ?, ?)');
      for (const p of list) ins.run(p.entry.key, encodeEntry(p.entry), p.holdUntil);
    });
  }

  // --- parked_entries ---
  loadParked(): { entry: AssociationEntry; parkedAt: number }[] {
    const rows = this.c.stmt(ENTRY_SQL.loadParked).all() as { entry_json: string; parked_at: number }[];
    return rows.map((r) => ({ entry: decodeEntry(r.entry_json), parkedAt: Number(r.parked_at) }));
  }
  /** Replace the parked set. Entries already parked keep their first parked_at. */
  replaceParked(entries: AssociationEntry[], now: number): void {
    this.c.transaction(() => {
      const before = new Map(this.loadParked().map((p) => [p.entry.key, p.parkedAt]));
      this.c.raw.exec('DELETE FROM parked_entries');
      const ins = this.c.stmt('INSERT OR IGNORE INTO parked_entries (key, portal_id, entry_json, parked_at) VALUES (?, ?, ?, ?)');
      for (const e of entries) ins.run(e.key, e.event.portalId, encodeEntry(e), before.get(e.key) ?? now);
    });
  }
  parkedCount(): number {
    return Number((this.c.stmt('SELECT COUNT(*) AS n FROM parked_entries').get() as { n: number }).n);
  }
}
