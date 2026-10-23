// Lifecycle hook that NEVER stops the shared journal offset (scale-review C2).
//
// APP_INSTALL / APP_UNINSTALL handling (hooks.ts makeLifecycleHook) can fail: a missing scope, a 409 race with the
// app server, a 5xx from the subscriptions API. Before this, the throw kept the offset and blocked every portal.
// Now:
//   - the failure is caught, recorded on the portal (/health), and persisted to lifecycle_retry (worker-tables.ts);
//   - the journal offset moves on;
//   - the worker loop calls runDue() each cycle: back-off LIFECYCLE_RETRY_BASE_MS (30 s) x2 .. LIFECYCLE_RETRY_MAX_MS
//     (30 min), forever, with an [ALERT] after 10 failed attempts (repeated every 10 more);
//   - a failed UNINSTALL purges the portal's local data at once (privacy); only the HubSpot side (subscription delete,
//     token wipe) waits for the retry;
//   - an INSTALL the app server is (probably) still provisioning (installed < LIFECYCLE_INSTALL_GRACE_MS ago, not
//     provisioned yet) is NOT provisioned in parallel: it is deferred to the retry table until the grace has passed,
//     then the retry finds it provisioned (no-op) or provisions it.
// One row per portal: a newer lifecycle event replaces an older pending one (the handler ignores stale uninstalls).

import { APP_EVENT_TYPE } from '../hubspot/journal.js';
import { isLifecycleEvent } from '../install/lifecycle.js';
import type { JournalEvent } from '../core/types.js';
import type { Store } from '../store/db.js';
import type { PortalRow } from '../store/portals.js';
import type { WorkerTables } from './worker-tables.js';
import { createLogger } from '../obs/log.js';
import { legacyLog } from '../obs/wiring.js';

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void;
export type OtherEventHook = (event: JournalEvent, fileOffset: string) => Promise<unknown> | unknown;

export interface LifecycleRetryOptions {
  tables: WorkerTables;
  store: Pick<Store, 'purgePortal' | 'recordPortalError'>;
  /** The real hook (hooks.ts makeLifecycleHook); may throw. */
  hook: OtherEventHook;
  /** For the install grace check. */
  portals?: { getPortal(portalId: number): Pick<PortalRow, 'installedAt' | 'provisionedAt' | 'uninstalledAt'> | undefined };
  baseMs?: number;
  maxMs?: number;
  installGraceMs?: number;
  alertAfter?: number;
  now?: () => number;
  log?: Log;
  /** Extra cleanup on a local purge (metrics series etc.). */
  onLocalPurge?: (portalId: number) => void;
}

const kindOf = (e: JournalEvent): 'install' | 'uninstall' | 'other' => {
  const a = (e as { action?: string }).action;
  const t = (e as { eventTypeId?: string }).eventTypeId;
  if (a === 'APP_UNINSTALL' || t === APP_EVENT_TYPE.UNINSTALL) return 'uninstall';
  if (a === 'APP_INSTALL' || t === APP_EVENT_TYPE.INSTALL) return 'install';
  return 'other';
};

export class LifecycleRetry {
  private readonly now: () => number;
  private readonly log: Log;
  readonly baseMs: number;
  readonly maxMs: number;
  readonly installGraceMs: number;

  constructor(private o: LifecycleRetryOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? legacyLog(createLogger('lifecycle'));
    this.baseMs = o.baseMs ?? 30_000;
    this.maxMs = o.maxMs ?? 30 * 60_000;
    this.installGraceMs = o.installGraceMs ?? 5 * 60_000;
  }

  /** runOnce's onOtherEvent. Never throws. */
  readonly onOtherEvent = async (event: JournalEvent, fileOffset: string): Promise<unknown> => {
    if (!isLifecycleEvent(event)) {
      try {
        return await this.o.hook(event, fileOffset);
      } catch (e) {
        this.log('warn', `non-lifecycle event hook failed (ignored, offset moves on): ${(e as Error).message}`);
        return undefined;
      }
    }
    const t = this.now();
    // A newer event for this portal supersedes a pending retry.
    const grace = this.graceUntil(event);
    if (grace !== null) {
      this.o.tables.addLifecycleRetry(event as never, 'install: app server may still be provisioning', grace, t);
      this.log('info', `portal ${event.portalId}: install event while the app server may still be provisioning; checking again at ${new Date(grace).toISOString()}`);
      return 'deferred';
    }
    try {
      const r = await this.o.hook(event, fileOffset);
      this.o.tables.doneLifecycleRetry(event.portalId);
      return r;
    } catch (e) {
      this.fail(event, e, t, true);
      return 'deferred';
    }
  };

  /** Retry due rows. Never throws. Returns how many succeeded. */
  async runDue(): Promise<number> {
    let ok = 0;
    for (const row of this.o.tables.dueLifecycleRetries(this.now())) {
      const json = JSON.stringify(row.event);
      try {
        await this.o.hook(row.event as unknown as JournalEvent, 'lifecycle-retry');
        this.o.tables.doneLifecycleRetry(row.portalId, json);
        ok++;
        this.log('info', `portal ${row.portalId}: lifecycle ${kindOf(row.event as unknown as JournalEvent)} succeeded on retry ${row.attempts + 1}`);
      } catch (e) {
        const attempts = row.attempts + 1;
        const wait = this.backoff(attempts);
        const msg = e instanceof Error ? e.message : String(e);
        this.o.tables.failLifecycleRetry(row.portalId, msg, this.now() + wait);
        this.o.store.recordPortalError(row.portalId, `lifecycle retry ${attempts} failed: ${msg}`, this.now());
        const alertAfter = this.o.alertAfter ?? 10;
        const level = attempts >= alertAfter && (attempts - alertAfter) % 10 === 0 ? 'error' : 'warn';
        this.log(level, `${level === 'error' ? '[ALERT] ' : ''}portal ${row.portalId}: lifecycle retry ${attempts} failed, next in ${Math.round(wait / 1000)}s: ${msg}`);
      }
    }
    return ok;
  }

  nextDueAt(): number | null {
    return this.o.tables.nextLifecycleRetryAt();
  }

  private backoff(attempts: number): number {
    return Math.min(this.maxMs, this.baseMs * 2 ** Math.max(0, Math.min(30, attempts - 1)));
  }

  private graceUntil(event: JournalEvent): number | null {
    if (kindOf(event) !== 'install' || !this.o.portals) return null;
    const p = this.o.portals.getPortal(event.portalId as number);
    if (!p || p.provisionedAt !== null || p.uninstalledAt !== null || p.installedAt === null) return null;
    const until = p.installedAt + this.installGraceMs;
    return until > this.now() ? until : null;
  }

  private fail(event: JournalEvent, e: unknown, t: number, first: boolean): void {
    const msg = e instanceof Error ? e.message : String(e);
    const kind = kindOf(event);
    this.o.store.recordPortalError(event.portalId as number, `lifecycle ${kind} failed (will retry): ${msg}`, t);
    if (kind === 'uninstall') {
      // Privacy first: delete what we hold locally now (before queuing the retry, which a purge would delete);
      // the HubSpot side (subscriptions, token) is retried.
      const purged = this.o.store.purgePortal(event.portalId as number);
      const total = Object.values(purged).reduce((a, b) => a + b, 0);
      this.o.onLocalPurge?.(event.portalId as number);
      this.o.tables.addLifecycleRetry(event as never, msg, t + this.baseMs, t);
      this.log('warn', `portal ${event.portalId}: uninstall failed (${msg}); local data purged now (${total} row(s)), HubSpot cleanup retried`);
    } else {
      this.o.tables.addLifecycleRetry(event as never, msg, t + this.baseMs, t);
      this.log('warn', `portal ${event.portalId}: lifecycle ${kind} failed${first ? '' : ' again'}; offset moves on, retry in ${Math.round(this.baseMs / 1000)}s: ${msg}`);
    }
  }
}

/** A synthetic uninstall (pause expired after 7 days, or a missed uninstall event) routed through the same path. */
export function syntheticUninstall(portalId: number, now: number): JournalEvent {
  return {
    type: 'app_lifecycle_event',
    action: 'APP_UNINSTALL',
    eventTypeId: APP_EVENT_TYPE.UNINSTALL,
    portalId,
    occurredAt: new Date(now).toISOString(),
    properties: { reason: 'changecatch: token revoked for over 7 days' },
  } as unknown as JournalEvent;
}
