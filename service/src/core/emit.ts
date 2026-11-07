import { createHash } from 'node:crypto';
import type { AppEventOccurrence, AppEventProperties, NormalizedChange } from './types.js';

export const MAX_OCCURRENCES_PER_BATCH = 500;

export interface EmitConfig {
  /** Also send the event onto the "to" record, so workflows on either object can trigger. */
  emitOnToRecord: boolean;
}

export const DEFAULT_EMIT_CONFIG: EmitConfig = { emitOnToRecord: false };

// Empty lists are left out of the event instead of sent as "" (how HubSpot treats "" is unconfirmed).
// Label arrays hold keys (type ids); app events carry the names (NormalizedChange.labelNames). The structural
// "unlabeled" key is not a label and is dropped.
const joinLabels = (l: string[] | undefined, names: Record<string, string> = {}) => {
  // Sorted by name (keys sort by type id), so "Decision maker, Influencer" reads the same as before.
  const out = (l ?? []).filter((k) => k !== 'unlabeled').map((k) => names[k] ?? k).sort();
  return l === undefined || out.length === 0 ? undefined : out.join(', ');
};

function occurrenceId(change: NormalizedChange, targetType: string, targetId: string): string {
  const h = createHash('sha256');
  h.update([...change.sourceKeys].sort().join('\n'));
  h.update(`\n->${targetType}:${targetId}`);
  return h.digest('hex').slice(0, 32);
}

function build(change: NormalizedChange, target: [string, string], other: [string, string]): AppEventOccurrence {
  const properties: AppEventProperties = {
    change_type: change.changeType,
    other_object_type: other[0],
    other_record_id: other[1],
    association_category: change.associationCategory,
    occurred_at: change.occurredAt,
  };
  const before = joinLabels(change.labelBefore, change.labelNames);
  const after = joinLabels(change.labelAfter, change.labelNames);
  const current = joinLabels(change.labelsCurrent, change.labelNames);
  if (before !== undefined) properties.label_before = before;
  if (after !== undefined) properties.label_after = after;
  if (current !== undefined) properties.labels_current = current;
  return {
    id: occurrenceId(change, target[0], target[1]),
    portalId: change.portalId,
    objectTypeId: target[0],
    objectId: target[1],
    occurredAt: change.occurredAt,
    properties,
  };
}

export function toOccurrences(change: NormalizedChange, config: EmitConfig = DEFAULT_EMIT_CONFIG): AppEventOccurrence[] {
  const from: [string, string] = [change.fromObjectTypeId, change.fromObjectId];
  const to: [string, string] = [change.toObjectTypeId, change.toObjectId];
  const out = [build(change, from, to)];
  if (config.emitOnToRecord) out.push(build(change, to, from));
  return out;
}

export function chunk<T>(items: T[], size: number = MAX_OCCURRENCES_PER_BATCH): T[][] {
  if (size < 1) throw new Error('chunk size must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
