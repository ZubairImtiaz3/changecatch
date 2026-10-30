// Customer OAuth access token for the tools. Not a tool itself.
//
// Order:
//  1. The app's stored install for the portal (encrypted refresh token in DB_PATH, decrypted with TOKEN_ENC_KEYS /
//     legacy TOKEN_ENC_KEY) via PortalTokenProvider (service/src/install/token-provider.ts). The real, current token.
//  2. Fallback, with a loud warning: HUBSPOT_TEST_REFRESH_TOKEN, and ONLY when the portal is HUBSPOT_TEST_PORTAL_ID
//     (that token belongs to that portal). Often stale: every uninstall revokes it (400 BAD_REFRESH_TOKEN).
// Never log a token.

import './env.js'; // loads .env and pins DB_PATH (must stay first)
import { existsSync } from 'node:fs';
import { getPortalAccessToken } from '@changecatch/service/hubspot/oauth.js';
import { PortalNotInstalledError, PortalTokenProvider } from '@changecatch/service/install/token-provider.js';
import { PortalStore } from '@changecatch/service/store/portals.js';
import { dbPath } from './paths.js';

let provider: { store: PortalStore; tokens: PortalTokenProvider } | null | undefined;

function openProvider(): { store: PortalStore; tokens: PortalTokenProvider } | null {
  if (provider !== undefined) return provider;
  const path = dbPath();
  if (!process.env.TOKEN_ENC_KEYS && !process.env.TOKEN_ENC_KEY) {
    console.warn('[portal-token] TOKEN_ENC_KEYS / TOKEN_ENC_KEY not set: cannot read stored installs.');
    return (provider = null);
  }
  if (!existsSync(path)) {
    console.warn(`[portal-token] ${path} not found: no stored installs.`);
    return (provider = null);
  }
  const store = new PortalStore({ path });
  return (provider = { store, tokens: new PortalTokenProvider({ store }) });
}

/**
 * Access token for one portal. forceRefresh: drop the cached access token first (use after a 401).
 */
export async function getToolPortalToken(opts: { portalId: number; forceRefresh?: boolean }): Promise<string> {
  const { portalId } = opts;
  const p = openProvider();
  let why = 'no stored install';
  if (p) {
    const row = p.store.getPortal(portalId);
    if (row?.hasToken && row.uninstalledAt === null) {
      if (opts.forceRefresh) p.tokens.forget(portalId);
      try {
        return await p.tokens.getAccessToken(portalId);
      } catch (e) {
        if (!(e instanceof PortalNotInstalledError)) throw e; // network / secret errors: surface them
        why = e.message; // includes the revoked case (subclass)
      }
    } else if (row) why = row.uninstalledAt !== null ? 'app uninstalled' : 'stored install has no token';
  }

  const testPortal = Number(process.env.HUBSPOT_TEST_PORTAL_ID);
  const refresh = process.env.HUBSPOT_TEST_REFRESH_TOKEN;
  if (refresh && portalId === testPortal) {
    console.warn(
      `[portal-token] WARNING: portal ${portalId}: ${why}. Falling back to HUBSPOT_TEST_REFRESH_TOKEN ` +
        '(dev only; revoked by any uninstall: expect BAD_REFRESH_TOKEN). Reinstall through the app server to fix.',
    );
    return getPortalAccessToken(refresh, { portalId, forceRefresh: opts.forceRefresh });
  }
  throw new Error(`portal ${portalId}: ${why}, and no HUBSPOT_TEST_REFRESH_TOKEN fallback for this portal. Install the app via the app server first.`);
}
