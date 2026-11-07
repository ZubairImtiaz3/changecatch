// The worker's view of the single SQLite file: one connection, one repository per feature (each owns its tables'
// queries), uninstall purge across all of them, and the ONE maintenance timer of the file. Core code depends on the
// narrow ports it declares (PollerStore, AbsorbStore, EmittedActionStore, ...), which this Store satisfies.

import type { DatabaseSync } from 'node:sqlite';
import { ChangeLog } from './change-log.js';
import { EmittedActions } from './emitted.js';
import { EntryStore } from './entries.js';
import { JournalState, SeenEvents } from './journal-state.js';
import { LabelStore } from './labels.js';
import { MetricsStore } from './metrics.js';
import { pruneUninstalledPortals } from './portals.js';
import { PORTAL_TABLES, migrateSchema, type PortalTable } from './schema.js';
import { Db, MAINTENANCE_INTERVAL_MS, openDatabase, openDatabaseReadOnly, optimizeDatabase } from './sqlite.js';
import { createLogger, type Logger } from '../obs/log.js';
import { StampStore } from './stamps.js';
import { WorkerStore } from './worker.js';

/** Purge / footprint statements of one PORTAL_TABLES entry. */
export const purgeSql = (t: PortalTable): string => `DELETE FROM ${t.table} WHERE ${t.where}`;
export const footprintSql = (t: PortalTable): string => `SELECT COUNT(*) AS n FROM ${t.table} WHERE ${t.where}`;

export class Store {
  readonly conn: Db;
  readonly journal: JournalState;
  readonly seen: SeenEvents;
  readonly changes: ChangeLog;
  readonly stamps: StampStore;
  readonly labels: LabelStore;
  readonly emitted: EmittedActions;
  readonly entries: EntryStore;
  readonly metrics: MetricsStore;
  readonly worker: WorkerStore;
  private maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  private readonly log: Logger;

  /**
   * readOnly: tools and checks (no migrations, no writes, no timers, no optimize). The file must exist.
   * log: migrations and maintenance failures (default: createLogger('store')).
   */
  constructor(path: string, opts: { readOnly?: boolean; log?: Logger } = {}) {
    this.log = opts.log ?? createLogger('store');
    // 64 MB page cache: the worker is the heavy reader/writer (the app server's PortalStore keeps the default).
    this.conn = new Db(opts.readOnly ? openDatabaseReadOnly(path) : openDatabase(path, { cacheSizeKiB: 64 * 1024 }));
    this.journal = new JournalState(this.conn);
    this.seen = new SeenEvents(this.conn);
    this.changes = new ChangeLog(this.conn);
    this.stamps = new StampStore(this.conn);
    this.labels = new LabelStore(this.conn);
    this.emitted = new EmittedActions(this.conn);
    this.entries = new EntryStore(this.conn);
    this.metrics = new MetricsStore(this.conn);
    this.worker = new WorkerStore(this.conn);
    if (opts.readOnly) return;
    try {
      migrateSchema(this.db, this.log);
    } catch (e) {
      this.conn.close();
      throw e;
    }
    if (this.journal.getState('created_at') === undefined) this.journal.setState('created_at', String(Date.now()));
    optimizeDatabase(this.db, true);
    // Periodic prune + optimize on real files (the worker's long-lived connection). ':memory:' (tests): no timer.
    if (path !== ':memory:') this.startMaintenance(MAINTENANCE_INTERVAL_MS);
  }

  get db(): DatabaseSync {
    return this.conn.raw;
  }

  close(): void {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
    this.conn.close();
  }

  /**
   * Run fn in one SQLite write transaction (BEGIN IMMEDIATE). Rolls back on throw.
   * A nested call runs inside the outer transaction. Never await inside fn.
   */
  transaction<T>(fn: () => T): T {
    return this.conn.transaction(fn);
  }

  /**
   * One maintenance pass for the whole file: chunked prunes of every retention table (each chunk its own short
   * transaction), then give freed pages back (incremental_vacuum) and PRAGMA optimize. Safe any time; does nothing
   * if a transaction is open on this connection.
   */
  runMaintenance(now: number = Date.now()): Record<string, number> {
    if (this.db.isTransaction) return {};
    const out = {
      seen_events: this.seen.pruneSeen(now),
      change_log: this.changes.pruneChangeLog(now),
      stamp_last: this.stamps.pruneStampLast(now),
      association_labels: this.labels.pruneAssociationLabels(now),
      label_cache: this.labels.pruneLabelCache(now),
      emitted_actions: this.emitted.pruneEmittedActions(now),
      portals: pruneUninstalledPortals(this.conn, now),
    };
    this.db.exec('PRAGMA incremental_vacuum(2000);');
    optimizeDatabase(this.db);
    return out;
  }
  /** Periodic maintenance (unref'd, never keeps the process alive). */
  private startMaintenance(intervalMs: number): void {
    this.maintenanceTimer = setInterval(() => {
      try {
        if (this.db.isOpen) this.runMaintenance();
      } catch (e) {
        // e.g. busy > 5 s; next tick retries
        this.log.error('maintenance_failed', `maintenance failed: ${(e as Error).message}`, { store: 'store', error: e });
      }
    }, intervalMs);
    this.maintenanceTimer.unref();
  }

  /**
   * Uninstall: delete EVERY row of one portal in every table of PORTAL_TABLES (schema.ts), in one transaction
   * (privacy policy). Returns rows deleted per table.
   */
  purgePortal(portalId: number): Record<string, number> {
    return this.transaction(() =>
      Object.fromEntries(PORTAL_TABLES.map((t) => [t.table, Number(this.conn.stmt(purgeSql(t)).run(...t.args(portalId)).changes)])),
    );
  }
  /** Rows of one portal per table of PORTAL_TABLES (all 0 after purgePortal). */
  portalFootprint(portalId: number): Record<string, number> {
    return Object.fromEntries(
      PORTAL_TABLES.map((t) => [t.table, Number((this.conn.stmt(footprintSql(t)).get(...t.args(portalId)) as { n: number }).n)]),
    );
  }
}
