// The app lifecycle in HubSpot: the two app-level APP_LIFECYCLE_EVENT journal subscriptions (kept alive by the API
// server), reading install/uninstall events from the journal, and the HubSpot side of an uninstall (run by the worker,
// src/worker/lifecycle.ts). Subscription calls use the APP-LEVEL client credentials token (./journal.ts).
// Docs: https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/subscriptions/guide

import { createLogger, type Logger } from '../obs/log.js';
import type { PortalStore } from '../store/portals.js';
import type { SubscriptionApi } from './journal.js';
import type { TokenProvider } from './portal-tokens.js';

export const APP_EVENT_TYPE = {
  INSTALL: '4-1909196',
  UNINSTALL: '4-1916193',
} as const;

/**
 * A journal entry's app lifecycle kind, or null for anything else. Payload (docs example, docs/research/journal.md section 6):
 * { type: "app_lifecycle_event", action: "APP_INSTALL" | "APP_UNINSTALL", eventTypeId: APP_EVENT_TYPE.*, portalId, occurredAt }.
 */
export function appLifecycleKind(e: { type: string; action?: string; eventTypeId?: unknown }): 'install' | 'uninstall' | null {
  if (e.type !== 'app_lifecycle_event') return null;
  if (e.action === 'APP_UNINSTALL' || e.eventTypeId === APP_EVENT_TYPE.UNINSTALL) return 'uninstall';
  if (e.action === 'APP_INSTALL' || e.eventTypeId === APP_EVENT_TYPE.INSTALL) return 'install';
  return null;
}

/** Properties seen in the docs' APP_INSTALL example payload (docs/research/journal.md section 6). */
const LIFECYCLE_PROPERTIES = ['hs_app_id', 'hs_app_install_level', 'hs_initiating_user_id', 'hs_user_id'];

/**
 * Make sure the two app-level APP_LIFECYCLE_EVENT subscriptions (install, uninstall) exist.
 * No portalId: they cover every portal. Creates only what's missing.
 */
export async function ensureLifecycleSubscriptions(
  api: Pick<SubscriptionApi, 'listSubscriptions' | 'createSubscription'>,
): Promise<{ created: string[]; existing: string[] }> {
  const all = await api.listSubscriptions();
  const have = new Set(all.filter((s) => s.subscriptionType === 'APP_LIFECYCLE_EVENT' && !s.deletedAt).map((s) => s.eventTypeId));
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

const LIFECYCLE_SUB_CHECK_MS = 10 * 60 * 1000;

/**
 * Self-heal: the lifecycle subs were once found deleted after an uninstall (seen 2026-10-30 in testing; cause unknown).
 * Runs ensureLifecycleSubscriptions at start and then every intervalMs (default LIFECYCLE_SUB_CHECK_MS, 10 min).
 * Never throws; overlapping checks are skipped; the timer is unref'd so it never keeps the process alive.
 */
export function startLifecycleSubscriptionWatch(opts: {
  api: Pick<SubscriptionApi, 'listSubscriptions' | 'createSubscription'>;
  intervalMs?: number;
  log?: Logger;
}): { check: () => Promise<{ created: string[]; existing: string[] } | null>; stop: () => void; ready: Promise<unknown> } {
  const api = opts.api;
  const log = opts.log ?? createLogger('lifecycle-subs');
  const intervalMs = opts.intervalMs ?? LIFECYCLE_SUB_CHECK_MS;
  let running = false;
  let first = true;

  async function check() {
    if (running) return null;
    running = true;
    try {
      const r = await ensureLifecycleSubscriptions(api);
      const what = `lifecycle subscription(s) [${r.created.join(', ')}]; existing [${r.existing.join(', ')}]`;
      if (r.created.length && !first) log.warn('lifecycle_subscriptions_recreated', `MISSING, recreated ${what}`, { created: r.created });
      else if (r.created.length) log.info('lifecycle_subscriptions_created', `created ${what}`, { created: r.created });
      else if (first) log.info('lifecycle_subscriptions_ok', `lifecycle subscriptions OK [${r.existing.join(', ')}]; re-checking every ${Math.round(intervalMs / 1000)}s`);
      return r;
    } catch (e) {
      log.error('lifecycle_subscriptions_failed', `lifecycle subscription check FAILED: ${(e as Error).message}`, { error: e });
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

export interface UninstallDeps {
  subscriptions: Pick<SubscriptionApi, 'deletePortalSubscriptions'>;
  portals: Pick<PortalStore, 'markUninstalled'>;
  tokens: Pick<TokenProvider, 'forget'>;
  now: () => number;
  log: Logger;
}

/**
 * Uninstall one portal: FIRST mark it uninstalled (refresh token wiped) and forget its cached access token, so no
 * customer token outlives the uninstall; THEN delete its journal subscriptions (app token, not the portal's). Throws if
 * HubSpot fails; the caller (worker/lifecycle.ts) keeps a lifecycle_retry row until this succeeds. Safe to repeat.
 */
export async function uninstallPortal(d: UninstallDeps, portalId: number): Promise<void> {
  d.portals.markUninstalled(portalId, d.now());
  d.tokens.forget(portalId);
  await d.subscriptions.deletePortalSubscriptions(portalId);
  d.log.info('portal_uninstalled', `portal ${portalId} uninstalled: token wiped, subscriptions deleted`, { portalId });
}
