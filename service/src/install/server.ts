// The app server (node:http, no framework). One process serves every portal.
//   GET  /                    -> redirect to the HubSpot install URL (same as /install)
//   GET  /install             -> redirect to the HubSpot install URL
//   GET  /install?custom=1    -> same, plus the 2 conditionally required custom-object write scopes (second consent)
//   GET  /oauth/callback      -> code exchange, save tokens, provision the portal (path comes from HUBSPOT_REDIRECT_URI),
//                                then 302 to HubSpot's Marketplace returnUrl, else to the ChangeCatch settings tab in HubSpot
//   GET  /api/settings        -> settings for the calling portal (signed hubspot.fetch from the settings page)
//   POST /api/settings        -> save settings, diff subscriptions, create properties
//   GET  /health              -> "ok"
//
// Security (docs/reviews/system-design-review.md section 7):
// - /api/settings requires a HubSpot **v3** signature (5-minute timestamp window, HMAC-SHA256 over
//   method + full URI + body + timestamp, constant-time compare). No v2 fallback (v2 has no timestamp = replayable).
//   hubspot.fetch appends ?userId=&portalId=&userEmail=&appId= itself and signs the full PUBLIC URL:
//     https://developers.hubspot.com/docs/apps/developer-platform/add-features/ui-extensions/fetching-data.md
//   The URI is rebuilt from PUBLIC_BASE_URL + the raw request path, never from Host / X-Forwarded-* headers.
//   portalId is read only after verification, and must appear exactly once (as must userId and appId).
// - SETTINGS_ALLOW_UNSIGNED is refused unless NODE_ENV != production AND PUBLIC_BASE_URL is localhost (or unset).
// - OAuth state is HMAC-signed (step + expiry + nonce) and single-use, so it survives restarts and can't be forged.
//   Installs from HubSpot's own Install button carry no state: allowed, but logged. A state that IS present but
//   expired/forged/reused is rejected (CSRF). Redirects only go to the fixed HubSpot authorize URL, a validated HubSpot
//   returnUrl (https app[-region].hubspot.com only), or the settings tab URL we build from portalId + HUBSPOT_APP_ID.
//   Only the callback may be framed (by *.hubspot.com), as HubSpot's embedded Marketplace install needs.
// - 64 KB body limit (413), JSON errors -> 400, generic 5xx messages with a reference id (details only in logs),
//   security headers on every response, no CORS headers (hubspot.fetch is proxied server-side), request timeouts.
// - Never log codes, tokens or signed URLs. Logged values from the request are stripped of newlines and truncated.
//
// Custom objects (src/install/scopes.ts): in CUSTOM_WRITE_MODE=conditional the callback chains straight to the
// ?custom=1 consent when the portal granted custom READ but not custom WRITE (Enterprise with custom objects).
// Loop guard: the signed state carries the step; after step 2 we never redirect again, whatever was granted or declined.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { verifyHubSpotSignature } from './signature.js';
import type { TokenResponse } from '../hubspot/oauth.js';
import type { PortalStore } from '../store/portals.js';
import type { Installer } from './installer.js';
import { MAX_SPACING_SECONDS, MIN_SPACING_SECONDS, SettingsValidationError } from './installer.js';
import type { ObjectTypeOption } from './object-types.js';
import { isObjectTypeId } from './pairs.js';
import { customAccess, needsCustomStep, type CustomWriteMode } from './scopes.js';

export const MAX_BODY_BYTES = 64 * 1024;
export const STATE_TTL_MS = 15 * 60 * 1000;
const MAX_USED_NONCES = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 15_000;

/** The only redirect target we ever send a browser to: HubSpot's OAuth authorize page. */
export const HUBSPOT_AUTHORIZE_ORIGIN = 'https://app.hubspot.com';
export const HUBSPOT_AUTHORIZE_PATH = '/oauth/authorize';

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  // Nothing here is meant to be framed: the settings page is a HubSpot UI extension that calls us via the
  // server-side hubspot.fetch proxy, not an iframe.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export interface AppServerOptions {
  installer: Pick<Installer, 'completeInstall' | 'saveSettings'>;
  portals: Pick<PortalStore, 'getPortal' | 'getWatchedPairs' | 'getStampSpacingSeconds' | 'isInstalled'>;
  objectTypes: (portalId: number) => Promise<ObjectTypeOption[]>;
  buildInstallUrl: (state: string, opts?: { custom?: boolean }) => string;
  /** Default 'conditional' (see src/install/scopes.ts). */
  customWriteMode?: CustomWriteMode;
  exchangeCode: (code: string) => Promise<TokenResponse>;
  clientSecret: string;
  callbackPath: string;
  /** HubSpot app ID (HUBSPOT_APP_ID). When set, a finished install redirects to the app's settings tab in HubSpot. */
  appId?: number;
  /** Public origin HubSpot calls (e.g. https://changecatch.fly.dev). Required for the settings API. */
  publicBaseUrl?: string;
  /** Local testing only: skip signature checks and take portalId from the query. Refused outside localhost/dev. */
  allowUnsigned?: boolean;
  /** Defaults to process.env.NODE_ENV. */
  nodeEnv?: string;
  now?: () => number;
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------- config guards

export function isLocalhostUrl(u: string | undefined): boolean {
  if (!u) return true; // unset = nothing public is configured
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** Throws if SETTINGS_ALLOW_UNSIGNED would be unsafe here. src/api/main.ts turns this into exit(1). */
export function assertUnsignedAllowed(o: { allowUnsigned?: boolean; nodeEnv?: string; publicBaseUrl?: string }): void {
  if (!o.allowUnsigned) return;
  if ((o.nodeEnv ?? '').toLowerCase() === 'production') {
    throw new Error('SETTINGS_ALLOW_UNSIGNED=1 is not allowed when NODE_ENV=production. Remove it.');
  }
  if (!isLocalhostUrl(o.publicBaseUrl)) {
    throw new Error(`SETTINGS_ALLOW_UNSIGNED=1 is only allowed when PUBLIC_BASE_URL is localhost (got a public URL). Remove it.`);
  }
}

/** Throws unless the URL is HubSpot's authorize page (no open redirect, even if buildInstallUrl were misconfigured). */
export function assertHubSpotAuthorizeUrl(u: string): string {
  const p = new URL(u);
  if (p.origin !== HUBSPOT_AUTHORIZE_ORIGIN || p.pathname !== HUBSPOT_AUTHORIZE_PATH || p.username || p.password) {
    throw new Error('install URL is not the HubSpot authorize URL');
  }
  return p.toString();
}

// ---------------------------------------------------------------- OAuth state (signed, single-use)

export interface StateCodec {
  /** returnUrl: HubSpot's Marketplace returnUrl, carried through the second consent so we can still go back to it. */
  issue(step: 1 | 2, returnUrl?: string | null): string;
  /** 'none' = no state given; 'invalid' = forged / malformed / expired / reused. */
  take(state: string | null): { status: 'ok'; step: 1 | 2; returnUrl: string | null } | { status: 'none' } | { status: 'invalid'; reason: string };
}

export function createStateCodec(secret: string, now: () => number = Date.now, ttlMs = STATE_TTL_MS): StateCodec {
  const key = createHmac('sha256', secret).update('changecatch/oauth-state/v1').digest();
  const mac = (s: string) => createHmac('sha256', key).update(s).digest('base64url');
  const used = new Map<string, number>(); // nonce -> expiry

  return {
    issue(step, returnUrl) {
      // Format: step.expiry.nonce[.base64url(returnUrl)].mac  (the returnUrl part is optional and also signed)
      const ret = returnUrl ? `.${Buffer.from(returnUrl, 'utf8').toString('base64url')}` : '';
      const body = `${step}.${now() + ttlMs}.${randomBytes(16).toString('base64url')}${ret}`;
      return `${body}.${mac(body)}`;
    },
    take(state) {
      if (!state) return { status: 'none' };
      const parts = state.split('.');
      if (parts.length !== 4 && parts.length !== 5) return { status: 'invalid', reason: 'malformed' };
      const sig = parts.pop()!;
      const [step, exp, nonce, ret] = parts;
      const want = Buffer.from(mac(parts.join('.')));
      const got = Buffer.from(sig);
      if (want.length !== got.length || !timingSafeEqual(want, got)) return { status: 'invalid', reason: 'bad signature' };
      if (step !== '1' && step !== '2') return { status: 'invalid', reason: 'bad step' };
      const t = now();
      if (!(Number(exp) > t)) return { status: 'invalid', reason: 'expired' };
      for (const [n, e] of used) if (e <= t) used.delete(n);
      if (used.has(nonce)) return { status: 'invalid', reason: 'reused' };
      if (used.size >= MAX_USED_NONCES) used.delete(used.keys().next().value!); // bounded memory
      used.set(nonce, Number(exp));
      const returnUrl = ret ? safeReturnUrl(Buffer.from(ret, 'base64url').toString('utf8')) : null;
      return { status: 'ok', step: step === '2' ? 2 : 1, returnUrl };
    },
  };
}

// ---------------------------------------------------------------- where the browser goes after install

/**
 * HubSpot's Marketplace "seamless install" sends ?returnUrl= to our redirect URL; after the code exchange we MUST
 * redirect there ("required to avoid an infinite login loop"):
 *   https://developers.hubspot.com/docs/apps/developer-platform/list-apps/understand-app-install-flow.md
 * Accept only https HubSpot app hosts (app.hubspot.com, app-eu1.hubspot.com, ...), so it can't become an open redirect.
 */
export function safeReturnUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    const okHost = p.hostname === 'app.hubspot.com' || /^app-[a-z]{2,3}\d{1,2}\.hubspot\.com$/.test(p.hostname);
    if (p.protocol !== 'https:' || !okHost || p.username || p.password || p.port) return null;
    return p.toString();
  } catch {
    return null;
  }
}

/**
 * HubSpot web host for the portal's data region. HubSpot OAuth codes and refresh tokens start with the region
 * ("na1-...", "eu1-..."): na1 is app.hubspot.com, any other region is app-<region>.hubspot.com.
 */
export function hubspotAppHost(regionPrefixed?: string | null): string {
  const m = /^([a-z]{2,3}\d{1,2})-/.exec(regionPrefixed ?? '');
  return !m || m[1] === 'na1' ? 'https://app.hubspot.com' : `https://app-${m[1]}.hubspot.com`;
}

/**
 * The ChangeCatch tab in HubSpot (Settings > Integrations > Connected apps > ChangeCatch), where the settings page
 * lives. Not documented by HubSpot; format copied from the browser on 2026-11-07 (without the suffix HubSpot opens
 * the Overview tab; it adds ?accountId= itself):
 *   https://app.hubspot.com/connected-apps/{portalId}/installed/framework/{appId}/settings/general-settings
 */
export function settingsPageUrl(o: { appId?: number; portalId: number; regionPrefixed?: string | null }): string | null {
  if (!o.appId || !Number.isSafeInteger(o.portalId) || o.portalId <= 0) return null;
  return `${hubspotAppHost(o.regionPrefixed)}/connected-apps/${o.portalId}/installed/framework/${o.appId}/settings/general-settings`;
}

/** The OAuth callback must be frameable by HubSpot (Marketplace install runs in an embedded browser context). */
const CALLBACK_FRAME_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self' https://app.hubspot.com https://*.hubspot.com; base-uri 'none'; form-action 'none'",
};

// ---------------------------------------------------------------- helpers

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return reject(new BodyTooLargeError());
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        req.pause();
        reject(new BodyTooLargeError());
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function sendHtml(res: ServerResponse, status: number, title: string, msg: string): void {
  sendPage(res, status, title, `<p>${esc(msg)}</p>`);
}

/** bodyHtml must already be escaped / trusted markup. */
function sendPage(res: ServerResponse, status: number, title: string, bodyHtml: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:sans-serif;max-width:40em;margin:3em auto;line-height:1.5"><h1>${esc(title)}</h1>${bodyHtml}</body>`);
}

// ---------------------------------------------------------------- OAuth error pages

/**
 * HubSpot APP GOVERNANCE: a super admin must approve the app and turn on its extra data permissions.
 * Seen text (2026-10-30, Enterprise custom-object re-test): "Authorization failed because this
 * app hasn't been approved to access the required scopes [...] Please reach out to your account super admin to add the
 * app's permissions in your account's app governance settings." KB: https://knowledge.hubspot.com/integrations/manage-access-to-apps
 */
export function isGovernanceError(error: string | null, description: string | null): boolean {
  return /(?:has ?n[o']t been approved|not been approved|app governance|super ?admin)/i.test(`${error ?? ''} ${description ?? ''}`);
}

const GOVERNANCE_STEPS_HTML =
  '<ol>' +
  '<li>In HubSpot, go to <b>Settings</b> (gear icon) &gt; <b>Integrations</b> &gt; <b>Connected Apps</b>.</li>' +
  '<li>Open the <b>Approved apps</b> tab and click <b>ChangeCatch</b>. (Not listed? Click <b>Approve apps</b>, search for ChangeCatch, click <b>Approve</b>, then <b>Enable all</b>.)</li>' +
  '<li>Click <b>Manage access</b>.</li>' +
  '<li>Under data permissions, turn on the <b>custom object</b> permissions (custom objects write and custom object schemas write). Save.</li>' +
  '</ol>';

/** The friendly page for an OAuth callback that came back with ?error=. Pure (testable); the caller logs. */
export function oauthErrorPage(o: { error: string; description: string | null; step: 1 | 2; ref: string }): { status: number; title: string; html: string; kind: 'governance' | 'custom-declined' | 'other' } {
  const governance = isGovernanceError(o.error, o.description);
  const retry = o.step === 2 || governance ? '/install?custom=1' : '/install';
  const tryAgain = `<p><a href="${retry}">Try again</a></p>`;
  const meanwhile = '<p>Meanwhile, ChangeCatch keeps working for contacts, companies and deals. Only custom-object pairs stay locked.</p>';
  const said = o.description ? `<p>HubSpot said: <i>${esc(o.description.slice(0, 500))}</i></p>` : '';
  const refLine = `<p style="color:#666;font-size:.9em">Reference: ${esc(o.ref)}</p>`;
  if (governance) {
    return {
      status: 403, kind: 'governance', title: 'A super admin needs to approve ChangeCatch',
      html:
        '<p>Your HubSpot account uses <b>app approval</b> (app governance). ChangeCatch&rsquo;s custom-object permissions have not been allowed yet, so HubSpot stopped the request.</p>' +
        said + '<p><b>Ask a super admin to do this:</b></p>' + GOVERNANCE_STEPS_HTML +
        '<p>Then click <b>Try again</b> below (or <b>Enable custom objects</b> on the ChangeCatch settings page) and approve.</p>' +
        tryAgain + meanwhile + refLine,
    };
  }
  if (o.step === 2) {
    // Declined (or failed) the custom-object consent: the first install already worked. Never loop back automatically.
    return {
      status: 200, kind: 'custom-declined', title: 'ChangeCatch is installed',
      html:
        '<p>ChangeCatch works for contacts, companies and deals. Custom objects can be enabled later from the ChangeCatch settings page in HubSpot.</p>' +
        said +
        '<p>If HubSpot blocked the request because your company requires app approval, a super admin must first allow ChangeCatch&rsquo;s custom-object permissions:</p>' +
        GOVERNANCE_STEPS_HTML + tryAgain + refLine,
    };
  }
  const code = /^[a-z_]{1,64}$/.test(o.error) ? ` (${esc(o.error)})` : '';
  return {
    status: 400, kind: 'other', title: 'Install failed',
    html:
      `<p>HubSpot did not complete the install${code}. Nothing was changed in your account.</p>` + said +
      '<p>If your company requires app approval, a super admin may need to approve ChangeCatch first (Settings &gt; Integrations &gt; Connected Apps &gt; Approved apps).</p>' +
      tryAgain + refLine,
  };
}

/** Make a value safe to log: no CR/LF (log injection), no token-ish material, at most 300 chars. */
export function logSafe(v: unknown): string {
  return String(v)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/((?:code|token|refresh_token|access_token|client_secret|state|signature|X-Amz-[A-Za-z-]+)=)[^&\s"]+/gi, '$1[redacted]')
    .replace(/("(?:code|token|refresh_token|access_token|client_secret|state|signature)"\s*:\s*")[^"]*/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/[^\s?"]+\?[^\s"]*/gi, (u) => u.split('?')[0] + '?[redacted]')
    .slice(0, 300);
}

/** Parse + validate the POST body shape. Object types are checked against the portal later. */
export function parseSettingsBody(raw: string): { watchedPairs: { objectTypeId: string; associatedObjectTypeId: string }[]; stampSpacingSeconds: number } {
  let b: any;
  try {
    b = JSON.parse(raw || '{}');
  } catch {
    throw new SettingsValidationError('Body is not JSON');
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new SettingsValidationError('Body must be a JSON object');
  if (!Array.isArray(b.watchedPairs)) throw new SettingsValidationError('watchedPairs must be an array');
  if (b.watchedPairs.length > 200) throw new SettingsValidationError('Too many pairs (max 200)');
  const watchedPairs = b.watchedPairs.map((p: any) => {
    if (!p || !isObjectTypeId(p.objectTypeId) || !isObjectTypeId(p.associatedObjectTypeId)) {
      throw new SettingsValidationError('Each pair needs objectTypeId and associatedObjectTypeId like "0-3"');
    }
    return { objectTypeId: p.objectTypeId, associatedObjectTypeId: p.associatedObjectTypeId };
  });
  const stampSpacingSeconds = Number(b.stampSpacingSeconds);
  return { watchedPairs, stampSpacingSeconds };
}

// ---------------------------------------------------------------- server

export function createAppServer(opts: AppServerOptions): Server {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.log(`[app] ${m}`));
  const mode: CustomWriteMode = opts.customWriteMode ?? 'conditional';
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
  assertUnsignedAllowed({ allowUnsigned: opts.allowUnsigned, nodeEnv, publicBaseUrl: opts.publicBaseUrl });
  const publicBase = opts.publicBaseUrl ? opts.publicBaseUrl.replace(/\/+$/, '') : undefined;
  const states = createStateCodec(opts.clientSecret, now);
  const hsts = publicBase?.startsWith('https://') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {};

  const enableCustomObjectsUrl = publicBase ? `${publicBase}/install?custom=1` : null;
  const LATER = 'Custom objects can be enabled later from the ChangeCatch settings page in HubSpot.';

  function redirectToHubSpot(res: ServerResponse, step: 1 | 2, returnUrl: string | null = null): void {
    const target = assertHubSpotAuthorizeUrl(opts.buildInstallUrl(states.issue(step, returnUrl), { custom: step === 2 }));
    res.writeHead(302, { Location: target });
    res.end();
  }

  /** 302 to a HubSpot page we built or validated (returnUrl / settings tab). */
  function redirectInto(res: ServerResponse, target: string): void {
    res.writeHead(302, { Location: target });
    res.end();
  }

  /** "Open ChangeCatch settings" button for the fallback pages, or '' when we can't build the link. */
  function settingsButton(portalId: number, regionPrefixed: string | null | undefined, label = 'Open ChangeCatch settings in HubSpot'): string {
    const u = settingsPageUrl({ appId: opts.appId, portalId, regionPrefixed });
    return u ? `<p><a href="${esc(u)}" style="display:inline-block;padding:.6em 1.2em;background:#ff7a59;color:#fff;border-radius:4px;text-decoration:none">${esc(label)}</a></p>` : '';
  }

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
        log(`settings[${ref}]: PUBLIC_BASE_URL is not set; refusing (signatures cover the public URL)`);
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
        uri: publicBase + path, // from config, never from Host / X-Forwarded-* headers
        rawBody,
        headers: req.headers,
        now: now(),
        requireV3: true,
      });
      if (!v.ok) {
        log(`settings[${ref}]: rejected signature (${v.version}: ${v.reason})`);
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

  async function settingsView(portalId: number) {
    const portal = opts.portals.getPortal(portalId);
    const access = customAccess(portal?.scopes ?? []);
    return {
      portalId,
      // Custom object types are only selectable once the custom write scopes are granted.
      objectTypes: (await opts.objectTypes(portalId)).map((t) => ({ ...t, selectable: !t.custom || access.enabled })),
      customObjectsAvailable: access.available,
      customObjectsEnabled: access.enabled,
      enableCustomObjectsUrl,
      watchedPairs: opts.portals.getWatchedPairs(portalId),
      stampSpacingSeconds: opts.portals.getStampSpacingSeconds(portalId),
      spacingLimits: { min: MIN_SPACING_SECONDS, max: MAX_SPACING_SECONDS },
      // Stored provisioning errors can hold HubSpot response text: only say whether there was one.
      lastProvisionError: portal?.lastProvisionError ? 'The last setup attempt did not finish.' : null,
    };
  }

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

      if (req.method === 'GET' && (path === '/' || path === '/install')) {
        return redirectToHubSpot(res, url.searchParams.get('custom') === '1' ? 2 : 1);
      }

      if (req.method === 'GET' && path === opts.callbackPath) {
        // HubSpot's Marketplace install may load this URL in an embedded browser: allow HubSpot to frame it.
        res.removeHeader('X-Frame-Options');
        for (const [k, v] of Object.entries(CALLBACK_FRAME_HEADERS)) res.setHeader(k, v);
        const error = url.searchParams.get('error');
        const st = states.take(url.searchParams.get('state'));
        if (st.status === 'invalid') {
          // A state was sent but it isn't one we issued (or it expired / was used): possible CSRF. Don't exchange the code.
          log(`oauth[${ref}]: rejected state (${st.reason})`);
          return sendHtml(res, 400, 'Install link expired', 'This install link has expired or was already used. Please start the install again.');
        }
        const step = st.status === 'ok' ? st.step : 1;
        // Marketplace returnUrl: on the URL for a HubSpot-initiated install, or carried in our state through step 2.
        const returnUrl = safeReturnUrl(url.searchParams.get('returnUrl')) ?? (st.status === 'ok' ? st.returnUrl : null);
        if (error) {
          // The app is already installed when the optional custom-object consent (step 2) is declined: in the
          // Marketplace flow we must still go back to HubSpot, or the user is stuck in a login loop.
          if (step === 2 && returnUrl) {
            log(`oauth[${ref}]: custom-object consent not granted (${logSafe(error)}); returning to HubSpot`);
            return redirectInto(res, returnUrl);
          }
          // Friendly page (governance / declined custom consent / other). Step 2 never loops back automatically.
          const description = url.searchParams.get('error_description');
          const page = oauthErrorPage({ error, description, step, ref });
          log(`oauth[${ref}]: HubSpot returned error ${logSafe(error)} at step ${step} (${page.kind})${description ? `: ${logSafe(description)}` : ''}`);
          return sendPage(res, page.status, page.title, page.html);
        }
        const code = url.searchParams.get('code');
        if (!code) return sendHtml(res, 400, 'Install failed', 'Missing ?code.');
        // Installs started from HubSpot's own "Install" button / Marketplace carry no state of ours. Allow, but log:
        // the code can only be exchanged with our client secret + redirect URI anyway.
        const source = st.status === 'ok' ? `app-initiated step ${step}` : 'hubspot-initiated (no state)';

        let t: TokenResponse;
        try {
          t = await opts.exchangeCode(code);
        } catch (e) {
          log(`oauth[${ref}]: code exchange failed (${source}): ${logSafe((e as Error).message)}`);
          return sendHtml(res, 500, 'Install failed', `Could not finish the install with HubSpot. Please try installing again. Reference: ${ref}`);
        }
        log(`oauth[${ref}]: install for portal ${Number(t.hub_id)} (${source})`);
        try {
          const r = await opts.installer.completeInstall(t);
          const granted = t.scopes ?? [];
          if (needsCustomStep(granted, mode, step)) {
            log(`install[${ref}]: portal ${r.portalId} has custom objects but no custom write scopes: asking for them now`);
            return redirectToHubSpot(res, 2, returnUrl);
          }
          // Done: Marketplace install -> back to HubSpot's returnUrl (required). Our own install link -> straight to
          // the ChangeCatch settings tab in HubSpot, where the admin picks object pairs.
          const target = returnUrl ?? settingsPageUrl({ appId: opts.appId, portalId: r.portalId, regionPrefixed: t.refresh_token ?? code });
          if (target) return redirectInto(res, target);
          // Fallback when HUBSPOT_APP_ID isn't configured.
          const access = customAccess(granted);
          const note = access.available && !access.enabled ? ` ${LATER}` : '';
          return sendHtml(res, 200, 'ChangeCatch is installed',
            `Watching ${r.watchedPairs.length} object pair(s) in account ${r.portalId}. Change them in HubSpot under Settings > Connected apps > ChangeCatch.${note} You can close this tab.`);
        } catch (e) {
          // Tokens are saved before provisioning, so the admin can fix it from the settings page (Save retries).
          log(`install[${ref}]: provisioning failed: ${logSafe((e as Error).message)}`);
          if (returnUrl) return redirectInto(res, returnUrl); // never strand a Marketplace install; the settings page shows the error
          return sendPage(res, 500, 'Installed, but setup did not finish',
            `<p>${esc(`ChangeCatch is installed, but setup did not finish. Open the ChangeCatch settings page in HubSpot and press Save to retry. Reference: ${ref}`)}</p>` +
              settingsButton(Number(t.hub_id), t.refresh_token ?? code));
        }
      }

      if (path === '/api/settings' && (req.method === 'GET' || req.method === 'POST')) {
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
        if (req.method === 'GET') return sendJson(res, 200, await settingsView(portalId));

        try {
          const input = parseSettingsBody(raw);
          const types = await opts.objectTypes(portalId);
          const report = await opts.installer.saveSettings(portalId, input, types.map((t) => t.objectTypeId));
          return sendJson(res, 200, {
            ok: true,
            ...(await settingsView(portalId)),
            changes: { subscriptions: report.subscriptions, propertiesCreatedOn: report.properties.map((p) => p.objectType) },
          });
        } catch (e) {
          if (e instanceof SettingsValidationError) return sendJson(res, 400, { error: e.message });
          log(`settings[${ref}]: save failed for ${portalId}: ${logSafe((e as Error).message)}`);
          return sendJson(res, 502, { error: 'Saving failed. Nothing was lost; press Save to retry.', ref });
        }
      }

      if (path === '/api/settings') return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, POST' });
      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      log(`unhandled[${ref}] ${req.method} ${logSafe(path)}: ${logSafe((e as Error).message)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error', ref });
      else res.end();
    }
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}
