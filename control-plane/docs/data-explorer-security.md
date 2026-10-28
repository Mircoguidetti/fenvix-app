# Data Explorer: security model

The Data Explorer lets a customer open one of their databases in the dashboard and see, filter, insert, edit and delete its documents, like the Data Explorer of Atlas. It gives people access to their customers' data, so this page says exactly what is allowed, what is refused, where every limit is, and what risk is left.

## Architecture

```
browser (dashboard, Data tab)
   │  HTTPS, Authorization: Bearer <Supabase session JWT>  (or an fnx_ API key, or the fnx_session cookie)
   ▼
control plane  /v1/databases/:id/data/...      routes/explorer.ts -> services/explorer.ts -> explorer/rules.ts
   │  MongoDB wire protocol, official "mongodb" driver, TLS required,
   │  SCRAM-SHA-256 as the database's OWN engine user cp_<hex> (password derived, never stored)
   ▼
FENVIX engine, MongoDB listener (27018)        database db_<32 hex of the id>
                                               user cp_<32 hex> on db_<hex>, role readWrite on db_<hex> only
```

* The browser never talks to the engine. Only the control plane opens connections to it (`src/engine/data-mongo.ts`).
* The engine's admin interface (8443, `EngineClient`) is not used by the Data Explorer, and the Data Explorer's client (`DataClient`, `src/engine/data.ts`) is a separate interface with its own in-memory fake (`src/engine/data-fake.ts`) so every test runs without an engine.

## Routes

All under `/v1/databases/:id/data/collections`, with the same authentication, workspace rate limit, origin check for cookie sessions and error format as every other route (`src/http.ts`).

| Method and path | Who | What |
| --- | --- | --- |
| `GET …/collections` | anyone in the workspace | names, type, `browsable`, `estimatedCount` (from metadata, never a scan); at most 500 names, counts for the first 100 |
| `GET …/collections/:collection/documents?filter=&sort=&projection=&page=&pageSize=` | anyone in the workspace | one page: `{ items: [{ id, version, partial, document }], page, pageSize, hasMore, truncated }` |
| `GET …/collections/:collection/documents/:docId` | anyone in the workspace | one document |
| `POST …/collections/:collection/documents` body `{ document }` | writers | `201 { id, version }` |
| `PUT …/collections/:collection/documents/:docId` body `{ document, version }` | writers | `200 { id, version }`; `409` if the document changed since `version` |
| `DELETE …/collections/:collection/documents/:docId?version=` | writers | `200 { deleted: true }`; `409` if it changed |

There is no "run any command", no aggregation, no update operators (`$set`…), no bulk write, no index or collection management. `:docId` is the canonical Extended JSON of the `_id`, URL-encoded (`%7B%22%24oid%22%3A%22…%22%7D`).

## The eleven points

### 1. Isolation between tenants

* `resolveTarget()` (`services/explorer.ts`) is the only place a `DataTarget` is made. It reads the database row with `workspace_id = <caller's workspace> and id = :id` in a transaction scoped to that workspace (so Postgres row level security applies too). A row of another workspace, a row still being provisioned, an id that does not exist and a malformed id all give **the same 404** with the same body (`{"error":{"code":"not_found","message":"That database does not exist."}}`).
* The engine database name is `db_` + the 32 hex digits of **the id of that row** (`targetDbName()` in `engine/data.ts`, using `engineName()`). A `DataTarget` is a frozen object carrying a private symbol, so an object a client could shape cannot pass for one (`targetDbName` throws). Nothing a client sends becomes a database name.
* Order of checks per request: authentication → rate limits → write permission (for writes) → input validation → `resolveTarget` → engine. None of the steps before `resolveTarget` depends on whether the database exists, so nothing leaks through the order either (a read-only key gets the same 403 for its own database, another workspace's and one that does not exist; tested).
* Tests: `tests/integration/explorer-isolation.test.ts` tries all seven routes as a person and as a read-write API key of workspace A against workspace B's database (same name in both workspaces), compares each answer with the answer for a random id, checks B's documents byte for byte before and after, checks the engine was never called with B's database name, and checks the audit tables. Against the real engine: `explorer-real-engine.test.ts`, "two workspaces".

### 2. Collection names

`isAllowedCollection()` (`explorer/rules.ts`): 1 to 120 characters of `A-Z a-z 0-9 _ - .`, not starting with a dot, no `..`, not ending with a dot, not `system.*` (any case). That excludes `$`, NUL, spaces, slashes, unicode. Names that exist in a database but fall outside the rule are listed with `browsable: false` and cannot be opened; `system.*` collections are not listed at all. Tests: `tests/unit/explorer-rules.test.ts` (25 refused names), `explorer-hostile.test.ts` (12 names in the URL, nothing reaches the engine).

### 3. Operator injection

The filter is parsed by an allowlist (`parseFilter`, `explorer/rules.ts`), never passed on as received:

* Top level and inside `$and` / `$or`: field paths and `$and`, `$or` (1 to 20 branches).
* For a field: a literal (equality) or an object of operators, never both mixed: `$eq $ne $gt $gte $lt $lte $in $nin $exists $regex $options $not`. `$in`/`$nin` take at most 100 values; `$exists` takes a boolean; `$not` takes an operator object; `$regex` is 1 to 256 characters without NUL, and `$options` may only use `i`, `m`, `s` (no `x`, no repeats).
* Everything else is refused with 400, wherever it appears: `$where $function $accumulator $expr $lookup $out $merge $jsonSchema $text $elemMatch $nor $size $type $all $mod $comment …`, including inside `$or`, `$not`, inside a value (`{"a": {"b": {"$where": …}}}`), inside `$in` lists.
* Values are Extended JSON; only these wrappers are accepted, each checked for its exact shape and turned into its BSON type one at a time: `$oid $date $numberInt $numberLong $numberDouble $numberDecimal $binary $uuid $timestamp $minKey $maxKey` (and `$regularExpression` in documents only; in a filter use `$regex`). `$code`, `$symbol`, `$dbPointer`, `$ref`/`$id` (DBRef) and legacy forms (`{"$binary": "…", "$type": …}`) are refused. The EJSON parser never sees a whole client object, so it cannot reinterpret legacy shapes.
* Field paths: 1 to 256 characters, no leading `$`, no empty part, no part starting with `$`, no NUL, no `__proto__` (also refused as a field name in documents, so the server's objects cannot be polluted).
* Limits: 8 KiB of filter text, 8 levels of nesting, 100 keys in total.
* Sort: field paths to `1`/`-1`, at most 8; `_id` is added last so pages are stable. Projection: field paths to `1`/`0` (or booleans), not mixed, at most 50, `_id` always shown; no `$slice`, `$elemMatch`, `$meta`. A projected document comes without a `version`, so it cannot be saved as if it were whole (the dashboard opens the whole document first).
* Documents (insert, save): field names without a leading `$`, without `.`, without NUL, not `__proto__`; at most 32 levels and 20,000 keys; `_id` not an array and not a regular expression (an ObjectId is added when it is missing); BSON size limit below.
* Tests: `tests/unit/explorer-rules.test.ts` (17 tests, 25 forbidden operators in four positions each, every wrapper, depth/size/count limits), `explorer-hostile.test.ts` (over HTTP; for each refused input the engine call counters are unchanged).

### 4. Limits

| Limit | Value | Where |
| --- | --- | --- |
| Request body | 256 KiB (Fastify, whole service) | `app.ts` |
| Document size (BSON) | 192 KiB default, `DATA_MAX_DOCUMENT_BYTES`, hard ceiling 200 KiB | `config.ts`, `rules.ts` |
| Documents per page | 25 default, 100 maximum (`DATA_DEFAULT_PAGE_SIZE`, `DATA_MAX_PAGE_SIZE`, ceiling 100) | `config.ts` |
| Paging depth | skip ≤ 10,000 (`DATA_MAX_SKIP`) | `services/explorer.ts` |
| Bytes read per page | 4 MiB of BSON (`DATA_MAX_RESPONSE_BYTES`); the cursor is read in batches of at most 25 and closed as soon as the budget is reached (`truncated: true`); a single listed document over 1 MiB of JSON is replaced by `{ tooLarge, sizeBytes }` | `data-mongo.ts`, `services/explorer.ts` |
| Command time | `maxTimeMS` = `DATA_COMMAND_TIMEOUT_MS` (10 s default, ≤ 60 s) on every command; the client gives up 2 s later whatever happens (`withDeadline`), plus socket and server-selection timeouts | `services/explorer.ts`, `data-mongo.ts` |
| Filters with a regular expression | `maxTimeMS` = `DATA_REGEX_TIMEOUT_MS` (**2 s default**, never above the command time) for a find whose filter has `$regex` (or a BSON regex) anywhere | `services/explorer.ts` (`hasRegex`) |
| Requests per minute | per person and per API key: `DATA_RATE_LIMIT_PER_MINUTE` (120) for all Data Explorer requests, `DATA_WRITE_RATE_LIMIT_PER_MINUTE` (30) for writes; on top of the existing per-workspace limit | `routes/explorer.ts` (same `RateLimiter` as `ratelimit.ts`) |
| Collections listed | 500, counts for the first 100 (4 at a time) | `services/explorer.ts` |

No answer loads a whole collection: there is no count of documents (only the metadata estimate), no "export", and every read is a bounded cursor. Tests: `explorer.test.ts` ("limits", "timeouts").

### 5. Roles

* Reading: everyone who can read the database today: owner, admin, member, and every API key of the workspace.
* Inserting, saving, deleting: owner, admin and member (the same people who can already create, fork and restore databases, which also change data), and **only API keys whose `data_access` is `read_write`**. A key without it gets 403 on every write, and the refusal is audited (`outcome = denied`).
* The roles were enough for people. For keys there was no notion of "read only", so the minimal change is one column, `api_keys.data_access` (`read` | `read_write`, default `read`) in migration 0004. **Every key that exists today becomes read-only for documents**; a read-write key is made with `POST /api-keys {"name": …, "dataAccess": "readWrite"}` (owner or admin, signed in; keys still cannot make keys). The dashboard's API keys page was not changed, so read-write keys are made through the API for now. Tests: `explorer.test.ts` ("roles and API keys").

### 6. Credentials towards the engine: one engine user per database

**The model.** Every customer database `db_<hex>` has its own engine user `cp_<hex>` (same 32 hex digits, the id of the Postgres row), defined on that database (its authentication database is `db_<hex>`), with exactly one role: the engine's built-in `readWrite` on `db_<hex>`. The Data Explorer connects to a database **as that database's user and as nobody else**: `MongoDataClient` keeps one driver client per database (`src/engine/data-mongo.ts`), and both the database name and the credential come from the same `DataTarget` (`targetDbName`, `engineCredential`). There is no credential that can read every database anywhere in the Data Explorer's reach.

So the per-database limit no longer rests on our code alone. Proved against the real engine (`tests/engine-real/security.test.ts`, branch `compat-gaps` with `--auth --tls-mode requireTLS`):

* A's user is refused (`Unauthorized`, 13) on B for `find`, `count`, `listCollections`, `insert`, `update`, `delete`, upsert, `create`, `drop`, `createIndexes`, `dropDatabase`, `$merge`/`$out` from A into B, `renameCollection` A → B, `createUser`/`grantRolesToUser`, reading `admin.system.users`; `listDatabases` shows it only A; it cannot even drop its own database (that is the control plane's job). B is byte for byte unchanged.
* A simulated bug that forces B's name while serving a request for A (the driver's `db()` patched to always answer B) is refused by the engine: 503 to the customer, nothing of B in the answer, audit `attempted` + `failed`, B unchanged.
* After erase the user is gone: a new connection fails authentication (18), and a connection that was already authenticated loses its rights at once (13) because the engine re-reads a user's roles when users change.

**Passwords are derived, never stored.** `password = 40 characters of [A-Za-z0-9] from HMAC-SHA256(ENGINE_USER_KEY secret, "fenvix-engine-user" ‖ version ‖ "db_<hex>")` (`src/engine/credentials.ts`; unbiased mapping by rejection sampling, about 238 bits). Nothing is written to Postgres, to the audit log, to operation records or to logs; the control plane computes the password when it needs it. The letters-and-digits alphabet needs no escaping in a URI and is unchanged by SCRAM's SASLprep. The key has a **version** (`v1`, `v2`, …) that is part of the derivation, so the same secret under a new version gives new passwords, and the user's `customData.fenvix.keyVersion` on the engine says which version its password was made with (a version is not a secret).

**Settings** (`config.ts`, `engineUserSettings`):

| Variable | Secret | Meaning |
| --- | --- | --- |
| `ENGINE_USER_KEY` (or `_FILE`) | yes | `v<N>:<at least 32 characters>`, the master key. In production: SSM SecureString `/fenvix/<env>/control-plane/engine-user-key` (the fetch script turns it into `ENGINE_USER_KEY`). |
| `ENGINE_USER_KEY_PREVIOUS` (or `_FILE`) | yes | Only during a rotation: the previous key (another version, another secret). SSM `/fenvix/<env>/control-plane/engine-user-key-previous`. |
| `ENGINE_PROVISIONER_USERNAME` | no | The engine user that creates and drops the per-database users (see below). Must not start with `cp_`. |
| `ENGINE_PROVISIONER_PASSWORD` (or `_FILE`) | yes | Its password. SSM `/fenvix/<env>/control-plane/engine-provisioner-password`. |
| `ENGINE_PROVISIONER_AUTH_SOURCE` | no | Default `admin`. |
| `ENGINE_USER_SWEEP_SECONDS` | no | How often users are compared with Postgres (default 3600; 0 off). |
| `DATA_ENGINE_ENDPOINTS`, `DATA_ENGINE_TLS` (`true`), `DATA_ENGINE_TLS_CA_FILE`, `DATA_ENGINE_TLS_SERVER_NAME` | no | Where the engine's MongoDB listener is and how its certificate is checked (unchanged). |

Rules enforced at start: with `ENGINE_DRIVER=real` and the Data Explorer on, `ENGINE_USER_KEY` is required; `DATA_ENGINE_USERNAME` (the old shared credential) cannot be set with it and is **refused in production**; the master key, the provisioner's password and the admin token must be three different secrets (a leak of one does not open the others); the previous key must differ from the current one in version and secret. Errors never contain a secret (unit tests).

**Three credentials, three places, never mixed.**

1. The **admin token** (`ENGINE_ADMIN_TOKEN`) opens the engine's admin interface (8443). Only `src/engine/admin-http.ts` uses it.
2. The **provisioner** (`ENGINE_PROVISIONER_*`) is an engine user on the MongoDB listener with a custom role holding only `createUser`, `dropUser`, `viewUser`, `changePassword`, `changeCustomData`, `grantRole`, `revokeRole` on any database: it can read no document. Only `src/engine/users.ts` (`MongoEngineUsers`) authenticates as it; its client is separate from the Data Explorer's.
3. The **master key** (`ENGINE_USER_KEY`) is the only thing the Data Explorer receives (`app.ts` passes `{ current, previous }` and nothing else to `MongoDataClient`; a unit test checks that the client holds nothing of the provisioner). The Data Explorer can therefore only ever authenticate as a per-database user.

**Life cycle** (`src/services/operations.ts`; every step repeatable):

| Operation | Engine user |
| --- | --- |
| create | engine database, then `createUser cp_<hex>` (or `updateUser` if it is there: a retry repairs password and role), then Postgres `ready`. If the user cannot be made for good, the create fails and **the engine database is erased** before the row is removed. |
| fork | the fork gets its own new user `cp_<fork hex>`; the source's user has no right on the fork (its role names the source only), nor the fork's on the source. Tested. |
| restore | users are not inside the database, so a restore leaves the user as it was; it is re-ensured after the restore (best effort: retrying the operation would apply the restore again; the sweep repairs a missing user). |
| export | nothing: users live in `admin.system.users`, not in `db_<hex>`; the dump holds no user, hash or `SCRAM` record (tested). |
| erase | **the user is dropped first** (from then on nobody, including a connection already open, can write the database while or after it goes), then the engine erase, then the Postgres row. If the engine refuses the erase for good (a fork still reads it), the user is made again and the database stays `ready`. |

**No orphan users.** Two mechanisms. (1) A failure for good undoes the engine side before Postgres says "failed" (`finishFailed`): what a create or fork made is erased together with its user; when the engine cannot be reached for that, the operation goes back to the queue with its failure kept (`params.pendingFailure`) and only the clean-up is retried; the row stays hidden (`provisioning`) meanwhile. (2) The **user sweep** (`src/services/engine-users.ts`, every `ENGINE_USER_SWEEP_SECONDS`) lists the engine's `cp_*` users (`usersInfo forAllDBs`) and the databases in Postgres (`fenvix_cp_engine_databases()`, migration `0005`): users without a row are dropped, `ready`/`restoring` rows without a user get one, users on an older key version get the current one. It lists users before rows; since operations make the row before the user and drop the user before the row, a user seen without a row really is an orphan. Tested on the real engine (an orphan made by hand is dropped, a dropped user is made again, a second sweep changes nothing) and with the fake.

**Rotating the master key without stopping the service.**

1. Make a new secret and give it a new version, e.g. `v2:<new secret>`. Store it as the new `/fenvix/<env>/control-plane/engine-user-key`, and store the old value (`v1:…`) as `/fenvix/<env>/control-plane/engine-user-key-previous`.
2. Restart the control-plane instances one by one (each reads SSM at start). From now on both versions are valid at the same time: an instance tries a database's user with the version that worked last for it, and on `AuthenticationFailed` with the other one (`MongoDataClient.run`). Instances still running with v1 alone keep working, because no user has changed yet.
3. When **every** instance runs with v2 + previous v1, let the sweep run (or wait `ENGINE_USER_SWEEP_SECONDS`): it gives every user the v2 password (`updateUser`, `customData.fenvix.keyVersion = "v2"`), logging `rotated: N`. A connection that is already authenticated is not cut; new connections use v2.
4. When a sweep reports `rotated: 0, failed: 0`, remove `engine-user-key-previous` and restart the instances again. Now only v2 exists.

Order matters: an instance that knows only v1 is refused (clean 503) for every database the sweep has moved to v2, and for databases created by an instance already on v2. The sweep only moves users forward (`olderVersion`): an instance not yet restarted never moves a v2 user back to v1. Tested on the real engine end to end (v2 + previous v1 both work at once; the sweep moves every user; v2 alone works; v1 alone is refused cleanly). If the master key leaked, do the same with urgency: after step 3 the leaked key opens nothing.

**Making the provisioner (once per engine, by an operator).** On an engine started with `--auth`, the first user can be created only from the machine itself (localhost exception). From the engine host:

```
db.getSiblingDB("admin").createUser({ user: "<break-glass root>", pwd: <random>, roles: ["root"] })   // kept offline
db.getSiblingDB("admin").createRole({ role: "fenvix_provisioner", roles: [], privileges: [{ resource: { db: "", collection: "" },
  actions: ["createUser", "dropUser", "viewUser", "changePassword", "changeCustomData", "grantRole", "revokeRole"] }] })
db.getSiblingDB("admin").createUser({ user: "fenvix_provisioner", pwd: <random>, roles: [{ role: "fenvix_provisioner", db: "admin" }], mechanisms: ["SCRAM-SHA-256"] })
```

The test suite does exactly this (`tests/helpers/engine-proc.ts`, `bootstrap()`).

**Known engine gap (reported, not fixable here).** The engine's `createUser` checks only the `createUser` action, not `grantRole` on the roles it grants (mongod checks both). So the provisioner, which can read nothing, *can create a user with `root`*: a stolen provisioner password is as strong as root. Shown by a `todo` test in `security.test.ts` that turns green when the engine is fixed. Until then: keep the provisioner password only in SSM, give it to the control plane only, and rotate it if in doubt. The same engine also **echoes the whole command in its `Unauthorized` message, `pwd` included**; the control plane never passes an engine message on (only the kind and the numeric code), and a test makes the engine refuse a `createUser` and checks that the derived password is in no answer, log or operation record.

**What the customer's connection string says.** Unchanged (`mongodb://app_user:<password>@<host>:<port>/db_<hex>?tls=true`): the per-database user of this change is the control plane's own way into one database (the Data Explorer), and its password is never shown. Giving customers their own credentials (a user per database for the application, a password shown once, reset) is a separate decision (see results-e2e-engine.md).

### 7. Sensitive data

* Logs: one line per Data Explorer call, `{ dataExplorer: { databaseId, op, outcome, durationMs, documents } }` on a logger already bound to `workspaceId` and `actor` (user id or key id). Failures add the error kind and numeric code. Never a document, a filter, a value, an `_id`, a collection name, an engine name or an engine message. The request path is logged as `/v1/databases/<id>/data/[redacted]` (`logPath`, `app.ts`); query strings were already never logged. Tested with markers in documents, filters, `_id`s and collection names (`explorer.test.ts`, "logs").
* Audit: `public.data_audit_log` (migration `0004_data_explorer.sql`): workspace, actor type and id, database id, collection, operation (`insert`/`replace`/`delete`), document `_id` (canonical Extended JSON, at most 1024 characters), outcome, request id, time. One `attempted` row before the engine call and one `ok`/`failed`/`conflict` row after it; refusals are `denied`. Never the content of a document. The control-plane role can insert and read it (its own workspace only, RLS), cannot update or delete it; `anon` and `authenticated` cannot read it. Reads are not audited (they are logged).
* Idempotency: Data Explorer writes use the `no-replay` mode, so `public.idempotency_keys` keeps a status, never a document (tested).

### 8. Answers and errors

* Errors are the service's usual `{ error: { code, message, field? } }`. Engine failures are mapped (`toApiError`): duplicate `_id` → 409; a refused command → 400 "The database refused this request."; timeout, unreachable engine, the engine's own internal errors, our credentials refused → 503 `unavailable` with `Retry-After`. No stack, no engine message, no address, no engine name.
* Every Data Explorer answer, errors included, carries `Cache-Control: no-store`, `Pragma: no-cache`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer` (an `onSend` hook in the explorer's own plugin, so other routes are unchanged).
* CORS and cookies are unchanged: no new allowed header, method or origin (DELETE was already allowed; the version travels in the body or the query, not in an `If-Match` header, for that reason).

### 9. Dashboard

* Every key and value of a document is rendered as React text (`src/components/DataExplorer.tsx`, `src/lib/ejson.ts`). No `innerHTML`, `dangerouslySetInnerHTML`, `insertAdjacentHTML`, `document.write` or `eval` exists anywhere in `src/` (a unit test reads every file). The check "documents are shown as text, never as markup" shows a document holding `<script>…</script>` and `<img src=x onerror=…>`, expands it, opens it in the editor, and verifies the text is there, no `script`/`img`/`iframe`/`object` element was created, no browser dialog opened and the script's side effect did not happen; on desktop and phone.
* Deleting asks for confirmation (the `_id` is named). Saving and deleting send the `version` last read; the server compares it with the current document, and then makes the engine apply the change only to the document as it was read (filter on `_id` and every top-level field with `$eq`). A change by someone else in between gives 409, the dashboard says so and offers to load the latest version (tested end to end, including a change made between the version check and the engine call).
* The dashboard calls the API with the Supabase session token as `Authorization: Bearer`, `credentials: "omit"`, `cache: "no-store"`. It needs `VITE_API_URL`; without it the Data tab says it is not set up.

### 10. MongoDB types

**Canonical Extended JSON v2**, both ways. Every value keeps its type (`{"$numberInt":"5"}` vs `{"$numberDouble":"5.0"}` vs `{"$numberLong":"5"}`, `$oid`, `$date`, `$numberDecimal`, `$binary` with subtype, `$timestamp`, `$regularExpression`, `$minKey`/`$maxKey`), so a document read and saved unchanged comes back byte for byte identical. Relaxed EJSON was not chosen because it loses types (int32 vs int64 vs double, dates as ISO strings). Input may also be relaxed: a bare JSON number is typed like canonical parsing does (int32 if it fits, int64 for other integers, double otherwise). The driver is told not to convert values (`promoteValues/promoteLongs/promoteBuffers: false`, `bsonRegExp: true`) on reads only (on the whole client it also turned the engine's own error codes and counts into objects; found against the real engine, fixed, tested). Tests: unit (every wrapper round trip), real engine (a document with fourteen fields of every common type inserted and read back identical).

### 11. Sleeping databases

* The first request to a sleeping database wakes it in the engine. The client waits up to `DATA_COMMAND_TIMEOUT_MS` + 2 s; if that is not enough the answer is 503 with `Retry-After: 2` and a message that says it is waking. The dashboard shows "Waking the database…" while a request to an asleep database runs (immediately) or any request takes more than 0.9 s, and retries a 503 up to 5 times as `Retry-After` says. To make that retry safe for inserts, the dashboard chooses the `_id` before the first attempt; a save retried after it actually landed gets 409 (version changed) and never overwrites.
* Connections: one driver client per database (it authenticates as that database's user), at most `DATA_ENGINE_MAX_CLIENTS` (100) open (the least recently used idle one is closed first; if all are busy the request gets 503), each with a pool of at most `DATA_ENGINE_POOL_MAX` (5) connections, each closed after `DATA_ENGINE_POOL_IDLE_MS` (30 s) unused, `minPoolSize` 0, and the whole client (including its monitoring connection) is closed after `DATA_ENGINE_CLIENT_IDLE_CLOSE_MS` (60 s) without a request for that database.
* How this interacts with sleep and keep awake: the engine wakes and keeps a database open only for commands that name it, and closes it after its idle time (`--idle-secs`). A connection is to the engine, not to a database, and the driver's monitoring sends `hello` to `admin`. Verified on the real engine: with a client connected and sending heartbeats every 500 ms, the database written through it was closed by the engine 5 s after the write (`writer_close` / `release` in the engine log). So an open browser tab, an idle pool or the monitoring connection keep nothing awake; only actual Data Explorer requests do, like any client's. The dashboard never polls. "Keep awake" is unchanged: a pinned database stays awake whatever the explorer does; browsing an unpinned database keeps it awake only while requests come, then it sleeps after the engine's idle time.

## Residual risk (what is not solved)

1. **The control plane still holds the master key**, from which every database's password can be derived, and the provisioner. A compromised control-plane process can therefore still reach every database (as it can erase them with the admin token). What changed: a *bug* in the code can no longer cross databases (the engine refuses), and no credential that reads everything exists in the Data Explorer, in Postgres or in a log. Narrower still would need the engine to accept short-lived per-request tokens.
2. **Engine gaps** (above): the provisioner can create a `root` user (no `grantRole` check), and refusals echo the command, password included. Both reported; both covered by tests on our side.
3. **Regex cost.** Patterns are limited to 256 characters and three options, and a filter with a regex gets `DATA_REGEX_TIMEOUT_MS` (2 s by default): a pathological pattern can use the engine's CPU for up to 2 s per request (and per-person rate limits apply).
4. **Concurrency window.** The `$eq` filter catches changes to any field that existed when the document was read. A field *added* by someone else between the version check and the replace (milliseconds) would be dropped by the replace. Documents whose top-level field names contain `.` or start with `$` (legal in MongoDB 5+) are protected by the version check only.
5. **Writes that time out.** A write that times out on the client may still have been applied by the engine; it is audited as `attempted` + `failed`. The dashboard handles this for inserts (its own `_id`) and saves (version); an API client that inserts without an `_id` and retries can insert twice (send your own `_id`).
6. **Response size.** The 4 MiB budget counts BSON bytes; canonical Extended JSON is larger (typically 1.5 to 3 times), so one answer can reach about 10 MiB of JSON.
7. **Rate limits are per instance** (in memory, as for the rest of the service).
8. **Documents the editor cannot save.** Documents holding `$code`, DBRefs, `$`/`.` field names, or nested deeper than 32 levels are shown but refused on save (by design: those shapes are refused on input).
9. **The `_id` is stored in the audit log and in idempotency records** (as asked: it identifies the document). If customers use personal data as `_id` (an email), that is personal data in the audit log.
10. **Not run on AWS, not against a published engine release, not against one binary with both the admin interface and authentication** (the fused branch did not exist yet): see `results-e2e-engine.md`.
