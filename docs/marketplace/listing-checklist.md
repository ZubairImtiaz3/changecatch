# Marketplace listing checklist

Checked against the live docs on **2026-10-30**. Main source:
https://developers.hubspot.com/docs/apps/developer-platform/list-apps/listing-your-app/app-marketplace-listing-requirements

Public listing title: **ChangeCatch: Association Change Triggers**.

Status key:
- **done**: done and verified in this repo.
- **todo**: work for us (code or docs).
- **owner**: needs the owner (an account, a decision, legal, a website, or real customers).

HubSpot reviews the first submission within **10 business days**. The whole feedback loop can take up to **60 days**. You can only have **one app in review at a time**. Only a **Super Admin** of the developer account can submit.

What v1 does, for reviewers and listing copy:
- ChangeCatch reads association changes from the Webhooks Journal.
- It writes each change into **7 ChangeCatch properties** on the affected record (property stamping).
- Workflows trigger on "Property value changed: ChangeCatch: last change ID".
- v1 has **no app events** (they need HubSpot partner approval; a later upgrade) and **no custom workflow action**.

---

## 1. Minimum requirements (hard gates)

| # | Requirement (docs wording, shortened) | Our status | Notes / next step |
|---|---|---|---|
| 1 | **Access:** the listing must not redirect to, or need, another public or private app. | done | One app. The journal worker uses this same app's client credentials. |
| 2 | **Uniqueness:** don't list a duplicate; update the existing app instead. | done | First listing. |
| 3 | **Use case:** one app per use case. Similar apps must be merged. | done | One app with conditional scopes, not two variants (see [scopes.md](scopes.md)). |
| 4 | **Single HubSpot app ID:** all API calls use the listed app's ID and OAuth client ID. | todo | Production must use the same app (the `changecatch_app` uid in `hubspot-app/`) for OAuth **and** the journal client-credentials token. Don't create a separate "prod" app later. |
| 5 | **OAuth only** as the authorization method. | done | `distribution: marketplace`, `auth.type: oauth`. No private-app or static tokens for customers. |
| 6 | **3 active, unique installs:** unique *production* HubSpot accounts, **unaffiliated** with our organization, with successful app activity (OAuth API calls or signed webhook/extension requests) in the **last 30 days**. Enforced in the submit flow since Aug 19, 2026. | owner | Test and developer accounts don't count, and neither does the owner's own agency portal. Agency **clients'** portals are separate businesses, so they likely count. Get each client's written OK. Our stamping makes OAuth calls, so any real association change counts as activity. Aim for 5 to be safe. |
| 7 | **Scopes:** request only the scopes you use. | done | `timeline.write` removed. Custom read scopes are optional; custom write scopes are conditionally required. See [scopes.md](scopes.md). |
| 8 | **Terms:** accept the Technology Partner Program Agreement. https://legal.hubspot.com/technology-program-agreement | owner | Accepted in the submit dialog. The owner (or the agency) must be OK being bound by it. |
| 9 | **Restricted industries:** the app must not serve only restricted industries. | done | It's a general CRM tool. |
| 10 | **No classic CRM cards.** | done | None used. |
| 11 | **Developer platform version is supported.** Legacy apps and projects 2023.2/2025.1 are rejected for new listings from **Nov 2, 2026**. | done | The project is on **2026.09**. Recheck the versioning page before submitting. https://developers.hubspot.com/docs/developer-tooling/platform/versioning |
| 12 | **AI connectors** must be user-level or use HubSpot's MCP server. | done (n/a) | Not an AI connector. |
| 13 | **Acceptable use policy** signed. | done | Signed on the app's Distribution tab. |

## 2. Brand and naming

| # | Requirement | Status | Notes |
|---|---|---|---|
| 14 | Don't combine HubSpot's name (including "Hub" and "HubSpot") with the app name or logo. Don't modify, imitate or abbreviate HubSpot names (bad examples from HubSpot: "HubConnector", "SyncSpot", "HubSync"). | done | Final name: **ChangeCatch**. No "Hub" or "-Spot". |
| 15 | Don't use generic name + HubSpot (bad examples: "CRM for HubSpot"). Acceptable patterns are "<Brand> integration for HubSpot" and "<Brand> + HubSpot app". | done | Listing title: "ChangeCatch: Association Change Triggers". The brand name stands alone. |
| 16 | **"App" in the name.** No explicit ban on "App" was found in the current requirements or branding guidelines. HubSpot's own examples even use "Hooli + HubSpot app". | done | The name is a distinct brand, not a generic word like "App", "Integration" or "Connector". |
| 17 | No "UNBOUND" / "INBOUND" tie-ins. No domain names containing "HubSpot". | owner | Check the chosen domain. |
| 18 | Write "HubSpot" with a capital S everywhere (listing, docs, website). | todo | Check all public docs. |
| 19 | Icon: 800×800 px, JPG or PNG, fills the space, **no text or wordmark**, no HubSpot sprocket or other brands' logos. | owner | Design needed. |

Branding guidelines: https://www.hubspot.com/partners/technology/branding-guidelines · Trademark usage: https://legal.hubspot.com/tm-usage-guidelines

## 3. Listing content (missing items put the listing back to Draft)

| # | Requirement | Status | Notes |
|---|---|---|---|
| 20 | Listing copy is specific to the integration and its value (not general product info). | todo | Base it on the problem: HubSpot workflows can't trigger when records are linked, unlinked or relabeled. Use [../user-guide.md](../user-guide.md) for the feature list. |
| 21 | **All URLs are live, public and working.** HubSpot checks them with its SEO crawler, so allow-list the "HubSpot Crawler" user agent. Each URL field has a 250-character limit. | owner | Needs a public website and domain. |
| 22 | **Public setup guide URL**: not behind a login, specific to this app, with the install and configure steps. | todo | Publish [../user-guide.md](../user-guide.md) as the setup guide. For **certification** later it also needs screenshots of each step (including the scope screen), use, disconnect, uninstall, and the data consequences. Write it to the certification standard now. Template: https://developers.hubspot.com/docs/apps/developer-platform/list-apps/listing-your-app/create-an-app-listing-setup-guide |
| 23 | **Install button URL** that connects the app. "Seamless install" (HubSpot OAuth only) is recommended. | todo | The production redirect URL must be **https** on a real domain (no IPs). Replace the `https://REPLACE-WITH-PUBLIC-BASE-URL/oauth/callback` placeholder in `hubspot-app/src/app/app-hsmeta.json` (`redirectUrls`, and `permittedUrls.fetch`). The install page must allow framing by `app.hubspot.com` and `app-eu1.hubspot.com` (CSP `frame-ancestors`). See [../install-flow.md](../install-flow.md). |
| 24 | **Support resources URLs** (support site, community, case study) are live. | owner | At least a support page on the website. |
| 25 | **Terms of Service and Privacy Policy URLs** are live and current. | owner | Drafts: [terms-draft.md](terms-draft.md) and [privacy-policy-draft.md](privacy-policy-draft.md) (DRAFT, needs legal review). Publish on the website. |
| 26 | **Shared data table** is accurate, matches the scopes, and documents every object in the scopes. Read + write on an object = **bi-directional**. | todo | Use [shared-data-table.md](shared-data-table.md). Update it if the scopes change. |
| 27 | **Pricing** is clear and matches the website. Use "Free" only for free-forever or freemium. | owner | v1 is free. Publish a pricing page (even "Free") on the website that says the same thing. |
| 28 | **At least one support contact.** The Support info tab needs a support email **and** support languages. | owner | `app-hsmeta.json` still has the placeholder `support@changecatch.example`. Replace it with a real monitored inbox on our domain. |
| 29 | Demo video (recommended) and up to 8 screenshots with alt text. | owner | A screen recording: change a label, then show the workflow enrolling. |
| 30 | App overview, up to 2 categories, HubSpot features it works with (Workflows, CRM), and languages. | todo | Draft with the listing copy. |
| 31 | **App features** tab: features with **scope groups**. | todo | 2 features: standard objects, and custom objects (Enterprise). See [scopes.md](scopes.md) §5. |
| 32 | **Testing info** tab: give reviewers a way to test. | todo | Reviewer instructions: install, keep the default Deal ↔ Contact pair, change a label, then check the `changecatch_*` properties on the deal and a sample workflow that triggers on "ChangeCatch: last change ID". |

## 4. Security, privacy and reliability (things reviewers may check)

| # | Item | Status | Notes |
|---|---|---|---|
| 33 | Every requested scope is used; subset scopes are optional or conditional. | done | [scopes.md](scopes.md). |
| 34 | No sensitive-data scopes. | done | None requested. |
| 35 | Refresh tokens encrypted at rest and never logged. | done | AES-256-GCM, key rotation supported. `service/src/install/crypto.ts`, `portals.refresh_token_enc`. See [../architecture.md](../architecture.md). |
| 36 | Token wiped on uninstall. | done | `PortalStore.markUninstalled` sets `refresh_token_enc = NULL` and deletes the watched pairs. |
| 37 | **Per-account data deleted on uninstall.** The privacy policy promises this. | done | `Store.purgePortal` (`service/src/store/db.ts`) deletes settings, label caches, `association_labels`, metrics, the stamp queue, parked entries and `change_log`. Only the token-less `portals` row is kept (for late uninstall events) and deleted after 30 days. Retention limits also apply while installed (see [privacy-policy-draft.md](privacy-policy-draft.md)). |
| 38 | Hosting in production: always-on worker, https, encrypted backups, and an alert if there's no journal read for 1 hour. | todo / owner | TODO: choose a hosting provider. It becomes a subprocessor in the privacy policy. See [../observability.md](../observability.md) and [../runbook.md](../runbook.md). |
| 39 | No unpublished or unused components in the production project. | done | `hubspot-app/` holds only the app and the settings page. No custom workflow action, so the `automation` scope isn't needed. |

## 5. After listing (not needed to submit)
- Certification needs **60** active installs plus the full setup-guide items. https://developers.hubspot.com/docs/apps/developer-platform/list-apps/apply-for-certification/certification-requirements
- App events (a later upgrade, after partner approval) would need `timeline.write` added back. Changing scopes means resubmitting the listing and updating the shared data table.

## Sources
- Listing requirements: https://developers.hubspot.com/docs/apps/developer-platform/list-apps/listing-your-app/app-marketplace-listing-requirements
- How to list (the 7 tabs): https://developers.hubspot.com/docs/apps/developer-platform/list-apps/listing-your-app/listing-your-app
- Setup guide requirements: https://developers.hubspot.com/docs/apps/developer-platform/list-apps/listing-your-app/create-an-app-listing-setup-guide
- Install flow: https://developers.hubspot.com/docs/apps/developer-platform/list-apps/understand-app-install-flow
- Branding guidelines: https://www.hubspot.com/partners/technology/branding-guidelines
- Active-install change (Aug 2026): https://community.hubspot.com/t/changes-to-marketplace-submission-flow-how-active-installs-are-determined/156427 (returned 403 when checked; the rule text above comes from the requirements page)
