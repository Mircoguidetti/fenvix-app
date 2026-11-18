# Deploying the GitHub App and the runners on AWS

This page is for the founder. It puts the fenvix GitHub App on `https://github.fenvix.dev` (Lambda, SQS, API Gateway,
Supabase), always up. The runners come in three modes:

- **Demo mode (default, built):** `demo-up` starts one fresh t3.medium for a demo and registers it as a runner;
  `demo-down` deregisters it and terminates it. Each demo gets a new machine, so no data is shared between demos.
- **Per-job mode (option, built):** each queued job gets its own EC2 machine, deleted after the job, with a shared
  cache.
- **Customer mode (design and spike, not built):** one c7i.xlarge host runs each customer job in its own Firecracker
  microVM (Nitro Sandboxes) and destroys it after the job. See "Customer mode" below.

The steps are in order, with one action per step. **Nothing here has been deployed yet.** The code was synthesized
and tested without an AWS account (see `docs/REPORT-aws-deploy.md`).

Account `865859654353`, region `eu-west-1` (Ireland). Both come from `infra/github-app/cdk.json`.

## What gets created (demo mode)

```
GitHub ──HTTPS──▶ github.fenvix.dev  (API Gateway HTTP API, ACM certificate, DNS on Cloudflare)
                    └▶ Lambda "http": checks the signature or the runner token, puts the work on SQS, answers 202
                 SQS "work" queue  (failed 5 times → "dead-letters" queue + alarm; payloads over 200 KB go via S3)
                    └▶ Lambda "worker": stores the event, opens the onboarding PR, publishes the check run, the PR
                       comment, ci_runs, usage events
                 EventBridge Scheduler: "sweep" every minute (jobs whose summary never came), "reaper" every
                       10 minutes (a demo machine older than 12 hours is terminated)
                 Lambda "demo" (invoked only by scripts/demo-up.sh and demo-down.sh): holds the App key; registers a
                       runner on a repository, starts one machine; deregisters, terminates
Runner image: EC2 Image Builder (Ubuntu 24.04 + strace, build tools, uv, Python, Rust, the engine wheel built by
   runner/bootstrap.sh install, the GitHub runner, the hooks); built by hand with scripts/build-image.sh
Demo machine (t3.medium, 30 GB gp3, from the image, no inbound port): registered runner, labels self-hosted, fenvix;
   after each job ──▶ POST https://github.fenvix.dev/v1/runner/summaries; local engine cache on its own disk
Supabase (yours): the role fenvix_github_app writes gh_*, ci_projects, ci_runs, ci_usage_events
```

| Piece | Detail |
|---|---|
| Secrets | SSM Parameter Store, type SecureString, under `/fenvix/prod/github-app/` (and `/fenvix/prod/cache/` in per-job mode). You create them; the stack never sees their values. Each Lambda reads only its own, by exact name. The demo function reads only the App's private key. |
| Machines | Two users. `fenvix` runs the runner and the job. `fenvix-post` alone holds `RUNNER_TOKEN` and sends the summary. Neither user can reach the instance metadata service. `strace -f` works on a job's own children. Outbound traffic is HTTPS and HTTP only. There is no SSH. A machine can only be started from our launch template and our own images, tagged with its role, and the demo function and the reaper may terminate only machines with that tag. |
| Logs | CloudWatch log groups `/aws/lambda/fenvix-prod-github-app-{http,worker,sweep,reaper,demo}` and `/aws/apigateway/fenvix-prod-github-app-api`, kept **14 days**. |

## The steps

You need a laptop with **Node.js 22.18 or newer**, **AWS CLI v2**, `git` and `openssl`. You also need an AWS admin
login for steps 9 to 11 only.

### A. Secrets and the test repository (your laptop and GitHub)

**Step 1.** Generate four random values and store them in your password manager. Never put them in git, a chat or a
ticket.

```
openssl rand -hex 32      # WEBHOOK_SECRET
openssl rand -hex 32      # STATE_SIGNING_KEY
openssl rand -hex 32      # RUNNER_TOKEN
openssl rand -base64 36   # DB_PASSWORD (the role fenvix_github_app)
```

**Step 2.** Create a **private** test repository, for example `Mircoguidetti/fenvix-demo`. Give it a small pytest
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

**Step 7.** Run the migration once. 0011 and 0012 are already applied, since the dashboard reads their tables. Paste
the whole file `supabase/migrations/0013_github_app.sql` and click Run. It is safe to repeat. It creates the `gh_*`
tables and `ci_usage_events`, the role `fenvix_github_app` (no password, no BYPASSRLS) and its row-level security
policies.

**Step 8.** Give the role its password (`DB_PASSWORD` from step 1):

```sql
alter role fenvix_github_app with password '<DB_PASSWORD>';
```

Then build the connection string from Supabase → **Connect** → **Session pooler**, with the user
`fenvix_github_app.<project-ref>`:

```
postgresql://fenvix_github_app.<project-ref>:<DB_PASSWORD>@aws-0-<supabase-region>.pooler.supabase.com:5432/postgres
```

Use the pooler, not the direct host. The direct host `db.<ref>.supabase.co` answers on IPv6 only, and Lambda (outside
a VPC) has IPv4 only. Session mode behaves like a direct connection. Each warm Lambda keeps at most 2 connections
(`DB_POOL_MAX=2`).

### C. AWS account (an admin, once)

**Step 9.** Create the three policies that CloudFormation will use when it creates this stack. The scope of each:

- **app:** Lambda, IAM roles named `fenvix-prod-github-app-*`, SQS, S3, logs, Scheduler;
- **edge:** ACM, API Gateway, the alarm;
- **fleet:** EC2 (only the instance types allowed) and Image Builder.

Run this from `infra/github-app/`:

```
aws iam create-policy --policy-name fenvix-github-app-cfn-exec-app   --policy-document file://cfn-exec-policy-app.json
aws iam create-policy --policy-name fenvix-github-app-cfn-exec-edge  --policy-document file://cfn-exec-policy-edge.json
aws iam create-policy --policy-name fenvix-github-app-cfn-exec-fleet --policy-document file://cfn-exec-policy-fleet.json
```

**Step 10.** Bootstrap CDK in eu-west-1 with those three policies:

```
aws cloudformation describe-stacks --stack-name CDKToolkit --region eu-west-1   # "does not exist" is expected
npx cdk bootstrap aws://865859654353/eu-west-1 --cloudformation-execution-policies \
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

It cannot create IAM, Lambda or EC2 resources itself.

- **IAM Identity Center (recommended):** create a permission set `fenvix-github-app-deployer` with the content of
  `deploy-policy.json` as its inline policy. Assign it to your user on account 865859654353. Then run
  `aws configure sso --profile fenvix-deployer` on your laptop.
- **Or an IAM user:** `aws iam create-user --user-name fenvix-github-app-deployer`, then
  `aws iam put-user-policy --user-name fenvix-github-app-deployer --policy-name deploy --policy-document file://deploy-policy.json`,
  then `aws iam create-access-key --user-name fenvix-github-app-deployer` and
  `aws configure --profile fenvix-deployer`.

From here on, everything runs as this identity: `export AWS_PROFILE=fenvix-deployer AWS_REGION=eu-west-1`.

### D. The secrets in SSM (your laptop, as the deployer)

**Step 12.** Create five parameters. Type each value at the prompt, so that it stays out of your shell history:

```
P=/fenvix/prod/github-app
for n in webhook-secret client-secret state-signing-key runner-token database-url; do
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
| `/fenvix/prod/github-app/runner-token` | `RUNNER_TOKEN` (step 1); job machines read the same parameter |
| `/fenvix/prod/github-app/database-url` | the connection string from step 8 |

**Step 13.** Store the private key from its file, then delete the file:

```
aws ssm put-parameter --name /fenvix/prod/github-app/private-key --type SecureString --value file://$HOME/Downloads/<app>.<date>.private-key.pem --overwrite
rm $HOME/Downloads/<app>.<date>.private-key.pem
```

**Step 14.** (Per-job mode only; **skip it in demo mode**, which has no shared cache.) Create the shared cache's two
tokens:

```
cd infra/github-app && bash scripts/cache-tokens.sh
```

It stores `/fenvix/prod/cache/write-token` and `/fenvix/prod/cache/read-token` in SSM and never prints them. It prints
two lines, `"cacheTokenSha256Write": "<hex>",` and `"cacheTokenSha256Read": "<hex>",`. These are the tokens'
SHA-256: not secret, and the only thing the cache machine keeps.

### E. Deploy

**Step 15.** Fill in the non-secret settings in `infra/github-app/cdk.json` (section `context`) and commit them:

| Setting | Value |
|---|---|
| `githubAppId`, `githubAppSlug`, `githubClientId` | step 4 |
| `dashboardUrl` | the dashboard's address (step 3's Homepage URL) |
| `supabaseUrl` | `https://<project-ref>.supabase.co` |
| `demoRepository` | the test repository, e.g. `Mircoguidetti/fenvix-demo` (demo-up's default) |
| `alarmEmail` | optional: an email for the dead-letter alarm (confirm the subscription email AWS sends) |

The other settings keep their defaults:

- `runnerMode` `demo`, `runnerInstanceType` `t3.medium`, `runnerVolumeGb` `30`;
- `demoMaxHours` `12`: the reaper terminates a demo machine somebody forgot to take down;
- `engineCliCommit` `a20b93d` (`claude/shared-cache`);
- `domainName` `github.fenvix.dev`, `logRetentionDays` `14`, `summaryWaitSeconds` `600`.

Per-job mode (section H) adds the cache settings.

**Step 16.** Run the deploy command, which is the only one:

```
cd infra/github-app && npm run deploy
```

It checks your account and the parameters (names only), installs and tests everything, shows the change, asks `y/N`,
and deploys. The first deploy stops at the certificate. That is when it
prints **Cloudflare record 1 of 2**.

**Step 17.** In Cloudflare (zone `fenvix.dev` → DNS → Add record), add record 1 exactly as printed: Type `CNAME`,
Name `_<hash>.github`, Target `_<hash>.<...>.acm-validations.aws`, Proxy status **DNS only**. Keep it after the
certificate is issued, because ACM renews through it. The deploy continues within minutes, and at the end prints
**Cloudflare record 2 of 2**. You can print both again at any time with `bash scripts/dns-records.sh`.

**Step 18.** In Cloudflare, add record 2: Type `CNAME`, Name `github`, Target
`d-xxxxxxxxxx.execute-api.eu-west-1.amazonaws.com` (the `DnsTarget` output), Proxy status **DNS only**.

**Step 19.** Check the host: `curl -s https://github.fenvix.dev/healthz` must answer `{"ok":true}`.

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
cd infra/github-app && bash scripts/demo-up.sh Mircoguidetti/fenvix-demo
```

It reuses the runner image (or builds it once, 30 to 45 minutes). It asks the demo function to register a runner on
the repository through the App and to start **one new t3.medium** from the image, then waits until GitHub shows the
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

It deregisters the runner from the repository and terminates the machine; its disk is deleted with it. **Every demo
gets a new machine and a new disk**, so no data from one demo, whether code, cache or logs, is on the next one. The
App, the queue and the dashboard stay up. If you forget demo-down, the reaper terminates the machine after 12 hours.

### H. Option: one machine per job (`runnerMode` = `per-job`)

Each queued fenvix job gets its own EC2 machine, which takes just that job and is then terminated. The shared cache
lets proof cross machines. Set `runnerMode` to `per-job`, run step 14 (cache tokens), put the two cache lines in
`cdk.json`, deploy, and build the image (step 21). Then:

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
`FENVIX_HOME`, `FENVIX_CACHE_URL` and the cache token file.

A job machine runs the PR's job, with the **read-only** cache token. The cache is empty, so every test runs. When the
job ends:

- PR → **Checks** → **fenvix** is completed;
- PR → **Conversation** has one comment by `<slug>[bot]`.

**Step H6.** Merge that pull request. The job on `main` (a trusted ref) gets the **write** token and records every
test into the shared cache.

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
| a delivery shows **401** | the App's webhook secret vs `/fenvix/prod/github-app/webhook-secret` | make them equal, then deploy again (Lambda reads the parameter at cold start) |
| demo-up says `the App is not installed on ...` | demo log (`aws logs tail /aws/lambda/fenvix-prod-github-app-demo`) | step 22 on that repository |
| demo-up says `Resource not accessible by integration` | demo log | the App lacks **Administration: Read and write** (step 3), or the installation has not approved it yet |
| demo-up waits, the runner never comes online | EC2 → the instance → Actions → Monitor → Get system log | the machine could not register (the token is valid one hour): `demo-down`, then `demo-up` again |
| a fenvix job stays **Queued** during a demo | repository → Settings → Actions → Runners | the demo runner is offline or busy; jobs wait, they are neither failed nor billed |
| per-job: a job stays **Queued**, the worker logs `the installation is not linked` / `no runner image yet` / `limit 4` | worker log | step H2 / step 21 / 4 machines busy (retried every 12 minutes for about an hour) |
| no PR comment; the check says "No fenvix summary" | the job's log, line `fenvix: ...` | the job did not call `fenvix-run`, so there is no `$RUNNER_TEMP/fenvix/summary.json` (step 26); or the summary was refused with 401 because of a runner token mismatch |
| nothing is reused on a second machine | the job's log, line `shared cache ...` | the cache tokens in `cdk.json` do not match SSM (run step 14 again, update `cdk.json`, deploy: the cache machine is replaced), or the run was untrusted (read-only) and nothing was recorded yet |
| the dead-letter alarm fires | `aws logs tail /aws/lambda/fenvix-prod-github-app-worker --since 1h` | fix the cause, then SQS console → `fenvix-prod-github-app-dead-letters` → **Start DLQ redrive** |

To remove everything: `cd infra/github-app && npx cdk destroy fenvix-prod-github-app`, then deregister the runner
images (EC2 → AMIs) and delete their snapshots. The SSM parameters and the Cloudflare records stay; delete them by
hand.

## Per-job mode: why the shared cache is a small machine, not Lambda + S3

(Demo mode has no shared cache: each demo machine keeps its cache on its own disk, deleted with it.)

The cache service is the engine's own (`detpy.cache_service`, `docs/SHARED-CACHE.md` in fenvix-engine-cli). It is
deployed here unchanged, byte for byte, at the pinned commit. Two of its properties rule out Lambda as it is written:

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

Limit: all repositories share one cache organization (`cacheOrg`), so a write token for one customer could write
entries for another. Before a second customer, give each organization its own cache tokens.

## Time from a queued job to the first test (ESTIMATE, not measured)

No AWS account was available, so none of this was measured.

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
| EC2 t3.medium, Linux | $0.0456 per hour; **billed per second, 60-second minimum** | Price List API AmazonEC2, SKU 47NTBKB4KMUU98P8; aws.amazon.com/ec2/pricing/on-demand ("by the hour or second (minimum of 60 seconds)") |
| EC2 t4g.nano, Linux | $0.0046 per hour | Price List API AmazonEC2, SKU 2WUM3HJN9JGXQ3A8 |
| EBS gp3 | $0.088 per GB-month; billed per second, 60-second minimum; 3,000 IOPS and 125 MB/s included | Price List API AmazonEC2, SKU TXACT7E3PV6ZX2NM; aws.amazon.com/ebs/pricing |
| EBS snapshot, Standard tier (the runner images) | $0.05 per GB-month of data stored (incremental) | Price List API AmazonEC2, SKU UZ7N3QU3DRSU25FK; aws.amazon.com/ebs/pricing |
| Public IPv4 address | $0.005 per hour | aws.amazon.com/vpc/pricing (and Price List API AmazonVPC) |
| EC2 Image Builder | no cost besides the resources it uses | aws.amazon.com/image-builder (its pricing page answered 404) |
| EC2 c7i.xlarge, Linux (customer-mode host) | $0.19152 per hour | Price List API AmazonEC2, SKU UGSWTF5QKT6FFUDJ |
| EC2 c5n.metal, Linux (the cheapest x86 bare metal in eu-west-1, of 72) | $4.392 per hour | Price List API AmazonEC2, SKU 5WTB2K6WFG5VB34R |
| Nitro Enclaves / Nitro Sandboxes | no additional charge ("you pay the standard charges for the Amazon EC2 instance") | docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nitro-sandboxes.html; aws.amazon.com/ec2/nitro/nitro-enclaves/faqs |
| Lambda (x86) | $0.0000166667 per GB-second, $0.20 per 1M requests; free tier 400,000 GB-s and 1M requests per month | Price List API AWSLambda; aws.amazon.com/lambda/pricing |
| SQS standard | $0.40 per 1M requests (64 KB = 1 request); 1M per month free | Price List API AWSQueueService; aws.amazon.com/sqs/pricing |
| API Gateway HTTP API | $1.11 per 1M requests; 1M per month free for 12 months, new customers only | Price List API AmazonApiGateway; aws.amazon.com/api-gateway/pricing |
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
| Demo machines: 20 hours × ($0.0456 t3.medium + $0.005 IPv4 + 30 GB gp3 at $0.088 ÷ 730 h) = 20 × $0.0542 | $1.08 |
| Lambda, SQS, logs, alarm (without free tier; free at this volume with it) | $0.43 |
| API Gateway, Scheduler, SSM, ACM, S3 | $0.00 |
| **Total without free tiers** | **≈ $1.81** |
| **Total with free tiers** | **≈ $1.38** |

Each extra demo hour costs about $0.054. Image builds add about $0.03 each. Between demos nothing runs, so the cost
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
| t3.medium | $0.0456 × 1/6 h | $0.00760 |
| public IPv4 | $0.005 × 1/6 h | $0.00083 |
| 30 GB gp3 disk | 30 × $0.088 ÷ 730 h × 1/6 h | $0.00060 |
| **Total** | | **≈ $0.0090** |

**Monthly:**

| | 0 jobs | 100 jobs | 1,000 jobs |
|---|---|---|---|
| Cache machine t4g.nano (730 h) | $3.36 | $3.36 | $3.36 |
| Cache disk 8 GB gp3 | $0.70 | $0.70 | $0.70 |
| Runner image snapshot (~6 GB) | $0.30 | $0.30 | $0.30 |
| Job machines (≈ $0.0090 each) | $0.00 | $0.90 | $9.04 |
| Lambda (without free tier) | $0.06 | $0.07 | $0.25 |
| SQS (without free tier) | $0.26 | $0.26 | $0.28 |
| API Gateway (without free tier) | $0.00 | $0.00 | $0.01 |
| CloudWatch Logs and alarm (without free tier) | $0.11 | $0.11 | $0.12 |
| Scheduler, SSM, ACM, S3, data transfer | $0.00 | $0.00 | $0.00 |
| **Total without free tiers** | **≈ $4.79** | **≈ $5.70** | **≈ $14.06** |
| **Total with free tiers** (Lambda, SQS, logs, alarm free at this volume) | **≈ $4.36** | **≈ $5.26** | **≈ $13.40** |

Image builds add about $0.03 each: 45 minutes of t3.medium and its disk.

A job that runs longer costs proportionally more. Each extra 10 minutes of job time adds $0.0090. At 1,000 jobs of
20 minutes, the job machines cost about $18.

## Customer mode (design; spike in `infra/customer-mode/spike/`; not built)

**The plan.** One **c7i.xlarge** host runs each customer job in its own **Firecracker microVM**, using Firecracker's
**Nitro Sandboxes** backend (v1.18.0, released with `PUT /enclave`). The microVM is destroyed after the job. More hosts
are added as customers grow. There is no Docker-per-job path.

**Why a c7i and not a T3 or a metal host.** Nitro Sandboxes run on the instance types that support Nitro Enclaves:
"not currently available on bare metal instances, burstable instance types (e.g. T3), and instances with only 1 CPU
core" (Nitro Enclaves FAQ, read 2026-11-18). C7i is supported except c7i.large and the metal sizes (EC2 User Guide,
Nitro Sandboxes). A sandbox needs no `/dev/kvm`: Firecracker drives `/dev/nitro_enclaves`, and the Nitro Hypervisor
isolates the sandbox from the parent and from other sandboxes.

### How a job runs

```
GitHub ── workflow_job.queued ──▶ App (worker Lambda): linked installation? → generate-jitconfig (one job)
                                    └▶ SQS "jobs" queue (per host group)            [to build: SqsHostLauncher]
c7i.xlarge host agent (polls the queue, holds RUNNER_TOKEN, never gives it to a guest):
   1. copy the guest disk (reflink on the host's XFS: instant), write a small job disk with the jitconfig
   2. TAP device + NAT; the sandbox may reach the internet, never the parent, its metadata service or another sandbox
   3. firecracker --config-file (2 vCPUs, 2 GiB, direct mode, CPU overcommit), under the jailer in production
   4. guest: systemd → fenvix-guest-job → just-in-time runner takes exactly one job → summary.json onto the job disk
      → poweroff → the sandbox is torn down (vCPUs and memory back to the pools)
   5. host: read summary.json, POST it with RUNNER_TOKEN, delete the disks and the TAP device
```

- **Shared cache.** The same private cache machine as per-job mode (t4g.nano), with **one organization and token pair
  per customer**, so one customer's entries never reach another's jobs. Write tokens only for trusted refs.
- **Capacity of one c7i.xlarge** (4 vCPUs, 8 GiB; ESTIMATE): sandbox memory is donated whole (no overcommit), and the
  parent needs about 1.5 GiB. That leaves room for **about 3 jobs of 2 vCPUs and 2 GiB at once**, with CPU
  overcommitted on 4 vCPUs; the sandbox limit is 20 vCPUs per host. The slot budget starts at 4 and grows in steps
  of 8, each step donating 128 MiB. Heavier jobs need a c7i.2xlarge ($0.38304 per hour) or more hosts.
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

**Inside a KVM Firecracker microVM on the .metal fallback:** same answer, the same guest kernel and image. Docker runs
in Firecracker KVM guests routinely. Nested KVM inside the guest is not needed for containers.

### Must be tested on a real c7i.xlarge before the first customer

1. **Start time per job.** Run `run-job.sh` 20 times and record each stage:
   - preparing the disks (reflink);
   - sandbox start → guest up (UEFI + systemd);
   - guest up → runner online → job assigned;
   - the job's setup;
   - with and without `nitro_enclaves.mempool=` reserved at boot.

   Target: a job starts within about 30 s of being queued.
2. **Isolation:**
   - a guest cannot reach the parent, the metadata service or another sandbox (try from inside);
   - two jobs at once see nothing of each other (disk, network, processes);
   - the runner token never enters a guest;
   - every disk is deleted after the job;
   - the just-in-time config is single use;
   - the jailer (chroot, cgroups, seccomp) wraps Firecracker;
   - direct mode leaves sandbox memory readable by the parent (us). Confidential mode, with a DMB-patched guest kernel,
     closes that if customers ask for it.
3. **Docker:**
   - `docker run hello-world`;
   - a job with `services: postgres`;
   - testcontainers (Python and Java);
   - `docker compose up`;
   - image pull time, with and without a registry mirror on the host;
   - overlay2 on the guest's ext4.
4. **The engine:** `strace -f` inside the guest; `fenvix-run` with the shared cache from the guest; a warm cache across
   two jobs (two microVMs).
5. **Cost and capacity:**
   - how many 2-vCPU, 2 GiB jobs one c7i.xlarge runs at once before jobs slow down;
   - disk throughput with concurrent copies;
   - the host disk size the guest image and concurrent copies need;
   - data transfer for image pulls.
6. **Failure handling:**
   - a guest that hangs is killed by the host (killing Firecracker tears the sandbox down);
   - a sandbox that never got its job;
   - the host rebooting with jobs running.
7. **Limits of Nitro Sandboxes to live with:**
   - no snapshots or pause, so no warm-start from a snapshot;
   - no virtio device reset, so nothing in the guest may rebind its disk or network drivers;
   - memory is not overcommitted.

**Fallback if Nitro Sandboxes fails a must-have** (start time, Docker, isolation): a **.metal** host with KVM
Firecracker, the same guest image and agent. The cheapest x86 metal type in eu-west-1 is **c5n.metal, $4.392 an hour**
(72 vCPUs, 192 GiB), against $0.19152 for a c7i.xlarge. KVM adds snapshots (faster starts) and memory overcommit.
Below dozens of concurrent jobs it is not worth the price.

### Customer mode: monthly cost per host (DECLARED prices; usage ESTIMATED)

| | c7i.xlarge (Nitro Sandboxes) | c5n.metal (KVM fallback) |
|---|---|---|
| instance, 730 h | $139.81 | $3,206.16 |
| host disk 50 GB gp3 | $4.40 | $4.40 |
| public IPv4 | $3.65 | $3.65 |
| **per host per month** | **≈ $147.86** | **≈ $3,214.21** |
| jobs at once (2 vCPU, 2 GiB) | about 3 | about 35 by vCPU, more with overcommit |

A job costs nothing extra on a host that is already running; the host is the cost. The serverless part and the cache
machine are as in per-job mode, about $4.80 a month.
