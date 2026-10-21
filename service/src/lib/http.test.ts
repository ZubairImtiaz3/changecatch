// Rate limiter + http.ts behaviour. No HubSpot calls: fetch is stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hsRequest, HttpError, parseRetryAfter, rateKeyFor, RetryLaterError, TimeoutError } from './http.js';
import { RateLimiter, RateLimitWaitError, portalIdForToken, registerPortalToken, setRateLimiter } from './rate-limiter.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// ---------------------------------------------------------------- limiter

test('limiter: sliding window caps starts per window, FIFO', async () => {
  const l = new RateLimiter({ portal: { limit: 2, windowMs: 150 } });
  const t0 = Date.now();
  const done: number[] = [];
  await Promise.all([0, 1, 2, 3].map((i) => l.acquire({ portalId: 1 }).then(() => done.push(i))));
  assert.deepEqual(done, [0, 1, 2, 3]);
  assert.ok(Date.now() - t0 >= 140, 'the 3rd and 4th waited for the window');
});

test('limiter fairness: a throttled portal does not block another portal', async () => {
  const l = new RateLimiter({ portal: { limit: 2, windowMs: 300 } });
  const a = [1, 2, 3, 4, 5].map(() => l.acquire({ portalId: 1 }));
  await sleep(5);
  assert.equal(l.queueDepth(1), 3, '3 of portal 1 are queued');
  const t0 = Date.now();
  await l.acquire({ portalId: 2 });
  assert.ok(Date.now() - t0 < 50, 'portal 2 got a slot at once');
  assert.equal(l.queueDepth(2), 0);
  await Promise.all(a);
  assert.equal(l.queueDepth(1), 0);
});

test('limiter: pause() holds only that key; maxWaitMs throws instead of queueing', async () => {
  const l = new RateLimiter({ portal: { limit: 100, windowMs: 10_000 } });
  l.pause({ portalId: 1 }, 150);
  const t0 = Date.now();
  await l.acquire({ portalId: 2 });
  assert.ok(Date.now() - t0 < 50);
  await assert.rejects(l.acquire({ portalId: 1 }, { maxWaitMs: 50 }), RateLimitWaitError);
  assert.equal(l.queueDepth(1), 0, 'a rejected acquire is not queued');
  await l.acquire({ portalId: 1 });
  assert.ok(Date.now() - t0 >= 140, 'portal 1 waited for the pause');
  assert.ok(l.stats()['portal:1'].inWindow >= 1);
});

test('limiter: app-level buckets are separate from portal buckets', async () => {
  const l = new RateLimiter({ journal: { limit: 1, windowMs: 10_000 } });
  await l.acquire('journal');
  assert.ok(l.waitMs('journal') > 1000);
  assert.equal(l.waitMs('subscriptions'), 0);
  assert.equal(l.waitMs({ portalId: 9 }), 0);
});

test('rateKeyFor: journal / subscriptions / oauth / presigned / registered portal token', () => {
  registerPortalToken('tok-77', 77);
  const u = (p: string) => new URL(p.startsWith('http') ? p : 'https://api.hubapi.com' + p);
  assert.equal(rateKeyFor(u('/webhooks-journal/journal/2026-09/next'), {}), 'journal');
  assert.equal(rateKeyFor(u('/webhooks-journal/subscriptions/2026-09'), {}), 'subscriptions');
  assert.equal(rateKeyFor(u('/oauth/2026-09/token'), { token: 'tok-77' }), null);
  assert.equal(rateKeyFor(u('https://s3.amazonaws.com/x?sig=1'), { token: 'tok-77' }), null);
  assert.deepEqual(rateKeyFor(u('/crm/objects/2026-09/0-3/batch/update'), { token: 'tok-77' }), { portalId: 77 });
  assert.equal(rateKeyFor(u('/crm/objects/2026-09/0-3/batch/update'), { token: 'unknown' }), null);
  assert.deepEqual(rateKeyFor(u('/anything'), { portalId: 5 }), { portalId: 5 });
  assert.equal(rateKeyFor(u('/webhooks-journal/journal/2026-09/next'), { rateKey: 'none' }), null);
});

test('token registry keeps only the last 3 tokens per portal', () => {
  for (let i = 0; i < 5; i++) registerPortalToken(`p88-${i}`, 88);
  assert.equal(portalIdForToken('p88-0'), undefined);
  assert.equal(portalIdForToken('p88-1'), undefined);
  assert.equal(portalIdForToken('p88-4'), 88);
});

test('parseRetryAfter: seconds and HTTP date', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000);
});

// ---------------------------------------------------------------- http + limiter

test('429 with Retry-After pauses ONLY that portal; another portal continues; then the call succeeds', async () => {
  setRateLimiter(new RateLimiter());
  registerPortalToken('tok-A', 1001);
  registerPortalToken('tok-B', 1002);
  let aCalls = 0;
  const hs = stubFetch((url, init) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    if (auth === 'Bearer tok-A' && aCalls++ === 0) return json({ category: 'RATE_LIMITS' }, 429, { 'retry-after': '0.25' });
    return json({ ok: auth });
  });
  try {
    const t0 = Date.now();
    const pa = hsRequest('/crm/objects/2026-09/0-3/batch/update', { method: 'POST', token: 'tok-A', body: {} });
    await sleep(30); // A has had its 429 and is paused
    const tB = Date.now();
    assert.deepEqual(await hsRequest('/crm/objects/2026-09/0-1/batch/update', { method: 'POST', token: 'tok-B', body: {} }), { ok: 'Bearer tok-B' });
    assert.ok(Date.now() - tB < 100, 'portal B was not held by portal A');
    assert.deepEqual(await pa, { ok: 'Bearer tok-A' });
    assert.ok(Date.now() - t0 >= 240, 'portal A waited for Retry-After');
    assert.equal(aCalls, 2);
  } finally {
    hs.restore();
    setRateLimiter(new RateLimiter());
  }
});

test('429 with a long Retry-After on a portal call: RetryLaterError at once, bucket paused, others fine', async () => {
  const l = new RateLimiter();
  setRateLimiter(l);
  registerPortalToken('tok-C', 1003);
  const hs = stubFetch(() => json({ category: 'RATE_LIMITS' }, 429, { 'retry-after': '30' }));
  try {
    const t0 = Date.now();
    const err = await hsRequest('/crm/objects/2026-09/0-3/batch/update', { method: 'POST', token: 'tok-C', body: {} }).catch((e) => e);
    assert.ok(err instanceof RetryLaterError);
    assert.ok(err instanceof HttpError && err.status === 429, 'still an HttpError 429 for existing handlers');
    assert.equal(err.retryAfterMs, 30_000);
    assert.ok(Date.now() - t0 < 200, 'no inline sleep');
    assert.equal(hs.calls.length, 1);
    assert.ok(l.waitMs({ portalId: 1003 }) > 29_000, 'portal bucket paused');
    assert.equal(l.waitMs({ portalId: 1004 }), 0);
    // A second call for the throttled portal fails fast from the limiter, without hitting HubSpot.
    await assert.rejects(hsRequest('/crm/x', { token: 'tok-C' }), RetryLaterError);
    assert.equal(hs.calls.length, 1);
  } finally {
    hs.restore();
    setRateLimiter(new RateLimiter());
  }
});

test('timeout: a hung request is aborted and retried with backoff', async () => {
  let n = 0;
  const hs = stubFetch((_url, init) => {
    if (n++ === 0) {
      // Never answers; only the abort signal ends it.
      return new Promise<Response>((_res, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)));
    }
    return json({ ok: true });
  });
  try {
    const t0 = Date.now();
    assert.deepEqual(await hsRequest('/crm/y', { timeoutMs: 50, rateKey: 'none' }), { ok: true });
    assert.equal(n, 2);
    assert.ok(Date.now() - t0 < 2_000);
  } finally {
    hs.restore();
  }
});

test('timeout: after the last retry a TimeoutError is thrown', async () => {
  const hs = stubFetch((_url, init) => new Promise<Response>((_res, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason))));
  try {
    await assert.rejects(hsRequest('/crm/z', { timeoutMs: 30, retries: 0, rateKey: 'none' }), TimeoutError);
  } finally {
    hs.restore();
  }
});

test('journal calls use the journal bucket, not a portal bucket', async () => {
  const l = new RateLimiter({ journal: { limit: 1, windowMs: 10_000 } });
  setRateLimiter(l);
  const hs = stubFetch(() => json({ url: 'x', expiresAt: '', currentOffset: '1' }));
  try {
    await hsRequest('/webhooks-journal/journal/2026-09/next', { token: 'app' });
    assert.equal(l.stats().journal.inWindow, 1);
    assert.equal(Object.keys(l.stats()).filter((k) => k.startsWith('portal:')).length, 0);
  } finally {
    hs.restore();
    setRateLimiter(new RateLimiter());
  }
});
