// Typed client for the Webhooks Journal + journal subscription APIs.
// All calls use the APP-LEVEL client credentials token (see auth.ts), never a customer token.
//
// Version: HUBSPOT_API_VERSION (2026-09, current "latest" docs as of 2026-10-30). v4 paths are legacy; do not use.

import { backoffMs } from '../lib/backoff.js';
import { HUBSPOT_API_VERSION, hsFetch, hsRequest, HubSpotError } from '../lib/http.js';
import type { AppBucket } from '../lib/rate-limiter.js';
import { appTokenSource } from './auth.js';
import type { AppClient } from './oauth.js';

const SUBS = `/webhooks-journal/subscriptions/${HUBSPOT_API_VERSION}`;
const JOURNAL = `/webhooks-journal/journal/${HUBSPOT_API_VERSION}`;

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
  eventTypeId: string; // see app-lifecycle.ts APP_EVENT_TYPE
  properties: string[];
}

export type SubscriptionRequest = AssociationSubscriptionRequest | AppLifecycleSubscriptionRequest;

export interface Subscription {
  id: number;
  appId: number;
  subscriptionType: SubscriptionType;
  objectTypeId?: string;
  /** APP_LIFECYCLE_EVENT subscriptions: the event type (app-lifecycle.ts APP_EVENT_TYPE), set by normaliseSubscription. */
  eventTypeId?: string;
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

/** The subscription part of the journal client (journalClient below), or a test fake. */
export interface SubscriptionApi {
  listSubscriptions(): Promise<Subscription[]>;
  createSubscription(body: SubscriptionRequest): Promise<Subscription>;
  deleteSubscription(id: number): Promise<void>;
  deletePortalSubscriptions(portalId: number): Promise<void>;
}

/**
 * HubSpot's list returns a lifecycle subscription's event type in `objectTypeId` (e.g. "4-1909196", seen live), even
 * though the create request calls it `eventTypeId`. We always expose it as `eventTypeId`.
 */
export function normaliseSubscription(s: Subscription): Subscription {
  if (s.subscriptionType !== 'APP_LIFECYCLE_EVENT' || s.eventTypeId) return s;
  return { ...s, eventTypeId: s.objectTypeId };
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

// ---------------------------------------------------------------- client

function clampCount(count: number): number {
  return Math.max(1, Math.min(MAX_BATCH, Math.floor(count)));
}

export type JournalClient = ReturnType<typeof journalClient>;

export function journalClient(app: AppClient) {
  const appToken = appTokenSource(app);
  async function call<T>(bucket: AppBucket, path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
    return hsRequest<T>(path, { ...opts, bucket, token: await appToken() });
  }
  /**
   * The docs do not say how "nothing new" is signalled for single reads.
   * We treat 204 / empty body / 404 as "no entry".
   */
  async function single(path: string): Promise<JournalFetchResponse | null> {
    try {
      const res = await call<JournalFetchResponse | undefined>('journal', path);
      return res && typeof res === 'object' && res.url ? res : null;
    } catch (e) {
      if (e instanceof HubSpotError && e.status === 404) return null;
      throw e;
    }
  }

  return {
    // ------------------------------------------------------------ subscriptions

    // Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/subscriptions/create-subscription
    // POST /webhooks-journal/subscriptions/2026-09  (upsert)  scope: developer.webhooks_journal.subscriptions.write
    createSubscription(body: SubscriptionRequest): Promise<Subscription> {
      return call<Subscription>('subscriptions', SUBS, { method: 'POST', body });
    },

    // Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/subscriptions/get-subscriptions
    // GET /webhooks-journal/subscriptions/2026-09  (no paging)  scope: developer.webhooks_journal.subscriptions.read
    async listSubscriptions(): Promise<Subscription[]> {
      const res = await call<{ results: Subscription[] }>('subscriptions', SUBS);
      return (res?.results ?? []).map(normaliseSubscription);
    },

    // Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/subscriptions/delete-subscription
    // DELETE /webhooks-journal/subscriptions/2026-09/{subscriptionId} -> 204  scope: ...subscriptions.write
    async deleteSubscription(subscriptionId: number | string): Promise<void> {
      await call<void>('subscriptions', `${SUBS}/${encodeURIComponent(String(subscriptionId))}`, { method: 'DELETE' });
    },

    // Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/subscriptions/delete-subscriptions-by-portal
    // DELETE /webhooks-journal/subscriptions/2026-09/portals/{portalId} -> 204  scope: ...subscriptions.write
    async deletePortalSubscriptions(portalId: number): Promise<void> {
      await call<void>('subscriptions', `${SUBS}/portals/${portalId}`, { method: 'DELETE' });
    },

    // ------------------------------------------------------------ journal: single reads (global)
    // Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/journal-entries/guide#retrieve-journal-data
    // scope: developer.webhooks_journal.read.

    /** GET /webhooks-journal/journal/2026-09/earliest */
    getEarliest: () => single(`${JOURNAL}/earliest`),

    /** GET /webhooks-journal/journal/2026-09/latest */
    getLatest: () => single(`${JOURNAL}/latest`),

    // ------------------------------------------------------------ journal: batch reads (global, max 100)
    // Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/journal-entries/guide#batch-journal-operations
    // Path note: the guide's prose says /webhooks/2026-09/journal/batch/..., but its curl examples and the
    // OpenAPI reference use /webhooks-journal/journal/2026-09/batch/... We use the latter.

    /** GET /webhooks-journal/journal/2026-09/batch/{offset}/next/{count}: entries AFTER offset, in order. */
    batchNext: (offset: string, count = MAX_BATCH) =>
      call<JournalBatchResponse>('journal', `${JOURNAL}/batch/${encodeURIComponent(offset)}/next/${clampCount(count)}`),

    /** GET /webhooks-journal/journal/2026-09/batch/earliest/{count} */
    batchEarliest: (count = MAX_BATCH) => call<JournalBatchResponse>('journal', `${JOURNAL}/batch/earliest/${clampCount(count)}`),
  };
}

// ---------------------------------------------------------------- journal file download
// The presigned URL comes from HubSpot's API, but we still fetch only HubSpot's journal bucket on S3 over https,
// capped at JOURNAL_MAX_FILE_BYTES. Anything else is a DownloadRejectedError: the reader alerts
// "journal_file_rejected" and holds the offset (it never skips past a file it did not read).

export const JOURNAL_MAX_FILE_BYTES = 20 * 1024 * 1024;
const JOURNAL_DOWNLOAD_TIMEOUT_MS = 15_000;
const DOWNLOAD_RETRIES = 3;

/** A journal file download we refuse: not HubSpot's journal bucket, or over the size cap. Never retried. */
export class DownloadRejectedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'DownloadRejectedError';
  }
}

/** HubSpot's S3 journal bucket over https, no user info (seen live: hubspot-webhooks-journal-na1.s3.amazonaws.com). */
function isJournalFileUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && host.startsWith('hubspot-webhooks-journal') && host.endsWith('.amazonaws.com') && !url.username && !url.password;
}

/**
 * Download a presigned journal file as text. Not the journal bucket, or a body over the cap -> DownloadRejectedError.
 * 5xx / network / timeout (a redirect counts as a network error) are retried with back-off. Presigned S3 URLs are
 * not rate limited by HubSpot.
 */
export async function downloadJournalFile(raw: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DownloadRejectedError('journal file URL is not a valid URL; refusing to download');
  }
  if (!isJournalFileUrl(url))
    throw new DownloadRejectedError(`journal file URL host "${url.hostname.toLowerCase()}" (${url.protocol}) is not HubSpot's journal bucket; refusing to download`);
  const read = async (res: Response): Promise<string> => {
    if (!res.ok) return '';
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > JOURNAL_MAX_FILE_BYTES)
      throw new DownloadRejectedError(`journal file is ${declared} bytes, over the ${JOURNAL_MAX_FILE_BYTES} byte cap`);
    return readCapped(res);
  };
  for (let n = 0; ; n++) {
    const a = await hsFetch(url, { method: 'GET', redirect: 'error' }, { api: 'journal_file', timeoutMs: JOURNAL_DOWNLOAD_TIMEOUT_MS, read });
    if (a.ok && a.res.ok) return a.data;
    const error = a.ok ? HubSpotError.fromStatus(a.res.status, undefined, `journal file download failed with ${a.res.status}`) : a.error;
    if (error.kind !== 'transient' || n >= DOWNLOAD_RETRIES) throw error;
    await new Promise((r) => setTimeout(r, backoffMs(n, 250, 5_000)));
  }
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > JOURNAL_MAX_FILE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new DownloadRejectedError(`journal file is over the ${JOURNAL_MAX_FILE_BYTES} byte cap`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
