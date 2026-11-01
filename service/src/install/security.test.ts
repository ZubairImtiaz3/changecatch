// Security tests: settings signatures (v3 only), unsigned-mode guard, OAuth state, body limit, headers,
// token key rotation, refresh-token revocation. No network calls to HubSpot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { signV2, signV3, verifyHubSpotSignature } from './signature.js';
import type { TokenResponse } from '../hubspot/oauth.js';
import { HttpError } from '../lib/http.js';
import { PortalStore } from '../store/portals.js';
import { decryptToken, encryptToken, keyFromEnv, keyIdOf, parseKeyring } from './crypto.js';
import type { ChangeReport } from './installer.js';
import { rotateTokens } from './rotate.js';
import { assertHubSpotAuthorizeUrl, assertUnsignedAllowed, createAppServer, createStateCodec, logSafe, MAX_BODY_BYTES } from './server.js';
import { PortalNotInstalledError, PortalTokenProvider, PortalTokenRevokedError } from './token-provider.js';
import { memoryLogger } from '../obs/log.js';

const P = 4242;
const SECRET = 'client-secret';
const BASE = 'https://changecatch.example.com';
const b64 = () => randomBytes(32).toString('base64');

// ---------------------------------------------------------------- signature verifier

test('signature: v3 valid / expired / tampered / v2 rejected when requireV3', () => {
  const uri = `${BASE}/api/settings?portalId=${P}`;
  const now = 1_800_000_000_000;
  const ts = String(now);
  const headers = { 'x-hubspot-signature-v3': signV3(SECRET, 'POST', uri, '{"a":1}', ts), 'x-hubspot-request-timestamp': ts };
  const base = { secret: SECRET, method: 'POST', uri, rawBody: '{"a":1}', headers, now, requireV3: true };
  assert.deepEqual(verifyHubSpotSignature(base), { ok: true, version: 'v3' });
  assert.equal(verifyHubSpotSignature({ ...base, now: now + 5 * 60 * 1000 + 1 }).ok, false, 'expired');
  assert.equal(verifyHubSpotSignature({ ...base, now: now - 5 * 60 * 1000 - 1 }).ok, false, 'future');
  assert.equal(verifyHubSpotSignature({ ...base, rawBody: '{"a":2}' }).ok, false, 'tampered body');
  assert.equal(verifyHubSpotSignature({ ...base, uri: uri.replace(String(P), '1') }).ok, false, 'tampered portal');
  assert.equal(verifyHubSpotSignature({ ...base, method: 'GET' }).ok, false, 'tampered method');
  assert.equal(verifyHubSpotSignature({ ...base, secret: 'other' }).ok, false, 'wrong secret');

  const v2 = { 'x-hubspot-signature': signV2(SECRET, 'POST', uri, '{"a":1}'), 'x-hubspot-signature-version': 'v2' };
  assert.deepEqual(verifyHubSpotSignature({ ...base, headers: v2 }), { ok: false, version: 'v2', reason: 'v3 signature required' });
  assert.equal(verifyHubSpotSignature({ ...base, headers: v2, requireV3: false }).ok, true, 'v2 accepted when requireV3 is false');
});

// ---------------------------------------------------------------- unsigned guard + redirect target

test('SETTINGS_ALLOW_UNSIGNED is refused in production and with a public URL', () => {
  assert.throws(() => assertUnsignedAllowed({ allowUnsigned: true, nodeEnv: 'production', publicBaseUrl: 'http://localhost:3001' }), /NODE_ENV=production/);
  assert.throws(() => assertUnsignedAllowed({ allowUnsigned: true, nodeEnv: 'development', publicBaseUrl: 'https://abc.example.com' }), /localhost/);
  assert.doesNotThrow(() => assertUnsignedAllowed({ allowUnsigned: true, nodeEnv: 'development', publicBaseUrl: 'http://127.0.0.1:3001' }));
  assert.doesNotThrow(() => assertUnsignedAllowed({ allowUnsigned: true, nodeEnv: undefined, publicBaseUrl: undefined }));
  assert.doesNotThrow(() => assertUnsignedAllowed({ allowUnsigned: false, nodeEnv: 'production', publicBaseUrl: BASE }));
  // createAppServer enforces it too (defence in depth).
  assert.throws(() => server({ allowUnsigned: true, nodeEnv: 'production', publicBaseUrl: 'http://localhost:1' }));
});

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
  assert.deepEqual(c.take(s1), { status: 'ok', step: 1 });
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

function server(o: Partial<Parameters<typeof createAppServer>[0]> = {}, logs: string[] = []) {
  const portals = new PortalStore({ path: ':memory:', key: randomBytes(32) });
  portals.saveInstall(P, 'rt', []);
  const exchanged: string[] = [];
  const s = createAppServer({
    installer: {
      completeInstall: async (t: TokenResponse) => ({ portalId: Number(t.hub_id), watchedPairs: [], properties: [], subscriptions: { created: [], deleted: [], unchanged: [] } }) as unknown as ChangeReport,
      saveSettings: async () => { throw new Error('HubSpot said: {"token":"secret-xyz"} at /internal/path'); },
    },
    portals,
    objectTypes: async () => [{ objectTypeId: '0-3', label: 'Deal', custom: false }],
    buildInstallUrl: (state) => `https://app.hubspot.com/oauth/authorize?state=${state}`,
    exchangeCode: async (code) => { exchanged.push(code); return { token_type: 'bearer', access_token: 'a', refresh_token: 'r', expires_in: 1800, hub_id: P, scopes: [] }; },
    clientSecret: SECRET,
    callbackPath: '/oauth/callback',
    publicBaseUrl: BASE,
    nodeEnv: 'production',
    log: (m) => logs.push(m),
    ...o,
  });
  return Object.assign(s, { exchanged });
}

async function listen(s: ReturnType<typeof server>) {
  await new Promise<void>((r) => s.listen(0, r));
  return `http://localhost:${(s.address() as AddressInfo).port}`;
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
    const v2 = { 'x-hubspot-signature': signV2(SECRET, 'GET', BASE + path, ''), 'x-hubspot-signature-version': 'v2' };
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
  const s = server({ publicBaseUrl: undefined, nodeEnv: 'development' });
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
  const s = server({}, logs);
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

test('logSafe strips newlines and redacts token-ish values', () => {
  const out = logSafe('a\r\nb code=abc&state=x https://s3.example/f?X-Amz-Signature=zz Bearer abc.def {"access_token":"t"}');
  assert.doesNotMatch(out, /[\r\n]|abc&|X-Amz-Signature=zz|Bearer abc|"t"/);
});

// ---------------------------------------------------------------- key rotation

test('crypto: k<id> format, unique IV, tag verified, legacy v1 still readable', () => {
  const k1 = b64();
  const k2 = b64();
  const legacy = b64();
  const ring = parseKeyring(`new:${k2},old:${k1}`, legacy);
  const enc = encryptToken('rt-1', ring, '7');
  assert.match(enc, /^knew:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  const [, iv, tag] = enc.split(':');
  assert.equal(Buffer.from(iv, 'base64').length, 12);
  assert.equal(Buffer.from(tag, 'base64').length, 16);
  assert.notEqual(encryptToken('rt-1', ring, '7').split(':')[1], iv, 'fresh IV each time');
  assert.equal(decryptToken(enc, ring, '7'), 'rt-1');
  assert.throws(() => decryptToken(enc, ring, '8'), 'AAD bound to portal');
  const parts = enc.split(':');
  const flipped = Buffer.from(parts[3], 'base64');
  flipped[0] ^= 1;
  assert.throws(() => decryptToken([...parts.slice(0, 3), flipped.toString('base64')].join(':'), ring, '7'), 'tampered data');
  assert.throws(() => decryptToken(enc.replace(/^knew:/, 'kold:'), ring, '7'), 'wrong key id');
  assert.throws(() => decryptToken(enc, parseKeyring(`old:${k1}`, undefined), '7'), /not in TOKEN_ENC_KEYS/);

  const v1 = encryptToken('legacy-rt', Buffer.from(legacy, 'base64'), '7'); // what the old code wrote
  assert.ok(v1.startsWith('v1:'));
  assert.equal(decryptToken(v1, ring, '7'), 'legacy-rt');
  assert.throws(() => decryptToken(v1, parseKeyring(`new:${k2}`, undefined), '7'), /TOKEN_ENC_KEY/);

  assert.throws(() => parseKeyring('bad id:xx', undefined));
  assert.throws(() => parseKeyring(`a:${k1},a:${k2}`, undefined), /twice/);
  assert.throws(() => parseKeyring(undefined, undefined), /TOKEN_ENC_KEYS/);
});

test('rotation: legacy + old-key rows are re-encrypted with the active key (dry run writes nothing)', () => {
  const legacy = b64();
  const k1 = b64();
  const k2 = b64();
  // Day 0: legacy single key. Day 1: TOKEN_ENC_KEYS=k1. Day 2: rotate to k2.
  const store = new PortalStore({ path: ':memory:', key: keyFromEnv({ TOKEN_ENC_KEY: legacy }) });
  store.saveInstall(1, 'rt-legacy', []);
  const day1 = keyFromEnv({ TOKEN_ENC_KEYS: `k1:${k1}`, TOKEN_ENC_KEY: legacy });
  // A k1 row, and a row whose key id is no longer configured.
  store.db.prepare('INSERT INTO portals (portal_id, refresh_token_enc, scopes, installed_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(2, encryptToken('rt-k1', day1, '2'), '', 1, 1);
  store.db.prepare('INSERT INTO portals (portal_id, refresh_token_enc, scopes, installed_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(3, 'kgone:AAAA:AAAA:AAAA', '', 1, 1);

  const day2 = keyFromEnv({ TOKEN_ENC_KEYS: `k2:${k2},k1:${k1}`, TOKEN_ENC_KEY: legacy });
  const dry = rotateTokens(store.db, day2);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.wouldReencrypt, 2);
  assert.equal(dry.reencrypted, 0);
  assert.deepEqual(dry.byKeyId, { legacy: 1, k1: 1, gone: 1 });
  assert.equal(dry.failed.length, 1);
  assert.ok(String((store.db.prepare('SELECT refresh_token_enc e FROM portals WHERE portal_id = 1').get() as { e: string }).e).startsWith('v1:'), 'dry run wrote nothing');

  const applied = rotateTokens(store.db, day2, { dryRun: false });
  assert.equal(applied.reencrypted, 2);
  // Old keys removed: rows are still readable with k2 alone.
  const onlyK2 = keyFromEnv({ TOKEN_ENC_KEYS: `k2:${k2}` });
  for (const [id, want] of [[1, 'rt-legacy'], [2, 'rt-k1']] as const) {
    const e = (store.db.prepare('SELECT refresh_token_enc e FROM portals WHERE portal_id = ?').get(id) as { e: string }).e;
    assert.equal(keyIdOf(e), 'k2');
    assert.equal(decryptToken(e, onlyK2, String(id)), want);
  }
  assert.equal(rotateTokens(store.db, day2, { dryRun: false }).reencrypted, 0, 'second run is a no-op');
  // New writes through the store use the active key.
  const s2 = new PortalStore({ path: ':memory:', key: day2 });
  s2.saveInstall(9, 'rt-new', []);
  assert.equal(s2.getRefreshToken(9), 'rt-new');
  assert.equal(keyIdOf((s2.db.prepare('SELECT refresh_token_enc e FROM portals WHERE portal_id = 9').get() as { e: string }).e), 'k2');
  s2.close();
  store.close();
});

// ---------------------------------------------------------------- refresh-token revocation

test('token provider: invalid_grant marks the portal revoked; reinstall clears it', async () => {
  let now = 1_000;
  const store = new PortalStore({ path: ':memory:', key: randomBytes(32) });
  store.saveInstall(P, 'rt', [], now);
  let calls = 0;
  let fail = true;
  const tp = new PortalTokenProvider({
    store,
    now: () => now,
    logger: memoryLogger().log,
    refresh: async () => {
      calls++;
      if (fail) throw new HttpError(400, { status: 'BAD_REFRESH_TOKEN', message: 'missing or invalid refresh token' }, 'POST /oauth -> 400');
      return { token_type: 'bearer', access_token: 'at', expires_in: 1800 };
    },
  });
  now = 2_000;
  await assert.rejects(tp.getAccessToken(P), (e: unknown) => e instanceof PortalTokenRevokedError && e instanceof PortalNotInstalledError);
  assert.equal(tp.isRevoked(P), true);
  assert.deepEqual(tp.revokedPortals(), [{ portalId: P, revokedAt: 2_000 }]);
  await assert.rejects(tp.getAccessToken(P), PortalTokenRevokedError);
  assert.equal(calls, 1, 'no more HubSpot calls once revoked');

  // Survives a restart (SQLite table).
  const tp2 = new PortalTokenProvider({ store, refresh: async () => { throw new Error('unused'); }, logger: memoryLogger().log });
  assert.equal(tp2.isRevoked(P), true);

  // A reinstall after the revocation clears it.
  now = 3_000;
  fail = false;
  store.saveInstall(P, 'rt2', [], now);
  assert.equal(tp.isRevoked(P), false);
  assert.equal(await tp.getAccessToken(P), 'at');

  // Other errors (5xx, network) don't mark anything.
  const tp3 = new PortalTokenProvider({ store: { getRefreshToken: () => 'x', updateRefreshToken: () => {} }, logger: memoryLogger().log, refresh: async () => { throw new HttpError(503, 'down', 'POST -> 503'); } });
  await assert.rejects(tp3.getAccessToken(1), (e: unknown) => e instanceof HttpError);
  assert.equal(tp3.isRevoked(1), false);
  store.close();
});
