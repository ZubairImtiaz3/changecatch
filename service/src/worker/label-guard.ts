// The worker's label cache: label definitions per object pair in the LabelStore (label_cache), fetched from HubSpot on
// a miss or after LABEL_TTL_MS. Strict: if we can't name a label, we HOLD the batch instead of guessing.
//
// Why: a wrong label name ("type 249") would be stamped onto a customer record and fire their workflows,
// and the label properties are dropdowns (only known options are accepted). So:
//  - The label fetch fails (network, 5xx, 401 after refresh)       -> LabelHoldError (offset not saved, retry later)
//  - The type id is still unknown after a fresh fetch              -> LabelHoldError (a brand-new label may not be
//                                                                     visible yet; retry later)
//  - A type id we never announced for an object pair (labeled or   -> await onUnknownLabel(portalId, from, to) first,
//    not: the first event of a new pair needs its other-object-       so the dropdown options can be synced
//    type option), or a label whose name changed (rename)             (src/core/label-options.ts). If the hook throws -> hold.
//  - A hold that lasts longer than LABEL_MAX_HOLD_MS (30 min)      -> give up for that type: return undefined, so
//                                                                     resolve.ts stamps it as unresolved. Logged as
//                                                                     an error; the shared journal can't wait forever.
//  - The portal has no token (not installed any more)              -> no hold (it can never succeed); stamps for it are
//                                                                     dropped later anyway.
// A stale cached row is used if the refresh fails (the name was right yesterday; better than holding), but only for a
// type id already announced: an unannounced one still needs the option sync first (which then fails -> hold).

import { LabelHoldError, type LabelCache, type LabelFetcher, type LabelLookup } from '../core/labels.js';
import { normLabelName } from '../core/label-options.js';
import { labelPairKey } from '../core/keys.js';
import { PortalNotInstalledError } from '../hubspot/portal-tokens.js';
import type { LabelStore } from '../store/labels.js';
import { createLogger, type Logger } from '../obs/log.js';

/** Syncs the dropdown options for a pair. true = synced; false = nothing to sync (portal not installed). Throws = hold. */
export type UnknownLabelHook = (portalId: number, fromObjectTypeId: string, toObjectTypeId: string) => Promise<boolean>;

/** Cached definitions older than this are refreshed on next use. */
export const LABEL_TTL_MS = 24 * 60 * 60 * 1000;
/** Don't refetch the same pair more often than this when a type id or name is missing (deleted labels). */
export const LABEL_MIN_REFETCH_MS = 60_000;
/** Give up holding an unresolvable label after this long (it is stamped "unknown"). */
export const LABEL_MAX_HOLD_MS = 30 * 60 * 1000;

export interface LabelCacheOptions {
  store: LabelStore;
  fetch: LabelFetcher;
  /** Dropdown option sync for a type id not announced yet (hooks.ts makeLabelOptionSync). */
  onUnknownLabel: UnknownLabelHook;
  /**
   * STAMP_MIRROR: the other object type needs options too, so the "already announced" markers are kept apart
   * (labels_synced scope 'mirror'): switching mirroring on announces every label once more.
   */
  mirror: boolean;
  now?: () => number;
  /** Default: createLogger('labels'). */
  log?: Logger;
}

export class GuardedLabelCache implements LabelCache {
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly syncScope: string;
  private inflight = new Map<string, Promise<void>>();

  constructor(private opts: LabelCacheOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? createLogger('labels');
    this.syncScope = opts.mirror ? 'mirror' : '';
  }

  async get(portalId: number, from: string, to: string, typeId: number): Promise<LabelLookup | undefined> {
    const { store } = this.opts;
    const holdKey = labelPairKey(portalId, from, to, typeId);
    const cached = store.getLabel(portalId, from, to, typeId);

    let hit: LabelLookup | undefined;
    if (cached && this.now() - cached.fetchedAt < LABEL_TTL_MS) hit = cached;
    else {
      try {
        if (this.mayRefetch(portalId, from, to)) await this.refresh(portalId, from, to);
        hit = store.getLabel(portalId, from, to, typeId);
      } catch (e) {
        if (e instanceof PortalNotInstalledError) return undefined;
        if (!cached) return this.hold(holdKey, `label fetch failed: ${(e as Error).message}`);
        // Still goes through the announce check below: a cached name is only stamped once its option was synced.
        this.log.warn('label_refresh_failed', `label refresh failed for ${holdKey}, using the cached name: ${(e as Error).message}`, { portalId });
        hit = cached;
      }
    }
    if (!hit) return this.hold(holdKey, "association type id not found in the portal's label definitions");

    // A type id we have not announced yet (new label, or the first event of a pair after install), or a label renamed
    // in HubSpot (the refresh returned a new name): let the dropdown options catch up BEFORE we stamp it. Persisted per
    // pair, so it runs once per new type id / rename.
    const synced = store.getSyncedTypeIds(portalId, from, to, this.syncScope);
    const renamed = !!cached && cached.label !== hit.label;
    if (!synced.includes(typeId) || renamed) {
      let didSync: boolean;
      try {
        didSync = await this.opts.onUnknownLabel(portalId, from, to);
      } catch (e) {
        return this.hold(holdKey, `onUnknownLabel failed: ${(e as Error).message}`);
      }
      // Recorded only after a real sync (not when the portal is no longer installed: nothing is stamped for it).
      if (didSync) {
        const now = store.listLabels(portalId, from, to).map((d) => d.associationTypeId);
        store.setSyncedTypeIds(portalId, from, to, [...new Set([...synced, ...now, typeId])].sort((a, b) => a - b), this.syncScope);
      }
    }
    store.clearLabelHold(holdKey);
    return { label: hit.label, category: hit.category };
  }

  async findByName(portalId: number, from: string, to: string, label: string): Promise<number | undefined> {
    const want = normLabelName(label);
    const match = () => {
      const hits = this.opts.store.listLabels(portalId, from, to).filter((d) => d.label !== null && normLabelName(d.label) === want);
      return hits.length === 1 ? hits[0].associationTypeId : undefined;
    };
    const hit = match();
    if (hit !== undefined || !this.mayRefetch(portalId, from, to)) return hit;
    const holdKey = `${labelPairKey(portalId, from, to)}|name:${want}`;
    try {
      await this.refresh(portalId, from, to);
    } catch (e) {
      if (e instanceof PortalNotInstalledError) return undefined;
      // A LabelHoldError (not the raw error), so the poller parks only this portal.
      return this.hold(holdKey, `label fetch failed: ${(e as Error).message}`);
    }
    this.opts.store.clearLabelHold(holdKey);
    return match();
  }

  private mayRefetch(portalId: number, from: string, to: string): boolean {
    const last = this.opts.store.getLabelsFetchedAt(portalId, from, to);
    return last === null || this.now() - last >= LABEL_MIN_REFETCH_MS;
  }

  /** One fetch per pair at a time, even with concurrent callers. */
  private refresh(portalId: number, from: string, to: string): Promise<void> {
    const k = labelPairKey(portalId, from, to);
    let p = this.inflight.get(k);
    if (!p) {
      p = this.opts.fetch(portalId, from, to)
        .then((defs) => this.opts.store.replaceLabels(portalId, from, to, defs, this.now()))
        .finally(() => this.inflight.delete(k));
      this.inflight.set(k, p);
    }
    return p;
  }

  private hold(holdKey: string, why: string): undefined {
    const t = this.now();
    const since = this.opts.store.noteLabelHold(holdKey, t, why);
    if (t - since >= LABEL_MAX_HOLD_MS) {
      this.log.error('label_hold_given_up', `giving up on label ${holdKey} after ${Math.round((t - since) / 60000)} min (${why}); stamping with a fallback name`);
      return undefined;
    }
    throw new LabelHoldError(holdKey, why);
  }
}
