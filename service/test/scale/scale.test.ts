// Scale + robustness tests for the worker (scale-review C3, H3, H4 adoption; system-design-review dead letters,
// revoked-token pause, single-worker lock; security-review health privacy).
// All with a fake clock; no HubSpot calls.

import { memoryLogger } from '../fixtures/log.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Store } from '../../src/store/db.js';
import { type StampUpdate } from '../../src/core/stamp.js';
import { recordKey, STAMP_PREFIX } from '../../src/core/keys.js';
import { DEAL, T0 } from '../fixtures/journal.js';
import { HubSpotError } from '../../src/lib/http.js';
import { sendStampBatches, type StampResult, type StampSendDeps } from '../../src/hubspot/stamp.js';
import { ChangeCatchMetrics } from '../../src/obs/metrics.js';
import { StampQueue } from '../../src/worker/stamp-queue.js';
import { TokenRevokedError, type TokenProvider } from '../../src/hubspot/portal-tokens.js';
import { healthSnapshot, registerWorkerGauges, startHealthServer } from '../../src/worker/health.js';
import { WorkerLockError, WorkerStore } from '../../src/store/worker.js';
import { DEFAULT_RETRY_WINDOW_MS } from '../../src/worker/stamp-queue.js';
import { DEFAULT_STAMP_SPACING_SECONDS } from '../../src/store/schema.js';
import { JOURNAL_DOWNLOAD_CONCURRENCY, makeJournalReader, type JournalApi } from '../../src/worker/journal-reader.js';

const quiet = memoryLogger().log;
const okTokens: Pick<TokenProvider, 'getAccessToken'> = { getAccessToken: async (p) => `tok-${p}` };
const noneRevoked = { listRevoked: () => [] };
/** The production sender (src/hubspot/stamp.ts) with a fake CRM call. */
const realSender = (batchUpdate: StampSendDeps['batchUpdate'], tokens: StampSendDeps['tokens'] = okTokens) => (u: StampUpdate[]) =>
  sendStampBatches(u, { tokens, batchUpdate, log: quiet });

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

// C2 (lifecycle never holds the offset): src/worker/lifecycle.test.ts. Parking cap: src/worker/data-loss.test.ts.

// ---------------------------------------------------------------- C3: parallel downloads, order kept

test('C3: journal files download in parallel (bounded) but come back in offset order', async () => {
  const store = new Store(':memory:');
  let inFlight = 0;
  let maxInFlight = 0;
  const offsets = Array.from({ length: 40 }, (_, i) => `0190-${String(i).padStart(4, '0')}`);
  const api: JournalApi = {
    latest: async () => null,
    earliest: async () => null,
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
  const read = makeJournalReader(api, { store, log: quiet });
  const r = await read('0190-start');
  assert.deepEqual(r.files.map((f) => f.offset), offsets, 'processing order = offset order');
  assert.equal(r.nextOffset, offsets.at(-1));
  assert.ok(maxInFlight > 1 && maxInFlight <= JOURNAL_DOWNLOAD_CONCURRENCY, `bounded parallelism (max in flight ${maxInFlight})`);
  store.close();
});

test('C3: one failed download fails the read (offset not advanced past it)', async () => {
  const store = new Store(':memory:');
  const api: JournalApi = {
    latest: async () => null,
    earliest: async () => null,
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
    store, revoked: noneRevoked, now: () => clock.t, log: quiet,
    spacingFor: () => DEFAULT_STAMP_SPACING_SECONDS * 1000,
    retryWindowMs: DEFAULT_RETRY_WINDOW_MS,
    sendBatches: async (u) => {
      sent.push(u);
      return o.sendBatches ? o.sendBatches(u) : u.map((x): StampResult => ({ update: x, kind: 'ok' }));
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
  assert.equal(s.store.stamps.queueSize(), 900);
  // Next cycles keep serving A.
  await s.queue.drain();
  assert.equal(s.store.stamps.queueSize(), 800);
  s.store.close();
});

test('H3: a throttled error (429) on portal A defers only A; B is stamped; A is skipped until retryAfter', async () => {
  const s = fairSetup({
    sendBatches: async (u) =>
      u.map((x): StampResult =>
        x.portalId === 111
          ? { update: x, kind: 'throttled', retryAfterMs: 60_000, message: 'portal:111 throttled' }
          : { update: x, kind: 'ok' },
      ),
  });
  s.queue.enqueue([upd(111, 1, T0, 'a1'), upd(111, 2, T0, 'a2'), upd(222, 1, T0, 'b1')]);
  const r1 = await s.queue.drain();
  assert.deepEqual(r1.sent.map((u) => u.properties.changecatch_last_change_id), ['b1']);
  assert.deepEqual(r1.failed.sort(), ['a1', 'a2']);

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
        if (call === 1 && x.objectId === '2') return { update: x, kind: 'retry', message: 'POST ... failed with 502' };
        if (call === 1 && x.objectId === '3') return { update: x, kind: 'refused', message: 'OBJECT_NOT_FOUND: record 3 deleted' };
        return { update: x, kind: 'ok' };
      });
    },
  });
  s.queue.enqueue([upd(111, 1, T0, 'r1'), upd(111, 2, T0, 'r2'), upd(111, 3, T0, 'r3')]);
  const r1 = await s.queue.drain();
  assert.deepEqual(r1.sent.map((u) => u.objectId), ['1']);
  assert.deepEqual(r1.failed, ['r2']);
  assert.deepEqual(r1.dropped.map((u) => u.objectId), ['3']);
  assert.equal(s.store.stamps.deadLetterCounts().get(111), 1);

  s.clock.t += 5_000; // back-off
  await s.queue.drain();
  assert.deepEqual(s.sent[1].map((u) => u.objectId), ['2'], 'only the failed record is re-sent');
  assert.equal(s.store.stamps.queueSize(), 0);
  s.store.close();
});

test('transient failures retry for up to the retry window (24 h), then dead-letter', async () => {
  const s = fairSetup({
    sendBatches: async (u) => u.map((x): StampResult => ({ update: x, kind: 'retry', message: 'failed with 503' })),
    extra: { retryWindowMs: 60 * 60_000, retryMaxMs: 10 * 60_000 },
  });
  s.queue.enqueue([upd(111, 1, s.clock.t, 'x')]);
  for (let i = 0; i < 20 && s.store.stamps.queueSize(); i++) {
    await s.queue.drain();
    s.clock.t = Math.max(s.clock.t + 1, s.store.stamps.nextDueAt() ?? s.clock.t);
  }
  assert.equal(s.store.stamps.queueSize(), 0);
  assert.equal(s.store.stamps.deadLetterCounts().get(111), 1);
  assert.ok(s.sent.length > 3, 'retried several times first');
  s.store.close();
});

// ---------------------------------------------------------------- coalescing adoption (C1 + H4)

test('coalescing: a burst on one record is folded (latest mode); folded ids are marked seen; other records are not delayed (C1)', async () => {
  const s = fairSetup();
  const burst = Array.from({ length: 10 }, (_, i) => upd(111, 1, T0 + i, `burst${i}`));
  const other = upd(111, 99, T0 + 5, 'other');
  const delivered = s.queue.enqueue([...burst, other]);
  const drained = await s.queue.drain();
  // Record 1: oldest + newest kept (2 stamps), 8 folded into the newest's count.
  const queued = () => s.store.stamps.queuedFor(recordKey(burst[0]));
  assert.deepEqual(queued().map((q) => q.changeId), ['burst9']);
  assert.equal(queued()[0].update.coalescedCount, 9);
  assert.ok(!('changecatch_changes_since_last_stamp' in queued()[0].update.properties), 'count is not a HubSpot property (D5)');
  assert.equal(queued()[0].notBefore, s.clock.t + 3_000, 'spaced after the first stamp of the same record');
  assert.equal(s.store.seen.filterSeen([STAMP_PREFIX + 'burst4']).size, 1, 'folded ids are marked seen (stamp status)');
  const sentIds = s.sent[0].map((u) => u.properties.changecatch_last_change_id).sort();
  assert.deepEqual(sentIds, ['burst0', 'other'], 'the other record went out immediately, not behind the burst');
  assert.equal(delivered.length, 8, '8 folded (settled at enqueue)');
  assert.equal(drained.sent.length, 2, '2 sent by the drain');

  // At the threshold nothing is folded: every change is its own stamp, one per record per spacing slot.
  const o = fairSetup();
  o.queue.enqueue(Array.from({ length: 3 }, (_, i) => upd(111, 1, T0 + i, `o${i}`)));
  const slots = o.store.stamps.queuedFor(recordKey(upd(111, 1))).map((q) => q.notBefore - o.clock.t);
  assert.deepEqual(slots, [0, 3_000, 6_000]);
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
          ? { update: x, kind: 'auth', message: 'token revoked' }
          : { update: x, kind: 'ok' },
      ),
    extra: { onPauseExpired: (p) => void expired.push(p) },
  });
  s.queue.enqueue([upd(111, 1, s.clock.t, 'p1'), upd(111, 2, s.clock.t, 'p2'), upd(222, 1, s.clock.t, 'q1')]);
  const r1 = await s.queue.drain();
  assert.equal(r1.dropped.length, 0, 'nothing dropped');
  assert.equal(s.store.stamps.queueSize(), 3, 'queue kept');
  assert.ok(s.store.stamps.getPause(111) && s.store.stamps.getPause(222));

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
  assert.equal(s.store.stamps.getPause(111), undefined);
  await s.queue.drain();
  assert.equal(s.store.stamps.queueSize(), 0);

  // Revoked per the token provider (token_revocations) for > 7 days with NOTHING queued -> uninstall routine.
  const r = fairSetup({ extra: { revoked: { listRevoked: () => [{ portalId: 444, revokedAt: T0 }] }, onPauseExpired: (p) => void expired.push(p) } });
  await r.queue.drain();
  assert.deepEqual(expired, [], 'not yet');
  assert.ok(r.store.stamps.getPause(444), 'paused from the revocation time');
  r.clock.t = T0 + 7 * 24 * 60 * 60_000 + 1;
  await r.queue.drain();
  await r.queue.drain();
  assert.deepEqual(expired, [444], 'uninstall routine called once');
  s.store.close();
  r.store.close();
});

test('pause expiry purges again after a reinstall and a second revocation in the same process', async () => {
  const DAY = 24 * 60 * 60_000;
  let revoked: { portalId: number; revokedAt: number }[] = [{ portalId: 444, revokedAt: T0 }];
  const expired: number[] = [];
  const r = fairSetup({
    extra: {
      revoked: { listRevoked: () => revoked },
      // The uninstall routine: purges the portal's rows (pause included) and its revocation.
      onPauseExpired: (p) => {
        expired.push(p);
        r.store.purgePortal(p);
        revoked = [];
      },
    },
  });
  await r.queue.drain();
  r.clock.t = T0 + 7 * DAY + 1;
  await r.queue.drain();
  assert.deepEqual(expired, [444], 'first episode purged');
  // Reinstall (nothing revoked), then revoked again.
  r.clock.t += DAY;
  await r.queue.drain();
  const second = r.clock.t;
  revoked = [{ portalId: 444, revokedAt: second }];
  await r.queue.drain();
  assert.ok(r.store.stamps.getPause(444), 'paused again');
  r.clock.t = second + 7 * DAY + 1;
  await r.queue.drain();
  assert.deepEqual(expired, [444, 444], 'second episode purged too');
  r.store.close();
});

test('revoked: the real sender pauses on a TokenRevokedError from the token provider (not retried, not dead-lettered)', async () => {
  let calls = 0;
  const s = fairSetup({
    extra: {
      sendBatches: realSender(async () => (calls++, { results: [] }), { getAccessToken: async (p) => { throw new TokenRevokedError(p, T0); } }),
    },
  });
  s.queue.enqueue([upd(111, 1, s.clock.t, 'r1'), upd(111, 2, s.clock.t, 'r2')]);
  const r = await s.queue.drain();
  assert.equal(calls, 0);
  assert.deepEqual([r.sent.length, r.dropped.length, r.failed.length], [0, 0, 2]);
  assert.equal(s.store.stamps.queueSize(), 2, 'queue kept');
  assert.ok(s.store.stamps.getPause(111));
  assert.equal(s.store.stamps.deadLetterCounts().size, 0);
  s.store.close();
});

test('a throttle or a pause is not a failed attempt: the first real failure afterwards backs off by the base delay', async () => {
  let kind: 'throttled' | 'auth' | 'retry' = 'throttled';
  const s = fairSetup({
    sendBatches: async (u) =>
      u.map((x): StampResult => (kind === 'throttled' ? { update: x, kind, retryAfterMs: 1_000, message: '429' } : { update: x, kind, message: kind })),
    extra: { retryBaseMs: 5_000 },
  });
  s.queue.enqueue([upd(111, 1, s.clock.t, 'a1')]);
  await s.queue.drain();
  s.clock.t += 1_000;
  kind = 'auth';
  await s.queue.drain();
  assert.ok(s.store.stamps.getPause(111));
  s.clock.t = s.store.stamps.nextDueAt()!; // the hourly probe
  kind = 'retry';
  await s.queue.drain();
  assert.equal(s.sent.length, 3);
  assert.equal(s.store.stamps.queuedFor(recordKey(upd(111, 1)))[0].notBefore, s.clock.t + 5_000, 'first failed attempt: base back-off (a 2nd would be 10 s)');
  s.store.close();
});

test('revoked: a 401 after refresh pauses the portal (not dead-lettered)', async () => {
  const s = fairSetup({
    extra: {
      sendBatches: realSender(async () => { throw HubSpotError.fromStatus(401, {}, 'POST /crm/objects/2026-09/0-3/batch/update failed with 401: {}'); }),
    },
  });
  s.queue.enqueue([upd(111, 1, s.clock.t, 'z')]);
  await s.queue.drain();
  assert.equal(s.store.stamps.queueSize(), 1);
  assert.equal(s.store.stamps.deadLetterCounts().size, 0);
  assert.ok(s.store.stamps.getPause(111));
  s.store.close();
});

// ---------------------------------------------------------------- single-worker lock

test('worker lock: a second worker refuses to start while the first heartbeats; takes over once it is stale', () => {
  const store = new Store(':memory:');
  const a = new WorkerStore(store.conn);
  const b = new WorkerStore(store.conn);
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
  const metrics = new ChangeCatchMetrics();
  const s = fairSetup({ extra: { metrics } });
  registerWorkerGauges(metrics, s.store);
  s.queue.enqueue([upd(111, 1, s.clock.t - 4_000), upd(111, 1, s.clock.t - 3_000), upd(222, 1, s.clock.t - 2_000)]);
  await s.queue.drain();
  metrics.journalRunOk({ files: 1, events: 3, newestOccurredAtMs: Date.now() - 5_000, caughtUp: true });
  assert.equal(metrics.registry.get('stamps_sent', { portal: 111 }), 1);
  assert.equal(metrics.registry.get('stamp_queue_depth', { portal: 111 }), 1);
  assert.equal(metrics.registry.histogram('e2e_latency_ms')?.count, 2);

  const server = await startHealthServer({
    port: 0, host: '127.0.0.1', healthToken: 'tkn', metrics,
    snapshot: () => healthSnapshot(s.store, s.clock.t, { startedAt: T0, metrics }),
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
