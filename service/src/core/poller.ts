import type { Logger } from '../obs/log.js';
import { absorbLateHalves, emittedActionsFor, type AbsorbResult, type AbsorbStore } from './absorb.js';
import { dedupeEntries, toAssociationEntries } from './dedupe.js';
import { buildStructuralCheck, LabelHoldError, type LabelCache } from './labels.js';
import { DEFAULT_PAIRING_CONFIG, pairAssociations, type PairingConfig, type StructuralCheck } from './pairing.js';
import { prefetchMirrorLabels, resolveChanges } from './resolve.js';
import { toChangeRecords, toStampUpdate, type ChangeRecord, type StampUpdate } from './stamp.js';
import type { LabelStateReader } from './resolve.js';
import type { AssociationEntry, JournalEvent, JournalFile, PendingEntry, WatchedPair } from './types.js';
import { isAssociationEvent } from './types.js';

/**
 * Everything one run reads and commits. Implemented by src/store/db.ts Store: all repositories share one connection,
 * so the end-of-run transaction (seen keys, pending, parked, label state, metrics, offset) is atomic.
 */
export interface PollerStore extends AbsorbStore {
  journal: {
    getOffset(): string | null;
    setOffset(offset: string, now: number): void;
    setLastSuccessfulReadAt(ms: number): void;
  };
  seen: AbsorbStore['seen'] & { markSeen(keys: string[], now: number): void };
  entries: {
    loadPending(): PendingEntry[];
    replacePending(list: PendingEntry[]): void;
    loadParked(): { entry: AssociationEntry; parkedAt: number }[];
    replaceParked(entries: AssociationEntry[], now: number): void;
  };
  labels: LabelStateReader & {
    setAssociationLabels(pairKey: string, labels: string[], now: number): void;
    deleteAssociationLabels(pairKey: string): void;
  };
  changes: AbsorbStore['changes'] & { saveChanges(records: ChangeRecord[], now: number): void };
  metrics: { recordPortalError(portalId: number, message: string, now: number): void };
}

export interface JournalReadResult {
  /** Downloaded journal files strictly after the given offset, oldest first. */
  files: JournalFile[];
  /** Offset to store once these files are fully processed (the last file's offset). null = nothing new. */
  nextOffset: string | null;
  /** True if the read hit its batch limit, i.e. more is probably waiting. */
  full: boolean;
}

export interface RunDeps {
  /** offset null = no stored offset yet (the worker's reader then starts from `latest`). */
  readJournal(afterOffset: string | null): Promise<JournalReadResult>;
  /**
   * The stamp sink (the worker's StampQueue.enqueue). Called INSIDE the end-of-run transaction, so the queued stamps
   * commit together with the offset or not at all. Synchronous; returns the updates settled now (coalesced away).
   */
  enqueueStamps(updates: StampUpdate[]): StampUpdate[];
  store: PollerStore;
  labels: LabelCache;
  /**
   * The pairs this portal's events are processed for. The worker passes core/pairs.ts portalPairs(...).active (saved
   * pairs minus custom ones without custom write).
   */
  watchedPairs(portalId: number): WatchedPair[];
  now?: () => number;
  /**
   * Non-association events (e.g. app install/uninstall). Called before the offset is saved. A throw keeps the offset,
   * so the worker passes Lifecycle.onOtherEvent (src/worker/lifecycle.ts), which never throws on a HubSpot failure.
   */
  onOtherEvent?(event: JournalEvent, fileOffset: string): Promise<unknown> | unknown;
  /**
   * Late-half absorption decisions (info) and the "parked_entries_dropped" alert (known data loss: parked entries
   * dropped by the per-portal cap; the caller also counts data_loss from RunResult.parkDroppedByPortal).
   */
  log: Logger;
  config?: Partial<RunConfig>;
}

export interface RunConfig {
  pairing: PairingConfig;
  /**
   * STAMP_MIRROR: also stamp the record on the other side of the association. The one switch read by resolve (label
   * translation), stamp, absorb (and, in the worker, the label option sync).
   */
  mirror: boolean;
}

/**
 * Head-of-line cap: at most this many parked entries per portal. Past it, the newest parked entries of that portal are
 * dropped with an alert (recorded on the portal), so one portal's bad data can never grow without bound. It never holds
 * the offset either way.
 */
export const MAX_PARKED_PER_PORTAL = 20_000;

export const DEFAULT_RUN_CONFIG: RunConfig = {
  pairing: DEFAULT_PAIRING_CONFIG,
  mirror: false,
};

export interface RunResult {
  eventsRead: number;
  changesEmitted: number;
  /** Updates settled at enqueue in this run (coalesced into a later stamp), excluding amend stamps. */
  delivered: number;
  /** All updates coalesced away at enqueue in this run, amend stamps included (log + metric after the commit). */
  coalesced: number;
  pending: number;
  batchFull: boolean;
  offset: string | null;
  /** Portals whose entries are parked after this run (label lookup held). */
  parkedPortals: number[];
  /** Entries parked after this run (all portals). */
  parked: number;
  /**
   * Wall-clock ms when the earliest held pairing cluster can be released (deadline or maxHold), or null if
   * nothing is held. The worker wakes up then (or earlier for its poll interval), so a label edit is not
   * stuck waiting for a later, unrelated event.
   */
  nextReleaseAt: number | null;
  /** Journal files in this read. */
  filesRead: number;
  /** occurredAt (ms) of the newest association event read, or null (for journal_lag_seconds). */
  newestOccurredAtMs: number | null;
  /** Changes produced per portal in this run. */
  changesByPortal: Map<number, number>;
  /** Parked entries dropped by the per-portal cap in this run. */
  parkDropped: number;
  /** Same, per portal (for data_loss{reason="park_dropped"}). Only set once the run committed. */
  parkDroppedByPortal: Map<number, number>;
  /** Late journal halves of already-emitted actions handled in this run (absorb.ts). */
  lateHalves: { absorbed: number; amended: number; converted: number };
}

function isWatched(e: AssociationEntry, pairs: WatchedPair[]): boolean {
  const { fromObjectTypeId: f, toObjectTypeId: t } = e.event;
  return pairs.some(
    (p) => (p.objectTypeId === f && p.associatedObjectTypeId === t) || (p.objectTypeId === t && p.associatedObjectTypeId === f),
  );
}

/**
 * Read -> dedupe -> look up structural types -> pair -> resolve labels -> send -> persist.
 * The offset (with pending pairs, seen keys, label state AND the queued stamps) is saved in ONE transaction. If
 * anything throws, nothing of the run is kept and the next run re-reads and decides again.
 */
export async function runOnce(deps: RunDeps): Promise<RunResult> {
  const { store, labels } = deps;
  const now = deps.now ?? Date.now;
  const cfg: RunConfig = { ...DEFAULT_RUN_CONFIG, ...deps.config };

  const startOffset = store.journal.getOffset();
  const read = await deps.readJournal(startOffset);
  const t = now();

  if (deps.onOtherEvent) {
    for (const f of read.files)
      for (const ev of f.journalEvents ?? []) if (!isAssociationEvent(ev)) await deps.onOtherEvent(ev, f.offset);
  }

  const all = dedupeEntries(toAssociationEntries(read.files), store.seen);
  const watchedCache = new Map<number, WatchedPair[]>();
  const watched = (portalId: number) => {
    if (!watchedCache.has(portalId)) watchedCache.set(portalId, deps.watchedPairs(portalId));
    return watchedCache.get(portalId)!;
  };
  // Events for object pairs the portal has not chosen are dropped (subscriptions should already filter; this covers
  // races). Pending and parked entries of a pair that is no longer watched (settings change, uninstall) are dropped too.
  const isWatchedNow = (e: AssociationEntry) => isWatched(e, watched(e.event.portalId));
  const watchedNow = all.filter(isWatchedNow);
  const allPending = store.entries.loadPending().filter((p) => isWatchedNow(p.entry));
  const parkedBefore = store.entries.loadParked().map((p) => p.entry).filter(isWatchedNow);

  // ---- per-portal label lookups (structural check; with mirror also the to -> from translation, prefetchMirrorLabels).
  // Structural = "linked at all" type: label === null. A LabelHoldError PARKS that
  // portal's entries (new ones, earlier parked ones and its pending pairs) in the store and the offset moves on for
  // everyone else; parked entries are retried on every run. Any other error holds the whole batch.
  const parkedPortals = new Set<number>();
  const structuralByPortal = new Map<number, StructuralCheck>();
  const byPortal = new Map<number, AssociationEntry[]>();
  for (const e of [...parkedBefore, ...watchedNow, ...allPending.map((p) => p.entry)])
    (byPortal.get(e.event.portalId) ?? byPortal.set(e.event.portalId, []).get(e.event.portalId)!).push(e);
  for (const [portalId, entries] of byPortal) {
    try {
      const check = await buildStructuralCheck(entries, labels);
      if (cfg.mirror) await prefetchMirrorLabels(entries, labels, store.labels);
      structuralByPortal.set(portalId, check);
    } catch (e) {
      if (!(e instanceof LabelHoldError)) throw e;
      parkedPortals.add(portalId);
      store.metrics.recordPortalError(portalId, `entries parked: ${e instanceof Error ? e.message : String(e)}`, now());
    }
  }
  // Only entries of portals that were not parked are paired, so every one has its check.
  const isStructural: StructuralCheck = (portalId, r) => structuralByPortal.get(portalId)!(portalId, r);
  const isParked = (e: AssociationEntry) => parkedPortals.has(e.event.portalId);
  const candidates = [...parkedBefore, ...watchedNow];
  const fresh = candidates.filter((e) => !isParked(e));
  let toPark = candidates.filter(isParked);
  let parkDropped = 0;
  const parkDroppedByPortal = new Map<number, number>();
  const parkAlerts: { portalId: number; msg: string }[] = [];
  if (toPark.length) {
    const cap = MAX_PARKED_PER_PORTAL;
    const per = new Map<number, AssociationEntry[]>();
    for (const e of toPark) (per.get(e.event.portalId) ?? per.set(e.event.portalId, []).get(e.event.portalId)!).push(e);
    const kept: AssociationEntry[] = [];
    for (const [portalId, list] of per) {
      if (list.length <= cap) {
        kept.push(...list);
        continue;
      }
      const sorted = [...list].sort((a, b) => a.occurredAtMs - b.occurredAtMs);
      kept.push(...sorted.slice(0, cap));
      const n = sorted.length - cap;
      parkDropped += n;
      parkDroppedByPortal.set(portalId, n);
      const msg = `${n} parked entr${n === 1 ? 'y' : 'ies'} DROPPED (cap ${cap} per portal; label lookup held too long)`;
      store.metrics.recordPortalError(portalId, msg, now());
      parkAlerts.push({ portalId, msg: `portal ${portalId}: ${msg}. Changes in them are lost.` });
    }
    toPark = kept;
  }
  const pending = allPending.filter((p) => !isParked(p.entry));
  const pendingKept = allPending.filter((p) => isParked(p.entry));

  // Wall-clock release (now >= occurredAt + window + publish slack) only when this read reached the head of
  // the journal. While catching up on a backlog (full batch) "now" says nothing about unread files, so
  // clusters are closed by the stream watermark instead and the next read follows at once.
  const { changes: paired, stillPending: stillPendingActive, nextReleaseAt } = pairAssociations({
    entries: fresh,
    pending,
    now: t,
    config: cfg.pairing,
    streamWatermarkMs: all.reduce((m, e) => Math.max(m, e.occurredAtMs), -Infinity),
    isStructural,
    caughtUp: !read.full,
  });
  const stillPending = [...stillPendingActive, ...pendingKept];

  // Late halves of actions emitted in an earlier run: absorb / amend / convert.
  const absorbed: AbsorbResult = await absorbLateHalves(paired, {
    store,
    labels,
    now: t,
    mirror: cfg.mirror,
    windowMs: cfg.pairing.windowMs,
    log: deps.log,
  });
  const resolved = await resolveChanges(absorbed.normal, labels, store.labels, cfg.mirror, absorbed.stateUpdates);
  const stateUpdates = resolved.stateUpdates;
  // Late structural halves after an already-stamped change are new changes of their own (absorb.ts).
  const changes = absorbed.emitted.length
    ? [...absorbed.emitted, ...resolved.changes].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
    : resolved.changes;
  const emittedMemory: ReturnType<typeof emittedActionsFor> = [];

  const records: ReturnType<typeof toChangeRecords> = [];
  for (const c of changes) {
    const rs = toChangeRecords(c, cfg.mirror);
    records.push(...rs);
    emittedMemory.push(...emittedActionsFor(c, rs));
  }
  // Amend stamps (late label halves) go first: they belong to older changes than anything new in this run.
  const updates = [...absorbed.amendStamps, ...records.map(toStampUpdate)];
  let delivered = 0;
  let coalesced = 0;

  // Old rows of the retention tables are pruned by the Store's maintenance timer, not in this transaction.
  store.transaction(() => {
    // Saved before any stamp is queued (so before any is sent): a change id seen on a record can always be found in
    // change_log. Inside the transaction, so a failed run leaves no orphan rows. Idempotent (INSERT OR IGNORE on the
    // deterministic change id).
    store.changes.saveChanges(records, now());
    if (updates.length) {
      const dropped = deps.enqueueStamps(updates);
      coalesced = dropped.length;
      delivered = dropped.filter((u) => u.amendOf === undefined).length;
    }
    // `all` includes events dropped by the watched-pairs filter: they are handled too.
    store.seen.markSeen(all.map((e) => e.key), t);
    store.entries.replacePending(stillPending);
    if (emittedMemory.length) store.emitted.saveEmittedActions(emittedMemory, t);
    store.entries.replaceParked(toPark, t);
    for (const [k, v] of stateUpdates) {
      if (v === null) store.labels.deleteAssociationLabels(k);
      else store.labels.setAssociationLabels(k, v, t);
    }
    if (read.nextOffset) store.journal.setOffset(read.nextOffset, t);
    store.journal.setLastSuccessfulReadAt(t);
  });

  // Only after the commit: a run that fails re-reads, re-parks and decides again (no double counting).
  for (const a of parkAlerts) deps.log.alert('parked_entries_dropped', a.msg, { portalId: a.portalId });

  return {
    eventsRead: all.length,
    changesEmitted: changes.length,
    delivered,
    coalesced,
    pending: stillPending.length,
    batchFull: read.full,
    offset: store.journal.getOffset(),
    parkedPortals: [...parkedPortals].sort((a, b) => a - b),
    parked: toPark.length,
    nextReleaseAt,
    filesRead: read.files.length,
    newestOccurredAtMs: all.length ? all.reduce((m, e) => Math.max(m, e.occurredAtMs), -Infinity) : null,
    changesByPortal: changes.reduce((m, c) => m.set(c.portalId, (m.get(c.portalId) ?? 0) + 1), new Map<number, number>()),
    parkDropped,
    parkDroppedByPortal,
    lateHalves: { absorbed: absorbed.absorbed, amended: absorbed.amended, converted: absorbed.converted },
  };
}
