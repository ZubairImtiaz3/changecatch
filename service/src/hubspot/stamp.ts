// Writes ChangeCatch stamps onto customer records with the batch update API, using the customer's OAuth token.
//
// Docs (checked 2026-10-30):
//   POST /crm/objects/2026-09/{objectType}/batch/update  body { inputs: [{ id, properties }] }
//     https://developers.hubspot.com/docs/api-reference/latest/crm/objects/objects/batch/update-objects.md
//   "Object API batch endpoints are limited to 100 inputs per request." objectType may be 0-3 / 2-xxx:
//     https://developers.hubspot.com/docs/api-reference/latest/crm/using-object-apis.md
//   Response (checked 2026-11-07): 200 BatchResponseSimplePublicObject with results[] and optional errors[] /
//   numErrors. A 207 is not documented for batch UPDATE; http.ts treats any 2xx as success and we read errors[]
//   either way (item shape: ./batch.ts).
//   Whole-batch errors (checked 2026-11-07): the page lists only "200 successful operation" and a "default" error
//   response (category, correlationId, message, context, errors[]). It does NOT say whether one bad input (deleted id,
//   invalid option) fails the whole request with a 4xx or only that record. So a refused (4xx) multi-record batch is
//   bisected (sendStampBatch) until the bad record(s) are isolated; see untangle-log "Final confirmation pass".
// Scopes: crm.objects.<object>.write (core/contract.ts scopesFor).

import { scopesFor } from '../core/contract.js';
import type { StampUpdate } from '../core/stamp.js';
import { HUBSPOT_API_VERSION, hsRequest, HubSpotError, type PortalAuth } from '../lib/http.js';
import { createLogger, type Logger } from '../obs/log.js';
import { batchErrorFor, type BatchError } from './batch.js';
import { PortalNotInstalledError, TokenRefreshError, TokenRevokedError, withPortalToken, type TokenProvider } from './portal-tokens.js';

const MAX_STAMPS_PER_BATCH = 100;

export interface StampSendDeps {
  tokens: Pick<TokenProvider, 'getAccessToken'>;
  log?: Logger;
  /** Injected for tests. Defaults to the real batch update call. */
  batchUpdate?: (auth: PortalAuth, objectType: string, inputs: { id: string; properties: Record<string, string> }[]) => Promise<BatchUpdateResponse>;
}

export interface BatchUpdateResponse {
  status?: string;
  results?: { id: string }[];
  numErrors?: number;
  errors?: BatchError[];
}

/** Error categories that fix themselves (retry), even without a numeric status. */
const TRANSIENT_CATEGORIES = new Set(['RATE_LIMITS', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE', 'TIMEOUT']);

/** One record's error inside a 2xx batch response: 429 / 5xx / transient category -> 'retry'; other 4xx -> 'refused'. */
function batchErrorKind(e: BatchError): 'retry' | 'refused' {
  const status = Number(e.status);
  if (status === 429 || status >= 500) return 'retry';
  if (status >= 400) return 'refused';
  return TRANSIENT_CATEGORIES.has(e.category ?? '') ? 'retry' : 'refused';
}

async function batchUpdateObjects(
  auth: PortalAuth,
  objectType: string,
  inputs: { id: string; properties: Record<string, string> }[],
): Promise<BatchUpdateResponse> {
  if (inputs.length > MAX_STAMPS_PER_BATCH) throw new Error(`batch update takes at most ${MAX_STAMPS_PER_BATCH} inputs`);
  return hsRequest<BatchUpdateResponse>(`/crm/objects/${HUBSPOT_API_VERSION}/${encodeURIComponent(objectType)}/batch/update`, {
    method: 'POST',
    ...auth,
    body: { inputs },
  });
}

/**
 * What happened to one record. The stamp queue decides from `kind` only; `message` is for logs and dead letters.
 *  ok         stamped.
 *  retry      failed for a reason that can fix itself (5xx / network / timeout / token refresh failure / unknown error). Retry with back-off.
 *  throttled  HubSpot 429 or our limiter is full for this portal. Wait retryAfterMs; not a failed attempt.
 *  auth       the portal's token is rejected (401 after one refresh, or revoked). A reinstall can fix it.
 *  refused    HubSpot will not take this record (deleted record, bad value, missing scope, no token). Never retried.
 */
export type StampOutcome =
  | { kind: 'ok' }
  | { kind: 'retry'; message: string }
  | { kind: 'throttled'; retryAfterMs: number; message: string }
  | { kind: 'auth'; message: string }
  | { kind: 'refused'; message: string };
type StampFailureOutcome = Exclude<StampOutcome, { kind: 'ok' }>;
export type StampResult = StampOutcome & { update: StampUpdate };

function outcomeOf(e: unknown, objectTypeId: string): StampFailureOutcome {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof PortalNotInstalledError) return { kind: 'refused', message: `no token: ${message}` };
  if (e instanceof TokenRevokedError) return { kind: 'auth', message };
  // Includes a 4xx from the token endpoint (bad client secret): a misconfiguration must not drop stamps.
  if (e instanceof TokenRefreshError) return { kind: 'retry', message };
  if (!(e instanceof HubSpotError)) return { kind: 'retry', message };
  switch (e.kind) {
    case 'throttled':
      return { kind: 'throttled', retryAfterMs: e.retryAfterMs ?? 0, message };
    case 'transient':
      return { kind: 'retry', message };
    case 'unauthorized':
      return { kind: 'auth', message };
    case 'refused':
      return { kind: 'refused', message: e.status === 403 ? `403 (missing ${scopesFor(objectTypeId).write ?? 'object write'} scope?) ${message}` : message };
  }
}

type Attempt = { res: BatchUpdateResponse } | { err: unknown };

/** One refused (4xx) error the batch can be split on. A 403 (missing scope) refuses every record alike, so it is not. */
const splittable = (e: unknown): e is HubSpotError => e instanceof HubSpotError && e.kind === 'refused' && e.status !== 403;
/**
 * What an error says, minus HubSpot's per-request correlationId (observed live 2026-11-07: every error body carries a new
 * one, so raw messages of two identical failures never match).
 */
const errorShape = (e: HubSpotError) => {
  const b = e.body;
  if (b && typeof b === 'object') {
    const { correlationId: _ignored, ...rest } = b as Record<string, unknown>;
    return JSON.stringify(rest);
  }
  return e.message;
};
const sameError = (a: unknown, b: unknown) =>
  splittable(a) && splittable(b) && a.status === b.status && errorShape(a) === errorShape(b);

/**
 * Send ONE batch (same portal, same object type, at most 100 records) with no spacing logic. One result per record.
 * 429 / 5xx / network are retried inside http.ts first. A 401 refreshes the token once and tries again.
 * Per-record errors in a 2xx response affect only those records (batchErrorKind); a record in neither results nor
 * errors is retried (we never guess which error was its).
 */
async function sendStampBatch(batch: StampUpdate[], deps: StampSendDeps): Promise<StampResult[]> {
  if (batch.length === 0) return [];
  const log = deps.log ?? createLogger('stamp');
  const update = deps.batchUpdate ?? batchUpdateObjects;
  const { portalId, objectTypeId } = batch[0];
  if (batch.some((u) => u.portalId !== portalId || u.objectTypeId !== objectTypeId)) {
    throw new Error('sendStampBatch: one batch must hold one portal and one object type');
  }
  const attempt = async (part: StampUpdate[]): Promise<Attempt> => {
    const inputs = part.map((u) => ({ id: u.objectId, properties: u.properties as Record<string, string> }));
    try {
      return { res: await withPortalToken(deps.tokens, portalId, (auth) => update(auth, objectTypeId, inputs)) };
    } catch (err) {
      return { err };
    }
  };
  const failAll = (part: StampUpdate[], e: unknown): StampResult[] => {
    const o = outcomeOf(e, objectTypeId);
    if (o.kind === 'refused' || o.kind === 'auth')
      log.error('stamp_batch_failed', `portal ${portalId} ${objectTypeId}: ${part.length} stamp(s) ${o.kind}: ${o.message}`, { portalId, n: part.length, kind: o.kind });
    return part.map((u) => ({ update: u, ...o }));
  };
  const read = (part: StampUpdate[], res: BatchUpdateResponse): StampResult[] => {
    const errs = res?.errors ?? [];
    if (errs.length === 0) return part.map((u) => ({ update: u, kind: 'ok' }));
    const okIds = new Set((res.results ?? []).map((r) => String(r.id)));
    let failed = 0;
    let first = '';
    const out = part.map((u): StampResult => {
      if (okIds.has(u.objectId)) return { update: u, kind: 'ok' };
      const err = batchErrorFor(errs, u.objectId);
      const message = err
        ? `${err.status ? `${err.status} ` : ''}${err.category ?? 'ERROR'}: ${err.message ?? ''}`
        : `record not in the batch response (${errs.length} error(s) named other records)`;
      if (failed++ === 0) first = message;
      return { update: u, kind: err ? batchErrorKind(err) : 'retry', message };
    });
    if (failed) log.warn('stamp_records_failed', `portal ${portalId} ${objectTypeId}: ${failed} record(s) not stamped: ${first}`, { portalId, n: failed });
    return out;
  };
  // One bad record may fail the whole request with a 4xx (undocumented, see top). Bisect so only the bad record(s)
  // are refused: about 2k*log2(n) extra calls for k bad records, each through the per-portal rate limiter in
  // http.ts. When BOTH halves fail as a whole with the parent's status+message, the error hits every record
  // (deleted property, unknown object type): refuse them all without splitting further.
  const settle = async (part: StampUpdate[], a: Attempt): Promise<StampResult[]> => {
    if ('res' in a) return read(part, a.res);
    if (part.length < 2 || !splittable(a.err)) return failAll(part, a.err);
    const mid = Math.ceil(part.length / 2);
    const halves = [part.slice(0, mid), part.slice(mid)];
    const tries = [await attempt(halves[0]), await attempt(halves[1])];
    if (tries.every((t) => 'err' in t && sameError(t.err, a.err))) return failAll(part, a.err);
    return [...(await settle(halves[0], tries[0])), ...(await settle(halves[1], tries[1]))];
  };
  return settle(batch, await attempt(batch));
}

// ---------- many records, one call per (portal, objectType, 100 records) ----------

/** Order inside a group is kept. */
function chunkStampUpdates(updates: StampUpdate[], size = MAX_STAMPS_PER_BATCH): StampUpdate[][] {
  const groups = new Map<string, StampUpdate[]>();
  for (const u of updates) {
    const k = `${u.portalId}|${u.objectTypeId}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(u);
  }
  const out: StampUpdate[][] = [];
  for (const g of groups.values()) for (let i = 0; i < g.length; i += size) out.push(g.slice(i, i + size));
  return out;
}

/**
 * Stamp any number of records from any portals: one batch/update call per (portal, objectType, <=100 records).
 * Every update gets a StampResult. Batches for different portals run concurrently (up to `concurrency`); the
 * per-portal rate limiter in http.ts keeps each portal under its own limit, so one throttled portal does not hold
 * up the others.
 */
export async function sendStampBatches(
  updates: StampUpdate[],
  deps: StampSendDeps & { concurrency?: number },
): Promise<StampResult[]> {
  const batches = chunkStampUpdates(updates);
  const results: StampResult[][] = new Array(batches.length);
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const i = next++;
      results[i] = await sendStampBatch(batches[i], deps);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency ?? 4, batches.length)) }, worker));
  return results.flat();
}
