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
//    exponentially (JOURNAL_ERROR_BASE_MS .. JOURNAL_ERROR_MAX_MS), separately from polling.
//  - the loop sleeps until the EARLIEST of: next poll, the earliest pairing-hold deadline (runOnce's
//    nextReleaseAt), and the stamp queue's next due time. A due stamp is sent on that wake-up without a read.
//
// Wiring done in createWorkerFromEnv (one source of truth each):
//  - tokens:        install work's encrypted per-portal tokens (PortalStore + PortalTokenProvider), via
//                   workerTokenProvider. No .env token fallback.
//  - watched pairs: portal_settings (written by the settings page / installer; read by Store.getWatchedPairs).
//  - spacing:       portals.stamp_spacing_seconds (settings page). STAMP_SPACING_MS only for portals without a row.
//  - label options: onUnknownLabel -> syncLabelOptions (hooks.ts).
//  - lifecycle:     APP_LIFECYCLE_EVENT -> handleLifecycleEvent (hooks.ts) wrapped in LifecycleRetry: a failure is
//                   persisted + retried with back-off; it never holds the shared offset (C2).
//  - parking:       a portal whose label lookup is held is parked (capped per portal, PARK_MAX_PER_PORTAL); the offset
//                   moves on for the others.
//  - stamping:      StampQueue: coalescing (COALESCE_MODE), fair round-robin drain across portals (H3), per-record
//                   retries, dead letters, revoked-token pauses (7 days -> uninstall routine).
//  - single worker: worker_lock row + heartbeat; a second worker refuses to start (WORKER_LOCK_STALE_MS, 30 s).
//  - monitoring:    src/obs metrics -> /health (JSON) and /metrics (Prometheus). Per-portal detail needs x-health-token.
//                   JSON logs (LOG_LEVEL / LOG_FORMAT); `[ALERT]` lines -> level error, event alert, error reporter.
//                   Heartbeat (HEARTBEAT_URL): ok after successful reads (<= 1/min), /fail while stale.
//                   Errors (SENTRY_DSN optional): unexpected run failures, alerts, crashes; flushed on shutdown.
//                   HTTP metrics: instrumentFetch counts every HubSpot request / error / 429.

import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dbPath } from '../lib/env.js';
import { StoreLabelCache, type LabelCache } from '../core/labels.js';
import { pairingConfigFromEnv } from '../core/pairing.js';
import { DEFAULT_STAMP_CONFIG } from '../core/stamp.js';
import {
  DEFAULT_DELAY_CONFIG,
  delayAfter,
  delayConfigFromEnv,
  runOnce,
  STALE_AFTER_MS,
  type DelayConfig,
  type RunConfig,
  type RunDeps,
  type RunResult,
} from '../core/poller.js';
import type { JournalEvent } from '../core/types.js';
import { listLabels } from '../hubspot/labels.js';
import { Installer } from '../install/installer.js';
import { PortalTokenProvider } from '../install/token-provider.js';
import { HttpError } from '../lib/http.js';
import { rateLimiterStats } from '../lib/rate-limiter.js';
import { coalesceOptionsFromEnv } from '../core/coalesce.js';
import { ChangeCatchMetrics } from '../obs/metrics.js';
import { createLogger, type Logger } from '../obs/log.js';
import { errors as globalErrors, initErrorReporting, installProcessHandlers, type Errors } from '../obs/errors.js';
import { Heartbeat } from '../obs/heartbeat.js';
import { instrumentFetch, legacyLog, type LegacyLog } from '../obs/wiring.js';
import { portalIdForToken } from '../lib/rate-limiter.js';
import { Store } from '../store/db.js';
import { PortalStore } from '../store/portals.js';
import { makeLabelOptionSync, makeLifecycleHook } from './hooks.js';
import { healthSnapshot, registerWorkerGauges, StaleAlerter, startHealthServer } from './health.js';
import { LifecycleRetry, syntheticUninstall } from './lifecycle-retry.js';
import { WorkerLockError, WorkerTables } from './worker-tables.js';
import type { LatencyStats } from './latency.js';
import { makeJournalReader, realJournalApi, type JournalApi } from './journal-reader.js';
import { GuardedLabelCache, LabelHoldError, type UnknownLabelHook } from './label-guard.js';
import { DEFAULT_PAUSE_MAX_MS, DEFAULT_RETRY_WINDOW_MS, StampQueue, StampSendError } from './stamp-queue.js';
import { workerTokenProvider, type TokenProvider } from './tokens.js';

/** `(level, msg, event?, fields?)`. Plain `(level, msg)` callbacks (tests) still fit. */
type Log = LegacyLog;
const rootLogger: Logger = createLogger('worker');
const defaultLog: Log = legacyLog(rootLogger);

export interface WorkerDeps {
  store: Store;
  readJournal: RunDeps['readJournal'];
  /** Label lookups for pairing + names. Use a GuardedLabelCache so failures HOLD the batch. */
  labels: LabelCache;
  queue: StampQueue;
  now?: () => number;
  delay?: DelayConfig;
  runConfig?: Partial<RunConfig>;
  /** Non-association journal events (e.g. app install/uninstall). Hook for the install work. */
  onOtherEvent?: RunDeps['onOtherEvent'];
  /** Per-portal parking (RunDeps.isParkable). createWorkerFromEnv passes `e instanceof LabelHoldError`. */
  isParkable?: RunDeps['isParkable'];
  alerter?: StaleAlerter;
  staleAfterMs?: number;
  /** Longest single sleep, so the stale alert is re-checked even when idle. */
  maxSleepMs?: number;
  log?: Log;
  verbose?: boolean;
  /** Injected for fake-clock tests. Default: a real, stop()-interruptible setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Persisted lifecycle retries. When set, onOtherEvent is wrapped so a lifecycle failure never holds the offset. */
  lifecycleRetry?: LifecycleRetry;
  metrics?: ChangeCatchMetrics;
  /** Worker lock heartbeat (set when main() holds the lock). Returns false if another worker took over. */
  heartbeat?: () => boolean;
  /** External dead-man's switch (HEARTBEAT_URL): ok() after each successful read, fail() while stale. */
  pulse?: Pick<Heartbeat, 'ok' | 'fail'>;
  /** Error reporter for unexpected failures. Default: the process-wide `errors` (log backend unless Sentry is on). */
  errors?: Pick<Errors, 'capture'>;
}

export class Worker {
  readonly startedAt: number;
  private stopping = false;
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;
  private nextReadAt = 0;
  private readonly now: () => number;
  private readonly log: Log;
  private readonly alerter: StaleAlerter;
  private readonly errors: Pick<Errors, 'capture'>;

  constructor(private deps: WorkerDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? defaultLog;
    this.errors = deps.errors ?? globalErrors;
    this.alerter = deps.alerter ?? new StaleAlerter(undefined, (m) => this.log('error', m));
    this.startedAt = this.now();
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /** One journal iteration (read -> ... -> stamp -> persist offset). Returns null if it failed. */
  async readOnce(): Promise<RunResult | null> {
    const { store } = this.deps;
    let result: RunResult | null = null;
    try {
      result = await runOnce({
        readJournal: this.deps.readJournal,
        sendStamps: (updates, onDelivered) => this.deps.queue.sendStamps(updates, onDelivered),
        store,
        labels: this.deps.labels,
        now: this.now,
        onOtherEvent: this.deps.lifecycleRetry?.onOtherEvent ?? this.deps.onOtherEvent,
        isParkable: this.deps.isParkable,
        log: (msg) => this.log('info', msg, 'poller'),
        alert: (msg) => this.log('error', msg, 'alert'),
        config: { ...this.deps.runConfig, deliveryMode: 'stamp' },
      });
      if (result.eventsRead > 0 || this.deps.verbose) {
        const queued = store.queueSize();
        this.log(
          'info',
          `read ${result.eventsRead} event(s) -> ${result.changesEmitted} change(s), ${result.occurrencesSent} stamped now, ` +
            `${queued} queued, ${result.pending} event(s) held for pairing (saved with the offset); offset ${result.offset ?? '(none)'}`,
          'journal_read',
          {
            files: result.filesRead,
            events: result.eventsRead,
            changes: result.changesEmitted,
            stampedNow: result.occurrencesSent,
            queued,
            pending: result.pending,
            offset: result.offset ?? null,
          },
        );
      }
      const m = this.deps.metrics;
      if (m) {
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
      }
      void this.deps.pulse?.ok();
      if (result.parkedPortals.length)
        this.log('warn', `${result.parked} entries PARKED for portal(s) ${result.parkedPortals.join(', ')} (label lookup held; retried every run)`, 'entries_parked', {
          parked: result.parked,
          portals: result.parkedPortals,
        });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // http_errors is counted per HTTP response by instrumentFetch, so not here (no double counting).
      this.deps.metrics?.journalRunFailed();
      // Held labels and unfinished stamp batches are expected states: log them, don't report them.
      if (e instanceof LabelHoldError) this.log('warn', `batch HELD (offset not saved): ${msg}`, 'batch_held');
      else if (e instanceof StampSendError) this.log('warn', `batch not finished (offset not saved): ${msg}`, 'batch_unfinished');
      else {
        this.log('error', `journal run failed (offset not saved): ${msg}`, 'journal_run_failed', { error: e });
        this.errors.capture(e, { component: 'worker', op: 'journal_run' });
      }
    }
    const t = this.now();
    this.nextReadAt = t + delayAfter(store, result, this.deps.delay ?? DEFAULT_DELAY_CONFIG);
    // Wake up exactly when a held pairing cluster can be released (never on a failed run: error back-off wins).
    if (result?.nextReleaseAt != null) this.nextReadAt = Math.min(this.nextReadAt, Math.max(t, result.nextReleaseAt));
    return result;
  }

  /** Send queued stamps that are due. Never throws. */
  async drainQueue(): Promise<void> {
    try {
      const r = await this.deps.queue.drain();
      if (r.sent.length || r.dropped.length || r.failed.length)
        this.log('info', `queue: ${r.sent.length} stamped, ${r.dropped.length} dropped, ${r.failed.length} to retry`, 'queue_drain', {
          sent: r.sent.length,
          dropped: r.dropped.length,
          failed: r.failed.length,
        });
    } catch (e) {
      this.log('error', `queue drain failed: ${(e as Error).message}`, 'queue_drain_failed', { error: e });
      this.errors.capture(e, { component: 'worker', op: 'stamp_drain' });
    }
  }

  /** When the next journal read is planned (wall-clock ms). */
  get nextReadTime(): number {
    return this.nextReadAt;
  }

  /** Retry failed install/uninstall handling that is due. Never throws. */
  async retryLifecycle(): Promise<void> {
    try {
      await this.deps.lifecycleRetry?.runDue();
    } catch (e) {
      this.log('error', `lifecycle retry failed: ${(e as Error).message}`, 'lifecycle_retry_failed', { error: e });
      this.errors.capture(e, { component: 'worker', op: 'lifecycle_retry' });
    }
  }

  /** When the loop wakes next: min(next read / hold deadline, stamp queue due time, lifecycle retry). */
  nextWakeAt(): number {
    return Math.min(this.nextReadAt, this.deps.queue.nextDueAt() ?? Infinity, this.deps.lifecycleRetry?.nextDueAt() ?? Infinity);
  }

  /** p50/p95 end-to-end latency (occurredAt -> stamped) of recent stamps, for /health. */
  latencyStats(): LatencyStats {
    return this.deps.queue.latency.stats();
  }

  /** Main loop. Resolves after stop() once the current batch is finished. */
  run(): Promise<void> {
    if (!this.loop) this.loop = this.loopBody();
    return this.loop;
  }

  private async loopBody(): Promise<void> {
    const { store } = this.deps;
    const staleAfter = this.deps.staleAfterMs ?? STALE_AFTER_MS;
    const maxSleep = this.deps.maxSleepMs ?? 60_000;
    this.log('info', `started; offset ${store.getOffset() ?? '(none: will start from latest)'}, ${store.queueSize()} stamp(s) queued`, 'worker_started', {
      offset: store.getOffset(),
      queued: store.queueSize(),
    });
    while (!this.stopping) {
      if (this.deps.heartbeat && !this.deps.heartbeat()) {
        this.log('error', '[ALERT] another worker took over the worker lock; stopping this one');
        this.stopping = true;
        break;
      }
      if (this.now() >= this.nextReadAt) await this.readOnce();
      if (this.stopping) break;
      await this.drainQueue();
      await this.retryLifecycle();
      // Stale (no successful read for STALE_AFTER_MS): the alerter logs the [ALERT] (-> error reporter) every 15 min;
      // the heartbeat /fail ping is throttled by Heartbeat itself (state changes at once, repeats <= 1/min).
      if (this.alerter.check(store, this.now(), staleAfter)) void this.deps.pulse?.fail('no successful journal read for 1 h');
      if (this.stopping) break;
      const ms = Math.max(0, Math.min(maxSleep, this.nextWakeAt() - this.now()));
      if (ms > 0) await (this.deps.sleep ? this.deps.sleep(ms) : this.sleep(ms));
    }
    this.log('info', `stopped; offset ${store.getOffset() ?? '(none)'}, ${store.queueSize()} stamp(s) left in the queue for next start`, 'worker_stopped', {
      offset: store.getOffset(),
      queued: store.queueSize(),
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

// ---------------------------------------------------------------- wiring from env

export interface WorkerFromEnvOptions {
  env?: NodeJS.ProcessEnv;
  store?: Store;
  /** Install state + encrypted tokens + spacing. Default: new PortalStore on the same DB_PATH. */
  portals?: PortalStore;
  /** Per-portal OAuth tokens. Default: workerTokenProvider (encrypted per-portal tokens from the install flow). */
  tokens?: TokenProvider;
  /** Used by the lifecycle hook. Default: new Installer on `portals`. */
  installer?: Pick<Installer, 'uninstall' | 'provision'>;
  /** Called when a new association label shows up, BEFORE it is stamped. Default: syncLabelOptions (hooks.ts). */
  onUnknownLabel?: UnknownLabelHook;
  onOtherEvent?: (event: JournalEvent, fileOffset: string) => Promise<void> | void;
  journalApi?: JournalApi;
  metrics?: ChangeCatchMetrics;
  /** Legacy callback for all components (tests). Default: structured JSON logger children per component. */
  log?: Log;
  /** Root structured logger. Default: createLogger('worker'). Ignored when `log` is set. */
  logger?: Logger;
  /** Error reporter. Default: the process-wide `errors`. */
  errors?: Errors;
  /** Heartbeat (HEARTBEAT_URL). Default: none here; main() creates one. */
  pulse?: Pick<Heartbeat, 'ok' | 'fail'>;
}

export function createWorkerFromEnv(opts: WorkerFromEnvOptions = {}): {
  worker: Worker;
  store: Store;
  portals: PortalStore;
  tables: WorkerTables;
  metrics: ChangeCatchMetrics;
} {
  const env = opts.env ?? process.env;
  const errs = opts.errors ?? globalErrors;
  const root = opts.logger ?? rootLogger;
  // One structured child logger per component; a caller-supplied legacy callback gets the old "[component] " prefix.
  const logFor = (component: string): Log =>
    opts.log ? (level, msg, event, fields) => opts.log!(level, `[${component}] ${msg}`, event, fields) : legacyLog(root.child({ component }), { errors: errs });
  const log: Log = opts.log ?? legacyLog(root, { errors: errs });
  for (const k of ['HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET']) if (!env[k]) throw new Error(`Missing env var ${k}. See .env.example.`);
  if (!opts.portals && !env.TOKEN_ENC_KEYS && !env.TOKEN_ENC_KEY)
    throw new Error('Missing env var TOKEN_ENC_KEYS (or legacy TOKEN_ENC_KEY); same value as the app server. See .env.example.');

  const db = dbPath(env.DB_PATH);
  const store = opts.store ?? new Store(db);
  const portals = opts.portals ?? new PortalStore({ path: db });
  const metrics = opts.metrics ?? new ChangeCatchMetrics();
  const realTokens = new PortalTokenProvider({ store: portals, logger: root.child({ component: 'oauth' }), metrics });
  const tokens = opts.tokens ?? workerTokenProvider({ portals, real: realTokens });
  const installer = opts.installer ?? new Installer({ portals, tokens: realTokens, log: (m) => logFor('install')('info', m) });

  const mirror = env.STAMP_MIRROR === '1';

  // Label definitions with the PORTAL's OAuth token (one refresh on 401).
  const fetchLabels = async (portalId: number, from: string, to: string) => {
    try {
      return await listLabels(await tokens.getAccessToken(portalId), from, to);
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) return listLabels(await tokens.getAccessToken(portalId, { forceRefresh: true }), from, to);
      throw e;
    }
  };
  const labels = new GuardedLabelCache(new StoreLabelCache(store, fetchLabels), {
    store,
    onUnknownLabel:
      opts.onUnknownLabel ?? makeLabelOptionSync({ tokens, watchedPairs: (p) => store.getWatchedPairs(p), mirror, log: logFor('labels') }),
    // Switching mirroring on means the other object type needs options too: announce every label once more.
    syncScope: mirror ? 'mirror' : undefined,
    maxHoldMs: numEnv(env.LABEL_MAX_HOLD_MS),
    log: logFor('labels'),
  });
  const tables = new WorkerTables(store);
  registerWorkerGauges(metrics, store, tables);
  const coalesce = coalesceOptionsFromEnv(env);
  const innerHook =
    opts.onOtherEvent ??
    makeLifecycleHook({ installer, portals, store, tables, log: (m) => logFor('lifecycle')('info', m), onPurged: (p) => metrics.forgetPortal(p) });
  const lifecycleRetry = new LifecycleRetry({
    tables,
    store,
    hook: innerHook,
    portals,
    baseMs: numEnv(env.LIFECYCLE_RETRY_BASE_MS),
    maxMs: numEnv(env.LIFECYCLE_RETRY_MAX_MS),
    installGraceMs: numEnv(env.LIFECYCLE_INSTALL_GRACE_MS),
    log: logFor('lifecycle'),
    onLocalPurge: (p) => {
      tables.purgePortal(p);
      metrics.forgetPortal(p);
    },
  });
  // Revocations (src/install/token-provider.ts, table token_revocations): pause the portal; purge after 7 days.
  const revokedSource = realTokens as unknown as {
    isRevoked?: (p: number) => boolean;
    revokedPortals?: () => { portalId: number; revokedAt: number }[];
  };
  const queue = new StampQueue({
    store,
    tokens,
    tables,
    metrics,
    coalesceFor: () => coalesce,
    drainInline: false, // the loop drains right after each read; a journal read never waits on CRM writes (H3)
    portalConcurrency: numEnv(env.STAMP_PORTAL_CONCURRENCY),
    retryWindowMs: numEnv(env.STAMP_RETRY_MAX_MS) ?? DEFAULT_RETRY_WINDOW_MS,
    pauseMaxMs: numEnv(env.PORTAL_PAUSE_MAX_MS) ?? DEFAULT_PAUSE_MAX_MS,
    isRevoked: typeof revokedSource.isRevoked === 'function' ? (p) => revokedSource.isRevoked!.call(revokedSource, p) : undefined,
    revokedPortals:
      typeof revokedSource.revokedPortals === 'function' ? () => revokedSource.revokedPortals!.call(revokedSource) : undefined,
    // 7 days paused without a reinstall: same routine as an uninstall (HubSpot cleanup + data purge).
    onPauseExpired: async (p) => {
      await lifecycleRetry.onOtherEvent(syntheticUninstall(p, Date.now()), 'pause-expired');
    },
    // Settings page value (portals.stamp_spacing_seconds). Portals without a row use STAMP_SPACING_MS / 3 s.
    spacingFor: (p) => (portals.getPortal(p) ? portals.getStampSpacingMs(p) : undefined),
    defaultSpacingMs: numEnv(env.STAMP_SPACING_MS),
    log: logFor('stamp'),
    errors: errs,
  });
  const readJournal = makeJournalReader(opts.journalApi ?? realJournalApi, {
    store,
    batchSize: numEnv(env.JOURNAL_BATCH_SIZE),
    skipAfterMs: numEnv(env.JOURNAL_SKIP_FAILED_AFTER_MS),
    downloadConcurrency: numEnv(env.JOURNAL_DOWNLOAD_CONCURRENCY),
    metrics,
    log: logFor('journal'),
  });

  const worker = new Worker({
    store,
    readJournal,
    labels,
    queue,
    lifecycleRetry,
    metrics,
    isParkable: (e) => e instanceof LabelHoldError,
    log,
    errors: errs,
    pulse: opts.pulse,
    verbose: env.WORKER_VERBOSE === '1',
    delay: delayConfigFromEnv(env),
    // Spacing is done by the StampQueue (per portal); STAMP_MIRROR=1 also stamps the other record.
    runConfig: {
      stamp: { ...DEFAULT_STAMP_CONFIG, mirrorOnOtherRecord: mirror },
      pairing: pairingConfigFromEnv(env),
      ...(numEnv(env.PARK_MAX_PER_PORTAL) !== undefined ? { maxParkedPerPortal: numEnv(env.PARK_MAX_PER_PORTAL) } : {}),
    },
  });
  return { worker, store, portals, tables, metrics };
}

function numEnv(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Expected a non-negative number, got "${v}"`);
  return n;
}

/** Process entry (see the guard at the bottom of this file): health server + signals + loop. */
export async function main(opts: WorkerFromEnvOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? defaultLog;
  // Errors first, so a crash during start-up is reported too. SENTRY_DSN set but @sentry/node missing = one warning.
  await initErrorReporting({ env, log: rootLogger.child({ component: 'errors' }) });
  installProcessHandlers();
  const pulse = opts.pulse ?? new Heartbeat({ url: env.HEARTBEAT_URL ?? null, log: rootLogger.child({ component: 'heartbeat' }) });
  const metrics = opts.metrics ?? new ChangeCatchMetrics();
  // Counts every HubSpot request / error / 429 (http_requests, http_errors, rate_limited) without touching lib/http.
  const uninstrument = instrumentFetch(metrics, { portalForToken: portalIdForToken });
  const { worker, store, portals, tables } = createWorkerFromEnv({ ...opts, metrics, pulse });

  // Only ONE worker may read the shared journal offset. Refuse to start if another one heartbeated recently.
  const lockStaleMs = numEnv(env.WORKER_LOCK_STALE_MS) ?? 30_000;
  try {
    tables.acquireLock(Date.now(), lockStaleMs);
  } catch (e) {
    if (e instanceof WorkerLockError) log('error', `[ALERT] refusing to start: ${e.message}`);
    store.close();
    portals.close();
    uninstrument();
    await globalErrors.flush();
    throw e;
  }
  metrics.restore({ lastSuccessfulReadAt: store.getLastSuccessfulReadAt(), offset: store.getOffset() });
  const beat = setInterval(() => {
    if (!tables.heartbeat(Date.now())) {
      log('error', '[ALERT] worker lock lost (another worker took over); stopping');
      void worker.stop();
    }
  }, Math.max(1_000, Math.floor(lockStaleMs / 3)));
  beat.unref();

  const port = numEnv(env.WORKER_HEALTH_PORT) ?? 3002;
  let server: Server | null = null;
  try {
    server = await startHealthServer({
      port,
      metrics,
      snapshot: () =>
        healthSnapshot(store, Date.now(), worker.startedAt, undefined, worker.latencyStats(), { tables, metrics, rateLimiter: rateLimiterStats }),
    });
    log('info', `health: http://localhost:${port}/health`, 'health_server', { port });
  } catch (e) {
    log('error', `health server could not start on port ${port}: ${(e as Error).message} (worker keeps running)`, 'health_server_failed', { port });
  }

  let signals = 0;
  const onSignal = (sig: string) => {
    signals++;
    if (signals > 1) {
      log('warn', `${sig} again: exiting now (the offset of an unfinished batch is NOT saved; it will be re-read)`, 'shutdown_forced');
      void globalErrors.flush(1000).finally(() => process.exit(130));
      return;
    }
    log('info', `${sig}: finishing the current batch, then stopping (press again to force)`, 'shutdown');
    void worker.stop();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  await worker.run();
  clearInterval(beat);
  tables.releaseLock();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  store.close();
  portals.close();
  uninstrument();
  await globalErrors.flush();
}

// Run as the process entry point (pnpm start:worker -> tsx src/worker/main.ts). Importing this module (tests, other
// code) does NOT start the worker.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(async (e) => {
    rootLogger.error('fatal', `fatal: ${e instanceof Error ? e.message : String(e)}`, { error: e });
    globalErrors.capture(e, { component: 'worker', op: 'fatal', level: 'fatal' });
    await globalErrors.flush();
    process.exit(1);
  });
}
