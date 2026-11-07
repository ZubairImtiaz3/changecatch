// Association label fixtures and a LabelCache over fixed definitions.
import type { LabelCache } from '../../src/core/labels.js';
import { normLabelName } from '../../src/core/label-options.js';
import type { LabelDefinition, PairedChange } from '../../src/core/types.js';
import { CONTACT, DEAL, HD, T0, UD } from './journal.js';

/** Synthetic Deal->Contact labels: 3 = unlabeled default, 101 Influencer, 102 Decision maker. */
export const LABELS: LabelDefinition[] = [
  { associationTypeId: 3, label: null, category: HD },
  { associationTypeId: 101, label: 'Influencer', category: UD },
  { associationTypeId: 102, label: 'Decision maker', category: UD },
];

// Real Deal->Contact association types from the HubSpot test portal (2026-10-30 load tests).
// 3 = unlabeled default (HUBSPOT_DEFINED); 247/249/251 = custom labels (USER_DEFINED).
export const DEAL_CONTACT_LABELS: LabelDefinition[] = [
  { associationTypeId: 3, label: null, category: HD },
  { associationTypeId: 247, label: 'Decision maker', category: UD },
  { associationTypeId: 249, label: 'Influencer', category: UD },
  { associationTypeId: 251, label: 'Billing contact', category: UD },
];

/** Label definitions per direction, keyed `${from}>${to}`. */
export type Defs = Record<string, { typeId: number; label: string | null; category: string }[]>;

/** A LabelCache answering from `defs` (no store, no HubSpot). */
export function defsLabelCache(defs: Defs): LabelCache {
  return {
    async get(_p, from, to, typeId) {
      const d = defs[`${from}>${to}`]?.find((x) => x.typeId === typeId);
      return d && { label: d.label, category: d.category };
    },
    async findByName(_p, from, to, label) {
      const hits = (defs[`${from}>${to}`] ?? []).filter((x) => x.label !== null && normLabelName(x.label) === normLabelName(label));
      return hits.length === 1 ? hits[0].typeId : undefined;
    },
  };
}

/** A LabelCache answering every object pair direction from the same `defs` (no store, no HubSpot). */
export function fixedLabelCache(defs: LabelDefinition[]): LabelCache {
  return {
    async get(_p, _from, _to, typeId) {
      const d = defs.find((x) => x.associationTypeId === typeId);
      return d && { label: d.label, category: d.category };
    },
    async findByName(_p, _from, _to, label) {
      const hits = defs.filter((x) => x.label !== null && normLabelName(x.label) === normLabelName(label));
      return hits.length === 1 ? hits[0].associationTypeId : undefined;
    },
  };
}

/** A paired change on portal 111 between two records (default Deal 1 -> Contact 2). */
export function pairedChange(
  changeType: PairedChange['changeType'],
  added: number[],
  removed: number[] = [],
  from: [string, string] = [DEAL, '1'],
  to: [string, string] = [CONTACT, '2'],
): PairedChange {
  const ref = (associationTypeId: number) => ({ fromObjectTypeId: from[0], toObjectTypeId: to[0], associationTypeId, associationCategory: UD });
  return {
    portalId: 111, changeType, fromObjectTypeId: from[0], fromObjectId: from[1], toObjectTypeId: to[0], toObjectId: to[1],
    added: added.map(ref), removed: removed.map(ref), associationCategory: UD,
    occurredAt: new Date(T0).toISOString(), sourceKeys: [`k${from[1]}${changeType}${added}${removed}`], sourceOffsets: ['f'],
    structuralNet: changeType === 'ADDED' ? 1 : changeType === 'REMOVED' ? -1 : 0,
  };
}
