# Observability: logs, metrics, errors, heartbeat, alerts

The building blocks live in `service/src/obs/`, with tests in `service/src/obs/obs.test.ts`. None of them adds a package.

| File | What it gives you |
|---|---|
| `service/src/obs/log.ts` | The one `Logger` (JSON lines, `log.alert()` / `log.alertCleared()`), `ALERTS` (every alert name) + `redact()` / `redactString()` |
| `service/src/obs/metrics.ts` | Metrics registry (the only place counts live), the standard ChangeCatch metrics, Prometheus + JSON output (full or public) |
| `service/src/obs/errors.ts` | Throttled exception writer (crashes, unhandled rejections), one line per error shape per 5 min |
| `service/src/obs/alerts.ts` | `AlertThrottle` (one throttle for repeated alerts) |
| `service/src/obs/heartbeat.ts` | Dead-man's-switch ping to Healthchecks.io (or any URL that takes `/fail`) |
| `service/src/worker/health.ts` | Worker `/health` (JSON) and `/metrics` (Prometheus), extra worker gauges, and the stale rule + alert (`STALE_AFTER_MS`, `isStale`, `StaleAlerter`) |
| `service/src/lib/process.ts` | `startProcess(config, { log, metrics? })`: log level/format, crash reporting, the shared rate limiter and HTTP metrics, once per process |

Env vars for all of this are in [configuration.md](configuration.md) section 10. The incident playbooks that use these signals are in [runbook.md](runbook.md).

## Wiring status

| Piece | Status |
|---|---|
| Metrics registry in the worker, `/metrics` and `/health` | Wired. |
| Journal metrics (`journal_*`, `files_read`, `events_read`, `changes_processed`) | Wired. `journal_offset_age_seconds` uses the saved offset and survives restarts. |
| Stamp metrics (`stamps_sent`, `stamps_failed`, `stamp_queue_depth`, `e2e_latency_ms`) | Wired. |
| `http_requests`, `http_errors`, `rate_limited` | Counted inside `service/src/lib/http.ts` (the one way out to HubSpot), per attempt, once the worker calls `startProcess(config, { log, metrics })`. The app server and the tools pass no metrics (not counted; the app server has no metrics endpoint). |
| `data_loss` | Wired: `dead_letter`, `stamp_dropped` (stamp queue), `skipped_entries`, `offset_expired` (journal reader), `park_dropped` (worker, from the poller's result). |
| Worker gauges (`dead_letters`, `portals_paused`, `lifecycle_retries_pending`, `parked_entries`) and `stamps_coalesced` | Wired. |
| `forgetPortal` on uninstall | Wired. |
| Stale alert (alert `worker_stale`, `/health` → 503, heartbeat `/fail`) | Wired. |
| JSON logger | Wired in the worker and the app server: one root logger per process, a child per component, passed to the modules (`lib/http.ts` gets it from `startProcess`; a few modules, e.g. `hubspot/properties.ts`, still create their own logger, which follows `LOG_LEVEL` / `LOG_FORMAT` too). `pnpm --filter @changecatch/service dev` defaults to `LOG_FORMAT=pretty`. |
| Error reporting (log backend) | Wired in both processes: crashes and unhandled rejections, and app server route failures (as exceptions, with a stack). Everything else is one `log.error` / `log.alert` line. |
| Heartbeat | Wired in the worker. `HEARTBEAT_URL` works. |

`/health` counts (`totals`, per-portal rows, `latency`) come from the in-memory metrics, so they start at 0 when the worker starts. The database keeps only state (offset, last read, queue, dead letters, pauses) and the last error per portal.

Section 6 lists where each call is made.

---

## 1. Logs (`service/src/obs/log.ts`)

One JSON object per line. `info`/`debug` go to stdout, `warn`/`error` to stderr.

```json
{"level":"info","ts":"2026-10-30T09:12:01.123Z","component":"worker","portalId":12345678,"event":"stamp_sent","msg":"stamped 12 records","n":12}
```

```ts
import { createLogger } from '../obs/log.js';
const log = createLogger('worker');     // the process's root logger; modules get log.child({ component })
log.info('journal_read', 'read 3 files', { files: 3, events: 41 });
log.child({ portalId }).warn('stamp_retry', 'retry in 30s', { attempts: 2 });
log.alert('stamps_refused', 'portal 123: 20 stamps refused in a row', { portalId: 123 });
log.alertCleared('worker_stale', 'journal reads are succeeding again');
```

- `event` is a short snake_case name. Search logs by it (`event=stamp_sent`), not by message text.
- Env: `LOG_LEVEL` = `debug|info|warn|error` (default `info`). `LOG_FORMAT=pretty` for local reading.
- **Redaction runs on every message and every field**, so a token can't leak even by accident:
  - Keys: anything named like `token`, `accessToken`, `refresh_token`, `*_secret`, `password`, `authorization`, `cookie`, `apiKey`, `signature`, `dsn`, and `code` (OAuth code; error codes like `ECONNRESET` or `429` are kept).
  - Values: `Bearer …`, `pat-na1-…` keys, HubSpot refresh tokens (`na1-xxxx-…`), JWTs, `access_token=` / `client_secret=` / `code=` / `state=` in URLs, the whole query of signed URLs (`X-Amz-…`, `sig=`, `signature=`), `user:pass@` in URLs (DSNs, connection strings), hex runs of 32+ chars, base64 runs of 40+ chars with letters and digits (HubSpot access tokens).
  - Kept on purpose: journal offsets (UUIDs), portal IDs, object type IDs, API paths.
- A message never contains CR/LF (one record = one line, also in the pretty format).
- **Alerts:** `log.alert(name, msg, fields)` writes ONE line: `level=error`, `event=alert`, `alert=<name>` (nothing else is sent anywhere). Callers throttle repeats with `AlertThrottle`. `log.alertCleared(name, msg)` writes `level=info`, `event=alert_cleared`, `alert=<name>`. Search `event=alert`, then narrow by `alert`. Pass `portalId` as a field (it is never read from the message text). Alert names:

  | `alert` | Where | Meaning |
  |---|---|---|
  | `worker_stale` | `worker/health.ts` StaleAlerter | No successful journal read for 1 h. Repeats every 15 min; `alert_cleared` when reads work again. |
  | `offset_expired` | `worker/journal-reader.ts` | Stored offset expired (HTTP 404 or empty read); restarted from earliest. Data was lost. |
  | `journal_entries_skipped` | `worker/journal-reader.ts` | Journal entries skipped after a lasting HTTP 207. Data was lost. |
  | `journal_file_rejected` | `worker/journal-reader.ts` | A journal file URL/size was refused for safety (offset held). |
  | `parked_entries_dropped` | `core/poller.ts` | Parked entries over the per-portal cap were dropped. Data was lost. |
  | `stamps_refused` | `worker/stamp-queue.ts` | Many stamps of one portal refused in a row (at most every 15 min per portal). |
  | `portal_paused` | `worker/stamp-queue.ts` | Token revoked/invalid: portal paused. |
  | `pause_expired` | `worker/stamp-queue.ts` | Paused for 7 days: running the uninstall routine. |
  | `uninstall_retry_failing` | `worker/lifecycle.ts` | HubSpot cleanup of an uninstall keeps failing (from retry 10, at most hourly per portal). |
  | `provisioning_failing` | `install/installer.ts` (API server) | A portal failed provisioning 3 sweeps in a row (then at most hourly). |
  | `worker_lock_lost` / `worker_lock_refused` | `worker/main.ts` | Another worker holds the lock: this one stops / does not start. |

- Worker events you can search on: `worker_started`, `worker_stopped`, `journal_read`, `journal_run_failed`, `batch_held`, `entries_parked`, `queue_drain`, `queue_drain_failed`, `stamp_sent`, `stamp_retry`, `dead_letter`, `alert`, `alert_cleared`, `fatal`. Components: `worker`, `poller`, `journal`, `stamp`, `labels`, `lifecycle`, `install`, `oauth`, `health`, `heartbeat`, `errors`. App server: component `app` (events `oauth_install`, `oauth_state_rejected`, `oauth_error`, `oauth_code_exchange_failed`, `install_provisioning_failed`, `settings_signature_rejected`, `settings_save_failed`, `unhandled`, `app_started`, `shutdown`, `fatal`; each carries the `ref` shown to the user).
- **Volume rule:** log one `info` summary per drain, not one line per stamp. At 500k changes/day, one line per stamp is too much.

---

## 2. Metrics (`service/src/obs/metrics.ts`)

One `ChangeCatchMetrics` per process, passed down as a dependency. It wraps a `MetricsRegistry`.

- Counters, gauges, histograms. Histograms keep the last 2,048 samples per series for p50/p95/p99, plus lifetime count and sum.
- **One source:** every count lives here (nothing is counted again in SQLite). Recording a name that was never `define()`d throws, so a typo fails in tests.
- **Bounded cardinality:** at most 250 label sets per metric. Past that, new label sets are folded into `portal="_other"`, and `changecatch_metrics_series_overflow_total{metric}` goes up. On uninstall the worker calls `forgetPortal(id)`.
- Output: `toPrometheus(publicView)` (text format 0.0.4, prefix `changecatch_`, counters get `_total`, histograms are exported as `summary`) and `toJSON(publicView)` (compact, top 20 series per metric, for `/health`).
- **Privacy:** a metric with a `portal` label is declared `{ perPortal: true }`. The public view sums it over `portal`. `/health` and `/metrics` show the public view unless the request has the header `x-health-token` equal to `HEALTH_TOKEN`. With `HEALTH_TOKEN` unset, portal ids never appear. Rate limiter buckets in `/health` are split into `app` (always shown) and `portals` (token only).

### Standard metrics

| Name (Prometheus) | Type | Labels | Meaning |
|---|---|---|---|
| `changecatch_journal_read_age_seconds` | gauge | | now − last successful journal read |
| `changecatch_journal_last_success_timestamp_seconds` | gauge | | Unix time of the last successful read |
| `changecatch_journal_offset_age_seconds` | gauge | | now − the time **inside** the saved offset. Offsets are UUIDv7, so their first 48 bits are the Unix-ms time HubSpot wrote that entry. This is how old the newest journal entry we've consumed is. Falls back to "time the offset was saved". |
| `changecatch_journal_caught_up` | gauge | | 1 = last batch not full, 0 = backlog |
| `changecatch_journal_lag_seconds` | gauge | | now − `occurredAt` of the newest event processed in the last run; 0 when caught up and nothing new |
| `changecatch_journal_reads_total` | counter | `result=ok\|error` | Journal runs |
| `changecatch_files_read_total` | counter | | Journal files downloaded |
| `changecatch_events_read_total` | counter | | Journal events read |
| `changecatch_changes_processed_total` | counter | `portal` | Changes produced |
| `changecatch_stamps_sent_total` | counter | `portal` | Records stamped |
| `changecatch_stamps_failed_total` | counter | `portal, reason=retry\|gave_up\|dropped` | Failed stamp attempts |
| `changecatch_stamp_queue_depth` | gauge | `portal` | Stamps waiting (updated after each drain; the public view is the total) |
| `changecatch_stamps_coalesced_total` | counter | | Stamps folded into a later stamp on the same record |
| `changecatch_e2e_latency_ms` | summary | | `occurredAt` → stamp accepted. `/health` `latency` is read from it. |
| `changecatch_http_requests_total` | counter | `api=journal\|journal_file\|crm\|oauth\|subscriptions\|other` | Worker requests to HubSpot; `journal_file` = presigned journal file downloads (denominator for the error rate). Retries count as requests. |
| `changecatch_http_errors_total` | counter | `status` (400, 401, 403, 404, 409, 423, 429, 500, 502, 503, 504, `4xx`, `5xx`, `timeout`, `network`) | Errors |
| `changecatch_token_refreshes_total` | counter | `result=ok\|revoked\|error` | Customer OAuth access-token refresh calls to HubSpot (callers that joined a running refresh are not counted) |
| `changecatch_rate_limited_total` | counter | `portal` (`app` = app-level limit) | HubSpot 429 responses, plus requests refused at once because our own limiter was full for longer than `HS_PORTAL_MAX_WAIT_MS` (10 s) (one per request, not per stamp). Short inline limiter waits are not counted. |
| `changecatch_data_loss_total` | counter | `reason, portal` | **A change that will never be stamped.** Reasons: `dead_letter` (gave up after retries), `skipped_entries` (journal file skipped after a lasting HTTP 207), `stamp_dropped` (CRM rejected the record for good), `offset_expired` (stored offset older than the ~3 day retention: HTTP 404 or an empty read; restarted from earliest), `park_dropped` (parked entries over the per-portal cap) |

### Worker gauges (`service/src/worker/health.ts`)

Computed from the database at scrape time.

| Name (Prometheus) | Type | Meaning |
|---|---|---|
| `changecatch_dead_letters` | gauge | Stamps in `stamp_dead_letter`, per portal |
| `changecatch_portals_paused` | gauge | Portals paused because their token is revoked or invalid |
| `changecatch_lifecycle_retries_pending` | gauge | Uninstall cleanups in HubSpot (deleting the portal's journal subscriptions) waiting for a retry |
| `changecatch_parked_entries` | gauge | Association entries parked (label lookup held), all portals |

Not built yet (add when needed, with `registry.defineComputedGauge()`): oldest due stamp age, database size / free disk ratio, backup replication lag, clock skew.

---

## 3. Heartbeat (`service/src/obs/heartbeat.ts`)

The **one alert that works when the host itself is down.** Healthchecks.io free tier (20 checks, email + phone push) is enough.

- Env: `HEARTBEAT_URL=https://hc-ping.com/<uuid>`. Not set = off.
- `heartbeat.ok()` after each successful journal run. Throttled to one ping per 60 s.
- `heartbeat.fail(reason)` on every loop pass while the worker is stale (no successful read for 1 h). The first one goes to `HEARTBEAT_URL/fail` at once; repeats are throttled to one a minute. The next successful read sends an ok ping at once.
- A state change is sent at once; a failed ping is retried on the next call. It never throws and never logs the URL.
- **Set up the check:** Period 1 minute, Grace **10 minutes**. You're paged if there's no successful read for about 11 min, or at once on `/fail`. Add the on-call email and the Healthchecks phone app as integrations.

---

## 4. Errors (`service/src/obs/errors.ts`)

```ts
import { errors } from '../obs/errors.js';
startProcess(config, { log });  // lib/process.ts, once at start: reports go to log.child({ component: 'errors' }); unhandledRejection + uncaughtException
errors.capture(err, { op: 'settings', portalId, extra: { ref } });
```

- One problem = one log line. `Errors` writes only failures nobody else logs: uncaught exceptions (then exit), unhandled rejections, and app server route failures (`op` = `oauth_code_exchange`, `install`, `settings`, `unhandled`). Worker failures are the single `log.error` line of their event (`journal_run_failed`, `queue_drain_failed`, `lifecycle_retry_failed`, `dead_letter`, `fatal`, with the error and stack as a field); alerts are the single `log.alert()` line. Held labels and unfinished stamp batches are expected states and are only logged as warnings.
- Backend: the JSON logger (`event: "exception"`), redacted like every log line. There is no external error service (Sentry was removed before launch); page on these lines through the log or metric alerts in section 5.
- **Throttling:** the same error shape (numbers and UUIDs stripped) is reported at most once per 5 min; the skipped count rides along as `suppressedSinceLast`. A stuck loop can't flood the log.

---

## 5. Alerts and a low-cost stack

Hosting is not chosen yet. This stack works with any host that can run the two processes.

| Layer | Tool | Cost | What it catches |
|---|---|---|---|
| Dead-man's switch | Healthchecks.io (`HEARTBEAT_URL`) | free | Worker down, host down, journal stuck > ~11 min, stale |
| Metrics + dashboards | Any Prometheus-compatible scraper + Grafana (for example the host's managed metrics, or Grafana Cloud free) | free tier | Everything in section 2 |
| Metric alerts | Grafana alert rules on that data source | free tier | Rules below |
| Uptime of the install path | UptimeRobot or Better Stack free, `GET https://<public url>/health` every 1–5 min | free | API server down, TLS, DNS |
| Logs older than a few days | Better Stack or Axiom free (optional) | free | Searching old logs (a subprocessor) |

**Scraping:** the worker serves `/metrics` on `WORKER_HEALTH_PORT` (default 3002). Keep that port private and scrape it from inside the host's network. Send `x-health-token` only if you want per-portal series, and keep that token secret.

### Alert rules (PromQL)

| # | Alert | Rule | For | Severity |
|---|---|---|---|---|
| 1 | **No successful read for 1 h** | `changecatch_journal_read_age_seconds > 3600` (also: `/health` → 503, and Healthchecks `/fail`) | 0 | **page** |
| 1b | Early warning: no read for 10 min | `changecatch_journal_read_age_seconds > 600` (the Healthchecks grace does the same off-host) | 0 | **page** |
| 2 | Journal lag > 5 min | `changecatch_journal_lag_seconds > 300` | 5m | warn; page if > 30 min |
| 3 | Offset age while behind | `changecatch_journal_offset_age_seconds > 900 and changecatch_journal_caught_up == 0` | 10m | **page** (backlog is not draining). Don't alert on offset age alone: with no association changes for hours it grows while all is fine. |
| 4 | Offset close to journal expiry | `changecatch_journal_offset_age_seconds > 172800` (2 days of the ~3-day retention) | 0 | **page**: data loss in under 1 day |
| 5 | Queue depth growing for 10 min | `sum(changecatch_stamp_queue_depth) > 100 and deriv(sum(changecatch_stamp_queue_depth)[10m:1m]) > 0` | 10m | warn |
| 5b | One portal's queue stuck | `max by (portal) (changecatch_stamp_queue_depth) > 1000 and delta(changecatch_stamp_queue_depth[10m]) >= 0` | 10m | warn |
| 6 | **Any data loss** | `increase(changecatch_data_loss_total[15m]) > 0` | 0 | **page** (label `reason` says which path). |
| 6b | Portal paused | `changecatch_portals_paused > 0` | 1h | warn (an admin must reinstall; see runbook B5) |
| 6c | Lifecycle retries stuck | `changecatch_lifecycle_retries_pending > 0` | 1h | warn |
| 7 | HTTP error rate | `sum(rate(changecatch_http_errors_total{status!~"429\|404"}[10m])) / sum(rate(changecatch_http_requests_total[10m])) > 0.2` | 10m | warn |
| 8 | Auth errors | `increase(changecatch_http_errors_total{status=~"401\|403"}[15m]) > 5` | 0 | warn (a portal needs re-auth, or our client secret changed) |
| 9 | Rate limiting | `sum by (portal) (rate(changecatch_rate_limited_total[10m])) * 600 > 50` | 10m | warn |
| 10 | Latency SLO | `changecatch_e2e_latency_ms{quantile="0.95"} > 60000` | 15m | warn |
| 11 | Journal run errors | `increase(changecatch_journal_reads_total{result="error"}[15m]) > 10` | 0 | warn |
| 12 | Cardinality cap hit | `increase(changecatch_metrics_series_overflow_total[1h]) > 0` | 0 | info: raise `maxSeriesPerMetric` |

Delivery: email + phone push (Healthchecks and Grafana both do this). One on-call person is fine for v1. Put a link to [runbook.md](runbook.md) in each alert's description.

---

## 6. Where it is wired

| Signal | Where |
|---|---|
| `startProcess(config, { log, metrics? })` (logging, crash reporting, rate limiter, HTTP metrics) | `service/src/worker/main.ts` `main()` (with metrics), `service/src/api/main.ts` `start()`, the tools (`startTool`, at `TOOL_RATE_PER_10S`) |
| Root logger, a child per component | `worker/main.ts` (`rootLogger`, `logFor(component)` in `createWorker()`), `api/main.ts` (`log`) |
| `heartbeat.ok()` / `heartbeat.fail()` | `Worker.readOnce()` after a successful run / `Worker.loopBody()` when `StaleAlerter.check()` is true |
| `metrics.restore({ lastSuccessfulReadAt, offset })` | worker `main()` |
| `data_loss{dead_letter,stamp_dropped}` | `service/src/worker/stamp-queue.ts` `applyResults()` |
| `data_loss{offset_expired,skipped_entries}` | `service/src/worker/journal-reader.ts` |
| `http_requests`, `http_errors`, `rate_limited` (HubSpot 429s and local limiter refusals) | `service/src/lib/http.ts` |

Tests: `service/src/worker/observability.test.ts` (log shape and redaction through the worker, heartbeat timing with a fake clock, one line per failure and alert, data loss), `service/src/install/security.test.ts` (no code/token/state in a log line from the OAuth routes; route failures reported), `service/src/lib/http.test.ts` (HTTP metrics) and `service/src/obs/obs.test.ts` (redaction, no newlines/secrets in any log line, alerts, throttle, public metrics view, the metrics tables above match `M`, the alert tables here and in the runbook match `ALERTS`).

Still open: optional app server counters (`installs`, `settings_saves`).
