# FENVIX on AWS: deploy guide

This folder describes the AWS setup for FENVIX as code. **Nothing here has been deployed.** The first deploy is a step you do yourself, in order, below. Read the whole page once before starting.

## What you get (per region)

| Piece | What it is |
|---|---|
| Data bucket | One private S3 bucket `fenvix-<env>-data-<account>-<region>`. Encrypted, versioned, old versions deleted after `retentionDays`, HTTPS only, readable only by the engine server. It is **kept** when you delete the stack (it holds customer data). |
| Engine server | One EC2 server (default `t3.medium`) with a small encrypted disk. It runs the FENVIX engine and restarts it if it stops. AWS replaces the host if the host fails. |
| Control plane | In the **first region** only: the control-plane container (the API the dashboard calls) and, in front of it, a small TLS terminator (Caddy) that serves `https://console.<your domain>`. |
| Network | A private network (VPC) with one public subnet. Open to the internet: port **27018** (database, TLS required) and **443** (control plane, HTTPS). The engine's admin port (**8443**) is open to nothing: it listens only inside the server, where the control plane reaches it. No SSH; you connect with Session Manager in the browser. |
| Certificate and DNS | One free **Let's Encrypt** certificate per region for `*.<region>.db.<your domain>` (every database host has this form, for example `orders-1a2b3c4d.eu-central-1.db.example.com`) and, in the first region, `console.<your domain>`. The server requests and renews it itself (DNS check in Route 53) and keeps a copy in Parameter Store, so a replaced server does not request a new one. DNS records point these names at the server. |
| Cost guard | A monthly budget with emails at 50%, 80%, 100%, and an automatic action that **stops the engine server at 100%**. |

Everything is tagged `project=fenvix` and `env=<prod|...>`.

## Files

- `deploy-policy.json`: the permissions your deploy role needs, nothing more.
- `cdk.json`: the settings (region list, server size, budget...).
- `lib/`, `bin/`: the code. `test/`: the checks.
- `lib/engine-command.ts`: the engine's start command (the only place with the engine's flag names).
- `lib/control-plane-env.ts`: every setting of the control-plane container (the only place to add one).
- `lib/parameters.ts`: the secrets the services need (the table below mirrors it).
- `lib/acme.ts`: the certificate: client version and checksum, names, the script that requests and renews it.

## Settings

Set them in `cdk.json` (section `context`) or per command with `-c name=value`. Environment variables also work (name in the last column). An environment variable beats `cdk.json` and `-c` (so the `export` lines in Step 5 always win).

| Setting | Default | Meaning | Env variable |
|---|---|---|---|
| `regions` | `eu-central-1` | Comma list. **One more entry = one more full copy in that region** (needs `hostedZoneId`). | `FENVIX_REGIONS` |
| `account` | `865859654353` | AWS account. Deploy stops if your login is a different account. | `FENVIX_ACCOUNT` |
| `env` | `prod` | The `env` tag, and part of every name. | `FENVIX_ENV` |
| `instanceType` | `t3.medium` | `t3.medium`, `c6i.large` or `c7g.large` (c7g is ARM: needs an ARM engine build). | `FENVIX_INSTANCE_TYPE` |
| `volumeGb` | `20` | Server disk size. | `FENVIX_VOLUME_GB` |
| `retentionDays` | `30` | Days an overwritten/deleted object version is kept. | `FENVIX_RETENTION_DAYS` |
| `budgetAmount` | `100` | Monthly budget in US dollars, per region. | `FENVIX_BUDGET_AMOUNT` |
| `budgetEmail` | **required** | Where alerts go. | `FENVIX_BUDGET_EMAIL` |
| `baseDomain` | **required** | Your domain, e.g. `fenvix.cloud`. | `BASE_DOMAIN` |
| `dnsZone` | `db` | What Route 53 holds: `db` = only `db.<domain>` (recommended, see "The domain"), `domain` = the whole domain. | `FENVIX_DNS_ZONE` |
| `hostedZoneId` | unset | Use an existing Route 53 zone (of `db.<domain>` or of `<domain>`, as `dnsZone` says) instead of creating one. **Required with more than one region.** | `FENVIX_HOSTED_ZONE_ID` |
| `acmeEmail` | **required**, no default | Your address for the Let's Encrypt account (expiry warnings, incidents). | `FENVIX_ACME_EMAIL` |
| `acmeStaging` | `false` | `true` = Let's Encrypt **staging**: for the first try only (see "The certificate"). | `FENVIX_ACME_STAGING` |
| `dashboardOrigins` | **required** | Web address of the dashboard, e.g. `https://app.fenvix.cloud` (comma list if several). | `FENVIX_DASHBOARD_ORIGINS` |
| `engineUrl` | placeholder | HTTPS link to the engine binary. `{arch}` becomes `x86_64` or `aarch64`. | `FENVIX_ENGINE_URL` |
| `engineSha256` | empty | Checksum of the binary; if set, the server refuses any other file. | `FENVIX_ENGINE_SHA256` |
| `controlPlaneImage` | placeholder | Container image of the control plane, e.g. `ghcr.io/your-org/fenvix-control-plane:1.0.0`. | `FENVIX_CONTROL_PLANE_IMAGE` |
| `proxyImage` | `public.ecr.aws/docker/library/caddy:2.8.4` | Container image of the TLS terminator in front of the control plane. | `FENVIX_PROXY_IMAGE` |
| `engineRetentionWindowSecs` | `604800` (7 days) | How far back a database can be restored; set by the control plane on every new database. | `FENVIX_ENGINE_RETENTION_WINDOW_SECS` |
| `mongoPort` / `adminPort` / `controlPlanePort` | `27018` / `8443` / `443` | Database port (open to the internet), engine admin port (open to nothing), control-plane HTTPS port. | `FENVIX_MONGO_PORT` / `FENVIX_ADMIN_PORT` / `FENVIX_CONTROL_PLANE_PORT` |

**Placeholders.** `engineUrl` and `controlPlaneImage` ship with `example.invalid ... REPLACE-ME`. Nothing is downloaded when you build the templates. If a placeholder is still there when the server boots, the server stops with the message "release location still has the placeholder value" (see Step 9) and starts nothing. The engine and the container images must be downloadable **without a login**, because the server's permissions are limited to its own bucket, its own settings and its own certificate. `baseDomain` and `dashboardOrigins` ship empty and `acmeEmail` is not in `cdk.json` at all: `cdk synth` stops with "Missing setting ..." until you set them.

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

1. **The domain.** You need a domain you control (for example `fenvix.cloud`). Without one nothing can start: the engine only accepts encrypted connections and needs a certificate for `*.<region>.db.<domain>`. How the DNS is split is in "The domain" below; the recommendation is **option B** (`dnsZone=db`, the default).
2. **The dashboard address** (for example `https://app.fenvix.cloud`): where the dashboard web app is served. The API will be `https://console.<domain>/v1`.
3. **The certificate email** (`acmeEmail`): a mailbox you read. Let's Encrypt writes there if something is wrong with the certificate.

### The domain

You buy the domain from a registrar (Cloudflare or GoDaddy); today the website is on Vercel. Route 53 must answer for the database names, because the server proves to Let's Encrypt that it controls them by writing a short-lived TXT record in Route 53. Two ways:

**Option A: the whole domain moves to Route 53** (`dnsZone=domain`). The stack makes a Route 53 zone `<domain>` with `console.<domain>` and `*.<region>.db.<domain>`.
- At the registrar, replace the domain's name servers with the 4 that the deploy prints (`NameServers`). **Cloudflare Registrar does not allow other name servers** (a domain bought there must keep Cloudflare DNS): with Cloudflare, option A is not possible. GoDaddy allows it (Domain, DNS, Nameservers, Change, "I'll use my own nameservers").
- Before switching, recreate in Route 53 (console, Hosted zones, `<domain>`, Create record) **every record the domain has today**: the website (the values Vercel shows in Project, Settings, Domains; usually `A` for `@` and `CNAME` `www` to Vercel's name), and every `MX`, `TXT` (SPF, DKIM, DMARC, site verifications) and `CAA` record. A forgotten record breaks the site or the email when the name servers switch.
- Records that must exist afterwards: the site's records (by hand), `console.<domain>` `A` and `*.<region>.db.<domain>` `A` (by the stack), the Route 53 `NS`/`SOA` (by Route 53). Temporary `_acme-challenge` TXT records come and go during a renewal.

**Option B (recommended): only `db.<domain>` moves to Route 53** (`dnsZone=db`, default). The stack makes a Route 53 zone `db.<domain>` with `*.<region>.db.<domain>`. The domain's DNS stays where it is (Cloudflare, GoDaddy or Vercel) and the website is not touched. Where that DNS is, you add by hand three kinds of record, which the deploy prints (`NameServers`, `ManualDnsRecords`):

| Type | Name (in the DNS of `<domain>`) | Value | Why |
|---|---|---|---|
| `NS` (4 records) | `db` | the 4 name servers of `NameServers` (one per record) | hands `db.<domain>` and everything under it to Route 53 |
| `A` | `console` | the `PublicIp` of the deploy (an Elastic IP: it stays the same when the server is replaced) | the control-plane API |
| `CNAME` | `_acme-challenge.console` | `_acme-challenge.console.db.<domain>` | lets the server prove `console.<domain>` to Let's Encrypt without access to your main DNS |

On Cloudflare: DNS, Records, Add record; for `console` and the `CNAME` set **Proxy status: DNS only** (grey cloud). On GoDaddy: Domain, DNS, Add New Record (GoDaddy accepts `NS` records for a subdomain). No record of the website changes.

Why B: the website and email stay untouched, it works with Cloudflare Registrar, and the server's permissions reach only the `db.<domain>` zone, never the records of the website. The cost of either option is the same (one Route 53 zone, $0.50 a month). With A you manage one DNS place instead of two, but you move every record of the domain, and with Cloudflare you cannot.

### The certificate

The certificate is free (Let's Encrypt). It is issued **on the server**, not in AWS: at the first start the server asks Let's Encrypt, writes the TXT record `_acme-challenge.<...>` in Route 53, gets the certificate, stores it as `/etc/fenvix/tls/engine.pem` (chain and key, readable only by the engine user) and keeps a copy in the SecureString parameter `/fenvix-tls/prod/acme-state` (Advanced tier, about $0.05 a month), made by the server, not by the stack.

- **Renewal:** twice a day the server checks. With fewer than 30 days left (certificates last 90) it renews, and only if the certificate changed it restarts the engine and the TLS terminator (a few seconds; drivers reconnect).
- **A replaced server** (new deploy, budget stop and start, host failure) takes the certificate from Parameter Store and does not ask Let's Encrypt again. That matters: Let's Encrypt gives at most 5 identical certificates a week, and allows 5 failed checks an hour. After a failed request the server waits 20 minutes before the next one.
- **No certificate, no service:** if the server has no valid certificate and cannot get one, the engine and the TLS terminator do not start, and the log says why (Step 9).
- **`acmeStaging=true` (first try):** uses the Let's Encrypt test service, which has much higher limits. Use it for the very first deploy, or after changing the domain or the DNS, to check that everything works without spending the real limits. **Database drivers and browsers do not trust staging certificates**: connections fail with a certificate error, which is expected. Once Step 9 shows `fenvix-tls: certificate installed`, set `FENVIX_ACME_STAGING=false` and deploy again: the server is replaced and gets the real certificate (the staging copy is ignored).
- **What the server may change in DNS:** only TXT records named `_acme-challenge.<region>.db.<domain>` (and the `console` one) in the stack's zone. It cannot change the `A` records or any other zone. Whoever takes over the server can still get a certificate for these names: see `report-infra-align.md`.

## Deploy, step by step

You need: a web browser, the AWS login of the account `865859654353`, your domain, and about an hour. These steps use **AWS CloudShell** (a terminal inside the AWS console that already has Node.js and the AWS tools), so nothing is installed on your computer.

### Step 1. Choose the region
AWS console, top right: choose **Europe (Frankfurt) eu-central-1**. Every step below happens in this region.

### Step 2. Create the secrets (with your own login, before the deploy role)
1. Click the `>_` icon in the bottom bar of the console (CloudShell). Wait for the prompt.
2. Paste these lines **one block at a time**. They make random values and store them directly; the values never appear on screen. Each command prints something like `{ "Version": 1, "Tier": "Standard" }`.
   ```
   R=eu-central-1; P=/fenvix/prod
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
Get from your engineers: the HTTPS link of the engine binary (with `{arch}` where the CPU name goes), its SHA-256, and the control-plane image name. Then:
```
export FENVIX_BUDGET_EMAIL="you@yourcompany.com"
export BASE_DOMAIN="fenvix.cloud"
export FENVIX_DASHBOARD_ORIGINS="https://app.fenvix.cloud"
export FENVIX_ENGINE_URL="https://.../fenvix-engine-{arch}"
export FENVIX_ENGINE_SHA256="<64 characters>"
export FENVIX_CONTROL_PLANE_IMAGE="ghcr.io/your-org/fenvix-control-plane:1.0.0"
export FENVIX_ACME_EMAIL="you@yourcompany.com"
export FENVIX_ACME_STAGING=true
```
`FENVIX_ACME_STAGING=true` for the first deploy only (see "The certificate"). Option A of "The domain" only: `export FENVIX_DNS_ZONE=domain`. If you already have the Route 53 zone (needed for more than one region): `export FENVIX_HOSTED_ZONE_ID="Z..."`.
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
Read the table it shows (roles, security group). Type `y`. No `cdk bootstrap` is needed: the stack uploads no files. The boot scripts that do not fit in the server's 16 KB start-up data are in the template itself, as plain (not secret) Parameter Store values `/fenvix-boot/prod/scripts-*`; the server checks their SHA-256 before running them.

It takes 10 to 20 minutes. At the end it prints `BucketName`, `InstanceId`, `PublicIp`, `SecretsPath`, `DatabaseHosts` (`*.eu-central-1.db.<domain>`), `ControlPlaneUrl` (`https://console.<domain>/v1`), `TlsStateParameter`, `NameServers` (if the stack made the zone) and, with option B, `ManualDnsRecords`.

Now make the DNS records of "The domain" (option B: the table; option A: the name servers at the registrar). Until they work, the server cannot get its certificate and the engine does not start (it tries again every 20 minutes; Step 9). To check from CloudShell that the delegation works: `dig +short NS db.<domain>` (option B) must print the 4 Route 53 name servers.

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
   Expected: the log ends with `fenvix bootstrap done`; the three services are `active (running)`; the engine log shows `fenvix-tls: certificate from Let's Encrypt ...`, `fenvix-tls: certificate installed`, `fenvix-tls: certificate saved in /fenvix-tls/prod/acme-state` and `admin interface listening on 172.17.0.1:8443 (bearer token required)`.
   - "release location still has the placeholder value": Step 5 was skipped. Set the variables, run `npx cdk deploy --all` again (AWS replaces the server; no data is lost, it lives in S3).
   - "missing SSM parameters: ...": the names listed are missing or misspelled. Fix them in Parameter Store (Step 2), then `sudo systemctl restart fenvix-engine fenvix-control-plane fenvix-proxy`.
   - "... must hold the same value as ...": the two admin tokens differ. Put the same value in both (Step 2), then restart as above.
   - "fenvix-tls: the request to Let's Encrypt failed" followed by "FATAL: no valid certificate": usually the DNS records of "The domain" are missing or not yet visible (check `dig +short NS db.<domain>`), or `acmeEmail` was refused. The lines in between say what Let's Encrypt or Route 53 answered. After fixing it, either wait up to 20 minutes or run `sudo rm -f /var/lib/fenvix-acme/.failed && sudo systemctl restart fenvix-engine fenvix-proxy`. Do not loop this: Let's Encrypt allows 5 failed checks an hour.
   - "FATAL: no certificate on this server and the saved one cannot be read": the server cannot read `/fenvix-tls/prod/acme-state` (permissions). It does not ask Let's Encrypt in that case.
   - "the saved state in ... is unreadable": delete that parameter (Parameter Store) and restart the engine; a new certificate is requested.
3. Which ports listen where:
   ```
   sudo ss -ltn | grep -E ':(27018|8443|443) '
   ```
   Expected: `0.0.0.0:27018`, `172.17.0.1:8443` (the admin port, inside the server only) and `0.0.0.0:443`.
4. The admin port refuses requests without the token (from the server):
   ```
   curl -s -o /dev/null -w '%{http_code}\n' http://172.17.0.1:8443/health
   ```
   Expected: `401`.

### Step 10. Create the engine's users (once)
The control plane makes one engine user per customer database, through an engine user called `fenvix_provisioner`. That user is made once, from the server itself:
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
D=fenvix.cloud
curl -s https://console.$D/healthz
openssl s_client -connect check.eu-central-1.db.$D:27018 -servername check.eu-central-1.db.$D </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -enddate
timeout 5 bash -c "echo > /dev/tcp/$(dig +short console.$D | head -1)/8443" && echo OPEN || echo CLOSED
```
Expected: `{"ok":true}`; a subject with `*.eu-central-1.db.fenvix.cloud` and a Let's Encrypt issuer (with `acmeStaging=true`: an issuer marked `(STAGING)`, and `curl` fails with a certificate error, which is expected; add `-k` to check the rest); `CLOSED` (the admin port is not reachable from the internet). If `dig` is missing, use the `PublicIp` printed in Step 7 instead of `$(dig ...)`.

### Certificate renewal
Twice a day (04:20 and 16:20 UTC, plus up to an hour) the server runs `fenvix-tls`. With more than 30 days left it does nothing and asks nobody. With fewer it renews; if the certificate changed it installs it, saves it in Parameter Store and restarts the engine and the TLS terminator once (a few seconds of interruption; drivers reconnect). The engine cannot load a new certificate without a restart. To run the check now: `sudo systemctl start fenvix-tls.service`, then `sudo journalctl -u fenvix-tls -n 10 --no-pager`. Expiry date: `sudo openssl x509 -in /etc/fenvix/tls/engine.pem -noout -enddate`.

### Adding a region later
1. You need an existing Route 53 zone: set `FENVIX_HOSTED_ZONE_ID` (if the first deploy created the zone, its id is in Route 53, Hosted zones). Each region's server may write only its own `_acme-challenge.<region>.db.<domain>` record.
2. Change one line: `"regions": "eu-central-1,us-east-1"` in `cdk.json`.
3. In `deploy-policy.json` every ARN that contains `eu-central-1` needs a twin with the new region, and the `aws:RequestedRegion` lists need the new region. Update the inline policy in IAM.
4. Repeat Step 2 (secrets) in the new region, then `npx cdk deploy --all`. The new region gets its own engine, bucket, certificate and `*.<region>.db.<domain>` record. The control plane stays in the first region and manages **only the first region's engine** (reaching another region's admin port is not built; see `results-infra.md`).

## If the budget stops the server
At 100% the budget stops the engine server (the data is safe in S3). To resume: raise `budgetAmount`, deploy, and in EC2 console select the instance, Instance state, Start. Services start by themselves. Budget data is updated a few times a day, so the stop can come some hours late.

## Tear everything down

Do this in order. Data is deleted for good in step 3.

1. In CloudShell: `npx cdk destroy --all`. This removes the server, network, roles, alarm, budget, boot-script parameters, DNS records and (if created) the hosted zone. The **S3 bucket stays**. Route 53 refuses to delete a zone that still holds records it did not create (for example a `_acme-challenge` TXT left by an interrupted renewal): delete those in the Route 53 console and run the command again.
2. Option A: point the domain's name servers back at your registrar's before step 1 finishes, or the domain stops resolving. Option B: delete the `db` NS records, `console` and `_acme-challenge.console` where the domain's DNS is.
3. Delete the bucket (customer data!): S3 console, open `fenvix-prod-data-...`. The bucket policy blocks everyone except the engine role and the account root user. Either sign in as the root user, or first remove the policy: Permissions, Bucket policy, Delete. Then *Empty* (it also removes old versions), then *Delete*.
4. Systems Manager, Parameter Store: delete the parameters under `/fenvix/prod/` and `/fenvix-tls/prod/acme-state` (the saved certificate; the stack does not own it).
5. IAM: delete the role `fenvix-deployer`.
6. Next day: Billing, Bills, check that no charges are left (an Elastic IP or hosted zone left behind costs a few dollars a month).

## Checks that ran in development
`npm test` runs the assertions (bucket, TLS, ports, engine flags, certificate names, secrets, IAM, tags, budget, DNS, regions, deploy policy), the cdk-nag AwsSolutions lint, the boot scripts (bash syntax, the boot-script download and its checksum, the secrets fetcher, and the certificate script run for real with a fake Let's Encrypt client and fake AWS answers: first issue, reuse, restore on a new server, renewal near expiry, restart only on change, failures) and the control plane's own settings check on the container environment. What cannot be proven without a real AWS account is in `results-infra.md`.
