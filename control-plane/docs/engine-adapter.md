# Engine adapter: what the real `EngineClient` must call

**Status: not implemented.** The task named the branch `control-ops` of `Mircoguidetti/test5` as the engine's admin interface. That branch does not exist on the remote (branches there: `main`, `compat-audit`, `compat-indexes`, `engine-cost`, `load-test`, `slatedb-tenant-bench`; none has a create, fork, restore, export, erase, keep-awake or usage call: the engine in `mongo-server/` speaks only the MongoDB wire protocol). So this service ships the interface and an in-memory fake (`src/engine/fake.ts`), and this page is the specification the real adapter has to meet. Everything under "Suggested HTTP shape" is a proposal for the engine team, not something that exists.

The interface is `src/engine/types.ts`. The server refuses to start with any `ENGINE_DRIVER` other than `fake`, and says why.

## Rules that hold for every call

1. **Databases are addressed by `id`**, the UUID of the row in Postgres (`public.databases.id`). The engine never needs the name for addressing. The name is only for routing (see "Connections" below).
2. **Idempotency.** Every call that changes something carries an `idempotencyKey`. Calling again with the same key must return the first result and must not do the work twice. The control plane uses the id of its operation record (`public.operations.id`, plus `:<databaseId>` for each database of an erase) as the key, and retries with the same key after a timeout, a crash or a 5xx. The fake enforces this and the tests rely on it (`tests/unit/misc.test.ts`, `tests/integration/operations.test.ts`).
3. **Error mapping.** The adapter turns engine answers into `EngineError`:

   | Engine says | `EngineError.kind` | Control plane does |
   | --- | --- | --- |
   | not found | `not_found` | fails the operation: 404 |
   | already exists, busy | `conflict` | fails the operation: 409 |
   | request refused (for example a restore point outside the retained history) | `invalid` | fails the operation: 400 with the engine's message, which must be written for people |
   | timeout, connection error, 5xx | `unavailable` | retries with backoff (5 s, 10 s, ... up to 5 minutes, 8 attempts), then fails: 500 |

4. **Timeouts.** The adapter must time out each call (the control plane waits `OPERATION_WAIT_MS`, default 20 s, before answering 202 and carrying on in the background; calls themselves may take longer).
5. **Authentication** between the control plane and the engine is the engine team's choice; the adapter will need its own environment variables (for example `ENGINE_ADMIN_URL`, `ENGINE_ADMIN_TOKEN`). Add them to `src/config.ts` when the adapter is written. Never log them.

## The calls

| `EngineClient` method | What the engine must do | Suggested HTTP shape |
| --- | --- | --- |
| `createDatabase({ id, workspaceId, name, region, idempotencyKey })` | Create an empty database with this id, asleep, in this region. Same id again: return the existing one. | `PUT /admin/v1/databases/{id}` body `{ workspaceId, name, region }`, header `Idempotency-Key` |
| `getDatabase(id)` | Return the database or null. | `GET /admin/v1/databases/{id}` (404 gives null) |
| `listDatabases(workspaceId)` | All databases of a workspace (for reconciliation; not called by the service today). | `GET /admin/v1/databases?workspaceId=` |
| `forkDatabase({ sourceId, id, workspaceId, name, idempotencyKey })` | Instant copy-on-write copy of `sourceId` as `id`, asleep, same region. Source must stay usable. | `POST /admin/v1/databases/{sourceId}/fork` body `{ id, workspaceId, name }` |
| `restoreDatabase({ id, at, idempotencyKey })` | Roll the database back in place to `at` (ISO UTC). Refuse (`invalid`) a point before the oldest retained backup or in the future. | `POST /admin/v1/databases/{id}/restore` body `{ at }` |
| `exportDatabases({ ids, idempotencyKey })` | Prepare **one archive** of all listed databases. Return a stable `exportId`, a `filename`, a `mimeType` and the size. Same key: same `exportId`. | `POST /admin/v1/exports` body `{ ids }` |
| `exportDownloadUrl(exportId, ttlSeconds)` | A fresh link to the archive that works for `ttlSeconds` (the control plane asks for 900, the contract's 15 minutes) and no longer. Callable many times. | `POST /admin/v1/exports/{exportId}/link` body `{ ttlSeconds }`, or a presigned object-store URL |
| `eraseDatabase({ id, idempotencyKey })` | Delete the live data **and every backup**. Erasing what is already gone returns `{ erased: false }`, not an error. | `DELETE /admin/v1/databases/{id}` |
| `setKeepAwake({ id, enabled })` | `true`: wake it and pin it (never sleep). `false`: unpin. Repeating changes nothing. Returns the database. | `PUT /admin/v1/databases/{id}/keep-awake` body `{ enabled }` |
| `usage({ id, from, to })` | Hourly buckets in `[from, to)` (`hour`, `requests`, `storageBytes`), current `state`, `storageBytes`, `lastActiveAt`, and wake-ups since `from` (`at`, `firstRequestMs`). Hours without traffic may be left out. | `GET /admin/v1/databases/{id}/usage?from=&to=` |

`EngineDatabase` (the return value of create, get, fork, restore, set-keep-awake) carries `state` (`awake` or `asleep`), `storageBytes`, `lastActiveAt`, `keepAwake`, `forkedFrom`, `restoredTo` and `earliestRestorePoint`. The control plane copies `state` and `storageBytes` into Postgres when a create or fork finishes, and the usage sync keeps them current afterwards.

## What the engine does not get

Tags, billing, invoices, users, API keys and the idle-timeout setting stay in Postgres. The workspace setting `idleMinutes` is stored but **not yet pushed to the engine**; the adapter needs a call for it (for example `PUT /admin/v1/workspaces/{id}/idle-timeout`) once the engine supports one.

## Connections

The Database JSON carries `host` (from `HOST_TEMPLATE`, default `<name>.<region>.db.<BASE_DOMAIN>`) and a connection string with `<password>` as a placeholder. The control plane stores no database passwords. The engine must route an incoming connection on that host to the right database id, and the user's password must come from somewhere the engine team decides (not specified by the contract).

**Open problem:** database names are unique per workspace, not globally (that is what the contract and `0001_init.sql` say). Two workspaces can both have `orders-prod`, and then `orders-prod.<region>.db.<base>` is ambiguous. The template accepts `<workspace>` (the first 8 hex characters of the workspace id) so that routing can be made unique, for example `<name>-<workspace>.<region>.db.<BASE_DOMAIN>`. The default is left as the task specified. This needs a decision before the first customer connects.

## Round trip to run when the interface exists

1. `ENGINE_DRIVER=<real>`, start the service against a scratch Postgres with both migrations applied and a local S3-compatible store behind the engine.
2. `POST /v1/databases` -> 201, then connect with a Mongo client to the returned host, write a document.
3. `POST /v1/databases/{id}/fork` -> 201; the fork reads the document; a write to the fork does not appear in the source.
4. `POST /v1/databases/{id}/restore` with a time before the write; the document is gone.
5. `POST /v1/databases/erase` -> `{ "affected": 2 }`; the engine's objects (data and backups) are gone from the store; repeating the call gives `{ "affected": 0 }`.
6. Kill the engine during step 3, retry: the fork exists once.
