// App lifecycle subscriptions (create only what's missing, self-heal) and the real HubSpot list shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseSubscription, type Subscription, type SubscriptionApi, type SubscriptionRequest } from './journal.js';
import { ensureLifecycleSubscriptions, startLifecycleSubscriptionWatch } from './app-lifecycle.js';
import { FakeSubs } from '../../test/fixtures/subscriptions.js';
import { memoryLogger } from '../../test/fixtures/log.js';

test('ensureLifecycleSubscriptions creates only the missing install/uninstall subs', async () => {
  const api = new FakeSubs();
  assert.deepEqual((await ensureLifecycleSubscriptions(api)).created, ['4-1909196', '4-1916193']);
  assert.deepEqual(await ensureLifecycleSubscriptions(api), { created: [], existing: ['4-1909196', '4-1916193'] });
});

test('lifecycle subs self-heal: created at start, recreated when deleted, failures logged not thrown', async () => {
  const api = new FakeSubs();
  const { log, lines: logs } = memoryLogger();
  const w = startLifecycleSubscriptionWatch({ api, intervalMs: 60_000, log });
  try {
    await w.ready;
    assert.deepEqual(api.subs.map((s) => (s as { objectTypeId?: string }).objectTypeId).sort(), ["4-1909196", "4-1916193"]);

    assert.equal((await w.check())!.created.length, 0, 'nothing to do when both exist');

    api.subs = api.subs.filter((s) => (s as { objectTypeId?: string }).objectTypeId !== "4-1916193"); // "deleted after an uninstall"
    assert.deepEqual((await w.check())!.created, ['4-1916193']);
    assert.ok(logs.some((l) => /MISSING, recreated .*4-1916193/.test(l)), 'recreation is logged');

    api.listSubscriptions = async () => { throw new Error('journal down'); };
    assert.equal(await w.check(), null);
    assert.ok(logs.some((l) => /FAILED: journal down/.test(l)));
  } finally {
    w.stop();
  }
});

test('lifecycle subs self-heal: the timer re-checks periodically', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const api = new FakeSubs();
  const w = startLifecycleSubscriptionWatch({ api, intervalMs: 1_000, log: memoryLogger().log });
  try {
    await w.ready;
    api.subs = [];
    t.mock.timers.tick(999);
    await new Promise((r) => setImmediate(r));
    assert.equal(api.subs.length, 0, 'not before the interval');
    t.mock.timers.tick(1);
    await new Promise((r) => setImmediate(r));
    assert.equal(api.subs.length, 2, 'deleted subs were recreated by the timer');
  } finally {
    w.stop();
  }
});

test('normaliseSubscription + ensureLifecycleSubscriptions recognise the real HubSpot list shape (event type in objectTypeId)', async () => {
  // Shape copied from a live GET /webhooks-journal/subscriptions/2026-09 response: lifecycle subs carry the event
  // type in `objectTypeId` and have no `eventTypeId` field. Reading the wrong field made every check report "missing".
  const live = [
    { id: 60406478, appId: 1, subscriptionType: 'APP_LIFECYCLE_EVENT', objectTypeId: '4-1909196', actions: [], createdAt: '2026-10-30T02:54:00.020Z', updatedAt: '' },
    { id: 60406479, appId: 1, subscriptionType: 'APP_LIFECYCLE_EVENT', objectTypeId: '4-1916193', actions: [], createdAt: '2026-10-30T02:54:00.349Z', updatedAt: '' },
    { id: 60406509, appId: 1, subscriptionType: 'ASSOCIATION', portalId: 1234567, objectTypeId: '0-3', associatedObjectTypeIds: ['0-1'], actions: [], createdAt: '', updatedAt: '' },
  ] as unknown as Subscription[];
  const created: unknown[] = [];
  const api: SubscriptionApi = {
    listSubscriptions: async () => live.map(normaliseSubscription),
    createSubscription: async (b: SubscriptionRequest) => { created.push(b); return live[0]; },
    deleteSubscription: async () => {},
  } as unknown as SubscriptionApi;
  const r = await ensureLifecycleSubscriptions(api);
  assert.deepEqual(r, { created: [], existing: ['4-1909196', '4-1916193'] });
  assert.equal(created.length, 0, 'no create call when both already exist');
});
