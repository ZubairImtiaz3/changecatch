# Scopes and the listing scope table

Research date: **2026-10-30**. Platform: projects **2026.09**.
Labels used below:
- **[Doc]** means quoted or closely paraphrased from a current HubSpot docs page (URL given).
- **[Observed]** means we saw it ourselves while testing.
- **[Inferred]** means it is our reading or conclusion, not a direct statement from a source.

This is the reasoning behind decision D3 (custom-object scopes). Summary of the decision: [../decisions.md](../decisions.md).

---

## TL;DR

- **Required Enterprise scopes would block installs on Pro and free portals.** So the custom-object scopes are **not** required.
- **What ChangeCatch requests (in `hubspot-app/src/app/app-hsmeta.json`):**
  - `requiredScopes` = standard-object scopes only. Every account tier has them.
  - `optionalScopes` = `crm.objects.custom.read` + `crm.schemas.custom.read`. HubSpot drops them silently on non-Enterprise portals, and grants them on Enterprise (we saw this).
  - `conditionallyRequiredScopes` = `crm.objects.custom.write` + `crm.schemas.custom.write`. They are requested **only** on a second consent screen, which the OAuth callback opens automatically for portals that granted the custom read scopes (that is, Enterprise).
- HubSpot's listing rules recommend exactly this kind of split: *"If certain scopes only apply to a subset of your app's user base, they should be included as conditionally required or optional scopes."*
- **`timeline.write` is not requested.** Nothing in v1 uses it. It comes back only with app events, a later upgrade.
- **Checks still open before listing:** see section 6.

---

## 1. Required Enterprise scopes on a non-Enterprise portal: is the install blocked?

**Yes, by the docs.** Not yet confirmed on a real Pro portal.

- **[Doc]** "Working with OAuth", `scope` parameter: *"Any scopes that you've checked off in your app's Auth settings will be treated as required … Additionally, users will get an error if they try to install your app in an account that doesn't have access to an included scope."*
  https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/working-with-oauth
- **[Doc]** Scopes reference: `crm.objects.custom.read`, `crm.objects.custom.write` and `crm.schemas.custom.read` are each *"Available to Enterprise accounts only."* `crm.schemas.custom.write` **isn't listed** in the scopes table at all. The Create-property API spec does accept it, as one of its alternatives.
  https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes
  https://developers.hubspot.com/docs/api-reference/latest/crm/properties/create-property
- **[Doc]** App configuration, `requiredScopes`: *"the installing user must grant these scopes to successfully install the app."*
  https://developers.hubspot.com/docs/apps/developer-platform/build-apps/app-configuration

**Conclusion [Inferred, high confidence]:** making the custom scopes required would show an error on a Pro or free portal and stop the install.

---

## 2. What `conditionallyRequiredScopes` means on 2026.09

- **[Doc] App configuration:** *"A list of scopes that are required only when included in the `scope` query parameter of the install URL."*
- **[Doc] Scopes page:** *"scopes that must be authorized by the user only if they're present in the `scope` query parameter in your app's install URL … This scope type allows you to … provide a separate install URL for tiered features … one install URL could include the conditionally required scope … while another install URL omits that scope … If a conditionally required scope is present in your app install URL and a user without access to the associated feature attempts to install your app using that URL, the installation will fail."*
  https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes#app-scope-types
- **[Doc] Marketplace install flow:** *"Required and optional scopes are already included in the install URL. If you need to use conditional scopes, you'll need to initiate a separate secondary install flow."* With partner sign-in, you add them to the `scope` parameter on the `returnUrl` redirect.
  https://developers.hubspot.com/docs/apps/developer-platform/list-apps/understand-app-install-flow

**In plain words:**
- A conditionally required scope is **declared** in the app, but HubSpot asks for it **only when our URL includes it**.
- When the URL does include it, it behaves like a required scope: the user can't untick it, and a portal without the feature gets an error.
- It doesn't detect the portal tier automatically. **We** decide when to ask for it.

---

## 3. Why custom write is not an optional scope

**[Observed]**
- With the 4 custom scopes as **optional**, the token came back with `crm.objects.custom.read` and `crm.schemas.custom.read`, but **not** the two write scopes. Creating a property on a custom object then failed with 403 "requires one of [custom-object-write]".
- This happened on a re-install **and** on a fresh install, both on an Enterprise portal.
- That portal uses HubSpot **app governance**: a super admin approves apps and turns their optional / extra data permissions on or off (off by default). This is the most likely cause. KB: https://knowledge.hubspot.com/integrations/manage-access-to-apps

**What the docs say about optional scopes:**
- **[Doc]** *"Optional scopes will be automatically dropped from the authorization request if the user selects a HubSpot account that doesn't have access to that tool … you will need to check the access token or refresh token to see which ones were granted."* (Working with OAuth)
- **[Doc]** *"These scopes can be excluded from the authorization during installation if the account **or user** installing the app doesn't have the proper permissions."* (App configuration)
- **[Doc]** Users *"can customize and confirm each optional permission they grant."* (Scopes page)

**Practical lesson [Inferred]:** optional *write* scopes are unreliable for something the app can't work without. Never assume a scope was granted. Always read `scopes` from the token response, which we save in `portals.scopes`.

---

## 4. The setup ChangeCatch uses

### 4.1 `auth` block in `hubspot-app/src/app/app-hsmeta.json`

```json
"requiredScopes": [
  "oauth",
  "crm.objects.contacts.read",  "crm.objects.contacts.write",
  "crm.objects.companies.read", "crm.objects.companies.write",
  "crm.objects.deals.read",     "crm.objects.deals.write",
  "crm.schemas.contacts.write", "crm.schemas.companies.write", "crm.schemas.deals.write"
],
"optionalScopes": [
  "crm.objects.custom.read",
  "crm.schemas.custom.read"
],
"conditionallyRequiredScopes": [
  "crm.objects.custom.write",
  "crm.schemas.custom.write"
]
```

### 4.2 Install flow (`CUSTOM_WRITE_MODE`, default `conditional`)

1. **Normal install** (Marketplace "Seamless install" or our own `/install` link). The URL has `scope` = required and `optional_scope` = the 2 custom read scopes.
   - On **Pro or free**, the read scopes are dropped and the install succeeds. The app works for Contacts, Companies and Deals.
   - On **Enterprise**, the read scopes are granted. The settings page can then list custom objects (`GET /crm-object-schemas/2026-09/schemas`).
2. **The OAuth callback checks the granted scopes.** If custom read was granted but custom write is missing, it redirects straight to a **second consent screen** that adds `crm.objects.custom.write crm.schemas.custom.write`. A loop guard in `state` stops repeats.
   - Only Enterprise portals reach this screen, so the conditional install can't fail for a Pro user.
   - The settings page keeps an "Enable custom objects" link (`/install?custom=1`) as a backup.
3. The new token is saved, replacing the old refresh token. We then create the `changecatch_*` properties on the chosen custom objects.
4. **If the portal can't grant custom write** (app governance, or the user lacks permission), the custom-object pairs stay disabled with a clear message, including the super-admin approval steps. Standard objects keep working.

`CUSTOM_WRITE_MODE=optional` puts the custom write scopes in `optional_scope` on the first screen instead. It is kept for testing on portals without app governance. See [../configuration.md](../configuration.md) and [../install-flow.md](../install-flow.md).

Code: `service/src/hubspot/oauth.ts` (authorize URL), `service/src/install/scopes.ts` (which list each scope goes in), `service/src/install/installer.ts` (only creates custom-object properties when the custom write scopes are in `portals.scopes`). Token calls use the date-based endpoint `/oauth/2026-09/token`, not OAuth v1.

### 4.3 Why not the other options

| Option | Problem |
|---|---|
| Keep custom scopes required | Pro and free installs fail (docs). Breaks the free community tier. |
| All 4 custom scopes optional | Write was silently dropped in our tests. Custom objects would break with no reliable fix. |
| Two separate apps | The listing rules say one app per use case ("Apps with similar functionality and use the same APIs should be consolidated"). Last resort only. |
| Admin creates properties by hand + optional `crm.objects.custom.write` only | Still relies on optional *write* being granted. Also much worse setup UX. |

---

## 5. Marketplace "App features" tab

- Create 2 features with their own **scope groups**: "Watch standard object associations" (required scopes) and "Watch custom object associations" (custom scopes, Enterprise).
- HubSpot uses these scope groups to show which features a customer's account is compatible with.
  https://developers.hubspot.com/docs/apps/developer-platform/list-apps/listing-your-app/listing-your-app#app-features

---

## 6. Checks still open before listing

| # | Check | Pass means |
|---|---|---|
| A | Install into a **Pro** test account. | The install succeeds. Custom read is absent, and no second consent screen appears. |
| B | Fresh install in `optional` mode on an Enterprise portal **without** app governance. | Shows whether HubSpot grants optional custom write when nothing blocks it. If yes, `optional` mode gives a one-screen install. |
| C (optional) | With only `crm.objects.custom.write` (no `crm.schemas.custom.write`), try creating a property on a custom object. | If it works, drop `crm.schemas.custom.write`, which means one fewer scope to justify. |

Configurable test accounts (to pick the tier): https://developers.hubspot.com/docs/developer-tooling/local-development/configurable-test-accounts

---

## 7. Per-scope justification (for the listing reviewer)

The Webhooks Journal scopes (`developer.webhooks_journal.read`, `developer.webhooks_journal.subscriptions.read/write`) belong to our **app-level client-credentials token**. They are **not** customer install scopes, and they are not declared in `app-hsmeta.json`.

| Scope | Type | Why we need it | Feature | API we call |
|---|---|---|---|---|
| `oauth` | Required | Basic OAuth. HubSpot adds it to every app. | Install / connection | `/oauth/2026-09/token` |
| `crm.objects.contacts.read` | Required | Read the contact association label definitions, so a label ID becomes a name like "Decision maker". | Label names on contact pairs | `GET /crm/associations/2026-09/{from}/{to}/labels` |
| `crm.objects.contacts.write` | Required | Write the `changecatch_*` change details onto the contact that changed, so workflows can trigger. | Change stamping on contacts | `POST /crm/objects/2026-09/contacts/batch/update` |
| `crm.schemas.contacts.write` | Required | Create the "ChangeCatch" property group and the 7 `changecatch_*` properties on contacts. Keep the label dropdown options in sync. | Setup + label dropdowns | `POST/PATCH /crm/properties/2026-09/contacts[...]` |
| `crm.objects.companies.read` | Required | Same as contacts, for companies. | Label names on company pairs | labels endpoint |
| `crm.objects.companies.write` | Required | Same as contacts, for companies. | Change stamping on companies | batch update |
| `crm.schemas.companies.write` | Required | Same as contacts, for companies. | Setup + label dropdowns | properties API |
| `crm.objects.deals.read` | Required | Same as contacts, for deals. | Label names on deal pairs | labels endpoint |
| `crm.objects.deals.write` | Required | Same as contacts, for deals. | Change stamping on deals | batch update |
| `crm.schemas.deals.write` | Required | Same as contacts, for deals. | Setup + label dropdowns | properties API |
| `crm.schemas.custom.read` | Optional (Enterprise) | List the portal's custom objects, so the admin can choose which to watch. | Settings: object picker | `GET /crm-object-schemas/2026-09/schemas` |
| `crm.objects.custom.read` | Optional (Enterprise) | Read the association label definitions for custom object pairs. | Label names on custom pairs | labels endpoint |
| `crm.objects.custom.write` | Conditionally required (Enterprise) | Write the `changecatch_*` change details onto custom object records. | Change stamping on custom objects | batch update |
| `crm.schemas.custom.write` | Conditionally required (Enterprise) | Create the `changecatch_*` properties and group on custom objects. Drop it if check C shows it's not needed. | Setup on custom objects | properties API |

Not requested: `timeline.write`. It is only for the future app-events path. The rules say *"Scopes that are not used must be removed."* Add it back only once app events are approved and shipped.

**Notes for the reviewer text:**
- We never read contact, company, deal or custom record **property values** (names, emails and so on). The `*.read` scopes are used only for association label definitions. If a reviewer asks, check whether `crm.schemas.*.read` would be enough for the labels endpoint. The current spec lists the object read scopes.
- We never create, delete or change records other than writing our own `changecatch_*` properties.
- We don't request sensitive or highly-sensitive scopes.

---

## Sources
- Scopes (types + tier table): https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes
- App configuration (`auth` fields): https://developers.hubspot.com/docs/apps/developer-platform/build-apps/app-configuration
- Working with OAuth (`scope`, `optional_scope`): https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/working-with-oauth
- Marketplace install flow (conditional scopes need a secondary flow): https://developers.hubspot.com/docs/apps/developer-platform/list-apps/understand-app-install-flow
- Listing requirements (scope rules): https://developers.hubspot.com/docs/apps/developer-platform/list-apps/listing-your-app/app-marketplace-listing-requirements
- Granular scopes migration (`timeline` → `timeline.read` / `timeline.write`): https://developers.hubspot.com/docs/apps/developer-platform/build-apps/migrate-an-app/update-your-app-to-granular-scopes
- Create property (accepted scopes include `crm.schemas.custom.write`): https://developers.hubspot.com/docs/api-reference/latest/crm/properties/create-property
- App governance (super admin approves apps and their permissions): https://knowledge.hubspot.com/integrations/manage-access-to-apps
- Third-party note on silently dropped optional scopes (not official): https://docs.composio.dev/kb/guide/toolkits-hubspot
