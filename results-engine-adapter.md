# Results: engine adapter (`ENGINE_DRIVER=real`)

Branch `engine-adapter` of `mircoguidetti/olvix-app`, from `main`. Not merged, no pull request, nothing deployed. No AWS call, no secret, no change to the landing, the root `docs/` or the dashboard's `src/`. Design, mapping and open questions: [`control-plane/docs/engine-adapter.md`](control-plane/docs/engine-adapter.md).

The engine side was read in `Mircoguidetti/test5`, branch `control-ops` (`results-ops.md`, `mongo-server/src/ctl/*`, `ctl-tests/*`), read only, at commit `1f473f9`. The adapter was written from that code. The engine itself was **not run**: the tests use a simulated engine (`control-plane/tests/helpers/sim-engine.ts`) that models only what that code says.

## What is done

| Item | Where |
| --- | --- |
| Real adapter with the same interface as the fake: create, get, fork, restore, export (+ download), erase, keep awake, usage. `listDatabases` is not offered (the engine cannot do it) | `control-plane/src/engine/real.ts`, `admin-http.ts`, `names.ts`, `zip.ts` |
| Every production value from configuration (admin address per region, token or token file, CA / client certificate files, ports, hostname template, domain, fork mode, restore window, timeouts). Nothing in the code; the service refuses to start with the real driver when something is missing or wrong, and says what | `control-plane/src/config.ts`, `README.md` |
| Ports and hostnames: engine name `db_<id>`, hostname `<name>-<workspace>.<region>.db.<domain>`, engine ports 27018 (MongoDB) and 8443 (control) in `infra/`. Decision and reasons written down | `docs/engine-adapter.md` ("Names, ports, hostnames"), `infra/` |
| Permission boundary: route allowlist and name namespace in the adapter (code, tested), admin port closed to the internet (existing, now 8443), metadata hop limit 1 so the control-plane container cannot reach the instance role (new), restricted Postgres role (existing) | `admin-http.ts`, `infra/lib/fenvix-stack.ts`, `docs/engine-adapter.md` |
| The dashboard's side door closed, as the README announced | `supabase/migrations/0003_close_dashboard_write_path.sql` (a separate file, to run at cutover) |
| Uniqueness of hostnames in the database | same migration, `databases_host_unique` |

## What was run

All on this machine: Node 22.22, a scratch Postgres 16 (migrations 0001, 0002, 0003 applied twice), no network beyond localhost.

| Run | Result |
| --- | --- |
| `main` before any change: `npm test` in `control-plane` | typecheck ok; 22/22 unit; integration 139 tests: **136 pass, 2 fail**, 1 skipped |
| This branch: `npm test` in `control-plane` | typecheck ok; **73/73 unit** (51 new); integration 162 tests: **159 pass, 2 fail (the same two as on `main`)**, 1 skipped (the seeded scale test, needs the 3,000-database seed) |
| `npx jest` in `infra` | 5 suites, **66/66 pass** (includes cdk-nag with no unsuppressed findings, the new port, admin-port and hop-limit assertions) |
| Production start path: `node src/server.ts`, `NODE_ENV=production`, real driver against the simulator | with an `http://` admin address and no `ENGINE_ADMIN_ALLOW_PLAIN_HTTP`: one readable fatal line, no listener; with it: `/healthz` 200, `/readyz` 200, `/v1/databases` without a session 401; the token and the admin address appear nowhere in the output |
| Zip written by the adapter, read by Python's `zipfile.testzip()` and by `unzip -t` | ok (this found and fixed a bug: an empty chunk reset the CRC) |

**The two integration failures exist on unmodified `main` and are not caused by this work.** (1) `usage sync (engine to Postgres)`: the test places a usage row 30 hours back and expects it inside "since yesterday 00:00 UTC", which is only true after about 06:00 UTC; it failed at 01:55 UTC (`2 !== 3`). Not confirmed by changing the clock. (2) `two identical requests at the same moment do not both run`: once the second request answered 500 (`201,500`); run alone six times in a row it always gave 201/409, so it depends on the state left by earlier tests; cause not found. Neither was touched.

New tests, by what they prove:

* `tests/unit/real-engine.test.ts` (41): the same contract suite against the fake and against the real adapter + simulator; create / fork / erase / keep-awake repeated and after a lost answer; every error mapping; restore with and without history; export with a broken transfer resumed and with more breaks than allowed; expired snapshots; several regions (an unreachable region is not "not found"); TLS with a throw-away certificate (trusted only through the configured CA, wrong name refused); the route allowlist (14 requests allowed on the 13 routes, 22 refused, none of them reaches the simulator; a full run uses only allowed routes).
* `tests/integration/real-engine.test.ts` (16): the whole service on the real driver: create, same name in two workspaces, fork, restore (and refusal), keep awake, export + signed download + forged link, usage sync, erase refused while a fork exists, erase; failures once, lost answers for create and erase finished by the sweeper with one database in the engine; the engine is asked only for names of this service and never for the list; no secret in the log.
* `tests/integration/closed-door.test.ts` (7): the dashboard role after 0003 can read, cannot write the four tables, cannot call the eleven functions, nothing changed, the control plane works, the file is safe to run again, hostnames cannot repeat (and the API answers the ordinary 409).
* `tests/unit/config-real.test.ts` (8), `tests/unit/zip.test.ts` (2).

## What is doubtful

* **The simulator is my reading of the engine.** Any difference between it and the engine (field names, status codes, 409 codes) is invisible to every test here. Question 15 in the adapter doc.
* `restore_retried` (500) is treated as success because its message says the retry completed it; `erase_incomplete` (500) is retried. Both come from reading `pitr.rs` and `erase.rs`.
* A retried restore is applied again; a retried export makes another snapshot (the engine has no idempotency key). The adapter remembers export keys in memory only.
* The hop limit of 1 and "a container cannot reach the instance role" are not verified on AWS.
* The export is a ZIP built by the control plane (no ZIP64, folders named by engine name, size reported as 0). A product choice made by me, not by the engine.
* The usage numbers are daily, put at 00:00 UTC of their day. Hourly charts on the real driver are not real hourly data.
* `fenvix_save_settings` and the other revoked functions are the only ones 0003 removes; the dashboard can still rename the workspace (`workspaces` update policy) and write the usage and invoice tables through RLS. Not in the README's list, so not touched: **a signed-in user can still forge their own `usage_daily` / `usage_hourly` rows**. Worth a decision.
* The stale text of `infra/README.md` (still says 27017 / admin 27018 and "TLS") was left as it is: the instruction was not to touch documentation. The three lines to change: the "Network" row, the `adminPort` row (add `mongoPort`), and the TLS claim.

## Open questions

The full list (15) is in `control-plane/docs/engine-adapter.md`. The ones that decide whether it can go live:

1. The engine's MongoDB listener has **no authentication, no TLS and no tenant isolation**: any client reaching it can use any database name and list them all. The connection string's `app_user:<password>` and `tls=true` are not backed by anything.
2. What routes the hostname to the engine (the engine ignores it)?
3. Is there TLS in front of the admin interface (it has none)?
4. Idempotency keys for restore and export.
5. How plan retention relates to the engine's restore window.
6. What erase should do for a database with clone forks (the engine refuses).
7. Billing for the last partial day of an erased database (the engine returns it once, the control plane drops it).

## What is missing to connect it to the published engine

1. Publish the engine (`control-ops` merged and released) and answer questions 1 to 3.
2. Run the round trip at the end of `docs/engine-adapter.md` against it with a local S3-compatible store.
3. Make `infra/` and the engine agree on names (`FENVIX_LISTEN` etc. vs `--listen`, `MONGO_ADMIN_TOKEN`) and give the container the settings this service reads; add the SSM parameter `/fenvix/prod/control-plane/engine-admin-token`.
4. Set the production values (README, "Switching to the real engine").
5. At cutover, after the dashboard calls the API: run `0003`.
