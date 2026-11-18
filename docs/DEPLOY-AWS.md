# Deploying the GitHub App and the runners on AWS

This page is for the founder. It puts the fenvix GitHub App on `https://github.fenvix.dev` (Lambda, SQS, API Gateway,
Supabase), always up. The runners come in three modes:

- **Demo mode (default, built):** `demo-up` starts one fresh c6i.large for a demo and registers it as a runner on
  your demo repository (the only repository it accepts); `demo-down` terminates it, then deregisters it. Each demo
  gets a new machine, so no data is shared between demos.
- **Per-job mode (option, built):** each queued job gets its own EC2 machine, deleted after the job, with a shared
  cache in which each customer installation is its own organization.
- **Customer mode (design and spike, not built):** one c7i.xlarge host runs each customer job in its own Firecracker
  microVM (Nitro Sandboxes) and destroys it after the job. See "Customer mode" below.

The steps are in order, with one action per step. **Nothing here has been deployed yet.** The code was synthesized
and tested without an AWS account (see `docs/REPORT-aws-deploy.md`, and `docs/REPORT-aws-deploy-2.md` for the fixes
of review R-012).

Account `865859654353`, region `eu-west-1` (Ireland). Both come from `infra/github-app/cdk.json`.

## What gets created (demo mode)

```
GitHub ──HTTPS──▶ github.fenvix.dev  (API Gateway HTTP API, ACM certificate, DNS on Cloudflare)
                    └▶ Lambda "http": checks the signature or the machine's summary credential, puts the work on SQS,
                       answers 202 (routes /webhooks/github, /github/setup, /healthz and /v1/runner/*)
dashboard ──HTTPS──▶ github.fenvix.dev/v1/*  (every other /v1 route)
                    └▶ Lambda "api": the dashboard API (openapi/fenvix-api.yaml): checks the Supabase session, the
                       membership and the role, reads and writes Postgres as fenvix_api (pooler, transaction mode);
                       queues "open the setup pull request" on SQS
                 SQS "work" queue  (failed 5 times → "dead-letters" queue + alarm; payloads over 200 KB go via S3)
                    └▶ Lambda "worker": stores the event, opens the onboarding PR, publishes the check run, the PR
                       comment, ci_runs, usage events
                 EventBridge Scheduler: "sweep" every minute (jobs whose summary never came), "reaper" every
                       10 minutes (a demo machine older than 12 hours is terminated; the runner of a demo machine
                       that is gone is deregistered)
                 Lambda "demo" (invoked only by scripts/demo-up.sh and demo-down.sh): holds the App key and the
                       summary signing key; works only on demoRepository; registers a runner there and starts one
                       machine with its own summary credential; terminates, then deregisters
Runner image: EC2 Image Builder (Ubuntu 24.04 + strace, build tools, uv, Python, Rust, the engine wheel built by
   runner/bootstrap.sh install, the GitHub runner, the hooks); built by hand with scripts/build-image.sh
Demo machine (c6i.large, 30 GB gp3, from the image, no inbound port, an IAM role with no permission): registered
   runner, labels self-hosted, fenvix; after each job ──▶ POST https://github.fenvix.dev/v1/runner/summaries with its
   own credential; local engine cache on its own disk
Supabase (yours): the role fenvix_github_app writes gh_*, ci_projects, ci_runs, ci_usage_events; the role fenvix_api
   (the dashboard API) reads its organization's rows and changes settings, members and invitations; the browser
   reaches no table (row level security checks the API's membership and role again)
```

| Piece | Detail |
|---|---|
| Secrets | SSM Parameter Store, type SecureString, under `/fenvix/prod/github-app/` (and `/fenvix/prod/cache/` in per-job mode). You create them; the stack never sees their values. Each Lambda reads only its own, by exact name, and reloads them every 5 minutes. **No machine reads any of them**: the machines' IAM role has no permission, and the image build machine is denied every `/fenvix/*` parameter. |
| Machine credentials | Each machine gets its own, in its user data (root only): a summary credential signed for its runner name and repository (per job: also its run), and per job a cache token for its customer's cache organization only. The App takes the runner's identity from the credential, never from the request. Stealing one lets an attacker publish only that one job's summary. |
| Machines | Two users. `fenvix` runs the runner and the job. `fenvix-post` alone holds the machine's summary credential and sends the summary. Neither user can reach the instance metadata service (it serves the user data). `strace -f` works on a job's own children. Outbound traffic is HTTPS and HTTP only. There is no SSH. A machine can only be started through our launch template, of the configured type, from our own images, tagged with its role; the demo function and the reaper may terminate only machines with that tag. |
| IAM | Every role of the stack carries the permissions boundary `fenvix-prod-github-app-boundary` (`permissions-boundary.json`), and CloudFormation may create or change a role only with it. |
| Logs | CloudWatch log groups `/aws/lambda/fenvix-prod-github-app-{http,api,worker,sweep,reaper,demo}` and `/aws/apigateway/fenvix-prod-github-app-api`, kept **14 days**. |
| Dashboard API | Lambda `api`, its own role: reads only `/fenvix/prod/github-app/api-database-url` and `state-signing-key`, may only send to the work queue. It never holds the App's private key, the webhook secret, the OAuth client secret or a runner token. See "The dashboard API" below. |

## The steps

You need a laptop with **Node.js 22.18 or newer**, **AWS CLI v2**, `git` and `openssl`. You also need an AWS admin
login for steps 9 to 11 only.

### A. Secrets and the test repository (your laptop and GitHub)

**Step 1.** Generate four random values and store them in your password manager. Never put them in git, a chat or a
ticket.

```
openssl rand -hex 32      # WEBHOOK_SECRET
openssl rand -hex 32      # STATE_SIGNING_KEY
openssl rand -hex 32      # RUNNER_TOKEN (signs each machine's own summary credential; never on a machine)
openssl rand -base64 36   # DB_PASSWORD (the role fenvix_github_app)
```

**Step 2.** Create a **private** test repository of your own, for example `Mircoguidetti/fenvix-demo`. It is the
only repository a demo runner is ever registered on (setting `demoRepository`, step 15). Give it a small pytest
project and this file, `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.13" }
      - run: pip install -e . pytest
      - run: python -m pytest -q
```

**Step 3.** Create the GitHub App: **github.com → Settings → Developer settings → GitHub Apps → New GitHub App**. Use
the organization's settings for a company-owned App. Enter these values:

| Field | Value |
|---|---|
| GitHub App name | `fenvix` (if taken: `fenvix-ci`) |
| Homepage URL | the dashboard's address, e.g. `https://app.fenvix.dev` |
| Callback URL | `https://github.fenvix.dev/github/setup` |
| Expire user authorization tokens | on |
| Request user authorization (OAuth) during installation | **on** |
| Enable Device Flow | off |
| Redirect on update | on |
| Webhook: Active | on |
| Webhook URL | `https://github.fenvix.dev/webhooks/github` |
| Webhook secret | `WEBHOOK_SECRET` from step 1 |
| SSL verification | Enable |
| Repository permissions | Actions: **Read-only** · **Administration: Read and write** · Checks: **Read and write** · Contents: **Read and write** · Metadata: Read-only · Pull requests: **Read and write** · **Workflows: Read and write** |
| Organization / account permissions | none |
| Subscribe to events | **Pull request**, **Push**, **Workflow job** |
| Where can this GitHub App be installed? | Only on this account (for now) |

Click **Create GitHub App**. `docs/GITHUB-APP.md` explains the other permissions.

**Administration: Read and write** is new. It is the permission GitHub requires for the self-hosted runner calls on a
repository, and the App uses it for nothing else:

- in demo mode: `POST .../actions/runners/registration-token` (demo-up) and `DELETE .../actions/runners/{id}`
  (demo-down);
- in per-job and customer mode: `POST .../actions/runners/generate-jitconfig` (a just-in-time runner for one job).

The runner is registered **on the repository**, so it can only take that repository's jobs.

The organization-level alternative is the organization permission **Self-hosted runners: Read and write**, with
`POST /orgs/{org}/actions/runners/generate-jitconfig`. It is narrower in what it grants, but it does not work for
installations on personal accounts, and its runners could take jobs of any repository in the organization. It is not
used.

Customers see the permission on the install page. Customers who installed the App before must approve the added
permission.

GitHub's first "ping" will fail because nothing answers yet. You redeliver it in step 20.

**Step 4.** On the App's General page, copy the **App ID** and the **Client ID**. The slug is the last part of
`https://github.com/apps/<slug>`.

**Step 5.** On the same page, click **Generate a new client secret** and copy it once (`CLIENT_SECRET`).

**Step 6.** Click **Private keys → Generate a private key**. A `.pem` file downloads. Leave it where it is until
step 13, then delete it.

### B. Supabase (SQL editor of your project)

**Step 7.** Run the migrations once, in order. 0011 and 0012 are already applied. Paste the whole file
`supabase/migrations/0013_github_app.sql` and click Run, then the whole file `supabase/migrations/0014_dashboard_api.sql`
and click Run. Each is safe to repeat (0013 only before 0014: after 0014, run 0014 alone again). 0013 creates the
`gh_*` tables and `ci_usage_events`, the role `fenvix_github_app` (no password, no BYPASSRLS) and its row-level
security policies. 0014 removes the earlier database product, takes every right on our tables away from the browser
(`anon`, `authenticated`: the dashboard talks to the API only), and creates the dashboard API's role `fenvix_api`
(login, no password yet, no BYPASSRLS) with its policies.

**Step 8.** Give the role its password (`DB_PASSWORD` from step 1) **without typing it into the SQL editor**, which
keeps every query in its history. On your laptop, turn it into a SCRAM verifier (computed locally; Postgres stores it
as given and checks logins against it):

```
cd infra/github-app && read -rsp "DB_PASSWORD: " v; echo; printf '%s' "$v" | node scripts/scram-verifier.mjs; unset v
```

It prints one line, `SCRAM-SHA-256$4096:...`. It is not the password and cannot be turned back into it. In the SQL
editor:

```sql
alter role fenvix_github_app with password 'SCRAM-SHA-256$4096:<the rest of the line>';
```

Then build the connection string from Supabase → **Connect** → **Session pooler**, with the user
`fenvix_github_app.<project-ref>`:

```
postgresql://fenvix_github_app.<project-ref>:<DB_PASSWORD>@aws-0-<supabase-region>.pooler.supabase.com:5432/postgres
```

Use the pooler, not the direct host. The direct host `db.<ref>.supabase.co` answers on IPv6 only, and Lambda (outside
a VPC) has IPv4 only. Session mode behaves like a direct connection. Each warm Lambda keeps at most 2 connections
(`DB_POOL_MAX=2`).

**Step 8b.** The dashboard API's role, the same way. Choose a second password `API_DB_PASSWORD`
(`openssl rand -hex 24`), turn it into a verifier on your laptop (`printf '%s' "$v" | node scripts/scram-verifier.mjs`
as above), and in the SQL editor:

```sql
alter role fenvix_api with password 'SCRAM-SHA-256$4096:<the rest of the line>';
```

Its connection string uses the pooler in **transaction mode** (Supabase → **Connect** → **Transaction pooler**,
port **6543**), with the user `fenvix_api.<project-ref>`:

```
postgresql://fenvix_api.<project-ref>:<API_DB_PASSWORD>@aws-0-<supabase-region>.pooler.supabase.com:6543/postgres
```

Transaction mode suits Lambda: a connection is held only for one transaction, so many short API calls share few
database connections. The API is written for it: one transaction per request, who it acts for set with
`set_config(..., true)` (it ends with the transaction), no session state and no named prepared statement. Each warm
API Lambda keeps one connection (`DB_POOL_MAX=1`).

### C. AWS account (an admin, once)

**Step 9.** Create the permissions boundary and the three policies that CloudFormation will use when it creates this
stack. The scope of each:

- **boundary** (`fenvix-prod-github-app-boundary`, exactly this name): the most any role of the stack may ever do.
  Logs of its own functions, `ssm:GetParameter(s)` on `/fenvix/prod/{github-app,cache}/*` and Ubuntu's public image
  parameters, the image build machine's agent, the work queue, the overflow objects, starting, tagging and
  terminating runner machines, passing only the stack's roles to EC2, invoking only the stack's functions. **No IAM
  action** but `iam:PassRole`;
- **app:** Lambda, IAM roles named `fenvix-prod-github-app-*` (created or changed **only with the boundary**; the
  boundary can never be removed or rewritten), SQS, S3, logs, Scheduler;
- **edge:** ACM, API Gateway, the alarm;
- **fleet:** EC2 (only the instance types allowed) and Image Builder.

Run this from `infra/github-app/`:

```
aws iam create-policy --policy-name fenvix-prod-github-app-boundary  --policy-document file://permissions-boundary.json
aws iam create-policy --policy-name fenvix-github-app-cfn-exec-app   --policy-document file://cfn-exec-policy-app.json
aws iam create-policy --policy-name fenvix-github-app-cfn-exec-edge  --policy-document file://cfn-exec-policy-edge.json
aws iam create-policy --policy-name fenvix-github-app-cfn-exec-fleet --policy-document file://cfn-exec-policy-fleet.json
```

**Step 10.** Bootstrap CDK in eu-west-1 with those three policies, using the CDK CLI version pinned in this
repository's lock file (not whatever `npx` would download):

```
cd infra/github-app && npm ci                                                  # installs the pinned aws-cdk
aws cloudformation describe-stacks --stack-name CDKToolkit --region eu-west-1   # "does not exist" is expected
npx --no-install cdk bootstrap aws://865859654353/eu-west-1 --cloudformation-execution-policies \
  arn:aws:iam::865859654353:policy/fenvix-github-app-cfn-exec-app,arn:aws:iam::865859654353:policy/fenvix-github-app-cfn-exec-edge,arn:aws:iam::865859654353:policy/fenvix-github-app-cfn-exec-fleet
```

If `CDKToolkit` already exists, other stacks may rely on its current policies. In that case, add these ARNs to the
policies it already has; do not replace them.

**Step 11.** Create the deploy identity with **exactly** `infra/github-app/deploy-policy.json`. That policy lets it:

- assume the three CDK bootstrap roles and read the stack;
- print the certificate record;
- write the `/fenvix/prod/{github-app,cache}/*` parameters;
- read this stack's logs;
- start the image build;
- invoke the demo function (demo-up, demo-down).

It calls no IAM, Lambda or EC2 API itself. What it can do **through CloudFormation** is bounded by the execution
policies of step 9: CloudFormation creates or changes a role only with the permissions boundary, so no template the
deployer submits can give any role more than the boundary allows (no IAM change, no parameter outside
`/fenvix/prod/{github-app,cache}/`, EC2 only for runner machines). The deployer is therefore not an administrator.
It does deploy the App's code, which reads the App's secrets: treat this identity as able to read them.

- **IAM Identity Center (recommended):** create a permission set `fenvix-github-app-deployer` with the content of
  `deploy-policy.json` as its inline policy. Assign it to your user on account 865859654353. Then run
  `aws configure sso --profile fenvix-deployer` on your laptop.
- **Or an IAM user:** `aws iam create-user --user-name fenvix-github-app-deployer`, then
  `aws iam put-user-policy --user-name fenvix-github-app-deployer --policy-name deploy --policy-document file://deploy-policy.json`,
  then `aws iam create-access-key --user-name fenvix-github-app-deployer` and
  `aws configure --profile fenvix-deployer`.

From here on, everything runs as this identity: `export AWS_PROFILE=fenvix-deployer AWS_REGION=eu-west-1`.

### D. The secrets in SSM (your laptop, as the deployer)

**Step 12.** Create six parameters. Type each value at the prompt, so that it stays out of your shell history:

```
P=/fenvix/prod/github-app
for n in webhook-secret client-secret state-signing-key runner-token database-url api-database-url; do
  read -rsp "$n: " v; echo
  aws ssm put-parameter --name "$P/$n" --type SecureString --value "$v" --overwrite >/dev/null && echo "$P/$n stored"
done
unset v
```

| Parameter | Value |
|---|---|
| `/fenvix/prod/github-app/webhook-secret` | `WEBHOOK_SECRET` (step 1, the same value as on the App's page) |
| `/fenvix/prod/github-app/client-secret` | `CLIENT_SECRET` (step 5) |
| `/fenvix/prod/github-app/state-signing-key` | `STATE_SIGNING_KEY` (step 1) |
| `/fenvix/prod/github-app/runner-token` | `RUNNER_TOKEN` (step 1): the key that signs each machine's own summary credential. Read by the http function (to check), the worker (per-job) and the demo function (to sign). No machine reads it. |
| `/fenvix/prod/github-app/database-url` | the connection string from step 8 |
| `/fenvix/prod/github-app/api-database-url` | the connection string from step 8b (`fenvix_api`, port 6543). Read by the api function only. |

**Step 13.** Store the private key from its file, then delete the file:

```
aws ssm put-parameter --name /fenvix/prod/github-app/private-key --type SecureString --value file://$HOME/Downloads/<app>.<date>.private-key.pem --overwrite
rm $HOME/Downloads/<app>.<date>.private-key.pem
```

**Step 14.** (Per-job mode only; **skip it in demo mode**, which has no shared cache.) Create the cache signing key:

```
cd infra/github-app && bash scripts/cache-key.sh
```

It creates an RSA key pair on your laptop, stores the private half as `/fenvix/prod/cache/signing-key` in SSM (only
the worker reads it, to sign one cache token per job), shreds the local copy and never prints it. It prints one
line, `"cacheSigningPublicKey": "<base64>",`: the public half, not secret, and the only key the cache machine holds
(it can check tokens, never make one).

### E. Deploy

**Step 15.** Fill in the non-secret settings in `infra/github-app/cdk.json` (section `context`) and commit them:

| Setting | Value |
|---|---|
| `githubAppId`, `githubAppSlug`, `githubClientId` | step 4 |
| `dashboardUrl` | the dashboard's address (step 3's Homepage URL) |
| `supabaseUrl` | `https://<project-ref>.supabase.co` |
| `demoRepository` | the test repository of step 2, e.g. `Mircoguidetti/fenvix-demo`. **Required in demo mode**: the demo function registers a runner on this repository and refuses any other, so our runner can never be put on a customer's repository (it would receive that repository's jobs, their `GITHUB_TOKEN` and secrets) |
| `alarmEmail` | optional: an email for the dead-letter alarm (confirm the subscription email AWS sends) |
| `apiCorsOrigins` | optional: more browser origins the dashboard API accepts besides `dashboardUrl`'s (comma separated `https://` origins, e.g. a preview of the dashboard). Every other origin gets no CORS header, and its preflight a 403 |
| `fenvixRegion` | `us` (default) or `eu`: the region (an organization's setting) this stack's runner machines serve |
| `secondFenvixRegion`, `secondAwsRegion`, `secondLaunchTemplateId` (and `secondCacheUrl`) | optional, the first three together or none: the other region's runner fleet (this stack deployed again, in another AWS region) and, per-job, its shared cache's URL. The worker gets both fleets as `RUNNER_PLACEMENT` (the second cache URL as that placement's `machineEnv`). Each region's machines are reaped by the reaper of the stack deployed in that region (a reaper cleans its own AWS region only). The worker's IAM permissions to start machines cover this stack's region only; a fleet in a second AWS region needs that region's statements added before it can be used |

The other settings keep their defaults:

- `runnerMode` `demo`, `runnerInstanceType` `c6i.large`, `runnerVolumeGb` `30`. Not a T3 by default: a T3 gets no
  launch credits, so a fresh one in "standard" mode would run at its 20% CPU baseline for its whole short life (a T3
  type is allowed and then runs "unlimited", which costs more than a c6i.large at full speed);
- `demoMaxHours` `12`: the reaper terminates a demo machine somebody forgot to take down;
- `engineCliCommit` `a20b93d` (`claude/shared-cache`);
- `domainName` `github.fenvix.dev`, `logRetentionDays` `14`, `summaryWaitSeconds` `600`.

Per-job mode (section H) adds `cacheSigningPublicKey` (step 14).

**Step 16.** Run the deploy command, which is the only one:

```
cd infra/github-app && npm run deploy
```

It checks your account and the parameters (names only), installs and tests everything, shows the change, asks `y/N`,
and deploys. If CloudFormation reports that the policy `fenvix-prod-github-app-boundary` does not exist, step 9's
first command was skipped. The first deploy stops at the certificate. That is when it
prints **Cloudflare record 1 of 2**.

**Step 17.** In Cloudflare (zone `fenvix.dev` → DNS → Add record), add record 1 exactly as printed: Type `CNAME`,
Name `_<hash>.github`, Target `_<hash>.<...>.acm-validations.aws`, Proxy status **DNS only**. Keep it after the
certificate is issued, because ACM renews through it. The deploy continues within minutes, and at the end prints
**Cloudflare record 2 of 2**. You can print both again at any time with `bash scripts/dns-records.sh`.

**Step 18.** In Cloudflare, add record 2: Type `CNAME`, Name `github`, Target
`d-xxxxxxxxxx.execute-api.eu-west-1.amazonaws.com` (the `DnsTarget` output), Proxy status **DNS only**.

**Step 19.** Check the host: `curl -s https://github.fenvix.dev/healthz` must answer `{"ok":true}`. Then the
dashboard API: `curl -s https://github.fenvix.dev/v1/me` must answer **401** `{"error":{"code":"unauthenticated",...}}`,
and a preflight from the dashboard's origin must answer **204** with `access-control-allow-origin`:

```
curl -si -X OPTIONS https://github.fenvix.dev/v1/me -H "Origin: <dashboardUrl>" -H "Access-Control-Request-Method: GET" | head -5
```

Set the dashboard's `VITE_API_URL` to `https://github.fenvix.dev` (the `DashboardApiUrl` output).

**Step 20.** GitHub → the App's settings → **Advanced → Recent Deliveries**. Open the failed `ping` and click
**Redeliver**. The response must be `200 {"ok":true,"pong":true}`.

### F. The runner image

**Step 21.** Build the runner image:

```
bash scripts/build-image.sh
```

It starts the Image Builder pipeline and prints the status every minute. It takes **30 to 45 minutes**, because the
engine is built from source, and ends with `runner image ready: ami-...`. Demo and job machines always start from the newest
image, so no deploy is needed after a build. Run it again after changing `engineCliCommit` or
`lib/runner/files/`. After a few builds, delete the old images (EC2 → AMIs → Deregister, then their snapshots); each
one is billed as snapshot storage.

### G. A demo: one fresh machine, then gone

**Step 22.** Install the App on the test repository: open `https://github.com/apps/<slug>/installations/new`, choose
**Only select repositories** → `fenvix-demo` → **Install**. GitHub then sends you to
`https://github.fenvix.dev/github/setup`, which sends you on to the dashboard with `github=error&reason=expired`. That
is expected: the installation did not start from the dashboard, so it carries no signed organization.

**Step 23.** (So that the runs show in the dashboard.) Link the installation to your organization in the Supabase SQL
editor:

```sql
select installation_id, account_login from gh_installations where workspace_id is null;   -- the installation id
select w.id as workspace_id, m.user_id, m.role from workspaces w join workspace_members m on m.workspace_id = w.id
  join auth.users u on u.id = m.user_id where u.email = '<your email>';                    -- your organization, you (owner)
select public.gh_link_installation(<installation_id>, '<workspace_id>', '<user_id>');
```

**Step 24.** See the onboarding PR: test repository → **Pull requests** → **"Run the tests on fenvix (runs-on:
fenvix)"**, from branch `fenvix/runs-on`. Its diff is one line. If it is missing, read the worker's log:
`aws logs tail /aws/lambda/fenvix-prod-github-app-worker --since 30m`.

**Step 25.** Before the demo, start the demo machine:

```
cd infra/github-app && bash scripts/demo-up.sh
```

It reuses the runner image (or builds it once, 30 to 45 minutes). It asks the demo function to register a runner on
`demoRepository` through the App and to start **one new c6i.large** from the image, with its own summary credential
(this runner name, this repository), then waits until GitHub shows the
runner online, usually 1 to 2 minutes. The runner is `fenvix-demo-<date><time>` (repository → **Settings → Actions →
Runners**, labels `self-hosted`, `Linux`, `X64`, `fenvix`).

**Step 26.** Merge the onboarding PR. The `test` job runs on the demo machine: its "Set up job" step says
`Runner name: 'fenvix-demo-...'`. This workflow still runs plain `pytest`, so no `summary.json` is written. The
**fenvix** check run is completed by the sweep about 10 minutes later, with "No fenvix summary".

**Step 27.** Open a pull request that runs the tests through the engine. On a branch, replace the last two steps of
the `test` job with:

```yaml
      - name: Project environment with the fenvix engine
        run: |
          set -eu
          uv venv -q --python 3.13 "$RUNNER_TEMP/venv"
          py="$RUNNER_TEMP/venv/bin/python"
          uv pip install -q --python "$py" -e . pytest "$(ls "$FENVIX_WHEEL_DIR"/detpy-*.whl | head -1)"
          echo "FENVIX_PY=$py" >> "$GITHUB_ENV"
      - name: Tests in the fenvix engine
        run: >
          "$FENVIX_PY" "$FENVIX_HOME/bin/fenvix-run" --project . --python "$FENVIX_PY" --key "$GITHUB_REPOSITORY"
          ${FENVIX_CACHE_URL:+--cache "$FENVIX_CACHE_URL"} --out "$RUNNER_TEMP/fenvix"
```

Remove the `actions/setup-python` step: the machine's `uv` provides Python 3.13. The machine sets `FENVIX_WHEEL_DIR`
and `FENVIX_HOME`. In demo mode `FENVIX_CACHE_URL` is unset, so the cache is the machine's own disk. When the job
ends:

- PR → **Checks** → **fenvix** is completed, with tests run, reused with proof and failures;
- PR → **Conversation** has one comment by `<slug>[bot]`.

**Step 28.** Push a second commit that changes one test file. The same demo machine runs it with its local cache, and
the comment updates in place: most tests are now **reused with proof**.

**Step 29.** After the demo, take the machine down:

```
bash scripts/demo-down.sh
```

It terminates the machine (its disk is deleted with it), waits until it is gone, then deregisters the runner from the
repository. In that order because GitHub refuses to delete a runner while it runs a job, and a registered runner whose
machine is gone stays listed (offline) for days. If GitHub still marks it busy after a minute, demo-down says so and
the reaper deregisters it within the hour. **Every demo gets a new machine and a new disk**, so no data from one
demo, whether code, cache or logs, is on the next one. The App, the queue and the dashboard stay up. If you forget
demo-down, the reaper terminates the machine after 12 hours and then deregisters its runner.

### H. Option: one machine per job (`runnerMode` = `per-job`)

Each queued fenvix job gets its own EC2 machine, which takes just that job and is then terminated. The shared cache
lets proof cross machines. Set `runnerMode` to `per-job`, run step 14 (cache signing key), put its line in
`cdk.json`, deploy, and build the image (step 21). Then:

What separates customers in this mode: every job is its own VM; the machine's role may do nothing; its summary
credential is good for its own job only; its cache token is good for its own customer's cache organization only
(`gh-<installation id>`), read-only for pull requests, forks and branches other than the default. What they still
share: the cache machine (one process, one SQLite file, separated by organization in every query) and the VPC (no
inbound rule on any runner machine). Run it for your own repositories and design partners; customer mode (below) is
the plan for customers at large.

**Step H1.** Install the App on the test repository: open `https://github.com/apps/<slug>/installations/new`, choose
**Only select repositories** → `fenvix-demo` → **Install**. GitHub then sends you to
`https://github.fenvix.dev/github/setup`, which sends you on to the dashboard with `github=error&reason=expired`. That
is expected: the installation did not start from the dashboard, so it carries no signed organization.

**Step H2.** Link the installation to your organization. This is **required for job machines**: an installation
without an organization never starts one. In the Supabase SQL editor, run:

```sql
select installation_id, account_login from gh_installations where workspace_id is null;   -- the installation id
select w.id as workspace_id, m.user_id, m.role from workspaces w join workspace_members m on m.workspace_id = w.id
  join auth.users u on u.id = m.user_id where u.email = '<your email>';                    -- your organization, you (owner)
select public.gh_link_installation(<installation_id>, '<workspace_id>', '<user_id>');
```

**Step H3.** See the onboarding PR: test repository → **Pull requests** → **"Run the tests on fenvix (runs-on:
fenvix)"**, from branch `fenvix/runs-on`. Its diff is one line. If it is missing, read the worker's log:
`aws logs tail /aws/lambda/fenvix-prod-github-app-worker --since 30m`.

**Step H4.** Merge it. The `test` job is queued with the label `fenvix`, and within seconds the worker logs
`runner machine requested`. EC2 → Instances shows `fenvix-j<job id>`. About one minute later, the job's "Set up job"
step says `Runner name: 'fenvix-j<job id>'`. When the job ends, the machine shuts down and disappears (state
**terminated**).

This workflow still runs plain `pytest`, so no `summary.json` is written. The **fenvix** check run is completed by
the sweep about 10 minutes later, with "No fenvix summary".

**Step H5.** Open a pull request that runs the tests through the engine and the shared cache. On a branch, replace
the last two steps of the `test` job with:

```yaml
      - name: Project environment with the fenvix engine
        run: |
          set -eu
          uv venv -q --python 3.13 "$RUNNER_TEMP/venv"
          py="$RUNNER_TEMP/venv/bin/python"
          uv pip install -q --python "$py" -e . pytest "$(ls "$FENVIX_WHEEL_DIR"/detpy-*.whl | head -1)"
          echo "FENVIX_PY=$py" >> "$GITHUB_ENV"
      - name: Tests in the fenvix engine
        run: >
          "$FENVIX_PY" "$FENVIX_HOME/bin/fenvix-run" --project . --python "$FENVIX_PY" --key "$GITHUB_REPOSITORY"
          ${FENVIX_CACHE_URL:+--cache "$FENVIX_CACHE_URL"} --out "$RUNNER_TEMP/fenvix"
```

Remove the `actions/setup-python` step: the machine's `uv` provides Python 3.13. The machine sets `FENVIX_WHEEL_DIR`,
`FENVIX_HOME`, `FENVIX_CACHE_URL` (ending in this installation's organization, `gh-<installation id>`) and the cache
token file.

A job machine runs the PR's job, with a **read-only** cache token for this installation. The cache is empty, so every test runs. When the
job ends:

- PR → **Checks** → **fenvix** is completed;
- PR → **Conversation** has one comment by `<slug>[bot]`.

**Step H6.** Merge that pull request. The job on `main` (a trusted ref) gets a **write** token for this installation
and records every test into the shared cache.

**Step H7.** Open another pull request that changes one test file. A **new** machine runs it, pulls from the shared
cache, and the comment shows most tests as **reused with proof**. This shows that proof crosses machines. The
dashboard (after step H2) shows the project, the runs and the usage month.

## When something fails

| What you see | Where to look | What to do |
|---|---|---|
| the deploy stops with `AccessDenied ... cdk-hnb659fds-...` | the deploy's output | step 10 was not run (bootstrap), or the deploy identity lacks `deploy-policy.json` |
| the deploy stops with `... is not authorized to perform: <action>` | the stack's Events in the console | add that action to the matching `cfn-exec-policy-*.json`, update the policy (`aws iam create-policy-version --set-as-default`), deploy again |
| the deploy waits on `Certificate` for over 30 minutes | `bash scripts/dns-records.sh` | record 1 is missing, mistyped, or proxied (orange cloud) in Cloudflare |
| a GitHub delivery shows **503** `queue_unavailable` | `aws logs tail /aws/lambda/fenvix-prod-github-app-http` | SQS refused the message; redeliver it from the App's Recent Deliveries |
| the dashboard says "could not reach the server"; the browser console shows a CORS error | `aws logs tail /aws/lambda/fenvix-prod-github-app-api` | the dashboard's origin is not `dashboardUrl`'s nor in `apiCorsOrigins`: set it, deploy |
| every dashboard call answers **401** | the API log | the API checks tokens against `supabaseUrl`'s published keys (`/auth/v1/.well-known/jwks.json`) and issuer: `supabaseUrl` must be the dashboard's Supabase project |
| every dashboard call answers **500** / **503** | the API log (`password authentication failed`, `timeout`) | `/fenvix/prod/github-app/api-database-url`: the `fenvix_api` password (step 8b), the user `fenvix_api.<project-ref>`, port 6543; wait 5 minutes after changing it |
| a delivery shows **401** | the App's webhook secret vs `/fenvix/prod/github-app/webhook-secret` | make them equal (`aws ssm put-parameter --overwrite`), wait 5 minutes (every function reloads its secrets every 5 minutes; no deploy needed), then redeliver |
| demo-up says `the App is not installed on ...` | demo log (`aws logs tail /aws/lambda/fenvix-prod-github-app-demo`) | step 22 on that repository |
| demo-up says `... is not the demo repository` | `demoRepository` in `cdk.json` | the demo function works only on that repository; change the setting and deploy if you mean another repository of your own |
| demo-up says `Resource not accessible by integration` | demo log | the App lacks **Administration: Read and write** (step 3), or the installation has not approved it yet |
| demo-up waits, the runner never comes online | EC2 → the instance → Actions → Monitor → Get system log | the machine could not register (the token is valid one hour): `demo-down`, then `demo-up` again |
| a fenvix job stays **Queued** during a demo | repository → Settings → Actions → Runners | the demo runner is offline or busy; jobs wait, they are neither failed nor billed |
| per-job: a job stays **Queued**, the worker logs `the installation is not linked` / `no runner image yet` / `limit 4` | worker log | step H2 / step 21 / 4 machines busy (retried every 12 minutes for about an hour) |
| no PR comment; the check says "No fenvix summary" | the job's log, line `fenvix: ...`; on the machine, `journalctl -u fenvix-summary-poster` (EC2 → Get system log) | the job did not call `fenvix-run`, so there is no `$RUNNER_TEMP/fenvix/summary.json` (step 26); or the summary was refused: 401 (the credential's key is not `runner-token` or `runner-token-previous` any more, or it expired), 403 (the body named another runner, repository or run) |
| nothing is reused on a second machine | the job's log, line `shared cache ...` | `cacheSigningPublicKey` in `cdk.json` does not match `/fenvix/prod/cache/signing-key` (run step 14 again, update `cdk.json`, deploy: the cache machine is replaced and starts empty), or the run was untrusted (read-only) and nothing was recorded yet, or it is another installation (each has its own cache) |
| the dead-letter alarm fires | `aws logs tail /aws/lambda/fenvix-prod-github-app-worker --since 1h` | fix the cause, then SQS console → `fenvix-prod-github-app-dead-letters` → **Start DLQ redrive** |

### Rotating a secret

Every function reloads its secrets from SSM every **5 minutes** (`SECRETS_TTL_SECONDS`), so a rotation needs no
deploy.

- **runner-token** (the key of the machines' summary credentials): copy the current value to
  `/fenvix/prod/github-app/runner-token-previous`, put a new value in `runner-token`, wait 5 minutes. Machines started
  before keep working (their credentials are checked against the previous key too). After the longest machine
  lifetime (per-job 6 hours, demo 12 hours) plus a day, delete `runner-token-previous`.
- **webhook-secret**: change it in SSM and on the App's page at the same time; deliveries in the 5 minutes between
  fail with 401 and can be redelivered.
- **client-secret**, **state-signing-key**, **database-url**, **api-database-url**, **private-key**: change in SSM
  (and at GitHub or Supabase), wait 5 minutes. An install link made with the old state key fails within those minutes
  (the person asks for a new link).
- **cache signing key**: `bash scripts/cache-key.sh`, put the new line in `cdk.json`, deploy. The cache machine is
  replaced and the cache starts empty.

### To remove everything

1. Demo mode: `bash scripts/demo-down.sh` first. Per-job mode: wait until no job machine runs (EC2 → Instances,
   tag `fenvix:role`). A running machine uses the stack's subnet and security group, and the deletion fails on them.
2. Empty the overflow bucket (CloudFormation does not delete a bucket that has objects):
   `aws s3 rm --recursive "s3://$(aws cloudformation describe-stack-resources --stack-name fenvix-prod-github-app --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId | [0]" --output text)"`
   (an admin: the deploy identity has no S3 permission).
3. `cd infra/github-app && npx --no-install cdk destroy fenvix-prod-github-app`.
4. Deregister the runner images (EC2 → AMIs) and delete their snapshots. The SSM parameters, the permissions
   boundary and the Cloudflare records stay; delete them by hand.

## The dashboard API

The dashboard talks only to this API, never to the database. The contract is `openapi/fenvix-api.yaml` (operations
tagged `dashboard`); the server is `github-app/src/api/`, its Lambda entry `github-app/src/lambda/api.ts`.

| | |
|---|---|
| Routes | API Gateway sends `ANY /v1/{proxy+}` to the api function, `ANY /v1/runner/{proxy+}` and everything else (`/webhooks/github`, `/github/setup`, `/healthz`) to the http function. The more specific route wins. |
| Sign-in | `Authorization: Bearer <Supabase access token>`, checked against the project's published keys (JWKS; ES256, RS256 or EdDSA only; issuer `<supabaseUrl>/auth/v1`, audience `authenticated`). No token or a bad one: 401. |
| Organization | `X-Fenvix-Workspace: <organization id>` on every organization operation. Not a member: 404, the same as an organization that does not exist. A member calling an owner-or-admin operation (`x-fenvix-role: admin` in the contract): 403. |
| Database | role `fenvix_api` through the transaction pooler (step 8b). In every transaction the API names the user and the organization (`set_config('app.user_id', …, true)`, `set_config('app.workspace_id', …, true)`); row level security shows a row only to a member of its organization and lets only owners and admins change settings, members, invitations and project settings (a second barrier behind the API's own checks). |
| CORS | answered by the function (API Gateway has no CORS setting): only `dashboardUrl`'s origin and `apiCorsOrigins`; headers `authorization`, `content-type`, `x-fenvix-workspace`, `if-none-match`; `etag`, `content-disposition` and `retry-after` readable. |
| Live run view | `GET /v1/runs/{id}` answers an `ETag` (from the run's `updated_at` and `progress_at`, and the project as shown) with `Cache-Control: private, no-cache`; the same `If-None-Match` answers 304 with no body. |
| Setup pull request | `POST /v1/github/repositories/{id}/setup-pull-request` queues `{ kind: "onboard", repositoryId }` on the work queue; the worker opens the pull request. |

Tests: `cd github-app && npm test` runs the API's unit tests and, with the local Supabase running
(`bash scripts/local-supabase/up.sh`, Docker), its integration tests (real Supabase Auth tokens; every dashboard
operation; every 2xx answer validated against the contract). `TEST_DATABASE_URL=... npm run test:rls` (repository
root) runs the row level security tests (`supabase/tests/`).

## Per-job mode: why the shared cache is a small machine, not Lambda + S3

(Demo mode has no shared cache: each demo machine keeps its cache on its own disk, deleted with it.)

The cache service is the engine's own (`detpy.cache_service`, `docs/SHARED-CACHE.md` in fenvix-engine-cli). It is
deployed here unchanged, byte for byte, at the pinned commit, behind a small wrapper of ours
(`lib/cache/fenvix_cache_auth.py`) that replaces its token file with per-job signed tokens. Two of its properties rule out Lambda as it is written:

- It stores everything in **SQLite in WAL mode**. WAL does not work on a network file system (EFS), and Lambda has no
  other durable disk.
- Its client uploads batches of up to **16 MB** per request. API Gateway accepts 10 MB, and a synchronous Lambda call
  6 MB.

Lambda + S3 would mean rewriting the service's storage (for example S3 for documents and DynamoDB for the key log)
and its batching, in the engine repository. That is possible later.

Until then, the cheapest place where the service runs unchanged is one **t4g.nano** with an 8 GB disk:
**$3.36 + $0.70 a month**. It has no public address (no IPv4 charge) and no outbound route. Runners reach it inside
the VPC over HTTP; the client allows plain HTTP there through `FENVIX_CACHE_ALLOW_HTTP=1`. If the machine is
replaced, the cache starts empty, and the next runs record it again.

**One cache organization per customer installation.** The service scopes every entry, file fact and run to the
organization of the token. The worker signs one token per job (RSA, the key in SSM that only it reads) naming
`gh-<installation id>`, read or write, and an expiry; the cache machine checks it with the public key (setting
`cacheSigningPublicKey`). A job of one customer therefore never reads or writes another customer's cache, and a pull
request never writes. Nothing role-wide is on a job machine to steal.

## Time from a queued job to the first test (ESTIMATE, not measured)

No AWS account was available, so none of this was measured.

These estimates assume the machine runs at full speed, which is why the default is a c6i.large and not a T3 (a fresh
T3 in "standard" mode has no credits and runs at 20% of a vCPU).

**Demo mode.** The machine is started before the demo, and `demo-up` returns once the runner is online. A job then
starts within a few seconds of being queued, as on any self-hosted runner. The first test runs after the job's own
setup (checkout, `uv venv`, install: 10 to 60 s depending on the project). Starting the demo machine takes about 1 to
2 minutes, before the demo.

**Per-job mode** (a machine is started per job):

| Stage | Estimate |
|---|---|
| GitHub queues the job → webhook at API Gateway | about 1 s |
| HTTP Lambda → SQS → worker Lambda (warm; cold start adds 1–2 s) | under 1 s |
| worker: workflow run, `generate-jitconfig`, newest image, RunInstances | 1–2 s |
| EC2 pending → running | 10–20 s |
| Ubuntu boot → user data → runner connected and assigned the job | 30–50 s |
| **job starts (Set up job)** | **≈ 45–75 s after queued** |
| checkout, `uv venv`, project and engine install | 10–60 s, depending on the project; the first reads of the disk are slower, because a volume made from an image loads its blocks on first access |
| **first test runs** | **≈ 1–2.5 minutes after queued** |

A GitHub-hosted runner usually starts a job within seconds. The time lost here is the price of starting nothing when
no job runs. To cut it later: keep one warm, stopped machine to start, or turn on EBS fast snapshot restore (billed
per hour).

## Monthly cost

All prices are for eu-west-1, on demand, in USD, read on **2026-11-18**. Each price is marked **DECLARED**: it is
AWS's published price, read today, and not a measured bill.

The regional numbers come from AWS's official **Price List API**
(`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/current/eu-west-1/index.json`, with SKU and
publication date). The aws.amazon.com pricing pages load those same numbers in the browser from a data host that this
container's network refused, so the pages could not be read for them. The aws.amazon.com pages were read for the free
tiers, the metering units, the billing granularity and the flat prices.

| Item | Price (DECLARED) | Source (read 2026-11-18) |
|---|---|---|
| EC2 c6i.large, Linux (runner machines and the image build, default) | $0.0912 per hour; **billed per second, 60-second minimum** | Price List API AmazonEC2, SKU MY34M56N9KVPBWDG (as read by review R-012 on 2026-11-18; not re-read in this session, see below); aws.amazon.com/ec2/pricing/on-demand ("by the hour or second (minimum of 60 seconds)") |
| EC2 t3.medium, Linux (only if chosen; runs "unlimited") | $0.0456 per hour, plus $0.05 per vCPU-hour of surplus credits above the 20% baseline: ≈ $0.1256 per hour at full speed | Price List API AmazonEC2, SKU 47NTBKB4KMUU98P8; surplus credits SKU Z25C5STUBANBQC5Y (R-012) |
| EC2 t4g.nano, Linux | $0.0046 per hour | Price List API AmazonEC2, SKU 2WUM3HJN9JGXQ3A8 |
| EBS gp3 | $0.088 per GB-month; billed per second, 60-second minimum; 3,000 IOPS and 125 MB/s included | Price List API AmazonEC2, SKU TXACT7E3PV6ZX2NM; aws.amazon.com/ebs/pricing |
| EBS snapshot, Standard tier (the runner images) | $0.05 per GB-month of data stored (incremental) | Price List API AmazonEC2, SKU UZ7N3QU3DRSU25FK; aws.amazon.com/ebs/pricing |
| Public IPv4 address | $0.005 per hour | aws.amazon.com/vpc/pricing (and Price List API AmazonVPC) |
| EC2 Image Builder | no cost besides the resources it uses | aws.amazon.com/image-builder (its pricing page answered 404) |
| EC2 c7i.xlarge, Linux (customer-mode host) | $0.19152 per hour | Price List API AmazonEC2, SKU UGSWTF5QKT6FFUDJ |
| EC2 c7i.2xlarge, Linux (customer-mode host for 3 full-speed jobs) | $0.38304 per hour | Price List API AmazonEC2, SKU QC3ZMNBVRWVYJ3M2 |
| Nested virtualization on C7i (the KVM fallback) | no additional cost | docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html (re-read 2026-11-18: "There is no additional cost for using nested virtualization"; C7i listed) |
| EC2 c5n.metal, Linux (the cheapest x86 bare metal in eu-west-1, of 72; no longer the fallback) | $4.392 per hour | Price List API AmazonEC2, SKU 5WTB2K6WFG5VB34R |
| Nitro Enclaves / Nitro Sandboxes | no additional charge ("you pay the standard charges for the Amazon EC2 instance") | docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nitro-sandboxes.html; aws.amazon.com/ec2/nitro/nitro-enclaves/faqs |
| Lambda (x86) | $0.0000166667 per GB-second, $0.20 per 1M requests; free tier 400,000 GB-s and 1M requests per month | Price List API AWSLambda; aws.amazon.com/lambda/pricing |
| SQS standard | $0.40 per 1M requests (64 KB = 1 request); 1M per month free | Price List API AWSQueueService; aws.amazon.com/sqs/pricing |
| API Gateway HTTP API | $1.11 per 1M requests; 1M per month free for 12 months for accounts created before 2025-07-15 (newer accounts get Free Tier credits instead; not material at this volume) | Price List API AmazonApiGateway; aws.amazon.com/api-gateway/pricing |
| EventBridge Scheduler | 14M invocations per month free, then $1.00 per 1M | aws.amazon.com/eventbridge/pricing |
| SSM Parameter Store, standard | no additional charge | aws.amazon.com/systems-manager/pricing |
| CloudWatch Logs | $0.57 per GB ingested, $0.03 per GB-month; 5 GB per month free | Price List API AmazonCloudWatch; aws.amazon.com/cloudwatch/pricing |
| CloudWatch alarm | $0.10 per alarm-month; first 10 free | Price List API AmazonCloudWatch |
| ACM certificate for API Gateway | no cost | aws.amazon.com/certificate-manager/pricing |
| Data transfer out | 100 GB per month free | aws.amazon.com/ec2/pricing/on-demand |

### Default: demo mode

**Assumptions** (ESTIMATE, not measured): the runner image holds about 6 GB of data; 10 demos a month, each machine
up for 2 hours; the serverless part runs as in per-job mode at 0 jobs.

| | Monthly |
|---|---|
| Runner image snapshot (~6 GB × $0.05) | $0.30 |
| Demo machines: 20 hours × ($0.0912 c6i.large + $0.005 IPv4 + 30 GB gp3 at $0.088 ÷ 730 h) = 20 × $0.0998 | $2.00 |
| Lambda, SQS, logs, alarm (without free tier; free at this volume with it) | $0.43 |
| API Gateway, Scheduler, SSM, ACM, S3 | $0.00 |
| **Total without free tiers** | **≈ $2.73** |
| **Total with free tiers** | **≈ $2.30** |

Each extra demo hour costs about $0.10. Image builds add about $0.08 each (45 minutes of c6i.large, its IPv4 address
and disk). Between demos nothing runs, so the cost
is the image snapshot and the serverless part.

### Option: one machine per job

**Assumptions** (ESTIMATE, not measured):

- A job machine lives about **10 minutes** in all: about 1.5 minutes to boot, the job itself, and power-off.
- A runner image holds about **6 GB** of data (Ubuntu, build tools, Rust, Python, the engine build, the GitHub
  runner).
- Each job brings about 10 webhooks and runner requests.
- The sweep runs every minute (43,800 times a month) and the reaper every 10 minutes (4,380).
- The idle SQS trigger polls about 660,000 times a month.

**Per job:**

| Item | Calculation | Cost |
|---|---|---|
| c6i.large | $0.0912 × 1/6 h | $0.01520 |
| public IPv4 | $0.005 × 1/6 h | $0.00083 |
| 30 GB gp3 disk | 30 × $0.088 ÷ 730 h × 1/6 h | $0.00060 |
| **Total** | | **≈ $0.0166** |

**Monthly:**

| | 0 jobs | 100 jobs | 1,000 jobs |
|---|---|---|---|
| Cache machine t4g.nano (730 h) | $3.36 | $3.36 | $3.36 |
| Cache disk 8 GB gp3 | $0.70 | $0.70 | $0.70 |
| Runner image snapshot (~6 GB) | $0.30 | $0.30 | $0.30 |
| Job machines (≈ $0.0166 each) | $0.00 | $1.66 | $16.64 |
| Lambda (without free tier) | $0.06 | $0.07 | $0.25 |
| SQS (without free tier) | $0.26 | $0.26 | $0.28 |
| API Gateway (without free tier) | $0.00 | $0.00 | $0.01 |
| CloudWatch Logs and alarm (without free tier) | $0.11 | $0.11 | $0.12 |
| Scheduler, SSM, ACM, S3, data transfer | $0.00 | $0.00 | $0.00 |
| **Total without free tiers** | **≈ $4.79** | **≈ $6.46** | **≈ $21.66** |
| **Total with free tiers** (Lambda, SQS, logs, alarm free at this volume) | **≈ $4.36** | **≈ $6.02** | **≈ $21.01** |

Image builds add about $0.08 each: 45 minutes of c6i.large, its IPv4 address and disk.

A job that runs longer costs proportionally more. Each extra 10 minutes of job time adds $0.0166. At 1,000 jobs of
20 minutes, the job machines cost about $33.

## Customer mode (design; spike in `infra/customer-mode/spike/`; not built)

**The plan.** Customer jobs run on **c7i** hosts, each job in its own **Firecracker microVM**, using Firecracker's
**Nitro Sandboxes** backend (v1.18.0, released with `PUT /enclave`). The microVM is destroyed after the job. More hosts
are added as customers grow. There is no Docker-per-job path.

**Why a c7i and not a T3 or a metal host.** Nitro Sandboxes run on the instance types that support Nitro Enclaves:
"not currently available on bare metal instances, burstable instance types (e.g. T3), and instances with only 1 CPU
core" (Nitro Enclaves FAQ, read 2026-11-18). C7i is supported except c7i.large and the metal sizes (EC2 User Guide,
Nitro Sandboxes). A sandbox needs no `/dev/kvm`: Firecracker drives `/dev/nitro_enclaves`.

**The real trust boundary is the parent, not only the Nitro Hypervisor.** The Nitro Hypervisor isolates a sandbox's
memory and vCPUs. In direct mode, though, "the trust model is equivalent to that of a nested virtual machine" (AWS):
what a hostile guest attacks is Firecracker's device emulation in the parent, the parent's TAP networking and
anything of the guest's the parent reads. One escape there must not reach other tenants or our credentials. So
(R-012 F17):

- **Firecracker runs under the jailer**, one per sandbox: its own uid, a chroot holding only that job's files, its own
  cgroup, Firecracker's seccomp filter. Never as root.
- **No credential of ours on the path a guest can reach.** The host agent that polls the queue holds only its queue
  role; each job's summary credential (signed by the worker for that job's runner name, repository and run, as in
  per-job mode) is handed over with the job. It is read by `fenvix-post`, a separate user that never reads guest
  bytes. The parent's metadata service has hop limit 1 and is unreachable from any TAP.
- **The host never mounts a disk a guest wrote** (F9). The guest writes its result to a raw 16 MiB disk as one
  length-prefixed record; an unprivileged user (`fenvix-parse`) reads it in userspace with a size cap
  (`read-result.py`). The repository, run, attempt and runner name of the summary come from the host's own job record,
  never from the guest. (vsock is the alternative; the raw disk needs no listener on the host.)
- **The firewall is keyed on the interface** (F10): every rule matches `-i fctap+`; `FORWARD` defaults to DROP; each
  TAP accepts only its own sandbox's source address, and `rp_filter` is strict; only the VPC's DNS
  (`169.254.169.253:53`) is reachable in `169.254.0.0/16`; a sandbox reaches no port of the parent and no other
  sandbox; IPv6 is off on every TAP and dropped by `ip6tables`. Each sandbox has a connection limit (4,096 tracked
  connections), a new-connection rate limit and Firecracker's own bandwidth and packet-rate limiters, so one sandbox
  cannot exhaust the connection-tracking table the others share.
- **The memory pool is mandatory** (F11): "With a memory pool, the parent instance has 4 slots. Without a pool, it has
  0" (EC2 User Guide, "Run Nitro Sandboxes with Firecracker", re-read 2026-11-18). `host-setup.sh` stops unless
  `nitro_enclaves.mempool=` is on the kernel command line (`grubby` and a reboot first) and then sets 12 slots
  (slots grow from 4 in steps of 8; each step uses 128 MiB of the pool).
- Direct mode leaves sandbox memory readable by the parent (us). Confidential mode, with a DMB-patched guest kernel,
  closes that if customers ask for it.

### How a job runs

```
GitHub ── workflow_job.queued ──▶ App (worker Lambda): linked installation? → generate-jitconfig (one job)
                                    → the job's summary credential and cache token (signed per job)
                                    └▶ SQS "jobs" queue (per host group)            [to build: SqsHostLauncher]
c7i host agent (polls the queue; holds no fleet secret):
   1. under /srv/jailer/firecracker/<id>/root, owned by the jail's uid: a copy of the guest disk (reflink), a
      read-only input disk with the jitconfig, an empty raw result disk
   2. TAP device fctap<N> owned by the jail's uid, IPv6 off, its source-address rule
   3. jailer → firecracker --config-file (2 vCPUs, 2 GiB, direct mode, rate limiters)
   4. guest: systemd → fenvix-guest-job → just-in-time runner takes exactly one job → result record onto the raw disk
      → poweroff → the sandbox is torn down (vCPUs and memory back to the pools)
   5. host: fenvix-parse reads the record; fenvix-post sends the summary with the job's credential and the host's ids;
      everything of the job is deleted (also on failure: trap)
```

- **Shared cache.** The same private cache machine as per-job mode, one organization per customer installation,
  per-job tokens; write only for trusted refs.
- **Capacity** (F16; ESTIMATE until measured). A c7i.xlarge has 4 vCPUs on **2 physical cores**. "The Nitro Enclaves
  driver keeps the first core of the parent instance for the parent, and the other cores form the CPU pool" (EC2
  User Guide). Without CPU overcommit, a c7i.xlarge therefore runs **one** 2-vCPU sandbox at full speed. With CPU
  overcommit (the spike's setting), three 2-vCPU, 2 GiB jobs fit by memory but time-share 2 cores with the parent,
  roughly 0.6 core each. For **3 jobs at full speed, plan a c7i.2xlarge** (8 vCPUs, 4 cores: 3 for the pool) at
  $0.38304 per hour, or a Graviton host (one thread per core) if jobs can be arm64. Measure it (test 6 below).
- **Hosts:** one to start; add a host when the queue waits. Scale-out by queue depth is a later step.

### Docker inside the job (`services:`, testcontainers, docker compose)

**Inside a Nitro Sandbox microVM:** expected to work, not yet run.

- Docker needs no hardware virtualization, only Linux kernel features in the guest, and the guest is a normal Linux
  VM.
- The spike's check (`guest-kernel-docker-check.sh`) on Firecracker's CI x86_64 6.18 guest kernel config plus its EFI
  fragment finds **every required option present**: namespaces, cgroups (memory, pids, cpu, devices, freezer, bpf),
  seccomp, keys, overlayfs, ext4, veth, bridge, bridge netfilter, iptables NAT and MASQUERADE, addrtype and conntrack
  matches. Only the optional IP_VS, MACVLAN and IPVLAN are absent; swarm and those network drivers are not needed for
  CI.
- The guest image installs `docker.io`, and the job user is in the `docker` group, inside its own VM.
- Each job starts with an empty image store, so every `docker pull` downloads again. A pull-through registry mirror on
  the host would help; this needs measuring.

**Inside a KVM Firecracker microVM on the fallback (nested virtualization on the same C7i):** same answer, the same
guest kernel and image. Docker runs in Firecracker KVM guests routinely.

### Must be tested on a real host before the first customer

1. **Start time per job.** Run `run-job.sh` 20 times and record each stage (preparing the disks; sandbox start →
   guest up; guest up → runner online → job assigned; the job's setup). Target: a job starts within about 30 s of
   being queued.
2. **The jailer with the Nitro Sandboxes backend.** Firecracker under the jailer with `/dev/nitro_enclaves` created
   in the chroot for the jail's uid, its seccomp filter, cgroup v2: the sandbox starts; as the jail's uid the VMM
   cannot read another sandbox's disk or any credential (F17). Not verified anywhere yet.
3. **From a guest, as root** (F10): spoof the source address (`ip addr add 10.42.0.99/32 dev eth0`,
   `curl --interface 10.42.0.99 169.254.169.254`); reach another sandbox's `172.16.N.2` with a spoofed source; reach
   the parent over IPv6 link-local (`ping6 fe80::...%eth0`, `nc -6`). All must fail. `169.254.169.254` (IMDSv1 and
   v2), `169.254.169.123` and the VPC resolver's other addresses fail; `169.254.169.253:53` answers; the cache machine
   answers only with the job's own customer's token.
4. **Conntrack exhaustion** from one guest (`hping3 --flood` to many ports): other sandboxes' jobs keep their network.
5. **The result disk** (F9): a guest writes a symlink, a corrupted record, a record of 2 GiB, another job's ids: the
   host neither follows, mounts nor accepts them, and the summary carries the host's ids.
6. **CPU** (F16): 1, 2 and 3 concurrent 2-vCPU jobs (`stress-ng --cpu 2` plus a real pytest suite), with and without
   CPU overcommit, on c7i.xlarge and c7i.2xlarge; the same on the fallback (nested virtualization).
7. **Memory pool sizing** (F11): `mempool` for 3 × (2048 + 2) MiB plus 256 MiB for 12 slots (7G); a fourth start fails
   cleanly.
8. **Host reboot mid-job:** no disk of a previous job remains under `/srv/jailer` or `/var/lib/fenvix-sandboxes`.
9. **Docker:** `docker run hello-world`; a job with `services: postgres`; testcontainers (Python and Java);
   `docker compose up`; image pull time with and without a registry mirror; overlay2 on the guest's ext4.
10. **The engine:** `strace -f` inside the guest; `fenvix-run` with the shared cache from the guest; a warm cache
    across two jobs (two microVMs).
11. **Failure handling:** a guest that hangs is killed by the host (killing Firecracker tears the sandbox down); a
    sandbox that never got its job.
12. **Limits of Nitro Sandboxes to live with:** no snapshots or pause, so no warm-start from a snapshot; no virtio
    device reset; memory is not overcommitted.

**Fallback if Nitro Sandboxes fails a must-have** (start time, Docker, isolation, the jailer): **KVM Firecracker with
nested virtualization on the same C7i type** ("There is no additional cost for using nested virtualization"; C7i is
supported; EC2 User Guide, re-read 2026-11-18). Same guest image and agent, same price per host, and KVM adds
snapshots (faster starts) and memory overcommit. Nested virtualization and Nitro Sandboxes are not on at the same time
on one instance, which suits a fallback. A bare-metal host (c5n.metal, $4.392 an hour) is no longer needed.

### Customer mode: monthly cost per host (DECLARED prices; usage ESTIMATED)

| | c7i.xlarge | c7i.2xlarge |
|---|---|---|
| instance, 730 h | $139.81 | $279.62 |
| host disk 50 GB gp3 | $4.40 | $4.40 |
| public IPv4 | $3.65 | $3.65 |
| **per host per month** | **≈ $147.86** | **≈ $287.67** |
| jobs at once (2 vCPU, 2 GiB) at full speed | 1 (3 time-sharing 2 cores) | 3 |

The same figures hold for the fallback (KVM with nested virtualization on the same type). A job costs nothing extra
on a host that is already running; the host is the cost. The serverless part and the cache machine are as in per-job
mode, about $4.80 a month.
