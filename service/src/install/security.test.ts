// Security tests: settings signatures (v3 only), unsigned-mode guard, OAuth state, body limit, headers,
// token key rotation, refresh-token revocation. No network calls to HubSpot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { signV3, verifyHubSpotSignature } from './signature.js';
import type { TokenResponse } from '../hubspot/oauth.js';
import { PortalStore } from '../store/portals.js';
import { parseKeyring } from '../lib/crypto.js';
import type { ChangeReport } from './installer.js';
import { MAX_BODY_BYTES } from './http-util.js';
import { assertHubSpotAuthorizeUrl, createStateCodec } from './oauth-flow.js';
import type { AppServerOptions } from './server.js';
import { listen, testAppServer } from '../../test/fixtures/app-server.js';
import { Logger } from '../obs/log.js';

const P = 4242;
const SECRET = 'client-secret';
const BASE = 'https://changecatch.example.com';

// ---------------------------------------------------------------- signature verifier

test('signature: v3 valid / expired / tampered / v2-only rejected', () => {
  const uri = `${BASE}/api/settings?portalId=${P}`;
  const now = 1_800_000_000_000;
  const ts = String(now);
  const headers = { 'x-hubspot-signature-v3': signV3(SECRET, 'POST', uri, '{"a":1}', ts), 'x-hubspot-request-timestamp': ts };
  const base = { secret: SECRET, method: 'POST', uri, rawBody: '{"a":1}', headers, now };
  assert.deepEqual(verifyHubSpotSignature(base), { ok: true });
  assert.equal(verifyHubSpotSignature({ ...base, now: now + 5 * 60 * 1000 + 1 }).ok, false, 'expired');
  assert.equal(verifyHubSpotSignature({ ...base, now: now - 5 * 60 * 1000 - 1 }).ok, false, 'future');
  assert.equal(verifyHubSpotSignature({ ...base, rawBody: '{"a":2}' }).ok, false, 'tampered body');
  assert.equal(verifyHubSpotSignature({ ...base, uri: uri.replace(String(P), '1') }).ok, false, 'tampered portal');
  assert.equal(verifyHubSpotSignature({ ...base, method: 'GET' }).ok, false, 'tampered method');
  assert.equal(verifyHubSpotSignature({ ...base, secret: 'other' }).ok, false, 'wrong secret');

  const v2 = { 'x-hubspot-signature': 'a'.repeat(64), 'x-hubspot-signature-version': 'v2' };
  assert.deepEqual(verifyHubSpotSignature({ ...base, headers: v2 }), { ok: false, reason: 'v3 signature required' });
});

// ---------------------------------------------------------------- redirect target

test('redirects only go to the HubSpot authorize URL', () => {
  assert.ok(assertHubSpotAuthorizeUrl('https://app.hubspot.com/oauth/authorize?client_id=1'));
  for (const bad of ['https://evil.com/oauth/authorize', 'http://app.hubspot.com/oauth/authorize', 'https://app.hubspot.com.evil.com/oauth/authorize', 'https://app.hubspot.com/other', 'https://u:p@app.hubspot.com/oauth/authorize']) {
    assert.throws(() => assertHubSpotAuthorizeUrl(bad), Error, bad);
  }
});

// ---------------------------------------------------------------- OAuth state

test('state: signed, single-use, expires, rejects forgeries', () => {
  let t = 1_000_000;
  const c = createStateCodec(SECRET, () => t, 60_000);
  const s1 = c.issue(1);
  assert.deepEqual(c.take(s1), { status: 'ok', step: 1, returnUrl: null });
  assert.equal(c.take(s1).status, 'invalid', 'reuse');
  assert.deepEqual(c.take(null), { status: 'none' });
  const s2 = c.issue(2);
  assert.equal(c.take(s2.replace(/^2\./, '1.')).status, 'invalid', 'step tampered');
  assert.equal(createStateCodec('other-secret', () => t).take(s2).status, 'invalid', 'other secret');
  assert.equal(c.take('garbage').status, 'invalid');
  t += 60_001;
  assert.deepEqual(c.take(s2), { status: 'invalid', reason: 'expired' });
});

// ---------------------------------------------------------------- HTTP server

function server(o: Partial<AppServerOptions> = {}, logs: string[] = []) {
  const portals = new PortalStore({ path: ':memory:', key: parseKeyring(`t:${randomBytes(32).toString('base64')}`) });
  portals.saveInstall(P, 'rt', []);
  const exchanged: string[] = [];
  const s = testAppServer({
    installer: {
      completeInstall: async (t: TokenResponse) => ({ portalId: Number(t.hub_id), watchedPairs: [], properties: [], subscriptions: { created: [], deleted: [], unchanged: [] } }) as unknown as ChangeReport,
      saveSettings: async () => { throw new Error('HubSpot said: {"token":"secret-xyz"} at /internal/path'); },
    },
    portals,
    exchangeCode: async (code) => { exchanged.push(code); return { token_type: 'bearer', access_token: 'a', refresh_token: 'r', expires_in: 1800, hub_id: P, scopes: [] }; },
    clientSecret: SECRET,
    publicBaseUrl: BASE,
    log: new Logger('app', {}, { level: 'debug', sink: (_r, line) => void logs.push(line) }),
    errors: { capture: () => true },
    ...o,
  });
  return Object.assign(s, { exchanged });
}

function signed(method: string, path: string, body = '', ts = String(Date.now())) {
  return { 'x-hubspot-signature-v3': signV3(SECRET, method, BASE + path, body, ts), 'x-hubspot-request-timestamp': ts, 'content-type': 'application/json' };
}

test('server: settings needs v3 over PUBLIC_BASE_URL; v2, expired, spoofed host and duplicate portalId are rejected', async () => {
  const s = server();
  const url = await listen(s);
  const path = `/api/settings?userId=1&portalId=${P}&appId=9`;
  try {
    assert.equal((await fetch(url + path, { headers: signed('GET', path) })).status, 200);
    assert.equal((await fetch(url + path, { headers: signed('GET', path, '', String(Date.now() - 6 * 60 * 1000)) })).status, 401, 'expired');
    const v2 = { 'x-hubspot-signature': 'a'.repeat(64), 'x-hubspot-signature-version': 'v2' };
    assert.equal((await fetch(url + path, { headers: v2 })).status, 401, 'v2 rejected');
    // Signed for the attacker's own host: we rebuild the URI from PUBLIC_BASE_URL, so it can't match.
    const ts = String(Date.now());
    const evil = { 'x-hubspot-signature-v3': signV3(SECRET, 'GET', `https://evil.example${path}`, '', ts), 'x-hubspot-request-timestamp': ts, host: 'evil.example', 'x-forwarded-host': 'evil.example' };
    assert.equal((await fetch(url + path, { headers: evil })).status, 401, 'host spoof');
    const dup = `/api/settings?portalId=1&userId=1&portalId=${P}&appId=9`;
    assert.equal((await fetch(url + dup, { headers: signed('GET', dup) })).status, 400, 'duplicate portalId');
    const dupUser = `/api/settings?portalId=${P}&userId=1&userId=2`;
    assert.equal((await fetch(url + dupUser, { headers: signed('GET', dupUser) })).status, 400, 'duplicate userId');
  } finally {
    s.close();
  }
});

test('server: settings without PUBLIC_BASE_URL is refused (no Host-header fallback)', async () => {
  const s = server({ publicBaseUrl: undefined });
  const url = await listen(s);
  const path = `/api/settings?portalId=${P}`;
  try {
    const host = new URL(url).host;
    const ts = String(Date.now());
    const h = { 'x-hubspot-signature-v3': signV3(SECRET, 'GET', `http://${host}${path}`, '', ts), 'x-hubspot-request-timestamp': ts };
    assert.equal((await fetch(url + path, { headers: h })).status, 503);
  } finally {
    s.close();
  }
});

test('server: body limit 413, bad JSON 400, generic 5xx with ref, security headers, no CORS', async () => {
  const logs: string[] = [];
  const reported: { op?: string; portalId?: number }[] = [];
  const s = server({ errors: { capture: (_e, ctx = {}) => (reported.push({ op: ctx.op, portalId: ctx.portalId }), true) } }, logs);
  const url = await listen(s);
  const path = `/api/settings?portalId=${P}`;
  try {
    const big = JSON.stringify({ watchedPairs: [], pad: 'x'.repeat(MAX_BODY_BYTES) });
    const r413 = await fetch(url + path, { method: 'POST', headers: signed('POST', path, big), body: big });
    assert.equal(r413.status, 413);

    const r400 = await fetch(url + path, { method: 'POST', headers: signed('POST', path, '{oops'), body: '{oops' });
    assert.equal(r400.status, 400);
    const b400 = (await r400.json()) as any;
    assert.equal(b400.error, 'Body is not JSON');

    const ok = JSON.stringify({ watchedPairs: [], stampSpacingSeconds: 3 });
    const r502 = await fetch(url + path, { method: 'POST', headers: signed('POST', path, ok), body: ok });
    assert.equal(r502.status, 502);
    const b502 = (await r502.json()) as any;
    assert.match(b502.ref, /^[0-9a-f]{8}$/);
    assert.doesNotMatch(JSON.stringify(b502), /secret-xyz|internal/, 'no raw error details to the browser');
    assert.ok(logs.some((l) => l.includes(b502.ref)), 'details are in the log under the same ref');
    assert.ok(!logs.join('\n').includes('secret-xyz'), 'token-like values are redacted in logs');
    assert.ok(logs.some((l) => /"level":"error".*"event":"settings_save_failed"/.test(l)), 'error level + event name');
    assert.deepEqual(reported, [{ op: 'settings', portalId: P }], 'route failure reported to the error reporter');

    for (const r of [r413, r400, r502, await fetch(url + '/health'), await fetch(url + '/nope')]) {
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.equal(r.headers.get('access-control-allow-origin'), null);
      assert.match(r.headers.get('strict-transport-security') ?? '', /max-age/);
    }
  } finally {
    s.close();
  }
});

test('server: OAuth callback state handling (CSRF) and no code/token in logs', async () => {
  const logs: string[] = [];
  const s = server({}, logs);
  const url = await listen(s);
  const get = (p: string) => fetch(url + p, { redirect: 'manual' });
  try {
    const loc = (await get('/install')).headers.get('location')!;
    assert.ok(loc.startsWith('https://app.hubspot.com/oauth/authorize?'));
    const state = new URL(loc).searchParams.get('state')!;

    assert.equal((await get(`/oauth/callback?code=CODE1&state=${encodeURIComponent(state)}`)).status, 200);
    assert.equal((await get(`/oauth/callback?code=CODE2&state=${encodeURIComponent(state)}`)).status, 400, 'reused state');
    assert.equal((await get('/oauth/callback?code=CODE3&state=forged.1.2.3')).status, 400, 'forged state');
    assert.equal((await get('/oauth/callback?code=CODE4')).status, 200, 'HubSpot-initiated install without state is allowed');
    assert.deepEqual(s.exchanged, ['CODE1', 'CODE4'], 'rejected states never reach the code exchange');
    assert.ok(logs.some((l) => /hubspot-initiated/.test(l)), 'stateless installs are logged');
    assert.ok(!/CODE\d/.test(logs.join('\n')), 'codes are never logged');

    const inj = await get('/oauth/callback?error=x%0D%0Afake%20line');
    assert.equal(inj.status, 400);
    assert.ok(!logs.some((l) => /[\r\n]/.test(l)), 'no log injection');
  } finally {
    s.close();
  }
});

test('server: an expired state is rejected', async () => {
  let t = Date.now();
  const s = server({ now: () => t });
  const url = await listen(s);
  try {
    const state = new URL((await fetch(url + '/install', { redirect: 'manual' })).headers.get('location')!).searchParams.get('state')!;
    t += 16 * 60 * 1000;
    assert.equal((await fetch(`${url}/oauth/callback?code=c&state=${encodeURIComponent(state)}`, { redirect: 'manual' })).status, 400);
    assert.deepEqual(s.exchanged, []);
  } finally {
    s.close();
  }
});
