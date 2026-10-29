# Where this service goes beyond `docs/control-plane-api.md`

The contract is implemented as written (37 endpoints, checked by `tests/integration/contract.test.ts`, which parses the contract document and asserts every method and path is routed). These are the places where the service adds something or makes a choice the contract leaves open.

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
| Organization `owner` | everything, including admins and other owners |
| Organization `admin` | everything except managing admins and owners (see [`organizations.md`](organizations.md)) |
| Organization `member` | reading only: **every** `POST`, `PUT` and `DELETE` answers `403`, except creating an organization, accepting an invitation and leaving |
| API key | everything except API keys, settings and organizations (a stolen key cannot mint more keys) |

The organization a request acts for is named by the header `X-Fenvix-Workspace` (see "Organizations" below).

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

## Data Explorer

Six routes under `/v1/databases/{id}/data/collections` let a customer browse and edit the documents of one of their databases (collections with estimated counts; a page of documents with filter, sort and projection; one document; insert; save with `version`; delete with `version`). Documents are canonical Extended JSON. They are not in the contract document; the contract test lists them as extensions. Everything about them (allowed operators, limits, roles, audit, errors, sleeping databases, residual risk) is in [`data-explorer-security.md`](data-explorer-security.md).

Changes to existing behaviour, all additive:

* `POST /api-keys` accepts `"dataAccess": "read" | "readWrite"` (default `read`), and every key in `GET /api-keys` and the create answer has `dataAccess`. Only `readWrite` keys can insert, save or delete documents. Needs migration `0004_data_explorer.sql`.
* A new error code, `unavailable` (503, with `Retry-After`): the engine's MongoDB listener did not answer in time or is waking a database. Only the Data Explorer uses it.

## Database users

The customer's own database users ("Database Access"). Everything about them (roles, who may do what, limits, how a
password is shown once, erase, fork, restore, audit, residual risk) is in [`database-users.md`](database-users.md).
Four routes, not in the contract document; the contract test lists them as extensions:

* `GET /databases/{id}/users` -> `{ items: [{ username, role, createdAt }], limit }`. Never a password; never the
  control plane's own `cp_<hex>` user.
* `POST /databases/{id}/users` `{ username, role? }` -> `201 { user, password, connectionString }`. `role` is
  `"readWrite"` (default) or `"read"`; any other field is refused.
* `POST /databases/{id}/users/{username}/reset-password` -> `200 { user, password, connectionString }`.
* `DELETE /databases/{id}/users/{username}` -> `200 { username, deleted: true }`.

The three changes are `Idempotency-Key` "no-replay": a repeat with the same key answers `409` and changes nothing.

Changes to existing behaviour, all additive:

* `POST /databases` and `POST /databases/{id}/fork` accept `appUser` (the initial user's name, default `"app"`). Their
  answer (the `Database`, `201`/`200`) has `initialUser: { username, role, password, connectionString }`; `password`
  and `connectionString` are set in the answer to the request that started the operation only, and are `null` in a
  replay, in `GET /operations/{id}` and when the answer was a `202`.
* `Database.connectionString` names the database's user (its initial user, or `<username>` when it was deleted) and
  carries `authSource` and `authMechanism=SCRAM-SHA-256`: `mongodb://app:<password>@host:port/db?tls=true&authSource=db&authMechanism=SCRAM-SHA-256`.
* `POST /api-keys` accepts `"userAccess": "none" | "manage"` (default `none`), and every key has `userAccess`. Only
  `manage` keys can create, reset or delete database users. Needs migration `0007_database_users.sql`.

## Organizations

Organizations (the `workspaces` table), members and invitations. Rules, roles, limits and the threat model are in
[`organizations.md`](organizations.md). Needs migration `0008_organizations.sql`.

The organization a request acts for: header `X-Fenvix-Workspace: <id>` on any route. The server checks on every
request that the signed-in person is a member of it and takes the role from the membership. An organization that does
not exist, is not theirs, or is not a valid id gives the same `404`. Without the header: their oldest membership, as
before. An API key always acts for its own organization (naming another one is a `404`).

The person (no organization needed; never an API key):

* `GET /organizations` -> `{ items: [{ id, name, role, nameConfirmed }] }`, oldest membership first.
* `POST /organizations` `{ name }` -> `201 { organization }`. The person is its owner; the name counts as confirmed.
* `POST /invitations/accept` `{ token }` -> `200 { organization }`. Every refusal is the same `404`.

The current organization (never an API key):

* `GET /organization` -> `{ id, name, role, nameConfirmed, members, limits: { maxMembers, invitationsPerDay } }`.
* `PUT /organization` `{ name }` -> renames and confirms the name. Owner or admin.
* `POST /organization/leave` -> `200 {}`. Any role; `409` for the last owner.
* `GET /organization/members` -> `{ items: [{ userId, name, email, role, joinedAt, you }], limit }`.
* `PUT /organization/members/{userId}` `{ role }` -> `200 { userId, role }`. `DELETE` the same path removes them.
* `GET /organization/invitations` -> pending ones `{ items: [{ id, email, role, createdAt, expiresAt }] }`. Owner or admin.
* `POST /organization/invitations` `{ email, role? }` -> `201 { invitation, link }`. The link holds the token and is
  in this answer only (`Idempotency-Key` "no-replay").
* `POST /organization/invitations/{id}/revoke` -> `200 { invitation }`.

Changes to existing behaviour:

* A `member` can no longer create, fork, restore, export, erase, keep awake or tag databases, download invoices, or
  change documents in the Data Explorer (`403`). Reading is unchanged.
* `403` for a person with no organization now says to create one or accept an invitation.

## IP allowlist

Which addresses may sign in to a database, and the addresses the engine has blocked after failed sign-ins. Rules,
order of the operations, divergence with the engine and what the control plane does so it never blocks itself are in
[`network-allowlist.md`](network-allowlist.md). Needs migration `0009_ip_allowlist.sql` and the engine of
`Mircoguidetti/test5` branch `network-limits` (commit 1c9fee7 or later). Five routes, not in the contract document; the
contract test lists them as extensions:

* `GET /databases/{id}/ip-allowlist` (every role, API keys) -> `{ entries, allowAll, maxEntries, updatedAt, updatedBy:
  { type, id, name } | null, engine: { status: "in_sync" | "different" | "unavailable", entries?, enforced },
  dataExplorer: { trusted: true | false | null } }`. `entries` is the saved list in the engine's form; `engine.entries`
  is there only when the engine holds a different list.
* `PUT /databases/{id}/ip-allowlist` `{ entries: [...] }` (owner, admin, API keys; a member gets `403`) -> the same
  answer. At most 100 IPv4 or IPv6 addresses or CIDR networks, checked with the engine's rules; `[]` allows every
  address. A refused entry is a `400` whose `field` is `entries[<index>]`. The engine is changed first; if it refuses
  or does not answer, nothing is saved (`400` or `503`).
* `POST /databases/{id}/ip-allowlist/reapply` (owner, admin, API keys) -> the same answer: sends the saved list to the
  engine again, after `engine.status` was `different`.
* `GET /databases/{id}/network/blocks` (owner, admin, API keys) -> `{ items: [{ ip, until, remainingSecs }] }`: the
  addresses blocked on this database. Only the address (an IPv6 block is shown as its `/64`) and its end.
* `POST /databases/{id}/network/unblock` `{ ip }` (owner, admin, API keys) -> `{ ip, unblocked }`. Only an address the
  previous route lists; anything else is a `404`.

Every change is recorded in `audit_log`: `database.ip_allowlist.set` and `.reapply` with `before` and `after`,
`database.network.unblock` with `ip`.

