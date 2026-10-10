import type { Store } from '../store/db.js';
import { absorbLateHalves, emittedActionsFor, type AbsorbResult } from './absorb.js';
import { dedupeEntries, toAssociationEntries } from './dedupe.js';
import { chunk, DEFAULT_EMIT_CONFIG, toOccurrences, type EmitConfig } from './emit.js';
import { buildStructuralCheck, type LabelCache } from './labels.js';
import { DEFAULT_PAIRING_CONFIG, pairAssociations, type PairingConfig } from './pairing.js';
import { DEFAULT_RESOLVE_CONFIG, resolveChanges, type ResolveConfig } from './resolve.js';
import {
  DEFAULT_STAMP_CONFIG,
  deliveryModeFromEnv,
  stampIdOf,
  toChangeRecords,
  toStampUpdate,
  type DeliveryMode,
  type StampConfig,
  type StampUpdate,
} from './stamp.js';
import type { AppEventOccurrence, AssociationEntry, JournalEvent, JournalFile, WatchedPair } from './types.js';
import { isAssociationEvent } from './types.js';

// ---------- polling delay ----------
//
// Latency target (2026-10-30): most changes stamped within ~10 s of occurredAt. HubSpot publishes a journal
// file ~1-4 s after occurredAt, and the Journal API limit (100 req/s per app) is separate from customers'
// limits; there is ONE app-wide stream for all portals. So a steady short interval costs almost nothing.
// The old idle back-off (60 s -> 120 s) made a single UI change wait up to 2 min; it is gone by default.

export interface DelayConfig {
  /** Steady interval between reads (JOURNAL_POLL_MS). */
  pollMs: number;
  /** Optional idle back-off cap (JOURNAL_IDLE_MAX_MS): empty reads double pollMs up to this. Default = pollMs (no back-off). */
  idleMaxMs: number;
  /** First delay after a failed run (JOURNAL_ERROR_BASE_MS), then doubles. */
  errorBaseMs: number;
  /** Cap for the error back-off (JOURNAL_ERROR_MAX_MS). */
  errorMaxMs: number;
}

export const DEFAULT_POLL_MS = 3_000;

export const DEFAULT_DELAY_CONFIG: DelayConfig = {
  pollMs: DEFAULT_POLL_MS,
  idleMaxMs: DEFAULT_POLL_MS,
  errorBaseMs: 5_000,
  errorMaxMs: 120_000,
};

/** Delay config from env. Unset values use the defaults; idleMaxMs is never below pollMs. */
export function delayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DelayConfig {
  const num = (k: string): number | undefined => {
    const v = env[k];
    if (v === undefined || v.trim() === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Expected a non-negative number for ${k}, got "${v}"`);
    return n;
  };
  const pollMs = num('JOURNAL_POLL_MS') ?? DEFAULT_DELAY_CONFIG.pollMs;
  return {
    pollMs,
    idleMaxMs: Math.max(pollMs, num('JOURNAL_IDLE_MAX_MS') ?? pollMs),
    errorBaseMs: num('JOURNAL_ERROR_BASE_MS') ?? DEFAULT_DELAY_CONFIG.errorBaseMs,
    errorMaxMs: num('JOURNAL_ERROR_MAX_MS') ?? DEFAULT_DELAY_CONFIG.errorMaxMs,
  };
}

/** Full batch -> read again now. Otherwise pollMs (empty reads may back off up to idleMaxMs if configured). */
export function nextDelayMs(
  r: { batchFull: boolean; eventCount: number; consecutiveEmpty: number },
  c: DelayConfig = DEFAULT_DELAY_CONFIG,
): number {
  if (r.batchFull) return 0;
  if (r.eventCount > 0 || c.idleMaxMs <= c.pollMs) return c.pollMs;
  const n = Math.max(1, r.consecutiveEmpty);
  return Math.min(c.idleMaxMs, c.pollMs * 2 ** (n - 1));
}

/** Exponential back-off after failed runs: errorBaseMs, x2, x4 ... capped at errorMaxMs. Separate from polling. */
export function errorDelayMs(consecutiveErrors: number, c: DelayConfig = DEFAULT_DELAY_CONFIG): number {
  return Math.min(c.errorMaxMs, c.errorBaseMs * 2 ** Math.max(0, Math.min(30, consecutiveErrors - 1)));
}

export const STALE_AFTER_MS = 60 * 60 * 1000;

/** True if there was no successful read for maxAgeMs (operational rule: the journal keeps only ~3 days). Counts from DB creation if never read. */
export function isStale(store: Store, now: number, maxAgeMs: number = STALE_AFTER_MS): boolean {
  const last = store.getLastSuccessfulReadAt() ?? store.getCreatedAt();
  return now - last >= maxAgeMs;
}

// ---------- one worker iteration ----------

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
  /** app_events sink. Must throw if HubSpot did not accept the batch. Batches are at most 500. */
  sendOccurrences?(batch: AppEventOccurrence[]): Promise<void>;
  /**
   * stamp sink (default, see stamp.ts). Must throw if delivery should be retried (offset is then kept).
   * Must call onDelivered after each accepted batch, so a retry doesn't re-stamp those records.
   * Wire it to Stamper.send (src/hubspot/stamp.ts).
   */
  sendStamps?(updates: StampUpdate[], onDelivered: (done: StampUpdate[]) => void): Promise<unknown>;
  store: Store;
  labels: LabelCache;
  now?: () => number;
  /**
   * Non-association events (e.g. app install/uninstall). Called before the offset is saved. A throw keeps the offset,
   * so the worker passes LifecycleRetry.onOtherEvent (src/worker/lifecycle-retry.ts), which never throws (C2).
   */
  onOtherEvent?(event: JournalEvent, fileOffset: string): Promise<unknown> | unknown;
  /**
   * Per-portal parking. If set, label lookups are tried per portal first; when one throws an error this
   * predicate accepts (the worker passes `e instanceof LabelHoldError`), that portal's entries (new ones,
   * earlier parked ones and its pending pairs) are PARKED in the store and the offset moves on for everyone
   * else. Parked entries are retried on every run. Unset = old behaviour (any failure holds the whole batch).
   */
  isParkable?(err: unknown): boolean;
  /** Info log (late-half absorption decisions). Default: none. */
  log?(msg: string): void;
  config?: Partial<RunConfig>;
}

export interface RunConfig {
  pairing: PairingConfig;
  emit: EmitConfig;
  resolve: ResolveConfig;
  /** Drop events for object pairs the portal has not chosen (subscriptions should already filter; this covers races). */
  enforceWatchedPairs: boolean;
  /**
   * Head-of-line cap: at most this many parked entries per portal (PARK_MAX_PER_PORTAL). Past it, the newest parked
   * entries of that portal are dropped with an [ALERT] (recorded on the portal), so one portal's bad data can never
   * grow without bound. It never holds the offset either way.
   */
  maxParkedPerPortal: number;
  stamp: StampConfig;
  /**
   * Which sink delivers changes. Unset: if only one sender is given, use that one; otherwise DELIVERY_MODE (default stamp).
   */
  deliveryMode?: DeliveryMode;
  /**
   * Late-half absorption (src/core/absorb.ts, stamp mode only): a late journal half of an already-emitted action is
   * absorbed / amended instead of becoming an extra change. Default true.
   */
  absorbLateHalves: boolean;
}

export const DEFAULT_RUN_CONFIG: RunConfig = {
  pairing: DEFAULT_PAIRING_CONFIG,
  emit: DEFAULT_EMIT_CONFIG,
  resolve: DEFAULT_RESOLVE_CONFIG,
  enforceWatchedPairs: true,
  maxParkedPerPortal: 20_000,
  stamp: DEFAULT_STAMP_CONFIG,
  absorbLateHalves: true,
};

export function resolveDeliveryMode(deps: Pick<RunDeps, 'sendOccurrences' | 'sendStamps'>, cfg: Pick<RunConfig, 'deliveryMode'>): DeliveryMode {
  if (cfg.deliveryMode) return cfg.deliveryMode;
  if (deps.sendStamps && !deps.sendOccurrences) return 'stamp';
  if (deps.sendOccurrences && !deps.sendStamps) return 'app_events';
  return deliveryModeFromEnv();
}

export interface RunResult {
  eventsRead: number;
  changesEmitted: number;
  occurrencesSent: number;
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
  /** Late journal halves of already-emitted actions handled in this run (absorb.ts). */
  lateHalves: { absorbed: number; amended: number; converted: number };
}

const OCC_PREFIX = 'occ:';
/** seen_events prefix for a delivered stamp (shared with the worker's stamp queue). */
export const STAMP_PREFIX = 'stamp:';

function isWatched(e: AssociationEntry, pairs: WatchedPair[]): boolean {
  const { fromObjectTypeId: f, toObjectTypeId: t } = e.event;
  return pairs.some(
    (p) => (p.objectTypeId === f && p.associatedObjectTypeId === t) || (p.objectTypeId === t && p.associatedObjectTypeId === f),
  );
}

/**
 * Read -> dedupe -> look up structural types -> pair -> resolve labels -> send -> persist.
 * The offset (with pending pairs, seen keys and label state) is saved in ONE transaction and only
 * after every batch was accepted. If anything throws, the offset stays put and the next run re-reads.
 * Occurrences already accepted before a failure are remembered by id, so a retry does not resend them.
 */
export async function runOnce(deps: RunDeps): Promise<RunResult> {
  const { store, labels } = deps;
  const now = deps.now ?? Date.now;
  const cfg: RunConfig = { ...DEFAULT_RUN_CONFIG, ...deps.config };

  try {
    const startOffset = store.getOffset();
    const read = await deps.readJournal(startOffset);
    const t = now();

    if (deps.onOtherEvent) {
      for (const f of read.files)
        for (const ev of f.journalEvents ?? []) if (!isAssociationEvent(ev)) await deps.onOtherEvent(ev, f.offset);
    }

    const all = dedupeEntries(toAssociationEntries(read.files), store);
    const watchedCache = new Map<number, WatchedPair[]>();
    const watched = (portalId: number) => {
      if (!watchedCache.has(portalId)) watchedCache.set(portalId, store.getWatchedPairs(portalId));
      return watchedCache.get(portalId)!;
    };
    const watchedNow = cfg.enforceWatchedPairs ? all.filter((e) => isWatched(e, watched(e.event.portalId))) : all;
    // Pending entries of a pair that is no longer watched (settings change, uninstall) are dropped too.
    const allPending = store
      .loadPending()
      .filter((p) => !cfg.enforceWatchedPairs || isWatched(p.entry, watched(p.entry.event.portalId)));

    // ---- per-portal parking (see RunDeps.isParkable)
    // A parked entry whose pair is no longer watched (settings change, uninstall) is dropped.
    const parkedBefore = deps.isParkable
      ? store.loadParked().map((p) => p.entry).filter((e) => !cfg.enforceWatchedPairs || isWatched(e, watched(e.event.portalId)))
      : [];
    const parkedPortals = new Set<number>();
    if (deps.isParkable) {
      const byPortal = new Map<number, AssociationEntry[]>();
      for (const e of [...parkedBefore, ...watchedNow, ...allPending.map((p) => p.entry)])
        (byPortal.get(e.event.portalId) ?? byPortal.set(e.event.portalId, []).get(e.event.portalId)!).push(e);
      for (const [portalId, entries] of byPortal) {
        try {
          // Same lookups that pairing + resolve do below; afterwards they are served from the label cache.
          await buildStructuralCheck(entries, labels);
        } catch (e) {
          if (!deps.isParkable(e)) throw e;
          parkedPortals.add(portalId);
          store.recordPortalError(portalId, `entries parked: ${e instanceof Error ? e.message : String(e)}`, now());
        }
      }
    }
    const isParked = (e: AssociationEntry) => parkedPortals.has(e.event.portalId);
    const candidates = [...parkedBefore, ...watchedNow];
    const fresh = candidates.filter((e) => !isParked(e));
    let toPark = candidates.filter(isParked);
    let parkDropped = 0;
    if (toPark.length) {
      const cap = Math.max(1, cfg.maxParkedPerPortal);
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
        const msg = `[ALERT] ${n} parked entr${n === 1 ? 'y' : 'ies'} DROPPED (cap ${cap} per portal; label lookup held too long)`;
        store.recordPortalError(portalId, msg, now());
        console.error(`${new Date(now()).toISOString()} [poller] portal ${portalId}: ${msg}`);
      }
      toPark = kept;
    }
    const pending = allPending.filter((p) => !isParked(p.entry));
    const pendingKept = allPending.filter((p) => isParked(p.entry));

    // Structural = "linked at all" type: label === null in the label definitions (any category).
    const isStructural = await buildStructuralCheck([...fresh, ...pending.map((p) => p.entry)], labels);
    // Wall-clock release (now >= occurredAt + window + publish slack) only when this read reached the head of
    // the journal. While catching up on a backlog (full batch) "now" says nothing about unread files, so
    // clusters are closed by the stream watermark instead and the next read follows at once.
    const { changes: paired, stillPending: stillPendingActive, nextReleaseAt } = pairAssociations(
      fresh,
      pending,
      t,
      cfg.pairing,
      all.reduce((m, e) => Math.max(m, e.occurredAtMs), -Infinity),
      isStructural,
      { caughtUp: !read.full },
    );
    const stillPending = [...stillPendingActive, ...pendingKept];
    const mode = resolveDeliveryMode(deps, cfg);

    // Late halves of actions emitted in an earlier run: absorb / amend / convert (stamp mode, structural pairing).
    let absorbed: AbsorbResult | null = null;
    if (mode === 'stamp' && cfg.absorbLateHalves) {
      absorbed = await absorbLateHalves(paired, {
        store, labels, now: t, resolve: cfg.resolve, stamp: cfg.stamp, windowMs: cfg.pairing.windowMs, log: deps.log,
      });
    }
    const resolved = await resolveChanges(absorbed?.normal ?? paired, labels, store, cfg.resolve, absorbed?.stateUpdates);
    const stateUpdates = resolved.stateUpdates;
    // Late structural halves after an already-stamped change are new changes of their own (absorb.ts).
    const changes = absorbed?.emitted.length
      ? [...absorbed.emitted, ...resolved.changes].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
      : resolved.changes;
    const emittedMemory: ReturnType<typeof emittedActionsFor> = [];

    // Per-portal counter: occurrences (app_events) or stamped records (stamp).
    const delivered: { portalId: number }[] = [];

    if (mode === 'app_events') {
      if (!deps.sendOccurrences) throw new Error('DELIVERY_MODE=app_events but no sendOccurrences was given');
      const occurrences = changes.flatMap((c) => toOccurrences(c, cfg.emit));
      const alreadySent = store.filterSeen(occurrences.map((o) => OCC_PREFIX + o.id));
      const toSend = occurrences.filter((o) => !alreadySent.has(OCC_PREFIX + o.id));
      for (const batch of chunk(toSend)) {
        await deps.sendOccurrences(batch);
        store.markSeen(batch.map((o) => OCC_PREFIX + o.id), now());
      }
      delivered.push(...toSend);
    } else {
      if (!deps.sendStamps) throw new Error('DELIVERY_MODE=stamp but no sendStamps was given');
      const records: ReturnType<typeof toChangeRecords> = [];
      for (const c of changes) {
        const rs = toChangeRecords(c, cfg.stamp);
        records.push(...rs);
        emittedMemory.push(...emittedActionsFor(c, rs));
      }
      // Save BEFORE stamping, so "Get association change" can always find a change id it sees on a record.
      // Idempotent (INSERT OR IGNORE on the deterministic change id).
      store.saveChanges(records, now());
      // Amend stamps (late label halves) go first: they belong to older changes than anything new in this run.
      const updates = [...(absorbed?.amendStamps ?? []), ...records.map(toStampUpdate)];
      const alreadySent = store.filterSeen(updates.map((u) => STAMP_PREFIX + stampIdOf(u)));
      const toStamp = updates.filter((u) => !alreadySent.has(STAMP_PREFIX + stampIdOf(u)));
      if (toStamp.length) {
        await deps.sendStamps(toStamp, (done) => {
          store.markSeen(done.map((u) => STAMP_PREFIX + stampIdOf(u)), now());
          delivered.push(...done.filter((u) => u.amendOf === undefined));
        });
      }
    }

    store.transaction(() => {
      // `all` includes events dropped by the watched-pairs filter: they are handled too.
      store.markSeen(all.map((e) => e.key), t);
      store.replacePending(stillPending);
      if (emittedMemory.length) store.saveEmittedActions(emittedMemory, t);
      if (deps.isParkable) store.replaceParked(toPark, t);
      for (const [k, v] of stateUpdates) {
        if (v === null) store.deleteAssociationLabels(k);
        else store.setAssociationLabels(k, v, t);
      }
      const perPortal = new Map<number, { events: number; changes: number; occurrences: number }>();
      const bump = (p: number) => perPortal.get(p) ?? perPortal.set(p, { events: 0, changes: 0, occurrences: 0 }).get(p)!;
      // Portals with no watched pairs (uninstalled) get no metrics row, so an uninstall purge stays purged.
      for (const e of all) if (!cfg.enforceWatchedPairs || watched(e.event.portalId).length) bump(e.event.portalId).events++;
      for (const c of changes) bump(c.portalId).changes++;
      for (const o of delivered) bump(o.portalId).occurrences++;
      for (const [p, d] of perPortal) store.addMetrics(p, d, t);

      if (read.nextOffset) store.setOffset(read.nextOffset, t);
      store.setLastSuccessfulReadAt(t);
      store.resetConsecutiveErrors();
      store.setState('consecutive_empty', String(all.length === 0 ? Number(store.getState('consecutive_empty') ?? 0) + 1 : 0));
      store.pruneSeen(t);
      store.pruneChangeLog(t);
      store.pruneStampLast(t);
      store.pruneAssociationLabels(t);
      store.pruneEmittedActions(t);
    });

    return {
      eventsRead: all.length,
      changesEmitted: changes.length,
      occurrencesSent: delivered.length,
      pending: stillPending.length,
      batchFull: read.full,
      offset: store.getOffset(),
      parkedPortals: [...parkedPortals].sort((a, b) => a - b),
      parked: toPark.length,
      nextReleaseAt,
      filesRead: read.files.length,
      newestOccurredAtMs: all.length ? all.reduce((m, e) => Math.max(m, e.occurredAtMs), -Infinity) : null,
      changesByPortal: changes.reduce((m, c) => m.set(c.portalId, (m.get(c.portalId) ?? 0) + 1), new Map<number, number>()),
      parkDropped,
      lateHalves: { absorbed: absorbed?.absorbed ?? 0, amended: absorbed?.amended ?? 0, converted: absorbed?.converted ?? 0 },
    };
  } catch (err) {
    store.recordError(err instanceof Error ? err.message : String(err), now());
    throw err;
  }
}

/** Delay before the next run, based on the last result (or failure). */
export function delayAfter(store: Store, result: RunResult | null, c: DelayConfig = DEFAULT_DELAY_CONFIG): number {
  if (!result) return errorDelayMs(store.getConsecutiveErrors(), c);
  return nextDelayMs(
    { batchFull: result.batchFull, eventCount: result.eventsRead, consecutiveEmpty: Number(store.getState('consecutive_empty') ?? 0) },
    c,
  );
}
