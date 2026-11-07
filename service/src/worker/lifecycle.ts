// The worker's part of the app lifecycle. The API server owns provisioning (Installer.provisionPending, run at start
// and on a timer); the worker never provisions. It handles:
//   - APP_INSTALL (journal): lifts a stamping pause when the portal was (re)installed after the pause began.
//   - APP_UNINSTALL (journal) and a pause that expired (7 days revoked, stamp-queue.ts): handleUninstall =
//     delete every per-portal row (Store.purgePortal; privacy policy: "we delete your portal's data on uninstall") and
//     its metric series, and write a lifecycle_retry row ("HubSpot cleanup owed") in the same transaction; then wipe
//     its token and delete its journal subscriptions (hubspot/app-lifecycle.ts uninstallPortal). Success deletes the
//     row; a failure keeps it and is retried with back-off, so a failure never holds the shared journal offset.
// Idempotent: a re-read after a crash finds the portal uninstalled with no cleanup owed and only purges again.

import type { JournalEvent } from '../core/types.js';
import { appLifecycleKind } from '../hubspot/app-lifecycle.js';
import { backoffMs } from '../lib/backoff.js';
import { AlertThrottle } from '../obs/alerts.js';
import { createLogger, type Logger } from '../obs/log.js';
import type { ChangeCatchMetrics } from '../obs/metrics.js';
import type { Store } from '../store/db.js';
import type { PortalStore } from '../store/portals.js';

export interface LifecycleDeps {
  /** The HubSpot side of an uninstall (buildWorker: uninstallPortal). Throws on a HubSpot failure. */
  uninstall: (portalId: number) => Promise<void>;
  portals: Pick<PortalStore, 'getPortal' | 'markProvisioned'>;
  store: Pick<Store, 'purgePortal' | 'metrics' | 'worker' | 'stamps' | 'transaction'>;
  metrics?: Pick<ChangeCatchMetrics, 'forgetPortal'>;
  baseMs?: number;
  maxMs?: number;
  /** Alert "uninstall_retry_failing" once a portal's HubSpot cleanup failed this many retries, then at most hourly. */
  alertAfter?: number;
  now?: () => number;
  /** Default: createLogger('lifecycle'). */
  log?: Logger;
}

export class Lifecycle {
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly alertAfter: number;
  private readonly retryAlerts = new AlertThrottle<number>(60 * 60_000);

  constructor(private readonly d: LifecycleDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? createLogger('lifecycle');
    this.baseMs = d.baseMs ?? 30_000;
    this.maxMs = d.maxMs ?? 30 * 60_000;
    this.alertAfter = d.alertAfter ?? 10;
  }

  /** runOnce's onOtherEvent. Ignores everything but app lifecycle events. Throws only on a local DB error. */
  readonly onOtherEvent = async (event: JournalEvent): Promise<void> => {
    const kind = appLifecycleKind(event);
    if (!kind || typeof event.portalId !== 'number') return;
    if (kind === 'install') return this.liftPause(event.portalId);
    const at = Date.parse(event.occurredAt ?? '');
    await this.handleUninstall(event.portalId, 'app uninstalled', Number.isFinite(at) ? at : this.now());
  };

  /** Uninstall routine. `at` = when the uninstall happened; a reinstall after it wins. */
  async handleUninstall(portalId: number, reason: string, at: number = this.now()): Promise<void> {
    if (this.reinstalledAfter(portalId, at)) return;
    const p = this.d.portals.getPortal(portalId);
    if (p && p.uninstalledAt !== null && !this.cleanupOwed(portalId)) {
      this.purge(portalId); // already done (re-read after a crash, duplicate event)
      return;
    }
    const t0 = this.now();
    // The purge deletes the portal's lifecycle_retry row too, so the "cleanup owed" row is written after it.
    this.d.store.transaction(() => {
      this.purge(portalId);
      this.d.store.worker.addLifecycleRetry({ portalId, reason, at }, 'not attempted yet', t0 + this.baseMs, t0);
    });
    try {
      const done = await this.uninstall(portalId, at);
      this.d.store.worker.doneLifecycleRetry(portalId);
      if (!done) return;
    } catch (e) {
      const t = this.now();
      this.d.store.worker.addLifecycleRetry({ portalId, reason, at }, errorText(e), t + this.baseMs, t);
      this.d.store.metrics.recordPortalError(portalId, `uninstall (${reason}) failed, will retry: ${errorText(e)}`, t);
      this.log.warn('uninstall_failed', `portal ${portalId}: uninstall (${reason}) failed; local data purged now, HubSpot cleanup retried: ${errorText(e)}`, {
        portalId,
      });
      return;
    }
    this.log.info('uninstalled', `portal ${portalId}: uninstalled (${reason}); portal data deleted`, { portalId });
  }

  /** Retry due HubSpot cleanups. Never throws on HubSpot errors. Returns how many succeeded. */
  async runDue(): Promise<number> {
    let ok = 0;
    for (const row of this.d.store.worker.dueLifecycleRetries(this.now())) {
      if (this.reinstalledAfter(row.portalId, row.at)) {
        this.d.store.worker.doneLifecycleRetry(row.portalId);
        continue;
      }
      try {
        if (await this.uninstall(row.portalId, row.at)) this.purge(row.portalId);
        ok++;
        this.retryAlerts.clear(row.portalId);
        this.log.info('uninstall_retry_ok', `portal ${row.portalId}: uninstall (${row.reason}) cleanup succeeded on retry ${row.attempts + 1}`, {
          portalId: row.portalId,
        });
      } catch (e) {
        const attempts = row.attempts + 1;
        const wait = backoffMs(attempts - 1, this.baseMs, this.maxMs);
        const t = this.now();
        this.d.store.worker.failLifecycleRetry(row.portalId, errorText(e), t + wait);
        this.d.store.metrics.recordPortalError(row.portalId, `uninstall retry ${attempts} failed: ${errorText(e)}`, t);
        const msg = `portal ${row.portalId}: uninstall (${row.reason}) retry ${attempts} failed, next in ${Math.round(wait / 1000)}s: ${errorText(e)}`;
        if (attempts >= this.alertAfter && this.retryAlerts.fire(row.portalId, t))
          this.log.alert('uninstall_retry_failing', msg, { portalId: row.portalId, attempts });
        else this.log.warn('uninstall_retry_failed', msg, { portalId: row.portalId, attempts });
      }
    }
    return ok;
  }

  nextDueAt(): number | null {
    return this.d.store.worker.nextLifecycleRetryAt();
  }

  private liftPause(portalId: number): void {
    const pause = this.d.store.stamps.getPause(portalId);
    const p = this.d.portals.getPortal(portalId);
    if (!pause || !p || p.uninstalledAt !== null || p.installedAt === null || p.installedAt <= pause.since) return;
    this.d.store.stamps.unpause(portalId);
    this.log.info('pause_lifted', `portal ${portalId}: reinstalled; stamping pause lifted`, { portalId });
  }

  /**
   * The HubSpot side of the uninstall at `at`. The API server may reinstall and provision the portal while the
   * subscription delete is in flight (another process); the delete then removed the NEW install's subscriptions, so
   * flag the portal for re-provisioning (Installer.provisionPending picks up any last_provision_error). Returns false
   * in that case, so the caller does not purge the new install's data.
   */
  private async uninstall(portalId: number, at: number): Promise<boolean> {
    await this.d.uninstall(portalId);
    if (!this.reinstalledAfter(portalId, at)) return true;
    this.d.portals.markProvisioned(portalId, 'subscriptions removed by a concurrent uninstall', this.now());
    this.log.warn('reprovision_needed', `portal ${portalId}: reinstalled during the uninstall cleanup; re-provisioning`, { portalId });
    return false;
  }

  private reinstalledAfter(portalId: number, at: number): boolean {
    const installedAt = this.d.portals.getPortal(portalId)?.installedAt;
    if (installedAt == null || installedAt <= at) return false;
    this.log.info('uninstall_ignored', `portal ${portalId}: uninstall at ${new Date(at).toISOString()} is older than the latest install; ignored`, { portalId });
    return true;
  }

  private cleanupOwed(portalId: number): boolean {
    return this.d.store.worker.listLifecycleRetries().some((r) => r.portalId === portalId);
  }

  private purge(portalId: number): void {
    const total = Object.values(this.d.store.purgePortal(portalId)).reduce((a, b) => a + b, 0);
    this.d.metrics?.forgetPortal(portalId);
    if (total) this.log.info('portal_purged', `portal ${portalId}: deleted ${total} stored row(s) of portal data`, { portalId, rows: total });
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
