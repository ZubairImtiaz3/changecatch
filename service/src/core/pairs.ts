// Watched object pairs: defaults, normalising, orientation, and which pairs are active for a portal's scopes. Pure.
//
// DEFAULT PAIRS (set on install, the admin can change them in the settings page):
//   Deal <-> Contact, Deal <-> Company, Contact <-> Company
// Why: these are the three standard pairs every Pro portal has, and they are what the community threads ask about
// ("contact added to deal", "company changed on deal", "contact moved to another company").
// Custom objects are NOT watched by default: they need Enterprise and the admin knows which ones matter.
// The settings page offers the same list as "Use recommended pairs" (GET /api/settings recommendedPairs).
//
// ORIENTATION: the journal only reports an association from the SUBSCRIBED object's side (verified in testing:
// "from = the subscribed object, no reverse duplicates"). So for each unordered pair we pick one side to subscribe on.
// Rule (stable, matches what Tests 1+2 used): custom objects first, then deal, ticket, company, contact, others
// (rank in core/contract.ts STANDARD_OBJECTS).
// A pair is stored in portal_settings with objectTypeId = the subscribed side.

import { CUSTOM_OBJECT_SCOPES, isCustomObjectType, standardObject } from './contract.js';
import type { WatchedPair } from './types.js';

function rank(t: string): number {
  if (isCustomObjectType(t)) return 0;
  return standardObject(t)?.rank ?? 5;
}

/** Put the side we subscribe on first. Deterministic for any input order. */
export function orientPair(a: string, b: string): WatchedPair {
  const [x, y] = rank(a) !== rank(b) ? (rank(a) < rank(b) ? [a, b] : [b, a]) : a <= b ? [a, b] : [b, a];
  return { objectTypeId: x, associatedObjectTypeId: y };
}

export const objectPairKey = (p: WatchedPair) => `${p.objectTypeId}|${p.associatedObjectTypeId}`;

/** Orient, de-duplicate and sort. Direction-insensitive: (A,B) and (B,A) are the same pair. */
export function normalisePairs(pairs: readonly WatchedPair[]): WatchedPair[] {
  const m = new Map<string, WatchedPair>();
  for (const p of pairs) {
    const o = orientPair(p.objectTypeId, p.associatedObjectTypeId);
    m.set(objectPairKey(o), o);
  }
  return [...m.values()].sort((a, b) => objectPairKey(a).localeCompare(objectPairKey(b)));
}

export const DEFAULT_PAIRS: readonly WatchedPair[] = normalisePairs([
  { objectTypeId: '0-3', associatedObjectTypeId: '0-1' },
  { objectTypeId: '0-3', associatedObjectTypeId: '0-2' },
  { objectTypeId: '0-2', associatedObjectTypeId: '0-1' },
]);

export const hasCustomObject = (p: WatchedPair) => isCustomObjectType(p.objectTypeId) || isCustomObjectType(p.associatedObjectTypeId);

const TYPE_ID = /^\d+-\d+$/;
export const isObjectTypeId = (s: unknown): s is string => typeof s === 'string' && TYPE_ID.test(s);

export const CUSTOM_READ_SCOPES = [CUSTOM_OBJECT_SCOPES.objectRead];
export const CUSTOM_WRITE_SCOPES = [CUSTOM_OBJECT_SCOPES.objectWrite, CUSTOM_OBJECT_SCOPES.schemaWrite];

export interface CustomAccess {
  /** Custom read granted: the portal has custom objects (Enterprise) and we can list them. */
  available: boolean;
  /** Both custom write scopes granted: we can create properties on and stamp custom objects. */
  enabled: boolean;
}

export function customAccess(granted: string[]): CustomAccess {
  const g = new Set(granted);
  return { available: CUSTOM_READ_SCOPES.every((s) => g.has(s)), enabled: CUSTOM_WRITE_SCOPES.every((s) => g.has(s)) };
}

/** The portal has custom objects (custom read) but we can't stamp them yet (custom write missing). */
export function customWriteMissing(granted: string[]): boolean {
  const a = customAccess(granted);
  return a.available && !a.enabled;
}

/** A pair with a custom object is active (properties, subscriptions, worker) only while the portal has custom write. */
export const isPairActive = (p: WatchedPair, access: CustomAccess): boolean => access.enabled || !hasCustomObject(p);

/**
 * One portal's pairs: saved = what the admin saved (portal_settings, kept as is); active = the saved pairs that may be
 * watched now; access = its custom-object access. Used by the installer, the settings view and the worker.
 */
export function portalPairs(
  portals: { getPortal(portalId: number): { scopes: string[] } | null | undefined; getWatchedPairs(portalId: number): WatchedPair[] },
  portalId: number,
): { saved: WatchedPair[]; active: WatchedPair[]; access: CustomAccess } {
  const access = customAccess(portals.getPortal(portalId)?.scopes ?? []);
  const saved = portals.getWatchedPairs(portalId);
  return { saved, active: saved.filter((p) => isPairActive(p, access)), access };
}

/** All object type ids used by these pairs (both sides). */
export function objectTypesIn(pairs: WatchedPair[]): string[] {
  return [...new Set(pairs.flatMap((p) => [p.objectTypeId, p.associatedObjectTypeId]))].sort();
}
