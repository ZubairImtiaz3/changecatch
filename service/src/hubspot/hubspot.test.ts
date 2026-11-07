// Batching / caching in the HubSpot clients. No HubSpot calls: fetch and batchUpdate are stubbed.
import { memoryLogger } from '../../test/fixtures/log.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StampUpdate } from '../core/stamp.js';
import { HubSpotError } from '../lib/http.js';
import { PortalNotInstalledError, TokenRefreshError, TokenRevokedError } from './portal-tokens.js';
import { LabelListCache, type RawLabel } from './labels.js';
import { CHANGECATCH_PROPERTIES } from '../core/contract.js';
import { ensureChangeCatchProperties } from './properties.js';
import { sendStampBatches, type BatchUpdateResponse } from './stamp.js';

const upd = (portalId: number, objectTypeId: string, objectId: string): StampUpdate =>
  ({ portalId, objectTypeId, objectId, occurredAtMs: 0, properties: { changecatch_last_change_id: objectId } as StampUpdate['properties'] });
const quiet = memoryLogger().log;

// ---------------------------------------------------------------- stamping

test('stamp batching: each call is one portal + object type and at most 100 records (HubSpot batch limit)', async () => {
  const updates = [
    ...Array.from({ length: 250 }, (_, i) => upd(1, '0-3', `d${i}`)),
    ...Array.from({ length: 3 }, (_, i) => upd(2, '0-1', `c${i}`)),
    upd(1, '0-1', 'c-p1'),
  ];
  const calls: { portalId: number; token: string; type: string; ids: string[] }[] = [];
  const res = await sendStampBatches(updates, {
    tokens: { getAccessToken: async (p) => `tok-${p}` },
    log: quiet,
    batchUpdate: async ({ portalId, token }, type, inputs) => {
      calls.push({ portalId, token, type, ids: inputs.map((i) => i.id) });
      return { status: 'COMPLETE', results: inputs.map((i) => ({ id: i.id })) };
    },
  });
  assert.equal(calls.length, 5, 'no more calls than needed (3 for 250 deals, 1 per other group)');
  assert.ok(calls.every((c) => c.ids.length <= 100));
  assert.ok(calls.every((c) => c.token === `tok-${c.portalId}`));
  const sent = calls.flatMap((c) => c.ids.map((id) => `${c.portalId}|${c.type}|${id}`)).sort();
  assert.deepEqual(sent, updates.map((u) => `${u.portalId}|${u.objectTypeId}|${u.objectId}`).sort(), 'every record sent once, to its own portal + type');
  assert.equal(res.length, updates.length);
  assert.ok(res.every((r) => r.kind === 'ok'));
});

test('stamp batching: 207 partial errors -> only those records refused; a 503 batch -> retry', async () => {
  const updates = [upd(1, '0-3', '1'), upd(1, '0-3', '2'), upd(1, '0-3', '3'), upd(2, '0-3', '9')];
  const res = await sendStampBatches(updates, {
    tokens: { getAccessToken: async (p) => `tok-${p}` },
    log: quiet,
    batchUpdate: async (auth, _type, inputs): Promise<BatchUpdateResponse> => {
      if (auth.portalId === 2) throw HubSpotError.fromStatus(503, {}, 'POST batch/update failed with 503');
      return {
        status: 'COMPLETE',
        results: inputs.filter((i) => i.id !== '2').map((i) => ({ id: i.id })),
        numErrors: 1,
        errors: [{ status: 'error', category: 'OBJECT_NOT_FOUND', message: 'Object not found', context: { ids: ['2'] } }],
      };
    },
  });
  const byId = new Map(res.map((r) => [r.update.objectId, r]));
  assert.equal(byId.get('1')!.kind, 'ok');
  assert.equal(byId.get('3')!.kind, 'ok');
  assert.equal(byId.get('2')!.kind, 'refused');
  assert.equal(byId.get('9')!.kind, 'retry', 'transient failure of another portal is retried, and did not affect portal 1');
});

test('stamp batching: a whole-batch 4xx caused by one record is bisected; only that record is refused', async () => {
  const calls: string[][] = [];
  const res = await sendStampBatches(['1', '2', '3', '4', '5'].map((id) => upd(1, '0-3', id)), {
    tokens: { getAccessToken: async () => 't' },
    log: quiet,
    batchUpdate: async (_auth, _type, inputs): Promise<BatchUpdateResponse> => {
      calls.push(inputs.map((i) => i.id));
      if (inputs.some((i) => i.id === '3')) throw HubSpotError.fromStatus(400, {}, 'POST batch/update failed with 400');
      return { status: 'COMPLETE', results: inputs.map((i) => ({ id: i.id })) };
    },
  });
  assert.deepEqual(Object.fromEntries(res.map((r) => [r.update.objectId, r.kind])), { 1: 'ok', 2: 'ok', 3: 'refused', 4: 'ok', 5: 'ok' });
  assert.ok(calls.length <= 1 + 2 * Math.ceil(Math.log2(5)), `bounded calls (${calls.length})`);
  // A 403 (missing scope) refuses every record alike: no split.
  let n403 = 0;
  const r403 = await sendStampBatches(['1', '2', '3'].map((id) => upd(1, '0-3', id)), {
    tokens: { getAccessToken: async () => 't' },
    log: quiet,
    batchUpdate: async () => { n403++; throw HubSpotError.fromStatus(403, {}, '403'); },
  });
  assert.equal(n403, 1);
  assert.ok(r403.every((r) => r.kind === 'refused'));
});

test('stamp batching: a 4xx that hits every record (both halves fail alike) is not split further', async () => {
  let n = 0;
  const res = await sendStampBatches(Array.from({ length: 100 }, (_, i) => upd(1, '2-99', String(i + 1))), {
    tokens: { getAccessToken: async () => 't' },
    log: quiet,
    batchUpdate: async () => { n++; throw HubSpotError.fromStatus(404, {}, 'POST batch/update failed with 404: unknown object type'); },
  });
  assert.equal(n, 3, 'the batch + its two halves, not 199 calls');
  assert.equal(res.length, 100);
  assert.ok(res.every((r) => r.kind === 'refused'));
});

test('stamp batching: "fail alike" ignores HubSpot\'s per-request correlationId (real 400 body shape)', async () => {
  // Body shape observed live on 2026-11-07 (portal 9206859) for an invalid option: every response carries a new
  // correlationId, so comparing raw messages would never see two halves as "alike".
  let n = 0;
  const res = await sendStampBatches(Array.from({ length: 100 }, (_, i) => upd(1, '0-3', String(i + 1))), {
    tokens: { getAccessToken: async () => 't' },
    log: quiet,
    batchUpdate: async () => {
      n++;
      const body = {
        status: 'error',
        message: 'Property values were not valid: [{"error":"PROPERTY_DOESNT_EXIST","name":"changecatch_last_change_id"}]',
        correlationId: `01a1b772-0000-0000-0000-${String(n).padStart(12, '0')}`,
        errors: [{ message: 'Property does not exist', code: 'PROPERTY_DOESNT_EXIST', context: { propertyName: ['changecatch_last_change_id'] } }],
        category: 'VALIDATION_ERROR',
      };
      throw HubSpotError.fromStatus(400, body, `POST batch/update failed with 400: ${JSON.stringify(body)}`);
    },
  });
  assert.equal(n, 3, 'the batch + its two halves, even though every correlationId differs');
  assert.ok(res.every((r) => r.kind === 'refused'));
});

test('stamp batching: per-record errors in a 2xx are classified per record; a record named nowhere is retried', async () => {
  const ids = ['1', '2', '3', '4', '5', '6'];
  const res = await sendStampBatches(ids.map((id) => upd(1, '0-3', id)), {
    tokens: { getAccessToken: async (p) => `tok-${p}` },
    log: quiet,
    batchUpdate: async (): Promise<BatchUpdateResponse> => ({
      status: 'COMPLETE',
      results: [{ id: '1' }],
      numErrors: 4,
      errors: [
        { status: '400', category: 'VALIDATION_ERROR', message: 'bad value', context: { ids: ['2'] } },
        { status: '429', category: 'RATE_LIMITS', message: 'slow down', context: { ids: ['3'] } },
        { status: '503', category: 'INTERNAL_ERROR', message: 'oops', context: { ids: ['4'] } },
        { status: 'error', category: 'RATE_LIMITS', message: 'later', context: { objectIds: ['5'] } },
      ],
    }),
  });
  const kind = Object.fromEntries(res.map((r) => [r.update.objectId, r.kind]));
  assert.deepEqual(kind, { 1: 'ok', 2: 'refused', 3: 'retry', 4: 'retry', 5: 'retry', 6: 'retry' });
  const six = res.find((r) => r.update.objectId === '6')!;
  assert.ok(six.kind === 'retry' && /not in the batch response/.test(six.message), 'no borrowed error message');
});

test('stamp batching: throttled keeps retryAfterMs; 401 after refresh and a revoked token are auth; no token is refused', async () => {
  const res = await sendStampBatches([upd(5, '0-3', '1')], {
    tokens: { getAccessToken: async () => 't' },
    log: quiet,
    batchUpdate: async () => { throw new HubSpotError('throttled', 'throttled', { retryAfterMs: 12_000, scope: 'portal' }); },
  });
  assert.deepEqual(res.map((r) => [r.kind, r.kind === 'throttled' && r.retryAfterMs]), [['throttled', 12_000]]);
  let refreshed = false;
  const res401 = await sendStampBatches([upd(5, '0-3', '1')], {
    tokens: { getAccessToken: async (_p, o) => ((refreshed ||= !!o?.forceRefresh), 't') },
    log: quiet,
    batchUpdate: async () => { throw HubSpotError.fromStatus(401, {}, 'POST -> 401'); },
  });
  assert.ok(refreshed, 'token refreshed once');
  assert.equal(res401[0].kind, 'auth');

  const call = (err: Error) =>
    sendStampBatches([upd(5, '0-3', '1')], {
      tokens: { getAccessToken: async () => { throw err; } },
      log: quiet,
      batchUpdate: async () => assert.fail('no call without a token'),
    });
  assert.equal((await call(new TokenRevokedError(5, 1)))[0].kind, 'auth');
  assert.equal((await call(new PortalNotInstalledError(5)))[0].kind, 'refused');
  assert.equal((await call(new TokenRefreshError(5, HubSpotError.fromStatus(503, 'down', 'x'))))[0].kind, 'retry');
  // A 4xx from the token endpoint that is not a revoked grant (bad client secret) is a misconfiguration:
  // the stamps are kept and retried, never refused (dead-lettered).
  const badSecret = HubSpotError.fromStatus(400, { status: 'BAD_CLIENT_ID', message: 'missing or unknown client id' }, 'POST /oauth -> 400');
  assert.equal((await call(new TokenRefreshError(5, badSecret)))[0].kind, 'retry');
});

// ---------------------------------------------------------------- labels

test('label cache: one fetch per (portal, from, to); concurrent misses share it; entries expire', async () => {
  let t = 1_000_000;
  const fetched: string[] = [];
  const cache = new LabelListCache({
    now: () => t,
    fetch: async (_auth, from, to) => {
      fetched.push(`${from}>${to}`);
      await new Promise((r) => setImmediate(r));
      return { results: [{ category: 'USER_DEFINED', typeId: 1, label: `${from}>${to}` } satisfies RawLabel] };
    },
  });
  const a1 = { portalId: 801, token: 't' };
  const a2 = { portalId: 802, token: 't' };
  const [a, b] = await Promise.all([cache.get(a1, '0-3', '0-1'), cache.get(a1, '0-3', '0-1')]);
  assert.equal(fetched.length, 1);
  assert.equal(a, b);
  await cache.get(a1, '0-3', '0-1');
  assert.equal(fetched.length, 1, 'cache hit');
  await cache.get(a2, '0-3', '0-1');
  await cache.get(a1, '0-1', '0-3');
  assert.equal(fetched.length, 3, 'other portal / other direction are separate keys');
  t += 60_000;
  await cache.get(a1, '0-3', '0-1');
  assert.equal(fetched.length, 4, 'expired');
});

// ---------------------------------------------------------------- properties

test('ensureChangeCatchProperties: at most 3 calls (groups, batch read, batch create), per-name status from a 207', async () => {
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
    const r = await ensureChangeCatchProperties({ portalId: 1, token: 't' }, '0-3');
    assert.ok(calls.length <= 3, calls.join(', '));
    assert.equal(r.properties.length, CHANGECATCH_PROPERTIES.length);
    assert.equal(r.properties[0].status, 'exists');
    assert.equal(r.properties.find((p) => p.name === 'changecatch_change_type')!.status, 'error');
    assert.equal(r.properties.filter((p) => p.status === 'created').length, CHANGECATCH_PROPERTIES.length - 2);
    assert.match(r.failure ?? '', /^changecatch_change_type: VALIDATION_ERROR/);
  } finally {
    globalThis.fetch = real;
  }
});

test('ensureChangeCatchProperties: a property that exists with another type is a failure (stamps on it would be refused)', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const path = new URL(String(input)).pathname;
    const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (path.endsWith('/groups')) return j({ results: [{ name: 'changecatch' }] });
    if (path.endsWith('/batch/read'))
      return j({ results: CHANGECATCH_PROPERTIES.map((d) => ({ ...d, type: d.name === 'changecatch_last_change_id' ? 'number' : d.type })) });
    return j({});
  }) as typeof fetch;
  try {
    const r = await ensureChangeCatchProperties({ portalId: 1, token: 't' }, '0-3');
    assert.equal(r.properties.find((p) => p.name === 'changecatch_last_change_id')!.status, 'exists-mismatch');
    assert.match(r.failure ?? '', /^changecatch_last_change_id: existing type number/);
  } finally {
    globalThis.fetch = real;
  }
});
