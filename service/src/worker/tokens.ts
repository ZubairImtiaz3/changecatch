// Per-portal OAuth access tokens for the worker (label reads, label-option sync, stamping).
// The journal itself uses the APP-level client credentials token (src/hubspot/auth.ts). Never mix the two.
//
// Default (createWorkerFromEnv): workerTokenProvider() below, which uses ONLY the encrypted per-portal tokens
// written by the install flow (src/install/token-provider.ts + src/store/portals.ts). No .env token fallback.

import type { PermanentTokenError } from '../hubspot/stamp.js';
import { PortalNotInstalledError, PortalTokenRevokedError, type PortalTokenProvider } from '../install/token-provider.js';
import { HttpError } from '../lib/http.js';
import type { PortalStore } from '../store/portals.js';

export interface TokenProvider {
  /** Access token for one installed portal. Throw a NoPortalTokenError if the portal has no token (not installed). */
  getAccessToken(portalId: number, opts?: { forceRefresh?: boolean }): Promise<string>;
}

/** "We have no token for this portal." Permanent: stamps are dropped and label lookups don't hold the batch. */
export class NoPortalTokenError extends Error implements PermanentTokenError {
  readonly permanent = true as const;
  constructor(public portalId: number, why = 'no OAuth token stored for this portal') {
    super(`portal ${portalId}: ${why}`);
    this.name = 'NoPortalTokenError';
  }
}

/**
 * The portal's token was revoked / is invalid (HubSpot rejected the refresh token: invalid_grant / BAD_REFRESH_TOKEN).
 * NOT permanent: the admin may fix it by reinstalling. The stamp queue PAUSES the portal (keeps its queue, probes
 * hourly, purges after 7 days) instead of dropping stamps. retryAfterMs is picked up by sendStampBatches.
 */
export class TokenRevokedError extends Error {
  readonly revoked = true as const;
  readonly retryAfterMs = 60 * 60_000;
  constructor(public portalId: number, why = 'refresh token rejected by HubSpot (revoked?); the admin must reinstall') {
    super(`portal ${portalId}: token revoked: ${why}`);
    this.name = 'TokenRevokedError';
  }
}

export function isTokenRevokedError(e: unknown): e is TokenRevokedError {
  return e instanceof Error && (e as Partial<TokenRevokedError>).revoked === true;
}

export interface WorkerTokenDeps {
  portals: Pick<PortalStore, 'getPortal'>;
  real: Pick<PortalTokenProvider, 'getAccessToken' | 'forget'>;
}

/**
 * The worker's TokenProvider on top of the install work's PortalTokenProvider:
 *  - forceRefresh (after a 401) -> forget the cached access token, refresh once.
 *  - not installed / uninstalled -> NoPortalTokenError (permanent: label lookups don't hold the journal).
 *  - HubSpot rejects the refresh token (400 BAD_REFRESH_TOKEN / invalid_grant) -> TokenRevokedError (the portal is
 *    paused, not dropped: see stamp-queue.ts).
 */
export function workerTokenProvider(d: WorkerTokenDeps): TokenProvider {
  return {
    async getAccessToken(portalId, opts) {
      const row = d.portals.getPortal(portalId);
      if (row?.hasToken && row.uninstalledAt === null) {
        if (opts?.forceRefresh) d.real.forget(portalId);
        try {
          return await d.real.getAccessToken(portalId);
        } catch (e) {
          // Revoked (marked by the install token provider) BEFORE the generic "not installed": pause, don't drop.
          if (e instanceof PortalTokenRevokedError) throw new TokenRevokedError(portalId);
          if (e instanceof PortalNotInstalledError) throw new NoPortalTokenError(portalId);
          // Only a rejected REFRESH TOKEN is permanent. A bad client secret (also 4xx) must not drop every stamp.
          if (e instanceof HttpError && e.status === 400 && /BAD_REFRESH_TOKEN|invalid_grant/i.test(JSON.stringify(e.body ?? '')))
            throw new TokenRevokedError(portalId);
          throw e;
        }
      }
      throw new NoPortalTokenError(portalId, row?.uninstalledAt != null ? 'app uninstalled' : undefined);
    },
  };
}
