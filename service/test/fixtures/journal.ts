// Journal fixtures: events, files, UUIDv7 offsets, a fake reader (RunDeps.readJournal) and a fake JournalApi.
import { entryKey } from '../../src/core/dedupe.js';
import type { JournalReadResult } from '../../src/core/poller.js';
import type { AssociationAction, AssociationEntry, JournalAssociationEntry, JournalFile } from '../../src/core/types.js';
import type { JournalBatchResponse, JournalFetchResponse } from '../../src/hubspot/journal.js';
import type { JournalApi } from '../../src/worker/journal-reader.js';

export const T0 = Date.parse('2026-10-30T10:00:00.000Z');
export const DEAL = '0-3';
export const CONTACT = '0-1';
export const SUB = '2-134027637';
export const ADD = 'ASSOCIATION_ADDED' as const;
export const REM = 'ASSOCIATION_REMOVED' as const;
export const UD = 'USER_DEFINED';
export const HD = 'HUBSPOT_DEFINED';

export interface EvOpts {
  action?: AssociationAction;
  portalId?: number;
  from?: [string, number];
  to?: [string, number];
  typeId?: number;
  category?: string;
  at?: number; // ms offset from T0
}

export function ev(o: EvOpts = {}): JournalAssociationEntry {
  return {
    type: 'association',
    portalId: o.portalId ?? 111,
    occurredAt: new Date(T0 + (o.at ?? 0)).toISOString(),
    action: o.action ?? ADD,
    fromObjectTypeId: (o.from ?? [DEAL, 1])[0],
    fromObjectId: (o.from ?? [DEAL, 1])[1],
    toObjectTypeId: (o.to ?? [CONTACT, 2])[0],
    toObjectId: (o.to ?? [CONTACT, 2])[1],
    associationTypeId: o.typeId ?? 3,
    associationCategory: o.category ?? HD,
    isPrimary: false,
  };
}

let n = 0;
export function entry(o: EvOpts = {}, fileOffset = `file-${String(++n).padStart(6, '0')}`): AssociationEntry {
  const e = ev(o);
  return { event: e, fileOffset, key: entryKey(fileOffset, e), occurredAtMs: Date.parse(e.occurredAt) };
}

export function file(offset: string, events: JournalAssociationEntry[]): JournalFile {
  return { offset, journalEvents: events, publishedAt: new Date(T0).toISOString() };
}

let seq = 0;
/** UUIDv7-shaped journal offset whose first 48 bits are `ms` (pairing reads the publish time from it). */
export function uuid7(ms: number, n = ++seq): string {
  const h = ms.toString(16).padStart(12, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** RunDeps.readJournal over fixed files: everything after the given offset, at most `limit` files per read. */
export function fakeJournal(files: JournalFile[], limit = Infinity) {
  const reads: (string | null)[] = [];
  const readJournal = async (after: string | null): Promise<JournalReadResult> => {
    reads.push(after);
    const start = after === null ? 0 : files.findIndex((f) => f.offset === after) + 1;
    const batch = files.slice(start, start + limit);
    return { files: batch, nextOffset: batch.at(-1)?.offset ?? null, full: batch.length === limit };
  };
  return { readJournal, reads, files };
}

/** A journal file and the time HubSpot published it (its UUIDv7 offset time). */
export interface TimedFile {
  pub: number;
  file: JournalFile;
}

/** RunDeps.readJournal with HubSpot's timing: a file becomes readable `visibleDelayMs` after it was published. */
export function timedJournal(files: TimedFile[], now: () => number, visibleDelayMs: number) {
  let next = 0;
  return async (): Promise<JournalReadResult> => {
    const out: JournalFile[] = [];
    while (next < files.length && files[next].pub + visibleDelayMs <= now()) out.push(files[next++].file);
    return { files: out, nextOffset: out.at(-1)?.offset ?? null, full: false };
  };
}

// ---------------------------------------------------------------- JournalApi (makeJournalReader input)

export const fetchEntry = (offset: string, expiresAt = '2999-01-01T00:00:00Z'): JournalFetchResponse => ({
  url: `https://hubspot-webhooks-journal-na1.s3.amazonaws.com/${offset}`,
  expiresAt,
  currentOffset: offset,
});

/** A batch read: `ok` offsets as results, `failed` offsets as PRESIGNING_ERRORs (HTTP 207). */
export const batchOf = (ok: string[], failed: string[] = []): JournalBatchResponse => ({
  status: 'COMPLETE',
  startedAt: '',
  completedAt: '',
  results: ok.map((o) => fetchEntry(o)),
  numErrors: failed.length,
  errors: failed.map((o) => ({ status: 'PRESIGNING_ERROR', message: 'x', context: { offset: [o] } })),
});

/**
 * A JournalApi: batchNext/batchEarliest return the queued `batches` in order (undefined = 204), latest/earliest the
 * given entries, download an empty file. `calls` logs every call ('latest', 'earliest', 'batchEarliest',
 * 'next:<offset>'). `over` replaces methods.
 */
export function fakeJournalApi(
  o: { batches?: (JournalBatchResponse | undefined)[]; latest?: JournalFetchResponse | null; earliest?: JournalFetchResponse | null } = {},
  over: Partial<JournalApi> = {},
): JournalApi & { calls: string[] } {
  const calls: string[] = [];
  const batches = [...(o.batches ?? [])];
  return {
    calls,
    latest: async () => (calls.push('latest'), o.latest ?? null),
    earliest: async () => (calls.push('earliest'), o.earliest ?? null),
    batchEarliest: async () => (calls.push('batchEarliest'), batches.shift()),
    batchNext: async (off) => (calls.push(`next:${off}`), batches.shift()),
    download: async (e) => ({ offset: e.currentOffset, journalEvents: [] }),
    ...over,
  };
}
