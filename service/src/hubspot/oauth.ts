// Customer OAuth (authorization code + refresh token) for CRM reads and property writes.
// The app-level client credentials token for the Webhooks Journal lives in ./auth.ts. Never mix the two.
//
// Docs (checked 2026-10-30):
//   Authorize URL + token endpoints:
//   https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens
//   (The install/authorize URL is built in src/install/oauth-flow.ts.)
//
// OAuth v1 (/oauth/v1/token) is deprecated (Feb 16, 2027). We only use /oauth/2026-09/token.
// Access tokens live 30 minutes (expires_in = 1800). Never log access or refresh tokens.

import { HUBSPOT_TOKEN_URL, hsRequest } from '../lib/http.js';

/** The app's OAuth client (config.hubspot). */
export interface AppClient {
  clientId: string;
  clientSecret: string;
}

/** The app's OAuth client plus the registered redirect URI (config.hubspot + HUBSPOT_REDIRECT_URI). */
export interface OAuthApp extends AppClient {
  redirectUri: string;
}

/** Every /oauth/2026-09/token response (client credentials ones have no refresh_token, hub_id or scopes). */
export interface TokenResponse {
  token_type: string;
  access_token: string;
  refresh_token?: string;
  expires_in: number; // seconds
  hub_id?: number;
  scopes?: string[];
}

/** Refresh a cached access token this long before HubSpot's expiry, so a token never dies mid-request. */
export const EARLY_REFRESH_MS = 5 * 60 * 1000;

export async function exchangeCode(app: OAuthApp, code: string): Promise<TokenResponse> {
  // POST /oauth/2026-09/token, grant_type=authorization_code
  // https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens#generate-initial-access-and-refresh-tokens
  return hsRequest<TokenResponse>(HUBSPOT_TOKEN_URL, {
    method: 'POST',
    retries: 0, // codes are single-use; a retry can only fail
    form: {
      grant_type: 'authorization_code',
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: app.redirectUri,
      code,
    },
  });
}

/** Get a fresh access token from a refresh token (no cache). */
export async function refreshAccessToken(app: AppClient, refreshToken: string): Promise<TokenResponse> {
  // POST /oauth/2026-09/token, grant_type=refresh_token
  // https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens#refresh-an-access-token
  return hsRequest<TokenResponse>(HUBSPOT_TOKEN_URL, {
    method: 'POST',
    form: {
      grant_type: 'refresh_token',
      client_id: app.clientId,
      client_secret: app.clientSecret,
      refresh_token: refreshToken,
    },
  });
}
