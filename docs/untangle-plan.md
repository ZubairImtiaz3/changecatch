# Untangle plan (step 3: redesign from first principles) — DRAFT for owner approval, 2026-11-07

Source: six surveys in docs/untangle-log.md (~450 problems). Each fix below removes several problems at once.
Fixed constraints: never miss a trigger; HubSpot-facing names/values frozen (D7); SQLite single file + single worker;
behaviour unchanged except listed bug fixes; 322-test suite + replay tests green at every merge.

## Owner decisions (2026-11-07)
- App events path: DELETE (v1.1 = new sink behind the stamp queue; update D2).
- Sentry: DROP (re-add properly with production hosting).
- Pre-launch legacy squash: YES (dev DB recreated once; owner reinstalls on test portal at the end).
- Provisioning: API server is the only owner.

## The fixes (each = one root cause)

F1  **One delivery path.** Delete app-events (emit.ts, sendOccurrences, DELIVERY_MODE, OCC_PREFIX, labelNames lookups),
    the in-memory Stamper + planStampWaves/Slots/Batches, formatLabels. Re-target poller.test + replay/pairing.real
    to the stamp path (today the main runOnce invariants test a path production never runs). [OWNER: D2 says app events
    are "a config change"; this makes v1.1 a new sink behind the queue instead.]
F2  **One config, read once.** lib/config.ts loadConfig(env): one parser (unset = default, junk = fail at start),
    frozen object passed down; nothing below main reads process.env; no import-time env reads; tools use the same
    loader. ~20 never-tuned knobs become named constants. configuration.md + .env.example checked by a test.
F3  **One owner per product fact.** core/contract.ts: the 7 properties (names, labels, options, value format) and one
    STANDARD_OBJECTS table (id, names, rank, scopes, supported). Scopes derive from APP_SCOPES. One isCustomObjectType.
    Snapshot test of every frozen name/value first. Fixes the Ticket inconsistency.
F4  **Settings contract owned by the server.** One settings module (validation + defaults + view); GET returns
    recommended pairs, spacing presets/default/limits and object names; the settings page drops its copies.
    Fixes bug: provision() silently drops saved custom pairs. [Needs a hubspot-app upload.]
F5  **One HubSpot transport.** lib/http.ts with typed errors (Throttled / Transient / Unauthorized / Refused /
    Revoked), one URL classifier for limiter + metrics, one back-off, one API version constant, journal S3 downloads
    through it, metrics inside it (API server calls get counted too). Deletes 3 "throttled" error types, the
    globalThis.fetch patch, error-text regexes.
F6  **One token module.** One TokenProvider (refresh, force-refresh, revoked/not-installed as typed errors), portalId
    passed explicitly; delete worker/tokens.ts, the global token→portal registry, the second token cache in oauth.ts,
    the `as unknown` cast; "revoked" stored once.
F7  **Typed stamp results.** Stamp sender returns kind ok/retry/throttled/auth/refused; the queue stops regex-matching
    reason text.
F8  **One schema list, one purge, typed keys.** All tables in one versioned migration list (worker-tables, portals,
    token_revocations included); each table declares its portal key → one generated purge; store/keys.ts for every
    "portal|…" key and seen-event prefix; typed worker_state; journal_fail leak fixed. Then split Store (580 lines,
    fan-in 30) by feature; core owns its types (no core↔store cycle).
F9  **One lifecycle owner.** The API server owns provisioning (startup/periodic sweep of unprovisioned portals); the
    worker only handles uninstall/pause. Deletes the install-grace timing guess, the outcome-string protocol, the
    duplicated kind(), the fake 'pause-expired' event. Pause expiry calls uninstall directly. [Small behaviour change:
    failed provisioning is retried by the API sweep instead of the worker.]
F10 **Structured logging + one metrics source.** One injected Logger with log.alert(); delete the [ALERT]/"portal N"
    text parsing (32 sites), legacy log adapters, console fallbacks. Counts live in the in-memory metrics only; /health
    reads them; delete latency.ts and duplicate percentile/queue-size metrics.
F11 **Freeze pairing + runOnce does one job.** Delete never-used pairing modes/flags; structuralNet required; delay,
    back-off and staleness move to the worker loop (counters in memory); duplicate prunes go.
F12 **Split server.ts** into oauth-flow / settings-api / router; delete the test-only v2 signature path,
    CUSTOM_WRITE_MODE=optional, ExitPending, duplicate checks.
F13 **Dead code (~600+ lines).** journal.ts old reader (contradicts the real one), auth knobs, limiter accessors,
    unused Store methods, pickStampProperties shim, Sentry backend (package not installed), "occurrences" naming,
    unused worker options (blockOnFailure, drainInline, heartbeat, isStopping…). [OWNER: keep or drop Sentry?]
F14 **Tools reuse the service.** Tools use Store queries (no raw SQL / copied key formats), the service limiter,
    percentile, labels API and token provider; delete properties-setup + labels-sync (the product already does
    both); load-test KPIs read the real /health shape (3 KPI rows never got data).
F15 **Pre-launch legacy squash.** v1 token format + TOKEN_ENC_KEY, pre-versioning migration paths, the free-text →
    checkbox property migration. [OWNER: requires recreating the dev DB once = one reinstall on the test portal.]
F16 **Tests + comments last.** One shared test harness built by the same factory as production (no drainInline
    default drift); helpers deduped (8 fake journals, 5 uuid7 builders, 6 label fixtures); remove tests of dead code,
    of internals, of constants; behaviour tests over raw SQL; injected clock instead of wall-clock asserts.
    Remove comments that restate code (~40-55% of comment lines); keep HubSpot facts, measured numbers, doc URLs.

Deferred (high risk, little gain now): replace seen_events prefixes with a delivery-status column.

## Execution (parallel, in isolated git worktrees, merged in waves; full test run after each merge)

Wave 1 (deletions, disjoint files):  F1 · F13 · F12(deletions only) · F14(tool slimming)
Wave 2 (foundations):                 F2 config · F3 contract · F8a schema/keys/purge · F5 transport
Wave 3 (built on wave 2):             F6 tokens · F7 stamp results · F9 lifecycle · F10 logging/metrics · F11 · F4 settings
Wave 4:                               F8b split Store · F12 split server · F15 squash
Wave 5:                               F16 tests + comments, then re-survey agents (step 5) until nothing worth fixing.
Final check: typecheck, all tests, replay tests, live e2e on the test portal, settings page upload + click-through.

## Carry-overs from finished workstreams (pick up in later waves)
- w2: drop ErrorReporter interface/`reporter` option once worker/observability.test.ts uses memoryLogger (F10/F16);
  initErrorReporting unused `env` param + Sentry comments in worker/main.ts:31,111,477 (F2/F10); getMetrics/getChange
  only used as test assertions (F16: replace with behaviour checks, then delete); move memoryLogger to test helpers
  (F16); add a query-plan check for the real drain query worker-tables dueForPortal (F8).
- Branch naming: agents use `untangle-<ws>` (git can't create `untangle/<ws>` next to `untangle`).
- w3: saved custom pairs are now kept when custom write is missing, but still count as "watched" → in-flight custom
  events could reach stamping and fail on scope. F4/F9: distinguish saved pairs from ACTIVE pairs (worker filter + settings
  page shows inactive custom pairs as such).
- w4: tools still use raw read-only SQL (Store/PortalStore constructors run migrations + timers). F8: add a read-only
  Store open (no migrations/timers) + methods for change_log by record (incl. superseded_by), stamp_queue count by record,
  stamp-handled marker lookup; then tools switch over (key formats stop being copied).
- w1: PortalMetrics.occurrencesSent + occurrences_sent column still shown per portal in /health (F10/F15);
  STANDARD_OBJECT_NAMES still in core/stamp.ts (F3); STAMP_MIRROR label-name lookup failure now fails the run (retried).
- Wave 1 merged 2026-11-07: 322 -> 303 tests (removed tests of deleted code; runOnce invariants + real replay now on
  the stamp path). setRateLimiter kept (tools use it to share one 80/10s bucket for the test portal).
- w5 (merged, 311 tests): hubspot/properties.ts now imports install/object-types.ts (listCustomObjectTypes) — wrong
  direction (hubspot → install), same as hubspot/oauth.ts → install/scopes. Later: move listCustomObjectTypes into
  hubspot/ (it's an HTTP call) and buildInstallUrl into install/ (it's install policy). F4 should take plural names from
  core/contract STANDARD_OBJECTS. Tickets (0-5) now have no fake schema scope; 0-5 stays a frozen option value.
- w8 (merged, 307 tests): pruning now only on the Store maintenance timer → F2 must make the maintenance interval a
  non-zero constant (DB_MAINTENANCE_INTERVAL_MS=0 would disable pruning; remove that knob). /health consecutiveErrors
  still from the consecutive_errors row while the Worker keeps an in-memory counter (F10/F8: read the Worker's, drop row).
  PRUNE_CHUNK_ROWS_IN_TX unused (F8). StampQueue default coalesce OFF vs prod latest (F2). worker/schedule.ts numEnv →
  F2 config.
- w7 (merged, 309 tests): app client-credentials token now requested from api.hubspot.com (documented host) — verify in
  the final live e2e. Left: F6 stale retryAfterMs comment in worker/tokens.ts + "token revoked" text check in stamp-queue;
  F7 stamp results kind; F10 API server must call setHttpMetrics(). journal_gap data-loss reason removed (offset_expired).
- w6 (merged, 314 tests): store/schema.ts one migration list (migrations 9-12; 12 widens the drain index); store/keys.ts;
  PORTAL_TABLES → one purgePortal + portalFootprint; typed worker_state keys; read-only Store for tools (no raw SQL in
  tools). Left: core/* re-exports of moved key names (remove when callers import store/keys — F8b/F16); labels_synced as
  its own table + a single maintenance timer (F8b); old `portals` rows in schema_migrations (F15).
- Wave 2 complete 2026-11-07 (untangle 42d33c4, 314/314).
- w9 (merged, 315): typed StampResult kinds; isRevoked hook (F6 replaces with typed revoked error; F6 must also make
  token-endpoint misconfig 4xx keep stamps instead of dead-lettering).
- w10 (merged): install/settings.ts owns the settings contract; saved vs ACTIVE pairs (worker uses activePairs);
  CHANGECATCH_DEFAULT_PAIRS removed; GET adds recommendedPairs/spacing/singular/plural/active (old fields kept until the
  page upload). PAGE NOT UPLOADED: needs owner OK; visible change = plural names "Deals ↔ Contacts" + grey "Needs
  custom-object access" under inactive saved custom pairs. Remove old GET fields (label, spacingLimits) after upload.
- w13 (merged): API server provisionPending sweep (startup + 10 min); worker/lifecycle.ts handleUninstall; one
  appLifecycleKind classifier.
- w12 (merged): hubspot/portal-tokens.ts one provider; TokenRefreshError (misconfig 4xx keeps stamps, retried);
  withPortalToken = only 401 refresh path; token→portal registry gone, portalId explicit. Left: portal_pause.since still
  duplicates "revoked" (needs schema change → F15); misconfig alert should use log.alert (F10); one extra SQL per token call.
- w15 (merged): server.ts → router + oauth-flow.ts / settings-api.ts / pages.ts / http-util.ts; shared test fixture
  install/test-app-server.ts. Left: isLocalhostUrl(undefined)===true special case + its test once config guarantees
  PUBLIC_BASE_URL (F2 follow-up); docs/observability.md:199 still names server.ts catch blocks (F10); logSafe in
  http-util.ts (F10 may replace).
- w11 (merged): lib/config.ts loadConfig = only env reader (test enforces); 20 service env vars left, rest constants;
  docs/.env.example drift test. Left: runbook incident levers (HS_PORTAL_RATE_PER_10S, STAMP_RETRY_MAX_MS) are now
  constants → ask owner; coalesce 'off' only used by tests (F16); lib/config imports install/crypto → move crypto to lib/
  (also store/portals → install/crypto); isLocalhostUrl(undefined) special case can go now (w15 note).
- w16 (merged): Store = facade of feature repositories over one Db connection; all stamp_queue queries in store/stamps.ts;
  core/keys.ts + core-owned types/ports (no core → store runtime imports); labels_synced table (migration 13).
  Left: getMetrics/listDeadLetters test-only (F16); facade still exposes db/conn (tests + revocations).
- w14 (merged): one injected Logger + log.alert (alert names in docs/observability.md); in-memory registry = only counter
  store; obs/alerts.ts (isStale, AlertThrottle); /health counters reset on restart.
- w17 (merged): one initial migration + old-DB guard; lib/crypto.ts, Keyring, no v1/TOKEN_ENC_KEY; no free-text property
  migration; coalesce 'off' removed. Left: portal_pause.since vs token_revocations overlap (pause also covers 401-after-
  refresh) — review in re-survey. OWNER STEPS: stop servers, delete service/data/changecatch.db(-wal,-shm), keep
  TOKEN_ENC_KEYS only, start, reinstall via /install, pick pairs again.
- All F1–F15 merged 2026-11-07. Next: F16 tests + comments (parallel by area), then step-5 re-survey loop.
- w22 (merged): install/hubspot/lib/store/obs tests reviewed, 17 mutation checks all caught. Left for re-survey:
  un-export test-only/internal exports (planSubscriptionChanges, applySubscriptionPlan, groupPairs, chunkStampUpdates,
  StatementCache, fingerprintOf, statusLabel, isGovernanceError, CUSTOM_READ_SCOPES).
- w21 (merged, 308): core/worker/replay tests reviewed, raw SQL → store methods, 8 mutation checks caught; deleted
  queuedAttempts/listDeadLetters (getMetrics/listDeadLetters carry-overs closed). Re-survey hints: poller dedupeEntries may
  be redundant (no test fails without it — verify, don't delete blindly: it may guard same-batch duplicates);
  StampQueueOptions.maxAttempts has no production caller; raw INSERT into token_revocations in a lifecycle test seed.
- F16 complete 2026-11-07. Next: step 5 re-survey loop with fresh agents.
- Fix round 1 merged so far: r1a (throttle spin bug fixed + test; per-record batch errors classified; recordDelivered
  shared with replay; worker tables → store/worker.ts), r1b (one mirror flag, one label cache, label-key helpers,
  store.emitted, core/journal-offset.ts), r1c (zero hubspot→install edges, PortalStore owns revocations/rotation,
  portalPairs, Installer syncs options when a custom pair starts being watched, uninstall race re-check, one Db open).
  Round-2 hint: label guard skips the announce on the cached-label fallback path — check it can't stamp a label whose
  option doesn't exist.
- r1d merged: one line per alert/error (Errors.message gone), configureHttp(config) in every entry point, JOURNAL_PATHS
  shared, metrics↔docs drift test, dead http/metrics/worker options removed, typed health httpErrors.
  Round-2 hints: lib/config.ts now imports worker/stamp-queue.ts (lib → worker, wrong direction — config is composition:
  consider moving it out of lib/ or the default into a lower layer); install oauth-flow (2), settings-api (1), server (1)
  still log.error + errs.capture → 2 lines.
- Fix round 1 complete 2026-11-07.
- r2b merged. DEPLOY ORDER: the new service removes GET fields label/spacingLimits → upload the new settings page together with (or before) running the new service.
- r2a merged: stale-cache fallback announces first; announce recorded only after a real sync (r.failure incl. wrong-type); self-heal retries stamps refused for an invalid option (VALIDATION_ERROR + 'INVALID_OPTION'/'was not one of the allowed options' — wording NOT confirmed live; falls back to dead-letter); fixtures fake HubSpot option sets and refuse unknown values (mutation-checked); mirror errors park one portal; Store.settings gone; replay via workerHarness/buildWorker. Left: docs/install-flow.md:55 install/pairs.ts → core/pairs.ts.
