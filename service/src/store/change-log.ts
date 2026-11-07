// change_log: every emitted change per stamped record (lookups by change id, corrections by late-half absorption).
// Schema in schema.ts.

import type { ChangeRecord } from '../core/stamp.js';
import type { ChangeType } from '../core/types.js';
import type { Db } from './sqlite.js';

export const CHANGE_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // change-id lookups work for 30 days

/** Hot statements, used as-is below and planned by store.test.ts (EXPLAIN QUERY PLAN). */
export const CHANGE_LOG_SQL = {
  getChange: 'SELECT * FROM change_log WHERE change_id = ? AND portal_id = ?',
  changesSince: 'SELECT * FROM change_log WHERE portal_id = ? AND object_type_id = ? AND created_at >= ?',
} as const;

/** One change_log row. supersededBy = the change that corrected it after it was stamped (late split), else null. */
export type LoggedChange = ChangeRecord & { createdAt: number; supersededBy: string | null };

type Row = Record<string, number | string | null>;

export class ChangeLog {
  constructor(private readonly c: Db) {}

  /** Insert change records. Idempotent: an existing change_id is left as it is (same journal input -> same row). */
  saveChanges(records: ChangeRecord[], now: number = Date.now()): void {
    this.c.transaction(() => {
      const ins = this.c.stmt(
        `INSERT OR IGNORE INTO change_log (change_id, portal_id, object_type_id, object_id, change_type, other_object_type,
           other_record_id, label_before, label_after, labels_current, association_category, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of records)
        ins.run(r.changeId, r.portalId, r.objectTypeId, r.objectId, r.changeType, r.otherObjectType, r.otherRecordId,
          r.labelBefore, r.labelAfter, r.labelsCurrent, r.associationCategory, r.occurredAt, now);
    });
  }
  /** Look up one change. portalId is part of the key so one portal can never read another portal's change. */
  getChange(portalId: number, changeId: string): LoggedChange | undefined {
    const r = this.c.stmt(CHANGE_LOG_SQL.getChange).get(changeId, portalId) as Row | undefined;
    return r && toLoggedChange(r);
  }
  /** change_log rows of these records (one object type) logged since sinceMs. For tools/checks. */
  changesForRecords(portalId: number, objectTypeId: string, objectIds: string[], sinceMs: number): LoggedChange[] {
    const ids = new Set(objectIds);
    return (this.c.stmt(CHANGE_LOG_SQL.changesSince).all(portalId, objectTypeId, sinceMs) as Row[]).filter((r) => ids.has(String(r.object_id))).map(toLoggedChange);
  }
  pruneChangeLog(now: number = Date.now(), maxAgeMs: number = CHANGE_LOG_RETENTION_MS): number {
    return this.c.pruneOlderThan('change_log', 'created_at', now - maxAgeMs);
  }
  /** Correct an already-logged change (late-half absorption). Only the given fields change. */
  updateChange(
    portalId: number,
    changeId: string,
    f: Partial<Pick<ChangeRecord, 'changeType' | 'labelBefore' | 'labelAfter' | 'labelsCurrent'>>,
  ): void {
    this.c.stmt(
      `UPDATE change_log SET change_type = COALESCE(?, change_type), label_before = COALESCE(?, label_before),
         label_after = COALESCE(?, label_after), labels_current = COALESCE(?, labels_current)
       WHERE change_id = ? AND portal_id = ?`,
    ).run(f.changeType ?? null, f.labelBefore ?? null, f.labelAfter ?? null, f.labelsCurrent ?? null, changeId, portalId);
  }
  /** Mark an already-stamped change as corrected by a later change (late journal half, src/core/absorb.ts). */
  markSuperseded(portalId: number, changeId: string, supersededBy: string): void {
    this.c.stmt('UPDATE change_log SET superseded_by = ? WHERE change_id = ? AND portal_id = ?').run(supersededBy, changeId, portalId);
  }
}

function toLoggedChange(r: Row): LoggedChange {
  return {
    changeId: String(r.change_id),
    portalId: Number(r.portal_id),
    objectTypeId: String(r.object_type_id),
    objectId: String(r.object_id),
    changeType: String(r.change_type) as ChangeType,
    otherObjectType: String(r.other_object_type),
    otherRecordId: String(r.other_record_id),
    labelBefore: String(r.label_before),
    labelAfter: String(r.label_after),
    labelsCurrent: String(r.labels_current),
    associationCategory: String(r.association_category),
    occurredAt: String(r.occurred_at),
    createdAt: Number(r.created_at),
    supersededBy: r.superseded_by === null || r.superseded_by === undefined ? null : String(r.superseded_by),
  };
}
