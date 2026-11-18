# Deploying the GitHub App and the runners on AWS

This page is for the founder. It puts the fenvix GitHub App on `https://github.fenvix.dev`. By default, every queued
fenvix job gets **its own EC2 machine**, which is started for that job and deleted after it. The steps are in order,
with one action per step. **Nothing here has been deployed yet.** The code was synthesized and tested without an AWS
account (see `docs/REPORT-aws-deploy.md`).

Account `865859654353`, region `eu-west-1` (Ireland). Both come from `infra/github-app/cdk.json`.

## What gets created

```
GitHub ──HTTPS──▶ github.fenvix.dev  (API Gateway HTTP API, ACM certificate, DNS on Cloudflare)
                    └▶ Lambda "http": checks the signature or the runner token, puts the work on SQS, answers 202
                 SQS "work" queue  (failed 5 times → "dead-letters" queue + alarm; payloads over 200 KB go via S3)
                    └▶ Lambda "worker": stores the event; opens the onboarding PR; on workflow_job.queued (fenvix label,
                       installation linked to an organization) gets a just-in-time runner from GitHub and starts one
                       EC2 machine for that job; publishes the check run, the PR comment, ci_runs, usage events
                 EventBridge Scheduler: "sweep" every minute (jobs whose summary never came), "reaper" every 10 minutes
                       (job machines older than 6 hours)

Job machine (one per job, t3.medium, from the runner image; no inbound port)
   just-in-time runner: takes exactly one job ──after it──▶ POST https://github.fenvix.dev/v1/runner/summaries
   then powers off; shutdown behaviour "terminate" deletes the machine and its disk
   no job within 20 minutes (cancelled, or taken by another machine) → powers off too
Runner image: EC2 Image Builder (Ubuntu 24.04 + strace, build tools, uv, Python, Rust, the engine wheel built by
   runner/bootstrap.sh install, the GitHub runner, the hooks); built by hand with scripts/build-image.sh
Shared cache machine (t4g.nano, private address 10.42.0.10, no public address, no outbound route)
   the engine's own cache service (detpy.cache_service), reached only by job machines, so that a test proven on one
   machine can be skipped with proof on the next one
Supabase (yours): the role fenvix_github_app writes gh_*, ci_projects, ci_runs, ci_usage_events
```

| Piece | Detail |
|---|---|
| Secrets | SSM Parameter Store, type SecureString, under `/fenvix/prod/github-app/` and `/fenvix/prod/cache/`. You create them; the stack never sees their values. Each Lambda reads only its own, by exact name. |
| Who starts machines | Only the worker, and only for an installation **linked to an organization** (a stranger who installs the public App starts nothing). It starts at most `runnerMaxRunning` (4) machines at once; more queued jobs wait, because the queue retries them every 12 minutes for about an hour. A machine can only start from our launch template and our own images, and only tagged `fenvix:role=runner-job`. The reaper may only terminate machines with that tag. |
| Job machines | Two users. `fenvix` runs the runner and the job. `fenvix-post` alone holds `RUNNER_TOKEN` and sends the summary. Neither user can reach the instance metadata service, so job code cannot use the machine's AWS role. `strace -f` works on a job's own children. Outbound traffic is HTTPS and HTTP, plus the cache machine. There is no SSH. |
| Shared cache | Write token only for jobs on **trusted refs**: a push, schedule or manual run on the repository's default branch, from the repository itself. Pull requests, forks and other branches get a read-only token, as the engine's `docs/SHARED-CACHE.md` requires. The token is handed to `fenvix-run` as a file it deletes once read. |
| Logs | CloudWatch log groups `/aws/lambda/fenvix-prod-github-app-{http,worker,sweep,reaper}` and `/aws/apigateway/fenvix-prod-github-app-api`, kept **14 days**. |

The always-on runner is still available (setting `runnerMode` to `always-on`). See section H.

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

**Administration: Read and write** is new. It is the permission GitHub requires for
`POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig`, the call that creates a just-in-time runner for one
job. The App uses this permission for nothing else. The runner is registered **on the repository**, so it can only
take that repository's jobs.

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
- write the `/fenvix/prod/{github-app,runner,cache}/*` parameters;
- read this stack's logs;
- start the image build;
- stop and start the always-on runner;
- open a Session Manager shell on it.

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

**Step 14.** Create the shared cache's two tokens:

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
| `cacheTokenSha256Write`, `cacheTokenSha256Read` | the two lines from step 14 |
| `alarmEmail` | optional: an email for the dead-letter alarm (confirm the subscription email AWS sends) |

The other settings keep their defaults:

- `runnerMode` `per-job`, `runnerInstanceType` `t3.medium`, `runnerVolumeGb` `30`;
- `runnerMaxRunning` `4`, `runnerIdleMinutes` `20`, `runnerMaxHours` `6`;
- `cacheInstanceType` `t4g.nano`, `cachePrivateIp` `10.42.0.10`;
- `engineCliCommit` `a20b93d` (`claude/shared-cache`, which has the shared-cache client);
- `domainName` `github.fenvix.dev`, `logRetentionDays` `14`, `summaryWaitSeconds` `600`.

**Step 16.** Run the deploy command, which is the only one:

```
cd infra/github-app && npm run deploy
```

It checks your account and the parameters (names only), installs and tests everything, keeps the machine images it
already uses, shows the change, asks `y/N`, and deploys. The first deploy stops at the certificate. That is when it
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
engine is built from source, and ends with `runner image ready: ami-...`. Job machines always start from the newest
image, so no deploy is needed after a build. Run it again after changing `engineCliCommit` or
`lib/runner/files/`. After a few builds, delete the old images (EC2 → AMIs → Deregister, then their snapshots); each
one is billed as snapshot storage.

### G. The first onboarding PR, the first job machine, the first PR comment

**Step 22.** Install the App on the test repository: open `https://github.com/apps/<slug>/installations/new`, choose
**Only select repositories** → `fenvix-demo` → **Install**. GitHub then sends you to
`https://github.fenvix.dev/github/setup`, which sends you on to the dashboard with `github=error&reason=expired`. That
is expected: the installation did not start from the dashboard, so it carries no signed organization.

**Step 23.** Link the installation to your organization. This is **required for job machines**: an installation
without an organization never starts one. In the Supabase SQL editor, run:

```sql
select installation_id, account_login from gh_installations where workspace_id is null;   -- the installation id
select w.id as workspace_id, m.user_id, m.role from workspaces w join workspace_members m on m.workspace_id = w.id
  join auth.users u on u.id = m.user_id where u.email = '<your email>';                    -- your organization, you (owner)
select public.gh_link_installation(<installation_id>, '<workspace_id>', '<user_id>');
```

**Step 24.** See the onboarding PR: test repository → **Pull requests** → **"Run the tests on fenvix (runs-on:
fenvix)"**, from branch `fenvix/runs-on`. Its diff is one line. If it is missing, read the worker's log:
`aws logs tail /aws/lambda/fenvix-prod-github-app-worker --since 30m`.

**Step 25.** Merge it. The `test` job is queued with the label `fenvix`, and within seconds the worker logs
`runner machine requested`. EC2 → Instances shows `fenvix-j<job id>`. About one minute later, the job's "Set up job"
step says `Runner name: 'fenvix-j<job id>'`. When the job ends, the machine shuts down and disappears (state
**terminated**).

This workflow still runs plain `pytest`, so no `summary.json` is written. The **fenvix** check run is completed by
the sweep about 10 minutes later, with "No fenvix summary".

**Step 26.** Open a pull request that runs the tests through the engine and the shared cache. On a branch, replace
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

**Step 27.** Merge that pull request. The job on `main` (a trusted ref) gets the **write** token and records every
test into the shared cache.

**Step 28.** Open another pull request that changes one test file. A **new** machine runs it, pulls from the shared
cache, and the comment shows most tests as **reused with proof**. This shows that proof crosses machines. The
dashboard (after step 23) shows the project, the runs and the usage month.

### H. Option: one always-on runner (`runnerMode` = `always-on`)

This mode runs one machine all the time, registered once on one repository or organization. Its local cache is on
its own disk, so there is no cache machine, image or job machine. Use it for demos where you want no start-up delay.

1. In `cdk.json`, set `runnerMode` to `always-on`, and set `runnerScopeUrl` to the test repository
   (`https://github.com/Mircoguidetti/fenvix-demo`) or an organization. Then run `npm run deploy`.
2. Wait 15 to 20 minutes for the machine's setup (Session Manager: `aws ssm start-session --target <RunnerInstanceId>`,
   then `sudo tail -f /var/log/fenvix-runner-setup.log`). It ends with "fenvix runner setup done", then
   "waiting for the registration token in SSM".
3. Get a registration token: repository → **Settings → Actions → Runners → New self-hosted runner**. Copy only the
   token in `./config.sh ... --token <TOKEN>`; it is valid one hour.
4. Store it within that hour:
   `read -rsp "token: " v; echo; aws ssm put-parameter --name /fenvix/prod/runner/registration-token --type SecureString --value "$v" --overwrite; unset v`.
   The machine registers within 30 seconds and deletes the parameter.

**Stop and start** (one command each, from `infra/github-app/`):

```
bash scripts/runner-stop.sh     # stops the machine; waits until it is stopped
bash scripts/runner-start.sh    # starts it; it is Idle on GitHub again within about a minute
```

After a start, the machine comes back by itself. Its services are enabled, and its registration is on its disk, so
it needs **no new registration token**.

While the machine is stopped, the App keeps working: webhooks, onboarding PRs, the dashboard. Queued fenvix jobs
wait on GitHub. The App never publishes, fails or bills a job that has not completed. If GitHub cancels a job after
24 hours in the queue, the App records it as **not billable** (`cancelled_before_tests`) and writes no run row.
`tests/integration/runners.test.ts` checks this.

## When something fails

| What you see | Where to look | What to do |
|---|---|---|
| the deploy stops with `AccessDenied ... cdk-hnb659fds-...` | the deploy's output | step 10 was not run (bootstrap), or the deploy identity lacks `deploy-policy.json` |
| the deploy stops with `... is not authorized to perform: <action>` | the stack's Events in the console | add that action to the matching `cfn-exec-policy-*.json`, update the policy (`aws iam create-policy-version --set-as-default`), deploy again |
| the deploy waits on `Certificate` for over 30 minutes | `bash scripts/dns-records.sh` | record 1 is missing, mistyped, or proxied (orange cloud) in Cloudflare |
| a GitHub delivery shows **503** `queue_unavailable` | `aws logs tail /aws/lambda/fenvix-prod-github-app-http` | SQS refused the message; redeliver it from the App's Recent Deliveries |
| a delivery shows **401** | the App's webhook secret vs `/fenvix/prod/github-app/webhook-secret` | make them equal, then deploy again (Lambda reads the parameter at cold start) |
| a fenvix job stays **Queued**, and the worker logs `the installation is not linked` | worker log | step 23 |
| ... and the worker logs `no runner image yet` | worker log | step 21 |
| ... and the worker logs `limit 4` | worker log | 4 machines are busy; the job is retried every 12 minutes for about an hour. Raise `runnerMaxRunning` if needed |
| ... and the worker logs `Resource not accessible by integration` on `generate-jitconfig` | worker log | the App lacks **Administration: Read and write**, or the customer has not approved it yet |
| a job machine starts but the job never runs | EC2 → the instance → Actions → Monitor → Get system log | the machine powers off after 20 minutes without a job; the reaper terminates anything left after 6 hours |
| no PR comment; the check says "No fenvix summary" | the job's log, line `fenvix: ...` | the job did not call `fenvix-run`, so there is no `$RUNNER_TEMP/fenvix/summary.json` (step 26); or the summary was refused with 401 because of a runner token mismatch |
| nothing is reused on a second machine | the job's log, line `shared cache ...` | the cache tokens in `cdk.json` do not match SSM (run step 14 again, update `cdk.json`, deploy: the cache machine is replaced), or the run was untrusted (read-only) and nothing was recorded yet |
| the dead-letter alarm fires | `aws logs tail /aws/lambda/fenvix-prod-github-app-worker --since 1h` | fix the cause, then SQS console → `fenvix-prod-github-app-dead-letters` → **Start DLQ redrive** |

To remove everything: `cd infra/github-app && npx cdk destroy fenvix-prod-github-app`, then deregister the runner
images (EC2 → AMIs) and delete their snapshots. The SSM parameters and the Cloudflare records stay; delete them by
hand.

## Why the shared cache is a small machine, not Lambda + S3

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

No AWS account was available, so none of this was measured. The figures are typical durations, to be replaced by a
measurement on the first real job: GitHub's job log shows "queued" and "started" times, and the worker logs `runner
machine requested`.

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
| Lambda (x86) | $0.0000166667 per GB-second, $0.20 per 1M requests; free tier 400,000 GB-s and 1M requests per month | Price List API AWSLambda; aws.amazon.com/lambda/pricing |
| SQS standard | $0.40 per 1M requests (64 KB = 1 request); 1M per month free | Price List API AWSQueueService; aws.amazon.com/sqs/pricing |
| API Gateway HTTP API | $1.11 per 1M requests; 1M per month free for 12 months, new customers only | Price List API AmazonApiGateway; aws.amazon.com/api-gateway/pricing |
| EventBridge Scheduler | 14M invocations per month free, then $1.00 per 1M | aws.amazon.com/eventbridge/pricing |
| SSM Parameter Store, standard | no additional charge | aws.amazon.com/systems-manager/pricing |
| CloudWatch Logs | $0.57 per GB ingested, $0.03 per GB-month; 5 GB per month free | Price List API AmazonCloudWatch; aws.amazon.com/cloudwatch/pricing |
| CloudWatch alarm | $0.10 per alarm-month; first 10 free | Price List API AmazonCloudWatch |
| ACM certificate for API Gateway | no cost | aws.amazon.com/certificate-manager/pricing |
| Data transfer out | 100 GB per month free | aws.amazon.com/ec2/pricing/on-demand |

### Default mode: one machine per job

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

### Option: the always-on runner

| | Running all month | Stopped all month |
|---|---|---|
| t3.medium | $33.29 | $0 |
| 30 GB gp3 disk | $2.64 | $2.64 (the disk stays) |
| Public IPv4 | $3.65 | $0 (released while stopped) |
| Serverless part (without free tiers) | ≈ $0.44 | ≈ $0.44 |
| **Total** | **≈ $40.02** | **≈ $3.08** (≈ $2.64 with free tiers) |

When it is stopped, only its **disk** is billed: 30 GB × $0.088 = $2.64 a month. Each hour it runs adds $0.0456 for
the instance and $0.005 for the IPv4 address, about $0.05.
