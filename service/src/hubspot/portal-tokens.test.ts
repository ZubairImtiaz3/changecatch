// The token module: typed errors, revocation (stored in token_revocations), 401 retry, and refresh observability
// (one structured `oauth` log line per refresh call, the token_refreshes{result} counter, no token material in logs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { TokenResponse } from './oauth.js';
import { HubSpotError } from '../lib/http.js';
import { memoryLogger } from '../../test/fixtures/log.js';
import { ChangeCatchMetrics } from '../obs/metrics.js';
import { PortalStore } from '../store/portals.js';
import { parseKeyring } from '../lib/crypto.js';
import {
  PortalNotInstalledError,
  PortalTokenProvider,
  refreshFailure,
  TokenRefreshError,
  TokenRevokedError,
  withPortalToken,
} from './portal-tokens.js';

const P = 777;
// Fake tokens built from pieces, so no scanner sees a token-shaped literal in the source.
const SHORT_AT = 'at' + '-' + 'sentinel' + '42'; // too short for the redactor: proves we never pass it at all
const LONG_AT = 'CJ' + 'Sx'.repeat(12) + '0a9B'.repeat(8); // HubSpot-access-token-shaped
const RT = ['na1', 'ab12', 'cd34', 'ef56gh78ij90'].join('-');

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const BAD_REFRESH = () =>
  HubSpotError.fromStatus(400, { status: 'BAD_REFRESH_TOKEN', message: 'missing or invalid refresh token ' + RT }, 'POST /oauth -> 400');

function setup(refresh: (rt: string) => Promise<TokenResponse>) {
  const { log, records, lines } = memoryLogger('test');
  const metrics = new ChangeCatchMetrics();
  let now = 10_000;
  const store = new PortalStore({ path: ':memory:', key: parseKeyring(`t:${randomBytes(32).toString('base64')}`) });
  store.saveInstall(P, RT, [], 1);
  const tp = new PortalTokenProvider({
    store,
    refresh,
    logger: log,
    metrics,
    now: () => now,
  });
  return { tp, store, records, lines, metrics, advance: (ms: number) => (now += ms), at: () => now };
}

const assertNoTokens = (lines: string[]) => {
  const all = lines.join('\n');
  for (const t of [SHORT_AT, LONG_AT, RT]) assert.ok(!all.includes(t), `token material leaked into logs: ${t.slice(0, 6)}...`);
};

test('token_refreshed: one oauth line per refresh, with portalId/expiresInSec/singleFlight, no token', async () => {
  const { tp, records, lines, metrics } = setup(async () => ({ token_type: 'bearer', access_token: SHORT_AT, refresh_token: RT, expires_in: 1800 }));
  assert.equal(await tp.getAccessToken(P), SHORT_AT);
  assert.equal(await tp.getAccessToken(P), SHORT_AT, 'cached: no second refresh');

  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.level, 'info');
  assert.equal(r.component, 'oauth');
  assert.equal(r.event, 'token_refreshed');
  assert.equal(r.portalId, P);
  assert.equal(r.expiresInSec, 1800);
  assert.equal(r.singleFlight, false);
  assert.equal(r.joiners, 0);
  assert.equal(typeof r.durationMs, 'number');
  for (const k of Object.keys(r)) assert.ok(!/token$/i.test(k) || k === 'token_refreshed', `unexpected token-ish field ${k}`);
  assertNoTokens(lines);

  assert.equal(metrics.registry.get('token_refreshes', { result: 'ok' }), 1);
  assert.match(metrics.toPrometheus(), /^changecatch_token_refreshes_total\{result="ok"\} 1$/m);
});

test('token_refreshed: concurrent callers share one refresh; the line says singleFlight with joiner count', async () => {
  const d = deferred<TokenResponse>();
  let calls = 0;
  const { tp, records, lines, metrics, advance } = setup(() => (calls++, d.promise));
  const ps = [tp.getAccessToken(P), tp.getAccessToken(P), tp.getAccessToken(P)];
  advance(250);
  d.resolve({ token_type: 'bearer', access_token: LONG_AT, expires_in: 1800 });
  assert.deepEqual(await Promise.all(ps), [LONG_AT, LONG_AT, LONG_AT]);

  assert.equal(calls, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].event, 'token_refreshed');
  assert.equal(records[0].singleFlight, true);
  assert.equal(records[0].joiners, 2);
  assert.equal(records[0].durationMs, 250);
  assert.equal(metrics.registry.get('token_refreshes', { result: 'ok' }), 1, 'joined callers are not counted');
  assertNoTokens(lines);

  // After expiry a new refresh: a fresh line, joiners reset.
  advance(1800 * 1000);
  await tp.getAccessToken(P).catch(() => {}); // same deferred (already resolved) -> refresh #2
  assert.equal(records.length, 2);
  assert.equal(records[1].singleFlight, false);
  assert.equal(metrics.registry.get('token_refreshes', { result: 'ok' }), 2);
});

test('token_refresh_failed: invalid_grant -> warn, reason revoked, status 400, counted as revoked', async () => {
  const { tp, records, lines, metrics } = setup(async () => {
    throw BAD_REFRESH();
  });
  await assert.rejects(tp.getAccessToken(P), TokenRevokedError);
  await assert.rejects(tp.getAccessToken(P), TokenRevokedError); // revoked: no second HubSpot call, no second line

  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.level, 'warn');
  assert.equal(r.component, 'oauth');
  assert.equal(r.event, 'token_refresh_failed');
  assert.equal(r.portalId, P);
  assert.equal(r.status, 400);
  assert.equal(r.reason, 'revoked');
  assertNoTokens(lines);
  assert.equal(metrics.registry.get('token_refreshes', { result: 'revoked' }), 1);
  assert.equal(metrics.registry.get('token_refreshes', { result: 'ok' }) ?? 0, 0);
});

test('token_refresh_failed: other 4xx -> error; 5xx and network -> warn; counted as error', async () => {
  const cases: { err: unknown; level: string; status: number | null; reason: string }[] = [
    { err: HubSpotError.fromStatus(401, { message: 'bad client secret' }, 'POST -> 401'), level: 'error', status: 401, reason: 'http_401' },
    { err: HubSpotError.fromStatus(503, 'down', 'POST -> 503'), level: 'warn', status: 503, reason: 'http_503' },
    { err: new TypeError('fetch failed'), level: 'warn', status: null, reason: 'network' },
  ];
  for (const c of cases) {
    const { tp, store, records, lines, metrics } = setup(async () => {
      throw c.err;
    });
    await assert.rejects(tp.getAccessToken(P), TokenRefreshError);
    assert.equal(store.revokedAt(P), null);
    assert.equal(records.length, 1);
    assert.equal(records[0].event, 'token_refresh_failed');
    assert.equal(records[0].level, c.level);
    assert.equal(records[0].status, c.status);
    assert.equal(records[0].reason, c.reason);
    assertNoTokens(lines);
    assert.equal(metrics.registry.get('token_refreshes', { result: 'error' }), 1);
  }
  assert.deepEqual(refreshFailure(HubSpotError.fromStatus(400, { error: 'invalid_grant' }, 'x')), { result: 'revoked', status: 400, reason: 'revoked' });
});

test('cached token is reused until 5 minutes before expiry; a rotated refresh token is stored', async () => {
  let n = 0;
  const { tp, store, advance } = setup(async () => ({ token_type: 'bearer', access_token: `at${++n}`, refresh_token: 'rt-rotated', expires_in: 1800 }));
  assert.equal(await tp.getAccessToken(P), 'at1');
  assert.equal(store.getRefreshToken(P), 'rt-rotated');
  advance(25 * 60 * 1000 - 1);
  assert.equal(await tp.getAccessToken(P), 'at1');
  advance(1);
  assert.equal(await tp.getAccessToken(P), 'at2', 'refreshed inside the last 5 minutes');
});

// ---------------------------------------------------------------- typed errors + revocation

test('revoked grant: TokenRevokedError, stored in token_revocations (survives a restart); reinstall clears it', async () => {
  let fail = true;
  let calls = 0;
  const { tp, store, advance, at } = setup(async () => {
    calls++;
    if (fail) throw BAD_REFRESH();
    return { token_type: 'bearer', access_token: 'at', expires_in: 1800 };
  });
  await assert.rejects(tp.getAccessToken(P), (e: unknown) => e instanceof TokenRevokedError && !(e instanceof PortalNotInstalledError));
  const revokedAt = at();
  assert.deepEqual(store.listRevoked(), [{ portalId: P, revokedAt }]);
  await assert.rejects(tp.getAccessToken(P, { forceRefresh: true }), TokenRevokedError);
  assert.equal(calls, 1, 'no more HubSpot calls once revoked');

  // A reinstall after the revocation clears it, without prime() (the API server process installed it).
  advance(1_000);
  fail = false;
  store.saveInstall(P, 'rt2', [], at());
  assert.deepEqual(store.listRevoked(), []);
  assert.equal(await tp.getAccessToken(P), 'at');

  // A later rejection is recorded again (the row left from before the reinstall is replaced).
  advance(1_000);
  fail = true;
  await assert.rejects(tp.getAccessToken(P, { forceRefresh: true }), TokenRevokedError);
  assert.deepEqual(store.listRevoked(), [{ portalId: P, revokedAt: at() }]);

  // A reinstall in the same millisecond as the rejection wins (that rejection was of the old token).
  store.saveInstall(P, 'rt3', [], at());
  assert.deepEqual(store.listRevoked(), []);
  store.close();
});

test('a 4xx from the token endpoint that is not a revoked grant (bad client secret) is TokenRefreshError, never revoked', async () => {
  const { tp, store, records } = setup(async () => {
    throw HubSpotError.fromStatus(400, { status: 'BAD_CLIENT_ID', message: 'missing or unknown client id' }, 'POST /oauth -> 400');
  });
  await assert.rejects(tp.getAccessToken(P), TokenRefreshError);
  assert.deepEqual(store.listRevoked(), []);
  assert.equal(records[0].level, 'error', 'misconfiguration is an error-level line');
});

test('not installed / uninstalled: PortalNotInstalledError, even with a cached token', async () => {
  const { tp, store } = setup(async () => ({ token_type: 'bearer', access_token: 'at', expires_in: 1800 }));
  await assert.rejects(tp.getAccessToken(999), PortalNotInstalledError);
  assert.equal(await tp.getAccessToken(P), 'at');
  store.markUninstalled(P, 5); // e.g. by the API server process
  await assert.rejects(tp.getAccessToken(P), PortalNotInstalledError);
});

test('withPortalToken: a 401 forces one refresh and one retry; other errors pass through', async () => {
  let n = 0;
  const { tp } = setup(async () => ({ token_type: 'bearer', access_token: `at${++n}`, expires_in: 1800 }));
  const seen: string[] = [];
  const r = await withPortalToken(tp, P, async (auth) => {
    seen.push(`${auth.portalId}:${auth.token}`);
    if (auth.token === 'at1') throw HubSpotError.fromStatus(401, {}, 'GET -> 401');
    return 'ok';
  });
  assert.equal(r, 'ok');
  assert.deepEqual(seen, [`${P}:at1`, `${P}:at2`]);
  const refused = HubSpotError.fromStatus(403, {}, 'GET -> 403');
  await assert.rejects(withPortalToken(tp, P, async () => { throw refused; }), (e: unknown) => e === refused);
  await assert.rejects(
    withPortalToken(tp, P, async () => { throw HubSpotError.fromStatus(401, {}, 'GET -> 401'); }),
    (e: unknown) => e instanceof HubSpotError && e.kind === 'unauthorized',
    'a second 401 is not retried again',
  );
});

