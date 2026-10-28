# Database users ("Database Access")

How a customer's application connects to its own database: the users, their passwords, who can manage them, and what
happens to them through the life of a database. Code: `src/services/db-users.ts` (rules and order), `src/routes/users.ts`
(routes), `src/engine/users.ts` (the engine side, real and in memory), `src/services/operations.ts` (create, fork, erase),
`src/services/databases.ts` (`connectionString`). Migration: `supabase/migrations/0007_database_users.sql`.

## 1. Two kinds of users on every database

| User | Who uses it | Password | Listed / changeable through the API |
| --- | --- | --- | --- |
| `cp_<hex>` | the control plane (Data Explorer) | derived from `ENGINE_USER_KEY`, never shown (`data-explorer-security.md`) | **never**: not listed, and a name starting with `cp_` cannot be created, reset or deleted |
| the customer's (`app`, ...) | the customer's applications | random, shown **once** | yes |

Both are engine users defined on the database itself (`db_<hex>`, so `authSource` is the database) with **one** role on
that database only. Users are in the engine only: the control plane keeps no list of them and no password, hash or
SCRAM material, anywhere.

## 2. Roles: a fixed list on the server

| Name in the API | Engine role | Database |
| --- | --- | --- |
| `readWrite` (default) | `readWrite` | the user's own `db_<hex>` |
| `read` | `read` | the user's own `db_<hex>` |

A request names one of these two strings and nothing else. The engine role and its database are set by the server
(`CUSTOMER_ROLES` in `engine/users.ts`, `customerCommand`). Objects, lists, other roles (`root`, `dbOwner`, `userAdmin`,
...), names inherited from `Object.prototype` (`toString`, `__proto__`), and any other field in the body (`roles`, `db`,
`pwd`, `password`, `customData`, `mechanisms`, `privileges`) are refused with `400`, not ignored.

This does **not** depend on the engine: today the engine's `createUser` does not check `grantRole` on the roles it grants
(the provisioner could create a `root` user; reported, `security.test.ts` "ENGINE GAP"). The control plane never sends a
role outside the list, whatever the request says (tested by recording every role sent to the engine, and by reading the
users back from the real engine as root).

## 3. Names

3 to 32 characters: a lowercase letter, then lowercase letters, digits, `_` or `-` (`^[a-z][a-z0-9_-]{2,31}$`). Nothing is
trimmed or lowercased. Reserved: `admin root system local config fenvix provisioner superuser backup restore monitor
cluster internal support readwrite read dbowner`, the deployment's `ENGINE_PROVISIONER_USERNAME`, and any name starting
with `cp_`, `cp-`, `fenvix`, `mongo`, `system`, `__`. In a URL, a name that breaks the rule is a user that does not
exist (`404`), never a `400` that would tell `cp_<hex>` apart.

## 4. Who may do what

| Caller | List | Create, reset password, delete |
| --- | --- | --- |
| owner, admin | yes | yes |
| member | yes | no (`403`, audited as `denied`) |
| API key, `userAccess: "none"` (**default**, every existing key) | yes | no (`403`, audited as `denied`) |
| API key, `userAccess: "manage"` | yes | yes |
| anyone, a database of another workspace | `404` | `404` |

`userAccess` is set when a key is made (`POST /api-keys`, by an owner or admin with a session: keys cannot make keys) and
is stored in `api_keys.user_access` (migration 0007). A database of another workspace and a database that does not
exist give the same `404` with the same body, from the same query, on every route, for people and keys.

Creating a database (or a fork) also creates its initial user and shows its password to whoever created it; members and
API keys can create databases (unchanged), so they get that password. They could already read and write every document
of the workspace through the Data Explorer.

## 5. A password is shown once

* Made by `randomPassword()` (`engine/credentials.ts`): 40 characters `[A-Za-z0-9]` from `crypto.randomBytes`, rejection
  sampling (no bias), about 238 bits.
* Sent to the engine in `createUser` / `updateUser` (the engine keeps the SCRAM-SHA-256 hash only) and put in **one**
  answer: `201` of `POST /users`, `200` of `reset-password`, or the create/fork answer. Those answers have
  `Cache-Control: no-store`, `Pragma: no-cache`, and (users routes) `X-Frame-Options: DENY`, a `default-src 'none'` CSP
  and `Referrer-Policy: no-referrer`.
* Never in Postgres (no table has it: operations keep `initialUser: { username, role, password: null }`; idempotency
  records keep only the status), never in a log (the driver's command is never logged; engine errors are reduced to a kind
  and a code), never in the audit log, never in a later answer. Tested by collecting every password shown and searching
  every answer, the service log, the engines' logs and the tables `audit_log`, `data_audit_log`, `operations`,
  `idempotency_keys`, `databases`, `api_keys`.

**The initial user** is made inside the create (or fork) operation, which can be retried. Its password lives in this
process's memory only (`src/once.ts`, `OnceSecrets`, 10 minutes) between the operation and the answer: the request that
submitted the operation (same request id, same person or key) takes it out once. Consequences, by design:

* a repeat of the create with the same `Idempotency-Key` replays the operation: the same database, `password: null`, no
  second user, and the first password is not changed;
* a create whose answer is a `202` (the operation outlived `OPERATION_WAIT_MS`), or that finished on another instance or
  after a restart, never shows the password: the user exists, `initialUser.password` is `null`, and the dashboard says to
  reset it;
* a retry of the operation in the same process sets the same password again; a retry elsewhere sets a new one (nobody
  had seen the first).

**Create user and reset password** use `Idempotency-Key` "no-replay" (as `POST /api-keys`): a repeat with the same key is
`409 conflict` ("cannot be shown a second time") and makes no second user or password. Without a key, a second create of
the same name is `409` (the name is taken).

## 6. Connection string

`mongodb://<user>:<password>@<host>:<CONNECTION_PORT>/<db>?tls=true&authSource=<db>&authMechanism=SCRAM-SHA-256`

* `<db>` is `db_<hex>` with the real engine (`CONNECTION_DB_NAME=engine`), and it is also `authSource`, because users are
  defined on the database. (Before this work the string said `app_user`, a user that did not exist, and had no
  `authSource`, so a driver would have authenticated against the wrong database.)
* `<user>` in `Database.connectionString` is the database's initial user (`databases.app_user`, migration 0007): `app`
  unless named otherwise. When that user is deleted it becomes `<username>`, and the next user created takes its place.
* `<password>` stays a placeholder everywhere except in the one answer that shows a password, where
  `connectionString` is the complete string.
* Proved against the real engine: the string from the create answer, with only the host and port pointed at the local
  test engine (the real host is a DNS name of the deployment), connects with the official Node.js driver and with
  pymongo, writes, updates, indexes and reads; the same string with `tls=false` is refused.

## 7. Life cycle

| Event | Users | Where |
| --- | --- | --- |
| create | `cp_<hex>`, then the initial user (`readWrite`). If the initial user cannot be made, the create fails and everything is undone: every user of the database is dropped, then the database (`cleanupEngine` → `dropAll`). An engine that does not answer is retried as before. | `operations.ts` |
| fork | the fork gets its own `cp_<hex>` and a **new** initial user with a **new** password. The source's users are never copied and have no right on the fork (their role names the source), and the reverse. | `operations.ts` |
| restore | users are not inside the database (they are in `admin.system.users`), so a restore leaves them exactly as they are: a user made after the restore point still exists and works. | tested |
| export | users are not in the dump. | `lifecycle.test.ts` |
| erase | 1. every customer user **loses its roles** (`lockCustomers`: `updateUser roles: []`, the roles kept in the user's own customData on the engine); 2. `cp_<hex>` is dropped; 3. the database is erased; 4. **every** user defined on the database is listed (`usersInfo`) and dropped (`dropAll`), because the engine's erase does not touch users. If the engine refuses the erase for good (a fork still reads it), `cp_<hex>` is made again and the customer users get their roles back (`unlockCustomers`): same passwords, working again. | `operations.ts` |
| delete a user | `dropUser`: a connection already open as that user is refused its next command (code 13), a new one cannot authenticate (18). | tested |
| reset a password | new connections need the new password (18 with the old one). **A connection already authenticated stays open** (as in MongoDB): to cut sessions, delete the user. | tested |
| sweep | the user sweep (`engine-users.ts`) only ever looks at `cp_<hex>` names: customer users are never dropped or changed by it, also on a database that has no row. | tested |

Why erase locks first instead of dropping the customer users first: dropping is irreversible (only the engine had the
passwords), and the engine does refuse some erases (a database with forks). Locking gives the same guarantee for the data
(from step 1 on, no customer user can read or write, open connections included: proved on the real engine) and lets a
refused erase give everything back. Every user is still gone after the erase.

The users routes refuse a database being restored or erased (`409`) and treat one still being created as not existing
(`404`). A change locks the database row (`for update`) for the length of its engine call, so an erase or a restore cannot
start in the middle of it and two changes to the same database's users run one after the other.

## 8. Limits

`config/limits.json` (`src/limits.ts`; a file without these keys gets the defaults):

* `maxUsersPerDatabase` (20): customer users per database, the initial user included, `cp_<hex>` not. The 21st is `409`.
* `userChangesPerMinute` (10): creates, resets and deletes, per person and per API key (`429` + `Retry-After`).
* `userListsPerMinute` (60): added to the above for all users requests of a person or key.
* the workspace's `RATE_LIMIT_PER_MINUTE` applies as to every route. In memory per instance (see the README).

## 9. Audit

`public.audit_log` (0002), in the same transaction as the change when it succeeds:

| action | outcome | metadata |
| --- | --- | --- |
| `database.user.create` | `ok`, `failed` (+ `code`), `denied` | `username`, `role` |
| `database.user.reset_password` | `ok`, `failed`, `denied` | `username` |
| `database.user.delete` | `ok`, `failed`, `denied` | `username` |

with the actor (person or API key), workspace, `target_type: database`, `target_id`, request id, address and time.
Never a password or a hash (the audit writer also removes any key named like `password`). A change that reaches a
database of another workspace (or none) ends in the `404` and is not written against that id; a refused one (`denied`,
checked before the database is looked up) is written in the caller's own workspace's log with the id as sent, if it has
the form of an id. The initial user is recorded with the
create (`database.create.requested` / `completed`).

## 10. Errors

Only our words: `400` (rule broken, with `field`), `403`, `404` ("That database does not exist." / "That user does not
exist."), `409` (name taken, limit, database busy, repeated key), `429`, `503` ("The database engine did not answer. Try
again in a moment."), `500` (generic). Engine messages, codes, addresses and stacks are never passed on (the engine's
`Unauthorized` errors repeat the whole command, password included: they are reduced to a kind before anything else
sees them). The initial user failing for good fails the create with "The database's first user could not be created, so
the database was not created. Try again."

## 11. Not done, or done only in part

* **The dashboard on Supabase does not create databases through this service yet** (it still calls the `fenvix_*`
  functions until the cutover, README step 9): there, creating a database shows no password, and the Users tab needs
  `VITE_API_URL`. The mock backend shows the whole flow.
* A reset does not end sessions already open (the engine behaves like MongoDB); delete the user to do that.
* The initial password is not shown when the create answers `202` or runs on another instance (§5): the user must reset it.
* Several instances: rate limits are per instance; `OnceSecrets` is per instance (by design).
* The user limit is checked under the database row lock: with several instances, two creates for the same database
  still run one after the other (the lock is in Postgres), so the limit holds.
* The engine's own `grantRole` check in `createUser` (§2) and a dedicated "kill sessions of a user" are engine changes.
