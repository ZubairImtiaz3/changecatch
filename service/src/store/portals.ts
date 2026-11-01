// Per-portal install state: encrypted refresh token, granted scopes, install/uninstall times, settings.
// Lives in the SAME SQLite file as src/store/db.ts (DB_PATH, default service/data/changecatch.db) but owns its own table
// ("portals") and its own connection.
//
// Watched pairs are NOT stored here. They live in db.ts's `portal_settings` table, because the worker
// (Store.getWatchedPairs) reads them from there. We read/write that table with plain SQL and create it with the
// exact same schema if it doesn't exist yet. If db.ts ever renames that table, update PAIRS_SQL below.

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  MAINTENANCE_INTERVAL_MS, PRUNE_CHUNK_ROWS, StatementCache, getStoreLogger, openDatabase, optimizeDatabase, runInTransaction, runMigrations,
  type Migration,
} from './db.js';
import type { WatchedPair } from '../core/types.js';
import { decryptToken, encryptToken, keyFromEnv } from '../install/crypto.js';
import { dbPath } from '../lib/env.js';

export const DEFAULT_STAMP_SPACING_SECONDS = 3;
/** Uninstalled portal rows (portal_id + uninstalled_at only) are deleted this long after the uninstall. */
export const UNINSTALLED_PORTAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS portals (
  portal_id INTEGER PRIMARY KEY,          -- = hub_id from the OAuth token response
  refresh_token_enc TEXT,                 -- AES-256-GCM, see src/install/crypto.ts. NULL after uninstall.
  scopes TEXT NOT NULL DEFAULT '',        -- space-separated granted scopes
  installed_at INTEGER,                   -- epoch ms of the latest install
  uninstalled_at INTEGER,                 -- epoch ms; NULL while installed
  provisioned_at INTEGER,                 -- epoch ms of the last successful subscription+property setup
  last_provision_error TEXT,
  stamp_spacing_seconds INTEGER NOT NULL DEFAULT ${DEFAULT_STAMP_SPACING_SECONDS},
  updated_at INTEGER NOT NULL
);
-- Same schema as in src/store/db.ts (owned there). Created here too so this module works on its own.
CREATE TABLE IF NOT EXISTS portal_settings (
  portal_id INTEGER NOT NULL,
  object_type_id TEXT NOT NULL,
  associated_object_type_id TEXT NOT NULL,
  PRIMARY KEY (portal_id, object_type_id, associated_object_type_id)
);
`;

/** Versioned schema for this store (scope 'portals' in schema_migrations). APPEND ONLY; steps idempotent. */
export const PORTAL_MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial portals schema', up: (db) => db.exec(SCHEMA) },
  {
    version: 2,
    name: 'index for the uninstalled-portal prune',
    up: (db) => db.exec('CREATE INDEX IF NOT EXISTS portals_uninstalled_at ON portals (uninstalled_at) WHERE uninstalled_at IS NOT NULL;'),
  },
];

export interface PortalRow {
  portalId: number;
  scopes: string[];
  installedAt: number | null;
  uninstalledAt: number | null;
  provisionedAt: number | null;
  lastProvisionError: string | null;
  stampSpacingSeconds: number;
  hasToken: boolean;
}

export class PortalStore {
  readonly db: DatabaseSync;
  private readonly key: Buffer;
  private readonly stmts: StatementCache;
  private maintenanceTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: { path?: string; key?: Buffer } = {}) {
    const path = opts.path ?? dbPath();
    // Shared pragmas (busy_timeout first, WAL, synchronous=NORMAL, ...): see applyPragmas in ./db.ts.
    this.db = openDatabase(path);
    this.stmts = new StatementCache(this.db);
    runMigrations(this.db, 'portals', PORTAL_MIGRATIONS);
    this.key = opts.key ?? keyFromEnv();
    optimizeDatabase(this.db, true);
    if (path !== ':memory:' && MAINTENANCE_INTERVAL_MS > 0) {
      this.maintenanceTimer = setInterval(() => {
        try {
          if (this.db.isOpen) this.runMaintenance();
        } catch (e) {
          getStoreLogger().error('maintenance_failed', `portals maintenance failed: ${(e as Error).message}`, { store: 'portals', error: e });
        }
      }, MAINTENANCE_INTERVAL_MS);
      this.maintenanceTimer.unref();
    }
  }

  close(): void {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
    this.stmts.clear();
    if (this.db.isOpen) this.db.close();
  }

  /** Periodic: delete long-uninstalled portal rows, then PRAGMA optimize. Skipped inside a transaction. */
  runMaintenance(now: number = Date.now()): { uninstalledPortalsDeleted: number } {
    if (this.db.isTransaction) return { uninstalledPortalsDeleted: 0 };
    const n = this.pruneUninstalled(now);
    optimizeDatabase(this.db);
    return { uninstalledPortalsDeleted: n };
  }

  /**
   * Privacy: delete portal rows uninstalled more than maxAgeMs ago (the row then holds only portal_id + uninstalled_at,
   * see markUninstalled). Indexed and chunked. After this, a late lifecycle event for that portal finds no row
   * (the journal keeps events for ~3 days, so that can't happen in practice).
   */
  pruneUninstalled(now: number = Date.now(), maxAgeMs: number = UNINSTALLED_PORTAL_RETENTION_MS): number {
    const st = this.stmt(
      `DELETE FROM portals WHERE rowid IN (SELECT rowid FROM portals WHERE uninstalled_at IS NOT NULL AND uninstalled_at < ? AND refresh_token_enc IS NULL LIMIT ${PRUNE_CHUNK_ROWS})`,
    );
    let total = 0;
    for (;;) {
      const n = Number(this.transaction(() => st.run(now - maxAgeMs).changes));
      total += n;
      if (n < PRUNE_CHUNK_ROWS) return total;
    }
  }

  /** Cached prepared statement. */
  private stmt(sql: string): StatementSync {
    return this.stmts.get(sql);
  }

  /** Save a (re)install. Encrypts the refresh token. Clears uninstalled_at. Keeps stamp spacing. */
  saveInstall(portalId: number, refreshToken: string, scopes: string[], now: number = Date.now()): void {
    const enc = encryptToken(refreshToken, this.key, String(portalId));
    this.stmt(
        `INSERT INTO portals (portal_id, refresh_token_enc, scopes, installed_at, uninstalled_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(portal_id) DO UPDATE SET refresh_token_enc = excluded.refresh_token_enc, scopes = excluded.scopes,
           installed_at = excluded.installed_at, uninstalled_at = NULL, updated_at = excluded.updated_at`,
      )
      .run(portalId, enc, scopes.join(' '), now, now);
  }

  /** HubSpot may rotate the refresh token on refresh. Only updates installed portals. */
  updateRefreshToken(portalId: number, refreshToken: string, now: number = Date.now()): void {
    const enc = encryptToken(refreshToken, this.key, String(portalId));
    this.stmt('UPDATE portals SET refresh_token_enc = ?, updated_at = ? WHERE portal_id = ? AND uninstalled_at IS NULL')
      .run(enc, now, portalId);
  }

  /** Decrypted refresh token, or undefined if the portal isn't installed. Never log the result. */
  getRefreshToken(portalId: number): string | undefined {
    const row = this.stmt('SELECT refresh_token_enc FROM portals WHERE portal_id = ? AND uninstalled_at IS NULL')
      .get(portalId) as { refresh_token_enc: string | null } | undefined;
    return row?.refresh_token_enc ? decryptToken(row.refresh_token_enc, this.key, String(portalId)) : undefined;
  }

  /**
   * Mark uninstalled, wipe the token and the watched pairs. Privacy: the row keeps only portal_id + uninstalled_at
   * (+ updated_at); scopes, install time, errors and spacing are reset. pruneUninstalled deletes it after 30 days.
   */
  markUninstalled(portalId: number, now: number = Date.now()): void {
    this.transaction(() => {
      this.stmt(
          `INSERT INTO portals (portal_id, refresh_token_enc, installed_at, uninstalled_at, provisioned_at, updated_at)
           VALUES (?, NULL, NULL, ?, NULL, ?)
           ON CONFLICT(portal_id) DO UPDATE SET refresh_token_enc = NULL, scopes = '', installed_at = NULL,
             uninstalled_at = excluded.uninstalled_at, provisioned_at = NULL, last_provision_error = NULL,
             stamp_spacing_seconds = ${DEFAULT_STAMP_SPACING_SECONDS}, updated_at = excluded.updated_at`,
        )
        .run(portalId, now, now);
      this.stmt('DELETE FROM portal_settings WHERE portal_id = ?').run(portalId);
    });
  }

  getPortal(portalId: number): PortalRow | undefined {
    const r = this.stmt('SELECT * FROM portals WHERE portal_id = ?').get(portalId) as Record<string, any> | undefined;
    return r && toRow(r);
  }

  listInstalled(): PortalRow[] {
    return (this.stmt('SELECT * FROM portals WHERE uninstalled_at IS NULL AND refresh_token_enc IS NOT NULL').all() as Record<string, any>[]).map(toRow);
  }

  isInstalled(portalId: number): boolean {
    const p = this.getPortal(portalId);
    return !!p && p.uninstalledAt === null && p.hasToken;
  }

  markProvisioned(portalId: number, error: string | null, now: number = Date.now()): void {
    if (error === null) this.stmt('UPDATE portals SET provisioned_at = ?, last_provision_error = NULL, updated_at = ? WHERE portal_id = ?').run(now, now, portalId);
    else this.stmt('UPDATE portals SET last_provision_error = ?, updated_at = ? WHERE portal_id = ?').run(error.slice(0, 2000), now, portalId);
  }

  // --- settings ---
  getStampSpacingSeconds(portalId: number): number {
    return this.getPortal(portalId)?.stampSpacingSeconds ?? DEFAULT_STAMP_SPACING_SECONDS;
  }
  /** For the worker: minimum gap between two stamps on the same record in this portal. */
  getStampSpacingMs(portalId: number): number {
    return this.getStampSpacingSeconds(portalId) * 1000;
  }
  setStampSpacingSeconds(portalId: number, seconds: number, now: number = Date.now()): void {
    this.stmt('UPDATE portals SET stamp_spacing_seconds = ?, updated_at = ? WHERE portal_id = ?').run(seconds, now, portalId);
  }

  getWatchedPairs(portalId: number): WatchedPair[] {
    const rows = this.stmt('SELECT object_type_id, associated_object_type_id FROM portal_settings WHERE portal_id = ? ORDER BY object_type_id, associated_object_type_id')
      .all(portalId) as { object_type_id: string; associated_object_type_id: string }[];
    return rows.map((r) => ({ objectTypeId: r.object_type_id, associatedObjectTypeId: r.associated_object_type_id }));
  }
  setWatchedPairs(portalId: number, pairs: WatchedPair[]): void {
    this.transaction(() => {
      this.stmt('DELETE FROM portal_settings WHERE portal_id = ?').run(portalId);
      const ins = this.stmt('INSERT OR IGNORE INTO portal_settings (portal_id, object_type_id, associated_object_type_id) VALUES (?, ?, ?)');
      for (const p of pairs) ins.run(portalId, p.objectTypeId, p.associatedObjectTypeId);
    });
  }

  /** One write transaction (BEGIN IMMEDIATE; nested calls join the outer one). Never await inside fn. */
  transaction<T>(fn: () => T): T {
    return runInTransaction(this.db, fn);
  }
}

function toRow(r: Record<string, any>): PortalRow {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    portalId: Number(r.portal_id),
    scopes: String(r.scopes ?? '').split(' ').filter(Boolean),
    installedAt: n(r.installed_at),
    uninstalledAt: n(r.uninstalled_at),
    provisionedAt: n(r.provisioned_at),
    lastProvisionError: r.last_provision_error ?? null,
    stampSpacingSeconds: Number(r.stamp_spacing_seconds),
    hasToken: !!r.refresh_token_enc,
  };
}
