DONE

# Report 2: review R-012 of the AWS deploy kit, fixed (branch `claude/github-app`)

Review: `docs/REVIEW-R-012.md` on `claude/review-r012` (FIX 18, threat model: the job runs hostile customer code).
The reviewer's two test files are copied onto this branch **unchanged** (byte-identical to `claude/review-r012`):
`github-app/tests/integration/review-r012.test.ts` (5 tests) and `infra/github-app/test/review-r012.test.ts` (11).

- **Before** (this branch at `98cb03e`, the tests copied in): **0 of 16 pass** (5/5 and 11/11 fail).
- **After:** **16 of 16 pass.**

All 18 findings are fixed, highest severity first within the order asked (demo blockers, then per-job and customer
mode). F15, F16, F17 and F18 had no reviewer test; each has a test of mine where code was involved (marked
"own test" below). **Nothing was deployed** (no AWS account). The founder's steps are in `docs/DEPLOY-AWS.md`, which
is updated, as is `docs/REPORT-aws-deploy.md` (wrong statements corrected in place, marked R-012).

## Finding → fix → test (before / after)

Before = failure message on `98cb03e` with the reviewer's test; after = pass.

| # | Sev | Fix | Test | Before | After |
|---|---|---|---|---|---|
| **F5** | High | Image build role: explicit `Deny ssm:GetParameter, GetParameters, GetParametersByPath, GetParameterHistory` on `parameter/fenvix/*` (beats `AmazonSSMManagedInstanceCore`'s Allow on `*`). `install.sh` installs the GitHub runner's libraries **by name** (`libicu74 libkrb5-3 liblttng-ust1t64 libssl3t64 zlib1g`) and never runs `installdependencies.sh`; nothing writes as root into the `fenvix` user's files (the hooks' `.env` is written as `fenvix`; `fenvix-jit-prepare` and `fenvix-register` likewise at boot). Same change in the spike's `build-guest.sh`. The boundary (F4) caps the build role too | reviewer `F5`; own: `stack.test.ts` "the image build machine may read none of our parameters, and runs no file the job user owns as root" | fail: "the build role has AmazonSSMManagedInstanceCore … and no Deny on parameter/fenvix/*" | pass |
| **F8** | Medium | Default `runnerInstanceType` **c6i.large** (not burstable; no credit option); a T3 type, if chosen, runs **unlimited**. AWS re-read: "T8i, T4g, T3a, and T3 instances do not receive launch credits". Timings and every cost recomputed | reviewer `F8`; own: launch template / settings tests | fail: "runner machines are t3.medium with CPU credits {"CpuCredits":"standard"}" | pass |
| **F13** | Medium | `demoRepository` is **required** in demo mode; the demo function passes it as `allowedRepositories`; `demoUp`, `demoDown` and `demoStatus` refuse any other repository ("… is not the demo repository") | reviewer `F13`; own: `demo.test.ts` "only the demo repository: up, down and status refuse any other" | fail: "Missing expected rejection" | pass |
| **F4** | Medium | New `permissions-boundary.json` (`fenvix-prod-github-app-boundary`: no IAM action but `PassRole`; SSM reads only `/fenvix/prod/{github-app,cache}/*` and Ubuntu's public parameters; EC2, SQS, S3, logs, Lambda invoke scoped to the stack). CDK applies it to **every role** (8 of 8 in both modes). `cfn-exec-policy-app.json`: `CreateRole`, `PutRolePolicy`, `DeleteRolePolicy`, `AttachRolePolicy`, `DetachRolePolicy` only with `iam:PermissionsBoundary` = that policy; explicit Deny on removing or rewriting a boundary. `cfn-exec-policy-fleet.json`: parent-image `ssm:GetParameter(s)` scoped to `parameter/aws/service/canonical/*`. DEPLOY-AWS.md step 9 creates the boundary, step 11's false claim is replaced by what is true (the deployer is not an administrator; it does deploy code that reads the App's secrets) | reviewer `F4` ×2; own: boundary file and every role carries it | fail: "IamRolesOfThisStack writes IAM policies without a permissions boundary"; "ssm:GetParameter on * lets CloudFormation's role read …/private-key" | pass ×2 |
| **F7** | Medium | `RunInstances` on `instance/*` needs `ec2:LaunchTemplate` = our template **and** `ec2:InstanceType` = the configured type (plus the role tag); `volume/*` and `network-interface/*` need the launch template too (demo function and worker) | reviewer `F7`; own: `per-job.test.ts`, `stack.test.ts` conditions | fail: "/^DemoRole/: RunInstances on instance/* is conditioned only on ["aws:RequestTag/fenvix:role"] …" | pass |
| **F6** | Low | `demoDown`: terminate → wait until gone → deregister, retrying 422 (busy) for a minute; leftovers reported. The **reaper** (demo mode) deregisters the runner of every demo machine that is shutting down or terminated (it reads the App key for that). Demo function timeout 180 s; `demo-down.sh` read timeout 200 s | reviewer `F6`; own: `demo.test.ts` "the reaper deregisters gone machines' runners" | fail: "still registered after demo-down: fenvix-demo-… is running a job; it is removed when the machine stops" | pass |
| **F1** | High | `src/runners/credentials.ts`: a **per-machine summary credential** `fxr1.<payload>.<HMAC-SHA256>` keyed with `runner-token` (never on a machine), naming the runner name, repository id, and per job the run id, with an expiry. The worker signs one per job machine, the demo function one per demo machine (runner name + demo repository). `POST /v1/runner/summaries` takes the identity **from the credential**; a body naming another runner, repository or run gets 403; the bare fleet token gets 401. `runner-token-previous` still verifies during a rotation | reviewer `F1`; own: `basics.test.ts` (sign/verify, forged payload, expiry, previous key), `results.test.ts` (401 for the fleet key, 403 ×3 for another runner/repository/run), `runners.test.ts` (the job's credential is bound to its runner, repository, run) | fail: "a summary for acme/web's job, sent with the credential of acme/shop's machine, was accepted (202; 1 row stored)" | pass (401) |
| **F2** | High | The job machines' role (`FleetJobRole`) has **no permission**. No machine reads SSM; the AWS CLI is no longer installed on runner machines. Credentials arrive in the user data (root only; the metadata service is blocked for the `fenvix` and `fenvix-post` users): `/etc/fenvix/summary-token` (moved to the poster's private directory by `fenvix-summary-credential`), `/etc/fenvix/cache-token`, the jitconfig or registration token, each shredded after use | reviewer `F2`; own: role has no statement (both modes); worker reads | fail: "the machines' single role can read the write token: […/runner-token, …]" | pass |
| **F3** | High | **One cache organization per customer installation** (`gh-<installation id>`). The worker signs one cache token per job (`fxs1.<payload>.<RSA-SHA256>`: org, write flag, expiry, job) with `/fenvix/prod/cache/signing-key` (SSM, worker only; `scripts/cache-key.sh`). The cache machine holds **only the public key** and runs the vendored `cache_service.py` unchanged behind `lib/cache/fenvix_cache_auth.py`, which accepts only valid, unexpired signed tokens (static `tokens.json` tokens are refused). PRs, forks, other branches: read-only, own org only. `FENVIX_CACHE_URL` ends in the job's org | reviewer `F3`; own: `cache.test.ts` runs the real Python service with tokens from the App's signer: same customer's PR reads but cannot write (403), another customer finds nothing (blobs and keys), expired/forged/other-key/static/no token → 401 | fail: "acme's and globex's pull requests get the same cache organization and token" | pass |
| **F12** | Low | `RunnerLauncher.hasCapacity()` (EC2 launcher) is checked **before** `generate-jitconfig`; if the launch still fails (or EC2 returns the existing machine for a redelivery), the just-in-time runner just registered is **deleted** | reviewer `F12`; own: `runners.test.ts` (retry reuses `fenvix-j908`, no orphan), `hasCapacity` unit test | fail: "just-in-time runners registered with no machine to run them: fenvix-j1003, fenvix-j1003-… ×4" | pass |
| **F14** | Low | The cache instance gets IMDSv2 through a launch template (`requireImdsv2`), so cdk-nag's EC26 finds a template and evaluates (it was throwing on `launchTemplate` undefined). Not suppressed | reviewer `F14`; own: per-job test asserts the instance has a launch template | fail: `CdkNagValidationFailure` on `Cache/Instance` | pass |
| **F9** | High | Spike: the host **never mounts a disk the guest wrote**. Input: a read-only disk the host writes. Output: a raw 16 MiB disk with one length-prefixed record, read in userspace by `read-result.py` as the unprivileged `fenvix-parse`, capped at 8 MiB. Repository, run, attempt and runner name come from the host's job record (`REPOSITORY_ID`, `RUN_ID`, `RUN_ATTEMPT`, `RUNNER_NAME`), never the guest. Cleanup on every exit (`trap`) | reviewer `F9` ×2; own: `runner-scripts.test.ts` "the result reader" (good record, no record, 2 GiB claim refused, guest ids dropped, trap and jailer present) | fail: "run-job.sh mounts the guest's disk without nosymfollow"; "repositoryId/runId/runAttempt come from the guest's 'ids' file" | pass ×2 |
| **F10** | Medium | Spike firewall: every rule on `-i fctap+` (chain `FENVIX-SBX`), `iptables -P FORWARD DROP`, per-TAP source-address rule, `rp_filter=1`, only `169.254.169.253:53` in link-local, no parent port (`INPUT -i fctap+ DROP`), no sandbox-to-sandbox, `disable_ipv6` per TAP plus `ip6tables` DROP, per-sandbox `connlimit` 4,096 and a `hashlimit` on new connections, Firecracker's rx/tx rate limiters, a larger `nf_conntrack_max` | reviewer `F10`; own: config test asserts rate limiters | fail: "rules must match the sandboxes' interfaces (-i fctap+)" | pass |
| **F11** | Medium | `host-setup.sh` stops unless `nitro_enclaves.mempool=` is on `/proc/cmdline` and `mem_pool/total` > 0 (prints the `grubby` + reboot commands); writes **12** slots. README step 0 adds `grubby … mempool=7G@0` and the reboot. AWS re-read: "With a memory pool, the parent instance has 4 slots. Without a pool, it has 0"; slots "grow from 4 in steps of 8 (12, 20, 28 …)" | reviewer `F11` | fail: "host-setup.sh must check nitro_enclaves.mempool= on the kernel command line" | pass |
| **F17** | High | Design and spike: Firecracker runs **under the jailer** (own uid per slot, chroot with only that job's files, cgroup v2 CPU limit, Firecracker's seccomp), never as root; the TAP is owned by the jail's uid; `/dev/nitro_enclaves` is created in the chroot for that uid. The host agent holds no fleet secret: each job's summary credential (F1) travels with the job and is read by `fenvix-post`, which never reads guest bytes; guest bytes are read only by `fenvix-parse`. Parent IMDS hop limit 1. DEPLOY-AWS.md "Customer mode" now states that the parent, not only the Nitro Hypervisor, is the trust boundary | own: `runner-scripts.test.ts` (jailer, trap) | n/a (design) | done in spike and design; **unverified on a real host** (first item of the host test list) |
| **F15** | Medium | Every function reloads its secrets after `SECRETS_TTL_SECONDS` (300 s): `refreshing()` in `lambda/runtime.ts` builds a new app/core, closes the old one after the new one is ready, and keeps serving with the old one if SSM fails. DEPLOY-AWS.md: a rotation procedure per secret (runner-token via `runner-token-previous`), and the "401 → deploy again" advice replaced | own: `lambda.test.ts` "refreshing(): made again after the TTL, the old one closed; a failed reload keeps the old one" | n/a | pass |
| **F16** | Medium | DEPLOY-AWS.md and the first report: the fallback is **KVM Firecracker with nested virtualization on the same C7i** (re-read at docs.aws.amazon.com: C7i supported, "There is no additional cost for using nested virtualization"), ≈ $147.86 per host per month, not c5n.metal at ≈ $3,214.21. Capacity: the driver "keeps the first core of the parent instance for the parent" (re-read), so a c7i.xlarge runs **one** 2-vCPU sandbox at full speed (three only time-sharing 2 cores); **c7i.2xlarge** (≈ $287.67/month) for three | n/a (doc) | n/a | done |
| **F18** | Low | Step 10: `npm ci` first, then `npx --no-install cdk` (the locked CLI). Step 8: the DB password becomes a **SCRAM-SHA-256 verifier** computed locally (`scripts/scram-verifier.mjs`; verified against Postgres 16 here: the right password logs in, a wrong one is refused), so it never enters the SQL editor's history. Removal: demo-down / no job machine first, empty the overflow bucket, then destroy. Image build ≈ $0.08 (45 min of c6i.large, IPv4, disk). API Gateway free tier: accounts created after 2025-07-15 get credits instead. `lib/nag.ts` reasons no longer mention the always-on runner. The request log drops the query string (no OAuth `code` in CloudWatch) | own: `settings-and-policies.test.ts` (verifier format, never the password, ASCII only), `lambda.test.ts` "never logs the query string" | n/a | pass |

## What was run (all in this container)

| Check | Result |
|---|---|
| `github-app`: `npm test` (typecheck, unit, integration against a scratch Postgres 16 with `scripts/prepare-test-db.sh`) | **59/59 unit, 68/68 integration** (was 52 + 61; the 5 reviewer tests are in the 68) |
| `infra/github-app`: `npm test` (typecheck and all tests, with cdk-nag in both modes) | **52/52** (was 35; the 11 reviewer tests are in the 52) |
| Reviewer's files alone | app 5/5, infra 11/11 (before: 0/5, 0/11) |
| `npx --no-install cdk synth --quiet`, demo mode (default) | exit 0; cdk-nag 0 errors, 0 `CdkNagValidationFailure`; 1 CloudFormation-Validate warning (the pinned availability zone, by design) |
| `npx --no-install cdk synth --quiet`, per-job mode (with a fresh cache public key and a pinned cache AMI, as `deploy.sh` does) | exit 0; cdk-nag 0 errors, 0 `CdkNagValidationFailure`; 3 CloudFormation-Validate warnings (the pinned zone ×2, the pinned AMI id, by design) |
| Synthesized templates searched for secrets | none (`PRIVATE KEY`, `fxr1.`, `fxs1.`: 0 hits); 8 of 8 roles carry the boundary, in both modes |
| Cache isolation end to end | the vendored Python service behind the wrapper, with tokens from the App's own signer (`cache.test.ts`) |
| SCRAM verifier | a role created with the verifier logs in with the password and is refused with another (local Postgres 16) |
| AWS documentation re-read (docs.aws.amazon.com, reachable from here) | T3 launch credits (F8), Nitro Sandboxes memory pool, slots and CPU pool (F11, F16), nested virtualization on C7i and its cost (F16) |
| Shell scripts | `bash -n` on every script; **shellcheck was not available** (installing it was not permitted in this session); the tests run it when it is installed |

## Changes to plan for (founder)

- **New one-time steps:** create the permissions boundary (`aws iam create-policy --policy-name
  fenvix-prod-github-app-boundary --policy-document file://permissions-boundary.json`, step 9) before the first
  deploy; set `demoRepository` (now required in demo mode); per-job mode: `bash scripts/cache-key.sh` (replaces
  `cache-tokens.sh`) and put `cacheSigningPublicKey` in `cdk.json`.
- **Cost:** demo mode ≈ **$2.73** a month without free tiers (was $1.81 with a throttled t3.medium); per-job ≈ **$6.46**
  at 100 jobs and ≈ **$21.66** at 1,000 (were $5.70 and $14.06); customer-mode host ≈ $147.86 (c7i.xlarge, 1 job at
  full speed) or ≈ $287.67 (c7i.2xlarge, 3 jobs); fallback at the same price. The c6i.large price ($0.0912/h, SKU
  MY34M56N9KVPBWDG) is the reviewer's Price List reading; the regional price pages still cannot be loaded from this
  container, so please check c6i.large, t4g.nano, c7i.xlarge and c7i.2xlarge on aws.amazon.com/ec2/pricing/on-demand
  (EU (Ireland)) before deploying, as the review asks.
- **Rotation without deploys:** secrets take effect within 5 minutes.

## Not verified (needs an AWS account or a real host)

- Everything that only a deploy shows: the boundary accepting every call the stack's roles make at run time (the
  boundary was written from the roles' statements and the two AWS-managed policies; a missing action would show as an
  `AccessDenied` in a function's log or the image build log); `ec2:LaunchTemplate` and `ec2:InstanceType` conditions
  as EC2 evaluates them; the Image Builder build with the libraries installed by name instead of
  `installdependencies.sh`; the demo-down timing against GitHub's busy flag; the reaper's deregistration.
- Customer mode on a real c7i: the Nitro Sandboxes backend under the jailer, the firewall tests, the result disk, CPU
  capacity (the 12-item list in DEPLOY-AWS.md).

## Remaining risks (accepted, documented)

- A job's summary is still its own word (it writes `summary.json`); the credential limits a forgery to that job. Do
  not bill on test counts or "minutes saved".
- Per-job mode: customers share the cache machine (one process, one SQLite file, separated by organization in every
  query). Run it for our own repositories and design partners; customer mode is the plan for customers at large.
- Within one demo, one job can alter the next job on the same demo machine (the runner is persistent); acceptable
  only because the demo repository is the founder's own (now enforced, F13).

## Commits

- `Review R-012 fixes (code): …` — the code, the policies, the spike, the reviewer's tests copied unchanged, the
  updated tests.
- `Review R-012 fixes (docs): …` — DEPLOY-AWS.md, REPORT-aws-deploy.md, this report, READMEs, the SCRAM script and the
  last tests.
