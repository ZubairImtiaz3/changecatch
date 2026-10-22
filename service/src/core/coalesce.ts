// Burst coalescing + per-record slot planning for the persisted stamp queue (scale-review C1 + H4).
// Pure: no HTTP, no DB. Tested in coalesce.test.ts with a fake clock.
//
// ================= CONTRACT FOR THE WORKER (src/worker/stamp-queue.ts enqueue) =================
//   const plan = planEnqueue({
//     fresh,                                    // StampUpdate[] from this journal batch (already filtered "seen")
//     queuedFor: (recordKey) => QueuedSlot[],   // that record's rows still in stamp_queue (any order)
//     lastStampAt: (recordKey) => store.getLastStampAt(k),   // REAL last stamp only, NOT maxQueuedNotBefore
//     now,
//     spacingFor: (portalId) => ms,
//     coalesceFor: (portalId) => CoalesceOptions,             // e.g. () => coalesceOptionsFromEnv(); per-portal later
//   });
//   plan.insert -> store.enqueueStamps(plan.insert, now)          (shape: { changeId, recordKey, update, notBefore })
//   plan.reslot -> UPDATE stamp_queue SET not_before, update      (queued rows whose slot or count property changed)
//   plan.drop   -> wasQueued: DELETE from stamp_queue; all: mark `stamp:<changeId>` seen (so a journal re-read does
//                  not re-queue it). The change stays in change_log. Count them as "delivered (coalesced)".
// Drain: send due rows; group them with planStampBatches (stamp.ts) or chunkStampUpdates (<= 100 per portal+type).
// Concurrency: run enqueue and drain under the same lock (a row being sent must not be reslotted or deleted).
// The earliest pending update of a record is never dropped and, if already queued, keeps its notBefore, so a
// row that is due / being retried is never moved.
//
// ================= WHAT ADMINS GET (workflow semantics) =================
// COALESCE_MODE=off    : every association change = one stamp = one workflow enrollment (spaced >= 3 s per record,
//                        decision D4). 200 contacts linked to one deal -> 200 stamps over ~10 min, 200 enrollments.
// COALESCE_MODE=latest : (default) when a record has MORE than K (COALESCE_THRESHOLD, default 3) changes pending
//                        at once, we stamp only
//                          (a) the next due change (the oldest pending; it reacts immediately), and
//                          (b) the latest change, carrying coalescedCount = how many changes it stands for
//                              (itself + every skipped one). coalescedCount is NOT written to HubSpot (decision D5,
//                              2026-10-30: the changecatch_changes_since_last_stamp property was cut); the worker
//                              logs it and counts it in metrics (stamps_coalesced).
//                        200 contacts linked to one deal -> about 2-3 enrollments (one per journal batch the burst
//                        spans) instead of 200, finished in seconds instead of ~10 min, far fewer API calls.
//   Trade-offs admins must know (put in setup docs):
//   - Every change is still in change_log (and in exports/support), but INTERMEDIATE changes never appear on the
//     record, so they never trigger a workflow. A workflow filtered on a specific label / other record / change
//     type ("label became Billing contact", "contact 123 was removed") can MISS a change that was in the middle
//     of a burst. Workflows that only need "something changed, here is the final state" are unaffected
//     (changecatch_labels_current always shows the final state). Admins who need every change: COALESCE_MODE=off.
//   - Bursts below or at the threshold (<= K pending) are stamped one by one, exactly like off mode.

import {
  compareUpdates,
  recordKey,
  stampIdOf,
  type StampUpdate,
} from './stamp.js';

export type CoalesceMode = 'off' | 'latest';

export interface CoalesceOptions {
  mode: CoalesceMode;
  /** Coalesce when a record has MORE than this many pending stamps. Minimum 2. */
  threshold: number;
}

export const DEFAULT_COALESCE: CoalesceOptions = { mode: 'latest', threshold: 3 };

/** COALESCE_MODE=off|latest (default latest), COALESCE_THRESHOLD=int >= 2 (default 3). Throws on junk. */
export function coalesceOptionsFromEnv(env: Record<string, string | undefined> = process.env): CoalesceOptions {
  const m = (env.COALESCE_MODE ?? '').trim().toLowerCase();
  let mode: CoalesceMode;
  if (m === '' || m === 'latest') mode = 'latest';
  else if (m === 'off') mode = 'off';
  else throw new Error(`Invalid COALESCE_MODE "${env.COALESCE_MODE}". Use "off" or "latest".`);
  const t = (env.COALESCE_THRESHOLD ?? '').trim();
  const threshold = t === '' ? DEFAULT_COALESCE.threshold : Number(t);
  if (!Number.isInteger(threshold) || threshold < 2) throw new Error(`Invalid COALESCE_THRESHOLD "${t}". Use an integer >= 2.`);
  return { mode, threshold };
}

const idOf = stampIdOf;

/** How many changes this update stands for (1 unless it is already a coalesced stamp). */
export function changesCountOf(u: StampUpdate): number {
  const n = u.coalescedCount;
  return n !== undefined && Number.isInteger(n) && n >= 1 ? n : 1;
}

/** Sets coalescedCount (not a HubSpot property: logs + metrics only, decision D5). */
function withCount(u: StampUpdate, n: number): StampUpdate {
  return { ...u, coalescedCount: n };
}

/**
 * One record's pending updates -> which to stamp. Input in any order; output keep/dropped in occurredAt order.
 * off: keep all, untouched. latest: if more than threshold, keep [oldest, newest] and fold the middle into the
 * newest's coalescedCount; otherwise keep all. In latest mode every kept update carries coalescedCount.
 */
export function coalesceRecord(pending: StampUpdate[], opts: CoalesceOptions): { keep: StampUpdate[]; dropped: StampUpdate[] } {
  // Amend stamps (late-half label fixes, no enrollment) are never folded and never count toward the threshold.
  const amends = pending.filter((u) => u.amendOf !== undefined);
  if (amends.length) {
    const r = coalesceRecord(pending.filter((u) => u.amendOf === undefined), opts);
    return { keep: [...r.keep, ...amends].sort(compareUpdates), dropped: r.dropped };
  }
  const all = [...pending].sort(compareUpdates);
  if (opts.mode === 'off') return { keep: all, dropped: [] };
  if (all.length <= Math.max(2, opts.threshold)) return { keep: all.map((u) => withCount(u, changesCountOf(u))), dropped: [] };
  const first = all[0];
  const last = all[all.length - 1];
  const dropped = all.slice(1, -1);
  const folded = dropped.reduce((s, u) => s + changesCountOf(u), changesCountOf(last));
  return { keep: [withCount(first, changesCountOf(first)), withCount(last, folded)], dropped };
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
  coalesceFor?: (portalId: number) => CoalesceOptions;
}

/**
 * Per-record planning for the persisted queue. Only records that appear in `fresh` are touched.
 * Each record is planned on its own timeline (C1): another record's backlog never delays it.
 * Fresh updates whose change id is already queued (journal re-read) are ignored.
 */
export function planEnqueue(args: PlanEnqueueArgs): EnqueuePlan {
  const { now } = args;
  const coalesceFor = args.coalesceFor ?? (() => DEFAULT_COALESCE);
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
      if (seen.has(idOf(u))) continue;
      seen.add(idOf(u));
      newOnes.push(u);
    }
    if (newOnes.length === 0) continue;

    const portalId = freshList[0].portalId;
    const spacing = args.spacingFor(portalId);
    const { keep, dropped } = coalesceRecord([...[...queued.values()].map((q) => q.update), ...newOnes], coalesceFor(portalId));

    let prev = args.lastStampAt(k);
    keep.forEach((u, i) => {
      const id = idOf(u);
      const q = queued.get(id);
      // The oldest queued row keeps its slot: it may be due, in flight or waiting for a retry.
      const notBefore =
        i === 0 && q ? q.notBefore : prev === undefined ? now : Math.max(now, prev + spacing);
      prev = notBefore;
      const slot: PlannedSlot = { changeId: id, recordKey: k, update: u, notBefore };
      if (!q) plan.insert.push(slot);
      else if (q.notBefore !== notBefore || !sameProps(q.update, u)) plan.reslot.push(slot);
    });
    for (const u of dropped) plan.drop.push({ changeId: idOf(u), recordKey: k, update: u, wasQueued: queued.has(idOf(u)) });
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
