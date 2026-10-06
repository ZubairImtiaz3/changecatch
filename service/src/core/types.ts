// Core types for the journal worker.
// Journal payload shapes come from the docs' example JSON:
// https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/guide (section "Event data format")
// Important: `offset` belongs to a journal FILE, which holds many `journalEvents`. Events have no own id.

export type AssociationAction = 'ASSOCIATION_ADDED' | 'ASSOCIATION_REMOVED';

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
  /** Docs show "USER_DEFINED"; HUBSPOT_DEFINED and INTEGRATOR_DEFINED are expected but unconfirmed. */
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
   * 'structural' mode only: net count of structural (unlabeled default) events in the cluster. <0 = the link went
   * away, >0 = a new link, 0 = labels only. Used by late-half absorption (absorb.ts). Undefined in 'label' mode.
   */
  structuralNet?: number;
}

/** A change with label names resolved; this is what becomes app events. */
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
  /** Label names this change removed / added (from the journal events). Set by resolveChanges. */
  removedLabels?: string[];
  addedLabels?: string[];
  associationCategory: string;
  occurredAt: string;
  sourceOffsets: string[];
  sourceKeys: string[];
}

export interface AppEventProperties {
  change_type: ChangeType;
  other_object_type: string;
  other_record_id: string;
  label_before?: string;
  label_after?: string;
  labels_current?: string;
  association_category: string;
  /** ISO 8601. */
  occurred_at: string;
}

export interface AppEventOccurrence {
  /** Deterministic id (same journal input -> same id). Used to skip re-sends after a crash. */
  id: string;
  portalId: number;
  objectTypeId: string;
  objectId: string;
  occurredAt: string;
  properties: AppEventProperties;
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
