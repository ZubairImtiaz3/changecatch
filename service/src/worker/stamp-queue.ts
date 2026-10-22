// Persisted stamp queue: per-record spacing (decision D4), burst coalescing (H4), a FAIR per-portal drain (H3),
// per-record retries (only the records that failed), dead letters (no silent drops) and revoked-token pauses.
//
// Enqueue (C1 + H4): planEnqueue() from src/core/coalesce.ts. Every record has its own timeline, so one hot record
//   never delays other records. COALESCE_MODE=latest folds a burst on one record into fewer stamps; the folded ones
//   are marked `stamp:<id>` seen (they stay in change_log) and count as delivered.
//
// Drain (H3), one "cycle":
//   - every portal with due rows gets a turn, in round-robin order (the start rotates each cycle);
//   - each portal sends at most maxPerPortalPerDrain records (default 100 = one batch call) per cycle, so portal A
//     with 50k queued and portal B with 1 both get a batch in the SAME cycle;
//   - all picked records go to sendStampBatches (src/hubspot/stamp.ts): grouped per portal + object type, portals in
//     parallel (STAMP_PORTAL_CONCURRENCY), each portal held to its own rate limit by src/lib/http.ts;
//   - a RetryLaterError (429 / our limiter full) for portal A defers ONLY A's records by retryAfterMs and skips A for
//     that long; B is not affected.
//   Rows skipped for spacing/order are deferred in ONE transaction (no per-row commits).
//
// Results, per record:
//   ok                        -> delete from queue, remember stamp time, mark `stamp:<id>` seen.
//   retryable (5xx/network)   -> back-off (retryBaseMs x2 .. retryMaxMs) for up to retryWindowMs (STAMP_RETRY_MAX_MS,
//                                24 h), then DEAD-LETTERED.
//   rate limited (429)        -> deferred by retryAfterMs, attempt not counted.
//   token revoked / 401       -> portal PAUSED: its queue is kept and probed every pauseProbeMs (1 h). Success unpauses.
//                                After pauseMaxMs (7 days) onPauseExpired runs (worker: the uninstall routine = purge).
//   refused (4xx, no token)   -> DEAD-LETTERED at once (worker-tables.ts stamp_dead_letter), never silently deleted.
//   Many refusals in a row for one portal -> one [ALERT] log line (head-of-line protection: it never blocks anyone).
//
// Failed sends do NOT hold the shared journal offset (default). blockOnFailure=true restores the old behaviour.
// Concurrency: enqueue and drain must not overlap (the worker loop is sequential; drainInline runs them in order).

import { coalesceOptionsFromEnv, planEnqueue, type CoalesceOptions } from '../core/coalesce.js';
import { recordKey, SENT_PREFIX, stampIdOf, type StampUpdate } from '../core/stamp.js';
import { STAMP_PREFIX } from '../core/poller.js';
import { sendStampBatches, type StampResult, type StamperDeps } from '../hubspot/stamp.js';
import type { ChangeCatchMetrics } from '../obs/metrics.js';
import type { Errors } from '../obs/errors.js';
import type { QueuedStamp, Store } from '../store/db.js';
import { LatencyTracker } from './latency.js';
import { isTokenRevokedError, type TokenProvider } from './tokens.js';
import { WorkerTables } from './worker-tables.js';
import { createLogger } from '../obs/log.js';
import { legacyLog } from '../obs/wiring.js';

export const DEFAULT_SPACING_MS = 3_000;
export const DEFAULT_RETRY_WINDOW_MS = 24 * 60 * 60_000;
export const DEFAULT_PAUSE_PROBE_MS = 60 * 60_000;
export const DEFAULT_PAUSE_MAX_MS = 7 * 24 * 60 * 60_000;

export interface StampQueueOptions {
  store: Store;
  tokens: TokenProvider;
  /** Fallback when spacingFor gives nothing. Default: env STAMP_SPACING_MS, else 3000. */
  defaultSpacingMs?: number;
  /** Per-portal spacing (ms) from the settings page. undefined = use defaultSpacingMs. */
  spacingFor?: (portalId: number) => number | undefined;
  /** Burst coalescing per portal. Default: off (every change one stamp). The worker wires COALESCE_MODE. */
  coalesceFor?: (portalId: number) => CoalesceOptions;
  /** true = sendStamps throws while one of its updates waits for a retry (holds the journal offset). Default false. */
  blockOnFailure?: boolean;
  /** true (default) = sendStamps also drains. The production worker sets false: the loop drains right after a read. */
  drainInline?: boolean;
  /** Optional hard cap on attempts (default: none; retryWindowMs decides). */
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Keep retrying a transient failure this long after the change happened (STAMP_RETRY_MAX_MS). Default 24 h. */
  retryWindowMs?: number;
  /** Portals sent in parallel (STAMP_PORTAL_CONCURRENCY). Default 8. */
  portalConcurrency?: number;
  /** Records per portal per drain cycle. Default 100 (one batch call). */
  maxPerPortalPerDrain?: number;
  pauseProbeMs?: number;
  pauseMaxMs?: number;
  /** Token provider's revoked flag (security work). true = pause the portal. */
  isRevoked?: (portalId: number) => boolean;
  /**
   * Every portal marked revoked, with when (token provider's revokedPortals()). Swept on each drain so a revoked
   * portal with NOTHING queued is still purged after pauseMaxMs.
   */
  revokedPortals?: () => { portalId: number; revokedAt: number }[];
  /** Called once when a portal has been paused for pauseMaxMs. The worker runs the uninstall routine. */
  onPauseExpired?: (portalId: number) => Promise<void> | void;
  /** Consecutive refused stamps for one portal before an [ALERT] line. Default 20. */
  alertAfterRefusals?: number;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, event?: string, fields?: Record<string, unknown>) => void;
  /** Error reporter for dead letters (data loss). Default: none (the log line and metrics still happen). */
  errors?: Pick<Errors, 'message'>;
  /** Injected for tests. Defaults to the real batch update call. */
  batchUpdate?: StamperDeps['batchUpdate'];
  /** Injected for tests. Default: sendStampBatches with the tokens/batchUpdate above. */
  sendBatches?: (updates: StampUpdate[]) => Promise<StampResult[]>;
  /** End-to-end latency (occurredAt -> stamped). Default: a new tracker. */
  latency?: LatencyTracker;
  metrics?: ChangeCatchMetrics;
  tables?: WorkerTables;
}

export interface DrainResult {
  sent: StampUpdate[];
  /** Dead-lettered (refused, or retries ran out). Not retried by the queue. */
  dropped: StampUpdate[];
  /** changeIds that failed with a transient error and were deferred. */
  failed: string[];
  errors: string[];
}

export class StampSendError extends Error {
  constructor(public changeIds: string[], detail: string) {
    super(`Stamping failed, will retry: ${detail}`);
    this.name = 'StampSendError';
  }
}

export function spacingFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.STAMP_SPACING_MS);
  return Number.isFinite(v) && v >= 0 && env.STAMP_SPACING_MS !== '' && env.STAMP_SPACING_MS !== undefined ? v : DEFAULT_SPACING_MS;
}

const idOf = stampIdOf;
const OFF: CoalesceOptions = { mode: 'off', threshold: 3 };

/** Auth failure that a reinstall can fix: pause the portal instead of dropping. */
function isAuthFailure(r: Extract<StampResult, { ok: false }>): boolean {
  return /token revoked|invalid_grant|BAD_REFRESH_TOKEN/i.test(r.reason) || (!r.retryable && /failed with 401\b/.test(r.reason));
}
const isRateLimited = (r: Extract<StampResult, { ok: false }>) =>
  r.retryable && r.retryAfterMs !== undefined && !/token revoked/i.test(r.reason);

export { coalesceOptionsFromEnv };

export class StampQueue {
  private readonly now: () => number;
  private readonly log: NonNullable<StampQueueOptions['log']>;
  private readonly defaultSpacing: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly retryWindowMs: number;
  private readonly perPortal: number;
  private readonly pauseProbeMs: number;
  private readonly pauseMaxMs: number;
  private draining: Promise<DrainResult> | null = null;
  /** Round-robin start: the first portal id served in the last cycle. */
  private cursor = -Infinity;
  /** In-memory: portal skipped until (after a RetryLaterError). */
  private readonly skipUntil = new Map<number, number>();
  private readonly refusals = new Map<number, number>();
  private readonly lastAlertAt = new Map<number, number>();
  private readonly expiredHandled = new Set<number>();
  /** occurredAt -> stamped latency of every accepted stamp (p50/p95 shown in /health). */
  readonly latency: LatencyTracker;
  readonly tables: WorkerTables;

  constructor(private opts: StampQueueOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? legacyLog(createLogger('stamp'));
    this.defaultSpacing = opts.defaultSpacingMs ?? spacingFromEnv();
    this.retryBaseMs = opts.retryBaseMs ?? 5_000;
    this.retryMaxMs = opts.retryMaxMs ?? 10 * 60_000;
    this.retryWindowMs = opts.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS;
    this.perPortal = Math.max(1, opts.maxPerPortalPerDrain ?? 100);
    this.pauseProbeMs = opts.pauseProbeMs ?? DEFAULT_PAUSE_PROBE_MS;
    this.pauseMaxMs = opts.pauseMaxMs ?? DEFAULT_PAUSE_MAX_MS;
    this.latency = opts.latency ?? new LatencyTracker();
    this.tables = opts.tables ?? new WorkerTables(opts.store);
  }

  spacingFor(portalId: number): number {
    return this.opts.spacingFor?.(portalId) ?? this.defaultSpacing;
  }

  /**
   * Plan (per-record slots + coalescing) and persist. Idempotent on change id.
   * Returns the updates that were coalesced away (never stamped; marked seen; still in change_log).
   */
  enqueue(updates: StampUpdate[]): StampUpdate[] {
    const { store } = this.opts;
    const t = this.now();
    const plan = planEnqueue({
      fresh: updates,
      queuedFor: (k) => this.tables.queuedFor(k).map((q) => ({ changeId: q.changeId, update: q.update, notBefore: q.notBefore })),
      lastStampAt: (k) => store.getLastStampAt(k),
      now: t,
      spacingFor: (p) => this.spacingFor(p),
      coalesceFor: this.opts.coalesceFor ?? (() => OFF),
    });
    store.transaction(() => {
      store.enqueueStamps(plan.insert, t);
      this.tables.reslot(plan.reslot);
      const queuedDrops = plan.drop.filter((d) => d.wasQueued).map((d) => d.changeId);
      if (queuedDrops.length) store.deleteQueued(queuedDrops);
      if (plan.drop.length) store.markSeen(plan.drop.map((d) => STAMP_PREFIX + d.changeId), t);
    });
    if (plan.drop.length) {
      this.log('info', `coalesced ${plan.drop.length} stamp(s) into later ones (bursts on the same record; all kept in change_log)`);
      this.metricsInc('stamps_coalesced', plan.drop.length);
    }
    return plan.drop.map((d) => d.update);
  }

  /**
   * RunDeps.sendStamps for runOnce: enqueue, then (drainInline) send whatever is due now.
   * onDelivered gets this call's updates that were sent, dead-lettered or coalesced now (so runOnce counts them).
   */
  async sendStamps(updates: StampUpdate[], onDelivered: (done: StampUpdate[]) => void): Promise<void> {
    const coalesced = this.enqueue(updates);
    const mine = new Set(updates.map(idOf));
    const r = this.opts.drainInline === false ? { sent: [], dropped: [], failed: [], errors: [] } : await this.drain();
    const done = [...coalesced, ...[...r.sent, ...r.dropped].filter((u) => mine.has(idOf(u)))];
    if (done.length) onDelivered(done);
    if (!this.opts.blockOnFailure) return; // failures retry from the persisted queue (see the header)
    const failedMine = [...mine].filter((id) => (this.opts.store.queuedAttempts(id) ?? 0) > 0);
    if (failedMine.length) throw new StampSendError(failedMine, r.errors.join('; ') || 'waiting for a retry of an earlier failed send');
  }

  /** Send due stamps (one fair cycle). Concurrent calls share one run. Never throws for HubSpot errors. */
  drain(): Promise<DrainResult> {
    if (!this.draining) this.draining = this.drainOnce().finally(() => (this.draining = null));
    return this.draining;
  }

  /** Earliest time the drain has work: a due row of an unpaused portal, or a paused portal's next probe. */
  nextDueAt(): number | null {
    const n = this.tables.nextDueAt();
    if (n === null) return null;
    // A portal skipped after a 429 has its rows deferred already; nothing else to fold in.
    return n;
  }

  // ---------------------------------------------------------------- drain

  private async drainOnce(): Promise<DrainResult> {
    const { store } = this.opts;
    const out: DrainResult = { sent: [], dropped: [], failed: [], errors: [] };
    const t = this.now();
    await this.sweepRevoked(t);
    const portals = this.tables.portalsWithDue(t);
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
    const expired: number[] = [];

    for (const p of order) {
      if ((this.skipUntil.get(p) ?? 0) > t) continue;
      let pause = this.tables.getPause(p);
      if (!pause && this.opts.isRevoked?.(p)) {
        pause = this.tables.pause(p, t, t, 'token revoked (token provider)');
        this.log('warn', `portal ${p}: token revoked; PAUSED (queue kept, probed every ${Math.round(this.pauseProbeMs / 60_000)} min)`);
      }
      let limit = this.perPortal;
      if (pause) {
        if (t - pause.since >= this.pauseMaxMs) {
          expired.push(p);
          continue;
        }
        if (pause.nextTryAt > t) continue;
        limit = 1; // probe with one record
        this.tables.pause(p, t, t + this.pauseProbeMs, pause.reason ?? 'paused');
      }
      const sp = this.spacingFor(p);
      const taken = new Set<string>();
      const list: QueuedStamp[] = [];
      for (const q of this.tables.dueForPortal(p, t, Math.max(1000, limit * 10))) {
        if (taken.has(q.recordKey)) {
          defer(q.changeId, t + sp); // a later change for a record we send now
          continue;
        }
        const first = store.firstQueuedFor(q.recordKey);
        if (first && first.changeId !== q.changeId) {
          defer(q.changeId, Math.max(t, first.notBefore) + sp); // keep per-record order
          continue;
        }
        const last = store.getLastStampAt(q.recordKey);
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
    if (defers.size) store.transaction(() => { for (const [at, ids] of defers) store.deferQueued(ids, at); });

    // Interleave portals so the batch groups are in round-robin order too.
    const interleaved: QueuedStamp[] = [];
    const lists = [...picks.values()];
    for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) interleaved.push(l[i]);

    if (interleaved.length) {
      const byId = new Map(interleaved.map((q) => [q.changeId, q]));
      let results: StampResult[];
      try {
        results = await this.sendBatches(interleaved.map((q) => q.update));
      } catch (e) {
        // sendStampBatches never throws; a custom sender might. Treat everything as a transient failure.
        const reason = e instanceof Error ? e.message : String(e);
        results = interleaved.map((q) => ({ update: q.update, ok: false, retryable: true, reason }));
      }
      this.applyResults(results, byId, out);
    }

    for (const p of expired) await this.expirePause(p);
    this.updateDepthMetric();
    return out;
  }

  private sendBatches(updates: StampUpdate[]): Promise<StampResult[]> {
    if (this.opts.sendBatches) return this.opts.sendBatches(updates);
    return sendStampBatches(updates, {
      getToken: (p, o) => this.opts.tokens.getAccessToken(p, o),
      log: this.log,
      batchUpdate: this.opts.batchUpdate,
      concurrency: Math.max(1, this.opts.portalConcurrency ?? 8),
    });
  }

  private applyResults(results: StampResult[], byId: Map<string, QueuedStamp>, out: DrainResult): void {
    const { store } = this.opts;
    const at = this.now();
    const okByPortal = new Map<number, QueuedStamp[]>();
    const dead: { q: QueuedStamp; error: string }[] = [];
    const errorsByPortal = new Map<number, string>();

    for (const r of results) {
      const q = byId.get(idOf(r.update));
      if (!q) continue;
      const p = q.portalId;
      if (r.ok) {
        (okByPortal.get(p) ?? okByPortal.set(p, []).get(p)!).push(q);
        continue;
      }
      errorsByPortal.set(p, r.reason);
      if (isAuthFailure(r)) {
        const pause = this.tables.pause(p, at, at + this.pauseProbeMs, r.reason);
        store.deferQueued([q.changeId], at + this.pauseProbeMs, { error: r.reason });
        out.failed.push(q.changeId);
        if (pause.since === at)
          this.log('warn', `[ALERT] portal ${p}: token revoked/invalid; PAUSED (queue kept, probed hourly, purged after ${Math.round(this.pauseMaxMs / 86_400_000)} days without a reinstall): ${r.reason}`);
        continue;
      }
      if (isRateLimited(r)) {
        const wait = r.retryAfterMs!;
        this.skipUntil.set(p, Math.max(this.skipUntil.get(p) ?? 0, at + wait));
        store.deferQueued([q.changeId], at + wait, { error: r.reason });
        out.failed.push(q.changeId);
        // HubSpot 429 responses are counted where they happen (obs/wiring.ts instrumentFetch); here only the
        // deferrals our own limiter caused, so one throttle is not counted twice.
        if (!/failed with 429/.test(r.reason)) this.opts.metrics?.rateLimited(p);
        continue;
      }
      if (r.retryable) {
        const attempts = q.attempts + 1;
        const tooOld = at - q.update.occurredAtMs >= this.retryWindowMs;
        const tooMany = this.opts.maxAttempts !== undefined && attempts >= this.opts.maxAttempts;
        if (tooOld || tooMany) {
          dead.push({ q, error: `gave up after ${attempts} attempt(s): ${r.reason}` });
          this.opts.metrics?.stampsFailed(p, 1, 'gave_up');
          this.opts.metrics?.dataLoss('dead_letter', 1, p);
          continue;
        }
        const wait = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (attempts - 1));
        store.deferQueued([q.changeId], at + wait, { error: r.reason, countAttempt: true });
        out.failed.push(q.changeId);
        this.opts.metrics?.stampsFailed(p, 1, 'retry');
        this.log('warn', `portal ${p}: stamp ${q.changeId} failed (attempt ${attempts}), retry in ${Math.round(wait / 1000)}s: ${r.reason}`);
        continue;
      }
      dead.push({ q, error: r.reason });
      this.opts.metrics?.stampsFailed(p, 1, 'dropped');
      this.opts.metrics?.dataLoss('stamp_dropped', 1, p);
    }

    for (const [p, msg] of errorsByPortal) {
      out.errors.push(`portal ${p}: ${msg}`);
      store.recordPortalError(p, msg, at);
    }

    // Accepted.
    for (const [p, list] of okByPortal) {
      const ids = list.map((q) => q.changeId);
      store.transaction(() => {
        store.deleteQueued(ids);
        store.setLastStampAt(list.map((q) => q.recordKey), at);
        // Which change each record now shows (absorb.ts only corrects a change the record actually shows).
        const normal = list.filter((q) => q.update.amendOf === undefined);
        store.setLastStampedChange(normal.map((q) => ({ recordKey: q.recordKey, changeId: q.changeId })), at);
        store.markSeen(normal.map((q) => SENT_PREFIX + q.changeId), at);
        store.markSeen(ids.map((id) => STAMP_PREFIX + id), at);
        store.addStampMetrics(p, { sent: list.length });
      });
      // Amend stamps (late-half label fixes) are not new changes: no latency sample.
      const lat = list.filter((q) => q.update.amendOf === undefined).map((q) => at - q.update.occurredAtMs);
      for (const ms of lat) this.latency.record(ms);
      this.opts.metrics?.stampsSent(p, list.length, lat);
      this.refusals.delete(p);
      if (this.tables.unpause(p)) this.log('info', `portal ${p}: stamping works again; pause lifted`);
      for (const q of list) {
        out.sent.push(q.update);
        const u = q.update;
        if (u.amendOf !== undefined) {
          this.log('info', `amended labels on portal ${p} ${u.objectTypeId}/${u.objectId} for change ${u.amendOf} (late journal half; no new change id)`);
          continue;
        }
        this.log(
          'info',
          `stamped portal ${p} ${u.objectTypeId}/${u.objectId} ${u.properties.changecatch_change_type} ` +
            `change ${q.changeId}: ${((at - u.occurredAtMs) / 1000).toFixed(1)}s after occurredAt` +
            // Burst size lives only in logs/metrics now (decision D5: no count property on the record).
            ((u.coalescedCount ?? 1) > 1 ? ` (stands for ${u.coalescedCount} changes; burst coalesced)` : ''),
        );
      }
    }

    // Dead letters: never silently deleted.
    if (dead.length) {
      store.transaction(() => {
        this.tables.deadLetter(dead, at);
        store.deleteQueued(dead.map((d) => d.q.changeId));
        store.markSeen(dead.map((d) => STAMP_PREFIX + d.q.changeId), at);
        const per = new Map<number, number>();
        for (const d of dead) per.set(d.q.portalId, (per.get(d.q.portalId) ?? 0) + 1);
        for (const [p, n] of per) store.addStampMetrics(p, { dropped: n });
      });
      for (const d of dead) out.dropped.push(d.q.update);
      const per = new Map<number, { q: QueuedStamp; error: string }[]>();
      for (const d of dead) (per.get(d.q.portalId) ?? per.set(d.q.portalId, []).get(d.q.portalId)!).push(d);
      for (const [p, list] of per) {
        this.log('error', `portal ${p}: ${list.length} stamp(s) DEAD-LETTERED (kept in stamp_dead_letter): ${list[0].error}`, 'dead_letter', {
          portalId: p,
          n: list.length,
        });
        this.opts.errors?.message('stamps dead-lettered', { component: 'stamp', op: 'stamp_dead_letter', portalId: p, extra: { n: list.length, error: list[0].error } });
        const n = (this.refusals.get(p) ?? 0) + list.length;
        this.refusals.set(p, n);
        const threshold = this.opts.alertAfterRefusals ?? 20;
        const last = this.lastAlertAt.get(p);
        if (n >= threshold && (last === undefined || at - last >= 15 * 60_000)) {
          this.lastAlertAt.set(p, at);
          this.log('error', `[ALERT] portal ${p}: ${n} stamps refused in a row (bad data / missing property or scope?). Other portals are not affected. Last: ${list[0].error}`);
        }
      }
    }
  }

  /** Revoked portals: pause them (from the revocation time) and purge the ones revoked for over pauseMaxMs. */
  private async sweepRevoked(t: number): Promise<void> {
    let list: { portalId: number; revokedAt: number }[] = [];
    try {
      list = this.opts.revokedPortals?.() ?? [];
    } catch (e) {
      this.log('warn', `revokedPortals() failed: ${(e as Error).message}`);
    }
    for (const r of list) {
      const since = Math.min(r.revokedAt, this.tables.getPause(r.portalId)?.since ?? Infinity);
      if (t - since >= this.pauseMaxMs) await this.expirePause(r.portalId);
      else if (!this.tables.getPause(r.portalId)) this.tables.pause(r.portalId, since, t + this.pauseProbeMs, 'token revoked (token provider)');
    }
  }

  private async expirePause(p: number): Promise<void> {
    if (this.expiredHandled.has(p)) return;
    this.expiredHandled.add(p);
    this.log('error', `[ALERT] portal ${p}: paused for over ${Math.round(this.pauseMaxMs / 86_400_000)} days without a reinstall; running the uninstall routine (data purge)`);
    try {
      await this.opts.onPauseExpired?.(p);
    } catch (e) {
      this.log('error', `portal ${p}: pause-expiry purge failed: ${(e as Error).message}`);
      this.expiredHandled.delete(p);
    }
  }

  private updateDepthMetric(): void {
    this.opts.metrics?.setStampQueueDepth(this.tables.queueDepthByPortal());
  }

  private metricsInc(name: string, n: number): void {
    const r = this.opts.metrics?.registry;
    if (!r) return;
    try {
      r.inc(name, n);
    } catch {
      /* not defined: ignore */
    }
  }
}

export { recordKey };
