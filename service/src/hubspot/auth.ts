// App-level client credentials token (used ONLY for the Webhooks Journal + subscription APIs).
// Customer CRM calls use the customer's OAuth token instead; never mix the two.
//
// Docs (checked 2026-10-30):
//   https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens#generate-a-client-credentials-access-token
//   https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/guide#authentication-and-scopes
// POST /oauth/2026-09/token (form-encoded), grant_type=client_credentials, space-separated scope.
// Response: { token_type: "bearer", access_token, expires_in: 1800 }. No refresh token: just request a new one.

import { env, optionalEnv } from '../lib/env.js';
import { hsRequest } from '../lib/http.js';

export const OAUTH_VERSION = '2026-09';

/** Scopes we need for Tests 0-2. Snapshot scopes are left out on purpose (not used yet). */
export const DEFAULT_JOURNAL_SCOPES = [
  'developer.webhooks_journal.read',
  'developer.webhooks_journal.subscriptions.read',
  'developer.webhooks_journal.subscriptions.write',
];

interface TokenResponse {
  token_type: string;
  access_token: string;
  expires_in: number; // seconds
}

let cached: { token: string; scope: string; expiresAt: number } | null = null;

/** Refresh this long before HubSpot's expiry, so a token never dies mid-request. */
const EARLY_REFRESH_MS = 5 * 60 * 1000;

/** Which scopes to request. Override with HUBSPOT_JOURNAL_SCOPES="a b c" if needed. */
export function journalScopes(): string {
  return optionalEnv('HUBSPOT_JOURNAL_SCOPES') ?? DEFAULT_JOURNAL_SCOPES.join(' ');
}

/**
 * Get a client credentials token for the app. Cached in memory until 5 min before expiry.
 * Never log the return value.
 */
export async function getAppToken(opts: { forceRefresh?: boolean; scope?: string } = {}): Promise<string> {
  const scope = opts.scope ?? journalScopes();
  const now = Date.now();
  if (!opts.forceRefresh && cached && cached.scope === scope && cached.expiresAt - EARLY_REFRESH_MS > now) {
    return cached.token;
  }

  const res = await hsRequest<TokenResponse>(`/oauth/${OAUTH_VERSION}/token`, {
    method: 'POST',
    form: {
      grant_type: 'client_credentials',
      client_id: env('HUBSPOT_CLIENT_ID'),
      client_secret: env('HUBSPOT_CLIENT_SECRET'),
      scope,
    },
  });

  cached = { token: res.access_token, scope, expiresAt: now + res.expires_in * 1000 };
  return res.access_token;
}

/** Safe-to-print info about the cached token (no token value). */
export function appTokenInfo(): { scope: string; expiresAt: string } | null {
  return cached ? { scope: cached.scope, expiresAt: new Date(cached.expiresAt).toISOString() } : null;
}

/** Forget the cached token (e.g. after a 401). */
export function clearAppToken(): void {
  cached = null;
}
