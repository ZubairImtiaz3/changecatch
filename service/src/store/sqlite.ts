// SQLite toolkit shared by every store on the single DB file (DB_PATH): connection pragmas, transactions, statement
// cache, versioned migrations. Owner decision: SQLite in WAL mode stays in production.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../obs/log.js';

/**
 * WAL auto-checkpoint threshold in pages (4 KiB pages, so about 4 MB of WAL). This is SQLite's default; we set it
 * explicitly so nobody turns it off by accident:
 *   - Auto-checkpoints are PASSIVE: they never block writers or wait for readers, they copy what they can.
 *   - Litestream (deploy/litestream.yml) holds a read lock on the WAL until it has shipped the frames, so a PASSIVE
 *     checkpoint can never move past frames Litestream has not copied. Safe with Litestream, AND the WAL stays
 *     bounded when Litestream is not running (local dev, tests, a plain `docker run` without LITESTREAM_* env).
 *   - Lower = more checkpoint I/O for our many small commits; higher = a longer WAL for every reader to search.
 */
export const WAL_AUTOCHECKPOINT_PAGES = 1000;
/** After a checkpoint, truncate the -wal file to at most 64 MB (a one-off burst can't leave a huge file behind). */
export const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
/** How often the worker's Store runs maintenance (chunked prunes of every retention table + optimize). This timer is
 * the only pruning of the retention tables, so it is never off. */
export const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;
/** Rows per DELETE when pruning in our own transactions (each chunk = one short write lock). */
export const PRUNE_CHUNK_ROWS = 5000;

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

/**
 * Read-only connection for tools and checks: no pragmas that write, no migrations, no timers. Waits up to 5 s for a
 * writer like every other connection.
 */
export function openDatabaseReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000;');
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

/** Chunked prune: rows older than the cutoff, through the time index, by rowid. */
export const pruneSql = (table: string, column: string, chunk: number): string =>
  `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ${chunk})`;

/**
 * One connection and its statement cache. Every feature repository of a process works on the same Db, so one
 * transaction can span features (the poller commits seen keys, offset, pending and parked entries together).
 */
export class Db {
  private readonly stmts: StatementCache;
  constructor(readonly raw: DatabaseSync) {
    this.stmts = new StatementCache(raw);
  }
  stmt(sql: string): StatementSync {
    return this.stmts.get(sql);
  }
  /** See runInTransaction. Never await inside fn. */
  transaction<T>(fn: () => T): T {
    return runInTransaction(this.raw, fn);
  }
  /** DELETE rows older than cutoff in chunks of PRUNE_CHUNK_ROWS, each its own short transaction. */
  pruneOlderThan(table: string, column: string, cutoff: number): number {
    return this.pruneChunks(pruneSql(table, column, PRUNE_CHUNK_ROWS), cutoff);
  }
  /** Run a chunked DELETE (LIMIT PRUNE_CHUNK_ROWS, one `?` cutoff) until nothing is left. */
  pruneChunks(sql: string, cutoff: number): number {
    const st = this.stmt(sql);
    let total = 0;
    for (;;) {
      const n = Number(this.transaction(() => st.run(cutoff).changes));
      total += n;
      if (n < PRUNE_CHUNK_ROWS) return total;
    }
  }
  close(): void {
    this.stmts.clear();
    if (this.raw.isOpen) this.raw.close();
  }
}

// --- versioned schema migrations (shared by both stores) ---

/** One schema step. APPEND ONLY per scope; never edit or reorder a shipped step. */
export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  scope TEXT NOT NULL,            -- 'store' = the one list in schema.ts
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
export function runMigrations(db: DatabaseSync, scope: string, steps: Migration[], log: Logger, now: number = Date.now()): number[] {
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
      log.info('migration_applied', `${scope} migration ${m.version} applied: ${m.name}`, {
        scope, version: m.version, name: m.name, durationMs: Date.now() - t0,
      });
  }
  if (fresh && applied.length)
    log.debug('schema_created', `${scope} schema created at version ${applied[applied.length - 1]}`, {
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
