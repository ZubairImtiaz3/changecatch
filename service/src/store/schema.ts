// The ONE schema of the single SQLite file (DB_PATH): every table, every migration, and which tables hold per-portal
// rows (PORTAL_TABLES, used by Store.purgePortal and Store.portalFootprint).
// APPEND ONLY from here: never edit or reorder a shipped step; add a new version. The history before 2026-11-07 was
// squashed into version 1 before launch (docs/decisions.md); a file made before that is refused, not upgraded.
import type { DatabaseSync } from 'node:sqlite';
import { portalKeyRange } from '../core/keys.js';
import type { Logger } from '../obs/log.js';
import { runMigrations, type Migration } from './sqlite.js';

/** Scope of MIGRATIONS in schema_migrations. */
export const SCHEMA_SCOPE = 'store';
export const DEFAULT_STAMP_SPACING_SECONDS = 3;

/**
 * Every table and index. Every query in the store and worker is covered by a PRIMARY KEY or one of these indexes
 * (scale-review H5 / S4); src/store/store.test.ts checks the hot ones with EXPLAIN QUERY PLAN.
 */
const SCHEMA = `
CREATE TABLE worker_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- Single app-level journal stream, so one row (id = 1).
CREATE TABLE journal_offset (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  offset TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE seen_events (
  key TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
CREATE INDEX seen_events_seen_at ON seen_events (seen_at);
CREATE TABLE label_cache (
  portal_id INTEGER NOT NULL,
  from_type TEXT NOT NULL,
  to_type TEXT NOT NULL,
  type_id INTEGER NOT NULL,
  label TEXT,
  category TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (portal_id, from_type, to_type, type_id)
);
CREATE INDEX label_cache_fetched_at ON label_cache (fetched_at);
CREATE TABLE label_cache_fetches (
  portal_id INTEGER NOT NULL,
  from_type TEXT NOT NULL,
  to_type TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (portal_id, from_type, to_type)
);
CREATE INDEX label_cache_fetches_fetched_at ON label_cache_fetches (fetched_at);
-- Dropdown-sync markers: which association type ids a pair's label dropdowns already hold.
CREATE TABLE labels_synced (
  portal_id INTEGER NOT NULL,
  scope TEXT NOT NULL,
  from_type TEXT NOT NULL,
  to_type TEXT NOT NULL,
  type_ids_json TEXT NOT NULL,
  PRIMARY KEY (portal_id, scope, from_type, to_type)
);
CREATE TABLE pending_pairs (
  key TEXT PRIMARY KEY,
  entry_json TEXT NOT NULL,
  hold_until INTEGER NOT NULL
);
CREATE TABLE portal_settings (
  portal_id INTEGER NOT NULL,
  object_type_id TEXT NOT NULL,
  associated_object_type_id TEXT NOT NULL,
  PRIMARY KEY (portal_id, object_type_id, associated_object_type_id)
);
-- Last known label set per pair of records (label keys = association type ids; learned from events we have seen).
CREATE TABLE association_labels (
  pair_key TEXT PRIMARY KEY,
  labels_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX association_labels_updated_at ON association_labels (updated_at);
-- Last error per portal, shown on /health (counts live in the in-memory metrics, src/obs/metrics.ts).
CREATE TABLE metrics (
  portal_id INTEGER PRIMARY KEY,
  last_error TEXT,
  last_error_at INTEGER
);
-- Every stamped change, keyed by change id: re-reading the same journal input re-creates the same row (crash safety).
-- Written BEFORE the record is stamped. One row per stamped record (a mirrored change has 2 rows).
-- A change already stamped when the late half of its action arrives is left as it was (a workflow may have run on
-- it); the corrected change gets its own row + id, and superseded_by = that new change id.
CREATE TABLE change_log (
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
  created_at INTEGER NOT NULL,
  superseded_by TEXT
);
CREATE INDEX change_log_created_at ON change_log (created_at);
-- purgePortal (portal_id prefix) and per-portal time lookups.
CREATE INDEX change_log_portal_occurred ON change_log (portal_id, occurred_at);
-- Worker: when each record was last stamped and WHICH change it shows (per-record spacing survives restarts; a
-- late-half correction is only sent when it corrects what the record actually shows).
CREATE TABLE stamp_last (
  record_key TEXT PRIMARY KEY,
  stamped_at INTEGER NOT NULL,
  last_change_id TEXT
);
CREATE INDEX stamp_last_stamped_at ON stamp_last (stamped_at);
-- Worker: stamps waiting for their spacing slot or for a retry. A crash never loses them.
CREATE TABLE stamp_queue (
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
-- dueStamps ORDER BY (not_before, occurred_at_ms, change_id) with no temp sort; MIN(not_before).
CREATE INDEX stamp_queue_due_order ON stamp_queue (not_before, occurred_at_ms, change_id);
-- firstQueuedFor / maxQueuedNotBefore, in the slot planner's order (compareUpdates). Load test "mixed": two different
-- orders kept pushing each other's rows back (one stamp waited 278.6 s).
CREATE INDEX stamp_queue_record_order ON stamp_queue (record_key, occurred_at_ms, change_id);
-- The fair drain (STAMP_SQL.dueForPortal) and purgePortal: the full drain order, so no temp b-tree over a portal's
-- whole due backlog.
CREATE INDEX stamp_queue_portal_due_order ON stamp_queue (portal_id, not_before, occurred_at_ms, change_id);
-- Worker: association entries parked because THEIR portal's label lookup is held. The shared journal offset moves
-- on for everyone else; these are retried on every run (see runOnce in src/core/poller.ts).
CREATE TABLE parked_entries (
  key TEXT PRIMARY KEY,
  portal_id INTEGER NOT NULL,
  entry_json TEXT NOT NULL,
  parked_at INTEGER NOT NULL
);
CREATE INDEX parked_entries_portal ON parked_entries (portal_id);
CREATE INDEX parked_entries_parked_at ON parked_entries (parked_at, key);
-- Worker: label lookups that keep failing, and since when (the batch is held, not guessed).
CREATE TABLE label_holds (
  hold_key TEXT PRIMARY KEY,
  first_failed_at INTEGER NOT NULL,
  last_error TEXT
);
-- Short-lived memory of emitted changes for late-half absorption (src/core/absorb.ts).
CREATE TABLE emitted_actions (
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
CREATE INDEX emitted_actions_record ON emitted_actions (record_key, occurred_at_ms);
CREATE INDEX emitted_actions_created_at ON emitted_actions (created_at);
CREATE INDEX emitted_actions_portal ON emitted_actions (portal_id);
-- Install state per portal (queries in src/store/portals.ts).
CREATE TABLE portals (
  portal_id INTEGER PRIMARY KEY,          -- = hub_id from the OAuth token response
  refresh_token_enc TEXT,                 -- AES-256-GCM, see src/lib/crypto.ts. NULL after uninstall.
  scopes TEXT NOT NULL DEFAULT '',        -- space-separated granted scopes
  installed_at INTEGER,                   -- epoch ms of the latest install
  uninstalled_at INTEGER,                 -- epoch ms; NULL while installed
  provisioned_at INTEGER,                 -- epoch ms of the last successful subscription+property setup
  last_provision_error TEXT,
  stamp_spacing_seconds INTEGER NOT NULL DEFAULT ${DEFAULT_STAMP_SPACING_SECONDS},
  updated_at INTEGER NOT NULL
);
CREATE INDEX portals_uninstalled_at ON portals (uninstalled_at) WHERE uninstalled_at IS NOT NULL;
-- Worker tables (queries: stamp_dead_letter + portal_pause in stamps.ts, lifecycle_retry + worker_lock in worker.ts):
--  stamp_dead_letter : stamps we could not deliver (HubSpot refused the record, or retries ran out). NEVER silently
--                      deleted: shown per portal on /health and /metrics, purged only with the portal's data.
--  lifecycle_retry   : uninstall cleanups in HubSpot (subscription delete, token wipe) that failed. The shared journal
--                      offset moves on; the worker retries these with back-off outside the journal path (scale-review C2).
--  portal_pause      : portals whose token is revoked/invalid (401 after refresh, invalid_grant). Their queue is KEPT
--                      and probed hourly; after 7 days without a reinstall the portal is purged via the uninstall routine.
--  worker_lock       : single-row lock with a heartbeat, so a second worker process refuses to start.
CREATE TABLE stamp_dead_letter (
  change_id TEXT PRIMARY KEY,
  portal_id INTEGER NOT NULL,
  record_key TEXT NOT NULL,
  update_json TEXT NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE INDEX stamp_dead_letter_portal ON stamp_dead_letter (portal_id);
CREATE TABLE lifecycle_retry (
  portal_id INTEGER PRIMARY KEY,
  reason TEXT NOT NULL,                -- why the portal was uninstalled ('app uninstalled', 'pause expired')
  uninstalled_at INTEGER NOT NULL,     -- epoch ms of the uninstall; a later reinstall cancels the retry
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE portal_pause (
  portal_id INTEGER PRIMARY KEY,
  since INTEGER NOT NULL,
  next_try_at INTEGER NOT NULL,
  reason TEXT
);
CREATE TABLE worker_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  worker_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  host TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);
-- Refresh tokens HubSpot rejected (queries in src/hubspot/portal-tokens.ts).
CREATE TABLE token_revocations (
  portal_id INTEGER PRIMARY KEY,
  token_revoked_at INTEGER NOT NULL,   -- epoch ms of the first rejected refresh
  reason TEXT NOT NULL                 -- short code, never token material
);
`;

/** The one versioned migration list (scope SCHEMA_SCOPE). */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial schema (pre-launch squash 2026-11-07)', up: (db) => db.exec(SCHEMA) },
];

/**
 * Bring the file to the current schema (both stores call this on open). Refuses a file made before the 2026-11-07
 * squash (old history, or tables without any history) instead of mixing two schemas.
 */
export function migrateSchema(db: DatabaseSync, log: Logger): number[] {
  assertSquashedHistory(db);
  return runMigrations(db, SCHEMA_SCOPE, MIGRATIONS, log);
}

function assertSquashedHistory(db: DatabaseSync): void {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(
    (r) => r.name,
  );
  if (tables.length === 0) return;
  const history = tables.includes('schema_migrations')
    ? (db.prepare('SELECT scope, version, name FROM schema_migrations').all() as { scope: string; version: number; name: string }[])
    : [];
  const first = history.find((r) => r.scope === SCHEMA_SCOPE && Number(r.version) === 1);
  if (first && first.name === MIGRATIONS[0].name && history.every((r) => r.scope === SCHEMA_SCOPE)) return;
  throw new Error(
    `dev DB predates the squash: delete ${db.location() ?? 'the database file'} (and its -wal/-shm files) and reinstall ` +
      'the app on the test portal (docs/development.md, "Recreate the dev DB")',
  );
}

/** How one table's rows of a portal are found. */
export interface PortalTable {
  table: string;
  where: string;
  args: (portalId: number) => (string | number)[];
}
const byPortalId = (table: string): PortalTable => ({ table, where: 'portal_id = ?', args: (p) => [p] });
const byKeyPrefix = (table: string, column: string): PortalTable => ({
  table,
  where: `${column} >= ? AND ${column} < ?`,
  args: portalKeyRange,
});

/**
 * Every table that holds rows of one portal. Store.purgePortal deletes them all (uninstall, privacy policy) and
 * Store.portalFootprint counts them. NOT here, on purpose:
 *   portals      : the row keeps portal_id + uninstalled_at for stale-event checks (PortalStore.markUninstalled wipes
 *                  the rest; pruneUninstalled deletes it after 30 days).
 *   seen_events  : journal identity keys and stamp ids, no names; expire after 4 days.
 *   worker_state : app-level keys only, not portal-scoped.
 */
export const PORTAL_TABLES: PortalTable[] = [
  byPortalId('portal_settings'),
  byPortalId('label_cache'),
  byPortalId('label_cache_fetches'),
  byKeyPrefix('label_holds', 'hold_key'),
  byKeyPrefix('association_labels', 'pair_key'),
  byPortalId('metrics'),
  byPortalId('stamp_queue'),
  byKeyPrefix('stamp_last', 'record_key'),
  byPortalId('change_log'),
  byPortalId('parked_entries'),
  byPortalId('emitted_actions'),
  byPortalId('labels_synced'),
  { table: 'pending_pairs', where: "json_extract(entry_json, '$.event.portalId') = ?", args: (p) => [p] },
  byPortalId('stamp_dead_letter'),
  byPortalId('lifecycle_retry'),
  byPortalId('portal_pause'),
  byPortalId('token_revocations'),
];

/** Tables with a portal_id column that are deliberately NOT in PORTAL_TABLES. */
export const PORTAL_TABLES_KEPT = ['portals'];
