// Writes ChangeCatch stamps onto customer records with the batch update API, using the customer's OAuth token.
//
// Docs (checked 2026-10-30):
//   POST /crm/objects/2026-09/{objectType}/batch/update  body { inputs: [{ id, properties }] }
//     https://developers.hubspot.com/docs/api-reference/latest/crm/objects/objects/batch/update-objects.md
//   "Object API batch endpoints are limited to 100 inputs per request." objectType may be 0-3 / 2-xxx:
//     https://developers.hubspot.com/docs/api-reference/latest/crm/using-object-apis.md
//   Response: 200 with results[], optional errors[] / numErrors. Whether partial failures come back as 207 for
//   batch UPDATE is not documented (only batch create mentions 207); http.ts treats any 2xx as success, and we
//   read errors[] from the body either way. UNCONFIRMED: shape of errors[].context for a missing record.
// Scopes: crm.objects.{contacts|companies|deals}.write, crm.objects.custom.write for 2-xxx.

import { planStampWaves, recordKey, STAMP_PROPERTY_NAMES, type StampUpdate } from '../core/stamp.js';
import { HttpError, hsRequest } from '../lib/http.js';

const V = '2026-09';
export const MAX_STAMPS_PER_BATCH = 100;

export interface StamperDeps {
  /** Customer OAuth access token for a portal. forceRefresh after a 401. */
  getToken(portalId: number, opts?: { forceRefresh?: boolean }): Promise<string>;
  minSpacingMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to console. Never receives tokens. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Injected for tests. Defaults to the real batch update call. */
  batchUpdate?: (token: string, objectType: string, inputs: { id: string; properties: Record<string, string> }[]) => Promise<BatchUpdateResponse>;
}

export interface BatchUpdateResponse {
  status?: string;
  results?: { id: string }[];
  numErrors?: number;
  errors?: { status?: string; category?: string; message?: string; context?: Record<string, unknown> }[];
}

export interface StampOutcome {
  sent: number;
  /** Records HubSpot refused (deleted record, missing property, missing scope, ...). Logged, not retried. */
  dropped: { update: StampUpdate; reason: string }[];
}

export async function batchUpdateObjects(
  token: string,
  objectType: string,
  inputs: { id: string; properties: Record<string, string> }[],
): Promise<BatchUpdateResponse> {
  if (inputs.length > MAX_STAMPS_PER_BATCH) throw new Error(`batch update takes at most ${MAX_STAMPS_PER_BATCH} inputs`);
  return hsRequest<BatchUpdateResponse>(`/crm/objects/${V}/${encodeURIComponent(objectType)}/batch/update`, {
    method: 'POST',
    token,
    body: { inputs },
  });
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * An error from getToken that will not fix itself by retrying (e.g. the portal uninstalled the app,
 * or we have no refresh token for it). Mark it with `permanent = true` and the batch is dropped, not retried.
 */
export interface PermanentTokenError extends Error {
  permanent: true;
}

export function isPermanentTokenError(e: unknown): e is PermanentTokenError {
  return e instanceof Error && (e as Partial<PermanentTokenError>).permanent === true;
}

export type StampDrop = { update: StampUpdate; reason: string };

/**
 * Send ONE batch (same portal, same object type, at most 100 records) with no spacing logic.
 * Used by Stamper below and by the worker's persisted queue (src/worker/stamp-queue.ts).
 * Error policy:
 *  - 429 / 5xx / network: retried inside http.ts; if still failing, THROWN (caller retries later).
 *  - 401: refresh the token once and retry; if still 4xx, drop (likely uninstalled).
 *  - permanent token error (no token for this portal): drop.
 *  - other 4xx for the whole batch, or per-record errors in a 2xx response: drop those records.
 * Returns the dropped records (empty = all stamped).
 */
export async function sendStampBatch(
  batch: StampUpdate[],
  deps: Pick<StamperDeps, 'getToken' | 'log' | 'batchUpdate'>,
): Promise<StampDrop[]> {
  if (batch.length === 0) return [];
  if (batch.length > MAX_STAMPS_PER_BATCH) throw new Error(`sendStampBatch takes at most ${MAX_STAMPS_PER_BATCH} records`);
  const log = deps.log ?? ((level, msg) => console[level](`[stamp] ${msg}`));
  const update = deps.batchUpdate ?? batchUpdateObjects;
  const { portalId, objectTypeId } = batch[0];
  if (batch.some((u) => u.portalId !== portalId || u.objectTypeId !== objectTypeId)) {
    throw new Error('sendStampBatch: one batch must hold one portal and one object type');
  }
  // Only the 7 current properties. Any other key on a queued row (e.g. an old changecatch_last_change_at /
  // changecatch_changes_since_last_stamp) is not sent.
  const inputs = batch.map((u) => ({ id: u.objectId, properties: pickStampProperties(u.properties) }));
  const dropAll = (reason: string) => {
    log('error', `portal ${portalId} ${objectTypeId}: dropped ${batch.length} stamp(s): ${reason}`);
    return batch.map((u) => ({ update: u, reason }));
  };
  const token = async (forceRefresh: boolean) => deps.getToken(portalId, forceRefresh ? { forceRefresh } : undefined);

  let res: BatchUpdateResponse;
  try {
    res = await update(await token(false), objectTypeId, inputs);
  } catch (e) {
    if (isPermanentTokenError(e)) return dropAll(`no token: ${e.message}`);
    if (!(e instanceof HttpError)) throw e;
    if (e.status === 401) {
      try {
        res = await update(await token(true), objectTypeId, inputs);
      } catch (e2) {
        if (isPermanentTokenError(e2)) return dropAll(`no token: ${e2.message}`);
        if (e2 instanceof HttpError && e2.status >= 400 && e2.status < 500 && e2.status !== 429) return dropAll(e2.message);
        throw e2;
      }
    } else if (e.status >= 400 && e.status < 500 && e.status !== 429) {
      return dropAll(e.status === 403 ? `403 (missing ${objectTypeId.startsWith('2-') ? 'crm.objects.custom.write' : 'object write'} scope?) ${e.message}` : e.message);
    } else {
      throw e;
    }
  }

  // Per-record errors in a 2xx response. Map them back to records by any id we can find in the error context.
  const errs = res?.errors ?? [];
  if (errs.length === 0) return [];
  const okIds = new Set((res.results ?? []).map((r) => String(r.id)));
  const dropped: StampDrop[] = [];
  for (const u of batch) {
    if (okIds.has(u.objectId)) continue;
    const err = errs.find((er) => JSON.stringify(er.context ?? {}).includes(`"${u.objectId}"`)) ?? errs[0];
    dropped.push({ update: u, reason: `${err.category ?? 'ERROR'}: ${err.message ?? ''}` });
  }
  if (dropped.length) log('warn', `portal ${portalId} ${objectTypeId}: ${dropped.length} record(s) not stamped: ${dropped[0].reason}`);
  return dropped;
}

// ---------- many records, one call per (portal, objectType, 100 records) ----------

export type StampResult =
  | { update: StampUpdate; ok: true }
  /**
   * retryable = true: the whole batch failed for a reason that can fix itself (429 / 5xx / network / timeout).
   * Re-queue ONLY these. retryAfterMs is set when HubSpot (or our limiter) said how long to wait.
   * retryable = false: HubSpot refused this record (deleted record, bad value, missing scope, uninstalled). Drop.
   */
  | { update: StampUpdate; ok: false; retryable: boolean; reason: string; retryAfterMs?: number };

/** Group by portal + object type and chunk to MAX_STAMPS_PER_BATCH (100). Order inside a group is kept. */
export function chunkStampUpdates(updates: StampUpdate[], size = MAX_STAMPS_PER_BATCH): StampUpdate[][] {
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
 * Never throws for HubSpot errors: every update gets a StampResult, so the caller retries only the failed ones.
 * Batches for different portals run concurrently (up to `concurrency`); the per-portal rate limiter in http.ts
 * keeps each portal under its own limit, so one throttled portal does not hold up the others.
 * Per-record errors in a 2xx/207 response are mapped to records (see sendStampBatch).
 */
export async function sendStampBatches(
  updates: StampUpdate[],
  deps: Pick<StamperDeps, 'getToken' | 'log' | 'batchUpdate'> & { concurrency?: number },
): Promise<StampResult[]> {
  const batches = chunkStampUpdates(updates);
  const results: StampResult[][] = new Array(batches.length);
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const i = next++;
      const batch = batches[i];
      try {
        const drops = await sendStampBatch(batch, deps);
        const byUpdate = new Map(drops.map((d) => [d.update, d.reason]));
        results[i] = batch.map((u) =>
          byUpdate.has(u) ? { update: u, ok: false, retryable: false, reason: byUpdate.get(u)! } : { update: u, ok: true },
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        const retryAfterMs = (e as { retryAfterMs?: number })?.retryAfterMs;
        results[i] = batch.map((u) => ({ update: u, ok: false, retryable: true, reason, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency ?? 4, batches.length)) }, worker));
  return results.flat();
}

/**
 * Sends stamps with per-record spacing. Keeps the last stamp time per record in memory, across calls.
 * One-shot helper. The always-on worker uses the persisted queue in src/worker/stamp-queue.ts instead
 * (spacing survives restarts there). Error policy: see sendStampBatch. In short
 * (so one broken portal can't block the shared journal for everyone):
 *  - 429 / 5xx: retried inside http.ts; if still failing, the error is THROWN (the poller keeps its offset and retries).
 *  - 401: refresh the token once and retry; if still 401, drop (likely uninstalled).
 *  - other 4xx for a whole batch, or per-record errors in the response: drop + log. The change stays in change_log.
 */
export class Stamper {
  private last = new Map<string, number>();
  private readonly spacing: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: NonNullable<StamperDeps['log']>;
  private readonly update: NonNullable<StamperDeps['batchUpdate']>;

  constructor(private deps: StamperDeps) {
    this.spacing = deps.minSpacingMs ?? 3_000;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? sleepReal;
    this.log = deps.log ?? ((level, msg) => console[level](`[stamp] ${msg}`));
    this.update = deps.batchUpdate ?? batchUpdateObjects;
  }

  lastStampAt(key: string): number | undefined {
    return this.last.get(key);
  }

  /**
   * Stamp all updates. `onDelivered` is called after each accepted batch (with sent and dropped updates),
   * so the caller can mark them done before a later batch fails.
   */
  async send(updates: StampUpdate[], onDelivered?: (done: StampUpdate[]) => void): Promise<StampOutcome> {
    const outcome: StampOutcome = { sent: 0, dropped: [] };
    const waves = planStampWaves(updates, (k) => this.last.get(k), this.now(), this.spacing);
    for (const wave of waves) {
      const wait = wave.notBefore - this.now();
      if (wait > 0) await this.sleep(wait);
      // Group by portal (token) and object type (endpoint), then chunk to 100.
      const groups = new Map<string, StampUpdate[]>();
      for (const u of wave.updates) {
        const k = `${u.portalId}|${u.objectTypeId}`;
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(u);
      }
      for (const group of groups.values()) {
        for (let i = 0; i < group.length; i += MAX_STAMPS_PER_BATCH) {
          const batch = group.slice(i, i + MAX_STAMPS_PER_BATCH);
          const dropped = await this.sendBatch(batch);
          const stampedAt = this.now();
          for (const u of batch) this.last.set(recordKey(u), stampedAt);
          outcome.sent += batch.length - dropped.length;
          outcome.dropped.push(...dropped);
          onDelivered?.(batch);
        }
      }
    }
    return outcome;
  }

  private sendBatch(batch: StampUpdate[]): Promise<StampDrop[]> {
    return sendStampBatch(batch, { getToken: this.deps.getToken, log: this.log, batchUpdate: this.update });
  }
}

/** Keeps only the current stamp properties (STAMP_PROPERTY_NAMES). */
export function pickStampProperties(props: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of STAMP_PROPERTY_NAMES) if (props[k] !== undefined) out[k] = props[k];
  return out;
}
