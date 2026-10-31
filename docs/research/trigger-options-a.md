> Research reference, written before v1 was built (Oct 2026). Check the current HubSpot docs before relying on any endpoint.

# Workflow trigger options without app-event approval (research A)

Researched 2026-10-30. Legend: **[C]** = confirmed in the cited doc. **[I]** = inferred, or only from community or third-party sources. Test these before relying on them.

## Baseline facts

- **App events need approval.** [C] "intended only for technology partners, and requires approval from HubSpot to use". New event types also go through a review: "New event types are subject to a review process before they can be activated". App events support custom objects. https://developers.hubspot.com/docs/apps/developer-platform/add-features/app-events/overview.md and .../create-and-manage-event-types.md
- **Event trigger list (KB, updated Aug 3, 2026).** [C] There is no association trigger. "Integration event occurs" covers contacts, companies, deals and tickets only. Re-enrollment is a per-workflow setting: "Yes, re-enroll every time the trigger occurs". https://knowledge.hubspot.com/workflows/set-event-enrollment-triggers

---

## 1. "When a webhook is received" workflow trigger

Source: https://knowledge.hubspot.com/workflows/set-when-a-webhook-is-received-workflow-triggers (updated Sep 7, 2026)

- **Tier:** [C] Marketing, Sales, Service, Data Hub or Smart CRM, at Professional or Enterprise.
- **Record matching:** [C] HubSpot matches a webhook field to a *custom property that has "Require unique values" turned on*. "The workflow will only trigger if there is an existing record with a corresponding unique property value". The value must not be empty. The KB does **not** mention matching on record ID.
  - So our app would have to create a unique property on every watched object (for example `changecatch_key = recordId`) and fill it in on every record. That is a backfill on large portals.
  - [I] HubSpot caps unique-value properties at about 10 per object. Check this.
  - Community report: some deals enrolled even though the ID field was empty. https://community.hubspot.com/t5/APIs-Integrations/Unexpected-Workflow-Enrollments-Triggered-by-Webhook-Events/m-p/1222629
- **Objects:** [I] The KB does not list the workflow types it supports. Custom objects are unconfirmed, so we need to test this.
- **Payload:** [C] JSON only. Each field maps to string, enum, number or boolean; datetime is not supported. You can define up to 100 webhook events. [I] The mapped fields work as trigger refinement filters. This is likely but not stated.
- **Re-enrollment:** [I] It is an event trigger, so the standard "re-enroll every time" option should apply. The KB does not say.
- **Setup:** [C] The URL is created per webhook event inside the workflow. The customer copies it, our app sends a test event, then the customer maps fields and picks the match property. So every workflow needs the customer to paste its URL into our settings page.
- **Auth and rate limits:** [C] The KB does not document either. [I] The URL itself is the secret.
- **Approval:** none. [I] Marketplace-acceptable.

## 2. Enrolling records through the API

- **Legacy v2 endpoint:** [C] `POST /automation/v2/workflows/{workflowId}/enrollments/contacts/{email}`. It works for **contacts only**, matches by email, and returns 204 without validating anything. https://developers.hubspot.com/docs/api-reference/legacy/automation/workflows/v2/enroll-contact.md
  - Per the changelog (Sep 15, 2026), v1–v3 endpoints are unsupported after Sep 2027. https://developers.hubspot.com/changelog/legacy-apis-and-legacy-apps-whats-going-unsupported-and-when
- **Date-based Workflows API:** [C] It is a public beta (2027-03-beta) and needs the `automation` scope. It covers create, read, update and delete for flows. I found **no enroll-record endpoint**. https://developers.hubspot.com/docs/api-reference/2027-03-beta/automation/workflows/guide.md
  - The guide mentions "enroll records" only when it lists the sensitive-data write scopes.
- **What the API trigger types allow:** [C] Enrollment criteria types are LIST_BASED, EVENT_BASED, MANUAL and DATASET. There is no webhook trigger type and no "API enroll" trigger type.
- **Verdict:** this option does not exist for non-contact objects.

## 3. New 2025–2026 trigger features

- **No app-defined trigger feature.** [C] The Fall 2026 spotlight (Sep 15, 2026) and the Spring 2026 spotlight have no "custom workflow trigger" or "app-defined trigger".
  - Agent tools (BETA) and MCP server components are *actions* that agents call. They are not triggers.
  - https://developers.hubspot.com/changelog/fall-2026-spotlight
  - https://developers.hubspot.com/changelog/spring-2026-spotlight
- **Objectless custom events (Fall 2026).** [C] These events are not stored, and the docs say they "can only be used to trigger workflows". They carry no record, so they cannot enroll a specific Deal or custom object record. Custom events also need Enterprise (already known). https://developers.hubspot.com/docs/api-reference/legacy/events/define-events/guide
- **Association triggers in HubSpot itself.** [C] The 2026 association workflow features are *actions* (create, label, remove), not triggers. https://knowledge.hubspot.com/workflows/manage-crm-record-associations-with-workflows (updated Apr and Aug 2026)
  - [I] I found no new association enrollment trigger in 2026.
- **Journal list-membership subscriptions (Spring 2026).** These are useful for reading changes, not for triggering workflows.

## 4. Legacy timeline events

- [C] "Existing timeline event integrations will continue to function", but "you cannot create new event types using the v1 and v3 APIs". New ones must be recreated as app events, so they go through the same approval.
- Legacy apps cannot be listed on the Marketplace from Nov 2, 2026.
- "Integration event occurs" never covered custom objects.
- **Verdict:** this is not an option for us.

---

## Comparison

| Option | Custom objects | Re-enrolls | Filterable data | Tier | Approval | Customer setup | Marketplace OK |
|---|---|---|---|---|---|---|---|
| Property stamping + "Property value changed" | Yes | Yes (when the value changes) | Partly (property values) | Pro | None | Low | Yes |
| Webhook-received trigger | Unknown [I] | Likely [I] | Yes, mapped fields [I] | Pro [C] | None | High: per workflow URL, plus a unique property | Likely [I] |
| App events | Yes [C] | Yes [I] | Yes [C] | Pro [I] | **Yes** [C] | Low | Yes |
| v2 enroll API | No (contacts only) [C] | Yes | No | Pro | None | Medium | Sunset Sep 2027 |
| Objectless custom events | No record enrolled | n/a | n/a | Enterprise | None | Medium | n/a |
| Timeline events | No [C] | n/a | n/a | n/a | Yes | n/a | No (legacy) |

## Ranked recommendation

1. **Property stamping + "Property value changed".** Ship this now: it needs no approval and works on all objects.
2. **App events.** Apply for approval in parallel, since it is the best long-term trigger.
3. **Webhook-received trigger.** Offer it as an optional power-user mode. Test custom objects and filters first.
4. **v2 enroll API.** Do not use it: contacts only, and dying.
5. **Objectless custom events and timeline events.** Not usable.
