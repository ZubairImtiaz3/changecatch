// The settings contract (GET/POST /api/settings): body parsing and validation, defaults, which saved pairs are
// active, and the view the settings page renders. The page (hubspot-app/src/app/settings/ChangeCatchSettings.tsx)
// keeps no copies of these facts; it renders what GET returns. settings.test.ts pins the response shape it relies on.
//
// Saved vs active pairs: the admin's saved pairs (portal_settings) are kept as they are, but a pair with a custom
// object is ACTIVE only while the portal has both custom write scopes (core/pairs.ts). Only active pairs get
// properties and journal subscriptions, and only they are watched by the worker.

import { standardObject } from '../core/contract.js';
import type { WatchedPair } from '../core/types.js';
import { DEFAULT_STAMP_SPACING_SECONDS } from '../store/schema.js';
import type { PortalStore } from '../store/portals.js';
import type { ObjectTypeOption } from '../hubspot/object-types.js';
import { type CustomAccess, DEFAULT_PAIRS, hasCustomObject, isObjectTypeId, isPairActive, normalisePairs, objectPairKey, portalPairs } from '../core/pairs.js';

/** Stamp spacing in seconds. The page offers the presets; the server accepts any whole number from min to max. */
export const SPACING = {
  default: DEFAULT_STAMP_SPACING_SECONDS,
  min: 1,
  max: 600,
  presets: [3, 5, 10, 30, 60], // starts at the recommended 3 s (owner, 2026-11-07)
} as const;

const MAX_PAIRS = 200;

export class SettingsValidationError extends Error {}

export interface SettingsInput {
  watchedPairs: WatchedPair[];
  stampSpacingSeconds: number;
}

/** Parse + validate the POST body. Pairs are checked against the portal by checkNewPairs (inside the installer's lock). */
export function parseSettingsBody(raw: string): SettingsInput {
  let b: any;
  try {
    b = JSON.parse(raw || '{}');
  } catch {
    throw new SettingsValidationError('Body is not JSON');
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new SettingsValidationError('Body must be a JSON object');
  if (!Array.isArray(b.watchedPairs)) throw new SettingsValidationError('watchedPairs must be an array');
  if (b.watchedPairs.length > MAX_PAIRS) throw new SettingsValidationError(`Too many pairs (max ${MAX_PAIRS})`);
  const watchedPairs = b.watchedPairs.map((p: any) => {
    if (!p || !isObjectTypeId(p.objectTypeId) || !isObjectTypeId(p.associatedObjectTypeId)) {
      throw new SettingsValidationError('Each pair needs objectTypeId and associatedObjectTypeId like "0-3"');
    }
    return { objectTypeId: p.objectTypeId, associatedObjectTypeId: p.associatedObjectTypeId };
  });
  const stampSpacingSeconds = Number(b.stampSpacingSeconds);
  if (!Number.isInteger(stampSpacingSeconds) || stampSpacingSeconds < SPACING.min || stampSpacingSeconds > SPACING.max) {
    throw new SettingsValidationError(`stampSpacingSeconds must be a whole number from ${SPACING.min} to ${SPACING.max}`);
  }
  return { watchedPairs, stampSpacingSeconds };
}

/**
 * Pairs the admin ADDS must use object types that exist in the portal, and custom ones need custom write.
 * Pairs that are already saved may always stay (e.g. a custom pair kept while custom write is missing).
 */
export function checkNewPairs(pairs: WatchedPair[], o: { saved: WatchedPair[]; objectTypes: ObjectTypeOption[]; access: CustomAccess }): void {
  const saved = new Set(normalisePairs(o.saved).map(objectPairKey));
  const known = new Set(o.objectTypes.map((t) => t.objectTypeId));
  for (const p of normalisePairs(pairs)) {
    if (saved.has(objectPairKey(p))) continue;
    if (!known.has(p.objectTypeId) || !known.has(p.associatedObjectTypeId)) {
      throw new SettingsValidationError(`Unknown object type in pair ${p.objectTypeId} <-> ${p.associatedObjectTypeId}`);
    }
    if (hasCustomObject(p) && !o.access.enabled) {
      throw new SettingsValidationError(
        'Custom objects need two extra permissions (crm.objects.custom.write, crm.schemas.custom.write). Use "Enable custom objects" first.',
      );
    }
  }
}

/** GET /api/settings (and the body of a successful POST). Pinned by settings.test.ts; the settings page reads it. */
export interface SettingsView {
  portalId: number;
  /** Display order: standard objects by STANDARD_OBJECTS rank, then custom objects by name. Custom ones are selectable only with custom write. */
  objectTypes: (ObjectTypeOption & { selectable: boolean })[];
  customObjectsAvailable: boolean;
  customObjectsEnabled: boolean;
  enableCustomObjectsUrl: string | null;
  watchedPairs: (WatchedPair & { active: boolean })[];
  recommendedPairs: WatchedPair[];
  stampSpacingSeconds: number;
  spacing: { default: number; min: number; max: number; presets: number[] };
  lastProvisionError: string | null;
}

const displayRank = (t: ObjectTypeOption) => (t.custom ? Infinity : (standardObject(t.objectTypeId)?.rank ?? Infinity));
const byDisplayOrder = (a: ObjectTypeOption, b: ObjectTypeOption) => displayRank(a) - displayRank(b) || a.singular.localeCompare(b.singular);

export function settingsView(
  portals: Pick<PortalStore, 'getPortal' | 'getWatchedPairs' | 'getStampSpacingSeconds'>,
  portalId: number,
  objectTypes: ObjectTypeOption[],
  enableCustomObjectsUrl: string | null,
): SettingsView {
  const portal = portals.getPortal(portalId);
  const { saved, access } = portalPairs(portals, portalId);
  return {
    portalId,
    objectTypes: [...objectTypes]
      .sort(byDisplayOrder)
      .map((t) => ({ ...t, selectable: !t.custom || access.enabled })),
    customObjectsAvailable: access.available,
    customObjectsEnabled: access.enabled,
    enableCustomObjectsUrl,
    watchedPairs: saved.map((p) => ({ ...p, active: isPairActive(p, access) })),
    recommendedPairs: [...DEFAULT_PAIRS],
    stampSpacingSeconds: portals.getStampSpacingSeconds(portalId),
    spacing: { ...SPACING, presets: [...SPACING.presets] },
    // Stored provisioning errors can hold HubSpot response text: only say whether there was one.
    lastProvisionError: portal?.lastProvisionError ? 'The last setup attempt did not finish.' : null,
  };
}
