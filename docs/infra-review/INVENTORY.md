# Infrastructure inventory (fenvix-app, main a3d5cd6, read 2026-11-23)

Read-only review: nothing here was changed or deployed. Every row names the file:line that defines it; `UNKNOWN`
means the repository does not say. Costs are the ones the repository's own docs state (prices DECLARED there, read
2026-11-18, `docs/DEPLOY-AWS.md` 560-584); the fresh prices of this review are in `COST.md` and `MACHINES.md`.
The AWS account number is written `<account>` everywhere.

## Corrections to the brief's "current state"

All lines of the brief were checked. Confirmed unless listed here:

1. **Which fenvix region the stack serves:** the stack is deployed in AWS `eu-west-1` (`infra/github-app/cdk.json:17`,
   `.github/workflows/deploy.yml` env `AWS_REGION: eu-west-1`) and **serves fenvix region `us`**: `fenvixRegion` is
   `"us"` in `cdk.json:35`, the setting can be overridden only by the environment variable `FENVIX_RUNNER_REGION`
   (`lib/settings.ts:144`, `:158-164`), and the deploy workflow does not set it (it passes only `FENVIX_RUNNER_MODE`,
   `deploy.yml:150`). No second region is configured (`cdk.json:36-39` empty). So customers who chose `us` get machines
   in Ireland, and an organization set to `eu` has no placement (the worker's `RUNNER_PLACEMENT` has only the `us` key,
   `lib/stack.ts:161-167`). Whether a repository variable changes it at deploy time: UNKNOWN (variables are not in the
   repository; `deploy.yml` would have to pass it, and it does not).
2. **Runner mode in production:** `cdk.json:40` says `per-job`, but `deploy.yml:150` passes the repository variable
   `FENVIX_RUNNER_MODE`, which wins when set (`settings.ts:160-161`). The value of that variable is UNKNOWN from the
   repository; this review assumes `per-job` as the brief does.
3. **Database connection of the App's Lambdas:** `GITHUB_APP_DATABASE_URL` (`github-app/src/config.ts:191`) is the role
   `fenvix_github_app` through the Supabase pooler in **session mode, port 5432** (`deploy/lib/supabase.mjs:14`,
   `docs/DEPLOY-AWS.md:227`), not transaction mode. Only the dashboard API uses transaction mode, 6543.
4. **`lambda/api.ts:18`** sets `DB_POOL_MAX: "1"` for the API (one connection per container); `DB_POOL_MAX=2`
   (`stack.ts:100`) applies to the other functions; the API's own environment overrides it to `"1"` (`stack.ts:149`).
5. **`launcher.ts:40-45`** is the `WarmupLaunch` description (a warm-up runs the customer's test job outside GitHub
   Actions); the daily cap 6 and reserve 1 are in `github-app/src/warmup/policy.ts:33` (defaults) and `:57-61` (checks),
   set from `cdk.json:46-50`.
6. **Account number** also appears in `.github/workflows/deploy.yml` (env `AWS_ACCOUNT`, `DEPLOY_ROLE`) and
   `docs/DEPLOY-AWS.md:20,88,213,463`, not only `cdk.json:16`. Not copied here.
7. **Lambda count:** 6 functions in per-job mode (http, api, worker, warmup, sweep, reaper); `demo` replaces `warmup`
   in demo mode (`stack.ts:233-260`).
8. **Nested virtualization:** `docs/DEPLOY-AWS.md:579` and `:757-761` already record that C7i supports nested
   virtualization at no extra cost (read there 2026-11-18). This matters for the isolation options in `MACHINES.md`.

## Inventory

| # | Item | What it is | Where it runs | How it scales | Cost at idle / per job (from repo docs) | Defined in |
|---|---|---|---|---|---|---|
| 1 | Runner machine lifecycle: who starts it | The worker Lambda, on a `workflow_job.queued` webhook, requests a just-in-time runner config and calls `RunInstances` from the launch template; the warm-up Lambda does the same for warm-ups | AWS EC2, eu-west-1, zone `a` (`stack.ts:62`) | One machine per job, no pool, nothing pre-started | $0 idle; ≈ $0.0166 per 10-minute machine (c6i.large + IPv4 + disk) | `stack.ts:182-187` (worker), `:193-223` (RunInstances rights), `github-app/src/runners/launcher.ts:343` (cap check) |
| 1a | Image | Ubuntu 24.04 amd64 + `install.sh` (tools, users, IMDS block, engine via `runner/bootstrap.sh` at `engineCliCommit`, GitHub runner, hooks), baked by EC2 Image Builder, run by hand (`scripts/build-image.sh`) or by the deploy when missing | EC2 Image Builder, eu-west-1; build machine = runner type | One AMI per recipe version | Snapshot ≈ 6 GB × $0.05 = $0.30/month; ≈ $0.08 per build | `lib/runner-fleet.ts:57-114`, `lib/runner.ts:5,105-108`, `lib/runner/files/install.sh:1-60`, `cdk.json:60` |
| 1b | Machine type and disk | `c6i.large` (2 vCPU, 4 GiB), 30 GB gp3 encrypted, public IPv4, IMDSv2 hop 1 | EC2 | — | $0.0912/h + IPv4 $0.005/h + disk | `cdk.json:58-59`, `runner-fleet.ts:124-131` |
| 1c | Boot to ready | Queued → job starts ≈ 45-75 s, first test ≈ 1-2.5 min: **ESTIMATE, not measured**; target 30 s (customer mode) | — | — | — | `docs/DEPLOY-AWS.md:515-542` (table, line 536), `docs/REPORT-aws-deploy.md:244`, target `docs/DEPLOY-AWS.md:738` |
| 1d | Idle watchdog | Timer on the machine: no job started within `FENVIX_IDLE_MINUTES` (20) of boot → power off | On the runner machine (systemd timer) | per machine | Bounds a lost job to ≤ 20 min of machine time | `cdk.json:45`, `lib/runner.ts:96`, `lib/runner/files/fenvix-idle-watchdog:2-10` |
| 1e | Reaper | Lambda every 10 minutes terminates `runner-job` machines older than `runnerMaxHours` (6) | Lambda + EventBridge Scheduler, eu-west-1 | — | 4,380 invocations/month, inside free tier | `stack.ts:290-308`, `cdk.json:44` |
| 1f | Fleet cap | At most `runnerMaxRunning` (4) machines per region; more jobs wait (the queue retries) | Worker / warm-up Lambda check | Raise the setting (max 100, `settings.ts:194`); also bounded by the account's EC2 vCPU quota (UNKNOWN in repo) | — | `cdk.json:43`, `launcher.ts:287,302,343` |
| 1g | Termination | Job done → `fenvix-job-done` posts the summary and powers off; shutdown behaviour = terminate, so AWS deletes machine and disk | EC2 | — | Billing stops at termination (per second, 60 s minimum) | `runner-fleet.ts:132-133`, `lib/runner/files/fenvix-job-done:3,10` |
| 2 | Warm-up runs | Scheduler tick every minute → warm-up Lambda dispatches cache-warming runs of onboarded default branches: full test jobs on fleet machines, outside GitHub Actions, never billed to the customer; ≤ 6 per repository per 24 h, 1 per org at once, 1 machine kept free for customers; preempted by a customer job | Lambda + EventBridge Scheduler + EC2 machines of the fleet | Bounded by daily cap × repositories and by the fleet cap minus reserve | Doc example: 10 repos × 6 × 22 days = 1,320 machines ≈ $22/month (ESTIMATE); 43,800 Lambda invocations/month | `stack.ts:45-46,174-179,238-243,279-288`, `github-app/src/warmup/policy.ts:33,57-61`, `launcher.ts:40-45`, `cdk.json:46-50`, `docs/DEPLOY-AWS.md:640-647` |
| 3 | Cache machine | Engine's own cache service (HTTP + SQLite WAL) behind per-job signed tokens, one org per installation; no public address, no outbound route; port 8787 from runners only | EC2 `t4g.nano` (arm64), 8 GB gp3, fixed private IP 10.42.0.10, eu-west-1 | One machine, vertical only; a replacement starts empty | $3.36 + $0.70 = $4.06/month | `lib/cache.ts:44-78`, `lib/cache/cache_service.py`, `cdk.json:51-57`, `docs/DEPLOY-AWS.md:488-513` |
| 4 | Network | One VPC 10.42.0.0/24, one public subnet /26, **no NAT gateway**; each runner gets a public IPv4; runner egress only TCP 443 and 80 to anywhere and 8787 to the cache; no inbound | AWS VPC, eu-west-1, one AZ | /26 = 64 addresses, of which AWS reserves 5 per subnet (docs.aws.amazon.com/vpc/latest/userguide/subnet-sizing.html, from memory, not re-read): ceiling ≈ 58 runners + the cache machine at once (ESTIMATED: 64 − 5 − 1) | Public IPv4 $0.005/h per machine; egress: first 100 GB/month free, then per GB (see `COST.md`); cache traffic stays inside the AZ | `lib/network.ts:5,19-28` (no NAT line 23; egress 29-30; cache 32-36), `runner-fleet.ts:129` |
| 5a | Lambda `http` | Webhooks (signature → SQS, 202), runner summaries, setup and onboarding routes | Lambda Node 22, x86_64, 512 MB, 29 s; behind API Gateway HTTP API (default route and `/v1/runner/*`) | Lambda concurrency; stage throttle 50 rps, burst 100 | Free tier at current volume; ≈ $0.06-0.25/month total Lambda per doc | `stack.ts:109-133,136-141,318-338` |
| 5b | Lambda `api` | Dashboard API (`openapi/fenvix-api.yaml`, `github-app/src/api/`), `/v1/*` except `/v1/runner/*` | Lambda, 512 MB, 29 s; API Gateway HTTP API | Same | Same | `stack.ts:145-154,330`, `github-app/src/lambda/api.ts` |
| 5c | Lambda `worker` | Runs queued webhooks and summaries, launches job machines, preempts warm-ups | Lambda, 512 MB, 120 s; SQS trigger batch 5, max concurrency 2 | Max 2 concurrent | — | `stack.ts:32,182-187,235-237` |
| 5d | Lambda `warmup` | Warm-up scheduler (see row 2) | Lambda, 256 MB, 120 s; Scheduler `rate(1 minute)` | — | — | `stack.ts:238-243,282-287` |
| 5e | Lambda `sweep` | Publishes completed jobs whose runner summary never came | Lambda, 256 MB, 300 s; Scheduler every `sweepMinutes` (1) | — | 43,800 invocations/month | `stack.ts:262-277`, `cdk.json:31` |
| 5f | Lambda `reaper` | Row 1e | Lambda, 256 MB, 120 s; Scheduler every 10 min | — | — | `stack.ts:295-307` |
| 5g | Lambda `demo` | Demo mode only (not deployed in per-job) | Lambda, 256 MB, 180 s; invoked by scripts | — | — | `stack.ts:247-260` |
| 6 | Queue | SQS `work` (SSE, visibility 720 s, retention 4 days), DLQ after 5 tries (14 days, CloudWatch alarm > 0), S3 overflow bucket for payloads > SQS size (claim check, expires 5 days) | SQS + S3, eu-west-1 | Managed | ≈ $0.26-0.28/month without free tier (idle polling) | `stack.ts:72-85,340-352`, `github-app/src/queue/sqs.ts:6-14` |
| 7 | Database | Supabase Postgres. **Engine:** Postgres (version UNKNOWN in repo; tests use Postgres 16, `.github/workflows/test.yml` step "Databases for the tests"). **Plan:** UNKNOWN. **Size:** UNKNOWN. **Backups / PITR:** UNKNOWN (depend on the plan). **Region:** eu-west-1 (pooler host `aws-0-eu-west-1`). **Connection path:** dashboard API as role `fenvix_api` via pooler transaction mode 6543; App Lambdas (http, worker, sweep, warmup) as `fenvix_github_app` via pooler session mode 5432; deploy (migrations, role passwords) via session pooler 5432. Schema: 16 migration files 0001-0017 (no 0006) | Supabase (on AWS eu-west-1) | Supabase plan / compute size (UNKNOWN) | UNKNOWN (not in repo) | `github-app/src/api/db.ts:24-27`, `api/config.ts:13`, `lambda/secrets.ts:7,16,34`, `lambda/api.ts:18`, `config.ts:191`, `deploy/lib/supabase.mjs:10-14`, `docs/DEPLOY-AWS.md:119,227-231`, `supabase/migrations/` |
| 8 | Auth | Dashboard users: Supabase Auth (sign-in only); the API checks the Supabase access token against the project's JWKS (issuer `<supabaseUrl>/auth/v1`, audience `authenticated`). GitHub App: webhook secret, App private key, OAuth client. Runner machines: per-machine signed summary credential and per-job cache token | Supabase Auth; Lambda | Supabase plan (MAU limits UNKNOWN in repo) | Included in Supabase plan (UNKNOWN) | `README.md:5,42-50`, `docs/DEPLOY-AWS.md:150,476`, `lambda/secrets.ts:3-40` |
| 9 | Secrets | SSM Parameter Store SecureString under `/fenvix/<env>/` (created by hand or by the deploy), read by exact name per function at cold start, reloaded after a TTL; bootstrap values under `/fenvix/prod/bootstrap/*`; deploy via GitHub OIDC (no stored AWS key) | SSM, eu-west-1 | — | Standard parameters: no charge (DEPLOY-AWS) | `lambda/secrets.ts:3-40`, `infra/github-app/lib/parameters.ts`, `stack.ts:50`, `deploy.yml:11-16` |
| 10 | Dashboard hosting | Vite SPA on Vercel (console.fenvix.dev), built by Vercel from the repo on each merge; AWS S3 + CloudFront stack exists behind `dashboardOnAws` (off) | Vercel (plan UNKNOWN; doc says "gratis") | Vercel CDN | $0 per doc (ESTIMATED there) | `vercel.json`, `docs/DEPLOY-VERCEL.md:3-12`, `infra/github-app/lib/app.ts:3,26`, `lib/dashboard.ts`, `cdk.json:24` |
| 11 | CI and deploy pipeline | `test.yml` (actionlint, cfn-lint, scratch Postgres 16 and local Supabase, App/API tests, RLS, CDK synth + cdk-nag, deploy steps, dashboard) and `deploy.yml` (on push to main: tests, migrations, secrets, API certificate, CDK deploy, DNS in Cloudflare, image build when missing); GitHub-hosted `ubuntu-24.04`; OIDC to AWS | GitHub Actions (private repo, GitHub Free) | — | Actions minutes from the Free plan quota; ≈ 25-40 min per deploy (ESTIMATE, DEPLOY-AWS) | `.github/workflows/test.yml:4-72`, `.github/workflows/deploy.yml:1-66,145-157`, `docs/DEPLOY-AWS.md:198-200,546-552` |
| 12 | Observability (extra) | CloudWatch log groups per function (14 days), API access logs, DLQ alarm (+ SNS email if set) | CloudWatch, eu-west-1 | — | ≈ $0.11-0.12/month without free tier | `stack.ts:104,332,341-352`, `cdk.json:32-33` |

## One customer job, webhook to check run

```
 customer repo: runs-on: fenvix                         (cdk.json:29 runsOnLabel)
        │ GitHub queues the job
        ▼
 GitHub ──workflow_job.queued (HTTPS, signed)──▶ api.fenvix.dev  API Gateway HTTP API (stack.ts:317-338)
                                                       │ default route
                                                       ▼
                                                http Lambda: verify signature, SQS send (or S3 overflow), 202
                                                       │                                    (stack.ts:136-141)
                                                       ▼
                                                SQS "work" ──▶ worker Lambda (batch 5, ≤ 2 concurrent)
                                                                │ linked installation? fleet < 4? (launcher.ts:343)
                                                                │ generate-jitconfig (one job), sign summary
                                                                │ credential + cache token (per job)
                                                                │ preempt a warm-up machine if the fleet is full
                                                                ▼
                                          EC2 RunInstances (launch template, c6i.large, public IPv4)
                                                                │ ≈ 10-20 s pending→running, 30-50 s boot (ESTIMATE)
                                                                ▼
                     runner machine: user data → just-in-time GitHub runner ──long-poll──▶ GitHub (443)
                        │ job runs: checkout, install, fenvix-run (engine)
                        │     ├──▶ shared cache 10.42.0.10:8787 (token for gh-<installation>)
                        │     └──▶ GitHub, package registries (443/80 via public IPv4)
                        │ job ends → summary.json → fenvix-summary-poster
                        ▼
           POST https://api.fenvix.dev/v1/runner/summaries ──▶ http Lambda ──▶ SQS ──▶ worker Lambda
                        │ fenvix-job-done: power off → terminate (machine and disk deleted)
                        ▼
           worker: writes gh_jobs / ci_runs / ci_usage_events (Supabase, fenvix_github_app, pooler 5432)
                   → GitHub Checks API: check run on the commit (service.ts:600-622)
           sweep Lambda (every minute): publishes jobs whose summary never came (after 600 s, cdk.json:30)
           reaper Lambda (every 10 min): terminates machines older than 6 h
```
