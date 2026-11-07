// Per-portal ASSOCIATION journal subscriptions: plan (pure) + apply. (App-level lifecycle subs: hubspot/app-lifecycle.ts.)
// All calls use the APP-LEVEL client credentials token (via src/hubspot/journal.ts).
// Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/subscriptions/guide
//
// Layout: ONE subscription per (portal, subscribed object type), with associatedObjectTypeIds = all partners.
//   e.g. pairs Deal-Contact + Deal-Company -> one sub { objectTypeId: "0-3", associatedObjectTypeIds: ["0-1","0-2"] }.
// Why: POST is an "upsert" and the docs don't say which fields form the key (docs/research/journal.md, open question 7).
// If the key is (portal, objectTypeId), separate subs per pair would overwrite each other. Grouping is safe either way.
// When a group changes we upsert FIRST and only then delete old sub ids that differ from the returned id,
// so there is never a gap where the portal is unsubscribed.

import type { WatchedPair } from '../core/types.js';
import type { Subscription, SubscriptionApi } from '../hubspot/journal.js';

const ASSOCIATION_ACTIONS = ['ASSOCIATION_ADDED', 'ASSOCIATION_REMOVED'] as const;

export interface SubscriptionUpsert {
  objectTypeId: string;
  associatedObjectTypeIds: string[];
  /** Existing sub ids for this objectTypeId. After the upsert, delete every one that isn't the returned id. */
  replaces: number[];
}

export interface SubscriptionPlan {
  upserts: SubscriptionUpsert[];
  deletes: number[];
  /** Groups that already match, for logging. */
  unchanged: string[];
}

/** Desired subscription groups: subscribed objectTypeId -> sorted partner type ids. Pairs must be normalised (pairs.ts). */
function groupPairs(pairs: WatchedPair[]): Map<string, string[]> {
  const g = new Map<string, Set<string>>();
  for (const p of pairs) {
    if (!g.has(p.objectTypeId)) g.set(p.objectTypeId, new Set());
    g.get(p.objectTypeId)!.add(p.associatedObjectTypeId);
  }
  return new Map([...g].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()]));
}

/** This portal's live ASSOCIATION subscriptions out of the app-wide list. */
function portalAssociationSubs(all: Subscription[], portalId: number): Subscription[] {
  return all.filter((s) => s.subscriptionType === 'ASSOCIATION' && Number(s.portalId) === portalId && !s.deletedAt);
}

function sameSet(a: readonly string[] | undefined, b: readonly string[]): boolean {
  const x = [...(a ?? [])].sort();
  return x.length === b.length && x.every((v, i) => v === [...b].sort()[i]);
}

function matches(s: Subscription, assoc: string[]): boolean {
  return (
    sameSet(s.associatedObjectTypeIds, assoc) &&
    sameSet(s.actions as string[], [...ASSOCIATION_ACTIONS]) &&
    (s.objectIds === undefined || s.objectIds.length === 0)
  );
}

/**
 * Pure diff. `desired` must be normalised (pairs.ts); `existing` must already be filtered to one portal (portalAssociationSubs).
 * - group wanted, one matching sub exists        -> unchanged (extra duplicates for that type are deleted)
 * - group wanted, no matching sub                -> upsert, replacing whatever subs exist for that type
 * - sub exists for an object type no longer wanted -> delete
 */
function planSubscriptionChanges(desired: WatchedPair[], existing: Subscription[]): SubscriptionPlan {
  const groups = groupPairs(desired);
  const plan: SubscriptionPlan = { upserts: [], deletes: [], unchanged: [] };
  const byType = new Map<string, Subscription[]>();
  for (const s of existing) {
    const t = String(s.objectTypeId);
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(s);
  }

  for (const [objectTypeId, assoc] of groups) {
    const subs = (byType.get(objectTypeId) ?? []).sort((a, b) => a.id - b.id);
    const keep = subs.find((s) => matches(s, assoc));
    if (keep) {
      plan.unchanged.push(objectTypeId);
      plan.deletes.push(...subs.filter((s) => s !== keep).map((s) => s.id));
    } else {
      plan.upserts.push({ objectTypeId, associatedObjectTypeIds: assoc, replaces: subs.map((s) => s.id) });
    }
  }
  for (const [t, subs] of byType) if (!groups.has(t)) plan.deletes.push(...subs.map((s) => s.id));
  plan.deletes.sort((a, b) => a - b);
  return plan;
}

export interface ApplyResult {
  created: Subscription[];
  deleted: number[];
}

/** Execute a plan: upserts first, then deletes. Throws on the first API error (caller records it; re-running is safe). */
async function applySubscriptionPlan(portalId: number, plan: SubscriptionPlan, api: SubscriptionApi): Promise<ApplyResult> {
  const out: ApplyResult = { created: [], deleted: [] };
  const toDelete = new Set(plan.deletes);
  for (const u of plan.upserts) {
    const sub = await api.createSubscription({
      subscriptionType: 'ASSOCIATION',
      portalId,
      objectTypeId: u.objectTypeId,
      associatedObjectTypeIds: u.associatedObjectTypeIds,
      actions: [...ASSOCIATION_ACTIONS],
      objectIds: [],
    });
    out.created.push(sub);
    for (const id of u.replaces) if (id !== sub.id) toDelete.add(id);
  }
  for (const id of toDelete) {
    await api.deleteSubscription(id);
    out.deleted.push(id);
  }
  return out;
}

/** List live subs, diff against `desired`, apply. Idempotent. */
export async function reconcilePortalSubscriptions(portalId: number, desired: WatchedPair[], api: SubscriptionApi) {
  const existing = portalAssociationSubs(await api.listSubscriptions(), portalId);
  const plan = planSubscriptionChanges(desired, existing);
  const result = await applySubscriptionPlan(portalId, plan, api);
  return { plan, result };
}
