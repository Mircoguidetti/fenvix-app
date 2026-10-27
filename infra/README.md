# FENVIX on AWS: deploy guide

This folder describes the AWS setup for FENVIX as code. **Nothing here has been deployed.** The first deploy is a step you do yourself, in order, below. Read the whole page once before starting.

## What you get (per region)

| Piece | What it is |
|---|---|
| Data bucket | One private S3 bucket `fenvix-<env>-data-<account>-<region>`. Encrypted, versioned, old versions deleted after `retentionDays`, HTTPS only, readable only by the engine node. It is **kept** when you delete the stack (it holds customer data). |
| Engine node | One EC2 server (default `t3.medium`) with a small encrypted disk. It runs the FENVIX engine and the control-plane container, and restarts them if they stop. AWS replaces the host if the host fails. |
| Network | A private network (VPC) with one public subnet. Open to the internet: port 27017 (database, TLS) and 443 (control plane). The engine's admin port (27018) is open **only to the server's own security group**. No SSH; you connect with Session Manager in the browser. |
| Cost guard | A monthly budget with emails at 50%, 80%, 100%, and an automatic action that **stops the engine server at 100%**. |
| DNS and certificate | Only if you set `BASE_DOMAIN`. Otherwise none, and the engine uses a self-signed certificate. |

Everything is tagged `project=fenvix` and `env=<prod|...>`.

## Files

- `deploy-policy.json`: the permissions your deploy role needs, nothing more.
- `cdk.json`: the settings (region list, server size, budget...).
- `lib/`, `bin/`: the code. `test/`: the checks.

## Settings

Set them in `cdk.json` (section `context`) or per command with `-c name=value`. Environment variables also work (name in the last column). Command line beats environment beats `cdk.json`.

| Setting | Default | Meaning | Env variable |
|---|---|---|---|
| `regions` | `eu-central-1` | Comma list. **One more entry = one more full copy in that region.** | `FENVIX_REGIONS` |
| `account` | `865859654353` | AWS account. Deploy stops if your login is a different account. | `FENVIX_ACCOUNT` |
| `env` | `prod` | The `env` tag, and part of every name. | `FENVIX_ENV` |
| `instanceType` | `t3.medium` | `t3.medium`, `c6i.large` or `c7g.large` (c7g is ARM: needs an ARM engine build). | `FENVIX_INSTANCE_TYPE` |
| `volumeGb` | `20` | Server disk size. | `FENVIX_VOLUME_GB` |
| `retentionDays` | `30` | Days an overwritten/deleted object version is kept. | `FENVIX_RETENTION_DAYS` |
| `budgetAmount` | `100` | Monthly budget in US dollars, per region. | `FENVIX_BUDGET_AMOUNT` |
| `budgetEmail` | **required** | Where alerts go. | `FENVIX_BUDGET_EMAIL` |
| `engineUrl` | placeholder | HTTPS link to the engine binary. `{arch}` becomes `x86_64` or `aarch64`. | `FENVIX_ENGINE_URL` |
| `engineSha256` | empty | Checksum of the binary; if set, the server refuses any other file. | `FENVIX_ENGINE_SHA256` |
| `controlPlaneImage` | placeholder | Container image of the control plane, e.g. `ghcr.io/your-org/fenvix-control-plane:1.0.0`. | `FENVIX_CONTROL_PLANE_IMAGE` |
| `adminPort` / `controlPlanePort` | `27018` / `443` | Ports. | `FENVIX_ADMIN_PORT` / `FENVIX_CONTROL_PLANE_PORT` |
| `baseDomain` | unset | Your domain, e.g. `fenvix.cloud`. Unset = no DNS, no certificate. | `BASE_DOMAIN` |
| `hostedZoneId` | unset | Use an existing Route 53 zone instead of creating one. | `FENVIX_HOSTED_ZONE_ID` |

**Placeholders.** `engineUrl` and `controlPlaneImage` ship with `example.invalid ... REPLACE-ME`. Nothing is downloaded when you build the templates. If a placeholder is still there when the server boots, the server stops with the message "release location still has the placeholder value" (see Step 8) and starts nothing. The engine and the container image must be downloadable **without a login**, because the server's permissions are limited to its own bucket and its own settings.

## The secrets (you create them, they are never in the code)

Create these in the AWS console as **SecureString** parameters (Step 3). The server reads them when it starts. Replace `prod` if you changed `env`.

| Name | Used by | Value |
|---|---|---|
| `/fenvix/prod/engine/admin-token` | engine (as `FENVIX_ADMIN_TOKEN`) | a long random string |
| `/fenvix/prod/control-plane/session-secret` | control plane (as `SESSION_SECRET`) | a long random string |

Any other parameter you add under `/fenvix/prod/engine/` or `/fenvix/prod/control-plane/` is handed to that service the same way (name in capitals, `-` becomes `_`; engine names get a `FENVIX_` prefix). The server stops and tells you which required parameter is missing. Parameters are per region: repeat Step 3 in each region.

## Deploy, step by step

You need: a web browser, the AWS login of the account `865859654353`, and about 45 minutes. These steps use **AWS CloudShell** (a terminal inside the AWS console that already has Node.js and the AWS tools), so nothing is installed on your computer.

### Step 1. Create the deploy role
1. AWS console, top right: choose the region **Europe (Frankfurt) eu-central-1**.
2. IAM, then Roles, then Create role. Trusted entity: *AWS account*, *This account*. Name it `fenvix-deployer`. Create it without permissions.
3. Open the role, Add permissions, **Create inline policy**, JSON tab. Paste the whole content of `infra/deploy-policy.json`. Name it `fenvix-deploy`. (It is longer than the 6,144 characters a managed policy may have, so it must be inline.)
4. Switch to this role: your name (top right), Switch role, account `865859654353`, role `fenvix-deployer`. Stay in this role for the rest of the steps.

### Step 2. Open CloudShell and get the code
1. Click the `>_` icon in the bottom bar of the console (CloudShell). Wait for the prompt.
2. Run, one line at a time:
   ```
   git clone https://github.com/mircoguidetti/olvix-app.git
   cd olvix-app && git checkout infra-aws && cd infra
   npm ci
   ```
   If CloudShell says `node` is too old, run `nvm install 22` first.

### Step 3. Create the secrets (before the first deploy)
1. In CloudShell, make two random values: `openssl rand -hex 32` (run it twice and keep each result for the next step; do not paste them anywhere else).
2. Console: Systems Manager, Parameter Store, Create parameter. For each row of the secrets table: Name as written, Tier *Standard*, Type **SecureString**, KMS key *alias/aws/ssm* (default), Value = one random string. Create.
3. Also add the tag `project` = `fenvix` to each parameter (Tags section while creating).

### Step 4. Fill in the release location
Get from your engineers: the HTTPS link of the engine binary (with `{arch}` where the CPU name goes), its SHA-256, and the control-plane image name. Then in CloudShell:
```
export FENVIX_BUDGET_EMAIL="you@yourcompany.com"
export FENVIX_ENGINE_URL="https://.../fenvix-engine-{arch}"
export FENVIX_ENGINE_SHA256="<64 characters>"
export FENVIX_CONTROL_PLANE_IMAGE="ghcr.io/your-org/fenvix-control-plane:1.0.0"
```
(These last until you close CloudShell. Set them again if it restarts.)

### Step 5. Check the plan without touching AWS
```
npm test
npx cdk synth --quiet
```
`npm test` must end with `Tests: ... passed`. `cdk synth` only writes files into `cdk.out/`; it changes nothing in AWS.

### Step 6. Deploy
```
npx cdk deploy --all --require-approval broadening
```
Read the table it shows (roles, security group). Type `y`. It takes 5 to 10 minutes. No `cdk bootstrap` is needed: the stack uses no uploaded files. At the end it prints `BucketName`, `InstanceId`, `PublicIp`, `SecretsPath`.

### Step 7. Switch on the cost tracking (once)
Billing console, Cost allocation tags, activate the user tags `project` and `env`. (Optional but useful: it lets Cost Explorer split costs per tag from the next day on. The budget itself already works per region without it.)

### Step 8. Check the server
1. EC2 console, Instances, select the `fenvix` instance, Connect, **Session Manager**, Connect.
2. Run:
   ```
   sudo tail -50 /var/log/fenvix-bootstrap.log
   systemctl status fenvix-engine fenvix-control-plane
   sudo journalctl -u fenvix-engine -n 50
   ```
   - "release location still has the placeholder value": Step 4 was skipped. Set the variables, run `npx cdk deploy --all` again (AWS replaces the server; no data is lost, it lives in S3).
   - "missing SSM parameters": a name in Step 3 is misspelled. Fix it in Parameter Store, then `sudo systemctl restart fenvix-engine fenvix-control-plane`.

### Step 9. Domain (only when you own one)
Until then the engine serves a **self-signed certificate** and no DNS exists. When you have the domain:
1. `export BASE_DOMAIN="fenvix.cloud"` and `npx cdk deploy --all`.
2. While the stack shows `CREATE_IN_PROGRESS`, open Route 53, Hosted zones, your domain, copy the 4 `NS` values into your domain registrar as the name servers. The certificate for `*.db.<domain>` and `console.<domain>` is validated by DNS and the stack waits for it. (Prefer to keep an existing zone: set `FENVIX_HOSTED_ZONE_ID=Z...` too.)
3. The certificate is requested as *exportable* (ACM charges extra for that). The server does **not** pick it up automatically yet; see `results-infra.md`, "Not done".

### Adding a region later
1. Change one line: `"regions": "eu-central-1,us-east-1"` in `cdk.json`.
2. In `deploy-policy.json` every ARN that contains `eu-central-1` needs a twin with the new region, and the `aws:RequestedRegion` lists need the new region. Update the inline policy in IAM.
3. Repeat Step 3 (secrets) in the new region, then `npx cdk deploy --all`. DNS stays with the first region.

## If the budget stops the server
At 100% the budget stops the engine server (the data is safe in S3). To resume: raise `budgetAmount`, deploy, and in EC2 console select the instance, Instance state, Start. Services start by themselves. Budget data is updated a few times a day, so the stop can come some hours late.

## Tear everything down

Do this in order. Data is deleted for good in step 3.

1. In CloudShell: `npx cdk destroy --all`. This removes the server, network, roles, alarm, budget, and (if created) the hosted zone and certificate. The **S3 bucket stays**.
2. If you created a hosted zone, point the domain's name servers back at your registrar's before step 1 finishes, or the domain stops resolving.
3. Delete the bucket (customer data!): S3 console, open `fenvix-prod-data-...`. The bucket policy blocks everyone except the engine role and the account root user. Either sign in as the root user, or first remove the policy: Permissions, Bucket policy, Delete. Then *Empty* (it also removes old versions), then *Delete*.
4. Systems Manager, Parameter Store: delete the parameters under `/fenvix/prod/`.
5. IAM: delete the role `fenvix-deployer`.
6. Next day: Billing, Bills, check that no charges are left (an Elastic IP or hosted zone left behind costs a few dollars a month).

## Checks that ran in development
`npm test` runs the assertions (bucket, TLS, admin port, IAM, tags, budget, DNS, regions, deploy policy), the cdk-nag AwsSolutions lint and a test of the server start-up script. `npx cdk synth -c regions=eu-central-1,us-east-1` proves the region list. What cannot be proven without a real AWS account is in `results-infra.md`.
