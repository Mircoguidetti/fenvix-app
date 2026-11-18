DONE

# Report: the GitHub App on AWS Lambda, the runner on EC2 (branch `claude/github-app`)

All five parts are built, committed and tested in the container. Nothing is deployed, because no AWS account was
available. "Not verified" below lists what only a real deploy can show. The founder's steps are in
`docs/DEPLOY-AWS.md`.

## 1. The service on Lambda (`github-app/`)

- **Hand-off:** `src/work.ts` defines the work a checked request leaves behind (a webhook, or a runner summary) and the
  `WorkQueue` interface.
  - In node server mode, `InProcessQueue` does what the service did before (it runs the work in the background). The
    node server, `npm start` and every existing test are unchanged.
  - On Lambda, `SqsWorkQueue` (`src/queue/sqs.ts`) sends the work to SQS and the request is answered **202**. No
    work runs after the response. If SQS refuses the message, the request is answered **503** `queue_unavailable`,
    so GitHub records a failed delivery that can be redelivered.
  - Payloads over 200 KB (an SQS message holds at most 1 MiB; an installation on "All repositories" can be far larger)
    go to an S3 overflow bucket, and the message carries only the key. The worker deletes the object after success,
    and a lifecycle rule removes leftovers after 5 days.
- **Lambda entry points** (`src/lambda/`):
  - `http.ts`: API Gateway payload 2.0 → Fastify `inject`. The exact body bytes are kept, because the signature is
    computed over them.
  - `worker.ts`: SQS batches, with `ReportBatchItemFailures`, so only the failed message comes back.
  - `sweep.ts`: run by EventBridge Scheduler. The in-process timer is off on Lambda (`SWEEP_SECONDS=0`).
  - The runner summaries endpoint is unchanged: same route, same token check, same 202.
- **Secrets:** read from SSM at cold start, by exact name (`src/lambda/secrets.ts`). `loadConfig(env, { surface:
  "worker" })` lets the worker and the sweep start without the webhook secret, the OAuth client secret, the state key
  or the runner token, and they are never given them. `buildApp` refuses a worker config.
- **Re-running work is safe,** since SQS delivers at least once. Deliveries are recorded once, summaries are upserted,
  publication is claimed once, and there is one usage event per GitHub job. All of this existed before and is now
  tested through the queue.
- **Tests added:**
  - `tests/unit/lambda.test.ts` (12): inline and overflow messages, checks when a message is read back, the SDK
    commands, the SSM names per function, the missing-parameter message (never a value), the config surfaces, the API
    Gateway adapter (base64 body, query, cookies, redirects, binary), `once()`, and the logger.
  - `tests/integration/queue.test.ts` (9), against Postgres and the fake GitHub:
    - a bad signature gets 401 and nothing is queued;
    - a signed webhook gets 202 with nothing done yet, then the worker opens the onboarding PR;
    - a duplicate delivery is handled once;
    - an overflow payload goes through S3 and is deleted after;
    - the queue being down gives 503;
    - a summary and a completed job are published once, with one usage event and one run;
    - when one message in a batch fails, only it is reported, it succeeds on the next receive, and the poison message
      keeps failing (it ends in the dead-letter queue);
    - the scheduled sweep publishes a job whose summary never came;
    - other routes (`/healthz`, the setup redirect) answer through the adapter.
- **One existing test was fixed.** `results.test.ts` "no summary at all" used a fixed completion time
  (`2026-11-18T10:03Z`). After 10:13 UTC on that date, the sweep found the job old enough, and the test failed (it
  failed on this branch before any change). It now uses times relative to now.

## 2. Infrastructure as code (`infra/github-app/`): AWS CDK in TypeScript

**Why CDK and not SAM:**

- `infra/` in this repository is already CDK in TypeScript, with cdk-nag.
- The service is TypeScript, and `NodejsFunction` bundles it with esbuild locally (no Docker).
- The EC2 runner, its VPC and its IAM are first-class in CDK. SAM targets the serverless half and would add a second
  toolchain (SAM CLI).
- The CDK app runs on Node's own TypeScript support (no ts-node, no jest), like the service.

**What the stack holds (one stack, `fenvix-prod-github-app`):**

- **Three Lambdas:** `http` (512 MB, 29 s), `worker` (512 MB, 120 s; SQS batch 5, max concurrency 2) and `sweep`
  (256 MB, 300 s). All are Node 22 on x86_64, bundled as ESM, with source maps.
- **SQS:**
  - the work queue: visibility 720 s, which is 6 × the worker's timeout;
  - a dead-letter queue after 5 receives, kept 14 days;
  - SQS-managed encryption on both, TLS required;
  - a CloudWatch alarm when the dead-letter queue is not empty, with an optional email.
- **The sweep schedule:** EventBridge **Scheduler**, `rate(1 minute)`. Its free tier (14M per month) is the price AWS
  states. The page says nothing about scheduled rules on the default bus.
- **The custom domain:** API Gateway HTTP API on `github.fenvix.dev`.
  - ACM certificate, validated by DNS without Route 53: the record is added in Cloudflare.
  - TLS 1.2.
  - The `execute-api` URL is **disabled**, so only the custom domain answers.
  - Stage throttling: 50 rps, burst 100. Access logs are on.
- **Secrets:** SSM Parameter Store SecureString, under `/fenvix/prod/github-app/`. Standard parameters cost nothing;
  Secrets Manager would cost $0.40 per secret-month. The stack never creates the parameters or reads their values.
- **Least privilege:**
  - Each Lambda has its own role, with no managed policy.
  - Each role holds `logs:CreateLogStream`/`PutLogEvents` on its own log group, and `ssm:GetParameters` on its exact
    parameter ARNs. `http` gets 7 of them; `worker` and `sweep` get only `database-url` and `private-key`.
  - `http` may `sqs:SendMessage` and `s3:PutObject` on `work/*`. `worker` gets the SQS consume grant and
    `s3:GetObject`/`DeleteObject` on `work/*`.
  - The Scheduler role may only invoke the sweep.
- **Logs:** all 4 log groups are kept **14 days**.
- **cdk-nag (AwsSolutions):** 0 non-compliant. 9 rule IDs are suppressed, each with its reason in `lib/nag.ts`:
  - APIG4: authorization is in the function (HMAC signature, runner token, Supabase JWT);
  - L1: Node 22 is the runtime the service is tested on;
  - S1: the overflow bucket's objects are transient;
  - VPC7, EC28, EC29: one replaceable runner machine;
  - IAM4: `AmazonSSMManagedInstanceCore`, for Session Manager;
  - IAM5: the log-stream `:*` suffix and the random `work/*` keys.
- **One deploy command:** `cd infra/github-app && npm run deploy` (`scripts/deploy.sh`). It runs these steps:
  1. checks Node ≥ 22.18, the AWS account, and that the 6 required SSM parameters exist (names only);
  2. installs, typechecks and unit-tests the service, and runs the infra tests;
  3. keeps the runner's AMI (on the first deploy it picks the current Ubuntu 24.04 AMI, and afterwards reads the
     stack's `RunnerAmiId`, so a new Canonical image never replaces the machine);
  4. shows `cdk diff` and asks y/N;
  5. deploys. While CloudFormation waits for the certificate, it prints Cloudflare record 1; at the end it prints
     record 2.
- **The exact Cloudflare records:** ACM generates the validation CNAME's name and value when the certificate is
  requested, so no one can know them before the deploy. `scripts/dns-records.sh` reads them from ACM and CloudFormation
  and prints them in Cloudflare's own terms:
  - record 1: `CNAME`, Name `_<hash>.github`, Target `_<hash>.<...>.acm-validations.aws`, DNS only. Keep it, because
    renewals use it;
  - record 2: `CNAME`, Name `github`, Target `d-<id>.execute-api.eu-west-1.amazonaws.com` (output `DnsTarget`), DNS
    only.
- **Deploy permissions:**
  - `deploy-policy.json` (the deployer): assume the three CDK bootstrap roles; read this stack; ACM list/describe;
    write `/fenvix/prod/github-app/*` and `/fenvix/prod/runner/*`; read this stack's logs; Session Manager on the
    instance tagged `component=github-app`. It holds no IAM, Lambda or EC2 write permission.
  - `cfn-exec-policy-app.json` and `cfn-exec-policy-edge.json`: what CloudFormation may do, given to `cdk bootstrap`.
    They are split because IAM caps one managed policy at 6,144 characters. Names are scoped to
    `fenvix-prod-github-app-*`. They deny any EC2 inbound rule, restrict instance types, and allow `PassRole` only to
    Lambda, EC2 and Scheduler.

## 3. The runner machine (EC2)

- **Instance:** t3.medium, Ubuntu 24.04 (Canonical's SSM parameter, then pinned), 30 GB gp3 encrypted, and IMDSv2 only
  with hop limit 1. CPU credits are set to "standard", so there is never a surplus-credit charge.
- **Network:** its own VPC, one public subnet, **no NAT gateway** and no inbound rule. Outbound is TCP 443 and 80 only
  (80 for Ubuntu's mirrors). There is no SSH; use Session Manager.
- **User data:** the settings, plus the 9 files gzip+base64 (about 10 KB of the 16 KB limit). It then runs `setup.sh`,
  which installs tools (git, curl, **strace**, build-essential, python3, iptables, the AWS CLI snap) and creates two
  users:
  - `fenvix`, which runs the runner and the jobs;
  - `fenvix-post`, which alone holds `RUNNER_TOKEN`.
- **Metadata blocked for both users:** `fenvix-imds-block.service` adds iptables owner-match rules. Without them, job
  code could take the instance role's credentials and read the token.
- **ptrace:** `kernel.yama.ptrace_scope=1`, so `strace -f` works on a job's own children. Setup checks this as `fenvix`
  and logs "strace -f as fenvix: ok". **No ambient `CAP_SYS_PTRACE` is granted.** It would let job code attach to the
  poster, which holds the token. Tracing children (what `fenvix-run` does) needs no capability. Docker is not
  installed, so a container's `--cap-add SYS_PTRACE` does not apply.
- **Bootstrap:** it clones `Mircoguidetti/fenvix-engine-cli` at the pinned commit `4391eb0` (setting
  `engineCliCommit`) and runs `runner/bootstrap.sh install` as `fenvix`. Then it runs `installdependencies.sh` as
  root, because the bootstrap tries `sudo`, which `fenvix` does not have.
- **`fenvix-runner.service`** runs `ExecStartPre=+fenvix-register`, then `bootstrap.sh run`, with `Restart=always`. It
  starts at boot and needs no re-registration.
  - `fenvix-register` waits for `/fenvix/prod/runner/registration-token`, registers with `bootstrap.sh register`, then
    **deletes the token**: the file is shredded and the SSM parameter deleted, even if registration failed (expired
    token).
  - The machine role may `GetParameter` on that token and on `runner-token`, and `DeleteParameter` on the registration
    token only.
- **Summaries:**
  - The GitHub runner's job-completed hook (`ACTIONS_RUNNER_HOOK_JOB_COMPLETED`) puts the job's
    `$RUNNER_TEMP/fenvix/summary.json` in a spool directory, with the job's ids. It never fails the job.
  - `fenvix-summary-poster.service` (user `fenvix-post`; ProtectSystem=strict, NoNewPrivileges) POSTs it to
    `https://github.fenvix.dev/v1/runner/summaries`. It sends the **machine's** runner name, whatever the job says, and
    `Authorization: Bearer` with the token read from SSM by root at start.
  - On 2xx the file is removed. On 4xx it is moved to `rejected/`. On 5xx or a network error it is retried.

## 4. The App's rows against `src/data/ci-rows.ts` on main

The merge base of this branch is main's head (`8f25a58`), so `src/data/` here is main's.
`tests/integration/dashboard-contract.test.ts` loads the dashboard's own `mapRun`/`mapProject`, runs them over the rows
the App wrote, and checks the result field by field.

**`ci_runs` (written by `insertRun`, read by `mapRun`):**

| Column → Run field | App writes | Status |
|---|---|---|
| `id`, `project_id`, `number` | default uuid; project; max+1 per project | ok |
| `engine_run_id` → `engineRunId` | not written (null) | ok: the summary has no engine run id |
| `commit_sha`, `commit_message`, `branch`, `pull_request` | head SHA, first line of the commit message, `head_branch`, PR number or null | ok |
| `trigger` | the run's event, mapped into the 5 allowed values | ok |
| `status` | `passed` / `failed` / `cancelled` | ok. `running` is never written (gap below) |
| `pushed_at`, `started_at`, `finished_at`, `duration_ms` | from the push event and the job | ok (180 s job → 180000) |
| `tests_total/ran/passed/failed/skipped/flaky_defects` | from summary.json | ok: passed + failed + skipped = total, ran + skipped = total |
| `test_time_ran_ms`, `test_time_skipped_ms`, `other_step_minutes` | from summary.json and the job | ok |
| `skip_share`, `minutes_saved`, `github_equivalent_minutes` | generated by Postgres | ok (checked against the written values) |
| `engine_version`, `seed` | from summary.json; seed not written | ok |
| `skip_misses` → `skipMisses` | `not_reused_reasons` | ok: the engine's kinds (`new`, `code`, `failed-before`, `clock`, ...) are the dashboard's `MissKind` |
| `miss_details` | not written (default `[]`) | gap below |

**`ci_projects` (read by `mapProject`):** `full_name`, `language`, `test_runner`, `default_branch`, `installation_id`,
`setup_state` (`app_installed` → `pr_open` → `active`), `setup_pr_number/url/state` and `connected_at` are all ok.
The `baseline_*` columns are not written (null), so `baseline` is null; see the gaps below.

**`ci_subscriptions.github_account`** (read by `getGitHubConnection`): set by `gh_link_installation`. ok.

**`ci_usage_events`:** **main does not read this table.** Usage and billing on main are computed from `ci_runs`
(`usageFrom`, `billingFrom` count every run row). Whether the event points at the right run and month is checked by
the contract test (`ci_run_id`, `project_id`, `month`).

**Mismatches fixed on this branch** (in `src/service.ts`):

1. **A job cancelled before it started on our machine got a `ci_runs` row.** The dashboard counts it as a used run,
   while its usage event says `billable: false`. It now gets no run row, so the dashboard's run count and the
   billable usage events agree. Test: `results.test.ts` "cancelled before it started".
2. **A Node repository whose test runner was not detected** (e.g. `npm test`) got a project labelled `node` +
   `pytest` from its first summary. The run's runner now applies only to its own language, and the project waits
   until its runner is known. Test: the contract test, second case.

**Gaps, not fixed** (they need product decisions or other branches):

- `status = 'running'` is never written: a run appears on the dashboard only when it ends. The "live activity" on main
  shows nothing while a job runs.
- `miss_details` (the "why tests ran" detail lines) and the `baseline_*` columns ("before fenvix") stay empty.
- **Runs before linking:** a run that ends before its installation is linked to an organization has a usage event, and
  linking gives the event its organization, but it has no `ci_runs` row. The dashboard (which counts `ci_runs`) does
  not show those runs. Billing from `ci_usage_events` would count them.
- **Month boundary:** usage events are dated by completion (`occurred_at`), and the dashboard's month by `started_at`.
  A job crossing midnight on the 1st can land in two different months.

## 5. Docs and cost

- **`docs/DEPLOY-AWS.md`:** 28 numbered steps, one action each:
  - A, secrets and the test repository: random values, the test repository, the GitHub App form with Callback URL
    `https://github.fenvix.dev/github/setup` and Webhook URL `https://github.fenvix.dev/webhooks/github`;
  - B, Supabase: 0013, the role password, the **session pooler** URL (Lambda has no IPv6 for the direct host);
  - C, AWS account: the two execution policies, `cdk bootstrap`, the deploy identity (IAM Identity Center or an IAM
    user);
  - D, secrets in SSM: commands that keep values out of shell history;
  - E, deploy: settings, `npm run deploy`, the two Cloudflare records, the checks;
  - F, the runner: setup watch, registration token;
  - G, the first onboarding PR, the run on the EC2 runner, linking by SQL for the dashboard, and the first PR comment;
  - a "When something fails" table.
- **Cost:** every price is DECLARED, read on 2026-11-18. **≈ $40.02 a month without free tiers, ≈ $39.58 with them,
  at ~100 jobs a month.** 99% of it is the always-on machine: t3.medium $33.29, 30 GB gp3 $2.64, public IPv4 $3.65.
  The serverless half is under $0.50.
- **Price source:** the aws.amazon.com pricing pages load their regional numbers from a data host this container's
  proxy refused, so the regional prices were read from AWS's official Price List API
  (`pricing.us-east-1.amazonaws.com`, with SKU and publication date). The pages themselves were read for free tiers,
  metering units and flat prices. `DEPLOY-AWS.md` says this line by line. The SNS email price was not read (an email
  alert is optional).

## Tests run (all green)

| Where | Command | Result |
|---|---|---|
| `github-app/` | `npm test` (typecheck, unit, integration against Postgres 16 with migrations 0001–0013 applied twice) | 46 unit + 48 integration pass (before this work: 34 + 37, one of which was failing on the clock) |
| `infra/github-app/` | `npm test` (typecheck + 4 test files) | 24 pass: template assertions (IAM per function, SQS, Scheduler, API, certificate, logs, EC2, user data round trip under 16 KB), cdk-nag clean, the three bundles load in Node and export `handler`, runner scripts (bash -n, **shellcheck**, hook → spool → poster against a local HTTP server: ids, runner name, token, retry on 5xx, rejected/ on 4xx), settings validation, policy files (size, account and region, every resource type covered) |
| `infra/github-app/` | `npx cdk synth --quiet` with sample settings | exit 0; 0 non-compliant in the cdk-nag report; no AWS call needed (zones and AMI need no lookup) |
| `lib/runner/files/*.service` | `systemd-analyze verify` | no finding |
| `scripts/deploy.sh` | run with a stub `aws` CLI, answering N | steps 1–4 work (account, parameters, install and tests, AMI pick); stops at `cdk diff`, which needs credentials |

## Not verified (needs an AWS account, or a real machine)

- **The deploy itself:**
  - CloudFormation's execution policies are written from the template's resource types, not from a real deploy run;
    a missing action shows up as `not authorized to perform: <action>`, which `DEPLOY-AWS.md` covers;
  - the ACM wait and the Cloudflare records;
  - the API Gateway custom domain.
- **The runner machine's first boot:** `setup.sh` passes shellcheck and its parts were tested in isolation, but it has
  never run on Ubuntu 24.04 on EC2. The `snap install aws-cli`, the iptables owner rules, `bootstrap.sh install` as a
  non-root user, and `installdependencies.sh` are all unverified there.
- **SQS idle polling:** the Lambda SQS trigger's idle polling volume (≈ 657,000 requests a month) is an estimate.
- **Supabase session pooler with the restricted role:** the `fenvix_github_app.<ref>` user and the `statement_timeout`
  startup parameter. The integration tests use a local Postgres.
- **KMS:** reading SecureString parameters is assumed to need no `kms:Decrypt` grant with the default `aws/ssm` key. If
  a function logs `AccessDeniedException ... kms`, grant `kms:Decrypt` on that key with `kms:ViaService =
  ssm.eu-west-1.amazonaws.com`.

## Worth knowing

- **Jobs that run plain `pytest` produce no `summary.json`.** The onboarding PR changes only `runs-on`. A customer job
  that runs plain `pytest` lands on our machine but writes no `summary.json`, so its check says "No fenvix summary"
  after 10 minutes. Today the engine runs only when the job calls `fenvix-run` (as in the engine repo's demo
  workflows). `DEPLOY-AWS.md` step 27 gives the two steps to use for the first end-to-end test. Running customers'
  plain `pytest` inside the engine without changing their workflow is not done anywhere yet.
- **Installing from GitHub directly carries no organization.** The dashboard on main does not yet call
  `/v1/github/install-link` (it still says "not set up"), so an installation made from GitHub's own page has no signed
  organization. `DEPLOY-AWS.md` step 26 links it with one SQL call.
- **The runner token can be read from the job.** The job-completed hook runs as the job user, so a job could put a
  forged `summary.json` for its own run. It cannot read `RUNNER_TOKEN`, cannot reach the instance role, and cannot
  claim another runner's name. The App accepts a summary only for a job GitHub reported on that runner.
- **One machine serves one repository or organization** (`runnerScopeUrl`). Per-customer just-in-time runners are
  Block 4 part 2.
- **Region `eu-west-1` and account `865859654353`** come from the existing `infra/cdk.json`.

## Commits on `claude/github-app`

- `b626c61` github-app: AWS Lambda mode (queue hand-off, worker, sweep, SSM secrets) and its tests; the clock-dependent
  test fixed.
- `c0258e7` github-app: the rows checked against the dashboard's reader, and the two fixes.
- `0fa0659` infra/github-app: the CDK stack, the runner machine, the deploy command, the policies, 24 tests.
- (this commit) docs: `DEPLOY-AWS.md`, this report, the READMEs, the execution policy additions.
