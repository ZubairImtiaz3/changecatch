// Core types for the journal worker.
// Journal payload shapes come from the docs' example JSON:
// https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/guide (section "Event data format")
// Important: `offset` belongs to a journal FILE, which holds many `journalEvents`. Events have no own id.

export type AssociationAction = 'ASSOCIATION_ADDED' | 'ASSOCIATION_REMOVED';

/** HubSpot's category for its built-in association types (e.g. the unlabeled Deal->Contact default, typeId 3). */
export const HUBSPOT_DEFINED = 'HUBSPOT_DEFINED';

/** One association event inside a journal file (docs example "Association added"). */
export interface JournalAssociationEntry {
  type: 'association';
  portalId: number;
  occurredAt: string; // ISO 8601
  action: AssociationAction;
  fromObjectId: number | string;
  toObjectId: number | string;
  fromObjectTypeId: string; // e.g. "0-3" or "2-134027637"
  toObjectTypeId: string;
  associationTypeId: number;
  /** Seen in real journal data: HUBSPOT_DEFINED and USER_DEFINED (pairing.ts A2). INTEGRATOR_DEFINED is unconfirmed. */
  associationCategory: string;
  isPrimary?: boolean;
}

/** Any other journal event (crmObject, app_lifecycle_event, ...). The worker passes these through untouched. */
export interface JournalOtherEvent {
  type: string;
  portalId?: number;
  occurredAt?: string;
  action?: string;
  [k: string]: unknown;
}

export type JournalEvent = JournalAssociationEntry | JournalOtherEvent;

/** The downloaded journal file (the thing the presigned `url` points to). */
export interface JournalFile {
  offset: string;
  journalEvents: JournalEvent[];
  publishedAt?: string;
}

/** A journal association event plus worker bookkeeping. */
export interface AssociationEntry {
  event: JournalAssociationEntry;
  fileOffset: string;
  /** Stable identity key, see dedupe.ts. */
  key: string;
  occurredAtMs: number;
}

/**
 * Row codec for a persisted AssociationEntry (pending_pairs / parked_entries entry_json). Plain JSON of the object
 * above: rows written by older builds must keep decoding, so a field change here needs a migration of those rows.
 */
export const encodeEntry = (e: AssociationEntry): string => JSON.stringify(e);
export const decodeEntry = (json: string): AssociationEntry => JSON.parse(json) as AssociationEntry;

/** One association type (label) of an object pair, as HubSpot defines it. label null = the unlabeled default type. */
export interface LabelDefinition {
  associationTypeId: number;
  label: string | null;
  category: string;
}

/** A label reference keeps its own direction because association type IDs are direction-specific. */
export interface LabelRef {
  fromObjectTypeId: string;
  toObjectTypeId: string;
  associationTypeId: number;
  associationCategory: string;
}

export type ChangeType = 'ADDED' | 'REMOVED' | 'LABEL_CHANGED';

/** Output of pairing: still in type IDs, not label names. */
export interface PairedChange {
  portalId: number;
  changeType: ChangeType;
  fromObjectTypeId: string;
  fromObjectId: string;
  toObjectTypeId: string;
  toObjectId: string;
  removed: LabelRef[];
  added: LabelRef[];
  associationCategory: string;
  occurredAt: string;
  sourceKeys: string[];
  sourceOffsets: string[];
  /**
   * Net count of structural (unlabeled default) events in the cluster. <0 = the link went away, >0 = a new link,
   * 0 = labels only. Used by late-half absorption (absorb.ts).
   */
  structuralNet: number;
}

/** A change with its label keys resolved; this is what gets stamped (stamp.ts toChangeRecords). */
export interface NormalizedChange {
  portalId: number;
  changeType: ChangeType;
  fromObjectTypeId: string;
  fromObjectId: string;
  toObjectTypeId: string;
  toObjectId: string;
  labelBefore?: string[];
  labelAfter?: string[];
  /** Full label set after the change. Undefined when we don't know it. */
  labelsCurrent?: string[];
  /**
   * Label KEYS this change removed / added (from the journal events). Set by resolveChanges. All label arrays on this
   * type hold keys: the association type id (direction from -> to) as a string, "unlabeled", or "type N" (unresolved).
   */
  removedLabels?: string[];
  addedLabels?: string[];
  /** STAMP_MIRROR only: key (from -> to) -> the same label's key in the to -> from direction. */
  mirrorLabelKeys?: Record<string, string>;
  associationCategory: string;
  occurredAt: string;
  sourceOffsets: string[];
  sourceKeys: string[];
}

/** A watched object pair from portal settings. Direction-insensitive. */
export interface WatchedPair {
  objectTypeId: string;
  associatedObjectTypeId: string;
}

export interface PendingEntry {
  entry: AssociationEntry;
  /** Epoch ms. After this, the entry is emitted even without a partner. */
  holdUntil: number;
}

export function isAssociationEvent(e: JournalEvent): e is JournalAssociationEntry {
  return (
    e.type === 'association' &&
    (e.action === 'ASSOCIATION_ADDED' || e.action === 'ASSOCIATION_REMOVED')
  );
}
