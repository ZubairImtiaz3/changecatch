# Security review: ChangeCatch

> Review as of 2026-10-30. Status of each finding reflects the code at that date.

This review read the code only. The `.env` file was not opened. It was written against the code before the hardening work, which landed the same day; each finding has a **Status** line that says what the code does now. Code references name the file and function; line numbers are left out because they drift.

Severity scale: **High** = fix before any real customer. **Medium** = fix before Marketplace or production launch. **Low** = hardening or hygiene.

---

## Summary

The basics are in good shape:

- Refresh tokens are encrypted with AES-256-GCM, a random 12-byte IV each time, a full 16-byte tag, and the portal ID as AAD.
- Access tokens are only kept in memory.
- The settings API checks the signature (with a timestamp window and a constant-time compare) before it trusts `portalId`.
- The install redirect only goes to a URL we build ourselves, so there is no open redirect.
- No log line prints tokens, codes or secrets.
- The dependency audit finds 0 vulnerabilities, with a very small production dependency set.
- Uninstall purges every worker table for the portal.

The real risks were configuration and lifecycle gaps, not crypto:

1. The settings API could be downgraded to a replayable v2 signature. **Fixed.**
2. The unsigned-settings test switch had no production guard. **Fixed.**
3. Uninstall cleanup depended only on the journal event arriving. **Fixed.**
4. The privacy policy and the code disagreed on retention, including backups. **Mostly fixed.**

### Status summary

| ID | Finding | Status |
|---|---|---|
| H1 | `SETTINGS_ALLOW_UNSIGNED` has no production guard | Fixed |
| M1 | Signature downgrade v3 → v2 | Fixed |
| M2 | Duplicate `portalId` query parameter | Fixed |
| M3 | Uninstall cleanup relies only on the journal event | Fixed (daily sweep open) |
| M4 | Privacy policy vs code retention | Mostly fixed (`secure_delete` and final policy wording open) |
| M5 | No encryption key rotation | Fixed |
| L1 | OAuth `state` and in-memory state map | Mostly fixed (per-IP rate limit open) |
| L2 | Error details leak to the browser | Fixed |
| L3 | 500 instead of 413, no timeouts, no security headers | Fixed |
| L4 | Journal download: no host allow-list or size cap | Fixed |
| L5 | Worker `/health` lists every portal | Mostly fixed (still binds to all interfaces) |
| L6 | Workflow-action server writes call logs to disk | Not applicable (the action is deferred and not in this repo) |
| L7 | Container image hygiene | Deferred with hosting |
| L8 | Log hygiene | Mostly fixed |
| L9 | Token-to-portal map in the rate limiter never cleared | Fixed |

---

## Findings

### H1. `SETTINGS_ALLOW_UNSIGNED=1` has no production guard. High (if it's set)
- **Where:** `service/src/api/main.ts`, `service/src/install/server.ts`
- **Exploit:** If this flag ends up in a production environment (for example by copying the dev `.env`), anyone on the internet can call `GET/POST /api/settings?portalId=<any>`. They can read any portal's object types and settings, and change watched pairs and subscriptions for every customer.
- **Fix:** Refuse to start when `NODE_ENV=production` and the flag is `1`. Also allow it only when the server is local.
- **Status: fixed.** The API server refuses to start if the flag is set with `NODE_ENV=production`, or with a `PUBLIC_BASE_URL` that is not localhost. A missing `PUBLIC_BASE_URL` is now fatal in production, and it must use `https://`.

### M1. Signature downgrade on the settings API (v3 to v2, no replay protection). Medium
- **Where:** `service/src/install/signature.ts`, used by `service/src/install/server.ts`
- **Exploit:** `verifyHubSpotSignature` accepted v2 when no v3 header was present. v2 has no timestamp. Someone who captures one signed settings request (from proxy or tunnel logs, an APM tool, or a misconfigured tunnel) could strip the v3 header and replay it **forever**. A replayed POST resets that portal's watched pairs.
- **Fix:** Add a `requireV3` option and use it for `/api/settings`, because `hubspot.fetch` always sends v3.
- **Status: fixed.** `/api/settings` calls the verifier with `requireV3: true`. There is no v2 fallback on that route.

### M2. `portalId` is read with `searchParams.get` (first value wins). Low/Medium
- **Where:** `service/src/install/server.ts`
- **Exploit:** The signature covers the whole URL, so an attacker can't add parameters. But if the extension code (or a future change) ever puts its own `portalId` in the URL, and HubSpot then appends the real one, `get()` returns **our** value, not HubSpot's. That opens a door to cross-portal access.
- **Fix:** Reject the request unless `portalId` appears exactly once. Do the same for `userId` and `appId`.
- **Status: fixed.** The server rejects a request where `portalId`, `userId` or `appId` appears more than once.

### M3. Uninstall cleanup relies only on the journal APP_UNINSTALL event. Medium
- **Where:** `service/src/worker/hooks.ts`, `service/src/install/lifecycle.ts`
- **Exploit or impact:** The journal keeps events for about 3 days. If the worker is down longer than that, or the event is skipped (`JOURNAL_SKIP_FAILED_AFTER_MS`), the portal's encrypted token, pairs, `change_log` and label data are **never** deleted. That breaks the privacy policy's "deleted when you uninstall" promise.
- **Fix:** Add a reconciliation path. When a token refresh returns `invalid_grant` or `BAD_REFRESH_TOKEN` (the app was uninstalled), run the same uninstall and purge. Also run a daily sweep of installed portals that does a refresh check.
- **Status: fixed, except the daily sweep.** A refresh that fails with `invalid_grant` / `BAD_REFRESH_TOKEN` marks the portal revoked (`service/src/install/token-provider.ts`). Its stamps are paused, not dropped, and probed every hour. After 7 days of revocation the worker runs the normal uninstall routine, which purges the portal's data. A separate daily sweep of all installed portals is not built; a portal with no activity is only checked when it next needs a token.

### M4. The privacy policy doesn't match the code's retention. Medium (Marketplace review)
- **Where:** the privacy policy draft vs `service/src/store/db.ts` and `service/src/store/portals.ts`
- **Mismatches found:**
  - `association_labels` (record-ID pairs plus label names) is kept for **90 days**. The policy said "a few days at most".
  - `label_cache` had no TTL at all.
  - Host volume snapshots keep **deleted** data for a while longer. The policy didn't mention backups.
  - The `portals` row (portal ID, scopes, install times, `last_provision_error`) was kept forever. The policy said "[X days]", still undecided.
  - The policy said the change log is deleted within 30 days after uninstall, but the code deletes it **at uninstall**. The policy undersold the code.
  - SQLite `secure_delete` is off, so deleted rows can linger in free pages and the WAL.
- **Fix:**
  - Either cut the `association_labels` retention or document 90 days.
  - Add a TTL prune for `label_cache`.
  - Pick a retention for `portals` rows and clear `last_provision_error` on uninstall.
  - Add a backups line to the policy.
  - Optionally set `PRAGMA secure_delete = ON`.
- **Status: mostly fixed.**
  - `label_cache` now has a 30-day TTL.
  - Uninstall clears the token, pairs and `last_provision_error`, and the leftover `portals` row is deleted 30 days after uninstall.
  - The policy draft was updated: change log 30 days while installed and deleted at uninstall, logs about 14 days, and a backups line.
  - **Open:** `secure_delete` is still off. Before submitting, check that the final policy covers `association_labels` (record-pair label state, 90 days) and the 30-day `portals` row retention, and that the backup retention matches whatever hosting is chosen.

### M5. No encryption key rotation path. Medium
- **Where:** `service/src/install/crypto.ts`
- **Impact:** There was one key, and no key ID in the ciphertext. If the key leaks, the only option is to ask every customer to reinstall. Losing the key does the same.
- **Fix:**
  - Use a format with a key ID, and read a keyring of `id:key` pairs. Encrypt with the newest key and decrypt with whichever key matches the ID.
  - Add a one-off tool that re-encrypts all rows.
  - Keep the key only in the host's secret store, and back it up offline.
- The rest of `crypto.ts` is fine: the IV is random per encryption (volume is far below the 2^32 limit), the tag length is fixed at 16 bytes, AAD is set, and a raw 32-byte key needs no KDF.
- **Status: fixed.** New ciphertexts use `k<id>:<iv>:<tag>:<data>` with `TOKEN_ENC_KEYS=id:key,...` (the first key is active). Old `v1:` values still decrypt with `TOKEN_ENC_KEY`. The rotation tool (`service/src/cli/rotate-token-key.ts`) re-encrypts every row with a compare-and-set update. The offline backup of the key is a process item for the owner.

### L1. OAuth `state` doesn't protect against CSRF, and it lives in memory. Low
- **Where:** `service/src/install/server.ts`
- **Details:**
  - Unknown states were accepted (needed for installs started in HubSpot), and state wasn't tied to the browser. So a login-CSRF attack could make a victim's browser finish an install of the **attacker's** portal. The impact is small: the victim only sees an "installed in account X" page.
  - States were in memory, so after a restart a step-2 callback was treated as step 1. That could cause one extra consent redirect.
  - `/install` floods grew the `states` map without limit for 15 minutes (a memory DoS).
- **Fix:** Cap the map and add a basic per-IP rate limit on `/install`. Optionally bind state to a short-lived cookie. Code replay is already handled: no retries, and HubSpot codes are single-use.
- **Status: mostly fixed.** State is now HMAC-signed (step + expiry + nonce) and single-use, so it survives restarts and can't be forged. A state that is present but expired, forged or reused is rejected. Installs from HubSpot's own button carry no state; they are allowed and logged. The used-nonce map is capped at 10k entries. **Open:** a per-IP rate limit on `/install` and `/oauth/callback`.

### L2. Error details leak to the browser. Low
- **Where:** `service/src/install/server.ts` (install page and settings errors), `service/src/worker/health.ts`
- **Impact:** Internal paths and HubSpot correlation IDs or error bodies were shown to the installing user or settings user, who is authenticated. That's minor, but sloppy for a Marketplace review.
- **Fix:** Log the full error with a short request ID, and show only a generic message plus the ID.
- **Status: fixed.** 5xx responses and the install error page show a generic message with a reference ID. Details go only to the logs. `/health` hides error text unless the `x-health-token` header is sent.

### L3. Oversized body returns 500, not 413. No server timeouts. No security headers. Low
- **Where:** `service/src/install/server.ts`
- **Details:**
  - `readBody` rejected at 256 KB, but the outer catch turned that into a 500. Body reading also happens **before** the signature check (that's fine, because it's capped).
  - The HTML pages had no CSP, `X-Content-Type-Options` or `frame-ancestors`.
  - No CORS headers are sent, which is correct: `hubspot.fetch` is proxied server-side, so browsers can't read cross-origin. Keep it that way.
- **Fix:** Return 413. Set `server.requestTimeout` / `headersTimeout` explicitly. Add `X-Content-Type-Options: nosniff`, a strict `Content-Security-Policy`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.
- **Status: fixed.** Bodies are capped at 64 KB with a 413. Invalid JSON returns 400. Request and header timeouts are set. Every response carries the security headers, including `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`. Still no CORS headers.

### L4. Journal file download has no host allow-list and no size cap. Low
- **Where:** `service/src/hubspot/journal.ts` → `service/src/lib/http.ts` (absolute URL, default `redirect: 'follow'`)
- **Exploit:** The URL comes from HubSpot's API over TLS, so this is SSRF only if HubSpot is compromised or a man-in-the-middle is possible. No token is sent, which is good. But the worker would fetch any host, follow redirects to internal addresses, and read a body of any size into memory.
- **Fix:** Require `https:` and a host allow-list (HubSpot's journal bucket on S3). Set `redirect: 'error'` for this call. Cap the body size (for example 50 MB).
- **Status: fixed.** `service/src/worker/journal-reader.ts` only downloads `https:` URLs on HubSpot's journal bucket host (`hubspot-webhooks-journal…amazonaws.com`, no user info). It uses `redirect: 'error'`, its own timeout, and a size cap (`JOURNAL_MAX_FILE_BYTES`) checked against both `Content-Length` and the bytes actually read. A rejected URL raises an alert.

### L5. Worker `/health` is unauthenticated on 0.0.0.0 and lists every portal. Low
- **Where:** `service/src/worker/health.ts`, `service/src/worker/main.ts`
- **Impact:** The worker's port (3002) is not meant to be public, but it may be reachable on the host's private network. It showed customer portal IDs, metrics, label-hold keys and last error texts.
- **Fix:** Bind to `127.0.0.1` by default. Optionally return only a status unless a token header is present.
- **Status: mostly fixed.** `/health` and `/metrics` now return only totals unless the request carries `x-health-token` equal to `HEALTH_TOKEN` (constant-time compare; unset = never). Error texts are hidden without the token. **Open:** the server still binds to `0.0.0.0` by default; keep port 3002 private at the network level.

### L6. The workflow-action server writes call logs to disk. Low
- **Where:** the custom workflow action server (deferred, not in this repo)
- **Impact:** If it is ever deployed, its default writes record IDs and labels to disk with no retention and no uninstall purge.
- **Fix:** Default the log directory to none in production.
- **Status: not applicable for v1.** The custom workflow action is deferred and not part of this repository. Apply this fix when it is brought back.

### L7. Container image hygiene. Low
- **What was good:** a non-root user, a multi-stage build, install scripts disabled, and `.env*`, `data/`, docs and `.git/` excluded from the image. No secrets in layers.
- **Details:**
  - It used `npm install` after editing `package.json`, not a lockfile-strict install, so the lock wasn't strictly enforced.
  - The base image was pinned by tag, not digest.
  - The app files were owned by the runtime user, so a compromised process could rewrite its own code.
  - Developer tools (including one that writes `.env`) were shipped in the image.
- **Fix:** Use a lockfile-strict, production-only install (`pnpm install --frozen-lockfile --prod`). Pin the base image by digest. Copy the app as root so only the data directory is writable. Ship only the two entry points, not `tools/`.
- **Status: deferred with hosting.** Hosting and the container build are out of scope for now. Apply these points when the image is built.

### L8. Log hygiene. Low (mostly good)
- No log line prints an access token, refresh token, code or client secret. `http.ts` logs only the method, the pathname (not the query) and the status, so presigned signatures don't leak.
- Small issues found:
  - `HttpError` messages include HubSpot response bodies, and those end up in `last_provision_error`, the metrics `last_error`, and `/health`.
  - The OAuth error log line included attacker-controlled text, so newlines could be injected into logs.
- **Fix:** Strip `\r\n` from logged query values, and truncate HubSpot bodies before saving them.
- **Status: mostly fixed.**
  - Values from the request are stripped of newlines and truncated before logging.
  - A central redaction helper (`service/src/obs/log.ts`) removes bearer tokens, refresh tokens, signed URL parameters and long secret-like strings from log lines and error reports.
  - `last_provision_error` is capped at 2,000 characters, and `/health` hides error text without the token (L5).
  - **Open:** the `HttpError` message itself still carries the full HubSpot response body; a shorter cap (about 300 characters) at the source would be tidier.

### L9. The token-to-portal map in the rate limiter is never cleared. Low
- **Where:** `service/src/install/token-provider.ts` calls `registerPortalToken`, and nothing removed entries on `forget()` or uninstall.
- **Impact:** Access tokens piled up in memory (they expire after 30 minutes, but were never evicted). This is a slow memory growth issue, not an exposure one.
- **Fix:** Evict entries on `forget()` and when the token expires.
- **Status: fixed.** `forget()` now calls `forgetPortalTokens`, which drops that portal's entries from the rate limiter.

### Checked and OK
- **Uninstall completeness:** `purgePortal` (`service/src/store/db.ts`) covers every per-portal table plus `pending_pairs`. String keys are purged with an exact `'<id>|'` range, so `12|` can't match `123|`. `markUninstalled` wipes the token and pairs. Subscriptions are deleted first; a failure is retried from the lifecycle retry table without holding the journal offset.
- **Plaintext in the DB** (`service/src/store/portals.ts`, `service/src/store/db.ts` schema): portal ID, scopes, timestamps, provisioning errors, record IDs, object types and label names. There are no names, emails or property values, which matches the shared-data table. Encryption at rest for the volume depends on the host.
- **Signature details:** the timestamp window is ±5 minutes, the compare is constant-time, and `portalId` is only read after a successful verification. The URI is rebuilt from `PUBLIC_BASE_URL` plus the raw request path, never from `Host` or `X-Forwarded-*` headers. A missing `PUBLIC_BASE_URL` is fatal in production.
- **Input validation:** at most 200 pairs, a type-ID regex, pairs checked against the portal's real object types, and spacing must be an integer from 1 to 600.
- **Dependencies:** the audit reports 0 vulnerabilities, both for everything and for production only.
- **Secrets in git:** `.env` has never been committed, and no token patterns were found in tracked files.

---

## Must fix before production

| # | Item | Status |
|---|---|---|
| 1 | **H1:** Hard-fail when `SETTINGS_ALLOW_UNSIGNED=1` and `NODE_ENV=production`. Make a missing `PUBLIC_BASE_URL` fatal in production. | Done |
| 2 | **M1:** Require v3 signatures on `/api/settings` (no v2 fallback). | Done |
| 3 | **M2:** Reject duplicate `portalId` / `userId` / `appId` query params. | Done |
| 4 | **M3:** Treat `invalid_grant` / `BAD_REFRESH_TOKEN` as an uninstall and purge, and add a daily installed-portal sweep. | Done, except the daily sweep |
| 5 | **M4:** Align the privacy policy with the code: `association_labels` 90 days, `label_cache` TTL, backups, the `portals` row retention, and change log deleted at uninstall. | Code done; final policy wording check open |
| 6 | **M5:** Add key IDs and a rotation tool for the token key, and back up the key offline. | Done in code; offline backup is a process item |
| 7 | **L2 + L3:** Return generic errors to the browser, 413 for oversized bodies, and basic security headers. | Done |
| 8 | **L4:** Allow-list the journal download host, set `redirect: 'error'`, and cap the size. | Done |

Still open after this list: a per-IP rate limit on `/install` and `/oauth/callback` (L1), binding the worker's health port to localhost (L5), `secure_delete` (M4), a shorter cap on HubSpot error bodies (L8), and the container points in L7 when hosting is set up.
