# ChangeCatch HubSpot app (project config)

This folder is the HubSpot developer project for the **production** ChangeCatch app.
It holds only the app definition (`src/app/app-hsmeta.json`) and the settings page
(`src/app/settings/`). The server and worker live elsewhere in this repo.

- Project name: `changecatch` (in `hsproject.json`). This is a NEW HubSpot project.
  It must never be uploaded over any other existing HubSpot project.
- Platform version: `2026.09`.
- Not included on purpose: the custom workflow action (parked, decision D4) and the
  app event definitions (waiting on HubSpot partner approval).

## 1. Config profiles (one per environment)

Per-environment values live in HubSpot **config profiles**, `src/hsprofile.<env>.json`
(docs: https://developers.hubspot.com/docs/developer-tooling/local-development/build-with-config-profiles.md).
A profile sets the target account and the variables; profiles are committed (values are URLs, never secrets).

```json
{ "accountId": 9206859, "variables": { "PUBLIC_BASE_URL": "https://<id>-3001.<region>.devtunnels.ms" } }
```

| Variable | Used in |
|---|---|
| `PUBLIC_BASE_URL` | `app-hsmeta.json` `auth.redirectUrls` (`${PUBLIC_BASE_URL}/oauth/callback`) and `permittedUrls.fetch` (`${PUBLIC_BASE_URL}/api/`); the settings page via `context.variables.PUBLIC_BASE_URL`. Public HTTPS origin, no trailing slash. Must equal `PUBLIC_BASE_URL` in the server's `.env`. |

Profiles today: `dev` (test portal 9206859, VS Code dev tunnel). Add production with
`hs project profile add prod --target-account <prod-account>`, then set its variables.
Once a project has profiles, every `upload` / `dev` / `validate` needs `--profile <env>`.

Still to replace before the Marketplace: `changecatch.example` (support email in `app-hsmeta.json` and
`SUPPORT_EMAIL` in the TSX), `USER_GUIDE_URL` in the TSX, and the `http://localhost:3001/oauth/callback`
redirect URL (local development only). Do not change the scopes without the owner's approval
(Marketplace rule: only the scopes we use).

## 2. Upload into the RIGHT account

The app must live in the production **developer account**, not the lab or a test account.

```sh
cd hubspot-app
npx hs accounts list                 # see which accounts the CLI knows
npx hs account auth                  # only if the production developer account is missing
npx hs project validate --profile prod
npx hs project upload --profile prod  # the profile's accountId picks the account
```

Before confirming, check that the CLI output names the production account ID and the
project `changecatch` in the intended account. If it names a different project or account, stop.

## 3. After the first upload, copy the IDs into the server config

In HubSpot: Development -> Projects -> changecatch -> ChangeCatch app -> Auth tab.

- App ID -> server env `HUBSPOT_APP_ID` (after install, users are sent to the app's Settings tab)
- Client ID and Client secret -> server env (OAuth client ID / secret). Never commit them.
- Confirm the redirect URL shown there matches the server's OAuth callback.
- Install URL -> use it for the first install into a test account.

Then create a client credentials token for this app (for the Webhooks Journal) and point
the server at it. Lab tokens, IDs, and subscriptions do not carry over.
