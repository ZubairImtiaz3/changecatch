# Architecture

ChangeCatch detects association changes in HubSpot accounts and writes each change onto the affected record as properties. Customer workflows trigger on those properties.

The service has two processes that share one SQLite database (`data/changecatch.db`):

- **API server** (`service/src/api/`): OAuth install, the settings API used by the in-HubSpot settings page, and the lifecycle-subscription self-heal.
- **Worker** (`service/src/worker/`): one always-on process for all installed accounts. It reads the Webhooks Journal, turns raw events into changes, and stamps them onto records.

All HubSpot APIs used are date-versioned (`2026-09`). App-level calls (journal, subscriptions) use a client-credentials token. Per-account CRM calls use that account's OAuth token. The two are kept separate in code.

---

## 1. Overview

```
 HubSpot (app level, client-credentials token)                 HubSpot (per account, OAuth token)
 ┌──────────────────────────────────────────┐                 ┌──────────────────────────────────────────┐
 │ Webhooks Journal: one ordered stream for │                 │ CRM batch update   (110 req / 10 s / acct)│
 │ ALL accounts, ~3 days retention          │                 │ Association labels, Properties, Schemas   │
 └────────────────────┬─────────────────────┘                 └────────────────────▲─────────────────────┘
                      │ batch read (≤100 files)                                    │
 ┌────────────────────▼──────────────────────────── worker (single instance) ──────┼─────────────────────┐
 │  1 read + download files (parallel, order kept)                                 │                     │
 │  2 lifecycle events  ──► install / uninstall handling (retried, never blocks)   │                     │
 │  3 dedupe (seen_events)                                                         │                     │
 │  4 watched-pair filter (portal_settings)                                        │                     │
 │  5 pairing: REMOVED+ADDED → LABEL_CHANGED, split-hold, late-half absorption     │                     │
 │  6 label resolution (label_cache; account parked if lookup fails)               │                     │
 │  7 change_log  (one row per change, deterministic change ID)                    │                     │
 │  8 stamp_queue (spacing, coalescing) ──► fair drain, batches of 100 ────────────┘                     │
 │  one transaction: offset + queued stamps + seen keys + pending + parked + label state + metrics      │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ┌─────────────────────────── API server ───────────────────────────┐
 │ /install, /oauth/callback, /api/settings (signed), /health        │──► portals, portal_settings,
 │ creates properties + journal subscriptions per account            │    journal subscriptions
 └───────────────────────────────────────────────────────────────────┘
                                                   Customer workflow: "ChangeCatch: last change ID"
                                                   has changed (re-enrollment ON) + filters
```

---

## 2. The pipeline

The pipeline is one function (`runOnce`) called in a loop. Each run processes one journal batch end to end and commits the result in a single transaction.

### 2.1 Journal read

- Reads `batch/next` from the stored offset (up to 100 files, HubSpot's maximum), then downloads the files in parallel (`JOURNAL_DOWNLOAD_CONCURRENCY`, 16). Processing order is always the offset order.
- Polls every `JOURNAL_POLL_MS` (3 s). A full batch re-reads at once. Failures back off exponentially (5 s → 120 s), separately from normal polling.
- The loop sleeps until the earliest of: the next poll, the next pairing-hold deadline, and the next due stamp.
- A file that keeps failing (HTTP 207) is skipped after `JOURNAL_SKIP_FAILED_AFTER_MS` (30 min) and counted as data loss.
- An expired offset (404) restarts from `earliest`, records a gap, and raises an alert.

### 2.2 Dedupe

Every journal event has an identity key stored in `seen_events` (kept 4 days, longer than the journal's ~3-day retention). A re-read after a crash produces no new work.

### 2.3 Watched-pair filter

Events are dropped unless the account watches that object pair (`portal_settings`). The check is direction-insensitive. Each pair is subscribed on one side only (custom objects first, then deal, ticket, company, contact), because the journal reports an association only from the subscribed side.

### 2.4 Pairing

HubSpot records a label edit as `ASSOCIATION_REMOVED` (old type ID) plus `ASSOCIATION_ADDED` (new type ID) on the same two records. Unlabeled (`HUBSPOT_DEFINED`) and labeled (`USER_DEFINED`) rows of one action arrive as separate events.

- **Clustering.** Events for the same record pair within `PAIRING_WINDOW_MS` (2 s; measured gaps were 33 ms in the UI, 108 ms via the API) form one action. The cluster becomes `ADDED`, `REMOVED`, or `LABEL_CHANGED`.
- **Release.** A cluster is released at `newest occurredAt + PAIRING_WINDOW_MS + publish slack (4 s)` (wall clock), capped by the max hold (60 s; both in `DEFAULT_PAIRING_CONFIG`). Pending clusters survive restarts (`pending_pairs`).
- **Split hold.** Under load HubSpot spreads one action over several journal files, seconds apart. A cluster that may be only half of an action (only the unlabeled part, or only labels) is held until `PAIRING_SPLIT_HOLD_MS` (4 s) after its file's publish time. Whole clusters are not delayed.
- **Late-half absorption.** No fixed hold survives every load, so every emitted action is remembered for 10 minutes (`emitted_actions`, keyed by record pair + `occurredAt`). A cluster that matches is treated as the late half of that action:

| Emitted | Late half | Result |
|---|---|---|
| `REMOVED` | label removed, or duplicate unlink | **Absorb**: no new change, no stamp |
| `ADDED` | label added | **Amend**: correct the labels on the existing change |
| `ADDED` | duplicate link | **Absorb** |
| `LABEL_CHANGED` | structural add/remove | **Convert** to `ADDED`/`REMOVED` (see §6) |
| `LABEL_CHANGED` | the other half of a label swap | **Amend** to one "old → new" change |

An amend corrects `change_log` and the queued stamp. If the record already shows the change, a small amend stamp writes only the label properties (never the trigger property, so no extra enrollment).

### 2.5 Label resolution

- `associationTypeId` → label name, cached per account and object pair (`label_cache`). An unknown type ID triggers a refresh from the associations labels endpoint.
- The three label properties are multiple-checkbox properties. When a new label appears, its options are synced onto the properties before the stamp is written, so every stamped value is a valid option. Values look like `0-1:279` (the other object type + the label's association type id; displayed as "Decision maker (Contact)"), plus `none` and `unknown` (displayed as "(none)" / "(unknown)"). A label renamed in HubSpot keeps its value; only the display text is updated (D7).
- `association_labels` keeps the last known label set per record pair (pruned after 90 days unchanged), which gives "labels before" and "current labels".
- If an account's label lookup keeps failing, that account's entries are **parked** (`parked_entries`, capped at 20 000 per account) and retried each run. The shared offset moves on for every other account. After 30 min (`LABEL_MAX_HOLD_MS`) the change is stamped with `unknown`.

### 2.6 change_log

Every change gets a deterministic change ID (hash of account, source event keys, and target record) and one `change_log` row, written before the record is stamped. The same change ID is the value of `changecatch_last_change_id`, the key of the stamp queue, and the dedupe key for sends. `change_log` is kept 30 days.

### 2.7 Stamp queue and drain

`stamp_queue` is a persisted outbox in the same database, so a crash never loses a stamp.

- **Target record.** The properties go on the subscribed side of the pair (Deal ↔ Contact → the Deal; Company ↔ Contact → the Company; custom pairs → the custom object). `STAMP_MIRROR=1` also stamps the other side.
- **Per-record spacing.** Two stamps on the same record are at least the account's spacing apart (settings page, default 3 s, range 1–600 s), so each change produces its own workflow enrollment. Every record has its own timeline; one busy record never delays others.
- **Coalescing.** Always on (`COALESCE_THRESHOLD`): when a record has more than 3 changes pending, only the next due change and the latest change are stamped. Every change stays in `change_log`, but intermediate changes never appear on the record, so a workflow filtered on a specific label, record or change type can miss one in the middle of a burst. Load test: 650 changes on one record → 6 stamps.
- **Fair drain.** Each drain cycle gives every account with due rows one turn, in rotating round-robin order, with at most 100 records per account per cycle. Accounts are sent in parallel (`STAMP_PORTAL_CONCURRENCY`, 8).
- **Batching.** Records are grouped per account and object type into CRM batch updates of up to 100 (`POST /crm/objects/2026-09/{objectType}/batch/update`).
- **Results.** Success → row deleted, `stamp_last` updated. 5xx/network → backoff for up to 24 h (`STAMP_RETRY_MAX_MS`), then dead-lettered. 429 → every row of that account due before `Retry-After` is deferred (one UPDATE), so the loop sleeps until then; other accounts are not affected. Per-record errors inside a 2xx batch response are classified per record (429/5xx/rate-limit category → retry, other 4xx → dead letter); a record named in neither `results` nor `errors` is retried. Permanent 4xx → dead-lettered at once (`stamp_dead_letter`; nothing is silently dropped). Exception: a `VALIDATION_ERROR` / `INVALID_OPTION` refusal on one of our dropdowns means the options are out of date: that object type's `labels_synced` markers are cleared, its options re-synced, and the record takes the retry path. Revoked token → the account is paused (§4).

Stamp failures never hold the shared journal offset.

---

## 3. Concurrency and rate limits

### Single-worker lock

The journal offset is one value for the whole app, so exactly one worker may run. The `worker_lock` row holds the worker ID, PID, host, and a heartbeat. A second worker refuses to start while the heartbeat is newer than `WORKER_LOCK_STALE_MS` (30 s). Within the worker, enqueue and drain run sequentially.

### Per-account rate limiter

Every HubSpot call goes through a shared limiter (`service/src/lib/rate-limiter.ts`):

| Bucket | HubSpot limit | ChangeCatch default |
|---|---|---|
| Each installed account (OAuth token) | 110 req / 10 s | 100 req / 10 s (`HS_PORTAL_RATE_PER_10S`) |
| Journal reads | 100 req / s per app | 80 req / s |
| Subscription management | 50 req / s per app | 40 req / s |

- It is a sliding window, not a token bucket, so it can never exceed the limit inside any 10-second window.
- Each bucket has its own queue and timer. A throttled account never delays another account.
- A portal call that would wait longer than `HS_PORTAL_MAX_WAIT_MS` is deferred instead of blocking the loop.
- Every request has a timeout (`HTTP_TIMEOUT_MS`, 20 s).
- The limiter is in-process. The API server makes very few account calls, which the 10% headroom covers. Running more than one worker would require a shared limiter.

Measured: about 0.01–0.02 API calls per change, peak 15 requests per 10 s for one account.

---

## 4. Lifecycle

### Install

1. `/install` redirects to HubSpot's authorize URL with a signed `state`.
2. `/oauth/callback` exchanges the code, saves the encrypted refresh token and granted scopes, and primes the access-token cache.
3. **Provisioning:** pairs = stored pairs or the defaults (Deal ↔ Contact, Deal ↔ Company, Company ↔ Contact) → create the "ChangeCatch" property group and 7 properties on every object type in those pairs → reconcile journal subscriptions (one per account and subscribed object type, upsert first, then delete stale ones).
4. If provisioning fails, the token is kept and `last_provision_error` is shown on the settings page. Saving settings retries.

**Custom objects.** Custom-object write scopes are conditionally required (§7, D3). When the callback sees custom read granted but custom write missing (an Enterprise account), it redirects straight to a second consent screen that includes the write scopes. A loop guard in `state` prevents repeats. App-governance errors show a page with the super-admin approval steps.

### Settings

The settings page calls `GET/POST /api/settings` with HubSpot's v3 request signature, checked against `PUBLIC_BASE_URL`. The account ID comes only from the signed URL. A save validates input, creates properties on newly watched objects, reconciles subscriptions, and stores pairs and spacing last, so a failed save changes nothing the worker reads.

### Uninstall

The worker handles the journal `APP_LIFECYCLE_EVENT` uninstall event:

1. Delete the account's journal subscriptions.
2. Mark the account uninstalled, wipe the refresh token and watched pairs.
3. Purge every per-account row: settings, label caches, holds, `association_labels`, metrics, `stamp_queue`, `stamp_last`, parked entries, pending pairs, and `change_log`.
4. Keep only the `portals` row without a token (to recognise a late or repeated uninstall), deleted 30 days later.

An uninstall older than the latest install is ignored. Properties stay in the customer's account.

The two lifecycle subscriptions (install, uninstall) are checked at API-server start and every 10 min (`LIFECYCLE_SUB_CHECK_MS`), and recreated if missing.

A failed HubSpot cleanup is stored in `lifecycle_retry` and retried with backoff; local data is purged at once. It never holds the shared offset. A revoked token that is not fixed within 7 days runs the same uninstall routine.

Provisioning (properties + subscriptions) is done only by the API server: in the OAuth callback, on settings save, and by a sweep at start and every 10 min that re-provisions installed accounts whose provisioning never finished or failed. The worker's install-event handling only lifts a stamping pause.

### Token revocation

A refresh rejected with `BAD_REFRESH_TOKEN`, or a 401, **pauses** the account (`portal_pause`): its queue is kept and probed hourly. A successful probe (for example after a reinstall) resumes it. After 7 days (`PAUSE_MAX_MS`) the uninstall purge runs.

### Token storage

Refresh tokens are encrypted with AES-256-GCM. The account ID is bound in as additional authenticated data, so a token copied to another account's row cannot be decrypted. Keys support rotation (`TOKEN_ENC_KEYS`, first key active). Access tokens live only in memory and are refreshed 5 minutes before expiry; tokens are never logged.

---

## 5. Data model

One SQLite file in WAL mode, shared by both processes (`busy_timeout` set before switching to WAL). Every table is created by ONE versioned, append-only migration list (`service/src/store/schema.ts`, recorded in `schema_migrations`), whichever process opens the file first. `PORTAL_TABLES` there lists every per-account table; uninstall deletes all of them (`Store.purgePortal`). Queries live with one owner per feature (`store/journal-state.ts`, `change-log.ts`, `stamps.ts`, `labels.ts`, `emitted.ts`, `entries.ts`, `metrics.ts`, `portals.ts`, `worker.ts`; pauses next to the stamp queue in `stamps.ts`, lifecycle retries + the worker lock in `worker.ts`), all on one connection so a batch commits atomically; core declares the narrow ports it uses (`PollerStore`, `AbsorbStore`, `EmittedActionStore`, `LabelStateReader`). The worker's Store runs the one maintenance timer for the file (retention prunes, uninstalled-portal prune, optimize).

| Table | Purpose | Retention |
|---|---|---|
| `portals` | One row per account: encrypted refresh token, granted scopes, install/uninstall/provision times, last provision error, stamp spacing | Token wiped on uninstall; row deleted 30 days later |
| `portal_settings` | Watched pairs per account (subscribed side first) | Until changed or uninstalled |
| `journal_offset` | The single app-level journal offset | Always |
| `worker_state` | Small app-level key/value state (typed keys in `store/journal-state.ts`: read time, errors, offset check, journal failure) | Always |
| `labels_synced` | Association type IDs whose dropdown options were synced, per account, scope and object pair | Until uninstalled |
| `worker_lock` | Single-worker lock and heartbeat | Always (one row) |
| `seen_events` | Dedupe keys for journal events and sent stamps | 4 days |
| `pending_pairs` | Clusters waiting for pairing release or a split half | Until released |
| `emitted_actions` | Recently emitted actions for late-half absorption | 10 min |
| `label_cache`, `label_cache_fetches` | Association type ID → label, per account and pair | Refreshed on unknown IDs |
| `label_holds` | Label lookups that keep failing, and since when | Until resolved |
| `parked_entries` | Journal entries of an account whose label lookup is held | Until resolved or 30 min |
| `association_labels` | Last known label set per record pair | 90 days unchanged |
| `change_log` | Every change (type, other record, labels before/after/current, category, time, `superseded_by`) | 30 days |
| `stamp_queue` | Outbox of stamps waiting for their slot or a retry | Until sent or dead-lettered |
| `stamp_last` | Last stamp time and change ID per record | 1 day |
| `stamp_dead_letter` | Stamps that failed for good, with the error | Until reviewed |
| `lifecycle_retry` | Install/uninstall events waiting for a retry | Until done |
| `portal_pause` | Accounts paused for a revoked token | Until resumed or purged |
| `token_revocations` | When an account's token was rejected | Until resumed or purged |
| `metrics` | Last error per account (counts are in-memory metrics) | Until uninstalled |

No personal data is stored: only record IDs, object types, label names, and timestamps.

---

## 6. Delivery semantics

**At-least-once, with idempotent effects.**

- The offset, queued stamps, seen keys, pending clusters, parked entries, label state, and metrics commit in one transaction per batch.
- A crash before the commit re-reads the same files and leaves nothing queued from that run, so the re-run decides (and pairs) once.
- A crash after HubSpot accepted a stamp but before the queue row was deleted re-sends the identical values (same change ID), which is not a property change.
- The outbox is persisted, so the drain continues after a restart. A worker outage shorter than the journal retention (~3 days) loses nothing; it only adds latency.

**Ordering.** Per record, stamps are sent in `occurredAt` order with spacing. There is no ordering across records; workflows are per record.

**Never miss a trigger.** A missed "linked" or "unlinked" trigger is worse than a rare extra one:

- When a late half converts a `LABEL_CHANGED` that was not stamped yet, it is corrected in place (same change ID).
- When that `LABEL_CHANGED` was **already stamped** (a workflow may have run on it), the correct `ADDED`/`REMOVED` is emitted as a new change with its own ID and stamp. The old `change_log` row keeps its values and gets `superseded_by` = the new change ID.
- Coalescing never drops the earliest pending change or the latest one, so the record always ends on its newest state.

**Explicit loss paths** (each counted in the `data_loss` metric and alerted): a dead-lettered stamp, a journal file skipped after a lasting 207, a stamp HubSpot rejected for good, and a journal gap after an expired offset.

**Known limit for customers.** Enrollment criteria see the right values for each change. Workflow steps that run later (especially after a delay) read the record's current values, which a newer change may have overwritten. Setup docs tell admins to keep ChangeCatch conditions in enrollment criteria.

---

## 7. Key decisions

### D1. Detection: the Webhooks Journal

The journal is one app-level, ordered, replayable stream with a `portalId` on each event, so one reader serves every account. Cost scales with the number of changes, not records, and journal limits are separate from customers' API limits. Tests confirmed it reports custom-object associations and label edits made in the UI and via the API. Classic push webhooks cover neither. Rejected: scheduled scans (cost at scale) and rollup-count "doorbell" properties (more setup and API calls).

### D2. Delivery: property stamping, not app events

HubSpot app events would be the ideal trigger, but they require partner approval, one event type cannot cover both standard and custom objects, and event types are locked after creation. Stamping properties and triggering on "Property value changed" works on standard and custom objects, re-enrolls on every change (the trigger value is new each time), and supports typed filters. App events stay a later upgrade: a new sink behind the stamp queue, not a config switch (decisions.md D2).

### D3. Custom-object scopes: conditional, plus app governance

Pro accounts must be able to install, and Enterprise accounts must get custom objects without a manual step.

- **Required:** `oauth`, contacts/companies/deals read and write, `crm.schemas.{contacts,companies,deals}.write`.
- **Optional:** `crm.objects.custom.read`, `crm.schemas.custom.read`.
- **Conditionally required:** `crm.objects.custom.write`, `crm.schemas.custom.write`.

HubSpot did not grant optional custom write scopes in testing, so the callback chains a second consent screen when custom read is granted (§4). Accounts with app governance need a super admin to approve the custom permissions once; the app shows the steps.

### D4. No custom workflow action in v1

A "Get association change" action would protect later workflow steps from newer changes, but it duplicates what enrollment criteria already do with the stamped properties, needs an always-on public endpoint called on every enrollment, and adds a second way to build the same workflow. v1 ships properties only, with per-record spacing and setup guidance.

### D5. Seven properties

All in the "ChangeCatch" property group on each watched object type:

| Property | Type | Meaning |
|---|---|---|
| `changecatch_last_change_id` | text | New on every change. **The workflow trigger.** |
| `changecatch_change_type` | dropdown | `ADDED`, `REMOVED`, `LABEL_CHANGED` (shown as Added, Removed, Label changed) |
| `changecatch_other_object_type` | dropdown | Object type id on the other side (`0-1`, `2-…`), shown by name |
| `changecatch_other_record_id` | text | ID of the other record |
| `changecatch_labels_before` | multiple checkboxes | Labels before the change |
| `changecatch_labels_after` | multiple checkboxes | Labels after the change |
| `changecatch_labels_current` | multiple checkboxes | All labels on that association now |

A change timestamp and a burst count were left out: HubSpot's property history already shows when the trigger changed, and the coalesced count lives in logs and metrics. The three label properties are multiple-checkbox properties (values `;`-joined) whose options are synced from the account's label definitions, because free-text equality fails with multiple labels and admins should pick labels, not type them.
