// Per-portal install state (table "portals": encrypted refresh token, granted scopes, install/uninstall times, stamp
// spacing), rejected refresh tokens (table "token_revocations") and the watched pairs (table "portal_settings").
// Same SQLite file as src/store/db.ts; schema in schema.ts. The API server opens its own connection; the worker's
// PortalStore shares the worker Store's connection. PortalStore is the only path to portal_settings.

import type { DatabaseSync } from 'node:sqlite';
import type { WatchedPair } from '../core/types.js';
import { decryptToken, encryptToken, keyIdOf, usesActiveKey, type Keyring } from '../lib/crypto.js';
import { createLogger, type Logger } from '../obs/log.js';
import { DEFAULT_STAMP_SPACING_SECONDS, migrateSchema } from './schema.js';
import { Db, PRUNE_CHUNK_ROWS, openDatabase, optimizeDatabase } from './sqlite.js';

/** Uninstalled portal rows (portal_id + uninstalled_at only) are deleted this long after the uninstall. */
export const UNINSTALLED_PORTAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Chunked prune of long-uninstalled portal rows (planned by store.test.ts). */
export const PRUNE_UNINSTALLED_SQL = `DELETE FROM portals WHERE rowid IN (SELECT rowid FROM portals WHERE uninstalled_at IS NOT NULL AND uninstalled_at < ? AND refresh_token_enc IS NULL LIMIT ${PRUNE_CHUNK_ROWS})`;

/**
 * Privacy: delete portal rows uninstalled more than maxAgeMs ago (the row then holds only portal_id + uninstalled_at,
 * see markUninstalled). Indexed and chunked; run by the Store's maintenance timer. After this, a late lifecycle event
 * for that portal finds no row (the journal keeps events for ~3 days, so that can't happen in practice).
 */
export function pruneUninstalledPortals(c: Db, now: number = Date.now(), maxAgeMs: number = UNINSTALLED_PORTAL_RETENTION_MS): number {
  return c.pruneChunks(PRUNE_UNINSTALLED_SQL, now - maxAgeMs);
}

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

/** Encryption AAD of a portal's refresh token: binds the ciphertext to its portal row. */
const tokenAad = (portalId: number) => String(portalId);

/**
 * A row not newer than the portal's latest install is ignored: this is how a reinstall clears a revocation (a
 * rejection in the install's own millisecond was of the old token).
 */
const REVOKED_SQL = `SELECT r.portal_id AS portalId, r.token_revoked_at AS revokedAt FROM token_revocations r
  LEFT JOIN portals p ON p.portal_id = r.portal_id
  WHERE (p.installed_at IS NULL OR p.installed_at < r.token_revoked_at)`;

export interface RotateReport {
  dryRun: boolean;
  total: number;
  alreadyActive: number;
  /** Rows not on the active key that decrypt fine (what --apply re-encrypts). */
  wouldReencrypt: number;
  reencrypted: number;
  /** Rows that could not be decrypted (missing key id, wrong key, tampered). Left unchanged. */
  failed: { portalId: number; keyId: string | null; error: string }[];
  /** Count of rows per key id before the run. */
  byKeyId: Record<string, number>;
}

export class PortalStore {
  /** The connection (the worker's PortalStore shares the worker Store's). */
  readonly conn: Db;
  private readonly owned: boolean;
  private readonly key: Keyring;

  /**
   * { path }: open (and migrate) the file on its own connection (API server, tools).
   * { db }: share an open, migrated connection (the worker's Store.conn), so a process opens the file once.
   * No maintenance timer: the worker's Store runs the one maintenance pass for this file (incl. pruneUninstalledPortals).
   */
  constructor(opts: { key: Keyring; log?: Logger } & ({ path: string } | { db: Db })) {
    this.key = opts.key;
    this.owned = 'path' in opts;
    if ('path' in opts) {
      // Shared pragmas (busy_timeout first, WAL, synchronous=NORMAL, ...): see applyPragmas in ./sqlite.ts.
      this.conn = new Db(openDatabase(opts.path));
      try {
        migrateSchema(this.conn.raw, opts.log ?? createLogger('store'));
      } catch (e) {
        this.conn.close();
        throw e;
      }
      optimizeDatabase(this.conn.raw, true);
    } else {
      this.conn = opts.db;
    }
  }

  get db(): DatabaseSync {
    return this.conn.raw;
  }

  /** Closes the connection only if this store opened it. */
  close(): void {
    if (this.owned) this.conn.close();
  }

  private stmt(sql: string) {
    return this.conn.stmt(sql);
  }

  /** Save a (re)install. Encrypts the refresh token. Clears uninstalled_at. Keeps stamp spacing. */
  saveInstall(portalId: number, refreshToken: string, scopes: string[], now: number = Date.now()): void {
    const enc = encryptToken(refreshToken, this.key, tokenAad(portalId));
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
    const enc = encryptToken(refreshToken, this.key, tokenAad(portalId));
    this.stmt('UPDATE portals SET refresh_token_enc = ?, updated_at = ? WHERE portal_id = ? AND uninstalled_at IS NULL')
      .run(enc, now, portalId);
  }

  /** Decrypted refresh token, or undefined if the portal isn't installed. Never log the result. */
  getRefreshToken(portalId: number): string | undefined {
    const row = this.stmt('SELECT refresh_token_enc FROM portals WHERE portal_id = ? AND uninstalled_at IS NULL')
      .get(portalId) as { refresh_token_enc: string | null } | undefined;
    return row?.refresh_token_enc ? decryptToken(row.refresh_token_enc, this.key, tokenAad(portalId)) : undefined;
  }

  /**
   * Mark uninstalled and wipe the token. Privacy: the row keeps only portal_id + uninstalled_at (+ updated_at); scopes,
   * install time, errors and spacing are reset. pruneUninstalledPortals deletes it after 30 days. Watched pairs and every
   * other per-portal row go with Store.purgePortal (the worker runs it right after the uninstall).
   */
  markUninstalled(portalId: number, now: number = Date.now()): void {
    this.stmt(
        `INSERT INTO portals (portal_id, refresh_token_enc, installed_at, uninstalled_at, provisioned_at, updated_at)
         VALUES (?, NULL, NULL, ?, NULL, ?)
         ON CONFLICT(portal_id) DO UPDATE SET refresh_token_enc = NULL, scopes = '', installed_at = NULL,
           uninstalled_at = excluded.uninstalled_at, provisioned_at = NULL, last_provision_error = NULL,
           stamp_spacing_seconds = ${DEFAULT_STAMP_SPACING_SECONDS}, updated_at = excluded.updated_at`,
      )
      .run(portalId, now, now);
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

  // --- token revocations (HubSpot rejected the refresh token; see hubspot/portal-tokens.ts) ---

  /** When the portal's refresh token was rejected since its latest install, or null. */
  revokedAt(portalId: number): number | null {
    const r = this.stmt(`${REVOKED_SQL} AND r.portal_id = ?`).get(portalId) as { revokedAt: number } | undefined;
    return r ? Number(r.revokedAt) : null;
  }

  listRevoked(): { portalId: number; revokedAt: number }[] {
    const rows = this.stmt(`${REVOKED_SQL} ORDER BY r.portal_id`).all() as { portalId: number; revokedAt: number }[];
    return rows.map((r) => ({ portalId: Number(r.portalId), revokedAt: Number(r.revokedAt) }));
  }

  /** Keep the first rejection; replace a row left from before the latest install. */
  markRevoked(portalId: number, at: number): void {
    this.stmt(
      `INSERT INTO token_revocations (portal_id, token_revoked_at, reason) VALUES (?, ?, 'invalid_grant')
       ON CONFLICT(portal_id) DO UPDATE SET token_revoked_at = excluded.token_revoked_at
       WHERE token_revoked_at <= COALESCE((SELECT installed_at FROM portals WHERE portal_id = excluded.portal_id), 0)`,
    ).run(portalId, at);
  }

  // --- key rotation (src/cli/rotate-token-key.ts) ---

  /**
   * Re-encrypt every stored refresh token with the active key (the first entry of the keyring). Dry run by default:
   * decrypts everything (proves every row is readable with the current keyring) but writes nothing.
   */
  rotateTokens(opts: { dryRun?: boolean; now?: number } = {}): RotateReport {
    const dryRun = opts.dryRun ?? true;
    const now = opts.now ?? Date.now();
    const rows = this.stmt('SELECT portal_id, refresh_token_enc FROM portals WHERE refresh_token_enc IS NOT NULL').all() as {
      portal_id: number;
      refresh_token_enc: string;
    }[];
    const report: RotateReport = { dryRun, total: rows.length, alreadyActive: 0, wouldReencrypt: 0, reencrypted: 0, failed: [], byKeyId: {} };
    const updates: { portalId: number; enc: string; old: string }[] = [];
    for (const r of rows) {
      const portalId = Number(r.portal_id);
      const kid = keyIdOf(r.refresh_token_enc);
      report.byKeyId[kid ?? 'unknown'] = (report.byKeyId[kid ?? 'unknown'] ?? 0) + 1;
      let plain: string;
      try {
        plain = decryptToken(r.refresh_token_enc, this.key, tokenAad(portalId));
      } catch (e) {
        report.failed.push({ portalId, keyId: kid, error: (e as Error).message });
        continue;
      }
      if (usesActiveKey(r.refresh_token_enc, this.key)) {
        report.alreadyActive++;
        continue;
      }
      updates.push({ portalId, enc: encryptToken(plain, this.key, tokenAad(portalId)), old: r.refresh_token_enc });
    }
    if (!dryRun && updates.length) {
      // Compare-and-set on the old value: a token refreshed meanwhile (already re-encrypted by the app) is left alone.
      const st = this.stmt('UPDATE portals SET refresh_token_enc = ?, updated_at = ? WHERE portal_id = ? AND refresh_token_enc = ?');
      this.conn.transaction(() => {
        for (const u of updates) report.reencrypted += Number(st.run(u.enc, now, u.portalId, u.old).changes);
      });
    }
    report.wouldReencrypt = updates.length;
    return report;
  }

  // --- settings: stamp spacing (portals row) and watched pairs (portal_settings) ---
  getStampSpacingSeconds(portalId: number): number {
    const r = this.stmt('SELECT stamp_spacing_seconds AS s FROM portals WHERE portal_id = ?').get(portalId) as { s: number } | undefined;
    return r ? Number(r.s) : DEFAULT_STAMP_SPACING_SECONDS;
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
    this.conn.transaction(() => {
      this.stmt('DELETE FROM portal_settings WHERE portal_id = ?').run(portalId);
      const ins = this.stmt('INSERT OR IGNORE INTO portal_settings (portal_id, object_type_id, associated_object_type_id) VALUES (?, ?, ?)');
      for (const p of pairs) ins.run(portalId, p.objectTypeId, p.associatedObjectTypeId);
    });
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
