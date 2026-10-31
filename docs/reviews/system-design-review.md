# System design review

> Review as of 2026-10-30. Status of each finding reflects the code at that date.

- **Scope:** the whole system: topology, delivery guarantees, failure handling, operations, security and how it will evolve.
- **Companion doc:** `scale-review.md` (same folder) is the code-level audit. Its findings are cited here by ID (C1–C3, H1–H5, M1–M7, S1–S7) and not repeated.
- The review was written against the code before the scale and hardening work, which landed the same day. Recommendations that are now in the code are marked **Done**; the rest are marked **Open** or **Deferred**.

**One-line verdict:** the shape is right for v1, and it does not need a broker. The journal works as a durable, replayable inbox, which makes most failures recoverable for free. Two gaps blocked launch:
1. **Isolation.** Shared work ran inline on the single loop, so one portal or one slow call could stall every portal (C1–C3, H1–H3). **Now fixed.**
2. **Operations.** Alerts were only log lines and nobody was paged. **The code side is now done** (metrics, heartbeat, error reporting). Wiring the alerts to a person, and backups with a restore drill, depend on hosting, which is out of scope for now.

With those, the design is sound for hundreds of portals.

---

## 0. The system

```
                         HubSpot (app-level)                                      HubSpot (per portal, OAuth)
 ┌──────────────────────────────────────────────┐                     ┌──────────────────────────────────────────┐
 │ Webhooks Journal: one ordered log, ~3 days    │                     │ CRM batch update (110 req / 10 s / portal)│
 │ batch/next (≤100 files) → presigned S3 URLs   │                     │ Labels API, Properties API, Schemas API  │
 └───────────────┬──────────────────────────────┘                     └───────────────▲──────────────────────────┘
                 │ client-credentials token                                           │ per-portal access token
 ┌───────────────┼──────────────────────────── one host, one volume ───────────────────┼─────────────────────────┐
 │  worker (singleton loop, every 3 s)                                                  │                         │
 │   read → download files → lifecycle hook → dedupe → watched filter → park check     │                         │
 │   → pairing → label resolve (+option sync) → change_log ─┐                           │                         │
 │                                                          ▼                           │                         │
 │                                   stamp_queue (SQLite outbox) ── drain ──────────────┘                         │
 │   one txn: offset + seen + pending + parked + label state + metrics                                           │
 │                                                                                                               │
 │  API server: /install, /oauth/callback, /api/settings (v3 signature)  ──► portals, portal_settings            │
 │                                                                                                               │
 │  SQLite WAL  data/changecatch.db                                                                              │
 └───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                                          customer workflow: "Property value changed:
                                                                          changecatch_last_change_id" (re-enroll ON)
```

---

## 1. Queue topology

### Verdict: sound. Keep "journal as inbox + SQLite outbox". No broker for v1.

**Why it works**
- **The journal is already a durable, ordered, replayable inbox,** kept for about 3 days. Our copy of the inbox is just one offset string. A broker in front of it would be a second copy of a log we can already re-read.
- **The outbox is in the same SQLite file as the rest of our state.** Enqueue is idempotent: `INSERT OR IGNORE` on a deterministic change ID (`changeIdFor` = hash of portal + source event keys + target record). So a crash anywhere between "enqueue" and "offset commit" just re-derives the same IDs. Nothing needs a two-phase commit.
- **The load is tiny for a queue.** 500 portals × 1k changes/day is about 6/s on average, with bursts of about 14/s from one importing portal. With S1/S2 applied, SQLite in WAL mode handles hundreds to thousands of small writes per second on one volume.
- **A broker would cost more than it buys.** Redis, BullMQ or SQS adds a second stateful service, a second backup story and a second failure domain. It also breaks the "offset + queue in one place" property: the enqueue and the offset commit could no longer share a transaction or an idempotent key space.

**When a queue service is actually needed**

| Trigger | What to do |
|---|---|
| More than one machine must drain stamps (active-active, or a standby that takes over by itself) | Move the store to **Postgres** and use it as the queue: `SELECT … FOR UPDATE SKIP LOCKED`, or pg-boss / graphile-worker. Still no Redis. |
| More than about 200 changes/s sustained, or more than about 5k portals | Same as above, plus split the drain into N workers sharded by `portal_id`. Ingest stays a singleton (the offset is one value). |
| Many independent sinks with their own scaling (app events, webhooks out, Slack...) | Still Postgres. Consider a real broker only if fan-out to external consumers becomes a product. |

SQS or BullMQ is never the first step. The first step is always "SQLite → Postgres, keep the outbox pattern".

### Outbox design: what to add

The `stamp_queue` had per-record ordering, spacing, backoff retry and a drop after 12 attempts. Recommended structure:

1. **Per-portal fair queues.** **Done.**
   - Drain round-robin across portals, with at most one batch in flight per portal and N portals in parallel. This is H3.
   - Decouple the drain from `runOnce`, so ingest never waits on CRM writes.
2. **Two priority lanes per portal.** **Open.**
   - `live`: changes read while caught up.
   - `bulk`: changes read while catching up a full batch, or from a portal over its burst threshold.
   - Drain `live` first. A customer's single UI edit should never queue behind their own 50k import.
   - The lane is just a column plus an index. No new infrastructure.
3. **Coalescing.** Burst-merge per record, as in H4. Every change stays in `change_log`, so coalescing loses no audit data. It only reduces enrollments. **Done** (worker-wide `COALESCE_MODE`).
4. **Dead-letter instead of drop.** **Done, except the replay tool.**
   - A stamp that hit `maxAttempts`, or a permanent 4xx, used to be deleted and marked seen. That is **silent data loss**.
   - Move it to a dead-letter table instead: portal, change ID, update JSON, last error, attempts, time. (Now `stamp_dead_letter`, with a `dead_letters` gauge in metrics.)
   - Add a replay tool (`replay-dead --portal X`). **Open.**
   - Keep 7 days, then purge, in line with privacy retention.
5. **Per-portal circuit breaker.** **Partly done.**
   - After K consecutive failures for a portal (401, 403 on scope, 5xx storm), pause that portal's lane for an increasing time. Don't keep hammering it.
   - Its rows stay queued, other portals are unaffected, and the breaker state shows in `/health`.
   - Today a revoked token or 401 pauses the portal and probes it every hour; the state shows as `portals_paused`. A breaker for 5xx storms is not built; those use per-record backoff.
6. **Per-portal queue cap** (see §5). **Open.**

---

## 2. Delivery semantics

### Verdict: at-least-once delivery, which gives effectively-once enrollments in practice. The only true loss paths are the explicit "give up" and "skip" branches, and the 3-day horizon.

**Walk through the crash points**

| Crash between… | What happens on restart | Duplicate enrollment? |
|---|---|---|
| Read and `saveChanges` | Same files re-read (offset not moved) | No |
| `saveChanges`/`enqueue` and the offset transaction | Re-read gives the same change IDs. `INSERT OR IGNORE` and `isQueued` mean nothing new is queued. Pending pairs are rebuilt from the last committed state. | No |
| HubSpot accepts a stamp batch, then the crash comes before the `deleteQueued` transaction | The row is still queued with the same change ID and the same property values, so it is re-sent | **Probably no**: the PATCH writes the identical `changecatch_last_change_id`. See the caveat below. |
| Offset committed, stamp still queued | The queue is persisted, so the drain continues | No |
| Restore from a continuous backup loses the last ~1 s of WAL | The offset rolls back about 1 s. Re-read gives the same IDs. `stamp_last` may be slightly old, so the same values may be re-sent. | Same as row 3 |

**Caveat to verify before launch:** **Open.**
- Effectively-once depends on HubSpot **not** enrolling again when a property is PATCHed to the **same** value. HubSpot normally records no property change when the value is the same, and "Property value changed" keys off a change. But we haven't tested it.
- **Test:** PATCH the same `changecatch_last_change_id` twice, 10 s apart, on a record in a re-enrolling workflow. Expect 1 enrollment.
- If HubSpot does re-enroll, the cheap fix is to read the record's current `changecatch_last_change_id` before re-sending a row with `attempts > 0` or one that was in flight at startup. This is rare, so it costs almost nothing.

**Where data can be lost (make each one a counted, alerted metric)**

The `changecatch_data_loss_total` counter now exists (**Done**). The loss paths:
1. A stamp dropped after `maxAttempts` or on a permanent error. **Fixed:** these now go to the dead-letter table, and the retry window is 24 h.
2. A journal file skipped after a 207 error that lasts more than 30 min (`JOURNAL_SKIP_FAILED_AFTER_MS`). Counted as data loss.
3. The offset expired (404), so the worker restarts from earliest. Everything older than about 3 days is gone. Logged as an alert and recorded in `worker_state`.
4. A portal parked for more than 30 min. The change is stamped as `(unknown)`, so it's degraded but not lost (M7, open).
5. A lifecycle failure that blocks the offset for everyone until it expires (C2). **Fixed:** lifecycle failures are retried from their own table.

**Ordering**
- **Per record:** guaranteed in the outbox by `occurred_at_ms` order (`firstQueuedFor`) plus the spacing rule.
- **Across journal files:** a change for record R that HubSpot publishes **late**, in a later file than a newer change for R, is stamped *after* the newer one. The record then shows the older change as "last".
  - Under load, the two halves of one label edit were seen in different files (up to about 30 s apart). The split-file pairing and late-half absorption fixes handle that case: a late half amends the change it belongs to instead of becoming a new one.
  - **Recommendation (open):** for genuinely separate changes, keep `stamp_last.occurred_at_ms`. When an incoming change for R is older than the last stamped one, still stamp it (it's a real change and should enroll). But compute `changecatch_labels_current` from the newest known state, not from the old change.
  - Count these "out-of-order" events as a metric. If the count stays 0 in production, do nothing more. **Open.**
- **Across records:** no ordering promise. None is needed; workflows are per record.

**Idempotency keys (current, and fine)**
- Ingest: the journal event key (M2 suggests a cheaper per-file offset key).
- Change: the deterministic `changeId`. It is the key for `change_log`, `stamp_queue` and `stamp:` seen keys, and it is also the value customers trigger on.
- App events (v1.1): use the same `changeId` as the occurrence ID.

---

## 3. Failure modes and backpressure

| Failure | Before the fixes | Recommendation | Status |
|---|---|---|---|
| **HubSpot CRM outage / 5xx storm** | Inline retry in `hsRequest` blocked the whole loop (H1). Then the queue deferred with backoff, up to about 1 h, then dropped. | No inline sleeps for customer calls (H1). Per-portal circuit breaker. Raise the give-up horizon to **24 h** (the queue is persisted, so waiting is cheap), then dead-letter. | Done, except the 5xx breaker |
| **Journal API outage** | Error backoff up to 2 min. Stale alert after 1 h, as a log line only. | Fine, since the journal itself buffers. Page at 15 min of no reads (§6). Do nothing clever. | Heartbeat done; paging depends on hosting |
| **Journal file download failure** (S3 presigned URL) | Threw, so the whole batch was retried. No timeout (H2). Serial downloads (C3). | Timeout plus parallel pool (C3/H2). Re-fetch the batch (fresh URLs) on 403 "expired signature": presigned URLs expire, so after a long error backoff a cached URL is useless. | Done. An expired URL is refused before download and the batch is read again. |
| **207 partial batch** | Barrier logic, then skip after 30 min | Keep, but count skips as **data loss** and page on them. Consider 2 h before skipping; the journal holds 3 days. | Counted as data loss; still 30 min by default |
| **Token revoked / app uninstalled without our seeing the event** | `BAD_REFRESH_TOKEN` gave `NoPortalTokenError`, and stamps were dropped at once | Mark the portal as needing re-auth, pause its lane, and keep its rows for 7 days (a reinstall replays them). After 7 days, run the full uninstall purge. This also covers a missed uninstall journal event. | Done |
| **429 storm** | Inline sleep for everyone (H1) | Per-portal token bucket (H1). On 429, defer with `Retry-After`. Lower that portal's rate for 60 s (cut the rate fast, raise it slowly). | Bucket and defer done; adaptive rate open |
| **Lifecycle (install/uninstall) failure** | Blocked the shared offset (C2) | `lifecycle_retry` table (C2). The offset always moves on. | Done |
| **Worker down < 3 days** | Resumes from the offset. Nothing lost. Backlog drains. | Make sure catch-up is fast (C3) and that backlog lands in a `bulk` lane, so new live changes interleave. | Fast catch-up done; lanes open |
| **Worker down > 3 days** | 404 → restart from earliest. The gap is lost, with one log line. | See the recovery plan below. | Partly done (alert + data-loss counter) |
| **Disk full** | SQLite returns `SQLITE_FULL`. Every transaction fails, the offset doesn't move, and a stale alert follows. | Alert at 70% and 85% of the volume. Size the volume per S5. Prune on a timer (H5/S5). Keep a small "ballast" file to delete in an emergency. | Timer pruning done; disk alerts depend on hosting |
| **Clock skew** | Pairing release uses `now ≥ occurredAt + window + slack` when caught up. The settings signature allows 5 min. | Hosts run NTP, so the risk is low. Add a metric: `min(read time − occurredAt)`. If it's negative, our clock is behind. Alert if it goes below −2 s, because a fast clock can split a label edit into REMOVED + ADDED. | Open |
| **SQLite corruption / volume loss** | Host snapshots only | Continuous WAL backup, RPO about 1 s. Restore runbook (§4). | Deferred with hosting |
| **Bad deploy (crash loop)** | The process restarts in a loop | Keep the previous build. Roll back to it. The journal buffers while you do it. | Deferred with hosting |

### Recovery plan for more than 3 days down (retention loss)

**What we know**
- The offset is gone and the changes in the gap are gone. **The Snapshots API won't give them back:**
  - It produces a *current-state* snapshot of CRM objects into the journal, not association history.
  - Whether it even covers associations is unverified.
  - At best it lets us rebuild *current* label state, not the events that happened.

**Plan, in order of value**
1. **Prevent it.**
   - Page at 15 min with no reads. Use an external heartbeat (§6).
   - Have a written runbook that gets a worker back in under 1 h, and the RPO question goes away.
   - Three days is a long time; this should never happen with paging.
2. **Detect and record the gap.** On a 404, record `gap = (last offset time, earliest available time)` per portal in a `journal_gaps` table, and page. **Partly done:** the reset is logged as an alert, stored in `worker_state`, and counted in `changecatch_data_loss_total`. The per-portal gap table is open.
3. **Tell affected customers.** **Open.**
   - Show a banner on the settings page: "Changes between X and Y were not tracked."
   - Do **not** stamp synthetic changes by default. Late, fake "ADDED" stamps would trigger customer workflows days later, maybe sending emails.
4. **Optional resync (v1.1, opt-in per portal).** **Open.**
   - For the watched pairs, re-read current associations of the records in `association_labels` (90-day state). Diff against our stored state and refresh `association_labels`, so that future `label_before` values are correct.
   - Write `changecatch_*` stamps only if the admin clicks "Replay the gap as changes".
   - Records we never saw can't be diffed without a full scan. That's acceptable and should be documented.

---

## 4. Single points of failure

| SPOF | Effect | Acceptable for v1? |
|---|---|---|
| One host | Worker and API server down. **No data loss** for up to 3 days (the journal buffers). Installs and settings fail meanwhile. | **Yes.** The journal turns a host outage into latency, not loss. |
| One volume | Losing it loses tokens (every portal must reinstall) and the offset (a gap). | **Only with continuous off-host backups.** Without them, no. |
| Singleton worker | Same as the host | Yes. It's the right design (one offset). |
| Token encryption keys (`TOKEN_ENC_KEYS`) | Losing them = every portal reinstalls, and backups are useless | Yes, if they're in a password manager **and** a second sealed place (owner + one trusted colleague). |
| HubSpot app client secret | Rotation needs a redeploy | Yes. Write a rotation runbook. |

### Cheapest upgrades, in order

1. **Continuous WAL backup to object storage, plus a restore runbook and a restore drill.** This is the must-have. **Deferred with hosting.** Runbook outline:
   1. Create a fresh volume (same region, or another region if the region is down).
   2. Restore the latest backup onto it (point-in-time if needed) as `data/changecatch.db`.
   3. Check `PRAGMA integrity_check` and the stored journal offset.
   4. Detach or destroy the old volume, so only one copy of the database is live.
   5. Watch `/health`: the offset advances and the backlog drains.
2. **Startup guard (M5).** **Done for one database file.**
   - The worker takes a lock row with a heartbeat and refuses to start while another worker's heartbeat is fresh.
   - Still open: a guard across **different** database files (for example a restored copy plus the old one, or a local run), via a heartbeat stored outside the database and keyed by `HUBSPOT_CLIENT_ID`. This is the real danger during recovery.
3. **Cold standby, not hot.** **Deferred with hosting.**
   - A second deployment in another region, stopped, with the same build and secrets. Recovery = run the runbook against it.
   - A hot standby with automatic failover needs a shared lease and a shared store, which means Postgres (`pg_try_advisory_lock`). That's the trigger for the Postgres move, not a v1 item.

### RTO / RPO targets (v1)

| Scenario | RTO (time to restore) | RPO (data loss) |
|---|---|---|
| Process crash | < 1 min (automatic restart) | 0 |
| Host failure | ≤ 30 min (restart, or the runbook) | 0 for changes (journal), ~1 s for local state (continuous backup) |
| Volume lost / corrupted | ≤ 1 h (restore) | 0 for changes; ≤ 1 s local state |
| Region outage | ≤ 4 h (restore into another region) | 0 for changes, as long as total downtime < 3 days |
| Volume **and** backup lost | Every portal reinstalls | The gap since the outage, plus all tokens |
| **Hard limit** | Any outage longer than about 72 h | Every change older than the journal's retention |

Latency SLO, separate from RTO: p95 occurredAt → stamped under 30 s when healthy, and catch-up after an outage at ≥ 50 files/s (C3).

---

## 5. Multi-tenancy isolation and noisy neighbours

### Verdict: isolation was the weakest part. The rule should be: the only shared, serial thing is reading the journal. Everything per portal must be asynchronous, parkable and rate-limited.

**Where one tenant could hurt others** (with refs and status):
- Ingest: serial downloads (C3, fixed), lifecycle throw (C2, fixed), inline 429 sleep (H1, fixed), no timeouts (H2, fixed), label-guard writes per change (M1, mostly fixed).
- Outbox: global `ORDER BY not_before` (H3, fixed), wave barrier (C1, fixed), hot record (H4, fixed).
- DB: parked rows rewritten every run (M3, open), and a prune that holds the write lock (H5, mostly fixed).

**Per-portal quotas**

| Quota | Default | Effect when hit | Status |
|---|---|---|---|
| CRM request budget | 100 req / 10 s token bucket (H1) | Lane slows down. Never sleeps the loop. | Done |
| In-flight batches | 1 per portal | Ordering, and one portal can't use all parallel slots | Done |
| Drain share | ≤ 100 records per portal per drain cycle | Fairness | Done |
| Queued stamps | 100k per portal | Above the cap, coalesce aggressively (one stamp per record per window) and alert | Open |
| Parked entries | 10k per portal (M3) | Keep only file offsets and re-read later | Open |
| Label option sync | ≤ 1 per (portal, pair) per minute | Already roughly there | Done |
| Workflow volume (customer-side) | Coalescing, default ON for bursts (H4) | Protects the customer's own workflow limits | Done (worker-wide) |

**Data isolation:** every table row is keyed by `portal_id`, and tokens are AES-GCM with portal ID as AAD (good). Purges of string-keyed tables now use exact primary-key ranges (H5).

**Free tier (later):** the same quota table becomes the plan limits. Build it as config per portal (for example `portals.limits_json`), not constants.

---

## 6. Observability

### Verdict: there was a good `/health` JSON and an in-memory latency tracker, but **nothing paged anyone**. The code side of this is now done; the alert wiring depends on hosting.

### Metrics

The worker exposes `/metrics` in Prometheus format. Every name gets the `changecatch_` prefix (and `_total` on counters). Per-portal detail is shown only with the `x-health-token` header.

| Metric | Meaning | Alert | Status |
|---|---|---|---|
| `journal_read_age_seconds` | now − last successful read | > 600 s → **page** | Done (read age / stale alert) |
| `journal_offset_age_seconds` | now − time of the stored offset (decoded from the UUIDv7 offset) | > 900 s for 10 min → **page** (we're behind) | Done |
| `journal_lag_seconds` | now − `occurredAt` of the newest processed event | p95 > 120 s for 15 min → warn | Done |
| End-to-end latency histogram | occurredAt → stamp accepted | p95 > 60 s for 15 min → warn | Done |
| Stamp queue depth (per portal) | Backlog per tenant | Oldest due > 10 min → warn | Depth done; oldest-due open |
| Stamps sent / failed, dead letters | Outcome | Any dead letter → warn; > 100/h → page | Done |
| `data_loss{reason}` | Proven loss (dead letter, skipped entries, journal gap) | **Any increase → page** | Done |
| HTTP requests, errors, rate-limited | Errors and rate pressure | 5xx rate > 20% for 10 min → warn | Done |
| `portals_paused`, parked entries, lifecycle retries pending | Tenant health | Parked > 30 min → warn | Done |
| Files and events read | Capacity (C3) | none | Done |
| `db_size_bytes`, `wal_size_bytes`, `volume_free_ratio` | Disk | Free < 30% warn, < 15% **page** | Open |
| Backup replica lag | Backup health | > 300 s → **page** | Deferred with hosting |
| `out_of_order_changes_total`, `clock_skew_min_ms` | §2, §3 | Skew < −2 s → warn | Open |
| `event_loop_lag_ms`, RSS | Process health | RSS > 80% of memory → warn | Open |

### Logs
- Structured JSON (`level`, `portal`, `changeId`, `op`, `ms`). **Done.**
- Per-stamp lines at debug level or sampled (M6). **Open:** still `info`.
- Never log tokens, presigned S3 URLs, or `Authorization` headers. A central redaction helper (`service/src/obs/log.ts`) now covers bearer tokens, refresh tokens, signed URL parameters and long secret-like strings. **Done.**
- For 7–14 days of search, ship logs to a log service. Add the vendor to the privacy subprocessor list. **Deferred with hosting.**

### Cheapest stack (about $0/month at launch)
1. **Managed metrics.** Scrape `/metrics` from the worker (port 3002) into a hosted Prometheus and Grafana. Put the dashboards and alert rules there. **Deferred with hosting.**
2. **A dead-man's-switch heartbeat** (for example Healthchecks.io). **Done in code** (`HEARTBEAT_URL`, `service/src/obs/heartbeat.ts`).
   - The worker pings it after successful journal reads, at most once a minute.
   - No ping for 10 min means email or SMS.
   - **This is the one alert that still works when the host, the region or the hosting account is down.** It's the most important item in this section.
3. **External uptime check** on `https://<app>/health` for the install and settings path. **Deferred with hosting.**
4. **Error reporting (Sentry free tier)** for exceptions in both processes, with PII off, headers scrubbed and `portalId` as a tag. It's a subprocessor, so list it. **Done in code** (`service/src/obs/errors.ts`).
5. Alert delivery: email plus a phone push. One person on call, which is the owner. That's fine for v1. Put the runbook links in the alert text.

---

## 7. Security

### Verdict: good foundations (AES-256-GCM with AAD, v3 signatures with a 5-min window, constant-time compare, secrets kept out of the code). The gaps were key rotation, a fallback that weakened signatures, a footgun flag, and privacy-text drift. Most are now fixed; see `security-review.md` for details.

| Area | Finding | Recommendation | Status |
|---|---|---|---|
| Token encryption key rotation | The `v1:` prefix existed, but there was a single key and no key ID. Rotating meant every portal reinstalls. | Use the format `k<id>:` + iv/tag/ct with a keyring `TOKEN_ENC_KEYS=id:key,...` (first = current). Decrypt with any key; re-encrypt with the current key, plus a one-off re-encrypt tool. | Done |
| Key custody | One copy in the host's secrets + the owner's password manager | Add a second sealed copy (a second person, or an offline vault). Never store the key next to the database backups. | Process item (open) |
| Signature fallback | The verifier accepted **v2** when v3 was missing. v2 has no timestamp, so a captured settings request could be replayed forever. | For `/api/settings`, require v3. | Done |
| `SETTINGS_ALLOW_UNSIGNED` | A production footgun | Refuse to start if it's set while `NODE_ENV=production` | Done (also refused with a non-localhost `PUBLIC_BASE_URL`) |
| OAuth `state` | Installs from HubSpot carry no `state`, so an unknown state was accepted | Acceptable (the code is bound to the installing portal), but log install source and portal. Rate-limit `/oauth/callback` per IP. | State is now HMAC-signed and single-use, and missing state is logged. Per-IP rate limit open. |
| Public surface | `/install`, `/oauth/callback`, `/api/settings`, `/health`. The workflow-action endpoint must **not** be deployed in v1. | Body size limit (64 KB), request timeouts, no stack traces in responses. The worker's port 3002 stays private (it contains portal IDs). | Done. The workflow action is deferred and not in this repo. |
| Secrets surface | `HUBSPOT_CLIENT_SECRET` (OAuth + signatures), `TOKEN_ENC_KEYS`, backup storage keys, error-reporting DSN, heartbeat URL | Write a rotation runbook for each. Backup credentials scoped to one bucket. | Token-key rotation done; the rest open |
| Log hygiene | "Tokens are never logged" was promised; presigned URLs were not covered | Central redaction (headers, `?X-Amz-*` query strings) | Done |
| Dependencies | Tiny dependency set | Turn on Dependabot or Renovate. Run an audit in CI. | CI exists; dependency bot open |

### Data minimisation and retention vs the privacy policy

The policy text and the code have to match before submitting.

| Data | Code | Recommendation | Status |
|---|---|---|---|
| `change_log` | 30 days; deleted **at uninstall** | Cut it to **7 days** (M6; nothing reads it in v1). | Still 30 days; the policy draft says 30 days and deletion at uninstall, so they match |
| `association_labels` (record-pair label state) | 90 days | Needed for `label_before`, so disclose "label state per linked record pair, 90 days". | Check the final policy wording; it must cover record-pair state, not only label definitions |
| `label_cache` (label definitions) | 30-day TTL (added) | Disclose. | Done in code |
| `portals` row after uninstall | Deleted 30 days after uninstall (added) | Pick a retention and delete via a timer job. | Done in code; match it in the policy |
| Backups | Not built yet | State backup retention in the policy. Purged portals stay in backups until they roll off. | Deferred with hosting |
| Logs | Per-stamp lines contain portal ID + record ID | Make per-stamp logs debug-level. State the log retention (for example 14 days). List the vendors. | Log level open |
| Error reporting | Built, off unless configured | List it when turned on. Scrub payloads. | Scrubbing done |
| Missed uninstall | Purge used to run only on the journal event | Add the revoked-token → 7-day pause → purge path (§3), so deletion happens even if the event was missed. | Done |

---

## 8. Evolution

### 8.1 App events (v1.1) as a pluggable sink

**Today:** `DELIVERY_MODE=stamp|app_events` is a process-wide switch, and the app-events path skips the outbox (it sends inline in `runOnce`). App events need HubSpot partner approval, so stamping is the only v1 sink.

**Recommended shape:**
- **One interface:** `DeliverySink { kind; spacingPolicy; maxBatch; deliver(portalId, items) → per-item result (ok | retry(after) | dead(reason)) }`.
- **Sink per portal, not per process.** Store the sinks on the portal (for example `["stamp"]`, `["stamp","app_event"]`). This allows a gradual migration: a customer turns on app events, builds new workflows, then turns stamps off.
- **Both sinks share the outbox.** Add a `sink` column to `stamp_queue` (rename it `delivery_queue`). Each sink brings its own policy:
  - Stamps need per-record spacing and coalescing.
  - App events need neither (each occurrence is its own enrollment), and batch up to 500.
- **The idempotency key stays `changeId`** for both sinks (the occurrence ID = `changeId`).
- **Event-type names and property types are locked after creation.** Freeze the type definitions in a reviewed file. Treat any change as a new type with a version suffix.
- **Don't remove stamping when app events arrive.** Stamping works without partner approval and on every tier. Keep it as the default sink.

### 8.2 Multi-region
- **Not needed for v1.** HubSpot's journal is one app-level stream. Hosting near HubSpot's `na1` region keeps latency low.
- **The EU data-residency question** will come from EU customers (HubSpot `eu1` portals). The design allows a second deployment in an EU region that reads the **same** journal with its **own** offset and handles only EU portals (a portal-region filter). Reads are cheap: 0.3% of the Journal API limit per reader.
- Do it only on real demand. It doubles operations.
- Disaster-recovery "multi-region" is just the cold standby in §4.

### 8.3 Repository layout

The production repository is a pnpm workspace:
- `service/`: the worker and the API server. Inside it, the existing boundaries stay:
  - `core`: pure pairing, resolve, stamp mapping. No I/O.
  - `hubspot`: clients.
  - `lib`: HTTP, rate limiter.
  - `obs`: logs, metrics, redaction, heartbeat, error reporting.
  - `store`: the SQLite implementation, so Postgres can drop in later.
  - `worker`, `api`, `install`.
- `tools/`: operator and test tools.
- `hubspot-app/`: the HubSpot project (settings page and app config).

Status of the items recommended for the move:
1. **Versioned schema migrations.** **Done:** a `schema_migrations` table with numbered steps, before any customer data exists.
2. **A compiled build.** Read scopes from a copied JSON. Part of hosting work.
3. **CI:** typecheck, unit tests, `hs project validate`, then a build. **CI exists;** deploy-on-tag is deferred with hosting.
4. **Store interfaces typed by use** (`OffsetStore`, `OutboxStore`, `PortalStore`), so the Postgres move later is one package. **Open.**
5. A `/metrics` endpoint and the heartbeat in the worker from day one. **Done.**
6. Decision-log entries move with the code. **Done.**

---

## 9. Target architecture

```
 HubSpot Webhooks Journal (app-level, ~3 days)                 HubSpot CRM (per portal, 110 req/10 s)
        │  batch/next ≤100 files                                         ▲
        ▼                                                                │
 ┌──────────────── one host ──────────────────────────────────────────────┼──────────────────────────┐
 │ INGEST (singleton, never blocks on a tenant)                           │                          │
 │  read ─► parallel download (pool, timeouts) ─► dedupe ─► watched ─►    │                          │
 │  pairing ─► label resolve (per-portal park) ─► change_log              │                          │
 │      │                       lifecycle ─► lifecycle_retry (async)      │                          │
 │      └─► ONE txn: enqueue(delivery_queue) + offset + pending + seen     │                          │
 │                                                                        │                          │
 │ DELIVERY (async, fair)                                                 │                          │
 │  delivery_queue[portal][lane: live|bulk][sink: stamp|app_event]        │                          │
 │   ─► coalesce (bursts) ─► per-portal token bucket + breaker ───────────┘                          │
 │   ─► retry with backoff (≤24 h) ─► dead letters (replay tool)                                      │
 │                                                                                                    │
 │ API SERVER: /install /oauth/callback /api/settings(v3 only)  ──► portals (keyring-encrypted)       │
 │ OPS: /metrics ─► Prometheus/Grafana   heartbeat ─► external monitor   errors ─► error reporting    │
 │ SQLite WAL data/changecatch.db ── continuous backup ──► object storage                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────┘
   Cold standby: second deployment (other region, stopped) + restore runbook + start-up lock guard
   Later (multi-writer / HA / >5k portals): SQLite → Postgres (outbox via SKIP LOCKED, advisory-lock leader)
```

Built today: everything in the diagram except the `live`/`bulk` lanes, the `sink` column, the replay tool, the 5xx breaker, the continuous backup and the cold standby.

---

## 10. Prioritised list

### Must before launch

| # | Item | Why | Ref | Status |
|---|---|---|---|---|
| 1 | Ingest never blocks on a tenant: lifecycle retry table, parallel downloads with timeouts, no inline 429 sleeps, a per-portal limiter | One portal or one hung call stalled everyone, and could turn into data loss after 3 days | C2, C3, H1, H2 | Done |
| 2 | Fair, decoupled outbox: per-portal round-robin, drain outside `runOnce`, no wave barrier | Imports delayed every tenant | C1, H3 | Done |
| 3 | **Real alerting:** an external heartbeat, uptime check, `/metrics` with the page-level alerts in §6, and a data-loss counter | Nobody was told when it broke | §6 | Code done; alert wiring deferred with hosting |
| 4 | **Continuous backups, a written restore runbook, and one restore drill**; the volume sized per S5 | Volume loss = every portal reinstalls | S7, §4 | Deferred with hosting |
| 5 | Dead-letter instead of drop; give-up horizon raised to 24 h; re-auth pause instead of instant drop | Silent loss paths | §1, §3 | Done (replay tool open) |
| 6 | Test "same-value PATCH does not re-enroll" | Our effectively-once guarantee depends on it | §2 | Open |
| 7 | Token keyring format (`k<id>:`) and a second sealed key copy | Rotating later would be a migration | §7 | Keyring done; second copy is a process item |
| 8 | v3-only signatures on settings; refuse `SETTINGS_ALLOW_UNSIGNED` in production; log redaction (tokens, presigned URLs) | Replay and secret-leak risk | §7 | Done |
| 9 | Align retention with the privacy policy: `change_log`, `association_labels` 90 days, backups, logs; `portals` row purge after uninstall | Marketplace review plus legal accuracy | §7, M6 | Partly done; final policy check open |
| 10 | Startup lock guard against a second worker (especially after a restore) | Two workers on two DBs double-stamp and double-provision | M5, §4 | Done for one DB file; cross-DB guard open |
| 11 | Versioned schema migrations | Needed before real customer data exists | §8.3 | Done |
| 12 | SQLite pragmas, transactions, indexes, timer pruning | Keeps the single writer fast as tables grow | S1–S5, H5, M1 | Mostly done |

### Later (v1.1+)

- A per-portal coalescing toggle on the settings page (H4). Coalescing itself is on by default.
- Priority lanes `live`/`bulk`. Cheap now that #2 is done.
- A `journal_gaps` record, a settings-page banner, and an opt-in resync (§3).
- Out-of-order and clock-skew metrics (§2, §3).
- Sinks per portal and app events through the shared outbox (§8.1).
- Cold standby in a second region (§4).
- M2, M3, M4 (compare-and-set), M6 leftovers and M7 from the scale review.
- Postgres plus a leader lock, only when a trigger in §1 is hit. EU deployment only on demand.

### RTO / RPO targets (summary)

- **Changes (customer data in flight):** RPO **0** for any outage shorter than about 72 h, because the journal is the buffer. Past 72 h, the gap is lost; it's detected and reported, never silently filled.
- **Local state (tokens, settings, offset, queue):** RPO **≤ 1 s** with continuous backup. Without it, it depends on host snapshots (often ≤ 24 h), which is **not** acceptable for launch.
- **RTO:** process crash < 1 min; host failure ≤ 30 min; volume loss ≤ 1 h; region loss ≤ 4 h.
- **Latency SLO when healthy:** p95 under 30 s from occurredAt to stamp.
