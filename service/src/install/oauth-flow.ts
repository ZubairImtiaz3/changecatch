// The OAuth install flow: /install redirect, the callback (code exchange, provisioning), the second consent for
// custom-object write scopes, and where the browser lands afterwards.
//
// Security:
// - OAuth state is HMAC-signed (step + expiry + nonce) and single-use, so it can't be forged or replayed.
//   Installs from HubSpot's own Install button carry no state: allowed, but logged. A state that IS present but
//   expired/forged/reused is rejected (CSRF). Redirects only go to the fixed HubSpot authorize URL, a validated HubSpot
//   returnUrl (https app[-region].hubspot.com only), or the settings tab URL we build from portalId + HUBSPOT_APP_ID.
// - Only the callback may be framed (by *.hubspot.com), as HubSpot's embedded Marketplace install needs.
// - Never log codes, tokens or signed URLs (the structured logger redacts them; request values are clipped).
//
// Custom objects (src/install/scopes.ts): the callback chains straight to the ?custom=1 consent when the portal granted
// custom READ but not custom WRITE (Enterprise with custom objects).
// Loop guard: the signed state carries the step; after step 2 we never redirect again, whatever was granted or declined.

import type { ServerResponse } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OAuthApp, TokenResponse } from '../hubspot/oauth.js';
import type { Installer } from './installer.js';
import { customWriteMissing } from '../core/pairs.js';
import { installScopes, needsCustomStep } from './scopes.js';
import { clip, redirect } from './http-util.js';
import type { Errors } from '../obs/errors.js';
import type { Logger } from '../obs/log.js';
import { oauthErrorPage, sendHtml, sendInstalledPage, sendPage, sendSetupUnfinishedPage } from './pages.js';

const STATE_TTL_MS = 15 * 60 * 1000;
const MAX_USED_NONCES = 10_000;

/** HubSpot's OAuth authorize page: the only place /install redirects to. */
export const HUBSPOT_AUTHORIZE_URL = 'https://app.hubspot.com/oauth/authorize';

/**
 * The authorize URL for one install step. Scopes are space-separated; step 2 adds the conditionally required custom
 * write scopes to `scope` (src/install/scopes.ts).
 * Docs: https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/working-with-oauth
 */
export function buildInstallUrl(app: Pick<OAuthApp, 'clientId' | 'redirectUri'>, state: string, opts: { custom?: boolean } = {}): string {
  const { scope, optionalScope } = installScopes({ custom: opts.custom });
  const u = new URL(HUBSPOT_AUTHORIZE_URL);
  u.searchParams.set('client_id', app.clientId);
  u.searchParams.set('redirect_uri', app.redirectUri);
  u.searchParams.set('scope', scope.join(' '));
  if (optionalScope.length) u.searchParams.set('optional_scope', optionalScope.join(' '));
  u.searchParams.set('state', state);
  return u.toString();
}

/** Throws unless the URL is HubSpot's authorize page (no open redirect, even if buildInstallUrl were misconfigured). */
export function assertHubSpotAuthorizeUrl(u: string): string {
  const p = new URL(u);
  if (`${p.origin}${p.pathname}` !== HUBSPOT_AUTHORIZE_URL || p.username || p.password) {
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

/** A HubSpot data region as it appears in hosts and token prefixes: na1, eu1, ap1, ... */
const REGION = String.raw`[a-z]{2,3}\d{1,2}`;
const REGION_APP_HOST = new RegExp(String.raw`^app-${REGION}\.hubspot\.com$`);
const REGION_PREFIX = new RegExp(`^(${REGION})-`);

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
    const okHost = p.hostname === 'app.hubspot.com' || REGION_APP_HOST.test(p.hostname);
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
function hubspotAppHost(regionPrefixed?: string | null): string {
  const m = REGION_PREFIX.exec(regionPrefixed ?? '');
  return !m || m[1] === 'na1' ? 'https://app.hubspot.com' : `https://app-${m[1]}.hubspot.com`;
}

/**
 * The ChangeCatch tab in HubSpot (Settings > Integrations > Connected apps > ChangeCatch), where the settings page
 * lives. Not documented by HubSpot; format copied from the browser on 2026-11-07 (without the suffix HubSpot opens
 * the Overview tab; it adds ?accountId= itself):
 *   https://app.hubspot.com/connected-apps/{portalId}/installed/framework/{appId}/settings/general-settings
 */
function settingsPageUrl(o: { appId?: number; portalId: number; regionPrefixed?: string | null }): string | null {
  if (!o.appId || !Number.isSafeInteger(o.portalId) || o.portalId <= 0) return null;
  return `${hubspotAppHost(o.regionPrefixed)}/connected-apps/${o.portalId}/installed/framework/${o.appId}/settings/general-settings`;
}

/** The OAuth callback must be frameable by HubSpot (Marketplace install runs in an embedded browser context). */
const CALLBACK_FRAME_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self' https://app.hubspot.com https://*.hubspot.com; base-uri 'none'; form-action 'none'",
};

// ---------------------------------------------------------------- the flow

export interface OAuthFlowOptions {
  installer: Pick<Installer, 'completeInstall'>;
  oauthApp: Pick<OAuthApp, 'clientId' | 'redirectUri'>;
  exchangeCode: (code: string) => Promise<TokenResponse>;
  clientSecret: string;
  /** HubSpot app ID (HUBSPOT_APP_ID). When set, a finished install redirects to the app's settings tab in HubSpot. */
  appId?: number;
  now: () => number;
  log: Logger;
  errors: Pick<Errors, 'capture'>;
}

export interface OAuthFlow {
  /** GET /install (step 1) or /install?custom=1 (step 2: the conditionally required custom-object write scopes). */
  startInstall(res: ServerResponse, step: 1 | 2): void;
  callback(res: ServerResponse, url: URL, ref: string): Promise<void>;
}

export function createOAuthFlow(opts: OAuthFlowOptions): OAuthFlow {
  const { log, errors: errs } = opts;
  const states = createStateCodec(opts.clientSecret, opts.now);

  function startInstall(res: ServerResponse, step: 1 | 2, returnUrl: string | null = null): void {
    redirect(res, assertHubSpotAuthorizeUrl(buildInstallUrl(opts.oauthApp, states.issue(step, returnUrl), { custom: step === 2 })));
  }

  async function callback(res: ServerResponse, url: URL, ref: string): Promise<void> {
    res.removeHeader('X-Frame-Options');
    for (const [k, v] of Object.entries(CALLBACK_FRAME_HEADERS)) res.setHeader(k, v);
    const error = url.searchParams.get('error');
    const st = states.take(url.searchParams.get('state'));
    if (st.status === 'invalid') {
      // A state was sent but it isn't one we issued (or it expired / was used): possible CSRF. Don't exchange the code.
      log.warn('oauth_state_rejected', `oauth[${ref}]: rejected state (${st.reason})`, { ref });
      return sendHtml(res, 400, 'Install link expired', 'This install link has expired or was already used. Please start the install again.');
    }
    const step = st.status === 'ok' ? st.step : 1;
    // Marketplace returnUrl: on the URL for a HubSpot-initiated install, or carried in our state through step 2.
    const returnUrl = safeReturnUrl(url.searchParams.get('returnUrl')) ?? (st.status === 'ok' ? st.returnUrl : null);
    if (error) {
      // The app is already installed when the optional custom-object consent (step 2) is declined: in the
      // Marketplace flow we must still go back to HubSpot, or the user is stuck in a login loop.
      if (step === 2 && returnUrl) {
        log.info('oauth_custom_consent_declined', `oauth[${ref}]: custom-object consent not granted (${clip(error)}); returning to HubSpot`, { ref });
        return redirect(res, returnUrl);
      }
      const description = url.searchParams.get('error_description');
      const page = oauthErrorPage({ error, description, step, ref });
      log.warn('oauth_error', `oauth[${ref}]: HubSpot returned error ${clip(error)} at step ${step} (${page.kind})${description ? `: ${clip(description)}` : ''}`, { ref });
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
      log.error('oauth_code_exchange_failed', `oauth[${ref}]: code exchange failed (${source}): ${clip((e as Error).message)}`, { ref });
      errs.capture(e, { op: 'oauth_code_exchange', extra: { ref } });
      return sendHtml(res, 500, 'Install failed', `Could not finish the install with HubSpot. Please try installing again. Reference: ${ref}`);
    }
    log.info('oauth_install', `oauth[${ref}]: install for portal ${Number(t.hub_id)} (${source})`, { ref, portalId: Number(t.hub_id) });
    const regionPrefixed = t.refresh_token ?? code;
    try {
      const r = await opts.installer.completeInstall(t);
      const granted = t.scopes ?? [];
      if (needsCustomStep(granted, step)) {
        log.info('install_custom_step', `install[${ref}]: portal ${r.portalId} has custom objects but no custom write scopes: asking for them now`, {
          ref,
          portalId: r.portalId,
        });
        return startInstall(res, 2, returnUrl);
      }
      // Marketplace install -> back to HubSpot's returnUrl (required). Our own install link -> straight to the
      // ChangeCatch settings tab in HubSpot, where the admin picks object pairs.
      const target = returnUrl ?? settingsPageUrl({ appId: opts.appId, portalId: r.portalId, regionPrefixed });
      if (target) return redirect(res, target);
      return sendInstalledPage(res, { portalId: r.portalId, pairCount: r.watchedPairs.length, customLater: customWriteMissing(granted) });
    } catch (e) {
      // Tokens are saved before provisioning, so the admin can fix it from the settings page (Save retries).
      log.error('install_provisioning_failed', `install[${ref}]: provisioning failed: ${clip((e as Error).message)}`, { ref, portalId: Number(t.hub_id) });
      errs.capture(e, { op: 'install', portalId: Number(t.hub_id), extra: { ref } });
      if (returnUrl) return redirect(res, returnUrl); // never strand a Marketplace install; the settings page shows the error
      return sendSetupUnfinishedPage(res, ref, settingsPageUrl({ appId: opts.appId, portalId: Number(t.hub_id), regionPrefixed }));
    }
  }

  return { startInstall: (res, step) => startInstall(res, step), callback };
}
