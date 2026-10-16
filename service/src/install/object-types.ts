// Object types the admin can pick in settings: the 3 standard ones our scopes cover + the portal's custom objects.
// Uses the CUSTOMER token.
// Custom objects: GET /crm-object-schemas/2026-09/schemas (scope crm.schemas.custom.read)
//   https://developers.hubspot.com/docs/api-reference/latest/crm/objects/schemas/guide
//   Response fields confirmed live: objectTypeId, labels.singular/plural, archived.
// Tickets etc. are left out on purpose: we have no scopes for them (src/install/app-scopes.ts).

import { HttpError, hsRequest } from '../lib/http.js';
import { STANDARD_OBJECTS } from './pairs.js';

export interface ObjectTypeOption {
  objectTypeId: string;
  label: string;
  custom: boolean;
}

interface SchemaRow {
  objectTypeId?: string;
  id?: string;
  labels?: { singular?: string; plural?: string };
  name?: string;
  archived?: boolean;
}

export async function listObjectTypes(token: string): Promise<ObjectTypeOption[]> {
  const out: ObjectTypeOption[] = STANDARD_OBJECTS.map((o) => ({ ...o, custom: false }));
  try {
    const res = await hsRequest<{ results?: SchemaRow[] }>('/crm-object-schemas/2026-09/schemas', { token });
    for (const s of res?.results ?? []) {
      if (s.archived) continue;
      const id = s.objectTypeId ?? (s.id ? `2-${s.id}` : undefined);
      if (!id) continue;
      out.push({ objectTypeId: id, label: s.labels?.singular ?? s.name ?? id, custom: true });
    }
  } catch (e) {
    // 403 = no custom-object scope/tier (non-Enterprise). Standard objects still work.
    if (!(e instanceof HttpError && (e.status === 403 || e.status === 404))) throw e;
  }
  return out;
}
