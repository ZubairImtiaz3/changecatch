# Design decisions

What we planned, what got in the way, what we compared, and what we chose. Newest first. Superseded plans are kept and marked, so the reasoning stays visible.

All decisions below were made in October 2026, while v1 was being built and tested against a real HubSpot test account.

| ID | Decision | Status |
|---|---|---|
| D8 | Pre-launch squash of legacy upgrade paths | Adopted |
| D6 | Late-half absorption instead of a longer split hold | Adopted |
| D5 | Trim the properties from 9 to 7 | Adopted |
| D4 | No custom workflow action in v1 | Adopted (action deferred) |
| D3 | Custom-object scopes: optional, required or conditional | Resolved: conditional |
| D2 | Deliver changes by property stamping, not app events | Adopted for v1 (app events = later upgrade) |
| D1 | Detect changes with the Webhooks Journal | Adopted |

---

## D8: Pre-launch squash (2026-11-07, owner decision)

**Why:** no customer has installed yet, so code that only upgrades our own dev data is surplus. Keeping it means every reader has to understand 13 schema steps and two token formats that no real database will ever need.

**What went:**
- The 13 schema migrations (incl. tables once created by their own modules) became ONE initial migration that creates today's schema exactly (`service/src/store/schema.ts`). Appending new versions works as before.
- The legacy `v1:` token format and the single-key `TOKEN_ENC_KEY` variable. `TOKEN_ENC_KEYS` (with key ids) and the rotation CLI stay for real rotations; the crypto module moved to `service/src/lib/crypto.ts`.
- The free-text -> checkbox property migration. Properties are created as dropdowns from day one; an existing property of another type is reported as `exists-mismatch` and left alone. Option merge (add / unhide / relabel) stays.
- The coalescing `off` mode (only tests used it).

**Cost:** the dev DB is recreated once and the app is reinstalled on the test portal ([development.md](development.md), "Recreate the dev DB"). A DB file made before the squash is refused at start with that instruction; it is never mixed with the new schema.

## D7: Naming of everything in the customer's portal (2026-11-07)

**Why:** internal property names and option values are frozen once customers install (HubSpot can't rename a property, and customers' workflow filters store option values). Reviewed before the first customer.

**Research:** HubSpot documents no naming rules beyond: internal name max 100 characters and not editable after creation; labels editable; option values are what the API and filters use. Marketplace requirements only cover app branding. Common practice: a snake_case `brand_field` internal name, the brand in the group and in the label (many pickers show only the label).

**Kept:** `changecatch_` prefix and snake_case; group `changecatch` / "ChangeCatch"; labels "ChangeCatch: …" in sentence case; change type values `ADDED` / `REMOVED` / `LABEL_CHANGED`.

**Changed:**
- `changecatch_label_before` / `_after` → `changecatch_labels_before` / `_after` (consistent with `changecatch_labels_current`).
- Change type option labels: "Added", "Removed", "Label changed" (values unchanged).
- Special label values `(none)` / `(unknown)` → `none` / `unknown` (display text still "(none)" / "(unknown)").
- `changecatch_other_object_type`: free text with a display name → dropdown, value = object type id (`0-1`, `2-…`), label = the object's name. A renamed custom object no longer breaks "is equal to" filters.
- Label option values: `${otherTypeId}:${label name}` → `${otherTypeId}:${associationTypeId}`. A label renamed in HubSpot keeps its value (filters keep matching); the option sync only updates the display text. The pipeline carries label type ids instead of names (resolve.ts `labelKeysOf`).
- Mirror stamps (`STAMP_MIRROR=1`): type ids are per direction, so labels are translated to the other direction by name; a paired label with different names per side is written as `unknown` rather than guessed.

**Migration:** store migration 8 clears the short-lived label memory that held names (`association_labels`, `emitted_actions`) and the `labels_synced:` markers, so every pair's dropdowns are synced again. Old properties in already-installed test portals are left alone (never deleted).

## D6: Late-half absorption instead of a longer split hold (2026-10-30)

### Original plan
HubSpot logs one association action as two journal events (for example "link removed" + "label removed"). Pairing held a cluster that might be half of such an action for `PAIRING_SPLIT_HOLD_MS` (15 s at the time) after its journal file was published, hoping the other half would arrive in time.

### Problem
In a 1,300-operation mixed load test, HubSpot published the two halves of one action (identical `occurredAt`) further apart than the hold. About 16% of deals ended with "current labels" = `(unknown)` instead of `(none)`: a REMOVED, then a bogus LABEL_CHANGED seconds later. Late halves also added hundreds of extra change-log rows. Any fixed hold can be beaten by enough load.

### Options
1. A longer hold (30–90 s). Slower for every unlabeled link and unlink, and still beatable.
2. Re-read the pair from the CRM. Extra API calls per change, and a rate-limit cost.
3. Remember recently emitted actions for a short time, and treat a matching late cluster as part of that action. **Chosen.**

### Choice
`service/src/core/absorb.ts` plus an `emitted_actions` table (10-minute TTL):
- Late label REMOVED after a REMOVED: absorbed (no new change).
- Late label ADDED after an ADDED: amended. If the stamp is still queued, it is merged. Otherwise an amend PATCH writes only `changecatch_labels_after` and `changecatch_labels_current` (named `changecatch_label_after` before D7), with no new change ID, so there is no extra workflow enrollment.
- Late structural half after a LABEL_CHANGED: converted in place if not stamped yet. If already stamped, the correct REMOVED or ADDED is emitted. That is one extra, correct enrollment; it can't be avoided.

The default split hold dropped to 4 s. It is now only an optimisation. The next 1,300-operation run was 100% correct (see [kpis.md](kpis.md)).

---

## D5: Trim the properties from 9 to 7 (2026-10-30, owner decision)

### Why
- Keep v1 simple. Fewer properties means less clutter in the customer's account and less to explain.
- `changecatch_last_change_at` added nothing a workflow needs. The trigger is `changecatch_last_change_id`, and HubSpot's property history already shows when it changed. The change time is still in our change log (and is the first part of the change ID).
- `changecatch_changes_since_last_stamp` (the burst count) confused admins.

### What changed
- Removed: `changecatch_last_change_at` and `changecatch_changes_since_last_stamp`. Setup doesn't create them and the worker doesn't write them.
- **Kept (7):** `changecatch_last_change_id` (the trigger), `changecatch_change_type`, `changecatch_other_object_type`, `changecatch_other_record_id`, `changecatch_label_before`, `changecatch_label_after`, `changecatch_labels_current`.

### Burst count
Coalescing works as before. The folded count now lives only in logs and metrics: `coalescedCount` on the queued update (not sent to HubSpot), the "stands for N changes" part of the `stamped ...` log line, and the `stamps_coalesced` metric.

---

## D4: No custom workflow action in v1 (2026-10-30, confirmed by the owner)

### Original plan (from D2)
Property stamping, plus an optional "ChangeCatch: Get association change" custom workflow action. The action looks up the exact change by `changecatch_last_change_id` and returns typed outputs for branches.

### What happened
- **The action worked** in testing. It appeared in the workflow editor, HubSpot called it with a valid v3 signature, and branches could use its dropdown outputs.
- **The owner's challenge:** it duplicates what admins can already do with the stamped properties in enrollment criteria and branches.

### Analysis
- The action's only unique value is **accuracy under bursts**:
  - Enrollment filters are evaluated at trigger time.
  - Branches and later actions read *current* property values. A second change on the same record a few seconds later can leak into the first enrollment's branch.
- The cost: an always-on public endpoint called on every enrollment, a second way to build the same workflow, and more docs.

### Decision
- **v1 = properties only.**
  - Docs tell admins to put conditions in **enrollment criteria**, one workflow per case, and to use property values in tokens or branches only before any delay (see [user-guide.md](user-guide.md), section 6).
  - Stamps on one record are spaced at least 3 s apart.
- **The action is deferred**, not thrown away. It is not part of this repository yet. Bring it back as an optional advanced step if customers report wrong branches on busy records.

### Follow-up improvement (adopted)
- `changecatch_label_before` and `changecatch_label_after` became **multiple-checkbox** properties, and `changecatch_labels_current` too.
- Options are synced from the account's association label definitions, and refreshed when an unknown label appears.
- Why: free-text equality fails when a link has several labels, and admins had to type label names by hand.

### The downstream-overwrite limit, in plain words (for docs and support)
- **Safe:** two quick changes on one record each enroll separately, and **enrollment criteria** see the right values for each.
- **Not safe:** steps *later* in the workflow that read `changecatch_*` properties (branches, tokens in tasks or emails, "Copy property value") can see a NEWER change if the record changed again while the workflow was running. That's most likely after a **delay** step.

---

## D3: Custom-object scopes (2026-10-30)

### Original plan
Custom-object scopes (`crm.objects.custom.*`, `crm.schemas.custom.*`) were **optional**, so accounts without Enterprise (no custom objects) can still install.

### Problem
As optional scopes, HubSpot granted the custom **read** scopes but silently left out `crm.objects.custom.write` and `crm.schemas.custom.write`. Creating a property on a custom object returned 403.

### What we tried
Making all four custom scopes **required** worked on an Enterprise account: properties were created and stamps written. But required Enterprise-only scopes **block installs** on accounts without access (per HubSpot's OAuth docs), and Pro accounts must be able to install.

### Options considered
- (a) `conditionallyRequiredScopes`.
- (b) Keep custom write optional and have the admin create properties by hand. Only works if HubSpot grants optional *object* write, which it didn't.
- (c) Two app variants. Last resort.

### Resolution (owner-approved)
Requirement: Pro accounts can install, and Enterprise accounts get custom-object support **automatically**, with no separate manual step.

- **Required:** `oauth`, contacts/companies/deals read + write, `crm.schemas.{contacts,companies,deals}.write`.
- **Optional:** `crm.objects.custom.read`, `crm.schemas.custom.read`.
- **Conditionally required:** `crm.objects.custom.write`, `crm.schemas.custom.write`.
- **Removed:** `timeline.write` (only needed for app events, unused in v1).

Install flow (was `CUSTOM_WRITE_MODE`, default `conditional`; the `optional` mode and the env var were removed on 2026-11-07, only `conditional` remains):
- **`conditional`:** the OAuth callback sees custom read granted but write missing (which means Enterprise), and immediately redirects to a second consent screen that includes the conditional scopes. A loop guard prevents repeats. The settings page keeps an "Enable custom objects" button as a backup, which also covers accounts that use app approval (app governance).
- **`optional`:** custom write goes in the optional scopes on the first screen. Tested on a fresh install: HubSpot **never granted optional custom write**. So `conditional` stays the default.

Details: [install-flow.md](install-flow.md), [marketplace/scopes.md](marketplace/scopes.md).

---

## D2: How changes reach customer workflows (2026-10-30)

### Original plan (superseded for v1)
Send a HubSpot **app event** "Association changed" onto the affected record. Customers build workflows with that app event as the **trigger** and filter on its properties (`change_type`, `label_before`, `label_after`, ...).

### Problem
- **App events need HubSpot partner approval.** The docs say they are "intended only for technology partners, and requires approval from HubSpot to use".
  - The CLI refused to scaffold them: "This account doesn't have access to this feature".
  - The access form asks for a *production* Hub ID (test accounts are rejected), a production app ID, the app name and a description.
  - HubSpot publishes no approval time; the form mentions about 10 business days. Each new event type is reviewed again.
- **One event type can't cover both a standard object and custom objects**, so the design needs 4 types (Deal, Contact, Company, Custom).
- **Event type names and property types are locked after creation.**

### Options compared (research in [research/](research/), trigger options A, B and C)

| Option | Custom objects | Re-enrolls every time | Filterable data | Customer tier | Approval | Verdict |
|---|---|---|---|---|---|---|
| App events | yes | yes | yes | Pro+ | **yes** | Best UX. Kept as the later upgrade |
| **Property stamping + "Property value changed"** | yes | yes (trigger on a value that's new each time) | yes (typed properties as filters) | Pro+ (custom objects need Enterprise) | no | **Chosen for v1** |
| + custom workflow action "Get association change" | yes | n/a (an action, not a trigger) | yes (typed outputs) | same | no | Built and tested; deferred (D4) |
| "When a webhook is received" trigger | not documented | not documented | mapped fields | Pro+ | no | Rejected: matches only via a unique custom property; per-workflow URL and mapping |
| Static list membership trigger | yes | yes (remove + re-add) | no data | Pro+ | no | Rejected: no data, list clutter, double the calls |
| Custom (behavioral) events | no (trigger is contact-only) | yes | yes | Enterprise | no | Rejected |
| Enroll via API | contacts only (legacy v2) | n/a | n/a | n/a | no | Rejected: legacy, unsupported after Sep 2027 |
| App creates workflows for the customer | n/a | n/a | n/a | n/a | no | Rejected: the Workflows API is beta-only |
| Legacy timeline events | no | n/a | n/a | n/a | same approval as app events | Rejected: legacy apps aren't allowed |

No app-defined workflow trigger exists on the new developer platform other than app events (Spring and Fall 2026 changelogs checked).

### Decision
**v1 = property stamping.** For each change, the worker PATCHes the record once with the 7 `changecatch_*` properties (D5). Workflows trigger on "Property value changed: ChangeCatch: last change ID" with re-enrollment on. Testing confirmed re-enrollment once per change, on Deals and on custom objects.

- Stamping is the only delivery path in the code. App events, if approved later, become a new sink behind the stamp queue (a code change plus uploading the event types), not a config switch. The first app-events implementation was deleted in the 2026-11 untangle; git history has it.
- Stamping needs write scopes: `crm.objects.{contacts,companies,deals}.write` and `crm.schemas.{contacts,companies,deals}.write`, plus custom-object write (see D3).

---

## D1: Detection source

- Use the **Webhooks Journal**: one app-level, ordered stream for all installed accounts, read with the `2026-09` endpoints.
- Rejected: scheduled scans (cost grows with the number of records), and a rollup-property "doorbell" (works, but needs more setup and more API calls). The doorbell was kept as a fallback and turned out not to be needed.
- Confirmed by testing: association adds and removes show up for standard **and** custom objects, and label edits (from the API and from the HubSpot UI) show up as REMOVED + ADDED event pairs that can be joined into one LABEL_CHANGED.
- Why it scales: cost depends on the number of changes, not the number of records, and journal rate limits are separate from customers' API limits.
