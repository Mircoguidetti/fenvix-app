# FENVIX control plane

The service between the dashboard and the engine. It implements `docs/control-plane-api.md` (the 37 endpoints of the contract, plus the callback of section 3) on Fastify, Node 22, TypeScript (strict). It reads and writes the dashboard's Postgres tables (Supabase) as a restricted role, and it talks to the engine through an `EngineClient` interface.

**Status.** Everything below the engine is built and tested. The engine side has two drivers behind one interface: `ENGINE_DRIVER=fake` (in memory, never for production) and `ENGINE_DRIVER=real`, the adapter for the engine's admin interface (`control-ops` in `Mircoguidetti/test5`). The real adapter is tested against a simulated engine written from `control-ops`' code; it has never talked to the real engine, which is not published yet. [`docs/engine-adapter.md`](docs/engine-adapter.md) maps every operation to the engine's routes, explains the port, name and hostname choices and the permission boundary, and lists the open questions. [`docs/api-extensions.md`](docs/api-extensions.md) says where the API adds to the contract. What was and was not run is in [`../results-control-plane.md`](../results-control-plane.md) and [`../results-engine-adapter.md`](../results-engine-adapter.md).

## Layout

```
config/limits.json   validation limits of the contract (name length, ids per call, page sizes, ...)
config/plans.json    plans, plan limits, unit rates. Ships with NO price, NO rate and NO limit (null / "")
src/config.ts        every setting, from environment variables
src/app.ts           Fastify app: logging, CORS, error handler, request ids, downloads, route registration
src/http.ts          authentication, rate limits, idempotency and operation answers around each route
src/routes/          data.ts (sections 1 and 2), session.ts (section 3)
src/services/        databases, operations (create/fork/restore/export/erase runner), usage, account (billing, keys, settings)
src/engine/          EngineClient interface, the in-memory fake, and the real adapter (real.ts, admin-http.ts with the route allowlist, names.ts, zip.ts)
src/auth/            Supabase JWT verification (JWKS) and the Supabase Auth gateway
../supabase/migrations/0002_control_plane.sql   restricted role, operations, idempotency and audit tables
../supabase/migrations/0003_close_dashboard_write_path.sql   closes the dashboard's direct write path (run at cutover)
tests/unit, tests/integration, tests/helpers
```

## Run it locally

```bash
cd control-plane && npm ci
# a scratch Postgres 15+ (never Supabase): apply the stand-ins and the three migrations
TEST_DATABASE_URL=postgresql://postgres@localhost:5432/cp_scratch bash scripts/prepare-test-db.sh
npm test                       # typecheck, unit tests, integration tests (needs TEST_DATABASE_URL)
SEEDED_DATABASE_URL=... node --test tests/integration/seeded.test.ts   # optional: the 3,000 database seed
```

`npm start` runs `node src/server.ts` (Node 22.18 or newer runs TypeScript directly, no build). It needs the environment below. The integration tests create their own users and workspaces with random ids, and connect as `fenvix_control_plane` exactly like production, so they exercise the real grants and policies. They set that role's password to a random value on the scratch database only.

## Configuration

Secrets are marked **secret**. Nothing here has a default for a secret, and no secret is ever logged (a test checks this).

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONTROL_PLANE_DATABASE_URL` | required, **secret** | Postgres connection string of the role `fenvix_control_plane` (never `postgres`, never `service_role`) |
| `SUPABASE_URL` | required | `https://<ref>.supabase.co`; its `/auth/v1/.well-known/jwks.json` is used to verify session tokens |
| `SUPABASE_ANON_KEY` | required | the project's public `anon` key, used only to call Supabase Auth. Not a secret. **Not** the `service_role` key |
| `DOWNLOAD_SIGNING_KEY` | required, **secret** | at least 32 characters; signs 15-minute download links. `openssl rand -hex 32` |
| `ENGINE_DRIVER` | required | `fake` (in memory) or `real` (the engine's admin interface; needs the `ENGINE_*` settings below) |
| `API_PUBLIC_URL` | required | public base including `/v1`, for example `https://api.fenvix.cloud/v1` (OAuth callback, cookie path and download links). `https` in production |
| `DASHBOARD_ORIGINS` | empty | comma list, for example `https://app.fenvix.cloud`. CORS with credentials, `returnTo` check, state-change origin check. Required in production |
| `BASE_DOMAIN` | empty; **required with `real`** | the domain databases are reached under |
| `ENGINE_ADMIN_ENDPOINTS` | **required with `real`** | admin address of the engine of each region: `region=url,region=url`, or one bare url when there is one region (the engine's admin port is 8443) |
| `ENGINE_ADMIN_TOKEN` or `ENGINE_ADMIN_TOKEN_FILE` | **required with `real`, secret** | the engine's admin bearer token, at least 16 characters |
| `ENGINE_ADMIN_CA_FILE`, `ENGINE_ADMIN_CLIENT_CERT_FILE`, `ENGINE_ADMIN_CLIENT_KEY_FILE`, `ENGINE_ADMIN_TLS_SERVER_NAME` | empty | PEM files and name for an `https://` admin address (private CA, client certificate) |
| `ENGINE_ADMIN_ALLOW_PLAIN_HTTP` | `false` | `true` to allow an `http://` admin address in production (the engine has no TLS of its own) |
| `ENGINE_REQUEST_TIMEOUT_MS`, `ENGINE_LONG_REQUEST_TIMEOUT_MS` | `15000`, `600000` | engine call timeouts; the long one is for fork, restore, export and erase |
| `ENGINE_FORK_MODE` | `clone` | `clone` (instant, but the source cannot be erased while the fork exists) or `copy` (independent, copies every object) |
| `ENGINE_RETENTION_WINDOW_SECS`, `ENGINE_RETENTION_INTERVAL_SECS` | unset | restore-point window set on every database created or forked; unset leaves the engine's default (restores need one) |
| `HOST_TEMPLATE` | `<name>.<region>.db.<BASE_DOMAIN>`; **must contain `<workspace>` with `real`** | `<name>`, `<region>`, `<workspace>` (first 8 hex digits of the workspace id), `<BASE_DOMAIN>`; empty parts and doubled dots are dropped (with the empty default the host is `name.region.db`). For the real driver use `<name>-<workspace>.<region>.db.<BASE_DOMAIN>` |
| `CONNECTION_PORT` | `27017`; **required with `real`** | port in the connection string: the port customers reach the engine's MongoDB listener on (the engine listens on 27018) |
| `CONNECTION_DB_NAME` | `name`; **must be `engine` with `real`** | what follows the port: `name` (the database's name with `_`) or `engine` (the name the engine knows it by, `db_` and the id). The engine has one namespace for all workspaces, so with the real driver the connection string carries the engine name |
| `REGIONS` | `eu-central-1` | comma list |
| `PLANS_FILE`, `LIMITS_FILE` | `config/plans.json`, `config/limits.json` | data files; edit them, not the code, to set prices, rates and plan limits |
| `COOKIE_SECURE` | `true` | `false` only for local http; refused in production |
| `COOKIE_DOMAIN` | host-only | set only if the dashboard and API must share a cookie across subdomains |
| `TRUST_PROXY` | `false` | **must be `true` behind a load balancer** (otherwise every client looks like the balancer and shares one rate limit); required to be set explicitly in production |
| `OPERATION_WAIT_MS` | `20000` | how long a request waits before answering 202 |
| `OPERATION_SWEEP_SECONDS` | `15` | how often queued/orphaned operations are picked up (0 = off) |
| `USAGE_SYNC_SECONDS` | `0` | how often the engine's usage is copied into Postgres (0 = off) |
| `HOURLY_RETENTION_DAYS`, `OPERATION_RETENTION_DAYS` | `8`, `90` | housekeeping |
| `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_ANON_PER_MINUTE` | `600`, `30` | per workspace; per address for sign-in, failed authentication, downloads |
| `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS` | `10`, `30000` | |
| `PORT`, `HOST`, `LOG_LEVEL`, `NODE_ENV` | `3000`, `0.0.0.0`, `info`, `development` | |

## How safety works

* **Authentication.** Session cookies (`fnx_session`, `HttpOnly`, `Secure`, `SameSite=Lax`) and `Authorization: Bearer <jwt>` carry Supabase JWTs, verified with the project's JWKS: issuer, audience `authenticated`, expiry, asymmetric algorithms only (HS256 and `none` are refused). `Authorization: Bearer fnx_...` is an API key: SHA-256 of the whole key, looked up with `fenvix_cp_resolve_api_key`, revoked keys refused. Wrong keys count against the caller's address.
* **Workspace isolation, twice.** Every query names `workspace_id` explicitly, and every transaction starts with `set_config('app.workspace_id', ..., true)`. The role's row level security policies allow a row only when `workspace_id = current_setting('app.workspace_id')`. So even a query that forgot its `where` cannot see another workspace, and with no workspace named every table is empty. `tests/integration/isolation.test.ts` tries every endpoint with another workspace's ids, compares the other workspace's rows before and after, and talks to Postgres as the restricted role directly.
* **The restricted role** (`0002_control_plane.sql`) is not superuser, does not bypass RLS, is a member of no role (not `authenticated`, not `service_role`), cannot run the dashboard's `fenvix_*` functions, cannot update or delete audit rows, cannot touch invoices (read only) or API key hashes. It can cross workspaces only through five functions that return ids and roles.
* **Operations** are rows. Each engine call carries the operation id as its idempotency key. A crashed or restarted service resumes `queued` operations, and `running` ones whose lease (2 minutes, renewed during long erases) ran out. Failures that cannot succeed (engine said no, 8 attempts used) undo the Postgres side: a failed create or fork removes its row, a failed restore or erase puts the database back to `ready`.
* **Audit.** `public.audit_log`: one row per change (`database.create.requested` / `.completed` / `.failed`, tags, keep awake, API keys, settings, usage sync) with workspace, actor (user, api key or system), request id, address. Secrets and connection strings are scrubbed from metadata.
* **Logs.** JSON lines (pino). Each request has an id (a valid `X-Request-Id` from the caller is kept, otherwise a UUID; it is returned as `X-Request-Id`). `Authorization`, cookies and `Set-Cookie` are redacted, query strings are not logged (they hold OAuth codes), and a test sends known secrets through and searches the log text.

## Founder steps (nothing here has been done for you)

1. **Check the Supabase project signs tokens with asymmetric keys.** Open `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`. It must list at least one key. If it is empty, the project still uses the legacy shared JWT secret: in Supabase go to Project Settings -> JWT Keys and move to the new signing keys. This service refuses shared-secret (HS256) tokens on purpose, so it would reject every sign-in.
2. **Run the migration.** Supabase -> SQL editor -> New query: paste `supabase/migrations/0002_control_plane.sql` -> Run (after `0001_init.sql`; safe to repeat). It creates the role `fenvix_control_plane` *without a password*.
3. **Give the role a password yourself.** Generate a long random one (for example `openssl rand -base64 36`), then in the SQL editor run `alter role fenvix_control_plane with password '<the password>';`. Do not paste the password anywhere else, and do not give it to anyone, including Claude.
4. **Build the connection string** from Supabase -> Project Settings -> Database -> Connection string (pick the pooler in *transaction* mode, or the direct one if the service runs on a network with IPv6). Replace the user with `fenvix_control_plane` (for the pooler it is `fenvix_control_plane.<project-ref>`) and the password with yours.
5. **Put the secrets in AWS** (Secrets Manager or SSM Parameter Store, injected as environment variables into the container): `CONTROL_PLANE_DATABASE_URL` (step 4) and `DOWNLOAD_SIGNING_KEY` (`openssl rand -hex 32`). `SUPABASE_URL` and `SUPABASE_ANON_KEY` are not secret (the anon key is already public in the dashboard bundle); never use the service_role key anywhere.
6. **Plain settings**: `API_PUBLIC_URL=https://api.fenvix.cloud/v1`, `DASHBOARD_ORIGINS=https://app.fenvix.cloud`, `NODE_ENV=production`, `TRUST_PROXY=true`, `ENGINE_DRIVER=fake` until the engine is published (**a deployment on `fake` stores nothing real**), and when decided `BASE_DOMAIN`, `REGIONS`, `HOST_TEMPLATE`. For `ENGINE_DRIVER=real` see "Switching to the real engine" below.
7. **Supabase Auth settings** (Authentication -> URL configuration / Providers / Email templates). Not tested against a real project, see the results file:
   * Redirect URLs allow-list: add `https://api.fenvix.cloud/v1/session/providers/github/callback`, `https://api.fenvix.cloud/v1/session/providers/google/callback` and `https://app.fenvix.cloud/`.
   * GitHub and Google providers: their callback URL at the provider stays Supabase's own (`https://<ref>.supabase.co/auth/v1/callback`), unchanged.
   * Email templates ("Magic Link" and "Confirm signup"): make the link `<a href="{{ .RedirectTo }}?token={{ .TokenHash }}">Sign in</a>`. The service sets `RedirectTo` to `https://app.fenvix.cloud/`, so the link opens `https://app.fenvix.cloud/?token=...` as the contract says, and the dashboard posts the token to `/session/email-link/complete`.
8. **Build and deploy the image yourself** when ready: `docker build -t fenvix-control-plane control-plane` (not built here: no Docker daemon in the sandbox). Health check `GET /healthz` (process) and `GET /readyz` (database). Run at least two copies only after reading "Limits" below.
9. **Cutover: close the side door.** Today the dashboard's Supabase client writes `public.databases` directly under row level security (its own `fenvix_*` functions, "Rows only. Nothing is sent to an engine yet"). While that stays open, a person can erase or fork rows without the engine knowing. `supabase/migrations/0003_close_dashboard_write_path.sql` closes it: it revokes write access of `authenticated` on `databases`, `database_tags`, `api_keys`, `workspace_settings` and the eleven mutating `fenvix_*` functions, and makes hostnames unique. **Run it only once the dashboard calls this API instead of those functions**, because it breaks the dashboard that is live now (every mutation in it goes through the revoked functions). Same way as step 2 (SQL editor, safe to repeat). The dashboard's own SQL tests (`supabase/tests/rls.sql`, `functions.sql`) describe the state before this step.

## Switching to the real engine

Not before the open questions in [`docs/engine-adapter.md`](docs/engine-adapter.md) are answered (above all: the engine's MongoDB listener has no authentication or TLS today). Then, in the AWS console as for the other secrets: add the SecureString parameter `/fenvix/prod/control-plane/engine-admin-token` with the same value as `/fenvix/prod/engine/admin-token` (it reaches the container as `ENGINE_ADMIN_TOKEN`), and set `ENGINE_DRIVER=real`, `ENGINE_ADMIN_ENDPOINTS`, `CONNECTION_PORT`, `CONNECTION_DB_NAME=engine`, `BASE_DOMAIN`, `HOST_TEMPLATE=<name>-<workspace>.<region>.db.<BASE_DOMAIN>`, and `ENGINE_RETENTION_WINDOW_SECS`. The service refuses to start with the real driver if any of these is missing or wrong, and says which. Then run the round trip at the end of `docs/engine-adapter.md`.

## Limits worth knowing

* The rate limiter is in memory per instance: with N instances the effective limit is N times the setting. The email-link limit (5 per address per hour) is the same.
* Operation sweeping is safe with several instances (a database `update ... where` claims each operation atomically; tested with two runners in one process), but the 2-minute `in_progress` expiry of idempotency keys assumes clocks within seconds of each other (the database's clock is used).
* Usage numbers only exist after the usage sync has run against a real engine (`USAGE_SYNC_SECONDS`); until then the dashboard's seed data is what the usage endpoints show.
* Time-bucketed endpoints use UTC.
