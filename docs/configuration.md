# Configuration

All configuration is through environment variables, loaded from `.env` at the repo root (copy `.env.example`). The API server, the worker and the tools read the **same** `.env` and open the **same** database file.

- `service/src/lib/config.ts` is the only code that reads them. Each process calls `loadConfig()` once at start and passes the values down.
- A variable's default is exported by the module that uses the value (for example `HS_PORTAL_RATE_PER_10S` in `lib/rate-limiter.ts`, `DEFAULT_RETRY_WINDOW_MS` in `worker/stamp-queue.ts` for `STAMP_RETRY_MAX_MS`); `config.ts` imports it.
- `config.test.ts` checks that the tables below list exactly these variables and that each Default matches the code.
- Never commit `.env`. Never put secret values in `.env.example`.
- Empty or unset means "use the default".
- Durations are in milliseconds unless the name says otherwise.
- A missing required variable or an invalid value (for example `LOG_LEVEL=loud` or `JOURNAL_POLL_MS=fast`) stops the process at start with one clear error.
- Only what an operator sets is a variable. Tuning values that never change are named constants in the code (see the last section).

Used by: **A** = API server, **W** = worker, **T** = tools.

---

## 1. HubSpot app credentials (required)

From the app in the HubSpot developer project (`hubspot-app/`).

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `HUBSPOT_CLIENT_ID` | A, W, T | (required) | App client ID. Used for OAuth and the client-credentials token. |
| `HUBSPOT_CLIENT_SECRET` | A, W, T | (required) | App client secret. Also verifies settings-page request signatures. |
| `HUBSPOT_APP_ID` | A | unset | Numeric app ID (the last number in the app's URL in HubSpot). When set, a finished install redirects to the ChangeCatch tab under Settings > Connected apps in the customer's portal. Unset = a plain "installed" page. Marketplace installs always return to HubSpot's `returnUrl`. |

## 2. Security and secrets

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `TOKEN_ENC_KEYS` | A, W, T | (required) | Keys that encrypt every account's refresh token: comma list of `id:base64key` (32 bytes each). The **first** key is active; the others decrypt older values until re-encrypted. **Losing all keys = every account must reinstall.** |
| `HEALTH_TOKEN` | W, T | unset | `/health` and `/metrics` show per-account detail only when the request header `x-health-token` equals this. Unset = never. |
| `SETTINGS_ALLOW_UNSIGNED` | A | `0` | `1` = skip settings-page signature checks. Local testing only: refused when `NODE_ENV=production` or when `PUBLIC_BASE_URL` is not localhost. |
| `NODE_ENV` | A, W | unset | `production` enables production safety checks (`PUBLIC_BASE_URL` required and https). |

Generate a key:

```bash
node -e "console.log('k1:' + require('crypto').randomBytes(32).toString('base64'))"
```

Rotate: put the new key **first** in `TOKEN_ENC_KEYS` (keep the old one after it), restart both processes, then run the key-rotation CLI with `--apply` to re-encrypt stored tokens (see section 7). Remove the old key only after that.

## 3. API server (install and settings)

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `HUBSPOT_REDIRECT_URI` | A | (required) | OAuth redirect URI, exactly as registered in the app. Its path is the callback route; its port is the listen port unless `PORT` is set. Example: `http://localhost:3001/oauth/callback`. |
| `PORT` | A | port of `HUBSPOT_REDIRECT_URI` | Listen port of the API server. |
| `PUBLIC_BASE_URL` | A | unset | Public HTTPS origin HubSpot calls for the settings page (no path). Signatures are checked against `PUBLIC_BASE_URL + path`. Also builds the "enable custom objects" link. Required when `NODE_ENV=production`. |

## 4. Storage

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `DB_PATH` | A, W, T | `data/changecatch.db` | SQLite file shared by every process. A relative path resolves against `service/` (so the default is `service/data/changecatch.db`). |

## 5. Worker

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `HS_PORTAL_RATE_PER_10S` | A, W | `100` | Requests per 10 s per account (HubSpot allows 110). Incident lever: lower it (e.g. 60) if a portal runs near its limit, then restart both processes. |
| `JOURNAL_POLL_MS` | W | `3000` | Interval between journal reads (at least 1). A full batch re-reads at once. |
| `PAIRING_WINDOW_MS` | W | `2000` | `REMOVED` + `ADDED` for the same two records within this window form one `LABEL_CHANGED`. Incident override only. |
| `PAIRING_SPLIT_HOLD_MS` | W | `4000` | A cluster that may be half of a split action is held until this long after its file's publish time. `0` = off. Late halves are still handled by late-half absorption. Incident override only. |
| `STAMP_MIRROR` | W | `0` | `1` = also stamp the record on the other side of the association. |
| `STAMP_RETRY_MAX_MS` | W | `86400000` (24 h) | Keep retrying a transient stamp failure this long, then dead-letter it (1 h to 7 days). Incident lever: raise it during a long HubSpot outage. |
| `WORKER_HEALTH_PORT` | W, T | `3002` | Port for `/health` (JSON) and `/metrics` (Prometheus). |

## 6. Logging and monitoring

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `LOG_LEVEL` | A, W | `info` | `debug`, `info`, `warn`, or `error`. |
| `LOG_FORMAT` | A, W | `json` | `json` (one object per line; `info`/`debug` on stdout, `warn`/`error` on stderr) or `pretty`. Secrets are redacted in both. `pnpm --filter @changecatch/service dev` defaults to `pretty`. |
| `HEARTBEAT_URL` | W | unset | Dead-man's-switch URL. Pinged after successful journal reads (at most once a minute); `<url>/fail` when no read has succeeded for 1 hour (repeats at most once a minute). Unset = off. The URL is never logged. |

## 7. Tools only (`tools/`)

Never set these in production. The API server and the worker ignore them.

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `HUBSPOT_TEST_PORTAL_ID` | T | unset | Test account ID, used when a tool's `--portal` flag is omitted. |
| `HUBSPOT_SETUP_TOKEN` | T | unset | Service key in the test account with write scopes. Used by the load-test and e2e tools to make association changes. |
| `CHANGECATCH_TEST_LABELS` | T | `Influencer,Decision maker,Billing contact` | Association label names the tools use (looked up by name). |
| `SAMPLES_DIR` | T | `tools/samples` | Where tools write their JSON reports. A relative path resolves against the repo root. |

Key rotation is a service CLI, not a tool: `pnpm --filter @changecatch/service exec tsx src/cli/rotate-token-key.ts` (dry run by default; `--apply` to re-encrypt).

## Fixed values (constants, not variables)

These used to be variables but never needed changing. Change one by editing the constant and redeploying. The
values live only in the code (config.test.ts checks each constant below exists in the named file).

| Value | Constant (file under `service/src/`) |
|---|---|
| WAL auto-checkpoint size | `WAL_AUTOCHECKPOINT_PAGES` (`store/sqlite.ts`) |
| Pruning + `PRAGMA optimize` interval (never off: it is the only pruning) | `MAINTENANCE_INTERVAL_MS` (`store/sqlite.ts`) |
| Journal batch size (HubSpot's maximum) | `MAX_BATCH` (`hubspot/journal.ts`) |
| Failed-read back-off (doubling, capped) | `DEFAULT_DELAY_CONFIG` (`worker/schedule.ts`) |
| Journal file size cap and download timeout | `JOURNAL_MAX_FILE_BYTES`, `JOURNAL_DOWNLOAD_TIMEOUT_MS` (`hubspot/journal.ts`) |
| Parallel journal file downloads | `JOURNAL_DOWNLOAD_CONCURRENCY` (`worker/journal-reader.ts`) |
| Skip a journal entry that keeps failing (HTTP 207) after this long (counted as data loss) | `JOURNAL_SKIP_FAILED_AFTER_MS` (`worker/journal-reader.ts`) |
| Offset age that triggers the expired-offset check and `/health` `degraded` | `JOURNAL_OFFSET_MAX_AGE_MS` (`worker/journal-reader.ts`) |
| Earliest/latest offset check interval (`/health` trusts it for twice that) | `OFFSET_CHECK_EVERY_MS` (`worker/journal-reader.ts`) |
| Pairing publish slack and max hold | `DEFAULT_PAIRING_CONFIG` (`core/pairing.ts`) |
| Label definitions cache time, refetch spacing per pair, give up on an unresolvable label (stamped `unknown`) | `LABEL_TTL_MS`, `LABEL_MIN_REFETCH_MS`, `LABEL_MAX_HOLD_MS` (`worker/label-guard.ts`) |
| Parked entries per account cap | `MAX_PARKED_PER_PORTAL` (`core/poller.ts`) |
| Coalescing: always `latest`, threshold of pending changes per record | `COALESCE_THRESHOLD` (`core/coalesce.ts`) |
| Stamp spacing for an account without a settings row (the settings default) | `DEFAULT_STAMP_SPACING_SECONDS` (`store/schema.ts`) |
| Accounts stamped in parallel per drain cycle | `STAMP_PORTAL_CONCURRENCY` (`worker/stamp-queue.ts`) |
| Purge an account paused for a revoked token after this long | `PAUSE_MAX_MS` (`worker/stamp-queue.ts`) |
| Uninstall-cleanup retry back-off | `Lifecycle` defaults (`worker/lifecycle.ts`) |
| Lifecycle subscriptions check interval | `LIFECYCLE_SUB_CHECK_MS` (`hubspot/app-lifecycle.ts`) |
| A second worker refuses to start while the lock heartbeat is newer than this | `WORKER_LOCK_STALE_MS` (`worker/main.ts`) |
| Defer a portal call that would wait longer than this for the limiter; timeout per HTTP attempt | `HS_PORTAL_MAX_WAIT_MS`, `HTTP_TIMEOUT_MS` (`lib/http.ts`) |
| No successful journal read for this long = stale (alert, `/health` 503) | `STALE_AFTER_MS` (`worker/health.ts`) |
| Heartbeat repeat interval and timeout | `MIN_INTERVAL_MS`, `TIMEOUT_MS` (`obs/heartbeat.ts`) |
| Watched pairs for a new install | `core/pairs.ts` |

The journal and subscription buckets are fixed in `lib/rate-limiter.ts` (`RateLimiter.appCfg`), below HubSpot's app-level limits. Journal reads with events are logged at `info`; empty reads are not logged.
