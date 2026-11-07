// Every stamp table query in one place: the persisted delayed-stamp queue (stamp_queue, incl. the fair per-portal
// drain and the ONE "next due" rule), per-record spacing (stamp_last), refused stamps (stamp_dead_letter) and
// revoked-token pauses (portal_pause). Used by src/worker/stamp-queue.ts, the worker's health/loop and late-half
// absorption (src/core/absorb.ts). Schema in schema.ts.

import { decodeStampUpdate, encodeStampUpdate, type StampUpdate } from '../core/stamp.js';
import type { Db } from './sqlite.js';

/** Last-stamp times only matter for spacing (seconds), so a day is plenty. */
export const STAMP_LAST_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Hot statements, used as-is below and planned by store.test.ts (EXPLAIN QUERY PLAN). */
export const STAMP_SQL = {
  getLastStampAt: 'SELECT stamped_at FROM stamp_last WHERE record_key = ?',
  // Next due row of an unpaused portal: walks the due index and stops at the first one (skips only paused rows).
  nextUnpausedDue: 'SELECT not_before FROM stamp_queue WHERE portal_id NOT IN (SELECT portal_id FROM portal_pause) ORDER BY not_before LIMIT 1',
  nextProbe: 'SELECT MIN(next_try_at) AS m FROM portal_pause WHERE portal_id IN (SELECT portal_id FROM stamp_queue)',
  firstQueuedFor: 'SELECT change_id, not_before FROM stamp_queue WHERE record_key = ? ORDER BY occurred_at_ms, change_id LIMIT 1',
  queuedFor: 'SELECT * FROM stamp_queue WHERE record_key = ? ORDER BY occurred_at_ms, change_id',
  queuedCountFor: 'SELECT COUNT(*) AS n FROM stamp_queue WHERE record_key = ?',
  // Fair drain: one portal's backlog never hides another portal's due rows.
  portalsWithDue: 'SELECT DISTINCT portal_id FROM stamp_queue WHERE not_before <= ? ORDER BY portal_id',
  dueForPortal: 'SELECT * FROM stamp_queue WHERE portal_id = ? AND not_before <= ? ORDER BY not_before, occurred_at_ms, change_id LIMIT ?',
} as const;

/** One delayed stamp waiting in the persisted queue. */
export interface QueuedStamp {
  changeId: string;
  portalId: number;
  recordKey: string;
  update: StampUpdate;
  notBefore: number;
  attempts: number;
  lastError: string | null;
}

/** A portal whose token is revoked/invalid: its queue is kept and probed at nextTryAt. */
export interface PortalPause {
  portalId: number;
  since: number;
  nextTryAt: number;
  reason: string | null;
}

type Row = Record<string, number | string | null>;

const toPause = (r: Row): PortalPause => ({
  portalId: Number(r.portal_id),
  since: Number(r.since),
  nextTryAt: Number(r.next_try_at),
  reason: r.reason === null ? null : String(r.reason),
});

const toQueued = (r: Row): QueuedStamp => ({
  changeId: String(r.change_id),
  portalId: Number(r.portal_id),
  recordKey: String(r.record_key),
  update: decodeStampUpdate(String(r.update_json)),
  notBefore: Number(r.not_before),
  attempts: Number(r.attempts),
  lastError: r.last_error === null || r.last_error === undefined ? null : String(r.last_error),
});

export class StampStore {
  constructor(private readonly c: Db) {}

  // --- stamp_queue ---
  /** Idempotent on changeId: a change that is already queued keeps its slot. Returns how many were new. */
  enqueueStamps(items: { changeId: string; recordKey: string; update: StampUpdate; notBefore: number }[], now: number): number {
    let added = 0;
    this.c.transaction(() => {
      const ins = this.c.stmt(
        `INSERT OR IGNORE INTO stamp_queue (change_id, portal_id, record_key, update_json, not_before, occurred_at_ms, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      );
      for (const i of items)
        added += Number(ins.run(i.changeId, i.update.portalId, i.recordKey, encodeStampUpdate(i.update), i.notBefore, i.update.occurredAtMs, now).changes);
    });
    return added;
  }
  /** The oldest queued change for one record (by change time). Only this one may be sent next, to keep order. */
  firstQueuedFor(recordKey: string): { changeId: string; notBefore: number } | undefined {
    const r = this.c.stmt(STAMP_SQL.firstQueuedFor).get(recordKey) as { change_id: string; not_before: number } | undefined;
    return r && { changeId: r.change_id, notBefore: r.not_before };
  }
  /** Stamps still waiting in the queue for one record (any kind), in send order. */
  queuedFor(recordKey: string): QueuedStamp[] {
    return (this.c.stmt(STAMP_SQL.queuedFor).all(recordKey) as Row[]).map(toQueued);
  }
  /**
   * The ONE "next due" rule (worker loop and /health): the earliest due row of an unpaused portal, or the next probe
   * of a paused portal with something queued. null = nothing queued.
   */
  nextDueAt(): number | null {
    const r = this.c.stmt(STAMP_SQL.nextUnpausedDue).get() as { not_before: number } | undefined;
    const p = this.c.stmt(STAMP_SQL.nextProbe).get() as { m: number | null };
    const vals = [r?.not_before ?? null, p.m].filter((v): v is number => v !== null);
    return vals.length ? Math.min(...vals) : null;
  }
  /** Stamps waiting in the queue for these records. */
  queuedCountFor(recordKeys: string[]): number {
    const q = this.c.stmt(STAMP_SQL.queuedCountFor);
    return recordKeys.reduce((sum, k) => sum + Number((q.get(k) as { n: number }).n), 0);
  }
  queueSize(): number {
    return Number((this.c.stmt('SELECT COUNT(*) AS n FROM stamp_queue').get() as { n: number }).n);
  }
  queueDepthByPortal(): Map<number, number> {
    const rows = this.c.stmt('SELECT portal_id, COUNT(*) AS n FROM stamp_queue GROUP BY portal_id').all() as Row[];
    return new Map(rows.map((r) => [Number(r.portal_id), Number(r.n)]));
  }
  /** Portals that have at least one due row, ordered by portal id (the drain rotates over them). */
  portalsWithDue(now: number): number[] {
    return (this.c.stmt(STAMP_SQL.portalsWithDue).all(now) as Row[]).map((r) => Number(r.portal_id));
  }
  dueForPortal(portalId: number, now: number, limit: number): QueuedStamp[] {
    return (this.c.stmt(STAMP_SQL.dueForPortal).all(portalId, now, limit) as Row[]).map(toQueued);
  }
  deleteQueued(changeIds: string[]): void {
    this.c.transaction(() => {
      const del = this.c.stmt('DELETE FROM stamp_queue WHERE change_id = ?');
      for (const id of changeIds) del.run(id);
    });
  }
  /** Move queued stamps to a later slot. countAttempt=true for a failed send (not for a spacing shift). */
  deferQueued(changeIds: string[], notBefore: number, opts: { error?: string; countAttempt?: boolean } = {}): void {
    this.c.transaction(() => {
      const st = this.c.stmt('UPDATE stamp_queue SET not_before = ?, attempts = attempts + ?, last_error = COALESCE(?, last_error) WHERE change_id = ?');
      for (const id of changeIds) st.run(notBefore, opts.countAttempt ? 1 : 0, opts.error?.slice(0, 500) ?? null, id);
    });
  }
  /**
   * HubSpot throttled this portal: nothing of it may be due before `until` (rows already due AND rows that would
   * become due meanwhile). One UPDATE; attempts are not counted.
   */
  deferPortalUntil(portalId: number, until: number): void {
    this.c.stmt('UPDATE stamp_queue SET not_before = ? WHERE portal_id = ? AND not_before < ?').run(until, portalId, until);
  }
  /** Change a queued row's slot and (coalesced count) properties. */
  reslot(items: { changeId: string; update: StampUpdate; notBefore: number }[]): void {
    if (!items.length) return;
    this.c.transaction(() => {
      const st = this.c.stmt('UPDATE stamp_queue SET not_before = ?, update_json = ? WHERE change_id = ?');
      for (const i of items) st.run(i.notBefore, encodeStampUpdate(i.update), i.changeId);
    });
  }
  /** Merge properties into a queued (not yet sent) stamp. False if the change is not queued any more. */
  mergeQueuedProperties(changeId: string, props: Partial<Record<string, string>>): boolean {
    const r = this.c.stmt('SELECT update_json FROM stamp_queue WHERE change_id = ?').get(changeId) as { update_json: string } | undefined;
    if (!r) return false;
    const u = decodeStampUpdate(r.update_json);
    u.properties = { ...u.properties, ...props };
    this.c.stmt('UPDATE stamp_queue SET update_json = ? WHERE change_id = ?').run(encodeStampUpdate(u), changeId);
    return true;
  }

  // --- stamp_last (persisted per-record spacing) ---
  getLastStampAt(recordKey: string): number | undefined {
    const r = this.c.stmt(STAMP_SQL.getLastStampAt).get(recordKey) as { stamped_at: number } | undefined;
    return r?.stamped_at;
  }
  setLastStampAt(recordKeys: string[], at: number): void {
    this.c.transaction(() => {
      const st = this.c.stmt(
        'INSERT INTO stamp_last (record_key, stamped_at) VALUES (?, ?) ON CONFLICT(record_key) DO UPDATE SET stamped_at = MAX(stamped_at, excluded.stamped_at)',
      );
      for (const k of recordKeys) st.run(k, at);
    });
  }
  /** Remember which change each record now shows (normal stamps only, never amend stamps). */
  setLastStampedChange(items: { recordKey: string; changeId: string }[], at: number): void {
    this.c.transaction(() => {
      const st = this.c.stmt(
        `INSERT INTO stamp_last (record_key, stamped_at, last_change_id) VALUES (?, ?, ?)
         ON CONFLICT(record_key) DO UPDATE SET last_change_id = excluded.last_change_id, stamped_at = MAX(stamped_at, excluded.stamped_at)`,
      );
      for (const i of items) st.run(i.recordKey, at, i.changeId);
    });
  }
  /** The change id the record shows (the last normal stamp we sent). undefined = unknown. */
  getLastStampedChange(recordKey: string): string | undefined {
    const r = this.c.stmt('SELECT last_change_id FROM stamp_last WHERE record_key = ?').get(recordKey) as { last_change_id: string | null } | undefined;
    return r?.last_change_id ?? undefined;
  }
  pruneStampLast(now: number = Date.now(), maxAgeMs: number = STAMP_LAST_RETENTION_MS): number {
    return this.c.pruneOlderThan('stamp_last', 'stamped_at', now - maxAgeMs);
  }

  // --- stamp_dead_letter (refused stamps, never silently deleted) ---
  deadLetter(items: { q: QueuedStamp; error: string }[], now: number): void {
    if (!items.length) return;
    this.c.transaction(() => {
      const ins = this.c.stmt(
        `INSERT INTO stamp_dead_letter (change_id, portal_id, record_key, update_json, error, attempts, first_at, last_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(change_id) DO UPDATE SET error = excluded.error, attempts = excluded.attempts, last_at = excluded.last_at`,
      );
      for (const { q, error } of items)
        ins.run(q.changeId, q.portalId, q.recordKey, encodeStampUpdate(q.update), error.slice(0, 500), q.attempts + 1, now, now);
    });
  }
  deadLetterCounts(): Map<number, number> {
    const rows = this.c.stmt('SELECT portal_id, COUNT(*) AS n FROM stamp_dead_letter GROUP BY portal_id').all() as Row[];
    return new Map(rows.map((r) => [Number(r.portal_id), Number(r.n)]));
  }

  // --- portal_pause (revoked/invalid token: queue kept, probed, never dropped) ---
  getPause(portalId: number): PortalPause | undefined {
    const r = this.c.stmt('SELECT * FROM portal_pause WHERE portal_id = ?').get(portalId) as Row | undefined;
    return r && toPause(r);
  }
  listPauses(): PortalPause[] {
    return (this.c.stmt('SELECT * FROM portal_pause ORDER BY since').all() as Row[]).map(toPause);
  }
  /** Start a pause (keeps the original `since`) and set the next probe time. */
  pause(portalId: number, now: number, nextTryAt: number, reason: string): PortalPause {
    this.c
      .stmt(
        `INSERT INTO portal_pause (portal_id, since, next_try_at, reason) VALUES (?, ?, ?, ?)
         ON CONFLICT(portal_id) DO UPDATE SET next_try_at = excluded.next_try_at, reason = excluded.reason`,
      )
      .run(portalId, now, nextTryAt, reason.slice(0, 500));
    return this.getPause(portalId)!;
  }
  unpause(portalId: number): boolean {
    return Number(this.c.stmt('DELETE FROM portal_pause WHERE portal_id = ?').run(portalId).changes) > 0;
  }
}
