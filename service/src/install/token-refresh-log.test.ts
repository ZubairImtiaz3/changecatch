// Token refresh observability: one structured `oauth` log line per refresh call (token_refreshed /
// token_refresh_failed), the token_refreshes{result} counter, and no token material in any log line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TokenResponse } from '../hubspot/oauth.js';
import { HttpError } from '../lib/http.js';
import { memoryLogger } from '../obs/log.js';
import { ChangeCatchMetrics } from '../obs/metrics.js';
import { PortalTokenProvider, PortalTokenRevokedError, refreshFailure } from './token-provider.js';

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

function setup(refresh: (rt: string) => Promise<TokenResponse>) {
  const { log, records, lines } = memoryLogger('test');
  const metrics = new ChangeCatchMetrics();
  let now = 10_000;
  const tp = new PortalTokenProvider({
    store: { getRefreshToken: () => RT, updateRefreshToken: () => {} },
    refresh,
    logger: log,
    metrics,
    now: () => now,
  });
  return { tp, records, lines, metrics, advance: (ms: number) => (now += ms) };
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
    throw new HttpError(400, { status: 'BAD_REFRESH_TOKEN', message: 'missing or invalid refresh token ' + RT }, 'POST /oauth -> 400');
  });
  await assert.rejects(tp.getAccessToken(P), PortalTokenRevokedError);
  await assert.rejects(tp.getAccessToken(P), PortalTokenRevokedError); // revoked: no second HubSpot call, no second line

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
    { err: new HttpError(401, { message: 'bad client secret' }, 'POST -> 401'), level: 'error', status: 401, reason: 'http_401' },
    { err: new HttpError(503, 'down', 'POST -> 503'), level: 'warn', status: 503, reason: 'http_503' },
    { err: new TypeError('fetch failed'), level: 'warn', status: null, reason: 'network' },
  ];
  for (const c of cases) {
    const { tp, records, lines, metrics } = setup(async () => {
      throw c.err;
    });
    await assert.rejects(tp.getAccessToken(P));
    assert.equal(tp.isRevoked(P), false);
    assert.equal(records.length, 1);
    assert.equal(records[0].event, 'token_refresh_failed');
    assert.equal(records[0].level, c.level);
    assert.equal(records[0].status, c.status);
    assert.equal(records[0].reason, c.reason);
    assertNoTokens(lines);
    assert.equal(metrics.registry.get('token_refreshes', { result: 'error' }), 1);
  }
  assert.deepEqual(refreshFailure(new HttpError(400, 'invalid_grant', 'x')), { result: 'revoked', status: 400, reason: 'revoked' });
});
