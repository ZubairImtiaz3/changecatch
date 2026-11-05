// Per-portal ASSOCIATION journal subscriptions: plan (pure) + apply. Plus the app-level APP_LIFECYCLE_EVENT subs.
// All calls use the APP-LEVEL client credentials token (via src/hubspot/journal.ts).
// Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/subscriptions/guide
//
// Layout: ONE subscription per (portal, subscribed object type), with associatedObjectTypeIds = all partners.
//   e.g. pairs Deal-Contact + Deal-Company -> one sub { objectTypeId: "0-3", associatedObjectTypeIds: ["0-1","0-2"] }.
// Why: POST is an "upsert" and the docs don't say which fields form the key (research-journal.md, open question 7).
// If the key is (portal, objectTypeId), separate subs per pair would overwrite each other. Grouping is safe either way.
// When a group changes we upsert FIRST and only then delete old sub ids that differ from the returned id,
// so there is never a gap where the portal is unsubscribed.

import type { WatchedPair } from '../core/types.js';
import {
  APP_EVENT_TYPE,
  createSubscription,
  deletePortalSubscriptions,
  deleteSubscription,
  listSubscriptions,
  type Subscription,
  type SubscriptionRequest,
} from '../hubspot/journal.js';
import { normalisePairs } from './pairs.js';

export const ASSOCIATION_ACTIONS = ['ASSOCIATION_ADDED', 'ASSOCIATION_REMOVED'] as const;

export interface SubscriptionApi {
  listSubscriptions(): Promise<Subscription[]>;
  createSubscription(body: SubscriptionRequest): Promise<Subscription>;
  deleteSubscription(id: number): Promise<void>;
  deletePortalSubscriptions(portalId: number): Promise<void>;
}

export const journalSubscriptionApi: SubscriptionApi = {
  listSubscriptions,
  createSubscription,
  deleteSubscription: (id) => deleteSubscription(id),
  deletePortalSubscriptions,
};

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

/** Desired subscription groups: subscribed objectTypeId -> sorted partner type ids. */
export function groupPairs(pairs: WatchedPair[]): Map<string, string[]> {
  const g = new Map<string, Set<string>>();
  for (const p of normalisePairs(pairs)) {
    if (!g.has(p.objectTypeId)) g.set(p.objectTypeId, new Set());
    g.get(p.objectTypeId)!.add(p.associatedObjectTypeId);
  }
  return new Map([...g].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()]));
}

/** This portal's live ASSOCIATION subscriptions out of the app-wide list. */
export function portalAssociationSubs(all: Subscription[], portalId: number): Subscription[] {
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
 * Pure diff. `existing` must already be filtered to one portal (portalAssociationSubs).
 * - group wanted, one matching sub exists        -> unchanged (extra duplicates for that type are deleted)
 * - group wanted, no matching sub                -> upsert, replacing whatever subs exist for that type
 * - sub exists for an object type no longer wanted -> delete
 */
export function planSubscriptionChanges(desired: WatchedPair[], existing: Subscription[]): SubscriptionPlan {
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
export async function applySubscriptionPlan(portalId: number, plan: SubscriptionPlan, api: SubscriptionApi): Promise<ApplyResult> {
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
export async function reconcilePortalSubscriptions(portalId: number, desired: WatchedPair[], api: SubscriptionApi = journalSubscriptionApi) {
  const existing = portalAssociationSubs(await api.listSubscriptions(), portalId);
  const plan = planSubscriptionChanges(desired, existing);
  const result = await applySubscriptionPlan(portalId, plan, api);
  return { plan, result };
}

// ---------------------------------------------------------------- app-level lifecycle subscriptions

/** Properties seen in the docs' APP_INSTALL example payload (research-journal.md section 4). */
export const LIFECYCLE_PROPERTIES = ['hs_app_id', 'hs_app_install_level', 'hs_initiating_user_id', 'hs_user_id'];

/**
 * Make sure the two app-level APP_LIFECYCLE_EVENT subscriptions (install 4-1909196, uninstall 4-1916193) exist.
 * No portalId: they cover every portal. Creates only what's missing.
 */
export async function ensureLifecycleSubscriptions(api: SubscriptionApi = journalSubscriptionApi): Promise<{ created: string[]; existing: string[] }> {
  const all = await api.listSubscriptions();
  const have = new Set(
    // HubSpot's list returns a lifecycle subscription's event type in `objectTypeId` (e.g. "4-1909196"), even though
    // the create request calls it `eventTypeId`. Read both, or every check wrongly reports the subscription missing.
    all
      .filter((s) => s.subscriptionType === 'APP_LIFECYCLE_EVENT' && !s.deletedAt)
      .map((s) => String((s as { objectTypeId?: unknown }).objectTypeId ?? (s as { eventTypeId?: unknown }).eventTypeId ?? '')),
  );
  const out = { created: [] as string[], existing: [] as string[] };
  for (const eventTypeId of [APP_EVENT_TYPE.INSTALL, APP_EVENT_TYPE.UNINSTALL]) {
    if (have.has(eventTypeId)) {
      out.existing.push(eventTypeId);
      continue;
    }
    await api.createSubscription({ subscriptionType: 'APP_LIFECYCLE_EVENT', eventTypeId, properties: LIFECYCLE_PROPERTIES });
    out.created.push(eventTypeId);
  }
  return out;
}

export const DEFAULT_LIFECYCLE_SUB_CHECK_MS = 10 * 60 * 1000;

/**
 * Self-heal: the lifecycle subs were once found deleted after an uninstall (seen 2026-10-30 in testing; cause unknown).
 * Runs ensureLifecycleSubscriptions at start and then every intervalMs (env LIFECYCLE_SUB_CHECK_MS, default 10 min).
 * Never throws; overlapping checks are skipped; the timer is unref'd so it never keeps the process alive.
 */
export function startLifecycleSubscriptionWatch(opts: {
  api?: SubscriptionApi;
  intervalMs?: number;
  log?: (msg: string) => void;
} = {}): { check: () => Promise<{ created: string[]; existing: string[] } | null>; stop: () => void; ready: Promise<unknown> } {
  const api = opts.api ?? journalSubscriptionApi;
  const log = opts.log ?? ((m: string) => console.log(`[lifecycle-subs] ${m}`));
  const fromEnv = Number(process.env.LIFECYCLE_SUB_CHECK_MS);
  const intervalMs = opts.intervalMs ?? (Number.isFinite(fromEnv) && fromEnv >= 1000 ? fromEnv : DEFAULT_LIFECYCLE_SUB_CHECK_MS);
  let running = false;
  let first = true;

  async function check() {
    if (running) return null;
    running = true;
    try {
      const r = await ensureLifecycleSubscriptions(api);
      if (r.created.length) log(`${first ? '' : 'MISSING, '}recreated lifecycle subscription(s) [${r.created.join(', ')}]; existing [${r.existing.join(', ')}]`);
      else if (first) log(`lifecycle subscriptions OK [${r.existing.join(', ')}]; re-checking every ${Math.round(intervalMs / 1000)}s`);
      return r;
    } catch (e) {
      log(`lifecycle subscription check FAILED: ${(e as Error).message}`);
      return null;
    } finally {
      first = false;
      running = false;
    }
  }

  const ready = check();
  const timer = setInterval(() => void check(), intervalMs);
  timer.unref?.();
  return { check, stop: () => clearInterval(timer), ready };
}
