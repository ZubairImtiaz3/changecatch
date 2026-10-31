# Scale review: 500 portals, bulk imports

> Review as of 2026-10-30. Status of each finding reflects the code at that date.

This is a code-level audit of the worker (`service/src/worker`, `service/src/core`), the HubSpot clients (`service/src/hubspot`), the store (`service/src/store`), install (`service/src/install`) and the two process entry points (`service/src/api/main.ts` and `service/src/worker/main.ts`).

The review was written against the code before the scale and hardening work. That work, and the later split-file pairing and burst fixes, landed the same day. Each finding below has a **Status** line that says what the code does now. Code references name the file and function; line numbers are left out because they drift.

**Scenario**
- 500 installed portals.
- A typical portal makes about 1,000 association changes per day, so 500k/day across all portals (about 6/s on average).
- Some portals run bulk imports of about 50,000 changes in one hour (about 14/s from one portal).

**Decision:** SQLite in WAL mode stays in production, with the API server and worker on one host. The database findings below are about making SQLite production-grade. Postgres appears only under "When to revisit".

Severity: **critical** = breaks correctness or stalls all portals at this scale. **high** = large latency or cost hit that is likely to happen. **medium** = will hurt, but has a workaround or is less likely. **low** = cleanup.

---

## Status summary

| ID | Finding | Status |
|---|---|---|
| C1 | One busy record delays the whole portal | Fixed |
| C2 | Lifecycle failure stops the journal for everyone | Fixed |
| C3 | Serial journal file downloads | Fixed |
| H1 | No per-portal rate limiter; 429 sleeps block the loop | Fixed |
| H2 | No request timeout | Fixed |
| H3 | Unfair, serial stamp drain | Fixed |
| H4 | Hot-record pile-up | Fixed (coalescing is a global setting, not yet per portal) |
| H5 | Full-table scans in pruning | Mostly fixed |
| M1 | Per-row autocommits and N+1 lookups | Mostly fixed |
| M2 | `seen_events` per event | Open |
| M3 | Pending and parked rows rewritten in full | Open |
| M4 | Uninstall and token races between two processes | Partly fixed (`BEGIN IMMEDIATE` done; refresh-token compare-and-set open) |
| M5 | No guard against two workers | Fixed for one database file |
| M6 | Other unbounded growth and missing metrics | Partly fixed |
| M7 | Deleted label can park a portal for 30 minutes | Open |
| S1–S6 | SQLite settings, transactions, statements, indexes, pruning | Mostly fixed |
| S7 | Backups | Deferred with hosting |

---

## 1. Findings

### C1. One busy record delays every other record in the same portal. **Critical**
`service/src/core/stamp.ts` (`planStampWaves`), called from `service/src/worker/stamp-queue.ts` (`enqueue`).

- A wave's `notBefore` was the **maximum** of `(previous stamp or queued slot) + spacing` over **all** records in that wave.
- After that, "waves are sequential", so a later wave was never scheduled before an earlier one.
- In `enqueue`, `lastAt(k)` included `maxQueuedNotBefore(k)`. So if deal A already had 200 stamps queued (the last one at now+600 s), every new update for deals B, C, D… in the same journal batch got `notBefore = now+603 s`.
- During a bulk import this compounds. Each journal batch queues behind the hottest record's tail, so the whole portal becomes one serial line at 3 s per wave. For a 50k import with a few changes per record per batch, that is tens of minutes to hours. Unrelated records in that portal also wait.
- The unit tests passed because they only covered one batch with fresh records.

**Fix:**
- Give each update its own slot in the queue path: `notBefore_u = max(now, lastAt(k) + spacing)`, then `+ spacing` for each further update of the same record within the call.
- Drop the "waves are sequential" rule for the persisted queue. The drain already enforces per-record order (`firstQueuedFor`) and spacing (`getLastStampAt`), so a per-wave barrier adds nothing.
- Keep `planStampWaves` only for the in-memory `Stamper` used by tools.

**Status: fixed.** Slots are now planned per update (`planStampSlots` / `planEnqueue`). There is no "waves are sequential" barrier. `planStampWaves` remains only for the in-memory stamper.

### C2. A failed install or uninstall in the lifecycle hook stops the journal for every portal. **Critical**
`service/src/core/poller.ts` → `service/src/worker/hooks.ts` → `service/src/install/lifecycle.ts` → `service/src/install/installer.ts`.

- `onOtherEvent` was awaited without a try/catch. `Installer.provision` re-throws on any failure: a missing scope, a 403 on a custom object, a 409 on a property-create race, or a 5xx on the subscriptions API.
- When it throws, `runOnce` throws, the offset is not saved, and the same file is re-read with error back-off forever. One bad install blocks all 500 portals. After about 3 days the offset expires and everything in between is lost.
- **Race that triggers it:** `/oauth/callback` provisions in the API-server process. The `APP_INSTALL` journal event arrives about 1 s later. The worker sees `provisionedAt === null` (the API server is still provisioning) and provisions again in parallel.
  - The two `Installer`s each have their own in-process lock, so nothing stops this.
  - The second `POST /crm/properties` gets 409, which counts as an error and throws.
  - It self-heals on the next run, but only after an error back-off for everyone.

**Fix:**
- Treat the lifecycle hook like a parkable portal error:
  - catch the error,
  - `recordPortalError`,
  - write a row to a `lifecycle_retry` table (portal, action, attempts, next_at),
  - move the offset on.
- Retry from that table outside the journal path.
- For uninstall, the local purge can run at once; the subscription delete can retry later.
- In the worker, make `install` do nothing (or only verify) when the API server provisioned a few minutes ago.

**Status: fixed.** `service/src/worker/lifecycle-retry.ts` wraps the hook. A failure is caught, recorded on the portal, and saved to the `lifecycle_retry` table. The offset always moves on, and the worker retries due rows on its own timer.

### C3. Journal files are downloaded one at a time, and that caps total throughput. **Critical at 500 portals**
`service/src/worker/journal-reader.ts` (`download`) and `service/src/hubspot/journal.ts`.

- Each journal **file** is one presigned S3 GET, typically 50–200 ms. A full batch of 100 files takes 5–20 s, so the ceiling is about 5–15 files/s.
- Tests showed one UI action per file, with both halves of a label edit in the same file. If production files carry about one change each, normal load (6 changes/s) already uses half to all of that ceiling.
- A 50k bulk import adds roughly 1.5–3 hours of backlog. Every portal waits behind it, because the offset is shared.
- It also makes the "full batch → read again at once" loop spend most of its time on S3 round trips. The Journal API (100 req/s) is not the limit.

**Fix:**
- Download with bounded parallelism (for example 16 at a time, over a small pool), keeping the result order.
- Also record `events per file` in metrics, so the real ratio is known.
- With 16-way downloads, a 100-file batch takes about 1 s, and a 50k import is caught up in a few minutes.

**Status: fixed.** Downloads run through a bounded pool (`mapConcurrent`) and are returned in offset order, so pairing and the stored offset see the same sequence as a serial read. Files read and events read are both counted in metrics.

### H1. No per-portal rate limiter, and 429 sleeps block the whole worker. **High**
`service/src/lib/http.ts`. There was no limiter anywhere. The project rules require a shared limiter.

- The worker was accidentally safe. Every call was awaited one after another, so it rarely went past about 3 req/s per portal, well under 110 per 10 s.
- But `hsRequest` handled a 429 or 5xx by sleeping **inline**: up to 4 retries, honouring `Retry-After`, up to 30 s each. During that sleep the single loop stopped for **all** portals: no journal reads, no other portal's stamps.
- The API server makes calls for the same portal (object types, provisioning) from a different process. Both draw on the same 110/10 s budget with no shared view of it.
- As soon as anyone adds parallelism (C3, H3), the per-portal limit will be hit during bulk imports.

**Fix:**
- Add a `RateLimiter` keyed by portalId: a token bucket of 100 per 10 s, leaving 10% headroom for the API server.
- Every customer-token call (stamps, labels, label sync, token refresh) goes through it.
- On 429, do not sleep inside `hsRequest` for worker calls. Throw a `RetryLaterError(retryAfterMs)`. The stamp queue already defers with backoff; use `Retry-After` as the defer time. Label fetches can park the portal.
- Keep inline retry only for the journal API (app-level, a separate limit).

**Status: fixed.** `service/src/lib/rate-limiter.ts` keeps a bucket per portal (`HS_PORTAL_RATE_PER_10S`, default 100) plus app-level buckets for the journal and subscriptions APIs. Portal calls that would wait too long throw `RetryLaterError`, and the stamp queue defers by `Retry-After`. Other portals are not blocked.

### H2. No request timeout: one hung connection stalls everything. **High**
`service/src/lib/http.ts`. `fetch` had no `AbortSignal`. Undici's default header and body timeouts are about 300 s each.

- A single hung S3 download, label fetch or batch update froze the single loop for up to about 5 minutes per attempt, for all portals. With 4 retries that could be up to about 20 minutes.

**Fix:** `fetch(url, { signal: AbortSignal.timeout(...) })`, with longer limits for batch updates and shorter ones for S3 downloads. A timeout counts as a network error, which is already retried.

**Status: fixed.** Every request has `AbortSignal.timeout` (default 20 s, `HTTP_TIMEOUT_MS`). Journal file downloads have their own timeout.

### H3. Stamp-queue drain: one portal's backlog blocks the others, and the drain is serial. **High**
`service/src/store/db.ts` (`dueStamps`: global `ORDER BY not_before LIMIT 1000`) and `service/src/worker/stamp-queue.ts` (groups sent one after another).

- After a 50k import (or the C1 pile-up), portal A has tens of thousands of stamps that are all due. Each drain takes the 1,000 oldest, which are all A's.
- Portal B's fresh stamp sorts behind them and waits until A's backlog is gone: 50 drains × about 10 sequential batch calls × about 0.5 s ≈ 4–5 minutes.
- Also, `runOnce` called `sendStamps` → `drain()` inline. So the journal read also waited for a full drain.

**Fix:**
- Make the drain fair across portals. Select at most N due rows **per portal**.
- Send different portals in parallel (for example 8 at a time), one at a time per portal, through the H1 limiter.
- Don't drain inside `sendStamps`; just enqueue and let the loop drain. The journal read then never waits on CRM writes.

**Status: fixed.** The drain takes at most 100 records per portal per cycle and stamps up to 8 portals in parallel (`STAMP_PORTAL_CONCURRENCY`). The production worker sets `drainInline: false`, so the loop drains after a read instead of inside it.

### H4. Hot-record pile-up: should we coalesce bursts? **High (product + cost)**
`service/src/worker/stamp-queue.ts`, with spacing from `portals.stamp_spacing_seconds`.

- **Example:** 200 contacts linked to one deal. With the subscription on Deal, that is 200 stamps × 3 s = **10 minutes**, 200 workflow enrollments on that deal, and 200 batch calls of 1 record each.
- **DB cost in the drain:** each drain looked at those rows and called `deferQueued` for every one it skipped, in a separate transaction per row. That is about 200 writes per drain × 200 drains = about 40k commits.
- **Product question:** does an admin want 200 enrollments on the deal? Enrollment criteria see the right values per change, so the 200 stamps are "correct". But for imports it is mostly noise. HubSpot workflow volume also counts against the customer.

**Fix (recommended):** a per-record burst coalesce.
- When a record has more than a threshold of stamps queued, merge the queued ones into **one** stamp:
  - `change_type` and labels from the **latest** change,
  - `changecatch_last_change_id` new.
- Every individual change stays in `change_log`.
- Expose a "Bulk changes: one stamp per record (recommended) / every change" choice.
- Even without coalescing, stop deferring row by row.

**Status: fixed.** `service/src/core/coalesce.ts` merges bursts. `COALESCE_MODE=latest` (default) with a threshold of 3; `COALESCE_MODE=off` stamps every change. Every change stays in `change_log`. Changes from the original proposal:
- There is **no** `changecatch_burst_count` property. The property set was trimmed (decision D5), so the burst size is only in logs and metrics.
- The mode is a worker-wide setting. A per-portal settings toggle is still open.
- Defers in a drain are written in one transaction.

### H5. Full-table scans in pruning on every run. **High as tables grow**
`service/src/core/poller.ts` ran four prune DELETEs inside the offset transaction on **every run**, which is about every 3 s.

- `stamp_last` had no index on `stamped_at`. It grows to about 500k rows (one day of stamped records), so each run scanned all of them.
- `association_labels` had no index on `updated_at`. With 90-day retention it can reach tens of millions of rows (one per record pair ever seen). Each run did a full scan while holding the write lock, which blocked the API server's writes.
- `purgePortal` used `LIKE 'p|%'` on string keys. Default `LIKE` is case-insensitive, so it can't use the primary-key index, and an uninstall did a full scan of each table.

**Fix:**
- Add indexes on `stamp_last (stamped_at)` and `association_labels (updated_at)`.
- Purge by an indexed `portal_id` column or a key range, not `LIKE`.
- Run pruning at most every 10 minutes, outside the offset transaction, in chunks.

**Status: mostly fixed.**
- Both indexes exist.
- `purgePortal` uses a primary-key range (`'p|'` to `'p}'`) instead of `LIKE`.
- A maintenance timer (every 10 minutes, `DB_MAINTENANCE_INTERVAL_MS`) prunes in chunks of separate short transactions, then runs `incremental_vacuum` and `PRAGMA optimize`.
- Remaining: the poller still runs small, indexed prunes (at most 1,000 rows per table) inside the offset transaction on each run. They are cheap now, but could move fully to the timer.

### M1. Per-row autocommits and N+1 lookups in SQLite. **Medium**
- `store.markSeen(...)` ran **outside** a transaction, so each key was its own commit and fsync.
- In `service/src/worker/label-guard.ts`, each lookup did 2× `getLabel`, a `getState` with JSON.parse, and an unconditional `clearLabelHold` DELETE, which is an autocommit write that takes the write lock.
  - `resolveChanges` (`service/src/core/resolve.ts`) called it **per change**, not per distinct type.
  - For a 100-file batch from an import, that is thousands of writes per run.
- `StampQueue.enqueue`: `isQueued`, `getLastStampAt` and `maxQueuedNotBefore` run per update. That's 3 SELECTs each, which is acceptable locally but N+1.
- `spacingFor` in the worker read the portal row twice per due row.
- `filterSeen`: one SELECT per key. That's OK, but `WHERE key IN (…)` in chunks of 500 is much cheaper.
- `Store` called `db.prepare(...)` on **every** method call.

**Fix:**
- Memoise label lookups per run.
- Only `clearLabelHold` when a hold exists.
- Wrap `markSeen` in a transaction.
- Cache spacing and portal rows per drain.
- Use a statement cache on `Store`.

**Status: mostly fixed.** `Store` and `PortalStore` both cache prepared statements. `markSeen` writes all keys in one transaction. Still open: `clearLabelHold` runs on every successful lookup, and `filterSeen` is still one SELECT per key (prepared once).

### M2. `seen_events` is mostly redundant, and it's the biggest hot table. **Medium**
`service/src/core/poller.ts` and the `seen_events` table.

- Journal events are deduped per event (a key of about 120 bytes: offset|portal|from|to|type|action|occurredAt). But the offset and the `seen` rows are committed in the **same** transaction. So after a crash, re-read files are exactly those never committed, and per-event keys only matter after the 404 "restart from earliest" recovery.
- At 500k changes/day (about 1M journal events, plus `stamp:` keys), 4 days of retention is about 5–6M rows and about 1–1.5 GB including the index.

**Fix:**
- Dedupe journal events by **file offset**. Offsets look like UUIDv7, so "skip files with offset ≤ stored offset" covers both normal re-reads and the earliest-restart.
- Keep the `stamp:<changeId>` keys, or drop them too: `change_log` plus the queue's `INSERT OR IGNORE` already give idempotency.
- This removes about 70% of row writes.

**Status: open.** Events are still deduped by per-event key with 4-day retention. The table is now indexed and pruned on the maintenance timer.

### M3. `pending_pairs` and `parked_entries` are rewritten in full on every run. **Medium**
- `replacePending` (DELETE all, then re-insert) and `replaceParked` (load all, DELETE all, re-insert) are called every run in the poller's final transaction.
- Normally they are small. But a portal whose label lookup is held during a 50k import parks up to 30 minutes of its events. That is 10–25k rows, JSON-parsed, re-checked and rewritten every 3 s.
- The structural check also re-runs over all parked entries for each portal.

**Fix:**
- Diff-based writes: insert only new rows, delete only released ones.
- When a portal is parked, probe its label lookup **once** before re-checking all its parked rows.
- Cap parked rows per portal; above the cap, keep only the journal offsets and re-read them later.

**Status: open.**

### M4. Uninstall while stamps are queued, and token races between the two processes. **Medium**
- **Uninstall:** `purgePortal` deletes the portal's `stamp_queue` rows, but only when the `APP_UNINSTALL` file is read. A drain that already picked rows will send them, and they fail and are handled. That's harmless.
- **Uninstall seen by the other process:** each process keeps access tokens in memory for up to 25 minutes. If an uninstall were handled by the API server instead of the worker, the worker would keep a revoked token until the first 401. That's acceptable.
- **Refresh-token rotation:**
  - The worker and API server each have their own `PortalTokenProvider` cache.
  - If HubSpot ever rotates refresh tokens (the code handles it), two processes refreshing at once with the same old refresh token could invalidate one of them. HubSpot doesn't rotate today. Note it as a risk.
  - The store update uses `WHERE uninstalled_at IS NULL` and isn't compare-and-set.
  - **Fix:** `UPDATE … WHERE portal_id=? AND refresh_token_enc=?old`, and re-read on 0 rows changed.
- **Two processes writing:** a deferred `BEGIN` that reads first and later writes can get `SQLITE_BUSY` **without** waiting for `busy_timeout`. **Fix:** `BEGIN IMMEDIATE` for every write transaction.

**Status: partly fixed.**
- Every write transaction now uses `BEGIN IMMEDIATE`.
- A revoked refresh token (`invalid_grant` / `BAD_REFRESH_TOKEN`) pauses the portal instead of dropping stamps (see the system design review, section 3).
- The compare-and-set refresh-token update is **open**. Only the key-rotation tool uses compare-and-set today.

### M5. No guard against two workers. **Medium**
There was no lock in code. It relied on the host allowing one worker and on people remembering not to run a local worker against the same app.

- Two workers reading the same app journal would both stamp. That's mostly benign, because the same change ID gives the same value, so there is no extra enrollment. But two workers on **different** database files would double the label-option syncs and the provisioning.

**Fix:**
- A lease row, taken with `BEGIN IMMEDIATE`, renewed every loop, and refused if another holder renewed recently.
- A cross-database guard (for example a local worker against production HubSpot) needs an external lock.

**Status: fixed for one database file.** The worker takes a `worker_lock` row with a heartbeat and refuses to start if another worker heartbeated within 30 s (`WORKER_LOCK_STALE_MS`). If it loses the lock, it stops. The cross-database guard is **open**.

### M6. Other unbounded growth and missing metrics. **Medium / low**

| Item | Status |
|---|---|
| `worker_state` `journal_fail:<offset>` keys are never deleted if the failed offset later succeeds (deleted only when skipped). | Open |
| The API server's OAuth `states` map was pruned only when a new state was created. | Fixed. State is now HMAC-signed, and the used-nonce map is capped at 10k. |
| `change_log` is kept 30 days only for the "Get association change" workflow action, which is deferred. At 500k rows/day that is about 15M rows and 5–7 GB. **Fix:** 7-day retention until the action ships. | Open (still 30 days) |
| The per-stamp `info` log line means 500k+ lines/day. Make it debug-level or sampled. | Open (still `info`) |
| No **journal lag** or per-portal queue depth. Add both and alert on lag > 10 min. | Fixed. `journal_lag_seconds`, `journal_offset_age_seconds` and stamp-queue depth are exported. |
| `listSubscriptions()` has no paging and returns every subscription of the app. At 500 portals × 1–3 subscriptions, that is 1,500 rows per provision or settings save. Confirm whether the API caps or pages this list. | Open |
| The journal app token is never cleared on 401 (`clearAppToken` exists but is unused). If it is revoked early, there is up to 25 minutes of failed runs. | Open |

### M7. A deleted association label can park a portal for 30 minutes. **Medium (unconfirmed)**
`service/src/worker/label-guard.ts`. A REMOVED event whose `typeId` is no longer in the definitions (the label was deleted, and HubSpot removes it from records) holds that portal until the maximum hold (30 min). After that, the stamp says `(unknown)`. During those 30 minutes all of that portal's entries are parked (M3).

**Fix:**
- Keep deleted definitions: soft-delete in `label_cache` instead of `DELETE` + re-insert, so old type IDs still resolve to their last known name.
- Test what HubSpot emits when a label is deleted.

**Status: open.** `replaceLabels` still deletes and re-inserts. A 30-day TTL on `label_cache` was added for privacy, which does not change this.

---

## 2. SQLite, production-grade (decision: SQLite stays)

The design fits SQLite well: one writer-heavy process (the worker) plus a light second writer (the API server) on one host and one volume. What was missing was the settings and the habits that keep it fast as tables grow.

### S1. Connection pragmas (both `Store` and `PortalStore`, in this order)
```sql
PRAGMA busy_timeout = 5000;        -- first (the WAL switch needs a lock)
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;       -- In WAL this is crash-safe for the DB (a power loss can drop the last
                                   -- commit, which the journal re-read covers). It removes the fsync on every
                                   -- commit, which was the main cost of the many small writes.
PRAGMA wal_autocheckpoint = 1000;  -- default 1000 pages; set it explicitly
PRAGMA foreign_keys = ON;          -- no FKs today; turn it on now so future ones are enforced
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -65536;        -- 64 MB page cache for the worker; the API server can stay at the default
PRAGMA journal_size_limit = 67108864; -- cap the WAL file at 64 MB after checkpoints
```

**Status: fixed.** Both connections share one setup function in `service/src/store/db.ts`. It also sets `auto_vacuum = INCREMENTAL` on new files.

### S2. Transactions
- **One transaction per journal batch for the bookkeeping** (`markSeen`, pending, parked, label state, metrics, offset). This was already done in the poller.
- The writes **before** it were still autocommits. Wrap them, or batch them in memory and write them in the final transaction.
- **Drain:** do all defers, deletes and last-stamp updates for one drain in **one** transaction, not one per row.
- Use `BEGIN IMMEDIATE` for every write transaction (M4), so `busy_timeout` always applies.
- Keep transactions short. Never `await` HubSpot inside one.

**Status: mostly fixed.** `BEGIN IMMEDIATE` everywhere; `markSeen` and drain defers are batched in one transaction. `clearLabelHold` is still a lone autocommit (M1).

### S3. Prepared-statement reuse
`Store` prepared SQL on every call. Add a small `stmt(sql)` cache (a `Map<string, StatementSync>`) and use it everywhere.

**Status: fixed** in both `Store` and `PortalStore`.

### S4. Indexes to add
| Table | Index | Why |
|---|---|---|
| `stamp_last` | `(stamped_at)` | prune (H5) |
| `association_labels` | `(updated_at)`, plus a portal-scoped purge | prune (H5), purge on uninstall |
| `stamp_queue` | `(portal_id, not_before)` | per-portal fair drain (H3), purge |
| `stamp_queue` | `(record_key, occurred_at_ms, created_at)` replacing `(record_key)` | `firstQueuedFor` sorts per record |
| `parked_entries` | `(portal_id)` | purge, per-portal unpark |
| `label_holds` | portal-scoped purge | purge without `LIKE` |

Existing indexes that were fine: `seen_events(seen_at)`, `change_log(created_at)`, `stamp_queue(not_before, occurred_at_ms)`. The unused `change_log(portal_id, object_type_id, object_id)` index could be dropped until the workflow action ships.

**Status: fixed.** All the indexes above exist. The unused `change_log` index was replaced by `(portal_id, occurred_at)`. Portal-scoped purges use primary-key ranges on the string keys instead of new `portal_id` columns. A store test checks the hot queries with `EXPLAIN QUERY PLAN`.

### S5. Pruning and VACUUM
- Prune on a timer (every 10 min), not every run, in chunks of about 5k rows per statement, outside the offset transaction.
- Retention: `seen_events` 4 days (or replace it with offset dedupe, M2); `change_log` **7 days** until the workflow action ships; `association_labels` 90 days (it's what gives "labels before"); `stamp_last` 1 day.
- `PRAGMA auto_vacuum = INCREMENTAL` can only be set before the first table exists (or via a one-time `VACUUM`). Set it in the schema bootstrap, then run `PRAGMA incremental_vacuum(2000)` after each prune pass. Avoid full `VACUUM` in production. It rewrites the whole file and needs 2× the disk.
- **Volume size:** estimate with the M2 and M6 fixes: about 1–2 GB at 500 portals. Without them: 8–10 GB. Size the volume to 3× the expected DB size for WAL and backups, so 10 GB with the fixes.

**Status: mostly fixed.** Timer pruning, chunking and `incremental_vacuum` are in place. `change_log` is still 30 days (M6). Uninstalled portal rows are now also deleted after 30 days. Volume sizing is a hosting decision.

### S6. Two processes, one file
- This is the right pattern on one host. Keep both processes on the same volume.
- Rules:
  - Short write transactions.
  - `BEGIN IMMEDIATE`.
  - `busy_timeout` ≥ 5 s.
  - The worker is the main writer.
  - API-server writes are rare: install, settings, refresh-token update.
- Never open the DB over a network filesystem.

**Status: followed.** Schema changes now go through versioned migrations (`schema_migrations`), each in its own `BEGIN IMMEDIATE` transaction, so two processes starting together can't both apply a step.

### S7. Backups
- Stream the SQLite WAL continuously to off-host object storage (a WAL replication tool), with about 72 h of WAL and daily snapshots for 14 days.
- Run one restore drill before launch.
- Refresh tokens are AES-GCM encrypted at rest (`service/src/install/crypto.ts`), so a backup is safe only while the encryption keys are stored separately from it.
- If a replicator owns checkpoints, don't also run manual `wal_checkpoint(TRUNCATE)`. The code only uses passive auto-checkpoints, which are safe with a replicator.

**Status: deferred with hosting.** Hosting is out of scope for now. The code side is ready (passive checkpoints only).

### When to revisit (Postgres or similar)
- More than one machine needs to write, for example the API server on its own scaled service, or a hot-standby worker.
- HA failover with an RPO near 0 (continuous WAL backup gives about 1 s RPO and a restore of minutes).
- Heavy dashboards or analytics reading the DB while the worker writes.
- DB above about 50 GB, or sustained above about 1,000 writes/s after the fixes above.

None of these apply at 500 portals now that C1–C3 are fixed and once M2 is.

---

## 3. Cost estimate

**Journal API (app-level, limit 100 req/s):**
- At 3 s polling (the default): 28,800 `batch/next` calls/day ≈ 0.33 req/s, or 0.3% of the limit. Free.
- Catch-up runs back-to-back: one `batch/next` per 100 files. At 1M files/day that is about 10k calls/day.
- S3 downloads: one per file. They're not HubSpot API calls, but they set the throughput (C3).

**HubSpot calls per change (customer limit 110 per 10 s per portal):**

| Step | Calls | Notes |
|---|---|---|
| Label lookup | ≈ 0 | Cached 24 h per (portal, from, to). About 1 call/day per watched pair-direction, plus at most 1 refetch per minute for an unknown type. |
| Label option sync | 3–8 per **new label** | Schemas (custom only) + 2 per other type + list properties + ≤3 PATCHes. Once per new label per pair. |
| Token refresh | ≈ 1 per 25 min per active portal | About 500 × 58 ≈ 29k/day app-wide. Fine. |
| Stamp | **1 per change** at typical volume | A portal making 1,000/day rarely has 2 records due in the same drain. That is 1,000 batch calls/day per portal, or about 0.01 req/s. |
| Stamp, bulk import | **0.01 per change** (100 per call) if the records are distinct | 50k changes ≈ 500 calls ≈ 1 per 7 s. A **hot record** without coalescing costs 1 call per change (H4). |
| Mirror (`STAMP_MIRROR=1`) | ×2 | |

**Totals:**
- About 500k customer-token calls/day app-wide at normal load (about 1 per change).
- Per portal, about 1,000/day, which is about 0.1% of what 110 per 10 s allows.
- With H4 coalescing, bulk imports drop to about 1 call per 100 changes.

---

## 4. Prioritised fix list (top 10)

| # | Fix | Severity | Effort | Status |
|---|---|---|---|---|
| 1 | **C1:** per-update slots in `StampQueue.enqueue`; no wave barrier for the persisted queue | Critical | S | Fixed |
| 2 | **C2:** lifecycle hook never throws into `runOnce`; a `lifecycle_retry` table | Critical | M | Fixed |
| 3 | **C3:** parallel journal file downloads, keep the order; add file and event metrics | Critical | S | Fixed |
| 4 | **H2:** `AbortSignal.timeout` on every `fetch` | High | XS | Fixed |
| 5 | **H1:** per-portal token-bucket limiter (100 per 10 s); 429 becomes defer-with-`Retry-After` for customer calls | High | M | Fixed |
| 6 | **H3:** fair per-portal drain, parallel across portals; don't drain inside `sendStamps` | High | M | Fixed |
| 7 | **H5 + S4:** missing indexes, timer-based chunked pruning, index-friendly purge | High | S | Mostly fixed |
| 8 | **S1 + S2 + S3 + M1:** `synchronous=NORMAL`, `BEGIN IMMEDIATE`, one transaction per drain, statement cache, fewer label-guard writes | Medium | S | Mostly fixed |
| 9 | **H4:** burst coalescing per record | High (product) | M | Fixed (global setting) |
| 10 | **M2 + M6 + S7:** offset-based dedupe; `change_log` to 7 days; journal-lag metric + alert; backups; bigger volume | Medium | M | Lag metric fixed; rest open or deferred with hosting |

Next after the top 10: M3 (diff-based pending/parked), M4 (compare-and-set refresh-token update), M7 (soft-deleted label definitions), and the open M6 items.

---

## 5. End-to-end latency budget (occurredAt → record stamped)

Assumes the fixes above, the pairing defaults (`windowMs` 2 s, `orderingSlackMs` 2 s, `publishDelaySlackMs` 4 s) and 3 s polling.

| Step | Typical | Worst normal | Notes |
|---|---|---|---|
| HubSpot publishes the journal file | 1–4 s | 4 s+ | Measured in testing |
| Wait for the next poll | 0–3 s (avg 1.5) | 3 s | `JOURNAL_POLL_MS` |
| `batch/next` + download | 0.3–0.6 s | 1–2 s | With parallel downloads (C3) |
| Pairing hold | 0–2 s | ≈ 6 s after occurredAt | At 500 portals the stream watermark closes clusters about 4 s after occurredAt. When quiet, the deadline is occurredAt + 2 + 4 s, and the worker wakes on `nextReleaseAt`. This mostly overlaps the publish delay. |
| Label resolve | < 10 ms | 3–8 s once | Cached; a new label triggers an option sync |
| Enqueue + drain + token | < 50 ms | 0.5 s | Token refresh about once per 25 min |
| CRM batch update | 0.3–0.8 s | 2 s | |
| Per-record spacing | 0 | +3 s × (n−1) | Only for the n-th change on the same record |
| **Total** | **≈ 5–8 s (p50)** | **≈ 10–12 s (p95)** | Meets the "under ~10 s for most changes" target |

**Under load, before the fixes:**
- A 50k import added hours of journal backlog for **every** portal (C3), plus C1's portal-wide queueing.
- A hung request added up to about 5 minutes (H2).
- A 429 storm added up to about 2 minutes for everyone (H1).

**With the fixes:**
- An import delays only its own portal's hot records.
- Other portals stay within the p95 above.
- Catch-up runs at about 100+ files/s, limited by downloads and pairing CPU, not by HubSpot limits.
