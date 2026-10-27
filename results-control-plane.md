# Results: FENVIX control-plane API

Branch `control-plane` of `mircoguidetti/olvix-app`, folder `control-plane/`, plus two new files outside it: `supabase/migrations/0002_control_plane.sql` and this file. Nothing in `src/`, `vercel.json` or the Vercel build was touched (`git diff --name-only main...HEAD` outside `control-plane/` lists only the migration, and this file once committed). Not merged, nothing deployed.

## Summary

* All 37 endpoints of `docs/control-plane-api.md`, plus the OAuth callback the contract describes in prose, are implemented. A test parses the contract document and fails if any method and path in it is not routed.
* **The engine side is the in-memory fake only.** `control-ops` does not exist in `Mircoguidetti/test5` (remote branches: `main`, `compat-audit`, `compat-indexes`, `engine-cost`, `load-test`, `slatedb-tenant-bench`). I also searched the engine source on those branches for any fork, restore, erase, keep-awake or admin call: there is none, the engine only speaks the MongoDB wire protocol. So there is **no HTTP engine adapter and no real create/fork/erase round trip**. `docs/engine-adapter.md` lists the exact calls the adapter has to make and the round trip to run once the interface exists. The server refuses to start with any engine driver except `fake`.
* Everything was run against a scratch **Postgres 16.15** with the stand-ins and migrations `0001` and `0002` applied (twice, to prove they can be repeated). Supabase itself (hosted Postgres, Auth, JWKS, email) was not used.

## What was run

| Run | Result |
| --- | --- |
| `npm test` on a freshly created scratch database: typecheck (`tsc --noEmit`, strict), 22 unit tests, 139 integration tests | exit 0; 22/22 and 138/138 pass, 1 skipped (the scale test, which needs a seeded database) |
| The same `npm test` run twice more on the *same* (reused) database | exit 0 both times, 138/138 pass (this found and fixed one test that depended on a clean database) |
| Scale test `tests/integration/seeded.test.ts` against the dashboard's own seed (3,000 databases, about 200 customers, 61 days of usage) | pass. Typical times: list page of 200: 65 ms; overview 24h/7d/30d: 59 to 97 ms; usage report by database (3,000 rows): 109 ms; by tag: 98 ms; trend: 57 ms; CSV of 3,000 rows: 112 ms. The by-tag total equals the by-database total, and the trend adds up to the report |
| The dashboard's own `supabase/tests/run-local.sh` (migration 0001, RLS test, functions test, seed), then `0002` on top, then `rls.sql` and `functions.sql` again | all pass: `0002` does not break what the dashboard relies on |
| Production start path: `npm ci --omit=dev` in a temp folder, then `node src/server.ts` with `NODE_ENV=production` | started, `/healthz` 200, `/readyz` 200, `/v1/databases` without a session gave the 401 contract body, CORS preflight 204, and the log shows no part of the connection string. Bad settings stop it with one readable line (`COOKIE_SECURE=false` in production, missing `DOWNLOAD_SIGNING_KEY`) |

One thing seen once and not reproduced: right after loading the seed, before Postgres had analysed the tables, the trend query took 20 s. With statistics (autovacuum on any real database does this) it is 57 ms, and the query plan is a plain hash join (47 ms in `EXPLAIN ANALYZE`). If you ever load a lot of usage rows in one go, run `analyze`.

## Per endpoint

"Tests" names the integration test files in `control-plane/tests/integration/`. Every test runs against the fake engine and Postgres, over `fastify.inject` (no network), authenticated as the restricted database role.

### Section 1: databases

| Endpoint | Done | Tests |
| --- | --- | --- |
| `GET /databases` | filters (search, state, keepAwake, tags `key:value` / `key` / `!key`), 6 sorts, default `lastActiveAt desc`, ties by name then id, paging, page past the end | `databases` (shape, sort, ties, paging, filters, `%` and `_` are not wildcards), `seeded` |
| `GET /databases/ids` | 400 over the cap asking for a narrower filter | `databases` (cap test uses a limits file with a cap of 2) |
| `GET /databases/groups` | counts, awake, keepAwake, storage, null group last | `databases`, `seeded` |
| `GET /tags` | | `databases` |
| `GET /databases/{id}` | 404 for missing or malformed id | `databases` |
| `GET /regions` | from `REGIONS` | `databases` |
| `POST /databases` | 201 Database; 400 with `field` for name, region, tags; 409 name taken (case-insensitive); engine refusal rolls back (no row, name free); plan database limit gives 403 | `databases`, `operations` |
| `POST /databases/{id}/fork` | 201, same region and tags, asleep, `forkedFrom`; 404, 400, 409; engine failure rolls back | `operations` |
| `POST /databases/{id}/restore` | 200 with `restoredTo`; 400 for future, before creation, malformed, outside the plan's retention window, or refused by the engine; 404; 409 while another restore runs | `operations` |
| `POST /databases/export` | 200 ExportResult, link made fresh with the 15 minute lifetime; 400 (0, over 100, bad ids); 404 if any id is missing | `operations` |
| `POST /databases/erase` | 200 `{affected}`, unknown ids skipped, rows and engine data gone; 400 over 1,000; 409 if a database is being restored; 403 for members | `operations`, `isolation` |
| `POST /databases/keep-awake` | pins in the engine and Postgres; 400; engine failure for part of the list gives 500 and the retry completes it | `operations` |
| `PUT /databases/{id}/tags` | 400 bad tag, two values for a key, over 20; a failed change leaves the tags as they were | `databases` |
| `POST /databases/tags/add`, `.../remove` | value replaced for an existing key; bare key removes the key; refuses to push a database past the tag limit | `databases` |
| `GET /databases/{id}/usage` | 24 hourly, 28 six-hourly, 30 daily points, always the exact count | `usage` |

### Section 2: overview, usage, billing, keys, settings

| Endpoint | Done | Tests |
| --- | --- | --- |
| `GET /overview` | every field of the contract incl. `sparks`; cost from the rates in the plans file; 24h/7d/30d | `usage` (values checked against the seeded fixture rows), `seeded` |
| `GET /tags/breakdown` | `(none)` group, limit, tie order | `usage` |
| `GET /usage/months`, `/usage`, `/usage/history`, `/usage/trend` | by database, by tag with and without `tagKey`, `key:(none)`, sort, paging, totals over everything, 400 for a month without a report; trend: top five plus Other, equal-length arrays | `usage`, `seeded` |
| `GET /usage/export` | CSV with the documented headers, link valid 15 minutes, served without a session; forged or tampered links give 404 | `usage` |
| `GET /plans`, `GET /billing` | exactly one current plan; billing from rates in `config/plans.json`; with the shipped file every cost is 0 and the rate text is "Pricing not set" | `usage` |
| `GET /invoices`, `POST /invoices/{id}/download` | 12 per page, newest first; PDF link | `usage` |
| `GET/POST /api-keys`, `POST /api-keys/{id}/revoke` | secret shown once, only SHA-256 + last four stored, revoking twice is fine, a retried create with the same Idempotency-Key never shows the secret again | `usage`, `auth` |
| `GET/PUT /settings` | validation of name length and allowed idle minutes | `usage` |

### Section 3: sign-in

| Endpoint | Done | Tests |
| --- | --- | --- |
| `GET /session` | 401 when signed out | `auth` |
| `POST /session/providers/{provider}` and the callback | PKCE, verifier kept in an `HttpOnly` cookie, `returnTo` must be a dashboard origin, failed sign-in goes back with `?error=sign_in_failed`, a code only works with the browser that started it | `auth` (against a fake Supabase Auth) |
| `POST /session/email-link` | 202 `{}` whether or not the address exists; 5 per address per hour then 429 with `Retry-After`; 400 for a bad address | `auth` |
| `POST /session/email-link/complete` | used, expired and unknown tokens all give the contract's 400 message | `auth` |
| `DELETE /session` | 204, twice | `auth` |

### Across all endpoints

| Requirement | Tests |
| --- | --- |
| 401 without credentials on every data endpoint (a list of 34 method+path pairs) | `auth` |
| Expired, wrong-audience, wrong-issuer, wrong-key, HS256 and `alg: none` tokens refused; JWKS fetched from a local HTTP server | `auth`, `tests/unit/jwt.test.ts` |
| API keys: hash lookup, scoped, `last_used_at`, revoked keys stop working at once, keys cannot manage keys or settings | `auth` |
| Cross-site cookie request refused, CORS only for `DASHBOARD_ORIGINS`, expired session renewed with the refresh cookie (once) | `auth` |
| Rate limit: 429 with `Retry-After`, per workspace, other workspaces unaffected; key guessing throttled per address | `auth` |
| Request ids, contract error shape for 404 / bad JSON / oversize body / unexpected failure (500 has no internals) | `http` |
| Logs: JSON, request id, no query string; a mixed workload is searched for 13 known secrets (API keys, session token, OAuth code, email token, email address, DB password and URL, signing key, `Bearer`, connection strings) and none appear | `http` |
| Audit rows with actor, request id, no secrets | `usage` |
| **Another workspace's data can never be read or changed** | `isolation` (see below) |
| **Retries never duplicate** | `operations` (see below) |

## Isolation tests (`isolation.test.ts`, 17 tests)

Two workspaces with databases, tags, API keys, an operation, an invoice and usage in each. Workspace A (by session and by API key) then:

* lists, ids, groups, tags, breakdown, overview and usage: only A's rows; B's names, tags and 777-request usage never show;
* every single-id endpoint with B's ids: 404; every bulk endpoint with B's ids (erase, keep awake, tag add and remove, export, fork, restore, revoke key, invoice download): `affected: 0` or 404;
* B's rows (databases, tags, keys, settings, operations, invoices, usage) are compared byte for byte before and after: unchanged; the engine was not told to pin or erase B's databases;
* the same `Idempotency-Key` in two workspaces is unrelated; `workspaceId` in a query or body is ignored; hostile strings in filters are data;
* connected as the restricted role itself: with no workspace set every table is empty; with A set only A's rows exist; updates, deletes and inserts aimed at B's workspace touch nothing or fail on row level security; it is not superuser, does not bypass RLS, is a member of no role, cannot update or delete audit rows, cannot write invoices, cannot change key hashes or plans, cannot run the dashboard's `fenvix_*` functions, cannot create tables, cannot read `auth.users`; `anon` and `authenticated` have no rights on the three new tables.

## Retry tests (`operations.test.ts`)

Same `Idempotency-Key` for create, fork, restore, erase and export: the first answer again, one row, one operation, and the fake engine's count of *work actually done* goes up by exactly one. A different body with the same key is 409. Concurrent identical requests give one action. Without a key: a repeated create is 409, a repeated erase is `{affected: 0}`, a repeated restore to the same time returns the running operation. Engine outage: retried with the same key until it works, one database in the engine. Orphaned operation after a "crash" (lease expired) is finished once by the sweeper; two runners racing for one operation run it once; after 8 failed attempts the operation fails and the row is removed.

## What could not be verified, or is not done

1. **No real engine.** No adapter, no real create/fork/erase round trip, no run against a local S3-compatible store. Reason: the admin interface does not exist (see Summary). The fake follows the idempotency rules the real engine must follow; whether the real engine can do that is unknown.
2. **Supabase Auth and JWKS are only exercised against fakes.** The REST calls in `src/auth/gateway.ts` (PKCE code exchange, OTP, token hash verify, refresh, logout) follow Supabase's documented API but have never touched a real project. The sign-in link only works if the email templates are edited as described below, and I am not certain whether a *new* address receives the "Magic Link" or the "Confirm signup" template, so edit both. JWT verification is tested with ES256 keys from a local JWKS server; Supabase also issues RS256 or Ed25519 keys, which the verifier accepts but which were not tested. Projects that still use the legacy shared secret (HS256) will be rejected by design.
3. **The migration was run on plain Postgres 16 with the dashboard's local stand-ins, not on Supabase.** Statements that depend on Supabase (default privileges that grant new tables to `anon` and `authenticated`, the owner `postgres` role) were written defensively (explicit revokes, attribute reset wrapped so it cannot fail the whole file) but not run there.
4. **The Docker image was not built**: the sandbox has no Docker daemon. The Dockerfile only does `npm ci --omit=dev` and `node src/server.ts`, and that path was run by hand (table above).
5. **Browser behaviour** (cookie `SameSite=Lax` across `app.` and `api.`, CORS preflight in a real browser) is covered at HTTP level only.
6. **Several instances at once**: operation claiming is an atomic database update and was tested with two runners in one process; the in-memory rate limiter is per instance by design.
7. **The usage sync** (`syncWorkspaceUsage`) is tested against the fake. It is off by default (`USAGE_SYNC_SECONDS=0`).
8. **`idleMinutes`** is stored but not sent to the engine (no call exists for it).
9. **Dashboard impact.** For create, fork, restore, export and erase the service answers `202` plus an operation to poll when the work takes longer than `OPERATION_WAIT_MS`; the contract only allows `202` for export. The dashboard needs a small poll loop before it relies on this. Details in `control-plane/docs/api-extensions.md`.
10. **Hostname clash.** Names are unique per workspace, so `orders-prod.<region>.db.<base>` can exist twice. The host template supports `<workspace>` to fix that; the default stays as you specified. Needs a decision before customers connect.
11. **The dashboard can still write the tables directly** through its Supabase functions and RLS (the "Rows only" behaviour). Until that is closed at cutover, a user can erase or fork rows without the engine knowing. Not done because it would break the live dashboard.
12. **Numbers I did not put in config:** operation lease (120 s), maximum attempts (8), retry backoff (5 s doubling to 5 min), stale idempotency claim (2 min), body limit (256 KB), refresh cookie lifetime (30 days). They are operational values in the code, not prices or plan limits. The contract's validation numbers (name length, 20 tags, 1,000 ids, ...) live in `config/limits.json`, and every price, rate and plan limit is in `config/plans.json`, shipped as `null` / empty (a test fails if a price or rate appears in the shipped file).

## Steps for you (nothing was done on your behalf)

Full text with explanations is in `control-plane/README.md`, "Founder steps". In short:

1. Open `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`. It must list a key. If it is empty, switch the project to the new JWT signing keys (Project Settings, JWT Keys); this service rejects the old shared-secret tokens.
2. **Migration to run in Supabase:** SQL editor, paste `supabase/migrations/0002_control_plane.sql` (after `0001_init.sql`), Run. Safe to repeat. It creates the role `fenvix_control_plane` with no password.
3. Set that role's password yourself, in the SQL editor: `alter role fenvix_control_plane with password '<long random password>';`. Keep the password out of chat, files and git.
4. Build the connection string (Project Settings, Database; transaction pooler user form is `fenvix_control_plane.<project-ref>`).
5. **Secrets in AWS** (Secrets Manager or SSM, passed to the container as environment variables): `CONTROL_PLANE_DATABASE_URL` (step 4) and `DOWNLOAD_SIGNING_KEY` (`openssl rand -hex 32`). Not secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the public anon key; never the service_role key).
6. Other settings: `NODE_ENV=production`, `API_PUBLIC_URL=https://api.fenvix.cloud/v1`, `DASHBOARD_ORIGINS=https://app.fenvix.cloud`, `TRUST_PROXY=true` (behind the load balancer), `ENGINE_DRIVER=fake` (a deployment on `fake` stores nothing real), later `BASE_DOMAIN`, `REGIONS`, `HOST_TEMPLATE`.
7. Supabase Auth: allow-list the redirect URLs `https://api.fenvix.cloud/v1/session/providers/github/callback`, `.../google/callback` and `https://app.fenvix.cloud/`; edit the "Magic Link" and "Confirm signup" templates so the link is `{{ .RedirectTo }}?token={{ .TokenHash }}`.
8. Build the image yourself (`docker build -t fenvix-control-plane control-plane`), health checks `/healthz` and `/readyz`.
9. Decide the hostname clash (item 10 above) and plan the cutover migration (item 11).
10. Fill `control-plane/config/plans.json` when prices are decided (rates, display prices, plan limits). Until then every cost is 0.
