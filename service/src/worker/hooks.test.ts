// Wiring tests: label-option sync hook (and that stamped values always match the synced options),
// lifecycle routing through the worker, and the worker's token provider. No HubSpot calls (fetch is stubbed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LabelCache } from '../core/labels.js';
import { splitValues } from '../core/label-options.js';
import type { JournalReadResult } from '../core/poller.js';
import { resolveChanges } from '../core/resolve.js';
import { toChangeRecords, toStampUpdate, type StampUpdate } from '../core/stamp.js';
import type { JournalFile, PairedChange } from '../core/types.js';
import { ADD, CONTACT, DEAL, ev, file, SUB, T0 } from '../core/testutil.js';
import { syncLabelOptions, type LabelSyncReport } from '../hubspot/properties.js';
import type { Subscription, SubscriptionRequest } from '../hubspot/journal.js';
import { Installer } from '../install/installer.js';
import type { SubscriptionApi } from '../install/subscriptions.js';
import { PortalNotInstalledError, PortalTokenProvider } from '../install/token-provider.js';
import { HttpError } from '../lib/http.js';
import { Store } from '../store/db.js';
import { PortalStore } from '../store/portals.js';
import { makeLabelOptionSync, makeLifecycleHook } from './hooks.js';
import { StaleAlerter } from './health.js';
import { StampQueue } from './stamp-queue.js';
import { StoreLabelCache } from '../core/labels.js';
import { Worker } from './main.js';
import { NoPortalTokenError, TokenRevokedError, workerTokenProvider, type TokenProvider } from './tokens.js';

const quiet = () => {};
const UD = 'USER_DEFINED', HD = 'HUBSPOT_DEFINED';

// ---------------------------------------------------------------- label options vs stamped values

/** Label definitions per direction, with awkward names on purpose. */
const DEFS: Record<string, { typeId: number; label: string | null; category: string }[]> = {
  [`${DEAL}>${CONTACT}`]: [
    { typeId: 3, label: null, category: HD },
    { typeId: 5, label: 'Primary', category: HD }, // named HUBSPOT_DEFINED label
    { typeId: 101, label: 'Decision maker', category: UD },
    { typeId: 102, label: 'Billing; contact', category: UD }, // ";" would split a multi-checkbox value
    { typeId: 103, label: '  Influencer   lead ', category: UD }, // odd spacing
  ],
  [`${CONTACT}>${DEAL}`]: [
    { typeId: 4, label: null, category: HD },
    { typeId: 201, label: 'Decision maker', category: UD },
    { typeId: 202, label: 'Billing; contact', category: UD },
    { typeId: 203, label: 'Influencer lead', category: UD },
  ],
  [`${SUB}>${CONTACT}`]: [
    { typeId: 40, label: null, category: UD }, // custom pairs use USER_DEFINED for the unlabeled default
    { typeId: 41, label: 'Owner', category: UD },
  ],
  [`${CONTACT}>${SUB}`]: [
    { typeId: 42, label: null, category: UD },
    { typeId: 43, label: 'Owner', category: UD },
  ],
};

/** Stub fetch: label definitions, property reads (label props exist with only the fixed options), PATCH capture. */
function stubHubSpot() {
  const patched = new Map<string, Set<string>>(); // objectType -> option values of changecatch_labels_current
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    let m = url.pathname.match(/^\/crm\/associations\/2026-09\/([^/]+)\/([^/]+)\/labels$/);
    if (m) return json({ results: (DEFS[`${decodeURIComponent(m[1])}>${decodeURIComponent(m[2])}`] ?? []) });
    if (url.pathname === '/crm-object-schemas/2026-09/schemas') return json({ results: [{ objectTypeId: SUB, labels: { singular: 'Subscription' } }] });
    m = url.pathname.match(/^\/crm\/properties\/2026-09\/([^/]+)(?:\/([^/]+))?$/);
    if (m && (init?.method ?? 'GET') === 'GET') {
      const fixed = [
        { label: '(none)', value: '(none)', displayOrder: 0, hidden: false },
        { label: '(unknown)', value: '(unknown)', displayOrder: 1, hidden: false },
      ];
      return json({
        results: ['changecatch_label_before', 'changecatch_label_after', 'changecatch_labels_current'].map((name) => ({
          name, type: 'enumeration', fieldType: 'checkbox', groupName: 'changecatch', options: fixed,
        })),
      });
    }
    if (m && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      if (m[2] === 'changecatch_labels_current') patched.set(decodeURIComponent(m[1]), new Set(body.options.map((o: { value: string }) => o.value)));
      return json({});
    }
    return new Response('unexpected ' + url.pathname, { status: 500 });
  }) as typeof fetch;
  return { patched, restore: () => (globalThis.fetch = real) };
}

const fakeLabels: LabelCache = {
  async get(_p, from, to, typeId) {
    const d = DEFS[`${from}>${to}`]?.find((x) => x.typeId === typeId);
    return d && { label: d.label, category: d.category };
  },
};

function paired(from: [string, string], to: [string, string], changeType: PairedChange['changeType'], added: number[], removed: number[] = []): PairedChange {
  const ref = (associationTypeId: number) => ({ fromObjectTypeId: from[0], toObjectTypeId: to[0], associationTypeId, associationCategory: UD });
  return {
    portalId: 111, changeType, fromObjectTypeId: from[0], fromObjectId: from[1], toObjectTypeId: to[0], toObjectId: to[1],
    added: added.map(ref), removed: removed.map(ref), associationCategory: UD,
    occurredAt: new Date(T0).toISOString(), sourceKeys: [`k${from[1]}${changeType}${added}${removed}`], sourceOffsets: ['f'],
  };
}

test('label options: every stamped label value (both records, mirror on) is an option synced by syncLabelOptions', async () => {
  const hs = stubHubSpot();
  try {
    const pairs = [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }, { objectTypeId: SUB, associatedObjectTypeId: CONTACT }];
    for (const t of [DEAL, CONTACT, SUB]) {
      const r = await syncLabelOptions('tok', 111, t, pairs);
      assert.equal(r.error, undefined);
      assert.ok(r.properties.every((p) => p.status !== 'error'), JSON.stringify(r.properties));
    }
    const changes = [
      paired([DEAL, '1'], [CONTACT, '2'], 'ADDED', [3, 5, 101, 102, 103]),
      paired([DEAL, '1'], [CONTACT, '2'], 'LABEL_CHANGED', [101], [102]),
      paired([DEAL, '1'], [CONTACT, '2'], 'REMOVED', [], [3, 101]),
      paired([DEAL, '7'], [CONTACT, '8'], 'LABEL_CHANGED', [999]), // unknown type id -> "(unknown)"
      paired([SUB, '5'], [CONTACT, '6'], 'ADDED', [40, 41]),
      paired([SUB, '5'], [CONTACT, '6'], 'LABEL_CHANGED', [], [41]),
    ];
    const state = new Map<string, string[]>();
    const { changes: normalized } = await resolveChanges(changes, fakeLabels, { getAssociationLabels: (k) => state.get(k) });
    const updates: StampUpdate[] = normalized.flatMap((c) => toChangeRecords(c, { mirrorOnOtherRecord: true })).map(toStampUpdate);
    assert.equal(updates.length, changes.length * 2);
    let checked = 0;
    for (const u of updates) {
      const options = hs.patched.get(u.objectTypeId);
      assert.ok(options, `options synced on ${u.objectTypeId}`);
      for (const prop of ['changecatch_label_before', 'changecatch_label_after', 'changecatch_labels_current'] as const) {
        const raw = u.properties[prop] ?? '';
        assert.ok(!/;\s|\s;/.test(raw), `no spaces around ";" in ${raw}`);
        for (const v of splitValues(raw)) {
          assert.ok(options.has(v), `${u.objectTypeId} ${prop}: "${v}" is not an option (${[...options].join(' | ')})`);
          checked++;
        }
      }
    }
    assert.ok(checked > 20);
    // Spot checks on the exact format.
    assert.ok(hs.patched.get(DEAL)!.has('0-1:Billing, contact'));
    assert.ok(hs.patched.get(CONTACT)!.has('0-3:Influencer lead'));
    assert.ok(hs.patched.get(CONTACT)!.has(`${SUB}:Owner`));
  } finally {
    hs.restore();
  }
});

// ---------------------------------------------------------------- the onUnknownLabel hook

const okReport = (objectTypeId: string, extra: Partial<LabelSyncReport> = {}): LabelSyncReport => ({
  portalId: 111, objectTypeId, otherObjectTypeIds: [], options: [], properties: [{ name: 'changecatch_labels_current', status: 'updated', added: ['x'] }],
  labelErrors: [], ...extra,
});

test('onUnknownLabel hook: syncs the stamped side (and the other side when mirroring); failures throw', async () => {
  const tokens: TokenProvider = { getAccessToken: async (p) => { if (p !== 111) throw new NoPortalTokenError(p); return 'tok'; } };
  const calls: { t: string; pairs: string[] }[] = [];
  let respond = (t: string): LabelSyncReport => okReport(t);
  const sync = async (_tok: string, _p: number, t: string, pairs: { objectTypeId: string; associatedObjectTypeId: string }[]) => {
    calls.push({ t, pairs: pairs.map((p) => `${p.objectTypeId}:${p.associatedObjectTypeId}`) });
    return respond(t);
  };
  const watched = () => [{ objectTypeId: DEAL, associatedObjectTypeId: '0-2' }];

  await makeLabelOptionSync({ tokens, watchedPairs: watched, mirror: false, sync, log: quiet })(111, DEAL, CONTACT);
  assert.deepEqual(calls.map((c) => c.t), [DEAL]);
  assert.ok(calls[0].pairs.includes(`${DEAL}:${CONTACT}`), 'the triggering pair is always included');

  calls.length = 0;
  const mirrored = makeLabelOptionSync({ tokens, watchedPairs: watched, mirror: true, sync, log: quiet });
  await mirrored(111, DEAL, CONTACT);
  assert.deepEqual(calls.map((c) => c.t), [DEAL, CONTACT]);

  respond = (t) => okReport(t, { properties: [{ name: 'changecatch_label_after', status: 'error', added: [], detail: '403' }] });
  await assert.rejects(async () => mirrored(111, DEAL, CONTACT), /changecatch_label_after: 403/);

  // A label read failure on THIS pair holds; on another pair it doesn't.
  respond = (t) => okReport(t, { labelErrors: [{ from: CONTACT, to: DEAL, error: '502' }] });
  await assert.rejects(async () => mirrored(111, DEAL, CONTACT), /labels 0-1->0-3: 502/);
  respond = (t) => okReport(t, { labelErrors: [{ from: DEAL, to: '0-2', error: '502' }] });
  await mirrored(111, DEAL, CONTACT);

  // Uninstalled portal: nothing to sync, nothing to hold.
  calls.length = 0;
  await mirrored(999, DEAL, CONTACT);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- lifecycle routing through the worker

class FakeSubs implements SubscriptionApi {
  calls: string[] = [];
  fail = 0;
  async listSubscriptions(): Promise<Subscription[]> { return []; }
  async createSubscription(b: SubscriptionRequest): Promise<Subscription> {
    return { id: 1, appId: 1, subscriptionType: b.subscriptionType, actions: [], createdAt: '', updatedAt: '' } as unknown as Subscription;
  }
  async deleteSubscription() {}
  async deletePortalSubscriptions(portalId: number) {
    if (this.fail-- > 0) throw new HttpError(503, {}, 'subs down');
    this.calls.push(`deletePortal ${portalId}`);
  }
}

test('lifecycle: APP_UNINSTALL from the journal is handled before the offset is saved; the portal stops stamping', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-hooks-'));
  const path = join(dir, 'db.sqlite');
  const store = new Store(path);
  const portals = new PortalStore({ path, key: randomBytes(32) });
  try {
    portals.saveInstall(111, 'rt-111', ['crm.objects.deals.write'], T0 - 1000);
    portals.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
    const real = new PortalTokenProvider({ store: portals, refresh: async () => ({ token_type: 'bearer', access_token: 'at', expires_in: 1800 }) });
    const subs = new FakeSubs();
    subs.fail = 1;
    const installer = new Installer({ portals, tokens: real, subscriptions: subs, log: quiet });
    const tokens = workerTokenProvider({ portals, real });
    const clock = { t: T0 + 60_000 };
    const stamps: string[] = [];
    const queue = new StampQueue({
      store, tokens, now: () => clock.t, log: quiet, defaultSpacingMs: 3000,
      batchUpdate: async (_t, _type, inputs) => (stamps.push(...inputs.map((i) => i.id)), { status: 'COMPLETE', results: inputs.map((i) => ({ id: i.id })) }),
    });
    // A stamp already waiting in the queue for portal 111 (e.g. spacing slot).
    store.enqueueStamps([{ changeId: 'old', recordKey: '111|0-3|1', notBefore: clock.t + 10_000,
      update: { portalId: 111, objectTypeId: DEAL, objectId: '1', occurredAtMs: T0, properties: { changecatch_last_change_id: 'old' } as StampUpdate['properties'] } }], clock.t);

    // Per-portal data for 111 (must all go) and for portal 5 (must stay).
    const seedPortal = (p: number) => {
      store.replaceLabels(p, DEAL, CONTACT, [{ associationTypeId: 101, label: 'Influencer', category: UD }], clock.t);
      store.setAssociationLabels(`${p}|0-1:2|0-3:1`, ['Influencer'], clock.t);
      store.addMetrics(p, { events: 1 }, clock.t);
      store.setLastStampAt([`${p}|0-3|1`], clock.t);
      store.noteLabelHold(`${p}|0-3|0-1|999`, clock.t, 'x');
      store.setState(`labels_synced:${p}|0-3|0-1`, '[101]');
      store.setState(`labels_synced:mirror:${p}|0-3|0-1`, '[101]');
      store.saveChanges([{ changeId: `c${p}`, portalId: p, objectTypeId: DEAL, objectId: '1', changeType: 'ADDED', otherObjectType: 'Contact',
        otherRecordId: '2', labelBefore: '(none)', labelAfter: '(none)', labelsCurrent: '(none)', associationCategory: HD, occurredAt: new Date(T0).toISOString() }], clock.t);
      store.replaceParked([...store.loadParked().map((x) => x.entry), { event: ev({ portalId: p }), fileOffset: 'f0', key: `park${p}`, occurredAtMs: T0 }], clock.t);
    };
    seedPortal(111);
    seedPortal(5);
    const count = (p: number) => {
      const n = (sql: string, ...a: (string | number)[]) => Number((store.db.prepare(sql).get(...a) as { n: number }).n);
      return {
        label_cache: n('SELECT COUNT(*) AS n FROM label_cache WHERE portal_id = ?', p),
        label_cache_fetches: n('SELECT COUNT(*) AS n FROM label_cache_fetches WHERE portal_id = ?', p),
        association_labels: n('SELECT COUNT(*) AS n FROM association_labels WHERE pair_key LIKE ?', `${p}|%`),
        metrics: n('SELECT COUNT(*) AS n FROM metrics WHERE portal_id = ?', p),
        stamp_last: n('SELECT COUNT(*) AS n FROM stamp_last WHERE record_key LIKE ?', `${p}|%`),
        stamp_queue: n('SELECT COUNT(*) AS n FROM stamp_queue WHERE portal_id = ?', p),
        label_holds: n('SELECT COUNT(*) AS n FROM label_holds WHERE hold_key LIKE ?', `${p}|%`),
        synced: n("SELECT COUNT(*) AS n FROM worker_state WHERE key LIKE ? OR key LIKE ?", `labels_synced:${p}|%`, `labels_synced:%:${p}|%`),
        change_log: n('SELECT COUNT(*) AS n FROM change_log WHERE portal_id = ?', p),
        parked: n('SELECT COUNT(*) AS n FROM parked_entries WHERE portal_id = ?', p),
        settings: n('SELECT COUNT(*) AS n FROM portal_settings WHERE portal_id = ?', p),
      };
    };
    assert.ok(Object.values(count(111)).every((v) => v > 0), JSON.stringify(count(111)));

    const uninstall = { type: 'app_lifecycle_event', action: 'APP_UNINSTALL', eventTypeId: '4-1916193', portalId: 111, occurredAt: new Date(T0).toISOString(), properties: {} };
    const files: JournalFile[] = [
      { offset: 'f1', journalEvents: [uninstall as never, ev({ action: ADD, typeId: 3, at: 1000 })] },
      file('f2', [ev({ portalId: 5, at: 40_000 })]),
    ];
    const readJournal = async (after: string | null): Promise<JournalReadResult> => {
      const start = after === null ? 0 : files.findIndex((f) => f.offset === after) + 1;
      const batch = files.slice(start);
      return { files: batch, nextOffset: batch.at(-1)?.offset ?? null, full: false };
    };
    const outcomes: string[] = [];
    const hook = makeLifecycleHook({ installer, portals, store, log: quiet });
    const worker = new Worker({
      store, readJournal, queue, now: () => clock.t, log: quiet, alerter: new StaleAlerter(1e9, quiet),
      labels: new StoreLabelCache(store, async () => [{ associationTypeId: 3, label: null, category: HD }]),
      onOtherEvent: async (e, off) => { const o = await hook(e, off); if (o) outcomes.push(o); },
    });

    // 1st run: the subscription delete fails -> offset NOT saved, portal still installed.
    assert.equal(await worker.readOnce(), null);
    assert.equal(store.getOffset(), null);
    assert.ok(portals.isInstalled(111));

    // 2nd run: uninstall works -> subs deleted, token wiped, pairs wiped, queue emptied, offset saved, nothing stamped.
    clock.t += 10_000;
    assert.ok(await worker.readOnce());
    assert.deepEqual(outcomes, ['uninstalled']);
    assert.deepEqual(subs.calls, ['deletePortal 111']);
    assert.equal(store.getOffset(), 'f2');
    assert.equal(portals.isInstalled(111), false);
    assert.deepEqual(store.getWatchedPairs(111), [], 'worker sees the wiped pairs (same DB)');
    assert.equal(store.queueSize(), 0);
    const zeros = Object.fromEntries(Object.keys(count(111)).map((k) => [k, 0]));
    assert.deepEqual(count(111), zeros, 'every per-portal row of 111 is deleted');
    const five = count(5);
    assert.ok(five.label_cache && five.association_labels && five.metrics && five.change_log && five.synced === 2, 'portal 5 untouched');
    await worker.drainQueue();
    clock.t += 120_000;
    await worker.readOnce();
    assert.deepEqual(stamps, []);
    await assert.rejects(tokens.getAccessToken(111), NoPortalTokenError);
    assert.deepEqual(count(111), zeros, 'later runs do not re-create rows for the uninstalled portal');

    // Re-read after a crash: idempotent.
    store.db.exec('DELETE FROM journal_offset');
    assert.ok(await worker.readOnce());
    assert.deepEqual(outcomes, ['uninstalled', 'ignored-already-uninstalled']);
  } finally {
    store.close();
    portals.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- worker token provider

test('worker tokens: stored token first; never-installed or uninstalled portals have no token; permanent errors', async () => {
  const rows = new Map<number, { hasToken: boolean; uninstalledAt: number | null }>([
    [111, { hasToken: true, uninstalledAt: null }],
    [222, { hasToken: false, uninstalledAt: 5 }],
  ]);
  const portals = { getPortal: (p: number) => rows.get(p) as never };
  const forgot: number[] = [];
  let realError: unknown = null;
  const real = {
    getAccessToken: async (p: number) => { if (realError) throw realError; return `stored-${p}`; },
    forget: (p: number) => { forgot.push(p); },
  };
  const t = workerTokenProvider({ portals, real });

  assert.equal(await t.getAccessToken(111), 'stored-111');
  assert.equal(await t.getAccessToken(111, { forceRefresh: true }), 'stored-111');
  assert.deepEqual(forgot, [111]);
  await assert.rejects(t.getAccessToken(333), NoPortalTokenError, 'never installed -> no token (no .env fallback)');
  await assert.rejects(t.getAccessToken(222), /app uninstalled/);

  realError = new PortalNotInstalledError(111);
  await assert.rejects(t.getAccessToken(111), NoPortalTokenError);
  realError = new HttpError(400, { status: 'BAD_REFRESH_TOKEN' }, 'bad');
  await assert.rejects(t.getAccessToken(111), TokenRevokedError, 'revoked = pause, not drop');
  realError = new HttpError(400, { status: 'BAD_CLIENT_ID' }, 'bad client');
  await assert.rejects(t.getAccessToken(111), (e) => e instanceof HttpError, 'config errors are not "uninstalled"');
  realError = new HttpError(503, {}, 'down');
  await assert.rejects(t.getAccessToken(111), (e) => e instanceof HttpError);
});
