import { alertsOf, memoryLogger } from '../../test/fixtures/log.js';
import type { Logger } from '../obs/log.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Subscription } from '../hubspot/journal.js';
import { FakeSubs, sub } from '../../test/fixtures/subscriptions.js';
import type { LabelSyncReport, SetupReport } from '../hubspot/properties.js';
import type { WatchedPair } from '../core/types.js';
import { PortalStore } from '../store/portals.js';
import { parseKeyring } from '../lib/crypto.js';
import { Installer } from './installer.js';
import { normalisePairs, orientPair, portalPairs } from '../core/pairs.js';
import { parseSettingsBody } from './settings.js';
import { listen, testAppServer } from '../../test/fixtures/app-server.js';
import { reconcilePortalSubscriptions } from './subscriptions.js';
import { PortalTokenProvider } from '../hubspot/portal-tokens.js';

const RAW_KEY = randomBytes(32);
const KEY = parseKeyring(`t:${RAW_KEY.toString('base64')}`);
const P = 111;
const DEAL = '0-3', CONTACT = '0-1', COMPANY = '0-2', PET = '2-23488212';

// ---------- helpers ----------

function setup(opts: { failPropsOn?: string; log?: Logger } = {}) {
  const portals = new PortalStore({ path: ':memory:', key: KEY });
  const refreshed: string[] = [];
  const tokens = new PortalTokenProvider({
    store: portals,
    refresh: async (rt) => { refreshed.push(rt); return { token_type: 'bearer', access_token: `at-${rt}`, expires_in: 1800 }; },
  });
  const subs = new FakeSubs();
  const propsCalls: string[] = [];
  const ensureProperties = async (_auth: unknown, objectType: string): Promise<SetupReport> => {
    propsCalls.push(objectType);
    if (objectType === opts.failPropsOn) return { objectType, group: 'error', properties: [], missingScope: 'crm.schemas.custom.write', error: '403', failure: 'missing scope crm.schemas.custom.write' };
    return { objectType, group: 'created', properties: [] };
  };
  const syncCalls: { objectTypeId: string; pairs: WatchedPair[] }[] = [];
  const syncOptions = async (auth: { portalId: number }, objectTypeId: string, pairs: WatchedPair[]): Promise<LabelSyncReport> => {
    syncCalls.push({ objectTypeId, pairs });
    return { portalId: auth.portalId, objectTypeId, otherObjectTypeIds: [], options: [], properties: [], labelErrors: [] };
  };
  const installer = new Installer({ portals, tokens, subscriptions: subs, ensureProperties, syncOptions, objectTypes: async () => OBJECT_TYPES, log: opts.log ?? memoryLogger().log });
  return { portals, tokens, subs, propsCalls, syncCalls, installer, refreshed };
}

const tokenResponse = (portalId = P, extraScopes: string[] = []) => ({ token_type: 'bearer', access_token: 'at0', refresh_token: 'rt-secret', expires_in: 1800, hub_id: portalId, scopes: ['oauth', 'crm.objects.deals.read', ...extraScopes] });
/** An Enterprise portal that granted the custom read + write scopes. */
const ot = (objectTypeId: string, singular: string, custom = false) => ({ objectTypeId, singular, plural: `${singular}s`, custom });
const OBJECT_TYPES = [ot(CONTACT, 'Contact'), ot(COMPANY, 'Company'), ot(DEAL, 'Deal'), ot(PET, 'Pet', true)];
const CUSTOM_GRANTED = ['crm.objects.custom.read', 'crm.schemas.custom.read', 'crm.objects.custom.write', 'crm.schemas.custom.write'];

// ---------- token storage ----------

// ---------- pairs ----------

test('pairs are oriented (custom > deal > company > contact) and de-duplicated', () => {
  assert.deepEqual(orientPair(CONTACT, DEAL), { objectTypeId: DEAL, associatedObjectTypeId: CONTACT });
  assert.deepEqual(orientPair(CONTACT, PET), { objectTypeId: PET, associatedObjectTypeId: CONTACT });
  assert.deepEqual(orientPair(CONTACT, COMPANY), { objectTypeId: COMPANY, associatedObjectTypeId: CONTACT });
  assert.deepEqual(orientPair('2-9', '2-1'), orientPair('2-1', '2-9'));
  assert.equal(normalisePairs([{ objectTypeId: CONTACT, associatedObjectTypeId: DEAL }, { objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]).length, 1);
});

// ---------- subscription reconcile ----------

const pairs = (...ps: [string, string][]) => ps.map(([a, b]) => ({ objectTypeId: a, associatedObjectTypeId: b }));
/** The portal's live subscriptions as [objectTypeId, sorted partners], sorted. */
const live = (api: FakeSubs) => api.subs.map((s) => [s.objectTypeId, [...s.associatedObjectTypeIds!].sort()] as const).sort();

async function reconcile(existing: Subscription[], desired: [string, string][]) {
  const api = new FakeSubs();
  api.subs = existing;
  await reconcilePortalSubscriptions(P, normalisePairs(pairs(...desired)), api);
  return api;
}

test('reconcile: one subscription per subscribed object type, partners grouped', async () => {
  const api = await reconcile([], [[DEAL, CONTACT], [COMPANY, DEAL], [CONTACT, COMPANY]]);
  assert.deepEqual(live(api), [[COMPANY, [CONTACT]], [DEAL, [CONTACT, COMPANY]]]);
  // Already in sync (action order ignored): no HubSpot writes.
  api.calls = [];
  await reconcilePortalSubscriptions(P, normalisePairs(pairs([DEAL, CONTACT], [DEAL, COMPANY], [COMPANY, CONTACT])), api);
  assert.deepEqual(api.calls, []);
});

test('reconcile: duplicates and unwanted types are deleted; changed partners are updated', async () => {
  const dup = await reconcile([sub(1, DEAL, [COMPANY, CONTACT]), sub(2, DEAL, [CONTACT, COMPANY]), sub(3, PET, [CONTACT])], [[DEAL, CONTACT], [DEAL, COMPANY]]);
  assert.deepEqual(live(dup), [[DEAL, [CONTACT, COMPANY]]]);
  const changed = await reconcile([sub(1, DEAL, [CONTACT])], [[DEAL, CONTACT], [DEAL, COMPANY]]);
  assert.deepEqual(live(changed), [[DEAL, [CONTACT, COMPANY]]]);
  assert.deepEqual(await reconcile([sub(4, DEAL, [CONTACT]), sub(3, PET, [CONTACT])], []).then(live), []);
});

test('reconcile: a sub filtered to objectIds or missing an action is replaced by a full one', async () => {
  for (const extra of [{ objectIds: [5] }, { actions: ['ASSOCIATION_ADDED'] }] as Partial<Subscription>[]) {
    const api = await reconcile([sub(1, DEAL, [CONTACT], extra)], [[DEAL, CONTACT]]);
    assert.deepEqual(api.calls, ['create 0-3'], 'not taken as a match: re-upserted');
    assert.equal(api.subs.length, 1);
  }
});

test('reconcile: a replaced sub is deleted only when HubSpot created a new one (upsert in place keeps it)', async () => {
  // The fake upserts by (portal, objectTypeId), like HubSpot: id 1 is updated in place and must survive.
  const inPlace = await reconcile([sub(1, DEAL, [CONTACT])], [[DEAL, CONTACT], [DEAL, COMPANY]]);
  assert.deepEqual(inPlace.subs.map((s) => s.id), [1]);
  // Two stale subs for one type: one is upserted, the other deleted.
  const stale = await reconcile([sub(1, DEAL, [CONTACT]), sub(2, DEAL, [COMPANY])], [[DEAL, CONTACT], [DEAL, COMPANY]]);
  assert.deepEqual(live(stale), [[DEAL, [CONTACT, COMPANY]]]);
  // A sub of another portal is never touched.
  const other = await reconcile([sub(9, DEAL, [CONTACT], { portalId: 222 })], [[DEAL, CONTACT]]);
  assert.deepEqual(other.subs.map((s) => [s.id, s.portalId]), [[9, 222], [1000, P]]);
});

// ---------- installer ----------

test('install: saves token, sets default pairs, creates properties + grouped subscriptions', async () => {
  const { installer, portals, subs, propsCalls, refreshed } = setup();
  const r = await installer.completeInstall(tokenResponse());
  assert.equal(r.watchedPairs.length, 3);
  assert.deepEqual([...propsCalls].sort(), [CONTACT, COMPANY, DEAL].sort());
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
  assert.throws(() => parseSettingsBody(JSON.stringify({ watchedPairs: [], stampSpacingSeconds: 0 })), /stampSpacingSeconds/);
  await assert.rejects(installer.saveSettings(P, { watchedPairs: pairs(['2-404', CONTACT]), stampSpacingSeconds: 3 }), /Unknown object type/);

  await installer.saveSettings(P, { watchedPairs: pairs([CONTACT, PET], [DEAL, CONTACT]), stampSpacingSeconds: 10 });
  assert.deepEqual(propsCalls, [PET]);
  assert.deepEqual(portals.getWatchedPairs(P), pairs([DEAL, CONTACT], [PET, CONTACT]));
  assert.equal(portals.getStampSpacingMs(P), 10_000);
  assert.deepEqual(subs.subs.map((s) => [s.objectTypeId, s.associatedObjectTypeIds]).sort(), [[DEAL, [CONTACT]], [PET, [CONTACT]]]);
});

// changecatch_other_object_type starts with the standard types only, so a newly watched custom pair must have its
// type as an option before the first stamp (a value that is not an option makes HubSpot reject the record update).
test('settings save: adding a custom-object pair syncs the dropdown options on both sides first; standard pairs need no sync', async () => {
  const { installer, syncCalls } = setup();
  await installer.completeInstall(tokenResponse(P, CUSTOM_GRANTED));
  assert.equal(syncCalls.length, 0, 'standard default pairs: no option sync');

  await installer.saveSettings(P, { watchedPairs: pairs([DEAL, CONTACT], [DEAL, COMPANY]), stampSpacingSeconds: 3 });
  assert.equal(syncCalls.length, 0, 'standard pair added: its options are there from property creation');

  await installer.saveSettings(P, { watchedPairs: pairs([DEAL, CONTACT], [PET, DEAL]), stampSpacingSeconds: 3 });
  assert.deepEqual(syncCalls.map((c) => c.objectTypeId).sort(), [DEAL, PET].sort());
  for (const c of syncCalls) assert.deepEqual(c.pairs, pairs([DEAL, CONTACT], [PET, DEAL]), 'synced against every active pair');

  syncCalls.length = 0;
  await installer.saveSettings(P, { watchedPairs: pairs([DEAL, CONTACT], [PET, DEAL]), stampSpacingSeconds: 5 });
  assert.equal(syncCalls.length, 0, 'an already watched custom pair is not synced again');
});

test('settings save: an uninstall by the worker during the save removes the re-created subscriptions and leaves no saved pairs', async () => {
  const { installer, portals, subs } = setup();
  await installer.completeInstall(tokenResponse(P, CUSTOM_GRANTED));
  const create = subs.createSubscription.bind(subs);
  subs.createSubscription = async (b) => {
    const r = await create(b);
    portals.markUninstalled(P); // the worker's Installer.uninstall, which does not share this process's lock
    return r;
  };
  await assert.rejects(installer.saveSettings(P, { watchedPairs: pairs([DEAL, CONTACT], [COMPANY, CONTACT]), stampSpacingSeconds: 3 }), /uninstalled/);
  assert.deepEqual(subs.subs.filter((x) => x.portalId === P), [], 'subscriptions deleted again');
  assert.deepEqual(portals.getWatchedPairs(P), [], 'no pairs left for the uninstalled portal');
});

test('settings save: pairs are saved BEFORE subscriptions are created (no event dropped as unwatched in between)', async () => {
  const { installer, portals, subs } = setup();
  await installer.completeInstall(tokenResponse(P, CUSTOM_GRANTED));
  const want = pairs([DEAL, CONTACT], [DEAL, COMPANY], [COMPANY, CONTACT], [PET, CONTACT]);
  const seenAtCreate: string[][] = [];
  const create = subs.createSubscription.bind(subs);
  subs.createSubscription = async (b) => {
    seenAtCreate.push(portals.getWatchedPairs(P).map((p) => `${p.objectTypeId}|${p.associatedObjectTypeId}`));
    return create(b);
  };
  await installer.saveSettings(P, { watchedPairs: want, stampSpacingSeconds: 3 });
  assert.ok(seenAtCreate.length > 0);
  for (const s of seenAtCreate) assert.ok(s.includes(`${PET}|${CONTACT}`), 'the new pair was already saved when its subscription was created');

  // A subscription failure after the save: the portal is marked provision-failed, so the sweep reconciles.
  const fresh = setup();
  await fresh.installer.completeInstall(tokenResponse(P, CUSTOM_GRANTED));
  fresh.subs.createSubscription = async () => { throw new Error('HubSpot 503'); };
  await assert.rejects(fresh.installer.saveSettings(P, { watchedPairs: want, stampSpacingSeconds: 3 }), /503/);
  assert.equal(fresh.portals.getWatchedPairs(P).length, 4, 'saved');
  assert.match(fresh.portals.getPortal(P)?.lastProvisionError ?? '', /503/);
});

test('provision: an explicitly empty pair list stays empty; defaults only when never configured', async () => {
  const { installer, portals, subs } = setup();
  await installer.completeInstall(tokenResponse(P));
  assert.equal(portals.getWatchedPairs(P).length, 3, 'defaults on first install');
  await installer.saveSettings(P, { watchedPairs: [], stampSpacingSeconds: 3 });
  assert.deepEqual(portals.getWatchedPairs(P), []);
  // Re-consent (OAuth again without an uninstall) re-provisions: still empty, no subscriptions re-created.
  const r = await installer.completeInstall(tokenResponse(P));
  assert.deepEqual(r.watchedPairs, []);
  assert.deepEqual(portals.getWatchedPairs(P), []);
  assert.deepEqual(subs.subs.filter((s) => s.portalId === P), []);
  // After an uninstall (provisioned_at reset, settings purged by the worker) a reinstall gets the defaults again.
  portals.markUninstalled(P);
  await installer.completeInstall(tokenResponse(P));
  assert.equal(portals.getWatchedPairs(P).length, 3);
});

test('settings save: a property failure changes nothing (pairs and subs stay)', async () => {
  const { installer, portals, subs } = setup({ failPropsOn: PET });
  await installer.completeInstall(tokenResponse(P, CUSTOM_GRANTED));
  const before = portals.getWatchedPairs(P);
  const subsBefore = JSON.stringify(subs.subs);
  await assert.rejects(
    installer.saveSettings(P, { watchedPairs: pairs([PET, CONTACT]), stampSpacingSeconds: 3 }),
    /Could not create ChangeCatch properties on 2-23488212/,
  );
  assert.deepEqual(portals.getWatchedPairs(P), before);
  assert.equal(JSON.stringify(subs.subs), subsBefore);
});

test('custom objects without the custom WRITE scopes: settings save is refused; provision skips them with a log line', async () => {
  const { log, lines: logs } = memoryLogger();
  const { installer, portals, subs, propsCalls } = setup({ log });
  await installer.completeInstall(tokenResponse(P, ['crm.objects.custom.read', 'crm.schemas.custom.read'])); // read only
  const before = portals.getWatchedPairs(P);
  propsCalls.length = 0;
  subs.calls = [];
  await assert.rejects(
    installer.saveSettings(P, { watchedPairs: pairs([PET, CONTACT], [DEAL, CONTACT]), stampSpacingSeconds: 3 }),
    /Custom objects need two extra permissions/,
  );
  assert.deepEqual(portals.getWatchedPairs(P), before, 'nothing saved');
  assert.deepEqual(propsCalls, []);
  assert.deepEqual(subs.calls, []);

  // A stored custom pair (e.g. from before the scopes were lost) is skipped by provision, not failed, and stays saved.
  portals.setWatchedPairs(P, pairs([PET, CONTACT], [DEAL, CONTACT]));
  const r = await installer.provision(P);
  assert.deepEqual(r.watchedPairs, pairs([DEAL, CONTACT]), 'only the standard pair is set up');
  assert.deepEqual(portals.getWatchedPairs(P), pairs([DEAL, CONTACT], [PET, CONTACT]), "the admin's custom pair is kept");
  assert.ok(!(propsCalls as string[]).includes(PET));
  assert.ok(subs.subs.every((x) => x.objectTypeId !== PET));
  assert.ok(logs.some((l) => /skipping 1 custom-object pair.*crm\.objects\.custom\.write/.test(l)), logs.join(' | '));
  assert.equal(portals.getPortal(P)?.lastProvisionError, null);
  assert.deepEqual(portalPairs(portals, P).active, pairs([DEAL, CONTACT]), 'the saved custom pair is not active (worker ignores it)');

  // Saving other changes keeps the saved (inactive) custom pair instead of refusing the whole save.
  propsCalls.length = 0;
  await installer.saveSettings(P, { watchedPairs: pairs([PET, CONTACT], [DEAL, CONTACT], [COMPANY, CONTACT]), stampSpacingSeconds: 5 });
  assert.deepEqual(portals.getWatchedPairs(P), pairs([COMPANY, CONTACT], [DEAL, CONTACT], [PET, CONTACT]));
  assert.deepEqual(propsCalls, [COMPANY], 'properties only on the newly active type');
  assert.ok(subs.subs.every((x) => x.objectTypeId !== PET));
  assert.equal(portals.getStampSpacingSeconds(P), 5);
});

test('provision keeps custom pairs saved while custom write is missing; they are set up once it is granted', async () => {
  const { installer, portals, subs, propsCalls } = setup();
  await installer.completeInstall(tokenResponse(P, CUSTOM_GRANTED));
  await installer.saveSettings(P, { watchedPairs: pairs([PET, CONTACT], [DEAL, CONTACT]), stampSpacingSeconds: 3 });

  // Reinstall without the custom write scopes (e.g. the second consent was declined): PET is skipped, not forgotten.
  await installer.completeInstall(tokenResponse(P, ['crm.objects.custom.read', 'crm.schemas.custom.read']));
  assert.deepEqual(portals.getWatchedPairs(P), pairs([DEAL, CONTACT], [PET, CONTACT]));
  assert.ok(subs.subs.every((x) => x.objectTypeId !== PET), 'no subscription for the ungranted custom object');

  // Custom write granted again: provision sets PET up from the saved pairs, no need to re-pick it.
  propsCalls.length = 0;
  await installer.completeInstall(tokenResponse(P, CUSTOM_GRANTED));
  assert.ok((propsCalls as string[]).includes(PET));
  assert.deepEqual(subs.subs.map((x) => x.objectTypeId).sort(), [DEAL, PET]);
});

// ---------- provisioning sweep (API server) ----------

test('provisionPending: re-provisions installed portals that were never provisioned or failed; leaves the rest alone; alerts on repeats', async () => {
  const o: { failPropsOn?: string; log?: Logger } = {};
  const { log, records } = memoryLogger();
  o.log = log;
  const { installer, portals, propsCalls } = setup(o);
  await installer.completeInstall(tokenResponse()); // P: provisioned by the callback
  portals.saveInstall(222, 'rt-222', ['oauth'], 1); // callback crashed before provisioning
  o.failPropsOn = DEAL;
  await assert.rejects(installer.completeInstall(tokenResponse(333))); // provisioning failed
  assert.ok(portals.getPortal(333)?.lastProvisionError);
  portals.saveInstall(444, 'rt-444', ['oauth'], 1);
  portals.markUninstalled(444, 2); // uninstalled: never provisioned again

  // HubSpot still failing: both retried every sweep; alert on the 3rd failure in a row.
  for (let i = 1; i <= 3; i++) {
    const r = await installer.provisionPending();
    assert.deepEqual([r.provisioned, r.failed.sort()], [[], [222, 333]]);
  }
  const alerts = alertsOf(records, 'provisioning_failing');
  assert.equal(alerts.filter((m) => m.startsWith('portal 222: provisioning failed (3 sweep(s) in a row)')).length, 1);
  assert.equal(alerts.length, 2);

  o.failPropsOn = undefined;
  propsCalls.length = 0;
  const r = await installer.provisionPending();
  assert.deepEqual([r.provisioned.sort(), r.failed], [[222, 333], []]);
  for (const p of [222, 333]) {
    assert.notEqual(portals.getPortal(p)?.provisionedAt, null);
    assert.equal(portals.getPortal(p)?.lastProvisionError, null);
  }
  propsCalls.length = 0;
  assert.deepEqual(await installer.provisionPending(), { provisioned: [], failed: [] });
  assert.deepEqual(propsCalls, [], 'provisioned portals are left alone');
});

// ---------- HTTP server ----------

test('server + real installer: settings GET returns the defaults, POST saves normalised pairs, bad body is 400', async () => {
  const { installer, portals } = setup();
  await installer.completeInstall(tokenResponse());
  const server = testAppServer({
    installer, portals, publicBaseUrl: 'http://localhost:1', allowUnsigned: true,
  });
  const base = await listen(server);
  const path = `/api/settings?userId=1&portalId=${P}&userEmail=a%40b.com&appId=9`;
  const json = { 'content-type': 'application/json' };
  try {
    const ok = await fetch(`${base}${path}`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as any;
    assert.equal(body.portalId, P);
    assert.equal(body.watchedPairs.length, 3);

    const payload = JSON.stringify({ watchedPairs: [{ objectTypeId: CONTACT, associatedObjectTypeId: DEAL }], stampSpacingSeconds: 5 });
    const saved = await fetch(`${base}${path}`, { method: 'POST', headers: json, body: payload });
    assert.equal(saved.status, 200);
    assert.deepEqual(((await saved.json()) as any).watchedPairs, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT, active: true }]);

    const invalid = JSON.stringify({ watchedPairs: 'nope', stampSpacingSeconds: 5 });
    assert.equal((await fetch(`${base}${path}`, { method: 'POST', headers: json, body: invalid })).status, 400);

    const redirect = await fetch(`${base}/install`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    const loc = new URL(redirect.headers.get('location') ?? '');
    assert.equal(`${loc.origin}${loc.pathname}`, 'https://app.hubspot.com/oauth/authorize');
    assert.match(loc.searchParams.get('state') ?? '', /^1\.\d+\.[\w-]+\.[\w-]+$/);
  } finally {
    server.close();
  }
});
