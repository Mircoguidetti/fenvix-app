# Fenvix public API

Manage your organization from code: databases, their users and IP allowlists, and API keys. The machine-readable
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
| `admin` | an organization **admin** | everything below, including creating and revoking keys |
| `read_only` | an organization **member** | every `GET` except listing API keys; every change is `403` |

* A key only ever reaches its own organization. Ids of another organization's databases, users, keys or operations
  answer `404`, exactly like ids that do not exist. Sending `X-Fenvix-Workspace` with another organization is a `404`.
* No key, a malformed key, an unknown key, a revoked key and an expired key all get the same `401`. Revoked and expired
  keys are also recorded in the organization's audit log (`api_key.public.auth_failed`, with the reason).
* The dashboard's own keys (`fnx_...`) do not work here, and `fvx_` keys do not work on the dashboard's routes.
* The key management routes (`/api-keys`) also accept a signed-in dashboard session of an owner or admin, so the
  first key can be made. Every other route takes keys only.

## Conventions

* **Errors** use the format of the rest of the service: `{ "error": { "code", "message", "field"? } }`. Codes:
  `validation_failed` 400, `unauthenticated` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `rate_limited` 429,
  `internal` 500, `unavailable` 503. A `field` names the part of the request that is wrong (`name`, `entries[2]`, ...).
* **Request id.** Every answer, errors included, has `X-Request-Id`. Send your own (8 to 64 of `A-Z a-z 0-9 . _ -`)
  to have it kept; quote it when you contact support.
* **Pages.** Lists take `limit` (1 to 100, default 20) and `cursor`, and answer `{ "items": [...], "nextCursor" }`.
  Pass `nextCursor` back as `cursor` for the next page; it is `null` on the last page. Cursors are opaque.
* **Idempotency.** Any `POST`, `PUT` or `DELETE` can carry `Idempotency-Key: <1 to 255 visible characters>`. For 24
  hours the same key with the same request answers what the first one answered, with `Idempotent-Replay: true`; the
  same key with a different request is `409`. A `400` or `5xx` frees the key so you can fix and retry. Answers that
  hold a secret (a new API key, a new database user's password) are never replayed: a repeat answers `409` and makes
  nothing. Keys are per organization and shared with the dashboard's routes.
* **Long operations.** Creating and deleting a database wait up to 20 seconds. If it is not finished by then the answer
  is `202 { "operation": {...} }` with `Location` and `Retry-After`; poll `GET /operations/{id}`.
* **Rate limits.** Each key has its own limit (`PUBLIC_API_RATE_LIMIT_PER_MINUTE`, default 120 a minute), on top of the
  organization's (`RATE_LIMIT_PER_MINUTE`). Over it: `429` with `Retry-After` in seconds. Database user routes have
  their own, smaller limits (as on the dashboard). Wrong keys count against your address.

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

Delete (admin key). Erases the database and its data; `200 { "id", "deleted": true }`, or `202` while it runs.

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
`201 { "key": {...}, "token": "fvx_..." }`; store `token` now.

```bash
curl -sS -X POST "$FENVIX_API/api-keys" -H "Authorization: Bearer $FENVIX_KEY" \
  -H "Content-Type: application/json" -d '{"name": "ci deploys", "role": "read_only", "expiresAt": "2027-06-30T00:00:00Z"}'
```

Revoke. Takes effect on the next request; revoking twice changes nothing.

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
* An admin key can create more keys (so automation can rotate its own). A stolen admin key is as strong as an admin:
  revoke it, then check `api_key.public.create` rows in the audit log for keys it made.

## Applying the migration

`supabase/migrations/0010_public_api_keys.sql` is repeatable and changes nothing that exists (new table, new function).
It needs `0002_control_plane.sql` (the role `fenvix_control_plane` and `cp_workspace()`) and `0001_init.sql`. **Apply it
before deploying the version of the control plane that has the public API**; the old version ignores the table.

1. Try it locally first: `TEST_DATABASE_URL=postgresql://postgres@localhost:5432/cp_scratch bash scripts/prepare-test-db.sh`
   applies every migration twice to a scratch Postgres, then `npm test`.
2. Supabase -> SQL editor -> New query: paste the whole file -> Run. Running it again is safe.
3. Check: `select relrowsecurity from pg_class where oid = 'public.public_api_keys'::regclass;` is `true`, and
   `select grantee, privilege_type from information_schema.role_table_grants where table_name = 'public_api_keys';`
   lists `fenvix_control_plane` (`SELECT`, `INSERT`) and no `anon` or `authenticated`.
4. Optional: set `PUBLIC_API_RATE_LIMIT_PER_MINUTE` on the service (default 120).

To undo (before anyone has made a key): `drop function public.fenvix_cp_resolve_public_api_key(text); drop table
public.public_api_keys;`.

## Not in this version

* Fork, restore, export, tags, keep-awake, usage, billing, the Data Explorer, network blocks and members are only on
  the dashboard's routes.
* No page in the dashboard for public keys yet: the first key is made with a session (above).
* Rate limits are in memory per instance (see the README, "Limits worth knowing").
* Browsers: the public API sends no CORS headers for other origins; call it from a server.
