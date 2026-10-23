// Strict label lookups for the worker: if we can't name a label, we HOLD the batch instead of guessing.
//
// Why: a wrong label name ("type 249") would be stamped onto a customer record and fire their workflows,
// and the label properties are dropdowns (only known options are accepted). So:
//  - The label fetch fails (network, 5xx, 401 after refresh)       -> LabelHoldError (offset not saved, retry later)
//  - The type id is still unknown after a fresh fetch              -> LabelHoldError (a brand-new label may not be
//                                                                     visible yet; retry later)
//  - A labeled type id we never announced for an object pair      -> await onUnknownLabel(portalId, from, to) first,
//                                                                     so the dropdown options can be synced (agent (a):
//                                                                     src/core/label-options.ts). If the hook throws -> hold.
//  - A hold that lasts longer than maxHoldMs (default 30 min)      -> give up for that type: return undefined, so
//                                                                     resolve.ts uses its "type N" fallback. Logged as
//                                                                     an error; the shared journal can't wait forever.
//  - The portal has no token (not installed any more)              -> no hold (it can never succeed); stamps for it are
//                                                                     dropped later anyway.
// A stale cached row is used if the refresh fails (the name was right yesterday; better than holding).

import type { LabelCache, LabelLookup } from '../core/labels.js';
import { isPermanentTokenError } from '../hubspot/stamp.js';
import type { Store } from '../store/db.js';
import { createLogger } from '../obs/log.js';
import { legacyLog } from '../obs/wiring.js';

export type UnknownLabelHook = (portalId: number, fromObjectTypeId: string, toObjectTypeId: string) => Promise<void> | void;

export class LabelHoldError extends Error {
  constructor(public holdKey: string, detail: string) {
    super(`Label lookup held (${holdKey}): ${detail}`);
    this.name = 'LabelHoldError';
  }
}

export interface LabelGuardOptions {
  store: Store;
  onUnknownLabel?: UnknownLabelHook;
  /**
   * Part of the "already announced" key. Change it when the hook's job changes (e.g. mirroring switched on, so the
   * other object type needs options too) and every label is announced once more.
   */
  syncScope?: string;
  maxHoldMs?: number;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export const DEFAULT_LABEL_MAX_HOLD_MS = 30 * 60 * 1000;

export class GuardedLabelCache implements LabelCache {
  private readonly maxHoldMs: number;
  private readonly now: () => number;
  private readonly log: NonNullable<LabelGuardOptions['log']>;

  constructor(private inner: LabelCache, private opts: LabelGuardOptions) {
    this.maxHoldMs = opts.maxHoldMs ?? DEFAULT_LABEL_MAX_HOLD_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? legacyLog(createLogger('labels'));
  }

  async get(portalId: number, from: string, to: string, typeId: number): Promise<LabelLookup | undefined> {
    const { store } = this.opts;
    const holdKey = `${portalId}|${from}|${to}|${typeId}`;
    const cachedBefore = store.getLabel(portalId, from, to, typeId);

    let hit: LabelLookup | undefined;
    try {
      hit = await this.inner.get(portalId, from, to, typeId);
    } catch (e) {
      if (isPermanentTokenError(e)) return undefined;
      if (cachedBefore) {
        this.log('warn', `label refresh failed for ${holdKey}, using the cached name: ${(e as Error).message}`);
        return { label: cachedBefore.label, category: cachedBefore.category };
      }
      return this.hold(holdKey, `label fetch failed: ${(e as Error).message}`);
    }

    if (!hit) return this.hold(holdKey, 'association type id not found in the portal\'s label definitions');

    // A labeled type id we have not announced yet (new label, or first sight after install): let the
    // dropdown options catch up BEFORE we stamp it. Persisted per pair, so it runs once per new label.
    if (hit.label !== null && this.opts.onUnknownLabel) {
      const syncKey = `labels_synced:${this.opts.syncScope ? `${this.opts.syncScope}:` : ''}${portalId}|${from}|${to}`;
      const synced: number[] = JSON.parse(store.getState(syncKey) ?? '[]');
      if (!synced.includes(typeId)) {
        try {
          await this.opts.onUnknownLabel(portalId, from, to);
        } catch (e) {
          return this.hold(holdKey, `onUnknownLabel failed: ${(e as Error).message}`);
        }
        const now = store.listLabels(portalId, from, to).filter((d) => d.label !== null).map((d) => d.associationTypeId);
        store.setState(syncKey, JSON.stringify([...new Set([...synced, ...now, typeId])].sort((a, b) => a - b)));
      }
    }
    store.clearLabelHold(holdKey);
    return hit;
  }

  private hold(holdKey: string, why: string): undefined {
    const t = this.now();
    const since = this.opts.store.noteLabelHold(holdKey, t, why);
    if (t - since >= this.maxHoldMs) {
      this.log('error', `giving up on label ${holdKey} after ${Math.round((t - since) / 60000)} min (${why}); stamping with a fallback name`);
      return undefined;
    }
    throw new LabelHoldError(holdKey, why);
  }
}
