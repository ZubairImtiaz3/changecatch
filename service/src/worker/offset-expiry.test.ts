// Expired journal offsets that come back as EMPTY reads (204), not 404 (seen live 2026-11-05).
// The reader must notice (offset older than JOURNAL_OFFSET_MAX_AGE_MS -> check earliest/latest), recover from
// earliest with an alert + data_loss{reason="offset_expired"}, and /health must say "degraded" meanwhile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../store/db.js';
import { batchOf, fakeJournalApi, fetchEntry, uuid7 } from '../../test/fixtures/journal.js';
import { ChangeCatchMetrics } from '../obs/metrics.js';
import { memoryLogger } from '../../test/fixtures/log.js';
import { makeJournalReader } from './journal-reader.js';
import { healthSnapshot } from './health.js';

const H = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 5, 10, 0, 0);

const v7 = (ms: number): string => uuid7(ms, 0);

/** Fake journal: batchNext is always empty (the live bug); earliest/latest/batchEarliest return what we give. */
function fakeApi(o: { earliest: string | null; latest: string | null; earliestBatch?: string[] }) {
  const api = fakeJournalApi(
    { earliest: o.earliest ? fetchEntry(o.earliest) : null, latest: o.latest ? fetchEntry(o.latest) : null },
    { batchEarliest: async () => (api.calls.push('batchEarliest'), batchOf(o.earliestBatch ?? [])) },
  );
  const n = (c: string) => api.calls.filter((x) => x.split(':')[0] === c).length;
  return { api, calls: () => ({ next: n('next'), earliest: n('earliest'), latest: n('latest'), batchEarliest: n('batchEarliest') }) };
}

test('expired offset + empty reads: recovers from earliest, logs alert, counts data_loss{offset_expired}', async () => {
  const store = new Store(':memory:');
  const metrics = new ChangeCatchMetrics();
  const mem = memoryLogger('journal');
  const clock = { t: NOW };
  const stored = v7(NOW - 72 * H);
  const earliest = v7(NOW - 70 * H);
  const { api, calls } = fakeApi({ earliest, latest: v7(NOW - 1000), earliestBatch: [earliest, v7(NOW - 69 * H)] });
  const read = makeJournalReader(api, { store, metrics, now: () => clock.t, log: mem.log });

  // Before the read: /health already says degraded (offset older than 48 h).
  store.journal.setOffset(stored);
  store.journal.setLastSuccessfulReadAt(NOW);
  let h = healthSnapshot(store, NOW, { startedAt: NOW });
  assert.equal(h.status, 'degraded');
  assert.equal(h.offsetAgeSeconds, 72 * 3600);
  assert.ok(!/portal/i.test(JSON.stringify({ s: h.status, r: h.degradedReason, a: h.offsetAgeSeconds })));

  const r = await read(stored);
  assert.deepEqual(
    r.files.map((f) => f.offset),
    [earliest, v7(NOW - 69 * H)],
    'restarted from earliest',
  );
  assert.equal(r.nextOffset, v7(NOW - 69 * H));
  assert.deepEqual(calls(), { next: 1, earliest: 1, latest: 1, batchEarliest: 1 });
  assert.equal(metrics.registry.get('data_loss', { reason: 'offset_expired', portal: 'app' }), 1);
  const alerts = mem.records.filter((x) => x.event === 'alert' && x.alert === 'offset_expired');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'error');
  assert.match(alerts[0].msg, /journal offset expired; recovered from earliest/);
  assert.match(store.journal.getLastError()!.message, /expired \(empty read\); restarted from earliest/);

  // Check result is stored: while the old offset is still the stored one, health reports it expired.
  h = healthSnapshot(store, NOW, { startedAt: NOW });
  assert.equal(h.status, 'degraded');
  assert.equal(h.degradedReason, 'journal offset expired');

  // The poller saves the new offset: health flips back to ok.
  store.journal.setOffset(r.nextOffset!);
  h = healthSnapshot(store, NOW, { startedAt: NOW });
  assert.equal(h.status, 'degraded', 'new offset is 69 h old, still over 48 h until we catch up');
  store.journal.setOffset(v7(NOW - 2000));
  assert.equal(healthSnapshot(store, NOW, { startedAt: NOW }).status, 'ok');
});

test('fresh offset + empty reads: no earliest/latest calls, health ok', async () => {
  const store = new Store(':memory:');
  const metrics = new ChangeCatchMetrics();
  const fresh = v7(NOW - 10 * 60 * 1000);
  const { api, calls } = fakeApi({ earliest: v7(NOW - 70 * H), latest: fresh });
  const read = makeJournalReader(api, { store, metrics, now: () => NOW, log: memoryLogger().log });
  for (let i = 0; i < 5; i++) {
    const r = await read(fresh);
    assert.equal(r.files.length, 0);
    assert.equal(r.nextOffset, null);
  }
  assert.deepEqual(calls(), { next: 5, earliest: 0, latest: 0, batchEarliest: 0 });
  assert.equal(metrics.registry.get('data_loss', { reason: 'offset_expired', portal: 'app' }), undefined);
  store.journal.setOffset(fresh);
  store.journal.setLastSuccessfulReadAt(NOW);
  const h = healthSnapshot(store, NOW, { startedAt: NOW });
  assert.equal(h.status, 'ok');
  assert.equal(h.offsetAgeSeconds, 600);
});

test('old but valid offset, latest newer: warns, no recovery, re-checks at most every 5 min', async () => {
  const store = new Store(':memory:');
  const metrics = new ChangeCatchMetrics();
  const { log, records: lines } = memoryLogger('journal');
  const clock = { t: NOW };
  const stored = v7(NOW - 50 * H);
  const { api, calls } = fakeApi({ earliest: v7(NOW - 70 * H), latest: v7(NOW - 1000) });
  const read = makeJournalReader(api, { store, metrics, now: () => clock.t, log });

  await read(stored);
  await read(stored); // same minute: throttled
  assert.deepEqual(calls(), { next: 2, earliest: 1, latest: 1, batchEarliest: 0 });
  assert.equal(lines.filter((l) => l.level === 'warn').length, 1);
  assert.match(lines[0].msg, /latest is newer/);
  assert.equal(metrics.registry.get('data_loss', { reason: 'offset_expired', portal: 'app' }), undefined);

  clock.t += 5 * 60 * 1000;
  await read(stored);
  assert.equal(calls().earliest, 2, 'checked again after 5 min');

  store.journal.setOffset(stored);
  store.journal.setLastSuccessfulReadAt(clock.t);
  const h = healthSnapshot(store, clock.t, { startedAt: NOW });
  assert.equal(h.status, 'degraded');
  assert.equal(h.degradedReason, 'stored offset is far behind the journal latest');
});

test('quiet journal: old offset that IS the latest stays ok after a check', async () => {
  const store = new Store(':memory:');
  const stored = v7(NOW - 50 * H);
  const { api } = fakeApi({ earliest: stored, latest: stored });
  const read = makeJournalReader(api, { store, now: () => NOW, log: memoryLogger().log });
  store.journal.setOffset(stored);
  store.journal.setLastSuccessfulReadAt(NOW);
  assert.equal(healthSnapshot(store, NOW, { startedAt: NOW }).status, 'degraded', 'unverified until the reader checks');
  await read(stored);
  assert.equal(healthSnapshot(store, NOW, { startedAt: NOW }).status, 'ok');
  assert.equal(healthSnapshot(store, NOW + 11 * 60 * 1000, { startedAt: NOW }).status, 'degraded', 'verification goes stale');
});
