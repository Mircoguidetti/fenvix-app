# Cost per 1,000 customer test-minutes

Read-only review, 2026-11-23. Prices are list prices read on 2026-11-23 (sources below and in `MACHINES.md`), USD,
before tax; usage figures are **ESTIMATED** (nothing has been measured: there is no AWS account in this review and
no production traffic data in the repository). Every cell shows its arithmetic so it can be recomputed with other
inputs.

## Definitions

- **Customer test-minute:** one minute of a customer's job as GitHub would bill it on a 2-core Linux runner (job
  start to job end). Volumes: **10k, 100k, 1M** per month.
- **Slot-minute:** one billed minute of a 2-vCPU / 4 GiB job slot. Today a slot is one whole `c6i.large`. On larger
  or bare-metal machines a slot is 2 hardware threads and 4 GiB of the machine (see each setup).
- **Utilization u** = customer test-minutes ÷ billed slot-minutes. Per-job machines: u < 100% because of boot,
  shutdown, idle watchdog and warm-up minutes. Hourly or monthly machines: u is fleet occupancy. Billed slot-minutes
  = V ÷ u.
- **Cost per month** = billed slot-minutes × price per slot-minute + jobs × per-job cost + fixed monthly cost.
  **Per 1,000** = cost per month ÷ (V ÷ 1,000). Jobs = V ÷ 10 (average job 10 minutes, `docs/DEPLOY-AWS.md:640-647`).
- Free tiers are **not** subtracted (they matter only at the smallest volume; conservative).

## Prices used for today's setup (AWS eu-west-1, on demand, read 2026-11-23)

| Item | Price | Source (read 2026-11-23) |
|---|---|---|
| c6i.large (2 vCPU, 4 GiB, Xeon 8375C) | $0.0912/h, per second, 60 s minimum | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/eu-west-1/index.csv (publication 2026-11-21); https://aws.amazon.com/ec2/pricing/on-demand/ |
| Public IPv4 | $0.005/h | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/eu-west-1/index.json |
| EBS gp3 | $0.088/GB-month | EC2 price list CSV above |
| t4g.nano (cache machine) | $0.0046/h | EC2 price list CSV above |
| Data transfer out to internet | 100 GB/month free (all AWS), then $0.09/GB (first 10 TB) | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/eu-west-1/index.json; https://aws.amazon.com/ec2/pricing/on-demand/ |
| Lambda | $0.20 per 1M requests; $0.0000166667 per GB-s (x86) | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/eu-west-1/index.json |
| API Gateway HTTP API | $1.11 per 1M | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonApiGateway/current/eu-west-1/index.json |
| SQS standard | $0.40 per 1M | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSQueueService/current/eu-west-1/index.json |
| CloudWatch Logs ingestion | $0.57/GB | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudWatch/current/eu-west-1/index.json |
| EBS snapshot (runner image) | $0.05/GB-month | `docs/DEPLOY-AWS.md:567` (read there 2026-11-18; **not re-read**) |
| Idle serverless (Lambda schedules, SQS polling, logs, alarm) | $0.43/month | `docs/DEPLOY-AWS.md:617-622` (computed there from 2026-11-18 prices, which equal today's for these items) |
| Supabase Pro (database; today's plan is UNKNOWN) | $25/month ("From"; includes Micro compute) | https://raw.githubusercontent.com/supabase/supabase/master/packages/shared-data/plans.ts (Supabase's own site source; supabase.com was not reachable from this session); details in `API-DB.md` |

All AWS unit prices above match the 2026-11-18 table of `docs/DEPLOY-AWS.md:560-584`: nothing changed there.
What this file changes from DEPLOY-AWS: it counts the database (missing there), egress, per-job serverless cost, and
expresses cost per 1,000 customer minutes with utilization instead of "10 machine-minutes per job".

## Assumptions (ESTIMATED)

| Assumption | Value | Why |
|---|---|---|
| Average job | 10 min (sensitivity 5 and 20 min below) | `docs/DEPLOY-AWS.md:640-647` |
| Boot overhead per job (billed) | 1.0 min | Midpoint of the 45-75 s "queued → job starts" estimate (`docs/DEPLOY-AWS.md:536`, `docs/REPORT-aws-deploy.md:244`). EC2 bills from the running state, so this slightly over-counts the 10-20 s pending phase; kept as a margin. |
| Shutdown overhead per job | 0.25 min | summary post + power-off (ESTIMATED, not measured) |
| Lost jobs (cancelled before the machine took one) | 2% of jobs × 20 min idle watchdog = 0.4 min per job | `runnerIdleMinutes` 20 (`cdk.json:45`); 2% is a guess |
| Warm-up runs | 10% of job count, each as long as a job | Cap is 6 per repository per day (`cdk.json:47`), none for a commit a customer run covers; assumes a repository with ≈ 20 jobs per working day gets ≈ 2 warm-ups per working day |
| Cache traffic per job | $0 | Runner → cache machine is private-IP traffic inside one AZ (`lib/network.ts`, `lib/cache.ts`). AWS does not charge same-AZ private-IP transfer (ESTIMATED from AWS's data-transfer rules; not re-read today). Volume per job is not measured. |
| Internet egress per job | 20 MB × $0.09/GB = $0.0018 | Job logs to GitHub, summary, artifact uploads (ESTIMATED). Downloads (checkout, packages) are ingress, free. A job that uploads big artifacts or `actions/cache` entries costs more: 1 GB = $0.09. |
| Serverless per job | $0.000106 | ≈ 10 webhook/runner requests: API Gateway 10 × $1.11/1M = $0.0000111; Lambda 20 invocations × $0.2/1M = $0.000004 + 20 × 0.5 GB × 0.3 s × $0.0000166667 = $0.00005; SQS 30 × $0.40/1M = $0.000012; logs 50 KB × $0.57/GB = $0.0000285. Sum $0.000106 |
| **Per-job cost total** | **$0.00191** | 0.000106 + 0.0018 |

**Today's implied utilization** (u = job ÷ (job + boot + shutdown + lost + warm-up)):

| Job | Arithmetic | u |
|---|---|---|
| 5 min | 5 ÷ (5 + 1.0 + 0.25 + 0.4 + 0.5) = 5 ÷ 7.15 | **69.9%** |
| 10 min | 10 ÷ (10 + 1.0 + 0.25 + 0.4 + 1.0) = 10 ÷ 12.65 | **79.1%** |
| 20 min | 20 ÷ (20 + 1.0 + 0.25 + 0.4 + 2.0) = 20 ÷ 23.65 | **84.6%** |

So today's setup sits between the 60% and 90% columns. 30% is the case of many very short jobs or many warm-ups.

## Setup 1: today's (AWS eu-west-1, one c6i.large per job, per-job mode)

- **Price per slot-minute:** (c6i.large $0.0912 + IPv4 $0.005 + 30 GB × $0.088 ÷ 730 h = $0.003616) ÷ 60 =
  **$0.0016636**.
- **Fixed per month:** cache t4g.nano $0.0046 × 730 = $3.358; cache disk 8 × $0.088 = $0.704; image snapshot ≈ 6 GB
  × $0.05 = $0.30; idle serverless $0.43; Supabase Pro $25.00 → **$29.792**.
- **Per job:** $0.00191 (above).


Cost per 1,000 customer test-minutes (bold), today's setup:

| Volume (customer test-min/month) | u = 30% | u = 60% | u = 90% |
|---|---|---|---|
| **10,000** | 10,000/0.30 = 33,333 slot-min × $0.001664 = $55.45; + 1,000 jobs × $0.00191 = $1.91; + fixed $29.79 = $87.15/month ÷ 10 = **$8.72** | 10,000/0.60 = 16,667 slot-min × $0.001664 = $27.73; + 1,000 jobs × $0.00191 = $1.91; + fixed $29.79 = $59.42/month ÷ 10 = **$5.94** | 10,000/0.90 = 11,111 slot-min × $0.001664 = $18.48; + 1,000 jobs × $0.00191 = $1.91; + fixed $29.79 = $50.18/month ÷ 10 = **$5.02** |
| **100,000** | 100,000/0.30 = 333,333 slot-min × $0.001664 = $554.54; + 10,000 jobs × $0.00191 = $19.06; + fixed $29.79 = $603.39/month ÷ 100 = **$6.03** | 100,000/0.60 = 166,667 slot-min × $0.001664 = $277.27; + 10,000 jobs × $0.00191 = $19.06; + fixed $29.79 = $326.12/month ÷ 100 = **$3.26** | 100,000/0.90 = 111,111 slot-min × $0.001664 = $184.85; + 10,000 jobs × $0.00191 = $19.06; + fixed $29.79 = $233.70/month ÷ 100 = **$2.34** |
| **1,000,000** | 1,000,000/0.30 = 3,333,333 slot-min × $0.001664 = $5,545.36; + 100,000 jobs × $0.00191 = $190.60; + fixed $29.79 = $5,765.75/month ÷ 1,000 = **$5.77** | 1,000,000/0.60 = 1,666,667 slot-min × $0.001664 = $2,772.68; + 100,000 jobs × $0.00191 = $190.60; + fixed $29.79 = $2,993.07/month ÷ 1,000 = **$2.99** | 1,000,000/0.90 = 1,111,111 slot-min × $0.001664 = $1,848.45; + 100,000 jobs × $0.00191 = $190.60; + fixed $29.79 = $2,068.84/month ÷ 1,000 = **$2.07** |

**Feasibility notes.** At 1M minutes and u = 90%, the fleet averages 1,111,111 ÷ 43,800 min per month = 25.4
machines running, with peaks above that: today's cap is 4 (`cdk.json:43`, maximum 175,200 machine-minutes a month =
4 × 43,800), a new AWS account's On-Demand Standard quota is 5 vCPUs = 2 c6i.large
(https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-quotas.html, read 2026-11-23), and the /26 subnet
holds ≈ 58 runners (`INVENTORY.md` row 4). 100k minutes at u = 90% = 111,111 ÷ 43,800 = 2.5 machines average:
already at the cap at peak. The cost cells assume those limits are raised.

### Sensitivity: job length (today's setup, 100k minutes)

The job length changes the per-job items (cost per 1,000 minutes = $0.00191 × 1,000 ÷ job length) and today's implied
utilization:

| Job | Per-job items per 1,000 min | Implied u | Cost per 1,000 min at the implied u |
|---|---|---|---|
| 5 min | 0.00191 × 200 = $0.382 | 69.9% | 1,000 ÷ 0.699 × $0.0016636 = $2.380; + $0.382; + fixed $29.792 ÷ 100 = $0.298 → **$3.06** |
| 10 min | 0.00191 × 100 = $0.191 | 79.1% | 1,000 ÷ 0.791 × $0.0016636 = $2.103; + $0.191; + $0.298 → **$2.59** |
| 20 min | 0.00191 × 50 = $0.0955 | 84.6% | 1,000 ÷ 0.846 × $0.0016636 = $1.966; + $0.0955; + $0.298 → **$2.36** |

### Benchmark: what the same minutes cost the customer on GitHub-hosted Linux runners

Source: https://docs.github.com/en/billing/reference/actions-runner-pricing (read 2026-11-23; rates after GitHub's
1 January 2026 price cut, https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/).
GitHub rounds each job up to the whole minute (same page). Same price at every volume (no volume discount listed).
Included usage per plan is now a dollar amount (Free $12, Team $18, Enterprise Cloud $300 a month,
https://docs.github.com/en/billing/concepts/product-billing/github-actions), not subtracted here.

| Runner | Per minute | Per 1,000 min | With rounding, 10-min average job (ESTIMATED +0.5 min per job) |
|---|---|---|---|
| Linux 1-core (slim) | $0.002 | 0.002 × 1,000 = **$2.00** | 2.00 × 10.5 ÷ 10 = $2.10 |
| Linux 2-core x64 (standard) | $0.006 | **$6.00** | 6.00 × 1.05 = $6.30 |
| Linux 4-core x64 | $0.012 | **$12.00** | $12.60 |
| Linux 8-core x64 | $0.022 | **$22.00** | $23.10 |
| Linux 16-core x64 | $0.042 | **$42.00** | $44.10 |
| Linux 32-core x64 | $0.082 | **$82.00** | $86.10 |
| Linux 64-core x64 | $0.162 | **$162.00** | $170.10 |

Reading: on today's setup our cost per 1,000 minutes ($2.07-$8.72, mostly $2.07-$3.26 from 100k minutes up) is below
the 2-core price ($6.00) except at 10k minutes and u = 30%. The margin left is $6.00 − $2.34 = $3.66 per 1,000 at
100k / 90%, before fenvix's own parallel speed-up (which changes how many minutes a suite takes, not this unit cost).
Self-hosted runners are free on GitHub today; the $0.002/min self-hosted platform fee GitHub announced for
1 March 2026 is postponed with no new date (changelog above). If it returns, the customer pays it on top of our
price for every minute on our runners: $2.00 per 1,000 minutes.


## Setups 2-4: the three cheapest viable options from MACHINES.md

Added after MACHINES.md (step 3).
