// Property stamping: the v1 delivery path (decision 2026-10-30, app events need partner approval).
// For each NormalizedChange we PATCH the affected record ONCE with app-owned "changecatch_*" properties.
// Customer workflows trigger on "Property value changed" for changecatch_last_change_id (always a new value).
// A custom workflow action "Get association change" looks the change up by id in the change_log table.
//
// Everything here is pure (no HTTP, no DB), so it is unit-tested in stamp.test.ts.
//
// ---------- Scheduling contract (scale-review C1 fix) ----------
// Every record gets its OWN slots. A record's backlog only delays that record, never other records in the portal.
//   planStampSlots(updates, lastStampAt, now, spacingMs) -> StampSlot[]
//       notBefore = max(now, lastStampAt(record) + spacing) for a record's first update, then +spacing for each
//       further update of the same record (in occurredAt order). Other records are not affected.
//   planStampBatches(slots, max = 100) -> StampBatch[]
//       Groups only slots with the SAME notBefore, per (portal, objectType), <= 100 per batch, one update per
//       record per batch. Sorted by notBefore.
//   planStampWaves(...)  (kept for the in-memory Stamper in src/hubspot/stamp.ts; same signature as before)
//       Now built on planStampSlots: one wave per distinct notBefore, no "waves are sequential" barrier.
// The persisted worker queue should use planEnqueue() in ./coalesce.ts (per-record slots + burst coalescing).
// lastStampAt must be the time the record was last ACTUALLY stamped. Do not fold queued slots into it when
// using planEnqueue (it takes the queued items separately); for planStampSlots/planStampWaves folding in the
// record's own max queued slot is fine (it only delays that record).

import { createHash } from 'node:crypto';
import { formatLabelValues, NONE, UNKNOWN } from './label-options.js';
import type { ChangeType, NormalizedChange } from './types.js';

export { NONE, UNKNOWN } from './label-options.js';

export const STAMP_PROPS = {
  changeId: 'changecatch_last_change_id',
  changeType: 'changecatch_change_type',
  otherObjectType: 'changecatch_other_object_type',
  otherRecordId: 'changecatch_other_record_id',
  labelBefore: 'changecatch_label_before',
  labelAfter: 'changecatch_label_after',
  labelsCurrent: 'changecatch_labels_current',
} as const;

export type StampPropertyName = (typeof STAMP_PROPS)[keyof typeof STAMP_PROPS];

/**
 * The 7 property names written on every stamp (decision D5, 2026-10-30: trimmed from 9; `changecatch_last_change_at`
 * and `changecatch_changes_since_last_stamp` were removed. Old copies in already-installed portals are left alone.)
 */
export const STAMP_PROPERTY_NAMES: readonly StampPropertyName[] = Object.values(STAMP_PROPS);

/** Separator for human-readable label lists (logs, app-event mode). Stamped label properties use ";" option values. */
export const LABEL_SEPARATOR = '; ';

export type DeliveryMode = 'stamp' | 'app_events';

/** DELIVERY_MODE=stamp|app_events. Default: stamp. */
export function deliveryModeFromEnv(value: string | undefined = process.env.DELIVERY_MODE): DeliveryMode {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '' || v === 'stamp') return 'stamp';
  if (v === 'app_events') return 'app_events';
  throw new Error(`Invalid DELIVERY_MODE "${value}". Use "stamp" or "app_events".`);
}

export interface StampConfig {
  /** Also stamp the "to" record (with from/to swapped), so workflows on either object can trigger. */
  mirrorOnOtherRecord: boolean;
  /** Minimum gap between two stamps on the same record, so workflow enrollments don't merge. */
  minSpacingMs: number;
  /** Display names for object type ids in changecatch_other_object_type. Unknown ids are written as-is. */
  objectTypeNames: Record<string, string>;
}

export const STANDARD_OBJECT_NAMES: Record<string, string> = {
  '0-1': 'Contact',
  '0-2': 'Company',
  '0-3': 'Deal',
  '0-5': 'Ticket',
};

export const DEFAULT_STAMP_CONFIG: StampConfig = {
  mirrorOnOtherRecord: false,
  minSpacingMs: 3_000,
  objectTypeNames: STANDARD_OBJECT_NAMES,
};

/** One row of the change log, and the data behind one stamp. Field names match the store's change_log columns. */
export interface ChangeRecord {
  changeId: string;
  portalId: number;
  /** The record that gets stamped. */
  objectTypeId: string;
  objectId: string;
  changeType: ChangeType;
  /** Display name (e.g. "Contact") or the raw object type id for custom objects. */
  otherObjectType: string;
  otherRecordId: string;
  /**
   * Already formatted as multi-checkbox option values (see label-options.ts): e.g. "0-1:Decision maker;0-1:Influencer",
   * "(none)" or "(unknown)". The prefix is the OTHER record's object type id.
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
   * Burst coalescing (COALESCE_MODE=latest, ./coalesce.ts): how many association changes this stamp stands for
   * (1 = just this change; N = this change + N-1 folded ones). NOT written to HubSpot (D5): logs + metrics only.
   */
  coalescedCount?: number;
}

/** Human-readable label list ("A; B"). Not used for the stamped properties (those use formatLabelValues). */
export function formatLabels(labels: string[] | undefined, whenUndefined: string = UNKNOWN): string {
  if (labels === undefined) return whenUndefined;
  const clean = labels.map((l) => l.trim()).filter((l) => l.length > 0);
  return clean.length === 0 ? NONE : clean.join(LABEL_SEPARATOR);
}

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
  config: StampConfig,
): ChangeRecord {
  // ADDED: nothing before. REMOVED: nothing after and nothing current. Otherwise undefined = unknown.
  // Values are option values of the multi-checkbox label properties, keyed by the other record's object type.
  const fmt = (labels: string[] | undefined, whenUndefined: string = UNKNOWN) => formatLabelValues(labels, other[0], whenUndefined);
  const before = change.changeType === 'ADDED' ? fmt(change.labelBefore, NONE) : fmt(change.labelBefore);
  const after = change.changeType === 'REMOVED' ? fmt(change.labelAfter, NONE) : fmt(change.labelAfter);
  const current = change.changeType === 'REMOVED' ? NONE : fmt(change.labelsCurrent);
  return {
    changeId: changeIdFor(change, target[0], target[1]),
    portalId: change.portalId,
    objectTypeId: target[0],
    objectId: target[1],
    changeType: change.changeType,
    otherObjectType: config.objectTypeNames[other[0]] ?? other[0],
    otherRecordId: other[1],
    labelBefore: before,
    labelAfter: after,
    labelsCurrent: current,
    associationCategory: change.associationCategory,
    occurredAt: change.occurredAt,
  };
}

/** NormalizedChange -> one change record for the "from" record, plus one for the "to" record if mirroring. */
export function toChangeRecords(change: NormalizedChange, config: Partial<StampConfig> = {}): ChangeRecord[] {
  const cfg: StampConfig = { ...DEFAULT_STAMP_CONFIG, ...config };
  const from: [string, string] = [change.fromObjectTypeId, String(change.fromObjectId)];
  const to: [string, string] = [change.toObjectTypeId, String(change.toObjectId)];
  const out = [buildRecord(change, from, to, cfg)];
  if (cfg.mirrorOnOtherRecord) out.push(buildRecord(change, to, from, cfg));
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

/**
 * Only these properties are written by an amend stamp (a late-half label correction of the change the record shows).
 * Never changecatch_last_change_id (no workflow enrollment) and never changecatch_change_type: a stamped change's type is
 * never changed silently; a type correction is a NEW change (src/core/absorb.ts).
 */
export const AMEND_PROPERTY_NAMES: readonly StampPropertyName[] = [
  STAMP_PROPS.labelBefore,
  STAMP_PROPS.labelAfter,
  STAMP_PROPS.labelsCurrent,
];

// ---------- spacing: never stamp the same record twice within minSpacingMs ----------

export const recordKey = (u: { portalId: number; objectTypeId: string; objectId: string }) =>
  `${u.portalId}|${u.objectTypeId}|${u.objectId}`;

/**
 * seen_events prefix: a NORMAL stamp for this change id was actually written to HubSpot (a workflow may have run on
 * it). Coalesced-away changes never get it. Set by the StampQueue on success; read by absorb.ts.
 */
export const SENT_PREFIX = 'stamp-sent:';

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

export interface StampSlot {
  /** Epoch ms. Send no earlier than this. */
  notBefore: number;
  update: StampUpdate;
}

/**
 * Per-record slots (C1 fix). For each record, in occurredAt order:
 *   first update:  notBefore = lastStampAt(record) === undefined ? now : max(now, lastStampAt + spacing)
 *   each next one: notBefore = max(now, previous slot + spacing)
 * Records never share a timeline: 200 updates on deal A put only deal A's slots into the future.
 * Output is sorted by (notBefore, occurredAt).
 */
export function planStampSlots(
  updates: StampUpdate[],
  lastStampAt: (key: string) => number | undefined,
  now: number,
  minSpacingMs: number,
): StampSlot[] {
  const prev = new Map<string, number | undefined>();
  const out: StampSlot[] = [];
  for (const u of [...updates].sort(compareUpdates)) {
    const k = recordKey(u);
    const p = prev.has(k) ? prev.get(k) : lastStampAt(k);
    const notBefore = p === undefined ? now : Math.max(now, p + minSpacingMs);
    prev.set(k, notBefore);
    out.push({ notBefore, update: u });
  }
  return out.sort((a, b) => a.notBefore - b.notBefore || compareUpdates(a.update, b.update));
}

/** Groups slots with the same notBefore. At most one update per record per group (matters only if spacing is 0). */
function groupSameTime(slots: StampSlot[], keyOf: (u: StampUpdate) => string, maxPerGroup: number): { notBefore: number; updates: StampUpdate[] }[] {
  const sorted = [...slots].sort((a, b) => a.notBefore - b.notBefore || compareUpdates(a.update, b.update));
  const out: { notBefore: number; updates: StampUpdate[] }[] = [];
  // Open groups for the current notBefore, per group key: list of groups, each with its record set.
  let currentTime: number | undefined;
  let open = new Map<string, { notBefore: number; updates: StampUpdate[]; records: Set<string> }[]>();
  for (const s of sorted) {
    if (s.notBefore !== currentTime) {
      currentTime = s.notBefore;
      open = new Map();
    }
    const gk = keyOf(s.update);
    const rk = recordKey(s.update);
    const list = open.get(gk) ?? open.set(gk, []).get(gk)!;
    // First group (in order) that doesn't hold this record yet and has room. Later groups keep per-record order.
    let target = undefined as (typeof list)[number] | undefined;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].records.has(rk)) break;
      if (list[i].updates.length < maxPerGroup) target = list[i];
    }
    if (!target) {
      target = { notBefore: s.notBefore, updates: [], records: new Set() };
      list.push(target);
      out.push(target);
    }
    target.updates.push(s.update);
    target.records.add(rk);
  }
  return out.map(({ notBefore, updates }) => ({ notBefore, updates }));
}

export interface StampBatch {
  notBefore: number;
  portalId: number;
  objectTypeId: string;
  /** <= maxPerBatch updates, one per record, all for this portal + object type. */
  updates: StampUpdate[];
}

/** Slots -> batch/update calls: same notBefore only, per (portal, objectType), chunked to `maxPerBatch` (100). */
export function planStampBatches(slots: StampSlot[], maxPerBatch = 100): StampBatch[] {
  return groupSameTime(slots, (u) => `${u.portalId}|${u.objectTypeId}`, maxPerBatch).map((g) => ({
    notBefore: g.notBefore,
    portalId: g.updates[0].portalId,
    objectTypeId: g.updates[0].objectTypeId,
    updates: g.updates,
  }));
}

export interface StampWave {
  /** Epoch ms. Send this wave no earlier than this. */
  notBefore: number;
  updates: StampUpdate[];
}

/**
 * Kept for the in-memory Stamper (scripts). Same signature and guarantees as before:
 *  - one wave holds at most one update per record,
 *  - a record's updates keep their occurredAt order,
 *  - a record is stamped no sooner than minSpacingMs after its previous stamp.
 * Changed (C1): each record has its own slots (planStampSlots); a wave = the updates due at the SAME time.
 * A busy record no longer pushes other records' waves back. Waves are sorted by notBefore.
 */
export function planStampWaves(
  updates: StampUpdate[],
  lastStampAt: (key: string) => number | undefined,
  now: number,
  minSpacingMs: number,
): StampWave[] {
  return groupSameTime(planStampSlots(updates, lastStampAt, now, minSpacingMs), () => '', Number.POSITIVE_INFINITY);
}
