// App-level client credentials token (used ONLY for the Webhooks Journal + subscription APIs).
// Customer CRM calls use the customer's OAuth token instead; never mix the two.
//
// Docs (checked 2026-10-30):
//   https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens#generate-a-client-credentials-access-token
//   https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/guide#authentication-and-scopes
// POST /oauth/2026-09/token (form-encoded), grant_type=client_credentials, space-separated scope.
// Response: { token_type: "bearer", access_token, expires_in: 1800 }. No refresh token: just request a new one.

import { HUBSPOT_TOKEN_URL, hsRequest } from '../lib/http.js';
import { EARLY_REFRESH_MS, type AppClient, type TokenResponse } from './oauth.js';

/** Snapshot scopes are left out on purpose (not used). */
const JOURNAL_SCOPES = [
  'developer.webhooks_journal.read',
  'developer.webhooks_journal.subscriptions.read',
  'developer.webhooks_journal.subscriptions.write',
].join(' ');

/**
 * A client credentials token source for the app, cached in memory until 5 min before expiry.
 * Never log the returned token.
 */
export function appTokenSource(app: AppClient): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | null = null;
  return async () => {
    const now = Date.now();
    if (cached && cached.expiresAt - EARLY_REFRESH_MS > now) return cached.token;
    const res = await hsRequest<TokenResponse>(HUBSPOT_TOKEN_URL, {
      method: 'POST',
      form: { grant_type: 'client_credentials', client_id: app.clientId, client_secret: app.clientSecret, scope: JOURNAL_SCOPES },
    });
    cached = { token: res.access_token, expiresAt: now + res.expires_in * 1000 };
    return res.access_token;
  };
}
