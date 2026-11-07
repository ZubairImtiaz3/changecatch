# Development

How to run, test, and develop ChangeCatch locally. Configuration is in [configuration.md](configuration.md); how the system works is in [architecture.md](architecture.md).

## Prerequisites

- Node.js 24+ and pnpm (version pinned in the root `package.json`).
- A HubSpot developer account and a developer **test account** with workflows (Pro or Enterprise). Custom objects need Enterprise.
- The HubSpot CLI comes with `@changecatch/hubspot-app` (`pnpm install` installs it). Authenticate once with `pnpm --filter @changecatch/hubspot-app exec hs account auth`.
- VS Code, for local HTTPS port forwarding (below).

## Workspace

| Package | Folder | What it contains |
|---|---|---|
| `@changecatch/service` | `service/` | API server (`src/api/`), worker (`src/worker/`), pipeline core, HubSpot clients, storage, observability |
| `@changecatch/hubspot-app` | `hubspot-app/` | HubSpot developer-platform project: app config, scopes, redirect URLs, settings page |
| `@changecatch/tools` | `tools/` | CLIs for operators and developers; imports `@changecatch/service` |

```bash
pnpm install
cp .env.example .env
pnpm --filter @changecatch/service dev            # API server + worker together
pnpm --filter @changecatch/service start:api      # API server only (port 3001)
pnpm --filter @changecatch/service start:worker   # worker only (/health on port 3002)
```

Both processes use `DB_PATH` (default `data/changecatch.db`). The `data/` folder and every `*.db` file are git-ignored.

### Recreate the dev DB

Needed once after the pre-launch squash ([decisions.md](decisions.md) D8): a DB file from before it is refused at start with "dev DB predates the squash". Also the way to start clean at any time.

1. Stop the API server and the worker.
2. Delete `service/data/changecatch.db` and its `-wal` / `-shm` files (or the file `DB_PATH` points to).
3. In `.env`, set `TOKEN_ENC_KEYS` (for example `k1:<32-byte base64 key>`; an old `TOKEN_ENC_KEY` value can be reused as `k1:<that value>`). `TOKEN_ENC_KEY` is no longer read; delete it.
4. Start both processes. The schema is created on first open.
5. Reinstall the app on the test portal (open the API server's `/install`), then pick the watched pairs again on the settings page. Stored tokens, settings and history are gone with the old file; the properties and journal subscriptions in HubSpot are reused.

## Tests

Tests use Node's built-in test runner through `tsx`. They run against in-memory SQLite and fake HubSpot clients, so they need no network and no `.env`.

```bash
pnpm test                                        # every package
pnpm typecheck                                   # every package
pnpm --filter @changecatch/service test          # service only
cd service && node --import tsx --test src/core/pairing.test.ts   # one file
```

Where tests live: small unit tests sit next to the code they test (`service/src/**/foo.test.ts`). Large tests go in `service/test/`: real-data replays and load-test regressions in `test/replay/`, burst/scale and worker robustness in `test/scale/`, and the shared test toolkit in `test/fixtures/` (used by both folders): journal events/files/offsets and fake journals (`journal.ts`), label fixtures (`labels.ts`), `memoryLogger` (`log.ts`), fake subscriptions (`subscriptions.ts`), the app-server fixture (`app-server.ts`), the replay driver (`replay.ts`), and `workerHarness` (`worker.ts`): the worker built by the production wiring (`buildWorker` in `src/worker/main.ts`) with HubSpot and the clock faked. `pnpm test` runs both folders.

Areas with dedicated tests: pairing (including recorded journal payloads and split files), late-half absorption (including bursts), coalescing and stamp planning, the stamp queue and fair drain, the poller, label options, install and scopes, request-signature security, storage migrations, the HTTP client and rate limiter, and observability. CI runs `pnpm typecheck` and `pnpm test` on every push.

When you change pipeline behaviour, add a test with a real payload shape. Journal behaviour under load (split files, late halves) is what broke in the past.

## The HubSpot project (`hubspot-app/`)

`hubspot-app/` is a project on HubSpot's developer platform (`hsproject.json`, platform version 2026.09 or newer). It defines:

- the app (`src/app/app-hsmeta.json`): name, OAuth redirect URLs, required, optional and conditionally required scopes, `permittedUrls.fetch`, support contact;
- the settings page (`src/app/settings/`): a React page using `@hubspot/ui-extensions` that calls the API server with `hubspot.fetch`.

### Use your own HubSpot app

Every environment needs **its own new HubSpot app**, created in your own developer account. Never upload to, or reuse the credentials of, an app that belongs to another environment: a project upload replaces the app's components and scopes for every account that has it installed.

1. In `hubspot-app/`, set a unique project `name` and app `uid`, and the app `name` "ChangeCatch" (add a suffix such as "ChangeCatch Dev" for non-production apps).
2. Add your redirect URI (for example `http://localhost:3001/oauth/callback`) to `auth.redirectUrls`.
3. Create a config profile for your environment and set its URL (see the next section):

   ```bash
   cd hubspot-app
   npx hs project profile add <env> --target-account <your-test-account-id>
   ```

4. Validate and upload with that profile:

   ```bash
   npx hs project validate --profile <env>
   npx hs project upload --profile <env>
   ```

5. Copy the new app's client ID, client secret and app ID into `.env` (`HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_APP_ID`).
6. Start the service and open `http://localhost:3001/install` to install the app into your test account. An Enterprise account with custom objects shows a second consent screen for the custom-object permissions.

Rules for project changes:

- Request only the scopes the code uses (a Marketplace requirement). Scope changes force existing installs to re-consent.
- Before an upload that removes components or changes scopes, check which accounts have the app installed.
- Keep `HUBSPOT_REDIRECT_URI` in `.env` identical to one of the registered redirect URLs.

## Local HTTPS for the settings page

The settings page runs inside HubSpot. `hubspot.fetch` calls are made by HubSpot's servers, so they need a **public HTTPS** URL; localhost does not work. Use VS Code port forwarding:

1. Start the API server (port 3001).
2. In VS Code, open the **Ports** panel, choose **Forward a Port**, and enter `3001`.
3. Right-click the port → **Port Visibility** → **Public**. (Private ports require a GitHub sign-in that HubSpot cannot do.)
4. Copy the forwarded address, for example `https://<id>-3001.<region>.devtunnels.ms`.
5. Set the same origin in two places:
   - `.env`: `PUBLIC_BASE_URL=https://<id>-3001.<region>.devtunnels.ms`
   - `hubspot-app/src/hsprofile.<env>.json`: `variables.PUBLIC_BASE_URL` (same value). The profile fills the redirect URL, `permittedUrls.fetch` and the settings page ([HubSpot config profiles](https://developers.hubspot.com/docs/developer-tooling/local-development/build-with-config-profiles.md)).
6. Restart the API server and upload: `npx hs project upload --profile <env>` from `hubspot-app/`.

The forwarded URL stays stable for the same VS Code account and port. If it changes, repeat step 5. Request signatures are verified against `PUBLIC_BASE_URL`, so a mismatch shows up as 401 responses from `/api/settings`.

For local `curl` tests of the settings API without HubSpot, `SETTINGS_ALLOW_UNSIGNED=1` skips the signature check. It is refused unless `PUBLIC_BASE_URL` is localhost or unset and `NODE_ENV` is not `production`.

## Checking a change end to end

1. Start the service and confirm `http://localhost:3002/health` reports a recent successful journal read.
2. In the test account, link, relabel, or unlink two records of a watched pair.
3. Within about 10 seconds the record on the subscribed side shows new `changecatch_*` values.
4. A workflow with trigger "ChangeCatch: last change ID has changed" and re-enrollment on should enroll once per change.

`/metrics` exposes Prometheus metrics. Per-account detail on `/health` and `/metrics` needs the `x-health-token` header set to `HEALTH_TOKEN`.

## Tools (`@changecatch/tools`)

Run any tool with:

```bash
pnpm --filter @changecatch/tools exec tsx src/<tool>.ts [args]
```

They read the same `.env` as the service. They cover journal inspection (read earliest, latest, from an offset, batch, download a file), subscription list/create/delete, label listing and option sync, property setup, test-data setup, token-key rotation, and the load test.

## Load test

The load test makes **real** association changes in a test account, then checks what the **running** worker did with them. It does not start the worker.

### Requirements

- The worker is running against the same `DB_PATH`, and its `/health` answers on `WORKER_HEALTH_PORT`.
- `HUBSPOT_TEST_PORTAL_ID` and `HUBSPOT_SETUP_TOKEN` (a service key in the test account with association write scopes) are set.
- The Deal ↔ Contact pair (`0-3:0-1`) is watched, and the labels "Influencer", "Decision maker", and "Billing contact" exist for it.
- The worker's last successful journal read was less than 10 minutes ago. The tool checks all of this before a real run.

### Running

```bash
pnpm --filter @changecatch/tools exec tsx src/load-test.ts burst-one-record --deal <dealId>         # dry run: plan + op count
pnpm --filter @changecatch/tools exec tsx src/load-test.ts burst-one-record --deal <dealId> --yes   # real run
```

| Scenario | What it does | Ops at defaults |
|---|---|---|
| `burst-one-record` | Links `--n` contacts to one deal with a label, relabels `--relabel` of them, unlinks all | 240 |
| `spread-many-records` | One link on each of `--n` deals, then unlinks | 200 |
| `label-churn` | `--links` links, each label flipped `--flips` times `--flip-gap` apart | 120 |
| `mixed` | Burst and spread at the same time | 440 |

Main options: `--n` (100), `--relabel` (20), `--max-ops` (500, hard cap per run), `--gap` (10 s between phases), `--settle` (15 s of quiet before "drained"), `--timeout` (1800 s), KPI targets `--kpi-p50` (10 s), `--kpi-p95` (20 s), `--kpi-correct` (100 %), `--kpi-wrong` (0), `--kpi-peak` (100 requests / 10 s), and `--append-kpis` to append the scorecard row to a KPI file.

### Safety

- It creates and deletes **no records**. It only uses record pairs that are not linked today, so there are no existing labels to restore.
- Every link it creates is removed in a `finally` block and re-read to confirm. Ctrl+C also cleans up; a second Ctrl+C quits without cleanup, and leftover pairs are saved to the result JSON.
- The `--max-ops` cap is checked on the plan and again on every write. Cleanup unlinks are never blocked.
- The tool sends at most 80 requests per 10 s (`TOOL_RATE_PER_10S`). HubSpot counts burst limits per app, so the service key does not use the worker's 110 / 10 s; 80 stays under the lowest private-app tier (100 / 10 s). See the comment in `tools/src/load-test-lib.ts`.

### Output

1. A functional PASS/FAIL table (sets the exit code): every change reached `change_log`, labels are right, the final stamp is the newest change, cleanup succeeded.
2. A KPI scorecard (PASS/WARN/FAIL): capture rate, wrong labels, missed stamps, p50/p95 latency from change to stamp, throughput, coalescing ratio, peak requests per 10 s, HubSpot errors.

Reference results (one account, 1,300 operations in about a minute): 100 % of changes captured, 0 wrong labels, 0 missed stamps, p50 ≈ 9 s, p95 ≈ 15 s, peak 15 requests per 10 s, 0 HubSpot errors.
