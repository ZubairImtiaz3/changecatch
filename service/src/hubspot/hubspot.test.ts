// Batching / caching in the HubSpot clients. No HubSpot calls: fetch and batchUpdate are stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StampUpdate } from '../core/stamp.js';
import { PortalTokenProvider } from '../install/token-provider.js';
import { HttpError } from '../lib/http.js';
import { portalIdForToken, registerPortalToken } from '../lib/rate-limiter.js';
import { clearLabelCache, getLabelsCached, listLabelsRaw, type RawLabel } from './labels.js';
import { ensureChangeCatchProperties, CHANGECATCH_PROPERTIES } from './properties.js';
import { chunkStampUpdates, sendStampBatches, type BatchUpdateResponse } from './stamp.js';

const upd = (portalId: number, objectTypeId: string, objectId: string): StampUpdate =>
  ({ portalId, objectTypeId, objectId, occurredAtMs: 0, properties: { changecatch_last_change_id: objectId } as StampUpdate['properties'] });
const quiet = () => {};

// ---------------------------------------------------------------- stamping

test('stamp batching: grouped by portal + object type, chunked at 100', async () => {
  const updates = [
    ...Array.from({ length: 250 }, (_, i) => upd(1, '0-3', `d${i}`)),
    ...Array.from({ length: 3 }, (_, i) => upd(2, '0-1', `c${i}`)),
    upd(1, '0-1', 'c-p1'),
  ];
  assert.deepEqual(chunkStampUpdates(updates).map((b) => b.length), [100, 100, 50, 3, 1]);
  const calls: { token: string; type: string; n: number }[] = [];
  const res = await sendStampBatches(updates, {
    getToken: async (p) => `tok-${p}`,
    log: quiet,
    batchUpdate: async (token, type, inputs) => {
      calls.push({ token, type, n: inputs.length });
      return { status: 'COMPLETE', results: inputs.map((i) => ({ id: i.id })) };
    },
  });
  assert.equal(calls.length, 5);
  assert.ok(calls.every((c) => c.n <= 100));
  assert.deepEqual(calls.filter((c) => c.token === 'tok-2').map((c) => c.type), ['0-1']);
  assert.equal(res.length, updates.length);
  assert.ok(res.every((r) => r.ok));
});

test('stamp batching: 207 partial errors -> only those records fail (not retryable); a 503 batch -> retryable', async () => {
  const updates = [upd(1, '0-3', '1'), upd(1, '0-3', '2'), upd(1, '0-3', '3'), upd(2, '0-3', '9')];
  const res = await sendStampBatches(updates, {
    getToken: async (p) => `tok-${p}`,
    log: quiet,
    batchUpdate: async (token, _type, inputs): Promise<BatchUpdateResponse> => {
      if (token === 'tok-2') throw new HttpError(503, {}, 'POST batch/update failed with 503');
      return {
        status: 'COMPLETE',
        results: inputs.filter((i) => i.id !== '2').map((i) => ({ id: i.id })),
        numErrors: 1,
        errors: [{ status: 'error', category: 'OBJECT_NOT_FOUND', message: 'Object not found', context: { ids: ['2'] } }],
      };
    },
  });
  const byId = new Map(res.map((r) => [r.update.objectId, r]));
  assert.equal(byId.get('1')!.ok, true);
  assert.equal(byId.get('3')!.ok, true);
  const two = byId.get('2')!;
  assert.ok(!two.ok && !two.retryable && /OBJECT_NOT_FOUND/.test(two.reason));
  const nine = byId.get('9')!;
  assert.ok(!nine.ok && nine.retryable, 'transient failure of another portal is retryable, and did not affect portal 1');
});

test('stamp batching: RetryLaterError carries retryAfterMs to the result', async () => {
  const { RetryLaterError } = await import('../lib/http.js');
  const res = await sendStampBatches([upd(5, '0-3', '1')], {
    getToken: async () => 't',
    log: quiet,
    batchUpdate: async () => { throw new RetryLaterError(12_000, {}, 'throttled'); },
  });
  assert.ok(!res[0].ok && res[0].retryable && res[0].retryAfterMs === 12_000);
});

// ---------------------------------------------------------------- token refresh

test('token refresh is single-flight per portal and registers the token with the limiter', async () => {
  let refreshes = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const tp = new PortalTokenProvider({
    store: { getRefreshToken: () => 'rt', updateRefreshToken: () => {} },
    refresh: async () => {
      refreshes++;
      await gate;
      return { token_type: 'bearer', access_token: 'at-501', expires_in: 1800 };
    },
  });
  const all = Promise.all([1, 2, 3, 4, 5].map(() => tp.getAccessToken(501)));
  release();
  assert.deepEqual(await all, Array(5).fill('at-501'));
  assert.equal(refreshes, 1);
  assert.equal(portalIdForToken('at-501'), 501);
  tp.prime(502, 'at-502', 1800);
  assert.equal(portalIdForToken('at-502'), 502);
});

// ---------------------------------------------------------------- labels

test('label cache: one fetch per (portal, from, to); concurrent misses share it; expiry and forceRefresh refetch', async () => {
  clearLabelCache();
  let fetches = 0;
  const fetch = async (_t: string, from: string, to: string) => {
    fetches++;
    await new Promise((r) => setTimeout(r, 5));
    return { results: [{ category: 'USER_DEFINED', typeId: 1, label: `${from}>${to}` }] as RawLabel[] };
  };
  let now = 1_000;
  const o = { fetch, now: () => now };
  const [a, b] = await Promise.all([getLabelsCached('t', 1, '0-3', '0-1', o), getLabelsCached('t', 1, '0-3', '0-1', o)]);
  assert.equal(fetches, 1);
  assert.equal(a, b);
  await getLabelsCached('t', 1, '0-3', '0-1', o);
  assert.equal(fetches, 1, 'cache hit');
  await getLabelsCached('t', 2, '0-3', '0-1', o);
  await getLabelsCached('t', 1, '0-1', '0-3', o);
  assert.equal(fetches, 3, 'other portal / other direction are separate keys');
  now += 60_000;
  await getLabelsCached('t', 1, '0-3', '0-1', o);
  assert.equal(fetches, 4, 'expired');
  await getLabelsCached('t', 1, '0-3', '0-1', { ...o, forceRefresh: true });
  assert.equal(fetches, 5);
});

test('label cache: a fresh listLabelsRaw with a registered portal token fills the cache', async () => {
  clearLabelCache();
  registerPortalToken('tok-lbl', 700);
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return new Response(JSON.stringify({ results: [{ category: 'USER_DEFINED', typeId: 7, label: 'X' }] }), { status: 200 });
  }) as typeof fetch;
  try {
    await listLabelsRaw('tok-lbl', '0-3', '0-1');
    const r = await getLabelsCached('tok-lbl', 700, '0-3', '0-1');
    assert.equal(n, 1, 'served from cache');
    assert.equal(r.results[0].label, 'X');
  } finally {
    globalThis.fetch = real;
    clearLabelCache();
  }
});

// ---------------------------------------------------------------- properties

test('ensureChangeCatchProperties: one batch read + one batch create (207: per-name status), no per-property calls', async () => {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const m = init.method ?? 'GET';
    calls.push(`${m} ${url.pathname}`);
    const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (url.pathname.endsWith('/groups')) return j({ results: [{ name: 'changecatch' }] });
    if (url.pathname.endsWith('/batch/read')) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.archived, false);
      assert.equal(body.inputs.length, CHANGECATCH_PROPERTIES.length);
      return j({ status: 'COMPLETE', results: [{ name: 'changecatch_last_change_id', type: 'string', groupName: 'changecatch' }] });
    }
    if (url.pathname.endsWith('/batch/create')) {
      const body = JSON.parse(String(init.body)) as { inputs: { name: string }[] };
      const bad = 'changecatch_change_type';
      return j({
        status: 'COMPLETE',
        results: body.inputs.filter((i) => i.name !== bad).map((i) => ({ name: i.name })),
        errors: [{ category: 'VALIDATION_ERROR', message: `bad ${bad}`, context: { name: [bad] } }],
      }, 207);
    }
    return j({ message: 'unexpected' }, 500);
  }) as typeof fetch;
  try {
    const r = await ensureChangeCatchProperties('t', '0-3', { dryRun: false });
    assert.deepEqual(calls.sort(), [
      'GET /crm/properties/2026-09/0-3/groups',
      'POST /crm/properties/2026-09/0-3/batch/create',
      'POST /crm/properties/2026-09/0-3/batch/read',
    ]);
    assert.equal(r.properties.length, CHANGECATCH_PROPERTIES.length);
    assert.equal(r.properties[0].status, 'exists');
    assert.equal(r.properties.find((p) => p.name === 'changecatch_change_type')!.status, 'error');
    assert.equal(r.properties.filter((p) => p.status === 'created').length, CHANGECATCH_PROPERTIES.length - 2);
  } finally {
    globalThis.fetch = real;
  }
});
