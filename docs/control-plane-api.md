# FENVIX control-plane API

This is the HTTP API the dashboard needs. Each method of `DataClient` (`src/data/client.ts`) and `SessionClient` (`src/session/client.ts`) maps to exactly one endpoint below. The TypeScript types in `src/data/types.ts` and `src/session/client.ts` are the source of truth for the JSON shapes; they are copied here so the engine team does not need the front-end code.

The dashboard ships with three implementations of `DataClient`, picked in `src/data/index.ts`: a mock (`VITE_DATA_BACKEND=mock`), the control plane over HTTP (`src/data/api-http.ts`, whenever `VITE_API_URL` is set) and the Supabase functions (otherwise). The HTTP one uses the endpoints below; see "The dashboard on the control plane" at the end for what it adds (operations, idempotency, errors). The Supabase one does not use them; see "Running on Supabase" for how each method maps onto database functions and where its behaviour differs.

## Conventions

- Base URL `https://api.fenvix.dev/v1`. JSON in, JSON out, UTF-8. All JSON property names are camelCase, exactly as in the TypeScript types.
- Times are ISO 8601 strings in UTC (`2026-10-26T12:00:00Z`). Months are `YYYY-MM`.
- Authentication: the dashboard sends the session cookie set by the sign-in endpoints (section 3), `SameSite=Lax`, `HttpOnly`, `Secure`. Scripts send `Authorization: Bearer <API key>`. Every endpoint except those in section 3 needs one of them. All data is scoped to the caller's workspace.
- A tag is a string `key:value`. Keys and values match `^[a-z0-9][a-z0-9._-]{0,39}$`. A database has at most 20 tags and one value per key.
- Mutating requests accept an optional `Idempotency-Key` header. Repeating a request with the same key within 24 hours returns the first response.

### Pagination

List endpoints take `page` (from 1, default 1) and `pageSize` (default 50, maximum 200) and answer with:

```json
{ "items": [], "total": 2988, "page": 1, "pageSize": 50 }
```

`total` is the number of matching rows over all pages. A page beyond the last one returns `items: []`. Sorting is stable: ties are broken by `name`, then `id`.

### Errors

Any non-2xx answer has this body:

```json
{ "error": { "code": "validation_failed", "message": "A database named acme-prod-01 already exists.", "field": "name" } }
```

`message` is written for people and is shown in the dashboard as is. `field` is optional.

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `validation_failed` | Body or query is malformed or breaks a rule (name format, tag format, date out of range). |
| 401 | `unauthenticated` | No valid session or API key. The dashboard shows the sign-in page. |
| 403 | `forbidden` | Signed in, but not allowed to do this. |
| 404 | `not_found` | The id does not exist in this workspace. |
| 409 | `conflict` | The name is taken, or the database is busy (for example being restored). |
| 429 | `rate_limited` | Too many requests. `Retry-After` gives seconds. |
| 500 | `internal` | Unexpected failure. Safe to retry reads. |

### Shared shapes

```ts
type DbState = "awake" | "asleep";

interface Database {
  id: string;
  name: string;
  state: DbState;
  storageMb: number;
  requests24h: number;
  lastActiveAt: string;
  createdAt: string;
  region: string;
  host: string;
  /** mongodb://app_user:<password>@<name>.db.fenvix.dev:27017/<db>?tls=true */
  connectionString: string;
  tags: string[];
  keepAwake: boolean;
  forkedFrom: string | null;
  restoredTo: string | null;
}

/** Filter used by list, ids, groups. All parts combine with AND. */
interface DatabaseFilter {
  search?: string;       // case-insensitive substring of the name
  state?: DbState;
  keepAwake?: boolean;
  tags?: string[];       // "key:value" exact, "key" any value, "!key" key absent
}

interface ExportResult { filename: string; mimeType: string; downloadUrl: string }  // downloadUrl valid for 15 minutes
interface BulkResult { affected: number }
```

In query strings the filter is `search`, `state`, `keepAwake=true|false` and repeated `tag` parameters (`?tag=customer:acme-labs&tag=env:prod`). In request bodies it is the JSON object above.

---

## 1. Data: databases

### `listDatabases` — `GET /databases`

Query: the filter above, plus `sort` (`name | state | keepAwake | storageMb | requests24h | lastActiveAt`, default `lastActiveAt`), `dir` (`asc | desc`, default `desc`), `page`, `pageSize`.

Response `200`: `{ "items": Database[], "total", "page", "pageSize" }`.

```json
{
  "items": [
    {
      "id": "db_0013", "name": "acme-labs-prod-01", "state": "asleep", "storageMb": 412,
      "requests24h": 18, "lastActiveAt": "2026-10-25T09:14:00Z", "createdAt": "2026-03-02T08:00:00Z",
      "region": "eu-west", "host": "acme-labs-prod-01.db.fenvix.dev",
      "connectionString": "mongodb://app_user:<password>@acme-labs-prod-01.db.fenvix.dev:27017/acme_labs_prod_01?tls=true",
      "tags": ["customer:acme-labs", "env:prod"], "keepAwake": false, "forkedFrom": null, "restoredTo": null
    }
  ],
  "total": 2988, "page": 1, "pageSize": 50
}
```

### `listDatabaseIds` — `GET /databases/ids`

Query: the filter. Used by "select all matching". Response `200`: `{ "ids": string[] }`. Capped at 10,000 ids; over the cap the answer is `400 validation_failed` asking for a narrower filter.

The dashboard's client method returns the `ids` array.

### `groupDatabases` — `GET /databases/groups`

Query: `groupBy` (a tag key, required) plus the filter. Counts matching databases per value of that key.

Response `200`:

```json
{
  "groupBy": "customer",
  "total": 3000,
  "groups": [
    { "value": "acme-labs", "count": 154, "awake": 9, "keepAwake": 2, "storageMb": 150912 },
    { "value": null, "count": 3, "awake": 0, "keepAwake": 0, "storageMb": 120 }
  ]
}
```

Groups are sorted by `count` descending, then `value`. `value: null` is the group of databases without the key and comes last. To list the databases of a group, call `listDatabases` with the tag `customer:acme-labs`, or `!customer` for the null group.

### `listTags` — `GET /tags`

Every tag in use in the workspace. Response `200`: `{ "items": [{ "key": "customer", "value": "acme-labs", "count": 154 }] }`, sorted by key, then count descending. Not paginated (a workspace has at most a few thousand distinct tags); the client method returns `items`.

### `getDatabase` — `GET /databases/{id}`

Response `200`: `Database`. `404 not_found` if missing (the client method turns this into `null`).

### `listRegions` — `GET /regions`

Response `200`: `{ "items": ["eu-west", "us-east", "us-west", "ap-south"] }`.

### `createDatabase` — `POST /databases`

```json
{ "name": "acme-labs-prod-02", "region": "eu-west", "tags": ["customer:acme-labs", "env:prod"] }
```

`name`: 3 to 48 characters, `^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$`, unique in the workspace (case-insensitive). The database starts asleep.

Response `201`: `Database` (includes `connectionString`). Errors: `400` bad name, region or tags; `409` name taken.

### `forkDatabase` — `POST /databases/{id}/fork`

```json
{ "name": "acme-labs-prod-01-fork" }
```

Instant copy-on-write copy with the same region and tags, starting asleep, `forkedFrom` set to the source id. Same name rules as create. Response `201`: `Database`. Errors: `404`, `400`, `409`.

### `restoreDatabase` — `POST /databases/{id}/restore`

```json
{ "at": "2026-10-20T10:00:00Z" }
```

Rolls the database back in place to `at`. `at` must be after `createdAt` and not in the future, within the retention window. Response `200`: updated `Database` with `restoredTo` set. Errors: `400` (out of range), `404`, `409` (a restore is already running).

### `exportDatabases` — `POST /databases/export`

```json
{ "ids": ["db_0001", "db_0007"] }
```

Prepares one file with the data of all listed databases (1 to 100 ids). Response `200`: `ExportResult`. For large databases the server may answer `202` with the same shape once the file is ready; the dashboard only needs the final `ExportResult`.

### `eraseDatabases` — `POST /databases/erase`

```json
{ "ids": ["db_0001", "db_0007"] }
```

Permanently deletes the databases and their backups. Not reversible. Up to 1,000 ids per call. Response `200`: `{ "affected": 2 }`. Ids that do not exist are skipped, not errors.

### `setKeepAwake` — `POST /databases/keep-awake`

```json
{ "ids": ["db_0001"], "enabled": true }
```

`enabled: true` wakes the databases and stops them from sleeping; `false` lets them sleep when idle. Up to 1,000 ids. Response `200`: `{ "affected": 1 }`.

### `setTags` — `PUT /databases/{id}/tags`

```json
{ "tags": ["customer:acme-labs", "env:staging"] }
```

Replaces the full tag list. Response `200`: updated `Database`. `400` for a bad tag, two values for one key, or more than 20 tags.

### `addTags` — `POST /databases/tags/add`

```json
{ "ids": ["db_0001", "db_0002"], "tags": ["customer:acme-labs"] }
```

Adds the tags to every listed database. If a database already has the key, its value is replaced. Up to 1,000 ids. Response `200`: `{ "affected": 2 }`.

### `removeTags` — `POST /databases/tags/remove`

```json
{ "ids": ["db_0001", "db_0002"], "tags": ["env:dev", "app"] }
```

`key:value` removes that exact tag, a bare `key` removes the key whatever its value. Response `200`: `{ "affected": 2 }`.

### `getUsage` — `GET /databases/{id}/usage`

Query: `range` = `24h | 7d | 30d`. Time series for the chart on the database page, oldest first: 24 hourly points for `24h`, 28 six-hourly points for `7d`, 30 daily points for `30d`.

Response `200`: `{ "items": [{ "at": "2026-10-26T11:00:00Z", "requests": 1204, "storageMb": 4820, "awake": true }] }` (the client method returns `items`). `awake` is true when the database was serving for part of that bucket; the dashboard draws the wake/sleep timeline from it. `404` if the database does not exist.

---

## 2. Data: overview, usage, billing, keys, settings

### `getOverview` — `GET /overview`

Everything the overview page shows. Query: `range` = `24h | 7d | 30d` (required). Buckets are hourly for `24h` and daily otherwise.

```json
{
  "range": "7d",
  "totals": { "databases": 3000, "awake": 247, "asleep": 2753, "asleepPercent": 92, "requests": 220978532, "storageGb": 2616.4, "costMtd": 859.58, "currency": "USD" },
  "sparks": { "databases": [], "awake": [], "requests": [], "storageGb": [], "cost": [] },
  "awakeSeries": [{ "at": "2026-10-20T00:00:00Z", "awake": 212, "total": 2964 }],
  "requestSeries": [{ "at": "2026-10-20T00:00:00Z", "requests": 36783887 }],
  "costSeries": [{ "at": "2026-10-01T00:00:00Z", "cost": 31.4, "reference": 29.8 }],
  "topDatabases": [{ "id": "db_0137", "name": "acme-labs-staging-06", "requests": 1301884 }],
  "recentWakeUps": [{ "id": "db_0137", "name": "acme-labs-staging-06", "at": "2026-10-26T11:58:00Z", "latencyMs": 571 }]
}
```

`sparks` holds up to 12 plain numbers per measure, oldest first, for the small trend lines on the number cards. `costSeries` always covers the current month by day: `cost` is the running total this month (0 for days that have not happened), `reference` the same running total one month earlier, or null when that month was shorter. `topDatabases` is the ten busiest over the last 24 hours, `recentWakeUps` the last eight databases that woke from sleep.

### `getTagBreakdown` — `GET /tags/breakdown`

Query: `key` (a tag key, required), `limit` (default 8, maximum 50). Biggest first by requests.

Response `200`: `{ "items": [{ "value": "acme-labs", "databases": 154, "storageGb": 125.18, "requests": 2644216 }] }`. Databases without the key are grouped under the value `(none)`.

### `listUsageMonths` — `GET /usage/months`

Months that have a report, newest first. The newest is the current, still running month. Response `200`: `{ "items": ["2026-10", "2026-09"] }`.

### `getUsageReport` — `GET /usage`

Storage and requests for one month, so the customer can bill their own customers.

Query:

| Parameter | Meaning |
| --- | --- |
| `month` | `YYYY-MM`, required. |
| `by` | `database` or `tag`, required. |
| `tagKey` | With `by=tag`: total up one key (`customer`). Without it, one row per `key:value` tag. Databases without the key form a row named `key:(none)`. |
| `sort` | `name | databases | storageGb | requests`, default `requests`. (`databases` only with `by=tag`.) |
| `dir` | `asc | desc`, default `desc`. |
| `page`, `pageSize` | As in Pagination. |

Response `200`:

```json
{
  "month": "2026-10", "page": 1, "pageSize": 50, "total": 200,
  "totals": { "databases": 3000, "storageGb": 2646.25, "requests": 668825953 },
  "items": [
    { "id": "customer:acme-labs", "name": "customer:acme-labs", "tags": [], "databases": 154, "storageGb": 147.37, "requests": 34100210 }
  ]
}
```

With `by=database`, `id` is the database id, `name` its name, `tags` its tags and `databases` is 1. `storageGb` is the average storage over the month (for the running month, up to now). `totals` covers every database, not only this page; a database with several tags counts once in `totals`, but once per tag in the rows when `by=tag` without `tagKey`.

`400` if `month` has no report.

### `exportUsageReport` — `GET /usage/export`

Same query as `getUsageReport` without `page` and `pageSize`. Returns all rows as a CSV file. Response `200`: `ExportResult` with `mimeType: "text/csv"`.

CSV header: `database,tags,storage_gb_avg,requests` for `by=database` (tags separated by spaces) and `tag,databases,storage_gb_avg,requests` for `by=tag`. UTF-8, `\n` line ends, fields containing a comma, quote or newline are quoted with doubled quotes.

### `getUsageHistory` — `GET /usage/history`

Totals per month, oldest first, for the trend lines on the usage page.

Response `200`: `{ "items": [{ "month": "2026-05", "databases": 2103, "storageGb": 1712.4, "requests": 611204331 }] }`.

### `getUsageTrend` — `GET /usage/trend`

Query: `month` (`YYYY-MM`) and `tagKey`. Daily requests of that month split over the five biggest values of the key, with the rest added up as `Other`.

```json
{
  "days": ["2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"],
  "series": [
    { "label": "acme-labs", "values": [2409133, 2502881] },
    { "label": "Other", "values": [19782260, 20553119] }
  ]
}
```

Every `values` array is the same length as `days`.

### `listPlans` — `GET /plans`

Response `200`: `{ "items": [{ "id": "managed", "name": "Managed", "price": "$29", "period": "/ month", "description": "…", "features": ["…"], "current": true }] }`. `price` and `period` are ready to display; exactly one plan has `current: true`.

### `getBilling` — `GET /billing`

What the customer pays FENVIX.

```json
{
  "currency": "USD",
  "plan": { "name": "Pay as you go", "description": "No base fee. You pay for the storage and requests of your databases, billed monthly." },
  "monthToDate": {
    "periodLabel": "October 1 to 26, 2026",
    "lines": [
      { "label": "Storage", "quantity": "2,219.44 GB-months", "rate": "$0.25 per GB-month", "cost": 554.86 },
      { "label": "Requests", "quantity": "668,825,953 requests", "rate": "$0.40 per million", "cost": 267.53 }
    ],
    "total": 822.39
  },
  "paymentMethod": { "brand": "Visa", "last4": "4242", "expires": "08/2028" }
}
```

Amounts are decimal numbers in `currency`; text fields (`periodLabel`, `quantity`, `rate`) are ready to display.

### `listInvoices` — `GET /invoices`

Paginated (default `pageSize` 12), newest first. Response `200`: `Page<Invoice>`:

```json
{ "items": [{ "id": "inv_2026-09", "number": "FNX-2026-09", "month": "2026-09", "issuedAt": "2026-10-01T00:00:00Z", "amount": 885.14, "currency": "USD", "status": "paid" }], "total": 5, "page": 1, "pageSize": 12 }
```

`status` is `paid` or `open`.

### `downloadInvoice` — `POST /invoices/{id}/download`

Response `200`: `ExportResult` with `mimeType: "application/pdf"`. `404` if missing.

### `listApiKeys` — `GET /api-keys`

Response `200`: `{ "items": ApiKey[] }`, newest first. Not paginated (a workspace has few keys).

```json
{ "items": [{ "id": "key_1", "name": "Production backend", "hint": "a91f", "createdAt": "2026-07-28T12:00:00Z", "lastUsedAt": "2026-10-26T11:56:00Z", "revokedAt": null }] }
```

`hint` is the last 4 characters of the secret.

### `createApiKey` — `POST /api-keys`

Body `{ "name": "CI pipeline" }` (1 to 60 characters). Response `201`: `{ "key": ApiKey, "secret": "fnx_..." }`. The secret is returned only here.

### `revokeApiKey` — `POST /api-keys/{id}/revoke`

Response `200`: the `ApiKey` with `revokedAt` set. Revoking twice is not an error. `404` if missing.

### `getSettings` — `GET /settings`

Response `200`: `{ "workspaceName": "Acme", "idleMinutes": 5, "emailNotices": true }`. `idleMinutes` is one of 1, 5, 15, 60.

### `saveSettings` — `PUT /settings`

Body: the full object above. Response `200`: the saved settings. `400` if `workspaceName` is empty or longer than 60 characters, or `idleMinutes` is not allowed.

---

## 3. Session (sign-in)

These endpoints need no session. Sessions are cookies; the dashboard never sees a token.

```ts
interface SessionUser { id: string; name: string; email: string; avatarUrl?: string | null }
```

`avatarUrl` is the picture the provider gave, if any.

### `getSession` — `GET /session`

Response `200`: `SessionUser`, or `401 unauthenticated` when signed out (the client method returns `null`). Called once on page load.

### `signInWithProvider` — `POST /session/providers/{provider}`

`provider` is `github` or `google`. Body: `{ "returnTo": "https://app.fenvix.dev/overview" }`.

Response `200`: `{ "redirectUrl": "https://github.com/login/oauth/authorize?..." }`. The client navigates the browser to `redirectUrl`. The provider sends the user back to the API callback (`GET /session/providers/{provider}/callback`, handled by the server only), which sets the session cookie and redirects to `returnTo`. On return the dashboard calls `getSession`. A cancelled or failed sign-in redirects to `returnTo` with `?error=sign_in_failed`.

### `requestEmailLink` — `POST /session/email-link`

Body: `{ "email": "you@company.com" }`. Sends a one-time link that opens `https://app.fenvix.dev/?code=...`. Response `202`: `{}`. The answer is the same whether or not the address has an account. Rate limit: 5 links per address per hour (`429`). `400` for a malformed address. The link works once and expires after 15 minutes.

### `completeEmailLink` — `POST /session/email-link/complete`

Body: `{ "token": "..." }`. Response `200`: `SessionUser`, and the session cookie is set. `400 validation_failed` with the message "This sign-in link has expired. Request a new one." for a used, expired or unknown token.

The emailed link points at `https://app.fenvix.dev/?token=<token>`. The dashboard reads the token out of the URL, calls this endpoint, drops the token from the address bar and shows the workspace.

### `signOut` — `DELETE /session`

Ends the session and clears the cookie. Response `204`. Signing out when already signed out is also `204`.


---

## The dashboard on the control plane

`src/data/api-http.ts` implements every `DataClient` method with the endpoint of the same name above, with the
session token of the signed-in person as `Authorization: Bearer`, the chosen organization as `X-Fenvix-Workspace`,
and the error handling shared with the Data, Users, Network and organization screens (`src/data/http.ts`).
Where the service goes beyond this contract (see `control-plane/docs/api-extensions.md`), the dashboard does this:

- **Operations.** Create, fork, restore, export and erase may answer `202 { "operation": { id, status, ... } }`
  instead of their result. The client then polls `GET /operations/{id}` (every 1.5 s, up to 10 minutes) until
  `status` is `succeeded` (the result is in `result`) or `failed` (the reason is in `error.message`, shown as is).
  The screens show the state on the way: sending, queued, in progress, done, or the reason it failed.
- **Idempotency.** Every `POST` and `PUT` carries a new `Idempotency-Key` per action. When the answer is lost
  (network error, 502, 503, 504) the same request is sent again with the same key, at most twice.
- **The initial password** of a create or fork is shown only when the first answer (`201`) carries
  `initialUser.password`. After a `202`, a replay or a poll it is `null`, and the screen says to reset the password
  in the Users tab.
- **Errors.** The server's `error.message` is shown as is. An answer without one (a proxy page, an empty body) gets a
  sentence for its status: 401 "Your session has ended. Sign in again.", 403, 404, 409, 422, 429 and 5xx likewise.
- **VITE_API_URL** includes `/v1` (`https://api.fenvix.dev/v1`); a bare host gets `/v1` added.

---

## Running on Supabase

`src/data/supabase.ts` and `src/session/supabase.ts` implement the two interfaces on Supabase. Every data
method is one call to a Postgres function (`supabase/migrations/0001_init.sql`), so each change is a single
transaction, and the functions run as the signed-in user under row level security.

| Client method | Database function |
| --- | --- |
| `listDatabases` | `fenvix_list_databases` |
| `listDatabaseIds` | `fenvix_database_ids` |
| `groupDatabases` | `fenvix_group_databases` |
| `listTags` | `fenvix_list_tags` |
| `getDatabase` | `fenvix_get_database` |
| `getOverview` | `fenvix_overview` |
| `getTagBreakdown` | `fenvix_tag_breakdown` |
| `getUsageTrend` | `fenvix_usage_trend` |
| `createDatabase` | `fenvix_create_database` |
| `forkDatabase` | `fenvix_fork_database` |
| `restoreDatabase` | `fenvix_restore_database` |
| `exportDatabases` | `fenvix_export_databases` |
| `eraseDatabases` | `fenvix_erase_databases` |
| `setKeepAwake` | `fenvix_set_keep_awake` |
| `setTags` / `addTags` / `removeTags` | `fenvix_set_tags` / `fenvix_add_tags` / `fenvix_remove_tags` |
| `getUsage` | `fenvix_usage_series` |
| `listUsageMonths` | `fenvix_usage_months` |
| `getUsageReport` | `fenvix_usage_report` |
| `getUsageHistory` | `fenvix_usage_history` |
| `exportUsageReport` | `fenvix_usage_export` |
| `getBilling` | `fenvix_billing` |
| `listInvoices` / `downloadInvoice` | `fenvix_list_invoices` / `fenvix_get_invoice` |
| `listApiKeys` / `createApiKey` / `revokeApiKey` | `fenvix_list_api_keys` / `fenvix_create_api_key` / `fenvix_revoke_api_key` |
| `getSettings` / `saveSettings` | `fenvix_settings` / `fenvix_save_settings` |
| `listPlans` | the plan catalogue in the client, plus `fenvix_settings` for the current plan |
| `listRegions` | fixed list in the client: `eu-west`, `us-east`, `us-west`, `ap-south` |

Where the behaviour is not what the sections above describe:

- **Ids** are UUIDs, not `db_0001`. A malformed id returns "not found" instead of an error.
- **Rows only.** Fork, restore, erase and the rest change records. Nothing is sent to an engine yet.
- **Limits.** Bulk actions take up to 5,000 ids per call; a page is at most 200 rows (5,000 for the usage export).
- **Exports are built in the browser** from the rows the function returns, and `downloadUrl` is a local `blob:` address, not a hosted file that expires. Invoice PDFs and usage CSVs work the same way.
- **API keys.** The browser makes the key (`fnx_` and 64 hex characters) and sends only its SHA-256 hash and last four characters. The database never sees the key and cannot show it again.
- **Usage history** is whatever is in `usage_daily`; the seed holds 61 days, so `listUsageMonths` returns the current and the previous month. `getUsage` for `24h` reads `usage_hourly` (hourly rows for the last 24 hours), for `7d` and `30d` it reads `usage_daily`.
- **Money** comes from one rate table in `fenvix_rates()`: 0.25 per GB-month of storage and 0.40 per million requests.
- **Tags** allow one value per key; values may contain `a-z`, `0-9`, `.`, `_`, `-`, and `(none)` is reserved for "no value" in usage reports.
- **Workspace.** Each person gets one personal workspace on first sign-in (a trigger on `auth.users`). There is no invitation flow yet; `workspace_members` can hold several users, but only the trigger and the SQL editor can add them.
- **Errors** are the messages raised by the functions (for example "A database named acme-prod-01 already exists."); network, expired-session and permission errors are turned into plain sentences by `friendlyError` in `src/data/queries.ts`.

### Sessions on Supabase

| Client method | Supabase Auth call |
| --- | --- |
| `getSession` | `auth.getSession()` |
| `signInWithProvider('github' \| 'google')` | `auth.signInWithOAuth` with PKCE; the browser is sent to the provider and comes back to the site root with `?code=` |
| `requestEmailLink` | `auth.signInWithOtp` with `emailRedirectTo` set to the site root |
| `completeEmailLink` | `auth.exchangeCodeForSession`; normally the code is exchanged before the app renders (see the README) |
| `signOut` | `auth.signOut()` |
| `subscribe` | `auth.onAuthStateChange` |

The code in the returned URL is exchanged once, the address is cleaned to `/overview`, and a replayed or invalid code is
shown as a message on the sign-in page.
