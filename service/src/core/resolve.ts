import type { LabelCache } from './labels.js';
import { pairKey } from './pairing.js';
import type { LabelRef, NormalizedChange, PairedChange } from './types.js';

export interface ResolveConfig {
  /** Name used for a type with no label (the structural default link), only relevant in 'label' mode. */
  unlabeledName: string;
}

export const DEFAULT_RESOLVE_CONFIG: ResolveConfig = { unlabeledName: 'Unlabeled' };

export interface LabelStateReader {
  getAssociationLabels(pairKey: string): string[] | undefined;
}

export interface ResolveResult {
  changes: NormalizedChange[];
  /** pairKey -> new label set, or null to forget the pair. Persist only after events are sent. */
  stateUpdates: Map<string, string[] | null>;
}

export const uniqSorted = (xs: string[]) => [...new Set(xs)].sort();

/** Label names of a paired change's removed / added type ids (sorted, unique). */
export async function labelNamesOf(
  p: Pick<PairedChange, 'portalId' | 'removed' | 'added'>,
  labels: LabelCache,
  config: ResolveConfig = DEFAULT_RESOLVE_CONFIG,
): Promise<{ removed: string[]; added: string[] }> {
  const nameOf = async (r: LabelRef): Promise<string> => {
    const hit = await labels.get(p.portalId, r.fromObjectTypeId, r.toObjectTypeId, r.associationTypeId);
    if (!hit) return `type ${r.associationTypeId}`;
    return hit.label ?? config.unlabeledName;
  };
  return {
    removed: uniqSorted(await Promise.all(p.removed.map(nameOf))),
    added: uniqSorted(await Promise.all(p.added.map(nameOf))),
  };
}

/*
 * labelBefore / labelAfter are FULL label sets when we know the pair's labels (learned from earlier
 * events since install). When we don't, they fall back to just the removed / added labels.
 * We only learn a pair's full set from a brand-new link (ADDED); label-only edits on a pair we have
 * never seen leave it unknown. A later version could seed state from a CRM read.
 */
export async function resolveChanges(
  paired: PairedChange[],
  labels: LabelCache,
  state: LabelStateReader,
  config: ResolveConfig = DEFAULT_RESOLVE_CONFIG,
  /** State changes already decided earlier in this run (late-half absorption); they win over the store. */
  initialStateUpdates?: Map<string, string[] | null>,
): Promise<ResolveResult> {
  const stateUpdates = new Map<string, string[] | null>(initialStateUpdates ?? []);
  const known = (k: string): string[] | undefined => {
    if (stateUpdates.has(k)) return stateUpdates.get(k) ?? undefined;
    return state.getAssociationLabels(k);
  };

  const changes: NormalizedChange[] = [];
  for (const p of paired) {
    const { removed, added } = await labelNamesOf(p, labels, config);
    const k = pairKey(p.portalId, p.fromObjectTypeId, p.fromObjectId, p.toObjectTypeId, p.toObjectId);
    const prev = known(k);

    let labelBefore: string[] | undefined;
    let labelAfter: string[] | undefined;
    let labelsCurrent: string[] | undefined;

    if (p.changeType === 'ADDED') {
      labelAfter = added;
      labelsCurrent = added;
      stateUpdates.set(k, added);
    } else if (p.changeType === 'REMOVED') {
      labelBefore = prev ?? removed;
      labelsCurrent = [];
      stateUpdates.set(k, null);
    } else if (prev) {
      labelBefore = prev;
      labelAfter = uniqSorted([...prev.filter((l) => !removed.includes(l)), ...added]);
      labelsCurrent = labelAfter;
      stateUpdates.set(k, labelAfter);
    } else {
      labelBefore = removed.length ? removed : undefined;
      labelAfter = added.length ? added : undefined;
    }

    changes.push({
      portalId: p.portalId,
      changeType: p.changeType,
      fromObjectTypeId: p.fromObjectTypeId,
      fromObjectId: p.fromObjectId,
      toObjectTypeId: p.toObjectTypeId,
      toObjectId: p.toObjectId,
      labelBefore,
      labelAfter,
      labelsCurrent,
      removedLabels: removed,
      addedLabels: added,
      associationCategory: p.associationCategory,
      occurredAt: p.occurredAt,
      sourceOffsets: p.sourceOffsets,
      sourceKeys: p.sourceKeys,
    });
  }
  return { changes, stateUpdates };
}
