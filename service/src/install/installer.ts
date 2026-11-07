// Install, provision, settings changes and uninstall for one portal (flow: docs/install-flow.md).
//
// Order: properties -> save pairs -> journal subscriptions. Pairs are saved BEFORE subscriptions exist, so an event
// from a new subscription is never dropped as unwatched. If a subscription step then fails, the portal is marked
// provision-failed and the provisioning sweep reconciles the subscriptions to the saved pairs.
// Default pairs only when the portal was never configured (never provisioned and nothing saved): an admin's explicitly
// empty list stays empty on re-provision (e.g. a re-consent for custom scopes).
// The API server is the ONLY process that provisions (the worker uninstalls: hubspot/app-lifecycle.ts uninstallPortal), so the in-process per-portal lock
// covers every path and a settings save can't race an install.
//
// Custom objects: pairs with a custom object type (2-...) are only active when the portal granted BOTH
// crm.objects.custom.write and crm.schemas.custom.write (pairs.ts portalPairs). Inactive pairs are skipped with a log
// line (no failure) but stay saved, so they come back once the scopes are granted. saveSettings refuses to ADD them.

import type { WatchedPair } from '../core/types.js';
import type { TokenResponse } from '../hubspot/oauth.js';
import { ensureChangeCatchProperties, type SetupReport, type SyncLabelOptions } from '../hubspot/properties.js';
import { AlertThrottle } from '../obs/alerts.js';
import { createLogger, type Logger } from '../obs/log.js';
import type { PortalStore } from '../store/portals.js';
import { listObjectTypes, type ObjectTypeOption } from '../hubspot/object-types.js';
import { DEFAULT_PAIRS, hasCustomObject, isPairActive, normalisePairs, objectPairKey, objectTypesIn, portalPairs } from '../core/pairs.js';
import { checkNewPairs, SettingsValidationError, type SettingsInput } from './settings.js';
import { reconcilePortalSubscriptions } from './subscriptions.js';
import type { SubscriptionApi } from '../hubspot/journal.js';
import type { TokenProvider } from '../hubspot/portal-tokens.js';
import type { PortalAuth } from '../lib/http.js';

export const PROVISION_SWEEP_MS = 10 * 60_000;
/** Alert "provisioning_failing" once a portal failed provisioning this many sweeps in a row, then at most hourly. */
const PROVISION_ALERT_AFTER = 3;

export type EnsureProperties = (auth: PortalAuth, objectTypeId: string) => Promise<SetupReport>;

export interface InstallerDeps {
  portals: PortalStore;
  tokens: Pick<TokenProvider, 'getAccessToken' | 'prime'>;
  /** Production: hubspot/journal.ts journalClient(config.hubspot). */
  subscriptions: SubscriptionApi;
  ensureProperties?: EnsureProperties;
  /** Dropdown option sync for newly watched custom-object pairs (production: createLabelOptionSync()). */
  syncOptions: SyncLabelOptions;
  /** Object types the portal has (settings validation). Default: listObjectTypes with the portal's token. */
  objectTypes?: (portalId: number) => Promise<ObjectTypeOption[]>;
  log?: Logger;
  now?: () => number;
}

export interface ChangeReport {
  portalId: number;
  watchedPairs: WatchedPair[];
  properties: SetupReport[];
  subscriptions: { created: number[]; deleted: number[]; unchanged: string[] };
}

export class Installer {
  private readonly subs: SubscriptionApi;
  private readonly ensureProps: EnsureProperties;
  private readonly syncOptions: SyncLabelOptions;
  /** Object types the portal has (settings validation and the settings view). */
  readonly objectTypes: (portalId: number) => Promise<ObjectTypeOption[]>;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly locks = new Map<number, Promise<unknown>>();
  private readonly provisionFailures = new Map<number, number>();
  private readonly provisionAlerts = new AlertThrottle<number>(60 * 60_000);

  constructor(private readonly deps: InstallerDeps) {
    this.subs = deps.subscriptions;
    this.ensureProps = deps.ensureProperties ?? ensureChangeCatchProperties;
    this.syncOptions = deps.syncOptions;
    this.objectTypes = deps.objectTypes ?? (async (p) => listObjectTypes({ portalId: p, token: await deps.tokens.getAccessToken(p) }));
    this.log = deps.log ?? createLogger('install');
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
    this.log.info('portal_installed', `portal ${portalId} installed (scopes: ${(t.scopes ?? []).length})`, { portalId });
    return this.provision(portalId);
  }

  /** (Re)create properties + subscriptions for the stored (or default) pairs. */
  provision(portalId: number): Promise<ChangeReport> {
    return this.withLock(portalId, () => this.provisionLocked(portalId));
  }

  /**
   * Provision every installed portal that was never provisioned or whose last provision failed. One portal at a
   * time, each under its lock (re-checked inside, so a callback that just finished is not repeated). Never throws.
   */
  async provisionPending(): Promise<{ provisioned: number[]; failed: number[] }> {
    const out = { provisioned: [] as number[], failed: [] as number[] };
    for (const { portalId } of this.deps.portals.listInstalled().filter(needsProvision)) {
      try {
        const done = await this.withLock(portalId, async () => {
          const p = this.deps.portals.getPortal(portalId);
          if (!p || p.uninstalledAt !== null || !p.hasToken || !needsProvision(p)) return false;
          await this.provisionLocked(portalId);
          return true;
        });
        this.provisionFailures.delete(portalId);
        this.provisionAlerts.clear(portalId);
        if (done) out.provisioned.push(portalId);
      } catch (e) {
        out.failed.push(portalId);
        const n = (this.provisionFailures.get(portalId) ?? 0) + 1;
        this.provisionFailures.set(portalId, n);
        const msg = `portal ${portalId}: provisioning failed (${n} sweep(s) in a row): ${(e as Error).message}`;
        if (n >= PROVISION_ALERT_AFTER && this.provisionAlerts.fire(portalId, this.now())) this.log.alert('provisioning_failing', msg, { portalId, sweeps: n });
        else this.log.warn('provisioning_failed', msg, { portalId, sweeps: n });
      }
    }
    return out;
  }

  private async provisionLocked(portalId: number): Promise<ChangeReport> {
    try {
      const { saved: stored, access } = portalPairs(this.deps.portals, portalId);
      const neverConfigured = stored.length === 0 && this.deps.portals.getPortal(portalId)?.provisionedAt == null;
      const saved = normalisePairs(neverConfigured ? DEFAULT_PAIRS : stored);
      const pairs = saved.filter((p) => isPairActive(p, access));
      if (pairs.length < saved.length)
        this.log.info(
          'custom_pairs_skipped',
          `portal ${portalId}: skipping ${saved.length - pairs.length} custom-object pair(s): ` +
            'crm.objects.custom.write + crm.schemas.custom.write not granted (enable custom objects from the settings page)',
          { portalId },
        );
      const report = await this.applyPairs(portalId, pairs, objectTypesIn(pairs), pairs, () => this.deps.portals.setWatchedPairs(portalId, saved));
      this.deps.portals.markProvisioned(portalId, null, this.now());
      this.log.info('portal_provisioned', `portal ${portalId} provisioned: ${pairs.length} pair(s), subs +${report.subscriptions.created.length} -${report.subscriptions.deleted.length}`, {
        portalId,
      });
      return report;
    } catch (e) {
      this.deps.portals.markProvisioned(portalId, (e as Error).message, this.now());
      throw e;
    }
  }

  /** Save settings from the settings page (input already parsed by settings.ts parseSettingsBody). */
  saveSettings(portalId: number, input: SettingsInput): Promise<ChangeReport> {
    return this.withLock(portalId, async () => {
      if (!this.deps.portals.isInstalled(portalId)) throw new SettingsValidationError(`Portal ${portalId} is not installed`);
      const objectTypes = await this.objectTypes(portalId);
      const current = portalPairs(this.deps.portals, portalId);
      const pairs = normalisePairs(input.watchedPairs);
      checkNewPairs(pairs, { saved: current.saved, objectTypes, access: current.access });
      const active = pairs.filter((p) => isPairActive(p, current.access));
      const before = new Set(objectTypesIn(current.active));
      const newTypes = objectTypesIn(active).filter((t) => !before.has(t));
      const wasActive = new Set(normalisePairs(current.active).map(objectPairKey));
      let saved = false;
      const report = await this.applyPairs(portalId, active, newTypes, active.filter((p) => !wasActive.has(objectPairKey(p))), () => {
        this.deps.portals.setWatchedPairs(portalId, pairs);
        this.deps.portals.setStampSpacingSeconds(portalId, input.stampSpacingSeconds, this.now());
        saved = true;
      }).catch((e) => {
        // Saved pairs without matching subscriptions: let the provisioning sweep finish the job.
        if (saved && this.deps.portals.isInstalled(portalId)) this.deps.portals.markProvisioned(portalId, (e as Error).message, this.now());
        throw e;
      });
      this.log.info('settings_saved', `portal ${portalId} settings saved: ${pairs.length} pair(s) (${active.length} active), spacing ${input.stampSpacingSeconds}s, new types [${newTypes.join(', ')}]`, { portalId });
      return report;
    });
  }

  /**
   * propertyTypes: object types that get the ChangeCatch properties. added: pairs that start being watched now.
   * save: persists the new settings; runs after the properties and before the subscriptions.
   * Throws if a HubSpot step fails (nothing saved if it fails before save), or if the portal was uninstalled meanwhile.
   */
  private async applyPairs(
    portalId: number,
    pairs: WatchedPair[],
    propertyTypes: string[],
    added: WatchedPair[],
    save: () => void,
  ): Promise<ChangeReport> {
    // 1) Properties first, so stamps never hit a missing property once events start flowing.
    const properties: SetupReport[] = [];
    const optionTypes = objectTypesIn(added.filter(hasCustomObject));
    if (propertyTypes.length || optionTypes.length) {
      const auth = { portalId, token: await this.deps.tokens.getAccessToken(portalId) };
      for (const t of propertyTypes) {
        const r = await this.ensureProps(auth, t);
        properties.push(r);
        if (r.failure !== undefined) throw new Error(`Could not create ChangeCatch properties on ${t}: ${r.failure}`);
      }
      // changecatch_other_object_type starts with the standard types only. A pair with a custom object needs that
      // type as an option on both sides before the first stamp. The worker's label guard also syncs on the first event
      // of a pair, but skips that when it falls back to a cached label (label fetch down), so we sync here too.
      for (const t of optionTypes) {
        const r = await this.syncOptions(auth, t, pairs);
        if (r.failure !== undefined) throw new Error(`Could not update ChangeCatch dropdown options on ${t}: ${r.failure}`);
      }
    }
    // 2) Save, so events from the subscriptions created next are watched. Not for a portal uninstalled meanwhile.
    if (!this.deps.portals.isInstalled(portalId)) throw new SettingsValidationError(`Portal ${portalId} was uninstalled while its settings were being applied`);
    save();
    // 3) Journal subscriptions.
    const { plan, result } = await reconcilePortalSubscriptions(portalId, pairs, this.subs);
    // The worker uninstalls without this process's lock: if that happened meanwhile, remove what we just created and
    // the pairs we saved (the worker's purge may already have run).
    if (!this.deps.portals.isInstalled(portalId)) {
      this.deps.portals.setWatchedPairs(portalId, []);
      await this.subs.deletePortalSubscriptions(portalId);
      throw new SettingsValidationError(`Portal ${portalId} was uninstalled while its settings were being applied`);
    }
    return {
      portalId,
      watchedPairs: pairs,
      properties,
      subscriptions: { created: result.created.map((s) => s.id), deleted: result.deleted, unchanged: plan.unchanged },
    };
  }
}

const needsProvision = (p: { provisionedAt: number | null; lastProvisionError: string | null }) =>
  p.provisionedAt === null || p.lastProvisionError !== null;
