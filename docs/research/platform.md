> Research reference, written before v1 was built (Oct 2026). Check the current HubSpot docs before relying on any endpoint.

# Research: developer platform, OAuth, app events, labels (checked 2026-10-30)

All facts below come from the live docs (raw `.md` pages), not memory. Doc index: https://developers.hubspot.com/docs/llms.txt

## TL;DR: surprises that change the plan

1. **App events need HubSpot approval.** Every app events page says: "intended only for technology partners, and requires approval from HubSpot". Apply via the in-app form: https://app.hubspot.com/l/developer-overview/appObjectsEventsRequest. New event types also go through a **review** before they activate.
   - Verified locally: `hs project create ... --features app-event` with the owner's current CLI account failed with **"This account doesn't have access to this feature."**
   - So the event definitions were kept out of the project (outside `src/`), so the base OAuth app could be uploaded. They go into `src/app/app-events/` once access is granted.
   - **This blocks Test 3** (workflow trigger on app events). Fallback: property stamping plus the "Property value changed" trigger. This is what v1 ships. We should apply for access now.
2. **One event type cannot cover Deal and custom objects.** `objectType` takes one standard object. `supportsCustomObject: true` covers *all* custom objects, but it can't be combined with `objectType`. So we define 4 event types: Deal, Contact, Company, Custom object.
3. **There is no `datetime` property type.** Allowed types are `string`, `number`, `date`, `enumeration`, `bool`. `hs project validate` confirmed this. `occurred_at` is `date` and accepts ISO 8601 or epoch ms.
4. **Custom-object occurrences need `objectTypeFullyQualifiedName`** (`p{portalId}_{objectName}`) in the payload. That means the worker needs the `crm.schemas.custom.read` scope (Enterprise only) to look up names.
5. **Property stamping does not work for custom-object event types.** So the custom-object fallback can't use app-event stamping. It would have to write CRM properties directly.
6. **No separate developer account needed.** Since Aug 28, 2025 every standard account has the Development section. Legacy developer accounts were migrated on Mar 9, 2026. Apps can be built, uploaded, and installed from a standard account. Source: https://developers.hubspot.com/docs/getting-started/account-types.md

## a) Platform version, CLI, project layout

- **Newest platform version: `2026.09`** (Current, available since Sep 8, 2026). `2026.03` and `2025.2` are Supported. https://developers.hubspot.com/docs/developer-tooling/platform/versioning.md
  - Note: `hs project create` still **defaults to `2026.03`**. Pass `--platform-version 2026.09`.
- **CLI:** npm package `@hubspot/cli`. Docs say the latest version is 8.16.0, npm has **8.18.0**, and app events need at least 7.6.0. It's installed locally as a devDependency, so run it with `npx hs ...`. https://developers.hubspot.com/docs/developer-tooling/local-development/hubspot-cli/install-the-cli.md
- **Commands** (https://developers.hubspot.com/docs/developer-tooling/local-development/hubspot-cli/project-commands.md):
  - `hs account auth`: connect the CLI with a personal access key.
  - `hs project create --name --dest --platform-version --project-base app --distribution marketplace --auth oauth --features ...`
  - `hs project validate`: validates config files. It ran fine on our project and checks the app-event schema too.
  - `hs project upload`: build, then auto-deploy by default.
  - `hs project deploy`: manual deploy, if auto-deploy is off.
  - `hs project open`: opens the project page, where you find the Auth tab with the client ID and secret.
  - `hs project dev`: local dev for UI extensions.
  - `hs project add`: add a feature, for example `settings`.
- **Layout** (https://developers.hubspot.com/docs/apps/developer-platform/build-apps/app-configuration.md):
  ```
  hubspot-app/
    hsproject.json                 { name, srcDir: "src", platformVersion: "2026.09" }
    src/app/app-hsmeta.json        uid, type "app", config{name, description, distribution, auth{type, redirectUrls, requiredScopes, optionalScopes, conditionallyRequiredScopes}, permittedUrls, support}
    src/app/app-events/*-hsmeta.json   (one file per event type; up to 750)
    src/app/settings/ ...          (later: settings page)
  ```
  - `distribution: "marketplace"` requires `auth.type: "oauth"`. `redirectUrls` must be HTTPS, but `http://localhost` is allowed for testing.
  - Name can't start or end with whitespace. The app name is "ChangeCatch".
- **Install limits** (https://developers.hubspot.com/docs/apps/developer-platform/build-apps/manage-apps-in-hubspot.md): an unlisted marketplace OAuth app installs in up to 25 accounts, not counting developer test accounts. There's no allowlist. Use the sample install URL or "Install now" (Standard install) on the Distribution tab. You'll get an "unverified app" warning; type "I accept the risk".

## b) Webhooks Journal scopes / client credentials

- These are **not** declared in the project. The journal API is "managed by API only" and doesn't use the `webhooks` project component. https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/guide.md
- The client credentials token is requested at runtime with `scope=developer.webhooks_journal.read developer.webhooks_journal.subscriptions.read ...`. Done in `service/src/hubspot/auth.ts`.
- The portal must also have granted the object read scopes for the subscribed objects (our `requiredScopes`/`optionalScopes`).

## c) App events

Sources:
- https://developers.hubspot.com/docs/apps/developer-platform/add-features/app-events/overview.md
- https://developers.hubspot.com/docs/apps/developer-platform/add-features/app-events/create-and-manage-event-types.md
- https://developers.hubspot.com/docs/apps/developer-platform/add-features/app-events/reference.md
- https://developers.hubspot.com/docs/apps/developer-platform/add-features/app-events/send-event-occurrences.md

**Prerequisites**
- The app must be OAuth and marketplace distribution, and have **`timeline` in `requiredScopes`**.
- The project must deploy successfully once **before** you add an app-event component.

**File format**

`src/app/app-events/<any>-hsmeta.json`:
```json
{ "uid": "...", "type": "app-event",
  "config": { "name", "description", "objectType" | "supportsCustomObject", "headerTemplate", "detailTemplate", "properties": [ { "name", "label", "description", "type", "options"? } ] } }
```

**Immutable after creation:** `name`, `objectType`, and each property's `type`.

**Our decisions:**
- Names: "Association changed (Deal)", "(Contact)", "(Company)", "(Custom object)".
- `objectType`: `DEAL` / `CONTACT` / `COMPANY`, plus `supportsCustomObject: true` for custom objects.
- Property names and types are final: `change_type` (enumeration: ADDED, REMOVED, LABEL_CHANGED), the six strings, and `occurred_at` (date).
- Deleting an event type deletes all its occurrences in every portal and breaks workflows. Never rename by delete + recreate.

**Property rules**
- Names are lowercase, 3–100 characters, can't start with `hs_`, and can't use reserved words (`objectId`, `timestamp`, `id`, `properties`, ...).
- Up to 500 properties per event type. A multi-value enumeration takes a `;`-separated value.

**Allowed `objectType` values:** APP_OBJECT, APPOINTMENT, COMPANY, CONTACT, COURSE, DEAL, LEAD, LISTING, ORDER, PROJECT, SERVICE, TICKET. Omit it for a workflow-only event (not stored, no timeline, no reports).

**Sending occurrences** (customer OAuth token)
- Single: `POST https://api.hubapi.com/integrators/timeline/2026-09/events`
- Batch: `POST https://api.hubapi.com/integrators/timeline/2026-09/events/batch` with `{ "inputs": [...] }`, up to **500**.
  - The docs contradict each other. One page says one invalid occurrence rejects the whole batch. Another says valid ones are still accepted.
- Body fields: `eventTypeName`, `objectId`, `objectTypeFullyQualifiedName` (custom objects only), `id`, `timestamp` (ISO), `properties`, `extraData`.
- `id` must be unique per event type across all accounts for one year. Duplicates are rejected, which gives us **free de-duplication**.
- Occurrences are immutable. Max size is 1 MB per occurrence and 512 KB per property.
- `eventTypeName`: the docs say either the uid or the `fullyQualifiedName`.
  - Get the FQN once with `POST /integrators/timeline/2026-09/types/projects` and body `{ projectName, developerSymbol: <event uid> }`.
  - That call is rate-limited per day. Hard-code the result in `.env` (`HUBSPOT_EVENT_TYPE_*`).

**Workflows:** the overview says app events can be used in "lists, lead scoring, and workflows", and event properties appear as filters. The exact trigger location in the workflow UI isn't documented. Confirm in Test 3.

## d) OAuth (newest, not v1)

Source: https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens.md

- **Authorize:** `https://app.hubspot.com/oauth/authorize?client_id&redirect_uri&scope&optional_scope&state`
- **Token:** `POST https://api.hubspot.com/oauth/2026-09/token`, form-encoded, all parameters in the body.
  - `grant_type=authorization_code` takes `code`, `redirect_uri`, `client_id`, and `client_secret`.
  - `grant_type=refresh_token` takes `refresh_token`, `client_id`, and `client_secret`.
  - `grant_type=client_credentials` takes `scope` and is for the journal.
- Response: `access_token`, `refresh_token`, `expires_in` (1800), `hub_id`, `scopes`. Access tokens last 30 minutes.
- **Introspect:** `POST /oauth/2026-09/token/introspect`

## e) Association labels (date-based)

- **List labels:** `GET /crm/associations/2026-09/{fromObjectType}/{toObjectType}/labels` returns `results[{category, typeId, label}]`.
  - `label` is `null` for the unlabeled default.
  - typeIds are **per direction**.
  - Any CRM object read scope works.
  - Sources: https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associations-schema/guide.md and https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associations-schema/labels/get-associations-label.md
- **Create label:** `POST .../labels` with `{label, name}`. Add `inverseLabel` for paired labels. Max 10 labels per pair.
- **Update label name:** `PUT .../labels`. **Delete label:** `DELETE .../labels/{typeId}`.
- **Associate with labels:** `PUT /crm/objects/2026-09/{objectType}/{objectId}/associations/{toObjectType}/{toObjectId}` with body `[{associationCategory, associationTypeId}]`.
  - **CORRECTED 2026-10-30 (tested): PUT ADDS the given labels and keeps existing ones.** To remove a label, use batch/labels/archive.
  - Batch version: `POST /crm/associations/2026-09/{from}/{to}/batch/create`.
  - Source: https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/guide.md
- **Default (unlabeled) link:** `PUT /crm/objects/2026-09/{from}/{id}/associations/default/{to}/{toId}`
- **Remove everything:** `DELETE /crm/objects/2026-09/{objectType}/{objectId}/associations/{toObjectType}/{toObjectId}`. Batch: `POST .../batch/archive`.
- **Remove only some labels:** use the batch "delete association labels" endpoint (`POST /crm/associations/2026-09/{from}/{to}/batch/labels/archive`, confirmed: https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/batch/delete-association-labels.md).
  - Deleting the unlabeled default type removes **all** labels.

## f) Custom object schemas (test setup)

Source: https://developers.hubspot.com/docs/api-reference/latest/crm/objects/schemas/guide.md

- Create: `POST /crm-object-schemas/2026-09/schemas` (scope `crm.schemas.custom.write`). Body: `name, labels{singular,plural}, primaryDisplayProperty, requiredProperties, properties[], associatedObjects["0-1"]`.
- List: `GET /crm-object-schemas/2026-09/schemas`. Each schema returns `objectTypeId`, `fullyQualifiedName`, and `associations`.
- Records:
  - `POST /crm/objects/2026-09/{objectTypeId}/batch/create`
  - Search: `POST /crm/objects/2026-09/{objectTypeId}/search`, which returns `total`.
- Test setup writes go through a **service key** in a test account (`HUBSPOT_SETUP_TOKEN`), so the app never asks for write scopes. https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys.md

## g) Settings page vs app card

- Settings page: React component in `src/app/settings/`, added with `hs project add`, then pick Settings. It's account-level, which is the right fit for "pick object pairs to watch". https://developers.hubspot.com/docs/apps/developer-platform/add-features/ui-extensions/extension-points/create-a-settings-page.md
- App cards sit on individual CRM records. They're not needed for v1.

## Scopes chosen at the time (app-hsmeta.json)

These were the first scopes, before v1. For the current scopes see [../marketplace/scopes.md](../marketplace/scopes.md).

- **required:** `oauth`, `timeline.write` (CONFIRMED 2026-10-30: plain `timeline` is rejected at deploy, "replaced by timeline.read, timeline.write"), `crm.objects.contacts.read`, `crm.objects.companies.read`, `crm.objects.deals.read`
- **optional:** `crm.objects.custom.read`, `crm.schemas.custom.read`. Both are Enterprise only. Optional means non-Enterprise portals can still install.

## Open questions

1. **App events access:** how long does approval take? Do we qualify without being a technology partner? This is the biggest risk for v1.
2. **`timeline` scope:** the scopes reference marks it "Legacy" and suggests granular `timeline.read`. The app-events docs explicitly require `timeline`. Kept `timeline`; confirm on first upload.
3. **`eventTypeName`:** does the uid work, or only the fullyQualifiedName? The docs contradict each other.
4. **Batch behavior:** does one invalid occurrence reject the whole batch? The docs contradict each other.
5. **Workflows:** do app events on custom objects show up as workflow triggers? Does re-enrollment work per occurrence? This is Test 3.
6. **Docs typo:** the property `label` field says "must be lowercase", but the docs' own examples use "Customer Name". `hs project validate` accepted our title-case labels.
7. **Uninstall cleanup:** no project-level lifecycle hook was found here. Handled through the journal instead (APP_LIFECYCLE_EVENT).
8. **Token host:** the OAuth docs use `api.hubspot.com`, and `auth.ts` uses `api.hubapi.com`. Both should work. Confirm on the first real call.
