// The worker's journal reader: wraps the 2026-09 journal client (src/hubspot/journal.ts) with the
// rules the always-on worker needs.
//
//  - First start (no stored offset): start from `latest`, NOT `earliest` (we don't replay 3 days of history).
//  - Empty journal: HTTP 204 with an empty body (confirmed 2026-10-30). hsRequest turns
//    that into `undefined`.
//  - HTTP 207 (partial batch): results[] holds the good entries, errors[] the failed offsets
//    (errors[i].context.offset[0]). Docs: journal-entries guide, "Batch journal operations".
//    Offsets are UUIDv7 strings (time-ordered, compared by compareOffsets). We return only the good files that come
//    BEFORE the first failed offset, so the stored offset never jumps over a failed file. The next read
//    starts at the failed one and retries it.
//  - A failed offset that keeps failing for JOURNAL_SKIP_FAILED_AFTER_MS (30 min) is skipped with an error log,
//    so one broken file can't stop every portal forever (journal retention is only ~3 days).
//  - Files are downloaded in parallel (JOURNAL_DOWNLOAD_CONCURRENCY) and returned in offset order.
//    Downloads are allow-listed (HubSpot's S3 journal bucket over https) and size-capped (hubspot/journal.ts).
//  - HTTP 404 on batch-next = our stored offset is no longer in the journal (expired after ~3 days of downtime).
//    We alert "offset_expired", count data_loss{reason="offset_expired"}, and restart from `earliest`.
//    Re-reading is safe: seen_events (kept 4 days) and the stamp:<id> keys stop double stamps. Changes that
//    expired before we got back are lost; the alert says so.
//  - BUT (seen live 2026-11-05): an expired offset can also come back as 204 / EMPTY, not 404, so the worker
//    would read "nothing new" forever. So when a read is empty AND the stored offset's UUIDv7 time is older than
//    JOURNAL_OFFSET_MAX_AGE_MS (48 h, under the ~72 h retention), we call `earliest` + `latest` (at most
//    every 5 min). Offset older than `earliest` = expired: alert, data_loss{reason="offset_expired"}, restart
//    from `earliest`. Not expired but `latest` is newer = unexpected: warn, check again next time.
//    The result is saved in worker_state (journal_offset_check) for /health ("degraded").

import type { JournalReadResult as CoreReadResult } from '../core/poller.js';
import type { JournalFile } from '../core/types.js';
import type { Store } from '../store/db.js';
import type { WorkerStateKey } from '../store/journal-state.js';
import { DownloadRejectedError, downloadJournalFile as fetchJournalText, MAX_BATCH, type JournalBatchResponse, type JournalClient, type JournalFetchResponse } from '../hubspot/journal.js';
import { HubSpotError } from '../lib/http.js';
import { createLogger, type Logger } from '../obs/log.js';
import { compareOffsets, offsetTimeMs } from '../core/journal-offset.js';
import type { ChangeCatchMetrics } from '../obs/metrics.js';

export interface JournalApi {
  latest(): Promise<JournalFetchResponse | null>;
  /** Oldest entry still in the journal. */
  earliest(): Promise<JournalFetchResponse | null>;
  /** Oldest entries still in the journal (recovery after an expired offset). */
  batchEarliest(count: number): Promise<JournalBatchResponse | undefined>;
  /** May resolve to undefined for HTTP 204 (nothing new). */
  batchNext(offset: string, count: number): Promise<JournalBatchResponse | undefined>;
  download(entry: JournalFetchResponse): Promise<JournalFile>;
}

// ---------------------------------------------------------------- journal file download
// Allow-list, size cap and timeout: hubspot/journal.ts downloadJournalFile.

/** Parallel file downloads. Processing order always follows the offset. */
export const JOURNAL_DOWNLOAD_CONCURRENCY = 16;
/** Skip a journal entry that keeps failing (HTTP 207) after this long; counted as data loss. */
export const JOURNAL_SKIP_FAILED_AFTER_MS = 30 * 60 * 1000;
/**
 * An empty read with a stored offset older than this triggers the earliest/latest check; also the age at which
 * /health reports `degraded`. Under the ~72 h retention.
 */
export const JOURNAL_OFFSET_MAX_AGE_MS = 48 * 60 * 60 * 1000;

async function downloadJournalFile(entry: JournalFetchResponse): Promise<JournalFile> {
  if (Date.parse(entry.expiresAt) < Date.now()) throw new Error(`Journal URL already expired at ${entry.expiresAt}; read the offset again.`);
  const text = await fetchJournalText(entry.url);
  const data = JSON.parse(text) as JournalFile;
  if (!data || typeof data !== 'object') throw new Error('Journal file was not a JSON object');
  return data;
}

export function journalApiFor(client: JournalClient): JournalApi {
  return {
    latest: () => client.getLatest(),
    earliest: () => client.getEarliest(),
    batchEarliest: (count) => client.batchEarliest(count),
    batchNext: (offset, count) => client.batchNext(offset, count),
    download: (entry) => downloadJournalFile(entry),
  };
}

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

export interface JournalReaderOptions {
  store: Store;
  now?: () => number;
  /** Default: createLogger('journal'). */
  log?: Logger;
  /** data_loss{reason="offset_expired"|"skipped_entries"} when changes are known to be lost. */
  metrics?: Pick<ChangeCatchMetrics, 'dataLoss'>;
}

// ---------------------------------------------------------------- expired-offset detection (empty reads)

/** At most one earliest/latest check per this many ms; /health trusts a check for twice this long. */
export const OFFSET_CHECK_EVERY_MS = 5 * 60 * 1000;
/** worker_state key: the last earliest/latest check (read by /health). */
export const OFFSET_CHECK_KEY = 'journal_offset_check';

export interface OffsetCheck {
  at: number;
  /** The stored offset that was checked. */
  offset: string;
  earliest: string | null;
  latest: string | null;
  expired: boolean;
}

export function readOffsetCheck(store: Store): OffsetCheck | null {
  const raw = store.journal.getState(OFFSET_CHECK_KEY);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as OffsetCheck;
    return c && typeof c.offset === 'string' && typeof c.at === 'number' ? c : null;
  } catch {
    return null;
  }
}

export class JournalPartialError extends Error {
  constructor(public failedOffsets: string[], detail: string) {
    super(`Journal batch partly failed (HTTP 207), retrying later: ${detail}`);
    this.name = 'JournalPartialError';
  }
}

/**
 * worker_state: the failed journal entry that holds the offset, and since when ({ offset, since }). Only the first
 * failed entry (the barrier) is tracked: the next read starts right before it. Cleared once a read has no failures.
 */
const FAIL_KEY: WorkerStateKey = 'journal_fail';

function readFail(store: Store): { offset: string; since: number } | null {
  try {
    const f = JSON.parse(store.journal.getState(FAIL_KEY) ?? 'null');
    return f && typeof f.offset === 'string' && typeof f.since === 'number' ? f : null;
  } catch {
    return null;
  }
}

export function makeJournalReader(api: JournalApi, opts: JournalReaderOptions): (afterOffset: string | null) => Promise<CoreReadResult> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? createLogger('journal');
  const { store } = opts;
  let lastCheckAt: number | null = null;

  // Download in parallel, but return files in the order of `entries` (sorted by offset), so
  // pairing and the stored offset see exactly the same sequence as a serial read. Any failure fails the read.
  const download = async (entries: JournalFetchResponse[]): Promise<JournalFile[]> => {
    try {
      return await mapConcurrent(entries, JOURNAL_DOWNLOAD_CONCURRENCY, async (r) => {
        const f = await api.download(r);
        if (!f.offset) f.offset = r.currentOffset;
        return f;
      });
    } catch (e) {
      if (e instanceof DownloadRejectedError) log.alert('journal_file_rejected', e.message);
      throw e;
    }
  };

  /** Empty read: returns the earliest batch when the offset turned out to be expired, else undefined. */
  const checkOldOffset = async (afterOffset: string): Promise<JournalBatchResponse | undefined> => {
    const t = now();
    const ot = offsetTimeMs(afterOffset);
    if (ot === null || t - ot < JOURNAL_OFFSET_MAX_AGE_MS) return undefined; // fresh (or not a UUIDv7): no extra calls
    if (lastCheckAt !== null && t - lastCheckAt < OFFSET_CHECK_EVERY_MS) return undefined; // don't loop hot
    lastCheckAt = t;
    const [e, l] = await Promise.all([api.earliest(), api.latest()]);
    const expired = !!e && compareOffsets(afterOffset, e.currentOffset) < 0;
    const check: OffsetCheck = { at: t, offset: afterOffset, earliest: e?.currentOffset ?? null, latest: l?.currentOffset ?? null, expired };
    store.journal.setState(OFFSET_CHECK_KEY, JSON.stringify(check));
    const ageH = Math.round((t - ot) / 3_600_000);
    if (expired) {
      log.alert(
        'offset_expired',
        `journal offset expired; recovered from earliest. Stored offset ${afterOffset} (${ageH} h old) is older than ` +
          `the earliest entry ${e!.currentOffset}, and HubSpot returned an EMPTY read (not 404). Duplicates are skipped; ` +
          `changes between the old offset and earliest may be lost.`,
        { offset: afterOffset },
      );
      store.journal.recordError(`journal offset ${afterOffset} expired (empty read); restarted from earliest`, t);
      opts.metrics?.dataLoss('offset_expired', 1);
      lastCheckAt = null;
      return (await api.batchEarliest(MAX_BATCH)) ?? undefined;
    }
    if (l && compareOffsets(l.currentOffset, afterOffset) > 0)
      log.warn(
        'offset_check_unclear',
        `journal read after offset ${afterOffset} (${ageH} h old) was empty, but latest is newer (${l.currentOffset}) and the ` +
          `offset is not older than earliest. Will check again in ${Math.round(OFFSET_CHECK_EVERY_MS / 60000)} min.`,
      );
    return undefined;
  };

  return async (afterOffset) => {
    if (afterOffset === null) {
      const latest = await api.latest();
      if (!latest) return { files: [], nextOffset: null, full: false };
      log.info('journal_start_latest', `no stored offset: starting from the latest journal entry ${latest.currentOffset}`, { offset: latest.currentOffset });
      const files = await download([latest]);
      return { files, nextOffset: files.at(-1)!.offset, full: false };
    }

    let raw: JournalBatchResponse | undefined;
    let reset = false;
    try {
      raw = await api.batchNext(afterOffset, MAX_BATCH);
    } catch (e) {
      if (!(e instanceof HubSpotError && e.status === 404)) throw e;
      const t = now();
      log.alert(
        'offset_expired',
        `journal offset ${afterOffset} is gone (HTTP 404, older than the ~3 day retention?). Restarting from ` +
          `the EARLIEST entry. Duplicates are skipped; changes that expired while we were behind are lost.`,
        { offset: afterOffset },
      );
      store.journal.recordError(`journal offset ${afterOffset} expired (404); restarted from earliest`, t);
      opts.metrics?.dataLoss('offset_expired', 1);
      reset = true;
      raw = await api.batchEarliest(MAX_BATCH);
    }
    if (!raw || (!(raw.results?.length) && !(raw.errors?.length) && !(raw.numErrors ?? 0))) {
      // 204 / empty: nothing new, OR (seen live) an expired offset. Check only when the offset is old.
      const recovered = reset ? undefined : await checkOldOffset(afterOffset);
      if (!recovered) return { files: [], nextOffset: null, full: false };
      raw = recovered;
    }
    const results = [...(raw.results ?? [])].sort((a, b) => compareOffsets(a.currentOffset, b.currentOffset));
    const errors = raw.errors ?? [];

    if (errors.length === 0 && !(raw.numErrors ?? 0)) {
      const files = await download(results);
      store.journal.deleteState(FAIL_KEY);
      return { files, nextOffset: files.at(-1)?.offset ?? null, full: results.length >= MAX_BATCH };
    }

    // ---- 207: partial failure
    const failed = errors.map((e) => e.context?.offset?.[0]).filter((o): o is string => typeof o === 'string');
    const detail = errors.map((e) => `${e.status}:${e.context?.offset?.[0] ?? '?'}`).join(', ');
    if (failed.length < errors.length || failed.length === 0) {
      // We can't tell which entries failed, so we can't safely move past any of them.
      throw new JournalPartialError(failed, `${detail} (failed offset unknown)`);
    }
    failed.sort(compareOffsets);
    const t = now();
    const prev = readFail(store);
    // Walk failures in offset order; stop at the first one we still want to retry.
    let barrier: string | null = null;
    const skipped: string[] = [];
    for (const o of failed) {
      if (prev?.offset === o && t - prev.since >= JOURNAL_SKIP_FAILED_AFTER_MS) skipped.push(o);
      else {
        barrier = o;
        break;
      }
    }
    if (barrier === null) store.journal.deleteState(FAIL_KEY);
    else if (prev?.offset !== barrier) store.journal.setState(FAIL_KEY, JSON.stringify({ offset: barrier, since: t }));
    if (skipped.length) {
      opts.metrics?.dataLoss('skipped_entries', skipped.length);
      log.alert('journal_entries_skipped', `SKIPPING journal entr${skipped.length === 1 ? 'y' : 'ies'} that failed for over ${Math.round(JOURNAL_SKIP_FAILED_AFTER_MS / 60000)} min: ${skipped.join(', ')}. Changes in them are lost.`);
    }
    const good = barrier === null ? results : results.filter((r) => compareOffsets(r.currentOffset, barrier!) < 0);
    if (good.length === 0) throw new JournalPartialError(failed, detail);
    log.warn('journal_partial', `HTTP 207: processing ${good.length} of ${results.length} entries before the failed one; will retry ${detail}`);
    const files = await download(good);
    // A cut batch means more is waiting: read again soon.
    return { files, nextOffset: files.at(-1)!.offset, full: barrier !== null || results.length + errors.length >= MAX_BATCH };
  };
}
