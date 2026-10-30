# ChangeCatch HubSpot app (project config)

This folder is the HubSpot developer project for the **production** ChangeCatch app.
It holds only the app definition (`src/app/app-hsmeta.json`) and the settings page
(`src/app/settings/`). The server and worker live elsewhere in this repo.

- Project name: `changecatch` (in `hsproject.json`). This is a NEW HubSpot project.
  It must never be uploaded over any other existing HubSpot project.
- Platform version: `2026.09`.
- Not included on purpose: the custom workflow action (parked, decision D4) and the
  app event definitions (waiting on HubSpot partner approval).

## 1. Fill in the placeholders first

Search for `REPLACE-WITH-PUBLIC-BASE-URL` and `changecatch.example`.

| Where | What to set |
|---|---|
| `src/app/settings/ChangeCatchSettings.tsx` -> `API_BASE` | Public HTTPS base URL of the ChangeCatch server, no trailing slash (e.g. `https://app.example.com`) |
| `src/app/app-hsmeta.json` -> `permittedUrls.fetch` | Same base URL + `/api/` |
| `src/app/app-hsmeta.json` -> `auth.redirectUrls` | Production `<base URL>/oauth/callback`. Keep `http://localhost:3001/oauth/callback` only while developing locally; remove it before the Marketplace listing |
| `src/app/app-hsmeta.json` -> `support.supportEmail` and `SUPPORT_EMAIL` in the TSX | Real support email |
| `USER_GUIDE_URL` in the TSX | Hosted user guide URL |

The server's `PUBLIC_BASE_URL` must match `API_BASE` exactly. Do not change the scopes
without the owner's approval (Marketplace rule: only the scopes we use).

## 2. Upload into the RIGHT account

The app must live in the production **developer account**, not the lab or a test account.

```sh
cd hubspot-app
npx hs accounts list                 # see which accounts the CLI knows
npx hs account auth                  # only if the production developer account is missing
npx hs accounts use <prod-account>   # make it the default, or pass --account below
npx hs project validate
npx hs project upload --account=<prod-account>
```

Before confirming, check that the CLI output names the production account ID and the
project `changecatch` in the intended account. If it names a different project or account, stop.

## 3. After the first upload, copy the IDs into the server config

In HubSpot: Development -> Projects -> changecatch -> ChangeCatch app -> Auth tab.

- App ID -> server env (app ID)
- Client ID and Client secret -> server env (OAuth client ID / secret). Never commit them.
- Confirm the redirect URL shown there matches the server's OAuth callback.
- Install URL -> use it for the first install into a test account.

Then create a client credentials token for this app (for the Webhooks Journal) and point
the server at it. Lab tokens, IDs, and subscriptions do not carry over.
