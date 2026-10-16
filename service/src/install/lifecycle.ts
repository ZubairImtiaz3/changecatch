// App install/uninstall events from the Webhooks Journal (app-level APP_LIFECYCLE_EVENT subscriptions).
// Payload (docs example, research-journal.md section 4):
//   { type: "app_lifecycle_event", action: "APP_INSTALL" | "APP_UNINSTALL", portalId, occurredAt,
//     eventTypeId: "4-1909196" | "4-1916193", properties: { hs_app_id, ... } }
//
// HOW THE WORKER ROUTES THESE (worker agent): for every event in every downloaded journal file,
//   if (isLifecycleEvent(e)) await handleLifecycleEvent(e, lifecycleCtx);
// where lifecycleCtx = { installer, portals } (see src/api/main.ts for how they are built).
// Handle them BEFORE saving the offset; the handler is idempotent, so a re-read after a crash is harmless.

import type { JournalEvent } from '../core/types.js';
import { APP_EVENT_TYPE } from '../hubspot/journal.js';
import type { PortalStore } from '../store/portals.js';
import type { Installer } from './installer.js';

export interface LifecycleEvent {
  type: 'app_lifecycle_event';
  action?: string;
  eventTypeId?: string;
  portalId: number;
  occurredAt?: string;
  properties?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface LifecycleContext {
  installer: Pick<Installer, 'uninstall' | 'provision'>;
  portals: Pick<PortalStore, 'getPortal'>;
  log?: (msg: string) => void;
}

export type LifecycleOutcome =
  | 'uninstalled'
  | 'ignored-stale-uninstall' // portal was re-installed after this uninstall happened
  | 'ignored-already-uninstalled'
  | 'provisioned'
  | 'install-already-provisioned'
  | 'install-without-tokens' // OAuth callback never reached us; nothing we can do without a token
  | 'ignored-unknown';

export function isLifecycleEvent(e: JournalEvent): e is LifecycleEvent {
  return e.type === 'app_lifecycle_event' && typeof e.portalId === 'number';
}

function kind(e: LifecycleEvent): 'install' | 'uninstall' | 'unknown' {
  if (e.action === 'APP_UNINSTALL' || e.eventTypeId === APP_EVENT_TYPE.UNINSTALL) return 'uninstall';
  if (e.action === 'APP_INSTALL' || e.eventTypeId === APP_EVENT_TYPE.INSTALL) return 'install';
  return 'unknown';
}

export async function handleLifecycleEvent(e: LifecycleEvent, ctx: LifecycleContext): Promise<LifecycleOutcome> {
  const log = ctx.log ?? ((m: string) => console.log(`[lifecycle] ${m}`));
  const portal = ctx.portals.getPortal(e.portalId);
  const at = e.occurredAt ? Date.parse(e.occurredAt) : NaN;

  switch (kind(e)) {
    case 'uninstall': {
      if (portal && portal.uninstalledAt !== null && !portal.hasToken) {
        log(`portal ${e.portalId}: uninstall already handled`);
        return 'ignored-already-uninstalled';
      }
      if (portal?.installedAt && Number.isFinite(at) && portal.installedAt > at) {
        log(`portal ${e.portalId}: uninstall at ${e.occurredAt} is older than the latest install; ignored`);
        return 'ignored-stale-uninstall';
      }
      await ctx.installer.uninstall(e.portalId);
      return 'uninstalled';
    }
    case 'install': {
      if (!portal || !portal.hasToken || portal.uninstalledAt !== null) {
        log(`portal ${e.portalId}: install event but no OAuth tokens stored (callback not reached?). Ask the admin to reinstall.`);
        return 'install-without-tokens';
      }
      if (portal.provisionedAt !== null) return 'install-already-provisioned';
      await ctx.installer.provision(e.portalId);
      return 'provisioned';
    }
    default:
      log(`portal ${e.portalId}: unknown lifecycle event ${e.action ?? e.eventTypeId}`);
      return 'ignored-unknown';
  }
}
