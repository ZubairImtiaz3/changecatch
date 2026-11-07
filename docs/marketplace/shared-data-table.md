# Shared data table (for the Marketplace listing)

Last checked: **2026-10-30**. It matches the scopes in [scopes.md](scopes.md) §4.1. **Update this file whenever the scopes change.**

## The rules this table follows
- *"All objects selected in your OAuth scopes should be documented in the Shared data table."*
- *"If your app is requesting both read and write object scopes, the data sync should be advertised as bi-directional for these specific objects."*
  (https://developers.hubspot.com/docs/apps/developer-platform/list-apps/listing-your-app/app-marketplace-listing-requirements)
- In the listing editor (App details → **Add shared data**), each row is: *app object* ↔ *HubSpot object* + *direction*. A short description goes with each row.

We request read **and** write scopes on all 4 object types, so every row is **bi-directional**, even though in practice the data mostly flows *into* HubSpot. The description below explains what really moves.

---

## Rows to enter in the listing editor

| App object | HubSpot object | Direction | Description to paste (≤ about 300 characters) |
|---|---|---|---|
| Association change | Contacts | Bi-directional | Reads association changes and label names for the contact pairs you choose. Writes the change details (type, other record, labels before/after, current labels) into app-owned "ChangeCatch" properties on the contact, so workflows can trigger. |
| Association change | Companies | Bi-directional | Same as contacts, for companies: reads association changes and label names, and writes the change details into app-owned "ChangeCatch" properties on the company. |
| Association change | Deals | Bi-directional | Same as contacts, for deals: reads association changes and label names, and writes the change details into app-owned "ChangeCatch" properties on the deal. |
| Association change | Custom objects (Enterprise only, opt-in) | Bi-directional | Only if you enable custom objects. Lists your custom objects, reads association changes and label names, and writes the change details into app-owned "ChangeCatch" properties on the custom object record. |

---

## Detail per object (for the setup guide, the privacy policy, and reviewer questions)

### What we READ from HubSpot
| Data | Objects | How | Scope |
|---|---|---|---|
| Association added / removed events: portal ID, object type IDs, record IDs, association type ID, category, timestamp | The pairs the admin picks (Contacts, Companies, Deals, custom objects) | Webhooks Journal (app-level; HubSpot publishes these to us) | App client-credentials journal scopes (not customer install scopes) |
| Association label definitions (label ID → label name, category) | Each watched pair | `GET /crm/associations/2026-09/{from}/{to}/labels` | `crm.objects.<object>.read` |
| Custom object definitions (object type ID, singular/plural name) | Custom objects | `GET /crm-object-schemas/2026-09/schemas` | `crm.schemas.custom.read` |
| Our own property and group definitions (to check whether they already exist) | All watched object types | `GET /crm/properties/2026-09/{object}` and `/groups` | `crm.schemas.<object>.write` (also covers read) |
| App install / uninstall events | n/a | Webhooks Journal `APP_LIFECYCLE_EVENT` | App-level |

**We do NOT read** names, emails, phone numbers, deal amounts or any other record property values. We don't read engagements, files or users.

### What we WRITE to HubSpot
| Data | Objects | How | Scope |
|---|---|---|---|
| A property group "ChangeCatch", plus 7 properties: `changecatch_last_change_id`, `changecatch_change_type`, `changecatch_other_object_type`, `changecatch_other_record_id`, `changecatch_labels_before`, `changecatch_labels_after`, `changecatch_labels_current` | Each watched object type | `POST/PATCH /crm/properties/2026-09/{object}` | `crm.schemas.<object>.write` |
| Dropdown options for the 3 label properties, kept in sync with the portal's label names | Same | `PATCH /crm/properties/2026-09/{object}/{name}` | `crm.schemas.<object>.write` |
| Values of the 7 `changecatch_*` properties on the record whose association changed (one side of each pair; see [../user-guide.md](../user-guide.md), "Which record gets updated?") | Watched records | `POST /crm/objects/2026-09/{object}/batch/update` | `crm.objects.<object>.write` |

**We do NOT** create, delete or merge records. We don't create, change or delete associations or labels. We don't change any property that isn't ours.

### What we STORE on our side (outside HubSpot)
| Data | Why | Kept for |
|---|---|---|
| HubSpot portal ID, encrypted OAuth refresh token, granted scopes, install / uninstall times | To act for the portal | Token and watched pairs deleted at uninstall. The token-less portal row (ID and times) is kept to recognise late uninstall events, then deleted after **30 days**. |
| Settings: the chosen object pairs, stamp spacing | Configuration | Deleted at uninstall |
| Label cache: label IDs and names per object pair | Turning label IDs into names | Refreshed on demand, up to **30 days**. Deleted at uninstall |
| Change log: change ID, portal ID, object type IDs, record IDs, change type, label names, timestamps | Lookups, debugging, idempotency | **30 days**, then deleted automatically. Deleted at uninstall |
| De-duplication keys (journal offset plus event identity) | Avoid double stamps | **4 days** |
| Pending stamp queue | Retry if HubSpot is busy | Until sent. Deleted at uninstall |
| Last known labels per record pair (record IDs plus label names) | Working out "labels before" | Up to **90 days** after the last change. Deleted at uninstall |
| Counters (events processed per portal, last event time) | Monitoring | Deleted at uninstall |

No personal data fields (names, emails and so on) are stored. Record IDs and label names may still count as personal data under GDPR when they relate to a contact, so the privacy policy treats them carefully.

---

## If app events are added later
App events need HubSpot partner approval and are a later upgrade, not part of v1. When they ship: add a row per object, "Association changed event → <object> → To HubSpot". Add `timeline.write` to the scope table and resubmit the listing.
