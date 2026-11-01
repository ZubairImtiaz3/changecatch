// data_loss{reason} + `[ALERT]` (level error, event alert) for the two poller-side ways changes can be lost:
//  - parked entries dropped by the per-portal cap (PARK_MAX_PER_PORTAL)      -> reason "park_dropped"
//  - a journal entry skipped after JOURNAL_SKIP_FAILED_AFTER_MS               -> reason "skipped_entries"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type LabelDefinition } from '../store/db.js';
import { StoreLabelCache } from '../core/labels.js';
import type { JournalReadResult } from '../core/poller.js';
import type { JournalFile } from '../core/types.js';
import { ADD, CONTACT, DEAL, ev, file, T0, UD } from '../core/testutil.js';
import { HttpError } from '../lib/http.js';
import type { JournalBatchResponse, JournalFetchResponse } from '../hubspot/journal.js';
import { ChangeCatchMetrics } from '../obs/metrics.js';
import { memoryLogger } from '../obs/log.js';
import { legacyLog } from '../obs/wiring.js';
import { GuardedLabelCache, LabelHoldError } from './label-guard.js';
import { StampQueue } from './stamp-queue.js';
import { StaleAlerter } from './health.js';
import { makeJournalReader, type JournalApi } from './journal-reader.js';
import { Worker } from './main.js';

const LABELS: LabelDefinition[] = [
  { associationTypeId: 3, label: null, category: 'HUBSPOT_DEFINED' },
  { associationTypeId: 101, label: 'Influencer', category: UD },
];
const quiet = () => {};

test('park cap: dropped parked entries count data_loss{reason=park_dropped} and log an alert (error)', async () => {
  const store = new Store(':memory:');
  store.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
  const clock = { t: T0 + 60_000 };
  const now = () => clock.t;
  const files: JournalFile[] = [
    file('f1', [
      ev({ action: ADD, typeId: 101, category: UD, to: [CONTACT, 2], at: 0 }),
      ev({ action: ADD, typeId: 101, category: UD, to: [CONTACT, 3], at: 10 }),
      ev({ action: ADD, typeId: 101, category: UD, to: [CONTACT, 4], at: 20 }),
    ]),
  ];
  const readJournal = async (after: string | null): Promise<JournalReadResult> => {
    const batch = after === null ? files : [];
    return { files: batch, nextOffset: batch.at(-1)?.offset ?? null, full: false };
  };
  const labels = new GuardedLabelCache(
    new StoreLabelCache(store, async () => {
      throw new HttpError(502, {}, 'labels down');
    }, undefined, now),
    { store, now, log: quiet },
  );
  const queue = new StampQueue({
    store,
    tokens: { getAccessToken: async () => 'tok' },
    now,
    log: quiet,
    batchUpdate: async (_t, _type, inputs) => ({ status: 'COMPLETE', results: inputs.map((i) => ({ id: i.id })) }),
  });
  const metrics = new ChangeCatchMetrics();
  const mem = memoryLogger('worker');
  const worker = new Worker({
    store, readJournal, labels, queue, now, metrics,
    log: legacyLog(mem.log, { errors: null }),
    alerter: new StaleAlerter(1e9, quiet),
    isParkable: (e) => e instanceof LabelHoldError,
    runConfig: { maxParkedPerPortal: 1 },
  });

  const r = await worker.readOnce();
  assert.ok(r, 'run succeeds; the offset moves on');
  assert.equal(r.parked, 1);
  assert.equal(r.parkDropped, 2);
  assert.equal(store.getOffset(), 'f1');
  assert.equal(metrics.registry.get('data_loss', { reason: 'park_dropped', portal: 111 }), 2);

  const alerts = mem.records.filter((x) => x.event === 'alert');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'error');
  assert.equal(alerts[0].portalId, 111);
  assert.match(alerts[0].msg, /2 parked entries DROPPED/);

  // Still parked (under the cap): no further loss counted.
  await worker.readOnce();
  assert.equal(metrics.registry.get('data_loss', { reason: 'park_dropped', portal: 111 }), 2);
  assert.equal(mem.records.filter((x) => x.event === 'alert').length, 1);
});

test('journal skip: an entry skipped after JOURNAL_SKIP_FAILED_AFTER_MS counts data_loss{reason=skipped_entries} and logs an alert (error)', async () => {
  const store = new Store(':memory:');
  let now = T0;
  const entry = (o: string): JournalFetchResponse => ({ url: `https://x/${o}`, expiresAt: '2999-01-01T00:00:00Z', currentOffset: o });
  const failed = (ok: string[], bad: string[]): JournalBatchResponse => ({
    status: 'COMPLETE', startedAt: '', completedAt: '',
    results: ok.map(entry),
    numErrors: bad.length,
    errors: bad.map((o) => ({ status: 'PRESIGNING_ERROR', message: 'x', context: { offset: [o] } })),
  });
  const batches = [failed(['01a2'], ['01a1']), failed(['01a2'], ['01a1'])];
  const api = {
    latest: async () => undefined,
    batchEarliest: async () => batches.shift(),
    batchNext: async () => batches.shift(),
    download: async (e: JournalFetchResponse) => ({ offset: e.currentOffset, journalEvents: [] }),
  } as unknown as JournalApi;
  const metrics = new ChangeCatchMetrics();
  const mem = memoryLogger('journal');
  const read = makeJournalReader(api, { store, metrics, now: () => now, skipAfterMs: 30 * 60_000, log: legacyLog(mem.log, { errors: null }) });

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
