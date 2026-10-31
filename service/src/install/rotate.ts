// Re-encrypt every stored refresh token with the active key (TOKEN_ENC_KEYS first entry). Used by
// src/cli/rotate-token-key.ts. Reads/writes portals.refresh_token_enc (the table src/store/portals.ts creates).
// Dry run by default: decrypts everything (proves every row is readable with the current keyring) but writes nothing.
// Never logs token values.

import type { DatabaseSync } from 'node:sqlite';
import { decryptToken, encryptToken, keyIdOf, usesActiveKey, type TokenKey } from './crypto.js';

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

export function rotateTokens(db: DatabaseSync, key: TokenKey, opts: { dryRun?: boolean; now?: number } = {}): RotateReport {
  const dryRun = opts.dryRun ?? true;
  const now = opts.now ?? Date.now();
  const rows = db
    .prepare('SELECT portal_id, refresh_token_enc FROM portals WHERE refresh_token_enc IS NOT NULL')
    .all() as { portal_id: number; refresh_token_enc: string }[];
  const report: RotateReport = { dryRun, total: rows.length, alreadyActive: 0, wouldReencrypt: 0, reencrypted: 0, failed: [], byKeyId: {} };
  const updates: { portalId: number; enc: string; old: string }[] = [];

  for (const r of rows) {
    const portalId = Number(r.portal_id);
    const kid = keyIdOf(r.refresh_token_enc);
    report.byKeyId[kid ?? 'unknown'] = (report.byKeyId[kid ?? 'unknown'] ?? 0) + 1;
    let plain: string;
    try {
      plain = decryptToken(r.refresh_token_enc, key, String(portalId));
    } catch (e) {
      report.failed.push({ portalId, keyId: kid, error: (e as Error).message });
      continue;
    }
    if (usesActiveKey(r.refresh_token_enc, key)) {
      report.alreadyActive++;
      continue;
    }
    updates.push({ portalId, enc: encryptToken(plain, key, String(portalId)), old: r.refresh_token_enc });
  }

  if (!dryRun && updates.length) {
    // Compare-and-set on the old value: a token refreshed meanwhile (already re-encrypted by the app) is left alone.
    const stmt = db.prepare('UPDATE portals SET refresh_token_enc = ?, updated_at = ? WHERE portal_id = ? AND refresh_token_enc = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const u of updates) report.reencrypted += Number(stmt.run(u.enc, now, u.portalId, u.old).changes);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  report.wouldReencrypt = updates.length;
  return report;
}
