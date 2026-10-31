> Research reference, written before v1 was built (Oct 2026). Check the current HubSpot docs before relying on any endpoint.

# Research: Webhooks Journal (checked 2026-10-30)

All facts below were read from HubSpot's docs on 2026-10-30. Each fact has its source URL.
Nothing here has been tested against a real account yet. Test 0 must confirm it.

Short names for the source pages used below:

| Short name | URL |
|---|---|
| [OVERVIEW] | https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/guide |
| [SUBS] | https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/subscriptions/guide |
| [ENTRIES] | https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/journal-entries/guide |
| [SNAPS] | https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/snapshots/guide |
| [OAUTH] | https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens |
| [AUTH-OV] | https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/overview |
| [REF-CREATE-SUB] | https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/subscriptions/create-subscription |
| [REF-LIST-SUB] | https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/subscriptions/get-subscriptions |
| [REF-BATCH-READ] | https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/journal-entries/aggregate/get-read |
| [REF-EARLIEST] | https://developers.hubspot.com/docs/api-reference/latest/webhooks-journal/journal-entries/aggregate/get-journal-earliest |
| [CHANGELOG] | https://developers.hubspot.com/changelog/spring-2026-spotlight |
| [LEGACY-V4] | https://developers.hubspot.com/docs/api-reference/legacy/webhooks/webhooks-journal |

Tip: add `.md` to any docs URL to get clean markdown (for example `.../webhooks-journal/guide.md`).
The OpenAPI JSON files listed in `llms.txt` (`/docs/specs/2026-09/webhooks-journal-webhooks-journal-v2026-09.json`) return **404**. But each API reference page embeds the OpenAPI snippet, so use those.

---

## 1. Which version to use

- **Current: `2026-09`.** The `latest` docs pages are 2026-09. A `2026-03` copy also exists with the same paths, just with `2026-03` in them. [ENTRIES], https://developers.hubspot.com/docs/api-reference/2026-03/webhooks-journal/journal-entries/guide
- **`v4` is legacy.** `/webhooks-journal/journal/v4/...` lives under `api-reference/legacy/`. Our rule: no v4 APIs. [LEGACY-V4]
- The spring 2026 changelog still shows `/webhooks/v4/journal/batch/...` paths. Ignore those; they are the old beta names. [CHANGELOG]
- Our code uses one constant `JOURNAL_VERSION = '2026-09'` in `service/src/hubspot/journal.ts`, so we can switch it in one place.

## 2. Auth: client credentials token

- Endpoint: `POST https://api.hubapi.com/oauth/2026-09/token`, body `application/x-www-form-urlencoded`. [OVERVIEW] [OAUTH]
- Params: `grant_type=client_credentials`, `client_id`, `client_secret`, `scope` (space-separated, at least one valid scope). [OAUTH]
- Response: `{ "token_type": "bearer", "access_token": "...", "expires_in": 1800 }`. **No refresh token.** Just ask for a new one. Token lives 30 minutes. [OAUTH]
- Token is **app-level** (not for one customer). Today the journal is the only feature that uses it. [AUTH-OV]
- Scopes: [OVERVIEW]
  - `developer.webhooks_journal.read`: read journal
  - `developer.webhooks_journal.subscriptions.read`: list subscriptions and filters
  - `developer.webhooks_journal.subscriptions.write`: create, delete subscriptions and filters
  - `developer.webhooks_journal.snapshots.read`
  - `developer.webhooks_journal.snapshots.write`
- You **also** need the CRM read scopes for the objects you subscribe to (for example `crm.objects.contacts.read`). These must be granted by the customer's install. [OVERVIEW]
- HubSpot surprise: the docs examples use both `api.hubapi.com` ([OVERVIEW]) and `api.hubspot.com` ([OAUTH]). We use `api.hubapi.com`.
- Whether the `developer.webhooks_journal.*` scopes must also be listed in `app-hsmeta.json` is **not documented**. See open questions.

## 3. Endpoints (all confirmed on the 2026-09 docs)

Base URL `https://api.hubapi.com`. Token: client credentials for every row.

### Subscriptions (50 req/s per app)

| Method | Path | Scope | Source |
|---|---|---|---|
| POST | `/webhooks-journal/subscriptions/2026-09` (create **or update**, it's an "upsert") | `...subscriptions.write` | [SUBS] [REF-CREATE-SUB] |
| GET | `/webhooks-journal/subscriptions/2026-09` (all subs, no paging) → `{ results: [...] }` | `...subscriptions.read` | [SUBS] [REF-LIST-SUB] |
| DELETE | `/webhooks-journal/subscriptions/2026-09/{subscriptionId}` → 204 | `...subscriptions.write` | [SUBS] |
| DELETE | `/webhooks-journal/subscriptions/2026-09/portals/{portalId}` → 204 (all subs for one account) | `...subscriptions.write` | [SUBS] |
| POST | `/webhooks-journal/subscriptions/2026-09/filters` → `{ filterId }` | `...subscriptions.write` | [SUBS] |
| GET | `/webhooks-journal/subscriptions/2026-09/filters/{filterId}` | `...subscriptions.read` | [SUBS] |
| GET | `/webhooks-journal/subscriptions/2026-09/filters/subscription/{subscriptionId}` | `...subscriptions.read` | [SUBS] |
| DELETE | `/webhooks-journal/subscriptions/2026-09/filters/{filterId}` → 204 | `...subscriptions.write` | reference page (the guide wrongly says GET) |

Note: "Update event subscriptions in batch" (`POST /app-webhooks/2026-09/{appId}/subscriptions/batch/update`) is listed in the same docs section but belongs to **classic** webhooks, not the journal.

### Journal: global (all portals, 100 req/s per app)

| Method | Path | Returns | Source |
|---|---|---|---|
| GET | `/webhooks-journal/journal/2026-09/earliest` | one `JournalFetchResponse` | [ENTRIES] [REF-EARLIEST] |
| GET | `/webhooks-journal/journal/2026-09/latest` | one `JournalFetchResponse` | [ENTRIES] |
| GET | `/webhooks-journal/journal/2026-09/offset/{offset}/next` | one `JournalFetchResponse` | [ENTRIES] |
| POST | `/webhooks-journal/journal/2026-09/batch/read` body `{ inputs: [offset, ...] }` | batch response (200 or 207) | [ENTRIES] [REF-BATCH-READ] |
| GET | `/webhooks-journal/journal/2026-09/batch/{offset}/next/{count}` | batch response | [ENTRIES] (curl example) |
| GET | `/webhooks-journal/journal/2026-09/batch/earliest/{count}` | batch response | [ENTRIES] |
| GET | `/webhooks-journal/journal/2026-09/batch/latest/{count}` | batch response | [ENTRIES] |
| GET | `/webhooks-journal/journal/2026-09/status/{statusId}` | snapshot status | [ENTRIES] |

All take an optional `installPortalId` query param (filter to one account). Scope: `developer.webhooks_journal.read`.

### Journal: local (one portal)

Same shapes, path prefix `/webhooks-journal/journal-local/2026-09/...`: `earliest`, `latest`, `offset/{offset}/next`, `status/{statusId}`, `batch/earliest/{count}`, `batch/latest/{count}`, `batch/read`. Pass `installPortalId`. [ENTRIES] and the "Local journal" reference pages.

For our design (one worker for all customers) we use the **global** journal.

### Snapshots (10 req/s per app; not needed for v1)

| Method | Path | Scope | Source |
|---|---|---|---|
| POST | `/webhooks-journal/snapshots/2026-09/crm` | `...snapshots.write` | [SNAPS] |
| GET | `/webhooks-journal/snapshots/2026-09/crm/status/{snapshotStatusId}` | `...snapshots.read` | [SNAPS] |

Status is async: `PENDING`, `IN_PROGRESS`, then `SUCCESS` / `FAILED` / `EXPIRED`. A 404 right after creating is normal; keep polling. [SNAPS]

## 4. Subscription body

### ASSOCIATION subscription (what we need)

From [SUBS], verbatim:

```json
{
  "objectTypeId": "0-1",
  "subscriptionType": "ASSOCIATION",
  "portalId": 12345,
  "actions": ["ASSOCIATION_ADDED", "ASSOCIATION_REMOVED"],
  "objectIds": [1001, 1002, 1003],
  "associatedObjectTypeIds": ["0-2"]
}
```

- `portalId` is **required**. So subscriptions are **per customer account**: one call per portal per object pair. [SUBS]
- The OpenAPI schema marks `objectIds` as **required** for ASSOCIATION. We send `objectIds: []` to mean "all records". Not stated in the docs; Test 1 must confirm empty means "all". [REF-CREATE-SUB]
- `associatedObjectTypeIds` is an array, so one sub can cover e.g. Deal → Contact **and** Company. [SUBS]
- The response has `id`, `appId`, `createdAt`, `updatedAt`. Store `id` so we can delete it later. [SUBS]
- The endpoint is called "Upsert subscription". The docs don't say which fields decide "same subscription". See open questions. [REF-CREATE-SUB]
- Subscription filters (`CRM_OBJECT_PROPERTY` conditions) only work on CREATE/UPDATE subscriptions (`FILTER_UNSUPPORTED_SUBSCRIPTION_ACTION`). They **can't** filter association events by label. [SUBS]
- Important warning from [OVERVIEW]: these subscriptions are "install-specific" and are **managed by API only**. You can't declare them in the project's `webhooks` feature files.

### APP_LIFECYCLE_EVENT subscription (install/uninstall)

From [SUBS], verbatim:

```json
{
  "subscriptionType": "APP_LIFECYCLE_EVENT",
  "eventTypeId": "4-1909196",
  "properties": ["string"]
}
```

- `4-1909196` = app install, `4-1916193` = app uninstall. One subscription per event type. [SUBS]
- **No `portalId`**. This is app-level: create it once for the whole app. [REF-CREATE-SUB]
- The API also lists `LIST_MEMBERSHIP`, `OBJECT`, `GDPR_PRIVACY_DELETION` (and `EVENT` in responses). [REF-CREATE-SUB]

## 5. Reading the journal: how it works

Reading the journal is **two steps**:

1. Call a journal endpoint. You get back a **pre-signed file URL**, not events: [ENTRIES]
   ```json
   {
     "url": "https://s3.amazonaws.com/bucket/path/to/journal/file.json",
     "expiresAt": "2024-01-01T12:00:00Z",
     "currentOffset": "550e8400-e29b-41d4-a716-446655440000"
   }
   ```
2. Download the `url` with a plain GET (**no** Authorization header; it's a signed S3 link). The file holds one journal entry: `{ offset, journalEvents: [...], publishedAt }`. [OVERVIEW]

Facts:

- **Offset** is a UUID (looks like UUIDv7, so time-ordered). `currentOffset` is the offset of the entry you just got. To move forward, call `.../offset/{currentOffset}/next`. [ENTRIES]
- One journal entry (one file) can hold **several** `journalEvents`. [OVERVIEW]
- **Ordering:** "historical event data stored in chronological order"; process "in chronological order using the offset system". [ENTRIES] [OVERVIEW]
- **Retention: 3 days.** [ENTRIES]
- **URL expiry:** `expiresAt` per URL. "Download files promptly." [OVERVIEW]
- **Batch:** max **100** entries per batch call; more gives `400` / `VALIDATION_ERROR`. [ENTRIES] [CHANGELOG]
- **Batch next:** "Entries *after* the specified offset are returned in order, so the latest entry can be used as the offset for the next batch." [ENTRIES]
- Batch response (verbatim from [ENTRIES]):
  ```json
  {
    "status": "COMPLETE",
    "startedAt": "2024-01-01T12:00:00.000Z",
    "completedAt": "2024-01-01T12:00:00.123Z",
    "results": [
      {
        "url": "https://s3.amazonaws.com/bucket/path/to/journal.json",
        "expiresAt": "2024-01-01T13:00:00.000Z",
        "currentOffset": "550e8400-e29b-41d4-a716-446655440000"
      }
    ],
    "numErrors": 0,
    "errors": []
  }
  ```
  Partial failures give HTTP **207** with `errors[]`. The failed offset is in `errors[i].context.offset[0]`. Error statuses: `NOT_FOUND`, `PRESIGNING_ERROR` (retry may work), `VALIDATION_ERROR`. [ENTRIES]
- Batch endpoints skip the normal daily and per-second limits, but still count against the journal's 100 req/s. [ENTRIES]
- **How "no new entries" is signalled is NOT documented.** The reference pages for earliest/latest/next show only a `default: Error` response, no 200 schema. Our code treats 204, 404, an empty body, or `results: []` as "empty". Test 0 must record what really happens.

## 6. Journal event shapes (verbatim from [OVERVIEW])

### Association added

```json
{
  "offset": "0198199f-f454-7ee4-9766-779433c4864d",
  "journalEvents": [
    {
      "type": "association",
      "portalId": 145534986,
      "occurredAt": "2025-07-17T18:22:49.134Z",
      "action": "ASSOCIATION_ADDED",
      "fromObjectId": 11073740013,
      "toObjectId": 11073740016,
      "fromObjectTypeId": "2-134027637",
      "toObjectTypeId": "2-134027637",
      "associationTypeId": 17,
      "associationCategory": "USER_DEFINED",
      "isPrimary": false
    }
  ]
}
```

(This example has no `publishedAt`; the other examples do.)

### Contact update (for reference)

```json
{
  "offset": "0198197a-f0ac-7906-8bfe-a569398704ac",
  "journalEvents": [
    {
      "type": "crmObject",
      "portalId": 145534986,
      "occurredAt": "2025-07-17T17:42:23.540Z",
      "action": "UPDATE",
      "objectTypeId": "0-1",
      "objectId": 11073740016,
      "propertyChanges": {
        "lastname": "smith"
      }
    }
  ],
  "publishedAt": "2025-07-17T17:42:24.173Z"
}
```

### App install

```json
{
  "offset": "01983883-ee94-71df-8c20-9f3cbf039015",
  "journalEvents": [
    {
      "type": "app_lifecycle_event",
      "occurredAt": "2025-07-23T18:20:23.719Z",
      "action": "APP_INSTALL",
      "portalId": 123456,
      "eventTypeId": "4-1909196",
      "properties": {
        "hs_app_id": 1234567,
        "hs_app_install_level": "PORTAL",
        "hs_initiating_user_id": 987654321,
        "hs_user_id": 12345
      }
    }
  ],
  "publishedAt": "2025-07-23T18:20:27.196Z"
}
```

What the association event has:

- `associationTypeId` (number): yes. Map it to a label name with the associations labels API.
- `associationCategory`: yes (`USER_DEFINED` in the example; we expect `HUBSPOT_DEFINED` for the default unlabeled type).
- `occurredAt`: yes (ms precision). `publishedAt` sits on the entry, not the event.
- `isPrimary`: yes.
- `portalId`: yes, on every event.
- **No user / source field** (no `sourceId`, no `changeSource`). "Who made the change" is not in the docs. "Who made the change" is planned as a later feature.
- The example is a custom object → custom object association (`2-...`) with a `USER_DEFINED` label. Good sign for Test 1. Still has to be tested.
- One action → one direction or both? Not documented. Test 1 must check.

## 7. Rate limits [OVERVIEW] [SUBS] [ENTRIES]

- Journal API: **100 req/s per app** (confirmed)
- Subscriptions API: **50 req/s per app** (confirmed)
- Snapshots API: **10 req/s per app** (confirmed)
- 429 comes with `Retry-After`. These are separate from normal HubSpot limits. "Subject to change." `service/src/lib/http.ts` already respects `Retry-After`.

## 8. Errors [OVERVIEW]

```json
{
  "status": "error",
  "message": "Invalid subscription type provided",
  "correlationId": "550e8400-e29b-41d4-a716-446655440000",
  "category": "VALIDATION_ERROR"
}
```

---

## Open questions / doc inconsistencies

1. **Batch path text vs example.** In [ENTRIES] the prose says `POST /webhooks/2026-09/journal/batch/read` and `GET /webhooks/2026-09/journal/batch/{offset}/next/{count}`. But the curl examples **and** the reference page use `/webhooks-journal/journal/2026-09/batch/...`. We use `/webhooks-journal/journal/2026-09/...` (matches the OpenAPI). If it 404s, try the other one.
2. **2026-03 guide typo:** batch latest is shown as `/webhooks-journal/journal/2026-03/batch/2026-03/{count}`. Clearly should be `batch/latest/{count}`.
3. **No reference page** (no OpenAPI) for the global `latest`, `offset/{offset}/next`, `batch/{offset}/next/{count}`, `batch/earliest/{count}`, `batch/latest/{count}`. They are only in the guide. Local versions do have reference pages.
4. **Empty journal signal** undocumented (see section 5). Record it in Test 0.
5. **Is `currentOffset` the offset of the returned entry, or the next one?** Guide says use it for `next`. The batch guide says "the latest entry can be used as the offset for the next batch". We assume it's the returned entry's offset; the file's own `offset` field should match. Check in Test 0.
6. **`objectIds: []` means "all records"?** Required by the schema, not explained. Test 1.
7. **Upsert key.** POST is "create or update". Which fields make two subs "the same" (portal + objectTypeId + subscriptionType?) is unknown. Test by posting the same body twice and listing.
8. **Journal scopes in `app-hsmeta.json`?** Not documented. The scopes docs only cover the install scopes. A community thread (https://community.hubspot.com/t/request-for-webhooks-journal-v4-beta-access-for-a-public-marketplace-app/159833, could not open, 403) reportedly had a `400 BAD_CLIENT_ID` on the client credentials grant and was told the GA endpoints work with no special access. Safest first try: request the token without changing the app's scopes. If it fails, ask the owner before adding scopes (project rule).
9. **Does a subscription only fire one direction?** Our sub has `objectTypeId` = 2-xxx and `associatedObjectTypeIds` = [0-1]. Do we also need the reverse sub (0-1 → 2-xxx), or do we get both `from/to` events? Test 1.
10. **Label edits** (Test 2): no docs mention what a label change looks like.
11. **URL lifetime** (`expiresAt`): actual length unknown. Note it in Test 0.
12. **Snapshot status:** two places. Journal guide has `/webhooks-journal/journal/2026-09/status/{statusId}`; snapshots guide has `/webhooks-journal/snapshots/2026-09/crm/status/{id}`. Changelog has `/webhooks/v4/snapshots/status/{statusId}`. Not needed for v1.
13. **Filter delete** method: guide says `GET`, reference page says `DELETE`. Use `DELETE`.
14. Subscriptions guide title says "(2026.03)" but the content is 2026-09. Cosmetic.
