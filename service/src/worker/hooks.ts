// Glue between the worker and the install work. Both hooks are injected into createWorkerFromEnv (main.ts).
//
// 1) makeLabelOptionSync -> GuardedLabelCache.onUnknownLabel
//    A labeled association type we have not announced yet shows up for (portal, from, to). BEFORE anything with that
//    label is stamped, the 3 label properties (multi-checkbox) must have its option, or HubSpot rejects the record
//    update. We sync the options on the stamped object type (`from`, the subscribed side) and, when mirroring, on
//    `to` too. Any failure throws, so the label guard HOLDS (and the poller parks only that portal).
//    The option values are built by src/core/label-options.ts (`${otherObjectTypeId}:${label}`), the same function
//    family the stamp uses (formatLabelValues), see src/worker/hooks.test.ts.
//
// 2) makeLifecycleHook -> runOnce's onOtherEvent
//    APP_LIFECYCLE_EVENT entries from the journal go to handleLifecycleEvent (src/install/lifecycle.ts) BEFORE the
//    offset is saved. The worker wraps this hook in LifecycleRetry (lifecycle-retry.ts): a throw is persisted and
//    retried with back-off, and the offset moves on (scale-review C2). Install -> make sure the portal
//    is provisioned. Uninstall -> delete its journal subscriptions, wipe the token and watched pairs (Installer),
//    then delete EVERY worker row of the portal here (Store.purgePortal: label tables, metrics, stamp queue/last,
//    change_log, parked/pending entries). Privacy policy: "we delete your portal's data on uninstall". After that the portal has no token and no watched pairs, so later events are
//    dropped by the watched-pair filter and any stamp would fail with a permanent NoPortalTokenError.

import type { WatchedPair } from '../core/types.js';
import type { JournalEvent } from '../core/types.js';
import { syncLabelOptions, type LabelSyncReport } from '../hubspot/properties.js';
import { isPermanentTokenError } from '../hubspot/stamp.js';
import { handleLifecycleEvent, isLifecycleEvent, type LifecycleContext, type LifecycleOutcome } from '../install/lifecycle.js';
import type { Store } from '../store/db.js';
import type { UnknownLabelHook } from './label-guard.js';
import type { TokenProvider } from './tokens.js';
import type { WorkerTables } from './worker-tables.js';
import { createLogger } from '../obs/log.js';
import { legacyInfoLog, legacyLog } from '../obs/wiring.js';

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void;
const defaultLog: Log = legacyLog(createLogger('hooks'));

export type LabelSyncFn = (token: string, portalId: number, objectTypeId: string, watchedPairs: WatchedPair[]) => Promise<LabelSyncReport>;

export interface LabelOptionSyncDeps {
  tokens: TokenProvider;
  watchedPairs: (portalId: number) => WatchedPair[];
  /** STAMP_MIRROR=1: the "to" record is stamped too, so its object type needs the options as well. */
  mirror: boolean;
  /** Injected for tests. Default: syncLabelOptions (real HubSpot calls). */
  sync?: LabelSyncFn;
  log?: Log;
}

export function makeLabelOptionSync(d: LabelOptionSyncDeps): UnknownLabelHook {
  const sync: LabelSyncFn = d.sync ?? ((token, portalId, t, pairs) => syncLabelOptions(token, portalId, t, pairs));
  const log = d.log ?? defaultLog;
  return async (portalId, from, to) => {
    let token: string;
    try {
      token = await d.tokens.getAccessToken(portalId);
    } catch (e) {
      // Uninstalled: nothing will be stamped for this portal anyway, so don't hold anything.
      if (isPermanentTokenError(e)) return;
      throw e;
    }
    // The triggering pair is always included, even if settings changed a moment ago.
    const pairs = [...d.watchedPairs(portalId), { objectTypeId: from, associatedObjectTypeId: to }];
    for (const objectTypeId of d.mirror ? [from, to] : [from]) {
      const r = await sync(token, portalId, objectTypeId, pairs);
      const other = objectTypeId === from ? to : from;
      const problems = [
        ...(r.error ? [r.error] : []),
        ...r.properties.filter((p) => p.status === 'error').map((p) => `${p.name}: ${p.detail ?? 'error'}`),
        // Only the directions of THIS pair matter; another pair's failure must not hold this one.
        ...r.labelErrors
          .filter((le) => (le.from === objectTypeId && le.to === other) || (le.from === other && le.to === objectTypeId))
          .map((le) => `labels ${le.from}->${le.to}: ${le.error}`),
      ];
      if (problems.length) throw new Error(`label option sync on ${objectTypeId} failed: ${problems.join('; ')}`);
      const added = r.properties.flatMap((p) => p.added);
      if (added.length) log('info', `portal ${portalId}: label options synced on ${objectTypeId} (+${new Set(added).size})`);
    }
  };
}

export interface LifecycleHookDeps extends LifecycleContext {
  store: Pick<Store, 'purgePortal'>;
  /** Worker-owned tables (dead letters, pauses, lifecycle retries): purged on uninstall; a reinstall lifts a pause. */
  tables?: Pick<WorkerTables, 'purgePortal' | 'unpause'>;
  /** Extra cleanup on uninstall (e.g. metrics.forgetPortal). */
  onPurged?: (portalId: number) => void;
}

/** runOnce onOtherEvent: routes APP_LIFECYCLE_EVENT entries; ignores every other non-association event. */
export function makeLifecycleHook(d: LifecycleHookDeps): (event: JournalEvent, fileOffset: string) => Promise<LifecycleOutcome | undefined> {
  return async (event) => {
    if (!isLifecycleEvent(event)) return undefined;
    const outcome = await handleLifecycleEvent(event, d);
    if (outcome === 'provisioned' || outcome === 'install-already-provisioned') {
      if (d.tables?.unpause(event.portalId)) (d.log ?? legacyInfoLog(createLogger('lifecycle')))(`portal ${event.portalId}: reinstalled; stamping pause lifted`);
    }
    if (outcome === 'uninstalled' || outcome === 'ignored-already-uninstalled') {
      const purged = { ...d.store.purgePortal(event.portalId), ...(d.tables?.purgePortal(event.portalId) ?? {}) };
      d.onPurged?.(event.portalId);
      const total = Object.values(purged).reduce((a, b) => a + b, 0);
      if (total) (d.log ?? legacyInfoLog(createLogger('lifecycle')))(`portal ${event.portalId}: deleted ${total} stored row(s) of portal data`);
    }
    return outcome;
  };
}
