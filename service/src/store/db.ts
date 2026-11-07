import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbPath } from '../lib/env.js';
import { createLogger, type Logger } from '../obs/log.js';
import type { ChangeRecord, StampUpdate } from '../core/stamp.js';
import type { AssociationEntry, ChangeType, PendingEntry, WatchedPair } from '../core/types.js';

export const SEEN_RETENTION_MS = 4 * 24 * 60 * 60 * 1000; // journal keeps ~3 days; keep a day more
export const CHANGE_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // "Get association change" lookups work for 30 days
/** Known label sets per record pair. Older than this = we stop remembering (labels before become "(unknown)"). */
export const ASSOCIATION_LABELS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * Label definitions per object pair (label_cache). Dropped when not re-fetched for this long; the next event for that
 * pair is a cache miss and re-fetches them (one API call). Keeps label names of portals that stopped using a pair from
 * living forever.
 */
export const LABEL_CACHE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Late-half absorption memory (emitted_actions): how long we remember a change we emitted, so a late journal half of
 * the SAME user action (same record pair + identical occurredAt) can be absorbed / amended instead of becoming an
 * extra change. Under load halves were seen up to ~30 s apart; 10 min is a wide margin and keeps the table tiny.
 */
export const EMITTED_ACTIONS_TTL_MS = 10 * 60 * 1000;
/** Last-stamp times only matter for spacing (seconds), so a day is plenty. */
export const STAMP_LAST_RETENTION_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------------------------
// Shared SQLite setup, used by Store here AND PortalStore in ./portals.ts (same file, two connections).
// Owner decision: SQLite in WAL mode stays in production.
// ---------------------------------------------------------------------------------------------------------------

/**
 * WAL auto-checkpoint threshold in pages (4 KiB pages, so about 4 MB of WAL). This is SQLite's default; we set it
 * explicitly so nobody turns it off by accident:
 *   - Auto-checkpoints are PASSIVE: they never block writers or wait for readers, they copy what they can.
 *   - Litestream (deploy/litestream.yml) holds a read lock on the WAL until it has shipped the frames, so a PASSIVE
 *     checkpoint can never move past frames Litestream has not copied. Safe with Litestream, AND the WAL stays
 *     bounded when Litestream is not running (local dev, tests, a plain `docker run` without LITESTREAM_* env).
 *   - Lower = more checkpoint I/O for our many small commits; higher = a longer WAL for every reader to search.
 * Override with SQLITE_WAL_AUTOCHECKPOINT (0 = only Litestream checkpoints; use only under Litestream).
 */
export const WAL_AUTOCHECKPOINT_PAGES = intEnv('SQLITE_WAL_AUTOCHECKPOINT', 1000);
/** After a checkpoint, truncate the -wal file to at most 64 MB (a one-off burst can't leave a huge file behind). */
export const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
/** How often a long-lived connection runs maintenance (Store: chunked prunes + optimize; PortalStore: optimize). */
export const MAINTENANCE_INTERVAL_MS = intEnv('DB_MAINTENANCE_INTERVAL_MS', 10 * 60 * 1000);
/** Rows per DELETE when pruning in our own transactions (each chunk = one short write lock). */
export const PRUNE_CHUNK_ROWS = 5000;
/** Rows per DELETE when a prune runs INSIDE a caller's transaction (the poller's offset transaction). */
export const PRUNE_CHUNK_ROWS_IN_TX = 1000;

function intEnv(name: string, dflt: number): number {
  const v = process.env[name];
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 ? n : dflt;
}

/**
 * Connection pragmas, in this order:
 *   busy_timeout FIRST: the WAL switch on a new file needs a lock and two processes (app server + worker) may open
 *     the file together. From here on every statement waits up to 5 s for the other process instead of failing.
 *   auto_vacuum = INCREMENTAL: only takes effect on a brand-new empty file and only BEFORE the WAL switch (that
 *     writes the header). Silent no-op on existing files. Lets maintenance give freed pages back to the disk.
 *   journal_mode = WAL: readers never block the writer and vice versa.
 *   synchronous = NORMAL: in WAL mode the file can't corrupt on power loss; at worst the last commits roll back,
 *     which the journal re-read and our idempotent writes cover. Removes an fsync per commit.
 *   foreign_keys = ON: none today; future ones get enforced.
 *   wal_autocheckpoint: see WAL_AUTOCHECKPOINT_PAGES.
 *   temp_store = MEMORY: sorts and temp b-trees never touch the disk.
 *   journal_size_limit, cache_size: see JOURNAL_SIZE_LIMIT_BYTES / opts.
 */
export function applyPragmas(db: DatabaseSync, opts: { cacheSizeKiB?: number } = {}): void {
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES};`);
  db.exec('PRAGMA temp_store = MEMORY;');
  db.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES};`);
  if (opts.cacheSizeKiB) db.exec(`PRAGMA cache_size = -${Math.floor(opts.cacheSizeKiB)};`);
}

/** Open (creating the folder) a SQLite file with the shared pragmas. */
export function openDatabase(path: string, opts: { cacheSizeKiB?: number } = {}): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  applyPragmas(db, opts);
  return db;
}

/** Long-lived connections: SQLite runs ANALYZE only where it helps (cheap, work-limited). */
export function optimizeDatabase(db: DatabaseSync, onOpen = false): void {
  db.exec(onOpen ? 'PRAGMA optimize = 0x10002;' : 'PRAGMA optimize;');
}

/**
 * Run fn in one write transaction. BEGIN IMMEDIATE takes the write lock up front, so busy_timeout applies and two
 * processes can't deadlock on a read->write upgrade. Rolls back on throw. A nested call just runs fn inside the
 * outer transaction. Never `await` inside fn.
 */
export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

/** Prepared statements, prepared once per SQL text per connection (node:sqlite StatementSync is reusable). */
export class StatementCache {
  private readonly map = new Map<string, StatementSync>();
  constructor(private readonly db: DatabaseSync) {}
  get(sql: string): StatementSync {
    let st = this.map.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.map.set(sql, st);
    }
    return st;
  }
  get size(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
}

/** Half-open range for every key starting with `<prefix>|` (PK-index friendly, unlike LIKE). '}' sorts right after '|'. */
export function pipePrefixRange(prefix: string): [string, string] {
  return [`${prefix}|`, `${prefix}}`];
}

// --- structured logging (component "store"; shared by both stores) ---

let storeLog: Logger = createLogger('store');
/** The store logger (portals.ts uses it too). */
export function getStoreLogger(): Logger {
  return storeLog;
}
/** Swap the store logger (tests). Returns a function that restores the previous one. */
export function setStoreLogger(l: Logger): () => void {
  const prev = storeLog;
  storeLog = l;
  return () => {
    storeLog = prev;
  };
}

// --- versioned schema migrations (shared by both stores) ---

/** One schema step. APPEND ONLY per scope; never edit or reorder a shipped step. `up` must be idempotent. */
export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  scope TEXT NOT NULL,            -- 'store' (db.ts) or 'portals' (portals.ts): both live in the same file
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (scope, version)
);`;

/**
 * Apply every not-yet-applied step of `scope`, in version order, each in its own BEGIN IMMEDIATE transaction that
 * re-checks schema_migrations first (two processes starting together can't both apply a step). Returns the versions
 * applied now. Throws (and rolls the step back) if a step fails, so a process never runs on a half-migrated schema.
 */
export function runMigrations(db: DatabaseSync, scope: string, steps: Migration[], now: number = Date.now()): number[] {
  const sorted = [...steps].sort((a, b) => a.version - b.version);
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i].version === sorted[i - 1].version) throw new Error(`duplicate migration ${scope}#${sorted[i].version}`);
  db.exec(MIGRATIONS_TABLE);
  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE scope = ? AND version = ?');
  const mark = db.prepare('INSERT INTO schema_migrations (scope, version, name, applied_at) VALUES (?, ?, ?, ?)');
  const applied: number[] = [];
  // A brand-new schema (every test store, first boot) logs ONE debug line; upgrades of an existing one log each step.
  const fresh = schemaVersion(db, scope) === 0;
  const t0All = Date.now();
  for (const m of sorted) {
    if (isApplied.get(scope, m.version) !== undefined) continue;
    const t0 = Date.now();
    runInTransaction(db, () => {
      if (isApplied.get(scope, m.version) !== undefined) return; // the other process won the race
      m.up(db);
      mark.run(scope, m.version, m.name, now);
      applied.push(m.version);
    });
    if (applied[applied.length - 1] === m.version && !fresh)
      storeLog.info('migration_applied', `${scope} migration ${m.version} applied: ${m.name}`, {
        scope, version: m.version, name: m.name, durationMs: Date.now() - t0,
      });
  }
  if (fresh && applied.length)
    storeLog.debug('schema_created', `${scope} schema created at version ${applied[applied.length - 1]}`, {
      scope, versions: applied, durationMs: Date.now() - t0All,
    });
  return applied;
}

/** Highest applied version for a scope (0 = none). */
export function schemaVersion(db: DatabaseSync, scope: string): number {
  db.exec(MIGRATIONS_TABLE);
  const r = db.prepare('SELECT MAX(version) AS v FROM schema_migrations WHERE scope = ?').get(scope) as { v: number | null };
  return Number(r.v ?? 0);
}

/** For idempotent "add a column" steps (ALTER TABLE ADD COLUMN has no IF NOT EXISTS). */
export function addColumnIfMissing(db: DatabaseSync, table: string, column: string, def: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}

/** One delayed stamp waiting in the persisted queue (see src/worker/stamp-queue.ts). */
export interface QueuedStamp {
  changeId: string;
  portalId: number;
  recordKey: string;
  update: StampUpdate;
  notBefore: number;
  attempts: number;
  lastError: string | null;
}

export interface LabelRow {
  label: string | null;
  category: string;
  fetchedAt: number;
}

export interface LabelDefinition {
  associationTypeId: number;
  label: string | null;
  category: string;
}

export interface PortalMetrics {
  portalId: number;
  eventsProcessed: number;
  changesEmitted: number;
  occurrencesSent: number;
  lastEventAt: number | null;
  /** Records actually stamped by the worker's queue (sent and accepted by HubSpot). */
  stampsSent: number;
  /** Stamps HubSpot refused, or that we gave up on. */
  stampsDropped: number;
  lastError: string | null;
  lastErrorAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS worker_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- Single app-level journal stream, so one row (id = 1).
CREATE TABLE IF NOT EXISTS journal_offset (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  offset TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seen_events (
  key TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS seen_events_seen_at ON seen_events (seen_at);
CREATE TABLE IF NOT EXISTS label_cache (
  portal_id INTEGER NOT NULL,
  from_type TEXT NOT NULL,
  to_type TEXT NOT NULL,
  type_id INTEGER NOT NULL,
  label TEXT,
  category TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (portal_id, from_type, to_type, type_id)
);
CREATE TABLE IF NOT EXISTS label_cache_fetches (
  portal_id INTEGER NOT NULL,
  from_type TEXT NOT NULL,
  to_type TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (portal_id, from_type, to_type)
);
CREATE TABLE IF NOT EXISTS pending_pairs (
  key TEXT PRIMARY KEY,
  entry_json TEXT NOT NULL,
  hold_until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS portal_settings (
  portal_id INTEGER NOT NULL,
  object_type_id TEXT NOT NULL,
  associated_object_type_id TEXT NOT NULL,
  PRIMARY KEY (portal_id, object_type_id, associated_object_type_id)
);
-- Last known label set per pair of records (label keys = association type ids; learned from events we have seen).
CREATE TABLE IF NOT EXISTS association_labels (
  pair_key TEXT PRIMARY KEY,
  labels_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics (
  portal_id INTEGER PRIMARY KEY,
  events_processed INTEGER NOT NULL DEFAULT 0,
  changes_emitted INTEGER NOT NULL DEFAULT 0,
  occurrences_sent INTEGER NOT NULL DEFAULT 0,
  last_event_at INTEGER
);
-- Every stamped change, so the "Get association change" workflow action can look it up by id.
-- Written BEFORE the record is stamped. One row per stamped record (a mirrored change has 2 rows).
CREATE TABLE IF NOT EXISTS change_log (
  change_id TEXT PRIMARY KEY,
  portal_id INTEGER NOT NULL,
  object_type_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  change_type TEXT NOT NULL,
  other_object_type TEXT NOT NULL,
  other_record_id TEXT NOT NULL,
  label_before TEXT NOT NULL,
  label_after TEXT NOT NULL,
  labels_current TEXT NOT NULL,
  association_category TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS change_log_created_at ON change_log (created_at);
CREATE INDEX IF NOT EXISTS change_log_record ON change_log (portal_id, object_type_id, object_id); -- dropped in migration 3
-- Worker: when each record was last stamped (persisted per-record spacing, survives restarts).
CREATE TABLE IF NOT EXISTS stamp_last (
  record_key TEXT PRIMARY KEY,
  stamped_at INTEGER NOT NULL
);
-- Worker: stamps waiting for their spacing slot or for a retry. A crash never loses them.
CREATE TABLE IF NOT EXISTS stamp_queue (
  change_id TEXT PRIMARY KEY,
  portal_id INTEGER NOT NULL,
  record_key TEXT NOT NULL,
  update_json TEXT NOT NULL,
  not_before INTEGER NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS stamp_queue_due ON stamp_queue (not_before, occurred_at_ms);
CREATE INDEX IF NOT EXISTS stamp_queue_record ON stamp_queue (record_key);
-- (Per-portal stamp spacing lives in the "portals" table of src/store/portals.ts: stamp_spacing_seconds, written by
-- the settings page. An older build kept it in a portal_options table here; that table is no longer read.)
-- Worker: association entries parked because THEIR portal's label lookup is held. The shared journal offset moves
-- on for everyone else; these are retried on every run (see runOnce in src/core/poller.ts).
CREATE TABLE IF NOT EXISTS parked_entries (
  key TEXT PRIMARY KEY,
  portal_id INTEGER NOT NULL,
  entry_json TEXT NOT NULL,
  parked_at INTEGER NOT NULL
);
-- Worker: label lookups that keep failing, and since when (the batch is held, not guessed).
CREATE TABLE IF NOT EXISTS label_holds (
  hold_key TEXT PRIMARY KEY,
  first_failed_at INTEGER NOT NULL,
  last_error TEXT
);
`;

/**
 * Indexes (scale-review H5 / S4). Every query in this file and in portals.ts is covered by a PRIMARY KEY or one of
 * these; src/store/store.test.ts checks the hot ones with EXPLAIN QUERY PLAN. Replaced indexes are dropped.
 */
const INDEXES_V2 = `
-- Replaced by wider indexes below.
DROP INDEX IF EXISTS change_log_record;
DROP INDEX IF EXISTS stamp_queue_due;
DROP INDEX IF EXISTS stamp_queue_record;
-- Prunes: DELETE ... WHERE rowid IN (SELECT rowid ... WHERE <time> < ? LIMIT n). seen_events_seen_at and
-- change_log_created_at already exist (migration 1).
CREATE INDEX IF NOT EXISTS stamp_last_stamped_at ON stamp_last (stamped_at);
CREATE INDEX IF NOT EXISTS association_labels_updated_at ON association_labels (updated_at);
-- change_log: purgePortal (portal_id prefix) and per-portal time lookups. Replaces (portal_id, object_type_id,
-- object_id), which no v1 query used.
CREATE INDEX IF NOT EXISTS change_log_portal_occurred ON change_log (portal_id, occurred_at);
-- stamp_queue: dueStamps ORDER BY (not_before, occurred_at_ms, change_id) with no temp sort; MIN(not_before).
CREATE INDEX IF NOT EXISTS stamp_queue_due_order ON stamp_queue (not_before, occurred_at_ms, change_id);
-- stamp_queue: firstQueuedFor (ORDER BY within one record), maxQueuedNotBefore.
CREATE INDEX IF NOT EXISTS stamp_queue_record_order ON stamp_queue (record_key, occurred_at_ms, created_at, change_id);
-- stamp_queue: purgePortal, and a per-portal fair drain later.
CREATE INDEX IF NOT EXISTS stamp_queue_portal_due ON stamp_queue (portal_id, not_before);
-- parked_entries: purgePortal; loadParked ORDER BY parked_at, key.
CREATE INDEX IF NOT EXISTS parked_entries_portal ON parked_entries (portal_id);
CREATE INDEX IF NOT EXISTS parked_entries_parked_at ON parked_entries (parked_at, key);
`;

/** Columns added after the first version (migration 2). Added with ALTER TABLE on old databases. */
const ADDED_COLUMNS: { table: string; column: string; def: string }[] = [
  { table: 'metrics', column: 'stamps_sent', def: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'metrics', column: 'stamps_dropped', def: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'metrics', column: 'last_error', def: 'TEXT' },
  { table: 'metrics', column: 'last_error_at', def: 'INTEGER' },
];

/**
 * Versioned schema for the worker store (scope 'store' in schema_migrations). APPEND ONLY: never edit or reorder a
 * shipped step; add a new version. Steps must be idempotent (a DB from before versioning already has the tables).
 */
/** Migration 5: short-lived memory of emitted changes for late-half absorption (src/core/absorb.ts). */
const EMITTED_ACTIONS = `
CREATE TABLE IF NOT EXISTS emitted_actions (
  action_key TEXT NOT NULL,          -- pairKey + '|' + occurredAt ms (one user action on one record pair)
  record_key TEXT NOT NULL,          -- the stamped record (portal|type|id); a mirrored change has 2 rows
  portal_id INTEGER NOT NULL,
  change_id TEXT NOT NULL,
  change_type TEXT NOT NULL,
  other_type_id TEXT NOT NULL,       -- object type of the OTHER record (prefix of the label option values)
  labels_before_json TEXT,           -- full label set before; NULL = unknown
  labels_after_json TEXT,            -- full label set after; NULL = unknown
  removed_json TEXT NOT NULL,        -- label keys (type ids) this change removed
  added_json TEXT NOT NULL,          -- label keys (type ids) this change added
  occurred_at_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (action_key, record_key)
);
CREATE INDEX IF NOT EXISTS emitted_actions_record ON emitted_actions (record_key, occurred_at_ms);
CREATE INDEX IF NOT EXISTS emitted_actions_created_at ON emitted_actions (created_at);
CREATE INDEX IF NOT EXISTS emitted_actions_portal ON emitted_actions (portal_id);
`;

/** One emitted change on one stamped record (emitted_actions row). */
export interface EmittedAction {
  actionKey: string;
  recordKey: string;
  portalId: number;
  changeId: string;
  changeType: ChangeType;
  otherTypeId: string;
  /** undefined = unknown. */
  labelsBefore?: string[];
  labelsAfter?: string[];
  removed: string[];
  added: string[];
  occurredAtMs: number;
}

export const STORE_MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial schema', up: (db) => db.exec(SCHEMA) },
  {
    version: 2,
    name: 'metrics stamp/error columns',
    up: (db) => {
      for (const m of ADDED_COLUMNS) addColumnIfMissing(db, m.table, m.column, m.def);
    },
  },
  { version: 3, name: 'indexes for prunes, purge and queue order (scale-review H5/S4)', up: (db) => db.exec(INDEXES_V2) },
  {
    version: 4,
    name: 'label_cache TTL indexes',
    up: (db) =>
      db.exec(`CREATE INDEX IF NOT EXISTS label_cache_fetched_at ON label_cache (fetched_at);
               CREATE INDEX IF NOT EXISTS label_cache_fetches_fetched_at ON label_cache_fetches (fetched_at);`),
  },
  { version: 5, name: 'emitted_actions (late-half absorption)', up: (db) => db.exec(EMITTED_ACTIONS) },
  {
    // Load test `mixed` 04:30 UTC: (1) firstQueuedFor ordered by created_at while the slot planner (compareUpdates)
    // orders by stamp id, so the two disagreed on which row of a record goes first and kept pushing each other back
    // (one stamp waited 278.6 s). Both now use (occurred_at_ms, change_id). (2) stamp_last remembers WHICH change a
    // record shows, so a late-half correction is only sent when it corrects what the record actually shows.
    version: 6,
    name: 'queue order = planner order; stamp_last.last_change_id',
    up: (db) => {
      db.exec(`DROP INDEX IF EXISTS stamp_queue_record_order;
               CREATE INDEX IF NOT EXISTS stamp_queue_record_order ON stamp_queue (record_key, occurred_at_ms, change_id);`);
      addColumnIfMissing(db, 'stamp_last', 'last_change_id', 'TEXT');
    },
  },
  {
    // A change that was already stamped when the late half of its action arrived is left as it was (a workflow may
    // have run on it); the corrected change gets its own row + id. superseded_by = that new change id.
    version: 7,
    name: 'change_log.superseded_by (late-split corrections)',
    up: (db) => addColumnIfMissing(db, 'change_log', 'superseded_by', 'TEXT'),
  },
  {
    // Naming review 2026-11-07: labels are now carried as association type ids, not names. The two tables that store
    // label sets in the old (name) form are short-lived memory, so they are cleared instead of converted: known label
    // sets are re-learned from the next ADDED event, and late-half memory has a minutes-long TTL. The labels_synced
    // markers are cleared so every pair's dropdowns are synced once more (new option values + other_object_type).
    version: 8,
    name: 'label keys: clear name-based association_labels, emitted_actions, labels_synced markers',
    up: (db) => {
      db.exec('DELETE FROM association_labels');
      db.exec('DELETE FROM emitted_actions');
      db.exec("DELETE FROM worker_state WHERE key LIKE 'labels_synced:%'");
    },
  },
];

export class Store {
  readonly db: DatabaseSync;
  private readonly stmts: StatementCache;
  private maintenanceTimer: ReturnType<typeof setInterval> | undefined;

  constructor(path: string = dbPath()) {
    // 64 MB page cache: the worker is the heavy reader/writer (the app server's PortalStore keeps the default).
    this.db = openDatabase(path, { cacheSizeKiB: 64 * 1024 });
    this.stmts = new StatementCache(this.db);
    runMigrations(this.db, 'store', STORE_MIGRATIONS);
    if (this.getState('created_at') === undefined) this.setState('created_at', String(Date.now()));
    optimizeDatabase(this.db, true);
    // Periodic prune + optimize on real files (the worker's long-lived connection). ':memory:' (tests): no timer.
    if (path !== ':memory:' && MAINTENANCE_INTERVAL_MS > 0) this.startMaintenance(MAINTENANCE_INTERVAL_MS);
  }

  close(): void {
    this.stopMaintenance();
    this.stmts.clear();
    if (this.db.isOpen) this.db.close();
  }

  /** Cached prepared statement (prepared once per SQL text). */
  private stmt(sql: string): StatementSync {
    return this.stmts.get(sql);
  }

  /**
   * Run fn in one SQLite write transaction (BEGIN IMMEDIATE). Rolls back on throw.
   * A nested call runs inside the outer transaction. Never await inside fn.
   */
  transaction<T>(fn: () => T): T {
    return runInTransaction(this.db, fn);
  }

  // --- maintenance (timer-based, outside any batch transaction) ---
  /**
   * One maintenance pass: chunked prunes of every retention table (each chunk its own short transaction), then give
   * freed pages back (incremental_vacuum; a no-op on files created before auto_vacuum was set) and PRAGMA optimize.
   * Safe any time; does nothing if a transaction is open on this connection.
   */
  runMaintenance(now: number = Date.now()): Record<string, number> {
    if (this.db.isTransaction) return {};
    const out = {
      seen_events: this.pruneSeen(now),
      change_log: this.pruneChangeLog(now),
      stamp_last: this.pruneStampLast(now),
      association_labels: this.pruneAssociationLabels(now),
      label_cache: this.pruneLabelCache(now),
      emitted_actions: this.pruneEmittedActions(now),
    };
    this.db.exec('PRAGMA incremental_vacuum(2000);');
    optimizeDatabase(this.db);
    return out;
  }
  /** Start the periodic maintenance timer (unref'd, never keeps the process alive). Returns a stop function. */
  startMaintenance(intervalMs: number = MAINTENANCE_INTERVAL_MS): () => void {
    this.stopMaintenance();
    this.maintenanceTimer = setInterval(() => {
      try {
        if (this.db.isOpen) this.runMaintenance();
      } catch (e) {
        // e.g. busy > 5 s; next tick retries
        storeLog.error('maintenance_failed', `maintenance failed: ${(e as Error).message}`, { store: 'store', error: e });
      }
    }, intervalMs);
    this.maintenanceTimer.unref();
    return () => this.stopMaintenance();
  }
  stopMaintenance(): void {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
  }

  /**
   * DELETE rows older than cutoff through the time index, by rowid, in chunks (never a full scan).
   * Inside a caller's transaction (the poller's offset transaction) only ONE small chunk goes, so that write lock
   * stays short; the rest goes on the next call or on the maintenance timer.
   * Outside a transaction, each chunk is its own short transaction until nothing old is left.
   */
  private pruneOlderThan(table: string, column: string, cutoff: number): number {
    const sql = (n: number) => `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ${n})`;
    if (this.db.isTransaction) return Number(this.stmt(sql(PRUNE_CHUNK_ROWS_IN_TX)).run(cutoff).changes);
    const st = this.stmt(sql(PRUNE_CHUNK_ROWS));
    let total = 0;
    for (;;) {
      const n = Number(this.transaction(() => st.run(cutoff).changes));
      total += n;
      if (n < PRUNE_CHUNK_ROWS) return total;
    }
  }

  // --- worker_state (small key/value) ---
  getState(key: string): string | undefined {
    const row = this.stmt('SELECT value FROM worker_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }
  setState(key: string, value: string): void {
    this.stmt('INSERT INTO worker_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  deleteState(key: string): void {
    this.stmt('DELETE FROM worker_state WHERE key = ?').run(key);
  }
  getCreatedAt(): number {
    return Number(this.getState('created_at'));
  }
  getLastSuccessfulReadAt(): number | null {
    const v = this.getState('last_successful_read_at');
    return v === undefined ? null : Number(v);
  }
  setLastSuccessfulReadAt(ms: number): void {
    this.setState('last_successful_read_at', String(ms));
  }
  recordError(message: string, now: number): void {
    this.setState('last_error', JSON.stringify({ message, at: now }));
    this.setState('consecutive_errors', String(this.getConsecutiveErrors() + 1));
  }
  getLastError(): { message: string; at: number } | null {
    const v = this.getState('last_error');
    return v ? JSON.parse(v) : null;
  }
  getConsecutiveErrors(): number {
    return Number(this.getState('consecutive_errors') ?? 0);
  }
  resetConsecutiveErrors(): void {
    this.setState('consecutive_errors', '0');
  }

  // --- offset ---
  getOffset(): string | null {
    const row = this.stmt('SELECT offset FROM journal_offset WHERE id = 1').get() as { offset: string } | undefined;
    return row?.offset ?? null;
  }
  setOffset(offset: string, now: number = Date.now()): void {
    this.stmt('INSERT INTO journal_offset (id, offset, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET offset = excluded.offset, updated_at = excluded.updated_at')
      .run(offset, now);
  }

  // --- seen_events ---
  filterSeen(keys: string[]): Set<string> {
    const stmt = this.stmt('SELECT 1 FROM seen_events WHERE key = ?');
    return new Set(keys.filter((k) => stmt.get(k) !== undefined));
  }
  markSeen(keys: string[], now: number = Date.now()): void {
    if (!keys.length) return;
    const stmt = this.stmt('INSERT OR IGNORE INTO seen_events (key, seen_at) VALUES (?, ?)');
    this.transactionIfNone(() => {
      for (const k of keys) stmt.run(k, now);
    });
  }
  pruneSeen(now: number = Date.now(), maxAgeMs: number = SEEN_RETENTION_MS): number {
    return this.pruneOlderThan('seen_events', 'seen_at', now - maxAgeMs);
  }

  // --- label_cache ---
  getLabel(portalId: number, fromType: string, toType: string, typeId: number): LabelRow | undefined {
    const row = this.stmt('SELECT label, category, fetched_at FROM label_cache WHERE portal_id = ? AND from_type = ? AND to_type = ? AND type_id = ?')
      .get(portalId, fromType, toType, typeId) as { label: string | null; category: string; fetched_at: number } | undefined;
    return row && { label: row.label, category: row.category, fetchedAt: row.fetched_at };
  }
  /** Replace the cached definitions for one object pair (direction matters). */
  replaceLabels(portalId: number, fromType: string, toType: string, defs: LabelDefinition[], now: number): void {
    this.transactionIfNone(() => {
      this.stmt('DELETE FROM label_cache WHERE portal_id = ? AND from_type = ? AND to_type = ?').run(portalId, fromType, toType);
      const ins = this.stmt('INSERT INTO label_cache (portal_id, from_type, to_type, type_id, label, category, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const d of defs) ins.run(portalId, fromType, toType, d.associationTypeId, d.label, d.category, now);
      this.stmt('INSERT INTO label_cache_fetches (portal_id, from_type, to_type, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET fetched_at = excluded.fetched_at')
        .run(portalId, fromType, toType, now);
    });
  }
  /**
   * TTL: drop label definitions (and their fetch marker) not re-fetched for maxAgeMs. replaceLabels writes both with
   * the same timestamp, so a pair is dropped as a whole and the next lookup re-fetches it. Indexed + chunked.
   */
  pruneLabelCache(now: number = Date.now(), maxAgeMs: number = LABEL_CACHE_RETENTION_MS): number {
    const cutoff = now - maxAgeMs;
    return this.pruneOlderThan('label_cache_fetches', 'fetched_at', cutoff) + this.pruneOlderThan('label_cache', 'fetched_at', cutoff);
  }
  /** All cached definitions for one object pair (direction matters). */
  listLabels(portalId: number, fromType: string, toType: string): LabelDefinition[] {
    const rows = this.stmt('SELECT type_id, label, category FROM label_cache WHERE portal_id = ? AND from_type = ? AND to_type = ? ORDER BY type_id')
      .all(portalId, fromType, toType) as { type_id: number; label: string | null; category: string }[];
    return rows.map((r) => ({ associationTypeId: Number(r.type_id), label: r.label, category: r.category }));
  }
  getLabelsFetchedAt(portalId: number, fromType: string, toType: string): number | null {
    const row = this.stmt('SELECT fetched_at FROM label_cache_fetches WHERE portal_id = ? AND from_type = ? AND to_type = ?')
      .get(portalId, fromType, toType) as { fetched_at: number } | undefined;
    return row?.fetched_at ?? null;
  }

  // --- pending_pairs ---
  loadPending(): PendingEntry[] {
    const rows = this.stmt('SELECT entry_json, hold_until FROM pending_pairs').all() as { entry_json: string; hold_until: number }[];
    return rows.map((r) => ({ entry: JSON.parse(r.entry_json), holdUntil: r.hold_until }));
  }
  replacePending(list: PendingEntry[]): void {
    this.transactionIfNone(() => {
      this.db.exec('DELETE FROM pending_pairs');
      const ins = this.stmt('INSERT OR REPLACE INTO pending_pairs (key, entry_json, hold_until) VALUES (?, ?, ?)');
      for (const p of list) ins.run(p.entry.key, JSON.stringify(p.entry), p.holdUntil);
    });
  }

  // --- portal_settings ---
  getWatchedPairs(portalId: number): WatchedPair[] {
    const rows = this.stmt('SELECT object_type_id, associated_object_type_id FROM portal_settings WHERE portal_id = ?')
      .all(portalId) as { object_type_id: string; associated_object_type_id: string }[];
    return rows.map((r) => ({ objectTypeId: r.object_type_id, associatedObjectTypeId: r.associated_object_type_id }));
  }
  setWatchedPairs(portalId: number, pairs: WatchedPair[]): void {
    this.transactionIfNone(() => {
      this.stmt('DELETE FROM portal_settings WHERE portal_id = ?').run(portalId);
      const ins = this.stmt('INSERT OR IGNORE INTO portal_settings (portal_id, object_type_id, associated_object_type_id) VALUES (?, ?, ?)');
      for (const p of pairs) ins.run(portalId, p.objectTypeId, p.associatedObjectTypeId);
    });
  }

  // --- association_labels (known label state per record pair) ---
  getAssociationLabels(pairKey: string): string[] | undefined {
    const row = this.stmt('SELECT labels_json FROM association_labels WHERE pair_key = ?').get(pairKey) as { labels_json: string } | undefined;
    return row ? JSON.parse(row.labels_json) : undefined;
  }
  setAssociationLabels(pairKey: string, labels: string[], now: number): void {
    this.stmt('INSERT INTO association_labels (pair_key, labels_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(pair_key) DO UPDATE SET labels_json = excluded.labels_json, updated_at = excluded.updated_at')
      .run(pairKey, JSON.stringify(labels), now);
  }
  deleteAssociationLabels(pairKey: string): void {
    this.stmt('DELETE FROM association_labels WHERE pair_key = ?').run(pairKey);
  }
  pruneAssociationLabels(now: number = Date.now(), maxAgeMs: number = ASSOCIATION_LABELS_RETENTION_MS): number {
    return this.pruneOlderThan('association_labels', 'updated_at', now - maxAgeMs);
  }

  /**
   * Uninstall: delete EVERY worker row of one portal (privacy policy). Returns rows deleted per table.
   * Not touched: seen_events (journal identity keys, no names; expire after 4 days) and the portals table row in
   * src/store/portals.ts (token + pairs are wiped there; the row keeps install/uninstall times for stale-event checks).
   */
  purgePortal(portalId: number): Record<string, number> {
    const p = String(portalId);
    const [lo, hi] = pipePrefixRange(p); // keys "<portal>|..." as a PK range (LIKE can't use the PK index)
    const out: Record<string, number> = {};
    const run = (table: string, sql: string, ...args: (string | number)[]) => {
      out[table] = (out[table] ?? 0) + Number(this.stmt(sql).run(...args).changes);
    };
    this.transactionIfNone(() => {
      run('portal_settings', 'DELETE FROM portal_settings WHERE portal_id = ?', portalId);
      run('label_cache', 'DELETE FROM label_cache WHERE portal_id = ?', portalId);
      run('label_cache_fetches', 'DELETE FROM label_cache_fetches WHERE portal_id = ?', portalId);
      run('label_holds', 'DELETE FROM label_holds WHERE hold_key >= ? AND hold_key < ?', lo, hi);
      run('association_labels', 'DELETE FROM association_labels WHERE pair_key >= ? AND pair_key < ?', lo, hi);
      run('metrics', 'DELETE FROM metrics WHERE portal_id = ?', portalId);
      run('stamp_queue', 'DELETE FROM stamp_queue WHERE portal_id = ?', portalId);
      run('stamp_last', 'DELETE FROM stamp_last WHERE record_key >= ? AND record_key < ?', lo, hi);
      run('change_log', 'DELETE FROM change_log WHERE portal_id = ?', portalId);
      run('parked_entries', 'DELETE FROM parked_entries WHERE portal_id = ?', portalId);
      run('emitted_actions', 'DELETE FROM emitted_actions WHERE portal_id = ?', portalId);
      // labels_synced:<portal>|from|to  or  labels_synced:<scope>:<portal>|from|to. worker_state is tiny (a few rows
      // per watched pair), so the mid-key LIKE scan is fine; the first form uses the PK range.
      run('worker_state', 'DELETE FROM worker_state WHERE key >= ? AND key < ?', ...pipePrefixRange(`labels_synced:${p}`));
      run('worker_state', 'DELETE FROM worker_state WHERE key LIKE ?', `labels_synced:%:${p}|%`);
      const pending = this.loadPending();
      const keep = pending.filter((x) => x.entry.event.portalId !== portalId);
      if (keep.length !== pending.length) this.replacePending(keep);
      out.pending_pairs = pending.length - keep.length;
    });
    return out;
  }

  // --- metrics ---
  addMetrics(portalId: number, d: { events?: number; changes?: number; occurrences?: number }, now: number): void {
    this.stmt(
        `INSERT INTO metrics (portal_id, events_processed, changes_emitted, occurrences_sent, last_event_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(portal_id) DO UPDATE SET
           events_processed = events_processed + excluded.events_processed,
           changes_emitted = changes_emitted + excluded.changes_emitted,
           occurrences_sent = occurrences_sent + excluded.occurrences_sent,
           last_event_at = excluded.last_event_at`,
      )
      .run(portalId, d.events ?? 0, d.changes ?? 0, d.occurrences ?? 0, now);
  }
  getMetrics(portalId: number): PortalMetrics | undefined {
    const r = this.stmt('SELECT * FROM metrics WHERE portal_id = ?').get(portalId) as Row | undefined;
    return r && toMetrics(r);
  }
  listMetrics(): PortalMetrics[] {
    return (this.stmt('SELECT * FROM metrics ORDER BY portal_id').all() as Row[]).map(toMetrics);
  }
  addStampMetrics(portalId: number, d: { sent?: number; dropped?: number }): void {
    this.stmt(
        `INSERT INTO metrics (portal_id, stamps_sent, stamps_dropped) VALUES (?, ?, ?)
         ON CONFLICT(portal_id) DO UPDATE SET
           stamps_sent = stamps_sent + excluded.stamps_sent,
           stamps_dropped = stamps_dropped + excluded.stamps_dropped`,
      )
      .run(portalId, d.sent ?? 0, d.dropped ?? 0);
  }
  /** Last error for one portal (shown on /health). Never pass token values in here. */
  recordPortalError(portalId: number, message: string, now: number): void {
    this.stmt(
        `INSERT INTO metrics (portal_id, last_error, last_error_at) VALUES (?, ?, ?)
         ON CONFLICT(portal_id) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at`,
      )
      .run(portalId, message.slice(0, 500), now);
  }

  // --- parked_entries (per-portal parking while a label lookup is held) ---
  loadParked(): { entry: AssociationEntry; parkedAt: number }[] {
    const rows = this.stmt('SELECT entry_json, parked_at FROM parked_entries ORDER BY parked_at, key').all() as { entry_json: string; parked_at: number }[];
    return rows.map((r) => ({ entry: JSON.parse(r.entry_json) as AssociationEntry, parkedAt: Number(r.parked_at) }));
  }
  /** Replace the parked set. Entries already parked keep their first parked_at. */
  replaceParked(entries: AssociationEntry[], now: number): void {
    this.transactionIfNone(() => {
      const before = new Map(this.loadParked().map((p) => [p.entry.key, p.parkedAt]));
      this.db.exec('DELETE FROM parked_entries');
      const ins = this.stmt('INSERT OR IGNORE INTO parked_entries (key, portal_id, entry_json, parked_at) VALUES (?, ?, ?, ?)');
      for (const e of entries) ins.run(e.key, e.event.portalId, JSON.stringify(e), before.get(e.key) ?? now);
    });
  }
  parkedCount(): number {
    return Number((this.stmt('SELECT COUNT(*) AS n FROM parked_entries').get() as { n: number }).n);
  }

  // --- stamp_last (persisted per-record spacing) ---
  getLastStampAt(recordKey: string): number | undefined {
    const r = this.stmt('SELECT stamped_at FROM stamp_last WHERE record_key = ?').get(recordKey) as { stamped_at: number } | undefined;
    return r?.stamped_at;
  }
  setLastStampAt(recordKeys: string[], at: number): void {
    this.transactionIfNone(() => {
      const st = this.stmt(
        'INSERT INTO stamp_last (record_key, stamped_at) VALUES (?, ?) ON CONFLICT(record_key) DO UPDATE SET stamped_at = MAX(stamped_at, excluded.stamped_at)',
      );
      for (const k of recordKeys) st.run(k, at);
    });
  }
  /** Remember which change each record now shows (normal stamps only, never amend stamps). */
  setLastStampedChange(items: { recordKey: string; changeId: string }[], at: number): void {
    this.transactionIfNone(() => {
      const st = this.stmt(
        `INSERT INTO stamp_last (record_key, stamped_at, last_change_id) VALUES (?, ?, ?)
         ON CONFLICT(record_key) DO UPDATE SET last_change_id = excluded.last_change_id, stamped_at = MAX(stamped_at, excluded.stamped_at)`,
      );
      for (const i of items) st.run(i.recordKey, at, i.changeId);
    });
  }
  /** The change id the record shows (the last normal stamp we sent). undefined = unknown. */
  getLastStampedChange(recordKey: string): string | undefined {
    const r = this.stmt('SELECT last_change_id FROM stamp_last WHERE record_key = ?').get(recordKey) as { last_change_id: string | null } | undefined;
    return r?.last_change_id ?? undefined;
  }
  pruneStampLast(now: number = Date.now(), maxAgeMs: number = STAMP_LAST_RETENTION_MS): number {
    return this.pruneOlderThan('stamp_last', 'stamped_at', now - maxAgeMs);
  }

  // --- stamp_queue (persisted delayed stamps) ---
  /** Idempotent on changeId: a change that is already queued keeps its slot. Returns how many were new. */
  enqueueStamps(items: { changeId: string; recordKey: string; update: StampUpdate; notBefore: number }[], now: number): number {
    let added = 0;
    this.transactionIfNone(() => {
      const ins = this.stmt(
        `INSERT OR IGNORE INTO stamp_queue (change_id, portal_id, record_key, update_json, not_before, occurred_at_ms, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      );
      for (const i of items)
        added += Number(ins.run(i.changeId, i.update.portalId, i.recordKey, JSON.stringify(i.update), i.notBefore, i.update.occurredAtMs, now).changes);
    });
    return added;
  }
  /** Latest planned slot for a record that still waits in the queue. */
  maxQueuedNotBefore(recordKey: string): number | undefined {
    const r = this.stmt('SELECT MAX(not_before) AS m FROM stamp_queue WHERE record_key = ?').get(recordKey) as { m: number | null };
    return r.m ?? undefined;
  }
  /** Queued stamps that are due, earliest slot first (then oldest change first). */
  dueStamps(now: number, limit = 1000): QueuedStamp[] {
    const rows = this.stmt('SELECT * FROM stamp_queue WHERE not_before <= ? ORDER BY not_before, occurred_at_ms, change_id LIMIT ?')
      .all(now, limit) as Row[];
    return rows.map((r) => ({
      changeId: String(r.change_id),
      portalId: Number(r.portal_id),
      recordKey: String(r.record_key),
      update: JSON.parse(String(r.update_json)) as StampUpdate,
      notBefore: Number(r.not_before),
      attempts: Number(r.attempts),
      lastError: r.last_error === null ? null : String(r.last_error),
    }));
  }
  /** The oldest queued change for one record (by change time). Only this one may be sent next, to keep order. */
  firstQueuedFor(recordKey: string): { changeId: string; notBefore: number } | undefined {
    const r = this.stmt('SELECT change_id, not_before FROM stamp_queue WHERE record_key = ? ORDER BY occurred_at_ms, change_id LIMIT 1')
      .get(recordKey) as { change_id: string; not_before: number } | undefined;
    return r && { changeId: r.change_id, notBefore: r.not_before };
  }
  /** undefined = not queued. */
  queuedAttempts(changeId: string): number | undefined {
    const r = this.stmt('SELECT attempts FROM stamp_queue WHERE change_id = ?').get(changeId) as { attempts: number } | undefined;
    return r?.attempts;
  }
  isQueued(changeId: string): boolean {
    return this.stmt('SELECT 1 FROM stamp_queue WHERE change_id = ?').get(changeId) !== undefined;
  }
  nextStampDueAt(): number | null {
    const r = this.stmt('SELECT MIN(not_before) AS m FROM stamp_queue').get() as { m: number | null };
    return r.m ?? null;
  }
  queueSize(): number {
    return Number((this.stmt('SELECT COUNT(*) AS n FROM stamp_queue').get() as { n: number }).n);
  }
  deleteQueued(changeIds: string[]): void {
    this.transactionIfNone(() => {
      const del = this.stmt('DELETE FROM stamp_queue WHERE change_id = ?');
      for (const id of changeIds) del.run(id);
    });
  }
  /** Move queued stamps to a later slot. countAttempt=true for a failed send (not for a spacing shift). */
  deferQueued(changeIds: string[], notBefore: number, opts: { error?: string; countAttempt?: boolean } = {}): void {
    this.transactionIfNone(() => {
      const st = this.stmt(
        'UPDATE stamp_queue SET not_before = ?, attempts = attempts + ?, last_error = COALESCE(?, last_error) WHERE change_id = ?',
      );
      for (const id of changeIds) st.run(notBefore, opts.countAttempt ? 1 : 0, opts.error?.slice(0, 500) ?? null, id);
    });
  }

  // --- label_holds ---
  /** Start (or keep) a hold. Returns when the failures started. */
  noteLabelHold(key: string, now: number, error: string): number {
    this.stmt('INSERT INTO label_holds (hold_key, first_failed_at, last_error) VALUES (?, ?, ?) ON CONFLICT(hold_key) DO UPDATE SET last_error = excluded.last_error')
      .run(key, now, error.slice(0, 500));
    return Number((this.stmt('SELECT first_failed_at FROM label_holds WHERE hold_key = ?').get(key) as { first_failed_at: number }).first_failed_at);
  }
  hasLabelHold(key: string): boolean {
    return this.stmt('SELECT 1 FROM label_holds WHERE hold_key = ?').get(key) !== undefined;
  }
  clearLabelHold(key: string): void {
    this.stmt('DELETE FROM label_holds WHERE hold_key = ?').run(key);
  }
  listLabelHolds(): { key: string; firstFailedAt: number; lastError: string | null }[] {
    return (this.stmt('SELECT * FROM label_holds ORDER BY first_failed_at').all() as Row[]).map((r) => ({
      key: String(r.hold_key),
      firstFailedAt: Number(r.first_failed_at),
      lastError: r.last_error === null ? null : String(r.last_error),
    }));
  }

  // --- change_log (lookup for the "Get association change" workflow action) ---
  /** Insert change records. Idempotent: an existing change_id is left as it is (same journal input -> same row). */
  saveChanges(records: ChangeRecord[], now: number = Date.now()): void {
    this.transactionIfNone(() => {
      const ins = this.stmt(
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
  getChange(portalId: number, changeId: string): (ChangeRecord & { createdAt: number }) | undefined {
    const r = this.stmt('SELECT * FROM change_log WHERE change_id = ? AND portal_id = ?').get(changeId, portalId) as
      | Record<string, string | number>
      | undefined;
    return (
      r && {
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
      }
    );
  }
  pruneChangeLog(now: number = Date.now(), maxAgeMs: number = CHANGE_LOG_RETENTION_MS): number {
    return this.pruneOlderThan('change_log', 'created_at', now - maxAgeMs);
  }
  /** Correct an already-logged change (late-half absorption). Only the given fields change. */
  updateChange(
    portalId: number,
    changeId: string,
    f: Partial<Pick<ChangeRecord, 'changeType' | 'labelBefore' | 'labelAfter' | 'labelsCurrent'>>,
  ): void {
    this.stmt(
      `UPDATE change_log SET change_type = COALESCE(?, change_type), label_before = COALESCE(?, label_before),
         label_after = COALESCE(?, label_after), labels_current = COALESCE(?, labels_current)
       WHERE change_id = ? AND portal_id = ?`,
    ).run(f.changeType ?? null, f.labelBefore ?? null, f.labelAfter ?? null, f.labelsCurrent ?? null, changeId, portalId);
  }

  /** Mark an already-stamped change as corrected by a later change (late journal half, src/core/absorb.ts). */
  markSuperseded(portalId: number, changeId: string, supersededBy: string): void {
    this.stmt('UPDATE change_log SET superseded_by = ? WHERE change_id = ? AND portal_id = ?').run(supersededBy, changeId, portalId);
  }

  // --- emitted_actions (late-half absorption memory, src/core/absorb.ts) ---
  /** Remember emitted changes (one row per stamped record). Replaces an older row of the same action + record. */
  saveEmittedActions(rows: EmittedAction[], now: number): void {
    this.transactionIfNone(() => {
      const st = this.stmt(
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
    const rows = this.stmt('SELECT * FROM emitted_actions WHERE action_key = ? AND created_at >= ? ORDER BY record_key')
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
    // action_key = pairKey + '|' + ms. '|' is 0x7C and '}' 0x7D, so this range is exactly "starts with pairKey|".
    const keys = this.stmt(
      'SELECT DISTINCT action_key FROM emitted_actions WHERE action_key > ? AND action_key < ? AND occurred_at_ms BETWEEN ? AND ? AND created_at >= ?',
    ).all(`${pairKey}|`, `${pairKey}}`, occurredAtMs - windowMs, occurredAtMs + windowMs, now - ttlMs) as { action_key: string }[];
    return keys.flatMap((k) => this.getEmittedActions(k.action_key, now, ttlMs));
  }
  /** Stamps still waiting in the queue for one record (any kind), in send order. */
  queuedStampsFor(recordKey: string): { changeId: string; update: StampUpdate }[] {
    const rows = this.stmt('SELECT change_id, update_json FROM stamp_queue WHERE record_key = ? ORDER BY occurred_at_ms, change_id').all(recordKey) as {
      change_id: string;
      update_json: string;
    }[];
    return rows.map((r) => ({ changeId: r.change_id, update: JSON.parse(r.update_json) as StampUpdate }));
  }
  /** True if the record has an emitted change that happened after occurredAtMs (inside the TTL). */
  hasNewerEmittedAction(recordKey: string, occurredAtMs: number, now: number, ttlMs: number = EMITTED_ACTIONS_TTL_MS): boolean {
    return (
      this.stmt('SELECT 1 FROM emitted_actions WHERE record_key = ? AND occurred_at_ms > ? AND created_at >= ? LIMIT 1')
        .get(recordKey, occurredAtMs, now - ttlMs) !== undefined
    );
  }
  pruneEmittedActions(now: number = Date.now(), ttlMs: number = EMITTED_ACTIONS_TTL_MS): number {
    return this.pruneOlderThan('emitted_actions', 'created_at', now - ttlMs);
  }

  /** Merge properties into a queued (not yet sent) stamp. False if the change is not queued any more. */
  mergeQueuedProperties(changeId: string, props: Partial<Record<string, string>>): boolean {
    const r = this.stmt('SELECT update_json FROM stamp_queue WHERE change_id = ?').get(changeId) as { update_json: string } | undefined;
    if (!r) return false;
    const u = JSON.parse(r.update_json) as StampUpdate;
    u.properties = { ...u.properties, ...props };
    this.stmt('UPDATE stamp_queue SET update_json = ? WHERE change_id = ?').run(JSON.stringify(u), changeId);
    return true;
  }

  private transactionIfNone(fn: () => void): void {
    this.transaction(fn); // runInTransaction nests
  }
}

type Row = Record<string, number | string | null>;

function toMetrics(r: Row): PortalMetrics {
  const num = (v: number | string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  return {
    portalId: Number(r.portal_id),
    eventsProcessed: Number(r.events_processed ?? 0),
    changesEmitted: Number(r.changes_emitted ?? 0),
    occurrencesSent: Number(r.occurrences_sent ?? 0),
    lastEventAt: num(r.last_event_at),
    stampsSent: Number(r.stamps_sent ?? 0),
    stampsDropped: Number(r.stamps_dropped ?? 0),
    lastError: r.last_error === null || r.last_error === undefined ? null : String(r.last_error),
    lastErrorAt: num(r.last_error_at),
  };
}
