> Research reference, written before v1 was built (Oct 2026). Check the current HubSpot docs before relying on any endpoint.

# Trigger options C: what an app itself can add to the workflow editor

Outcome: v1 ships plain property stamping (7 properties, trigger on `changecatch_last_change_id`) with **no** custom workflow action. See [../decisions.md](../decisions.md).

Research date: 2026-10-30. Scope: app-defined triggers, custom workflow actions, other app surfaces.
Webhook-triggered workflows, the enrollment API, property stamping, lists and custom behavioral events are covered by other docs and are not repeated here.

Legend: **[C]** = confirmed in the cited page. **[I]** = inferred (not stated in docs; test it).

---

## 1. App-defined / custom workflow TRIGGERS

**Short answer: on the new platform, app events are the only way an app adds its own trigger to the workflow editor. There is no separate "custom trigger" component, beta or GA.**

| Finding | Status | Source |
|---|---|---|
| The developer-platform index lists these app features: app events, custom workflow actions, app cards, settings pages, app pages, agent tools (BETA), app objects, serverless functions, bulk/app actions (BETA). There is **no** trigger component. | [C] | https://developers.hubspot.com/docs/_llms/apps/platform.txt |
| Custom workflow action docs do not mention triggers. They point to webhooks for "responding to events". | [C] | https://developers.hubspot.com/docs/apps/developer-platform/add-features/custom-workflow-actions.md |
| KB "Set event enrollment triggers" (updated Aug 3, 2026) has an **Integrations** category: "After installing an app in your HubSpot account, any integration timeline events will appear as workflow event triggers." That is the app events / timeline events path. There is no association trigger. | [C] | https://knowledge.hubspot.com/workflows/set-event-enrollment-triggers |
| App events: "This feature is intended only for technology partners, and requires approval from HubSpot to use." You apply through an in-app form. No turnaround time is published. | [C] | https://developers.hubspot.com/docs/apps/developer-platform/add-features/app-events/overview.md |
| App events support custom objects and app objects as `objectType`. Event properties "will appear as filters in workflows, lists, reports". Limit is 750 event types per app. `name` and `objectType` can't be changed after creation. | [C] | same page + https://developers.hubspot.com/docs/apps/developer-platform/add-features/app-events/create-and-manage-event-types.md |
| App events are "the next evolution of HubSpot's timeline events". | [C] | https://developers.hubspot.com/changelog/introducing-the-hubspot-developer-platform-2025 |
| Fall 2026 Spotlight (Sep 15, 2026): custom events can now be **objectless** for the Agentic automation builder. It has no app-trigger feature. The Workflows API is in public beta. | [C] | https://developers.hubspot.com/changelog/fall-2026-spotlight |
| Spring 2026 Spotlight: the 2026.03 platform went GA (Mar 30, 2026). It adds App Pages and agent tools. It has no app-trigger feature. | [C] | https://developers.hubspot.com/changelog/spring-2026-spotlight |

**Beta to join?** None found. The only gated path is the app events approval form, and HubSpot publishes no SLA for it. **[I]** Expect weeks. Apply now, in parallel with everything else.

**Loophole to note, not to use:** legacy apps that already have timeline event types can migrate them with `hs app migrate`. Search snippets of the app events docs say migrated event types don't need approval, but the page I fetched does not state this. Using it would mean creating a legacy app now and migrating it. That goes against our "no legacy app" rule, legacy apps are blocked from new listings from Nov 2, 2026, and v3 timeline events historically did not cover custom objects **[I]**. **Not recommended.**

---

## 2. Custom workflow ACTIONS (new platform)

| Question | Answer | Status / source |
|---|---|---|
| Component | `src/app/workflow-actions/<name>-hsmeta.json` with `"type": "workflow-action"`. Required fields: `uid`, `type`, `actionUrl`, `supportedClients`, `inputFields`, `labels.en.actionName`. `isPublished` defaults to false. | [C] https://developers.hubspot.com/docs/apps/developer-platform/add-features/custom-workflow-actions.md |
| Approval needed? | None mentioned for workflow actions. Agent tools (the "enhanced" version of actions) **do** need review for Marketplace apps: "Deploys will fail until the tool passes review". | [C] for agent tools (Spring 2026 Spotlight). [I] for no review on plain actions. |
| Object types | `objectTypes`: "If empty, the action will be available for all object types." Since Nov 24, 2025, `objectTypes` applies per action, with a `requiresObject` flag and a "target object" picker. Custom objects are not named explicitly. | [C] https://developers.hubspot.com/changelog/custom-actions-now-support-data-driven-workflows. [I] Leaving `objectTypes` empty should cover custom objects. Test it. |
| Output fields | `outputFields` with name/type/fieldType are parsed from our response and "can be used by later actions in the workflow". | [C] https://developers.hubspot.com/docs/api-reference/latest/automation/workflow-actions/custom-action-reference.md |
| Branch on outputs | The KB has a "Based on one property or action output" branch that uses "the outcomes of previous actions" (up to 250 branches). The docs do not explicitly show a custom-action output in a branch. Community reports show it working for custom code outputs. | [C] https://knowledge.hubspot.com/workflows/choose-your-workflow-actions, https://knowledge.hubspot.com/workflows/use-workflow-action-outputs. [I] for app actions. Test it. |
| Execution | HubSpot POSTs to `actionUrl`. The body includes `callbackId`, `origin.portalId`, `context.workflowId`, `object` (id, type, requested properties via `objectRequestOptions`) and `inputFields`. Signed with v2 `X-HubSpot-Signature`. | [C] reference page above + https://developers.hubspot.com/docs/api-reference/latest/automation/workflow-actions/custom-action-guide.md |
| Retries | 429 retried with `Retry-After`. 5xx retried with backoff "for up to 3 days before failing". | [C] reference |
| Async / block | `hs_execution_state`: SUCCESS, FAIL_CONTINUE, BLOCK, ASYNC. A BLOCK holds the enrollment until `POST /automation/actions/callbacks/2026-09/{callbackId}/complete`, sent with an OAuth token that has the `automation` scope. `hs_expiration_duration` is ISO 8601 (example `P1WT1H`) and **defaults to 1 week**. No maximum is stated. On expiry the workflow **continues** to the next actions. | [C] reference |
| Timeouts / rate limits / actions per app | Not documented. | Not found |
| Customer tier | Workflows need Pro/Enterprise. Custom-object workflows are Enterprise only. | [C] https://knowledge.hubspot.com/workflows/understand-workflow-object-types |

### Creative uses (actions are not triggers, but they can help)

**(a) "ChangeCatch: Get association change" action + ONE stamped property** (recommended)
- Our worker stamps one property per record, `changecatch_last_change_id`, with a unique event ID. It is a string, so every change gives a new value.
- The customer's workflow uses the trigger "Property value changed: changecatch_last_change_id", with re-enroll on.
- The first action is ours. Input = the change ID, taken from the enrolled record's property. Outputs = `change_type`, `label_before`, `label_after`, `labels_current`, `other_object_type`, `other_record_id`, `occurred_at`.
- Branches use "one property or action output" on `change_type` or the labels.
- Looking up by change ID, not "latest", avoids races when two changes land quickly.
- **Custom objects:** yes [I], on Enterprise. **Re-enrolls:** yes, every new value [I]. Rapid changes while a record is still enrolled may collapse, so keep these workflows short and test it.
- **Data for filters:** via branches, not trigger refinement filters.
- **Approval:** none known. **Marketplace:** fine. **Admin UX:** two steps (trigger + our action), which a template or our docs can show.
- Compared with plain stamping, this needs 1 property per object instead of about 6, and gives typed outputs.

**(b) "Wait until association changes" BLOCK action**
- The action returns BLOCK. Our worker stores the `callbackId` per record and calls `/complete` (with outputs [I]) when a matching change happens.
- It is good as a **mid-workflow step**, for example "Deal created, then wait until a Decision maker is linked, then notify".
- It is a poor general trigger. It only watches records that are already enrolled. It must be re-armed after each fire. It expires after 1 week by default and **continues on expiry**, so a branch is needed to tell "fired" from "expired". It can't detect changes for records that were never enrolled.
- Nice v1.1 differentiator, not the main mechanism.

**(c) Customer-side custom code action** (Data Hub Pro/Ent)
- Runs within 20 s, 128 MB, with secrets and outputs ([C] https://developers.hubspot.com/docs/api/workflows/custom-code-actions).
- It could call our API in place of (a), but it is worse UX, needs a higher tier, and needs customers to paste code. Only useful as a power-user fallback.

---

## 3. Other app surfaces

| Surface | Use for us | Custom objects | Re-enrolls | Filter/branch data | Tier | Approval | New platform | Marketplace OK |
|---|---|---|---|---|---|---|---|---|
| **Workflows API (create flows for the customer)** | "Create starter workflow" button on our settings page | Yes, `PLATFORM_FLOW` with custom sensitive scopes [C] | `shouldReEnroll` [C] | n/a | Pro+ | None, but needs `automation` + `crm.objects.*.sensitive.write` scopes [C] | Only **beta** date-based versions exist (`/automation/v4/2027-03-beta/flows`, 2026-09-beta). Legacy v4 is unsupported after Mar 30, 2027. [C] https://developers.hubspot.com/docs/api-reference/2027-03-beta/automation/workflows/guide.md | Risky: beta API and sensitive scopes. Optional later. |
| **Settings page / App Pages** | Pick object pairs, show docs, link to templates | n/a | n/a | n/a | any | none | Yes [C] (Spring 2026) | Yes |
| **App card** | Association change history on the record | Yes [I] | n/a | n/a | any | none | Yes [C] | Yes. Classic CRM cards must move to App Cards by Oct 31, 2026. |
| **Agent tools (BETA)** | Breeze agents could ask "what changed?" | ? | n/a | n/a | Agent Hub needs Pro/Ent [C] | Review required for Marketplace deploys [C] | Yes, beta | Later only |
| **Custom code action** | See 2(c) | [I] | n/a | outputs | Data Hub Pro/Ent [C] | none | n/a (customer-side) | n/a |

---

## 4. Recommendation

1. **Apply for app events today.** It is still the only true app trigger. Our `-hsmeta` event type is ready to switch on later.
2. **Ship v1 with stamping + a custom workflow action:**
   - Stamp `changecatch_last_change_id` (plus a readable `changecatch_last_change_summary` for people without branches).
   - The trigger is "Property value changed".
   - The first step is the "Get association change" action, whose outputs drive branches.
3. **v1.1:** a "Wait for association" BLOCK action, and optionally a starter-workflow button once the Workflows API leaves beta.

This **beats plain property stamping** on data richness (typed outputs, 1 property instead of about 6, lookup by event ID so no race) with no approval needed. It is **not better** on simplicity (an extra step) or on trigger-level filtering. Under the hood it is still stamping, so it shares the same re-enrollment caveats.

## Must-test list
- An action with empty `objectTypes` appears in custom-object workflows.
- Custom-action outputs appear in the "one property or action output" branch.
- Rapid changes: does the Property value changed trigger enroll once per change?
- `/complete` callback accepts extra outputFields.
