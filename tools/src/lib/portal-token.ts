// Customer OAuth access token for the tools: the app's stored install for the portal (encrypted refresh token in
// config.dbPath, decrypted with config.tokenKey), through the same provider the worker uses
// (service/src/hubspot/portal-tokens.ts). No .env token fallback:
// install the app through the API server first. Never log a token.

import { existsSync } from 'node:fs';
import { refreshAccessToken } from '@changecatch/service/hubspot/oauth.js';
import { PortalTokenProvider } from '@changecatch/service/hubspot/portal-tokens.js';
import type { Config } from '@changecatch/service/lib/config.js';
import { PortalStore } from '@changecatch/service/store/portals.js';

let provider: PortalTokenProvider | undefined;

export function toolTokens(config: Config): PortalTokenProvider {
  if (provider) return provider;
  const path = config.dbPath;
  if (!existsSync(path)) throw new Error(`${path} not found: no stored installs. Install the app via the app server first.`);
  const store = new PortalStore({ path, key: config.tokenKey });
  return (provider = new PortalTokenProvider({ store, refresh: (rt) => refreshAccessToken(config.hubspot, rt) }));
}
