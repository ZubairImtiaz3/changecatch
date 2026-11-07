# Configuration

All configuration is through environment variables, loaded from `.env` at the repo root (copy `.env.example`). The API server and the worker read the **same** `.env` and open the **same** database file.

- Never commit `.env`. Never put secret values in `.env.example`.
- Empty or unset means "use the default".
- Durations are in milliseconds unless the name says otherwise.
- Invalid values (for example an unknown `COALESCE_MODE`) stop the process at start with a clear error.

Used by: **A** = API server, **W** = worker, **T** = tools.

---

## 1. HubSpot app credentials (required)

From the app in the HubSpot developer project (`hubspot-app/`).

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `HUBSPOT_CLIENT_ID` | A, W, T | (required) | App client ID. Used for OAuth and the client-credentials token. |
| `HUBSPOT_CLIENT_SECRET` | A, W, T | (required) | App client secret. Also verifies settings-page request signatures. |
| `HUBSPOT_APP_ID` | A | unset | Numeric app ID (the last number in the app's URL in HubSpot). When set, a finished install redirects to the ChangeCatch tab under Settings > Connected apps in the customer's portal. Unset = a plain "installed" page. Marketplace installs always return to HubSpot's `returnUrl`. |
| `HUBSPOT_JOURNAL_SCOPES` | W, T | `developer.webhooks_journal.read developer.webhooks_journal.subscriptions.read developer.webhooks_journal.subscriptions.write` | Space-separated scopes for the app-level client-credentials token (journal and subscriptions). |

## 2. Security and secrets

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `TOKEN_ENC_KEYS` | A, W, T | (required, or `TOKEN_ENC_KEY`) | Keys that encrypt every account's refresh token: comma list of `id:base64key` (32 bytes each). The **first** key is active; the others decrypt older values until re-encrypted. **Losing all keys = every account must reinstall.** |
| `TOKEN_ENC_KEY` | A, W, T | — | Single legacy key (32 bytes, base64 or hex). Still read for values written before rotation. |
| `HEALTH_TOKEN` | W | unset | `/health` and `/metrics` show per-account detail only when the request header `x-health-token` equals this. Unset = never. |
| `SETTINGS_ALLOW_UNSIGNED` | A | unset | `1` = skip settings-page signature checks. Local testing only: refused when `NODE_ENV=production` or when `PUBLIC_BASE_URL` is not localhost. |
| `NODE_ENV` | A, W | unset | `production` enables production safety checks. Also the default error-reporting environment. |

Generate a key:

```bash
node -e "console.log('k1:' + require('crypto').randomBytes(32).toString('base64'))"
```

Rotate: put the new key **first** in `TOKEN_ENC_KEYS` (keep the old one after it), restart both processes, then run the key-rotation tool from `@changecatch/tools` with `--apply` to re-encrypt stored tokens. Remove the old key only after that.

## 3. API server (install and settings)

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `HUBSPOT_REDIRECT_URI` | A | (required) | OAuth redirect URI, exactly as registered in the app. Its path is the callback route; its port is the listen port unless `PORT` is set. Example: `http://localhost:3001/oauth/callback`. |
| `PORT` | A | port of `HUBSPOT_REDIRECT_URI` | Listen port of the API server. |
| `PUBLIC_BASE_URL` | A | unset | Public HTTPS origin HubSpot calls for the settings page. Signatures are checked against `PUBLIC_BASE_URL + path`. Also builds the "enable custom objects" link. |
| `CHANGECATCH_DEFAULT_PAIRS` | A | `0-3:0-1,0-3:0-2,0-2:0-1` | Watched pairs for a new install (Deal ↔ Contact, Deal ↔ Company, Company ↔ Contact). Format `objectTypeId:associatedObjectTypeId`, comma-separated. |
| `CUSTOM_WRITE_MODE` | A | `conditional` | How custom-object write scopes are requested. `conditional` = second consent screen right after install for accounts with custom objects. `optional` = in `optional_scope` on the first screen. |
| `LIFECYCLE_SUB_CHECK_MS` | A | `600000` | How often the two `APP_LIFECYCLE_EVENT` journal subscriptions are checked and recreated if missing. |

## 4. Storage

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `DB_PATH` | A, W, T | `data/changecatch.db` | SQLite file shared by both processes. A relative path resolves against `service/` (so the default is `service/data/changecatch.db`). |
| `DB_MAINTENANCE_INTERVAL_MS` | A, W | `600000` | How often a long-lived connection runs pruning and `PRAGMA optimize`. `0` = off. |
| `SQLITE_WAL_AUTOCHECKPOINT` | A, W | `1000` | WAL auto-checkpoint size in pages. `0` = only an external replicator checkpoints (use only when one runs). |

## 5. Worker: journal reading

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `JOURNAL_POLL_MS` | W | `3000` | Interval between journal reads. A full batch re-reads at once. |
| `JOURNAL_IDLE_MAX_MS` | W | = `JOURNAL_POLL_MS` | Optional idle back-off: empty reads double the interval up to this. Default = no back-off. |
| `JOURNAL_ERROR_BASE_MS` | W | `5000` | First back-off after a failed read. Doubles each failure. |
| `JOURNAL_ERROR_MAX_MS` | W | `120000` | Cap for the failed-read back-off. |
| `JOURNAL_BATCH_SIZE` | W | `100` | Journal entries per batch read (1–100). |
| `JOURNAL_DOWNLOAD_CONCURRENCY` | W | `16` | Parallel journal file downloads. Processing order always follows the offset. |
| `JOURNAL_MAX_FILE_BYTES` | W | `20971520` (20 MB) | Size cap for one journal file. |
| `JOURNAL_DOWNLOAD_TIMEOUT_MS` | W | `15000` | Download timeout per journal file. |
| `JOURNAL_SKIP_FAILED_AFTER_MS` | W | `1800000` | Skip a journal entry that keeps failing (HTTP 207) after this long. Counted as data loss. |
| `JOURNAL_OFFSET_MAX_AGE_MS` | W | `172800000` | An empty journal read with a stored offset older than this (48 h) triggers an `earliest`/`latest` check (max every 5 min) to catch expired offsets that HubSpot returns as empty, not 404. Also the age at which `/health` reports `degraded`. Keep it under the ~72 h retention. |

## 6. Worker: pairing and labels

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `PAIRING_WINDOW_MS` | W | `2000` | `REMOVED` + `ADDED` for the same two records within this window form one `LABEL_CHANGED`. |
| `PAIRING_PUBLISH_SLACK_MS` | W | `4000` | Extra wait for HubSpot's publish delay. A held cluster is released at newest `occurredAt` + window + this. |
| `PAIRING_MAX_HOLD_MS` | W | `60000` | Safety cap on holding an unpaired cluster. |
| `PAIRING_SPLIT_HOLD_MS` | W | `4000` | A cluster that may be half of a split action is held until this long after its file's publish time. `0` = off. Late halves are still handled by late-half absorption. |
| `LABEL_MAX_HOLD_MS` | W | `1800000` | Give up holding or parking an unresolvable label after this; the change is stamped with `(unknown)`. |
| `PARK_MAX_PER_PORTAL` | W | `20000` | Max parked entries per account. Past it the newest are dropped with an alert. |

## 7. Worker: stamping

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `STAMP_SPACING_MS` | W | `3000` | Minimum gap between two stamps on one record, for accounts without a settings row. Installed accounts use the settings-page value (default 3 s). |
| `STAMP_MIRROR` | W | unset | `1` = also stamp the record on the other side of the association. |
| `COALESCE_MODE` | W | `latest` | `latest` = when a record has more than the threshold pending, stamp only the next due and the latest change. `off` = every change gets its own stamp. |
| `COALESCE_THRESHOLD` | W | `3` | Pending changes per record before coalescing starts (integer ≥ 2). |
| `STAMP_PORTAL_CONCURRENCY` | W | `8` | Accounts stamped in parallel per drain cycle. |
| `STAMP_RETRY_MAX_MS` | W | `86400000` (24 h) | Keep retrying a transient stamp failure this long, then dead-letter it. |
| `PORTAL_PAUSE_MAX_MS` | W | `604800000` (7 days) | An account with a revoked token is paused (queue kept, probed hourly). After this, its data is purged. |

## 8. Worker: lifecycle and process

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `LIFECYCLE_RETRY_BASE_MS` | W | `30000` | First retry delay for a failed install/uninstall step. |
| `LIFECYCLE_RETRY_MAX_MS` | W | `1800000` | Retry delay cap for lifecycle steps. |
| `LIFECYCLE_INSTALL_GRACE_MS` | W | `300000` | Grace period while the API server provisions a new install. |
| `WORKER_LOCK_STALE_MS` | W | `30000` | A second worker refuses to start while the lock heartbeat is newer than this. |
| `WORKER_HEALTH_PORT` | W | `3002` | Port for `/health` (JSON) and `/metrics` (Prometheus). |
| `WORKER_VERBOSE` | W | unset | `1` = log every journal read, including empty ones. |

## 9. HTTP and rate limits

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `HS_PORTAL_RATE_PER_10S` | A, W | `100` | Requests per 10 s per account (HubSpot's limit is 110). |
| `HS_PORTAL_MAX_WAIT_MS` | A, W | `10000` | If an account call would wait longer than this for the limiter, it is deferred instead of blocking. |
| `HTTP_TIMEOUT_MS` | A, W, T | `20000` | Timeout per HTTP attempt. A timeout is retried like a network error. |

The journal (80 req/s) and subscription (40 req/s) buckets are fixed in code, below HubSpot's app-level limits.

## 10. Logging, errors, monitoring

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `LOG_LEVEL` | A, W | `info` | `debug`, `info`, `warn`, or `error`. |
| `LOG_FORMAT` | A, W | `json` | `json` (one object per line; `info`/`debug` on stdout, `warn`/`error` on stderr) or `pretty`. Secrets are redacted in both. `pnpm dev` defaults to `pretty`. |
| `HEARTBEAT_URL` | W | unset | Dead-man's-switch URL. Pinged after successful journal reads (at most once a minute); `<url>/fail` when no read has succeeded for 1 hour (repeats at most once a minute). Unset = off. The URL is never logged. |
| `SENTRY_DSN` | A, W | unset | Enables Sentry error reporting (needs `@sentry/node`: `pnpm --filter @changecatch/service add @sentry/node`; loaded only when this is set). Set but the package is missing = one warning at start, errors go to the log. Unset = errors go to the log only. |
| `SENTRY_ENVIRONMENT` | A, W | `NODE_ENV`, else `production` | Sentry environment name. |
| `SENTRY_RELEASE` | A, W | unset | Release identifier, for example the git SHA. |
| `SENTRY_TRACES_SAMPLE_RATE` | A, W | `0` | Trace sampling rate. `0` = errors only. |

## 11. Tools only (`tools/`)

Never set these in production. The service never reads them.

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `HUBSPOT_TEST_PORTAL_ID` | T | unset | Test account ID, used when a tool's `--portal` flag is omitted. |
| `HUBSPOT_TEST_REFRESH_TOKEN` | T | unset | Fallback refresh token for the test account, used only if that account was never installed through the API server. Prefer a normal install. |
| `HUBSPOT_SETUP_TOKEN` | T | unset | Service key in the test account with write scopes. Used by the load-test and e2e tools to make association changes. |
| `CHANGECATCH_TEST_LABELS` | T | `Influencer,Decision maker,Billing contact` | Association label names the load test uses (looked up by name). |
| `SAMPLES_DIR` | T | `tools/samples` | Where tools write their JSON reports. |

Key rotation is a service CLI, not a tool: `pnpm --filter @changecatch/service exec tsx src/cli/rotate-token-key.ts` (dry run by default; `--apply` to re-encrypt).
