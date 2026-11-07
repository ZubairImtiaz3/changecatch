// Wiring tests: label-option sync hook (and that stamped values always match the synced options),
// No HubSpot calls (fetch is stubbed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitValues } from '../core/label-options.js';
import { resolveChanges } from '../core/resolve.js';
import { toChangeRecords, toStampUpdate, type StampUpdate } from '../core/stamp.js';
import { CONTACT, DEAL, HD, SUB, UD } from '../../test/fixtures/journal.js';
import { defsLabelCache, pairedChange, type Defs } from '../../test/fixtures/labels.js';
import { memoryLogger } from '../../test/fixtures/log.js';
import { createLabelOptionSync, type LabelSyncReport } from '../hubspot/properties.js';
import { PortalNotInstalledError, type TokenProvider } from '../hubspot/portal-tokens.js';
import { makeLabelOptionSync } from './hooks.js';

const quiet = memoryLogger().log;

// ---------------------------------------------------------------- label options vs stamped values

/** Label definitions per direction, with awkward names on purpose. */
const DEFS: Defs = {
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
  const typePatched = new Map<string, Set<string>>(); // objectType -> option values of changecatch_other_object_type
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    let m = url.pathname.match(/^\/crm\/associations\/2026-09\/([^/]+)\/([^/]+)\/labels$/);
    if (m) return json({ results: (DEFS[`${decodeURIComponent(m[1])}>${decodeURIComponent(m[2])}`] ?? []) });
    if (url.pathname === '/crm-object-schemas/2026-09/schemas') return json({ results: [{ objectTypeId: SUB, labels: { singular: 'Subscription' } }] });
    const batchRead = /^\/crm\/properties\/2026-09\/[^/]+\/batch\/read$/.test(url.pathname) && init?.method === 'POST';
    m = url.pathname.match(/^\/crm\/properties\/2026-09\/([^/]+)(?:\/([^/]+))?$/);
    if (batchRead || (m && (init?.method ?? 'GET') === 'GET')) {
      const fixed = [
        { label: '(none)', value: 'none', displayOrder: 0, hidden: false },
        { label: '(unknown)', value: 'unknown', displayOrder: 1, hidden: false },
      ];
      // Every synced dropdown exists already (as after install), with only its starting options.
      return json({
        results: [
          ...['changecatch_labels_before', 'changecatch_labels_after', 'changecatch_labels_current'].map((name) => ({
            name, type: 'enumeration', fieldType: 'checkbox', groupName: 'changecatch', options: fixed,
          })),
          { name: 'changecatch_change_type', type: 'enumeration', fieldType: 'select', groupName: 'changecatch', options: [] },
          { name: 'changecatch_other_object_type', type: 'enumeration', fieldType: 'select', groupName: 'changecatch', options: [] },
        ],
      });
    }
    if (m && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      const values = new Set<string>(body.options.map((o: { value: string }) => o.value));
      if (m[2] === 'changecatch_labels_current') patched.set(decodeURIComponent(m[1]), values);
      if (m[2] === 'changecatch_other_object_type') typePatched.set(decodeURIComponent(m[1]), values);
      return json({});
    }
    return new Response('unexpected ' + url.pathname, { status: 500 });
  }) as typeof fetch;
  return { patched, typePatched, restore: () => (globalThis.fetch = real) };
}

const fakeLabels = defsLabelCache(DEFS);

test('label options: every stamped label value (both records, mirror on) is an option synced by the option sync', async () => {
  const hs = stubHubSpot();
  const syncLabelOptions = createLabelOptionSync();
  try {
    const pairs = [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }, { objectTypeId: SUB, associatedObjectTypeId: CONTACT }];
    for (const t of [DEAL, CONTACT, SUB]) {
      const r = await syncLabelOptions({ portalId: 111, token: 'tok' }, t, pairs);
      assert.equal(r.error, undefined);
      assert.ok(r.properties.every((p) => p.status !== 'error'), JSON.stringify(r.properties));
    }
    const changes = [
      pairedChange('ADDED', [3, 5, 101, 102, 103], [], [DEAL, '1'], [CONTACT, '2']),
      pairedChange('LABEL_CHANGED', [101], [102], [DEAL, '1'], [CONTACT, '2']),
      pairedChange('REMOVED', [], [3, 101], [DEAL, '1'], [CONTACT, '2']),
      pairedChange('LABEL_CHANGED', [999], [], [DEAL, '7'], [CONTACT, '8']), // unknown type id -> "(unknown)"
      pairedChange('ADDED', [40, 41], [], [SUB, '5'], [CONTACT, '6']),
      pairedChange('LABEL_CHANGED', [], [41], [SUB, '5'], [CONTACT, '6']),
    ];
    const state = new Map<string, string[]>();
    const { changes: normalized } = await resolveChanges(changes, fakeLabels, { getAssociationLabels: (k) => state.get(k) }, true);
    const updates: StampUpdate[] = normalized.flatMap((c) => toChangeRecords(c, true)).map(toStampUpdate);
    assert.equal(updates.length, changes.length * 2);
    let checked = 0;
    for (const u of updates) {
      const options = hs.patched.get(u.objectTypeId);
      assert.ok(options, `options synced on ${u.objectTypeId}`);
      assert.ok(hs.typePatched.get(u.objectTypeId)?.has(u.properties.changecatch_other_object_type!), `other object type is an option on ${u.objectTypeId}`);
      for (const prop of ['changecatch_labels_before', 'changecatch_labels_after', 'changecatch_labels_current'] as const) {
        const raw = u.properties[prop] ?? '';
        assert.ok(!/;\s|\s;/.test(raw), `no spaces around ";" in ${raw}`);
        for (const v of splitValues(raw)) {
          assert.ok(options.has(v), `${u.objectTypeId} ${prop}: "${v}" is not an option (${[...options].join(' | ')})`);
          checked++;
        }
      }
    }
    assert.ok(checked > 20);
    // Spot checks on the exact format: `${otherTypeId}:${typeId}`, own direction only.
    assert.ok(hs.patched.get(DEAL)!.has('0-1:102'), 'deal -> contact "Billing; contact"');
    assert.ok(hs.patched.get(CONTACT)!.has('0-3:203'), 'contact -> deal "Influencer lead" (the contact\'s own direction)');
    assert.ok(hs.patched.get(CONTACT)!.has(`${SUB}:43`), 'contact -> subscription "Owner"');
    assert.ok(!hs.patched.get(CONTACT)!.has('0-3:103'), 'the other direction\'s id is never an option');
    // The mirror stamp on the contact carries the contact -> deal ids, translated by name.
    const mirror = updates.find((u) => u.objectTypeId === CONTACT && u.properties.changecatch_change_type === 'ADDED' && u.properties.changecatch_other_object_type === DEAL)!;
    assert.equal(mirror.properties.changecatch_labels_current, '0-3:201;0-3:202;0-3:203;unknown', 'Primary (5) has no contact -> deal twin: unknown');
    assert.deepEqual([...hs.typePatched.get(DEAL)!].sort(), ['0-1', '0-2', '0-3', '0-5'].sort());
    assert.ok(hs.typePatched.get(CONTACT)!.has(SUB), 'custom other type added by the sync');
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
  const tokens: Pick<TokenProvider, 'getAccessToken'> = { getAccessToken: async (p) => { if (p !== 111) throw new PortalNotInstalledError(p); return 'tok'; } };
  const calls: { t: string; pairs: string[] }[] = [];
  let respond = (t: string): LabelSyncReport => okReport(t);
  const sync = async (_auth: unknown, t: string, pairs: { objectTypeId: string; associatedObjectTypeId: string }[]) => {
    calls.push({ t, pairs: pairs.map((p) => `${p.objectTypeId}:${p.associatedObjectTypeId}`) });
    return respond(t);
  };
  const watched = () => [{ objectTypeId: DEAL, associatedObjectTypeId: '0-2' }];

  assert.equal(await makeLabelOptionSync({ tokens, watchedPairs: watched, mirror: false, sync, log: quiet }).onUnknownLabel(111, DEAL, CONTACT), true);
  assert.deepEqual(calls.map((c) => c.t), [DEAL]);
  assert.ok(calls[0].pairs.includes(`${DEAL}:${CONTACT}`), 'the triggering pair is always included');

  calls.length = 0;
  const hook = makeLabelOptionSync({ tokens, watchedPairs: watched, mirror: true, sync, log: quiet });
  const mirrored = hook.onUnknownLabel;
  await mirrored(111, DEAL, CONTACT);
  assert.deepEqual(calls.map((c) => c.t), [DEAL, CONTACT]);

  respond = (t) => okReport(t, { properties: [{ name: 'changecatch_labels_after', status: 'error', added: [], detail: '403' }], failure: 'changecatch_labels_after: 403' });
  await assert.rejects(async () => mirrored(111, DEAL, CONTACT), /changecatch_labels_after: 403/);
  // A property of the wrong type (exists-mismatch) is not usable either: not synced -> held.
  respond = (t) => okReport(t, { properties: [{ name: 'changecatch_labels_current', status: 'exists-mismatch', added: [], detail: 'existing string/text' }], failure: 'changecatch_labels_current: existing string/text' });
  await assert.rejects(async () => mirrored(111, DEAL, CONTACT), /changecatch_labels_current: existing string\/text/);
  respond = (t) => okReport(t, { properties: [{ name: 'changecatch_labels_after', status: 'error', added: [], detail: '403' }], failure: 'changecatch_labels_after: 403' });
  await assert.rejects(async () => mirrored(111, DEAL, CONTACT), /changecatch_labels_after: 403/);

  // A label read failure on THIS pair holds; on another pair it doesn't.
  respond = (t) => okReport(t, { labelErrors: [{ from: CONTACT, to: DEAL, error: '502' }] });
  await assert.rejects(async () => mirrored(111, DEAL, CONTACT), /labels 0-1->0-3: 502/);
  respond = (t) => okReport(t, { labelErrors: [{ from: DEAL, to: '0-2', error: '502' }] });
  await mirrored(111, DEAL, CONTACT);

  // resync (a stamp refused for a value that is not an option): one object type, every watched pair, any label error.
  calls.length = 0;
  respond = (t) => okReport(t);
  assert.equal(await hook.resync(111, CONTACT), true);
  assert.deepEqual(calls, [{ t: CONTACT, pairs: [`${DEAL}:0-2`] }]);
  respond = (t) => okReport(t, { labelErrors: [{ from: DEAL, to: '0-2', error: '502' }] });
  await assert.rejects(async () => hook.resync(111, DEAL), /labels 0-3->0-2: 502/);

  // Uninstalled portal: nothing to sync, nothing to hold, reported as "not synced" (the guard then records nothing).
  calls.length = 0;
  assert.equal(await mirrored(999, DEAL, CONTACT), false);
  assert.equal(await hook.resync(999, DEAL), false);
  assert.equal(calls.length, 0);
});

test("option sync: a running sync is reused only when it covers the caller's other types; otherwise ours runs after it", async () => {
  // Counts label reads per other type and holds the first property read until released.
  const real = globalThis.fetch;
  const labelReads: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reads = 0;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const m = url.pathname.match(/^\/crm\/associations\/2026-09\/([^/]+)\/([^/]+)\/labels$/);
    if (m) {
      labelReads.push(decodeURIComponent(m[2]));
      return json({ results: [] });
    }
    if (url.pathname.endsWith('/batch/read') && init?.method === 'POST') {
      if (reads++ === 0) await gate;
      return json({ results: [] });
    }
    return json({}); // property creates
  }) as typeof fetch;
  try {
    const syncLabelOptions = createLabelOptionSync();
    const auth = { portalId: 111, token: 'tok' };
    const first = syncLabelOptions(auth, DEAL, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
    const same = syncLabelOptions(auth, DEAL, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
    const wider = syncLabelOptions(auth, DEAL, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }, { objectTypeId: DEAL, associatedObjectTypeId: '0-2' }]);
    assert.equal(same, first, 'covered: shares the running sync');
    assert.notEqual(wider, first);
    release();
    const [a, , c] = await Promise.all([first, same, wider]);
    assert.deepEqual(a.otherObjectTypeIds, [CONTACT]);
    assert.deepEqual(c.otherObjectTypeIds.sort(), [CONTACT, '0-2'].sort(), 'the wider call got its own run, with the new pair');
    assert.ok(labelReads.includes('0-2'), "the new pair's labels were read");
  } finally {
    globalThis.fetch = real;
  }
});
