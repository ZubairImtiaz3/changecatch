import type { AssociationEntry, JournalAssociationEntry, JournalFile } from './types.js';
import { isAssociationEvent } from './types.js';

/**
 * Stable identity for one journal association event.
 * Journal events have no id of their own, so we combine the file offset with the event fields.
 */
export function entryKey(fileOffset: string, e: JournalAssociationEntry): string {
  return [
    fileOffset,
    e.portalId,
    `${e.fromObjectTypeId}:${e.fromObjectId}`,
    `${e.toObjectTypeId}:${e.toObjectId}`,
    e.associationTypeId,
    e.action,
    e.occurredAt,
  ].join('|');
}

/** Pull association events out of journal files, in file order. Other event types are skipped. */
export function toAssociationEntries(files: JournalFile[]): AssociationEntry[] {
  const out: AssociationEntry[] = [];
  for (const f of files) {
    for (const ev of f.journalEvents ?? []) {
      if (!isAssociationEvent(ev)) continue;
      out.push({ event: ev, fileOffset: f.offset, key: entryKey(f.offset, ev), occurredAtMs: Date.parse(ev.occurredAt) });
    }
  }
  return out;
}

export interface SeenStore {
  filterSeen(keys: string[]): Set<string>;
}

/** Drop entries already processed (per store) and duplicates inside the same batch. */
export function dedupeEntries(entries: AssociationEntry[], store: SeenStore): AssociationEntry[] {
  const seen = store.filterSeen(entries.map((e) => e.key));
  const inBatch = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.key) || inBatch.has(e.key)) return false;
    inBatch.add(e.key);
    return true;
  });
}
