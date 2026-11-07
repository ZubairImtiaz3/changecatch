// Persisted stamp queue: per-record spacing, burst coalescing, a FAIR per-portal drain,
// per-record retries (only the records that failed), dead letters (no silent drops) and revoked-token pauses.
//
// Enqueue: planEnqueue() from src/core/coalesce.ts. Every record has its own timeline, so one hot record
//   never delays other records. Coalescing (COALESCE_THRESHOLD) folds a burst on one record into fewer stamps; the folded ones
//   are marked `stamp:<id>` seen (they stay in change_log) and count as delivered.
//
// Drain, one "cycle":
//   - every portal with due rows gets a turn, in round-robin order (the start rotates each cycle);
//   - each portal sends at most PER_PORTAL_PER_DRAIN records (100 = one batch call) per cycle, so portal A
//     with 50k queued and portal B with 1 both get a batch in the SAME cycle;
//   - all picked records go to sendBatches (production: sendStampBatches, src/hubspot/stamp.ts): grouped per portal +
//     object type, portals in parallel (STAMP_PORTAL_CONCURRENCY), each portal held to its own rate limit by src/lib/http.ts;
//   - a 'throttled' result (429 / our limiter full) for portal A defers ALL of A's rows due before retryAfterMs (one
//     UPDATE), so A has nothing due until then and the loop sleeps; B is not affected.
//   Rows skipped for spacing/order are deferred in ONE transaction (no per-row commits).
//
// Results, per record (StampResult.kind from src/hubspot/stamp.ts; nothing else is looked at):
//   ok         -> delete from queue, remember stamp time, mark `stamp:<id>` seen.
//   retry      -> back-off (retryBaseMs x2 .. retryMaxMs) for up to retryWindowMs (config STAMP_RETRY_MAX_MS), then
//                 DEAD-LETTERED.
//   throttled  -> deferred by retryAfterMs, attempt not counted.
//   auth       -> portal PAUSED: its queue is kept and probed every PAUSE_PROBE_MS (1 h). Success unpauses.
//                 After PAUSE_MAX_MS (7 days) onPauseExpired runs (worker: the uninstall routine = purge).
//   refused    -> DEAD-LETTERED at once (src/store/stamps.ts stamp_dead_letter), never silently deleted.
//                 Except "value is not an option" on one of our dropdowns (isInvalidOptionRefusal): the options are
//                 out of date (labels_synced said synced, HubSpot disagrees), which a re-sync fixes. onInvalidOption runs
//                 (worker: forget that object type's labels_synced markers + re-sync its options) and the record takes
//                 the 'retry' path (back-off, dead-lettered once the retry window is over, as before).
//   ALERT_AFTER_REFUSALS refusals in a row for one portal -> alert "stamps_refused" (at most every 15 min; head-of-line protection:
//   it never blocks anyone).
//
// Failed sends never hold the shared journal offset: they retry from the persisted queue.
// Concurrency: enqueue and drain must not overlap (the worker loop is sequential).

import { planEnqueue } from '../core/coalesce.js';
import { STAMP_PROPS, SYNCED_ENUM_PROPERTY_NAMES } from '../core/contract.js';
import { recordKey, SENT_PREFIX, STAMP_PREFIX } from '../core/keys.js';
import { stampIdOf, type StampUpdate } from '../core/stamp.js';
import type { StampResult } from '../hubspot/stamp.js';
import type { ChangeCatchMetrics } from '../obs/metrics.js';
import type { Store } from '../store/db.js';
import type { QueuedStamp } from '../store/stamps.js';
import type { PortalStore } from '../store/portals.js';
import { backoffMs } from '../lib/backoff.js';
import { AlertThrottle } from '../obs/alerts.js';
import { createLogger, type Logger } from '../obs/log.js';

/** Retry a transient stamp failure this long after the change happened, then dead-letter it (STAMP_RETRY_MAX_MS). */
export const DEFAULT_RETRY_WINDOW_MS = 24 * 60 * 60_000;
/** A paused portal is probed with one record this often. */
export const PAUSE_PROBE_MS = 60 * 60_000;
/** Paused this long without a reinstall -> onPauseExpired (the uninstall routine). */
export const PAUSE_MAX_MS = 7 * 24 * 60 * 60_000;
/** Portals sent in parallel per drain cycle. */
export const STAMP_PORTAL_CONCURRENCY = 8;
/** Records per portal per drain cycle (one batch call). */
const PER_PORTAL_PER_DRAIN = 100;
/** Consecutive refused stamps for one portal before the "stamps_refused" alert. */
const ALERT_AFTER_REFUSALS = 20;

/**
 * A refusal because a value is not one of a dropdown's options, on one of the dropdowns ChangeCatch syncs.
 * HubSpot docs (https://developers.hubspot.com/docs/api-reference/error-handling, checked 2026-11-07) document invalid
 * property values as category VALIDATION_ERROR with "Property values were not valid: [...]" listing a per-property
 * error code (examples: INVALID_INTEGER, PROPERTY_DOESNT_EXIST). The enumeration code INVALID_OPTION ("... was not one
 * of the allowed options") is NOT on that page: it is HubSpot's observed wording, so we match it OR the phrase, and only
 * together with VALIDATION_ERROR and one of our synced property names. Anything else stays an ordinary refusal.
 */
export function isInvalidOptionRefusal(message: string): boolean {
  return (
    message.includes('VALIDATION_ERROR') &&
    (message.includes('INVALID_OPTION') || message.includes('allowed options')) &&
    SYNCED_ENUM_PROPERTY_NAMES.some((n) => message.includes(n))
  );
}

export interface StampQueueOptions {
  store: Store;
  /** Revoked portals (token_revocations), swept on each drain, so a revoked portal with NOTHING queued is still purged after PAUSE_MAX_MS. */
  revoked: Pick<PortalStore, 'listRevoked'>;
  /** Per-portal spacing (ms): the settings page value (PortalStore.getStampSpacingMs). */
  spacingFor: (portalId: number) => number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Keep retrying a transient failure this long after the change happened (config STAMP_RETRY_MAX_MS). Default DEFAULT_RETRY_WINDOW_MS. */
  retryWindowMs?: number;
  /**
   * A stamp on (portal, object type) was refused because a value is not an option (isInvalidOptionRefusal). Awaited
   * once per drain per (portal, object type), before the retry is due. Unset: such refusals are dead-lettered like any other.
   */
  onInvalidOption?: (portalId: number, objectTypeId: string) => Promise<void>;
  /** Called once when a portal has been paused for PAUSE_MAX_MS. The worker runs the uninstall routine. */
  onPauseExpired?: (portalId: number) => Promise<void> | void;
  now?: () => number;
  /** Default: createLogger('stamp'). */
  log?: Logger;
  /** One result per update (production: sendStampBatches, src/hubspot/stamp.ts). */
  sendBatches: (updates: StampUpdate[]) => Promise<StampResult[]>;
  metrics?: ChangeCatchMetrics;
}

export interface DrainResult {
  sent: StampUpdate[];
  /** Dead-lettered (refused, or retries ran out). Not retried by the queue. */
  dropped: StampUpdate[];
  /** changeIds that failed with a transient error and were deferred. */
  failed: string[];
  errors: string[];
}

export class StampQueue {
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private draining: Promise<DrainResult> | null = null;
  /** Round-robin start: the first portal id served in the last cycle. */
  private cursor = -Infinity;
  private readonly refusals = new Map<number, number>();
  private readonly refusedAlerts = new AlertThrottle<number>(15 * 60_000);
  /** `${portalId}:${pause since}` of pause episodes already handed to onPauseExpired (a later episode, after a reinstall, is new). */
  private readonly expiredHandled = new Set<string>();

  constructor(private opts: StampQueueOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? createLogger('stamp');
    this.retryBaseMs = opts.retryBaseMs ?? 5_000;
    this.retryMaxMs = opts.retryMaxMs ?? 10 * 60_000;
  }

  /**
   * Plan (per-record slots + coalescing) and persist. Idempotent on change id. RunDeps.enqueueStamps for runOnce: it
   * runs inside runOnce's end-of-run transaction (nested), so the rows commit with the offset; the worker loop drains
   * right after the read, so a journal read never waits on CRM writes.
   * Returns the updates that were coalesced away (never stamped; marked seen; still in change_log). The caller logs
   * and counts them once its transaction has committed (Worker.readOnce: stamps_coalesced).
   */
  enqueue(updates: StampUpdate[]): StampUpdate[] {
    const { store } = this.opts;
    const t = this.now();
    const plan = planEnqueue({
      fresh: updates,
      queuedFor: (k) => store.stamps.queuedFor(k),
      lastStampAt: (k) => store.stamps.getLastStampAt(k),
      now: t,
      spacingFor: this.opts.spacingFor,
    });
    store.transaction(() => {
      store.stamps.enqueueStamps(plan.insert, t);
      store.stamps.reslot(plan.reslot);
      const queuedDrops = plan.drop.filter((d) => d.wasQueued).map((d) => d.changeId);
      if (queuedDrops.length) store.stamps.deleteQueued(queuedDrops);
      if (plan.drop.length) store.seen.markSeen(plan.drop.map((d) => STAMP_PREFIX + d.changeId), t);
    });
    return plan.drop.map((d) => d.update);
  }

  /** Send due stamps (one fair cycle). Concurrent calls share one run. Never throws for HubSpot errors. */
  drain(): Promise<DrainResult> {
    if (!this.draining) this.draining = this.drainOnce().finally(() => (this.draining = null));
    return this.draining;
  }

  // ---------------------------------------------------------------- drain

  private async drainOnce(): Promise<DrainResult> {
    const { store } = this.opts;
    const out: DrainResult = { sent: [], dropped: [], failed: [], errors: [] };
    const t = this.now();
    await this.sweepRevoked(t);
    const portals = store.stamps.portalsWithDue(t);
    if (portals.length === 0) {
      this.updateDepthMetric();
      return out;
    }
    // Round-robin: start after the portal that started last time.
    const startIdx = portals.findIndex((p) => p > this.cursor);
    const order = startIdx <= 0 ? portals : [...portals.slice(startIdx), ...portals.slice(0, startIdx)];
    this.cursor = order[0];

    const picks = new Map<number, QueuedStamp[]>();
    const defers = new Map<number, string[]>(); // notBefore -> changeIds (spacing/order only, no attempt)
    const defer = (id: string, at: number) => (defers.get(at) ?? defers.set(at, []).get(at)!).push(id);
    const expired: { p: number; since: number }[] = [];

    for (const p of order) {
      const pause = store.stamps.getPause(p);
      let limit = PER_PORTAL_PER_DRAIN;
      if (pause) {
        if (t - pause.since >= PAUSE_MAX_MS) {
          expired.push({ p, since: pause.since });
          continue;
        }
        if (pause.nextTryAt > t) continue;
        limit = 1; // probe with one record
        store.stamps.pause(p, t, t + PAUSE_PROBE_MS, pause.reason ?? 'paused');
      }
      const sp = this.opts.spacingFor(p);
      const taken = new Set<string>();
      const list: QueuedStamp[] = [];
      for (const q of store.stamps.dueForPortal(p, t, Math.max(1000, limit * 10))) {
        if (taken.has(q.recordKey)) {
          defer(q.changeId, t + sp); // a later change for a record we send now
          continue;
        }
        const first = store.stamps.firstQueuedFor(q.recordKey);
        if (first && first.changeId !== q.changeId) {
          defer(q.changeId, Math.max(t, first.notBefore) + sp); // keep per-record order
          continue;
        }
        const last = store.stamps.getLastStampAt(q.recordKey);
        if (last !== undefined && last + sp > t) {
          defer(q.changeId, last + sp);
          continue;
        }
        if (list.length >= limit) break; // the rest stays due for the next cycle
        taken.add(q.recordKey);
        list.push(q);
      }
      if (list.length) picks.set(p, list);
    }
    if (defers.size) store.transaction(() => { for (const [at, ids] of defers) store.stamps.deferQueued(ids, at); });

    // Interleave portals so the batch groups are in round-robin order too.
    const interleaved: QueuedStamp[] = [];
    const lists = [...picks.values()];
    for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) interleaved.push(l[i]);

    if (interleaved.length) {
      const byId = new Map(interleaved.map((q) => [q.changeId, q]));
      let results: StampResult[];
      try {
        results = await this.opts.sendBatches(interleaved.map((q) => q.update));
      } catch (e) {
        // sendStampBatches never throws for HubSpot errors; anything thrown is a transient failure.
        const message = e instanceof Error ? e.message : String(e);
        results = interleaved.map((q) => ({ update: q.update, kind: 'retry', message }));
      }
      const resync = this.applyResults(results, byId, out);
      for (const [p, objectTypeIds] of resync) for (const objectTypeId of objectTypeIds) {
        try {
          await this.opts.onInvalidOption!(p, objectTypeId);
        } catch (e) {
          this.log.warn('option_resync_failed', `portal ${p}: option re-sync on ${objectTypeId} failed (stamps retry anyway): ${(e as Error).message}`, { portalId: p });
        }
      }
    }

    for (const { p, since } of expired) await this.expirePause(p, since);
    this.updateDepthMetric();
    return out;
  }

  /** Returns portalId -> object type ids whose options need a re-sync (refused: not an option). */
  private applyResults(results: StampResult[], byId: Map<string, QueuedStamp>, out: DrainResult): Map<number, Set<string>> {
    const { store } = this.opts;
    const resync = new Map<number, Set<string>>();
    const at = this.now();
    const okByPortal = new Map<number, QueuedStamp[]>();
    const dead: { q: QueuedStamp; error: string }[] = [];
    const errorsByPortal = new Map<number, string>();
    const throttledUntil = new Map<number, number>();

    for (const result of results) {
      let r = result;
      const q = byId.get(stampIdOf(r.update));
      if (!q) continue;
      const p = q.portalId;
      if (r.kind === 'ok') {
        (okByPortal.get(p) ?? okByPortal.set(p, []).get(p)!).push(q);
        continue;
      }
      errorsByPortal.set(p, r.message);
      if (r.kind === 'refused' && this.opts.onInvalidOption && isInvalidOptionRefusal(r.message)) {
        (resync.get(p) ?? resync.set(p, new Set()).get(p)!).add(q.update.objectTypeId);
        r = { update: r.update, kind: 'retry', message: `options re-synced: ${r.message}` };
      }
      switch (r.kind) {
        case 'auth': {
          const pause = store.stamps.pause(p, at, at + PAUSE_PROBE_MS, r.message);
          store.stamps.deferQueued([q.changeId], at + PAUSE_PROBE_MS, { error: r.message });
          out.failed.push(q.changeId);
          if (pause.since === at)
            this.log.alert(
              'portal_paused',
              `portal ${p}: token revoked/invalid; PAUSED (queue kept, probed hourly, purged after ${Math.round(PAUSE_MAX_MS / 86_400_000)} days without a reinstall): ${r.message}`,
              { portalId: p },
            );
          break;
        }
        case 'throttled':
          // rate_limited is counted in src/lib/http.ts (once per throttled request), not per record here.
          throttledUntil.set(p, Math.max(throttledUntil.get(p) ?? 0, at + r.retryAfterMs));
          store.stamps.deferQueued([q.changeId], at + r.retryAfterMs, { error: r.message });
          out.failed.push(q.changeId);
          break;
        case 'retry': {
          const attempts = q.attempts + 1;
          if (at - q.update.occurredAtMs >= (this.opts.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS)) {
            dead.push({ q, error: `gave up after ${attempts} attempt(s): ${r.message}` });
            this.opts.metrics?.stampsFailed(p, 1, 'gave_up');
            this.opts.metrics?.dataLoss('dead_letter', 1, p);
            break;
          }
          const retryIn = backoffMs(attempts - 1, this.retryBaseMs, this.retryMaxMs);
          store.stamps.deferQueued([q.changeId], at + retryIn, { error: r.message, countAttempt: true });
          out.failed.push(q.changeId);
          this.opts.metrics?.stampsFailed(p, 1, 'retry');
          this.log.warn('stamp_retry', `portal ${p}: stamp ${q.changeId} failed (attempt ${attempts}), retry in ${Math.round(retryIn / 1000)}s: ${r.message}`, {
            portalId: p,
            attempts,
          });
          break;
        }
        case 'refused':
          dead.push({ q, error: r.message });
          this.opts.metrics?.stampsFailed(p, 1, 'dropped');
          this.opts.metrics?.dataLoss('stamp_dropped', 1, p);
          break;
      }
    }

    // The whole portal waits out the 429 (rows not picked this cycle too), so nothing of it is due meanwhile.
    for (const [p, until] of throttledUntil) store.stamps.deferPortalUntil(p, until);

    for (const [p, msg] of errorsByPortal) {
      out.errors.push(`portal ${p}: ${msg}`);
      store.metrics.recordPortalError(p, msg, at);
    }

    // Accepted.
    for (const [p, list] of okByPortal) {
      store.transaction(() => {
        store.stamps.deleteQueued(list.map((q) => q.changeId));
        this.recordDelivered(list.map((q) => q.update), at);
      });
      // Amend stamps (late-half label fixes) are not new changes: no latency sample.
      const lat = list.filter((q) => q.update.amendOf === undefined).map((q) => at - q.update.occurredAtMs);
      this.opts.metrics?.stampsSent(p, list.length, lat);
      this.refusals.delete(p);
      this.refusedAlerts.clear(p);
      if (store.stamps.unpause(p)) this.log.info('portal_unpaused', `portal ${p}: stamping works again; pause lifted`, { portalId: p });
      for (const q of list) {
        out.sent.push(q.update);
        const u = q.update;
        if (u.amendOf !== undefined) {
          this.log.info('stamp_amended', `amended labels on portal ${p} ${u.objectTypeId}/${u.objectId} for change ${u.amendOf} (late journal half; no new change id)`, {
            portalId: p,
          });
          continue;
        }
        this.log.info(
          'stamp_sent',
          `stamped portal ${p} ${u.objectTypeId}/${u.objectId} ${u.properties[STAMP_PROPS.changeType]} ` +
            `change ${q.changeId}: ${((at - u.occurredAtMs) / 1000).toFixed(1)}s after occurredAt` +
            // Burst size lives only in logs/metrics (decision D5: no count property on the record).
            ((u.coalescedCount ?? 1) > 1 ? ` (stands for ${u.coalescedCount} changes; burst coalesced)` : ''),
          { portalId: p },
        );
      }
    }

    // Dead letters: never silently deleted.
    if (dead.length) {
      store.transaction(() => {
        store.stamps.deadLetter(dead, at);
        store.stamps.deleteQueued(dead.map((d) => d.q.changeId));
        store.seen.markSeen(dead.map((d) => STAMP_PREFIX + d.q.changeId), at);
      });
      for (const d of dead) out.dropped.push(d.q.update);
      const per = new Map<number, { q: QueuedStamp; error: string }[]>();
      for (const d of dead) (per.get(d.q.portalId) ?? per.set(d.q.portalId, []).get(d.q.portalId)!).push(d);
      for (const [p, list] of per) {
        this.log.error('dead_letter', `portal ${p}: ${list.length} stamp(s) DEAD-LETTERED (kept in stamp_dead_letter): ${list[0].error}`, {
          portalId: p,
          n: list.length,
        });
        const n = (this.refusals.get(p) ?? 0) + list.length;
        this.refusals.set(p, n);
        if (n >= ALERT_AFTER_REFUSALS && this.refusedAlerts.fire(p, at))
          this.log.alert(
            'stamps_refused',
            `portal ${p}: ${n} stamps refused in a row (bad data / missing property or scope?). Other portals are not affected. Last: ${list[0].error}`,
            { portalId: p, n },
          );
      }
    }
    return resync;
  }

  /** Revoked portals: pause them (from the revocation time) and purge the ones revoked for over PAUSE_MAX_MS. */
  private async sweepRevoked(t: number): Promise<void> {
    let list: { portalId: number; revokedAt: number }[] = [];
    try {
      list = this.opts.revoked.listRevoked();
    } catch (e) {
      this.log.warn('revoked_portals_failed', `listRevoked() failed: ${(e as Error).message}`);
    }
    for (const r of list) {
      const pause = this.opts.store.stamps.getPause(r.portalId);
      const since = Math.min(r.revokedAt, pause?.since ?? Infinity);
      if (t - since >= PAUSE_MAX_MS) await this.expirePause(r.portalId, since);
      else if (!pause) {
        this.opts.store.stamps.pause(r.portalId, since, t + PAUSE_PROBE_MS, 'token revoked (token provider)');
        this.log.warn('portal_paused', `portal ${r.portalId}: token revoked; PAUSED (queue kept, probed every ${Math.round(PAUSE_PROBE_MS / 60_000)} min)`, {
          portalId: r.portalId,
        });
      }
    }
  }

  /**
   * What a delivered stamp leaves behind: the record's spacing time, which change each record now shows (normal stamps
   * only; absorb.ts corrects only a change the record shows) and the stamp markers. One transaction.
   */
  private recordDelivered(updates: StampUpdate[], at: number): void {
    const { store } = this.opts;
    const normal = updates.filter((u) => u.amendOf === undefined);
    store.transaction(() => {
      store.stamps.setLastStampAt(updates.map(recordKey), at);
      store.stamps.setLastStampedChange(normal.map((u) => ({ recordKey: recordKey(u), changeId: stampIdOf(u) })), at);
      store.seen.markSeen(normal.map((u) => SENT_PREFIX + stampIdOf(u)), at);
      store.seen.markSeen(updates.map((u) => STAMP_PREFIX + stampIdOf(u)), at);
    });
  }

  /** `since` = when this pause episode began; each episode is handed to onPauseExpired once (retried if it throws). */
  private async expirePause(p: number, since: number): Promise<void> {
    const key = `${p}:${since}`;
    if (this.expiredHandled.has(key)) return;
    this.expiredHandled.add(key);
    this.log.alert(
      'pause_expired',
      `portal ${p}: paused for over ${Math.round(PAUSE_MAX_MS / 86_400_000)} days without a reinstall; running the uninstall routine (data purge)`,
      { portalId: p },
    );
    try {
      await this.opts.onPauseExpired?.(p);
    } catch (e) {
      this.log.error('pause_expiry_failed', `portal ${p}: pause-expiry purge failed: ${(e as Error).message}`, { portalId: p });
      this.expiredHandled.delete(key);
    }
  }

  private updateDepthMetric(): void {
    this.opts.metrics?.setStampQueueDepth(this.opts.store.stamps.queueDepthByPortal());
  }
}
