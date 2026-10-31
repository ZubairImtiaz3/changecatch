# ChangeCatch runbook

What to do when something breaks in production. It assumes the two processes (API server and worker) run on one host and share one SQLite file (`DB_PATH`, default `data/changecatch.db`). Hosting is not chosen yet, so the steps say *what* to do, not which host command does it.

Background: [architecture.md](architecture.md), [install-flow.md](install-flow.md), [observability.md](observability.md), [configuration.md](configuration.md).

Part A answers one question: **can we rebuild association state after we lose journal data?** Part B has the incident playbooks. Part C lists the gaps this runbook exposes.

---

## 0. Tools used in every playbook

**Worker health JSON.** The worker serves `/health` on `WORKER_HEALTH_PORT` (default 3002). Keep that port private and ask from the host itself:

```sh
curl -s http://127.0.0.1:3002/health
curl -s -H "x-health-token: $HEALTH_TOKEN" http://127.0.0.1:3002/health   # adds per-portal detail
```

The fields that matter (`service/src/worker/health.ts`):

| Field | Meaning | Healthy |
|---|---|---|
| `status` | `ok`, or `stale` (HTTP 503) when there's been no successful journal read for 1 h | `ok` |
| `lastSuccessfulReadAt` | last good journal read | under 1 min ago |
| `offset` | stored journal offset (UUIDv7) | changes over time |
| `consecutiveErrors`, `lastError` | journal read failures in a row, and the last message | 0 / old |
| `stampQueue.size`, `stampQueue.nextDueAt` | stamps waiting; next due time | small; near now |
| `latency` | `occurredAt` → stamped, for recent stamps | p50 under ~10 s |
| `totals.deadLetters`, `totals.pausedPortals`, `totals.lifecycleRetries`, `totals.parkedEntries`, `totals.labelHolds` | trouble counters, all portals | 0 |
| `workerLock` | which process holds the single-worker lock | `mine: true` |
| `metrics` | the metrics registry as JSON (journal lag, offset age, and so on) | see [observability.md](observability.md) |
| `labelHolds[]` (token only) | label lookups failing, and since when | empty |
| `portals[]` (token only): `lastError`, `lastErrorAt`, `stampsDropped`, `queued`, `deadLetters`, `paused` | per-portal trouble | no recent errors, not paused |
| `lifecycleRetries[]` (token only) | install/uninstall handling waiting for a retry | empty |

**Journal lag.** `/metrics` has `changecatch_journal_lag_seconds` and `changecatch_journal_offset_age_seconds`. To work it out by hand: offsets are UUIDv7, so their first 12 hex digits are a Unix-ms timestamp. Lag = now minus that time:

```sh
node -e "const o=process.argv[1].replace(/-/g,'');const ms=parseInt(o.slice(0,12),16);console.log(new Date(ms).toISOString(),Math.round((Date.now()-ms)/60000)+' min ago')" "<offset from /health>"
```

**Other checks:**
- The host's process status: there must be exactly **one** worker process. A second one refuses to start while the lock heartbeat is fresh (`WORKER_LOCK_STALE_MS`).
- Logs: search for `[ALERT]`, `[http]`, `DEAD-LETTERED`, `PAUSED`, `SKIPPING journal`.

**SQL on the host.** You don't need a `sqlite3` CLI; Node has one built in:

```sh
node -e "const d=new (require('node:sqlite').DatabaseSync)(process.env.DB_PATH||'data/changecatch.db');console.log(d.prepare(process.argv[1]).all())" "SELECT key,value FROM worker_state WHERE key LIKE 'journal_%'"
```

The stored offset is in table `journal_offset`. An expired-offset reset is recorded in `worker_state` key `journal_offset_reset`.

**Log strings to know:**

| Log line | Source | Meaning |
|---|---|---|
| `[ALERT] ChangeCatch worker: no successful journal read since …` | `health.ts` StaleAlerter | No read for 1 h. Repeats while stale. `[ALERT-CLEARED]` when it recovers. |
| `[ALERT] journal offset … is gone (HTTP 404 …)` | `journal-reader.ts` | Offset expired. We restarted from `earliest`, so **data was lost**. Also sets `worker_state.journal_offset_reset`. |
| `SKIPPING journal entr… that failed for over 30 min` | `journal-reader.ts` | One journal file kept failing (HTTP 207) and was skipped. Its changes are lost. |
| `[ALERT] journal file …` (bad URL host, over the byte cap) | `journal-reader.ts` | A journal file was refused for safety. |
| `[http] … -> 429 (…)` / `-> 5xx, retry in …` / `timeout` | `lib/http.ts` | Rate limit, server error, or hung call. |
| `portal N: stamp … failed (attempt K), retry in …` | `stamp-queue.ts` | A transient stamp failure; it will be retried. |
| `portal N: K stamp(s) DEAD-LETTERED (kept in stamp_dead_letter)` | `stamp-queue.ts` | HubSpot refused the record, or retries ran out after `STAMP_RETRY_MAX_MS` (24 h). |
| `[ALERT] portal N: K stamps refused in a row` | `stamp-queue.ts` | Bad data, or a missing property or scope in that portal. Other portals are not affected. |
| `[ALERT] portal N: token revoked/invalid; PAUSED …` | `stamp-queue.ts` | That portal is paused until the admin reinstalls (B5). |
| `[ALERT] portal N: paused for over 7 days without a reinstall; running the uninstall routine` | `stamp-queue.ts` | The pause expired; the portal's data is purged. |
| `[ALERT] portal N: lifecycle retry K failed` | `lifecycle-retry.ts` | Install/uninstall handling keeps failing. |
| `[ALERT] … parked entr… DROPPED` | `core/poller.ts` | A portal's label lookup was held too long and the park cap was hit. |

---

## Part A. Rebuilding state after journal data loss

### A1. What the Snapshots API can do (checked 2026-10-30)

Sources:
- https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/snapshots/guide
- the journal overview https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/guide
- `llms.txt`, which has **no** snapshot reference pages or OpenAPI.

| Question | Answer from the docs |
|---|---|
| Endpoints | `POST /webhooks-journal/snapshots/2026-09/crm` and `GET /webhooks-journal/snapshots/2026-09/crm/status/{snapshotStatusId}` |
| Auth | Client-credentials token. `developer.webhooks_journal.snapshots.write` to create, `.read` for status. |
| Request | `{ "snapshotRequests": [ { "portalId", "objectId", "objectTypeId", "properties": ["..."] } ] }`. All four fields are required. It works **one record at a time**, and you name the **properties** you want. |
| Response | `snapshotResponses[]` echoes portal/object/type plus a `snapshotStatusId`. Status goes `PENDING` → `IN_PROGRESS` → `SUCCESS` / `FAILED` (`TIMEOUT`, `VALIDATION_ERROR`, `INTERNAL_ERROR`, `PERMISSION_DENIED`) / `EXPIRED`. A 404 just after create is normal. |
| Delivery | The result "may appear in the journal a few seconds after" `SUCCESS`. The shape of the snapshot journal event is **not documented**. |
| Limits | **10 req/s per app**. The docs say "group multiple snapshot requests into single API calls", but give no max batch size and no per-portal cap. |
| Associations / labels | **Not mentioned anywhere.** The only input is a list of property names. Nothing says a snapshot carries associations, `associationTypeId`, or labels. |
| Listing records | None. You must already know every `objectId`. |

**Verdict: no.** As documented, journal snapshots can't rebuild association state. They are point-in-time **property** snapshots of records whose IDs you already have. They return no associations or labels, and they can't list a portal's records. They also come back through the journal, the same channel that just lost data, in an undocumented format.

### A2. What *can* rebuild it: the CRM associations API (customer token)

`POST /crm/associations/2026-09/{fromObjectType}/{toObjectType}/batch/read` with `{ "inputs": [ { "id": "123", "after": "<cursor>" } ] }`.
- Source: https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/batch/get-associations
- It returns, for each source record, `to[]` with `toObjectId` and `associationTypes[]` = `{ category, typeId, label }`. So it gives **current links plus labels**, which is exactly what we need.
- Paging is per input (`paging.next.after`).
- The max inputs per call is **not stated**. Start with 100 and confirm live.
- It uses the **customer's** 110 req/10 s budget, so every call goes through our per-portal limiter (`service/src/lib/rate-limiter.ts`, `HS_PORTAL_RATE_PER_10S`, default 100).

You also need the record IDs of the subscribed side. List them with the date-based CRM objects list endpoint (`GET /crm/objects/2026-09/{objectType}?limit=100&after=…`). Confirm the exact path on the current docs page before first use.

**Cost per portal per watched pair** (subscribed side has N records):
- About N/100 list calls plus N/100 batch-read calls (more if records have more than one page of associations).
- At 10 req/s, 100k records take about 2,000 calls, so **about 3–4 min**.
- 1M records take about 35 min and use that portal's whole API budget while it runs.

This is a per-record scan, the thing the design avoids for normal running. That's acceptable for a rare recovery job only. Run it per portal, one at a time, never for all portals at once.

### A3. What state we keep, and its gaps

| Table / property | What it holds | Use for a diff | Gaps |
|---|---|---|---|
| `association_labels` (`pair_key` = `portal\|typeA:idA\|typeB:idB`, direction-insensitive; `labels_json`; `updated_at`) | Last known label set for each **record pair we saw an event for** | **Primary baseline.** Gives "labels before" for a pair. | (1) Only pairs that changed **since install**; links that existed before install are unknown. (2) Pruned after **90 days** without change. (3) Purged on uninstall. (4) No row for a pair is ambiguous: never linked, linked before install, or pruned. (5) Confirm in `service/src/store/db.ts` whether a REMOVED pair keeps an empty row or is deleted; if deleted, removed pairs are also "no row". |
| `change_log` | Every change (record, other record, `label_before`/`label_after`, type). Kept **30 days**. | A secondary check, and the source to **re-queue lost stamps**. | Only changes we produced. Not a full state. |
| `stamp_dead_letter` | Stamps we could not deliver, with the error | The exact list of changes customers never saw | Purged on uninstall. |
| `changecatch_labels_current` on the customer's record | Labels of the **last stamped pair** on that record | Shows what the customer's workflows currently "see" | It only describes one pair (the last one), not all of the record's associations. |
| `label_cache` | `typeId` → label name for each portal and object pair | Map scanned `typeId`s to names | Deleted labels drop out. |

**Conclusion.** The diff is reliable only for pairs already in `association_labels`. For those we can say "removed during the gap" or "label changed from X to Y during the gap". A link that exists now with no baseline row can't be told apart from an old link. If we emitted it as ADDED, we'd fire false workflows for every pre-install link.

### A4. "Reconcile after data loss" procedure (design; no tool yet)

**Inputs:**
- the gap window: `journal_offset_reset.from` (the timestamp in the UUIDv7) up to the `occurredAt` of the first `earliest` entry
- the affected portals: all installed portals with watched pairs, if the whole journal reset
- or one portal (token revoked, then reinstalled)

**Steps** (a future reconcile tool taking a portal id, an apply mode `refresh|replay`, and a dry-run flag):

1. **Freeze nothing.** The worker keeps running. Live changes keep flowing during the reconcile.
2. For each watched pair of the portal (subscribed side = `portal_settings.object_type_id`):
   - list record IDs, then batch-read associations;
   - build `now[pair_key] = set(label names)`, with `(none)` for HUBSPOT_DEFINED-only;
   - map `typeId` with `label_cache`, and refresh it on unknown IDs.
3. Load `before[pair_key]` from `association_labels` for that portal.
4. Classify each pair:

   | before | now | Class | Confidence |
   |---|---|---|---|
   | row | absent | REMOVED in gap | high |
   | row, set A | set B ≠ A | LABEL_CHANGED in gap | high |
   | row, A | A | unchanged | nothing to do |
   | no row | present | **ADDED in gap OR pre-existing** | **unknown** |
   | no row | absent | nothing | none |

5. Skip any pair whose `association_labels.updated_at` or `change_log` entry is **newer than the scan start**, because the live worker already handled it.
6. Write a report (`reconcile-<portal>-<ts>.json`) with counts per class and sample rows. **Always run a dry run first and get sign-off before applying** (it is a mass write to a customer's portal).
7. Apply: see A5.
8. Update `association_labels` to `now` for every scanned pair. This also fills the baseline for pre-install links, so the next reconcile is stronger.
9. Record `worker_state.reconcile_last:<portal>` = `{ at, gapFrom, gapTo, counts }`.

### A5. Synthetic changes vs. silent refresh

| | **Silent refresh** (recommended default) | **Synthetic replay** (opt-in) |
|---|---|---|
| What it writes | `changecatch_labels_current` (and `changecatch_label_after`) on affected records. **Not** `changecatch_last_change_id`. | Full stamps with a new `changecatch_last_change_id`, `changecatch_change_type` = REMOVED/LABEL_CHANGED. The real change time is unknown (the scan time is used in `change_log`). |
| Workflows | Customer workflows trigger on `changecatch_last_change_id`, so **none fire**. Exception: a customer who built a workflow on "labels current changed" would see it fire. Say this in the setup docs. | They fire, so the business process "catches up" (for example a task gets created for the new Decision maker). |
| False triggers | None from the main trigger | None for high-confidence classes. **Never** replay the "unknown" class (ADDED vs. pre-existing). |
| Wrong data | `changecatch_label_before` is not touched, so it can be stale until the next real change | `occurred_at` is not the real time. Two changes in the gap collapse into one (we only see the end state). A link added **and** removed inside the gap is invisible either way. |
| Cost | 1 batch update per 100 records | Same, plus workflow enrollments on the customer's side |
| Order | Any | Must respect per-record spacing; put it through `stamp_queue` like live stamps |

**Recommendation:**
- Default to **silent refresh** plus a per-portal report that the admin can see. Later, the settings page could show "N association changes happened while ChangeCatch was offline between X and Y; they did not trigger workflows."
- Offer **replay** per portal, only for high-confidence REMOVED and LABEL_CHANGED rows, after the admin agrees.
- To let customers filter synthetic stamps out, add one more property, `changecatch_change_source` (`live` / `reconcile`). This is new and needs an option sync. Without it, replayed stamps look exactly like live ones.
- The list and association read calls are covered by the existing CRM read scopes; no scope change is needed.

### A6. Honest limits

- Nothing recovers **who** changed what, or **when** inside the gap.
- Flip-flops inside the gap (add then remove, A → B → A) are invisible.
- Links that existed before install have no baseline, so they can never be classified as "added in gap".
- Large portals: a full reconcile costs minutes to tens of minutes of the customer's API budget per pair.
- **Prevention beats reconcile.** Keep the stale alert and the heartbeat wired to a pager or email ([observability.md](observability.md)), so a stopped worker is found long before the journal's ~3-day retention runs out.

---

## Part B. Incident playbooks

### B1. Worker down, less than 3 days

- **Symptoms:** `changecatch_*` properties stop changing. Customer workflows don't fire.
- **Detect:**
  - Heartbeat check fails (Healthchecks), or the alert on `changecatch_journal_read_age_seconds`.
  - Log: `[ALERT] ChangeCatch worker: no successful journal read since …`.
  - `/health`: `status: "stale"`, old `lastSuccessfulReadAt`, journal lag (section 0) in hours.
  - If the host itself is down, the public `/health` of the API server fails too.
- **Fix:**
  1. Read the logs from before the stop. Out of memory → give the host more memory. Crash loop right after a release → B8.
  2. Restart the worker (`pnpm --filter @changecatch/service start:worker`, or the host's restart command).
  3. Nothing else is needed. The stored offset is still valid, so the worker resumes from it. Dedupe (`seen_events`, change IDs) prevents double stamps.
- **Catch-up time:** about backlog files ÷ (download rate − arrival rate).
  - Files download in parallel (`JOURNAL_DOWNLOAD_CONCURRENCY`, default 16), in batches of up to 100.
  - Small installs (a few hundred files a day): seconds to minutes.
  - At large scale, estimate about 3 h of catch-up per day of downtime, and measure it in your own load tests.
  - Watch the lag shrink. If it isn't shrinking after 30 min, treat it as a B2 risk.
- **After:** stamps arrive late; `change_log` keeps the real change time. Workflows fire late, but they do fire. Tell affected admins if the gap was more than a few hours.

### B2. Worker down more than 3 days (or never caught up)

- **Symptoms:** as B1, plus on restart: `[ALERT] journal offset … is gone (HTTP 404 …)`.
- **Detect:** the `journal_offset_reset` row in `worker_state` (SQL in section 0); `lastError` mentions the expired offset and the restart from earliest.
- **Fix:**
  1. Restart as in B1. The worker restarts by itself from `earliest` and stamps the last ~3 days.
  2. Work out the gap. From = the time in `journal_offset_reset.from` (UUIDv7). To = the `occurredAt` of the first file read after the reset. Write it into the incident note.
  3. For every installed portal with watched pairs, run the **reconcile** (Part A4) as a dry run, review it, then apply in silent-refresh mode.
  4. Tell affected admins the gap window, and say that changes in it did not trigger workflows.
- **Recovery time:**
  - Journal replay of 3 days: see the B1 numbers.
  - Reconcile: about 3–4 min per 100k records per pair per portal, run one portal at a time.
  - **The reconcile tool doesn't exist yet.** Until it does, the gap is unrecoverable and the admin notice is the only action.

### B3. Journal 404 / expired offset while the worker was up

This can happen if the worker was "up" but stuck, for example erroring for days or falling behind.

- **Detect:** the same `[ALERT] journal offset … is gone` log and `journal_offset_reset` row. Before it happened, `consecutiveErrors` grew and journal lag climbed toward 72 h (alerts 3 and 4 in [observability.md](observability.md)).
- **Fix:** the worker has already restarted from `earliest`, so there is nothing to restart. Find the root cause (look at `lastError` before the reset). Then follow B2 steps 2–4.
- **Related:** `SKIPPING journal entr… failed for over 30 min` is a smaller version of the same thing (one file lost). Note the offset. The affected portals are unknown, because the file was never read. If it repeats, open a HubSpot support ticket with the offset and `correlationId`.

### B4. HubSpot outage / 5xx storm

- **Symptoms:** `[http] … -> 500/502/503` and `timeout` lines. `consecutiveErrors` rising. `stampQueue.size` growing.
- **Detect:**
  - `/health` `lastError`, `consecutiveErrors`, `stampQueue`.
  - Check https://status.hubspot.com. If the journal is down, the stale alert fires after 1 h.
- **What the code already does:**
  - Journal reads back off from 5 s up to 120 s (`JOURNAL_ERROR_BASE_MS` / `JOURNAL_ERROR_MAX_MS`). The offset doesn't move, so no data is lost while the outage is **under 3 days**.
  - Stamps retry with back-off for `STAMP_RETRY_MAX_MS` (24 h), then are **dead-lettered** (kept in `stamp_dead_letter`, never silently deleted). The change itself is also still in `change_log`.
  - HTTP timeouts are 20 s (`HTTP_TIMEOUT_MS`).
- **Do:**
  - Usually nothing. **Don't restart in a loop**; it resets nothing useful.
  - If the outage looks like it will last longer than a day, raise `STAMP_RETRY_MAX_MS` and restart the worker before dead-letters start.
- **After:** if stamps were dead-lettered, they can be re-queued from `stamp_dead_letter` (or from `change_log` by `change_id`). There is no re-queue tool yet, so today this is a manual job.
- **Recovery time:** the journal catches up as in B1, once HubSpot is back.

### B5. A portal's token is revoked, or the app is uninstalled, while stamps are queued

- **Symptoms:**
  - Log: `portal N: refresh token rejected by HubSpot; marked revoked`, then `[ALERT] portal N: token revoked/invalid; PAUSED …`. Or `app uninstalled`.
  - **Other portals are not affected.**
- **Detect:** `/health` `totals.pausedPortals`; with the health token, `portals[N].paused` and `portals[N].queued`. Metric `changecatch_portals_paused`.
- **If it was an uninstall:** this is expected. The worker reads the uninstall event, deletes the portal's subscriptions and purges its rows ([install-flow.md](install-flow.md)). Nothing to do.
- **If it was a revoke without uninstall** (an admin removed access, or the user who installed was removed):
  - The portal is **paused**: its queue is kept and probed hourly.
  - Ask the admin to reinstall at `<PUBLIC_BASE_URL>/install`. A reinstall lifts the pause and the queued stamps go out.
  - If there is no reinstall within `PORTAL_PAUSE_MAX_MS` (7 days), the uninstall routine runs and the portal's data is purged.
  - After the reinstall, check that `portals.last_provision_error` is empty (the settings page shows it).
  - If the pause ran long enough for the journal to move past changes that were never queued, reconcile that portal (Part A) for the window, in silent-refresh mode.
- **Recovery time:** as fast as the admin reinstalls.

### B6. 429 storms

- **Symptoms:** many `[http] … -> 429 (…)` lines. Stamp latency grows.
- **Detect:** logs; `latency` p95 in `/health`; `stampQueue.nextDueAt` slipping; `changecatch_rate_limited_total`.
- **Know which bucket:**
  - **Portal bucket** (the customer's 110 req/10 s). Usually the customer's own integrations are using up the shared budget, or a bulk import. Our limiter allows `HS_PORTAL_RATE_PER_10S` (default 100) per portal, and a throttled portal is deferred on its own. Other portals are not blocked.
    - Fix: lower `HS_PORTAL_RATE_PER_10S` (for example to 60) and restart both processes, or raise that portal's stamp spacing in its settings page.
  - **Journal bucket** (100 req/s per app; we use 80). This should never happen at 3 s polling. If it does, something is looping. Check for a **second worker** (two hosts, or a local worker pointed at production). There must be exactly one.
  - **Subscriptions bucket** (we use 40 req/s): only during mass reprovisioning. Wait it out.
- **Recovery time:** minutes after the source of load stops. Deferred stamps are not lost.

### B7. Disk full / SQLite corruption

- **Symptoms:** `SQLITE_FULL`, `database or disk is full`, `database disk image is malformed`, or `SQLITE_CORRUPT` in logs. The worker exits, and the host may restart it in a loop.
- **Detect** (on the host):
  ```sh
  df -h "$(dirname "${DB_PATH:-data/changecatch.db}")"
  ls -la "$(dirname "${DB_PATH:-data/changecatch.db}")"     # look for a huge changecatch.db-wal
  node -e "console.log(new (require('node:sqlite').DatabaseSync)(process.env.DB_PATH||'data/changecatch.db').prepare('PRAGMA integrity_check').all())"
  ```
- **Disk full:**
  1. Grow the disk (the host's volume resize), then restart both processes.
  2. Then shrink what grew. The usual causes are `seen_events`, `change_log` (30 days), and the WAL file. Pruning runs every `DB_MAINTENANCE_INTERVAL_MS`.
- **Corruption: restore from backup.**
  1. **Stop both processes** (API server and worker), so nothing writes to the file.
  2. Move the broken files aside for later study: `changecatch.db`, `changecatch.db-wal`, `changecatch.db-shm`. Don't leave an old `-wal` or `-shm` next to the restored file.
  3. Copy the latest good backup to `DB_PATH`.
  4. Check it: run `PRAGMA integrity_check` (above). It must print `ok`.
  5. Make sure the **same** `TOKEN_ENC_KEYS` (and `TOKEN_ENC_KEY`, if any old `v1:` rows exist) are set. Otherwise every restored refresh token is unreadable and every portal must reinstall.
  6. Start both processes. Pending schema migrations apply on start.
- **What the worker does after a restore:**
  - The restored offset is older than the real one. If it is **under ~3 days old**, the worker re-reads the journal from there. Changes already handled are re-read; dedupe and deterministic change IDs keep them from being treated as new.
  - If it is **more than ~3 days old**, the journal returns 404. The worker logs `[ALERT] journal offset … is gone`, records `journal_offset_reset`, and restarts from `earliest`. Follow B2.
  - Records already stamped get the same `change_id` again. They should not re-enrol in workflows, because setting a property to its current value is not a change. **Confirm this once** in a test portal before relying on it.
  - The restored `worker_lock` row has an old heartbeat, so the new worker takes the lock normally.
  - Settings saved and installs done after the backup time are lost. Those admins must save settings or reinstall again. Compare `portals.installed_at` with the backup time to find them.
- **How to verify:**
  - `/health` shows `status: "ok"`, a recent `lastSuccessfulReadAt`, and the `offset` moving.
  - Journal lag (section 0) shrinks.
  - Change an association in a test portal; within about a minute its `changecatch_*` properties change.
- **Recovery time:** depends on the backup method and size, plus journal catch-up. Run a restore drill once before launch.

### B8. Bad release (roll back)

- **Symptoms:** right after a release, a process crash-loops, health checks fail, `/api/settings` errors, or stamps look wrong.
- **Detect:** the host's process status, logs (stack traces). The worker's `status` goes `stale` after 1 h, but don't wait for that.
- **Fix:**
  1. Redeploy the last good build (previous git tag or image).
  2. Run **one** worker only. Don't scale up to "help".
  3. **Database schema:** migrations are append-only (`runMigrations` in `service/src/store/db.ts`), and normally only add tables or columns, so old code usually runs on a newer file. If the bad release did a destructive migration, restore the database (B7) **before** rolling back.
  4. If the bad release **stamped wrong values**, list the affected `change_id`s from `change_log` for the window, and correct them with the reconcile in silent-refresh mode after the rollback.
  5. If the release also changed the HubSpot app (scopes, `permittedUrls`, settings page), roll that back separately with `hs project upload` from `hubspot-app/` on the previous version. Get sign-off first: a project upload affects every installed portal.
- **Recovery time:** minutes if the previous build is ready, plus journal catch-up for the downtime.

### B9. Public URL change for the settings page

- **Symptoms:** the settings page in HubSpot shows a fetch error, or every `/api/settings` call returns **401**. OAuth install fails with `redirect_uri mismatch`.
- **Detect:** API server logs show 401 signature failures. Signatures are checked against `PUBLIC_BASE_URL + path`, so a URL mismatch is always the cause. The worker is not affected.
- **Fix:** change all four places together:
  1. `hubspot-app/src/app/app-hsmeta.json`: `config.auth.redirectUrls` (add the new `/oauth/callback`) and `config.permittedUrls.fetch` (the new HTTPS origin).
  2. `hubspot-app/src/app/settings/ChangeCatchSettings.tsx`: `API_BASE`.
  3. From `hubspot-app/`: `hs project upload` (get sign-off before uploading).
  4. Set `PUBLIC_BASE_URL=https://<new>` and `HUBSPOT_REDIRECT_URI=https://<new>/oauth/callback` on the host, then restart the API server.
  - For a custom domain, set up its TLS certificate and DNS on the host first, then do steps 1–4.
- **Test:** open the settings page and save once. Run a fresh `/install` in a test portal.
- **Recovery time:** 10–15 min, mostly the project build. Use a **stable** URL in production. Quick tunnels change on every restart.

### B10. Rotating the token encryption key

- **How it works:** stored refresh tokens are AES-256-GCM with the portal id as AAD (`service/src/install/crypto.ts`). Each value carries a key id. `TOKEN_ENC_KEYS` is a list: the **first** key encrypts new values, the others only decrypt. `TOKEN_ENC_KEY` is the legacy single key, still needed for old `v1:` values until they are re-encrypted.
- **When to rotate:**
  - The key leaked.
  - Someone who had it left.
  - On a schedule (yearly is plenty).
  - **If the key AND a database copy leaked together**, the refresh tokens are exposed. Rotation alone doesn't fix that. Treat it as a security incident, and have admins reinstall, which issues new refresh tokens.
- **Procedure** (no downtime needed):
  1. Make a new key (command in [configuration.md](configuration.md) section 2). Store it in the password manager next to the old one.
  2. Take a database backup first.
  3. Put the new key **first** in `TOKEN_ENC_KEYS`, keep the old one after it. Restart the API server and the worker.
  4. Dry run: `pnpm --filter @changecatch/service exec tsx src/cli/rotate-token-key.ts`. It decrypts every row and writes nothing. Token values are never printed. (The tools package README lists the current way to run it.)
  5. Apply: the same command with `--apply`. It re-encrypts every row that is not on the active key. Exit code 1 means some rows could not be decrypted; they are left unchanged.
  6. Verify: `/health` shows no portal with a token error, and logs show no decrypt errors.
  7. Remove the old key (and `TOKEN_ENC_KEY`) and restart again. Keep the old key in the password manager while older backups still need it, then destroy it.
- **Recovery time:** a few minutes. Without the keys, every portal must reinstall.

---

## Part C. Gaps this runbook exposes (to fix before launch)

1. **No reconcile tool** (Part A4). Today a gap of more than 3 days is unrecoverable.
2. **No re-queue tool for dead-lettered stamps.** `stamp_dead_letter` and `change_log` have the data.
3. **External alerting is not wired.** The heartbeat, Sentry and the `data_loss` metric exist as modules but are not called yet ([observability.md](observability.md), "Wiring status"). `[ALERT]` lines only reach the logs until they are.
4. **No backup method chosen yet.** Hosting is not decided. Pick one with a short restore-point gap (continuous SQLite replication is best), and run a restore drill (B7) before launch.
5. To confirm live: the max inputs for associations `batch/read`; whether re-stamping the same value re-enrols workflows; what the snapshot journal event looks like (only if snapshots are ever needed).
