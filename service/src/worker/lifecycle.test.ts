// The worker's lifecycle handling (lifecycle.ts) through the real Worker loop, Store and PortalStore:
// uninstall purges and deletes subscriptions (retried on HubSpot failure, never holding the offset), a stale uninstall
// is ignored, a reinstall lifts a stamping pause, a 7-day pause expiry runs the uninstall routine.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADD, CONTACT, DEAL, ev, file, HD, T0, UD } from '../../test/fixtures/journal.js';
import { closeWorkerHarnesses, workerHarness, type WorkerHarnessOpts } from '../../test/fixtures/worker.js';
import type { StampUpdate } from '../core/stamp.js';
import type { JournalEvent, JournalFile } from '../core/types.js';
import { PortalNotInstalledError, TokenRevokedError } from '../hubspot/portal-tokens.js';
import { HubSpotError } from '../lib/http.js';

afterEach(closeWorkerHarnesses);

const DAY = 24 * 60 * 60_000;

const lifecycleEvent = (action: 'APP_INSTALL' | 'APP_UNINSTALL', portalId: number, at: number): JournalEvent => ({
  type: 'app_lifecycle_event', action, eventTypeId: action === 'APP_INSTALL' ? '4-1909196' : '4-1916193', portalId,
  occurredAt: new Date(at).toISOString(), properties: {},
});

/** The production worker wiring on one SQLite file (Store + PortalStore), fake subscriptions, fake clock, nothing installed. */
function setup(files: JournalFile[] = [], o: WorkerHarnessOpts = {}) {
  const s = workerHarness({ files, installed: [], ...o });
  const forgotten: number[] = [];
  const forget = s.metrics.forgetPortal.bind(s.metrics);
  s.metrics.forgetPortal = (p) => (forgotten.push(p), forget(p));
  return { ...s, forgotten };
}

test('uninstall from the journal: local data purged at once, HubSpot cleanup retried with back-off; the offset never waits', async () => {
  const files: JournalFile[] = [
    { offset: 'f1', journalEvents: [lifecycleEvent('APP_UNINSTALL', 111, T0), ev({ action: ADD, typeId: 3, at: 1000 })] },
    file('f2', [ev({ portalId: 5, at: 40_000 })]),
  ];
  const s = setup(files);
  const { store, portals, subs, clock, worker, tokens } = s;
  portals.saveInstall(111, 'rt-111', ['crm.objects.deals.write'], T0 - 1000);
  portals.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
  subs.fail = 2;
  // A stamp already waiting in the queue for portal 111 (e.g. spacing slot).
  store.stamps.enqueueStamps([{ changeId: 'old', recordKey: '111|0-3|1', notBefore: clock.t + 10_000,
    update: { portalId: 111, objectTypeId: DEAL, objectId: '1', occurredAtMs: T0, properties: { changecatch_last_change_id: 'old' } as StampUpdate['properties'] } }], clock.t);

  // Per-portal data for 111 (must all go) and for portal 5 (must stay).
  const seedPortal = (p: number) => {
    store.labels.replaceLabels(p, DEAL, CONTACT, [{ associationTypeId: 101, label: 'Influencer', category: UD }], clock.t);
    store.labels.setAssociationLabels(`${p}|0-1:2|0-3:1`, ['Influencer'], clock.t);
    store.metrics.recordPortalError(p, 'x', clock.t);
    store.stamps.setLastStampAt([`${p}|0-3|1`], clock.t);
    store.labels.noteLabelHold(`${p}|0-3|0-1|999`, clock.t, 'x');
    store.labels.setSyncedTypeIds(p, DEAL, CONTACT, [101]);
    store.labels.setSyncedTypeIds(p, DEAL, CONTACT, [101], 'mirror');
    store.changes.saveChanges([{ changeId: `c${p}`, portalId: p, objectTypeId: DEAL, objectId: '1', changeType: 'ADDED', otherObjectType: 'Contact',
      otherRecordId: '2', labelBefore: 'none', labelAfter: 'none', labelsCurrent: 'none', associationCategory: HD, occurredAt: new Date(T0).toISOString() }], clock.t);
    store.entries.replaceParked([...store.entries.loadParked().map((x) => x.entry), { event: ev({ portalId: p }), fileOffset: 'f0', key: `park${p}`, occurredAtMs: T0 }], clock.t);
    store.emitted.saveEmittedActions([{ actionKey: `${p}|a|b|1`, recordKey: `${p}|0-3|1`, portalId: p, changeId: `c${p}`, changeType: 'ADDED',
      otherTypeId: CONTACT, removed: [], added: [], occurredAtMs: T0 }], clock.t);
    store.stamps.deadLetter([{ q: { changeId: `d${p}`, portalId: p, recordKey: `${p}|0-3|1`, update: { portalId: p, objectTypeId: DEAL, objectId: '1',
      occurredAtMs: T0, properties: {} as StampUpdate['properties'] }, notBefore: 0, attempts: 0, lastError: null }, error: 'x' }], clock.t);
    store.stamps.pause(p, clock.t, clock.t + 1e9, 'x');
    store.worker.addLifecycleRetry({ portalId: p, reason: 'x', at: clock.t }, 'x', clock.t + 1e9, clock.t);
    store.db.prepare("INSERT INTO token_revocations (portal_id, token_revoked_at, reason) VALUES (?, ?, 'invalid_grant')").run(p, clock.t);
  };
  seedPortal(111);
  seedPortal(5);
  const count = (p: number) => store.portalFootprint(p);
  // pending_pairs is rewritten by every run (seeded in src/store/store.test.ts instead). Portal 5 watches nothing and
  // has nothing queued, so it stamps nothing; its parked entry is dropped by the run (unwatched), not by the purge.
  const notSeeded = (p: number) => (p === 5 ? ['pending_pairs', 'portal_settings', 'stamp_queue', 'parked_entries'] : ['pending_pairs']);
  const seeded = (p: number) => Object.entries(count(p)).every(([t, v]) => notSeeded(p).includes(t) || v > 0);
  assert.ok(seeded(111), JSON.stringify(count(111)));

  const zeros = Object.fromEntries(Object.keys(count(111)).map((k) => [k, 0]));
  const onlyRetryLeft = { ...zeros, lifecycle_retry: 1, metrics: 1 }; // the pending cleanup + its error for /health

  // Run 1: the subscription delete fails -> offset still moves on, local data purged now, cleanup queued.
  assert.ok(await worker.readOnce());
  assert.equal(store.journal.getOffset(), 'f2');
  assert.deepEqual(count(111), onlyRetryLeft);
  // The customer's token is gone before HubSpot cleanup succeeds; the retry row alone says "cleanup owed".
  assert.equal(portals.isInstalled(111), false, 'marked uninstalled (refresh token wiped) although the subscription delete failed');
  assert.equal(portals.getPortal(111)?.hasToken, false);
  await assert.rejects(tokens.getAccessToken(111), PortalNotInstalledError);
  assert.equal(store.worker.listLifecycleRetries().filter((r) => r.portalId === 111).length, 1);
  assert.deepEqual(portals.getWatchedPairs(111), []);
  assert.equal(store.stamps.queueSize(), 0);
  assert.ok(seeded(5), `portal 5 untouched: ${JSON.stringify(count(5))}`);
  assert.ok(worker.nextWakeAt() <= clock.t + 30_000, 'loop wakes for the retry');

  // Retry 1 (after base back-off) fails again; not due before that.
  await worker.retryLifecycle();
  assert.equal(store.worker.listLifecycleRetries()[0].attempts, 0, 'not due yet');
  clock.t += 30_000;
  await worker.retryLifecycle();
  const row = store.worker.listLifecycleRetries()[0];
  assert.equal(row.attempts, 1);
  assert.equal(row.nextAt, clock.t + 30_000);
  assert.deepEqual(subs.calls, []);

  // Retry 2 works -> subs deleted, token wiped, every row of 111 gone (incl. the retry row), metric series forgotten.
  clock.t += 30_000;
  await worker.retryLifecycle();
  assert.deepEqual(subs.calls, ['deletePortal 111'], 'the retry still deletes the subscriptions (no token needed)');
  assert.equal(portals.isInstalled(111), false);
  assert.deepEqual(store.worker.listLifecycleRetries().filter((r) => r.portalId === 111), [], 'cleanup no longer owed');
  assert.deepEqual(count(111), zeros, 'every per-portal row of 111 is deleted');
  assert.ok(s.forgotten.includes(111));
  await worker.drainQueue();
  clock.t += 120_000;
  await worker.readOnce();
  assert.deepEqual(s.calls, []);
  await assert.rejects(tokens.getAccessToken(111), PortalNotInstalledError);
  assert.deepEqual(count(111), zeros, 'later runs do not re-create rows for the uninstalled portal');

  // Re-read after a crash: idempotent (no second HubSpot call, nothing left behind).
  s.rereadFromStart();
  assert.ok(await worker.readOnce());
  assert.deepEqual(subs.calls, ['deletePortal 111']);
  assert.deepEqual(count(111), zeros);
});

test('uninstall older than the latest install is ignored: no HubSpot call, no purge', async () => {
  const s = setup();
  try {
    s.portals.saveInstall(111, 'rt', [], T0);
    s.portals.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
    await s.lifecycle.onOtherEvent(lifecycleEvent('APP_UNINSTALL', 111, T0 - 1000));
    assert.deepEqual(s.subs.calls, []);
    assert.ok(s.portals.isInstalled(111));
    assert.equal(s.portals.getWatchedPairs(111).length, 1);

    // A pending cleanup is dropped when the portal is reinstalled before the retry runs.
    s.subs.fail = 1;
    await s.lifecycle.handleUninstall(111, 'app uninstalled', T0 + 1000);
    assert.equal(s.store.worker.listLifecycleRetries().length, 1);
    s.portals.saveInstall(111, 'rt2', [], T0 + 2000);
    s.clock.t += 60_000;
    assert.equal(await s.lifecycle.runDue(), 0);
    assert.equal(s.store.worker.listLifecycleRetries().length, 0);
    assert.deepEqual(s.subs.calls, [], 'the new install keeps its subscriptions');
    assert.ok(s.portals.isInstalled(111));
  } finally {
    s.close();
  }
});

test('a reinstall + provisioning while the subscription delete is in flight flags the portal for re-provisioning', async () => {
  const s = setup();
  try {
    const del = s.subs.deletePortalSubscriptions.bind(s.subs);
    let reinstallAt = T0 + 2000;
    // The API process reinstalls and provisions the portal while the worker's delete call is on the wire.
    s.subs.deletePortalSubscriptions = async (p: number) => {
      s.portals.saveInstall(111, 'rt2', [], reinstallAt);
      s.portals.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
      s.portals.markProvisioned(111, null, reinstallAt);
      return del(p);
    };
    s.portals.saveInstall(111, 'rt', [], T0);
    await s.lifecycle.handleUninstall(111, 'app uninstalled', T0 + 1000);
    let p = s.portals.getPortal(111)!;
    assert.ok(s.portals.isInstalled(111));
    assert.equal(p.lastProvisionError, 'subscriptions removed by a concurrent uninstall', 'the API sweep re-provisions it');
    assert.equal(s.store.worker.listLifecycleRetries().length, 0);

    // Same race on the retry path: the new install's settings are not purged either.
    s.subs.deletePortalSubscriptions = async () => { throw new Error('503'); };
    await s.lifecycle.handleUninstall(111, 'app uninstalled', T0 + 3000);
    reinstallAt = T0 + 4000;
    s.subs.deletePortalSubscriptions = async (pid: number) => {
      s.portals.saveInstall(111, 'rt3', [], reinstallAt);
      s.portals.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
      s.portals.markProvisioned(111, null, reinstallAt);
      return del(pid);
    };
    s.clock.t += 60_000;
    assert.equal(await s.lifecycle.runDue(), 1);
    p = s.portals.getPortal(111)!;
    assert.equal(p.lastProvisionError, 'subscriptions removed by a concurrent uninstall');
    assert.equal(s.portals.getWatchedPairs(111).length, 1, 'the new install keeps its settings');
  } finally {
    s.close();
  }
});

test('install event lifts a stamping pause only when the portal was installed after the pause began', async () => {
  const s = setup();
  try {
    s.portals.saveInstall(111, 'rt', [], T0);
    s.store.stamps.pause(111, T0 + 1000, T0 + 1e9, 'token revoked');
    await s.lifecycle.onOtherEvent(lifecycleEvent('APP_INSTALL', 111, T0));
    assert.ok(s.store.stamps.getPause(111), 'install older than the pause: kept');

    s.portals.saveInstall(111, 'rt2', [], T0 + 5000); // reinstall (the API server saved it)
    await s.lifecycle.onOtherEvent(lifecycleEvent('APP_INSTALL', 111, T0 + 5000));
    assert.equal(s.store.stamps.getPause(111), undefined, 'reinstalled after the pause: lifted');
    assert.deepEqual(s.subs.calls, [], 'the worker never provisions');

    // Non-lifecycle events and unknown portals are ignored.
    await s.lifecycle.onOtherEvent({ type: 'crmObject', portalId: 111 });
    await s.lifecycle.onOtherEvent(lifecycleEvent('APP_INSTALL', 999, T0));
  } finally {
    s.close();
  }
});

test('pause expiry (7 days revoked, no reinstall) runs the uninstall routine: subscriptions deleted, data purged', async () => {
  const s = setup([], { refresh: async () => { throw HubSpotError.fromStatus(400, { error: 'invalid_grant' }, 'refresh rejected'); } });
  try {
    s.portals.saveInstall(444, 'rt', [], T0 - DAY);
    s.portals.setWatchedPairs(444, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
    s.clock.t = T0;
    // HubSpot rejects the refresh token (uninstalled on HubSpot's side): the token provider marks the portal revoked.
    await assert.rejects(s.tokens.getAccessToken(444), TokenRevokedError);
    const { queue } = s;
    await queue.drain();
    assert.ok(s.store.stamps.getPause(444), 'paused from the revocation time');
    assert.deepEqual(s.subs.calls, []);
    s.clock.t = T0 + 7 * DAY + 1;
    await queue.drain();
    assert.deepEqual(s.subs.calls, ['deletePortal 444']);
    assert.equal(s.portals.isInstalled(444), false);
    assert.deepEqual(Object.values(s.store.portalFootprint(444)).filter((n) => n > 0), []);
  } finally {
    s.close();
  }
});
