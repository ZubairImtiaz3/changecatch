// Customer OAuth access tokens per portal: the ONE token module (API server, worker and tools).
// Refresh tokens come from PortalStore (encrypted at rest). Access tokens are cached in memory only, until 5 minutes
// before expiry. Concurrent callers for the same portal share one refresh call (single-flight). Never log a token.
//
// Errors from getAccessToken (callers decide on the class, never on message text):
//   PortalNotInstalledError  no refresh token (never installed / uninstalled). Permanent.
//   TokenRevokedError        HubSpot rejected the refresh token (app uninstalled or access removed). Stored by
//                            PortalStore.markRevoked; later calls throw without calling HubSpot. The worker PAUSES the
//                            portal (stamps kept, probed hourly, purged after the pause max). A reinstall clears it
//                            (PortalStore ignores a rejection not newer than the latest install).
//   TokenRefreshError        any other refresh failure (5xx, network, 429, or a 4xx such as a bad client secret).
//                            Retry later: a misconfiguration must never drop stamps.
//
// Observability: every refresh call to HubSpot logs ONE structured line (component `oauth`):
//   token_refreshed       info        { portalId, expiresInSec, singleFlight, joiners, durationMs }
//   token_refresh_failed  warn/error  { portalId, status, reason, singleFlight, joiners, durationMs }
// reason: revoked | http_<status> | network. A 4xx other than a revoked grant is level error (misconfiguration:
// it hits every portal). Counted in changecatch_token_refreshes_total{result}.

import { EARLY_REFRESH_MS, type TokenResponse } from './oauth.js';
import { HubSpotError, type PortalAuth } from '../lib/http.js';
import { createLogger, type Logger } from '../obs/log.js';
import type { ChangeCatchMetrics } from '../obs/metrics.js';
import type { PortalStore } from '../store/portals.js';

export interface TokenProvider {
  /** A valid access token for this portal. forceRefresh: drop the cached one first (after a 401). */
  getAccessToken(portalId: number, opts?: { forceRefresh?: boolean }): Promise<string>;
  /** Forget a portal's cached access token (uninstall). */
  forget(portalId: number): void;
  /** Seed the cache with the access token from the install code exchange. */
  prime(portalId: number, accessToken: string, expiresInSeconds: number): void;
}

export class PortalNotInstalledError extends Error {
  constructor(readonly portalId: number) {
    super(`portal ${portalId}: not installed (no refresh token stored)`);
    this.name = 'PortalNotInstalledError';
  }
}

export class TokenRevokedError extends Error {
  constructor(readonly portalId: number, readonly revokedAt: number) {
    super(`portal ${portalId}: token revoked: refresh token rejected by HubSpot (app uninstalled or access removed); the admin must reinstall`);
    this.name = 'TokenRevokedError';
  }
}

export class TokenRefreshError extends Error {
  constructor(readonly portalId: number, readonly cause: unknown) {
    super(`portal ${portalId}: access token refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'TokenRefreshError';
  }
}

/**
 * HubSpot's answer for a refresh token that is no longer valid: 400 with body { status: "BAD_REFRESH_TOKEN", ... }
 * (seen live), or the OAuth 2 standard { error: "invalid_grant" }.
 * https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens#refresh-an-access-token
 */
function isRevokedGrant(e: unknown): e is HubSpotError {
  if (!(e instanceof HubSpotError) || (e.status !== 400 && e.status !== 401)) return false;
  let body = e.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return false;
    }
  }
  const b = (body ?? {}) as { status?: unknown; error?: unknown };
  return b.status === 'BAD_REFRESH_TOKEN' || b.error === 'invalid_grant';
}

/** Run one portal call; on a 401 force a token refresh and run it once more. */
export async function withPortalToken<T>(
  tokens: Pick<TokenProvider, 'getAccessToken'>,
  portalId: number,
  call: (auth: PortalAuth) => Promise<T>,
): Promise<T> {
  try {
    return await call({ portalId, token: await tokens.getAccessToken(portalId) });
  } catch (e) {
    if (!(e instanceof HubSpotError && e.kind === 'unauthorized')) throw e;
    return call({ portalId, token: await tokens.getAccessToken(portalId, { forceRefresh: true }) });
  }
}

export type TokenRefreshResult = 'ok' | 'revoked' | 'error';

/** Classify a failed refresh for logs/metrics. Never reads token material. */
export function refreshFailure(e: unknown): { result: Exclude<TokenRefreshResult, 'ok'>; status: number | null; reason: string } {
  if (isRevokedGrant(e)) return { result: 'revoked', status: e.status, reason: 'revoked' };
  if (e instanceof HubSpotError && e.status) return { result: 'error', status: e.status, reason: `http_${e.status}` };
  return { result: 'error', status: null, reason: 'network' };
}

export interface PortalTokenProviderDeps {
  store: Pick<PortalStore, 'isInstalled' | 'getRefreshToken' | 'updateRefreshToken' | 'revokedAt' | 'markRevoked'>;
  /** Production: (rt) => refreshAccessToken(config.hubspot, rt). */
  refresh: (refreshToken: string) => Promise<TokenResponse>;
  now?: () => number;
  /** Default: createLogger('oauth'). The component is always `oauth`. */
  logger?: Logger;
  /** Counts refreshes in token_refreshes{result}. */
  metrics?: Pick<ChangeCatchMetrics, 'tokenRefresh'>;
}

export class PortalTokenProvider implements TokenProvider {
  private readonly cache = new Map<number, { token: string; expiresAt: number }>();
  private readonly inflight = new Map<number, Promise<string>>();
  /** Callers that joined the in-flight refresh for a portal (single-flight), for the refresh log line. */
  private readonly joiners = new Map<number, number>();
  private readonly refresh: (rt: string) => Promise<TokenResponse>;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(private readonly deps: PortalTokenProviderDeps) {
    this.refresh = deps.refresh;
    this.now = deps.now ?? Date.now;
    this.logger = (deps.logger ?? createLogger('oauth')).child({ component: 'oauth' });
  }

  async getAccessToken(portalId: number, opts: { forceRefresh?: boolean } = {}): Promise<string> {
    // Checked on every call: the worker's cache must not outlive an uninstall done by the API server.
    if (!this.deps.store.isInstalled(portalId)) {
      this.cache.delete(portalId);
      throw new PortalNotInstalledError(portalId);
    }
    const revokedAt = this.deps.store.revokedAt(portalId);
    if (revokedAt !== null) throw new TokenRevokedError(portalId, revokedAt);
    if (opts.forceRefresh) this.cache.delete(portalId);

    const hit = this.cache.get(portalId);
    if (hit && hit.expiresAt - EARLY_REFRESH_MS > this.now()) return hit.token;

    const pending = this.inflight.get(portalId);
    if (pending) {
      this.joiners.set(portalId, (this.joiners.get(portalId) ?? 0) + 1);
      return pending;
    }

    const p = (async () => {
      try {
        const rt = this.deps.store.getRefreshToken(portalId);
        if (!rt) throw new PortalNotInstalledError(portalId);
        const started = this.now();
        let res: TokenResponse;
        try {
          res = await this.refresh(rt);
        } catch (e) {
          this.logRefreshFailed(portalId, e, started);
          if (!isRevokedGrant(e)) throw new TokenRefreshError(portalId, e);
          this.deps.store.markRevoked(portalId, this.now());
          this.cache.delete(portalId);
          throw new TokenRevokedError(portalId, this.deps.store.revokedAt(portalId) ?? this.now());
        }
        if (res.refresh_token && res.refresh_token !== rt) this.deps.store.updateRefreshToken(portalId, res.refresh_token);
        this.cache.set(portalId, { token: res.access_token, expiresAt: this.now() + res.expires_in * 1000 });
        this.logRefreshed(portalId, res.expires_in, started);
        return res.access_token;
      } finally {
        this.inflight.delete(portalId);
        this.joiners.delete(portalId);
      }
    })();
    this.inflight.set(portalId, p);
    return p;
  }

  private singleFlight(portalId: number): { singleFlight: boolean; joiners: number } {
    const joiners = this.joiners.get(portalId) ?? 0;
    return { singleFlight: joiners > 0, joiners };
  }

  private logRefreshed(portalId: number, expiresInSec: number, started: number): void {
    this.deps.metrics?.tokenRefresh('ok');
    this.logger.info('token_refreshed', `portal ${portalId}: access token refreshed`, {
      portalId,
      expiresInSec,
      ...this.singleFlight(portalId),
      durationMs: Math.max(0, this.now() - started),
    });
  }

  private logRefreshFailed(portalId: number, e: unknown, started: number): void {
    const f = refreshFailure(e);
    this.deps.metrics?.tokenRefresh(f.result);
    // Revoked (uninstall) and transient failures (5xx, network) are warn; any other 4xx (bad client secret...) is error.
    const level = f.result === 'revoked' || f.status === null || f.status >= 500 ? 'warn' : 'error';
    const msg =
      f.result === 'revoked'
        ? `portal ${portalId}: refresh token rejected by HubSpot; marked revoked`
        : `portal ${portalId}: access token refresh failed (${f.reason}); calls are retried later`;
    this.logger.log(level, 'token_refresh_failed', msg, {
      portalId,
      status: f.status,
      reason: f.reason,
      ...this.singleFlight(portalId),
      durationMs: Math.max(0, this.now() - started),
    });
  }

  prime(portalId: number, accessToken: string, expiresInSeconds: number): void {
    this.cache.set(portalId, { token: accessToken, expiresAt: this.now() + expiresInSeconds * 1000 });
  }

  forget(portalId: number): void {
    this.cache.delete(portalId);
  }
}
