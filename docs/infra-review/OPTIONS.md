# Architecture options (input for the founder's decision)

Read-only review, 2026-11-23. Three whole architectures; costs come from `COST.md` (monthly totals = cost per 1,000
minutes × volume ÷ 1,000, shown as u = 30% / 60% / 90%), machines and terms from `MACHINES.md`, API and database from
`API-DB.md`. Effort is ESTIMATED in engineer-days. The 22 December product verdict is not in this repository; the
last field of each option names how its three open questions (price unit, cache, languages) would move the choice.

Common to all three: the API stays on Lambda + API Gateway + SQS and the database stays on Supabase Pro (`API-DB.md`:
at the brief's volumes Lambda costs < $3 a month against ≈ $22 for a VM and ≈ $51 for Fargate; Supabase Pro at $25
includes Auth, which 14 of 16 migrations depend on; every alternative database costs 5-8 days of migration for a
saving of at most ≈ $5 a month). Machines are ≈ 80% or more of cost from 100k minutes up (COST.md: 184.85 of 233.70 on setup 1 at 100k/90%), so they decide the options.

## Option 1: today's, tuned (AWS, one VM per job)

| Field | Content |
|---|---|
| **Machines** | EC2 c6i.large per job in eu-west-1 (cheapest per-job x86 priced: $0.0912/h vs c7i.large $0.09576, c7a.large $0.11012). Tuning: raise `runnerMaxRunning` (4) and ask AWS for an On-Demand quota above the default 5 vCPUs; deploy the stack a second time in the region "eu" customers expect and pass `FENVIX_RUNNER_REGION` in the deploy (today the Irish stack serves fenvix region `us`, `INVENTORY.md` correction 1); measure boot and warm-up minutes on the first real jobs (u is ESTIMATED 70-85%); price spot once the spot feed is readable (UNKNOWN today) and add a spot launch path with on-demand fallback. |
| **Isolation** | Unchanged: one VM per job, deleted after the job (Nitro hypervisor). Strongest and simplest of the three. |
| **API** | Lambda as today. |
| **Database** | Supabase Pro (plan to be confirmed: today's plan is UNKNOWN in the repository). |
| **Monthly cost** (COST.md setup 1) | 10k: $87.15 / $59.42 / $50.18. 100k: $603.39 / $326.12 / $233.70. 1M: $5,765.75 / $2,993.07 / $2,068.84. Per 1,000 min at today's implied u ≈ 79%: ≈ $2.6 at 100k (sensitivity table). |
| **Files that change** | `infra/github-app/cdk.json` (fleet cap, second-region settings), `.github/workflows/deploy.yml` (pass `FENVIX_RUNNER_REGION`; a second deploy for the other region), `infra/github-app/lib/runner-fleet.ts` (spot market options in the launch template, if adopted), `github-app/src/runners/launcher.ts` (spot fallback, cap), `docs/DEPLOY-AWS.md`. |
| **Effort** | 3-5 days (second region and deploy 1-2; spot path 1-2; measurement 1). |
| **Risks** | Cost per minute stays ≈ 3-5× bare metal at scale; margin against GitHub 2-core ($6.00) is ≈ $3.7 per 1,000 at 100k/90% and thinner at low volume or short jobs; the 45-75 s start (ESTIMATE) is far from GitHub's seconds; the 5-vCPU default quota and the /26 subnet (≈ 58 machines) cap growth until raised; spot interruptions kill running jobs. |
| **What the 22 December verdict could change** | **Price unit:** if fenvix bills per job or per suite rather than per minute, the per-job boot overhead (≈ 1.25 min per job) is a cost we carry, which favors options 2-3. **Cache:** the shared cache stays a small t4g.nano in the same AZ (free traffic); a bigger cache (more languages, artifacts) means a bigger machine but no design change. **Languages:** more languages = a bigger runner image and longer boot (larger AMI to load); no other change. |

## Option 2: hybrid: Hetzner dedicated hosts with Firecracker, AWS per-job VMs as overflow

| Field | Content |
|---|---|
| **Machines** | Hetzner AX102 (Ryzen 9 7950X3D, 32 threads, 128 GB, €159/month + €129 setup; 15 slots) in Falkenstein or Helsinki, one host to start, a second for availability when revenue allows; today's AWS per-job fleet kept unchanged as overflow when hosts are full, and as the only fleet while volume is below ≈ 100k minutes a month. |
| **Isolation** | Firecracker microVM per job under the jailer on KVM, destroyed after the job: the Customer-mode design of `DEPLOY-AWS.md:650-783` with the KVM backend instead of Nitro Sandboxes (its jailer, credential, result-disk, per-TAP firewall and connection-limit rules carry over). Hetzner bans mining, scanning and source-IP spoofing and can suspend the whole account on breach: per-microVM egress filtering and abuse detection are mandatory. |
| **API** | Lambda as today; a host agent pulls jobs from a per-host-group SQS queue (the `SqsHostLauncher` that `DEPLOY-AWS.md:695` lists as "to build"), so no inbound port on the hosts. |
| **Database** | Supabase Pro. |
| **Monthly cost** (COST.md: setup 1 at 10k, setup 2 from 100k; overflow minutes on AWS not included) | 10k: $87.15 / $59.42 / $50.18 (AWS only). 100k: $213.22 at any u (one host). 1M: $1,156.38 / $596.21 / $409.48. |
| **Files that change** | New: host agent and host setup (from `infra/customer-mode/spike/`, moved to KVM), provisioning of the hosts (Robot API or by hand at this size). Changed: `github-app/src/runners/launcher.ts` (placement: host queue first, EC2 overflow), `infra/github-app/lib/stack.ts` (jobs queue per host group, IAM for the host agent's queue role, cache placement), the cache (moved onto a host or reachable from it over TLS: `lib/cache.ts`, `lib/network.ts`), `cdk.json` and `lib/settings.ts` (new settings), `.github/workflows/deploy.yml` (deploy the host agent), `docs/DEPLOY-AWS.md` and a new host runbook. |
| **Effort** | 15-25 days: host agent and jailer setup 5-8; KVM port of the spike and the 12 tests of `DEPLOY-AWS.md:735-761` 5-8; launcher placement and overflow 2-3; cache across providers 2-3; runbook, monitoring 1-3. |
| **Risks** | Building and proving microVM isolation (the main risk: one escape exposes other customers); account suspension by Hetzner for one customer's abuse (all hosts at once: keep AWS overflow ready); new-account capacity limits and two Hetzner price rises in 2026 (April, June); setup fees and delivery from minutes to weeks per variant; cross-provider traffic between hosts and the cache/API (latency UNKNOWN); one host is a single point of failure. |
| **What the 22 December verdict could change** | **Price unit:** per-minute pricing makes the fixed host cost ($213 a month) pay off only from ≈ 100k minutes; per-job pricing makes the near-zero start overhead of microVMs worth more. **Cache:** a large shared cache fits well on the host's NVMe (2× 1.92 TB) next to the jobs, which is cheaper than an AWS cache. **Languages:** more languages mean a bigger guest image per microVM; with snapshots on KVM, start time stays low; RAM per slot (4 GiB) may need to grow for JVM or Node suites, which lowers slots per host (RAM-bound at 30 on 128 GB, `MACHINES.md`). |

## Option 3: hourly bare metal (phoenixNAP Amsterdam) with Firecracker, scaled with demand

| Field | Content |
|---|---|
| **Machines** | phoenixNAP d3.m6.xlarge (2× Xeon Platinum 8452Y, 144 threads UNVERIFIED, 512 GB, $1.92/h; 71 slots), started and stopped by the hour to follow demand; AWS per-job VMs kept for overflow and for the minutes when no host is up. Conditional: this type's availability in Amsterdam is UNKNOWN until seen in the portal; new accounts are capped at 5 servers. |
| **Isolation** | As option 2 (Firecracker on KVM, Customer-mode rules). phoenixNAP's AUP makes the client responsible for all use of the account. |
| **API** | Lambda as today, plus a scheduler that starts a host 1-15 minutes ahead of demand (provisioning time) and stops it when idle (full-hour billing). |
| **Database** | Supabase Pro. |
| **Monthly cost** (COST.md setup 3) | 10k: $40.59 / $33.06 / $30.55. 100k: $177.00 / $101.74 / $76.66. 1M: $1,541.12 / $788.57 / $537.73. |
| **Files that change** | As option 2, plus a host scheduler (new Lambda or a mode of the warm-up scheduler, `github-app/src/warmup/`, `infra/github-app/lib/stack.ts`) that calls phoenixNAP's API; credentials for that API in SSM (`lib/parameters.ts`, `lambda/secrets.ts`). |
| **Effort** | 20-30 days: option 2's work plus the demand scheduler (3-5). |
| **Risks** | As option 2 (isolation, abuse liability); plus: a host that takes up to 15 minutes to provision makes queue spikes wait or spill to AWS; full-hour rounding wastes money on short bursts; per-type EU availability and price anomalies on the price page (re-check needed); thread counts not verified; one EU site only. |
| **What the 22 December verdict could change** | **Price unit:** cheapest at low volume of the bare-metal options because it scales to zero, so it fits a per-minute price that must be profitable from the first customers. **Cache:** the host disappears when stopped, so the cache cannot live on it: it stays on a separate always-on machine (today's t4g.nano or a small host), adding cross-provider traffic. **Languages:** 512 GB of RAM keeps 71 slots even at 4+ GiB per job, so heavier language runtimes cost fewer slots than on option 2. |

## Recommendation

Keep the API on Lambda and the database on Supabase Pro: they are a few dollars of a bill that machines dominate,
and moving them buys nothing at the brief's volumes. For the machines, take **option 1 now** (2-5 days: second region
and the `fenvixRegion` fix, raise the cap and quota, measure boot, warm-up and utilization on the first real jobs),
because below ≈ 100k customer minutes a month per-job EC2 at ≈ $2.3-6 per 1,000 minutes is cheaper than any monthly
server and needs no new isolation code. Plan **option 2** as the step taken when measured volume approaches 100k
minutes a month or when the 22 December verdict fixes a per-job or per-suite price: one Hetzner AX102 host then costs
$213 a month for up to ≈ 650k slot-minutes, about $0.4-1.2 per 1,000 minutes at 1M against $2.1-5.8 on AWS, and the
Customer-mode design already contains most of the isolation work. Before committing to it: read the terms the
excluded providers could not show, confirm the EUR/USD rate and Hetzner's current capacity for new accounts, and run
the 12 host tests of `DEPLOY-AWS.md:735-761` on a KVM host. Option 3 is the fallback if hourly scaling matters more
than the lowest unit cost. This is input; the decision is the founder's.
