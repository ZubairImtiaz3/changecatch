# Observability: logs, metrics, errors, heartbeat, alerts

The building blocks live in `service/src/obs/`, with tests in `service/src/obs/obs.test.ts`. None of them adds a required package. Sentry is optional (section 4).

| File | What it gives you |
|---|---|
| `service/src/obs/log.ts` | JSON logger + `redact()` / `redactString()` |
| `service/src/obs/metrics.ts` | Metrics registry, the standard ChangeCatch metrics, Prometheus + JSON output |
| `service/src/obs/errors.ts` | Error reporting with a pluggable backend (log by default, Sentry via one env var) |
| `service/src/obs/heartbeat.ts` | Dead-man's-switch ping to Healthchecks.io (or any URL that takes `/fail`) |
| `service/src/obs/wiring.ts` | Glue: `legacyLog()` / `classifiedLog()` (old `(level, msg)` callbacks -> JSON logs, `[ALERT]` -> error reporter) and `instrumentFetch()` (HTTP metrics) |
| `service/src/worker/health.ts` | Worker `/health` (JSON) and `/metrics` (Prometheus), extra worker gauges, and the stale alert |

Env vars for all of this are in [configuration.md](configuration.md) section 10. The incident playbooks that use these signals are in [runbook.md](runbook.md).

## Wiring status

| Piece | Status |
|---|---|
| Metrics registry in the worker, `/metrics` and `/health` | Wired. |
| Journal metrics (`journal_*`, `files_read`, `events_read`, `changes_processed`) | Wired. `journal_offset_age_seconds` uses the saved offset and survives restarts. |
| Stamp metrics (`stamps_sent`, `stamps_failed`, `stamp_queue_depth`, `e2e_latency_ms`) | Wired. |
| `http_requests`, `http_errors`, `rate_limited` | Wired in the **worker** (`instrumentFetch` wraps `fetch`, so every HubSpot response is counted once). The app server is not instrumented: it has no metrics endpoint. |
| `data_loss` | Wired: `dead_letter`, `stamp_dropped` (stamp queue), `skipped_entries`, `journal_gap` (journal reader). |
| Worker gauges (`dead_letters`, `portals_paused`, `lifecycle_retries_pending`, `parked_entries`, `stamp_queue_size`, `stamps_coalesced`) | Wired. |
| `forgetPortal` on uninstall | Wired. |
| Stale alert (`[ALERT]` log line, `/health` → 503, heartbeat `/fail`, error reporter) | Wired. |
| JSON logger | Wired in the worker and the app server. `LOG_LEVEL` / `LOG_FORMAT` work. `pnpm dev` defaults to `LOG_FORMAT=pretty`. |
| Error reporting (log backend, optional Sentry) | Wired in both processes: crashes, unexpected worker failures, dead letters, every `[ALERT]` line, and error-level app server lines. Flushed on shutdown. |
| Heartbeat | Wired in the worker. `HEARTBEAT_URL` works. |

Known gaps (in shared modules, not the process entry points): the HTTP helper's retry notices (`[http] ... retry in`) and the store's maintenance errors are still plain `console` lines; the poller's "parked entries DROPPED" line is a plain `[ALERT]` on stderr and is not counted in `data_loss`.

Section 6 lists where each call is made.

---

## 1. Logs (`service/src/obs/log.ts`)

One JSON object per line. `info`/`debug` go to stdout, `warn`/`error` to stderr.

```json
{"level":"info","ts":"2026-10-30T09:12:01.123Z","component":"worker","portalId":12345678,"event":"stamp_sent","msg":"stamped 12 records","n":12}
```

```ts
import { createLogger } from '../obs/log.js';
const log = createLogger('worker');
log.info('journal_read', 'read 3 files', { files: 3, events: 41 });
log.child({ portalId }).warn('stamp_retry', 'retry in 30s', { attempts: 2 });
// Fits the existing callbacks unchanged (what the processes use; obs/wiring.ts):
const l = legacyLog(log);               // (level, msg, event?, fields?) => void; [ALERT] -> error + reporter
const app = classifiedLog(log);         // (msg) => void; level + event read from "route[ref]: ..." text
```

- `event` is a short snake_case name. Search logs by it (`event=stamp_sent`), not by message text.
- Env: `LOG_LEVEL` = `debug|info|warn|error` (default `info`). `LOG_FORMAT=pretty` for local reading.
- **Redaction runs on every message and every field**, so a token can't leak even by accident:
  - Keys: anything named like `token`, `accessToken`, `refresh_token`, `*_secret`, `password`, `authorization`, `cookie`, `apiKey`, `signature`, `dsn`, and `code` (OAuth code; error codes like `ECONNRESET` or `429` are kept).
  - Values: `Bearer …`, `pat-na1-…` keys, HubSpot refresh tokens (`na1-xxxx-…`), JWTs, `access_token=` / `client_secret=` / `code=` / S3 `X-Amz-Signature=` in URLs, `user:pass@` in URLs (Sentry DSN), hex runs of 32+ chars, base64 runs of 40+ chars with letters and digits (HubSpot access tokens).
  - Kept on purpose: journal offsets (UUIDs), portal IDs, object type IDs, API paths.
- **Alerts:** a message that starts with `[ALERT]` is written as `level=error`, `event=alert` (prefix removed) and is also sent to the error reporter. `[ALERT-CLEARED]` becomes `level=info`, `event=alert_cleared`. "portal 123" in a message fills `portalId`.
- Worker events you can search on: `worker_started`, `worker_stopped`, `journal_read`, `journal_run_failed`, `batch_held`, `batch_unfinished`, `entries_parked`, `queue_drain`, `queue_drain_failed`, `dead_letter`, `alert`, `alert_cleared`, `fatal`. Components: `worker`, `journal`, `stamp`, `labels`, `lifecycle`, `install`, `tokens`, `heartbeat`, `errors`. App server: component `app` (events `oauth`, `settings`, `install`, `unhandled`, `app_started`, `shutdown`, `fatal`).
- **Volume rule:** log one `info` summary per drain, not one line per stamp. At 500k changes/day, one line per stamp is too much.

---

## 2. Metrics (`service/src/obs/metrics.ts`)

One `ChangeCatchMetrics` per process, passed down as a dependency. It wraps a `MetricsRegistry`.

- Counters, gauges, histograms. Histograms keep the last 2,048 samples per series for p50/p95/p99, plus lifetime count and sum.
- **Bounded cardinality:** at most 250 label sets per metric. Past that, new label sets are folded into `portal="_other"`, and `changecatch_metrics_series_overflow_total{metric}` goes up. On uninstall the worker calls `forgetPortal(id)`.
- Output: `toPrometheus()` (text format 0.0.4, prefix `changecatch_`, counters get `_total`, histograms are exported as `summary`) and `toJSON()` (compact, top 20 series per metric, for `/health`).
- **Privacy:** `/health` and `/metrics` show aggregate numbers only. Per-portal labels and detail appear only when the request has the header `x-health-token` equal to `HEALTH_TOKEN`. With `HEALTH_TOKEN` unset, they never appear.

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
| `changecatch_stamp_queue_depth` | gauge | `portal` | Stamps waiting |
| `changecatch_e2e_latency_ms` | summary | | `occurredAt` → stamp accepted |
| `changecatch_http_requests_total` | counter | `api=journal\|crm\|oauth\|subscriptions\|other` | Worker requests to HubSpot, incl. journal file downloads (denominator for the error rate). Retries count as requests. |
| `changecatch_http_errors_total` | counter | `status` (400, 401, 403, 404, 409, 423, 429, 500, 502, 503, 504, `4xx`, `5xx`, `timeout`, `network`) | Errors |
| `changecatch_rate_limited_total` | counter | `portal` (`app` = app-level limit) | HubSpot 429 responses, plus stamps deferred because our own limiter was full for longer than `HS_PORTAL_MAX_WAIT_MS`. Short inline limiter waits are not counted. |
| `changecatch_data_loss_total` | counter | `reason, portal` | **A change that will never be stamped.** Reasons: `dead_letter` (gave up after retries), `skipped_entries` (journal file skipped after a lasting HTTP 207), `stamp_dropped` (CRM rejected the record for good), `journal_gap` (offset expired, restart from earliest) |

### Worker gauges (`service/src/worker/health.ts`)

Computed from the database at scrape time.

| Name (Prometheus) | Type | Meaning |
|---|---|---|
| `changecatch_dead_letters` | gauge | Stamps in `stamp_dead_letter`, per portal |
| `changecatch_portals_paused` | gauge | Portals paused because their token is revoked or invalid |
| `changecatch_lifecycle_retries_pending` | gauge | Install/uninstall handling waiting for a retry |
| `changecatch_parked_entries` | gauge | Association entries parked (label lookup held), all portals |
| `changecatch_stamp_queue_size` | gauge | Stamps waiting, all portals |
| `changecatch_stamps_coalesced_total` | counter | Stamps folded into a later stamp on the same record (`COALESCE_MODE=latest`) |

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
import { errors, initErrorReporting, installProcessHandlers } from '../obs/errors.js';
await initErrorReporting();   // once at start; reads SENTRY_DSN
installProcessHandlers();     // unhandledRejection + uncaughtException
errors.capture(err, { component: 'worker', op: 'stamp_drain', portalId, extra: { attempts } });
errors.message('no successful journal read for 1 h', { op: 'stale', level: 'fatal' });
await errors.flush();         // in the SIGTERM handler, before exit
```

- Wired in `worker/main.ts` and `api/main.ts` exactly like the snippet above. What is reported: uncaught exceptions (then exit) and unhandled rejections; unexpected worker failures (`op` = `journal_run`, `stamp_drain`, `lifecycle_retry`); dead letters (`op: stamp_dead_letter`); every `[ALERT]` line (`op: alert`); app server error-level lines (`op` = the route: `oauth`, `install`, `settings`, `unhandled`); start-up failures (`op: startup` / `fatal`). Held labels and unfinished stamp batches are expected states and are only logged.
- Default backend: the JSON logger (`event: "exception"`).
- **Turn on Sentry (free Developer tier, 5k errors/month):**
  1. `pnpm --filter @changecatch/service add @sentry/node`
  2. Set the secret `SENTRY_DSN=https://<key>@o<org>.ingest.sentry.io/<project>` in the host's secret store.
  3. Optional: `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` (git SHA), `SENTRY_TRACES_SAMPLE_RATE` (default 0).
  - If the DSN is set but the package is missing, it logs one warning and stays on the log backend.
- Safety: `sendDefaultPii: false`; `beforeSend`/`beforeBreadcrumb` run `redact()` on the whole event; messages, stacks and extras are redacted before they leave. `portalId`, `component` and `op` are tags.
- **Throttling:** the same error shape (numbers and UUIDs stripped) is reported at most once per 5 min; the skipped count rides along as `suppressedSinceLast`. A stuck loop can't burn the monthly quota.
- Sentry is a **subprocessor**: add it to the privacy policy's subprocessor list before turning it on in production.

---

## 5. Alerts and a low-cost stack

Hosting is not chosen yet. This stack works with any host that can run the two processes.

| Layer | Tool | Cost | What it catches |
|---|---|---|---|
| Dead-man's switch | Healthchecks.io (`HEARTBEAT_URL`) | free | Worker down, host down, journal stuck > ~11 min, stale |
| Metrics + dashboards | Any Prometheus-compatible scraper + Grafana (for example the host's managed metrics, or Grafana Cloud free) | free tier | Everything in section 2 |
| Metric alerts | Grafana alert rules on that data source | free tier | Rules below |
| Uptime of the install path | UptimeRobot or Better Stack free, `GET https://<public url>/health` every 1–5 min | free | API server down, TLS, DNS |
| Exceptions | Sentry free Developer tier | free | Crashes, unexpected errors |
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
| `initErrorReporting()`, `installProcessHandlers()`, `errors.flush()` on SIGINT/SIGTERM | `service/src/worker/main.ts` `main()`, `service/src/api/main.ts` `start()` |
| JSON logger per component | `createWorkerFromEnv()` (`logFor(component)`), `api/main.ts` (`classifiedLog`) |
| `heartbeat.ok()` / `heartbeat.fail()` | `Worker.readOnce()` after a successful run / `Worker.loopBody()` when `StaleAlerter.check()` is true |
| `instrumentFetch(metrics)` | worker `main()`; removed again on shutdown |
| `metrics.restore({ lastSuccessfulReadAt, offset })` | worker `main()` |
| `data_loss{dead_letter,stamp_dropped}` | `service/src/worker/stamp-queue.ts` `applyResults()` |
| `data_loss{journal_gap,skipped_entries}` | `service/src/worker/journal-reader.ts` |
| `rate_limited` for local limiter deferrals | `stamp-queue.ts` (HTTP 429s are counted by `instrumentFetch`, so they are not counted twice) |

Tests: `service/src/worker/observability.test.ts` (log shape and redaction through the worker, heartbeat timing with a fake clock, reporter on alerts, HTTP metrics, data loss) and `service/src/obs/obs.test.ts`.

Still open (other modules): the app server's route `catch` blocks in `install/server.ts` only log a line (reported through `classifiedLog`, not as an exception with a stack); optional app server counters (`installs`, `settings_saves`).
