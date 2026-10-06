// Typed client for the Webhooks Journal + journal subscription APIs.
// All calls use the APP-LEVEL client credentials token (see auth.ts), never a customer token.
//
// Version: 2026-09 (current "latest" docs as of 2026-10-30). v4 paths are legacy; do not use.

import type { JournalFile } from '../core/types.js';
import { hsRequest, HttpError } from '../lib/http.js';
import { getAppToken } from './auth.js';

export const JOURNAL_VERSION = '2026-09';
const SUBS = `/webhooks-journal/subscriptions/${JOURNAL_VERSION}`;
const JOURNAL = `/webhooks-journal/journal/${JOURNAL_VERSION}`;

/** Max entries per batch call. More returns 400 VALIDATION_ERROR. */
export const MAX_BATCH = 100;

// ---------------------------------------------------------------- types

export type JournalAction =
  | 'CREATE' | 'UPDATE' | 'DELETE' | 'MERGE' | 'RESTORE'
  | 'ASSOCIATION_ADDED' | 'ASSOCIATION_REMOVED' | 'SNAPSHOT'
  | 'APP_INSTALL' | 'APP_UNINSTALL' | 'ADDED_TO_LIST' | 'REMOVED_FROM_LIST' | 'GDPR_DELETE';

export type SubscriptionType =
  | 'OBJECT' | 'ASSOCIATION' | 'APP_LIFECYCLE_EVENT' | 'LIST_MEMBERSHIP' | 'GDPR_PRIVACY_DELETION' | 'EVENT';

/** AssociationSubscriptionUpsertRequest (all fields required per the OpenAPI schema). */
export interface AssociationSubscriptionRequest {
  subscriptionType: 'ASSOCIATION';
  portalId: number;
  objectTypeId: string; // e.g. "0-3" or "2-123456"
  associatedObjectTypeIds: string[]; // e.g. ["0-1"]
  actions: ('ASSOCIATION_ADDED' | 'ASSOCIATION_REMOVED')[];
  /** Required by the schema. [] means "all records". */
  objectIds: number[];
}

/** AppLifecycleEventSubscriptionUpsertRequest. App-level: no portalId. */
export interface AppLifecycleSubscriptionRequest {
  subscriptionType: 'APP_LIFECYCLE_EVENT';
  eventTypeId: string; // see APP_EVENT_TYPE
  properties: string[];
}

export type SubscriptionRequest = AssociationSubscriptionRequest | AppLifecycleSubscriptionRequest;

export const APP_EVENT_TYPE = {
  INSTALL: '4-1909196',
  UNINSTALL: '4-1916193',
} as const;

export interface Subscription {
  id: number;
  appId: number;
  subscriptionType: SubscriptionType;
  objectTypeId?: string;
  portalId?: number;
  actions: JournalAction[];
  associatedObjectTypeIds?: string[];
  objectIds?: number[];
  properties?: string[];
  listIds?: number[];
  createdBy?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  [k: string]: unknown;
}

/** What every journal read returns: a pre-signed file URL, not the events. */
export interface JournalFetchResponse {
  url: string;
  expiresAt: string;
  currentOffset: string;
}

export interface JournalBatchError {
  status: string; // NOT_FOUND | PRESIGNING_ERROR | VALIDATION_ERROR | ...
  category?: string;
  message: string;
  context?: { offset?: string[]; [k: string]: unknown };
}

export interface JournalBatchResponse {
  status: 'PENDING' | 'PROCESSING' | 'CANCELED' | 'COMPLETE' | string;
  startedAt: string;
  completedAt: string;
  requestedAt?: string;
  results: JournalFetchResponse[];
  numErrors?: number;
  errors?: JournalBatchError[];
}

// ---------------------------------------------------------------- helpers

async function call<T>(path: string, opts: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {}): Promise<T> {
  const token = await getAppToken();
  return hsRequest<T>(path, { ...opts, token });
}

function portalQuery(installPortalId?: number) {
  return installPortalId === undefined ? undefined : { installPortalId };
}

function clampCount(count: number): number {
  return Math.max(1, Math.min(MAX_BATCH, Math.floor(count)));
}

/**
 * The docs do not say how "nothing new" is signalled for single reads.
 * We treat 204 / empty body / 404 as "no entry".
 */
async function single(path: string, installPortalId?: number): Promise<JournalFetchResponse | null> {
  try {
    const res = await call<JournalFetchResponse | undefined>(path, { query: portalQuery(installPortalId) });
    return res && typeof res === 'object' && res.url ? res : null;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

// ---------------------------------------------------------------- subscriptions

// Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/subscriptions/create-subscription
// POST /webhooks-journal/subscriptions/2026-09  (upsert)  scope: developer.webhooks_journal.subscriptions.write
export function createSubscription(body: SubscriptionRequest): Promise<Subscription> {
  return call<Subscription>(SUBS, { method: 'POST', body });
}

/** Convenience: an ASSOCIATION subscription for one portal and one object pair. */
export function createAssociationSubscription(args: {
  portalId: number;
  objectTypeId: string;
  associatedObjectTypeIds: string[];
  actions?: ('ASSOCIATION_ADDED' | 'ASSOCIATION_REMOVED')[];
  objectIds?: number[];
}): Promise<Subscription> {
  return createSubscription({
    subscriptionType: 'ASSOCIATION',
    portalId: args.portalId,
    objectTypeId: args.objectTypeId,
    associatedObjectTypeIds: args.associatedObjectTypeIds,
    actions: args.actions ?? ['ASSOCIATION_ADDED', 'ASSOCIATION_REMOVED'],
    objectIds: args.objectIds ?? [],
  });
}

// Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/subscriptions/get-subscriptions
// GET /webhooks-journal/subscriptions/2026-09  (no paging)  scope: developer.webhooks_journal.subscriptions.read
export async function listSubscriptions(): Promise<Subscription[]> {
  const res = await call<{ results: Subscription[] }>(SUBS);
  return res?.results ?? [];
}

// Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/subscriptions/delete-subscription
// DELETE /webhooks-journal/subscriptions/2026-09/{subscriptionId} -> 204  scope: ...subscriptions.write
export async function deleteSubscription(subscriptionId: number | string): Promise<void> {
  await call<void>(`${SUBS}/${encodeURIComponent(String(subscriptionId))}`, { method: 'DELETE' });
}

// Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/subscriptions/delete-subscriptions-by-portal
// DELETE /webhooks-journal/subscriptions/2026-09/portals/{portalId} -> 204  scope: ...subscriptions.write
export async function deletePortalSubscriptions(portalId: number): Promise<void> {
  await call<void>(`${SUBS}/portals/${portalId}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------- journal: single reads (global)
// Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/journal-entries/guide#retrieve-journal-data
// scope: developer.webhooks_journal.read. Optional installPortalId filters to one account.

/** GET /webhooks-journal/journal/2026-09/earliest */
export function getEarliest(installPortalId?: number) {
  return single(`${JOURNAL}/earliest`, installPortalId);
}

/** GET /webhooks-journal/journal/2026-09/latest */
export function getLatest(installPortalId?: number) {
  return single(`${JOURNAL}/latest`, installPortalId);
}

/** GET /webhooks-journal/journal/2026-09/offset/{offset}/next. null = nothing newer (assumed, see single()). */
export function getNext(offset: string, installPortalId?: number) {
  return single(`${JOURNAL}/offset/${encodeURIComponent(offset)}/next`, installPortalId);
}

// ---------------------------------------------------------------- journal: batch reads (global, max 100)
// Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/journal-entries/guide#batch-journal-operations
// Path note: the guide's prose says /webhooks/2026-09/journal/batch/..., but its curl examples and the
// OpenAPI reference use /webhooks-journal/journal/2026-09/batch/... We use the latter.

/** GET /webhooks-journal/journal/2026-09/batch/{offset}/next/{count}: entries AFTER offset, in order. */
export function batchNext(offset: string, count = MAX_BATCH, installPortalId?: number) {
  return call<JournalBatchResponse>(`${JOURNAL}/batch/${encodeURIComponent(offset)}/next/${clampCount(count)}`, {
    query: portalQuery(installPortalId),
  });
}

/** GET /webhooks-journal/journal/2026-09/batch/earliest/{count} */
export function batchEarliest(count = MAX_BATCH, installPortalId?: number) {
  return call<JournalBatchResponse>(`${JOURNAL}/batch/earliest/${clampCount(count)}`, { query: portalQuery(installPortalId) });
}

/** GET /webhooks-journal/journal/2026-09/batch/latest/{count} */
export function batchLatest(count = MAX_BATCH, installPortalId?: number) {
  return call<JournalBatchResponse>(`${JOURNAL}/batch/latest/${clampCount(count)}`, { query: portalQuery(installPortalId) });
}

// Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/journal-entries/aggregate/get-read
/** POST /webhooks-journal/journal/2026-09/batch/read { inputs: [offset...] }. 207 = partial (see errors[]). */
export function batchRead(offsets: string[], installPortalId?: number) {
  if (offsets.length > MAX_BATCH) throw new Error(`batchRead: max ${MAX_BATCH} offsets, got ${offsets.length}`);
  return call<JournalBatchResponse>(`${JOURNAL}/batch/read`, {
    method: 'POST',
    body: { inputs: offsets },
    query: portalQuery(installPortalId),
  });
}

// ---------------------------------------------------------------- journal file download

/**
 * Download the journal file behind a pre-signed URL. No Authorization header: it's a signed S3 link.
 * Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/guide#event-data-format
 */
export async function downloadJournalFile(urlOrFetch: string | JournalFetchResponse): Promise<JournalFile> {
  const url = typeof urlOrFetch === 'string' ? urlOrFetch : urlOrFetch.url;
  if (typeof urlOrFetch !== 'string' && Date.parse(urlOrFetch.expiresAt) < Date.now()) {
    throw new Error(`Journal URL already expired at ${urlOrFetch.expiresAt}; read the offset again.`);
  }
  const data = await hsRequest<JournalFile | string>(url);
  if (typeof data === 'string') throw new Error('Journal file was not JSON');
  return data;
}

// ---------------------------------------------------------------- worker-friendly read

export interface JournalReadResult {
  /** Downloaded files strictly after afterOffset, in the order HubSpot returned them (oldest first). */
  files: JournalFile[];
  /** Offset to store once these files are processed (last file's offset). null = nothing new. */
  nextOffset: string | null;
  /** True if the batch was full, so more is probably waiting. */
  full: boolean;
  /** Raw batch response, for debugging. */
  raw: JournalBatchResponse;
}

/**
 * Read up to `count` entries after `afterOffset` (or from the earliest if null) and download each file.
 * Matches the RunDeps.readJournal shape in src/core/poller.ts.
 * Throws if the batch had any per-entry error, so the caller retries instead of skipping data.
 */
export async function readJournalAfter(afterOffset: string | null, count = MAX_BATCH, installPortalId?: number): Promise<JournalReadResult> {
  const n = clampCount(count);
  let raw: JournalBatchResponse;
  try {
    raw = afterOffset ? await batchNext(afterOffset, n, installPortalId) : await batchEarliest(n, installPortalId);
  } catch (e) {
    // Assumed "empty" signal for a fresh/quiet journal .
    if (e instanceof HttpError && e.status === 404) {
      return { files: [], nextOffset: null, full: false, raw: { status: 'COMPLETE', startedAt: '', completedAt: '', results: [] } };
    }
    throw e;
  }
  raw = raw ?? { status: 'COMPLETE', startedAt: '', completedAt: '', results: [] };

  if ((raw.numErrors ?? 0) > 0 || (raw.errors?.length ?? 0) > 0) {
    const bad = (raw.errors ?? []).map((er) => `${er.status}:${er.context?.offset?.[0] ?? '?'}`).join(', ');
    throw new Error(`Journal batch had ${raw.numErrors ?? raw.errors?.length} error(s): ${bad}`);
  }

  const results = raw.results ?? [];
  const files: JournalFile[] = [];
  for (const r of results) {
    const file = await downloadJournalFile(r);
    if (!file.offset) file.offset = r.currentOffset;
    files.push(file);
  }
  const last = files.at(-1);
  return { files, nextOffset: last ? last.offset : null, full: results.length >= n, raw };
}
