# FENVIX on AWS: deploy guide

This folder describes the AWS setup for FENVIX as code. **Nothing here has been deployed.** The first deploy is a step you do yourself, in order, below. Read the whole page once before starting.

## What you get (per region)

| Piece | What it is |
|---|---|
| Data bucket | One private S3 bucket `fenvix-<env>-data-<account>-<region>`. Encrypted, versioned, old versions deleted after `retentionDays`, HTTPS only, readable only by the engine server. It is **kept** when you delete the stack (it holds customer data). |
| Engine server | One EC2 server (default `t3.medium`) with a small encrypted disk. It runs the FENVIX engine and restarts it if it stops. AWS replaces the host if the host fails. |
| Control plane | In the **first region** only: the control-plane container (the API the dashboard calls) and, in front of it, a small TLS terminator (Caddy) that serves `https://api.<your domain>`. |
| Network | A private network (VPC) with one public subnet. Open to the internet: port **27018** (database, TLS required) and **443** (control plane, HTTPS). The engine's admin port (**8443**) is open to nothing: it listens only inside the server, where the control plane reaches it. No SSH; you connect with Session Manager in the browser. Customers reach port 27018 directly (no proxy, no Docker port in front of it), so the engine sees their real address: each database can have an **IP allowlist**, and addresses that keep failing to sign in are blocked for a while. The server's own processes are trusted by the engine (see "Trusted networks"). |
| Certificate and DNS | One free **Let's Encrypt** certificate per region for `*.<region>.db.<your domain>` (every database host has this form, for example `orders-1a2b3c4d.eu-west-1.db.example.com`) and, in the first region, `api.<your domain>`. The server requests and renews it itself (DNS challenge in Route 53) and keeps a copy in AWS Secrets Manager, so a replaced server does not request a new one. A Route 53 zone (`db.<your domain>` by default) holds the database records. See "The domain and DNS" and "TLS certificate". |
| Cost guard | A monthly budget with emails at 50%, 80%, 100%, and an automatic action that **stops the engine server at 100%**. |

Everything is tagged `project=fenvix` and `env=<prod|...>`.

## Files

- `deploy-policy.json`: the permissions your deploy role needs, nothing more.
- `cdk.json`: the settings (region list, server size, budget...).
- `lib/`, `bin/`: the code. `test/`: the checks.
- `lib/engine-command.ts`: the engine's start command (the only place with the engine's flag names).
- `lib/control-plane-env.ts`: every setting of the control-plane container (the only place to add one).
- `lib/parameters.ts`: the secrets the services need (the table below mirrors it).
- `lib/acme.ts`, `lib/scripts/fenvix-tls.sh`, `lib/scripts/fenvix-acme-dns-hook.sh`: the Let's Encrypt certificate (names, challenge records, request, renewal, copy in Secrets Manager).
- `lib/acme-requirements.txt`: certbot and its dependencies, pinned with SHA-256 hashes (made by `scripts/gen-acme-requirements.py`).

## Settings

Set them in `cdk.json` (section `context`) or per command with `-c name=value`. Environment variables also work (name in the last column). An environment variable beats `cdk.json` and `-c` (so the `export` lines in Step 5 always win).

| Setting | Default | Meaning | Env variable |
|---|---|---|---|
| `regions` | `eu-west-1` | Comma list. **One more entry = one more full copy in that region** (needs `hostedZoneId`). | `FENVIX_REGIONS` |
| `account` | `865859654353` | AWS account. Deploy stops if your login is a different account. | `FENVIX_ACCOUNT` |
| `env` | `prod` | The `env` tag, and part of every name. | `FENVIX_ENV` |
| `instanceType` | `t3.medium` | `t3.medium`, `c6i.large` or `c7g.large` (c7g is ARM: needs an ARM engine build). | `FENVIX_INSTANCE_TYPE` |
| `volumeGb` | `20` | Server disk size. | `FENVIX_VOLUME_GB` |
| `retentionDays` | `30` | Days an overwritten/deleted object version is kept. | `FENVIX_RETENTION_DAYS` |
| `budgetAmount` | `100` | Monthly budget in US dollars, per region. | `FENVIX_BUDGET_AMOUNT` |
| `budgetEmail` | **required** | Where alerts go. | `FENVIX_BUDGET_EMAIL` |
| `baseDomain` | **required** | Your domain, e.g. `fenvix.dev`. | `BASE_DOMAIN` |
| `dnsZone` | `db` | `db`: the Route 53 zone is `db.<domain>` (only that subdomain moves to AWS; recommended). `domain`: the zone is the whole domain. See "The domain and DNS". | `FENVIX_DNS_ZONE` |
| `hostedZoneId` | unset | Use an existing Route 53 zone (`db.<domain>` or `<domain>`, as `dnsZone` says) instead of creating one. **Required with more than one region.** | `FENVIX_HOSTED_ZONE_ID` |
| `acmeEmail` | **required** | Email of the Let's Encrypt account (expiry and incident notices). No default. | `FENVIX_ACME_EMAIL` |
| `acmeStaging` | `false` | `true` uses the Let's Encrypt **staging** service: for a first trial only, its certificates are **not trusted** (see "TLS certificate"). | `FENVIX_ACME_STAGING` |
| `dashboardOrigins` | **required** | Web address of the dashboard, e.g. `https://console.fenvix.dev` (comma list if several). The control plane allows these origins (CORS). Never `https://api.<domain>` (the API itself) or a `*.db.<domain>` host: refused. | `FENVIX_DASHBOARD_ORIGINS` |
| `engineVersion` / `engineSha256` | empty | Engine release to install and its SHA-256, as the `release-engine` workflow (Mircoguidetti/test5) prints them. The server refuses a file with another SHA-256. See "Release artifacts". | `FENVIX_ENGINE_VERSION` / `FENVIX_ENGINE_SHA256` |
| `controlPlaneVersion` / `controlPlaneSha256` | empty | Control-plane image archive to install and its SHA-256, as the `release-control-plane` workflow (this repository) prints them. | `FENVIX_CONTROL_PLANE_VERSION` / `FENVIX_CONTROL_PLANE_SHA256` |
| `engineRepo` / `engineRepoBranches` | `Mircoguidetti/test5` / `main` | The only repository, and its branches (comma list, no wildcards), whose GitHub Actions may write `engine/` in the artifacts bucket. | `FENVIX_ENGINE_REPO` / `FENVIX_ENGINE_REPO_BRANCHES` |
| `controlPlaneRepo` / `controlPlaneRepoBranches` | `Mircoguidetti/olvix-app` / `main` | The same for `control-plane/`. | `FENVIX_CONTROL_PLANE_REPO` / `FENVIX_CONTROL_PLANE_REPO_BRANCHES` |
| `githubOidcProviderArn` | empty | Only if the account already has GitHub's OIDC provider (`token.actions.githubusercontent.com`): its ARN. Empty: the stack creates it. | `FENVIX_GITHUB_OIDC_PROVIDER_ARN` |
| `artifactsBucket` | empty | Only for a second region: the `ArtifactsBucketName` output of the first region. | `FENVIX_ARTIFACTS_BUCKET` |
| `proxyImage` | `public.ecr.aws/docker/library/caddy:2.8.4` | Container image of the TLS terminator in front of the control plane. | `FENVIX_PROXY_IMAGE` |
| `engineRetentionWindowSecs` | `604800` (7 days) | How far back a database can be restored; set by the control plane on every new database. | `FENVIX_ENGINE_RETENTION_WINDOW_SECS` |
| `mongoPort` / `adminPort` / `controlPlanePort` | `27018` / `8443` / `443` | Database port (open to the internet), engine admin port (open to nothing), control-plane HTTPS port. | `FENVIX_MONGO_PORT` / `FENVIX_ADMIN_PORT` / `FENVIX_CONTROL_PLANE_PORT` |

**Release settings.** The four settings `engineVersion`, `engineSha256`, `controlPlaneVersion`, `controlPlaneSha256` go together: all set, or all empty. All empty is the first deploy: the artifacts bucket does not exist yet, so nothing can be published; the server prepares everything, gets its certificate, starts **no** service and logs `NO RELEASE PINNED`. `engineUrl` and `controlPlaneImage` no longer exist (setting them stops `cdk synth` with a message). `baseDomain`, `acmeEmail` and `dashboardOrigins` ship empty: `cdk synth` stops with "Missing setting ..." until you set them.

## The secrets (you create them, they are never in the code)

The server reads these from **AWS Systems Manager Parameter Store** every time a service starts. Create them as **SecureString** before the first deploy (Step 2). Replace `prod` if you changed `env`. Parameters are per region: repeat Step 2 in each region.

| Name | Required | Becomes on the server | Value |
|---|---|---|---|
| `/fenvix/prod/engine/admin-token` | **yes** | file `/run/fenvix/admin-token` (only the engine can read it), given to the engine with `--admin-token-file` | random, at least 16 characters |
| `/fenvix/prod/control-plane/engine-admin-token` | **yes** | `ENGINE_ADMIN_TOKEN` in the control plane | **the same value** as `/fenvix/prod/engine/admin-token` (checked at start) |
| `/fenvix/prod/control-plane/engine-user-key` | **yes** | `ENGINE_USER_KEY` | `v1:` followed by at least 32 random characters |
| `/fenvix/prod/control-plane/engine-user-key-previous` | no | `ENGINE_USER_KEY_PREVIOUS` | only while you rotate `engine-user-key` (control-plane/docs/data-explorer-security.md, "Rotating the master key") |
| `/fenvix/prod/control-plane/engine-provisioner-password` | **yes** | `ENGINE_PROVISIONER_PASSWORD` | random; the engine user `fenvix_provisioner` is made with it in Step 10 |
| `/fenvix/prod/control-plane/download-signing-key` | **yes** | `DOWNLOAD_SIGNING_KEY` | random, at least 32 characters |
| `/fenvix/prod/control-plane/control-plane-database-url` | **yes** | `CONTROL_PLANE_DATABASE_URL` | the Postgres connection string of the `fenvix_control_plane` role (control-plane/README.md) |
| `/fenvix/prod/control-plane/supabase-url` | **yes** | `SUPABASE_URL` | `https://<ref>.supabase.co` of your Supabase project |
| `/fenvix/prod/control-plane/supabase-anon-key` | **yes** | `SUPABASE_ANON_KEY` | the Supabase **anon** (public) key; never the `service_role` key |

If a required parameter is missing, the service does not start and its log names the missing parameter ("missing SSM parameters: ..."). Any other parameter you add under `/fenvix/prod/control-plane/` is handed to the control plane the same way (name in capitals, `-` becomes `_`). The old `/fenvix/prod/control-plane/session-secret` is no longer used: delete it if you created it.

Four different random values are needed (admin token, user key, provisioner password, signing key). The control plane refuses to start if the user key, the provisioner password and the admin token are not three different secrets.

## Before you start: decisions

1. **The domain and where its DNS lives.** You need a domain you control (for example `fenvix.dev`). Without one nothing can start: the engine only accepts encrypted connections and needs a certificate for `*.<region>.db.<domain>`. Read "The domain and DNS" below and choose option **B** (recommended: only `db.<domain>` moves to Route 53) or **A** (the whole domain moves to Route 53).
2. **The dashboard address** (`dashboardOrigins`, for example `https://console.fenvix.dev`): where the dashboard web app is served (Vercel). Required, no default. The API will be `https://api.<domain>/v1`; the two are different hosts, never the same (see "Addresses").
3. **An email address for Let's Encrypt** (`acmeEmail`): it receives notices about the certificate (for example if a renewal keeps failing). A shared mailbox is better than a personal one.
4. **Try with staging first?** With `acmeStaging=true` the first deploy proves the whole certificate flow without using Let's Encrypt's production limits, but the certificate is not trusted by anyone. See "TLS certificate".

## Addresses

| Address | What | Where |
|---|---|---|
| `fenvix.dev` | landing page and documentation | Vercel (not this stack) |
| `console.fenvix.dev` | the dashboard (web app) | Vercel (not this stack) |
| `api.fenvix.dev` | the control-plane API (`https://api.fenvix.dev/v1`) | this stack, first region |
| `<name>-<ws>.<region>.db.fenvix.dev` | customer databases (for example `orders-1a2b3c4d.eu-west-1.db.fenvix.dev`) | this stack, each region |

- **This stack never uses `console.<domain>`** for the API (not in the certificate, the DNS records, the challenge permissions or Caddy). `console.<domain>` appears only in `dashboardOrigins`, the list of browser origins the control plane allows (CORS). `npm test` fails if the API is ever built on `console.<domain>`, and the settings check refuses `https://api.<domain>` or a `*.db.<domain>` host in `dashboardOrigins`.
- **The dashboard must call `https://api.<domain>/v1`.** Set it in the dashboard's Vercel project (Settings, Environment Variables): `VITE_API_URL=https://api.fenvix.dev/v1` (the dashboard's `.env.example` says the value includes `/v1`), then redeploy the dashboard. Nothing in this folder sets it.
- **Cookies (security rule).** The dashboard must **not** set cookies with `Domain=.fenvix.dev` (or `Domain=fenvix.dev`): such cookies are also sent to every `*.db.fenvix.dev` customer host and to `api.fenvix.dev`. Cookies stay host-only on `console.fenvix.dev` (no `Domain` attribute), with `Secure` and `SameSite`. The API takes the Supabase token as `Authorization: Bearer`, not as a cookie.

## The domain and DNS

The names that must work:

| Name | Points to | Who makes it |
|---|---|---|
| `*.<region>.db.<domain>` (for example `*.eu-west-1.db.fenvix.dev`) | the server's public IP (`PublicIp` output) | the stack, in Route 53 |
| `api.<domain>` (the API; not `console.<domain>`, which is the dashboard on Vercel) | the same IP (first region only) | the stack (option A) or you (option B) |
| `_acme-challenge.<region>.db.<domain>` (TXT, only while a certificate is requested) | | the server, in Route 53 |
| `_acme-challenge.api.<domain>` | option A: TXT made by the server; option B: a CNAME you make once | |

Your website stays on Vercel in both options. The certificate is free (Let's Encrypt) in both options; a Route 53 zone costs about $0.50 a month.

**The registrar matters.** If you buy the domain from **Cloudflare**, Cloudflare Registrar only works with Cloudflare's own DNS: you cannot hand the whole domain to Route 53, so **only option B is possible**. GoDaddy allows both.

### Option B (recommended): only `db.<domain>` moves to Route 53
The domain's DNS stays where it is (Cloudflare or GoDaddy), with the Vercel records, email records and anything else. Route 53 gets only the subdomain `db.<domain>`. Why we recommend it: it works with both registrars; nothing about the website or email changes; and the AWS side can only ever touch `db.<domain>` (the server's permissions cannot reach the main domain at all, because it is not in AWS).

Settings: `dnsZone=db` (the default).

1. **Before the deploy, create the zone in Route 53** (so the delegation is ready when the server first asks for a certificate): Route 53 console, Hosted zones, Create hosted zone, name `db.<domain>` (for example `db.fenvix.dev`), type *Public*. Open it and note its id (`Z...`) and the 4 values of its `NS` record. Set `export FENVIX_HOSTED_ZONE_ID="Z..."` in Step 5. (You can also let the stack create the zone: then the NS values are in the `NameServers` output after the deploy, and the server retries the certificate every 20 minutes until the delegation works.)
2. **At your DNS provider** (Cloudflare: your domain, DNS, Records; GoDaddy: My Products, your domain, DNS), add, before the deploy:
   - 4 records of type **NS**, name `db`, one per name server of step 1 (for example `ns-123.awsdns-45.com`).
   - 1 record of type **CNAME**, name `_acme-challenge.api`, target `_acme-challenge-api.db.<domain>` (for example `_acme-challenge-api.db.fenvix.dev`). On Cloudflare set it to **DNS only** (grey cloud). This lets the server prove it controls `api.<domain>` by writing inside its own Route 53 zone.
   - Leave `console` (the dashboard, a CNAME to Vercel) and the bare domain (landing) as they are.
3. **After the deploy** (it prints `ApiRecordToCreate`), add:
   - 1 record of type **A**, name `api`, value the `PublicIp` output. On Cloudflare: **DNS only** (grey cloud): the server serves its own certificate; Cloudflare's proxy would replace it.
4. If your DNS has **CAA** records for the domain, add `0 issue "letsencrypt.org"` (and `0 issuewild "letsencrypt.org"`), or Let's Encrypt will refuse. No CAA record at all is fine.
5. Check (CloudShell or any terminal): `dig +short NS db.<domain>` shows the 4 AWS names; `dig +short CNAME _acme-challenge.api.<domain>` shows the target of step 2; after step 3, `dig +short api.<domain>` shows the `PublicIp`.

Summary of the records you make by hand at Cloudflare (option B, `fenvix.dev`):

| Type | Name | Value | Proxy |
|---|---|---|---|
| NS (4) | `db` | the 4 name servers of the Route 53 zone `db.fenvix.dev` | (not applicable) |
| CNAME | `_acme-challenge.api` | `_acme-challenge-api.db.fenvix.dev` | DNS only (grey cloud) |
| A | `api` | the `PublicIp` output | DNS only (grey cloud) |
| CAA (only if you already have CAA records) | `@` | `0 issue "letsencrypt.org"`, `0 issuewild "letsencrypt.org"` | (not applicable) |

The stack makes, in the `db.<domain>` zone: `*.<region>.db.<domain>` A record. The server makes and removes the `_acme-challenge` TXT records.

### Option A: the whole domain moves to Route 53 (GoDaddy only)
Route 53 becomes the DNS of the whole domain, and the stack makes every FENVIX record. Settings: `dnsZone=domain`.

1. Before changing anything at GoDaddy, create the zone `<domain>` in Route 53 (or let the stack create it) and **recreate every record the domain has**: the Vercel ones (in Vercel, Project, Settings, Domains, Vercel shows the exact values; usually an `A` record for the bare domain, for example `76.76.21.21`, a `CNAME` `www` and the dashboard's `CNAME` `console` to Vercel), email (`MX`, SPF/DKIM/DMARC `TXT`), and any verification `TXT`.
2. At GoDaddy, set the domain's name servers to the 4 `NS` values of the Route 53 zone. Until this is done, nothing resolves to the new zone.
3. Deploy (with `FENVIX_HOSTED_ZONE_ID` if you created the zone). The stack makes `*.<region>.db.<domain>` and `api.<domain>` (A records); the server makes and removes `_acme-challenge` TXT records for both names.

Risk of option A: a mistake in step 1 takes the website or email down, and the whole domain's DNS is in the same AWS account as the server (the server can still only write the two `_acme-challenge` TXT names, see "TLS certificate").

## TLS certificate (Let's Encrypt)

- **What and where.** One certificate per region with the names `*.<region>.db.<domain>` and (first region) `api.<domain>`, an RSA 2048 key. On the server it is in `/etc/fenvix/tls/` (directory and files owned by `fenvix`, files mode 0600): `engine.pem` (certificate chain then key, what the engine loads), `fullchain.pem` and `key.pem` (the same certificate and key, for Caddy).
- **Who requests it.** The server itself (not a container), with **certbot** (pinned version, installed at boot from PyPI with SHA-256 hashes for every package). The DNS challenge is answered by `fenvix-acme-dns-hook`, which writes one TXT record in Route 53 and waits until Route 53 serves it.
- **When.** `fenvix-tls` runs before the engine and Caddy start, and twice a day (`fenvix-tls.timer`, 00:00 and 12:00 UTC plus up to one hour). It does nothing while the certificate has more than 30 days left. With less, it requests a new one, installs it, and restarts the engine and Caddy once (a few seconds of interruption; drivers reconnect). If nothing changed, nothing is restarted.
- **Copy in Secrets Manager.** Every new certificate and key is also written to the secret `fenvix-<env>-tls-<region>` (output `TlsSecret`). A new server (after a redeploy that replaces it) takes it from there instead of asking Let's Encrypt again. Let's Encrypt allows **5 certificates for the same names per week** and **5 failed validations per name per hour**; replacing the server many times would otherwise hit the first limit. Only the server's role can read the secret (and the account's administrators); the deploy role cannot.
- **When it fails.** If the request fails, the next attempt waits 20 minutes (to stay under the failed-validation limit). If the installed certificate is still valid, the services keep using it and the log says `WARNING`. If there is no valid certificate, the engine and Caddy **do not start** (they never run without TLS) and the log says why: `sudo journalctl -u fenvix-engine -n 30 --no-pager`. No key or secret value is ever printed.
- **Staging** (`acmeStaging=true`). Uses `https://acme-staging-v02.api.letsencrypt.org/directory`: much higher limits, same steps, but the certificate's issuer is "(STAGING) ..." and **no driver, browser or the control plane trusts it**: browsers show a warning on `https://api.<domain>`, so the dashboard cannot call the API and customer connections with TLS checks fail. Use it for the very first deploy (to see the DNS delegation and the challenge work, `fenvix-tls: certificate installed` in the engine log), then set `acmeStaging=false` and deploy again (the server is replaced and gets a production certificate; a staging certificate is never served once production is configured).
- **What someone who takes over the server can do.** With the server's role they can request certificates for our names (they can write the challenge TXT records) and read the stored key. They cannot change the A records, other names, other record types or other zones. This is the price of a server that renews its own certificate.
- **To check or force a check now:** `sudo systemctl start fenvix-tls.service`, then `sudo journalctl -u fenvix-tls -n 20 --no-pager`. To force a new certificate (rarely needed; remember the weekly limit): `sudo rm /etc/fenvix/tls/fullchain.pem`, write `{}` into the secret (Secrets Manager console, Retrieve secret value, Edit, Plaintext), then `sudo systemctl restart fenvix-engine fenvix-proxy`.
- **Updating certbot.** `python3 -I scripts/gen-acme-requirements.py certbot==X acme==X ...` (every package of the current file, with the new versions) `> lib/acme-requirements.txt`, then check it resolves for both CPUs: `pip download --no-deps --require-hashes --only-binary=:all: --python-version 3.11 --implementation cp --abi cp311 --abi abi3 --abi none --platform manylinux_2_34_x86_64 --platform manylinux_2_28_x86_64 --platform manylinux_2_17_x86_64 --platform manylinux2014_x86_64 -d /tmp/x -r lib/acme-requirements.txt` (and the same with `aarch64`).

## Trusted networks
The engine checks each database's IP allowlist and counts failed sign-ins per address (5 on one database or 10 on all of them in 60 s block the address for 5 minutes, doubling up to an hour). Connections from its **trusted networks** skip all of that: they must be exactly the server's own processes, never a network customers can come from. The engine runs with `--trusted-networks=127.0.0.0/8,::1/128,172.17.0.0/16,172.18.0.0/24` (`TRUSTED_NETWORKS` in `lib/engine-command.ts`):

| Network | Who connects from it |
|---|---|
| `127.0.0.0/8`, `::1/128` | the server itself (the user script of Step 10 runs with `--network host` against `127.0.0.1`) |
| `172.17.0.0/16` | Docker's default bridge: its address `172.17.0.1` (`bip` in `/etc/docker/daemon.json`) is where the containers reach the host (`host.docker.internal`) |
| `172.18.0.0/24` | the Docker network `fenvix` of the control plane and Caddy. The control plane (Data Explorer, provisioner) connects to `host.docker.internal:27018`, but the connection leaves its container from its address on this network (there is no address translation between a container and its host), so this is the address the engine sees. The network is created with this subnet pinned; if a `fenvix` network already exists with another subnet, `fenvix-check-network` stops the control plane and Caddy with a message instead of letting the engine count (and block) them |

If the control plane were not trusted, a customer's IP allowlist would also apply to the Data Explorer, and the control plane's own failed sign-ins (a provisioner password changed on one side only, a key rotation half done) would be counted: 5 on `admin` block the provisioner, and no database could get its users. The control plane also limits its own failed sign-ins so that this cannot happen even then (control-plane/docs/network-allowlist.md), but the trusted networks are what keeps the Data Explorer out of the lists.

The engine release must be `network-limits` (test5 commit `1c9fee7`) or later: an older engine does not know `--trusted-networks` and refuses to start (systemd restarts it every 5 seconds, and `journalctl -u fenvix-engine` shows the engine's error about the unknown argument `--trusted-networks`).

## Release artifacts (engine binary, control-plane image)
The engine is private and the server must get it without exposing it. Nothing is pulled from a public place and the server has no registry login:

- **Bucket.** The first region's stack creates a private S3 bucket for releases (output `ArtifactsBucketName`; CloudFormation picks the name, with a random suffix). Public access blocked, ACLs off, encrypted, versioned, TLS only, replaced copies expire after 30 days, kept if the stack is deleted. Keys: `engine/<version>/<arch>/engine` and `control-plane/<version>/<arch>/control-plane.tar.gz` (`lib/artifacts.ts`).
- **Who writes.** Two GitHub Actions workflows, started by hand: `release-engine` in Mircoguidetti/test5 (`cargo build --release --workspace --locked` with a pinned Rust toolchain) and `release-control-plane` in this repository (`docker build`, then `docker save | gzip`). Each logs in to AWS with GitHub's OIDC token for 15 minutes, as a role the stack made for it: trusted only by that repository on the branches of `engineRepoBranches` / `controlPlaneRepoBranches`, allowed only `s3:PutObject` under its own prefix. A version is never overwritten. No long-lived AWS key exists anywhere.
- **Who reads.** The server, with its own role: `s3:GetObject` on the two prefixes, nothing else. The bucket policy repeats it: reads only by the engine roles, each prefix written only by its publisher.
- **The check.** The server installs a file only if its SHA-256 is the one in the stack settings (`engineSha256`, `controlPlaneSha256`); nothing stored in the bucket can change what is expected. A mismatch stops the boot before any service starts, with `SHA-256 MISMATCH for <key>: expected ..., got ...`.
- **Updates.** `sudo fenvix-artifact update engine <version> <sha256>` (or `control-plane`) on the server: download, check, ordered restart (the engine closes its databases cleanly on SIGTERM; data, WAL and leases are in S3), health check, and back to the previous version by itself if the new one does not come up. `sudo fenvix-artifact rollback engine` goes back by hand; `sudo fenvix-artifact current` shows what runs. Then put the same version in the stack settings, so that a replaced server installs it too. The full steps: `docs/deploy-checklist.md`.
- **The binary's name** is in `ENGINE_BINARY_NAME` (`lib/engine-command.ts`) only. The object in the bucket is always called `engine`.

## The boot script and the 16 KB limit
EC2 accepts at most 16 KB of user data. The boot script (`bootScript()` in `lib/user-data.ts`, with the files of `lib/scripts/`, `lib/acme-requirements.txt` and the artifact installer of `lib/artifacts.ts`) is about 32 KB, so the user data carries it **gzip-compressed and base85-encoded** (about 15.6 KB in all; base64 no longer fits once the artifact installer was added), checks its SHA-256 before running it, and keeps a readable copy at `/opt/fenvix/boot.sh` on the server. It is decoded with the Python 3 standard library, which every Amazon Linux 2023 image has (cloud-init runs on it). Nothing is downloaded for it and nothing is left out. `npm test` checks the size, with a long domain too, and that the compressed part decodes to the exact script. If it ever grows past 16 KB, the next step is to keep the boot script in the artifacts bucket under `boot/` with its SHA-256 fixed in the user data.

## Deploy, step by step

You need: a web browser, the AWS login of the account `865859654353`, your domain, and about an hour. The exact order of the first deploy, with every parameter, check and way back, is in `docs/deploy-checklist.md`. These steps use **AWS CloudShell** (a terminal inside the AWS console that already has Node.js and the AWS tools), so nothing is installed on your computer.

### Step 1. Choose the region
AWS console, top right: choose **Europe (Ireland) eu-west-1**. Every step below happens in this region.

### Step 2. Create the secrets (with your own login, before the deploy role)
1. Click the `>_` icon in the bottom bar of the console (CloudShell). Wait for the prompt.
2. Paste these lines **one block at a time**. They make random values and store them directly; the values never appear on screen. Each command prints something like `{ "Version": 1, "Tier": "Standard" }`.
   ```
   R=eu-west-1; P=/fenvix/prod
   put() { aws ssm put-parameter --region "$R" --type SecureString --name "$1" --value "$2" --tags Key=project,Value=fenvix Key=env,Value=prod; }
   ```
   ```
   TOKEN="$(openssl rand -hex 32)"
   put $P/engine/admin-token "$TOKEN"
   put $P/control-plane/engine-admin-token "$TOKEN"
   unset TOKEN
   ```
   ```
   put $P/control-plane/engine-user-key "v1:$(openssl rand -hex 32)"
   put $P/control-plane/engine-provisioner-password "$(openssl rand -hex 32)"
   put $P/control-plane/download-signing-key "$(openssl rand -hex 32)"
   ```
3. The last three values come from elsewhere (control-plane/README.md, and your Supabase project settings). Type each one when asked (it is not shown and not kept in the command history):
   ```
   read -r -s -p "Postgres URL of fenvix_control_plane: " V; echo; put $P/control-plane/control-plane-database-url "$V"; unset V
   read -r -s -p "Supabase URL (https://<ref>.supabase.co): " V; echo; put $P/control-plane/supabase-url "$V"; unset V
   read -r -s -p "Supabase anon key: " V; echo; put $P/control-plane/supabase-anon-key "$V"; unset V
   ```
4. Check that all 8 exist (names only, no values):
   ```
   aws ssm get-parameters-by-path --region "$R" --path "$P" --recursive --query 'Parameters[].Name' --output text
   ```
   Expected: the 8 names of the table marked **yes**.
5. Make a **break-glass root password** for the engine (`openssl rand -hex 24`) and store it in your password manager, **not** in AWS. You type it once in Step 10.

If `put` answers `ParameterAlreadyExists`, the parameter is there already; to replace it add `--overwrite` (and remove the `--tags` part). You can also create the parameters by hand: Systems Manager, Parameter Store, Create parameter, Tier *Standard*, Type **SecureString**, KMS key *alias/aws/ssm*.

### Step 3. Create the deploy role
1. IAM, then Roles, then Create role. Trusted entity: *AWS account*, *This account*. Name it `fenvix-deployer`. Create it without permissions.
2. Open the role, Add permissions, **Create inline policy**, JSON tab. Paste the whole content of `infra/deploy-policy.json`. Name it `fenvix-deploy`. (It is longer than the 6,144 characters a managed policy may have, so it must be inline.)
3. Switch to this role: your name (top right), Switch role, account `865859654353`, role `fenvix-deployer`. Stay in this role for the rest of the steps (CloudShell opens a new, empty session for the role).

### Step 4. Get the code
In CloudShell, run one line at a time:
```
git clone https://github.com/mircoguidetti/olvix-app.git
cd olvix-app && git checkout infra-align && cd infra
npm ci
```
If CloudShell says `node` is too old, run `nvm install 22` first. If the repository is private, `git clone` asks for a login and will fail for a password: ask your engineer for a read-only access token, or download the `infra-align` branch as a zip on your computer and upload it with CloudShell menu Actions, Upload file, then `unzip` it.

### Step 5. Fill in the settings
The release settings stay empty for the first deploy (the bucket they come from is made by it): `docs/deploy-checklist.md` has the exact order (stack with a staging certificate, then the artifacts, then the real certificate). Then:
```
export FENVIX_BUDGET_EMAIL="you@yourcompany.com"
export BASE_DOMAIN="fenvix.dev"
export FENVIX_ACME_EMAIL="ops@yourcompany.com"
export FENVIX_ACME_STAGING="true"    # first trial only; "false" (or remove the line) for the real certificate
export FENVIX_DASHBOARD_ORIGINS="https://console.fenvix.dev"
# after the artifacts are published (docs/deploy-checklist.md, phase 3):
# export FENVIX_ENGINE_VERSION="..."  FENVIX_ENGINE_SHA256="..."
# export FENVIX_CONTROL_PLANE_VERSION="..."  FENVIX_CONTROL_PLANE_SHA256="..."
```
If you created the Route 53 zone by hand ("The domain and DNS"): `export FENVIX_HOSTED_ZONE_ID="Z..."`. Option A only: `export FENVIX_DNS_ZONE="domain"`.
(These last until you close CloudShell. Set them again if it restarts.)

### Step 6. Check the plan without touching AWS
```
npm test
npx cdk synth --quiet
```
`npm test` must end with `Tests: ... passed`. `cdk synth` only writes files into `cdk.out/`; it changes nothing in AWS. If it says `Missing setting "baseDomain"` (or another name), Step 5 was not done in this CloudShell session.

### Step 7. Deploy
```
npx cdk deploy --all --require-approval broadening
```
Read the table it shows (roles, security group). Type `y`. No `cdk bootstrap` is needed: the stack uses no uploaded files.

The deploy does not wait for the certificate: the server requests it when it starts. It takes 10 to 20 minutes. At the end it prints `BucketName`, `InstanceId`, `PublicIp`, `SecretsPath`, `TlsSecret`, `DatabaseHosts` (`*.eu-west-1.db.<domain>`), `ControlPlaneUrl` (`https://api.<domain>/v1`: the value of the dashboard's `VITE_API_URL` on Vercel, see "Addresses"), with option B `ApiRecordToCreate` and `ApiChallengeRecordToCreate` (make them now if you have not, "The domain and DNS"), and, if the stack created the zone, `NameServers` (put them at your DNS provider now: option B as `NS` records named `db`, option A as the domain's name servers).

### Step 8. Switch on the cost tracking (once)
Billing console, Cost allocation tags, activate the user tags `project` and `env`. (Optional but useful: it lets Cost Explorer split costs per tag from the next day on. The budget itself already works per region without it.)

### Step 9. Check the server
1. EC2 console, Instances, select the `fenvix` instance, Connect, **Session Manager**, Connect.
2. Run:
   ```
   sudo tail -20 /var/log/fenvix-bootstrap.log
   systemctl status fenvix-engine fenvix-control-plane fenvix-proxy --no-pager
   sudo journalctl -u fenvix-engine -n 30 --no-pager
   ```
   Expected: the log ends with `fenvix bootstrap done`; the three services are `active (running)`; the engine log shows `fenvix-tls: requesting a certificate ...`, `fenvix-tls: certificate kept in Secrets Manager`, `fenvix-tls: certificate installed` and `admin interface listening on 172.17.0.1:8443 (bearer token required)` and `mongo-server listening on 0.0.0.0:27018 (idle close after 60 s, holder i-..., lease ttl 30 s)` (the holder is the instance id). The first start can take a few minutes (the DNS challenge).
   - "NO RELEASE PINNED": the first deploy, as expected; no service runs yet. Publish the artifacts and deploy again with the four release settings (`docs/deploy-checklist.md`).
   - "SHA-256 MISMATCH for ...": the file in the bucket is not the one the settings name (wrong version or hash pasted, or a different build). Nothing was started. Fix the setting and deploy again.
   - "cannot download s3://...": that version was not published for this CPU (`x86_64` or `aarch64`), or the name is mistyped.
   - "missing SSM parameters: ...": the names listed are missing or misspelled. Fix them in Parameter Store (Step 2), then `sudo systemctl restart fenvix-engine fenvix-control-plane fenvix-proxy`.
   - "... must hold the same value as ...": the two admin tokens differ. Put the same value in both (Step 2), then restart as above.
   - "fenvix-tls: the certificate request failed ... no valid certificate installed": Let's Encrypt could not validate. The lines above it say which name; usually the DNS delegation or the `_acme-challenge.api` CNAME is missing or not yet visible ("The domain and DNS", check 5), or a CAA record forbids Let's Encrypt. Fix it; the server tries again by itself every 20 minutes.
   - "fenvix-tls: the last certificate request failed ...s ago, next attempt in ...s": it is waiting before the next try, on purpose (Let's Encrypt limits).
   - "fenvix-tls: cannot read arn:...secret:...": the server cannot read its certificate copy in Secrets Manager; it does not request a new one in that case (that would only burn the weekly limit). Check that the secret `fenvix-<env>-tls-<region>` exists.
3. Which ports listen where:
   ```
   sudo ss -ltn | grep -E ':(27018|8443|443) '
   ```
   Expected: `0.0.0.0:27018`, `172.17.0.1:8443` (the admin port, inside the server only) and `0.0.0.0:443`.
   The control plane's Docker network has the subnet the engine trusts (see "Trusted networks"):
   ```
   sudo docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' fenvix
   ```
   Expected: `172.18.0.0/24`. And the engine trusts it: `curl -s -H "Authorization: Bearer $(sudo cat /run/fenvix/admin-token)" http://172.17.0.1:8443/v1/network | python3 -c 'import json,sys; print(json.load(sys.stdin)["config"]["trusted_networks"])'` shows the four networks of "Trusted networks".
4. The admin port refuses requests without the token (from the server):
   ```
   curl -s -o /dev/null -w '%{http_code}\n' http://172.17.0.1:8443/v1/health
   ```
   Expected: `401`.

### Step 10. Create the engine's users (once)
The control plane makes one engine user per customer database, through an engine user called `fenvix_provisioner`. That user is made once, from the server itself: the engine runs with `--auth`, and while it has no user at all it accepts `createUser` on `admin` only from a connection coming from the server itself (127.0.0.1, the "localhost exception"). The script uses it to make `fenvix_root`, then logs in as `fenvix_root` for the rest:
```
sudo /usr/local/bin/fenvix-create-engine-users
```
Type the break-glass root password of Step 2.5 when asked (nothing is shown). Expected lines: `root user fenvix_root created`, `role fenvix_provisioner created`, `user fenvix_provisioner created`, `done`. Then restart the control plane so it connects with the new user:
```
sudo systemctl restart fenvix-control-plane
sudo journalctl -u fenvix-control-plane -n 30 --no-pager
```
Running the script again is safe: it says the users exist and sets the provisioner's password to the value in Parameter Store (use this after changing `engine-provisioner-password`).

### Step 11. Check from outside (CloudShell, replace the domain)
```
D=fenvix.dev
curl -s https://api.$D/healthz
openssl s_client -connect check.eu-west-1.db.$D:27018 -servername check.eu-west-1.db.$D </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -enddate
timeout 5 bash -c "echo > /dev/tcp/$(dig +short api.$D | head -1)/8443" && echo OPEN || echo CLOSED
```
Expected: `{"ok":true}`; a subject with `*.eu-west-1.db.fenvix.dev` and a Let's Encrypt issuer (for example `O = Let's Encrypt, CN = R12`; with staging, an issuer starting with `(STAGING)`); `CLOSED` (the admin port is not reachable from the internet). If `dig` is missing, use the `PublicIp` printed in Step 7 instead of `$(dig ...)`.

### Certificate renewal
Automatic, see "TLS certificate": checked twice a day, renewed when less than 30 days are left, engine and TLS terminator restarted once only when the certificate changed. The engine has `rotateCertificates` (it reloads the files without a restart), but with `--auth` the engine allows that command only to a user with every privilege (`__system`), which no user here has, not even `fenvix_root`; so the server restarts it instead (a few seconds; drivers reconnect). To check now: `sudo systemctl start fenvix-tls.service`, then `sudo journalctl -u fenvix-tls -n 20 --no-pager`.

### Adding a region later
1. You need an existing Route 53 zone: set `FENVIX_HOSTED_ZONE_ID` (if the first deploy created the zone, its id is in Route 53, Hosted zones).
2. Change one line: `"regions": "eu-west-1,us-east-1"` in `cdk.json`.
3. In `deploy-policy.json` every ARN that contains `eu-west-1` needs a twin with the new region, and the `aws:RequestedRegion` lists need the new region. Update the inline policy in IAM.
4. Set `artifactsBucket` to the first region's `ArtifactsBucketName` output (the releases stay in one bucket; the new server reads them across regions).
5. Repeat Step 2 (secrets) in the new region, then `npx cdk deploy --all`. The new region gets its own engine, bucket, certificate (only `*.<region>.db.<domain>`), certificate copy in Secrets Manager and `*.<region>.db.<domain>` record; its server may write only its own `_acme-challenge.<region>.db.<domain>` TXT record. The control plane stays in the first region and manages **only the first region's engine** (reaching another region's admin port is not built; see `results-infra.md`).

## If the budget stops the server
At 100% the budget stops the engine server (the data is safe in S3). To resume: raise `budgetAmount`, deploy, and in EC2 console select the instance, Instance state, Start. Services start by themselves. Budget data is updated a few times a day, so the stop can come some hours late.

## Tear everything down

Do this in order. Data is deleted for good in step 3.

1. In CloudShell: `npx cdk destroy --all`. This removes the server, network, roles (also the two publish roles and GitHub's OIDC provider, if the stack made it), alarm, budget, DNS records, the certificate copy in Secrets Manager and (if the stack created it) the hosted zone. The **S3 buckets stay** (data and artifacts). Secrets Manager keeps a deleted secret for a recovery period: if you deploy again within it and the deploy fails with "already scheduled for deletion", run `aws secretsmanager delete-secret --region eu-west-1 --secret-id fenvix-prod-tls-eu-west-1 --force-delete-without-recovery` and deploy again.
2. Option A: point the domain's name servers back at GoDaddy's (with the website records there) before step 1 finishes, or the domain stops resolving. Option B: delete the `db` NS records, `api` (A) and `_acme-challenge.api` (CNAME) at your DNS provider (not `console`: that is the dashboard on Vercel), and the `db.<domain>` zone in Route 53 if you created it by hand.
3. Delete the bucket (customer data!): S3 console, open `fenvix-prod-data-...`. The bucket policy blocks everyone except the engine role and the account root user. Either sign in as the root user, or first remove the policy: Permissions, Bucket policy, Delete. Then *Empty* (it also removes old versions), then *Delete*.
   The artifacts bucket (`fenvix-prod-eu-west-1-artifactsbucket...`, only release files): same way, its policy also lets only the root user in.
4. Systems Manager, Parameter Store: delete the parameters under `/fenvix/prod/`.
5. IAM: delete the role `fenvix-deployer`.
6. Next day: Billing, Bills, check that no charges are left (an Elastic IP, hosted zone or secret left behind costs a few dollars a month).

## Checks that ran in development
`npm test` runs the assertions (bucket, TLS, ports, engine flags, certificate names, secrets, IAM, Route 53 challenge permission, tags, budget, DNS, regions, deploy policy), the cdk-nag AwsSolutions lint, the boot scripts (bash syntax, size and decoding of the compressed user data, the secrets fetcher, `fenvix-tls` and the DNS hook against a fake certbot and fake AWS answers) and the control plane's own settings check on the container environment. With `FENVIX_TEST_CERTBOT=/path/to/certbot npm test` the real certbot also checks the command line (against a closed local port, never Let's Encrypt). What cannot be proven without a real AWS account is in `results-infra.md`.
