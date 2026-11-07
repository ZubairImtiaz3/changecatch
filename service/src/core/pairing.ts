import { offsetTimeMs } from './journal-offset.js';
import { pairKey } from './keys.js';
import { HUBSPOT_DEFINED, type AssociationEntry, type ChangeType, type LabelRef, type PairedChange, type PendingEntry } from './types.js';

/*
 * Turns raw ASSOCIATION_ADDED / ASSOCIATION_REMOVED events into user-level changes.
 *
 * "Structural" type = the association type that means "these two records are linked at all"
 * (the unlabeled default). Every other type is a label.
 *
 * ASSUMPTIONS (status from real journal data captured 2026-10-30):
 *  A1. CONFIRMED. A label edit shows up as REMOVED(old typeId) + ADDED(new typeId) for the same two
 *      records, ~100 ms apart. The ADDED can come FIRST, so pairing is order-insensitive (net counts).
 *  A2. CONFIRMED. Linking two records always produces an ADDED of the structural type, and a full
 *      unlink always produces a REMOVED of it (same occurredAt as the label REMOVEDs). Adding or
 *      removing only a label does NOT touch the structural type.
 *      BUT the structural type is not always HUBSPOT_DEFINED:
 *        - standard pairs (e.g. Deal->Contact typeId 3): HUBSPOT_DEFINED, label null.
 *        - custom object pairs (e.g. Car->Contact 125, Pets->Contact 163): USER_DEFINED, label null.
 *      Rule: a type is structural if its label definition has `label === null` (any category).
 *      Only when the label for a typeId is unknown do we fall back to category === HUBSPOT_DEFINED.
 *      The rule is injected as `isStructural` (labels.ts buildStructuralCheck, called by poller.ts).
 *      So structural events only mean "link created / link removed" and are never paired as labels, and a label
 *      added or removed on its own (no structural event alongside) is a LABEL_CHANGED, never ADDED / REMOVED.
 *  A3. CONFIRMED: one direction only. Each change appears once, from the subscribed object's side.
 *      Mirror events (B->A copies of A->B) are still collapsed, as a harmless safety net in case that ever changes.
 *  A4. The journal is roughly ordered by time, so once we have seen an event that occurred well
 *      after a cluster's window, no more partners for that cluster will arrive.
 *  A5. (2026-10-30 latency work) HubSpot publishes a journal file ~1-4 s after occurredAt. So when a read
 *      has reached the head of the journal (batch not full), a cluster whose newest event is older than
 *      window + publish slack (wall clock) cannot get a partner any more: release it at that DEADLINE,
 *      without waiting for some later, unrelated event. maxHoldMs stays as a safety cap.
 *  A6. (load test `mixed`, 2026-10-30) A4/A5 do NOT hold under load. One batch unlink of 100 deals (all events with
 *      the IDENTICAL occurredAt) was spread over 5 journal files published 29.4-33.3 s (UUIDv7 offset times, i.e.
 *      1.5-5.4 s after occurredAt), and the worker only SAW them at +7.6 s and +13.6 s (a file published at +4.6 s
 *      was not visible yet at +7.6 s). A pair's structural REMOVED sat in one file and its label REMOVED in a later
 *      one. The first read was already past the occurredAt deadline (A5), so the structural half went out alone as
 *      REMOVED and the label half later as LABEL_CHANGED "(unknown)" (25 of 100 pairs; 12 more the other way round).
 *      Rule: a cluster that may be HALF of a change (only structural events, or only label events of one action)
 *      is also held until splitHoldMs after the publish time of its newest journal file (the UUIDv7 offset time):
 *      on the wall clock when caught up, or once a file that much newer has been read (backlog). Partner files
 *      were published <= 3.9 s apart and visible <= ~8.2 s after publishing (A7 below sets the hold).
 *      A cluster with both structural and label events, or a label swap (label REMOVED + ADDED), describes a
 *      whole change and keeps the fast rules. Offsets that are not UUIDv7 (tests) skip the split hold.
 *  A7. (load test `mixed` 04:12 UTC, 1,300 ops) Even an 8 s split hold is not enough: halves of one action (IDENTICAL
 *      occurredAt) were published further apart than that, so 47/301 deals ended on "(unknown)" and late halves became
 *      280 extra change_log rows. Correctness no longer depends on this timing: late-half ABSORPTION (absorb.ts)
 *      remembers emitted actions for 10 min and absorbs / amends / converts a late half instead of emitting it.
 *      The split hold is now only an optimisation (fewer amends, fewer double enrollments for label-first splits):
 *      default 4 s, see PairingConfig.splitHoldMs.
 *
 * When is a held cluster released? The FIRST of:
 *   1. stream moved on:  latest occurredAt seen >= cluster start + windowMs + ORDERING_SLACK_MS
 *   2. deadline:         caughtUp && now >= max occurredAt in cluster + windowMs + publishDelaySlackMs
 *   3. safety cap:       now >= holdUntil (first time held + maxHoldMs)
 * A possibly-half cluster (A6) needs 1 or 2 AND its split hold to have passed (3 always releases).
 */

/** True if this association type means "linked at all" (no label). */
export type StructuralCheck = (portalId: number, ref: LabelRef) => boolean;

/** Fallback when no label info is available: HUBSPOT_DEFINED = structural. */
export const categoryIsStructural: StructuralCheck = (_portalId, r) => r.associationCategory === HUBSPOT_DEFINED;

export interface PairingConfig {
  /**
   * Events for the same two records within this many ms of the first one form one change.
   * Measured halves of a label edit: UI 33 ms apart (same journal file), API 108 ms apart; full
   * links/unlinks share one occurredAt. 2000 ms is ~18x the worst case seen and well below the ~3 s per-record
   * stamp spacing, so two separate user edits on one link are still very unlikely to merge.
   */
  windowMs: number;
  /**
   * Wall-clock allowance for HubSpot's journal publish delay (~1-4 s after occurredAt). A held cluster is
   * released once now >= its newest occurredAt + windowMs + this (only when the read reached the journal head).
   */
  publishDelaySlackMs: number;
  /** Safety cap on how long we hold an unclosed cluster waiting for partners (wall-clock ms from first hold). */
  maxHoldMs: number;
  /**
   * A6: a cluster that may be half of a change (only structural events, or only label events of one action) is
   * held until this many ms after the publish time (UUIDv7 offset) of its newest journal file: wall clock when
   * caught up, journal offset time while catching up. Keep it below maxHoldMs. 0 = off.
   * Default 4000 (PAIRING_SPLIT_HOLD_MS). Since late-half absorption (A7) a missed partner no longer causes a wrong
   * result, so this only trades latency for fewer corrections: partner files were published <= 3.9 s apart in the
   * typical case (A6), so 4 s pairs most splits up front (no amend stamp, one enrollment even for label-first splits),
   * while adding at most 4 s to an unlabeled link/unlink or a single-label edit (against a ~10 s p50
   * latency target). Anything later is absorbed (structural-first) or converted (label-first).
   */
  splitHoldMs: number;
}

export const DEFAULT_PAIRING_CONFIG: PairingConfig = {
  windowMs: 2000,
  publishDelaySlackMs: 4000,
  maxHoldMs: 60_000,
  splitHoldMs: 4_000,
};

/** Extra margin for out-of-order journal files before a cluster counts as closed by the stream watermark. */
const ORDERING_SLACK_MS = 2000;

export interface PairingResult {
  changes: PairedChange[];
  stillPending: PendingEntry[];
  /** Earliest wall-clock time a still-pending cluster will be released (deadline or holdUntil). null = none held. */
  nextReleaseAt: number | null;
}

/** Wall-clock time at which a cluster (sorted by occurredAt) no longer expects partners. */
export function clusterDeadline(newestOccurredAtMs: number, config: PairingConfig): number {
  return newestOccurredAtMs + config.windowMs + config.publishDelaySlackMs;
}

interface Item {
  entry: AssociationEntry;
  holdUntil?: number;
  seq: number;
}

function entryPairKey(e: AssociationEntry): string {
  const ev = e.event;
  return pairKey(ev.portalId, ev.fromObjectTypeId, ev.fromObjectId, ev.toObjectTypeId, ev.toObjectId);
}

function sameDirection(a: AssociationEntry, b: AssociationEntry): boolean {
  return (
    a.event.fromObjectTypeId === b.event.fromObjectTypeId &&
    String(a.event.fromObjectId) === String(b.event.fromObjectId)
  );
}

export interface PairingInput {
  /** New entries, already de-duplicated. */
  entries: AssociationEntry[];
  /** Entries held from the last run. */
  pending: PendingEntry[];
  now: number;
  config: PairingConfig;
  /** Latest occurredAt seen in the whole stream, including events filtered out before pairing. */
  streamWatermarkMs?: number;
  /** Which types mean "linked at all" (buildStructuralCheck). */
  isStructural: StructuralCheck;
  /**
   * True when the read reached the head of the journal (batch not full). Only then may the wall-clock
   * deadline release a cluster: during a backlog catch-up, a partner may still be in an unread file.
   */
  caughtUp: boolean;
}

/** Pure: (new entries, entries held from last run, now, config) -> changes + entries still on hold. */
export function pairAssociations({
  entries,
  pending,
  now,
  config,
  streamWatermarkMs = -Infinity,
  isStructural,
  caughtUp,
}: PairingInput): PairingResult {
  let seq = 0;
  const items: Item[] = [
    ...pending.map((p) => ({ entry: p.entry, holdUntil: p.holdUntil, seq: seq++ })),
    ...entries.map((entry) => ({ entry, seq: seq++ })),
  ];
  items.sort((a, b) => a.entry.occurredAtMs - b.entry.occurredAtMs || a.seq - b.seq);

  // Latest event time we have seen anywhere in the (app-wide) stream: our "the stream has moved past" signal.
  const watermark = items.reduce((m, i) => Math.max(m, i.entry.occurredAtMs), streamWatermarkMs);
  // Newest journal publish time (UUIDv7 offset) among our entries: the backlog-safe "journal moved on" signal (A6).
  const offsetWatermark = items.reduce((m, i) => {
    const t = offsetTimeMs(i.entry.fileOffset);
    return t === null ? m : Math.max(m, t);
  }, -Infinity);

  const groups = new Map<string, Item[]>();
  for (const it of items) {
    const k = entryPairKey(it.entry);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(it);
  }

  const changes: PairedChange[] = [];
  const stillPending: PendingEntry[] = [];
  let nextReleaseAt: number | null = null;

  for (const group of groups.values()) {
    for (const cluster of clusterByWindow(group, config.windowMs)) {
      const start = cluster[0].entry.occurredAtMs;
      const streamMovedOn = watermark >= start + config.windowMs + ORDERING_SLACK_MS;
      const holds = cluster.map((c) => c.holdUntil).filter((h): h is number => h !== undefined);
      const holdUntil = holds.length ? Math.min(...holds) : now + config.maxHoldMs;
      const timedOut = now >= holdUntil;
      const deadline = clusterDeadline(cluster[cluster.length - 1].entry.occurredAtMs, config);
      const deadlinePassed = caughtUp && now >= deadline;

      // A6: a possibly-half cluster also waits until its other half can no longer be on its way.
      let splitReleaseAt = -Infinity;
      let splitSafe = true;
      const fileTimes = cluster.map((c) => offsetTimeMs(c.entry.fileOffset));
      const newestFile = fileTimes.includes(null) ? null : Math.max(...(fileTimes as number[]));
      if (config.splitHoldMs > 0 && newestFile !== null && mayBeHalf(cluster.map((c) => c.entry), isStructural)) {
        splitReleaseAt = newestFile + config.splitHoldMs;
        splitSafe = (caughtUp && now >= splitReleaseAt) || offsetWatermark >= splitReleaseAt;
      }

      if (timedOut || ((streamMovedOn || deadlinePassed) && splitSafe)) {
        const change = interpretCluster(cluster.map((c) => c.entry), isStructural);
        if (change) changes.push(change);
      } else {
        for (const c of cluster) stillPending.push({ entry: c.entry, holdUntil });
        const releaseAt = Math.min(Math.max(deadline, splitReleaseAt), holdUntil);
        nextReleaseAt = nextReleaseAt === null ? releaseAt : Math.min(nextReleaseAt, releaseAt);
      }
    }
  }

  changes.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  return { changes, stillPending, nextReleaseAt };
}

/**
 * A6: true if this cluster may be only half of one user action whose other half is still in an unread journal
 * file: only structural events (a link/unlink whose label events may follow), or only label events of a single
 * action (a label added/removed on its own, or the label half of a link/unlink). Structural + label events, or a
 * label REMOVED + ADDED swap, describe a whole change.
 */
export function mayBeHalf(cluster: AssociationEntry[], isStructural: StructuralCheck): boolean {
  let structural = false;
  let labelAdded = false;
  let labelRemoved = false;
  for (const e of cluster) {
    if (isStructural(e.event.portalId, ref(e))) structural = true;
    else if (e.event.action === 'ASSOCIATION_ADDED') labelAdded = true;
    else labelRemoved = true;
  }
  if (structural) return !labelAdded && !labelRemoved;
  return !(labelAdded && labelRemoved);
}

/** Anchored windows: an event joins the cluster if it is within windowMs of the cluster's FIRST event. */
function clusterByWindow(sortedGroup: Item[], windowMs: number): Item[][] {
  const clusters: Item[][] = [];
  let cur: Item[] = [];
  for (const it of sortedGroup) {
    if (cur.length && it.entry.occurredAtMs - cur[0].entry.occurredAtMs > windowMs) {
      clusters.push(cur);
      cur = [];
    }
    cur.push(it);
  }
  if (cur.length) clusters.push(cur);
  return clusters;
}

/** Drop the B->A copy of an A->B event (same action, same structural/label class). See assumption A3. */
function collapseMirrors(cluster: AssociationEntry[], structural: (e: AssociationEntry) => boolean): AssociationEntry[] {
  const canonical = cluster[0];
  const main = cluster.filter((e) => sameDirection(e, canonical));
  const other = cluster.filter((e) => !sameDirection(e, canonical));
  const used = new Set<AssociationEntry>();
  const kept: AssociationEntry[] = [];
  for (const o of other) {
    const twin = main.find(
      (m) =>
        !used.has(m) &&
        m.event.action === o.event.action &&
        structural(m) === structural(o),
    );
    if (twin) used.add(twin);
    else kept.push(o);
  }
  return [...main, ...kept].sort((a, b) => a.occurredAtMs - b.occurredAtMs);
}

function ref(e: AssociationEntry): LabelRef {
  return {
    fromObjectTypeId: e.event.fromObjectTypeId,
    toObjectTypeId: e.event.toObjectTypeId,
    associationTypeId: e.event.associationTypeId,
    associationCategory: e.event.associationCategory,
  };
}

const refKey = (r: LabelRef) => `${r.fromObjectTypeId}>${r.toObjectTypeId}#${r.associationTypeId}`;

/** Net label removals/additions. A REMOVED and ADDED of the same type cancel each other out. */
function netRefs(events: AssociationEntry[]): { removed: LabelRef[]; added: LabelRef[] } {
  const net = new Map<string, { ref: LabelRef; n: number }>();
  for (const e of events) {
    const r = ref(e);
    const k = refKey(r);
    const cur = net.get(k) ?? { ref: r, n: 0 };
    cur.n += e.event.action === 'ASSOCIATION_ADDED' ? 1 : -1;
    net.set(k, cur);
  }
  const removed: LabelRef[] = [];
  const added: LabelRef[] = [];
  for (const { ref: r, n } of net.values()) {
    if (n < 0) removed.push(r);
    if (n > 0) added.push(r);
  }
  return { removed, added };
}

function interpretCluster(raw: AssociationEntry[], isStructural: StructuralCheck): PairedChange | null {
  const portalId = raw[0].event.portalId;
  const structural = (e: AssociationEntry) => isStructural(portalId, ref(e));
  const cluster = collapseMirrors(raw, structural);
  const first = cluster[0].event;
  const labeled = cluster.filter((e) => !structural(e));
  const unlabeled = cluster.filter(structural);

  const structuralNet = unlabeled.reduce((n, e) => n + (e.event.action === 'ASSOCIATION_ADDED' ? 1 : -1), 0);
  const { removed, added } = netRefs(labeled);
  let changeType: ChangeType;
  if (structuralNet < 0) changeType = 'REMOVED';
  else if (structuralNet > 0) changeType = 'ADDED';
  else if (removed.length || added.length) changeType = 'LABEL_CHANGED';
  else return null; // everything cancelled out (e.g. label removed and re-added quickly)

  // Category of the labels involved. For an unlabeled link/unlink, the structural type's own category
  // (HUBSPOT_DEFINED for standard pairs, USER_DEFINED for custom object pairs).
  const catsOf = (es: AssociationEntry[]) => [...new Set(es.map((e) => e.event.associationCategory))];
  const categories = labeled.length ? catsOf(labeled) : catsOf(unlabeled);
  return {
    portalId: first.portalId,
    changeType,
    fromObjectTypeId: first.fromObjectTypeId,
    fromObjectId: String(first.fromObjectId),
    toObjectTypeId: first.toObjectTypeId,
    toObjectId: String(first.toObjectId),
    removed,
    added,
    associationCategory: categories.sort().join(','),
    occurredAt: cluster[cluster.length - 1].event.occurredAt,
    // Keys/offsets come from the raw cluster so dropped mirror events are still marked as handled.
    sourceKeys: raw.map((e) => e.key),
    sourceOffsets: [...new Set(raw.map((e) => e.fileOffset))],
    structuralNet,
  };
}
