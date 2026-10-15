// Customer OAuth access tokens per portal, for CRM reads/writes. The worker codes against TokenProvider.
// Refresh tokens come from PortalStore (encrypted at rest). Access tokens are cached in memory only,
// until 5 minutes before expiry. Concurrent callers for the same portal share one refresh call (single-flight).
// Every token handed out is registered with the rate limiter, so all calls made with it share the portal's bucket.
// Never log a token.
//
// Revocation: when a refresh fails with invalid_grant / BAD_REFRESH_TOKEN (the app was uninstalled or the grant was
// revoked), the portal is marked token_revoked_at (table token_revocations, owned here) and every later call throws
// PortalTokenRevokedError without calling HubSpot. isRevoked() lets the worker pause the portal; revokedPortals()
// lets it purge after its grace period. A reinstall clears the mark (prime() is called on install, and a mark older
// than the portal's latest install is ignored).

import type { DatabaseSync } from 'node:sqlite';
import { refreshAccessToken, type TokenResponse } from '../hubspot/oauth.js';
import { HttpError } from '../lib/http.js';
import { forgetPortalTokens, registerPortalToken } from '../lib/rate-limiter.js';
import type { PortalStore } from '../store/portals.js';

export interface TokenProvider {
  /** A valid customer access token for this portal. Throws PortalNotInstalledError if we have no token. */
  getAccessToken(portalId: number): Promise<string>;
}

export class PortalNotInstalledError extends Error {
  constructor(public readonly portalId: number) {
    super(`Portal ${portalId} is not installed (no refresh token).`);
  }
}

/** HubSpot rejected the refresh token (uninstalled / revoked). A subclass, so existing "not installed" handling applies. */
export class PortalTokenRevokedError extends PortalNotInstalledError {
  constructor(portalId: number, public readonly revokedAt: number) {
    super(portalId);
    this.message = `Portal ${portalId}: refresh token revoked (app uninstalled or access removed). Reinstall needed.`;
  }
}

/** True for HubSpot's "this refresh token is no longer valid" answers. */
export function isRevokedGrantError(e: unknown): boolean {
  if (!(e instanceof HttpError) || (e.status !== 400 && e.status !== 401)) return false;
  let body = '';
  try {
    body = typeof e.body === 'string' ? e.body : JSON.stringify(e.body ?? '');
  } catch {
    /* unserialisable body: rely on the message */
  }
  return /invalid_grant|BAD_REFRESH_TOKEN/i.test(`${body} ${e.message}`);
}

export interface RevocationStore {
  markRevoked(portalId: number, at: number, reason: string): void;
  revokedAt(portalId: number): number | null;
  clear(portalId: number): void;
  list(): { portalId: number; revokedAt: number }[];
}

export class SqliteRevocations implements RevocationStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS token_revocations (
      portal_id INTEGER PRIMARY KEY,
      token_revoked_at INTEGER NOT NULL,   -- epoch ms of the first rejected refresh
      reason TEXT NOT NULL                 -- short code, never token material
    )`);
  }
  markRevoked(portalId: number, at: number, reason: string): void {
    this.db
      .prepare('INSERT INTO token_revocations (portal_id, token_revoked_at, reason) VALUES (?, ?, ?) ON CONFLICT(portal_id) DO NOTHING')
      .run(portalId, at, reason);
  }
  revokedAt(portalId: number): number | null {
    const r = this.db.prepare('SELECT token_revoked_at FROM token_revocations WHERE portal_id = ?').get(portalId) as
      | { token_revoked_at: number }
      | undefined;
    return r ? Number(r.token_revoked_at) : null;
  }
  clear(portalId: number): void {
    this.db.prepare('DELETE FROM token_revocations WHERE portal_id = ?').run(portalId);
  }
  list(): { portalId: number; revokedAt: number }[] {
    const rows = this.db.prepare('SELECT portal_id, token_revoked_at FROM token_revocations ORDER BY portal_id').all() as {
      portal_id: number;
      token_revoked_at: number;
    }[];
    return rows.map((r) => ({ portalId: Number(r.portal_id), revokedAt: Number(r.token_revoked_at) }));
  }
}

export class MemoryRevocations implements RevocationStore {
  private readonly m = new Map<number, number>();
  markRevoked(portalId: number, at: number): void {
    if (!this.m.has(portalId)) this.m.set(portalId, at);
  }
  revokedAt(portalId: number): number | null {
    return this.m.get(portalId) ?? null;
  }
  clear(portalId: number): void {
    this.m.delete(portalId);
  }
  list(): { portalId: number; revokedAt: number }[] {
    return [...this.m].map(([portalId, revokedAt]) => ({ portalId, revokedAt }));
  }
}

const EARLY_REFRESH_MS = 5 * 60 * 1000;

export interface PortalTokenProviderDeps {
  store: Pick<PortalStore, 'getRefreshToken' | 'updateRefreshToken'> & Partial<Pick<PortalStore, 'db' | 'getPortal'>>;
  refresh?: (refreshToken: string) => Promise<TokenResponse>;
  /** Default: a SQLite table in the store's database when it has one, else in memory. */
  revocations?: RevocationStore;
  now?: () => number;
  log?: (msg: string) => void;
}

export class PortalTokenProvider implements TokenProvider {
  private readonly cache = new Map<number, { token: string; expiresAt: number }>();
  private readonly inflight = new Map<number, Promise<string>>();
  private readonly refresh: (rt: string) => Promise<TokenResponse>;
  private readonly now: () => number;
  private readonly revocations: RevocationStore;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: PortalTokenProviderDeps) {
    this.refresh = deps.refresh ?? refreshAccessToken;
    this.now = deps.now ?? Date.now;
    this.revocations = deps.revocations ?? (deps.store.db ? new SqliteRevocations(deps.store.db) : new MemoryRevocations());
    this.log = deps.log ?? ((m) => console.warn(`[tokens] ${m}`));
  }

  /** When the portal's refresh token was rejected (since its latest install), else null. */
  revokedAt(portalId: number): number | null {
    const at = this.revocations.revokedAt(portalId);
    if (at === null) return null;
    const installedAt = this.deps.store.getPortal?.(portalId)?.installedAt ?? null;
    if (installedAt !== null && installedAt > at) {
      this.revocations.clear(portalId); // reinstalled after the revocation
      return null;
    }
    return at;
  }

  /** The worker pauses a revoked portal (no HubSpot calls) and purges it after its grace period. */
  isRevoked(portalId: number): boolean {
    return this.revokedAt(portalId) !== null;
  }

  /** Every portal currently marked revoked (for the worker's purge sweep). */
  revokedPortals(): { portalId: number; revokedAt: number }[] {
    return this.revocations.list().filter((r) => this.revokedAt(r.portalId) !== null);
  }

  async getAccessToken(portalId: number): Promise<string> {
    const revokedAt = this.revokedAt(portalId);
    if (revokedAt !== null) throw new PortalTokenRevokedError(portalId, revokedAt);

    const hit = this.cache.get(portalId);
    if (hit && hit.expiresAt - EARLY_REFRESH_MS > this.now()) return hit.token;

    const pending = this.inflight.get(portalId);
    if (pending) return pending;

    const p = (async () => {
      try {
        const rt = this.deps.store.getRefreshToken(portalId);
        if (!rt) throw new PortalNotInstalledError(portalId);
        let res: TokenResponse;
        try {
          res = await this.refresh(rt);
        } catch (e) {
          if (!isRevokedGrantError(e)) throw e;
          const at = this.now();
          this.revocations.markRevoked(portalId, at, 'invalid_grant');
          this.forget(portalId);
          this.log(`portal ${portalId}: refresh token rejected by HubSpot; marked revoked`);
          throw new PortalTokenRevokedError(portalId, this.revocations.revokedAt(portalId) ?? at);
        }
        if (res.refresh_token && res.refresh_token !== rt) this.deps.store.updateRefreshToken(portalId, res.refresh_token);
        this.cache.set(portalId, { token: res.access_token, expiresAt: this.now() + res.expires_in * 1000 });
        registerPortalToken(res.access_token, portalId); // so http.ts uses this portal's rate-limit bucket
        return res.access_token;
      } finally {
        this.inflight.delete(portalId);
      }
    })();
    this.inflight.set(portalId, p);
    return p;
  }

  /** Seed the cache with the access token we got from the install code exchange (saves one refresh). */
  prime(portalId: number, accessToken: string, expiresInSeconds: number): void {
    this.revocations.clear(portalId); // a fresh install: an old revocation no longer applies
    this.cache.set(portalId, { token: accessToken, expiresAt: this.now() + expiresInSeconds * 1000 });
    registerPortalToken(accessToken, portalId);
  }

  /** Forget a portal's cached token (after a 401, or on uninstall). */
  forget(portalId: number): void {
    this.cache.delete(portalId);
    forgetPortalTokens(portalId); // drop its token -> portal entries in the rate limiter too
  }
}
