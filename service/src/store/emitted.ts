// Late-half absorption memory (emitted_actions): recently emitted changes, one row per stamped record.
// Implements core's EmittedActionStore (src/core/absorb.ts). Schema in schema.ts.

import { keyRange } from '../core/keys.js';
import type { EmittedAction } from '../core/absorb.js';
import type { ChangeType } from '../core/types.js';
import type { Db } from './sqlite.js';

/**
 * Late-half absorption memory (emitted_actions): how long we remember a change we emitted, so a late journal half of
 * the SAME user action (same record pair + identical occurredAt) can be absorbed / amended instead of becoming an
 * extra change. Under load halves were seen up to ~30 s apart; 10 min is a wide margin and keeps the table tiny.
 */
export const EMITTED_ACTIONS_TTL_MS = 10 * 60 * 1000;

type Row = Record<string, number | string | null>;

export class EmittedActions {
  constructor(private readonly c: Db) {}

  /** Remember emitted changes (one row per stamped record). Replaces an older row of the same action + record. */
  saveEmittedActions(rows: EmittedAction[], now: number): void {
    this.c.transaction(() => {
      const st = this.c.stmt(
        `INSERT OR REPLACE INTO emitted_actions (action_key, record_key, portal_id, change_id, change_type, other_type_id,
           labels_before_json, labels_after_json, removed_json, added_json, occurred_at_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows)
        st.run(r.actionKey, r.recordKey, r.portalId, r.changeId, r.changeType, r.otherTypeId,
          r.labelsBefore ? JSON.stringify(r.labelsBefore) : null, r.labelsAfter ? JSON.stringify(r.labelsAfter) : null,
          JSON.stringify(r.removed), JSON.stringify(r.added), r.occurredAtMs, now);
    });
  }
  /** Rows of one action still inside the TTL. */
  getEmittedActions(actionKey: string, now: number, ttlMs: number = EMITTED_ACTIONS_TTL_MS): EmittedAction[] {
    const rows = this.c.stmt('SELECT * FROM emitted_actions WHERE action_key = ? AND created_at >= ? ORDER BY record_key')
      .all(actionKey, now - ttlMs) as Row[];
    const arr = (v: number | string | null) => (v === null ? undefined : (JSON.parse(String(v)) as string[]));
    return rows.map((r) => ({
      actionKey: String(r.action_key),
      recordKey: String(r.record_key),
      portalId: Number(r.portal_id),
      changeId: String(r.change_id),
      changeType: String(r.change_type) as ChangeType,
      otherTypeId: String(r.other_type_id),
      labelsBefore: arr(r.labels_before_json),
      labelsAfter: arr(r.labels_after_json),
      removed: arr(r.removed_json) ?? [],
      added: arr(r.added_json) ?? [],
      occurredAtMs: Number(r.occurred_at_ms),
    }));
  }
  /**
   * Emitted actions on one record pair (direction-insensitive pairKey) whose occurredAt is within windowMs of
   * occurredAtMs (inside the TTL). Joins the two halves of a label swap that HubSpot gave different occurredAts.
   */
  getEmittedActionsNear(pairKey: string, occurredAtMs: number, windowMs: number, now: number, ttlMs: number = EMITTED_ACTIONS_TTL_MS): EmittedAction[] {
    // action_key = actionKey(pairKey, ms): the range is exactly "starts with pairKey|".
    const keys = this.c.stmt(
      'SELECT DISTINCT action_key FROM emitted_actions WHERE action_key > ? AND action_key < ? AND occurred_at_ms BETWEEN ? AND ? AND created_at >= ?',
    ).all(...keyRange(pairKey), occurredAtMs - windowMs, occurredAtMs + windowMs, now - ttlMs) as { action_key: string }[];
    return keys.flatMap((k) => this.getEmittedActions(k.action_key, now, ttlMs));
  }
  pruneEmittedActions(now: number = Date.now(), ttlMs: number = EMITTED_ACTIONS_TTL_MS): number {
    return this.c.pruneOlderThan('emitted_actions', 'created_at', now - ttlMs);
  }
}
