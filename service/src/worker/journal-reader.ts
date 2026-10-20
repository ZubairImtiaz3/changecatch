// The worker's journal reader: wraps the 2026-09 journal client (src/hubspot/journal.ts) with the
// rules the always-on worker needs.
//
//  - First start (no stored offset): start from `latest`, NOT `earliest` (we don't replay 3 days of history).
//  - Empty journal: HTTP 204 with an empty body (confirmed 2026-10-30). hsRequest turns
//    that into `undefined`.
//  - HTTP 207 (partial batch): results[] holds the good entries, errors[] the failed offsets
//    (errors[i].context.offset[0]). Docs: journal-entries guide, "Batch journal operations".
//    Offsets are UUIDv7 strings (time-ordered, compare as strings). We return only the good files that come
//    BEFORE the first failed offset, so the stored offset never jumps over a failed file. The next read
//    starts at the failed one and retries it.
//  - A failed offset that keeps failing for skipAfterMs (default 30 min) is skipped with an error log,
//    so one broken file can't stop every portal forever (journal retention is only ~3 days).
//  - Files are downloaded in parallel (JOURNAL_DOWNLOAD_CONCURRENCY, default 16) and returned in offset order.
//    Downloads are allow-listed (HubSpot's S3 journal bucket over https) and size-capped (JOURNAL_MAX_FILE_BYTES).
//  - HTTP 404 on batch-next = our stored offset is no longer in the journal (expired after ~3 days of downtime).
//    We log an [ALERT], remember it in worker_state (journal_offset_reset), and restart from `earliest`.
//    Re-reading is safe: seen_events (kept 4 days) and the stamp:<id> keys stop double stamps. Changes that
//    expired before we got back are lost; the alert says so.

import type { JournalReadResult as CoreReadResult } from '../core/poller.js';
import type { JournalFile } from '../core/types.js';
import type { Store } from '../store/db.js';
import {
  batchEarliest as realBatchEarliest,
  batchNext as realBatchNext,
  getLatest as realGetLatest,
  MAX_BATCH,
  type JournalBatchResponse,
  type JournalFetchResponse,
} from '../hubspot/journal.js';
import { HttpError } from '../lib/http.js';
import { createLogger } from '../obs/log.js';
import type { ChangeCatchMetrics } from '../obs/metrics.js';
import { legacyLog } from '../obs/wiring.js';

export interface JournalApi {
  latest(): Promise<JournalFetchResponse | null>;
  /** Oldest entries still in the journal (recovery after an expired offset). */
  batchEarliest(count: number): Promise<JournalBatchResponse | undefined>;
  /** May resolve to undefined for HTTP 204 (nothing new). */
  batchNext(offset: string, count: number): Promise<JournalBatchResponse | undefined>;
  download(entry: JournalFetchResponse): Promise<JournalFile>;
}

// ---------------------------------------------------------------- secure journal file download (security review)
// The presigned URL comes from HubSpot's API, but we still only fetch it if it is HubSpot's journal bucket on S3:
// https, host *.amazonaws.com starting with "hubspot-webhooks-journal" (seen live: hubspot-webhooks-journal-na1.s3.amazonaws.com).
// The body is capped at JOURNAL_MAX_FILE_BYTES (default 20 MB). Anything else is rejected with an [ALERT] and the
// offset is held (we never skip past a file we did not read). Presigned S3 URLs are NOT rate limited by HubSpot.

export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;

export class JournalFileRejectedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'JournalFileRejectedError';
  }
}

/** Throws JournalFileRejectedError unless the URL is HubSpot's journal bucket on S3 over https. */
export function assertJournalFileUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new JournalFileRejectedError('[ALERT] journal file URL is not a valid URL; refusing to download');
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || !host.endsWith('.amazonaws.com') || !host.startsWith('hubspot-webhooks-journal') || u.username || u.password) {
    throw new JournalFileRejectedError(`[ALERT] journal file URL host "${host}" (${u.protocol}) is not HubSpot's journal bucket; refusing to download`);
  }
  return u;
}

function envNum(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Download one journal file: allow-listed host, size cap, timeout, a few retries on network/5xx. */
export async function secureDownloadJournalFile(
  entry: JournalFetchResponse,
  opts: { maxBytes?: number; timeoutMs?: number; retries?: number; fetchImpl?: typeof fetch } = {},
): Promise<JournalFile> {
  const url = assertJournalFileUrl(entry.url);
  if (Date.parse(entry.expiresAt) < Date.now()) throw new Error(`Journal URL already expired at ${entry.expiresAt}; read the offset again.`);
  const maxBytes = opts.maxBytes ?? envNum('JOURNAL_MAX_FILE_BYTES', DEFAULT_MAX_FILE_BYTES);
  const timeoutMs = opts.timeoutMs ?? envNum('JOURNAL_DOWNLOAD_TIMEOUT_MS', 15_000);
  const retries = opts.retries ?? 3;
  const f = opts.fetchImpl ?? fetch;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await f(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) throw Object.assign(new Error(`journal file download -> ${res.status}`), { retry: true });
        throw new Error(`journal file download failed with ${res.status}`);
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes)
        throw new JournalFileRejectedError(`[ALERT] journal file is ${declared} bytes, over the ${maxBytes} byte cap (JOURNAL_MAX_FILE_BYTES)`);
      const text = await readCapped(res, maxBytes);
      const data = JSON.parse(text) as JournalFile;
      if (!data || typeof data !== 'object') throw new Error('Journal file was not a JSON object');
      return data;
    } catch (e) {
      const err = e as Error & { retry?: boolean };
      const transient = err.retry || err.name === 'TimeoutError' || err.name === 'AbortError' || err instanceof TypeError;
      if (err instanceof JournalFileRejectedError || !transient || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, Math.min(5_000, 250 * 2 ** attempt)));
    }
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new JournalFileRejectedError(`[ALERT] journal file is over the ${maxBytes} byte cap (JOURNAL_MAX_FILE_BYTES)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export const realJournalApi: JournalApi = {
  latest: () => realGetLatest(),
  batchEarliest: (count) => realBatchEarliest(count),
  batchNext: (offset, count) => realBatchNext(offset, count),
  download: (entry) => secureDownloadJournalFile(entry),
};

/** Map with at most `limit` in flight; results keep the INPUT order. */
export async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export const DEFAULT_DOWNLOAD_CONCURRENCY = 16;

export interface JournalReaderOptions {
  store: Store;
  batchSize?: number;
  /** Skip a journal entry that has failed for this long (ms). Default 30 min. */
  skipAfterMs?: number;
  /** Parallel file downloads (JOURNAL_DOWNLOAD_CONCURRENCY). Default 16. Order by offset is always kept. */
  downloadConcurrency?: number;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** data_loss{reason="journal_gap"|"skipped_entries"} when changes are known to be lost. */
  metrics?: Pick<ChangeCatchMetrics, 'dataLoss'>;
}

export class JournalPartialError extends Error {
  constructor(public failedOffsets: string[], detail: string) {
    super(`Journal batch partly failed (HTTP 207), retrying later: ${detail}`);
    this.name = 'JournalPartialError';
  }
}

const FAIL_KEY = (offset: string) => `journal_fail:${offset}`;

export function makeJournalReader(api: JournalApi, opts: JournalReaderOptions): (afterOffset: string | null) => Promise<CoreReadResult> {
  const n = Math.max(1, Math.min(MAX_BATCH, opts.batchSize ?? MAX_BATCH));
  const skipAfterMs = opts.skipAfterMs ?? 30 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? legacyLog(createLogger('journal'));
  const { store } = opts;

  const concurrency = Math.max(1, opts.downloadConcurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY);
  // scale-review C3: download in parallel, but return files in the order of `entries` (sorted by offset), so
  // pairing and the stored offset see exactly the same sequence as a serial read. Any failure fails the read.
  const download = async (entries: JournalFetchResponse[]): Promise<JournalFile[]> => {
    try {
      return await mapConcurrent(entries, concurrency, async (r) => {
        const f = await api.download(r);
        if (!f.offset) f.offset = r.currentOffset;
        return f;
      });
    } catch (e) {
      if (e instanceof JournalFileRejectedError) log('error', e.message);
      throw e;
    }
  };

  return async (afterOffset) => {
    if (afterOffset === null) {
      const latest = await api.latest();
      if (!latest) return { files: [], nextOffset: null, full: false };
      log('info', `no stored offset: starting from the latest journal entry ${latest.currentOffset}`);
      const files = await download([latest]);
      return { files, nextOffset: files.at(-1)!.offset, full: false };
    }

    let raw: JournalBatchResponse | undefined;
    try {
      raw = await api.batchNext(afterOffset, n);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) throw e;
      const t = now();
      log(
        'error',
        `[ALERT] journal offset ${afterOffset} is gone (HTTP 404, older than the ~3 day retention?). Restarting from ` +
          `the EARLIEST entry. Duplicates are skipped; changes that expired while we were behind are lost.`,
      );
      store.setState('journal_offset_reset', JSON.stringify({ from: afterOffset, at: t }));
      store.recordError(`journal offset ${afterOffset} expired (404); restarted from earliest`, t);
      opts.metrics?.dataLoss('journal_gap', 1);
      raw = await api.batchEarliest(n);
    }
    if (!raw) return { files: [], nextOffset: null, full: false }; // 204: nothing new
    const results = [...(raw.results ?? [])].sort((a, b) => (a.currentOffset < b.currentOffset ? -1 : a.currentOffset > b.currentOffset ? 1 : 0));
    const errors = raw.errors ?? [];

    if (errors.length === 0 && !(raw.numErrors ?? 0)) {
      const files = await download(results);
      return { files, nextOffset: files.at(-1)?.offset ?? null, full: results.length >= n };
    }

    // ---- 207: partial failure
    const failed = errors.map((e) => e.context?.offset?.[0]).filter((o): o is string => typeof o === 'string');
    const detail = errors.map((e) => `${e.status}:${e.context?.offset?.[0] ?? '?'}`).join(', ');
    if (failed.length < errors.length || failed.length === 0) {
      // We can't tell which entries failed, so we can't safely move past any of them.
      throw new JournalPartialError(failed, `${detail} (failed offset unknown)`);
    }
    failed.sort();
    const t = now();
    const expired = (o: string) => {
      const k = FAIL_KEY(o);
      const first = Number(store.getState(k) ?? NaN);
      if (!Number.isFinite(first)) {
        store.setState(k, String(t));
        return false;
      }
      return t - first >= skipAfterMs;
    };
    // Walk failures in offset order; stop at the first one we still want to retry.
    let barrier: string | null = null;
    const skipped: string[] = [];
    for (const o of failed) {
      if (expired(o)) skipped.push(o);
      else {
        barrier = o;
        break;
      }
    }
    if (skipped.length) {
      opts.metrics?.dataLoss('skipped_entries', skipped.length);
      log('error', `[ALERT] SKIPPING journal entr${skipped.length === 1 ? 'y' : 'ies'} that failed for over ${Math.round(skipAfterMs / 60000)} min: ${skipped.join(', ')}. Changes in them are lost.`);
      for (const o of skipped) store.deleteState(FAIL_KEY(o));
    }
    const good = barrier === null ? results : results.filter((r) => r.currentOffset < barrier!);
    if (good.length === 0) throw new JournalPartialError(failed, detail);
    log('warn', `HTTP 207: processing ${good.length} of ${results.length} entries before the failed one; will retry ${detail}`);
    const files = await download(good);
    // A cut batch means more is waiting: read again soon.
    return { files, nextOffset: files.at(-1)!.offset, full: barrier !== null || results.length + errors.length >= n };
  };
}
