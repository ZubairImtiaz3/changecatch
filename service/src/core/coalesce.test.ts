import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changesCountOf,
  coalesceOptionsFromEnv,
  coalesceRecord,
  planEnqueue,
  type CoalesceOptions,
  type EnqueuePlan,
  type QueuedSlot,
} from './coalesce.js';
import { recordKey, type StampUpdate } from './stamp.js';
import { DEAL } from './testutil.js';

const SPACING = 3000;
const OFF: CoalesceOptions = { mode: 'off', threshold: 3 };
const LATEST: CoalesceOptions = { mode: 'latest', threshold: 3 };

const upd = (objectId: string, at: number, portalId = 111): StampUpdate => ({
  portalId,
  objectTypeId: DEAL,
  objectId,
  occurredAtMs: at,
  properties: { changecatch_last_change_id: `${at}-${objectId}` } as StampUpdate['properties'],
});

/** A tiny fake of the persisted queue + last-stamp table, driven by a fake clock. */
function fakeQueue(opts: CoalesceOptions) {
  const queue = new Map<string, QueuedSlot & { recordKey: string }>();
  const last = new Map<string, number>();
  const seen = new Set<string>();
  const enqueue = (fresh: StampUpdate[], now: number): EnqueuePlan => {
    const plan = planEnqueue({
      fresh: fresh.filter((u) => !seen.has(u.properties.changecatch_last_change_id!)),
      queuedFor: (k) => [...queue.values()].filter((q) => q.recordKey === k),
      lastStampAt: (k) => last.get(k),
      now,
      spacingFor: () => SPACING,
      coalesceFor: () => opts,
    });
    for (const s of [...plan.insert, ...plan.reslot]) queue.set(s.changeId, s);
    for (const d of plan.drop) {
      queue.delete(d.changeId);
      seen.add(d.changeId);
    }
    return plan;
  };
  /** Sends at most one due row per record (oldest first), like the worker drain. */
  const drain = (now: number): StampUpdate[] => {
    const due = [...queue.values()].filter((q) => q.notBefore <= now).sort((a, b) => a.update.occurredAtMs - b.update.occurredAtMs);
    const taken = new Set<string>();
    const sent: StampUpdate[] = [];
    for (const q of due) {
      if (taken.has(q.recordKey)) continue;
      taken.add(q.recordKey);
      queue.delete(q.changeId);
      last.set(q.recordKey, now);
      seen.add(q.changeId);
      sent.push(q.update);
    }
    return sent;
  };
  return { queue, enqueue, drain };
}

const hot = (n: number, from = 1) => Array.from({ length: n }, (_, i) => upd('hot', from + i));
const singles = (n: number) => Array.from({ length: n }, (_, i) => upd(`o${i}`, 10_000 + i));

test('coalesceOptionsFromEnv: default latest/3, off, rejects junk', () => {
  assert.deepEqual(coalesceOptionsFromEnv({}), { mode: 'latest', threshold: 3 });
  assert.deepEqual(coalesceOptionsFromEnv({ COALESCE_MODE: 'OFF', COALESCE_THRESHOLD: '5' }), { mode: 'off', threshold: 5 });
  assert.throws(() => coalesceOptionsFromEnv({ COALESCE_MODE: 'merge' }));
  assert.throws(() => coalesceOptionsFromEnv({ COALESCE_THRESHOLD: '1' }));
  assert.throws(() => coalesceOptionsFromEnv({ COALESCE_THRESHOLD: 'x' }));
});

test('coalesceRecord: <= threshold keeps all (count 1); above keeps oldest + latest with folded count', () => {
  const small = coalesceRecord(hot(3).reverse(), LATEST);
  assert.equal(small.keep.length, 3);
  assert.deepEqual(small.keep.map((u) => u.occurredAtMs), [1, 2, 3]);
  assert.ok(small.keep.every((u) => changesCountOf(u) === 1 && u.coalescedCount === 1));

  const big = coalesceRecord(hot(4), LATEST);
  assert.deepEqual(big.keep.map((u) => [u.occurredAtMs, changesCountOf(u)]), [[1, 1], [4, 3]]);
  assert.deepEqual(big.dropped.map((u) => u.occurredAtMs), [2, 3]);

  const off = coalesceRecord(hot(10), OFF);
  assert.equal(off.keep.length, 10);
  assert.equal(off.dropped.length, 0);
  assert.ok(off.keep.every((u) => u.coalescedCount === undefined), 'off mode sets no count');
});

test('planEnqueue off (C1): 200 changes on one record + 100 single changes -> others not delayed, order kept', () => {
  const now = 1_000_000;
  const q = fakeQueue(OFF);
  // Batch 1: the hot record's 200 changes. Batch 2 (1 s later): 100 other records. The old code queued batch 2
  // behind the hot record's tail (now + 600 s).
  const p1 = q.enqueue(hot(200), now);
  assert.equal(p1.insert.length, 200);
  assert.equal(p1.drop.length, 0);
  const p2 = q.enqueue(singles(100), now + 1000);
  assert.equal(p2.insert.length, 100);
  assert.ok(p2.insert.every((s) => s.notBefore === now + 1000), 'other records are due immediately');

  const hotSlots = p1.insert.sort((a, b) => a.update.occurredAtMs - b.update.occurredAtMs);
  assert.equal(hotSlots[0].notBefore, now);
  for (let i = 1; i < hotSlots.length; i++) assert.equal(hotSlots[i].notBefore - hotSlots[i - 1].notBefore, SPACING);
  assert.ok(!hotSlots.some((s) => s.update.coalescedCount !== undefined), 'off mode unchanged');

  // Drain on the fake clock: every stamp is delivered, hot record in occurredAt order, others in the first drain.
  const sent: [number, StampUpdate][] = [];
  for (let t = now + 1000; q.queue.size > 0; t += SPACING) for (const u of q.drain(t)) sent.push([t, u]);
  assert.equal(sent.length, 300);
  assert.ok(sent.filter(([, u]) => u.objectId !== 'hot').every(([t]) => t === now + 1000));
  const hotSent = sent.filter(([, u]) => u.objectId === 'hot');
  assert.deepEqual(hotSent.map(([, u]) => u.occurredAtMs), hot(200).map((u) => u.occurredAtMs));
});

test('planEnqueue latest: 200-change burst -> 2 stamps, counts add up, others not delayed', () => {
  const now = 1_000_000;
  const q = fakeQueue(LATEST);
  const p = q.enqueue([...hot(200), ...singles(100)], now);
  const hotIns = p.insert.filter((s) => s.update.objectId === 'hot').sort((a, b) => a.notBefore - b.notBefore);
  assert.deepEqual(hotIns.map((s) => [s.update.occurredAtMs, s.notBefore, changesCountOf(s.update)]), [
    [1, now, 1],
    [200, now + SPACING, 199],
  ]);
  assert.equal(p.drop.length, 198);
  assert.ok(p.drop.every((d) => !d.wasQueued));
  const others = p.insert.filter((s) => s.update.objectId !== 'hot');
  assert.equal(others.length, 100);
  assert.ok(others.every((s) => s.notBefore === now && s.update.coalescedCount === 1));
});

test('planEnqueue latest: burst spread over journal batches -> ~3 enrollments, total count = changes', () => {
  const now = 1_000_000;
  const q = fakeQueue(LATEST);
  q.enqueue(hot(120, 1), now);
  const sent: StampUpdate[] = [...q.drain(now)]; // oldest goes out at once
  // Next journal batch, 1 s later: 80 more changes while the coalesced latest is still queued.
  const p2 = q.enqueue(hot(80, 121), now + 1000);
  assert.equal(p2.drop.length, 79, 'the 79 middle fresh changes are folded');
  assert.equal(p2.reslot.length, 0, 'the queued latest keeps its slot (it is now the next due one)');
  for (let t = now + SPACING; q.queue.size > 0; t += SPACING) sent.push(...q.drain(t));
  assert.deepEqual(sent.map((u) => [u.occurredAtMs, changesCountOf(u)]), [
    [1, 1],
    [120, 119],
    [200, 80],
  ]);
  assert.equal(sent.reduce((s, u) => s + changesCountOf(u), 0), 200, 'no change is lost from the counts');
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i].occurredAtMs > sent[i - 1].occurredAtMs, 'order kept');
});

test('planEnqueue: re-read of queued ids is ignored; per-portal coalesce override; real last stamp respected', () => {
  const now = 50_000;
  const queued: QueuedSlot[] = [{ changeId: '1-hot', update: upd('hot', 1), notBefore: now + 500 }];
  const plan = planEnqueue({
    fresh: [upd('hot', 1), upd('a', 2, 222), upd('a', 3, 222), upd('a', 4, 222), upd('a', 5, 222)],
    queuedFor: (k) => (k === recordKey(upd('hot', 0)) ? queued : []),
    lastStampAt: (k) => (k === recordKey(upd('a', 0, 222)) ? now - 1000 : undefined),
    now,
    spacingFor: () => SPACING,
    coalesceFor: (p) => (p === 222 ? OFF : LATEST),
  });
  assert.ok(!plan.insert.some((s) => s.update.objectId === 'hot'), 'already queued: nothing new');
  assert.equal(plan.reslot.length, 0);
  const a = plan.insert.map((s) => s.notBefore);
  assert.deepEqual(a, [now + 2000, now + 5000, now + 8000, now + 11000], 'portal 222 is off: 4 stamps, spaced from last stamp');
  assert.equal(plan.drop.length, 0);
});
