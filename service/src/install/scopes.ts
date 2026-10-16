// Custom-object scopes: which ones we ask for, what a portal was granted, and when to ask again. Pure (tested).
//
// App scopes (src/install/app-scopes.ts, mirrors hubspot-app's app-hsmeta.json; decision D3):
//   requiredScopes               oauth + contacts/companies/deals read+write + crm.schemas.{contacts,companies,deals}.write
//   optionalScopes               crm.objects.custom.read, crm.schemas.custom.read
//   conditionallyRequiredScopes  crm.objects.custom.write, crm.schemas.custom.write
// HubSpot only asks for a conditionally required scope when it is in the install URL's `scope` parameter.
//
// CUSTOM_WRITE_MODE (env):
//   conditional (default)  /install asks required + optional. /install?custom=1 adds the 2 custom write scopes to
//                          `scope`. The OAuth callback chains to ?custom=1 automatically when the portal granted
//                          custom READ (Enterprise with custom objects) but not custom WRITE (needsCustomStep).
//   optional               /install puts the 2 custom write scopes in `optional_scope` too (one consent screen).
//                          To verify: an earlier REINSTALL did not grant optional object write; a fresh install may.

export const CUSTOM_READ_SCOPES = ['crm.objects.custom.read'];
export const CUSTOM_WRITE_SCOPES = ['crm.objects.custom.write', 'crm.schemas.custom.write'];

export type CustomWriteMode = 'optional' | 'conditional';

export function customWriteMode(value: string | undefined = process.env.CUSTOM_WRITE_MODE): CustomWriteMode {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '' || v === 'conditional') return 'conditional';
  if (v === 'optional') return 'optional';
  throw new Error(`Invalid CUSTOM_WRITE_MODE "${value}". Use "conditional" or "optional".`);
}

export interface AppScopeSets {
  required: string[];
  optional: string[];
  conditional: string[];
}

/** The `scope` and `optional_scope` lists for one install URL. */
export function installScopes(s: AppScopeSets, o: { custom?: boolean; mode: CustomWriteMode }): { scope: string[]; optionalScope: string[] } {
  const uniq = (xs: string[]) => [...new Set(xs)];
  if (o.mode === 'optional') return { scope: uniq(s.required), optionalScope: uniq([...s.optional, ...s.conditional]) };
  return { scope: uniq([...s.required, ...(o.custom ? s.conditional : [])]), optionalScope: uniq(s.optional) };
}

export interface CustomAccess {
  /** Custom read granted: the portal has custom objects (Enterprise) and we can list them. */
  available: boolean;
  /** Both custom write scopes granted: we can create properties on and stamp custom objects. */
  enabled: boolean;
}

export function customAccess(granted: string[]): CustomAccess {
  const g = new Set(granted);
  return { available: CUSTOM_READ_SCOPES.every((s) => g.has(s)), enabled: CUSTOM_WRITE_SCOPES.every((s) => g.has(s)) };
}

/**
 * After the OAuth callback: send the admin straight to the ?custom=1 consent screen?
 * Yes only in conditional mode, when custom read was granted but custom write wasn't, and this was not already
 * the second step (loop guard: if they decline or HubSpot still doesn't grant, we stop asking).
 */
export function needsCustomStep(granted: string[], mode: CustomWriteMode, step: 1 | 2): boolean {
  if (mode !== 'conditional' || step === 2) return false;
  const a = customAccess(granted);
  return a.available && !a.enabled;
}
