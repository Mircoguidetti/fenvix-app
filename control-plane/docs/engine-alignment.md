# Engine alignment: what the control plane and `infra/` assume, and what the engine does

Every difference found between the real FENVIX engine (`Mircoguidetti/test5`) and what this repository assumes, with the exact change each side needs. **`infra/` was not modified by this work**: section 3 is the list of changes to make there, file by file.

Engine code read and run: branch `control-ops` @ `1f473f9` (admin interface, `mongo-server/src/ctl/*`) and branch `compat-gaps` @ `2742441` (SCRAM, TLS, users and roles: `auth.rs`, `authz.rs`, `tls.rs`, `scram.rs`). The fused branch (`fusion-ops`) did not exist when this was written. `merge-engine` @ `e4a560c` has **neither** the admin interface nor authentication (its `mongo-server/src/` has no `ctl/`).

"infra (main)" means `infra/` on `origin/main` = `origin/infra-aws` @ `0c4a32c`. "infra (this branch)" means `infra/` as it is on `data-browser` / `e2e-engine`: commit `646b694` (engine-adapter) already changed the ports there, and nothing else since.

## 0. Update: the final engine (test5 `final-engine`, engine commit `41ed169`)

Checked on branch `e2e-final` (results in `results-e2e-final.md`). Where this section and the rest of the document disagree, this section is right; the rest describes the two older branches.

* **One binary** has the admin interface, `--auth`, TLS and the users (`mongo-server`, `cargo build --release --workspace`). The engine-real suite runs it as one process; `ENGINE_E2E_PROFILE=production` runs it as the deployment will (local S3 store, leases, region, admin interface on its own address).
* **S3**: credentials only from the standard AWS chain (environment variables, web identity, container, instance role via IMDSv2); `--region` (or `AWS_REGION` / `AWS_DEFAULT_REGION`) is **required**; `--endpoint` only for S3-compatible stores, empty means AWS. Nothing is fixed in the code any more (2.5 is solved). `--store local` now runs the control operations (one process only).
* **grantRole rule**: `createUser`/`updateUser`/`grantRolesToUser`/`createRole`/... need `grantRole` on the database of each privilege granted, and the possession of every cluster-wide or any-database privilege. The provisioner (`fenvix_provisioner`: 7 actions on `{db: "", collection: ""}`) still makes everything the control plane makes; it can no longer make `root`, `__system`, cluster roles or any-database roles (gap 2 below: closed). What it can still do with a stolen password: any **database-level** role on any named database (`dbOwner` on a customer database, `readWrite`/`userAdmin` on `admin`), and a copy of its own role. Tested in `tests/engine-real/final-engine.test.ts` (d).
* **Users and erase/create/fork**: the engine's erase deletes the users and roles defined on the database; create and fork refuse with `409 users_exist` a name that still has users or roles (`exists` is checked first, so a retry of our own create/fork still gets `409 exists`). The control plane keeps its own order (lock, drop `cp_`, erase, drop all): the last step now finds nothing, harmlessly. The control plane's names are made from new ids, so it never meets `users_exist` in its flows.
* **`Unauthorized` messages** no longer carry `pwd` (gap 3: closed; the control plane still passes none of the engine's text on).
* **`rotateCertificates`** really reloads the certificate with TLS on (unusable files are refused and the previous certificate stays); with TLS off it answers ok and does nothing. **But with `--auth` no user can run it, not even root** (`authz.rs` has no entry for it, so it needs the internal `anyAction`; the same is true of `tenantAdmin`). In production a renewed certificate therefore still needs an engine restart (2.4 and infra item 6 stay as written). The control plane never sends it.
* **`tenantAdmin`** (and every other engine command) is not used by the control plane: it drives the engine only through the admin interface with the token; on the data port it sends user commands (as the provisioner) and data commands (as `cp_<id>`). Checked in the source and in the engine's command log (`final-engine.test.ts`, b).
* Still open: TLS on the admin interface (gap 6), a role allow-list for the provisioner (new, see above).

## 1. Summary

| Topic | Engine (real) | Control plane | infra (main) | infra (this branch) |
| --- | --- | --- | --- | --- |
| MongoDB port | `--listen`, default `127.0.0.1:27018` | `CONNECTION_PORT` (connection strings), `DATA_ENGINE_ENDPOINTS` (Data Explorer, provisioner) | **27017** (SG + `FENVIX_LISTEN`) | 27018 (`mongoPort`) |
| Admin port | `--admin-listen`, **no default** (off unless set); 8443 is our convention | `ENGINE_ADMIN_ENDPOINTS` | **27018** (`adminPort`) | 8443 |
| How the engine is configured | **command-line flags only** (clap, no `env =`); the only environment variable read is `MONGO_ADMIN_TOKEN` | — | `FENVIX_*` environment variables, `ExecStart` with **no flags** | same |
| Admin token | `--admin-token-file`, `--admin-token`, or `MONGO_ADMIN_TOKEN`; ≥ 16 characters | `ENGINE_ADMIN_TOKEN` / `_FILE` | SSM `engine/admin-token` → `FENVIX_ADMIN_TOKEN` (not read by the engine) | same |
| TLS (MongoDB port) | `--tls-mode disabled\|allowTLS\|preferTLS\|requireTLS`, `--tls-certificate-key-file <PEM cert+key>`, optional `--tls-ca-file` (client certificates) — compat-gaps only | requires TLS (`DATA_ENGINE_TLS=true`), CA/name settable | `FENVIX_TLS_MODE=self-signed` (no such mode), ACM ARN (the engine reads no ARN) | same |
| TLS (admin port) | none (plain HTTP/1.1) | `https` supported, `http` allowed in production only with `ENGINE_ADMIN_ALLOW_PLAIN_HTTP=true` | port open to the SG only | same |
| Authentication | `--auth` (compat-gaps only); users in `admin.system.users`; localhost exception for the first user | per-database users + provisioner (`ENGINE_USER_KEY`, `ENGINE_PROVISIONER_*`) | `--auth` never set | same |
| Object store | `--store s3\|local\|memory`; s3: `--endpoint` (default `http://localhost:9000`), `--bucket` (default `bench`), **region fixed to `us-east-1`, credentials fixed to `minioadmin`/`minioadmin`, plain HTTP allowed** | — | `FENVIX_S3_BUCKET`, `FENVIX_AWS_REGION` (not read) | same |
| Database names | any name < 64 characters without `/\\. "$*<>:|?` and NUL; `admin`, `local`, `config` reserved on the admin interface | `db_<32 hex of the id>` (`CONNECTION_DB_NAME=engine` required with the real driver) | — | — |
| Hostnames | no part in routing (the database is the `$db` of each command; no SNI routing) | `<name>-<workspace>.<region>.db.<BASE_DOMAIN>` (`HOST_TEMPLATE` must contain `<workspace>`) | DNS `*.db.<domain>`, certificate `*.db.<domain>` | same |
| Control-plane settings | — | `REGIONS`, `API_PUBLIC_URL`, `DOWNLOAD_SIGNING_KEY`, `ENGINE_*`, `DATA_ENGINE_*`, `CONNECTION_*`, `HOST_TEMPLATE`, … | gives only `FENVIX_REGION`, `PORT`, `BASE_DOMAIN`, `SESSION_SECRET` | same |

## 2. Differences in detail

### 2.1 Ports

* The engine's MongoDB listener defaults to `127.0.0.1:27018` (loopback: unreachable from outside unless `--listen 0.0.0.0:<port>` is given). The admin interface exists only with `--admin-listen`; it has no default port. The control plane and the engine-adapter documents use **27018** (MongoDB) and **8443** (admin).
* infra (main) opens **27017** to the internet and tells the engine (`FENVIX_LISTEN`) to listen there, and uses **27018 as the admin port**. So on main the admin port is the engine's own default MongoDB port: a confusion waiting to happen.
* infra (this branch) already says 27018 / 8443 in code and tests (`646b694`), but `infra/README.md` still says "27017 (database) … admin port (27018)" (lines 11 and 40).
* The control plane's container listens on `PORT=8443` *inside* the container, published as `controlPlanePort` (443) on the host: no clash with the engine's 8443 on the host.

### 2.2 Flags, not environment variables

`mongo-server` takes its settings from flags (clap `#[arg(long)]`, `main.rs` and `ctl/mod.rs`). Not one `FENVIX_*` variable is read. With infra's `ExecStart=/opt/fenvix/bin/fenvix-engine` (no flags) the engine would start listening on `127.0.0.1:27018`, against an S3 endpoint `http://localhost:9000` bucket `bench`, with no admin interface, no authentication and no TLS. Flags the deployment needs (fused engine):

```
--listen 0.0.0.0:27018
--admin-listen 0.0.0.0:8443 --admin-token-file /run/fenvix/admin-token
--auth --tls-mode requireTLS --tls-certificate-key-file /etc/fenvix/tls/engine.pem
--store s3 --bucket <data bucket> [--endpoint https://s3.<region>.amazonaws.com]
--idle-secs 60 --retention-window-secs <window> (or per database via the control plane)
```

(`--replica-set` / `--advertise` only if customers need transactions or change streams; `--no-leases` never in production.)

### 2.3 Names of variables and SSM parameters

* Admin token. infra stores `/fenvix/<env>/engine/admin-token`; its fetch script turns it into `FENVIX_ADMIN_TOKEN` (engine group, `FENVIX_` prefix). The engine reads `MONGO_ADMIN_TOKEN` or `--admin-token-file`. Recommended: keep the SSM name, write the value to a 0600 file readable by the `fenvix` user (`/run/fenvix/admin-token`) in the `ExecStartPre` step, and pass `--admin-token-file` (a file, not the command line, which other users can read).
* The control plane needs the **same** token as `ENGINE_ADMIN_TOKEN`. The fetch script maps `/fenvix/<env>/control-plane/<name>` to `<NAME>` with `-` → `_`, so the natural names are:

| SSM parameter (SecureString) | Becomes | Note |
| --- | --- | --- |
| `/fenvix/<env>/control-plane/engine-admin-token` | `ENGINE_ADMIN_TOKEN` | same value as `/fenvix/<env>/engine/admin-token` |
| `/fenvix/<env>/control-plane/engine-user-key` | `ENGINE_USER_KEY` | `v1:<≥ 32 random characters>`; the master key of the per-database passwords |
| `/fenvix/<env>/control-plane/engine-user-key-previous` | `ENGINE_USER_KEY_PREVIOUS` | **only during a rotation** (not required) |
| `/fenvix/<env>/control-plane/engine-provisioner-password` | `ENGINE_PROVISIONER_PASSWORD` | the engine user that makes per-database users |
| `/fenvix/<env>/control-plane/download-signing-key` | `DOWNLOAD_SIGNING_KEY` | ≥ 32 characters |
| `/fenvix/<env>/control-plane/control-plane-database-url` | `CONTROL_PLANE_DATABASE_URL` | the `fenvix_control_plane` role's connection string |

* `/fenvix/<env>/control-plane/session-secret` → `SESSION_SECRET` is **not read** by the control plane (sessions are Supabase JWTs). It can stay or go; it should not be required.

### 2.4 TLS and certificates

* MongoDB port: the engine needs a PEM file holding the certificate chain and its private key (`--tls-certificate-key-file`). There is no "self-signed" mode and no ACM integration. infra (main) already enables export on its ACM certificate (`certificateExport = 'ENABLED'`, a paid option); the missing step is a boot-time export to `/etc/fenvix/tls/engine.pem` (0600, owner `fenvix`) and a renewal hook. The engine reads the PEM only at start: its `rotateCertificates` command answers `ok` but reloads nothing (compat-gaps `admin_cmds.rs`, `rotate_certificates`), so a renewed certificate needs an engine restart.
* The certificate's names: infra makes `*.db.<domain>`, which covers **one** label (`x.db.<domain>`). The control plane's hosts are `<name>-<workspace>.<region>.db.<domain>`: **two** labels before `db`, so not covered. Needs `*.<region>.db.<domain>` (one per region, or one certificate with a SAN per region).
* DNS: by the standard wildcard rules `*.db.<domain>` should also answer for the deeper names (not verified on Route 53 here), but it sends every region's names to the one record; per region it should be `*.<region>.db.<domain>` → that region's node.
* Admin port: no TLS in the engine (`ctl/http.rs`). Keep it reachable only from the host and its security group, and set `ENGINE_ADMIN_ALLOW_PLAIN_HTTP=true` in the control plane (statement that the path is private), or put a TLS terminator in front and use `https://` with `ENGINE_ADMIN_CA_FILE`.
* The Data Explorer and the provisioner connect from the control-plane container to the engine's MongoDB port with TLS required: `DATA_ENGINE_ENDPOINTS=<host>:27018`, and `DATA_ENGINE_TLS_SERVER_NAME` set to a name the certificate covers (for example `check.<region>.db.<domain>`) when the address is an IP or `host.docker.internal`. With a public ACM certificate no CA file is needed.

### 2.5 Object store (engine change needed)

`--store s3` builds its client with `with_region("us-east-1")`, `with_access_key_id("minioadmin")`, `with_secret_access_key("minioadmin")` and `with_allow_http(true)` (`main.rs`, both branches). It cannot use the instance role or another region. **The engine must read credentials and region from the environment / instance metadata** (`AmazonS3Builder::from_env()` and `--region`) before it can run on AWS. Not testable here (no AWS, no MinIO run); the tests use `--store memory`.

`--store local` cannot run the control operations at all: create, fork, keep-awake and erase fail with `PutMode::Update not yet implemented by LocalFileSystem` (conditional puts), even with `--no-leases` (verified). And a database put to sleep cannot be woken on it (already reported in `results-data-browser.md`).

### 2.6 Hostname, database name, `CONNECTION_DB_NAME`

* The engine routes by the database name of each command, never by hostname, and has one flat namespace for all customers. Hence `db_<32 hex of the id>` (`src/engine/names.ts`) and `CONNECTION_DB_NAME=engine` (refused otherwise with the real driver). The engine accepts these names (`valid_db_name`: < 64 characters, none of `/\. "$*<>:|?`).
* Host: `<name>-<workspace>.<region>.db.<BASE_DOMAIN>`, `<workspace>` = first 8 hex digits of the workspace id. Longest label 48 + 1 + 8 = 57 ≤ 63. Set with `HOST_TEMPLATE=<name>-<workspace>.<region>.db.<BASE_DOMAIN>` and `BASE_DOMAIN`.
* The connection string's user `app_user` does **not** exist on the engine. The per-database user of this work (`cp_<hex>`) is the control plane's; customers' own credentials are a pending decision.

### 2.7 Admin interface: behaviour checked against the real engine

All adapter routes were run against `control-ops` (results-e2e-engine.md, section 3). Behaviour worth knowing:

* A new database answers `state: "awake"` (the adapter interface says "asleep"; Postgres records what the engine says).
* `forked_from` is an object `{ database, at_ms, mode }`; `storage_bytes` is `null` with `?storage=false`; usage days carry `storage_bytes_sampled: null`. The adapter handles all three.
* A failed erase leaves an intent record and the engine then answers `409 operation_in_progress` **until the engine process restarts** (it finishes the erase at start; observed with `--store local`, whose conditional puts fail). The adapter retries it as "busy" (8 attempts with backoff), then the operation fails and the database is given back (user re-made, row `ready`).
* A restore before the first restore point is `400 bad_request` with the engine's own sentence; the control plane no longer passes that sentence on (fixed in this work): "That time is before the earliest restorable point of this database (<time>). Choose a later time."
* `500 internal` answers carry raw text (file paths of the local store, for example); the adapter never passes them on.
* Export file paths follow mongodump's escaping (`per%25cent.bson`); the adapter's encoding round-trips them (checked with spaces, `%`, `?`, `#`, `.`, non-ASCII).

### 2.8 Engine gaps found (to report to the engine side)

Status with the final engine (section 0) in brackets.

1. Admin interface and authentication are on two branches (`control-ops`, `compat-gaps`); production needs both in one binary. [closed]
2. `createUser` does not check `grantRole` on the roles granted: a user with only `createUser` can create a `root` user. mongod checks it. [closed; database-level roles remain grantable, section 0]
3. `Unauthorized` messages repeat the whole command, `pwd` included. [closed]
4. S3 credentials and region are fixed (2.5). [closed]
5. `--store local` cannot run control operations (2.5). [closed, one process only]
6. No TLS on the admin interface. [open]
7. `rotateCertificates` is accepted but does nothing: certificates are read only at start. [reloads now, but with `--auth` nobody may run it: still a restart in production]
8. With `--auth`, `tenantAdmin` and `rotateCertificates` are refused even to root (no entry in `authz.rs`). [new; the control plane uses neither]

## 3. What to change in `infra/` (relative to main = infra-aws @ `0c4a32c`)

Not done here (`infra/` is another branch). Line numbers are those of `origin/infra-aws`.

| # | File and place | Change |
| --- | --- | --- |
| 1 | `infra/lib/config.ts` 20, 94-97; `infra/cdk.json` 14; `infra/test/helpers.ts` | Add `mongoPort` (default **27018**) and set `adminPort` default **8443**; the checks compare with `mongoPort` instead of the literal 27017. (This is what `646b694` did on this branch.) |
| 2 | `infra/lib/fenvix-stack.ts` 70 | Open `c.mongoPort` (27018) to the internet instead of 27017. |
| 3 | `infra/lib/user-data.ts` 96-97 | `FENVIX_LISTEN=0.0.0.0:${c.mongoPort}`, `FENVIX_ADMIN_LISTEN=0.0.0.0:${c.adminPort}` — and see 4: the engine does not read them. |
| 4 | `infra/lib/user-data.ts` 120 (`ExecStart`) | Pass flags: `ExecStart=/opt/fenvix/bin/fenvix-engine --listen ${FENVIX_LISTEN} --admin-listen ${FENVIX_ADMIN_LISTEN} --admin-token-file /run/fenvix/admin-token --auth --tls-mode requireTLS --tls-certificate-key-file /etc/fenvix/tls/engine.pem --store s3 --bucket ${FENVIX_S3_BUCKET}` (systemd expands `${VAR}` from the `EnvironmentFile`). Add `RuntimeDirectory=fenvix`. |
| 5 | `infra/lib/user-data.ts` 119 (`ExecStartPre`) | After fetching, write `FENVIX_ADMIN_TOKEN` to `/run/fenvix/admin-token` (0600, owner `fenvix`) and drop it from the environment file. |
| 6 | `infra/lib/user-data.ts` 98-100 | Remove `FENVIX_TLS_MODE=self-signed` (no such mode). Add a boot step that exports the ACM certificate to `/etc/fenvix/tls/engine.pem` (cert chain + key, 0600, owner `fenvix`) and a renewal timer that re-exports it and restarts the engine (its `rotateCertificates` reloads nothing). `FENVIX_BASE_DOMAIN` and `FENVIX_ACM_CERTIFICATE_ARN` are read by nothing in the engine. |
| 7 | `infra/lib/fenvix-stack.ts` 171 and 234 | Certificate and DNS per region: `*.${region}.db.${c.baseDomain}` (the hosts have two labels before `db`). |
| 8 | `infra/lib/fenvix-stack.ts` 27 (`requiredSecretNames`) | Require `${p}/control-plane/engine-admin-token`, `engine-user-key`, `engine-provisioner-password`, `download-signing-key`, `control-plane-database-url`; stop requiring `session-secret` (unused). `engine-user-key-previous` must stay optional. |
| 9 | `infra/lib/user-data.ts` 104-105 (`control-plane.static.env`) | Replace `FENVIX_REGION=…` with what the control plane reads: `NODE_ENV=production`, `REGIONS=${region}`, `ENGINE_DRIVER=real`, `ENGINE_ADMIN_ENDPOINTS=http://host.docker.internal:${adminPort}`, `ENGINE_ADMIN_ALLOW_PLAIN_HTTP=true`, `DATA_ENGINE_ENDPOINTS=host.docker.internal:${mongoPort}`, `DATA_ENGINE_TLS=true`, `DATA_ENGINE_TLS_SERVER_NAME=engine.${region}.db.${baseDomain}`, `ENGINE_PROVISIONER_USERNAME=fenvix_provisioner`, `CONNECTION_PORT=${mongoPort}`, `CONNECTION_DB_NAME=engine`, `HOST_TEMPLATE=<name>-<workspace>.<region>.db.<BASE_DOMAIN>`, `BASE_DOMAIN`, `API_PUBLIC_URL`, `DASHBOARD_ORIGINS`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TRUST_PROXY=false`, `ENGINE_RETENTION_WINDOW_SECS`. Keep `PORT=8443`. |
| 10 | `infra/lib/user-data.ts` 143 (`docker run`) | Add `--add-host=host.docker.internal:host-gateway` so the container reaches the engine on the host. |
| 11 | `infra/lib/fenvix-stack.ts` ~203 | `httpPutResponseHopLimit: 1` (on this branch since `646b694`): the container gets no instance-role credentials. |
| 12 | `infra/README.md` 11, 40, 52-53, 122 | Ports 27018/8443; the SSM table of item 8; certificate names of item 7; a step "create the engine's break-glass root and the provisioner" (control-plane/docs/data-explorer-security.md, "Making the provisioner"). |
| 13 | `infra/test/infra.test.ts` | Tests for 2, 4, 7, 8, 9 (open ports, flags in `ExecStart`, certificate names, required parameters, container environment). |

Engine side (not infra): 2.5 (S3 credentials and region) and 2.8.
