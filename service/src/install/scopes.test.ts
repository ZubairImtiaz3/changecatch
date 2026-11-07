// APP_SCOPES vs app-hsmeta.json (one source of truth). Custom-object scopes: install URL lists, the automatic second consent step (and its loop guard), settings view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TokenResponse } from '../hubspot/oauth.js';
import { PortalStore } from '../store/portals.js';
import type { ChangeReport } from './installer.js';
import { buildInstallUrl, HUBSPOT_AUTHORIZE_URL, safeReturnUrl } from './oauth-flow.js';
import { listen, testAppServer } from '../../test/fixtures/app-server.js';
import { APP_SCOPES, installScopes, needsCustomStep } from './scopes.js';
import { CUSTOM_WRITE_SCOPES, customAccess } from '../core/pairs.js';
import { parseKeyring } from '../lib/crypto.js';

const PRO = ['oauth', 'crm.objects.deals.read'];
const ENT_READ = [...PRO, 'crm.objects.custom.read', 'crm.schemas.custom.read'];
const ENT_ALL = [...ENT_READ, ...CUSTOM_WRITE_SCOPES];

// Copies of hubspot-app/src/app/app-hsmeta.json values must match it exactly (reading the other package is fine in a
// test; the service itself never does it at runtime).
const appFile = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../hubspot-app/src/app/${rel}`, import.meta.url)), 'utf8');
const meta = JSON.parse(appFile('app-hsmeta.json')).config;

test('APP_SCOPES matches hubspot-app/src/app/app-hsmeta.json', () => {
  const auth = meta.auth;
  const sorted = (xs: readonly string[] | undefined) => [...(xs ?? [])].sort();
  assert.deepEqual(sorted(APP_SCOPES.required), sorted(auth.requiredScopes), 'requiredScopes drifted');
  assert.deepEqual(sorted(APP_SCOPES.optional), sorted(auth.optionalScopes), 'optionalScopes drifted');
  assert.deepEqual(sorted(APP_SCOPES.conditional), sorted(auth.conditionallyRequiredScopes), 'conditionallyRequiredScopes drifted');
});

test('the settings page SUPPORT_EMAIL matches app-hsmeta.json support.supportEmail', () => {
  const page = /const SUPPORT_EMAIL = '([^']+)'/.exec(appFile('settings/ChangeCatchSettings.tsx'))?.[1];
  assert.ok(meta.support?.supportEmail, 'app-hsmeta.json has no support.supportEmail');
  assert.equal(page, meta.support.supportEmail);
});

test('scopes: install URL lists (custom write only on the ?custom=1 step)', () => {
  assert.deepEqual(installScopes(), { scope: APP_SCOPES.required, optionalScope: APP_SCOPES.optional });
  assert.deepEqual(installScopes({ custom: true }), { scope: [...APP_SCOPES.required, ...APP_SCOPES.conditional], optionalScope: APP_SCOPES.optional });

  const app = { clientId: 'cid', redirectUri: 'http://localhost:3001/oauth/callback' };
  const u = new URL(buildInstallUrl(app, 'st', { custom: true }));
  assert.equal(`${u.origin}${u.pathname}`, HUBSPOT_AUTHORIZE_URL);
  assert.equal(u.searchParams.get('scope'), [...APP_SCOPES.required, ...APP_SCOPES.conditional].join(' '));
  assert.equal(u.searchParams.get('optional_scope'), APP_SCOPES.optional.join(' '));
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('state'), 'st');
  // Conditional scopes are NOT in a plain install URL.
  const plain = new URL(buildInstallUrl(app, 'st'));
  assert.equal(plain.searchParams.get('scope'), APP_SCOPES.required.join(' '));
  assert.ok(!(plain.searchParams.get('optional_scope') ?? '').includes('crm.objects.custom.write'));
});

test('scopes: redirect decision', () => {
  assert.deepEqual(customAccess(ENT_READ), { available: true, enabled: false });
  assert.equal(needsCustomStep(ENT_READ, 1), true, 'custom read granted + write missing -> redirect');
  assert.equal(needsCustomStep(PRO, 1), false, 'Pro (no custom objects) -> no redirect');
  assert.equal(needsCustomStep(ENT_ALL, 1), false, 'already granted -> no redirect');
  assert.equal(needsCustomStep(ENT_READ, 2), false, 'step 2 -> never again (loop guard)');
  assert.equal(needsCustomStep(['crm.objects.custom.read', 'crm.objects.custom.write'], 1), true, 'both write scopes needed');
});

// ---------------------------------------------------------------- the server flow

/** A redirect to HubSpot's authorize page for step 2 (the custom write scopes are in `scope`). */
const asksCustomWrite = (loc: string | null) => (new URL(loc ?? '').searchParams.get('scope') ?? '').split(' ').includes('crm.objects.custom.write');

/** `grants`: the scopes HubSpot grants per authorization code (by code, not call order, so tests stay deterministic). */
async function startServer(grants: Record<string, string[]>, extra: { appId?: number; refreshToken?: string } = {}) {
  const portals = new PortalStore({ path: ':memory:', key: parseKeyring(`t:${randomBytes(32).toString('base64')}`) });
  const grantsFor = (code: string) => {
    if (!(code in grants)) throw new Error(`test: no grants for code ${code}`);
    return grants[code];
  };
  const installs: number[] = [];
  const server = testAppServer({
    installer: {
      completeInstall: async (t: TokenResponse) => {
        portals.saveInstall(Number(t.hub_id), t.refresh_token!, t.scopes ?? []);
        installs.push(Number(t.hub_id));
        return { portalId: Number(t.hub_id), watchedPairs: [], properties: [], subscriptions: { created: [], deleted: [], unchanged: [] } } as ChangeReport;
      },
      objectTypes: async () => [{ objectTypeId: '0-3', singular: 'Deal', plural: 'Deals', custom: false }, { objectTypeId: '2-9', singular: 'Pet', plural: 'Pets', custom: true }],
    },
    portals,
    publicBaseUrl: 'http://localhost:3001/', // allowUnsigned is only accepted for localhost
    allowUnsigned: true,
    appId: extra.appId,
    exchangeCode: async (code) => ({ token_type: 'bearer', access_token: 'a', refresh_token: extra.refreshToken ?? 'r', expires_in: 1800, hub_id: 111, scopes: grantsFor(code) }),
  });
  const base = await listen(server);
  const get = (p: string) => fetch(base + p, { redirect: 'manual' });
  const stateOf = (loc: string | null) => new URL(loc!).searchParams.get('state')!;
  return { server, portals, installs, get, stateOf, close: () => new Promise((r) => server.close(r)) };
}

test('callback: Enterprise without custom write -> straight to the ?custom=1 consent; step 2 never loops', async () => {
  const s = await startServer({ c1: ENT_READ, c2: ENT_READ }); // HubSpot still doesn't grant write on step 2
  try {
    const st1 = s.stateOf((await s.get('/install')).headers.get('location'));
    const cb1 = await s.get(`/oauth/callback?code=c1&state=${st1}`);
    assert.equal(cb1.status, 302);
    const loc = cb1.headers.get('location')!;
    assert.ok(asksCustomWrite(loc));
    const cb2 = await s.get(`/oauth/callback?code=c2&state=${s.stateOf(loc)}`);
    assert.equal(cb2.status, 200, 'no second redirect');
    assert.match(await cb2.text(), /enabled later/);
    assert.deepEqual(s.installs, [111, 111], 'both steps saved the install');
  } finally {
    await s.close();
  }
});

test('callback: step 2 declined -> "installed" page, no loop; Pro and already-granted portals never redirect', async () => {
  const s = await startServer({ c1: ENT_READ, c2: PRO, c3: ENT_ALL });
  try {
    const cb1 = await s.get(`/oauth/callback?code=c1`); // install started in HubSpot (no state of ours) = step 1
    assert.equal(cb1.status, 302);
    const declined = await s.get(`/oauth/callback?error=access_denied&state=${s.stateOf(cb1.headers.get('location'))}`);
    assert.equal(declined.status, 200);
    assert.match(await declined.text(), /Custom objects can be enabled later/);

    const pro = await s.get('/oauth/callback?code=c2');
    assert.equal(pro.status, 200);
    assert.doesNotMatch(await pro.text(), /custom/i);

    const ent = await s.get('/oauth/callback?code=c3');
    assert.equal(ent.status, 200);

    // /install?custom=1 (the settings-page backup link) asks for the conditional scopes; a stale step-2 state can't be reused.
    const manual = await s.get('/install?custom=1');
    assert.ok(asksCustomWrite(manual.headers.get('location')));
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- where the browser lands after install

const APP_ID = 60681660;
const SETTINGS = `https://app.hubspot.com/connected-apps/111/installed/framework/${APP_ID}/settings/general-settings`;

test('landing: our own install link -> straight to the ChangeCatch settings tab (after the custom consent)', async () => {
  const s = await startServer({ 'na1-c1': ENT_READ, 'na1-c2': ENT_ALL, 'na1-c3': PRO }, { appId: APP_ID, refreshToken: 'na1-' + 'abc' });
  try {
    const st1 = s.stateOf((await s.get('/install')).headers.get('location'));
    const cb1 = await s.get(`/oauth/callback?code=na1-c1&state=${st1}`);
    assert.ok(asksCustomWrite(cb1.headers.get('location')), 'custom consent first');
    const cb2 = await s.get(`/oauth/callback?code=na1-c2&state=${s.stateOf(cb1.headers.get('location'))}`);
    assert.equal(cb2.status, 302);
    assert.equal(cb2.headers.get('location'), SETTINGS);
    const pro = await s.get('/oauth/callback?code=na1-c3'); // HubSpot-initiated, Pro: no consent step
    assert.equal(pro.headers.get('location'), SETTINGS);
  } finally {
    await s.close();
  }
});

test('landing: EU portals go to app-eu1.hubspot.com', async () => {
  const s = await startServer({ 'eu1-c1': PRO }, { appId: APP_ID, refreshToken: 'eu1-' + 'abc' });
  try {
    assert.equal((await s.get('/oauth/callback?code=eu1-c1')).headers.get('location'), `https://app-eu1.hubspot.com/connected-apps/111/installed/framework/${APP_ID}/settings/general-settings`);
  } finally {
    await s.close();
  }
});

test('landing: Marketplace returnUrl wins, survives the custom consent, and is used even when step 2 is declined', async () => {
  const ret = 'https://app.hubspot.com/marketplace/111/install-complete?x=1';
  const s = await startServer({ c1: ENT_READ, c2: ENT_ALL, c3: ENT_READ }, { appId: APP_ID });
  try {
    const q = `returnUrl=${encodeURIComponent(ret)}&step=finalize`;
    const cb1 = await s.get(`/oauth/callback?code=c1&${q}`);
    const consent = cb1.headers.get('location')!;
    assert.ok(asksCustomWrite(consent));
    assert.doesNotMatch(consent, /marketplace/, 'returnUrl travels inside the signed state, not in clear');
    const cb2 = await s.get(`/oauth/callback?code=c2&state=${s.stateOf(consent)}`);
    assert.equal(cb2.headers.get('location'), ret);

    const cb3 = await s.get(`/oauth/callback?code=c3&${q}`);
    const declined = await s.get(`/oauth/callback?error=access_denied&state=${s.stateOf(cb3.headers.get('location'))}`);
    assert.equal(declined.status, 302);
    assert.equal(declined.headers.get('location'), ret, 'declining custom objects must not strand a Marketplace install');
  } finally {
    await s.close();
  }
});

test('landing: a non-HubSpot returnUrl is ignored (no open redirect)', async () => {
  const s = await startServer({ c: PRO }, { appId: APP_ID });
  try {
    for (const bad of ['https://evil.example/x', 'http://app.hubspot.com/x', 'https://app.hubspot.com.evil.example/', 'https://user@app.hubspot.com/', 'javascript:alert(1)']) {
      const r = await s.get(`/oauth/callback?code=c&returnUrl=${encodeURIComponent(bad)}`);
      assert.equal(r.headers.get('location'), SETTINGS, bad);
    }
  } finally {
    await s.close();
  }
  assert.equal(safeReturnUrl('https://app-eu1.hubspot.com/a'), 'https://app-eu1.hubspot.com/a');
  assert.equal(safeReturnUrl('https://app.hubspot.com:8443/a'), null);
});

test('landing: the callback can be framed by HubSpot; other routes still cannot be framed', async () => {
  const s = await startServer({ c1: PRO }, { appId: APP_ID });
  try {
    const cb = await s.get('/oauth/callback?code=c1');
    assert.match(cb.headers.get('content-security-policy')!, /frame-ancestors 'self' https:\/\/app\.hubspot\.com/);
    assert.equal(cb.headers.get('x-frame-options'), null);
    const other = await s.get('/health');
    assert.match(other.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal(other.headers.get('x-frame-options'), 'DENY');
  } finally {
    await s.close();
  }
});

test('landing: without HUBSPOT_APP_ID the plain "installed" page is kept', async () => {
  const s = await startServer({ c1: PRO });
  try {
    const r = await s.get('/oauth/callback?code=c1');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /ChangeCatch is installed/);
  } finally {
    await s.close();
  }
});

test('settings GET: custom-object flags, backup URL, custom types selectable only when enabled', async () => {
  const s = await startServer({});
  try {
    s.portals.saveInstall(111, 'r', ENT_READ);
    let body = (await (await s.get('/api/settings?portalId=111')).json()) as any;
    assert.equal(body.customObjectsAvailable, true);
    assert.equal(body.customObjectsEnabled, false);
    assert.equal(body.enableCustomObjectsUrl, 'http://localhost:3001/install?custom=1');
    assert.deepEqual(body.objectTypes.map((t: { objectTypeId: string; selectable: boolean }) => [t.objectTypeId, t.selectable]), [['0-3', true], ['2-9', false]]);

    s.portals.saveInstall(111, 'r', ENT_ALL);
    body = (await (await s.get('/api/settings?portalId=111')).json()) as any;
    assert.equal(body.customObjectsEnabled, true);
    assert.deepEqual(body.objectTypes.map((t: { selectable: boolean }) => t.selectable), [true, true]);
  } finally {
    await s.close();
  }
});

const GOV = "Authorization failed because this app hasn't been approved to access the required scopes [crm.objects.custom.write, crm.schemas.custom.write] in your account. Please reach out to your account super admin to add the app's permissions in your account's app governance settings.";

test('callback error page: app governance -> super-admin steps, retry link to ?custom=1, standard objects still work', async () => {
  const s = await startServer({});
  try {
    const st = s.stateOf((await s.get('/install?custom=1')).headers.get('location'));
    const r = await s.get(`/oauth/callback?error=access_denied&error_description=${encodeURIComponent(GOV)}&state=${st}`);
    assert.equal(r.status, 403);
    const html = await r.text();
    assert.match(html, /super admin needs to approve ChangeCatch/);
    assert.match(html, /Approved apps/);
    assert.match(html, /Manage access/);
    assert.ok(html.includes('href="/install?custom=1"'));
    assert.match(html, /keeps working for contacts, companies and deals/);
    assert.match(html, /hasn&#39;t been approved/, 'HubSpot text is shown escaped');
    // Governance wording is detected even without our state (step 1).
    const r2 = await s.get(`/oauth/callback?error=unauthorized&error_description=${encodeURIComponent('Please reach out to your account super admin')}`);
    assert.equal(r2.status, 403);
    assert.deepEqual(s.installs, [], 'no install attempted');
  } finally {
    await s.close();
  }
});

test('callback error page: custom step access_denied shows the governance hint; other errors are escaped and offer a retry', async () => {
  const s = await startServer({});
  try {
    const st = s.stateOf((await s.get('/install?custom=1')).headers.get('location'));
    const declined = await s.get(`/oauth/callback?error=access_denied&state=${st}`);
    assert.equal(declined.status, 200);
    const d = await declined.text();
    assert.match(d, /Custom objects can be enabled later/);
    assert.match(d, /Approved apps/);
    assert.ok(d.includes('href="/install?custom=1"'));

    const other = await s.get(`/oauth/callback?error=server_error&error_description=${encodeURIComponent('<script>x</script>')}`);
    assert.equal(other.status, 400);
    const o = await other.text();
    assert.match(o, /Install failed/);
    assert.ok(o.includes('href="/install"'));
    assert.ok(!o.includes('<script>'), 'description is escaped');
  } finally {
    await s.close();
  }
});
