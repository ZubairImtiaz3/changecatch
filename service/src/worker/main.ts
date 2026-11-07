// ChangeCatch v1 worker: one always-on process for ALL installed portals.
//
//   journal (app-level, client credentials) -> dedupe -> watched-pair filter -> pairing -> label names
//   (portal OAuth token; held on failure) -> change_log -> persisted stamp queue -> CRM batch update
//
// The pipeline itself is runOnce() in src/core/poller.ts. This file adds the loop, the queue drain,
// monitoring, and graceful shutdown. Run it with: pnpm start:worker (tsx src/worker/main.ts)
//
// Loop timing (latency work 2026-10-30, target: stamped ~10 s after occurredAt):
//  - read the journal every JOURNAL_POLL_MS (3 s); a full batch re-reads at once; failures back off
//    exponentially (5 s .. 2 min, DEFAULT_DELAY_CONFIG), separately from polling.
//  - the loop sleeps until the EARLIEST of: next poll, the earliest pairing-hold deadline (runOnce's
//    nextReleaseAt), and the stamp queue's next due time. A due stamp is sent on that wake-up without a read.
//
// What the worker is wired to (tokens, watched pairs, labels, lifecycle, stamp queue, lock, monitoring): buildWorker
// and main() below; docs/architecture.md and docs/observability.md.

import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_PAIRING_CONFIG } from '../core/pairing.js';
import { LabelHoldError, type LabelCache, type LabelFetcher } from '../core/labels.js';
import { runOnce, type RunConfig, type RunDeps, type RunResult } from '../core/poller.js';
import { listLabels } from '../hubspot/labels.js';
import { journalClient } from '../hubspot/journal.js';
import { refreshAccessToken } from '../hubspot/oauth.js';
import { PortalTokenProvider, withPortalToken, type TokenProvider } from '../hubspot/portal-tokens.js';
import { sendStampBatches, type StampSendDeps } from '../hubspot/stamp.js';
import { createLabelOptionSync, type SyncLabelOptions } from '../hubspot/properties.js';
import { portalPairs } from '../core/pairs.js';
import { uninstallPortal } from '../hubspot/app-lifecycle.js';
import type { SubscriptionApi } from '../hubspot/journal.js';
import { startProcess } from '../lib/process.js';
import { getRateLimiter } from '../lib/rate-limiter.js';
import { loadConfig, type Config, type WorkerConfig } from '../lib/config.js';
import { ChangeCatchMetrics } from '../obs/metrics.js';
import { createLogger, type Logger } from '../obs/log.js';
import { Heartbeat } from '../obs/heartbeat.js';
import { Store } from '../store/db.js';
import { PortalStore } from '../store/portals.js';
import { makeLabelOptionSync } from './hooks.js';
import { healthSnapshot, registerWorkerGauges, StaleAlerter, startHealthServer } from './health.js';
import { Lifecycle } from './lifecycle.js';
import { WorkerLockError } from '../store/worker.js';
import { journalApiFor, makeJournalReader } from './journal-reader.js';
import { GuardedLabelCache } from './label-guard.js';
import { STAMP_PORTAL_CONCURRENCY, StampQueue } from './stamp-queue.js';
import { DEFAULT_DELAY_CONFIG, errorDelayMs, nextDelayMs, type DelayConfig } from './schedule.js';

/** A second worker refuses to start while the lock heartbeat is newer than this. */
export const WORKER_LOCK_STALE_MS = 30_000;

/** Longest single sleep, so the stale alert is re-checked even when idle. */
const MAX_SLEEP_MS = 60_000;

const rootLogger: Logger = createLogger('worker');

export interface WorkerDeps {
  store: Store;
  readJournal: RunDeps['readJournal'];
  /** Label lookups for pairing + names. Use a GuardedLabelCache so failures HOLD the batch. */
  labels: LabelCache;
  /** RunDeps.watchedPairs: buildWorker passes the ACTIVE pairs (core/pairs.ts portalPairs). */
  watchedPairs: RunDeps['watchedPairs'];
  queue: StampQueue;
  now: () => number;
  delay: DelayConfig;
  runConfig: Partial<RunConfig>;
  log: Logger;
  /** Injected for fake-clock tests. Unset: a real, stop()-interruptible setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** App install/uninstall events from the journal, and retries of failed uninstall cleanups. */
  lifecycle: Pick<Lifecycle, 'onOtherEvent' | 'runDue' | 'nextDueAt'>;
  metrics: ChangeCatchMetrics;
  /** External dead-man's switch (HEARTBEAT_URL): ok() after each successful read, fail() while stale. */
  pulse?: Pick<Heartbeat, 'ok' | 'fail'>;
}

export class Worker {
  readonly startedAt: number;
  private stopping = false;
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;
  private nextReadAt = 0;
  /** Failed journal runs in a row (error back-off). In memory: a restart starts the back-off afresh. */
  private failedRuns = 0;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly alerter: StaleAlerter;

  constructor(private deps: WorkerDeps) {
    this.now = deps.now;
    this.log = deps.log;
    this.alerter = new StaleAlerter(this.log.child({ component: 'health' }));
    this.startedAt = this.now();
  }

  /** Failed journal runs in a row (error back-off, /health). In memory: a restart starts the back-off afresh. */
  get consecutiveErrors(): number {
    return this.failedRuns;
  }

  /** One journal iteration (read -> ... -> stamp -> persist offset). Returns null if it failed. */
  async readOnce(): Promise<RunResult | null> {
    const { store } = this.deps;
    let result: RunResult | null = null;
    try {
      result = await runOnce({
        readJournal: this.deps.readJournal,
        enqueueStamps: (updates) => this.deps.queue.enqueue(updates),
        store,
        labels: this.deps.labels,
        watchedPairs: this.deps.watchedPairs,
        now: this.now,
        onOtherEvent: this.deps.lifecycle.onOtherEvent,
        log: this.log.child({ component: 'poller' }),
        config: this.deps.runConfig,
      });
      if (result.eventsRead > 0) {
        const queued = store.stamps.queueSize();
        this.log.info(
          'journal_read',
          `read ${result.eventsRead} event(s) -> ${result.changesEmitted} change(s), ${result.delivered} settled now (sent or coalesced), ` +
            `${queued} queued, ${result.pending} event(s) held for pairing (saved with the offset); offset ${result.offset ?? '(none)'}`,
          {
            files: result.filesRead,
            events: result.eventsRead,
            changes: result.changesEmitted,
            delivered: result.delivered,
            queued,
            pending: result.pending,
            offset: result.offset ?? null,
          },
        );
      }
      const m = this.deps.metrics;
      if (result.coalesced) {
        this.log.child({ component: 'stamp' }).info('stamps_coalesced', `coalesced ${result.coalesced} stamp(s) into later ones (bursts on the same record; all kept in change_log)`, {
          n: result.coalesced,
        });
        m.stampsCoalesced(result.coalesced);
      }
      m.journalRunOk({
        files: result.filesRead,
        events: result.eventsRead,
        newestOccurredAtMs: result.newestOccurredAtMs,
        caughtUp: !result.batchFull,
        offset: result.offset ?? null,
        offsetSaved: result.offset != null,
      });
      for (const [p, n] of result.changesByPortal) m.changesProcessed(p, n);
      for (const [p, n] of result.parkDroppedByPortal) m.dataLoss('park_dropped', n, p);
      this.failedRuns = 0;
      void this.deps.pulse?.ok();
      if (result.parkedPortals.length)
        this.log.warn('entries_parked', `${result.parked} entries PARKED for portal(s) ${result.parkedPortals.join(', ')} (label lookup held; retried every run)`, {
          parked: result.parked,
          portals: result.parkedPortals,
        });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.failedRuns++;
      store.journal.recordError(msg, this.now());
      // http_errors is counted per HTTP response in src/lib/http.ts, so not here (no double counting).
      this.deps.metrics.journalRunFailed();
      // Held labels are an expected state: log them, don't report them.
      if (e instanceof LabelHoldError) this.log.warn('batch_held', `batch HELD (offset not saved): ${msg}`);
      else this.log.error('journal_run_failed', `journal run failed (offset not saved): ${msg}`, { error: e });
    }
    const t = this.now();
    const delay = this.deps.delay;
    this.nextReadAt = t + (result ? nextDelayMs(result.batchFull, delay) : errorDelayMs(this.failedRuns, delay));
    // Wake up exactly when a held pairing cluster can be released (never on a failed run: error back-off wins).
    if (result?.nextReleaseAt != null) this.nextReadAt = Math.min(this.nextReadAt, Math.max(t, result.nextReleaseAt));
    return result;
  }

  /** Send queued stamps that are due. Never throws. */
  async drainQueue(): Promise<void> {
    try {
      const r = await this.deps.queue.drain();
      if (r.sent.length || r.dropped.length || r.failed.length)
        this.log.info('queue_drain', `queue: ${r.sent.length} stamped, ${r.dropped.length} dropped, ${r.failed.length} to retry`, {
          sent: r.sent.length,
          dropped: r.dropped.length,
          failed: r.failed.length,
        });
    } catch (e) {
      this.log.error('queue_drain_failed', `queue drain failed: ${(e as Error).message}`, { error: e });
    }
  }

  /** Retry failed install/uninstall handling that is due. Never throws. */
  async retryLifecycle(): Promise<void> {
    try {
      await this.deps.lifecycle.runDue();
    } catch (e) {
      this.log.error('lifecycle_retry_failed', `lifecycle retry failed: ${(e as Error).message}`, { error: e });
    }
  }

  /** When the loop wakes next: min(next read / hold deadline, stamp queue due time, lifecycle retry). */
  nextWakeAt(): number {
    return Math.min(this.nextReadAt, this.deps.store.stamps.nextDueAt() ?? Infinity, this.deps.lifecycle.nextDueAt() ?? Infinity);
  }

  /** Main loop. Resolves after stop() once the current batch is finished. */
  run(): Promise<void> {
    if (!this.loop) this.loop = this.loopBody();
    return this.loop;
  }

  private async loopBody(): Promise<void> {
    const { store } = this.deps;
    this.log.info('worker_started', `started; offset ${store.journal.getOffset() ?? '(none: will start from latest)'}, ${store.stamps.queueSize()} stamp(s) queued`, {
      offset: store.journal.getOffset(),
      queued: store.stamps.queueSize(),
    });
    while (!this.stopping) {
      if (this.now() >= this.nextReadAt) await this.readOnce();
      if (this.stopping) break;
      await this.drainQueue();
      await this.retryLifecycle();
      // Stale (no successful read for 1 h, worker/health.ts STALE_AFTER_MS): the alerter sends alert "worker_stale" every 15 min;
      // the heartbeat /fail ping is throttled by Heartbeat itself (state changes at once, repeats <= 1/min).
      if (this.alerter.check(store, this.now())) void this.deps.pulse?.fail('no successful journal read for 1 h');
      if (this.stopping) break;
      const ms = Math.max(0, Math.min(MAX_SLEEP_MS, this.nextWakeAt() - this.now()));
      if (ms > 0) await (this.deps.sleep ? this.deps.sleep(ms) : this.sleep(ms));
    }
    this.log.info('worker_stopped', `stopped; offset ${store.journal.getOffset() ?? '(none)'}, ${store.stamps.queueSize()} stamp(s) left in the queue for next start`, {
      offset: store.journal.getOffset(),
      queued: store.stamps.queueSize(),
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
    });
  }

  /** Ask the loop to stop. The batch in progress finishes (and saves its offset) first. */
  stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    return this.loop ?? Promise.resolve();
  }
}

// ---------------------------------------------------------------- wiring

/** What the worker talks to. createWorker passes the real ones; tests pass fakes for HubSpot and the clock. */
export interface WorkerParts {
  store: Store;
  /** Install state, watched pairs, spacing (same database file as `store`). */
  portals: PortalStore;
  tokens: TokenProvider;
  /** Journal subscriptions, for the uninstall cleanup in HubSpot. */
  subscriptions: Pick<SubscriptionApi, 'deletePortalSubscriptions'>;
  readJournal: RunDeps['readJournal'];
  /** Label definitions of one pair (createWorker: HubSpot, with the portal's token). */
  fetchLabels: LabelFetcher;
  /** Dropdown option sync (hooks.ts makeLabelOptionSync runs it). Production: createLabelOptionSync(). */
  syncLabels: SyncLabelOptions;
  /** CRM batch update. Default: the real HubSpot call. */
  batchUpdate?: StampSendDeps['batchUpdate'];
  metrics: ChangeCatchMetrics;
  /** Root logger; each component gets a child. */
  log: Logger;
  pulse?: Pick<Heartbeat, 'ok' | 'fail'>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The worker's wiring: production (createWorker) and the tests both build the worker here. */
export function buildWorker(
  config: WorkerConfig,
  parts: WorkerParts,
): { worker: Worker; queue: StampQueue; lifecycle: Lifecycle; labels: GuardedLabelCache } {
  const { store, portals, tokens, metrics, now } = parts;
  const logFor = (component: string): Logger => parts.log.child({ component });
  const mirror = config.stampMirror;
  // Saved pairs minus custom ones the portal has no custom write for (settings page shows those as inactive).
  const watchedPairs = (p: number) => portalPairs(portals, p).active;

  const optionSync = makeLabelOptionSync({ tokens, watchedPairs, mirror, sync: parts.syncLabels, log: logFor('labels') });
  const labels = new GuardedLabelCache({
    store: store.labels,
    fetch: parts.fetchLabels,
    onUnknownLabel: optionSync.onUnknownLabel,
    mirror,
    now,
    log: logFor('labels'),
  });
  registerWorkerGauges(metrics, store);
  const uninstallDeps = { subscriptions: parts.subscriptions, portals, tokens, now: now ?? Date.now, log: logFor('lifecycle') };
  const lifecycle = new Lifecycle({ uninstall: (p) => uninstallPortal(uninstallDeps, p), portals, store, metrics, now, log: logFor('lifecycle') });
  const queue = new StampQueue({
    store,
    revoked: portals,
    metrics,
    retryWindowMs: config.stampRetryMaxMs,
    // 7 days paused without a reinstall: same routine as an uninstall (HubSpot cleanup + data purge).
    onPauseExpired: (p) => lifecycle.handleUninstall(p, 'pause expired'),
    // A stamp refused because a value is not an option: the "announced" markers were wrong. Forget them (the next
    // event of that object type announces again) and re-sync now, before the retry.
    onInvalidOption: async (p, objectTypeId) => {
      store.labels.clearSyncedFor(p, objectTypeId);
      await optionSync.resync(p, objectTypeId);
    },
    // Settings page value (portals.stamp_spacing_seconds); its default for portals without a row.
    spacingFor: (p) => portals.getStampSpacingMs(p),
    sendBatches: (updates) =>
      sendStampBatches(updates, { tokens, log: logFor('stamp'), batchUpdate: parts.batchUpdate, concurrency: STAMP_PORTAL_CONCURRENCY }),
    now,
    log: logFor('stamp'),
  });

  const worker = new Worker({
    store,
    readJournal: parts.readJournal,
    labels,
    watchedPairs,
    queue,
    lifecycle,
    metrics,
    log: parts.log,
    pulse: parts.pulse,
    now: now ?? Date.now,
    sleep: parts.sleep,
    delay: { ...DEFAULT_DELAY_CONFIG, pollMs: config.journalPollMs ?? DEFAULT_DELAY_CONFIG.pollMs },
    // Spacing is done by the StampQueue (per portal).
    runConfig: {
      mirror,
      pairing: {
        ...DEFAULT_PAIRING_CONFIG,
        windowMs: config.pairingWindowMs ?? DEFAULT_PAIRING_CONFIG.windowMs,
        splitHoldMs: config.pairingSplitHoldMs ?? DEFAULT_PAIRING_CONFIG.splitHoldMs,
      },
    },
  });
  return { worker, queue, lifecycle, labels };
}

export interface WorkerOptions {
  metrics?: ChangeCatchMetrics;
  /** Root logger; each component gets a child. Default: createLogger('worker'). */
  log?: Logger;
  /** Heartbeat (HEARTBEAT_URL). Default: none here; main() creates one. */
  pulse?: Pick<Heartbeat, 'ok' | 'fail'>;
}

/** The production worker: the real database, tokens, journal and HubSpot calls, wired by buildWorker. */
export function createWorker(config: Config, opts: WorkerOptions = {}): {
  worker: Worker;
  store: Store;
  portals: PortalStore;
  metrics: ChangeCatchMetrics;
} {
  const root = opts.log ?? rootLogger;
  const store = new Store(config.dbPath);
  const portals = new PortalStore({ db: store.conn, key: config.tokenKey });
  const metrics = opts.metrics ?? new ChangeCatchMetrics();
  const journal = journalClient(config.hubspot);
  const tokens = new PortalTokenProvider({
    store: portals,
    refresh: (rt) => refreshAccessToken(config.hubspot, rt),
    logger: root.child({ component: 'oauth' }),
    metrics,
  });
  const { worker } = buildWorker(config.worker, {
    store,
    portals,
    tokens,
    subscriptions: journal,
    readJournal: makeJournalReader(journalApiFor(journal), { store, metrics, log: root.child({ component: 'journal' }) }),
    // Label definitions with the PORTAL's OAuth token (one refresh on 401).
    fetchLabels: (portalId, from, to) => withPortalToken(tokens, portalId, (auth) => listLabels(auth, from, to)),
    syncLabels: createLabelOptionSync(),
    metrics,
    log: root,
    pulse: opts.pulse,
  });
  return { worker, store, portals, metrics };
}

/** Process entry (see the guard at the bottom of this file): health server + signals + loop. */
export async function main(config: Config, opts: WorkerOptions = {}): Promise<void> {
  const log = opts.log ?? rootLogger;
  const metrics = opts.metrics ?? new ChangeCatchMetrics();
  startProcess(config, { log, metrics });
  const pulse = opts.pulse ?? new Heartbeat({ url: config.worker.heartbeatUrl, log: log.child({ component: 'heartbeat' }) });
  const { worker, store, portals } = createWorker(config, { ...opts, metrics, pulse });

  // Only ONE worker may read the shared journal offset. Refuse to start if another one heartbeated recently.
  try {
    store.worker.acquireLock(Date.now(), WORKER_LOCK_STALE_MS);
  } catch (e) {
    if (e instanceof WorkerLockError) log.alert('worker_lock_refused', `refusing to start: ${e.message}`);
    store.close();
    portals.close();
    throw e;
  }
  metrics.restore({ lastSuccessfulReadAt: store.journal.getLastSuccessfulReadAt(), offset: store.journal.getOffset() });
  const beat = setInterval(() => {
    if (!store.worker.heartbeat(Date.now())) {
      log.alert('worker_lock_lost', 'worker lock lost (another worker took over); stopping');
      void worker.stop();
    }
  }, Math.max(1_000, Math.floor(WORKER_LOCK_STALE_MS / 3)));
  beat.unref();

  const port = config.worker.healthPort;
  let server: Server | null = null;
  try {
    server = await startHealthServer({
      port,
      metrics,
      healthToken: config.worker.healthToken,
      snapshot: () =>
        healthSnapshot(store, Date.now(), {
          startedAt: worker.startedAt,
          consecutiveErrors: worker.consecutiveErrors,
          metrics,
          rateLimiter: () => getRateLimiter().stats(),
        }),
    });
    log.info('health_server', `health: http://localhost:${port}/health`, { port });
  } catch (e) {
    log.error('health_server_failed', `health server could not start on port ${port}: ${(e as Error).message} (worker keeps running)`, { port });
  }

  let signals = 0;
  const onSignal = (sig: string) => {
    signals++;
    if (signals > 1) {
      log.warn('shutdown_forced', `${sig} again: exiting now (the offset of an unfinished batch is NOT saved; it will be re-read)`);
      process.exit(130);
    }
    log.info('shutdown', `${sig}: finishing the current batch, then stopping (press again to force)`);
    void worker.stop();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  await worker.run();
  clearInterval(beat);
  store.worker.releaseLock();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  store.close();
  portals.close();
}

// Run as the process entry point (pnpm start:worker -> tsx src/worker/main.ts). Importing this module (tests, other
// code) does NOT start the worker.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Config first: a missing or bad variable exits with one clear error.
  Promise.resolve()
    .then(() => {
      return main(loadConfig('worker'));
    })
    .catch(async (e) => {
      rootLogger.error('fatal', `fatal: ${e instanceof Error ? e.message : String(e)}`, { error: e });
      process.exit(1);
    });
}
