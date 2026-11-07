// Burst coalescing + per-record slot planning for the persisted stamp queue.
// Pure: no HTTP, no DB. The worker's StampQueue (src/worker/stamp-queue.ts) applies the plan under its queue lock.
// What admins get from coalescing (and its trade-off) is in docs/architecture.md ("Coalescing").
// coalescedCount is NOT written to HubSpot (decision D5): it lives in logs and the stamps_coalesced metric.

import { compareUpdates, stampIdOf, type StampUpdate } from './stamp.js';
import { recordKey } from './keys.js';

/** Coalesce when a record has MORE than this many pending stamps. */
export const COALESCE_THRESHOLD = 3;

/** How many changes this update stands for (1 unless it is already a coalesced stamp). */
export function changesCountOf(u: StampUpdate): number {
  const n = u.coalescedCount;
  return n !== undefined && Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * One record's pending updates -> which to stamp. Input in any order; output keep/dropped in occurredAt order.
 * More than COALESCE_THRESHOLD: keep [oldest, newest] and fold the middle into the newest's coalescedCount; otherwise keep all.
 * Every kept update carries coalescedCount.
 */
export function coalesceRecord(pending: StampUpdate[]): { keep: StampUpdate[]; dropped: StampUpdate[] } {
  // Amend stamps (late-half label fixes, no enrollment) are never folded and never count toward the threshold.
  const amends = pending.filter((u) => u.amendOf !== undefined);
  if (amends.length) {
    const r = coalesceRecord(pending.filter((u) => u.amendOf === undefined));
    return { keep: [...r.keep, ...amends].sort(compareUpdates), dropped: r.dropped };
  }
  const all = [...pending].sort(compareUpdates);
  if (all.length <= COALESCE_THRESHOLD) return { keep: all.map((u) => ({ ...u, coalescedCount: changesCountOf(u) })), dropped: [] };
  const first = all[0];
  const last = all[all.length - 1];
  const dropped = all.slice(1, -1);
  const folded = dropped.reduce((s, u) => s + changesCountOf(u), changesCountOf(last));
  return { keep: [{ ...first, coalescedCount: changesCountOf(first) }, { ...last, coalescedCount: folded }], dropped };
}

/** A row already in stamp_queue. */
export interface QueuedSlot {
  changeId: string;
  update: StampUpdate;
  notBefore: number;
}

/** Same shape as the items store.enqueueStamps takes. */
export interface PlannedSlot {
  changeId: string;
  recordKey: string;
  update: StampUpdate;
  notBefore: number;
}

export interface EnqueuePlan {
  /** New rows for stamp_queue. */
  insert: PlannedSlot[];
  /** Existing rows whose notBefore or coalescedCount changed. */
  reslot: PlannedSlot[];
  /** Coalesced away: never stamped. Still in change_log. wasQueued = delete the row from stamp_queue. */
  drop: { changeId: string; recordKey: string; update: StampUpdate; wasQueued: boolean }[];
}

export interface PlanEnqueueArgs {
  fresh: StampUpdate[];
  queuedFor: (recordKey: string) => QueuedSlot[];
  /** The record's last ACTUAL stamp time (not queued slots). */
  lastStampAt: (recordKey: string) => number | undefined;
  now: number;
  spacingFor: (portalId: number) => number;
}

/**
 * Per-record planning for the persisted queue. Only records that appear in `fresh` are touched.
 * Each record is planned on its own timeline: another record's backlog never delays it.
 * Fresh updates whose change id is already queued (journal re-read) are ignored.
 */
export function planEnqueue(args: PlanEnqueueArgs): EnqueuePlan {
  const { now } = args;
  const plan: EnqueuePlan = { insert: [], reslot: [], drop: [] };

  const freshByRecord = new Map<string, StampUpdate[]>();
  for (const u of args.fresh) {
    const k = recordKey(u);
    (freshByRecord.get(k) ?? freshByRecord.set(k, []).get(k)!).push(u);
  }

  for (const [k, freshList] of freshByRecord) {
    const queued = new Map(args.queuedFor(k).map((q) => [q.changeId, q]));
    const seen = new Set(queued.keys());
    const newOnes: StampUpdate[] = [];
    for (const u of freshList) {
      if (seen.has(stampIdOf(u))) continue;
      seen.add(stampIdOf(u));
      newOnes.push(u);
    }
    if (newOnes.length === 0) continue;

    const portalId = freshList[0].portalId;
    const spacing = args.spacingFor(portalId);
    const { keep, dropped } = coalesceRecord([...[...queued.values()].map((q) => q.update), ...newOnes]);

    let prev = args.lastStampAt(k);
    keep.forEach((u, i) => {
      const id = stampIdOf(u);
      const q = queued.get(id);
      // The oldest queued row keeps its slot: it may be due, in flight or waiting for a retry.
      const notBefore =
        i === 0 && q ? q.notBefore : prev === undefined ? now : Math.max(now, prev + spacing);
      prev = notBefore;
      const slot: PlannedSlot = { changeId: id, recordKey: k, update: u, notBefore };
      if (!q) plan.insert.push(slot);
      else if (q.notBefore !== notBefore || !sameProps(q.update, u)) plan.reslot.push(slot);
    });
    for (const u of dropped) plan.drop.push({ changeId: stampIdOf(u), recordKey: k, update: u, wasQueued: queued.has(stampIdOf(u)) });
  }
  return plan;
}

function sameProps(a: StampUpdate, b: StampUpdate): boolean {
  const ka = Object.keys(a.properties) as (keyof StampUpdate['properties'])[];
  const kb = Object.keys(b.properties);
  return (
    changesCountOf(a) === changesCountOf(b) && ka.length === kb.length && ka.every((key) => a.properties[key] === b.properties[key])
  );
}
