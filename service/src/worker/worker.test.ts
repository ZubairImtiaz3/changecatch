import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store, type LabelDefinition } from '../store/db.js';
import { StoreLabelCache } from '../core/labels.js';
import { DEFAULT_DELAY_CONFIG, type DelayConfig, type JournalReadResult } from '../core/poller.js';
import type { StampUpdate } from '../core/stamp.js';
import type { JournalFile } from '../core/types.js';
import { ADD, CONTACT, DEAL, ev, file, REM, T0, UD } from '../core/testutil.js';
import { HttpError } from '../lib/http.js';
import type { BatchUpdateResponse } from '../hubspot/stamp.js';
import type { JournalBatchResponse, JournalFetchResponse } from '../hubspot/journal.js';
import { GuardedLabelCache, LabelHoldError } from './label-guard.js';
import { StampQueue } from './stamp-queue.js';
import { NoPortalTokenError, type TokenProvider } from './tokens.js';
import { Worker } from './main.js';
import { JournalPartialError, makeJournalReader, type JournalApi } from './journal-reader.js';
import { healthSnapshot, StaleAlerter, startHealthServer } from './health.js';
import { LatencyTracker, percentile } from './latency.js';

const LABELS: LabelDefinition[] = [
  { associationTypeId: 3, label: null, category: 'HUBSPOT_DEFINED' },
  { associationTypeId: 101, label: 'Influencer', category: UD },
  { associationTypeId: 102, label: 'Decision maker', category: UD },
];
const quiet = () => {};
const tokens: TokenProvider = {
  async getAccessToken(portalId) {
    if (portalId !== 111 && portalId !== 333) throw new NoPortalTokenError(portalId);
    return 'tok';
  },
};

function fakeJournal(files: JournalFile[]) {
  const reads: (string | null)[] = [];
  const readJournal = async (after: string | null): Promise<JournalReadResult> => {
    reads.push(after);
    const start = after === null ? 0 : files.findIndex((f) => f.offset === after) + 1;
    const batch = files.slice(start);
    return { files: batch, nextOffset: batch.at(-1)?.offset ?? null, full: false };
  };
  return { readJournal, reads };
}

interface SetupOpts {
  store?: Store;
  fetchLabels?: (p: number, f: string, t: string) => Promise<LabelDefinition[]>;
  respond?: (call: number, ids: string[]) => BatchUpdateResponse;
  onUnknownLabel?: (p: number, f: string, t: string) => Promise<void> | void;
  now?: { t: number };
  /** Per-portal spacing (ms), like the settings page value. */
  spacing?: Map<number, number>;
  blockOnFailure?: boolean;
  isParkable?: (e: unknown) => boolean;
  delay?: DelayConfig;
  /** Override the journal reader (default: fakeJournal(files)). */
  readJournal?: (after: string | null) => Promise<JournalReadResult>;
  queueLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

function setup(files: JournalFile[], o: SetupOpts = {}) {
  const store = o.store ?? new Store(':memory:');
  store.setWatchedPairs(111, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
  const clock = o.now ?? { t: T0 + 60_000 };
  const now = () => clock.t;
  const spacing = o.spacing ?? new Map<number, number>();
  const calls: { ids: string[]; at: number; types: string[] }[] = [];
  const stamped: StampUpdate[] = [];
  const labels = new GuardedLabelCache(new StoreLabelCache(store, o.fetchLabels ?? (async () => LABELS), undefined, now), {
    store,
    now,
    log: quiet,
    onUnknownLabel: o.onUnknownLabel,
  });
  const queue = new StampQueue({
    store,
    tokens,
    now,
    log: o.queueLog ?? quiet,
    defaultSpacingMs: 3000,
    spacingFor: (p) => spacing.get(p),
    blockOnFailure: o.blockOnFailure,
    batchUpdate: async (_tok, _type, inputs) => {
      calls.push({ ids: inputs.map((i) => i.id), at: clock.t, types: inputs.map((i) => i.properties.changecatch_change_type) });
      const r = o.respond?.(calls.length, inputs.map((i) => i.id));
      if (r) return r;
      return { status: 'COMPLETE', results: inputs.map((i) => ({ id: i.id })) };
    },
  });
  const j = fakeJournal(files);
  const reads = j.reads;
  const readJournal = o.readJournal ? async (after: string | null) => (reads.push(after), o.readJournal!(after)) : j.readJournal;
  // Fake-clock sleep for loop tests: advances the clock, records when the loop woke up, stops at `until`.
  const wakes: number[] = [];
  let until = Infinity;
  let worker!: Worker;
  const sleep = async (ms: number) => {
    clock.t += ms;
    wakes.push(clock.t);
    if (clock.t >= until) void worker.stop();
  };
  worker = new Worker({
    store, readJournal, labels, queue, now, log: quiet, alerter: new StaleAlerter(1e9, quiet), isParkable: o.isParkable,
    delay: o.delay, sleep,
  });
  const runUntil = async (t: number) => {
    until = t;
    await worker.run();
  };
  return { store, worker, queue, calls, stamped, clock, reads, spacing, wakes, runUntil };
}

const changeLogCount = (s: Store) => Number((s.db.prepare('SELECT COUNT(*) AS n FROM change_log').get() as { n: number }).n);

// ---------------------------------------------------------------- offset vs stamping

test('worker (blockOnFailure): offset only advances after the stamp is accepted', async () => {
  const s = setup(
    [file('f1', [ev({ action: ADD, typeId: 3, at: 0 })]), file('f2', [ev({ action: ADD, typeId: 3, to: [CONTACT, 9], at: 40_000 })])],
    {
      blockOnFailure: true,
      now: { t: T0 + 40_500 }, // f2 (40 s) stays held for pairing during this test (deadline 46 s)
      respond: (call) => { if (call === 1) throw new HttpError(503, {}, 'down'); return undefined as never; },
    },
  );
  assert.equal(await s.worker.readOnce(), null, 'first run fails');
  assert.equal(s.store.getOffset(), null);
  assert.equal(s.store.queueSize(), 1, 'the stamp waits in the persisted queue');
  assert.equal(changeLogCount(s.store), 1, 'change_log written before stamping');

  // Retry not due yet: still held, nothing re-sent.
  assert.equal(await s.worker.readOnce(), null);
  assert.equal(s.store.getOffset(), null);
  assert.equal(s.calls.length, 1);

  s.clock.t += 5_000; // retry backoff
  const r = await s.worker.readOnce();
  assert.ok(r);
  assert.equal(s.store.getOffset(), 'f2');
  assert.equal(s.calls.length, 2);
  assert.equal(s.store.queueSize(), 0);
  assert.equal(s.store.getMetrics(111)?.stampsSent, 1);

  // A later re-read (offset lost) never stamps it again.
  s.store.db.exec('DELETE FROM journal_offset');
  await s.worker.readOnce();
  assert.equal(s.calls.length, 2);
});

test('worker (default): a 5xx on stamping does NOT hold the shared offset; the persisted queue retries', async () => {
  const s = setup(
    [file('f1', [ev({ action: ADD, typeId: 3, at: 0 })]), file('f2', [ev({ portalId: 5, at: 40_000 })])],
    { respond: (call) => { if (call === 1) throw new HttpError(503, {}, 'down'); return undefined as never; } },
  );
  assert.ok(await s.worker.readOnce());
  assert.equal(s.store.getOffset(), 'f2', 'offset moved on');
  assert.equal(s.store.queueSize(), 1, 'the failed stamp waits for its retry');
  s.clock.t += 5_000;
  await s.worker.drainQueue();
  assert.equal(s.calls.length, 2);
  assert.equal(s.store.queueSize(), 0);
  assert.equal(s.store.getMetrics(111)?.stampsSent, 1);
  // A re-read (offset lost) never stamps it again.
  s.store.db.exec('DELETE FROM journal_offset');
  await s.worker.readOnce();
  assert.equal(s.calls.length, 2);
});

// ---------------------------------------------------------------- label hold

test('worker: label fetch failure HOLDS the batch; nothing guessed, nothing stamped', async () => {
  let fail = true;
  const hooks: string[] = [];
  let hookFails = 1;
  const s = setup(
    [file('f1', [ev({ action: ADD, typeId: 3, at: 0 }), ev({ action: ADD, typeId: 101, category: UD, at: 1 })]), file('f2', [ev({ portalId: 5, at: 40_000 })])],
    {
      fetchLabels: async () => {
        if (fail) throw new HttpError(502, {}, 'labels down');
        return LABELS;
      },
      onUnknownLabel: (p, f, t) => {
        hooks.push(`${p}|${f}|${t}`);
        if (hookFails-- > 0) throw new Error('option sync failed');
      },
    },
  );
  assert.equal(await s.worker.readOnce(), null);
  assert.equal(s.store.getOffset(), null);
  assert.equal(changeLogCount(s.store), 0);
  assert.equal(s.calls.length, 0);
  assert.equal(s.store.listLabelHolds().length, 1);
  assert.match(s.store.getLastError()!.message, /labels down/);

  // Labels come back, but the option-sync hook fails once: still held.
  fail = false;
  assert.equal(await s.worker.readOnce(), null);
  assert.equal(s.store.getOffset(), null);
  assert.deepEqual(hooks, ['111|0-3|0-1']);

  // Hook works now: processed with the right name.
  const r = await s.worker.readOnce();
  assert.ok(r);
  assert.equal(hooks.length, 2);
  assert.equal(s.store.getOffset(), 'f2');
  assert.equal(s.store.listLabelHolds().length, 0);
  assert.equal(s.calls.length, 1);
  const row = s.store.db.prepare('SELECT labels_current FROM change_log').get() as { labels_current: string };
  assert.equal(row.labels_current, '0-1:101', 'Influencer (type 101) as its option value');
});

test('worker: unknown label type is held, then given up after the max hold (fallback name)', async () => {
  const s = setup([file('f1', [ev({ action: ADD, typeId: 3, at: 0 }), ev({ action: ADD, typeId: 999, category: UD, at: 1 })]), file('f2', [ev({ portalId: 5, at: 40_000 })])]);
  assert.equal(await s.worker.readOnce(), null);
  assert.equal(s.store.getOffset(), null);
  s.clock.t += 31 * 60_000;
  assert.ok(await s.worker.readOnce());
  assert.equal(s.store.getOffset(), 'f2');
  // The fallback value itself is formatted by src/core/stamp.ts (label options); we only check it went through.
  const row = s.store.db.prepare('SELECT change_type FROM change_log').get() as { change_type: string };
  assert.equal(row.change_type, 'ADDED');
  assert.equal(s.store.listLabelHolds().length, 1, 'hold stays visible on /health');
});

// ---------------------------------------------------------------- persisted spacing queue

test('stamp queue: spacing survives a restart; delayed stamps are not lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-worker-'));
  const path = join(dir, 'db.sqlite');
  try {
    const clock = { t: T0 + 60_000 };
    const files = [
      file('f1', [ev({ action: ADD, typeId: 3, at: 0 })]),
      file('f2', [ev({ action: REM, typeId: 3, at: 10_000 })]), // same deal + contact: 2nd stamp on deal 1
      file('f3', [ev({ portalId: 5, at: 40_000 })]),
    ];
    const a = setup(files, { store: new Store(path), now: clock });
    assert.ok(await a.worker.readOnce());
    assert.equal(a.store.getOffset(), 'f3', 'a stamp waiting for its slot does not block the offset');
    assert.deepEqual(a.calls.map((c) => c.types), [['ADDED']]);
    assert.equal(a.store.queueSize(), 1);
    assert.equal(a.store.nextStampDueAt(), clock.t + 3000);
    a.store.close(); // "crash"

    clock.t += 1000;
    const b = setup([], { store: new Store(path), now: clock });
    await b.worker.drainQueue();
    assert.equal(b.calls.length, 0, 'not due yet after restart');
    clock.t += 2000;
    await b.worker.drainQueue();
    assert.deepEqual(b.calls.map((c) => c.types), [['REMOVED']]);
    assert.equal(b.store.queueSize(), 0);

    // Persisted last-stamp time: a new change 1 s later is spaced 3 s after the last stamp.
    clock.t += 1000;
    const upd: StampUpdate = { portalId: 111, objectTypeId: DEAL, objectId: '1', occurredAtMs: clock.t, properties: { changecatch_last_change_id: 'x1' } as StampUpdate['properties'] };
    b.queue.enqueue([upd]);
    assert.equal(b.store.nextStampDueAt(), clock.t + 2000);

    // Per-portal spacing from the settings page (portals.stamp_spacing_seconds, wired via spacingFor).
    b.spacing.set(111, 10_000);
    const upd2 = { ...upd, objectId: '77', properties: { changecatch_last_change_id: 'x2' } as StampUpdate['properties'] };
    const upd3 = { ...upd2, occurredAtMs: clock.t + 1, properties: { changecatch_last_change_id: 'x3' } as StampUpdate['properties'] };
    b.queue.enqueue([upd2, upd3]);
    const q = b.store.db.prepare("SELECT change_id, not_before FROM stamp_queue WHERE change_id IN ('x2','x3') ORDER BY change_id").all() as { not_before: number }[];
    assert.equal(q[1].not_before - q[0].not_before, 10_000);
    b.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stamp queue: a portal without a token is dropped (not retried, not blocking)', async () => {
  const store = new Store(':memory:');
  const q = new StampQueue({ store, tokens, now: () => T0, log: quiet, batchUpdate: async () => ({ results: [] }) });
  const u: StampUpdate = { portalId: 222, objectTypeId: DEAL, objectId: '1', occurredAtMs: T0, properties: { changecatch_last_change_id: 'z' } as StampUpdate['properties'] };
  const delivered: StampUpdate[] = [];
  await q.sendStamps([u], (d) => delivered.push(...d));
  assert.equal(delivered.length, 1);
  assert.equal(store.queueSize(), 0);
  assert.equal(store.getMetrics(222)?.stampsDropped, 1);
});

// ---------------------------------------------------------------- journal reader: 204, latest, 207

function fakeApi(batches: (JournalBatchResponse | undefined)[], latest: JournalFetchResponse | null = null): JournalApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    latest: async () => (calls.push('latest'), latest),
    batchEarliest: async () => (calls.push('earliest'), batches.shift()),
    batchNext: async (off) => (calls.push(`next:${off}`), batches.shift()),
    download: async (e) => ({ offset: e.currentOffset, journalEvents: [] }),
  };
}
const entry = (o: string): JournalFetchResponse => ({ url: `https://x/${o}`, expiresAt: '2999-01-01T00:00:00Z', currentOffset: o });
const batch = (ok: string[], failed: string[] = []): JournalBatchResponse => ({
  status: 'COMPLETE', startedAt: '', completedAt: '',
  results: ok.map(entry),
  numErrors: failed.length,
  errors: failed.map((o) => ({ status: 'PRESIGNING_ERROR', message: 'x', context: { offset: [o] } })),
});

test('journal reader: first start uses latest (not earliest); 204 = empty', async () => {
  const store = new Store(':memory:');
  const api = fakeApi([undefined], entry('01a0'));
  const read = makeJournalReader(api, { store, log: quiet });
  const r1 = await read(null);
  assert.deepEqual(api.calls, ['latest']);
  assert.equal(r1.nextOffset, '01a0');
  const r2 = await read('01a0');
  assert.deepEqual(r2, { files: [], nextOffset: null, full: false });
});

test('journal reader: HTTP 207 keeps only entries before the first failed offset, skips after the limit', async () => {
  const store = new Store(':memory:');
  let now = T0;
  const api = fakeApi([
    batch(['01a1', '01a2', '01a4'], ['01a3']),
    batch(['01a4'], ['01a3']),
    batch(['01a4'], ['01a3']),
    { ...batch(['01a1']), numErrors: 1, errors: [{ status: 'PRESIGNING_ERROR', message: 'no context' }] },
  ]);
  const read = makeJournalReader(api, { store, log: quiet, now: () => now, skipAfterMs: 30 * 60_000 });

  const r1 = await read('01a0');
  assert.deepEqual(r1.files.map((f) => f.offset), ['01a1', '01a2']);
  assert.equal(r1.nextOffset, '01a2', 'never jumps over the failed entry');
  assert.equal(r1.full, true, 'read again soon');

  await assert.rejects(read('01a2'), JournalPartialError, 'failed entry first: nothing to process, retry later');

  now += 31 * 60_000;
  const r3 = await read('01a2');
  assert.deepEqual(r3.files.map((f) => f.offset), ['01a4'], 'skipped after failing for 30+ min');

  // An error without an offset: we can't tell what failed, so nothing is processed.
  await assert.rejects(read('01a0'), /failed offset unknown/);
});

test('journal reader: 404 on batch-next (expired offset) restarts from earliest with an alert', async () => {
  const store = new Store(':memory:');
  const lines: string[] = [];
  const api = fakeApi([batch(['01b1', '01b2'])]);
  api.batchNext = async (off) => {
    api.calls.push(`next:${off}`);
    throw new HttpError(404, {}, 'offset not found');
  };
  const read = makeJournalReader(api, { store, log: (_l, m) => lines.push(m) });
  const r = await read('00old');
  assert.deepEqual(api.calls, ['next:00old', 'earliest']);
  assert.deepEqual(r.files.map((f) => f.offset), ['01b1', '01b2']);
  assert.match(lines[0], /^\[ALERT\]/);
  assert.equal(JSON.parse(store.getState('journal_offset_reset')!).from, '00old');
  // Other errors still throw (offset kept).
  api.batchNext = async () => { throw new HttpError(500, {}, 'boom'); };
  await assert.rejects(read('01b2'), /boom/);
});

test('worker: a 207 partial read advances the offset only to the last good file', async () => {
  const store = new Store(':memory:');
  const api = fakeApi([batch(['01a1', '01a2', '01a4'], ['01a3'])]);
  store.setOffset('01a0');
  const read = makeJournalReader(api, { store, log: quiet });
  const s = setup([], { store });
  const w = new Worker({ store, readJournal: read, labels: new StoreLabelCache(store, async () => LABELS), queue: s.queue, log: quiet, alerter: new StaleAlerter(1e9, quiet) });
  const r = await w.readOnce();
  assert.equal(r?.offset, '01a2');
  assert.equal(r?.batchFull, true);
});

// ---------------------------------------------------------------- shutdown

test('worker: stop() lets the batch in progress finish and persist its offset', async () => {
  const store = new Store(':memory:');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const inRead = new Promise<void>((r) => (started = r));
  let reads = 0;
  const readJournal = async (): Promise<JournalReadResult> => {
    reads++;
    started();
    await gate;
    return { files: [file('f1', [])], nextOffset: 'f1', full: false };
  };
  const s = setup([], { store });
  const w = new Worker({ store, readJournal, labels: new StoreLabelCache(store, async () => LABELS), queue: s.queue, log: quiet, alerter: new StaleAlerter(1e9, quiet) });
  const loop = w.run();
  await inRead;
  const stopped = w.stop();
  release();
  await stopped;
  await loop;
  assert.equal(store.getOffset(), 'f1', 'offset of the finished batch saved');
  assert.equal(reads, 1, 'no new read after stop');
});

test('worker: stop() wakes the loop from its sleep', async () => {
  const store = new Store(':memory:');
  const s = setup([], { store });
  const w = new Worker({
    store,
    readJournal: async () => ({ files: [], nextOffset: null, full: false }),
    labels: new StoreLabelCache(store, async () => LABELS),
    queue: s.queue,
    log: quiet,
    alerter: new StaleAlerter(1e9, quiet),
  });
  const loop = w.run();
  await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  await w.stop();
  await loop;
  assert.ok(Date.now() - t0 < 1000);
});

// ---------------------------------------------------------------- health

test('health: 200 when fresh, 503 + alert line when no successful read for 1 h', async () => {
  const store = new Store(':memory:');
  let now = Date.now();
  const server = await startHealthServer({ port: 0, host: '127.0.0.1', healthToken: 'sekret', snapshot: () => healthSnapshot(store, now, now) });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
  try {
    store.setLastSuccessfulReadAt(now);
    store.addMetrics(111, { events: 2, changes: 1, occurrences: 1 }, now);
    let res = await fetch(url);
    assert.equal(res.status, 200);
    const pub = (await res.json()) as any;
    assert.equal(pub.status, 'ok');
    assert.equal(pub.portals, undefined, 'no portal ids without the token');
    assert.equal(pub.totals.portals, 1);
    assert.ok(!/portalId|portal=/.test(JSON.stringify(pub)), 'portal ids not leaked');
    assert.equal((await (await fetch(url, { headers: { 'x-health-token': 'wrong' } })).json() as any).portals, undefined);
    const body = (await (await fetch(url, { headers: { 'x-health-token': 'sekret' } })).json()) as any;
    assert.equal(body.portals[0].portalId, 111);

    now += 61 * 60_000;
    res = await fetch(url);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as any).status, 'stale');

    const lines: string[] = [];
    const alerter = new StaleAlerter(15 * 60_000, (m) => lines.push(m));
    assert.equal(alerter.check(store, now), true);
    alerter.check(store, now + 1000);
    assert.equal(lines.length, 1, 'not repeated within 15 min');
    assert.match(lines[0], /^\[ALERT\]/);
    assert.equal((await fetch(url.replace('/health', '/nope'))).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------- per-portal parking

test('worker: one portal\'s label failure PARKS only that portal; the offset moves on; parked entries are retried', async () => {
  let fail111 = true;
  const s = setup(
    [
      file('f1', [ev({ action: ADD, typeId: 101, category: UD, at: 0 })]), // portal 111 (labels fail)
      file('f2', [ev({ portalId: 333, action: ADD, typeId: 3, at: 1_000 })]), // portal 333 (fine)
      file('f3', [ev({ portalId: 5, at: 40_000 })]), // moves the stream past the pairing window
    ],
    {
      fetchLabels: async (p) => {
        if (p === 111 && fail111) throw new HttpError(502, {}, 'labels down');
        return LABELS;
      },
      isParkable: (e) => e instanceof LabelHoldError,
    },
  );
  s.store.setWatchedPairs(333, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
  const r1 = await s.worker.readOnce();
  assert.ok(r1, 'run succeeds');
  assert.deepEqual(r1.parkedPortals, [111]);
  assert.equal(s.store.getOffset(), 'f3', 'offset moved on for everyone');
  assert.equal(s.store.parkedCount(), 1);
  assert.deepEqual(s.calls.map((c) => c.types), [['ADDED']], 'portal 333 stamped');
  assert.match(s.store.getMetrics(111)!.lastError!, /parked/);

  // Still failing: stays parked, nothing lost, nothing stamped.
  assert.deepEqual((await s.worker.readOnce())!.parkedPortals, [111]);
  assert.equal(s.store.parkedCount(), 1);

  // Labels back: the parked entry is processed with the right name.
  fail111 = false;
  s.clock.t += 60_000;
  const r3 = await s.worker.readOnce();
  assert.deepEqual(r3!.parkedPortals, []);
  assert.equal(s.store.parkedCount(), 0, 'unparked (now in the normal pairing window)');
  s.clock.t += 60_000;
  await s.worker.readOnce();
  assert.equal(s.calls.length, 2);
  const row = s.store.db.prepare('SELECT label_after FROM change_log WHERE portal_id = 111').get() as { label_after: string };
  assert.equal(row.label_after, '0-1:101', 'Influencer (type 101)');
});

test('worker: a parked entry whose pair is no longer watched (uninstall wiped the pairs) is dropped', async () => {
  const s = setup([file('f1', [ev({ action: ADD, typeId: 101, category: UD, at: 0 })])], {
    fetchLabels: async () => { throw new HttpError(502, {}, 'labels down'); },
    isParkable: (e) => e instanceof LabelHoldError,
  });
  await s.worker.readOnce();
  assert.equal(s.store.parkedCount(), 1);
  s.store.setWatchedPairs(111, []);
  await s.worker.readOnce();
  assert.equal(s.store.parkedCount(), 0);
  assert.equal(s.calls.length, 0);
});

// ---------------------------------------------------------------- latency (fake clock, 2026-10-30)

test('loop: a UI label edit with NO later events is stamped at occurredAt + window + slack (wakes exactly then)', async () => {
  // Halves 33 ms apart in one file. First read 2 s after the edit (HubSpot publish delay).
  const s = setup(
    [file('f1', [ev({ action: REM, typeId: 101, category: UD, at: 0 }), ev({ action: ADD, typeId: 102, category: UD, at: 33 })])],
    { now: { t: T0 + 2_000 } },
  );
  await s.runUntil(T0 + 20_000);
  const deadline = T0 + 33 + 2_000 + 4_000;
  assert.equal(s.calls.length, 1, 'stamped once');
  assert.deepEqual(s.calls[0].types, ['LABEL_CHANGED']);
  assert.equal(s.calls[0].at, deadline, 'stamped exactly at the hold deadline, not at the next poll or a later event');
  assert.ok(s.wakes.includes(deadline), 'the loop woke exactly at the deadline');
  assert.deepEqual(s.wakes.slice(0, 2), [T0 + 5_000, deadline], 'poll at +3 s, then the deadline (earlier than the next poll)');
  const st = s.worker.latencyStats();
  assert.equal(st.count, 1);
  assert.equal(st.p50Ms, deadline - T0 - 33, 'occurredAt (newest half) -> stamped');
  assert.ok(st.p95Ms! <= 10_000, 'within the 10 s target');
});

test('loop: polls every 3 s when idle (no long back-off)', async () => {
  const s = setup([], { now: { t: T0 } });
  await s.runUntil(T0 + 15_000);
  assert.deepEqual(s.wakes, [3, 6, 9, 12, 15].map((n) => T0 + n * 1000));
  assert.equal(s.reads.length, 5, 'one read per wake-up before the stop (the stop wake does not read)');
});

test('loop: a due stamp (spacing slot) is flushed on its own wake-up WITHOUT a journal read', async () => {
  // Link then unlink of the same record 2.5 s apart -> two changes for one record; spacing 3 s.
  const s = setup(
    [file('f1', [ev({ action: ADD, typeId: 3, at: 0 }), ev({ action: REM, typeId: 3, at: 2_500 })])],
    { now: { t: T0 + 10_000 }, delay: { ...DEFAULT_DELAY_CONFIG, pollMs: 60_000, idleMaxMs: 60_000 } },
  );
  await s.runUntil(T0 + 20_000);
  assert.deepEqual(s.calls.map((c) => [c.at, c.types[0]]), [[T0 + 10_000, 'ADDED'], [T0 + 13_000, 'REMOVED']]);
  assert.equal(s.reads.length, 1, 'only the first read; the second stamp went out on the queue wake-up');
  assert.equal(s.wakes[0], T0 + 13_000);
});

test('loop: full batch re-reads immediately; failures back off exponentially, separately from polling', async () => {
  let n = 0;
  const s = setup([], {
    now: { t: T0 },
    readJournal: async () => {
      n++;
      if (n <= 3) throw new Error('journal 503');
      if (n === 4) return { files: [file('f1', [])], nextOffset: 'f1', full: true };
      return { files: [], nextOffset: null, full: false };
    },
  });
  const readTimes: number[] = [];
  const orig = s.worker.readOnce.bind(s.worker);
  s.worker.readOnce = async () => {
    readTimes.push(s.clock.t);
    return orig();
  };
  await s.runUntil(T0 + 40_000);
  // fail @0 -> +5 s, fail @5 -> +10 s, fail @15 -> +20 s, ok+full @35 -> at once, empty @35 -> +3 s ...
  assert.deepEqual(readTimes.slice(0, 6), [0, 5_000, 15_000, 35_000, 35_000, 38_000].map((x) => T0 + x));
  assert.equal(s.store.getConsecutiveErrors(), 0);
});

test('stamp queue: one log line per stamped change with its end-to-end latency; /health shows p50/p95', async () => {
  const lines: string[] = [];
  const s = setup([file('f1', [ev({ action: ADD, typeId: 3, at: 0 }), ev({ action: ADD, typeId: 3, from: [DEAL, 5], to: [CONTACT, 9], at: 0 })])], {
    now: { t: T0 + 7_000 },
    queueLog: (_l, m) => void lines.push(m),
  });
  await s.worker.readOnce();
  const stamped = lines.filter((l) => l.startsWith('stamped '));
  assert.equal(stamped.length, 2);
  assert.match(stamped[0], /^stamped portal 111 0-3\/(1|5) ADDED change \S+: 7\.0s after occurredAt$/);
  const h = healthSnapshot(s.store, s.clock.t, T0, undefined, s.worker.latencyStats());
  assert.equal(h.latency?.count, 2);
  assert.equal(h.latency?.p50Ms, 7_000);
  assert.equal(h.latency?.p95Ms, 7_000);
});

test('latency tracker: nearest-rank p50/p95 over a rolling window', () => {
  assert.equal(percentile([], 50), null);
  const t = new LatencyTracker(100);
  for (let i = 1; i <= 100; i++) t.record(i * 100);
  let st = t.stats();
  assert.deepEqual([st.count, st.p50Ms, st.p95Ms, st.maxMs, st.lastMs], [100, 5_000, 9_500, 10_000, 10_000]);
  for (let i = 0; i < 100; i++) t.record(1_000); // window rolls over
  st = t.stats();
  assert.deepEqual([st.count, st.p50Ms, st.p95Ms, st.totalSamples], [100, 1_000, 1_000, 200]);
});
