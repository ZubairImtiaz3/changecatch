// The app server (node:http, no framework). One process serves every portal. Routes: docs/install-flow.md.
// Security (docs/reviews/system-design-review.md section 7), here: security headers on every response, no CORS headers
// (hubspot.fetch is proxied server-side), request timeouts, generic 500s with a reference id (details only in logs).
// Logging: one structured Logger (codes, tokens, signed URLs are redacted by it); route failures are also reported as
// exceptions (src/obs/errors.ts).

import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { OAuthApp, TokenResponse } from '../hubspot/oauth.js';
import type { PortalStore } from '../store/portals.js';
import { errors as globalErrors, type Errors } from '../obs/errors.js';
import { createLogger, type Logger } from '../obs/log.js';
import type { Installer } from './installer.js';
import { clip, installPath, installStepOf, SECURITY_HEADERS, sendJson } from './http-util.js';
import { createOAuthFlow } from './oauth-flow.js';
import { createSettingsApi } from './settings-api.js';

const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 15_000;

export interface AppServerOptions {
  installer: Pick<Installer, 'completeInstall' | 'saveSettings' | 'objectTypes'>;
  portals: Pick<PortalStore, 'getPortal' | 'getWatchedPairs' | 'getStampSpacingSeconds' | 'isInstalled'>;
  /** Builds the HubSpot authorize URL (install/oauth-flow.ts buildInstallUrl). */
  oauthApp: Pick<OAuthApp, 'clientId' | 'redirectUri'>;
  exchangeCode: (code: string) => Promise<TokenResponse>;
  clientSecret: string;
  callbackPath: string;
  /** HubSpot app ID (HUBSPOT_APP_ID). When set, a finished install redirects to the app's settings tab in HubSpot. */
  appId?: number;
  /** Public origin HubSpot calls (e.g. https://changecatch.fly.dev). Required for the settings API. */
  publicBaseUrl?: string;
  /** Local testing only: skip signature checks and take portalId from the query (loadConfig refuses it outside localhost/dev). */
  allowUnsigned?: boolean;
  now?: () => number;
  log?: Logger;
  /** Route failures with a stack. Default: the process-wide `errors`. */
  errors?: Pick<Errors, 'capture'>;
}

export function createAppServer(opts: AppServerOptions): Server {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? createLogger('app');
  const errs = opts.errors ?? globalErrors;
  const publicBase = opts.publicBaseUrl ? opts.publicBaseUrl.replace(/\/+$/, '') : undefined;
  const hsts = publicBase?.startsWith('https://') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {};
  const oauth = createOAuthFlow({ ...opts, now, log, errors: errs });
  const settingsApi = createSettingsApi({ ...opts, publicBase, now, log, errors: errs });

  const server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...hsts })) res.setHeader(k, v);
    const ref = randomBytes(4).toString('hex'); // correlation id shown to users, details only in our logs
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'bad request' });
    }
    const path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('ok');
      }
      if (req.method === 'GET' && (path === '/' || path === installPath(1))) return oauth.startInstall(res, installStepOf(url));
      if (req.method === 'GET' && path === opts.callbackPath) return await oauth.callback(res, url, ref);
      if (path === '/api/settings') return await settingsApi(req, res, url, ref);
      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      log.error('unhandled', `unhandled[${ref}] ${req.method} ${clip(path)}: ${clip((e as Error).message)}`, { ref });
      errs.capture(e, { op: 'unhandled', extra: { ref } });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error', ref });
      else res.end();
    }
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}
