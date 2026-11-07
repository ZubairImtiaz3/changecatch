// data_loss{reason} + an alert (level error, event alert) for the two poller-side ways changes can be lost:
//  - parked entries dropped by the per-portal cap (MAX_PARKED_PER_PORTAL) -> reason "park_dropped"
//  - a journal entry skipped after JOURNAL_SKIP_FAILED_AFTER_MS               -> reason "skipped_entries"

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADD, batchOf, CONTACT, ev, fakeJournalApi, file, T0, UD } from '../../test/fixtures/journal.js';
import { memoryLogger } from '../../test/fixtures/log.js';
import { closeWorkerHarnesses, workerHarness } from '../../test/fixtures/worker.js';
import { MAX_PARKED_PER_PORTAL } from '../core/poller.js';
import { HubSpotError } from '../lib/http.js';
import { ChangeCatchMetrics } from '../obs/metrics.js';
import { Store } from '../store/db.js';
import { makeJournalReader } from './journal-reader.js';

afterEach(closeWorkerHarnesses);

test('park cap: dropped parked entries count data_loss{reason=park_dropped} and log an alert (error)', async () => {
  const cap = MAX_PARKED_PER_PORTAL;
  const mem = memoryLogger('worker');
  const s = workerHarness({
    files: [file('f1', Array.from({ length: cap + 2 }, (_, i) => ev({ action: ADD, typeId: 101, category: UD, to: [CONTACT, 2 + i], at: i % 1000 })))],
    fetchLabels: async () => {
      throw HubSpotError.fromStatus(502, {}, 'labels down');
    },
    log: mem.log,
  });

  const r = await s.worker.readOnce();
  assert.ok(r, 'run succeeds; the offset moves on');
  assert.equal(r.parked, cap);
  assert.equal(r.parkDropped, 2);
  assert.equal(s.store.journal.getOffset(), 'f1');
  assert.equal(s.metrics.registry.get('data_loss', { reason: 'park_dropped', portal: 111 }), 2);

  const alerts = mem.records.filter((x) => x.event === 'alert');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'error');
  assert.equal(alerts[0].portalId, 111);
  assert.match(alerts[0].msg, /2 parked entries DROPPED/);

  // Still parked (under the cap): no further loss counted.
  await s.worker.readOnce();
  assert.equal(s.metrics.registry.get('data_loss', { reason: 'park_dropped', portal: 111 }), 2);
  assert.equal(mem.records.filter((x) => x.event === 'alert').length, 1);
});

test('journal skip: an entry skipped after JOURNAL_SKIP_FAILED_AFTER_MS counts data_loss{reason=skipped_entries} and logs an alert (error)', async () => {
  const store = new Store(':memory:');
  let now = T0;
  const api = fakeJournalApi({ batches: [batchOf(['01a2'], ['01a1']), batchOf(['01a2'], ['01a1'])] });
  const metrics = new ChangeCatchMetrics();
  const mem = memoryLogger('journal');
  const read = makeJournalReader(api, { store, metrics, now: () => now, log: mem.log });

  await assert.rejects(read('01a0'), /./, 'first failure: retried later, nothing skipped');
  assert.equal(metrics.registry.get('data_loss', { reason: 'skipped_entries', portal: 'app' }), undefined);

  now += 31 * 60_000;
  const r = await read('01a0');
  assert.deepEqual(r.files.map((f) => f.offset), ['01a2']);
  assert.equal(metrics.registry.get('data_loss', { reason: 'skipped_entries', portal: 'app' }), 1);
  const alerts = mem.records.filter((x) => x.event === 'alert');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'error');
  assert.match(alerts[0].msg, /SKIPPING journal entry/);
});
