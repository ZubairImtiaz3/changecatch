// Late-half absorption (load test `mixed`, 2026-10-30, pairing assumption A6 follow-up).
//
// Problem: under load HubSpot splits ONE user action (a labeled link or unlink) over several journal files that can be
// published 30 s+ apart. All its events share the IDENTICAL occurredAt for the same from/to record pair. The pairing
// split hold (PAIRING_SPLIT_HOLD_MS) only waits a few seconds, so without absorption a late half becomes an EXTRA change:
// e.g. REMOVED (correct) followed by LABEL_CHANGED "(unknown)" (wrong final labels_current, extra enrollment).
// A label SWAP (REMOVED old label + ADDED new label) can also arrive split, and its two halves do NOT share an
// occurredAt: the 04:30 run's batch relabel had ADDED 247 @ 37.289 and REMOVED 249 @ 38.131 (842 ms apart).
//
// Fix: remember every emitted change for a short time (emitted_actions, TTL 10 min; key = record pair + occurredAt).
// A cluster whose key matches an emitted change is a late half of that action. A label-only cluster with no exact
// match may also be the other half of an emitted LABEL_CHANGED on the same pair within the pairing window (the same
// window pairing would have used had both halves arrived together). It is NEVER matched to an emitted link/unlink
// with a different occurredAt.
//
//   emitted     late half                     result
//   REMOVED     label REMOVED (or dup unlink)  ABSORB: no change_log row, no stamp (events just marked seen).
//   ADDED       label ADDED                    AMEND
//   ADDED       dup structural ADDED           ABSORB.
//   LABEL_CHG   structural REMOVED / ADDED     CONVERT to REMOVED / ADDED
//               (label-first split)
//   LABEL_CHG   label events (either way,      AMEND: one LABEL_CHANGED "old -> new" (label swap halves)
//               same or near occurredAt)
//   anything else                              processed normally.
//
// "Stamped" below = a normal stamp for that change id was actually written to HubSpot (seen key SENT_PREFIX, set by
// the StampQueue). A change that was only queued or coalesced away has never been seen by a workflow.
//
// CONVERT (the type changes):
//   - NOT stamped yet -> fixed IN PLACE (same change id, one change_log row): row corrected, queued stamp corrected
//     (a coalesced-away change has no stamp of its own; nothing more to do).
//   - ALREADY stamped -> a workflow may have run on it, and a missed "linked"/"unlinked" trigger is worse than a rare
//     extra one: the structural change is emitted as its OWN change (new change id, right type, labels "(none)" after
//     an unlink). The earlier row is left as it was, with change_log.superseded_by = the new change id.
// AMEND (labels only, the type stays): the row is corrected in place; the queued stamp is corrected if still queued;
//   if the record SHOWS this change (stamp_last.last_change_id) and nothing newer is queued for it, one AMEND stamp
//   writes the 3 label properties (never changecatch_change_type / changecatch_last_change_id: no enrollment, and a
//   stamped change's type is never changed silently); otherwise the record does not show it and nothing is sent.
// Load test 04:30 UTC: 31 of the 47 extra rows were "second changes" for LABEL_CHANGEDs that had only been coalesced
// (never stamped), and one amend stamp per late half on a burst record took a spacing slot each (30+ amends ahead of
// the final stamp, 278.6 s).
//
// Writes are idempotent, so a crash + re-read is safe:
// the memory row is updated at once, and a re-read late half then matches the updated row.

import { createHash } from 'node:crypto';
import type { Logger } from '../obs/log.js';
import type { SeenStore } from './dedupe.js';
import { actionKey, pairKey, recordKey, SENT_PREFIX } from './keys.js';
import type { LabelCache } from './labels.js';
import { STAMP_PROPS } from './contract.js';
import { labelKeysOf, mirrorKeysOf, uniqSorted } from './resolve.js';
import { changeIdFor, toChangeRecords, type ChangeRecord, type StampUpdate } from './stamp.js';
import type { ChangeType, NormalizedChange, PairedChange } from './types.js';

/** One emitted change on one stamped record (emitted_actions row). */
export interface EmittedAction {
  actionKey: string;
  recordKey: string;
  portalId: number;
  changeId: string;
  changeType: ChangeType;
  otherTypeId: string;
  /** undefined = unknown. */
  labelsBefore?: string[];
  labelsAfter?: string[];
  removed: string[];
  added: string[];
  occurredAtMs: number;
}

/** Late-half absorption memory (emitted_actions, TTL-bound). Implemented by src/store/emitted.ts. */
export interface EmittedActionStore {
  /** Rows of one action still inside the TTL. */
  getEmittedActions(actionKey: string, now: number): EmittedAction[];
  /** Rows on one record pair whose occurredAt is within windowMs of occurredAtMs (inside the TTL). */
  getEmittedActionsNear(pairKey: string, occurredAtMs: number, windowMs: number, now: number): EmittedAction[];
  saveEmittedActions(rows: EmittedAction[], now: number): void;
}

/** What absorption reads and corrects. Implemented by src/store/db.ts Store (one connection, one transaction). */
export interface AbsorbStore {
  transaction<T>(fn: () => T): T;
  seen: SeenStore;
  emitted: EmittedActionStore;
  changes: {
    updateChange(portalId: number, changeId: string, f: Partial<Pick<ChangeRecord, 'changeType' | 'labelBefore' | 'labelAfter' | 'labelsCurrent'>>): void;
    markSuperseded(portalId: number, changeId: string, supersededBy: string): void;
  };
  stamps: {
    /** Merge properties into a queued (not yet sent) stamp. False if the change is not queued any more. */
    mergeQueuedProperties(changeId: string, props: Partial<Record<string, string>>): boolean;
    /** Stamps still waiting in the queue for one record, in send order. */
    queuedFor(recordKey: string): { changeId: string; update: StampUpdate }[];
    /** The change id the record shows (the last normal stamp sent). undefined = unknown. */
    getLastStampedChange(recordKey: string): string | undefined;
  };
}

type PairRef = Pick<NormalizedChange, 'portalId' | 'fromObjectTypeId' | 'fromObjectId' | 'toObjectTypeId' | 'toObjectId' | 'occurredAt'>;

/** One user action on one record pair: direction-insensitive pair key + the identical occurredAt of its events. */
export function actionKeyOf(c: PairRef): string {
  return actionKey(pairKey(c.portalId, c.fromObjectTypeId, c.fromObjectId, c.toObjectTypeId, c.toObjectId), Date.parse(c.occurredAt));
}

/** Memory rows for an emitted change (one per stamped record). */
export function emittedActionsFor(change: NormalizedChange, records: ChangeRecord[]): EmittedAction[] {
  const known = change.changeType !== 'LABEL_CHANGED' || change.labelsCurrent !== undefined;
  const before = change.changeType === 'ADDED' ? [] : known ? change.labelBefore : undefined;
  const after = change.changeType === 'REMOVED' ? [] : known ? (change.labelAfter ?? []) : undefined;
  return records.map((r) => ({
    actionKey: actionKeyOf(change),
    recordKey: recordKey(r),
    portalId: r.portalId,
    changeId: r.changeId,
    changeType: change.changeType,
    otherTypeId:
      r.objectTypeId === change.fromObjectTypeId && r.objectId === String(change.fromObjectId) ? change.toObjectTypeId : change.fromObjectTypeId,
    labelsBefore: before,
    labelsAfter: after,
    removed: change.removedLabels ?? [],
    added: change.addedLabels ?? [],
    occurredAtMs: Date.parse(change.occurredAt),
  }));
}

export interface AbsorbDeps {
  store: AbsorbStore;
  labels: LabelCache;
  now: number;
  /** STAMP_MIRROR: the other record is stamped too (RunConfig.mirror). */
  mirror: boolean;
  /** Pairing window (PairingConfig.windowMs): how far apart the two halves of a label swap may be. */
  windowMs: number;
  log: Logger;
}

export interface AbsorbResult {
  /** Not a late half: process as usual (resolve -> stamp). */
  normal: PairedChange[];
  /** Late structural halves after an already-STAMPED change: emit these as new changes (already resolved). */
  emitted: NormalizedChange[];
  /** Known-label-state changes decided here (pass to resolveChanges, persist with the offset). */
  stateUpdates: Map<string, string[] | null>;
  /** Amend stamps (the 3 label properties only; never changecatch_change_type or changecatch_last_change_id). */
  amendStamps: StampUpdate[];
  absorbed: number;
  amended: number;
  converted: number;
}

const union = (...xs: (string[] | undefined)[]) => uniqSorted(xs.flatMap((x) => x ?? []));
const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));

type Plan =
  | { kind: 'absorb' }
  | { kind: 'amend' | 'convert'; type: ChangeType; before?: string[]; after?: string[]; current?: string[]; removed: string[]; added: string[] };

/** Decide what a late half does to the emitted change E (see the table at the top). null = not a late half. */
export function planLateHalf(E: EmittedAction, structuralNet: number, lateRem: string[], lateAdd: string[]): Plan | null {
  const s = structuralNet;
  const removed = union(E.removed, lateRem);
  const added = union(E.added, lateAdd);
  switch (E.changeType) {
    case 'REMOVED':
      return s <= 0 && lateAdd.length === 0 ? { kind: 'absorb' } : null;
    case 'ADDED': {
      if (s < 0 || lateRem.length) return null;
      if (!lateAdd.length) return { kind: 'absorb' };
      const after = union(E.labelsAfter ?? E.added, lateAdd);
      return { kind: 'amend', type: 'ADDED', before: [], after, current: after, removed: [], added };
    }
    case 'LABEL_CHANGED': {
      if (s < 0 && !lateAdd.length && !E.added.length) {
        return { kind: 'convert', type: 'REMOVED', before: union(E.labelsBefore ?? E.removed, lateRem), after: [], current: [], removed, added: [] };
      }
      if (s > 0 && !lateRem.length && !E.removed.length) {
        return { kind: 'convert', type: 'ADDED', before: [], after: added, current: added, removed: [], added };
      }
      if (s !== 0 || (!lateAdd.length && !lateRem.length)) return null;
      // Label events only, in either direction: the two halves of one label edit (e.g. a swap "Influencer ->
      // Decision maker" whose ADDED and REMOVED arrived in different journal files). A label removed and re-added
      // (or the other way round) cancels out.
      const netRem = minus(removed, added);
      const netAdd = minus(added, removed);
      if (E.labelsAfter) {
        const after = union(minus(E.labelsAfter, lateRem), lateAdd);
        return { kind: 'amend', type: 'LABEL_CHANGED', before: E.labelsBefore, after, current: after, removed: netRem, added: netAdd };
      }
      // Label state unknown: same fallback as resolveChanges (before = removed, after = added, current unknown).
      return {
        kind: 'amend', type: 'LABEL_CHANGED',
        before: netRem.length ? netRem : undefined, after: netAdd.length ? netAdd : undefined, removed: netRem, added: netAdd,
      };
    }
  }
  return null;
}

const shortHash = (xs: string[]) => createHash('sha256').update([...xs].sort().join('\n')).digest('hex').slice(0, 10);

/** Emitted actions that p may be the late half of: same occurredAt, or (label-only p) a LABEL_CHANGED within the window. */
function findEmitted(p: PairedChange, store: AbsorbStore, now: number, windowMs: number): EmittedAction[] {
  const exact = store.emitted.getEmittedActions(actionKeyOf(p), now);
  if (exact.length || p.structuralNet !== 0 || windowMs <= 0) return exact;
  const at = Date.parse(p.occurredAt);
  const pk = pairKey(p.portalId, p.fromObjectTypeId, p.fromObjectId, p.toObjectTypeId, p.toObjectId);
  // Only LABEL_CHANGED: a label edit is never merged with a link/unlink that has a different occurredAt.
  const near = store.emitted.getEmittedActionsNear(pk, at, windowMs, now).filter((r) => r.changeType === 'LABEL_CHANGED' && r.occurredAtMs !== at);
  if (!near.length) return [];
  const best = near.reduce((b, r) => (Math.abs(r.occurredAtMs - at) < Math.abs(b.occurredAtMs - at) ? r : b));
  return near.filter((r) => r.actionKey === best.actionKey);
}

/**
 * Split this run's paired changes into normal ones and late halves of already-emitted actions, and apply the late
 * halves (change_log fixes, queued-stamp merges, amend stamps, emitted-memory updates) right away. Idempotent.
 */
export async function absorbLateHalves(paired: PairedChange[], deps: AbsorbDeps): Promise<AbsorbResult> {
  const { store, labels, now, windowMs, log } = deps;
  const res: AbsorbResult = { normal: [], emitted: [], stateUpdates: new Map(), amendStamps: [], absorbed: 0, amended: 0, converted: 0 };

  for (const p of [...paired].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))) {
    const rows = findEmitted(p, store, now, windowMs);
    // A re-read of the SAME change (crash before the offset was saved) has the same change id: process it normally.
    const selfIds = new Set([changeIdFor(p, p.fromObjectTypeId, p.fromObjectId), changeIdFor(p, p.toObjectTypeId, p.toObjectId)]);
    if (!rows.length || rows.some((r) => selfIds.has(r.changeId))) {
      res.normal.push(p);
      continue;
    }
    const { removed: lateRem, added: lateAdd, names: lateNames } = await labelKeysOf(p, labels);
    const E = rows[0];
    const plan = planLateHalf(E, p.structuralNet, lateRem, lateAdd);
    const what = `portal ${p.portalId} ${p.fromObjectTypeId}/${p.fromObjectId} -> ${p.toObjectTypeId}/${p.toObjectId} @ ${p.occurredAt}`;
    if (!plan) {
      res.normal.push(p);
      continue;
    }
    if (plan.kind === 'absorb') {
      res.absorbed++;
      log.info('late_half_absorbed', `late journal half ABSORBED into ${E.changeType} ${E.changeId} (${what})`);
      continue;
    }

    const pk = pairKey(p.portalId, p.fromObjectTypeId, p.fromObjectId, p.toObjectTypeId, p.toObjectId);
    const v: NormalizedChange = {
      portalId: p.portalId,
      changeType: plan.type,
      fromObjectTypeId: p.fromObjectTypeId,
      fromObjectId: p.fromObjectId,
      toObjectTypeId: p.toObjectTypeId,
      toObjectId: p.toObjectId,
      labelBefore: plan.before,
      labelAfter: plan.after,
      labelsCurrent: plan.current,
      removedLabels: plan.removed,
      addedLabels: plan.added,
      associationCategory: p.associationCategory,
      occurredAt: new Date(E.occurredAtMs).toISOString(),
      sourceOffsets: p.sourceOffsets,
      sourceKeys: p.sourceKeys,
    };
    if (deps.mirror) {
      const keys = uniqSorted([...(plan.before ?? []), ...(plan.after ?? []), ...(plan.current ?? [])]);
      v.mirrorLabelKeys = await mirrorKeysOf(p, keys, lateNames, labels);
    }
    if (plan.type === 'REMOVED') res.stateUpdates.set(pk, null);
    else if (plan.current) res.stateUpdates.set(pk, plan.current);

    const recs = new Map(toChangeRecords(v, deps.mirror).map((r) => [recordKey(r), r]));
    const stamped = store.seen.filterSeen(rows.map((r) => SENT_PREFIX + r.changeId)).size > 0;

    if (plan.kind === 'convert' && stamped) {
      // A workflow may have run on the earlier change: emit the structural change as its own change (new id).
      res.emitted.push(v);
      store.transaction(() => {
        for (const row of rows) {
          const r = recs.get(row.recordKey);
          if (r) store.changes.markSuperseded(row.portalId, row.changeId, r.changeId);
        }
      });
      res.converted++;
      log.info('late_half_emitted', `late structural half after STAMPED ${E.changeType} ${E.changeId}: emitting ${plan.type} as a new change (${what})`);
      continue;
    }

    const outcome: string[] = [];
    const memory: EmittedAction[] = [];
    store.transaction(() => {
      for (const row of rows) {
        const r = recs.get(row.recordKey);
        if (!r) continue;
        store.changes.updateChange(row.portalId, row.changeId, { changeType: plan.type, labelBefore: r.labelBefore, labelAfter: r.labelAfter, labelsCurrent: r.labelsCurrent });
        // An amend writes only the label properties: never changecatch_last_change_id (no new workflow enrollment) and
        // never changecatch_change_type (a type correction is a NEW change, the 'convert' branch above).
        const labelProps = {
          [STAMP_PROPS.labelBefore]: r.labelBefore,
          [STAMP_PROPS.labelAfter]: r.labelAfter,
          [STAMP_PROPS.labelsCurrent]: r.labelsCurrent,
        };
        if (store.stamps.mergeQueuedProperties(row.changeId, { [STAMP_PROPS.changeType]: plan.type, ...labelProps })) {
          outcome.push('queued stamp corrected');
        } else if (plan.kind === 'convert') {
          outcome.push('never stamped (coalesced away)');
        } else {
          const queued = store.stamps.queuedFor(row.recordKey);
          if (queued.some((q) => q.update.amendOf === undefined)) {
            outcome.push('a later stamp is queued for the record');
          } else if (store.stamps.getLastStampedChange(row.recordKey) === row.changeId) {
            const qa = queued.find((q) => q.update.amendOf === row.changeId);
            if (qa) {
              store.stamps.mergeQueuedProperties(qa.changeId, labelProps);
              outcome.push('queued amend updated');
            } else {
              res.amendStamps.push({
                portalId: r.portalId,
                objectTypeId: r.objectTypeId,
                objectId: r.objectId,
                occurredAtMs: row.occurredAtMs,
                amendOf: row.changeId,
                stampId: `${row.changeId}~amend-${shortHash(p.sourceKeys)}`,
                properties: labelProps,
              });
              outcome.push('amend stamp');
            }
          } else {
            outcome.push('record shows another change (coalesced or superseded)');
          }
        }
        memory.push({ ...row, changeType: plan.type, labelsBefore: plan.before, labelsAfter: plan.after, removed: plan.removed, added: plan.added });
      }
      store.emitted.saveEmittedActions(memory, now);
    });
    if (plan.kind === 'convert') res.converted++;
    else res.amended++;
    log.info(
      'late_half_amended',
      `late journal half ${plan.kind === 'convert' ? 'CONVERTED' : 'AMENDED'} ${E.changeType} ${E.changeId} in place -> ${plan.type} ` +
        `labels ${JSON.stringify(plan.current ?? null)}; ${[...new Set(outcome)].join(', ')} (${what})`,
    );
  }
  return res;
}
