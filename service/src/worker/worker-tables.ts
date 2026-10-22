// Worker-owned SQLite tables and queries (same DB file as src/store/db.ts, created here with IF NOT EXISTS).
// Kept out of src/store so the worker can evolve them on its own. All are small and per-portal.
//
//  stamp_dead_letter : stamps we could not deliver (HubSpot refused the record, or retries ran out after
//                      STAMP_RETRY_MAX_MS). NEVER silently deleted: shown per portal on /health and /metrics,
//                      purged only with the portal's data (uninstall).
//  lifecycle_retry   : APP_INSTALL / APP_UNINSTALL handling that failed. The shared journal offset moves on; the
//                      worker retries these with back-off outside the journal path (scale-review C2).
//  portal_pause      : portals whose token is revoked/invalid (401 after refresh, invalid_grant). Their queue is
//                      KEPT and probed hourly; after PORTAL_PAUSE_MAX_MS (7 days) without a reinstall the portal is
//                      purged via the uninstall routine.
//  worker_lock       : single-row lock with a heartbeat, so a second worker process refuses to start.
//
// Plus fair-drain queries on stamp_queue (one portal's backlog never hides another portal's due rows).

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { StampUpdate } from '../core/stamp.js';
import type { QueuedStamp, Store } from '../store/db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stamp_dead_letter (
  change_id TEXT PRIMARY KEY,
  portal_id INTEGER NOT NULL,
  record_key TEXT NOT NULL,
  update_json TEXT NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS stamp_dead_letter_portal ON stamp_dead_letter (portal_id);
CREATE TABLE IF NOT EXISTS lifecycle_retry (
  portal_id INTEGER PRIMARY KEY,
  event_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS portal_pause (
  portal_id INTEGER PRIMARY KEY,
  since INTEGER NOT NULL,
  next_try_at INTEGER NOT NULL,
  reason TEXT
);
CREATE TABLE IF NOT EXISTS worker_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  worker_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  host TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS stamp_queue_portal_due ON stamp_queue (portal_id, not_before);
`;

type Row = Record<string, number | string | null>;

export interface DeadLetter {
  changeId: string;
  portalId: number;
  recordKey: string;
  update: StampUpdate;
  error: string | null;
  attempts: number;
  firstAt: number;
  lastAt: number;
}

export interface LifecycleRetryRow {
  portalId: number;
  event: Record<string, unknown> & { portalId: number };
  attempts: number;
  nextAt: number;
  lastError: string | null;
  createdAt: number;
}

export interface PortalPause {
  portalId: number;
  since: number;
  nextTryAt: number;
  reason: string | null;
}

export class WorkerLockError extends Error {
  constructor(public holder: { workerId: string; pid: number; host: string; heartbeatAt: number }, now: number) {
    super(
      `Another ChangeCatch worker is running (worker ${holder.workerId}, pid ${holder.pid} on ${holder.host}, ` +
        `last heartbeat ${Math.round((now - holder.heartbeatAt) / 1000)}s ago). Only ONE worker may read the shared ` +
        `journal offset. Stop the other one, or wait until its heartbeat is older than the lock timeout.`,
    );
    this.name = 'WorkerLockError';
  }
}

const toQueued = (r: Row): QueuedStamp => ({
  changeId: String(r.change_id),
  portalId: Number(r.portal_id),
  recordKey: String(r.record_key),
  update: JSON.parse(String(r.update_json)) as StampUpdate,
  notBefore: Number(r.not_before),
  attempts: Number(r.attempts),
  lastError: r.last_error === null || r.last_error === undefined ? null : String(r.last_error),
});

export class WorkerTables {
  /** Process identity for the worker lock. */
  readonly workerId = randomUUID();

  constructor(readonly store: Store) {
    store.db.exec(SCHEMA);
  }

  private get db() {
    return this.store.db;
  }

  private tx(fn: () => void): void {
    if (this.db.isTransaction) fn();
    else this.store.transaction(fn);
  }

  // ---------------------------------------------------------------- stamp_queue: fair drain + coalesce helpers

  /** Portals that have at least one due row, ordered by portal id (the drain rotates over them). */
  portalsWithDue(now: number): number[] {
    return (this.db.prepare('SELECT DISTINCT portal_id FROM stamp_queue WHERE not_before <= ? ORDER BY portal_id').all(now) as Row[]).map((r) =>
      Number(r.portal_id),
    );
  }

  dueForPortal(portalId: number, now: number, limit: number): QueuedStamp[] {
    return (
      this.db
        .prepare('SELECT * FROM stamp_queue WHERE portal_id = ? AND not_before <= ? ORDER BY not_before, occurred_at_ms, change_id LIMIT ?')
        .all(portalId, now, limit) as Row[]
    ).map(toQueued);
  }

  queuedFor(recordKey: string): QueuedStamp[] {
    return (this.db.prepare('SELECT * FROM stamp_queue WHERE record_key = ?').all(recordKey) as Row[]).map(toQueued);
  }

  /** Change a queued row's slot and (coalesced count) properties. */
  reslot(items: { changeId: string; update: StampUpdate; notBefore: number }[]): void {
    if (!items.length) return;
    this.tx(() => {
      const st = this.db.prepare('UPDATE stamp_queue SET not_before = ?, update_json = ? WHERE change_id = ?');
      for (const i of items) st.run(i.notBefore, JSON.stringify(i.update), i.changeId);
    });
  }

  /** Next due time, ignoring paused portals (they are probed via portal_pause.next_try_at instead). */
  nextDueAt(): number | null {
    const r = this.db
      .prepare('SELECT MIN(not_before) AS m FROM stamp_queue WHERE portal_id NOT IN (SELECT portal_id FROM portal_pause)')
      .get() as { m: number | null };
    const p = this.db
      .prepare('SELECT MIN(next_try_at) AS m FROM portal_pause WHERE portal_id IN (SELECT portal_id FROM stamp_queue)')
      .get() as { m: number | null };
    const vals = [r.m, p.m].filter((v): v is number => v !== null);
    return vals.length ? Math.min(...vals) : null;
  }

  queueDepthByPortal(): Map<number, number> {
    const rows = this.db.prepare('SELECT portal_id, COUNT(*) AS n FROM stamp_queue GROUP BY portal_id').all() as Row[];
    return new Map(rows.map((r) => [Number(r.portal_id), Number(r.n)]));
  }

  // ---------------------------------------------------------------- dead letters

  deadLetter(items: { q: QueuedStamp; error: string }[], now: number): void {
    if (!items.length) return;
    this.tx(() => {
      const ins = this.db.prepare(
        `INSERT INTO stamp_dead_letter (change_id, portal_id, record_key, update_json, error, attempts, first_at, last_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(change_id) DO UPDATE SET error = excluded.error, attempts = excluded.attempts, last_at = excluded.last_at`,
      );
      for (const { q, error } of items)
        ins.run(q.changeId, q.portalId, q.recordKey, JSON.stringify(q.update), error.slice(0, 500), q.attempts + 1, now, now);
    });
  }

  deadLetterCounts(): Map<number, number> {
    const rows = this.db.prepare('SELECT portal_id, COUNT(*) AS n FROM stamp_dead_letter GROUP BY portal_id').all() as Row[];
    return new Map(rows.map((r) => [Number(r.portal_id), Number(r.n)]));
  }

  listDeadLetters(portalId?: number): DeadLetter[] {
    const rows = (
      portalId === undefined
        ? this.db.prepare('SELECT * FROM stamp_dead_letter ORDER BY last_at').all()
        : this.db.prepare('SELECT * FROM stamp_dead_letter WHERE portal_id = ? ORDER BY last_at').all(portalId)
    ) as Row[];
    return rows.map((r) => ({
      changeId: String(r.change_id),
      portalId: Number(r.portal_id),
      recordKey: String(r.record_key),
      update: JSON.parse(String(r.update_json)) as StampUpdate,
      error: r.error === null ? null : String(r.error),
      attempts: Number(r.attempts),
      firstAt: Number(r.first_at),
      lastAt: Number(r.last_at),
    }));
  }

  // ---------------------------------------------------------------- lifecycle retry

  /** One row per portal: a newer lifecycle event replaces an older one (the handler checks staleness). */
  addLifecycleRetry(event: LifecycleRetryRow['event'], error: string, nextAt: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO lifecycle_retry (portal_id, event_json, attempts, next_at, last_error, created_at) VALUES (?, ?, 0, ?, ?, ?)
         ON CONFLICT(portal_id) DO UPDATE SET event_json = excluded.event_json, attempts = 0, next_at = excluded.next_at,
           last_error = excluded.last_error`,
      )
      .run(event.portalId, JSON.stringify(event), nextAt, error.slice(0, 500), now);
  }

  dueLifecycleRetries(now: number): LifecycleRetryRow[] {
    return (this.db.prepare('SELECT * FROM lifecycle_retry WHERE next_at <= ? ORDER BY next_at').all(now) as Row[]).map((r) => ({
      portalId: Number(r.portal_id),
      event: JSON.parse(String(r.event_json)),
      attempts: Number(r.attempts),
      nextAt: Number(r.next_at),
      lastError: r.last_error === null ? null : String(r.last_error),
      createdAt: Number(r.created_at),
    }));
  }

  listLifecycleRetries(): LifecycleRetryRow[] {
    return this.dueLifecycleRetries(Number.MAX_SAFE_INTEGER);
  }

  nextLifecycleRetryAt(): number | null {
    return (this.db.prepare('SELECT MIN(next_at) AS m FROM lifecycle_retry').get() as { m: number | null }).m ?? null;
  }

  failLifecycleRetry(portalId: number, error: string, nextAt: number): void {
    this.db
      .prepare('UPDATE lifecycle_retry SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE portal_id = ?')
      .run(nextAt, error.slice(0, 500), portalId);
  }

  /** Delete only if the row still holds this event (a newer event may have replaced it meanwhile). */
  doneLifecycleRetry(portalId: number, eventJson?: string): void {
    if (eventJson === undefined) this.db.prepare('DELETE FROM lifecycle_retry WHERE portal_id = ?').run(portalId);
    else this.db.prepare('DELETE FROM lifecycle_retry WHERE portal_id = ? AND event_json = ?').run(portalId, eventJson);
  }

  // ---------------------------------------------------------------- portal pause (revoked token)

  getPause(portalId: number): PortalPause | undefined {
    const r = this.db.prepare('SELECT * FROM portal_pause WHERE portal_id = ?').get(portalId) as Row | undefined;
    return r && { portalId, since: Number(r.since), nextTryAt: Number(r.next_try_at), reason: r.reason === null ? null : String(r.reason) };
  }

  listPauses(): PortalPause[] {
    return (this.db.prepare('SELECT * FROM portal_pause ORDER BY since').all() as Row[]).map((r) => ({
      portalId: Number(r.portal_id),
      since: Number(r.since),
      nextTryAt: Number(r.next_try_at),
      reason: r.reason === null ? null : String(r.reason),
    }));
  }

  /** Start a pause (keeps the original `since`) and set the next probe time. */
  pause(portalId: number, now: number, nextTryAt: number, reason: string): PortalPause {
    this.db
      .prepare(
        `INSERT INTO portal_pause (portal_id, since, next_try_at, reason) VALUES (?, ?, ?, ?)
         ON CONFLICT(portal_id) DO UPDATE SET next_try_at = excluded.next_try_at, reason = excluded.reason`,
      )
      .run(portalId, now, nextTryAt, reason.slice(0, 500));
    return this.getPause(portalId)!;
  }

  unpause(portalId: number): boolean {
    return Number(this.db.prepare('DELETE FROM portal_pause WHERE portal_id = ?').run(portalId).changes) > 0;
  }

  // ---------------------------------------------------------------- purge (uninstall)

  purgePortal(portalId: number): Record<string, number> {
    const out: Record<string, number> = {};
    this.tx(() => {
      for (const t of ['stamp_dead_letter', 'lifecycle_retry', 'portal_pause'])
        out[t] = Number(this.db.prepare(`DELETE FROM ${t} WHERE portal_id = ?`).run(portalId).changes);
      // token_revocations is owned by src/install/token-provider.ts (same DB file); purge its row too if it exists.
      const hasRevocations = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'token_revocations'").get();
      if (hasRevocations) out.token_revocations = Number(this.db.prepare('DELETE FROM token_revocations WHERE portal_id = ?').run(portalId).changes);
    });
    return out;
  }

  // ---------------------------------------------------------------- worker lock

  /**
   * Take the single-worker lock. Throws WorkerLockError if ANOTHER worker heartbeated within staleMs.
   * BEGIN IMMEDIATE so two processes starting together can't both win.
   */
  acquireLock(now: number, staleMs = 30_000, pid = process.pid, host = hostname()): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.db.prepare('SELECT * FROM worker_lock WHERE id = 1').get() as Row | undefined;
      if (r && String(r.worker_id) !== this.workerId && now - Number(r.heartbeat_at) < staleMs) {
        throw new WorkerLockError(
          { workerId: String(r.worker_id), pid: Number(r.pid), host: String(r.host), heartbeatAt: Number(r.heartbeat_at) },
          now,
        );
      }
      this.db
        .prepare(
          `INSERT INTO worker_lock (id, worker_id, pid, host, started_at, heartbeat_at) VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET worker_id = excluded.worker_id, pid = excluded.pid, host = excluded.host,
             started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at`,
        )
        .run(this.workerId, pid, host, now, now);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Returns false if another worker took the lock over (we should stop). */
  heartbeat(now: number): boolean {
    return Number(this.db.prepare('UPDATE worker_lock SET heartbeat_at = ? WHERE id = 1 AND worker_id = ?').run(now, this.workerId).changes) > 0;
  }

  releaseLock(): void {
    if (this.db.isOpen) this.db.prepare('DELETE FROM worker_lock WHERE id = 1 AND worker_id = ?').run(this.workerId);
  }

  lockInfo(): { workerId: string; pid: number; host: string; startedAt: number; heartbeatAt: number; mine: boolean } | null {
    const r = this.db.prepare('SELECT * FROM worker_lock WHERE id = 1').get() as Row | undefined;
    return r
      ? {
          workerId: String(r.worker_id),
          pid: Number(r.pid),
          host: String(r.host),
          startedAt: Number(r.started_at),
          heartbeatAt: Number(r.heartbeat_at),
          mine: String(r.worker_id) === this.workerId,
        }
      : null;
  }
}
