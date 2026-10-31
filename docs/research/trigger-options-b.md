> Research reference, written before v1 was built (Oct 2026). Check the current HubSpot docs before relying on any endpoint.

# Workflow trigger options without app-event approval (research B)

Outcome: v1 ships Option 1 with 7 properties. The trigger property is `changecatch_last_change_id`, not `changecatch_last_change_at`, and there is no summary property. See [../decisions.md](../decisions.md) and [../user-guide.md](../user-guide.md).

Date: 2026-10-30. Research only, nothing tested in a portal yet.
Labels: **[C]** means confirmed in the cited doc. **[I]** means inferred, so test it before relying on it.

## Key sources

| # | URL | Doc date |
|---|---|---|
| S1 | https://knowledge.hubspot.com/workflows/set-event-enrollment-triggers | updated 2026-08-03 |
| S2 | https://knowledge.hubspot.com/workflows/set-your-workflow-enrollment-triggers | updated 2026-09-04 |
| S3 | https://knowledge.hubspot.com/workflows/add-re-enrollment-triggers-to-a-workflow | updated 2026-10-15 |
| S4 | https://knowledge.hubspot.com/workflows/understand-workflow-object-types | updated 2026-09-01 |
| S5 | https://knowledge.hubspot.com/workflows/choose-your-workflow-actions | updated 2026-09-25 |
| S6 | https://developers.hubspot.com/docs/api-reference/latest/crm/properties/guide.md | no date shown (2026-09 version) |
| S7 | https://developers.hubspot.com/docs/api-reference/latest/crm/properties/create-property.md | 2026-09 spec |
| S8 | https://developers.hubspot.com/docs/api-reference/latest/crm/lists/guide.md | 2026-09 version |
| S9 | https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes | no date shown |
| S10 | https://developers.hubspot.com/docs/api-reference/latest/events/send-event-data/guide.md | 2026-09 version |
| S11 | https://developers.hubspot.com/docs/api-reference/events-manage-event-definitions-v3/guide | no date shown |
| S12 | https://developers.hubspot.com/docs/apps/developer-platform/list-apps/listing-your-app/app-marketplace-listing-requirements | no date shown |
| S13 | https://developers.hubspot.com/changelog/bugfix-integrations-and-crm-property-change-sources | changelog |
| S14 | https://knowledge.hubspot.com/data-management/track-crm-data-limits | updated 2026-06-20 |

## Tier baseline (applies to every option)

- Workflows need Professional or Enterprise (Marketing, Sales, Service, Data, Smart CRM, or Revenue Hub). [C, S2]
- Contact, company, and deal workflows are available on those tiers. Custom-object workflows are **Enterprise only**. [C, S4]
- Custom objects only exist on Enterprise anyway, so "custom objects need Enterprise" is no extra cost.

---

## Option 1: Property stamping + "Property value changed" trigger

**How it works.** On install, or when the admin picks a pair, the app creates a property group "ChangeCatch" plus properties on each watched object. The worker PATCHes the record for each change. The admin builds a workflow: trigger = "Property value changed" on `changecatch_last_change_at`, with re-enrollment on, plus refinement filters on the other stamped properties.

| Question | Answer |
|---|---|
| Trigger exists for deal / company / contact / custom object? | Yes. "Property value changed" is listed for **all workflow types**. [C, S1] |
| Tier | Pro+ for contact/company/deal workflows. Enterprise for custom-object workflows. [C, S2, S4] |
| Re-enrolls every time? | Yes, if the admin picks "Yes, re-enroll every time the trigger occurs". [C, S1] The trigger means "exactly one property changing from one value to another". [C, S1] **A write of the same value is not a change** [I, S3 plus community reports]. Fix: the trigger property must always get a new value, such as `changecatch_last_change_at` (ms timestamp) or an event counter or ID. |
| Refinement filters on the other stamped props | Refinement filters "must be met when the main event occurs". [C, S1] To make sure the filter sees the new values, write **all** ChangeCatch props in **one** PATCH, so they commit together. [I] |
| Race (two changes seconds apart) | Filters are checked at trigger time [C, S1]. Later workflow actions (branches, copy-property, webhooks) read the record's **current** value, not a snapshot [I, standard workflow behaviour]. A second change landing before an action runs will overwrite the first change's details. Mitigations: (a) the worker coalesces or serialises changes per record, for example at least about 10 s between stamps on the same record; (b) put the decisions in refinement filters, not later branches; (c) one workflow per change type, so the filter is evaluated at trigger time. The trigger itself still fires for each change, because each timestamp value is different. [I] |
| Property history / timeline | Every write appears in property history with source INTEGRATION and sourceId = app ID. [C, S13] This gives a free audit trail. It does not create a timeline activity card. [I] |
| Endpoints | Create: `POST /crm/properties/2026-09/{objectType}` (objectType can be `2-xxxx` for custom objects) [C, S7]. Group: `POST /crm/properties/2026-09/{objectType}/groups` [I, same API family]. Write values: `PATCH /crm/objects/2026-09/{objectType}/{id}` or `.../batch/update` (up to 100 per batch) [I: confirm path before coding]. |
| Scopes | Create properties: `crm.schemas.contacts.write`, `crm.schemas.companies.write`, `crm.schemas.deals.write` (all tiers) [C, S9]. Custom objects: `crm.schemas.custom.write`. This is the **only** custom-object scope accepted by create-property [C, S7], but it is **not listed** on the public scopes page [C, S9], and community and Workato reports say it was pilot-gated. **Biggest risk: test that an OAuth project app can request it.** Write values: `crm.objects.contacts.write`, `crm.objects.companies.write`, `crm.objects.deals.write`, and `crm.objects.custom.write` (Enterprise only) [C, S9]. |
| Fallback if `crm.schemas.custom.write` is not grantable | Ask the admin to create the ChangeCatch properties on the custom object themselves (with a setup checklist). The app then only needs `crm.objects.custom.write` to write values. [I] |
| Marketplace concern | The listing requirements say nothing against creating properties. Rules: request only the scopes you use, every requested scope must be used, and the Shared-data table must list the objects (read+write = "bi-directional"). [C, S12] Many listed apps create property groups [I]. Good practice: a "ChangeCatch" group, read-only display hint if available, and an optional cleanup on uninstall. |
| Property limits | Custom-property limits per object depend on the subscription. See the Product & Services Catalog. [C, S14] We add 6–8 per object, which is negligible. Up to 10 unique-ID props per object. [C, S6] |
| Data carried | Rich: change type (enum, filterable), label before/after (string, or enum if we sync label options), other object type, other record ID, current labels. Filterable with standard property operators. [I] |

**Recommended property set (per watched object):**
- `changecatch_last_change_at` (datetime): **the trigger property**. Always a new value.
- `changecatch_change_type` (enumeration: ADDED / REMOVED / LABEL_CHANGED): easy dropdown filter.
- `changecatch_other_object_type` (enumeration: the watched object types)
- `changecatch_other_record_id` (string)
- `changecatch_label_before` and `changecatch_label_after` (string; optionally an enumeration kept in sync with the pair's labels, which gives admins a dropdown)
- `changecatch_labels_current` (string or multi-checkbox)
- `changecatch_change_summary` (string, human-readable, e.g. "Deal 123: Influencer -> Decision maker"): for the timeline, emails, and tasks.

## Option 2: Static list membership + "List membership changed"

| Question | Answer |
|---|---|
| Objects | The trigger supports Contact, Company, Deal, and Custom object. [C, S1] MANUAL segments can be created through the API. [C, S8] The guide only shows `0-1`, so custom-object MANUAL lists are [I]: very likely, given the trigger support. |
| Re-enroll | Event trigger with "re-enroll every time" [C, S1]. The record must **leave and rejoin** to fire again [C, S3 for contact lists, I for others]. So the app must remove the record after each add, which doubles the API calls. |
| Endpoints | `POST /crm/lists/2026-09/`, `PUT /crm/lists/2026-09/{listId}/memberships/add`, `/remove`, `/add-and-remove`. [C, S8] |
| Scopes | `crm.lists.write` plus read (all tiers). [C, S9] |
| Data | **None.** It must be paired with stamped properties anyway, which makes Option 1 strictly simpler. One small upside: one list per change type gives a no-filter trigger. [I] |
| Downsides | Clutters the customer's segments. Race on remove/re-add. Two API calls per change. No extra capability over Option 1. |

## Option 3: Custom (behavioral) events

| Question | Answer |
|---|---|
| Objects | Definitions can use `primaryObject` CONTACT, COMPANY, DEAL, TICKET, or a custom object name. [C, S11] But the workflow trigger "Custom event occurs" is listed for **Contact only**. [C, S1] Only Agent Hub lists an "All custom events" trigger with no object. |
| Tier | Creating definitions needs `behavioral_events.event_definitions.read_write`, which is **Marketing Hub Enterprise only**. Sending needs `analytics.behavioral_events.send` (Pro/Ent). [C, S9] The UI also requires Enterprise. [C, S10] |
| Data | Up to 50 properties per event, values up to 256 chars. [C, S10, S11] Event properties are filterable as refinements in contact workflows [I]. |
| Endpoints | `POST /events/2026-09/send`, batch of 500. [C, S10] Definitions: `events/2026-03/event-definitions`. |
| Verdict | **Not viable for v1**: Marketing Enterprise only, and deal/company/custom-object workflows cannot use it. |

Side note: "Integration event occurs" (app timeline events) supports Contact, Company, Deal, and Ticket, but **not custom objects**. [C, S1] This is the same family as app events, which we are avoiding.

## Option 4: Hybrid design (one JSON property vs. several properties)

- **One JSON / summary property:** a workflow filter can only do "contains" on text, so it is fragile for non-technical admins. Labels with commas or quotes break filters. Readable in emails, but not in filters. [I]
- **Several typed properties (recommended):** the admin sees a normal dropdown "ChangeCatch change type is LABEL_CHANGED" and "label after is Decision maker". This is the same as any native property, with no training needed. Keep **one** extra `changecatch_change_summary` text for display and notifications. [I]
- Ship **ready-made workflow recipes** in the setup docs: "Deal label changed to Decision maker", "Contact unlinked from Company". Admin setup: pick object pairs in app settings, then build one workflow (about 3 clicks + 2 filters).

## Comparison

| Option | Custom objects | Re-enroll every time | Filterable data | Customer tier | Approval | Setup effort | Marketplace OK |
|---|---|---|---|---|---|---|---|
| 1 Property stamping | Yes [C], if a schema scope or a manual property creation is possible | Yes, with a timestamp trigger [C/I] | Yes, rich | Pro (std), Ent (custom) [C] | None | Low | Yes [I] |
| 2 Static list | Likely [I] | Yes, remove + re-add [I] | None (needs props) | Pro / Ent | None | Medium | Yes, but clutter |
| 3 Custom events | No (Contact-only trigger) [C] | Yes | Yes | **Marketing Ent** [C] | None | Medium | Yes |
| 4 Typed props + summary | Same as 1 | Same as 1 | Best UX | Same as 1 | None | Lowest | Yes |

## Tests to run before building
1. Can a 2026.09 project OAuth app request `crm.schemas.custom.write`? Can it create a property on `2-xxxx`?
2. Does writing the **same** value re-enroll? (Expected no; the timestamp design avoids it.)
3. Two changes on one record about 2 s apart: do both enrollments see their own `change_type` in the refinement filter?
4. Delay from PATCH to workflow enrollment.
