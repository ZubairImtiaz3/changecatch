// Property stamping, the v1 delivery path (D2: app events need partner approval).
// For each NormalizedChange we PATCH the affected record ONCE with app-owned "changecatch_*" properties.
// Customer workflows trigger on "Property value changed" for changecatch_last_change_id (always a new value).
// Pure (no HTTP, no DB). Scheduling and spacing live in the worker's persisted queue (./coalesce.ts planEnqueue).

import { createHash } from 'node:crypto';
import { NONE, STAMP_PROPS, UNKNOWN, type StampPropertyName } from './contract.js';
import { formatLabelValues, isTypeIdKey, unresolvedKey } from './label-options.js';
import type { ChangeType, NormalizedChange } from './types.js';

/** One row of the change log, and the data behind one stamp. Field names match the store's change_log columns. */
export interface ChangeRecord {
  changeId: string;
  portalId: number;
  /** The record that gets stamped. */
  objectTypeId: string;
  objectId: string;
  changeType: ChangeType;
  /** The other record's object type id (e.g. "0-1", "2-123"): the option value of changecatch_other_object_type. */
  otherObjectType: string;
  otherRecordId: string;
  /**
   * Already formatted as multi-checkbox option values (see label-options.ts): e.g. "0-1:279;0-1:281", "none" or
   * "unknown". The prefix is the OTHER record's object type id, the number the label's association type id.
   */
  labelBefore: string;
  labelAfter: string;
  labelsCurrent: string;
  associationCategory: string;
  /** ISO 8601. */
  occurredAt: string;
}

/** One record update for the batch update API. All 7 properties are always written, in one call. */
export interface StampUpdate {
  portalId: number;
  objectTypeId: string;
  objectId: string;
  /** Epoch ms of the change. Used to keep per-record order. */
  occurredAtMs: number;
  /** All 7 properties for a normal stamp. An AMEND stamp (amendOf set) carries only the label properties. */
  properties: Partial<Record<StampPropertyName, string>>;
  /**
   * Late-half absorption (absorb.ts): this update only corrects the labels of an already-stamped change (amendOf =
   * that change id). It never writes changecatch_last_change_id, so it starts no workflow enrollment.
   */
  amendOf?: string;
  /** Queue identity when it is not changecatch_last_change_id (amend stamps: `<changeId>~amend-<hash>`). */
  stampId?: string;
  /**
   * Burst coalescing (./coalesce.ts COALESCE_THRESHOLD): how many association changes this stamp stands for
   * (1 = just this change; N = this change + N-1 folded ones). NOT written to HubSpot (D5): logs + metrics only.
   */
  coalescedCount?: number;
}

/**
 * Row codec for a persisted StampUpdate (stamp_queue / stamp_dead_letter update_json). Plain JSON of the object above:
 * rows written by older builds must keep decoding, so a field change here needs a migration of those rows.
 */
export const encodeStampUpdate = (u: StampUpdate): string => JSON.stringify(u);
export const decodeStampUpdate = (json: string): StampUpdate => JSON.parse(json) as StampUpdate;

/**
 * Unique, deterministic id per (change, stamped record): `${occurredAtMs}-${10 hex}`.
 * Same journal input -> same id, so a re-run after a crash produces the same id (and the same change_log row).
 * Starts with the timestamp, so ids sort roughly by time and are easy to eyeball.
 */
export function changeIdFor(
  change: Pick<NormalizedChange, 'portalId' | 'sourceKeys' | 'occurredAt'>,
  targetTypeId: string,
  targetId: string,
): string {
  const h = createHash('sha256');
  h.update(`${change.portalId}\n`);
  h.update([...change.sourceKeys].sort().join('\n'));
  h.update(`\n->${targetTypeId}:${targetId}`);
  const ms = Date.parse(change.occurredAt);
  return `${Number.isFinite(ms) ? ms : 0}-${h.digest('hex').slice(0, 10)}`;
}

function buildRecord(
  change: NormalizedChange,
  target: [string, string],
  other: [string, string],
  mirrored: boolean,
): ChangeRecord {
  // ADDED: nothing before. REMOVED: nothing after and nothing current. Otherwise undefined = unknown.
  // Values are option values of the multi-checkbox label properties, keyed by the other record's object type.
  // Label keys are type ids in the from -> to direction; the mirror record needs the to -> from ids (mirrorLabelKeys).
  // A key with no translation becomes unresolved -> "unknown" (never a wrong label).
  const keys = (labels: string[] | undefined) =>
    labels === undefined || !mirrored ? labels : labels.map((k) => (isTypeIdKey(k) ? (change.mirrorLabelKeys?.[k] ?? unresolvedKey('?')) : k));
  const fmt = (labels: string[] | undefined, whenUndefined: string = UNKNOWN) => formatLabelValues(keys(labels), other[0], whenUndefined);
  const before = change.changeType === 'ADDED' ? fmt(change.labelBefore, NONE) : fmt(change.labelBefore);
  const after = change.changeType === 'REMOVED' ? fmt(change.labelAfter, NONE) : fmt(change.labelAfter);
  const current = change.changeType === 'REMOVED' ? NONE : fmt(change.labelsCurrent);
  return {
    changeId: changeIdFor(change, target[0], target[1]),
    portalId: change.portalId,
    objectTypeId: target[0],
    objectId: target[1],
    changeType: change.changeType,
    otherObjectType: other[0],
    otherRecordId: other[1],
    labelBefore: before,
    labelAfter: after,
    labelsCurrent: current,
    associationCategory: change.associationCategory,
    occurredAt: change.occurredAt,
  };
}

/**
 * NormalizedChange -> one change record for the "from" record, plus (mirror = STAMP_MIRROR) one for the "to" record
 * with from/to swapped, so workflows on either object can trigger.
 */
export function toChangeRecords(change: NormalizedChange, mirror: boolean): ChangeRecord[] {
  const from: [string, string] = [change.fromObjectTypeId, String(change.fromObjectId)];
  const to: [string, string] = [change.toObjectTypeId, String(change.toObjectId)];
  const out = [buildRecord(change, from, to, false)];
  if (mirror) out.push(buildRecord(change, to, from, true));
  return out;
}

/** The property values written onto the record (the 7 STAMP_PROPS). */
export function toStampUpdate(r: ChangeRecord): StampUpdate {
  const ms = Date.parse(r.occurredAt);
  return {
    portalId: r.portalId,
    objectTypeId: r.objectTypeId,
    objectId: r.objectId,
    occurredAtMs: ms,
    properties: {
      [STAMP_PROPS.changeId]: r.changeId,
      [STAMP_PROPS.changeType]: r.changeType,
      [STAMP_PROPS.otherObjectType]: r.otherObjectType,
      [STAMP_PROPS.otherRecordId]: r.otherRecordId,
      [STAMP_PROPS.labelBefore]: r.labelBefore,
      [STAMP_PROPS.labelAfter]: r.labelAfter,
      [STAMP_PROPS.labelsCurrent]: r.labelsCurrent,
    },
  };
}

/** Identity of a stamp in the queue / seen set: the change id, or stampId for an amend stamp. */
export function stampIdOf(u: StampUpdate): string {
  return u.stampId ?? u.properties[STAMP_PROPS.changeId] ?? '';
}

/** Stable order for one record's updates: occurredAt, then stamp id (ids start with the time; an amend sorts after its change). */
export function compareUpdates(a: StampUpdate, b: StampUpdate): number {
  if (a.occurredAtMs !== b.occurredAtMs) return a.occurredAtMs - b.occurredAtMs;
  const x = stampIdOf(a);
  const y = stampIdOf(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
