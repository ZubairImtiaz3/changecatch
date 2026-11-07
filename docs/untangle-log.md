# Untangle decision log (working file, 2026-11-07)

Method: `.claude/skills/untangle-codebase/SKILL.md`. Owner chose Comments + Tests. Status: step 2 (listing) in progress.

## Survey: core (service/src/core) — candidate root fixes

1. **Core is stamp-only.** Delete the app-events path: emit.ts, AppEvent types, sendOccurrences, OCC_PREFIX 'occ:',
   DeliveryMode / deliveryModeFromEnv / resolveDeliveryMode, RunConfig.emit/deliveryMode, labelNames/namesFor (names only
   inside mirror translation). Production hard-codes 'stamp' (worker/main.ts:153). Needs owner OK + D2 wording edit.
   Port poller.test.ts and test/replay/pairing.real.test.ts to the stamp sink. occurrencesSent/"stamped now" counts
   coalesced drops today (drainInline:false) → rename/drop.
2. **Delete the dead in-memory Stamper and planners**: planStampWaves/Slots/Batches, groupSameTime, Stamper
   (hubspot/stamp.ts:206), formatLabels, LABEL_SEPARATOR, minSpacingMs (dup of stamp-queue 3000), NONE/UNKNOWN re-export;
   use AMEND_PROPERTY_NAMES in absorb (absorb.ts:267 builds it by hand). STANDARD_OBJECT_NAMES → hubspot/properties.
3. **One keys-and-ledger module**: pairKey/actionKey/recordKey/labelPairKey ("portal|from|to[|typeId]" built in 4+
   places, LIKE in db.ts:765), amend id "<id>~amend-<hash>" sort rule, label-key vocabulary (UNLABELED_KEY, 'type N',
   /^\d+$/ x2, normLabelName == label-options clean). seen_events prefixes stamp:/stamp-sent:/occ: → named store
   methods (markStampHandled/markStampWritten/wasStampWritten); stamp-queue stops importing from core/poller.
   Delete ResolveConfig.unlabeledName. Stored strings must stay byte-identical.
4. **Freeze pairing**: delete structuralMode 'label', labelOnlyAddedAs/RemovedAs, collapseMirrorEvents flag (A2/A3
   confirmed), orderingSlackMs → const; structuralNet required (deletes absorb branch absorb.ts:192).
5. **Split runOnce**: delay/back-off/isStale/env parsing → worker; counters in memory not worker_state
   (consecutive_empty/errors); delete idleMaxMs; drop in-transaction prunes (maintenance timer does them);
   isParkable + alert required; delete enforceWatchedPairs/absorbLateHalves flags; buildStructuralCheck runs twice.
   num() env parser copied in pairing.ts:138, poller.ts:49, main.ts:466, rate-limiter.ts:71, db.ts:53 (+2 styles) →
   one lib/env helper; core never reads process.env.
6. **Types flow one way**: EmittedAction, LabelDefinition → core/types; core uses narrow store ports;
   mergeQueuedProperties (store edits StampUpdate JSON) → queue-owned correctQueuedLabels; delete hasNewerEmittedAction.
7. **One mirror flag** (resolve.mirror, stamp.mirrorOnOtherRecord, label-guard syncScope must agree); findByName required.
8. **Coalesce trims**: coalesceFor hook, idOf aliases, withCount, Math.max(2,…) dup, duplicated 40-line header.

Stale facts: custom action "Get association change" cited in stamp.ts:4/poller.ts:358 (removed by D4);
decisions.md:52 says amend writes 2 props, code writes 3. Comments: ~40% of core comment lines restate code
(worst poller.ts:101-207, stamp.ts headers, coalesce.ts:1-40). Tests: poller.test.ts runs app_events sink; stamp.test
tests dead planners/Stamper; units.test.ts is a grab bag; absorb.test tied to planLateHalf; fixtures (UD/HD, fake
LabelCache, LABELS 3/101/102) redefined in 5 files.
## Survey: install / api / cli — candidate root fixes

1. **One process owns HubSpot provisioning (API server).** In-memory per-portal lock in Installer can't cover API +
   worker (two Installers: api/main.ts:65, worker/main.ts:361). API adds a startup/periodic sweep re-provisioning
   portals with provisioned_at IS NULL; worker APP_INSTALL only lifts a pause (installed_at > paused_at). Deletes
   lifecycle.ts install branch, LifecycleOutcome string protocol (hooks.ts:92-100), LIFECYCLE_INSTALL_GRACE_MS guess,
   duplicated install/uninstall kind() (lifecycle.ts:45 ↔ lifecycle-retry.ts:46). Lifecycle-sub self-heal stays in API.
2. **One token provider, classified errors.** Two TokenProvider interfaces + two error hierarchies
   (install/token-provider.ts ↔ worker/tokens.ts, different revoked-grant regex); worker casts realTokens
   (worker/main.ts:404-420); second access-token cache in hubspot/oauth.ts:86-127 used only by tools;
   token_revocations DDL in a constructor outside migrations; MemoryRevocations test-only; revokedAt() deletes on read.
3. **Scopes + custom-object rules from one source.** CUSTOM_* scope lists derive from APP_SCOPES; "available" checks the
   scope the schemas call needs (crm.schemas.custom.read; 403 swallowed at object-types.ts:36); delete
   CUSTOM_WRITE_MODE=optional everywhere; one isCustomObjectType() for 7 startsWith('2-') copies; hubspot/oauth →
   install import direction fixed; "custom selectable" rule applied once (server view), UI just reads `selectable`.
4. **Settings module owns the contract.** Validation split server.ts:322 ↔ installer.ts:113; object types fetched twice
   per POST; GET adds recommendedPairs/defaultSpacing/limits so the UI drops RECOMMENDED_PAIRS, DEFAULT_SPACING, {1,600},
   STANDARD_NAMES copies; drop ticket (0-5) leftovers and CHANGECATCH_DEFAULT_PAIRS; provision() must not silently save
   the pair list with custom pairs removed (bug). Needs a hubspot-app upload (ask owner).
5. **Split server.ts (573 lines) + structured logging.** oauth-flow.ts / settings-api.ts / thin router; pass a
   structured Logger to installer/server/subscriptions so obs/wiring classifiedLog (level parsed from message words)
   and logSafe go; delete test-only v2 signature path, duplicate assertUnsignedAllowed/NODE_ENV, ExitPending trick.
   Check docs/observability.md alert rules before renaming events.
Tests: crypto tests duplicated (install.test ↔ security.test); v3 round trip tested twice; plan/apply tests tied to
internals; optional-mode and v2 tests test dead code. Keep: security.test server tests, scopes.test callback/landing
flows, install.test:206-311 + :401-418, token-refresh-log.test.

## Survey: worker — candidate root fixes (~115 problems)

1. **Typed StampResult kinds** (hubspot/stamp.ts returns kind ok|retry|rate_limited|auth|refused + retryAfterMs +
   source hubspot|limiter): deletes regex classification on free-text reasons (stamp-queue.ts:124-128, :357-359
   "/failed with 429/"), duck-typed retryAfterMs (tokens.ts:352, hubspot/stamp.ts:188).
2. **One token module** (= install fix 2): 3 TokenProvider shapes (tokens.ts:331, token-provider.ts:28,
   hubspot/stamp.ts:19), 3 error layers, duplicate BAD_REFRESH_TOKEN regex, `as unknown` cast main.ts:404; "revoked"
   stored twice (portal_pause + token_revocations) and re-synced every drain; isTokenRevokedError unused.
3. **Store owns all tables + one purge**: worker-tables schema outside migrations (re-creates index
   stamp_queue_portal_due), reaches into store.db, tx() dup, stamp_queue queries split across 2 files (dead dueStamps,
   isQueued), two "next due" definitions (paused or not), purge spans 4 stores + 2 paths (onPurged vs onLocalPurge) with
   a call-order rule; journal_fail:<offset> rows leak after a successful retry; listDeadLetters test-only;
   `new WorkerTables()` default makes a 2nd instance (random workerId).
4. **(High risk, decide later)** delivery status column instead of seen_events key prefixes stamp:/stamp-sent:.
5. **One config object** `workerConfigFromEnv(env)` passed down; 5 env-number parsers; process.env read deep in
   journal-reader.ts:97 and health.ts:130/287 (health can disagree with reader on JOURNAL_OFFSET_MAX_AGE_MS);
   STAMP_MIRROR fanned out to 4 places incl. magic syncScope 'mirror'; queue default coalesce OFF vs prod latest;
   STAMP_SPACING_MS never has an effect; ~10 never-set options (maxAttempts, retryBaseMs, maxPerPortalPerDrain,
   pauseProbeMs, alertAfterRefusals, staleAfterMs, maxSleepMs, prefix…).
6. **Delete test-only modes + dead code**: blockOnFailure, StampSendError, drainInline, WorkerDeps.heartbeat (2 lock-loss
   paths), isStopping, nextReadTime, latencyStats pass-through, dead re-exports, `first` param, journal_offset_reset
   (written never read), custom-sender catch, realJournalApi wrappers, mapConcurrent dup (hubspot/stamp.ts:192).
7. **Monitoring reads one source**: delete latency.ts (dup of e2e_latency_ms histogram; percentile x3 incl. tools);
   each outcome counted once (SQLite metrics vs registry); drop stamp_queue_size dup; Prometheus exporter + isStale →
   obs; privacy filter string-matches "portal=" (fragile); one throttled-alert helper (3 copies); [ALERT] baked into
   error text and re-parsed by obs/wiring.ts:14 regex.
8. **One lifecycle module** (merge install/lifecycle + hooks makeLifecycleHook + lifecycle-retry; one kind(); pause
   expiry calls uninstall(portalId, reason) instead of a fake event with magic offset 'pause-expired' and Date.now()).
9. **Journal-reader**: one case-insensitive compareOffsets (4 orderings today); delete journal_fail row on success;
   earliest required; one data-loss reason for an expired offset (journal_gap + offset_expired today).
Tests: 5 hand-rolled worker harnesses, none goes through createWorkerFromEnv → prod wiring untested. Keep worker.test
behavioural tests, offset-expiry, hooks.test :121 + :232, data-loss, label-guard :37-81, test/replay/*.

## Survey: cross-cutting — candidate root fixes

1. **Typed config loaded once** (lib/config.ts loadConfig(env), one parser: unset=default, junk throws; frozen object
   passed down; no process.env default args; no import-time env reads in db.ts:43,47; tools reuse the loader and stop
   mutating DB_PATH; docs/configuration.md + .env.example tested against the table). ~45 vars in 17 files, 10 parsers
   with 3 rules; configuration.md:7 claims invalid values stop the process but 7 vars silently default;
   JOURNAL_OFFSET_MAX_AGE_MS parsed twice with different 0 handling; 'conditional' default x2; required-var checks x4;
   api/main.ts:61 calls defaultPairs()/customWriteMode() only for side-effect validation.
2. **Delete unused modes/knobs**: DELIVERY_MODE + app-events path (decisions.md:171, architecture.md:237 wrongly
   advertise it), CUSTOM_WRITE_MODE=optional, Stamper/planStampWaves, unused config fields, journal_offset_reset;
   ~20 env knobs → named constants (keep window/split-hold override for incidents).
3. **Product constants served by GET /api/settings** (recommendedPairs, defaultSpacing, presets, limits, object labels)
   + one STANDARD_OBJECTS table {id, singular, plural, schemaWriteScope, rank, watchable} replacing 5 lists
   (TSX STANDARD_NAMES, pairs.ts STANDARD_OBJECTS/RANK, stamp.ts STANDARD_OBJECT_NAMES, properties STANDARD_OTHER_TYPES,
   schemaWriteScopeFor); TSX DISPLAY_ORDER ≠ pairs.ts STANDARD_RANK; 3 s spacing in 5 code places; settings response
   type re-declared in TSX with no contract test; support email TSX ↔ app-hsmeta. Needs hubspot-app upload.
4. **Store-owned key builders + typed worker_state** (store/keys.ts: portalKey, recordKey, holdKey, labelsSyncedKey,
   seen prefixes): `${portalId}|…` built inline in 7 places that purgePortal's pipePrefixRange depends on; load-test-lib
   rebuilds keys with raw SQL; journal_fail leak.
5. **Shared helpers + one logger**: lib/backoff.ts (back-off written 6x), withTokenRefresh (401 refresh 3x), one injected
   Logger (no console.* fallbacks in 6 modules, 4 log signatures), alerts as structured event:'alert' not "[ALERT]" text.
Special cases: hubspot/journal.ts:259 404 "assumed" empty → fake COMPLETE; swallowed name lookups (resolve.ts:94,
properties.ts:399); metricsInc swallows undefined metric; pickStampProperties legacy shim (pre-D5 rows).
Tests: scopes.test.ts:30 mutates real process.env; add drift tests (pairs, spacing, objects, support email, TSX contract).
Docs drift: tools/README.md:51 old property names; stamp-queue.ts:417 literal changecatch_change_type.

## Survey: infra (hubspot, lib, store, obs) — candidate root fixes

R1. **One HubSpot transport (lib/http)**: typed errors Throttled{retryAfterMs,scope}/Transient/Unauthorized/Refused/
    Revoked; one URL classifier for limiter + metrics (http.ts:91 rateKeyFor ≠ wiring.ts:75 apiFamily ≠
    journal-reader:79); one backoff; one API version constant ('2026-09' defined 8x + 2 inline, incl. tools); S3 downloads
    via a download mode (allow-list + size cap); metrics recorded inside (delete instrumentFetch globalThis.fetch patch —
    API server's calls aren't counted today); 3 "throttled" types (RetryLaterError, RateLimitWaitError, 429);
    oauth api.hubspot.com vs auth api.hubapi.com host mismatch.
R2. **Pass portalId explicitly**; PortalTokenProvider the only token cache; delete global token→portal registry
    (rate-limiter.ts:235-260, written as a side effect of token refresh, read for buckets/labels cache/metrics),
    oauth getPortalAccessToken/clearPortalToken, EARLY_REFRESH_MS x3, 401 branch in sendStampBatch.
R3. **One owner for the frozen property contract + object-type table (core/contract.ts)**: names, labels, help, options,
    value format, STANDARD objects {id,name,rank,scopes,supported}; properties.ts becomes a thin client; one
    listCustomObjectTypes (schemas call implemented twice: properties.ts:389 swallows all, object-types.ts:25).
    Ticket inconsistency: 0-5 offered as option but no scope (schemaWriteScopeFor returns 'crm.schemas.<0-5>.write').
    Snapshot test of all names/values before moving (D7).
R4. **One schema registry + one purge** for the single SQLite file: tables made in 4 modules by 3 mechanisms
    (STORE_MIGRATIONS, PORTAL_MIGRATIONS, worker-tables IF NOT EXISTS, token-provider constructor DDL); portal_settings
    schema + get/setWatchedPairs duplicated (db.ts ↔ portals.ts, API writes via one, worker reads via other); 3 purges +
    sqlite_master probe; worker_state typed keys; labels_synced → small table; one maintenance timer; drop unused
    portal_options table. Don't touch stamp_queue/stamp_last/seen_events contents.
R5. **Split Store by feature** (after R4): store/sqlite.ts toolkit; feature tables next to features behind core's
    repository interfaces; explicit versioned JSON codecs (update_json/entry_json shapes silently follow core types).
R6. **Delete dead code (~600 lines)**: Stamper/planStampWaves; journal.ts getNext/batchLatest/batchRead/
    createAssociationSubscription/readJournalAfter/downloadJournalFile (contradicts journal-reader: 404=empty, no
    allow-list); auth appTokenInfo/clearAppToken/HUBSPOT_JOURNAL_SCOPES; limiter accessors; Logger.asLegacy*;
    memoryLogger → test utils; Sentry backend (@sentry/node not installed); occurrences naming; db.ts isQueued/
    hasLabelHold/hasNewerEmittedAction (0 callers), dueStamps/getMetrics/getChange (test-only); readProperties 4xx
    fallback; dry-run states → tools; store→install (crypto → lib).
R7. **Logger as a dependency** with log.alert()/alertCleared(); delete legacyLog/legacyInfoLog/classifiedLog, [ALERT]
    parsing (32 sites), "portal N" scraping, console defaults.
R8. **One metrics source**: in-memory ChangeCatchMetrics; persist only what /health needs.
Special: properties.ts upserts turn 403 into text then sniff ' 403'; free-text→enum migration runs every install;
pickStampProperties legacy filter on every send; listProperties keeps the heavy GET only because hooks.test stubs it.

## Keep (core)

Keep: A1–A7 assumptions, UUIDv7 offset time, label===null structural rule, entryKey, deterministic changeIdFor +
change_log before stamp, D6 absorption, D7 values, mergeOptions never removes, label cache throttle, findByName unique
match, parking cap, emitted_actions PK range trick, planEnqueue keeps oldest slot.

## Re-survey round 1 (fresh agents, 2026-11-07)

### core + store — "mostly in good shape; no exactly-once risk"
Worth fixing: (1) STAMP_MIRROR fanned into 4 knobs (stamp.mirrorOnOtherRecord, resolve.mirror, label sync mirror,
syncScope 'mirror') → one `mirror` on RunConfig; (2) label cache split core/labels.ts StoreLabelCache ↔
worker/label-guard.ts GuardedLabelCache sharing a store behind each other's back → one worker-side LabelCache, core keeps
the interface + buildStructuralCheck; (3) label-key format re-parsed in resolve/stamp/label-options (/^\d+$/ x3,
"type N"/"type ?") → exported constructors/predicates; (4) emitted_actions inside LabelStore → own repository;
(5) ResolveConfig.unlabeledName never varies → delete; (6) RunDeps.watchedPairs optional with a non-production fallback
→ required; (7) store logger module global + test-only setter → injected Logger; (8) two "next due" queries (health
ignores pauses) + worker-only tables split store/ vs worker/ → one rule; (9) pending_pairs purge via json_extract →
portal_id column (pre-launch, fold into v1); (10) worker opens the DB twice (Store + PortalStore) → share one Db;
(11) dead worker_state key consecutive_empty; (12) CoalesceOptions threshold never varies → const; (13) pairing defaults
(incl. categoryIsStructural fallback) never used → required; (14) normLabelName == clean → one fn; (15) findByName
optional only for a stub; (17) dead `categories.length ? : HD` branch; tests: store tests in core test files, absorb.test
uses names. Not worth: core→obs type-only Logger import; tool read-API methods.

### install / api / cli / hubspot / hubspot-app — "mostly in good shape"
Worth fixing: (1) hubspot/oauth.ts buildInstallUrl/appScopes/AUTHORIZE_URL import install → move install URL into install/,
delete appScopes copy + test-only scopes param, merge AUTHORIZE_URL with oauth-flow's HUBSPOT_AUTHORIZE_ORIGIN/PATH;
(2) install/object-types.ts is a HubSpot schemas client → hubspot/object-types.ts; properties objectTypeNames reuses it
(→ zero hubspot→install edges); (3) raw SQL on token_revocations/portals outside store (portal-tokens.ts, install/rotate.ts
via PortalStore.db) + AAD rule copied → PortalStore owns revocations + rotateTokens; drop `db` from the Pick;
(4) CORRECTNESS: hubspot/stamp.ts per-record errors in a 2xx batch always `refused` (never retried) + missing record gets
errs[0] → classify per-record status/category like outcomeOf (CHECK HubSpot docs for errors[] shape first); same
id-matching heuristic copied in properties.ts; (5) customAccess+isPairActive repeated 4x, worker depends on settings.ts
for activePairs → one portalPairs helper next to pairs/scopes; (6) CHECK: settings save adding a pair — is
changecatch_other_object_type option guaranteed before the first stamp (label-guard first-sight announce) — fix comment
or call sync in applyPairs; (7) listProperties full GET kept for a test stub → readProperties; (8) hubspot/labels.ts
module-global cache with test-only options + uncalled clearLabelCache; (9) "/install?custom=1" in 4 places;
(10) delete back-compat GET fields after page upload; (11) TSX re-sorts object types (second ordering rule);
(12) SUPPORT_EMAIL copy; (13) properties.ts scope string literal + ' 403' text sniff; (14) objectTypes closure dup in
api/main; (15) normalise lifecycle-subscription list quirk in journal.ts; (16) region-host regex x2; (17) rare race:
worker uninstall vs API saveSettings re-creating subscriptions; (18) pairs.ts pairKey name clash with core/keys pairKey;
(19) un-export properties.ts internals.

### worker — "fair shape; pipeline/offset/exactly-once sound"
Worth fixing: (1) BUG: on 'throttled' only the rows picked this cycle are deferred; with >100 due rows the rest stay due
while in-memory skipUntil skips the portal → nextDueAt in the past → 0 ms sleep → CPU spin for retryAfterMs, starving
/health + lock heartbeat. Fix: defer ALL due rows of the portal in one UPDATE (or fold skipUntil into nextDueAt), delete
skipUntil, add loop test (>100 due + 429); (2) portal_pause written in worker/worker-tables.ts, read by store/stamps.ts
raw SQL, schema in store → pause queries into store/stamps.ts; consider moving lifecycle_retry + worker_lock into store so
WorkerTables disappears; (3) LabelHoldError lives in worker → core needs isParkable predicate with one value → move it +
guard policy next to LabelCache in core, poller checks directly; (4) dead WorkerDeps heartbeat/alerter/staleAfterMs/
maxSleepMs, isStopping/nextReadTime getters; two lock-loss paths (only setInterval live); (5) WorkerDeps optional with
defaults though only buildWorker builds Worker; (6) test-only seams sendBatches + batchUpdate → keep one;
(7) never-set options (maxAttempts, alertAfterRefusals, maxPerPortalPerDrain, pauseProbeMs, pauseMaxMs, lifecycle
baseMs/maxMs/alertAfter, label-guard maxHoldMs, journal-reader offsetCheckEveryMs — the last can diverge from health's
hard-coded constant) → constants; (8) stamp-queue defaults copy owners' defaults → required; (9) offsetTimeMs in
obs/metrics vs compareOffsets in journal-reader → one journal-offset module; (10) idOf alias, dead recordKey re-export,
pass-through nextDueAt; (11) LifecycleRetryRow.event typed as journal event but stores PendingUninstall; (12)
setRateLimiter only in entry guard, not main() (tests/tools run without limiter), mis-indented; (13) HealthOptions.tables
optional only for one test; (14) properties listProperties held by a test stub (also in install findings);
(15) main.ts header restates buildWorker; (16) overlapping 207-skip tests.

### lib / obs / tools / fixtures / docs — "items 1-3 real, rest tidy-ups"
(1) test/fixtures/replay.ts 'immediate' delivery hand-copies StampQueue success bookkeeping → shared recordDelivered or
'queue' delivery (guards the replay regression net); (2) two offsetTimeMs (obs/metrics vs core/pairing, different
contracts) → one in core; (3) log.alert() writes its line AND errors.message writes a second (no backend since Sentry
dropped) → alerts/paging fire twice; same for log.error+errors.capture → Errors = throttled writer only, one line;
(4) setRateLimiter line copied per entry point (forgetting it ignores HS_PORTAL_RATE_PER_10S) → configureHttp(config);
(5) classifyUrl hard-codes journal path prefixes built in journal.ts (silent unthrottled 'other' on change);
(6) stale COALESCE_MODE in metrics help + observability.md; (7) token_refreshes missing from observability.md metrics
table + add M↔doc drift test; (8) metrics matched by string literal in tools/health; (9) http maxWaitMs dead, timeoutMs/
rateKey test-only; (10) lib error names a worker constant; (11) ApiFamily list retyped in metrics; (12) dead
MetricsRegistry add/remove/reset, toPrometheus prefix, toJSON perLabelLimit, statusLabel, rateLimiterStats +
initErrorReporting pass-throughs, setHttpLogger test-only; (13) two conventions for defaults (config vs owner);
(15) configuration.md defaults column unchecked (optional test vs loadConfig({})); (16) e2e parses change-id format;
(17) 'HUBSPOT_DEFINED' literal repeated (pairing.ts x2). Good shape: crypto, backoff, alerts, heartbeat, tools/lib,
fixtures, app-scopes guard, config drift test, alert names match docs.

## Re-survey round 2

### core / store / worker / test
LABEL-OPTION RISK CONFIRMED: (1) label-guard.ts:72-77 stale-cache fallback on refresh failure (e.g. TokenRevokedError)
returns before the "announced?" check → stamps a type id whose option may not exist → HubSpot refuses → dead-letter after
reinstall; fix: fall through to the announce check with the cached hit; add test. (2) hooks.ts:39 hook returns silently
when not installed but guard records "announced" → only record after a real sync. (3) syncLabelOptions in-flight reuse
with different watchedPairs can skip a pair's options → reuse only if other types ⊇ caller's. (4) no self-healing:
labels_synced never re-checked → on a stamp refused for an invalid enum option, clear that portal/object type's
labels_synced so the next event re-announces. (5) replay/worker fixtures use a no-op option sync and can't catch
"stamped value is not an option" → simulate the option set and assert every stamped enum value is in it.
Other: (6) mirror-only: label errors in mirrorKeysOf/namesFor aren't caught per portal → whole-journal stall (fix: per-
portal step / park); (7) lib/config → worker/stamp-queue import; (8) Store.settings second path into portal_settings,
tests skip the active filter → drop it, use portalPairs; (9) replay fixture re-wires buildWorker by hand → build through
buildWorker with fake parts. Not worth: core→obs type-only Logger. Otherwise good shape.

### install / api / cli / hubspot / hubspot-app — "good shape; no trigger-loss bug"
Worth fixing: (1) installer.ts:202 property `exists-mismatch` doesn't fail provisioning → silent refused stamps; count it
as failure (lastProvisionError → settings page), one `failure?` on SetupReport/LabelSyncReport; (2) delete back-compat
GET fields spacingLimits/label (+ test) — page not uploaded but current TSX reads neither; (3) assertUnsignedAllowed →
loadConfig('api'); (4) prime() clears revocation AND REVOKED_SQL ignores older-than-install → keep installed_at rule
only (check <=); (5) TokenProvider.isRevoked no non-test caller; (6) scopes.ts header 3rd copy of scope sets;
(7) SUPPORT_EMAIL drift assertion in app-scopes.test; (8) buildInstallUrl passed back into oauth-flow; (9) Installer
exposes objectTypes only to pass it on; (10) pairs.ts/customAccess pure rule lives in install/ (worker → install edge) →
core/pairs.ts; (11) worker builds a full Installer only to uninstall → small shared uninstall fn; (12) app-lifecycle
spread over hubspot/install/worker → one lifecycle module; (13) batchErrorFor in stamp.ts used by properties → hubspot/
batch.ts; (14) hubspot/labels.ts module-global cache filled as a side effect (3 label caches) → explicit cache object
with injected clock; (15) TokenResponse + EARLY_REFRESH_MS twice; (17) JOURNAL_PATHS in lib → journal passes bucket;
(18) redaction/crypto tests in install folder → next to modules; (20) swallowed try/catch around logger/metrics in
portal-tokens. Not worth: ASSOCIATION_ACTIONS type dup, TSX SettingsView copy.

### lib / obs / tools / docs — "fairly good shape; docs spot-checked accurate"
(1) config: lib → worker import for DEFAULT_RETRY_WINDOW_MS + two default conventions → config passes undefined, owner
applies its default (keep range check in config); (2) process-wide setup order (configureHttp, configureLogging,
installProcessHandlers) + getRateLimiter lazy default hides a missed call → one startProcess(config,{metrics}), no lazy
default; (3) API server builds a metrics registry nobody reads → delete; (4) ~14 alert name literals copied into
runbook table unchecked → ALERTS const + runbook drift test; (5) 4 health gauge names outside M → into M + doc test;
(6) hsDownload is journal-specific → hubspot/journal.ts with its caps, drop unused retries; (7) rateKey 'none' only for
tools → tools pass portalId; (8) obs/errors surplus (fingerprint, Severity warning/fatal, maxFingerprints, component
'app'); (9) isStale/STALE_AFTER_MS → worker/health, drop unused staleAfterMs; (10) heartbeat never-set options → consts;
(11) README tools line wrong; (12) "pnpm dev" command wrong in configuration.md + observability.md; (13) observability.md
"logger injected into every module" untrue (http.ts, properties.ts module loggers); (14) configuration.md fixed-values
numbers unchecked → names only or test; (15) tools 80/10s comment vs worker 100/10s — check HubSpot limits (service key
vs app OAuth limits) and fix; (16) SUPPORT_EMAIL drift test; (17) type-only cycle lib/http ↔ obs/metrics; (19) http.test
tests rateKeyFor internal. Not worth: tools sleep dup, portal-token cache, DEAL/CONTACT ids, ToolsConfig in config,
metrics table rename.

## Re-survey round 3

### core / store / worker / test — "good shape"
Worth fixing: (1) BUG stamp-queue.ts:137/440-453 expiredHandled Set never cleared after a successful purge → after
reinstall + re-revoke in the same process the portal stays paused forever, privacy purge never runs → key by
portalId:pause.since or delete after onPauseExpired succeeds; (2) test/fixtures/worker.ts fakeOptionSync re-implements
properties.ts runLabelSync desired-options logic (differs: STANDARD_OTHER_TYPES) → extract pure desiredSyncedOptions()
used by both. Minor (only if in the file): maxParkedPerPortal → const; HealthOptions.staleAfterMs vs StaleAlerter
STALE_AFTER_MS disagree; resync keys string-encoded; recordDelivered export + stale comment; PortalSettings pass-through
class; changecatch_change_type literal; test-only retry knobs; units.test.ts → dedupe.test.ts.

### install / api / cli / hubspot / hubspot-app — "good shape; nothing risks a missed trigger"
Worth fixing: (1) properties.ts module-global labelLists cache + syncInflight → instance createLabelOptionSync() owned by
api/worker mains (tests dodge it with different portal ids). Flaky scopes.test: not reproduced; fix the only
nondeterminism: test/fixtures/app-server.ts listen on 127.0.0.1 + return 127.0.0.1 URL (Windows ::1/127.0.0.1 race),
scopes.test picks scopes by code not call count. Minor: customWriteMissing predicate dup (oauth-flow vs scopes);
/install route literal vs installPath (+ move routing helpers next to router); merge app-scopes.ts into scopes.ts, drop
installScopes param; 100-record check twice; stamp-queue reaches revoked list via token provider; ~25 exports with no
outside caller → un-export.

### lib / obs / tools / docs — "good shape, nearly done"
Worth fixing: docs/install-flow.md:55 install/pairs.ts → core/pairs.ts (only stale doc path). Minor: e2e-check + load-test
re-implement "Deal↔Contact watched" → WorkerDb.watches(); AppBucket union spelled 4x → one export; Config.nodeEnv dead;
metrics comment says app server uses ChangeCatchMetrics (only worker); SAMPLES_DIR resolved vs cwd (DB_PATH vs service/);
e2e-check own sleep + ChangeType re-spelled; tools linksOf rebuilds label key → typeIdKey; configuration.md env defaults
column unchecked → extend test. Not worth: installProcessHandlers params, opts.log ?? createLogger seam.

## Final confirmation pass
MUST: hubspot/stamp.ts failAll — whole-batch 4xx refuses+dead-letters up to 100 records for one bad record → split/bisect
refused multi-record batches so only the bad record is refused; verify HubSpot's real behaviour live (batch with one
deleted id / one invalid option). SHOULD: (2) stamps enqueued in their own tx before the offset/pending/seen commit → a
failed commit or crash between them can re-pair differently → double trigger → enqueue inside the end-of-run
transaction; drop stale "must throw / alreadySent / onDelivered" leftovers; (3) uninstallPortal deletes subscriptions
before marking uninstalled + wiping the token → token can linger while HubSpot cleanup retries → mark uninstalled +
forget tokens first (subscription delete uses the app token), lifecycle_retry row = cleanup owed. NICE: installer creates
subscriptions before saving pairs (events in the gap dropped) → save first / roll back; empty saved list silently means
DEFAULT_PAIRS → use a "not yet configured" state.
