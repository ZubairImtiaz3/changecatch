# Install, uninstall and settings (multi-account)

How ChangeCatch handles many customer accounts (portals) at once. Code: `service/src/install/`, `service/src/store/portals.ts`, `service/src/api/main.ts`, `hubspot-app/src/app/settings/`.

Background: [architecture.md](architecture.md) (pipeline, data model, decisions). All environment variables: [configuration.md](configuration.md).

## The pieces

| Piece | File | What it does |
|---|---|---|
| Token encryption | `service/src/lib/crypto.ts` | AES-256-GCM with key IDs, so the key can be rotated. Keys from `TOKEN_ENC_KEYS` (first = active). The portal id is bound in as AAD, so a token copied into another portal's row can't be decrypted. |
| Portal store | `service/src/store/portals.ts` | Table `portals` (encrypted refresh token, scopes, installed_at, uninstalled_at, provisioned_at, last error, stamp spacing). Same SQLite file as `service/src/store/db.ts`, but its own connection; one schema for the file in `service/src/store/schema.ts`. |
| Token provider | `service/src/hubspot/portal-tokens.ts` | The one token module (API server, worker, tools). `getAccessToken(portalId, { forceRefresh })`. Caches access tokens in memory until 5 min before expiry. Shares one refresh between parallel callers. Saves a rotated refresh token. Marks the portal revoked (`token_revocations`) when HubSpot rejects the refresh token; a reinstall clears that (a rejection not newer than the latest `installed_at` is ignored). `withPortalToken` = one refresh + retry after a 401. Every customer-portal call passes `{ portalId, token }`, so the rate limiter uses that portal's bucket. |
| Contract | `service/src/core/contract.ts` | The frozen property group + 7 properties (names, labels, options) and the one object-type table (names, pair rank, scopes, supported; Tickets are not supported). `APP_SCOPES` is built from it. Pinned by `contract.test.ts`. |
| Pairs | `service/src/core/pairs.ts` | Default pairs, orientation (which side we subscribe on), which saved pairs are active for the granted scopes (`customAccess`, `portalPairs`). |
| Subscriptions | `service/src/install/subscriptions.ts` | Pure diff (`planSubscriptionChanges`) + apply. |
| App lifecycle | `service/src/hubspot/app-lifecycle.ts` | The 2 app-level `APP_LIFECYCLE_EVENT` subscriptions (`ensureLifecycleSubscriptions`, self-heal watch), `appLifecycleKind` for journal events, and `uninstallPortal` (the HubSpot side of an uninstall, used by the worker). |
| Installer | `service/src/install/installer.ts` | Install, provision, save settings, and `provisionPending()` (the API server's sweep). One operation per portal at a time. A property that is missing, in error or exists with another type fails provisioning (`failure` on the report; shown on the settings page via `lastProvisionError`). |
| Lifecycle (worker) | `service/src/worker/lifecycle.ts` | Journal install/uninstall events: install lifts a stamping pause; uninstall (and a 7-day pause expiry) runs `handleUninstall`. |
| HTTP server | `service/src/install/server.ts` (router), `oauth-flow.ts` (install + callback + landing), `settings-api.ts` (`/api/settings` + signatures), `pages.ts` (HTML), `http-util.ts`; `service/src/api/main.ts` | OAuth install for any portal + settings API. |
| Settings page | `hubspot-app/src/app/settings/` | React settings page (`type: "settings"`). Talks to the server with `hubspot.fetch`. |
| Scopes | `service/src/install/scopes.ts` | The app's scope sets, which go in the install URL, and when to ask for the custom write scopes. |
| Worker glue | `service/src/worker/main.ts`, `service/src/worker/hooks.ts`, `service/src/worker/lifecycle.ts` | How the worker uses all of the above (section "Worker wiring"). |

## Endpoints

Start the API server with `pnpm --filter @changecatch/service start:api`. It listens on `PORT`, or the port of `HUBSPOT_REDIRECT_URI`.

| Method + path | Who calls it | Notes |
|---|---|---|
| `GET /install` (and `/`) | The admin's browser | Redirects to HubSpot's authorize URL with a fresh, signed `state`. |
| `GET /install?custom=1` | Callback (automatic) or the settings page backup link | Same, plus the 2 custom write scopes in `scope`. See "Custom objects". |
| `GET /oauth/callback` | HubSpot, after approval | Path comes from `HUBSPOT_REDIRECT_URI`. Exchanges the code, saves tokens, provisions the portal. Installs started inside HubSpot carry no `state` of ours: we log a warning but continue. A `state` that is present but expired, forged or reused is rejected. |
| `GET /api/settings` | Settings page (`hubspot.fetch`) | Needs a valid v3 signature. Returns object types in display order (`singular`, `plural`, `custom`, `selectable`), watched pairs (each with `active`), `recommendedPairs` (the install defaults), stamp spacing with `spacing {default, min, max, presets}`, last setup error, `customObjectsAvailable`, `customObjectsEnabled`, `enableCustomObjectsUrl`. Owned by `service/src/install/settings.ts` (`SettingsView`); `settings.test.ts` pins the shape the settings page reads. The page keeps no copies of these values. |
| `POST /api/settings` | Settings page | Body `{ watchedPairs: [{objectTypeId, associatedObjectTypeId}], stampSpacingSeconds }`. Validates, creates properties on newly watched objects, diffs subscriptions, saves. |
| `GET /health` | Monitoring | `ok`. |

`portalId` for `/api/settings` comes from the query string that **HubSpot** appends (`?userId=&portalId=&userEmail=&appId=`). It is trusted only after the signature check, because the signature covers the full URL. The URL is rebuilt from `PUBLIC_BASE_URL` + the request path, never from `Host` or `X-Forwarded-*` headers.

## Env vars

The API server needs these. Full list with defaults: [configuration.md](configuration.md).

| Var | Required | Notes |
|---|---|---|
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_REDIRECT_URI` | yes | The secret also verifies settings-page signatures. The callback path is the path of `HUBSPOT_REDIRECT_URI`. |
| `TOKEN_ENC_KEYS` | yes (API server AND worker) | **Losing all keys = every portal must reinstall.** Rotation: [configuration.md](configuration.md) section 2 and [runbook.md](runbook.md) B10. |
| `PUBLIC_BASE_URL` | for settings; required with `NODE_ENV=production` | The public HTTPS URL HubSpot calls. Signatures are checked against `PUBLIC_BASE_URL + path`. |
| `DB_PATH` | no | Default `data/changecatch.db`. |
| `PORT` | no | Defaults to the port in `HUBSPOT_REDIRECT_URI`. |
| `SETTINGS_ALLOW_UNSIGNED` | no | `1` = skip signature checks (local tests only). Refused with `NODE_ENV=production` or a non-localhost `PUBLIC_BASE_URL`. |

## Default watched pairs

Deal ↔ Contact, Deal ↔ Company, Company ↔ Contact. These are the standard pairs every Pro portal has, and the ones customers ask about most. Custom objects are off by default (Enterprise only; the admin knows which ones matter). The defaults are `DEFAULT_PAIRS` in `service/src/core/pairs.ts`; the settings page offers the same list as "Use recommended pairs".

## Subscription layout

- The journal reports an association only from the **subscribed** side (confirmed in testing). So each unordered pair is subscribed on one side. Rule: custom objects first, then deal, ticket, company, contact. Stored in `portal_settings` with `objectTypeId` = the subscribed side.
- **One subscription per (portal, subscribed object type)**, with all partners in `associatedObjectTypeIds`. Example: Deal↔Contact + Deal↔Company = one subscription on `0-3` with `["0-1","0-2"]`.
  - Why: the POST is an "upsert" and the docs don't say what the key is. If the key is (portal, objectTypeId), one subscription per pair would overwrite itself.
- On change: **upsert first, then delete** the old subscription ids that differ from the returned id. There is never a moment without a subscription.
- The worker's `isWatched` check is direction-insensitive, so orientation doesn't matter there.

## Flows

**Install** (`/oauth/callback`)
1. Exchange the code. Save the encrypted refresh token, scopes, `installed_at` (clears `uninstalled_at`).
2. Prime the access-token cache with the token from the exchange.
3. Provision: pairs = stored pairs, or the defaults if the portal was never configured (no `provisioned_at` and nothing saved; an admin's explicitly empty list stays empty) → create the ChangeCatch properties on every object type in them (both sides) → save the pairs → reconcile subscriptions → set `provisioned_at`.
   - Setup creates **7** properties (decision D5 in [architecture.md](architecture.md)), in the `changecatch` property group: `changecatch_last_change_id`, `changecatch_change_type`, `changecatch_other_object_type`, `changecatch_other_record_id`, `changecatch_labels_before`, `changecatch_labels_after`, `changecatch_labels_current`.
4. If step 3 fails, the token is still saved and `last_provision_error` is set. The settings page shows it; **Save** retries.
5. **The API server is the only process that provisions.** At start and every 10 min (`PROVISION_SWEEP_MS`) it runs `Installer.provisionPending()`: every installed portal with no `provisioned_at` (callback crashed half-way) or with `last_provision_error` set is provisioned again, one portal at a time under the per-portal lock. Provisioned portals are left alone. After 3 failed sweeps in a row for a portal it logs alert `provisioning_failing` (then at most hourly while it keeps failing).

**Settings save**
1. Validate: spacing is a whole number 1–600; every object type exists in the portal.
2. Create properties on object types that are newly watched. If this fails, nothing is saved.
3. Save pairs and spacing, BEFORE the subscriptions exist, so no event from a new subscription is dropped as unwatched.
4. Reconcile subscriptions. If this fails, `last_provision_error` is set and the provisioning sweep reconciles the subscriptions to the saved pairs (saving again also works).

**Uninstall** (journal `APP_LIFECYCLE_EVENT`, uninstall type `4-1916193`, handled by the worker: `Lifecycle.handleUninstall(portalId, reason)` in `service/src/worker/lifecycle.ts`; a 7-day revoked-token pause runs the same routine with reason `pause expired`)
1. Delete **every worker row** of the portal: `portal_settings`, `label_cache`, `label_cache_fetches`, `label_holds`, `association_labels`, `metrics`, `stamp_queue`, `stamp_last`, `parked_entries`, pending pairs, the portal's markers in `worker_state`, and **`change_log` too** (deleted at once, not kept until the 30-day prune). The worker-owned tables are purged as well: `stamp_dead_letter`, `lifecycle_retry`, `portal_pause`. In the same transaction a `lifecycle_retry` row is written: "HubSpot cleanup owed".
2. Mark uninstalled, wipe the refresh token, forget the cached access token (before any HubSpot call, so no customer token outlives the uninstall).
3. `DELETE /webhooks-journal/subscriptions/2026-09/portals/{portalId}` (app token). Success deletes the `lifecycle_retry` row.
4. What stays: a tombstone `portals` row with only the portal id and uninstall time (token, scopes, install time, errors and spacing are wiped; `PortalStore.markUninstalled`), so a late or repeated uninstall event can be recognised. `pruneUninstalled` deletes it after 30 days. Also and `seen_events` (journal identity keys only, no names), which expire after 4 days.
5. Ignored if the uninstall happened **before** the latest install (quick uninstall + reinstall). A repeat with no cleanup owed is a no-op (the purge runs again, harmlessly).
6. Later runs don't re-create rows: the portal has no watched pairs, so its events are dropped and get no metrics row.
7. The ChangeCatch properties and their values stay in the customer's portal. HubSpot never removes app-created properties on uninstall, and we have no token any more. This is the documented norm (HubSpot's setup-guide template: "Existing data will remain on your HubSpot records"); the user guide tells admins how to archive them. Deleting customer data automatically is deliberately not done.
8. If the HubSpot side fails, the local data is already purged and the token already wiped (privacy). Only the subscription delete waits for a retry (`lifecycle_retry`, see "Worker wiring"). A retry is dropped if the portal was reinstalled meanwhile. The shared journal offset is never held.

**Retention while installed:** `association_labels` (known label sets per record pair) is pruned after 90 days without change; `change_log` after 30 days; `seen_events` after 4 days; `stamp_last` after 1 day.

**Install event** (`4-1909196`): the OAuth callback (and, if that fails, the API server's sweep) does the work. The worker never provisions; it only lifts a stamping pause when the portal's `installed_at` is newer than the pause.

## Custom objects (scopes)

Scopes in `hubspot-app/src/app/app-hsmeta.json` (decision D3 in [architecture.md](architecture.md)):

- **Required:** oauth + contacts/companies/deals read+write + `crm.schemas.{contacts,companies,deals}.write`.
- **Optional:** `crm.objects.custom.read`, `crm.schemas.custom.read`.
- **Conditionally required:** `crm.objects.custom.write`, `crm.schemas.custom.write`. HubSpot only asks for a conditionally required scope when it is in the install URL's `scope`.

Goal: Enterprise portals get custom objects without a manual "enable" step.

`/install` asks for `scope` = required and `optional_scope` = custom read. The callback checks the granted scopes. Custom **read** granted but custom **write** missing (= Enterprise with custom objects) → it 302-redirects at once to the `?custom=1` authorize URL, so the admin just sees a second consent screen. (Putting custom write in `optional_scope` on one screen was tested and dropped: HubSpot never granted optional custom write.)

- **Loop guard:** the signed `state` remembers the step. After step 2 we never redirect again, whatever was granted. If the admin declines step 2, they see "ChangeCatch is installed ... Custom objects can be enabled later from the ChangeCatch settings page".
- Installs started in HubSpot (no state of ours) count as step 1, so they get the automatic second step too.
- **Backup:** settings GET returns `enableCustomObjectsUrl` = `PUBLIC_BASE_URL + /install?custom=1`.
- **Without custom write:** saved custom-object pairs are kept but are not **active** (`portalPairs` in `service/src/core/pairs.ts`): provision skips them with a log line (`skipping N custom-object pair(s) ... not granted`) and never fails, the worker ignores their events, and GET returns them with `active: false` (the page shows "Needs custom-object access"). They are set up as soon as custom write is granted. Settings POST refuses to *add* a custom pair with a clear message, but keeps already-saved ones. Custom types come back with `selectable: false`.
- Granted scopes are stored per portal (`portals.scopes`, from the token response's `scopes`).
- **Callback errors** (`?error=&error_description=`): handled by `oauthErrorPage` in `pages.ts`.
  - App-governance wording ("not been approved", "app governance", "super admin") gives a 403 page with the super-admin steps (Connected Apps > Approved apps > ChangeCatch > Manage access) and a "Try again" link to `/install?custom=1`.
  - Step-2 errors (for example `access_denied`) give "ChangeCatch is installed" plus the same hint.
  - Other errors give 400 "Install failed" with a retry link.
  - HubSpot often shows the governance error on its own page and never calls us back, so the settings page and the user guide explain it too.
- **Lifecycle subscriptions self-heal:** `startLifecycleSubscriptionWatch` (`hubspot/app-lifecycle.ts`) makes sure the 2 `APP_LIFECYCLE_EVENT` subscriptions exist at API server start and every 10 min (`LIFECYCLE_SUB_CHECK_MS`), and recreates missing ones with a log line. `--no-lifecycle` skips this.

## Worker wiring (`service/src/worker/main.ts` → `createWorker`)

| Concern | Single source of truth | Notes |
|---|---|---|
| Customer tokens | `portals` table (encrypted), via `PortalTokenProvider` | The same `PortalTokenProvider` (`service/src/hubspot/portal-tokens.ts`). There is no `.env` token fallback. Uninstalled or never installed → `PortalNotInstalledError` (permanent; nothing is held). Any other refresh failure (5xx, network, or a 4xx such as a bad client secret) → `TokenRefreshError`: stamps are retried, never dropped. A rejected refresh token (`invalid_grant` / `BAD_REFRESH_TOKEN`) → `TokenRevokedError`, and the portal is **paused**: its queue is kept and probed hourly; a reinstall lifts the pause; after 7 days (`PAUSE_MAX_MS`) the uninstall routine purges it. |
| Watched pairs | `portal_settings` (written by the installer and settings page, read by `Store.getWatchedPairs`) | Same table and schema in both stores. The worker watches only the active pairs (`portalPairs(...).active`, core/pairs.ts); its check is direction-insensitive. |
| Stamp spacing | `portals.stamp_spacing_seconds` (settings POST) | Used by the stamp queue. Portals without a `portals` row get the settings default (3 s, `DEFAULT_STAMP_SPACING_SECONDS`). |
| Label options | `createLabelOptionSync()` (one per process) | `onUnknownLabel(portal, from, to)` → sync the 3 label properties on `from` (and `to` when `STAMP_MIRROR=1`) **before** stamping (also when the label name comes from a stale cache because the refresh failed). Failure → label hold; announced only after a real sync (portal not installed → nothing recorded). A stamp refused as "not an option" clears the markers and re-syncs that object type (`stamp-queue.ts` `onInvalidOption`). Option values and stamped values come from the same functions (`${otherObjectTypeId}:${associationTypeId}`, `none`, `unknown`, `;`-joined; see [decisions.md](decisions.md) D7); `service/src/worker/hooks.test.ts` checks every stamped value is an option. |
| Lifecycle | journal `app_lifecycle_event` → `Lifecycle` (`service/src/worker/lifecycle.ts`) | Runs inside the journal run. Install: lift a pause. Uninstall: purge local data + write a `lifecycle_retry` row ("cleanup owed"), then `uninstallPortal` (hubspot/app-lifecycle.ts: token wiped first, then subscriptions deleted); a HubSpot failure is recorded on the portal, keeps the `lifecycle_retry` row, and is retried with back-off (30 s → 30 min) outside the journal path. The offset moves on. Alert `uninstall_retry_failing` is logged from the 10th failed attempt (at most hourly). Provisioning is the API server's job. |

Both processes open the same SQLite file. Each connection sets `busy_timeout` **before** switching to WAL.

## Run it locally

Full setup (your own HubSpot app, local HTTPS tunnel): [development.md](development.md).

1. `.env`: copy `.env.example`. Set `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_REDIRECT_URI=http://localhost:3001/oauth/callback`, `PORT=3001`, `PUBLIC_BASE_URL=<tunnel https url>`, and `TOKEN_ENC_KEYS` (see [configuration.md](configuration.md) for how to generate a key).
2. Start both processes: `pnpm --filter @changecatch/service dev` (API server + worker with health on 3002). Or in two terminals: `pnpm --filter @changecatch/service start:api` and `pnpm --filter @changecatch/service start:worker`.
3. Point an HTTPS tunnel at port 3001.
4. Install: open `http://localhost:3001/install`. An Enterprise portal with custom objects should show a second consent screen.
5. Check `http://localhost:3002/health`. Change an association in HubSpot. Within about a minute the record's `changecatch_*` properties change.

## Settings page

- Surface: an app **settings page** (`type: "settings"`, React, `@hubspot/ui-extensions`), the recommended account-level surface on the new developer platform.
- It lists Contact, Company, Deal plus the portal's custom objects (`GET /crm-object-schemas/2026-09/schemas`), shows every pair as a checkbox, and a number input for stamp spacing.
- The server URL comes from the HubSpot **config profile** used for the upload (`hubspot-app/src/hsprofile.<env>.json`, variable `PUBLIC_BASE_URL`). `app-hsmeta.json` uses `${PUBLIC_BASE_URL}` in `redirectUrls` and `permittedUrls.fetch`, and the settings page reads `context.variables.PUBLIC_BASE_URL`. It must equal `PUBLIC_BASE_URL` in the server's `.env` (HTTPS, no localhost). When the URL changes, see [runbook.md](runbook.md) B9.
  Docs: https://developers.hubspot.com/docs/developer-tooling/local-development/build-with-config-profiles.md

## After install

- Our own install link (`/install`): after the consent screen(s) the callback redirects to the ChangeCatch **Settings** tab in HubSpot: `https://app[-<region>].hubspot.com/connected-apps/{portalId}/installed/framework/{HUBSPOT_APP_ID}/settings/general-settings`. This URL is **not documented** by HubSpot (copied from the browser, 2026-11-07); recheck it after HubSpot UI changes. Without `HUBSPOT_APP_ID` a plain "installed" page is shown.
- Marketplace "seamless install": HubSpot sends `returnUrl` (and `step=finalize`) to the redirect URL; after the code exchange we **must** redirect there ("required to avoid an infinite login loop"). The `returnUrl` is kept through the custom-object consent inside the signed state, and only `https://app[-<region>].hubspot.com` URLs are accepted. The callback may be framed by `*.hubspot.com`.
  Docs: https://developers.hubspot.com/docs/apps/developer-platform/list-apps/understand-app-install-flow.md

## Known gaps

- The API server and the worker each have their own in-process per-portal lock. A settings save racing an uninstall in the other process isn't serialised (rare; both are idempotent).
- Parked or pending entries don't move the pairing "stream watermark", so a freed parked entry waits one more pairing window before it's stamped.
- We assume the 2026-09 token response includes `scopes`. If it doesn't, every portal looks like it has no custom scopes (custom objects stay off, the callback never chains). Check this on the first real install.

## Open points

- The upsert key of the subscription POST is still unknown; the design is safe either way (see above). Check once live: after a settings change, list subscriptions and confirm one subscription per object type.
- The listing shape of `APP_LIFECYCLE_EVENT` subscriptions (`eventTypeId` field) is assumed. If it differs, `ensureLifecycleSubscriptions` re-posts on each start (an upsert, so harmless), but fix the check.
- `listSubscriptions()` returns every subscription of the app (no paging). Fine for now; with hundreds of portals, check whether the API pages or filters by portal.
- ChangeCatch properties are not removed from the customer's portal on uninstall (HubSpot keeps them, and we have no token after uninstall).
