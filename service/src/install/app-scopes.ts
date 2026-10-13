// The app's OAuth scopes, as the service uses them to build install URLs.
//
// Source of truth: hubspot-app/src/app/app-hsmeta.json (config.auth). HubSpot enforces that file; this is a
// copy so the service never reads another package's files at runtime (the deployed service may not ship
// hubspot-app/). app-scopes.test.ts fails if the two drift: change BOTH in the same commit.
import type { AppScopeSets } from './scopes.js';

export const APP_SCOPES: Readonly<AppScopeSets> = Object.freeze({
  required: [
    'oauth',
    'crm.objects.contacts.read',
    'crm.objects.contacts.write',
    'crm.objects.companies.read',
    'crm.objects.companies.write',
    'crm.objects.deals.read',
    'crm.objects.deals.write',
    'crm.schemas.contacts.write',
    'crm.schemas.companies.write',
    'crm.schemas.deals.write',
  ],
  optional: ['crm.objects.custom.read', 'crm.schemas.custom.read'],
  conditional: ['crm.objects.custom.write', 'crm.schemas.custom.write'],
});
