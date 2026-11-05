import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { signV3 } from './signature.js';
import type { Subscription, SubscriptionRequest } from '../hubspot/journal.js';
import type { SetupReport } from '../hubspot/properties.js';
import { PortalStore } from '../store/portals.js';
import { decryptToken, encryptToken, parseKey } from './crypto.js';
import { Installer } from './installer.js';
import { handleLifecycleEvent } from './lifecycle.js';
import { defaultPairs, normalisePairs, orientPair, parsePairs } from './pairs.js';
import { createAppServer } from './server.js';
import { applySubscriptionPlan, ensureLifecycleSubscriptions, planSubscriptionChanges, startLifecycleSubscriptionWatch, type SubscriptionApi } from './subscriptions.js';
import { PortalTokenProvider } from './token-provider.js';

const KEY = randomBytes(32);
const P = 111;
const DEAL = '0-3', CONTACT = '0-1', COMPANY = '0-2', PET = '2-23488212';

// ---------- helpers ----------

function sub(id: number, objectTypeId: string, assoc: string[], extra: Partial<Subscription> = {}): Subscription {
  return {
    id, appId: 1, subscriptionType: 'ASSOCIATION', portalId: P, objectTypeId, associatedObjectTypeIds: assoc,
    actions: ['ASSOCIATION_REMOVED', 'ASSOCIATION_ADDED'], createdAt: '', updatedAt: '', ...extra,
  };
}

class FakeSubs implements SubscriptionApi {
  subs: Subscription[] = [];
  nextId = 1000;
  calls: string[] = [];
  /** Upsert key used by the fake: (portal, objectTypeId). */
  async listSubscriptions() { return this.subs.map((s) => ({ ...s })); }
  async createSubscription(b: SubscriptionRequest) {
    this.calls.push(`create ${'objectTypeId' in b ? b.objectTypeId : b.eventTypeId}`);
    if (b.subscriptionType === 'APP_LIFECYCLE_EVENT') {
      // Mirrors real HubSpot: the event type comes back as `objectTypeId`, and create is an upsert (no duplicates).
      const hit = this.subs.find((s) => s.subscriptionType === 'APP_LIFECYCLE_EVENT' && s.objectTypeId === b.eventTypeId);
      if (hit) return { ...hit };
      const s = { id: this.nextId++, appId: 1, subscriptionType: b.subscriptionType, objectTypeId: b.eventTypeId, actions: [], createdAt: '', updatedAt: '' } as unknown as Subscription;
      this.subs.push(s);
      return s;
    }
    const hit = this.subs.find((s) => s.portalId === b.portalId && s.objectTypeId === b.objectTypeId);
    if (hit) { hit.associatedObjectTypeIds = b.associatedObjectTypeIds; hit.actions = b.actions; return { ...hit }; }
    const s = sub(this.nextId++, b.objectTypeId, b.associatedObjectTypeIds, { portalId: b.portalId, actions: b.actions });
    this.subs.push(s);
    return s;
  }
  async deleteSubscription(id: number) { this.calls.push(`delete ${id}`); this.subs = this.subs.filter((s) => s.id !== id); }
  async deletePortalSubscriptions(portalId: number) { this.calls.push(`deletePortal ${portalId}`); this.subs = this.subs.filter((s) => s.portalId !== portalId); }
}

function setup(opts: { failPropsOn?: string; log?: (m: string) => void } = {}) {
  const portals = new PortalStore({ path: ':memory:', key: KEY });
  const refreshed: string[] = [];
  const tokens = new PortalTokenProvider({
    store: portals,
    refresh: async (rt) => { refreshed.push(rt); return { token_type: 'bearer', access_token: `at-${rt}`, expires_in: 1800 }; },
  });
  const subs = new FakeSubs();
  const propsCalls: string[] = [];
  const ensureProperties = async (_t: string, objectType: string): Promise<SetupReport> => {
    propsCalls.push(objectType);
    if (objectType === opts.failPropsOn) return { objectType, group: 'error', properties: [], missingScope: 'crm.schemas.custom.write', error: '403' };
    return { objectType, group: 'created', properties: [] };
  };
  const installer = new Installer({ portals, tokens, subscriptions: subs, ensureProperties, log: opts.log ?? (() => {}) });
  return { portals, tokens, subs, propsCalls, installer, refreshed };
}

const tokenResponse = (portalId = P, extraScopes: string[] = []) => ({ token_type: 'bearer', access_token: 'at0', refresh_token: 'rt-secret', expires_in: 1800, hub_id: portalId, scopes: ['oauth', 'crm.objects.deals.read', ...extraScopes] });
/** An Enterprise portal that granted the custom read + write scopes. */
const CUSTOM_GRANTED = ['crm.objects.custom.read', 'crm.schemas.custom.read', 'crm.objects.custom.write', 'crm.schemas.custom.write'];

// ---------- crypto ----------

test('token encryption round-trips and is bound to the portal id', () => {
  const enc = encryptToken('my-refresh-token', KEY, '111');
  assert.ok(enc.startsWith('v1:'));
  assert.ok(!enc.includes('my-refresh-token'));
  assert.equal(decryptToken(enc, KEY, '111'), 'my-refresh-token');
  assert.notEqual(encryptToken('my-refresh-token', KEY, '111'), enc, 'random IV each time');
  assert.throws(() => decryptToken(enc, KEY, '222'), 'wrong AAD fails');
  assert.throws(() => decryptToken(enc, randomBytes(32), '111'), 'wrong key fails');
  const tampered = enc.slice(0, -4) + (enc.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.throws(() => decryptToken(tampered, KEY, '111'), 'tampering fails');
});

test('parseKey accepts base64 and hex 32-byte keys only', () => {
  assert.equal(parseKey(KEY.toString('base64')).length, 32);
  assert.equal(parseKey(KEY.toString('hex')).length, 32);
  assert.throws(() => parseKey(undefined));
  assert.throws(() => parseKey(randomBytes(16).toString('base64')));
});

test('PortalStore keeps the refresh token encrypted at rest', () => {
  const s = new PortalStore({ path: ':memory:', key: KEY });
  s.saveInstall(P, 'rt-secret', ['oauth'], 1);
  const raw = s.db.prepare('SELECT refresh_token_enc FROM portals WHERE portal_id = ?').get(P) as { refresh_token_enc: string };
  assert.ok(!raw.refresh_token_enc.includes('rt-secret'));
  assert.equal(s.getRefreshToken(P), 'rt-secret');
  assert.deepEqual(s.getPortal(P)?.scopes, ['oauth']);
  assert.equal(s.getStampSpacingSeconds(P), 3);
});

// ---------- token provider ----------

test('token provider caches, shares in-flight refreshes, stores rotated refresh tokens', async () => {
  const portals = new PortalStore({ path: ':memory:', key: KEY });
  portals.saveInstall(P, 'rt1', [], 1);
  let n = 0;
  let t = 0;
  const tp = new PortalTokenProvider({
    store: portals,
    now: () => t,
    refresh: async () => { n++; return { token_type: 'bearer', access_token: `at${n}`, refresh_token: 'rt2', expires_in: 1800 }; },
  });
  const [a, b] = await Promise.all([tp.getAccessToken(P), tp.getAccessToken(P)]);
  assert.equal(a, 'at1');
  assert.equal(b, 'at1');
  assert.equal(n, 1);
  assert.equal(portals.getRefreshToken(P), 'rt2');
  t = 26 * 60 * 1000; // within 5 min of expiry -> refresh
  assert.equal(await tp.getAccessToken(P), 'at2');
  await assert.rejects(tp.getAccessToken(999), /not installed/);
});

// ---------- pairs ----------

test('pairs are oriented (custom > deal > company > contact) and de-duplicated', () => {
  assert.deepEqual(orientPair(CONTACT, DEAL), { objectTypeId: DEAL, associatedObjectTypeId: CONTACT });
  assert.deepEqual(orientPair(CONTACT, PET), { objectTypeId: PET, associatedObjectTypeId: CONTACT });
  assert.deepEqual(orientPair(CONTACT, COMPANY), { objectTypeId: COMPANY, associatedObjectTypeId: CONTACT });
  assert.deepEqual(orientPair('2-9', '2-1'), orientPair('2-1', '2-9'));
  assert.equal(normalisePairs([{ objectTypeId: CONTACT, associatedObjectTypeId: DEAL }, { objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]).length, 1);
  assert.equal(defaultPairs(undefined).length, 3);
  assert.deepEqual(parsePairs('0-1:0-3'), [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
  assert.throws(() => parsePairs('deal:contact'));
});

// ---------- subscription diffing ----------

const pairs = (...ps: [string, string][]) => ps.map(([a, b]) => ({ objectTypeId: a, associatedObjectTypeId: b }));

test('plan: nothing exists -> one upsert per subscribed object type, partners grouped', () => {
  const plan = planSubscriptionChanges(pairs([DEAL, CONTACT], [COMPANY, DEAL], [CONTACT, COMPANY]), []);
  assert.deepEqual(plan.upserts, [
    { objectTypeId: COMPANY, associatedObjectTypeIds: [CONTACT], replaces: [] },
    { objectTypeId: DEAL, associatedObjectTypeIds: [CONTACT, COMPANY], replaces: [] },
  ]);
  assert.deepEqual(plan.deletes, []);
});

test('plan: matching subs are unchanged (action order ignored), extras and unwanted types deleted', () => {
  const existing = [sub(1, DEAL, [COMPANY, CONTACT]), sub(2, DEAL, [CONTACT, COMPANY]), sub(3, PET, [CONTACT])];
  const plan = planSubscriptionChanges(pairs([DEAL, CONTACT], [DEAL, COMPANY]), existing);
  assert.deepEqual(plan.upserts, []);
  assert.deepEqual(plan.unchanged, [DEAL]);
  assert.deepEqual(plan.deletes, [2, 3]);
});

test('plan: changed partner set -> upsert that replaces the old sub', () => {
  const plan = planSubscriptionChanges(pairs([DEAL, CONTACT], [DEAL, COMPANY]), [sub(1, DEAL, [CONTACT])]);
  assert.deepEqual(plan.upserts, [{ objectTypeId: DEAL, associatedObjectTypeIds: [CONTACT, COMPANY], replaces: [1] }]);
  assert.deepEqual(plan.deletes, []);
});

test('plan: a sub filtered to objectIds or missing an action is not a match', () => {
  assert.equal(planSubscriptionChanges(pairs([DEAL, CONTACT]), [sub(1, DEAL, [CONTACT], { objectIds: [5] })]).upserts.length, 1);
  assert.equal(planSubscriptionChanges(pairs([DEAL, CONTACT]), [sub(1, DEAL, [CONTACT], { actions: ['ASSOCIATION_ADDED'] })]).upserts.length, 1);
});

test('plan: empty desired deletes everything for the portal', () => {
  const plan = planSubscriptionChanges([], [sub(4, DEAL, [CONTACT]), sub(3, PET, [CONTACT])]);
  assert.deepEqual(plan.deletes, [3, 4]);
});

test('apply: upsert first, then delete only replaced ids that differ from the returned id', async () => {
  const api = new FakeSubs();
  api.subs = [sub(1, DEAL, [CONTACT]), sub(7, PET, [CONTACT])];
  // upsert key in the fake is (portal, objectTypeId), so id 1 is updated in place and must NOT be deleted
  const plan = planSubscriptionChanges(pairs([DEAL, CONTACT], [DEAL, COMPANY]), api.subs);
  const r = await applySubscriptionPlan(P, plan, api);
  assert.deepEqual(api.calls, ['create 0-3', 'delete 7']);
  assert.deepEqual(r.deleted, [7]);
  assert.deepEqual(api.subs.map((s) => [s.id, s.associatedObjectTypeIds]), [[1, [CONTACT, COMPANY]]]);

  // If HubSpot instead creates a NEW sub (different upsert key), the old one is deleted after the create.
  const plan2 = { upserts: [{ objectTypeId: DEAL, associatedObjectTypeIds: [CONTACT], replaces: [1, 99] }], deletes: [], unchanged: [] };
  api.calls = [];
  await applySubscriptionPlan(P, plan2, api);
  assert.deepEqual(api.calls, ['create 0-3', 'delete 99']);
});

test('ensureLifecycleSubscriptions creates only the missing install/uninstall subs', async () => {
  const api = new FakeSubs();
  assert.deepEqual((await ensureLifecycleSubscriptions(api)).created, ['4-1909196', '4-1916193']);
  assert.deepEqual(await ensureLifecycleSubscriptions(api), { created: [], existing: ['4-1909196', '4-1916193'] });
});

// ---------- installer ----------

test('install: saves token, sets default pairs, creates properties + grouped subscriptions', async () => {
  const { installer, portals, subs, propsCalls, refreshed } = setup();
  const r = await installer.completeInstall(tokenResponse());
  assert.equal(r.watchedPairs.length, 3);
  assert.deepEqual(propsCalls, [CONTACT, COMPANY, DEAL]);
  assert.deepEqual(refreshed, [], 'used the primed access token');
  assert.deepEqual(subs.subs.map((s) => [s.objectTypeId, s.associatedObjectTypeIds]).sort(), [[COMPANY, [CONTACT]], [DEAL, [CONTACT, COMPANY]]]);
  assert.ok(portals.isInstalled(P));
  assert.notEqual(portals.getPortal(P)?.provisionedAt, null);
  // Running provision again is a no-op for subscriptions.
  subs.calls = [];
  await installer.provision(P);
  assert.deepEqual(subs.calls, []);
});

test('settings save: validates, creates properties only on new types, diffs subs, saves spacing', async () => {
  const { installer, portals, subs, propsCalls } = setup();
  await installer.completeInstall(tokenResponse(P, CUSTOM_GRANTED));
  propsCalls.length = 0;
  subs.calls = [];
  const allowed = [CONTACT, COMPANY, DEAL, PET];

  await assert.rejects(installer.saveSettings(P, { watchedPairs: [], stampSpacingSeconds: 0 }, allowed), /stampSpacingSeconds/);
  await assert.rejects(installer.saveSettings(P, { watchedPairs: pairs(['2-404', CONTACT]), stampSpacingSeconds: 3 }, allowed), /Unknown object type/);

  await installer.saveSettings(P, { watchedPairs: pairs([CONTACT, PET], [DEAL, CONTACT]), stampSpacingSeconds: 10 }, allowed);
  assert.deepEqual(propsCalls, [PET]);
  assert.deepEqual(portals.getWatchedPairs(P), pairs([DEAL, CONTACT], [PET, CONTACT]));
  assert.equal(portals.getStampSpacingMs(P), 10_000);
  assert.deepEqual(subs.subs.map((s) => [s.objectTypeId, s.associatedObjectTypeIds]).sort(), [[DEAL, [CONTACT]], [PET, [CONTACT]]]);
});

test('settings save: a property failure changes nothing (pairs and subs stay)', async () => {
  const { installer, portals, subs } = setup({ failPropsOn: PET });
  await installer.completeInstall(tokenResponse(P, CUSTOM_GRANTED));
  const before = portals.getWatchedPairs(P);
  const subsBefore = JSON.stringify(subs.subs);
  await assert.rejects(
    installer.saveSettings(P, { watchedPairs: pairs([PET, CONTACT]), stampSpacingSeconds: 3 }, [CONTACT, PET]),
    /Could not create ChangeCatch properties on 2-23488212/,
  );
  assert.deepEqual(portals.getWatchedPairs(P), before);
  assert.equal(JSON.stringify(subs.subs), subsBefore);
});

test('custom objects without the custom WRITE scopes: settings save is refused; provision skips them with a log line', async () => {
  const logs: string[] = [];
  const { installer, portals, subs, propsCalls } = setup({ log: (m) => logs.push(m) });
  await installer.completeInstall(tokenResponse(P, ['crm.objects.custom.read', 'crm.schemas.custom.read'])); // read only
  const before = portals.getWatchedPairs(P);
  propsCalls.length = 0;
  subs.calls = [];
  await assert.rejects(
    installer.saveSettings(P, { watchedPairs: pairs([PET, CONTACT], [DEAL, CONTACT]), stampSpacingSeconds: 3 }, [CONTACT, DEAL, PET]),
    /Custom objects need two extra permissions/,
  );
  assert.deepEqual(portals.getWatchedPairs(P), before, 'nothing saved');
  assert.deepEqual(propsCalls, []);
  assert.deepEqual(subs.calls, []);

  // A stored custom pair (e.g. from before the scopes were lost) is skipped by provision, not failed.
  portals.setWatchedPairs(P, pairs([PET, CONTACT], [DEAL, CONTACT]));
  await installer.provision(P);
  assert.deepEqual(portals.getWatchedPairs(P), pairs([DEAL, CONTACT]));
  assert.ok(!(propsCalls as string[]).includes(PET));
  assert.ok(subs.subs.every((x) => x.objectTypeId !== PET));
  assert.ok(logs.some((l) => /skipping 1 custom-object pair.*crm\.objects\.custom\.write/.test(l)), logs.join(' | '));
  assert.equal(portals.getPortal(P)?.lastProvisionError, null);
});

// ---------- lifecycle ----------

const lc = (action: 'APP_INSTALL' | 'APP_UNINSTALL', occurredAt: string, portalId = P) =>
  ({ type: 'app_lifecycle_event' as const, action, portalId, occurredAt, eventTypeId: action === 'APP_INSTALL' ? '4-1909196' : '4-1916193' });

test('lifecycle: uninstall deletes portal subs, wipes token and pairs; repeat is a no-op', async () => {
  const { installer, portals, subs } = setup();
  await installer.completeInstall(tokenResponse());
  subs.subs.push(sub(55, DEAL, [CONTACT], { portalId: 222 })); // another portal: untouched
  const ctx = { installer, portals, log: () => {} };

  assert.equal(await handleLifecycleEvent(lc('APP_UNINSTALL', new Date(Date.now() + 1000).toISOString()), ctx), 'uninstalled');
  assert.ok(subs.calls.includes(`deletePortal ${P}`));
  assert.deepEqual(subs.subs.map((s) => s.id), [55]);
  assert.equal(portals.getRefreshToken(P), undefined);
  assert.equal(portals.isInstalled(P), false);
  assert.deepEqual(portals.getWatchedPairs(P), []);
  assert.notEqual(portals.getPortal(P)?.uninstalledAt, null);

  assert.equal(await handleLifecycleEvent(lc('APP_UNINSTALL', new Date().toISOString()), ctx), 'ignored-already-uninstalled');
});

test('lifecycle: an uninstall older than the latest install is ignored', async () => {
  const { installer, portals } = setup();
  await installer.completeInstall(tokenResponse());
  const out = await handleLifecycleEvent(lc('APP_UNINSTALL', '2020-01-01T00:00:00Z'), { installer, portals, log: () => {} });
  assert.equal(out, 'ignored-stale-uninstall');
  assert.ok(portals.isInstalled(P));
});

test('lifecycle: install events provision only when needed', async () => {
  const { installer, portals } = setup();
  const ctx = { installer, portals, log: () => {} };
  assert.equal(await handleLifecycleEvent(lc('APP_INSTALL', new Date().toISOString()), ctx), 'install-without-tokens');
  await installer.completeInstall(tokenResponse());
  assert.equal(await handleLifecycleEvent(lc('APP_INSTALL', new Date().toISOString()), ctx), 'install-already-provisioned');
});

// ---------- HTTP server ----------

test('server: /api/settings requires a valid v3 signature and returns settings', async () => {
  const { installer, portals } = setup();
  await installer.completeInstall(tokenResponse());
  const secret = 'shh';
  const base = 'https://changecatch.example.com';
  const server = createAppServer({
    installer, portals, clientSecret: secret, callbackPath: '/oauth/callback', publicBaseUrl: base,
    objectTypes: async () => [{ objectTypeId: CONTACT, label: 'Contact', custom: false }, { objectTypeId: DEAL, label: 'Deal', custom: false }, { objectTypeId: COMPANY, label: 'Company', custom: false }],
    buildInstallUrl: (s) => `https://app.hubspot.com/oauth/authorize?state=${s}`,
    exchangeCode: async () => { throw new Error('unused'); },
    log: () => {},
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  const path = `/api/settings?userId=1&portalId=${P}&userEmail=a%40b.com&appId=9`;
  const signed = (method: string, body = '') => {
    const ts = String(Date.now());
    return { 'x-hubspot-signature-v3': signV3(secret, method, base + path, body, ts), 'x-hubspot-request-timestamp': ts, 'content-type': 'application/json' };
  };
  try {
    const bad = await fetch(`http://localhost:${port}${path}`);
    assert.equal(bad.status, 401);

    const ok = await fetch(`http://localhost:${port}${path}`, { headers: signed('GET') });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as any;
    assert.equal(body.portalId, P);
    assert.equal(body.watchedPairs.length, 3);
    assert.equal(body.stampSpacingSeconds, 3);

    const payload = JSON.stringify({ watchedPairs: [{ objectTypeId: CONTACT, associatedObjectTypeId: DEAL }], stampSpacingSeconds: 5 });
    const saved = await fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: signed('POST', payload), body: payload });
    assert.equal(saved.status, 200);
    assert.deepEqual(((await saved.json()) as any).watchedPairs, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);

    const invalid = JSON.stringify({ watchedPairs: 'nope', stampSpacingSeconds: 5 });
    assert.equal((await fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: signed('POST', invalid), body: invalid })).status, 400);

    const redirect = await fetch(`http://localhost:${port}/install`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.match(redirect.headers.get('location') ?? '', /^https:\/\/app\.hubspot\.com\/oauth\/authorize\?state=1\.\d+\.[\w-]+\.[\w-]+$/);
  } finally {
    server.close();
  }
});

test('lifecycle subs self-heal: created at start, recreated when deleted, failures logged not thrown', async () => {
  const api = new FakeSubs();
  const logs: string[] = [];
  const w = startLifecycleSubscriptionWatch({ api, intervalMs: 60_000, log: (m) => logs.push(m) });
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

test('lifecycle subs self-heal: the timer re-checks periodically', async () => {
  const api = new FakeSubs();
  let lists = 0;
  const orig = api.listSubscriptions.bind(api);
  api.listSubscriptions = async () => { lists++; return orig(); };
  const w = startLifecycleSubscriptionWatch({ api, intervalMs: 20, log: () => {} });
  try {
    await w.ready;
    api.subs = [];
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(lists >= 3, `expected periodic checks, got ${lists}`);
    assert.equal(api.subs.length, 2, 'deleted subs were recreated by the timer');
  } finally {
    w.stop();
  }
});

test('ensureLifecycleSubscriptions recognises the real HubSpot list shape (event type in objectTypeId)', async () => {
  // Shape copied from a live GET /webhooks-journal/subscriptions/2026-09 response: lifecycle subs carry the event
  // type in `objectTypeId` and have no `eventTypeId` field. Reading the wrong field made every check report "missing".
  const live = [
    { id: 60406478, appId: 1, subscriptionType: 'APP_LIFECYCLE_EVENT', objectTypeId: '4-1909196', actions: [], createdAt: '2026-10-30T02:54:00.020Z', updatedAt: '' },
    { id: 60406479, appId: 1, subscriptionType: 'APP_LIFECYCLE_EVENT', objectTypeId: '4-1916193', actions: [], createdAt: '2026-10-30T02:54:00.349Z', updatedAt: '' },
    { id: 60406509, appId: 1, subscriptionType: 'ASSOCIATION', portalId: 1234567, objectTypeId: '0-3', associatedObjectTypeIds: ['0-1'], actions: [], createdAt: '', updatedAt: '' },
  ] as unknown as Subscription[];
  const created: unknown[] = [];
  const api: SubscriptionApi = {
    listSubscriptions: async () => live,
    createSubscription: async (b: SubscriptionRequest) => { created.push(b); return live[0]; },
    deleteSubscription: async () => {},
  } as unknown as SubscriptionApi;
  const r = await ensureLifecycleSubscriptions(api);
  assert.deepEqual(r, { created: [], existing: ['4-1909196', '4-1916193'] });
  assert.equal(created.length, 0, 'no create call when both already exist');
});
