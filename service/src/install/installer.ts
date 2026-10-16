// Install, provision, settings changes and uninstall for one portal. All HubSpot access is injected (testable).
//
// Install:   save encrypted refresh token -> provision()
// Provision: watched pairs = stored pairs, or the defaults (pairs.ts) -> properties on every object type in them
//            -> reconcile journal subscriptions -> mark provisioned. Idempotent; safe to re-run.
// Settings:  validate -> properties on NEWLY watched object types -> reconcile subscriptions -> save pairs + spacing.
//            Pairs are saved last, so if HubSpot fails half-way the worker keeps the old (consistent) view and the
//            admin can simply press Save again.
// Uninstall: delete all of the portal's journal subscriptions -> mark uninstalled, wipe token + pairs.
//
// One operation per portal at a time (in-process lock), so a settings save can't race an install.
//
// Custom objects: pairs with a custom object type (2-...) are only set up when the portal granted BOTH
// crm.objects.custom.write and crm.schemas.custom.write (src/install/scopes.ts). Otherwise provision skips them with
// a log line (no failure), and saveSettings rejects them with a clear message.

import type { WatchedPair } from '../core/types.js';
import type { TokenResponse } from '../hubspot/oauth.js';
import { ensureChangeCatchProperties, type SetupReport } from '../hubspot/properties.js';
import type { PortalStore } from '../store/portals.js';
import { defaultPairs, normalisePairs, objectTypesIn } from './pairs.js';
import { customAccess } from './scopes.js';
import { journalSubscriptionApi, reconcilePortalSubscriptions, type SubscriptionApi } from './subscriptions.js';
import type { PortalTokenProvider } from './token-provider.js';

export const MIN_SPACING_SECONDS = 1;
export const MAX_SPACING_SECONDS = 600;

export type EnsureProperties = (token: string, objectTypeId: string) => Promise<SetupReport>;

export interface InstallerDeps {
  portals: PortalStore;
  tokens: Pick<PortalTokenProvider, 'getAccessToken' | 'prime' | 'forget'>;
  subscriptions?: SubscriptionApi;
  ensureProperties?: EnsureProperties;
  defaultPairs?: () => WatchedPair[];
  log?: (msg: string) => void;
  now?: () => number;
}

export interface SettingsInput {
  watchedPairs: WatchedPair[];
  stampSpacingSeconds: number;
}

export interface ChangeReport {
  portalId: number;
  watchedPairs: WatchedPair[];
  properties: SetupReport[];
  subscriptions: { created: number[]; deleted: number[]; unchanged: string[] };
}

export class SettingsValidationError extends Error {}

export class Installer {
  private readonly subs: SubscriptionApi;
  private readonly ensureProps: EnsureProperties;
  private readonly defaults: () => WatchedPair[];
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly locks = new Map<number, Promise<unknown>>();

  constructor(private readonly deps: InstallerDeps) {
    this.subs = deps.subscriptions ?? journalSubscriptionApi;
    this.ensureProps = deps.ensureProperties ?? ((token, t) => ensureChangeCatchProperties(token, t, { dryRun: false }));
    this.defaults = deps.defaultPairs ?? (() => defaultPairs());
    this.log = deps.log ?? ((m) => console.log(`[install] ${m}`));
    this.now = deps.now ?? Date.now;
  }

  /** Serialise operations per portal. */
  private withLock<T>(portalId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(portalId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(portalId, tail);
    void tail.then(() => {
      if (this.locks.get(portalId) === tail) this.locks.delete(portalId);
    });
    return run;
  }

  /** Called from the OAuth callback with the code-exchange response. */
  async completeInstall(t: TokenResponse): Promise<ChangeReport> {
    const portalId = Number(t.hub_id);
    if (!Number.isInteger(portalId) || portalId <= 0) throw new Error('Token response has no hub_id');
    if (!t.refresh_token) throw new Error('Token response has no refresh_token');
    this.deps.portals.saveInstall(portalId, t.refresh_token, t.scopes ?? [], this.now());
    this.deps.tokens.prime(portalId, t.access_token, t.expires_in);
    this.log(`portal ${portalId} installed (scopes: ${(t.scopes ?? []).length})`);
    return this.provision(portalId);
  }

  /** (Re)create properties + subscriptions for the stored (or default) pairs. */
  provision(portalId: number): Promise<ChangeReport> {
    return this.withLock(portalId, async () => {
      try {
        const stored = this.deps.portals.getWatchedPairs(portalId);
        const pairs = this.withoutUngrantedCustom(portalId, normalisePairs(stored.length ? stored : this.defaults()));
        const report = await this.applyPairs(portalId, pairs, objectTypesIn(pairs));
        this.deps.portals.setWatchedPairs(portalId, pairs);
        this.deps.portals.markProvisioned(portalId, null, this.now());
        this.log(`portal ${portalId} provisioned: ${pairs.length} pair(s), subs +${report.subscriptions.created.length} -${report.subscriptions.deleted.length}`);
        return report;
      } catch (e) {
        this.deps.portals.markProvisioned(portalId, (e as Error).message, this.now());
        throw e;
      }
    });
  }

  /** Save settings from the settings page. `allowedTypes` = object types that exist in the portal. */
  async saveSettings(portalId: number, input: SettingsInput, allowedTypes: string[]): Promise<ChangeReport> {
    const spacing = input.stampSpacingSeconds;
    if (!Number.isInteger(spacing) || spacing < MIN_SPACING_SECONDS || spacing > MAX_SPACING_SECONDS) {
      throw new SettingsValidationError(`stampSpacingSeconds must be a whole number from ${MIN_SPACING_SECONDS} to ${MAX_SPACING_SECONDS}`);
    }
    const allowed = new Set(allowedTypes);
    for (const p of input.watchedPairs) {
      if (!allowed.has(p.objectTypeId) || !allowed.has(p.associatedObjectTypeId)) {
        throw new SettingsValidationError(`Unknown object type in pair ${p.objectTypeId} <-> ${p.associatedObjectTypeId}`);
      }
    }
    return this.withLock(portalId, async () => {
      if (!this.deps.portals.isInstalled(portalId)) throw new SettingsValidationError(`Portal ${portalId} is not installed`);
      const pairs = normalisePairs(input.watchedPairs);
      if (!this.customEnabled(portalId) && pairs.some(hasCustom)) {
        throw new SettingsValidationError(
          'Custom objects need two extra permissions (crm.objects.custom.write, crm.schemas.custom.write). Use "Enable custom objects" first.',
        );
      }
      const before = new Set(objectTypesIn(this.deps.portals.getWatchedPairs(portalId)));
      const newTypes = objectTypesIn(pairs).filter((t) => !before.has(t));
      const report = await this.applyPairs(portalId, pairs, newTypes);
      this.deps.portals.setWatchedPairs(portalId, pairs);
      this.deps.portals.setStampSpacingSeconds(portalId, spacing, this.now());
      this.log(`portal ${portalId} settings saved: ${pairs.length} pair(s), spacing ${spacing}s, new types [${newTypes.join(', ')}]`);
      return report;
    });
  }

  /** Both custom write scopes granted at install? */
  customEnabled(portalId: number): boolean {
    return customAccess(this.deps.portals.getPortal(portalId)?.scopes ?? []).enabled;
  }

  private withoutUngrantedCustom(portalId: number, pairs: WatchedPair[]): WatchedPair[] {
    if (this.customEnabled(portalId)) return pairs;
    const skipped = pairs.filter(hasCustom);
    if (skipped.length)
      this.log(
        `portal ${portalId}: skipping ${skipped.length} custom-object pair(s) [${skipped.map((p) => `${p.objectTypeId}<->${p.associatedObjectTypeId}`).join(', ')}]: ` +
          'crm.objects.custom.write + crm.schemas.custom.write not granted (enable custom objects from the settings page)',
      );
    return pairs.filter((p) => !hasCustom(p));
  }

  /** Uninstall: delete the portal's journal subs, then wipe token and pairs. */
  uninstall(portalId: number): Promise<void> {
    return this.withLock(portalId, async () => {
      await this.subs.deletePortalSubscriptions(portalId);
      this.deps.portals.markUninstalled(portalId, this.now());
      this.deps.tokens.forget(portalId);
      this.log(`portal ${portalId} uninstalled: subscriptions deleted, token wiped`);
    });
  }

  private async applyPairs(portalId: number, pairs: WatchedPair[], propertyTypes: string[]): Promise<ChangeReport> {
    // 1) Properties first, so stamps never hit a missing property once events start flowing.
    const properties: SetupReport[] = [];
    if (propertyTypes.length) {
      const token = await this.deps.tokens.getAccessToken(portalId);
      for (const t of propertyTypes) {
        const r = await this.ensureProps(token, t);
        properties.push(r);
        if (r.error || r.properties.some((p) => p.status === 'error')) {
          const why = r.missingScope ? `missing scope ${r.missingScope}` : (r.error ?? r.properties.find((p) => p.detail)?.detail ?? 'unknown error');
          throw new Error(`Could not create ChangeCatch properties on ${t}: ${why}`);
        }
      }
    }
    // 2) Journal subscriptions.
    const { plan, result } = await reconcilePortalSubscriptions(portalId, pairs, this.subs);
    return {
      portalId,
      watchedPairs: pairs,
      properties,
      subscriptions: { created: result.created.map((s) => s.id), deleted: result.deleted, unchanged: plan.unchanged },
    };
  }
}

const hasCustom = (p: WatchedPair) => p.objectTypeId.startsWith('2-') || p.associatedObjectTypeId.startsWith('2-');
