// Rate limiter + http.ts behaviour. No HubSpot calls: fetch is stubbed.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { configureHttp, hsRequest, HubSpotError, parseRetryAfter } from './http.js';
import type { LogRecord } from '../obs/log.js';
import { ChangeCatchMetrics } from '../obs/metrics.js';
import { getRateLimiter, HS_PORTAL_RATE_PER_10S, RateLimiter, type RateKey } from './rate-limiter.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const queued = (l: RateLimiter, portalId: number) => l.stats().portals[portalId]?.queued ?? 0;

type Handler = (url: URL, init: RequestInit) => Promise<Response> | Response;
function stubFetch(handler: Handler) {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push(`${init.method ?? 'GET'} ${url.pathname}`);
    return handler(url, init);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}
/** A fetch that never answers, as HubSpot does when it hangs: the per-attempt timeout signal ends it. */
const timesOut = (init: RequestInit): Promise<Response> => {
  assert.ok(init.signal instanceof AbortSignal, 'every attempt carries a timeout signal');
  return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
};

/** Log lines http.ts writes to stderr (warn) while `f` runs. */
async function captureStderr(f: () => Promise<void>): Promise<{ records: LogRecord[]; lines: string[] }> {
  const lines: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => (lines.push(...String(chunk).split('\n').filter(Boolean)), true)) as typeof process.stderr.write;
  try {
    await f();
  } finally {
    process.stderr.write = real;
  }
  return { records: lines.map((l) => JSON.parse(l) as LogRecord), lines };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// ---------------------------------------------------------------- limiter (mocked clock + timers)

const flush = () => new Promise((r) => setImmediate(r));
/** Start acquires and record which ones have been granted. */
function track(l: RateLimiter, keys: RateKey[]) {
  const granted: number[] = [];
  keys.forEach((k, i) => void l.acquire(k).then(() => granted.push(i)));
  return granted;
}
const clock = (t: TestContext) => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });

test('limiter: sliding window caps starts per window, FIFO', async (t) => {
  clock(t);
  const l = new RateLimiter(2);
  const granted = track(l, [{ portalId: 1 }, { portalId: 1 }, { portalId: 1 }, { portalId: 1 }]);
  await flush();
  assert.deepEqual(granted, [0, 1]);
  t.mock.timers.tick(9_999);
  await flush();
  assert.deepEqual(granted, [0, 1], 'not before the 10 s window has passed');
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(granted, [0, 1, 2, 3]);
});

test('limiter fairness: a throttled portal does not block another portal', async (t) => {
  clock(t);
  const l = new RateLimiter(2);
  const granted = track(l, [1, 1, 1, 1, 1, 2].map((portalId) => ({ portalId })));
  await flush();
  assert.deepEqual(granted, [0, 1, 5], 'portal 2 got a slot at once');
  assert.equal(queued(l, 1), 3);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(granted.length, 5, 'two more of portal 1 per window');
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(granted.length, 6);
});

test('limiter: pause() holds only that key; waitMs reports the wait', async (t) => {
  clock(t);
  const l = new RateLimiter();
  l.pause({ portalId: 1 }, 150);
  assert.equal(l.waitMs({ portalId: 1 }), 150);
  assert.equal(l.waitMs({ portalId: 2 }), 0);
  const granted = track(l, [{ portalId: 1 }, { portalId: 2 }]);
  await flush();
  assert.deepEqual(granted, [1]);
  t.mock.timers.tick(150);
  await flush();
  assert.deepEqual(granted, [1, 0], 'portal 1 waited for the pause');
});

test('limiter: app-level buckets are separate from portal buckets', async (t) => {
  clock(t);
  const l = new RateLimiter(1);
  await l.acquire({ portalId: 9 });
  assert.ok(l.waitMs({ portalId: 9 }) > 0);
  const granted = track(l, ['journal', 'subscriptions', { portalId: 10 }]);
  await flush();
  assert.deepEqual(granted, [0, 1, 2], 'other buckets got a slot at once');
});

test('parseRetryAfter: seconds and HTTP date', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000);
});

// ---------------------------------------------------------------- http + limiter

test('429 with Retry-After pauses ONLY that portal; another portal continues; then the call succeeds', async () => {
  let aCalls = 0;
  const hs = stubFetch((url, init) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    if (auth === 'Bearer tok-A' && aCalls++ === 0) return json({ category: 'RATE_LIMITS' }, 429, { 'retry-after': '0.25' });
    return json({ ok: auth });
  });
  try {
    const l = getRateLimiter();
    const pa = hsRequest('/crm/objects/2026-09/0-3/batch/update', { method: 'POST', token: 'tok-A', portalId: 1001, body: {} });
    for (let i = 0; i < 200 && l.waitMs({ portalId: 1001 }) === 0; i++) await sleep(5); // wait for A's 429
    assert.ok(l.waitMs({ portalId: 1001 }) > 0, "A's 429 paused portal A's bucket");
    assert.equal(l.waitMs({ portalId: 1002 }), 0, 'portal B is not');
    assert.deepEqual(await hsRequest('/crm/objects/2026-09/0-1/batch/update', { method: 'POST', token: 'tok-B', portalId: 1002, body: {} }), { ok: 'Bearer tok-B' });
    assert.deepEqual(await pa, { ok: 'Bearer tok-A' });
    assert.equal(aCalls, 2);
  } finally {
    hs.restore();
  }
});

// A 30 s inline sleep would trip the test timeout.
test('429 with a long Retry-After on a portal call: throttled at once, bucket paused, others fine', { timeout: 10_000 }, async () => {
  const l = getRateLimiter();
  const hs = stubFetch(() => json({ category: 'RATE_LIMITS' }, 429, { 'retry-after': '30' }));
  try {
    const err = await hsRequest('/crm/objects/2026-09/0-3/batch/update', { method: 'POST', token: 'tok-C', portalId: 1003, body: {} }).catch((e) => e);
    assert.ok(err instanceof HubSpotError && err.kind === 'throttled' && err.scope === 'portal' && err.status === 429);
    assert.equal(err.retryAfterMs, 30_000);
    assert.equal(hs.calls.length, 1);
    assert.ok(l.stats().portals[1003].pausedForMs > 29_000, 'portal bucket paused');
    assert.equal(l.stats().portals[1004], undefined, 'no other portal touched');
    // A second call for the throttled portal fails fast from the limiter, without hitting HubSpot.
    await assert.rejects(hsRequest('/crm/x', { token: 'tok-C', portalId: 1003 }), (e) => e instanceof HubSpotError && e.kind === 'throttled' && e.scope === 'limiter');
    assert.equal(hs.calls.length, 1);
  } finally {
    hs.restore();
  }
});

test('timeout: a timed-out request is retried with backoff', async () => {
  let n = 0;
  const hs = stubFetch((_url, init) => (n++ === 0 ? timesOut(init) : json({ ok: true })));
  try {
    assert.deepEqual(await hsRequest('/crm/y'), { ok: true });
    assert.equal(n, 2);
  } finally {
    hs.restore();
  }
});

test('retry log: one structured warn per 5xx retry; method + path + status only, no token or query string', async () => {
  let n = 0;
  const hs = stubFetch(() => (n++ === 0 ? json({ message: 'oops' }, 503) : json({ ok: true })));
  const token = 'CJabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
  try {
    const mem = await captureStderr(async () => {
      assert.deepEqual(await hsRequest('/crm/2026-03/objects/deals', { token, query: { code: 'secret-code' } }), { ok: true });
    });
    assert.equal(mem.records.length, 1);
    const r = mem.records[0];
    assert.equal(r.level, 'warn');
    assert.equal(r.component, 'http');
    assert.equal(r.event, 'http_retry');
    assert.equal(r.method, 'GET');
    assert.equal(r.path, '/crm/2026-03/objects/deals');
    assert.equal(r.status, 503);
    assert.equal(r.reason, 'server_error');
    assert.equal(r.attempt, 1);
    assert.equal(r.retryInMs, 500);
    assert.match(r.msg, /^GET \/crm\/2026-03\/objects\/deals -> 503, retry in 500ms$/);
    assert.ok(!mem.lines[0].includes(token) && !mem.lines[0].includes('secret-code') && !mem.lines[0].includes('?'));
  } finally {
    hs.restore();
  }
});

test('timeout: after the last retry a transient error is thrown', async () => {
  const hs = stubFetch((_url, init) => timesOut(init));
  try {
    await assert.rejects(hsRequest('/crm/z', { retries: 0 }), (e) => e instanceof HubSpotError && e.kind === 'transient' && e.status === 0 && /timed out/.test(e.message));
  } finally {
    hs.restore();
  }
});

test('journal calls use the journal bucket, not a portal bucket', async () => {
  const l = getRateLimiter();
  const portalKeys = () => Object.keys(l.stats().portals).length;
  const portalsBefore = portalKeys();
  const hs = stubFetch(() => json({ url: 'x', expiresAt: '', currentOffset: '1' }));
  try {
    await hsRequest('/webhooks-journal/journal/2026-09/next', { token: 'app', bucket: 'journal' });
    assert.equal(l.stats().app.journal.inWindow, 1);
    assert.equal(portalKeys(), portalsBefore);
  } finally {
    hs.restore();
  }
});

test('error kinds: 401 unauthorized, other 4xx refused (status + body kept), 5xx transient after retries', async () => {
  let code = 401;
  const hs = stubFetch(() => json({ message: 'x' }, code));
  try {
    const kinds: string[] = [];
    for (const c of [401, 404, 503]) {
      code = c;
      const e = await hsRequest('/crm/k', { retries: 0 }).catch((x) => x);
      assert.ok(e instanceof HubSpotError && e.status === c);
      assert.deepEqual(e.body, { message: 'x' });
      kinds.push(e.kind);
    }
    assert.deepEqual(kinds, ['unauthorized', 'refused', 'transient']);
  } finally {
    hs.restore();
  }
});

test('metrics: every attempt counted in http_requests by api; errors by status; 429 and limiter throttles in rate_limited', async () => {
  const metrics = new ChangeCatchMetrics();
  configureHttp({ portalRatePer10s: HS_PORTAL_RATE_PER_10S, metrics });
  const hs = stubFetch((url) => {
    if (url.pathname === '/crm/throttled') return json({}, 429, { 'retry-after': '60' });
    if (url.pathname === '/oauth/2026-09/token') return json({}, 401);
    if (url.pathname === '/crm/network') throw new TypeError('fetch failed');
    return json({ ok: true });
  });
  try {
    await hsRequest('/webhooks-journal/journal/2026-09/latest', { bucket: 'journal' });
    await hsRequest('/crm/throttled', { token: 'tok-M', portalId: 111 }).catch(() => {});
    await hsRequest('/crm/after', { token: 'tok-M', portalId: 111 }).catch(() => {}); // our limiter: portal 111 is paused
    await hsRequest('https://api.hubspot.com/oauth/2026-09/token', { method: 'POST', retries: 0 }).catch(() => {});
    await hsRequest('/crm/network', { retries: 0 }).catch(() => {});
  } finally {
    hs.restore();
    configureHttp({ portalRatePer10s: HS_PORTAL_RATE_PER_10S });
  }
  const g = (n: string, l: Record<string, string | number>) => metrics.registry.get(n, l);
  assert.equal(g('http_requests', { api: 'journal' }), 1);
  assert.equal(g('http_requests', { api: 'crm' }), 2, 'the limiter refusal never reached HubSpot');
  assert.equal(g('http_requests', { api: 'oauth' }), 1);
  assert.equal(g('http_errors', { status: '429' }), 1);
  assert.equal(g('http_errors', { status: '401' }), 1);
  assert.equal(g('http_errors', { status: 'network' }), 1);
  assert.equal(g('rate_limited', { portal: 111 }), 2, 'one HubSpot 429 + one limiter refusal');
});
