# Fenvix public API

Manage your organization from code: databases, their users and IP allowlists, and API keys; and read its usage. The machine-readable
description is the OpenAPI 3.1 document at **`GET /v1/openapi.json`** (no key needed). This guide covers the same
routes with a `curl` example for each one. `tests/integration/public-openapi.test.ts` fails if a route is missing from
the document or from this guide, or if either describes a route that does not exist.

```
Base URL   https://api.fenvix.cloud/v1/public        (API_PUBLIC_URL + "/public")
Auth       Authorization: Bearer fvx_...
Format     JSON in, JSON out
```

The examples use two shell variables:

```bash
export FENVIX_API=https://api.fenvix.cloud/v1/public
export FENVIX_KEY=fvx_...        # never commit a key; read it from your secret store
```

## Authentication and roles

Every route needs a public API key: `Authorization: Bearer fvx_<43 characters>`. A key belongs to one organization and
has one role. The role is applied exactly as the dashboard applies an organization role to a person:

| Key role | Acts like | Can |
| --- | --- | --- |
| `admin` | an organization **admin** | everything below, including creating `read_only` keys and revoking keys |
| `read_only` | an organization **member** | every `GET` except listing API keys; every change is `403` |

* A key only ever reaches its own organization. Ids of another organization's databases, users, keys or operations
  answer `404`, exactly like ids that do not exist. Sending `X-Fenvix-Workspace` with another organization is a `404`.
* No key, a malformed key, an unknown key, a revoked key and an expired key all get the same `401`. Revoked and expired
  keys are also recorded in the organization's audit log (`api_key.public.auth_failed`, with the reason; at most one
  row a minute per key, see "How keys are kept").
* The dashboard's own keys (`fnx_...`) do not work here, and `fvx_` keys do not work on the dashboard's routes.
* The key management routes (`/api-keys`) also accept a signed-in dashboard session of an owner or admin, so the
  first key can be made. A session must name the organization with `X-Fenvix-Workspace: <organization id>`; without
  it the answer is `400` (there is no default organization). Every other route takes keys only.

## Conventions

* **Errors** use the format of the rest of the service: `{ "error": { "code", "message", "field"? } }`. Codes:
  `validation_failed` 400, `unauthenticated` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `rate_limited` 429,
  `internal` 500, `unavailable` 503. A `field` names the part of the request that is wrong (`name`, `entries[2]`, ...).
* **Request id.** Every answer, errors included, has `X-Request-Id`. Send your own (8 to 64 of `A-Z a-z 0-9 . _ -`)
  to have it kept; quote it when you contact support.
* **Pages.** Lists take `limit` (1 to 100, default 20) and `cursor`, and answer `{ "items": [...], "nextCursor" }`.
  Pass `nextCursor` back as `cursor` for the next page; it is `null` on the last page. Cursors are opaque.
* **Query parameters** a route does not take are refused (`400`, `field` names the parameter), not ignored.
* **Idempotency.** Any `POST`, `PUT` or `DELETE` can carry `Idempotency-Key: <1 to 255 visible characters>`. For 24
  hours the same key with the same request answers what the first one answered, with `Idempotent-Replay: true`; the
  same key with a different request is `409`. A `400` or `5xx` frees the key so you can fix and retry. Answers that
  hold a secret (a new API key, a new database user's password) are never replayed: a repeat answers `409` and makes
  nothing. Keys are per organization and shared with the dashboard's routes.
* **Long operations.** Creating and deleting a database wait up to 20 seconds. If it is not finished by then the answer
  is `202 { "operation": {...} }` with `Location` and `Retry-After`; poll `GET /operations/{id}`.
* **Rate limits.** Each key has its own limit (`PUBLIC_API_RATE_LIMIT_PER_MINUTE`, default 120 a minute), on top of the
  organization's (`RATE_LIMIT_PER_MINUTE`). Over it: `429` with `Retry-After` in seconds. Database user routes have
  their own, smaller limits (as on the dashboard).
* **Wrong keys and addresses.** Wrong, malformed or missing keys count against your address
  (`RATE_LIMIT_ANON_PER_MINUTE`, default 30 a minute, shared with failed dashboard sign-ins). Once an address is over
  it, a key is refused with `429` **before it is looked up**, so a flood of made-up keys costs no database work. The
  exception is a key the server instance knows to be valid (it created it, or saw it work in the last 15 minutes):
  that key is still looked up, on a separate and higher per-address budget (600 a minute), so failed or anonymous
  traffic from the same address (a NAT, a shared CI runner) does not lock out a working key. The lookup still
  decides: a revoked key is refused at once and forgotten. A valid key the instance has not seen yet, used for the
  first time from an address that is locked out, waits like any other key until the minute is over.
* Fetching `/v1/openapi.json` has its own counter (120 a minute per address) and does not count as a failure.

## Databases

List (newest first):

```bash
curl -sS "$FENVIX_API/databases?limit=20" -H "Authorization: Bearer $FENVIX_KEY"
```

Create (admin key). `tags` and `appUser` (the initial user, default `app`) are optional. The answer (`201`) is the
database with `initialUser.password` and a full `initialUser.connectionString`, **in this answer only**; a replay or a
poll shows `null`.

```bash
curl -sS -X POST "$FENVIX_API/databases" -H "Authorization: Bearer $FENVIX_KEY" \
  -H "Content-Type: application/json" -H "Idempotency-Key: create-orders-db-1" \
  -d '{"name": "orders", "region": "eu-central-1", "tags": ["env:prod"]}'
```

Get one. `status` is `ready`, `restoring` or `erasing`; `state` is `awake` or `asleep`; `connectionString` always says
`<password>`.

```bash
curl -sS "$FENVIX_API/databases/$DATABASE_ID" -H "Authorization: Bearer $FENVIX_KEY"
```

Delete (admin key). Erases the database and its data; `200 { "id", "deleted": true }`, or `202` while it runs. A
database that is already being erased (`status: "erasing"`) answers `409`.

```bash
curl -sS -X DELETE "$FENVIX_API/databases/$DATABASE_ID" -H "Authorization: Bearer $FENVIX_KEY"
```

Poll a long operation (the id is in the `Operation-Id` header and in a `202` answer). `result` is what the original
request would have answered, once `status` is `succeeded`.

```bash
curl -sS "$FENVIX_API/operations/$OPERATION_ID" -H "Authorization: Bearer $FENVIX_KEY"
```

## Database users

List (by name, never a password):

```bash
curl -sS "$FENVIX_API/databases/$DATABASE_ID/users?limit=50" -H "Authorization: Bearer $FENVIX_KEY"
```

Create (admin key). `role` is `readWrite` (default) or `read`. The password is in this answer only.

```bash
curl -sS -X POST "$FENVIX_API/databases/$DATABASE_ID/users" -H "Authorization: Bearer $FENVIX_KEY" \
  -H "Content-Type: application/json" -d '{"username": "reporting", "role": "read"}'
```

Delete (admin key). Connections already open as this user are refused their next command.

```bash
curl -sS -X DELETE "$FENVIX_API/databases/$DATABASE_ID/users/reporting" -H "Authorization: Bearer $FENVIX_KEY"
```

## Network allowlist

Get. `entries` is the saved list; `[]` means every address may connect. `engine.status` says whether the engine holds
the same list.

```bash
curl -sS "$FENVIX_API/databases/$DATABASE_ID/ip-allowlist" -H "Authorization: Bearer $FENVIX_KEY"
```

Replace (admin key). At most 100 IPv4 or IPv6 addresses or CIDR networks. The engine is changed first; if it refuses
or does not answer, nothing is saved (`400` or `503`).

```bash
curl -sS -X PUT "$FENVIX_API/databases/$DATABASE_ID/ip-allowlist" -H "Authorization: Bearer $FENVIX_KEY" \
  -H "Content-Type: application/json" -d '{"entries": ["203.0.113.7", "10.0.0.0/8"]}'
```

## Usage

Read only: `admin` and `read_only` keys alike. These routes show the numbers the dashboard's charts and monthly
report show, from the same rows, so you can bill your own users from them. They measure nothing new.

Usage of the organization. `range` is required: `24h` (24 hourly buckets), `7d` (28 six-hourly buckets, starting
at 00, 06, 12 and 18 UTC) or `30d` (30 UTC days). The last bucket is the current, unfinished one. Add
`databaseId=<id>` for one database (the answer is then the same as the next route's).

```bash
curl -sS "$FENVIX_API/usage?range=30d" -H "Authorization: Bearer $FENVIX_KEY"
```

Usage of one database (`404` for another organization's database, or one still being created):

```bash
curl -sS "$FENVIX_API/databases/$DATABASE_ID/usage?range=7d" -H "Authorization: Bearer $FENVIX_KEY"
```

```json
{
  "range": "7d", "databaseId": "6f1c...", "from": "2026-10-23T18:00:00Z", "to": "2026-10-30T18:00:00Z", "bucketSeconds": 21600,
  "totals": { "requests": 48210, "storageBytes": 734003200 },
  "items": [ { "at": "2026-10-23T18:00:00Z", "requests": 1200, "storageBytes": 733980672, "activeDatabases": 1 }, "..." ]
}
```

Every bucket of the range is in `items`, oldest first; a bucket with no data is zeros (a new or idle database, or an
organization with no databases, answers zeros, not an error). Times are UTC; `from` is the start of the first bucket
and `to` the end of the last (exclusive).

### What each number means

| Field | Meaning |
| --- | --- |
| `requests` (bucket) | Requests the engine counted for the database(s) in the bucket: MongoDB commands (the engine's `requests.commands`). Summed over databases. |
| `totals.requests` | The sum of the buckets: requests in the whole range. |
| `storageBytes` (bucket) | Bytes stored: for each database, its newest measurement in the bucket (the engine's sampled storage for the day, or the database's size when there is no sample), added up over databases. A level, not a sum over time. |
| `totals.storageBytes` | Bytes stored at the end of the range: each database's newest measurement in the range, added up. |
| `activeDatabases` | Databases that served at least one request in the bucket (`0` or `1` for one database). The dashboard's database chart calls this "awake". |

What is **not** measured, so it is not here: data transfer, CPU or compute time, time awake, per-collection or
per-database-user numbers, and prices. The dashboard's "cost this month" is Fenvix's own price, computed from rates
in the service's configuration; it is not part of the usage you bill on and is not exposed. Average storage over time
(for a GB-month price) is not a separate number either: average the daily `storageBytes` of `range=30d`, or use the
CSV's `storage_gb_avg` (below).

### How fresh it is

* The numbers are copied from the engine into Postgres by the **usage sync**, every `USAGE_SYNC_SECONDS` (a
  deployment setting; `0` turns it off, and then nothing new appears). Nothing is read from the engine when you call
  these routes, so they are cheap and never wait for it.
* Each sync reads again from 00:00 UTC of the day before and **overwrites** those rows: today's and yesterday's
  numbers can still grow. A UTC day is final once the day after it is over.
* **The engine counts per UTC day, not per hour.** With the current engine, a day's requests and storage land in
  the bucket that starts at 00:00 UTC of that day, so the hourly (`24h`) and six-hourly (`7d`) series show one
  non-zero bucket a day. Use `range=30d` (or the CSV) to bill; the finer ranges become exact when the engine reports
  hours.
* Hourly rows are kept for `HOURLY_RETENTION_DAYS` (default 8, at least 2; `7d` needs 7); daily rows are kept.
* **Erasing a database removes its usage** (its rows go with it), from these routes and from the CSV. Read or export
  what you need to bill before you erase a database.

### Monthly CSV

The dashboard's monthly report as a CSV file. `month` (`YYYY-MM`, UTC) and `by` (`database` or `tag`) are required;
`tagKey` (with `by=tag`), `sort` (`name`, `databases`, `storageGb`, `requests`; default `requests`) and `dir` (`asc`,
`desc`; default `desc`) are optional. The answer is `{ "filename", "mimeType", "downloadUrl", "expiresAt" }`:
`downloadUrl` is the same signed link the dashboard hands out (`/v1/downloads/<token>`, 15 minutes, no key needed: do
not share it). The file is built when the link is opened. A month without usage is a `400` (`field: "month"`).

```bash
curl -sS "$FENVIX_API/usage/export?month=2026-10&by=database" -H "Authorization: Bearer $FENVIX_KEY"
```

```bash
curl -sS -o usage.csv "$(curl -sS "$FENVIX_API/usage/export?month=2026-10&by=tag&tagKey=customer" \
  -H "Authorization: Bearer $FENVIX_KEY" | jq -r .downloadUrl)"
```

Columns: by database `database,tags,storage_gb_avg,requests`; by tag `tag,databases,storage_gb_avg,requests`.
`requests` is the month's sum; `storage_gb_avg` is the average of the daily storage over the days of the month that
have data, in GiB (2<sup>30</sup> bytes), rounded to 2 decimals. Tag your databases by customer (for example
`customer:acme`) and `by=tag&tagKey=customer` gives one row per customer.

## Organization

The key's organization, its member count, and the key's own id and role:

```bash
curl -sS "$FENVIX_API/organization" -H "Authorization: Bearer $FENVIX_KEY"
```

## API keys

Admin key (or an owner's or admin's dashboard session). Keys are shown by `prefix` (`fvx_` and 8 characters) and
`status` (`active`, `revoked`, `expired`); the key itself is never shown again after it is made.

List:

```bash
curl -sS "$FENVIX_API/api-keys" -H "Authorization: Bearer $FENVIX_KEY"
```

Create. `role` is `admin` or `read_only`; `expiresAt` is optional (at most 3 years ahead). The answer is
`201 { "key": {...}, "token": "fvx_..." }`; store `token` now. Rules:

* At most **100 active keys** per organization (revoked and expired keys do not count); the 101st is a `409`.
* **Admin keys are made only by a person** signed in to the dashboard (owner or admin). A key can create `read_only`
  keys only (`403` otherwise).
* A key made by a key **expires no later than its creator**: if the creating key expires, `expiresAt` is required
  and must be on or before the creator's expiry (`400`, `field: "expiresAt"`).
* If the answer cannot be completed after the key was made (the `Idempotency-Key` record could not be saved), the key
  is revoked at once (audit reason `not_delivered`; tried twice; nothing is recorded if the key was already revoked)
  and the request fails with `500`: retry it. The same goes for a new
  database user, which is dropped again.

```bash
curl -sS -X POST "$FENVIX_API/api-keys" -H "Authorization: Bearer $FENVIX_KEY" \
  -H "Content-Type: application/json" -d '{"name": "ci deploys", "role": "read_only", "expiresAt": "2027-06-30T00:00:00Z"}'
```

Revoke. Takes effect on the next request; revoking twice changes nothing. Keys made by the revoked key are revoked
with it (and keys made by those, and so on).

```bash
curl -sS -X DELETE "$FENVIX_API/api-keys/$KEY_ID" -H "Authorization: Bearer $FENVIX_KEY"
```

The first key: until the dashboard has a page for public keys, an owner or admin creates it with their session
(`Authorization: Bearer <Supabase access token>` and `X-Fenvix-Workspace: <organization id>`) on the same route.

## How keys are kept

* A key is `fvx_` plus 32 random bytes in base64url (43 characters, 256 bits).
* Postgres keeps only its SHA-256 (hex) and the display prefix, in `public.public_api_keys` (migration
  `0010_public_api_keys.sql`). Row level security is on; only the control plane's role `fenvix_control_plane` can read
  it, and only for the organization its transaction acts for. `anon` and `authenticated` cannot read it at all. A key
  is found by its hash through one function, `fenvix_cp_resolve_public_api_key`.
* A key never appears in a log line (the `Authorization` header is redacted and refusals log only the reason), in an
  error message or in the audit log. Tests send keys through every path and search the logs, the table and the audit
  log for them.
* Audit log (`public.audit_log`): `api_key.public.create` (name, role, expiry), `api_key.public.revoke`,
  `api_key.public.auth_failed` (revoked or expired, with method and path), `api_key.public.denied` (a read-only key
  tried a change). Changes made with a key are recorded with `actor_type = 'api_key'` and the key's id, like the
  dashboard's own audit rows.
* **Audit growth.** `api_key.public.auth_failed` and `api_key.public.denied` are written at most once a minute per
  key. The refusals held back in between are counted and never lost: the next row for the key says how many in
  `metadata.suppressed`, or, if the key goes quiet, a summary row (`metadata.summary: true`, `metadata.suppressed`)
  is written once its minute is over (checked every 15 seconds, and on shutdown). The minute starts only when a row
  was actually written: if writing fails, the count is kept and the next refusal tries again. The window is kept in
  memory per instance, so with N instances there are at most N rows a minute per key (plus summaries). A wrong key
  that matches no key has no organization to log into: it gets a log line (the reason only) and counts against the
  address.
* An admin key can create `read_only` keys (so automation can hand out narrower keys), never admin keys. A stolen
  admin key is as strong as an admin: revoke it; every key it made is revoked with it.

## Keys do not outlive their creator

Enforced in Postgres (triggers in migration `0010`), so it holds however the change is made: through the dashboard,
the control plane, an account deletion or the Supabase SQL editor.

| What happens | What is revoked | Audit row (`api_key.public.revoke`, actor `system`) |
| --- | --- | --- |
| A person leaves the organization or is removed from it (or their account is deleted) | the **admin** keys they created in it | `metadata.reason = "creator_removed"`, `metadata.creator = <user id>` |
| A person's role drops below admin (owner or admin to member) | the **admin** keys they created in it | `reason = "creator_demoted"` |
| A key is revoked (by anyone, or by one of the rules above) | every key it created, and so on down | `reason = "creator_revoked"`, `creator = <key id>` |

* `read_only` keys a person created stay when they leave or are demoted; they can only read, and an owner or admin
  can revoke them. An owner who becomes an admin keeps their keys (still admin).
* The request that removed or demoted the person has its own audit row (`member.remove`, `member.role_change`,
  `organization.leave`) with who did it.
* Nothing is revoked or recorded when the whole organization is deleted: its keys go with it.

**At the same moment.** Creating a key re-checks its creator inside the creating transaction and locks the creator's
row (`FOR SHARE`: the person's membership, or the creating key) until the new key is committed. An insert trigger
(`public_api_keys_check_creator`) makes the same checks under the same lock for inserts made anywhere, including the
SQL editor: a person must be an owner or admin; a creating key must be active (not revoked, not expired), may only
create `read_only` keys, and a key it creates may not outlive it. So a demotion, removal or revoke running at the same
time either commits first, and the create is refused (`403` for a person, `401` for a key), or waits for the new key,
and then revokes it. `tests/integration/public-concurrency.test.ts` runs both orders for a person and for a key.

## Applying the migration

`supabase/migrations/0010_public_api_keys.sql` is repeatable and changes no existing data: a new table, its policy, five
new functions and three new triggers (two on the new table, and one `after update of role or delete` on
`public.workspace_members`, which only revokes public API keys). `EXECUTE` on the functions is taken from `public`,
`anon`, `authenticated` and `service_role` (the control plane never uses `service_role`); only `fenvix_control_plane` may
call `fenvix_cp_resolve_public_api_key`, and the others are run only by the triggers.
It needs `0002_control_plane.sql` (the role `fenvix_control_plane` and `cp_workspace()`) and `0001_init.sql`. **Apply it
before deploying the version of the control plane that has the public API**; the old version ignores the table.

1. Try it locally first: `TEST_DATABASE_URL=postgresql://postgres@localhost:5432/cp_scratch bash scripts/prepare-test-db.sh`
   applies every migration twice to a scratch Postgres, then `npm test`.
2. Supabase -> SQL editor -> New query: paste the whole file -> Run. Running it again is safe.
3. Check: `select relrowsecurity from pg_class where oid = 'public.public_api_keys'::regclass;` is `true`, and
   `select grantee, privilege_type from information_schema.role_table_grants where table_name = 'public_api_keys';`
   lists `fenvix_control_plane` (`SELECT`, `INSERT`) and no `anon` or `authenticated`.
4. Optional: set `PUBLIC_API_RATE_LIMIT_PER_MINUTE` on the service (default 120).

To undo (before anyone has made a key): `drop trigger workspace_members_revoke_public_keys on public.workspace_members;
drop table public.public_api_keys; drop function public.public_api_keys_on_membership(), public.public_api_keys_on_revoke(),
public.public_api_keys_check_creator(), public.public_api_keys_revoke(uuid, uuid[], text, text),
public.fenvix_cp_resolve_public_api_key(text);` (dropping the table drops its two triggers).

## Not in this version

* Fork, restore, export, tags, keep-awake, billing and invoices, the overview (cost, wake-ups, top databases), the Data
  Explorer, network blocks and members are only on the dashboard's routes.
* No page in the dashboard for public keys yet: the first key is made with a session (above).
* Rate limits are in memory per instance (see the README, "Limits worth knowing").
* Browsers: the public API sends no CORS headers for other origins; call it from a server.
