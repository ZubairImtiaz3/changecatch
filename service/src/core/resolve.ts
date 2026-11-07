// Label KEYS, not names (naming review 2026-11-07): each label is carried as its association type id (direction
// from -> to), so stamped option values survive a label rename (see label-options.ts). Names are kept on the side
// (NormalizedChange.labelNames) for logs and the app-event mode.
import { UNLABELED_KEY } from './label-options.js';
import type { LabelCache } from './labels.js';
import { pairKey } from './pairing.js';
import type { LabelRef, NormalizedChange, PairedChange } from './types.js';

export interface ResolveConfig {
  /** Key used for a type with no label (the structural default link). Dropped when stamping. */
  unlabeledName: string;
  /** STAMP_MIRROR=1: also translate each label to the to -> from direction (mirrorLabelKeys) for the mirror stamp. */
  mirror?: boolean;
}

export const DEFAULT_RESOLVE_CONFIG: ResolveConfig = { unlabeledName: UNLABELED_KEY };

export interface LabelStateReader {
  getAssociationLabels(pairKey: string): string[] | undefined;
}

export interface ResolveResult {
  changes: NormalizedChange[];
  /** pairKey -> new label set, or null to forget the pair. Persist only after events are sent. */
  stateUpdates: Map<string, string[] | null>;
}

export const uniqSorted = (xs: string[]) => [...new Set(xs)].sort();

/**
 * Label keys of a paired change's removed / added type ids (sorted, unique), plus key -> name for the named ones.
 * Key = the type id as a string; the unlabeled structural type = config.unlabeledName; unresolvable = "type N".
 */
export async function labelKeysOf(
  p: Pick<PairedChange, 'portalId' | 'removed' | 'added'>,
  labels: LabelCache,
  config: ResolveConfig = DEFAULT_RESOLVE_CONFIG,
): Promise<{ removed: string[]; added: string[]; names: Record<string, string> }> {
  const names: Record<string, string> = {};
  const keyOf = async (r: LabelRef): Promise<string> => {
    const hit = await labels.get(p.portalId, r.fromObjectTypeId, r.toObjectTypeId, r.associationTypeId);
    if (!hit) return `type ${r.associationTypeId}`;
    if (hit.label === null) return config.unlabeledName;
    const key = String(r.associationTypeId);
    names[key] = hit.label;
    return key;
  };
  return {
    removed: uniqSorted(await Promise.all(p.removed.map(keyOf))),
    added: uniqSorted(await Promise.all(p.added.map(keyOf))),
    names,
  };
}

/**
 * Mirror stamps put the label on the "to" record, whose options use the to -> from type ids. Translate by name (a
 * normal label has the same name both ways). No unique match (a paired label such as "Manager"/"Employee") -> left
 * out, so that label is written as "unknown" on the mirror record.
 */
export async function mirrorKeysOf(
  c: Pick<NormalizedChange, 'portalId' | 'fromObjectTypeId' | 'toObjectTypeId'>,
  keys: string[],
  names: Record<string, string>,
  labels: LabelCache,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!labels.findByName) return out;
  for (const k of keys) {
    const name = names[k];
    if (name === undefined || k in out) continue;
    const id = await labels.findByName(c.portalId, c.toObjectTypeId, c.fromObjectTypeId, name);
    if (id !== undefined) out[k] = String(id);
  }
  return out;
}

/**
 * Names for every label key of a change. Keys that came from stored state (an earlier event) are looked up by id;
 * the label cache already holds them, so this is normally a local read.
 */
async function namesFor(
  p: Pick<PairedChange, 'portalId' | 'fromObjectTypeId' | 'toObjectTypeId'>,
  keys: string[],
  known: Record<string, string>,
  labels: LabelCache,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (known[k] !== undefined) out[k] = known[k];
    else if (/^\d+$/.test(k)) {
      try {
        const hit = await labels.get(p.portalId, p.fromObjectTypeId, p.toObjectTypeId, Number(k));
        if (hit?.label) out[k] = hit.label;
      } catch {
        /* names are only for logs and app events; the stamp uses the key */
      }
    }
  }
  return out;
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
    const { removed, added, names } = await labelKeysOf(p, labels, config);
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

    const allKeys = uniqSorted([...(labelBefore ?? []), ...(labelAfter ?? []), ...(labelsCurrent ?? []), ...removed, ...added]);
    const labelNames = await namesFor(p, allKeys, names, labels);
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
      labelNames,
      ...(config.mirror ? { mirrorLabelKeys: await mirrorKeysOf(p, allKeys, labelNames, labels) } : {}),
      associationCategory: p.associationCategory,
      occurredAt: p.occurredAt,
      sourceOffsets: p.sourceOffsets,
      sourceKeys: p.sourceKeys,
    });
  }
  return { changes, stateUpdates };
}
