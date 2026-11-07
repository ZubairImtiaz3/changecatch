// Domain key formats (record pair, user action, stamped record, label pair) that the store persists or ranges over.
// Stored keys must stay BYTE-IDENTICAL (no data migration): keys.test.ts pins each format. Purge
// (src/store/schema.ts PORTAL_TABLES) relies on portal-scoped keys starting with "<portalId>|", so build them only here.

/** Half-open range for every key starting with `<prefix>|` (PK-index friendly, unlike LIKE). '}' sorts right after '|'. */
export function keyRange(prefix: string): [string, string] {
  return [`${prefix}|`, `${prefix}}`];
}

/** Every "<portalId>|…" key of one portal. */
export const portalKeyRange = (portalId: number): [string, string] => keyRange(String(portalId));

/** Direction-insensitive key for "these two records in this portal" (association_labels.pair_key). */
export function pairKey(portalId: number, aType: string, aId: string | number, bType: string, bId: string | number): string {
  const a = `${aType}:${aId}`;
  const b = `${bType}:${bId}`;
  return `${portalId}|${a < b ? `${a}|${b}` : `${b}|${a}`}`;
}

/** One user action on one record pair (emitted_actions.action_key). */
export const actionKey = (pk: string, occurredAtMs: number): string => `${pk}|${occurredAtMs}`;

/** One stamped record (stamp_queue / stamp_last / emitted_actions record_key). */
export const recordKey = (u: { portalId: number; objectTypeId: string; objectId: string }): string =>
  `${u.portalId}|${u.objectTypeId}|${u.objectId}`;

/** Label definitions of one object pair ("portal|from|to"), or one association type of it ("portal|from|to|typeId" = label hold key). */
export const labelPairKey = (portalId: number, from: string, to: string, typeId?: number): string =>
  typeId === undefined ? `${portalId}|${from}|${to}` : `${portalId}|${from}|${to}|${typeId}`;

// --- seen_events prefixes (the rest of seen_events are journal entry keys) ---

/** A stamp for this id was handled: sent, or coalesced/dead-lettered away. */
export const STAMP_PREFIX = 'stamp:';
/**
 * A NORMAL stamp for this change id was actually written to HubSpot (a workflow may have run on it). Coalesced-away
 * changes never get it. Set by the StampQueue on success; read by absorb.ts.
 */
export const SENT_PREFIX = 'stamp-sent:';
