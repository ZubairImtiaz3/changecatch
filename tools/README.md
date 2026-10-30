# @changecatch/tools

Dev and test tools for ChangeCatch. They run against a **test portal** and a **running** service. They are not part of the deployed app.

Every tool is a **dry run by default**. It only reads, prints the plan, and changes nothing. Add `--yes` to make real changes.

## Setup

- Run `pnpm install` at the repo root. The tools import service code as `@changecatch/service/...` (workspace package).
- `.env`: the tools load the first `.env` they find for each variable, in this order: the current folder, `tools/.env`, `service/.env`, then the repo root `.env`. Variables already set in your shell win.
- `DB_PATH`: the worker's SQLite file. A relative path is resolved against `service/` (where the worker runs). The default is `service/data/changecatch.db`.
- Reports (JSON) go to `tools/samples/`, or to `SAMPLES_DIR` if you set it. Keep `tools/samples/` out of git.

Run the tools from `tools/`:

```sh
cd tools
pnpm exec tsx src/<tool>.ts [args]
```

### Environment variables

| Variable | Used by | What it is |
|---|---|---|
| `HUBSPOT_TEST_PORTAL_ID` | all | Fallback when `--portal` is not passed. There is no built-in default. |
| `HUBSPOT_SETUP_TOKEN` | e2e-check, load-test | A service key for the test portal. It makes the association changes. |
| `TOKEN_ENC_KEYS` / `TOKEN_ENC_KEY` | all except load-test | Decrypts the stored install token in `DB_PATH`, which gives the portal's OAuth token. |
| `HUBSPOT_TEST_REFRESH_TOKEN` | all except load-test | Dev-only fallback. Used only for `HUBSPOT_TEST_PORTAL_ID`, and you get a warning. Any uninstall revokes it. |
| App client credentials (see `.env.example`) | e2e-check | Used to list journal subscriptions. |
| `WORKER_HEALTH_PORT` | e2e-check, load-test | The worker's `/health` port. Default `3002`. |
| `CHANGECATCH_TEST_LABELS` | e2e-check, load-test | Deal->Contact label names, comma-separated. Same as `--labels`. |
| `DB_PATH`, `SAMPLES_DIR` | see above | |

**No portal-specific defaults.** The portal, the deal, and the record IDs are always flags, env vars, or picked at runtime. The tools look up association label type IDs by **name** with the labels API. The default names are `Influencer`, `Decision maker`, `Billing contact`. Use `--labels "A,B,C"` to pick others; they must already exist as Deal->Contact labels in the portal.

## Tools

### `properties-setup.ts`: create the ChangeCatch properties

Creates the `changecatch` property group and the `changecatch_*` properties on each object type. It is idempotent, so existing properties are skipped. It also migrates old free-text label properties to multiple checkboxes. If you get a 403 on a custom object (`2-…`), `crm.schemas.custom.write` was not granted.

```sh
pnpm exec tsx src/properties-setup.ts --portal <id> --objects 0-1,0-3,2-xxx         # dry run
pnpm exec tsx src/properties-setup.ts --portal <id> --objects 0-1,0-3,2-xxx --yes   # create
```

Auth: the portal's OAuth token (from its stored install).

### `labels-sync.ts`: sync label options

Adds one option per association label to the 3 label properties: `changecatch_label_before`, `changecatch_label_after`, and `changecatch_labels_current`. It only adds options and never removes any. Run it after `properties-setup`.

```sh
pnpm exec tsx src/labels-sync.ts --portal <id> --objects 0-1,0-3,2-xxx [--pairs 0-3:0-1,2-xxx:0-1] [--yes]
```

`--pairs` lists the watched pairs. By default it uses every pair among `--objects`.

### `e2e-check.ts`: one real change, end to end

Start the worker first. The tool runs read-only pre-checks: the journal subscription for Deal<->Contact, the watched pair in the DB, the worker's `/health`, and whether the OAuth token can read the deal. With `--yes`, it picks a contact that is **not** linked to the deal and does three steps:

1. Link it with label A. It expects `ADDED`.
2. Add label B and remove label A. It expects `LABEL_CHANGED` from A to B.
3. Remove the link. It expects `REMOVED`.

After each step, it polls the deal's `changecatch_*` stamp and checks the `change_log` row. The link is always removed at the end, even if a step fails. It never creates or deletes records.

```sh
pnpm exec tsx src/e2e-check.ts --portal <id> --deal <dealId>                 # dry run + pre-checks
pnpm exec tsx src/e2e-check.ts --portal <id> --deal <dealId> --yes [--contact <id>] [--labels "A,B"] [--gap 30] [--timeout 120]
```

### `load-test.ts`: load test plus KPI scorecard

Start the worker first. The tool makes many real association changes between **existing** deals and contacts, then reads the worker DB (read-only) and the deals' property history to check the results.

| Scenario | What it does |
|---|---|
| `burst-one-record` | Links N contacts to one deal (`--deal`), relabels `--relabel` of them, then unlinks them all. |
| `spread-many-records` | Links N different deals, 1 contact each, with labels 1/2/3 in turn, then unlinks them. |
| `label-churn` | Makes `--links` fresh links and flips each one's label `--flips` times. It compares the final stamp with HubSpot's real labels. |
| `mixed` | Runs burst and spread at the same time. Needs `--deal`. |

```sh
pnpm exec tsx src/load-test.ts mixed --portal <id> --deal <dealId>            # dry run: picks free pairs, prints the plan
pnpm exec tsx src/load-test.ts mixed --portal <id> --deal <dealId> --yes [--n 100] [--relabel 20] [--max-ops 500] [--append-kpis]
```

Other options: `--links 10 --flips 5 --flip-gap 1 --gap 10 --timeout 1800 --settle 15`. KPI targets: `--kpi-p50 10 --kpi-p95 20 --kpi-correct 100 --kpi-wrong 0 --kpi-peak 100`.

Safety rails:

- **Dry run by default.**
- **Op cap.** `--max-ops` (default 500) caps association operations. The run refuses to start if the plan goes over the cap.
- **Fresh links only.** It touches only pairs that are not linked today, and never creates or deletes records.
- **Cleanup.** Every link it created is removed in `finally`, including on the first Ctrl+C, and then re-checked. A second Ctrl+C quits without cleanup.
- **Rate limit.** A client-side limit of 80 requests per 10 s leaves headroom under the portal's 110 per 10 s, which it shares with the app.
- **Pre-checks.** It won't start unless the worker DB has the 0-3:0-1 pair and the worker read the journal in the last 10 minutes.

Output: a functional PASS/FAIL table, then the **KPI scorecard** (correctness, latency, throughput, per-portal pressure, efficiency, burst isolation, resources) with a PASS/WARN/FAIL verdict. The JSON goes to `samples/`. `--append-kpis` adds one row to `docs/kpis.md` at the repo root.

## Files

- `src/lib/env.ts`: loads `.env` and sets `DB_PATH` to an absolute path. Import it first in every tool.
- `src/lib/paths.ts`: the repo, service, and tools roots, `dbPath()`, and the samples folder.
- `src/lib/cli.ts`: argument parsing, `portalIdFrom()`, `saveSample()`, and `run()`.
- `src/lib/portal-token.ts`: the portal's OAuth token, from the stored install (with the env fallback described above).
- `src/lib/test-labels.ts`: label names from flags or env, and lookup by name.
- `src/load-test-lib.ts`: the rate limiter, HubSpot association helpers, a read-only worker DB view, and stats.
