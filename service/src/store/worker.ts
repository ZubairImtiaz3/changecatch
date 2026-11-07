// Worker-only tables (schema in schema.ts): lifecycle_retry (pending HubSpot uninstall cleanups, src/worker/lifecycle.ts)
// and worker_lock (one worker process at a time). Revoked-token pauses live next to the stamp queue (stamps.ts).

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Db } from './sqlite.js';

type Row = Record<string, number | string | null>;

/** A pending uninstall: the HubSpot cleanup of an uninstall that happened at `at`, retried with back-off. */
export interface LifecycleRetryRow {
  portalId: number;
  reason: string;
  at: number;
  attempts: number;
  nextAt: number;
  lastError: string | null;
  createdAt: number;
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

export class WorkerStore {
  /** Process identity for the worker lock. */
  readonly workerId = randomUUID();

  constructor(private readonly c: Db) {}

  // --- lifecycle_retry ---
  /** One row per portal; a newer uninstall replaces it. */
  addLifecycleRetry(u: { portalId: number; reason: string; at: number }, error: string, nextAt: number, now: number): void {
    this.c
      .stmt(
        `INSERT INTO lifecycle_retry (portal_id, reason, uninstalled_at, attempts, next_at, last_error, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(portal_id) DO UPDATE SET reason = excluded.reason, uninstalled_at = excluded.uninstalled_at, attempts = 0,
           next_at = excluded.next_at, last_error = excluded.last_error`,
      )
      .run(u.portalId, u.reason, u.at, nextAt, error.slice(0, 500), now);
  }
  dueLifecycleRetries(now: number): LifecycleRetryRow[] {
    return (this.c.stmt('SELECT * FROM lifecycle_retry WHERE next_at <= ? ORDER BY next_at').all(now) as Row[]).map((r) => ({
      portalId: Number(r.portal_id),
      reason: String(r.reason),
      at: Number(r.uninstalled_at),
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
    return (this.c.stmt('SELECT MIN(next_at) AS m FROM lifecycle_retry').get() as { m: number | null }).m ?? null;
  }
  failLifecycleRetry(portalId: number, error: string, nextAt: number): void {
    this.c.stmt('UPDATE lifecycle_retry SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE portal_id = ?').run(nextAt, error.slice(0, 500), portalId);
  }
  doneLifecycleRetry(portalId: number): void {
    this.c.stmt('DELETE FROM lifecycle_retry WHERE portal_id = ?').run(portalId);
  }

  // --- worker_lock ---
  /**
   * Take the single-worker lock. Throws WorkerLockError if ANOTHER worker heartbeated within staleMs.
   * BEGIN IMMEDIATE so two processes starting together can't both win.
   */
  acquireLock(now: number, staleMs = 30_000, pid = process.pid, host = hostname()): void {
    this.c.transaction(() => {
      const r = this.c.stmt('SELECT * FROM worker_lock WHERE id = 1').get() as Row | undefined;
      if (r && String(r.worker_id) !== this.workerId && now - Number(r.heartbeat_at) < staleMs) {
        throw new WorkerLockError(
          { workerId: String(r.worker_id), pid: Number(r.pid), host: String(r.host), heartbeatAt: Number(r.heartbeat_at) },
          now,
        );
      }
      this.c
        .stmt(
          `INSERT INTO worker_lock (id, worker_id, pid, host, started_at, heartbeat_at) VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET worker_id = excluded.worker_id, pid = excluded.pid, host = excluded.host,
             started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at`,
        )
        .run(this.workerId, pid, host, now, now);
    });
  }
  /** Returns false if another worker took the lock over (we should stop). */
  heartbeat(now: number): boolean {
    return Number(this.c.stmt('UPDATE worker_lock SET heartbeat_at = ? WHERE id = 1 AND worker_id = ?').run(now, this.workerId).changes) > 0;
  }
  releaseLock(): void {
    if (this.c.raw.isOpen) this.c.stmt('DELETE FROM worker_lock WHERE id = 1 AND worker_id = ?').run(this.workerId);
  }
  lockInfo(): { workerId: string; pid: number; host: string; startedAt: number; heartbeatAt: number; mine: boolean } | null {
    const r = this.c.stmt('SELECT * FROM worker_lock WHERE id = 1').get() as Row | undefined;
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
