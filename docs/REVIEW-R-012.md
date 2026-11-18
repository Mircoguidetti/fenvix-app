FIX 18

# Review R-012: AWS deploy kit (GitHub App on Lambda, runners, customer-mode design)

Reviewed: `claude/github-app` at `98cb03e` (commits `0fa0659`..`98cb03e`). Branch `claude/review-r012`.
Scope: docs/REPORT-aws-deploy.md, docs/DEPLOY-AWS.md, docs/GITHUB-APP.md, github-app/src/lambda, github-app/src/runners,
infra/github-app (CDK, runner files, scripts), infra/customer-mode/spike. Nothing was deployed. Threat model: the job
runs hostile customer code.

**Verdict: not ready to deploy.** In the default demo mode, one finding blocks the first deploy: **F5**, the image build
machine can read every secret. **F8** (CPU throttling) and **F13** (demo function scope) should also be fixed before
the first demo. Per-job mode has three high-severity cross-tenant defects (F1, F2, F3), so do not turn it on for a
second customer. The customer-mode design needs the changes in F9, F10, F11, F16 and F17 before the spike runs on a
real host.

## What I ran

| Check | Result |
|---|---|
| github-app `npm test`: typecheck, unit, integration (Postgres 16 scratch DB, `scripts/prepare-test-db.sh`) | unit 52/52, integration 61/61 pass |
| infra/github-app `npm test`: typecheck, template and script tests with cdk-nag | 35/35 pass |
| `cdk synth` in demo mode (default) | ok, cdk-nag clean |
| `cdk synth` in per-job mode (with cache token hashes) | ok, but cdk-nag **could not evaluate** AwsSolutions-EC26 on the cache instance (`CdkNagValidationFailure`, F14) |
| Synthesized templates searched for secrets (outputs, Lambda environment, user data) | none found |
| Unit prices re-read | all match (see "Cost figures") |
| New failing tests (this branch) | `github-app/tests/integration/review-r012.test.ts` (5 tests), `infra/github-app/test/review-r012.test.ts` (11 tests). All fail on `98cb03e` for the stated reason. |

Run the new tests with `cd github-app && TEST_DATABASE_URL=... node --test --test-concurrency=1 tests/integration/review-r012.test.ts`
and `cd infra/github-app && node --test test/review-r012.test.ts`. Both `npm test` suites now fail until the fixes land.
That is intended.

## Findings

Severity: **High** = secret or cross-tenant exposure, or a hostile job affects other tenants. **Medium** = least
privilege broken, or a wrong step or figure that the founder would act on. **Low** = hygiene.

| # | Sev | Mode | Finding | Test |
|---|---|---|---|---|
| F1 | High | per-job, customer | One fleet-wide `RUNNER_TOKEN`, and the body chooses `runnerName`: whoever holds the token publishes results for any customer's job | `F1` (github-app) |
| F2 | High | per-job | Every job machine (forks and PRs included) has one role that reads the cache **write** token and `RUNNER_TOKEN`. Only an iptables uid rule separates job code from it | `F2` (infra) |
| F3 | High | per-job | One cache organization for all customers: any PR job reads every customer's cache entries and runs, and a trusted job writes into them | `F3` (github-app) |
| F4 | Medium | all | Deploy identity ≈ admin through CloudFormation's execution role (IAM writes without a permissions boundary). The execution role reads every SSM secret. Step 11's claim is false | `F4` ×2 (infra) |
| F5 | **High** | **all (demo too)** | Image Builder build machine role (`AmazonSSMManagedInstanceCore`) reads every SSM parameter, App private key included. The build runs third-party code, then root runs a file the `fenvix` user owns | `F5` (infra) |
| F6 | Low | demo | demo-down leaves the runner registered when the runner is busy (it deletes before it terminates). The reaper never deregisters | `F6` (github-app) |
| F7 | Medium | demo, per-job | `ec2:RunInstances` on `instance/*` is conditioned only on a request tag: any instance type, with or without the launch template | `F7` (infra) |
| F8 | Medium | demo, per-job | Launch template forces T3 **standard** credits. T3 gets no launch credits, so every fresh machine runs at its 20% per-vCPU baseline. The cost figures assume full speed | `F8` (infra) |
| F9 | High | customer (spike) | Host mounts the guest-written ext4 (kernel attack surface, symlinks followed on the host). It takes repository and run ids from the guest and posts `runnerName fenvix-sandbox-<slot>`, which never matches a job | `F9` ×2 (infra) |
| F10 | Medium | customer (spike) | Sandbox firewall keyed on source address, FORWARD default ACCEPT, no IPv6, no per-sandbox conntrack limit | `F10` (infra) |
| F11 | Medium | customer (spike) | `host-setup.sh` treats the memory pool as optional. Without it the parent has 0 slots, so nothing starts | `F11` (infra) |
| F12 | Low | per-job | JIT runner registered before the capacity check: each retry while the fleet is full leaves an orphan runner registration | `F12` (github-app) |
| F13 | Medium | demo | The demo function registers our runner on **any** repository the App is installed on, customers' included | `F13` (github-app) |
| F14 | Low | per-job | cdk-nag rule EC26 throws on the cache instance, so "cdk-nag clean" is not fully true | `F14` (infra) |
| F15 | Medium | all | Secret rotation: the "deploy again" advice reloads nothing. Lambdas cache secrets for their lifetime, and the deployer cannot force a cold start | n/a (doc) |
| F16 | Medium | customer (doc) | KVM fallback priced at c5n.metal ($4.392/h); nested virtualization on the same C7i ($0.19152/h) is the fallback. The capacity estimate ignores the one-sandbox-per-core rule | n/a (doc) |
| F17 | High | customer (design) | Firecracker runs as root, without the jailer, on a parent that holds `RUNNER_TOKEN` and an IAM role. One VMM escape exposes every tenant | n/a (design) |
| F18 | Low | all (doc) | DEPLOY-AWS.md step-level errors (list below) | n/a (doc) |

### F1. Summary credential is fleet-wide and not bound to a job (High)

`POST /v1/runner/summaries` accepts any `repositoryId`, `runId` and `runnerName` with the one `RUNNER_TOKEN`
(`github-app/src/app.ts:106-124`). The service matches summaries to jobs only by those values
(`service.ts:396-405`). Runner names are predictable (`fenvix-j<job id>`). Every per-job machine role can read the
token (`runner-fleet.ts`, `ReadRunnerAndCacheTokens`), and so can the customer-mode host. One local root escalation on
any job machine, or one compromised host, therefore lets an attacker write any customer's check run, PR comment, ci_runs
row and usage event.
Test `F1`: acme/shop's machine posts for acme/web's job, gets 202, and the summary is stored.
**Fix:** a per-job summary credential. For example, the worker puts `HMAC(key, runnerName|repositoryId|runId)` into the
machine's user data, and the endpoint accepts a summary only for that tuple. Keep the fleet token only to identify the
fleet, or drop it.

### F2. Job machine role reads the write token and the runner token (High, per-job)

`FleetJobRole` grants `ssm:GetParameter` on `cache/write-token`, `cache/read-token` and `github-app/runner-token` to
every machine, so trusted and fork jobs get the same role. The only separation is `fenvix-imds-block`, an iptables
OUTPUT rule on the job's uid, on the same kernel. A kernel LPE, or any future path to another uid (a Docker group, a
setuid helper), reaches IMDS and both tokens. The task's own rule ("a job must not be able to call ... the cache write
path") therefore depends on one uid check.
**Fix:** two launch templates with two roles (trusted: write token; untrusted: read token or none), chosen by the
worker. Also F1, so that `RUNNER_TOKEN` is no longer worth stealing. Optionally, the worker fetches the token and
passes a short-lived one in user data instead of granting SSM to the machine.

### F3. One cache organization for every customer (High, per-job)

`tokensJson()` (`lib/cache.ts`) creates one organization (`cacheOrg`, default `fenvix`) with one write token and one
read token. The service scopes everything by organization, and the client chooses the namespace. Any PR job can
therefore call `POST /v1/ns/<other repo>/lookup`, `/v1/blobs/get` and `GET /v1/ns/<other repo>/runs` and read another
customer's entries, file facts and run receipts. DEPLOY-AWS.md names only the write side ("a write token for one
customer could write entries for another").
**Fix:** before per-job mode runs for a second customer, give each installation its own organization and token pair,
selected by the worker per job (test `F3`). DEPLOY-AWS.md section H should say that per-job mode is single-tenant until
then.

### F4. Deploy identity can escalate; execution role reads secrets (Medium)

- `cfn-exec-policy-app.json` `IamRolesOfThisStack` allows `iam:CreateRole`, `iam:PutRolePolicy` and
  `iam:AttachRolePolicy` on `fenvix-prod-github-app-*` with no `iam:PermissionsBoundary` condition. A template the
  deployer submits can create such a role with `"Action":"*"`, give it to a Lambda (allowed), and have the Scheduler
  invoke that Lambda (allowed). DEPLOY-AWS.md step 11 says the deployer "cannot create IAM, Lambda or EC2 resources
  itself". That is true only literally.
- `cfn-exec-policy-fleet.json` `ImageBuilderParentImage` allows `ssm:GetParameter` on `*`. Through the `aws/ssm` key,
  that covers the SecureString secrets.

**Fix:** create a permissions boundary policy, require it in the execution policy (`iam:PermissionsBoundary`
condition on CreateRole, PutRolePolicy and AttachRolePolicy), and set it in CDK
(`@aws-cdk/core:permissionsBoundary`). Scope the parent-image `ssm:GetParameter` to
`parameter/aws/service/canonical/*`. Correct step 11's wording.

### F5. Image build machine can read every secret (High, blocks demo mode)

`FleetBuildRole` has `AmazonSSMManagedInstanceCore`, whose first statement includes `ssm:GetParameter` and
`ssm:GetParameters` on `"Resource": "*"` (verified on the managed-policy reference page). The build runs
`install.sh`: it clones fenvix-engine-cli, then runs `bootstrap.sh install` as `fenvix`, which pulls PyPI and crates
dependencies and the GitHub runner. Then **root runs `$FENVIX_HOME/actions-runner/bin/installdependencies.sh`, a file
the `fenvix` user owns** (`install.sh`, step 4). Any dependency's build script can rewrite that file, become root,
reach IMDS, and read `/fenvix/prod/github-app/private-key`, `database-url`, `webhook-secret`, `client-secret`,
`runner-token` and the cache tokens. It also backdoors every runner image.
**Fix:** add an explicit `Deny ssm:GetParameter*` on `arn:...:parameter/fenvix/*` to the build role (test `F5`). Run
`installdependencies.sh` from a root-owned copy, or install its packages (`libicu`, etc.) by name before step 4.

### F6. demo-down can leave the runner registered (Low)

`demoDown` deletes runners **before** it terminates the machine. A busy runner gets 422 and stays registered, and the
message says it "is removed when the machine stops". That is wrong for a non-ephemeral runner: GitHub keeps it offline
for about 14 days. The reaper only terminates and never deregisters. The registration is harmless once the disk is
gone (its credentials were on it), but demo-down does not "really delete" it, as required.
**Fix:** terminate, wait for `terminated`, then delete the runner, retrying 422 for a minute. The reaper should
deregister `fenvix-demo-*` runners of the repository in the `fenvix:repository` tag (test `F6`).

### F7. RunInstances not limited to the launch template (Medium)

In `stack.ts` `mayLaunch`, the statement on `instance/*` and `volume/*` has only
`aws:RequestTag/fenvix:role`. A compromised worker or demo function can start any instance type (GPU, metal) without
the launch template, from any AMI the account owns. **Fix:** add `ec2:LaunchTemplate` (the template ARN) and
`ec2:InstanceType` conditions to that statement (test `F7`).

### F8. T3 "standard" credits throttle every fresh machine (Medium)

The launch template sets `creditSpecification: standard`. AWS: "T8i, T4g, T3a, and T3 instances do not receive launch
credits" (EC2 User Guide, burstable standard mode). A new t3.medium starts at 0 credits, at a 20% per-vCPU baseline,
and earns 24 credits an hour. A one-job machine never gets above baseline, so the engine install, the build and the
tests run several times slower. The timing estimates ("first test 1 to 2.5 minutes"), the 10-minute machine lifetime
and the costs all assume full speed.
**Fix:** use `c6i.large` (2 vCPU, 4 GiB, **$0.0912/h** in eu-west-1, already allowed by the settings), or T3
unlimited. Full-speed t3.medium unlimited costs $0.0456 + 2 × 0.8 × $0.05 = $0.1256/h, which is more than c6i.large.
Updated figures with c6i.large:
- demo: 20 h × $0.0998 ≈ **$2.00** (not $1.08). Demo total ≈ $2.73 without free tiers.
- per-job: ≈ **$0.0166** per 10-minute job (not $0.0090). 1,000 jobs: job machines ≈ $16.6, total ≈ $21.6.
- The image build machine is not affected: Image Builder sets no credit option, so T3 launches unlimited by default.

### F9. Spike host trusts the guest's disk (High, customer)

`run-job.sh`:
- `mount -o ro "$work/job.ext4"` mounts a filesystem that a hostile guest fully controls into the **parent's
  kernel**. A crafted ext4 image is a known kernel attack surface. `ro` also follows symlinks: a guest that makes
  `summary.json` a symlink to `/var/lib/fenvix-sandboxes/job-2/job/summary.json` gets another tenant's summary posted
  as its own, so it appears in its own PR comment.
- `read -r repo run attempt <"$mnt/ids"` takes repositoryId, runId and runAttempt from the guest. Combined with F1,
  that lets a guest write results for any run.
- `runnerName` is `fenvix-sandbox-$SLOT`, but the JIT runner is registered as `fenvix-j<job id>` (by the worker), so
  the App never matches a summary. The spike would never show a published result.

**Fix:** pass results out over vsock, or as a fixed-size raw block that a userspace parser reads with a length prefix
and a size cap. Never mount guest disks on the host. Take the ids and the runner name from the host's own job record.
If a mount is unavoidable, use `nosymfollow,nodev,nosuid,noexec` and run the parse in a throwaway user namespace.

### F10. Spike firewall (Medium, customer)

`host-setup.sh` matches `-s 172.16.0.0/16`. A guest controls its source address: with another source it skips the IMDS
DROP and the sandbox-to-sandbox DROP. AL2023's FORWARD policy is ACCEPT, so the packet is forwarded. `INPUT` has the
same problem. There are no `ip6tables` rules, so IPv6 link-local from a TAP reaches the parent's listening services.
AWS's own example matches on the interface (`iifname "tap0" ... daddr 169.254.169.254 reject`). The Nitro Sandboxes
page also warns that "one Nitro Sandbox can exhaust network resources that all Nitro Sandboxes share ... such as the
connection tracking table", and the design sets no limit.
**Fix:** use `-i fctap+` rules, `iptables -P FORWARD DROP`, `disable_ipv6` on every TAP (or ip6tables DROP), and allow
only `169.254.169.253` (DNS) out of 169.254.0.0/16. Add per-TAP conntrack (`connlimit`/`hashlimit`) and bandwidth
limits, and `rp_filter=1`.

### F11. Spike memory pool and slots (Medium, customer)

AWS (Run Nitro Sandboxes with Firecracker): "With a memory pool, the parent instance has 4 slots. Without a pool, it
has 0." `nitro_enclaves.mempool=<size>@0` plus a reboot is mandatory. `host-setup.sh` only logs it as advice, then
writes `8` to `pcie_slots`. The value rounds up to 12 and needs pool memory, so a fresh host fails with `No space left
on device`. The README's run order omits the pool. **Fix:** check `/proc/cmdline` and `mem_pool/total`; add the
`grubby` and reboot step to the README; write 12, not 8.

### F12. JIT runner before the capacity check (Low)

`launchRunner` calls `generate-jitconfig` before `launcher.launch()` checks the fleet limit. While the fleet is full,
each of the 5 SQS tries registers one more unused JIT runner (test `F12`: `fenvix-j1003`, `fenvix-j1003-…` ×4).
**Fix:** check capacity first (`launcher.hasCapacity()`), and delete the JIT runner when the launch fails. Related
note: the cap is check-then-act across two concurrent workers (`maxConcurrency: 2`), so it can be exceeded by one.

### F13. Demo function scope (Medium)

`demoUp(repository)` accepts any repository the App is installed on. Whoever can invoke the function (the deploy
identity) can register our runner on a **customer's** repository, receive its `runs-on: fenvix` jobs, and with them the
job's `GITHUB_TOKEN` and secrets on a machine we control. **Fix:** an allowlist (`demoRepository`, or repositories of
the founder's own account), checked in the Lambda (test `F13`).

### F14. cdk-nag not fully evaluated in per-job mode (Low)

`AwsSolutions-EC26` throws on `Cache/Instance` ("Cannot read properties of undefined (reading
'launchTemplateName')"), so EBS encryption on the cache instance is never checked. It is encrypted
(`encrypted: true`). Fix the construct (or the property override) so that the rule evaluates, rather than suppressing
`CdkNagValidationFailure`.

### F15. Secret rotation does not take effect (Medium, doc)

`lambda/runtime.ts` `once()` keeps the config (secrets included) for the container's lifetime. "When something fails,
401: make them equal, then deploy again" does nothing when the template did not change: CloudFormation reports no
change and the warm containers keep the old webhook secret. The same holds for rotating `runner-token`. The deployer
has no `lambda:UpdateFunctionConfiguration` to force a cold start. **Fix:** a short TTL on secrets (reload after
5 minutes, or on a signature failure), or a `SECRETS_VERSION` setting that the founder bumps in cdk.json. Then document
a rotation procedure with `runner-token-previous`.

### F16. Customer mode: fallback cost and capacity (Medium, doc)

- **Fallback.** EC2 now offers **nested virtualization on virtual instances**, including **C7i** and C8i ("Use nested
  virtualization to run hypervisors in Amazon EC2 instances", EC2 User Guide; KVM supported; no extra cost). The KVM
  Firecracker fallback is therefore the same c7i.xlarge at **$0.19152/h (≈ $147.86/month)**, with snapshots and
  memory overcommit, not c5n.metal at $4.392/h (≈ $3,214/month). Nested virtualization and Nitro Sandboxes cannot be
  on at the same time on one instance, which fits a fallback.
- **Capacity.** AWS: "On instances with two threads per core, a core runs only one Nitro Sandbox, or only the parent
  instance, at a time. The compute available to Nitro Sandboxes is therefore bounded by the physical cores." A
  c7i.xlarge has 2 cores, so "about 3 jobs of 2 vCPUs at once" time-share about 2 cores with the parent: roughly
  0.6 core per job. Measure it (test 5). Expect a c7i.2xlarge per 3 jobs, or a Graviton host (1 thread per core) if
  jobs can be arm64.

### F17. Customer mode: the parent is the real trust boundary (High, design)

In direct mode, "the trust model is equivalent to that of a nested virtual machine" (AWS). The guest's attack surface
is Firecracker's virtio devices in the parent, the parent's TAP networking and (F9) its filesystem code. The spike runs
Firecracker as **root without the jailer**, on the host that also holds `RUNNER_TOKEN` and polls SQS with an IAM role.
One device-emulation escape gives every tenant's disks, the fleet token and the role. The claim "the Nitro
Hypervisor isolates the sandbox from the parent and from other sandboxes" is true for memory and vCPUs. It is not the
whole boundary.
**Required design:**
- jailer per sandbox (own uid, chroot, cgroup, seccomp), never root;
- the token and AWS credentials in a separate process that never touches guest data;
- vsock instead of disk for results (F9);
- per-job credentials (F1);
- IMDS hop limit 1 on the parent, plus the F10 rules.

### F18. DEPLOY-AWS.md: step-level errors (Low)

- Step 10 runs `npx cdk bootstrap` before any `npm ci` (step 16): npx fetches an unpinned `aws-cdk`. Run `npm ci` in
  `infra/github-app` first and use the pinned CLI.
- Step 8: the DB password typed into the Supabase SQL editor stays in the editor's query history. Set a SCRAM verifier
  computed locally, or delete the query afterwards.
- "To remove everything": `cdk destroy` fails while a demo machine still runs (it uses the subnet and security group),
  and when the overflow bucket is not empty (`RemovalPolicy.DESTROY` without `autoDeleteObjects`). Run demo-down
  first, and empty the bucket or set `autoDeleteObjects`.
- "Image builds add about $0.03 each": 45 minutes of t3.medium (unlimited, building at 100%) plus IPv4 and disk is
  about $0.10.
- API Gateway's "1M per month free for 12 months": accounts created after 2025-07-15 get Free Tier **credits**
  instead (api-gateway pricing page). Not material at this volume.
- `lib/nag.ts` suppression reasons still mention "the always-on runner", which was removed.
- The HTTP Lambda's Fastify request log includes `req.url`, so `GET /github/setup?code=…&state=…` writes the one-time
  OAuth code to CloudWatch. It is single-use and needs the client secret, so the risk is low. Redact the query string.

## Demo mode: what was checked and holds

- Secrets: only in SSM, read by exact name per function (the demo function reads only `private-key`; the worker does
  not get the HTTP secrets). None in the Lambda environment, CloudFormation outputs, cdk.json, git or user data
  (`cdk-outputs.json` is git-ignored). The registration token is in user data and in a root-only file, shredded after
  use. IMDS is blocked for `fenvix` and `fenvix-post` (IPv4 and IPv6), with `HttpTokens=required` and hop limit 1.
  `RUNNER_TOKEN` is readable only by `fenvix-post` (`/run/fenvix-post`, 0700).
- Webhook: the HMAC-SHA256 signature (constant time) is checked before any work, and SHA-1 is never accepted. The
  delivery id is recorded once, so replays are ignored. A poison message goes to the DLQ after 5 tries (batch item
  failures), raising an alarm. The overflow key is validated with a regex.
- Reaper and demo terminate only `fenvix:role`-tagged instances, both in IAM (`aws:ResourceTag`) and in the filter.
  Tags can be set only at launch (`ec2:CreateAction=RunInstances`). The idle watchdog powers off only its own machine.
- Demo isolation between demos: new instance, new disk (`deleteOnTermination: true`), cache on that disk, new runner
  name. **Within** one demo the runner is persistent and the job user owns the runner directory, `.env` and
  `engine-cli`, so one job can alter the next job in the same demo. That is acceptable only because a demo runs the
  founder's own private repository. Never register a demo runner on a customer or public repository (see F13).
- Summaries are self-reported by job code, so "minutes saved" and test counts are attacker-controlled for the
  attacker's own job. Do not bill on them.

## Customer mode: tests to run on a real c7i.xlarge (in addition to DEPLOY-AWS.md's list)

1. From a guest, as root: spoof the source address (`ip addr add 10.42.0.99/32 dev eth0`,
   `curl --interface 10.42.0.99 169.254.169.254`); reach another sandbox's 172.16.N.2 with a spoofed source; reach
   the parent over IPv6 link-local (`ping6 fe80::...%eth0`, `nc -6`). All must fail (F10).
2. Guest writes a symlinked `summary.json` and `ids`, and a corrupted ext4 superblock: the host must neither follow
   nor mount them (F9).
3. Conntrack exhaustion from one guest (`hping3 --flood` to many ports): other sandboxes' jobs must keep their network
   (F10).
4. Firecracker under the jailer: as its own uid, the VMM cannot read `RUNNER_TOKEN` or another sandbox's disk (F17).
5. From the guest: `169.254.169.254` (v1 and v2), `169.254.169.253` (allowed DNS only), `169.254.169.123`, the VPC
   resolver, the cache machine (only with its own customer's token, F3).
6. CPU: 1, 2 and 3 concurrent 2-vCPU jobs (`stress-ng --cpu 2` plus a real pytest suite): measure per-job throughput
   against the 2-core limit (F16). Repeat on the same type with nested virtualization and KVM Firecracker, as the
   fallback.
7. Memory pool sizing: `mempool` for 3 × (2048 + 2) MiB plus 128 MiB per 8 slots; a fourth start must fail cleanly
   (F11).
8. Host reboot mid-job: no disk of a previous job remains under `/var/lib/fenvix-sandboxes` (run-job.sh has no
   `trap` cleanup: with `set -e`, a failed `curl` or `mount` exits before `cleanup`).

## Cost figures

I verified every unit price in DEPLOY-AWS.md against AWS's Price List files for eu-west-1, publication
2026-11-18T02:04:24Z:

| Item | Price | SKU |
|---|---|---|
| t3.medium | $0.0456 | 47NTBKB4KMUU98P8 |
| t4g.nano | $0.0046 | 2WUM3HJN9JGXQ3A8 |
| c7i.xlarge | $0.19152 | UGSWTF5QKT6FFUDJ |
| c7i.2xlarge | $0.38304 | QC3ZMNBVRWVYJ3M2 |
| c5n.metal | $4.392 | 5WTB2K6WFG5VB34R; the cheapest x86 metal of 72, as stated |
| gp3 | $0.088 | TXACT7E3PV6ZX2NM |
| EBS snapshot | $0.05 | UZ7N3QU3DRSU25FK |
| Public IPv4 | $0.005 | |
| Lambda | $0.0000166667 per GB-s, $0.20 per 1M requests | |
| SQS | $0.40 per 1M requests | |
| HTTP API | $1.11 per 1M requests | |
| CloudWatch Logs | $0.57 per GB ingested, $0.03 per GB-month | |
| Alarm | $0.10 | |
| c6i.large (for F8) | $0.0912 | MY34M56N9KVPBWDG |
| T3 surplus credits | $0.05 per vCPU-hour | Z25C5STUBANBQC5Y |

On the aws.amazon.com pages, which are reachable from here, I re-read:
- billing per second with a 60-second minimum;
- the public IPv4 price ($0.005);
- the Lambda price and free tier (400,000 GB-s);
- the Scheduler free tier (14 million);
- SSM standard parameters at no additional charge;
- the $0.10 alarm;
- the 100 GB data-transfer free tier;
- "no additional charges for using Nitro Sandboxes".

The **regional** tables on those pages load from `b0.p.awsstatic.com`, which this environment's proxy refuses (403), as
it did for the author. The requirement "prices from aws.amazon.com pages" is therefore met only through the official
Price List files for the regional numbers. **Before deploying, the founder should open these four pages in a browser,
select EU (Ireland), and compare the figures with the table above:**
- aws.amazon.com/ec2/pricing/on-demand (t3.medium, t4g.nano, c6i.large, c7i.xlarge);
- aws.amazon.com/ebs/pricing (gp3, snapshot);
- aws.amazon.com/api-gateway/pricing;
- aws.amazon.com/cloudwatch/pricing.

The arithmetic of every monthly table is correct for its assumptions. The assumptions that are wrong are F8 (T3
throttling: demo ≈ $2.73, not $1.81; per-job 1,000 jobs ≈ $21.6, not $14.06, with c6i.large) and F16 (fallback
$147.86, not $3,214.21, per host per month).
