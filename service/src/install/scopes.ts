// The app's OAuth scope sets, the install URL scope lists, and when to ask again for the custom-object write scopes
// (decision D3). Pure (tested). What a portal was granted: core/pairs.ts customAccess.
//
// APP_SCOPES is built from the object table in core/contract.ts. Source of truth for HubSpot:
// hubspot-app/src/app/app-hsmeta.json (config.auth). HubSpot enforces that file; this is a copy so the service never
// reads another package's files at runtime (the deployed service may not ship hubspot-app/). scopes.test.ts fails if
// the two drift: change BOTH in the same commit.
//
// HubSpot only asks for a conditionally required scope when it is in the install URL's `scope` parameter.
// /install asks required + optional. /install?custom=1 adds the 2 custom write scopes to `scope`. The OAuth callback
// chains to ?custom=1 automatically when the portal granted custom READ (Enterprise with custom objects) but not
// custom WRITE (needsCustomStep). HubSpot never granted optional custom WRITE, even on a fresh install (tested).

import { CUSTOM_OBJECT_SCOPES as C, STANDARD_OBJECTS } from '../core/contract.js';
import { customWriteMissing } from '../core/pairs.js';

export const APP_SCOPES: Readonly<{ required: string[]; optional: string[]; conditional: string[] }> = Object.freeze({
  required: [
    'oauth',
    ...STANDARD_OBJECTS.filter((o) => o.supported).flatMap((o) => [o.readScope, o.writeScope, o.schemaWriteScope].filter((s) => s !== undefined)),
  ],
  optional: [C.objectRead, C.schemaRead],
  conditional: [C.objectWrite, C.schemaWrite],
});

/** The `scope` and `optional_scope` lists for one install URL (custom: the ?custom=1 step). */
export function installScopes(o: { custom?: boolean } = {}): { scope: string[]; optionalScope: string[] } {
  const uniq = (xs: string[]) => [...new Set(xs)];
  return { scope: uniq([...APP_SCOPES.required, ...(o.custom ? APP_SCOPES.conditional : [])]), optionalScope: uniq(APP_SCOPES.optional) };
}

/**
 * After the OAuth callback: send the admin straight to the ?custom=1 consent screen?
 * Yes when custom read was granted but custom write wasn't, and this was not already the second step
 * (loop guard: if they decline or HubSpot still doesn't grant, we stop asking).
 */
export function needsCustomStep(granted: string[], step: 1 | 2): boolean {
  return step === 1 && customWriteMissing(granted);
}
