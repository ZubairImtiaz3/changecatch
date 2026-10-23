// Scale + robustness tests for the worker (scale-review C2, C3, H3, H4 adoption; system-design-review dead letters,
// revoked-token pause, single-worker lock; security-review health privacy + journal download allow-list).
// All with a fake clock; no HubSpot calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Store, type LabelDefinition } from '../store/db.js';
import { StoreLabelCache } from '../core/labels.js';
import { runOnce, type JournalReadResult } from '../core/poller.js';
import { recordKey, type StampUpdate } from '../core/stamp.js';
import type { JournalEvent, JournalFile } from '../core/types.js';
import { ADD, CONTACT, DEAL, ev, file, T0, UD } from '../core/testutil.js';
import { HttpError, RetryLaterError } from '../lib/http.js';
import type { StampResult } from '../hubspot/stamp.js';
import type { JournalFetchResponse } from '../hubspot/journal.js';
import { ChangeCatchMetrics } from '../obs/metrics.js';
import { StampQueue } from './stamp-queue.js';
import { TokenRevokedError, type TokenProvider } from './tokens.js';
import { Worker } from './main.js';
import { StaleAlerter, healthSnapshot, registerWorkerGauges, startHealthServer } from './health.js';
import { LifecycleRetry } from './lifecycle-retry.js';
import { WorkerLockError, WorkerTables } from './worker-tables.js';
import { assertJournalFileUrl, JournalFileRejectedError, makeJournalReader, secureDownloadJournalFile, type JournalApi } from './journal-reader.js';
import { LabelHoldError } from './label-guard.js';

const quiet = () => {};
const LABELS: LabelDefinition[] = [{ associationTypeId: 3, label: null, category: 'HUBSPOT_DEFINED' }];
const okTokens: TokenProvider = { getAccessToken: async (p) => `tok-${p}` };

let seq = 0;
function upd(portalId: number, objectId: string | number, at = T0, id?: string): StampUpdate {
  return {
    portalId,
    objectTypeId: DEAL,
    objectId: String(objectId),
    occurredAtMs: at,
    properties: { changecatch_last_change_id: id ?? `c${++seq}`, changecatch_change_type: 'ADDED' } as StampUpdate['properties'],
  };
}

function journalOf(files: JournalFile[]) {
  return async (after: string | null): Promise<JournalReadResult> => {
    const start = after === null ? 0 : files.findIndex((f) => f.offset === after) + 1;
    const batch = files.slice(start);
    return { files: batch, nextOffset: batch.at(-1)?.offset ?? null, full: false };
  };
}

// ---------------------------------------------------------------- C2: lifecycle hook never stops the offset

test('C2: a failing install/uninstall does NOT block the shared offset; it is retried with back-off; uninstall purges locally at once', async () => {
  const store = new Store(':memory:');
  const tables = new WorkerTables(store);
  const clock = { t: T0 + 60_000 };
  store.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
  store.setWatchedPairs(5, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
  store.addMetrics(111, { events: 1 }, clock.t);
  let failures = 2;
  const handled: string[] = [];
  const hook = async (e: JournalEvent) => {
    if ((e as { type?: string }).type !== 'app_lifecycle_event') return undefined;
    if (failures-- > 0) throw new HttpError(503, {}, 'subscriptions API down');
    handled.push(`${(e as { action: string }).action}:${e.portalId}`);
    return 'ok';
  };
  const retry = new LifecycleRetry({ tables, store, hook, now: () => clock.t, log: quiet, baseMs: 30_000 });
  const uninstall = { type: 'app_lifecycle_event', action: 'APP_UNINSTALL', portalId: 111, occurredAt: new Date(T0).toISOString() };
  const files: JournalFile[] = [
    { offset: 'f1', journalEvents: [uninstall as never] },
    file('f2', [ev({ portalId: 5, at: 1_000 })]),
  ];
  const queue = new StampQueue({ store, tokens: okTokens, tables, now: () => clock.t, log: quiet, sendBatches: async (u) => u.map((x) => ({ update: x, ok: true })) });
  const worker = new Worker({
    store, readJournal: journalOf(files), queue, now: () => clock.t, log: quiet, alerter: new StaleAlerter(1e9, quiet),
    labels: new StoreLabelCache(store, async () => LABELS), lifecycleRetry: retry,
  });

  const r = await worker.readOnce();
  assert.ok(r, 'the run succeeds although the lifecycle hook threw');
  assert.equal(store.getOffset(), 'f2', 'offset moved on for every portal');
  assert.equal(tables.listLifecycleRetries().length, 1, 'persisted for retry');
  assert.deepEqual(store.getWatchedPairs(111), [], 'local data of the uninstalled portal purged at once');
  assert.equal(store.getMetrics(111), undefined);
  assert.ok(store.getWatchedPairs(5).length, 'other portals untouched');
  assert.equal(worker.nextWakeAt() <= clock.t + 30_000, true, 'loop wakes for the retry');

  // Not due yet.
  await worker.retryLifecycle();
  assert.deepEqual(handled, []);
  // First retry fails -> back-off doubles (60 s).
  clock.t += 30_000;
  await worker.retryLifecycle();
  const row = tables.listLifecycleRetries()[0];
  assert.equal(row.attempts, 1);
  assert.equal(row.nextAt, clock.t + 30_000);
  // Second retry works -> row removed.
  clock.t += 30_000;
  await worker.retryLifecycle();
  assert.deepEqual(handled, ['APP_UNINSTALL:111']);
  assert.equal(tables.listLifecycleRetries().length, 0);
  store.close();
});

test('C2: an install the app server is still provisioning is deferred (no parallel provision), then handled', async () => {
  const store = new Store(':memory:');
  const tables = new WorkerTables(store);
  const clock = { t: T0 };
  const portal = { installedAt: T0 - 1_000, provisionedAt: null as number | null, uninstalledAt: null };
  const calls: number[] = [];
  const retry = new LifecycleRetry({
    tables, store, now: () => clock.t, log: quiet, portals: { getPortal: () => portal },
    hook: async (e) => { calls.push(clock.t); return e; },
  });
  const install = { type: 'app_lifecycle_event', action: 'APP_INSTALL', portalId: 7, occurredAt: new Date(T0).toISOString() } as unknown as JournalEvent;
  assert.equal(await retry.onOtherEvent(install, 'f'), 'deferred');
  assert.deepEqual(calls, []);
  assert.equal(retry.nextDueAt(), T0 - 1_000 + 5 * 60_000);
  portal.provisionedAt = T0 + 2_000; // the app server finished
  clock.t = T0 + 5 * 60_000;
  assert.equal(await retry.runDue(), 1);
  assert.equal(calls.length, 1);
  store.close();
});

// ---------------------------------------------------------------- C3: parallel downloads, order kept

test('C3: journal files download in parallel (bounded) but come back in offset order', async () => {
  const store = new Store(':memory:');
  let inFlight = 0;
  let maxInFlight = 0;
  const offsets = Array.from({ length: 40 }, (_, i) => `0190-${String(i).padStart(4, '0')}`);
  const api: JournalApi = {
    latest: async () => null,
    batchEarliest: async () => undefined,
    batchNext: async () => ({
      status: 'COMPLETE', startedAt: '', completedAt: '',
      // HubSpot order shuffled on purpose; the reader sorts by offset.
      results: [...offsets].reverse().map((o) => ({ url: `https://x/${o}`, expiresAt: '2999-01-01T00:00:00Z', currentOffset: o })),
    }),
    download: async (e) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Earlier offsets take LONGER, so completion order is the reverse of offset order.
      await new Promise((r) => setTimeout(r, 40 - offsets.indexOf(e.currentOffset)));
      inFlight--;
      return { offset: e.currentOffset, journalEvents: [] };
    },
  };
  const read = makeJournalReader(api, { store, downloadConcurrency: 8, log: quiet });
  const r = await read('0190-start');
  assert.deepEqual(r.files.map((f) => f.offset), offsets, 'processing order = offset order');
  assert.equal(r.nextOffset, offsets.at(-1));
  assert.ok(maxInFlight > 1 && maxInFlight <= 8, `bounded parallelism (max in flight ${maxInFlight})`);
  store.close();
});

test('C3: one failed download fails the read (offset not advanced past it)', async () => {
  const store = new Store(':memory:');
  const api: JournalApi = {
    latest: async () => null,
    batchEarliest: async () => undefined,
    batchNext: async () => ({ status: 'COMPLETE', startedAt: '', completedAt: '', results: ['a', 'b', 'c'].map((o) => ({ url: o, expiresAt: '', currentOffset: o })) }),
    download: async (e) => {
      if (e.currentOffset === 'b') throw new Error('S3 down');
      return { offset: e.currentOffset, journalEvents: [] };
    },
  };
  await assert.rejects(makeJournalReader(api, { store, log: quiet })('0'), /S3 down/);
  store.close();
});

// ---------------------------------------------------------------- H3: fair drain

function fairSetup(o: { sendBatches?: (u: StampUpdate[]) => Promise<StampResult[]>; clock?: { t: number }; extra?: Partial<ConstructorParameters<typeof StampQueue>[0]> } = {}) {
  const store = new Store(':memory:');
  const clock = o.clock ?? { t: T0 + 60_000 };
  const sent: StampUpdate[][] = [];
  const queue = new StampQueue({
    store, tokens: okTokens, now: () => clock.t, log: quiet, defaultSpacingMs: 3_000,
    sendBatches: async (u) => {
      sent.push(u);
      return o.sendBatches ? o.sendBatches(u) : u.map((x) => ({ update: x, ok: true }));
    },
    ...o.extra,
  });
  return { store, clock, sent, queue };
}

test('H3: portal A has 1000 queued; portal B\'s single stamp goes out in the SAME drain cycle', async () => {
  const s = fairSetup();
  s.queue.enqueue(Array.from({ length: 1000 }, (_, i) => upd(111, i + 1)));
  s.clock.t += 1; // B arrives later (later not_before than all of A)
  s.queue.enqueue([upd(222, 1, T0, 'b-only')]);
  const r = await s.queue.drain();
  const ids = r.sent.map((u) => u.properties.changecatch_last_change_id);
  assert.ok(ids.includes('b-only'), 'B stamped in the first cycle');
  assert.equal(r.sent.filter((u) => u.portalId === 111).length, 100, 'A gets one batch (100) per cycle, not all 1000');
  assert.equal(s.store.queueSize(), 900);
  // Next cycles keep serving A.
  await s.queue.drain();
  assert.equal(s.store.queueSize(), 800);
  s.store.close();
});

test('H3: a RetryLaterError (429) on portal A defers only A; B is stamped; A is skipped until retryAfter', async () => {
  const s = fairSetup({
    sendBatches: async (u) =>
      u.map((x): StampResult =>
        x.portalId === 111
          ? { update: x, ok: false, retryable: true, reason: new RetryLaterError(60_000, undefined, 'portal:111 throttled').message, retryAfterMs: 60_000 }
          : { update: x, ok: true },
      ),
  });
  const metrics = new ChangeCatchMetrics();
  (s.queue as unknown as { opts: { metrics: ChangeCatchMetrics } }).opts.metrics = metrics;
  s.queue.enqueue([upd(111, 1, T0, 'a1'), upd(111, 2, T0, 'a2'), upd(222, 1, T0, 'b1')]);
  const r1 = await s.queue.drain();
  assert.deepEqual(r1.sent.map((u) => u.properties.changecatch_last_change_id), ['b1']);
  assert.deepEqual(r1.failed.sort(), ['a1', 'a2']);
  assert.equal(s.store.queuedAttempts('a1'), 0, 'a rate limit is not counted as a failed attempt');
  assert.equal(metrics.registry.get('rate_limited', { portal: 111 }), 2);

  // B gets a new stamp; A is NOT tried again before retryAfter.
  s.clock.t += 5_000;
  s.queue.enqueue([upd(222, 2, T0, 'b2')]);
  const r2 = await s.queue.drain();
  assert.deepEqual(r2.sent.map((u) => u.properties.changecatch_last_change_id), ['b2']);
  assert.equal(s.sent.at(-1)!.some((u) => u.portalId === 111), false, 'A not called while throttled');
  s.clock.t += 60_000;
  await s.queue.drain();
  assert.ok(s.sent.at(-1)!.some((u) => u.portalId === 111), 'A retried after retryAfter');
  s.store.close();
});

test('partial batch failure: only the failed record is retried; refused records are dead-lettered (not deleted silently)', async () => {
  let call = 0;
  const s = fairSetup({
    sendBatches: async (u) => {
      call++;
      return u.map((x): StampResult => {
        if (call === 1 && x.objectId === '2') return { update: x, ok: false, retryable: true, reason: 'POST ... failed with 502' };
        if (call === 1 && x.objectId === '3') return { update: x, ok: false, retryable: false, reason: 'OBJECT_NOT_FOUND: record 3 deleted' };
        return { update: x, ok: true };
      });
    },
  });
  s.queue.enqueue([upd(111, 1, T0, 'r1'), upd(111, 2, T0, 'r2'), upd(111, 3, T0, 'r3')]);
  const r1 = await s.queue.drain();
  assert.deepEqual(r1.sent.map((u) => u.objectId), ['1']);
  assert.deepEqual(r1.failed, ['r2']);
  assert.deepEqual(r1.dropped.map((u) => u.objectId), ['3']);
  const dl = s.queue.tables.listDeadLetters(111);
  assert.equal(dl.length, 1);
  assert.equal(dl[0].changeId, 'r3');
  assert.match(dl[0].error!, /OBJECT_NOT_FOUND/);
  assert.equal(s.queue.tables.deadLetterCounts().get(111), 1);

  s.clock.t += 5_000; // back-off
  await s.queue.drain();
  assert.deepEqual(s.sent[1].map((u) => u.objectId), ['2'], 'only the failed record is re-sent');
  assert.equal(s.store.queueSize(), 0);
  s.store.close();
});

test('transient failures retry for up to STAMP_RETRY_MAX_MS, then dead-letter', async () => {
  const s = fairSetup({
    sendBatches: async (u) => u.map((x) => ({ update: x, ok: false, retryable: true, reason: 'failed with 503' })),
    extra: { retryWindowMs: 60 * 60_000, retryMaxMs: 10 * 60_000 },
  });
  s.queue.enqueue([upd(111, 1, s.clock.t, 'x')]);
  for (let i = 0; i < 20 && s.store.queueSize(); i++) {
    await s.queue.drain();
    s.clock.t = Math.max(s.clock.t + 1, s.store.nextStampDueAt() ?? s.clock.t);
  }
  assert.equal(s.store.queueSize(), 0);
  const dl = s.queue.tables.listDeadLetters();
  assert.equal(dl.length, 1);
  assert.match(dl[0].error!, /gave up after \d+ attempt/);
  assert.ok(s.sent.length > 3, 'retried several times first');
  s.store.close();
});

// ---------------------------------------------------------------- coalescing adoption (C1 + H4)

test('coalescing: a burst on one record is folded (latest mode); folded ids are marked seen; other records are not delayed (C1)', async () => {
  const s = fairSetup({ extra: { coalesceFor: () => ({ mode: 'latest', threshold: 3 }) } });
  const burst = Array.from({ length: 10 }, (_, i) => upd(111, 1, T0 + i, `burst${i}`));
  const other = upd(111, 99, T0 + 5, 'other');
  const delivered: StampUpdate[] = [];
  await s.queue.sendStamps([...burst, other], (d) => delivered.push(...d));
  // Record 1: oldest + newest kept (2 stamps), 8 folded into the newest's count.
  const rows = s.store.db.prepare('SELECT change_id, not_before, update_json FROM stamp_queue ORDER BY not_before').all() as { change_id: string; not_before: number; update_json: string }[];
  assert.deepEqual(rows.map((r) => r.change_id), ['burst9']);
  assert.equal(JSON.parse(rows[0].update_json).coalescedCount, 9);
  assert.ok(!('changecatch_changes_since_last_stamp' in JSON.parse(rows[0].update_json).properties), 'count is not a HubSpot property (D5)');
  assert.equal(rows[0].not_before, s.clock.t + 3_000, 'spaced after the first stamp of the same record');
  assert.equal(s.store.filterSeen(['stamp:burst4']).size, 1, 'folded ids are marked seen');
  const sentIds = s.sent[0].map((u) => u.properties.changecatch_last_change_id).sort();
  assert.deepEqual(sentIds, ['burst0', 'other'], 'the other record went out immediately, not behind the burst');
  assert.equal(delivered.length, 10, '8 folded + 2 sent now');

  // Off mode: every change is its own stamp, one per record per spacing slot.
  const o = fairSetup({ extra: { coalesceFor: () => ({ mode: 'off', threshold: 3 }) } });
  o.queue.enqueue(Array.from({ length: 4 }, (_, i) => upd(111, 1, T0 + i, `o${i}`)));
  const slots = (o.store.db.prepare('SELECT not_before FROM stamp_queue ORDER BY not_before').all() as { not_before: number }[]).map((r) => r.not_before - o.clock.t);
  assert.deepEqual(slots, [0, 3_000, 6_000, 9_000]);
  s.store.close();
  o.store.close();
});

// ---------------------------------------------------------------- revoked token: pause, probe, purge after 7 days

test('revoked token: the portal is PAUSED (queue kept, probed hourly), unpaused on success; purged after 7 days', async () => {
  let revoked = true;
  const expired: number[] = [];
  const s = fairSetup({
    sendBatches: async (u) =>
      u.map((x): StampResult =>
        revoked
          ? { update: x, ok: false, retryable: true, reason: new TokenRevokedError(x.portalId).message, retryAfterMs: 3_600_000 }
          : { update: x, ok: true },
      ),
    extra: { onPauseExpired: (p) => void expired.push(p) },
  });
  s.queue.enqueue([upd(111, 1, s.clock.t, 'p1'), upd(111, 2, s.clock.t, 'p2'), upd(222, 1, s.clock.t, 'q1')]);
  const r1 = await s.queue.drain();
  assert.equal(r1.dropped.length, 0, 'nothing dropped');
  assert.equal(s.store.queueSize(), 3, 'queue kept');
  assert.ok(s.queue.tables.getPause(111) && s.queue.tables.getPause(222));
  assert.equal(s.store.queuedAttempts('p1'), 0);

  // Before the hourly probe: not called.
  s.clock.t += 30 * 60_000;
  const before = s.sent.length;
  await s.queue.drain();
  assert.equal(s.sent.length, before);
  // Probe after an hour with ONE record per portal; it works -> unpaused, the rest follows.
  revoked = false;
  s.clock.t += 31 * 60_000;
  await s.queue.drain();
  assert.equal(s.sent.at(-1)!.length, 2, 'one probe record per paused portal');
  assert.equal(s.queue.tables.getPause(111), undefined);
  await s.queue.drain();
  assert.equal(s.store.queueSize(), 0);

  // Revoked per the token provider (token_revocations) for > 7 days with NOTHING queued -> uninstall routine.
  const r = fairSetup({ extra: { revokedPortals: () => [{ portalId: 444, revokedAt: T0 }], onPauseExpired: (p) => void expired.push(p) } });
  await r.queue.drain();
  assert.deepEqual(expired, [], 'not yet');
  assert.ok(r.queue.tables.getPause(444), 'paused from the revocation time');
  r.clock.t = T0 + 7 * 24 * 60 * 60_000 + 1;
  await r.queue.drain();
  await r.queue.drain();
  assert.deepEqual(expired, [444], 'uninstall routine called once');
  s.store.close();
  r.store.close();
});

test('revoked: a 401 after refresh pauses (not dead-letters); purge clears dead letters, pauses and token_revocations', async () => {
  const s = fairSetup({ sendBatches: async (u) => u.map((x) => ({ update: x, ok: false, retryable: false, reason: 'POST /crm/objects/2026-09/0-3/batch/update failed with 401: {}' })) });
  s.queue.enqueue([upd(111, 1, s.clock.t, 'z')]);
  await s.queue.drain();
  assert.equal(s.store.queueSize(), 1);
  assert.equal(s.queue.tables.listDeadLetters().length, 0);
  assert.ok(s.queue.tables.getPause(111));
  s.queue.tables.deadLetter([{ q: { changeId: 'd', portalId: 111, recordKey: '111|0-3|1', update: upd(111, 1), notBefore: 0, attempts: 0, lastError: null }, error: 'x' }], T0);
  s.store.db.exec('CREATE TABLE IF NOT EXISTS token_revocations (portal_id INTEGER PRIMARY KEY, token_revoked_at INTEGER NOT NULL, reason TEXT NOT NULL)');
  s.store.db.prepare('INSERT INTO token_revocations VALUES (111, 1, ?)').run('invalid_grant');
  const purged = s.queue.tables.purgePortal(111);
  assert.deepEqual([purged.stamp_dead_letter, purged.portal_pause, purged.token_revocations], [1, 1, 1]);
  s.store.close();
});

// ---------------------------------------------------------------- single-worker lock

test('worker lock: a second worker refuses to start while the first heartbeats; takes over once it is stale', () => {
  const store = new Store(':memory:');
  const a = new WorkerTables(store);
  const b = new WorkerTables(store);
  a.acquireLock(T0, 30_000, 1, 'host-a');
  assert.throws(() => b.acquireLock(T0 + 10_000, 30_000, 2, 'host-b'), (e) => e instanceof WorkerLockError && /pid 1 on host-a/.test(e.message));
  assert.equal(a.heartbeat(T0 + 20_000), true);
  assert.throws(() => b.acquireLock(T0 + 45_000, 30_000, 2, 'host-b'), WorkerLockError, 'heartbeat 25 s ago: still alive');
  b.acquireLock(T0 + 51_000, 30_000, 2, 'host-b'); // a's heartbeat is 31 s old
  assert.equal(a.heartbeat(T0 + 52_000), false, 'a learns it lost the lock');
  assert.equal(b.lockInfo()?.mine, true);
  b.releaseLock();
  assert.equal(b.lockInfo(), null);
  store.close();
});

// ---------------------------------------------------------------- metrics + health privacy

test('metrics: /metrics and /health expose queue depth, stamps_sent, e2e latency, journal lag; portal labels only with x-health-token', async () => {
  const s = fairSetup();
  const metrics = new ChangeCatchMetrics();
  (s.queue as unknown as { opts: { metrics: ChangeCatchMetrics } }).opts.metrics = metrics;
  registerWorkerGauges(metrics, s.store, s.queue.tables);
  s.queue.enqueue([upd(111, 1, s.clock.t - 4_000), upd(111, 1, s.clock.t - 3_000), upd(222, 1, s.clock.t - 2_000)]);
  await s.queue.drain();
  metrics.journalRunOk({ files: 1, events: 3, newestOccurredAtMs: Date.now() - 5_000, caughtUp: true });
  assert.equal(metrics.registry.get('stamps_sent', { portal: 111 }), 1);
  assert.equal(metrics.registry.get('stamp_queue_depth', { portal: 111 }), 1);
  assert.equal(metrics.registry.histogram('e2e_latency_ms')?.count, 2);

  const server = await startHealthServer({
    port: 0, host: '127.0.0.1', healthToken: 'tkn', metrics,
    snapshot: () => healthSnapshot(s.store, s.clock.t, T0, 1e12, null, { tables: s.queue.tables, metrics }),
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const pub = await (await fetch(`${base}/metrics`)).text();
    assert.match(pub, /changecatch_stamps_sent_total 2/);
    assert.match(pub, /changecatch_stamp_queue_depth 1/);
    assert.match(pub, /changecatch_journal_lag_seconds \d/);
    assert.match(pub, /changecatch_e2e_latency_ms_count 2/);
    assert.ok(!/portal=/.test(pub), 'no portal labels without the token');
    const priv = await (await fetch(`${base}/metrics`, { headers: { 'x-health-token': 'tkn' } })).text();
    assert.match(priv, /changecatch_stamps_sent_total\{portal="111"\} 1/);
    assert.match(priv, /changecatch_stamp_queue_depth\{portal="111"\} 1/);
    const h = (await (await fetch(`${base}/health`)).json()) as any;
    assert.equal(h.status, 'ok');
    assert.equal(h.stampQueue.size, 1);
    assert.equal(h.totals.deadLetters, 0);
    assert.ok(h.metrics, 'metrics JSON in /health');
    assert.ok(!/portal=|portalId/.test(JSON.stringify(h)));
    const hp = (await (await fetch(`${base}/health`, { headers: { 'x-health-token': 'tkn' } })).json()) as any;
    assert.ok(Array.isArray(hp.portals));
  } finally {
    await new Promise((r) => server.close(r));
    s.store.close();
  }
});

// ---------------------------------------------------------------- journal file download allow-list + size cap

test('journal download: only https HubSpot journal bucket on S3; size capped', async () => {
  assert.ok(assertJournalFileUrl('https://hubspot-webhooks-journal-na1.s3.amazonaws.com/x?sig=1'));
  for (const bad of [
    'http://hubspot-webhooks-journal-na1.s3.amazonaws.com/x',
    'https://evil.example.com/x',
    'https://hubspot-webhooks-journal.evil.com/x',
    'https://other-bucket.s3.amazonaws.com/x',
    'not a url',
  ])
    assert.throws(() => assertJournalFileUrl(bad), JournalFileRejectedError, bad);

  const entry: JournalFetchResponse = { url: 'https://hubspot-webhooks-journal-na1.s3.amazonaws.com/f', expiresAt: '2999-01-01T00:00:00Z', currentOffset: 'o' };
  const okFetch = (async () => new Response(JSON.stringify({ offset: 'o', journalEvents: [] }))) as typeof fetch;
  assert.equal((await secureDownloadJournalFile(entry, { fetchImpl: okFetch })).offset, 'o');
  const big = (async () => new Response('x'.repeat(2_000))) as typeof fetch;
  await assert.rejects(secureDownloadJournalFile(entry, { fetchImpl: big, maxBytes: 1_000 }), JournalFileRejectedError);
  let called = false;
  await assert.rejects(
    secureDownloadJournalFile({ ...entry, url: 'https://evil.example.com/f' }, { fetchImpl: (async () => ((called = true), new Response('{}'))) as typeof fetch }),
    JournalFileRejectedError,
  );
  assert.equal(called, false, 'never fetched');
});

// ---------------------------------------------------------------- head-of-line: parking cap

test('parking cap: one portal\'s held labels park at most N entries (alert), never holding the offset', async () => {
  const store = new Store(':memory:');
  store.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
  const files = [file('f1', Array.from({ length: 6 }, (_, i) => ev({ action: ADD, typeId: 101, category: UD, at: i, to: [CONTACT, 10 + i] })))];
  const origErr = console.error;
  const errs: string[] = [];
  console.error = (m: string) => void errs.push(m);
  try {
    const r = await runOnce({
      readJournal: journalOf(files), store, now: () => T0 + 60_000,
      labels: { get: async () => { throw new LabelHoldError('111|0-3|0-1|101', 'labels down'); } } as never,
      sendStamps: async () => {},
      isParkable: (e) => e instanceof LabelHoldError,
      config: { maxParkedPerPortal: 4 },
    });
    assert.equal(store.getOffset(), 'f1');
    assert.equal(r.parked, 4);
    assert.equal(r.parkDropped, 2);
    assert.equal(store.parkedCount(), 4);
    assert.match(store.getMetrics(111)!.lastError!, /\[ALERT\].*DROPPED/);
    assert.ok(errs.some((e) => /\[ALERT\]/.test(e)));
  } finally {
    console.error = origErr;
    store.close();
  }
});

// keep recordKey import used (shared helper for readers of this file)
void recordKey;
