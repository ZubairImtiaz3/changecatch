// Watched object pairs: defaults, normalising and orientation.
//
// DEFAULT PAIRS (set on install, the admin can change them in the settings page):
//   Deal <-> Contact, Deal <-> Company, Contact <-> Company
// Why: these are the three standard pairs every Pro portal has, and they are what the community threads ask about
// ("contact added to deal", "company changed on deal", "contact moved to another company").
// Custom objects are NOT watched by default: they need Enterprise and the admin knows which ones matter.
// Override with env CHANGECATCH_DEFAULT_PAIRS="0-3:0-1,0-3:0-2,0-1:0-2" (no code change needed).
//
// ORIENTATION: the journal only reports an association from the SUBSCRIBED object's side (verified in testing:
// "from = the subscribed object, no reverse duplicates"). So for each unordered pair we pick one side to subscribe on.
// Rule (stable, matches what Tests 1+2 used): custom objects first, then deal, ticket, company, contact, others.
// A pair is stored in portal_settings with objectTypeId = the subscribed side.

import type { WatchedPair } from '../core/types.js';

export const STANDARD_OBJECTS: { objectTypeId: string; label: string }[] = [
  { objectTypeId: '0-1', label: 'Contact' },
  { objectTypeId: '0-2', label: 'Company' },
  { objectTypeId: '0-3', label: 'Deal' },
];

export const BUILTIN_DEFAULT_PAIRS: WatchedPair[] = [
  { objectTypeId: '0-3', associatedObjectTypeId: '0-1' },
  { objectTypeId: '0-3', associatedObjectTypeId: '0-2' },
  { objectTypeId: '0-2', associatedObjectTypeId: '0-1' },
];

const STANDARD_RANK: Record<string, number> = { '0-3': 1, '0-5': 2, '0-2': 3, '0-1': 4 };

function rank(t: string): number {
  if (t.startsWith('2-')) return 0;
  return STANDARD_RANK[t] ?? 5;
}

/** Put the side we subscribe on first. Deterministic for any input order. */
export function orientPair(a: string, b: string): WatchedPair {
  const [x, y] = rank(a) !== rank(b) ? (rank(a) < rank(b) ? [a, b] : [b, a]) : a <= b ? [a, b] : [b, a];
  return { objectTypeId: x, associatedObjectTypeId: y };
}

export const pairKey = (p: WatchedPair) => `${p.objectTypeId}|${p.associatedObjectTypeId}`;

/** Orient, de-duplicate and sort. Direction-insensitive: (A,B) and (B,A) are the same pair. */
export function normalisePairs(pairs: WatchedPair[]): WatchedPair[] {
  const m = new Map<string, WatchedPair>();
  for (const p of pairs) {
    const o = orientPair(p.objectTypeId, p.associatedObjectTypeId);
    m.set(pairKey(o), o);
  }
  return [...m.values()].sort((a, b) => pairKey(a).localeCompare(pairKey(b)));
}

const TYPE_ID = /^\d+-\d+$/;
export const isObjectTypeId = (s: unknown): s is string => typeof s === 'string' && TYPE_ID.test(s);

/** Parse "0-3:0-1,0-3:0-2". Throws on bad input so a typo in .env fails loudly at startup. */
export function parsePairs(spec: string): WatchedPair[] {
  const out: WatchedPair[] = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [a, b] = part.split(':').map((s) => s.trim());
    if (!isObjectTypeId(a) || !isObjectTypeId(b)) throw new Error(`Bad pair "${part}" (expected e.g. 0-3:0-1)`);
    out.push({ objectTypeId: a, associatedObjectTypeId: b });
  }
  return normalisePairs(out);
}

export function defaultPairs(env: string | undefined = process.env.CHANGECATCH_DEFAULT_PAIRS): WatchedPair[] {
  return env ? parsePairs(env) : normalisePairs(BUILTIN_DEFAULT_PAIRS);
}

/** All object type ids used by these pairs (both sides). */
export function objectTypesIn(pairs: WatchedPair[]): string[] {
  return [...new Set(pairs.flatMap((p) => [p.objectTypeId, p.associatedObjectTypeId]))].sort();
}
