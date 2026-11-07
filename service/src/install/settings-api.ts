// GET/POST /api/settings over HTTP: body limit, signature check, trusted portalId. The contract itself (parsing,
// validation, the view) is settings.ts.
//
// Security:
// - Requires a HubSpot **v3** signature (5-minute timestamp window, HMAC-SHA256 over method + full URI + body +
//   timestamp, constant-time compare). No v2 fallback (v2 has no timestamp = replayable).
//   hubspot.fetch appends ?userId=&portalId=&userEmail=&appId= itself and signs the full PUBLIC URL:
//     https://developers.hubspot.com/docs/apps/developer-platform/add-features/ui-extensions/fetching-data.md
//   The URI is rebuilt from PUBLIC_BASE_URL + the raw request path, never from Host / X-Forwarded-* headers.
//   portalId is read only after verification, and must appear exactly once (as must userId and appId).
// - SETTINGS_ALLOW_UNSIGNED is refused (by loadConfig('api'), lib/config.ts) unless NODE_ENV != production AND
//   PUBLIC_BASE_URL is localhost (or unset).
// - Generic 5xx messages with a reference id; details only in logs.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyHubSpotSignature } from './signature.js';
import type { PortalStore } from '../store/portals.js';
import type { Installer } from './installer.js';
import { parseSettingsBody, SettingsValidationError, settingsView } from './settings.js';
import { BodyTooLargeError, clip, installPath, MAX_BODY_BYTES, readBody, sendJson } from './http-util.js';
import type { Errors } from '../obs/errors.js';
import type { Logger } from '../obs/log.js';

export interface SettingsApiOptions {
  installer: Pick<Installer, 'saveSettings' | 'objectTypes'>;
  portals: Pick<PortalStore, 'getPortal' | 'getWatchedPairs' | 'getStampSpacingSeconds' | 'isInstalled'>;
  clientSecret: string;
  /** PUBLIC_BASE_URL without a trailing slash. */
  publicBase?: string;
  allowUnsigned?: boolean;
  now: () => number;
  log: Logger;
  errors: Pick<Errors, 'capture'>;
}

export function createSettingsApi(opts: SettingsApiOptions): (req: IncomingMessage, res: ServerResponse, url: URL, ref: string) => Promise<void> {
  const { log, publicBase, errors: errs } = opts;
  const enableCustomObjectsUrl = publicBase ? `${publicBase}${installPath(2)}` : null;

  /** Verify the hubspot.fetch signature and return the trusted portalId, or send an error and return null. */
  function authPortal(req: IncomingMessage, res: ServerResponse, url: URL, rawBody: string, ref: string): number | null {
    for (const p of ['portalId', 'userId', 'appId']) {
      if (url.searchParams.getAll(p).length > 1) {
        sendJson(res, 400, { error: `duplicate ${p}` });
        return null;
      }
    }
    if (!opts.allowUnsigned) {
      const path = req.url ?? '';
      if (!publicBase) {
        log.warn('settings_not_configured', `settings[${ref}]: PUBLIC_BASE_URL is not set; refusing (signatures cover the public URL)`, { ref });
        sendJson(res, 503, { error: 'Server is not configured for the settings page.', ref });
        return null;
      }
      if (!path.startsWith('/')) {
        sendJson(res, 400, { error: 'bad request' });
        return null;
      }
      const v = verifyHubSpotSignature({
        secret: opts.clientSecret,
        method: req.method ?? 'GET',
        uri: publicBase + path,
        rawBody,
        headers: req.headers,
        now: opts.now(),
      });
      if (!v.ok) {
        log.warn('settings_signature_rejected', `settings[${ref}]: rejected signature (${v.reason})`, { ref });
        sendJson(res, 401, { error: 'invalid signature' });
        return null;
      }
    }
    // Trusted only now: the query string is covered by the verified signature.
    const raw = url.searchParams.get('portalId') ?? '';
    const portalId = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(portalId) || portalId <= 0) {
      sendJson(res, 400, { error: 'missing portalId' });
      return null;
    }
    if (!opts.portals.isInstalled(portalId)) {
      sendJson(res, 404, { error: 'ChangeCatch is not installed in this account. Reinstall the app.' });
      return null;
    }
    return portalId;
  }

  return async (req, res, url, ref) => {
    if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, POST' });
    let raw = '';
    if (req.method === 'POST') {
      try {
        raw = await readBody(req);
      } catch (e) {
        if (e instanceof BodyTooLargeError) {
          sendJson(res, 413, { error: `Body too large (max ${MAX_BODY_BYTES} bytes)` }, { Connection: 'close' });
          req.resume();
          return;
        }
        throw e;
      }
    }
    const portalId = authPortal(req, res, url, raw, ref);
    if (portalId === null) return;
    const view = async () => settingsView(opts.portals, portalId, await opts.installer.objectTypes(portalId), enableCustomObjectsUrl);
    if (req.method === 'GET') return sendJson(res, 200, await view());

    try {
      const report = await opts.installer.saveSettings(portalId, parseSettingsBody(raw));
      return sendJson(res, 200, {
        ok: true,
        ...(await view()),
        changes: { subscriptions: report.subscriptions, propertiesCreatedOn: report.properties.map((p) => p.objectType) },
      });
    } catch (e) {
      if (e instanceof SettingsValidationError) return sendJson(res, 400, { error: e.message });
      log.error('settings_save_failed', `settings[${ref}]: save failed for ${portalId}: ${clip((e as Error).message)}`, { ref, portalId });
      errs.capture(e, { op: 'settings', portalId, extra: { ref } });
      return sendJson(res, 502, { error: 'Saving failed. Nothing was lost; press Save to retry.', ref });
    }
  };
}
