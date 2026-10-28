# Where this service goes beyond `docs/control-plane-api.md`

The contract is implemented as written (40 endpoints, checked by `tests/integration/contract.test.ts`, which parses the contract document and asserts every method and path is routed). These are the places where the service adds something or makes a choice the contract leaves open.

## Long operations: 202 and polling

Create, fork, restore, export and erase are *operations*: each one is a row in `public.operations` that survives a restart.

* The request waits up to `OPERATION_WAIT_MS` (default 20 s). If the operation finished, the answer is **exactly what the contract says** (`201 Database`, `200 Database`, `200 ExportResult`, `200 { affected }`), and the response has an `Operation-Id` header.
* If it is still going, or waiting for an engine retry, the answer is **`202`** with `{ "operation": { id, kind, status, databaseId, createdAt, updatedAt, finishedAt, result, error } }`, a `Location` header and `Retry-After: 2`. The contract allows `202` for export; for the others the dashboard would need to handle it. Poll:
* `GET /v1/operations/{id}` -> the operation. `status` is `queued`, `running`, `succeeded` or `failed`. `result` is the same body the synchronous answer would have had (for export, with a freshly made 15-minute link on every read). `error` is `{ code, message, field? }` with the contract's codes.
* `GET /v1/operations?status=&page=&pageSize=` -> the workspace's operations, newest first.

A database being created or forked is invisible (lists, `GET /databases/{id}`, usage) until its engine call succeeds, but its name is already taken. If the engine fails for good, the row is removed and the name is free again.

## Idempotency

* `Idempotency-Key` (1 to 255 visible characters) on any `POST`/`PUT`. Keys are per workspace and last 24 hours. Same key and same request: the first answer again, with `Idempotent-Replay: true`. Same key and a different request: `409 conflict`. Same key while the first request is still running: `409 conflict` ("still running").
* A `400` does not use the key up (fix the body, retry with the same key). `403`, `404` and `409` answers are remembered; `5xx` and `429` free the key.
* For operations the record keeps only the operation id, so a replay shows the operation's *current* state (and a fresh export link).
* `POST /api-keys` never replays: the secret is not stored anywhere, so a retry with the same key answers `409` ("cannot be shown a second time").
* Without a key, retries are still safe: create and fork find the running operation with the same name; a second create after success is `409 name taken`; erase of ids that are gone is `{ "affected": 0 }`; restore to the same time while one runs returns the running one, to a different time is `409`.

## Who may do what

The contract only has `403 forbidden` ("signed in, but not allowed"). The rules are:

| Caller | Allowed |
| --- | --- |
| Workspace `owner` / `admin` (cookie session) | everything |
| Workspace `member` | everything except erase, API keys and saving settings |
| API key | everything except API keys and saving settings (a stolen key cannot mint more keys) |

Only `owner` exists today (the sign-up trigger makes each person an owner of their own workspace); `workspace_members` can hold the others.

## Downloads

`downloadUrl` for the usage CSV and invoice PDFs is `API_PUBLIC_URL/downloads/<token>`: a signed, 15-minute link (HMAC with `DOWNLOAD_SIGNING_KEY`) that carries the workspace and what to build. `GET /v1/downloads/{token}` needs no session; the file is built when it is opened. Database exports are the engine's: the link comes from `EngineClient.exportDownloadUrl`.

## Smaller choices

* Names are trimmed and lowercased before the contract's rule is applied, like the dashboard's own SQL does.
* `getUsage`: `24h` = 24 hourly, `7d` = 28 six-hourly (UTC 00/06/12/18), `30d` = 30 daily buckets; empty buckets are zero points, so the counts are always exact. `7d` needs hourly rows for seven days; the usage sync keeps `HOURLY_RETENTION_DAYS` (default 8). The seed only has two days of hourly rows, so on seed data the six-hourly chart is mostly empty.
* `sparks` are the last (at most 12) values of the matching series, evenly sampled when longer; `cost` spark is the running month cost up to today.
* `exportDatabases`: `404` if any id does not exist (nothing is silently left out); `erase` skips unknown ids, as the contract says. Malformed ids in a body are `400`.
* Costs: `costMtd`, `costSeries` and the billing lines use `config/plans.json` rates. They are `null` in the shipped file, so every cost is 0 and the billing page says "Pricing not set".
* `keep-awake` answers `500 internal` if the engine failed for some databases; the ones that succeeded are recorded, so the retry finishes the job.
* Section 3: sign-in works through Supabase Auth's REST API (PKCE for providers, `token_hash` for email links); the browser only ever holds the `HttpOnly` cookies `fnx_session` and `fnx_refresh`. An expired session cookie is renewed with the refresh cookie on the next request. `returnTo` must be on one of `DASHBOARD_ORIGINS`.
* Rate limits: `RATE_LIMIT_PER_MINUTE` per workspace (authenticated), `RATE_LIMIT_ANON_PER_MINUTE` per address (section 3, failed authentication, downloads), and the contract's 5 email links per address per hour. In memory per instance (see the README).
