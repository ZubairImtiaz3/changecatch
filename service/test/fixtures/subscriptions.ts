// In-memory journal subscriptions (SubscriptionApi), shaped like HubSpot's.
import { normaliseSubscription, type Subscription, type SubscriptionRequest } from '../../src/hubspot/journal.js';
import { HubSpotError } from '../../src/lib/http.js';
import type { SubscriptionApi } from '../../src/hubspot/journal.js';

export function sub(id: number, objectTypeId: string, assoc: string[], extra: Partial<Subscription> = {}): Subscription {
  return {
    id, appId: 1, subscriptionType: 'ASSOCIATION', portalId: 111, objectTypeId, associatedObjectTypeIds: assoc,
    actions: ['ASSOCIATION_REMOVED', 'ASSOCIATION_ADDED'], createdAt: '', updatedAt: '', ...extra,
  };
}

export class FakeSubs implements SubscriptionApi {
  subs: Subscription[] = [];
  nextId = 1000;
  calls: string[] = [];
  /** The next `fail` deletePortalSubscriptions calls throw a 503. */
  fail = 0;
  async listSubscriptions() { return this.subs.map((s) => normaliseSubscription({ ...s })); }
  async createSubscription(b: SubscriptionRequest) {
    this.calls.push(`create ${'objectTypeId' in b ? b.objectTypeId : b.eventTypeId}`);
    if (b.subscriptionType === 'APP_LIFECYCLE_EVENT') {
      // Like HubSpot: the event type comes back as `objectTypeId`, and create is an upsert (no duplicates).
      const hit = this.subs.find((s) => s.subscriptionType === 'APP_LIFECYCLE_EVENT' && s.objectTypeId === b.eventTypeId);
      if (hit) return { ...hit };
      const s = { id: this.nextId++, appId: 1, subscriptionType: b.subscriptionType, objectTypeId: b.eventTypeId, actions: [], createdAt: '', updatedAt: '' } as unknown as Subscription;
      this.subs.push(s);
      return s;
    }
    const hit = this.subs.find((s) => s.portalId === b.portalId && s.objectTypeId === b.objectTypeId);
    if (hit) { hit.associatedObjectTypeIds = b.associatedObjectTypeIds; hit.actions = b.actions; return { ...hit }; }
    const s = sub(this.nextId++, b.objectTypeId, b.associatedObjectTypeIds, { portalId: b.portalId, actions: b.actions });
    this.subs.push(s);
    return s;
  }
  async deleteSubscription(id: number) { this.calls.push(`delete ${id}`); this.subs = this.subs.filter((s) => s.id !== id); }
  async deletePortalSubscriptions(portalId: number) {
    if (this.fail-- > 0) throw HubSpotError.fromStatus(503, {}, 'subs down');
    this.calls.push(`deletePortal ${portalId}`);
    this.subs = this.subs.filter((s) => s.portalId !== portalId);
  }
}
