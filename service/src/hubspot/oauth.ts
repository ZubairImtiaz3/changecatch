// Customer OAuth (authorization code + refresh token) for CRM reads and property writes.
// The app-level client credentials token for the Webhooks Journal lives in ./auth.ts. Never mix the two.
//
// Docs (checked 2026-10-30):
//   Authorize URL + token endpoints:
//   https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens
//   Install URL params (scope, optional_scope, state):
//   https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/working-with-oauth
//
// OAuth v1 (/oauth/v1/token) is deprecated (Feb 16, 2027). We only use /oauth/2026-09/token.
// Access tokens live 30 minutes (expires_in = 1800). Never log access or refresh tokens.

import { env } from '../lib/env.js';
import { hsRequest } from '../lib/http.js';
import { registerPortalToken } from '../lib/rate-limiter.js';
import { APP_SCOPES } from '../install/app-scopes.js';
import { customWriteMode, installScopes, type AppScopeSets, type CustomWriteMode } from '../install/scopes.js';

export const OAUTH_VERSION = '2026-09';
export const AUTHORIZE_URL = 'https://app.hubspot.com/oauth/authorize';
// The token docs show host api.hubspot.com; api.hubapi.com also serves /oauth/... (src/hubspot/auth.ts uses it).
export const TOKEN_URL = `https://api.hubspot.com/oauth/${OAUTH_VERSION}/token`;

export interface TokenResponse {
  token_type: string;
  access_token: string;
  refresh_token?: string;
  expires_in: number; // seconds
  hub_id?: number;
  scopes?: string[];
}

/** The app's scopes (src/install/app-scopes.ts, kept equal to hubspot-app's app-hsmeta.json by a test). */
export function appScopes(): AppScopeSets {
  return { required: [...APP_SCOPES.required], optional: [...APP_SCOPES.optional], conditional: [...APP_SCOPES.conditional] };
}

/**
 * Build the install (authorize) URL. Scopes are space-separated per the OAuth docs.
 * custom=true (the "?custom=1" step) adds the conditionally required custom write scopes to `scope`.
 * Which list each scope lands in depends on CUSTOM_WRITE_MODE, see src/install/scopes.ts.
 */
export function buildInstallUrl(state: string, opts: { custom?: boolean; mode?: CustomWriteMode; scopes?: AppScopeSets } = {}): string {
  const { scope, optionalScope } = installScopes(opts.scopes ?? appScopes(), { custom: opts.custom, mode: opts.mode ?? customWriteMode() });
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('client_id', env('HUBSPOT_CLIENT_ID'));
  u.searchParams.set('redirect_uri', env('HUBSPOT_REDIRECT_URI'));
  u.searchParams.set('scope', scope.join(' '));
  if (optionalScope.length) u.searchParams.set('optional_scope', optionalScope.join(' '));
  u.searchParams.set('state', state);
  return u.toString();
}

/** Exchange the one-time ?code= from the redirect for access + refresh tokens. */
export async function exchangeCode(code: string): Promise<TokenResponse> {
  // POST /oauth/2026-09/token, grant_type=authorization_code
  // https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens#generate-initial-access-and-refresh-tokens
  return hsRequest<TokenResponse>(TOKEN_URL, {
    method: 'POST',
    retries: 0, // codes are single-use; a retry can only fail
    form: {
      grant_type: 'authorization_code',
      client_id: env('HUBSPOT_CLIENT_ID'),
      client_secret: env('HUBSPOT_CLIENT_SECRET'),
      redirect_uri: env('HUBSPOT_REDIRECT_URI'),
      code,
    },
  });
}

/** Get a fresh access token from a refresh token (no cache). */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  // POST /oauth/2026-09/token, grant_type=refresh_token
  // https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens#refresh-an-access-token
  return hsRequest<TokenResponse>(TOKEN_URL, {
    method: 'POST',
    form: {
      grant_type: 'refresh_token',
      client_id: env('HUBSPOT_CLIENT_ID'),
      client_secret: env('HUBSPOT_CLIENT_SECRET'),
      refresh_token: refreshToken,
    },
  });
}

const EARLY_REFRESH_MS = 5 * 60 * 1000;
const cache = new Map<string, { token: string; expiresAt: number }>();
const inflight = new Map<string, Promise<string>>();

/**
 * Access token for one installed portal, cached in memory until 5 min before expiry.
 * Keyed by refresh token (kept only in memory). Never log the return value.
 * Single-flight: concurrent callers (also concurrent forceRefresh callers) share one refresh call.
 * Pass portalId so calls made with the token use that portal's rate-limit bucket (src/lib/rate-limiter.ts).
 * Without it we fall back to hub_id from the token response, if HubSpot sends one.
 */
export async function getPortalAccessToken(
  refreshToken: string,
  opts: { forceRefresh?: boolean; portalId?: number } = {},
): Promise<string> {
  const hit = cache.get(refreshToken);
  if (!opts.forceRefresh && hit && hit.expiresAt - EARLY_REFRESH_MS > Date.now()) {
    if (opts.portalId !== undefined) registerPortalToken(hit.token, opts.portalId);
    return hit.token;
  }

  const pending = inflight.get(refreshToken);
  if (pending) return pending;

  const p = (async () => {
    try {
      const res = await refreshAccessToken(refreshToken);
      cache.set(refreshToken, { token: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 });
      const portalId = opts.portalId ?? res.hub_id;
      if (portalId !== undefined) registerPortalToken(res.access_token, portalId);
      return res.access_token;
    } finally {
      inflight.delete(refreshToken);
    }
  })();
  inflight.set(refreshToken, p);
  return p;
}

export function clearPortalToken(refreshToken: string): void {
  cache.delete(refreshToken);
}
