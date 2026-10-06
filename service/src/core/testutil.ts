// Helpers shared by tests only.
import { entryKey } from './dedupe.js';
import type { AssociationAction, AssociationEntry, JournalAssociationEntry, JournalFile } from './types.js';

export const T0 = Date.parse('2026-10-30T10:00:00.000Z');
export const DEAL = '0-3';
export const CONTACT = '0-1';
export const SUB = '2-134027637';

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
    action: o.action ?? 'ASSOCIATION_ADDED',
    fromObjectTypeId: (o.from ?? [DEAL, 1])[0],
    fromObjectId: (o.from ?? [DEAL, 1])[1],
    toObjectTypeId: (o.to ?? [CONTACT, 2])[0],
    toObjectId: (o.to ?? [CONTACT, 2])[1],
    associationTypeId: o.typeId ?? 3,
    associationCategory: o.category ?? 'HUBSPOT_DEFINED',
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

export const ADD = 'ASSOCIATION_ADDED' as const;
export const REM = 'ASSOCIATION_REMOVED' as const;
export const UD = 'USER_DEFINED';
