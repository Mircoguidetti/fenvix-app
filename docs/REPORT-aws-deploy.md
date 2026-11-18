DONE

# Report: the GitHub App on AWS Lambda, the runners on EC2 (branch `claude/github-app`)

> **Updated after review R-012** (`docs/REVIEW-R-012.md` on `claude/review-r012`; fixes in
> `docs/REPORT-aws-deploy-2.md`). The statements below that the review proved wrong are corrected in place and marked
> **(R-012)**. In short: runners are c6i.large, not t3.medium "standard"; no runner machine reads any secret (each gets
> its own credentials in its user data); one cache organization per customer installation; every role carries a
> permissions boundary; the image build machine is denied every `/fenvix/*` parameter; demo-down terminates before it
> deregisters; the customer-mode fallback is nested virtualization on the same C7i, not a metal host.

**Updated for the founder's final hosting plan** (sent through the coordinator; it replaces the two earlier requests):

1. **Demo mode is the default, and is built** (section 3c).
   - `scripts/demo-up.sh` starts one fresh c6i.large **(R-012)** from the prebuilt runner image and registers it
     through the App on `demoRepository` only **(R-012)**; `scripts/demo-down.sh` terminates it, then deregisters it
     **(R-012)**.
   - Each demo gets a new machine and disk, so no data is shared between demos.
   - Lambda, the App and the dashboard stay up.
2. **Per-job mode is kept as an option** (section 3b): one EC2 machine per queued job, with the shared cache.
3. **Customer mode is a design and a spike, not built** (section 3d): one c7i.xlarge per host, each job in its own
   Firecracker microVM through the Nitro Sandboxes backend (Firecracker v1.18.0), destroyed after the job; KVM Firecracker
   with nested virtualization on the same C7i as the fallback **(R-012; was a `.metal` host)**; Docker inside the job
   checked.
4. **No Docker-per-job path.**
5. **The always-on machine (and its stop/start scripts) is removed**; demo mode replaces it.

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

- **Lambdas:** `http` (512 MB, 29 s), `worker` (512 MB, 120 s; SQS batch 5, max concurrency 2), `sweep` (256 MB,
  300 s), and in per-job mode `reaper` (256 MB, 60 s; every 10 minutes). All are Node 22 on x86_64, bundled as ESM,
  with source maps.
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
  - IAM4: `AmazonSSMManagedInstanceCore`, for Session Manager on the image build machine only, with an explicit Deny
    on every `/fenvix/*` parameter **(R-012 F5)**;
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

## 3. The runner machines (EC2)

### 3a. What every runner machine has (both modes)

- **Instance:** c6i.large **(R-012 F8: a T3 in "standard" mode gets no launch credits and would run at its 20%
  baseline)**, Ubuntu 24.04 (Canonical's SSM parameter, then pinned), 30 GB gp3 encrypted, and IMDSv2 only with hop
  limit 1. A T3 type, if chosen, runs "unlimited".
- **Network:** its own VPC, one public subnet, **no NAT gateway** and no inbound rule. Outbound is TCP 443 and 80 only
  (80 for Ubuntu's mirrors). There is no SSH; use Session Manager.
- **User data:** the settings, plus the 9 files gzip+base64 (about 10 KB of the 16 KB limit). It then runs `setup.sh`,
  which installs tools (git, curl, **strace**, build-essential, python3, iptables, the AWS CLI snap) and creates two
  users:
  - `fenvix`, which runs the runner and the jobs;
  - `fenvix-post`, which alone holds the machine's own summary credential **(R-012 F1: no machine holds
    `RUNNER_TOKEN` any more; the machines' role has no permission)**.
- **Metadata blocked for both users:** `fenvix-imds-block.service` adds iptables owner-match rules. Without them, job
  code could take the instance role's credentials and read the token.
- **ptrace:** `kernel.yama.ptrace_scope=1`, so `strace -f` works on a job's own children. Setup checks this as `fenvix`
  and logs "strace -f as fenvix: ok". **No ambient `CAP_SYS_PTRACE` is granted.** It would let job code attach to the
  poster, which holds the token. Tracing children (what `fenvix-run` does) needs no capability. Docker is not
  installed, so a container's `--cap-add SYS_PTRACE` does not apply.
- **Bootstrap:** it clones `Mircoguidetti/fenvix-engine-cli` at the pinned commit `4391eb0` (setting
  `engineCliCommit`) and runs `runner/bootstrap.sh install` as `fenvix`. **(R-012 F5: it no longer runs `installdependencies.sh`
  as root; the runner's libraries are installed by name, and nothing writes as root into the job user's files.)** It
  used to run `installdependencies.sh` as
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

### 3b. One machine per job (option, `runnerMode: per-job`)

- **Trigger:** on `workflow_job.queued` with the fenvix label, the worker (`src/service.ts` `launchRunner`) starts one
  machine. The guards:
  - only for an installation **linked to an organization**, not suspended and not deleted, so a stranger who
    installs the public App cannot start machines;
  - only while the job is still queued: a late `queued` event after `in_progress` starts nothing.
- **Steps:**
  - It asks GitHub for a just-in-time runner:
    `POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig`, name `fenvix-j<job id>`, label `fenvix`, default
    group. On a retry, a 409 (name taken) gets a fresh name.
  - It starts one EC2 from the launch template and the newest image tagged `fenvix:image=runner`
    (`src/runners/launcher.ts`). The client token is `fenvix-job-<id>`, so a job delivered twice gets one machine; a
    retry that finds the machine already started is treated as done.
  - The user data (root only) holds the machine's settings and the just-in-time configuration. It then starts
    `fenvix-job.target`: the poster, the just-in-time runner and the idle watchdog.
- **GitHub permission: repository "Administration: Read and write"**, which GitHub requires for `generate-jitconfig`.
  It was added to the App form in `DEPLOY-AWS.md` and `GITHUB-APP.md`. The organization alternative ("Self-hosted
  runners: Read and write") was not chosen: it does not work for personal accounts, and its runners could take jobs
  of any repository in the organization.
- **One job, then gone:**
  - `run.sh --jitconfig` takes exactly one job.
  - `ExecStopPost` gives the poster up to 2 minutes to send the summary, then powers off. The shutdown behaviour
    "terminate" deletes the machine and its disk.
  - If no job started within 20 minutes (the job was cancelled, or another machine took it), the watchdog powers the
    machine off.
  - The **reaper** Lambda (every 10 minutes) terminates any machine tagged `fenvix:role=runner-job` older than 6 hours.
    It may terminate only that tag.
- **Fleet limit:** at most 4 machines pending or running. Beyond that, the delivery fails, SQS retries it every 12
  minutes (5 times), then it goes to the dead-letter queue and the alarm fires.
- **Prebuilt image:** EC2 Image Builder (`lib/runner-fleet.ts`).
  - The component runs `install.sh`: tools, strace, users, the metadata block, uv, Python, Rust, the engine wheel
    through `runner/bootstrap.sh install`, the GitHub runner and the hooks. (Since demo mode, the files are one
    gzipped bundle: the document is 9,329 of 16,000 characters.)
  - The parent image is Ubuntu 24.04, through Canonical's SSM parameter.
  - The resulting AMI is tagged `fenvix:image=runner`.
  - `scripts/build-image.sh` starts the build and waits for it.
- **Shared cache:** the engine's own `detpy.cache_service`, from `claude/shared-cache` at `a20b93d`, vendored byte for
  byte with its SHA-256 checked by a test. It runs on a **t4g.nano** at the fixed private address 10.42.0.10, with no
  public address and no outbound route. Only the runners' security group can reach port 8787, and HTTP is allowed
  inside the VPC (`FENVIX_CACHE_ALLOW_HTTP=1`).
  - **Why not Lambda + S3:** the service stores in SQLite in WAL mode, which does not work on EFS, and its client
    sends batches of up to 16 MB, against API Gateway's 10 MB and Lambda's 6 MB. Lambda would mean rewriting its
    storage and batching in the engine repository, which this session cannot change.
  - **Tokens (superseded, R-012 F3):** per-job tokens signed by the worker for one customer installation's
    organization (`scripts/cache-key.sh`, `lib/cache/fenvix_cache_auth.py`) replace the two static tokens. Before:
    `scripts/cache-tokens.sh` created two tokens in SSM. Only their SHA-256 goes into `cdk.json` and onto
    the cache machine.
  - **Which token a job gets:** the worker gives the **write** token only to trusted refs (a push, schedule, manual or
    merge-queue run on the default branch, from the repository itself, read from the workflow run). Pull requests,
    forks and other branches get the read-only one.
  - **Hand-off:** `fenvix-jit-prepare` (root) writes the chosen token as the file that `fenvix-run` reads once and
    deletes.
  - `engineCliCommit` is now `a20b93d` (the shared-cache client). `bootstrap.sh` is identical to the old pin.
- **Job machine role:** read only `runner-token` and the two cache tokens. The job user cannot reach the metadata
  service, so it cannot use the role.
- **Worker's EC2 rights:** `RunInstances` only from our launch template, our own images (`ec2:Owner`), and with the
  request tag `fenvix:role=runner-job`. `CreateTags` only at launch. `PassRole` only for the job role, to EC2. No
  `TerminateInstances`.
- **Time from queued to the first test: ESTIMATE, not measured** (no AWS account). The job starts ≈ 45–75 s after it
  is queued, and the first test runs ≈ 1–2.5 minutes after, depending on the project's install. `DEPLOY-AWS.md` gives
  the breakdown and how to measure it on the first real job.
- **Monthly cost** (prices DECLARED, read 2026-11-18; usage ESTIMATED with 10 machine-minutes per job):

  | Jobs per month | 0 | 100 | 1,000 |
  |---|---|---|---|
  | Without free tiers | ≈ $4.79 | ≈ $6.46 (R-012) | ≈ $21.66 (R-012) |
  | With free tiers | ≈ $4.36 | ≈ $5.26 | ≈ $13.40 |

  - The fixed part is the cache machine ($3.36 + $0.70 disk) and the image snapshot (≈ $0.30).
  - A job costs ≈ $0.0166 **(R-012)**: c6i.large per second, $0.0912 an hour; IPv4, $0.005 an hour; 30 GB gp3.

### 3c. Demo mode (default, `runnerMode: demo`)

- **`demo-up.sh [owner/repo]`:**
  1. reuses the newest runner image, or builds it once with `build-image.sh`;
  2. invokes the `demo` Lambda (`src/runners/demo.ts`), which:
     - finds the App's installation on the repository (`GET /repos/{o}/{r}/installation`, as the App);
     - gets a registration token (`POST .../actions/runners/registration-token`; repository permission
       **Administration: Read and write**);
     - starts one machine from the launch template and the image, tagged `fenvix:role=runner-demo`, with the token in
       root-only user data;
  3. polls `status` until GitHub shows the runner `fenvix-demo-<time>` online.
- **On the machine:** `fenvix-register` takes the token from `/etc/fenvix/registration-token`, shreds it, and
  registers. `fenvix-runner` serves jobs.
- **Repeated `up`:** a second `up` returns the same machine; an `up` for another repository while one runs is refused.
- **`demo-down.sh`:** deregisters every `fenvix-demo-*` runner of the repository (`DELETE .../actions/runners/{id}`;
  other runners untouched; a busy one is reported) and terminates the demo machines, then waits until they are gone.
- **No data shared between demos:** a new machine and a new disk per demo, and no shared cache. The engine's cache
  lives on the machine's disk, so the second job of the same demo is warm, and it is deleted with the machine.
- **Safety:** the reaper terminates a demo machine older than `demoMaxHours` (12). The demo Lambda reads only the
  App's private key, may start only `runner-demo` machines from our template and our images, and may terminate only
  those. The deployer may invoke only this one function.
- **The image now contains the registration path too.** Its files are bundled as **one** gzipped script, which brings
  the component down from 15,879 to 9,329 of 16,000 characters. The bundle was round-tripped through a real `bash`
  here.
- **Cost** (DECLARED prices; ESTIMATED usage: 10 demos of 2 hours a month): **≈ $2.73 a month without free tiers
  (R-012, c6i.large; it was ≈ $1.81 with a throttled t3.medium),
  ≈ $1.38 with them**; each extra demo hour ≈ $0.054.

### 3d. Customer mode: design and spike (`docs/DEPLOY-AWS.md` "Customer mode", `infra/customer-mode/spike/`)

**Read today:**

- Firecracker v1.18.0's changelog and its `docs/nitro-sandboxes/` (README, getting started, how it works, features,
  comparison with KVM).
- Its API description (`swagger/firecracker.yaml`, with `PUT /enclave` and `EnclaveConfig`).
- Its CI guest kernel configs.
- AWS's Nitro Enclaves and Nitro Sandboxes pages, on instance types and price. T3 and metal instances are excluded; a
  c7i.xlarge is supported; there is no additional charge.

**Design:**

- The worker sends a just-in-time config per job to a host queue; this is the `RunnerLauncher` interface, already
  used by per-job mode.
- A host agent on each c7i.xlarge copies the guest disk (reflink), writes a job disk (jitconfig in, summary out),
  starts a sandbox (direct mode, CPU overcommit, 2 vCPUs, 2 GiB), and reads and sends the summary with the **host's**
  runner token, so the guest never holds it. It then deletes everything.
- Sandboxes are firewalled from the parent, its metadata service and each other.
- The shared cache uses one organization and token pair per customer.
- Capacity is about 3 concurrent 2-vCPU, 2 GiB jobs per c7i.xlarge (ESTIMATE; memory is donated whole).

**Spike, checked here:**

- The scripts (`host-setup.sh`, `build-guest.sh`, `run-job.sh`, `guest/fenvix-guest-job`) pass shellcheck.
- `run-job.sh`'s configuration is **valid against Firecracker 1.18.0's own API description**, and an invalid value is
  refused (`validate-config.mjs`).
- **Docker in the microVM:** our own `guest-kernel-docker-check.sh` on Firecracker's CI x86_64 6.18 guest kernel
  config plus its EFI fragment finds **every required option present** (0 missing); only the optional IP_VS, MACVLAN
  and IPVLAN are absent. Docker needs no virtualization inside the guest, so the same answer holds for the KVM `.metal`
  fallback.
- Running moby's own `check-config.sh` was blocked here, because executing a downloaded script was not allowed; the
  list in our script is written from Docker's documented requirements.
- **Nothing ran on a real host:** this container has no `/dev/nitro_enclaves` and no `/dev/kvm`.

**Must be tested on a real c7i.xlarge before the first customer** (the full list is in DEPLOY-AWS.md): start time per
job (20 runs, by stage, target ≈ 30 s); isolation, from inside a guest and between two concurrent jobs; Docker
(`hello-world`, `services: postgres`, testcontainers, compose, pull times and a registry mirror); `strace -f` and the
shared cache from the guest; concurrency and cost per host; hang and reboot handling; and the limits of Nitro
Sandboxes (no snapshots or pause, no virtio device reset, no memory overcommit).

**Cost per host** (DECLARED, read 2026-11-18): c7i.xlarge $0.19152 an hour, ≈ **$147.86 a month** with disk and
IPv4. **(R-012 F16)** The fallback is KVM Firecracker with nested virtualization on the same type, at the same price
(it was c5n.metal at $4.392 an hour, ≈ $3,214.21 a month). A c7i.xlarge runs one 2-vCPU job at full speed (the
parent keeps one of its two cores); plan a c7i.2xlarge (≈ $287.67 a month) for three.

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

- **`docs/DEPLOY-AWS.md`:** 29 numbered steps, one action each, plus section H for the per-job option and a section on
  customer mode.
  - A, secrets and the test repository: random values, the test repository, the GitHub App form (Callback URL
    `https://github.fenvix.dev/github/setup`, Webhook URL `https://github.fenvix.dev/webhooks/github`, now with
    **Administration: Read and write**);
  - B, Supabase: 0013, the role password, the **session pooler** URL (Lambda has no IPv6 for the direct host);
  - C, AWS account: the three execution policies, `cdk bootstrap`, the deploy identity;
  - D, secrets in SSM, and the cache tokens;
  - E, deploy: settings, `npm run deploy`, the two Cloudflare records, the checks;
  - F, the runner image: `scripts/build-image.sh`;
  - G, the first onboarding PR, linking (required before any machine starts), the first job machine, the first PR
    comment, and reuse across machines through the shared cache;
  - G is now a demo (demo-up, onboarding PR, a PR comment, demo-down), H is the per-job option, and a section
    covers customer mode;
  - a "When something fails" table, why the cache is not on Lambda, the time to the first test (ESTIMATE), and the
    monthly cost.
- **Cost:** every price is DECLARED, read on 2026-11-18. With a job machine ≈ 10 minutes per job:

  | Jobs per month | 0 | 100 | 1,000 |
  |---|---|---|---|
  | Per-job mode, without free tiers | ≈ $4.79 | ≈ $6.46 (R-012) | ≈ $21.66 (R-012) |
  | Per-job mode, with free tiers | ≈ $4.36 | ≈ $5.26 | ≈ $13.40 |

  Demo mode (default) costs ≈ $2.73 a month without free tiers (10 demos of 2 hours; R-012); customer mode costs ≈ $147.86
  a month per c7i.xlarge host.
- **Price sources:** the aws.amazon.com pricing pages load their regional numbers from a data host this container's
  proxy refused, so the regional prices were read from AWS's official Price List API (`pricing.us-east-1.amazonaws.com`,
  with SKU and publication date). The pages themselves were read for free tiers, metering units, per-second billing
  and flat prices. Not read:
  - the SNS email price (the email alert is optional);
  - the Image Builder pricing page (HTTP 404; the product page says "no cost, other than the cost of the underlying
    AWS resources");
  - whether Lambda's free tier is permanent (no page says).

## Tests run (all green)

**After review R-012** (details in `docs/REPORT-aws-deploy-2.md`): github-app **58 unit + 68 integration pass**;
infra/github-app **51 pass** (with cdk-nag; `CdkNagValidationFailure` gone in per-job mode); `cdk synth` exit 0 in demo
and per-job mode. The table below is the state before the review.

| Where | Command | Result |
|---|---|---|
| `github-app/` | `npm test` (typecheck, unit, integration against Postgres 16 with migrations 0001–0013 applied twice) | **52 unit + 61 integration pass**; the demo tests (`tests/integration/demo.test.ts`) cover up, the same machine again, another repository refused, status, down (only demo runners, busy reported), the App not installed, user data refusing injection, and REAP parsing, with every GitHub call checked against the OpenAPI description (before this work: 34 + 37, one of which was failing on the clock). The per-job tests: `tests/unit/runners.test.ts` (user data, launch input, client token, limit, idempotent retry, reaper, settings) and `tests/integration/runners.test.ts` (linked-only, one just-in-time runner and one machine per job, write/read cache by trust, late `queued` ignored, limit → retry with a fresh name, every GitHub call checked against the OpenAPI description, no runner online: queued jobs neither failed nor billed) |
| `infra/github-app/` | `npm test` (typecheck + 7 test files) | **35 pass**, in demo (default) and per-job mode; they include the demo function's rights, the reaper per mode, the image bundle round trip, and the customer-mode spike (shellcheck, a valid sandbox configuration, the Docker kernel check): template assertions; per-job (worker launch rights and conditions, reaper, launch template, job role, Image Builder component under the limit, cache machine private with inbound from runners only); cdk-nag clean; the four bundles load; the runner scripts (bash -n, **shellcheck**, hook → spool → poster); the **vendored cache service run locally with the stack's `tokens.json`** (write token records, read token gets 403 on write, unknown token 401); settings; the policy files cover every resource type of both modes |
| `infra/github-app/` | `npx cdk synth --quiet` with sample settings, demo and per-job | exit 0 in both; cdk-nag 0 non-compliant. CloudFormation's own validation found a real bug (Image Builder's untyped `AmiDistributionConfiguration` keys), now fixed |
| `lib/runner/files/*.service` | `systemd-analyze verify` | no finding |
| `scripts/deploy.sh` | run with a stub `aws` CLI, answering N | steps 1–4 work (account, parameters, install and tests, AMI pick); stops at `cdk diff`, which needs credentials |

## Not verified (needs an AWS account, or a real machine)

- **One machine per job, end to end:**
  - the Image Builder build (`install.sh` on the build machine, through SSM, with Ubuntu's snap SSM agent);
  - the just-in-time runner taking its job;
  - the power-off ending in termination;
  - the idle watchdog and the reaper on real machines;
  - the real start-up time.
- **The cache machine on a real arm64 machine without internet,** and `fenvix-run --cache http://10.42.0.10:8787/...`
  from a job machine. The service and its `tokens.json` were run here (x86, loopback).
- **RunInstances under the worker's conditions:** the `ec2:Owner` condition on images, and the request-tag condition
  on volumes created from a launch template.

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
- **A job's summary is the job's own word.** The job-completed hook runs as the job user, so a job could put a
  forged `summary.json` for its own run. **(R-012 F1)** It cannot reach the machine's credential, and the credential
  is good only for that machine's runner name, repository and run. Do not bill on "minutes saved" or test counts.
- **(R-012 F3, fixed)** One cache organization per customer installation, per-job signed tokens; pull requests are
  read-only within their own organization.
- **The start-up delay in per-job mode** (≈ 1 minute before the job starts) is the price of starting nothing when no
  job runs. A warm, stopped machine or EBS fast snapshot restore would cut it.
- **Region `eu-west-1` and account `865859654353`** come from the existing `infra/cdk.json`.

## Commits on `claude/github-app`

- `b626c61` github-app: AWS Lambda mode (queue hand-off, worker, sweep, SSM secrets) and its tests; the clock-dependent
  test fixed.
- `c0258e7` github-app: the rows checked against the dashboard's reader, and the two fixes.
- `0fa0659` infra/github-app: the CDK stack, the runner machine, the deploy command, the policies, 24 tests.
- `0c7d1c0` docs: `DEPLOY-AWS.md`, this report, the READMEs, the execution policy additions.
- `e2cd1c7` one machine per job, the shared cache machine, the always-on option with stop/start; tests for both
  modes.
- `e58d909` docs for the per-job design.
- `0d82511` demo mode (default): demo-up/down, the demo Lambda, the reaper per mode, the image bundle; always-on
  removed.
- `98cb03e` the customer-mode design and spike, and DEPLOY-AWS.md and this report for the final plan.
- Review R-012 fixes: see `docs/REPORT-aws-deploy-2.md`.
