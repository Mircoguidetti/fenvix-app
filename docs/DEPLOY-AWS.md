# Deploying the GitHub App and the runner on AWS

This page is for the founder. It puts the fenvix GitHub App on `https://github.fenvix.dev` and one fenvix runner
machine on EC2. The steps are in order, with one action per step. **Nothing here has been deployed yet.** The code was
synthesized and tested without an AWS account (see `docs/REPORT-aws-deploy.md`).

Account `865859654353`, region `eu-west-1` (Ireland). Both come from `infra/github-app/cdk.json`.

## What gets created

```
GitHub ──HTTPS──▶ github.fenvix.dev  (API Gateway HTTP API, ACM certificate, DNS on Cloudflare)
                    └▶ Lambda "http": checks the signature or the runner token, puts the work on SQS, answers 202
                 SQS "work" queue  (failed 5 times → "dead-letters" queue + alarm; payloads over 200 KB go via S3)
                    └▶ Lambda "worker": stores the event, opens the onboarding PR, publishes the check run, the PR comment, ci_runs, usage events
                 EventBridge Scheduler, every minute
                    └▶ Lambda "sweep": publishes the finished jobs whose runner summary never came (after SUMMARY_WAIT_SECONDS)
EC2 t3.medium "fenvix-prod-runner" (Ubuntu 24.04, 30 GB gp3, no inbound port)
   GitHub runner, labels self-hosted,Linux,X64,fenvix  ──after each job──▶ POST https://github.fenvix.dev/v1/runner/summaries
Supabase (yours): the role fenvix_github_app writes gh_*, ci_projects, ci_runs, ci_usage_events
```

| Piece | Detail |
|---|---|
| Secrets | SSM Parameter Store, type SecureString, under `/fenvix/prod/github-app/`. You create them; the stack never sees their values. Each Lambda reads only its own, by exact name. The worker and the sweep never get the webhook secret, the OAuth client secret, the state key or the runner token. |
| Logs | CloudWatch log groups `/aws/lambda/fenvix-prod-github-app-{http,worker,sweep}` and `/aws/apigateway/fenvix-prod-github-app-api`, kept **14 days**. |
| Runner machine | Ubuntu 24.04 with `runner/bootstrap.sh install` from `Mircoguidetti/fenvix-engine-cli`, pinned to commit `4391eb0`. Two users. `fenvix` runs the GitHub runner and the jobs. `fenvix-post` alone holds `RUNNER_TOKEN` and sends the summaries. Neither user can reach the instance metadata service, so job code cannot use the machine's AWS role. `strace -f` works for a process's own children (ptrace scope 1, checked at setup). There is no SSH: use Session Manager. Outbound traffic is HTTPS and HTTP only. |
| Runner registration | The machine waits for a one-hour registration token in SSM (`/fenvix/prod/runner/registration-token`). It registers, then deletes the token (both the file and the parameter). The service `fenvix-runner` restarts by itself and survives reboots. |
| Hand-off | A job's `summary.json` (`$RUNNER_TEMP/fenvix/summary.json`, written by `fenvix-run`) is picked up by the runner's job-completed hook. The poster sends it with the machine's runner name. |

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

Keep it private. A self-hosted runner on a public repository would run code from forks.

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
| Repository permissions | Actions: **Read-only** · Checks: **Read and write** · Contents: **Read and write** · Metadata: Read-only · Pull requests: **Read and write** · **Workflows: Read and write** |
| Organization / account permissions | none |
| Subscribe to events | **Pull request**, **Push**, **Workflow job** |
| Where can this GitHub App be installed? | Only on this account (for now) |

Click **Create GitHub App**. `docs/GITHUB-APP.md` explains why each permission is needed. GitHub's first "ping" will
fail because nothing answers yet. You redeliver it in step 19.

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

**Step 9.** Create the two policies that CloudFormation will use when it creates this stack. They cover Lambda, IAM
roles named `fenvix-prod-github-app-*`, SQS, S3, logs, Scheduler, ACM, API Gateway, the alarm and EC2. EC2 may never
get an inbound rule. Run this from `infra/github-app/`:

```
aws iam create-policy --policy-name fenvix-github-app-cfn-exec-app  --policy-document file://cfn-exec-policy-app.json
aws iam create-policy --policy-name fenvix-github-app-cfn-exec-edge --policy-document file://cfn-exec-policy-edge.json
```

**Step 10.** Bootstrap CDK in eu-west-1 with those two policies:

```
aws cloudformation describe-stacks --stack-name CDKToolkit --region eu-west-1   # "does not exist" is expected
npx cdk bootstrap aws://865859654353/eu-west-1 \
  --cloudformation-execution-policies arn:aws:iam::865859654353:policy/fenvix-github-app-cfn-exec-app,arn:aws:iam::865859654353:policy/fenvix-github-app-cfn-exec-edge
```

If `CDKToolkit` already exists, other stacks may rely on its current policies. In that case, add the two ARNs above to
the policies it already has; do not replace them. The existing `infra/` stacks do not use the CDK bootstrap.

**Step 11.** Create the deploy identity with **exactly** `infra/github-app/deploy-policy.json`. That policy lets it
assume the three CDK bootstrap roles, read the stack, print the certificate record, write the
`/fenvix/prod/github-app/*` and `/fenvix/prod/runner/*` parameters, read this stack's logs and open a Session Manager
shell on the runner. It cannot create IAM, Lambda or EC2 resources itself.

- **IAM Identity Center (recommended):** create a permission set `fenvix-github-app-deployer` with the content of
  `deploy-policy.json` as its inline policy. Assign it to your user on account 865859654353. Then run
  `aws configure sso --profile fenvix-deployer` on your laptop.
- **Or an IAM user:**
  ```
  aws iam create-user --user-name fenvix-github-app-deployer
  aws iam put-user-policy --user-name fenvix-github-app-deployer --policy-name deploy --policy-document file://deploy-policy.json
  aws iam create-access-key --user-name fenvix-github-app-deployer      # then: aws configure --profile fenvix-deployer
  ```

From here on, everything runs as this identity: `export AWS_PROFILE=fenvix-deployer AWS_REGION=eu-west-1`.

### D. The secrets in SSM (your laptop, as the deployer)

**Step 12.** Create the six parameters. Type each value at the prompt, so that it stays out of your shell history:

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
| `/fenvix/prod/github-app/runner-token` | `RUNNER_TOKEN` (step 1); the runner machine reads the same parameter |
| `/fenvix/prod/github-app/database-url` | the connection string from step 8 |
| `/fenvix/prod/github-app/private-key` | step 13 |
| `/fenvix/prod/github-app/runner-token-previous` | not now (only while you rotate `runner-token`) |

**Step 13.** Store the private key from its file, then delete the file:

```
aws ssm put-parameter --name /fenvix/prod/github-app/private-key --type SecureString --value file://$HOME/Downloads/<app>.<date>.private-key.pem --overwrite
rm $HOME/Downloads/<app>.<date>.private-key.pem
```

### E. Deploy

**Step 14.** Fill in the non-secret settings in `infra/github-app/cdk.json` (section `context`) and commit them:

| Setting | Value |
|---|---|
| `githubAppId` | the App ID (step 4) |
| `githubAppSlug` | the slug (step 4) |
| `githubClientId` | the Client ID (step 4) |
| `dashboardUrl` | the dashboard's address (step 3's Homepage URL) |
| `supabaseUrl` | `https://<project-ref>.supabase.co` |
| `runnerScopeUrl` | the test repository, e.g. `https://github.com/Mircoguidetti/fenvix-demo` (or an organization: `https://github.com/<org>`) |
| `alarmEmail` | optional: an email for the dead-letter alarm (confirm the subscription email AWS sends) |

The other settings keep their defaults: `domainName` `github.fenvix.dev`, `runnerInstanceType` `t3.medium`,
`runnerVolumeGb` `30`, `logRetentionDays` `14`, `summaryWaitSeconds` `600`, `sweepMinutes` `1`, `runnerName`
`fenvix-ec2-1`.

**Step 15.** Run the deploy command, which is the only one:

```
cd infra/github-app && npm run deploy
```

It checks your account and the six parameters (names only). It installs and tests the service and this folder,
picks and keeps the runner's Ubuntu 24.04 AMI, shows the change and asks `y/N`, then deploys. The first deploy stops
at the certificate. That is when it prints **Cloudflare record 1 of 2**.

**Step 16.** In Cloudflare (zone `fenvix.dev` → DNS → Add record), add record 1 exactly as printed: Type `CNAME`,
Name `_<hash>.github`, Target `_<hash>.<...>.acm-validations.aws`, Proxy status **DNS only**. Keep it after the
certificate is issued, because ACM renews through it. Within a few minutes ACM issues the certificate and the deploy
continues. Expect 5 to 15 minutes in all. At the end the deploy prints **Cloudflare record 2 of 2**. You can print
both again at any time with `bash scripts/dns-records.sh`.

**Step 17.** In Cloudflare, add record 2: Type `CNAME`, Name `github`, Target `d-xxxxxxxxxx.execute-api.eu-west-1.amazonaws.com`
(the `DnsTarget` output), Proxy status **DNS only**. The grey cloud is needed because API Gateway serves its own
certificate and must see the request as GitHub sent it.

**Step 18.** Check the host: `curl -s https://github.fenvix.dev/healthz` must answer `{"ok":true}`.

**Step 19.** GitHub → the App's settings → **Advanced → Recent Deliveries**. Open the failed `ping` and click
**Redeliver**. The response must be `200 {"ok":true,"pong":true}`.

### F. The runner machine

**Step 20.** Wait for the machine's setup. It installs tools and builds the engine, which takes about 15 to 20
minutes after the instance starts. To watch it:

```
aws ssm start-session --target <RunnerInstanceId output>     # needs the Session Manager plugin, or use the EC2 console: Connect → Session Manager
sudo tail -f /var/log/fenvix-runner-setup.log                # ends with "fenvix runner setup done", "strace -f as fenvix: ok", "instance metadata blocked for fenvix: ok"
sudo journalctl -u fenvix-runner -f                          # "waiting for the registration token in SSM: /fenvix/prod/runner/registration-token"
```

**Step 21.** Get a registration token: test repository → **Settings → Actions → Runners → New self-hosted runner**.
Copy only the token from the line `./config.sh --url ... --token <TOKEN>`. It is valid for one hour.

**Step 22.** Put it in SSM within that hour:

```
read -rsp "registration token: " v; echo
aws ssm put-parameter --name /fenvix/prod/runner/registration-token --type SecureString --value "$v" --overwrite; unset v
```

Within 30 seconds the machine registers and deletes the parameter. The journal says `registered as fenvix-ec2-1 ...;
token deleted`. The repository's **Settings → Actions → Runners** page shows `fenvix-ec2-1` as **Idle**, with the
labels `self-hosted`, `Linux`, `X64`, `fenvix`. If the token had expired, the parameter is deleted anyway. Repeat
steps 21 and 22.

### G. The first onboarding PR, the first run, the first PR comment

**Step 23.** Install the App on the test repository: open `https://github.com/apps/<slug>/installations/new`, choose
**Only select repositories** → `fenvix-demo` → **Install**. GitHub then sends you to
`https://github.fenvix.dev/github/setup`, which sends you on to the dashboard with `github=error&reason=expired`. That
is expected: the installation did not start from the dashboard, so it carries no signed organization. Step 26 links
it by hand.

**Step 24.** See the onboarding PR: test repository → **Pull requests** → **"Run the tests on fenvix (runs-on:
fenvix)"**, from branch `fenvix/runs-on`. Its diff is one line, the test job's `runs-on`. If it is missing, read the
worker's log:

```
aws logs tail /aws/lambda/fenvix-prod-github-app-worker --since 30m
```

**Step 25.** Merge the onboarding PR. The `CI` workflow runs on `main`. In the job `test`, the "Set up job" step says
`Runner name: 'fenvix-ec2-1'`: the job ran on the EC2 machine. A **fenvix** check run appears on the commit (commit →
checks). This workflow still calls plain `pytest`, so no `summary.json` is written. The check run is completed
**about 10 minutes later** by the sweep, with "No fenvix summary" (`SUMMARY_WAIT_SECONDS=600`).

**Step 26.** (So that the run also shows in the dashboard.) In the Supabase SQL editor, link the installation to your
organization:

```sql
select installation_id, account_login from gh_installations where workspace_id is null;   -- the installation id
select w.id as workspace_id, m.user_id, m.role from workspaces w join workspace_members m on m.workspace_id = w.id
  join auth.users u on u.id = m.user_id where u.email = '<your email>';                    -- your organization, you (owner)
select public.gh_link_installation(<installation_id>, '<workspace_id>', '<user_id>');
```

**Step 27.** Open a pull request on the test repository that runs the tests through the fenvix engine. On a branch,
replace the last two steps of the `test` job with:

```yaml
      - name: Project environment with the fenvix engine
        run: |
          set -eu
          uv venv -q --python 3.13 "$RUNNER_TEMP/venv"
          py="$RUNNER_TEMP/venv/bin/python"
          uv pip install -q --python "$py" -e . pytest "$(ls "$FENVIX_WHEEL_DIR"/detpy-*.whl | head -1)"
          echo "FENVIX_PY=$py" >> "$GITHUB_ENV"
      - name: Tests in the fenvix engine
        run: '"$FENVIX_PY" "$FENVIX_HOME/bin/fenvix-run" --project . --python "$FENVIX_PY" --out "$RUNNER_TEMP/fenvix"'
```

Remove the `actions/setup-python` step: the machine's `uv` provides Python 3.13. `FENVIX_WHEEL_DIR` and `FENVIX_HOME`
come from the runner (`runner/bootstrap.sh`).

**Step 28.** See the result on the PR. When the job ends, the job-completed hook queues `summary.json`, the poster
sends it (on the machine: `sudo journalctl -u fenvix-summary-poster` shows `sent (202)`), and within seconds:

- PR → **Checks** → **fenvix**: completed, with tests run, reused with proof and failures;
- PR → **Conversation**: one comment by `<slug>[bot]`, which is updated in place on the next push;
- the dashboard (after step 26): the project `fenvix-demo`, its run, and the usage month.

Push a second commit that changes one test file. The comment updates, and most tests are now "reused with proof"
(warm cache on the machine).

## When something fails

| What you see | Where to look | What to do |
|---|---|---|
| the deploy stops with `AccessDenied ... cdk-hnb659fds-...` | the deploy's output | step 10 was not run (bootstrap), or the deploy identity lacks `deploy-policy.json` |
| the deploy stops with `... is not authorized to perform: <action>` from CloudFormation | the stack's Events in the console | add that action to `cfn-exec-policy-app.json` or `-edge.json`, update the policy (`aws iam create-policy-version --set-as-default`), deploy again |
| the deploy waits on `Certificate` for over 30 minutes | `bash scripts/dns-records.sh` | record 1 is missing, mistyped, or proxied (orange cloud) in Cloudflare |
| a GitHub delivery shows **503** `queue_unavailable` | `aws logs tail /aws/lambda/fenvix-prod-github-app-http` | SQS refused the message; redeliver it from the App's Recent Deliveries |
| a delivery shows **401** | the App's webhook secret vs `/fenvix/prod/github-app/webhook-secret` | make them equal; Lambda reads the parameter at cold start, so deploy again (or wait for new containers) |
| a function logs `missing SSM parameters: ...` | its log group | create the named parameter (step 12) |
| the database refuses the connection | the worker's log | check the user `fenvix_github_app.<ref>`, the password (step 8) and the **session** pooler host on port 5432 |
| the dead-letter alarm fires | `aws logs tail /aws/lambda/fenvix-prod-github-app-worker --since 1h` | fix the cause, then move the messages back: SQS console → `fenvix-prod-github-app-dead-letters` → **Start DLQ redrive** |
| the runner never registers | `sudo journalctl -u fenvix-runner` on the machine | the token expired (steps 21–22 again) or `runnerScopeUrl` is not the repository the token is for |
| no PR comment, the check says "No fenvix summary" | `sudo journalctl -u fenvix-summary-poster`; the job log line `fenvix: ...` | the job wrote no `$RUNNER_TEMP/fenvix/summary.json` (step 27), or the poster got 401 (runner token mismatch) |

To remove everything: `cd infra/github-app && npx cdk destroy fenvix-prod-github-app`. The SSM parameters and your
Cloudflare records stay; delete them by hand. Remove the runner from the repository's **Settings → Actions →
Runners**.

## Monthly cost at low volume

All prices are for eu-west-1, on demand, in USD, read on **2026-11-18**. Each price is marked **DECLARED**: it is
AWS's published price, read today, and not a measured bill.

The regional numbers come from AWS's official **Price List API**
(`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/current/eu-west-1/index.json`). The
aws.amazon.com pricing pages load those same numbers in the browser from a data host that this container's network
refused, so the pages could not be read for them. The aws.amazon.com pages were read for the free tiers, the metering
units and the flat prices (public IPv4, T3 credits, SSM, ACM).

| Item | Price (DECLARED) | Source (read 2026-11-18) |
|---|---|---|
| EC2 t3.medium, Linux | $0.0456 per hour | Price List API AmazonEC2, SKU 47NTBKB4KMUU98P8 |
| EBS gp3 | $0.088 per GB-month; 3,000 IOPS and 125 MB/s included | Price List API AmazonEC2, SKU TXACT7E3PV6ZX2NM; aws.amazon.com/ebs/pricing |
| Public IPv4 address | $0.005 per hour | aws.amazon.com/vpc/pricing (and Price List API AmazonVPC) |
| Lambda (x86) | $0.0000166667 per GB-second, $0.20 per 1M requests; free tier 400,000 GB-s and 1M requests per month | Price List API AWSLambda; aws.amazon.com/lambda/pricing |
| SQS standard | $0.40 per 1M requests (64 KB = 1 request); 1M requests per month free | Price List API AWSQueueService; aws.amazon.com/sqs/pricing |
| API Gateway HTTP API | $1.11 per 1M requests (512 KB units); 1M per month free for 12 months, **new customers only** | Price List API AmazonApiGateway; aws.amazon.com/api-gateway/pricing |
| EventBridge Scheduler | 14M invocations per month free, then $1.00 per 1M | aws.amazon.com/eventbridge/pricing; Price List API AWSEvents |
| SSM Parameter Store, standard | no additional charge (storage and standard throughput) | aws.amazon.com/systems-manager/pricing |
| (Secrets Manager, not used) | $0.40 per secret-month, $0.05 per 10,000 calls | Price List API AWSSecretsManager |
| CloudWatch Logs | $0.57 per GB ingested, $0.03 per GB-month stored; 5 GB per month free | Price List API AmazonCloudWatch; aws.amazon.com/cloudwatch/pricing |
| CloudWatch alarm (standard) | $0.10 per alarm-month; first 10 free | Price List API AmazonCloudWatch, SKU GDMKAEDCSYJAKBZQ / FCH8WPMWVXA4B6VM |
| S3 Standard (overflow bucket) | $0.023 per GB-month, $0.005 per 1,000 PUT, $0.0004 per 1,000 GET | Price List API AmazonS3 |
| ACM public certificate (API Gateway) | no cost | aws.amazon.com/certificate-manager/pricing |
| Data transfer out | 100 GB per month free; then $0.09 per GB | aws.amazon.com/ec2/pricing/on-demand; Price List API AWSDataTransfer |

**Usage assumed** (an ESTIMATE, not measured): 100 fenvix jobs a month, which is about 1,000 HTTP requests (5 webhooks
and 1 summary per job, plus installs and pings) and 1,000 worker runs of about 2 s. The sweep runs every minute,
43,800 times a month at about 0.2 s and 256 MB. The worker's SQS trigger long-polls even when idle; assumed about
657,000 requests a month (5 pollers × 3 per minute). Logs are about 20 MB a month.

| Item | Usage | Without free tier | With free tier |
|---|---|---|---|
| EC2 t3.medium, always on (credits "standard": no surplus charge) | 730 h | **$33.29** | $33.29 |
| EBS gp3 30 GB | 30 GB-month | **$2.64** | $2.64 |
| Public IPv4 of the runner | 730 h | **$3.65** | $3.65 |
| Lambda | ~3,340 GB-s, ~45,800 requests | $0.07 | $0.00 |
| SQS | ~660,000 requests | $0.26 | $0.00 |
| API Gateway HTTP API | ~1,000 requests | $0.00 (0.11 cents) | $0.00 |
| EventBridge Scheduler | 43,800 invocations | $0.00 | $0.00 |
| SSM Parameter Store (7 standard parameters) | | $0.00 | $0.00 |
| CloudWatch Logs | ~0.02 GB | $0.01 | $0.00 |
| CloudWatch alarm | 1 | $0.10 | $0.00 |
| S3, ACM, data transfer | | $0.00 | $0.00 |
| **Total per month** | | **≈ $40.02** | **≈ $39.58** |

The machine accounts for 99% of the cost: the EC2 instance, its disk and its IPv4 address. Stopping it when no test
runs saves the $33.29 but not the disk. The Lambda side stays under $1 a month up to a few thousand jobs. An optional
email alert (SNS) adds nothing at this volume; its price was not read.
