import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../store/db.js';
import { dedupeEntries, entryKey, toAssociationEntries } from './dedupe.js';
import { chunk, toOccurrences } from './emit.js';
import { StoreLabelCache, type LabelFetcher } from './labels.js';
import { DEFAULT_DELAY_CONFIG, delayConfigFromEnv, errorDelayMs, isStale, nextDelayMs } from './poller.js';
import { DEFAULT_PAIRING_CONFIG, pairingConfigFromEnv } from './pairing.js';
import type { NormalizedChange } from './types.js';
import { CONTACT, DEAL, ev, file, REM, T0, UD } from './testutil.js';

// ---------- dedupe ----------

test('entryKey is stable and differs by offset, action and type', () => {
  const e = ev();
  assert.equal(entryKey('f1', e), entryKey('f1', { ...e }));
  assert.notEqual(entryKey('f1', e), entryKey('f2', e));
  assert.notEqual(entryKey('f1', e), entryKey('f1', { ...e, action: REM }));
  assert.notEqual(entryKey('f1', e), entryKey('f1', { ...e, associationTypeId: 99 }));
});

test('toAssociationEntries skips non-association events', () => {
  const f = file('f1', [ev()]);
  f.journalEvents.push({ type: 'crmObject', action: 'CREATE', objectTypeId: '0-1', objectId: 1, portalId: 1 });
  f.journalEvents.push({ type: 'app_lifecycle_event', action: 'APP_INSTALL', portalId: 1 });
  assert.equal(toAssociationEntries([f]).length, 1);
});

test('dedupe drops events already seen in the store and duplicates within the batch', () => {
  const store = new Store(':memory:');
  const [a, b] = toAssociationEntries([file('f1', [ev({ at: 0 }), ev({ at: 1 })])]);
  store.markSeen([a.key], T0);
  const again = toAssociationEntries([file('f1', [ev({ at: 0 }), ev({ at: 1 }), ev({ at: 1 })])]);
  const out = dedupeEntries(again, store);
  assert.deepEqual(out.map((e) => e.key), [b.key]);
});

test('seen_events pruning removes keys older than 4 days', () => {
  const store = new Store(':memory:');
  store.markSeen(['old'], T0 - 5 * 86_400_000);
  store.markSeen(['new'], T0 - 1 * 86_400_000);
  assert.equal(store.pruneSeen(T0), 1);
  assert.deepEqual([...store.filterSeen(['old', 'new'])], ['new']);
});

// ---------- label cache ----------

function fakeFetcher(defs: Record<string, { associationTypeId: number; label: string | null; category: string }[]>) {
  const calls: string[] = [];
  const fn: LabelFetcher = async (p, f, t) => {
    calls.push(`${p}|${f}|${t}`);
    return defs[`${f}>${t}`] ?? [];
  };
  return { fn, calls };
}

test('label cache fetches on miss, then serves from the store', async () => {
  const store = new Store(':memory:');
  const f = fakeFetcher({ [`${DEAL}>${CONTACT}`]: [{ associationTypeId: 101, label: 'Influencer', category: UD }, { associationTypeId: 3, label: null, category: 'HUBSPOT_DEFINED' }] });
  let now = T0;
  const cache = new StoreLabelCache(store, f.fn, { ttlMs: 3_600_000, minRefetchMs: 60_000 }, () => now);
  assert.deepEqual(await cache.get(111, DEAL, CONTACT, 101), { label: 'Influencer', category: UD });
  assert.deepEqual(await cache.get(111, DEAL, CONTACT, 3), { label: null, category: 'HUBSPOT_DEFINED' });
  assert.equal(f.calls.length, 1);

  now += 3_600_000; // TTL expired
  await cache.get(111, DEAL, CONTACT, 101);
  assert.equal(f.calls.length, 2);
});

test('label cache refreshes when a type id is unknown (new label created) but rate-limits refetches', async () => {
  const store = new Store(':memory:');
  const defs = { [`${DEAL}>${CONTACT}`]: [{ associationTypeId: 101, label: 'Influencer', category: UD }] };
  const f = fakeFetcher(defs);
  let now = T0;
  const cache = new StoreLabelCache(store, f.fn, { ttlMs: 86_400_000, minRefetchMs: 60_000 }, () => now);
  await cache.get(111, DEAL, CONTACT, 101);

  defs[`${DEAL}>${CONTACT}`].push({ associationTypeId: 102, label: 'Decision maker', category: UD });
  assert.equal(await cache.get(111, DEAL, CONTACT, 102), undefined, 'within minRefetchMs: no refetch');
  assert.equal(f.calls.length, 1);

  now += 60_000;
  assert.deepEqual(await cache.get(111, DEAL, CONTACT, 102), { label: 'Decision maker', category: UD });
  assert.equal(f.calls.length, 2);
});

test('label cache shares one in-flight fetch between concurrent callers, keyed per portal', async () => {
  const store = new Store(':memory:');
  const f = fakeFetcher({ [`${DEAL}>${CONTACT}`]: [{ associationTypeId: 101, label: 'Influencer', category: UD }] });
  const cache = new StoreLabelCache(store, f.fn);
  await Promise.all([cache.get(111, DEAL, CONTACT, 101), cache.get(111, DEAL, CONTACT, 101)]);
  assert.equal(f.calls.length, 1);
  await cache.get(222, DEAL, CONTACT, 101);
  assert.equal(f.calls.length, 2);
});

// ---------- emit ----------

const change: NormalizedChange = {
  portalId: 111,
  changeType: 'LABEL_CHANGED',
  fromObjectTypeId: DEAL,
  fromObjectId: '1',
  toObjectTypeId: CONTACT,
  toObjectId: '2',
  labelBefore: ['Influencer'],
  labelAfter: ['Decision maker', 'Influencer'],
  labelsCurrent: ['Decision maker', 'Influencer'],
  associationCategory: UD,
  occurredAt: new Date(T0).toISOString(),
  sourceOffsets: ['f1'],
  sourceKeys: ['k1', 'k2'],
};

test('toOccurrences targets the from record by default', () => {
  const [o, ...rest] = toOccurrences(change);
  assert.equal(rest.length, 0);
  assert.equal(o.objectTypeId, DEAL);
  assert.equal(o.objectId, '1');
  assert.deepEqual(o.properties, {
    change_type: 'LABEL_CHANGED',
    other_object_type: CONTACT,
    other_record_id: '2',
    label_before: 'Influencer',
    label_after: 'Decision maker, Influencer',
    labels_current: 'Decision maker, Influencer',
    association_category: UD,
    occurred_at: '2026-10-30T10:00:00.000Z',
  });
});

test('toOccurrences can also target the to record, with "other" swapped and distinct ids', () => {
  const [a, b] = toOccurrences(change, { emitOnToRecord: true });
  assert.equal(b.objectTypeId, CONTACT);
  assert.equal(b.properties.other_object_type, DEAL);
  assert.equal(b.properties.other_record_id, '1');
  assert.notEqual(a.id, b.id);
  assert.equal(a.id, toOccurrences({ ...change, sourceKeys: ['k2', 'k1'] })[0].id, 'id is deterministic');
});

test('empty label lists are omitted', () => {
  const [o] = toOccurrences({ ...change, changeType: 'ADDED', labelBefore: undefined, labelAfter: [], labelsCurrent: [] });
  assert.equal('label_after' in o.properties, false);
  assert.equal('labels_current' in o.properties, false);
});

test('chunk splits into batches of at most 500', () => {
  const items = Array.from({ length: 1201 }, (_, i) => i);
  const batches = chunk(items);
  assert.deepEqual(batches.map((b) => b.length), [500, 500, 201]);
  assert.deepEqual(chunk([]), []);
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
});

// ---------- delays and staleness ----------

test('nextDelayMs: full -> 0 (re-read at once), otherwise a steady 3 s (no idle back-off by default)', () => {
  assert.equal(nextDelayMs({ batchFull: true, eventCount: 100, consecutiveEmpty: 0 }), 0);
  assert.equal(nextDelayMs({ batchFull: false, eventCount: 3, consecutiveEmpty: 0 }), 3_000);
  assert.equal(nextDelayMs({ batchFull: false, eventCount: 0, consecutiveEmpty: 1 }), 3_000);
  assert.equal(nextDelayMs({ batchFull: false, eventCount: 0, consecutiveEmpty: 50 }), 3_000);
});

test('nextDelayMs: optional idle back-off up to idleMaxMs; events reset to pollMs', () => {
  const c = { ...DEFAULT_DELAY_CONFIG, pollMs: 2_000, idleMaxMs: 10_000 };
  assert.deepEqual([1, 2, 3, 4, 9].map((n) => nextDelayMs({ batchFull: false, eventCount: 0, consecutiveEmpty: n }, c)), [2_000, 4_000, 8_000, 10_000, 10_000]);
  assert.equal(nextDelayMs({ batchFull: false, eventCount: 1, consecutiveEmpty: 0 }, c), 2_000);
  assert.equal(nextDelayMs({ batchFull: true, eventCount: 1, consecutiveEmpty: 0 }, c), 0);
});

test('errorDelayMs: separate exponential back-off, capped at errorMaxMs', () => {
  assert.deepEqual([1, 2, 3].map((n) => errorDelayMs(n)), [5_000, 10_000, 20_000]);
  assert.equal(errorDelayMs(20), 120_000);
  assert.equal(errorDelayMs(1000), 120_000, 'no overflow');
  assert.equal(errorDelayMs(3, { ...DEFAULT_DELAY_CONFIG, errorBaseMs: 1_000, errorMaxMs: 3_000 }), 3_000);
});

test('delayConfigFromEnv / pairingConfigFromEnv', () => {
  assert.deepEqual(delayConfigFromEnv({}), DEFAULT_DELAY_CONFIG);
  const d = delayConfigFromEnv({ JOURNAL_POLL_MS: '5000', JOURNAL_IDLE_MAX_MS: '1000', JOURNAL_ERROR_MAX_MS: '60000' });
  assert.equal(d.pollMs, 5_000);
  assert.equal(d.idleMaxMs, 5_000, 'idle max never below the poll interval');
  assert.equal(d.errorMaxMs, 60_000);
  assert.throws(() => delayConfigFromEnv({ JOURNAL_POLL_MS: 'abc' }));
  assert.deepEqual(pairingConfigFromEnv({}), DEFAULT_PAIRING_CONFIG);
  const p = pairingConfigFromEnv({ PAIRING_WINDOW_MS: '1500', PAIRING_PUBLISH_SLACK_MS: '6000', PAIRING_MAX_HOLD_MS: '30000' });
  assert.deepEqual([p.windowMs, p.publishDelaySlackMs, p.maxHoldMs], [1_500, 6_000, 30_000]);
});

test('isStale after 1h without a successful read', () => {
  const store = new Store(':memory:');
  store.setLastSuccessfulReadAt(T0);
  assert.equal(isStale(store, T0 + 59 * 60_000), false);
  assert.equal(isStale(store, T0 + 60 * 60_000), true);
});

test('store: watched pairs and offsets round-trip', () => {
  const store = new Store(':memory:');
  assert.equal(store.getOffset(), null);
  store.setOffset('abc');
  assert.equal(store.getOffset(), 'abc');
  store.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
  store.setWatchedPairs(111, [{ objectTypeId: '2-1', associatedObjectTypeId: CONTACT }]);
  assert.deepEqual(store.getWatchedPairs(111), [{ objectTypeId: '2-1', associatedObjectTypeId: CONTACT }]);
  assert.deepEqual(store.getWatchedPairs(222), []);
});
