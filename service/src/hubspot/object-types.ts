// Object types the admin can pick in settings: the supported standard ones (core/contract.ts) + the portal's custom
// objects. Uses the CUSTOMER token.
// Custom objects: GET /crm-object-schemas/2026-09/schemas (scope crm.schemas.custom.read)
//   https://developers.hubspot.com/docs/api-reference/latest/crm/objects/schemas/guide
//   Response fields confirmed live: objectTypeId, labels.singular/plural, archived.

import { STANDARD_OBJECTS } from '../core/contract.js';
import { HUBSPOT_API_VERSION, hsRequest, HubSpotError, type PortalAuth } from '../lib/http.js';

export interface ObjectTypeOption {
  objectTypeId: string;
  singular: string;
  plural: string;
  custom: boolean;
}

interface SchemaRow {
  objectTypeId?: string;
  id?: string;
  labels?: { singular?: string; plural?: string };
  name?: string;
  archived?: boolean;
}

/** The portal's (non-archived) custom object types. 403/404 = no custom-object scope or tier (non-Enterprise) = none. */
export async function listCustomObjectTypes(auth: PortalAuth): Promise<ObjectTypeOption[]> {
  const out: ObjectTypeOption[] = [];
  try {
    const res = await hsRequest<{ results?: SchemaRow[] }>(`/crm-object-schemas/${HUBSPOT_API_VERSION}/schemas`, { ...auth });
    for (const s of res?.results ?? []) {
      if (s.archived) continue;
      const id = s.objectTypeId ?? (s.id ? `2-${s.id}` : undefined);
      if (!id) continue;
      const singular = s.labels?.singular ?? s.name ?? id;
      out.push({ objectTypeId: id, singular, plural: s.labels?.plural ?? singular, custom: true });
    }
  } catch (e) {
    if (!(e instanceof HubSpotError && (e.status === 403 || e.status === 404))) throw e;
  }
  return out;
}

export async function listObjectTypes(auth: PortalAuth): Promise<ObjectTypeOption[]> {
  const standard = STANDARD_OBJECTS.filter((o) => o.supported).map(({ objectTypeId, singular, plural }) => ({ objectTypeId, singular, plural, custom: false }));
  return [...standard, ...(await listCustomObjectTypes(auth))];
}
