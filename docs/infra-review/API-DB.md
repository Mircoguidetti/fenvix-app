# API hosting and database options

Read-only review, 2026-11-23. List prices read on 2026-11-23 (sources per row), USD, before tax. Usage figures are
**ESTIMATED** (no production metrics in the repository). Free tiers are not subtracted.

Sources used throughout (read 2026-11-23):
- [LAMBDA] https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/eu-west-1/index.json: $0.20 per 1M
  requests, $0.0000166667 per GB-s (x86).
- [APIGW] https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonApiGateway/current/eu-west-1/index.json: HTTP API
  $1.11 per 1M.
- [SQS] https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSQueueService/current/eu-west-1/index.json: $0.40 per 1M.
- [ECS] https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/eu-west-1/index.json: Fargate x86
  $0.04048 per vCPU-h, $0.004445 per GB-h; https://aws.amazon.com/fargate/pricing/: per second, 1-minute minimum.
- [ELB] https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSELB/current/eu-west-1/index.json: ALB $0.0252 per
  hour, $0.008 per LCU-hour.
- [VPC] https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/eu-west-1/index.json: public IPv4
  $0.005 per hour.
- [LIMITS] https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html: function timeout up to 1,800 s
  (30 minutes). **This corrects the usual "15 minutes".**
- [BATCH] https://docs.aws.amazon.com/batch/latest/userguide/when-to-use-fargate.html: "jobs that run on Fargate can be
  provisioned in about 30 seconds".
- [RDS] https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/20261120224619/eu-west-1/index.json
- [SB] Supabase's own site and docs source, https://raw.githubusercontent.com/supabase/supabase/master/
  (`packages/shared-data/plans.ts`, `apps/docs/content/guides/platform/compute-and-disk.mdx`, `.../backups.mdx`,
  `.../connecting-to-postgres.mdx`, `.../regions.ts`). supabase.com itself was not reachable from this session; the
  source files may lag the live page.
- [NEON] Neon's own docs source, https://raw.githubusercontent.com/neondatabase/website/main/content/docs/introduction/plans.md
  (updated 2026-11-18), `.../scale-to-zero.md`, `.../regions.md`, `.../connect/connection-pooling.md`. neon.com was not
  reachable from this session.
- [AURORA-PAUSE] https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html

## Part 1: API

### What is served today

Two request kinds reach AWS (`INVENTORY.md` rows 5-6):

- **Dashboard API requests** (`/v1/*`): API Gateway HTTP API → `api` Lambda (512 MB, 29 s) → Supabase pooler.
- **Webhook deliveries** (GitHub → `http` Lambda, 512 MB → SQS → `worker` Lambda, 512 MB, up to 120 s). The worker
  may start an EC2 machine and call GitHub.

Plus the scheduled functions (sweep every minute, warm-up every minute, reaper every 10 minutes), which run on every
option (as Lambdas or as timers inside the service).

### Per-request assumptions (ESTIMATED)

| Item | Value |
|---|---|
| API request, Lambda duration | 100 ms at 512 MB = 0.05 GB-s |
| Webhook, `http` Lambda | 50 ms at 512 MB = 0.025 GB-s |
| Webhook, `worker` Lambda | 500 ms at 512 MB = 0.25 GB-s (GitHub API calls, database writes) |
| Webhook, SQS | 3 requests (send, receive, delete) |
| Average response size | 10 KB (for ALB processed bytes) |

### Option A: Lambda as today

- **Cold start:** UNKNOWN measured; Node 22 with a bundled, minified ESM handler plus an SSM read at cold start
  (`lambda/secrets.ts`): ESTIMATED 0.5-1.5 s on the first request of a new container (`docs/DEPLOY-AWS.md:531` already
  assumes "cold start adds 1-2 s").
- **Maximum duration:** 30 minutes per invocation [LIMITS]; behind API Gateway the HTTP request itself is limited to
  29 s (the functions' timeout is set to 29 s, `stack.ts:137,146`).
- **Operational burden:** lowest: no machine, no patching, scales to zero; limits to watch: database connections per
  concurrent container (pool 1-2 today), the 6 MB synchronous payload limit (`docs/DEPLOY-AWS.md:495-497`).
- **Unit costs:** API request = $1.11/1M [APIGW] + $0.20/1M [LAMBDA] + 0.05 GB-s × $0.0000166667 = $0.00000111 +
  $0.0000002 + $0.00000083 = **$0.00000214**. Webhook = $1.11/1M + 2 × $0.20/1M + (0.025 + 0.25) GB-s ×
  $0.0000166667 + 3 × $0.40/1M = $0.00000111 + $0.0000004 + $0.00000458 + $0.0000012 = **$0.00000729**.
- **Fixed:** $0 for the API itself (the schedules' $0.43 a month is the same on every option and left out here).

| Volume | Arithmetic | Cost / month |
|---|---|---|
| 10k API requests | 10,000 × $0.00000214 | **$0.02** |
| 100k API requests | 100,000 × $0.00000214 | **$0.21** |
| 1M API requests | 1,000,000 × $0.00000214 | **$2.14** |
| 1k webhooks | 1,000 × $0.00000729 | **$0.007** |
| 10k webhooks | 10,000 × $0.00000729 | **$0.07** |
| 100k webhooks | 100,000 × $0.00000729 | **$0.73** |

### Option B: container service (ECS Fargate behind an Application Load Balancer)

Shape (ESTIMATED): 2 tasks of 0.25 vCPU / 0.5 GB (x86) for availability, in public subnets with a public IPv4 each
(no NAT gateway, as today); one ALB in 2 zones (2 public IPv4); SQS kept for webhooks (the worker runs in the same
service, polling the queue).

- **Cold start:** none for requests (tasks always on); a new task starts in "about 30 seconds" [BATCH] when scaling or
  replacing.
- **Maximum duration:** no maximum task duration stated by AWS [ECS pricing page]; request duration limited by the ALB
  idle timeout (configurable).
- **Operational burden:** medium: container image build and registry, task definitions, health checks, deploy
  rollouts, scaling policy, the ALB; no OS patching.
- **Fixed per month:** tasks 2 × (0.25 × $0.04048 + 0.5 × $0.004445) × 730 h = 2 × $0.0123425 × 730 = $18.02; ALB
  $0.0252 × 730 = $18.40; 4 public IPv4 (2 tasks + 2 ALB nodes) × $0.005 × 730 = $14.60 → **$51.02**.
- **Per request:** ALB LCU from processed bytes: 1 LCU = 1 GB per hour of processed bytes (ESTIMATED: AWS's LCU
  definition, not re-read today); 10 KB × N ÷ 1 GB × $0.008. Webhook: + 3 × $0.40/1M SQS.

| Volume | Arithmetic | Cost / month |
|---|---|---|
| 10k API requests | $51.02 + 10,000 × 10 KB = 0.1 GB → 0.1 LCU-h × $0.008 = $0.0008 | **$51.02** |
| 100k API requests | $51.02 + 1 GB → $0.008 | **$51.03** |
| 1M API requests | $51.02 + 10 GB → $0.08 | **$51.10** |
| 1k webhooks | $51.02 + 1,000 × ($0.0000012 SQS) + 0.01 GB ALB ≈ $0.0012 | **$51.02** |
| 10k webhooks | $51.02 + $0.012 + $0.0008 | **$51.03** |
| 100k webhooks | $51.02 + $0.12 + $0.008 | **$51.15** |

The fixed $51.02 is shared: the API and the webhooks run in the same service, so do not add the two columns' fixed
parts twice.

### Option C: one small always-on VM

Shape (ESTIMATED): one Hetzner Cloud CPX22 (2 shared vCPU, 4 GB, Nuremberg) running the API, the webhook receiver
and the worker as one Node service behind a TLS reverse proxy, with the schedules as timers. Price €19.99/month cap
(NBG1; €0.0272/h) (https://www.hetzner.com/cloud/regular-performance, read 2026-11-23); × $1.10 per € (ASSUMED rate,
see `MACHINES.md`) = **$21.99**. The page labels prices "incl. IPv4" while the docs list a Primary IPv4 at €0.50/month:
whether that is extra is UNKNOWN (+$0.55 if it is). Traffic: 20 TB included. The same shape on AWS in eu-west-1, next
to the database, would cost more: the cheapest x86 size priced in this review, c7i.large, is $0.09576 × 730 =
$69.90 + IPv4 $3.65 = $73.55 (AWS t3/t4g small sizes were not read today: UNKNOWN).

- **Cold start:** none (always on); a restart or deploy drops requests for seconds unless two instances run behind
  a load balancer (price of Hetzner's load balancer not read: UNKNOWN).
- **Maximum duration:** none.
- **Operational burden:** highest: OS patching, TLS certificates, process supervision, deploys, monitoring and a
  single point of failure; the webhook queue must be durable (keep SQS, which needs AWS credentials on the VM, or a
  table-based queue in Postgres: code change). Latency to Supabase in Ireland from Nuremberg: UNKNOWN (not measured).
- **Per request:** $0 on the VM (inside its capacity: 1M requests a month is 0.4 requests per second on average,
  ESTIMATED 1,000,000 ÷ 2,592,000 s); webhooks + 3 × $0.40/1M if SQS is kept.

| Volume | Arithmetic | Cost / month |
|---|---|---|
| 10k API requests | $21.99 + 0 | **$21.99** |
| 100k API requests | $21.99 + 0 | **$21.99** |
| 1M API requests | $21.99 + 0 | **$21.99** |
| 1k webhooks | $21.99 + 1,000 × $0.0000012 = $0.0012 | **$21.99** |
| 10k webhooks | $21.99 + $0.012 | **$22.00** |
| 100k webhooks | $21.99 + $0.12 | **$22.11** |

The fixed $21.99 is shared between the API and webhook columns, as for option B.

### API: reading

At every volume in the brief (up to 1M API requests and 100k webhooks a month), Lambda costs under $3 a month and
needs no machine; Fargate costs ≈ $51 and the VM ≈ $22 regardless of volume. Lambda stays cheapest by a wide margin
until roughly $21.99 ÷ $0.00000214 ≈ 10M API requests a month (ESTIMATED break-even with the VM). The API is not
where the margin is.

## Part 2: database

### Today

Supabase Postgres in eu-west-1 (`INVENTORY.md` row 7). **Plan: UNKNOWN. Database size: UNKNOWN.** Assumed here:
**1 GB (ESTIMATED)** today and **10 GB** at 10x. Connection paths: the dashboard API through the Supavisor pooler in
transaction mode (6543), the App's Lambdas through the pooler in session mode (5432), the deploy through the session
pooler.

**What ties the schema to Supabase** (counted in this repository): 14 of the 16 migration files reference Supabase's
roles or Auth schema (`anon`, `authenticated`, `service_role`, `auth.uid()`, `auth.users`): `auth.users` 13 times and
`auth.uid()` 8 times (`grep` over `supabase/migrations/`, 3,614 lines in all). Dashboard sign-in is Supabase Auth
(`README.md:42-50`), and the API verifies Supabase's JWTs (`docs/DEPLOY-AWS.md:476`). Moving the database off
Supabase therefore means either keeping a Supabase project for Auth only, or replacing Auth too.

### Load assumption (ESTIMATED)

The `sweep` Lambda queries the database every minute and the `warmup` Lambda every minute (`stack.ts:270-287`):
the database is never idle for 5 minutes, so **scale-to-zero never happens** on Neon or Aurora with today's
schedules. Smallest compute is assumed always on.

### The five options

| Option | Price at today's size (1 GB, ESTIMATED) | Price at 10x (10 GB) | Connection handling from Lambda | Backups and point-in-time restore | EU region | Migration effort from today |
|---|---|---|---|---|---|---|
| **Supabase Free** | $0 [SB plans.ts] — **does not fit**: the Free database limit is 500 MB, and "Free projects are paused after 1 week of inactivity" | does not fit (500 MB) | Same as today (Supavisor 6543 / 5432, IPv4 on all plans [SB connecting-to-postgres.mdx]) | **No automatic backups** on Free [SB backups.mdx] | Ireland, London, Paris, Frankfurt, Zurich, Stockholm [SB regions.ts] | None (same product). Not viable for production: 500 MB limit, pausing, no backups. |
| **Supabase Pro** (Micro compute) | $25 ("From", includes one Micro project: $10 compute credits cover Micro $0.01344/h ≈ $10) [SB plans.ts, compute.mdx]; 8 GB disk included → **$25.00** | 25 + (10 − 8) × $0.125/GB = **$25.25**; Micro's recommended maximum database is 10 GB [SB compute-and-disk.mdx], so the next step is Small: 25 + 15 − 10 + 0.25 = **$30.25** | Today's path: Supavisor transaction mode 6543 (no prepared statements), session mode 5432; Micro allows 60 direct connections / 200 pooler clients [SB compute-and-disk.mdx] | Daily backups kept 7 days on Pro [SB backups.mdx]; PITR add-on 7 days ≈ $100/month ($0.137/h), 14 days ≈ $200, 28 days ≈ $400 [SB pricing_pitr.mdx] | Same as Free | None (assumed to be today's plan). |
| **Amazon RDS for PostgreSQL** db.t4g.micro, Single-AZ, gp3 | Instance $0.017/h × 730 = $12.41 [RDS]; storage: allocated 20 GB (ESTIMATED minimum for gp3, not read today) × $0.127 = $2.54 → **$14.95**; + RDS Proxy for Lambda $0.016 per vCPU-h of the instance [RDS], minimum 2 vCPU UNKNOWN from a primary source → if it applies 2 × 0.016 × 730 = $23.36 → **$38.31** with proxy. Multi-AZ: $0.035/h × 730 = $25.55 + 20 × $0.254 = $5.08 → $30.63 (+ proxy) | Same 20 GB allocation → $14.95 ($38.31 with proxy); a larger instance if needed: db.t4g.small $0.035/h → $25.55 + $2.54 = $28.09 | No built-in pooler: RDS Proxy (above) or keep pool size 1 per Lambda container and rely on the low concurrency (worker max 2) | Automated backups with PITR, retention 0-35 days [https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.BackupRetention.html]; backup storage beyond the free allocation $0.095/GB-month [RDS] | eu-west-1 (same region as the Lambdas) | **High**: replace `auth.users` and `auth.uid()` in 14 migrations, recreate the `anon`/`authenticated` roles and RLS policies, keep Supabase Auth (separate project) or move sign-in to another provider (dashboard and API token check change), data copy (`pg_dump`/`pg_restore`), new deploy steps (`deploy/lib/supabase.mjs`, `roles.mjs`, `migrate.mjs`). ESTIMATED 5-8 days. |
| **Aurora Serverless v2** (PostgreSQL), Standard | Never pauses (see load assumption) → minimum 0.5 ACU: 0.5 × $0.14 × 730 = $51.10 [RDS; AURORA-PAUSE]; storage 1 × $0.11 = $0.11; I/O ESTIMATED 10M × $0.22/1M = $2.20 → **$53.41** | $51.10 + 10 × $0.11 + $2.20 = **$54.40** (I/O assumed unchanged) | **Data API** (HTTP, no connection pool) available for Aurora Serverless v2, $0.373 per 1M requests; or RDS Proxy ($0.018 per ACU-h, minimum 8 ACU UNKNOWN from a primary source; a proxy prevents auto-pause) [RDS] | Continuous backup with PITR up to 35 days; backup storage beyond free allocation $0.021/GB-month [RDS] | eu-west-1 | Same as RDS (**high**, 5-8 days) + Data API changes if used (the code uses `pg` directly). |
| **Neon** (Launch plan) | Never scales to zero (scale-to-zero after 5 min idle [NEON scale-to-zero.md]) → 0.25 CU always on (ESTIMATED smallest size): 0.25 × $0.106 × 730 = $19.35; storage 1 × $0.35 = $0.35; restore history ESTIMATED 1 GB × $0.20 = $0.20 → **$19.90** [NEON plans.md] | $19.35 + 10 × $0.35 + 2 GB history × $0.20 = **$23.25** | PgBouncer transaction mode, up to 10,000 clients (`-pooler` host) [NEON connection-pooling.md]; serverless driver over HTTP/WebSockets with a Lambda guide | Instant restore (PITR) history: Launch up to 7 days, $0.20/GB-month; snapshots $0.09/GB-month [NEON plans.md] | **Frankfurt (aws-eu-central-1) and London (aws-eu-west-2) only, not Ireland** [NEON regions.md]: the Lambdas in eu-west-1 would cross regions (latency per query UNKNOWN, not measured) | Same as RDS (**high**, 5-8 days), plus a region decision. Free plan (100 CU-hours per month) does not cover 0.25 CU × 730 h = 182.5 CU-hours. |

Notes:
- RDS's minimum gp3 allocation (20 GB) and the ALB's LCU definition were not re-read today: marked ESTIMATED.
- Neon's compute prices were cut on 2025-11-07 (Launch $0.14 → $0.106 per CU-hour) per Neon's changelog
  (https://raw.githubusercontent.com/neondatabase/website/main/content/changelog/2025-11-07.md).
- If the sweep and warm-up schedules were made event-driven, Aurora could pause (≈ 15 s resume, ≥ 30 s after 24 h
  paused [AURORA-PAUSE]) and Neon could scale to zero ("a few hundred milliseconds" [NEON]); that is a code change
  outside this review.
- **Reading:** at today's size Supabase Pro ($25) is in the same range as RDS micro with a proxy ($38) or Neon
  ($20), includes Auth and costs no migration. The database is not where the margin is (compare `COST.md`: machines
  are 80-95% of cost from 100k minutes up).
