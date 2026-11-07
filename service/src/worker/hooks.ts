// Label-option sync hook, injected by buildWorker (main.ts) as GuardedLabelCache.onUnknownLabel.
//    A labeled association type we have not announced yet shows up for (portal, from, to). BEFORE anything with that
//    label is stamped, the 3 label properties (multi-checkbox) must have its option, or HubSpot rejects the record
//    update. We sync the options on the stamped object type (`from`, the subscribed side) and, when mirroring, on
//    `to` too. Any failure throws, so the label guard HOLDS (and the poller parks only that portal).
//    The option values are built by src/core/label-options.ts (`${otherObjectTypeId}:${associationTypeId}`), the same function
//    family the stamp uses (formatLabelValues), see src/worker/hooks.test.ts.
//    resync: a stamp refused because a value is not an option (stamp-queue.ts) re-syncs that object type before the retry.
// (App install/uninstall events: src/worker/lifecycle.ts.)

import type { WatchedPair } from '../core/types.js';
import type { SyncLabelOptions } from '../hubspot/properties.js';
import { PortalNotInstalledError, type TokenProvider } from '../hubspot/portal-tokens.js';
import type { PortalAuth } from '../lib/http.js';
import type { UnknownLabelHook } from './label-guard.js';
import { createLogger, type Logger } from '../obs/log.js';

export interface LabelOptionSyncDeps {
  tokens: Pick<TokenProvider, 'getAccessToken'>;
  watchedPairs: (portalId: number) => WatchedPair[];
  /** STAMP_MIRROR=1: the "to" record is stamped too, so its object type needs the options as well. */
  mirror: boolean;
  /** The process's option sync (production: createLabelOptionSync()). */
  sync: SyncLabelOptions;
  /** Default: createLogger('hooks'). */
  log?: Logger;
}

/** The dropdown option sync of one portal, used by the label guard (new pair / label) and the stamp queue (refused value). */
export interface LabelOptionSync {
  /** GuardedLabelCache.onUnknownLabel: syncs `from` (and `to` when mirroring) for this pair. */
  onUnknownLabel: UnknownLabelHook;
  /** Re-sync every option of one object type (all watched pairs). false = portal not installed. Throws on failure. */
  resync(portalId: number, objectTypeId: string): Promise<boolean>;
}

export function makeLabelOptionSync(d: LabelOptionSyncDeps): LabelOptionSync {
  const { sync } = d;
  const log = d.log ?? createLogger('hooks');
  /** The portal's auth, or null when it is not installed (nothing will be stamped for it, so nothing to sync or hold). */
  const authFor = async (portalId: number): Promise<PortalAuth | null> => {
    try {
      return { portalId, token: await d.tokens.getAccessToken(portalId) };
    } catch (e) {
      if (e instanceof PortalNotInstalledError) return null;
      throw e;
    }
  };
  /** `pair` set: only label errors of that pair's directions count (another pair's failure must not hold this one). */
  const syncOne = async (auth: PortalAuth, objectTypeId: string, pairs: WatchedPair[], other?: string): Promise<void> => {
    const r = await sync(auth, objectTypeId, pairs);
    // r.failure: missing scope, whole-call error, or a property in error / of the wrong type (properties.ts failureOf).
    const problems = [
      ...(r.failure ? [r.failure] : []),
      ...r.labelErrors
        .filter((le) => other === undefined || (le.from === objectTypeId && le.to === other) || (le.from === other && le.to === objectTypeId))
        .map((le) => `labels ${le.from}->${le.to}: ${le.error}`),
    ];
    if (problems.length) throw new Error(`label option sync on ${objectTypeId} failed: ${problems.join('; ')}`);
    const added = r.properties.flatMap((p) => p.added);
    if (added.length) log.info('label_options_synced', `portal ${auth.portalId}: label options synced on ${objectTypeId} (+${new Set(added).size})`, { portalId: auth.portalId });
  };
  return {
    async onUnknownLabel(portalId, from, to) {
      const auth = await authFor(portalId);
      if (!auth) return false;
      // The triggering pair is always included, even if settings changed a moment ago.
      const pairs = [...d.watchedPairs(portalId), { objectTypeId: from, associatedObjectTypeId: to }];
      for (const objectTypeId of d.mirror ? [from, to] : [from]) await syncOne(auth, objectTypeId, pairs, objectTypeId === from ? to : from);
      return true;
    },
    async resync(portalId, objectTypeId) {
      const auth = await authFor(portalId);
      if (!auth) return false;
      await syncOne(auth, objectTypeId, d.watchedPairs(portalId));
      return true;
    },
  };
}
