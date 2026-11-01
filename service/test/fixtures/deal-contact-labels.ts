// Real Deal->Contact association types from the HubSpot test portal (2026-10-30 load tests).
// 3 = unlabeled default (HUBSPOT_DEFINED); 247/249/251 = custom labels (USER_DEFINED).
import type { LabelDefinition } from '../../src/store/db.js';

export const HD = 'HUBSPOT_DEFINED';

export const DEAL_CONTACT_LABELS: LabelDefinition[] = [
  { associationTypeId: 3, label: null, category: HD },
  { associationTypeId: 247, label: 'Decision maker', category: 'USER_DEFINED' },
  { associationTypeId: 249, label: 'Influencer', category: 'USER_DEFINED' },
  { associationTypeId: 251, label: 'Billing contact', category: 'USER_DEFINED' },
];
