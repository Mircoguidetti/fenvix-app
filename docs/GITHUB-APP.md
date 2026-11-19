# The fenvix GitHub App

The GitHub side of fenvix, as a service (`github-app/`). What it does:

1. **Webhooks** (`POST /webhooks/github`), signature checked (`X-Hub-Signature-256`, HMAC-SHA256 with the webhook
   secret, constant-time) before anything else: `installation`, `installation_repositories`, `push`, `pull_request`,
   `workflow_job`. Each delivery is handled once (`X-GitHub-Delivery`); the App answers `202` at once and works in the
   background (GitHub waits 10 seconds at most).
2. **Installation per organization.** An installation is stored when GitHub announces it and becomes an organization's
   only after the person who installed it comes back through the setup callback (signed `state`, OAuth code, and
   GitHub confirming that this person can see the installation) and is an owner or admin of that organization
   (migration `supabase/migrations/0013_github_app.sql`, row level security, `gh_link_installation()`).
3. **Onboarding pull request.** When a repository is added, the App reads its workflows, finds the job that runs the
   tests, changes **only that job's `runs-on:`** to `fenvix` (comments, quoting and every other line kept byte for
   byte), and opens a pull request from the branch `fenvix/runs-on` with the diff in the body. With "All repositories"
   the App does not open pull requests across a whole account by itself: the dashboard asks for them per repository
   through the dashboard API (`POST /v1/github/repositories/{repositoryId}/setup-pull-request`), which queues the work
   `{ "kind": "onboard", "repositoryId": <GitHub's id> }` for the worker. Every repository's state (`pending`,
   `pr_open`, `merged`, `closed`, `no_workflow`, `no_test_job`, `already_fenvix`, `unsupported`, `failed`) is stored
   with a detail. The language and test runner are detected (workflow, else the run's summary), never assumed.
4. **Run result on GitHub.** A job that asks for `runs-on: fenvix` gets a check run named `fenvix` on its commit (in
   progress while it runs), completed with: tests run, tests skipped with proof (with the link to the receipts),
   minutes saved, failures, and flaky tests explained with their replay command. On a pull request, one short comment,
   updated in place on every run. The input is the run summary our runner writes (`runner/fenvix-run`,
   `summary.json`), sent by the machine to `POST /v1/runner/summaries`.
5. **Runs and usage events** in Postgres: a `ci_runs` row per job (the dashboard's run, `docs/data-contract.md`),
   created `running` when the job starts on a fenvix machine and finished at publish, and one `ci_usage_events` row
   per job that used a fenvix machine, for billing by run units.
6. **What the runner sends besides the summary** (`docs/data-contract.md`, "What the runner sends"): live progress
   (`POST /v1/runner/progress`, written at once), per-test results, receipts, defect bundles and audit reruns in chunks
   (`POST /v1/runner/results`), nightly explorations (`POST /v1/runner/explorations`).
7. **Trial and region.** Linking an organization's first installation starts its 30-day shadow trial: machines get
   `FENVIX_MODE=shadow` and runs are `mode: shadow` until it ends. A job's machine starts in the organization's region
   (`us` or `eu`, `RUNNER_PLACEMENT`), or not at all.

The App never deploys anything and has no GitHub Actions workflow of its own. Nothing here is live until the founder
creates the App and runs the service.

---

## Create the App (the founder, about 15 minutes, $0)

Before you start, decide two addresses (they can be changed later on the App's settings page):

- `APP_HOST`: where the service will answer, e.g. `https://github.fenvix.dev` (must be https, reachable by GitHub).
- `DASHBOARD_URL`: the dashboard, e.g. `https://app.fenvix.dev`.

Generate the webhook secret on your machine and keep it in your password manager (never in a chat or in git):

```
openssl rand -hex 32
```

### 1. New GitHub App

Where the App lives decides who owns it. For a company-owned App: **github.com → your organization → Settings →
Developer settings → GitHub Apps → New GitHub App**. (For a personal one: your avatar → Settings → Developer settings →
GitHub Apps → New GitHub App.)

Fill in, top to bottom:

| Field | Value |
|---|---|
| GitHub App name | `fenvix` (if taken: `fenvix-ci`). The URL name (slug) GitHub derives from it is `GITHUB_APP_SLUG` |
| Description | `Runs your test jobs on fenvix machines: skip unchanged tests with proof, turn flaky tests into reproducible defects.` |
| Homepage URL | `DASHBOARD_URL` |
| **Identifying and authorizing users** → Callback URL | `APP_HOST/github/setup` |
| Expire user authorization tokens | ✔ (leave on) |
| **Request user authorization (OAuth) during installation** | ✔ **on** (the App uses it once, to confirm who installed it; with it on, GitHub sends people to the Callback URL after installing, so the Setup URL field is not used) |
| Enable Device Flow | off |
| **Post installation** → Redirect on update | ✔ on |
| **Webhook** → Active | ✔ on |
| Webhook URL | `APP_HOST/webhooks/github` |
| Webhook secret | the value from `openssl rand -hex 32` above |
| SSL verification | Enable (default) |

### 2. Permissions

**Repository permissions** (everything else stays "No access"):

| Permission | Access | Why |
|---|---|---|
| Actions | **Read-only** | read the workflow run of a job (its trigger, commit message and pull request); needed for the `workflow_job` event |
| **Administration** | **Read and write** | one machine per job (`DEPLOY-AWS.md`): `POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig` creates the just-in-time runner of one queued job, on that repository only. Used for nothing else |
| Checks | **Read and write** | the `fenvix` check run on each commit |
| Contents | **Read and write** | read the workflow files; create the `fenvix/runs-on` branch and commit the one-line change on it |
| Metadata | **Read-only** | mandatory for every App (GitHub sets it) |
| Pull requests | **Read and write** | open the onboarding pull request; the one comment per pull request, updated in place |
| **Workflows** | **Read and write** | **required by GitHub to change any file under `.github/workflows/`**: without it the commit of the onboarding change is refused (Contents: write is not enough). Not in the original list of P-017; see the session report |

**Organization permissions**: none. **Account permissions**: none.

> Just-in-time runners (one machine per job, `DEPLOY-AWS.md`) use **Administration: Read and write** on the
> repository. The organization permission **Self-hosted runners: Read and write** would also allow it, but not for
> personal accounts, and its runners could take any repository's jobs; it is not used. Customers who installed the App
> before must approve the added permission.

### 3. Events

Under **Subscribe to events**, tick:

- **Pull request**
- **Push**
- **Workflow job** (the box appears once Actions is Read-only)

`installation` and `installation_repositories` are sent to every GitHub App without a box to tick.

### 4. Where can this GitHub App be installed?

- **Only on this account** while you try it on your own repositories.
- **Any account** when customers install it (Settings → Advanced → Make public, later).

Click **Create GitHub App**.

### 5. The values to copy (General page of the App)

| On the page | Becomes |
|---|---|
| **App ID** (top, "About") | `GITHUB_APP_ID` (a number; not secret) |
| **Client ID** | `GITHUB_CLIENT_ID` (not secret) |
| **Generate a new client secret** → copy it once | `GITHUB_CLIENT_SECRET` (**secret**) |
| **Private keys → Generate a private key** → a `.pem` file downloads | `GITHUB_APP_PRIVATE_KEY_FILE` (path of the mounted file) or `GITHUB_APP_PRIVATE_KEY` (its content) (**secret**) |
| the public page `https://github.com/apps/<slug>` | `GITHUB_APP_SLUG` |
| the webhook secret you generated | `GITHUB_WEBHOOK_SECRET` (**secret**) |

On AWS (`DEPLOY-AWS.md`), the secrets are SSM SecureString parameters under `/fenvix/prod/github-app/`. Otherwise,
put the secrets straight into the secret store of the machine that will run the service (e.g. AWS Secrets Manager or
SSM Parameter Store, injected as environment variables or mounted files). Never in git, never in a chat, never in a
ticket. Delete the downloaded `.pem` from your laptop once it is stored.

Optional: upload the fenvix logo under "Display information".

### 6. The database role

In Supabase → SQL editor, run `supabase/migrations/0013_github_app.sql` (after 0001–0012; safe to repeat). It
creates the role `fenvix_github_app` **without a password**. Then, with a long random password of your own
(`openssl rand -base64 36`):

```
alter role fenvix_github_app with password '<the password>';
```

Build `GITHUB_APP_DATABASE_URL` from Supabase → Project Settings → Database → Connection string (pooler in
*transaction* mode, or direct), with the user `fenvix_github_app` (for the pooler: `fenvix_github_app.<project-ref>`)
and that password. It is a **secret**. On AWS Lambda use the **session** pooler (port 5432): Lambda has no IPv6 for
the direct host; see `DEPLOY-AWS.md`, step 8.

### 7. Two more secrets

```
openssl rand -hex 32   # STATE_SIGNING_KEY: signs the installation link's state
openssl rand -hex 32   # RUNNER_TOKEN: signs each runner machine's own summary credential
```

`RUNNER_TOKEN` goes into the same secret store. It never goes onto a machine: the App (worker, demo function) signs a
credential for each machine with it, bound to that machine's runner name and repository (and, per job, its run), and
the HTTP side checks it (`src/runners/credentials.ts`; review R-012 F1).

---

## Environment variables

| Variable | Default | Secret | What |
|---|---|---|---|
| `GITHUB_APP_DATABASE_URL` | required | **yes** | Postgres connection string of the role `fenvix_github_app` (never `postgres`, never `service_role`) |
| `GITHUB_APP_ID` | required | no | the App ID |
| `GITHUB_APP_SLUG` | required | no | the App's URL name; the install link is `https://github.com/apps/<slug>/installations/new` |
| `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_FILE` | required | **yes** | the `.pem` GitHub generated (PKCS#1 or PKCS#8; literal `\n` accepted) |
| `GITHUB_WEBHOOK_SECRET` or `_FILE` | required | **yes** | at least 20 characters; the same value as on the App's page |
| `GITHUB_CLIENT_ID` | required | no | the App's Client ID |
| `GITHUB_CLIENT_SECRET` or `_FILE` | required | **yes** | the App's client secret |
| `DASHBOARD_URL` | required | no | e.g. `https://app.fenvix.dev`: links in check runs and comments, redirect after setup |
| `SUPABASE_URL` | required | no | `https://<ref>.supabase.co`: session tokens of dashboard users are checked against its JWKS |
| `SUPABASE_JWKS_URL` | `SUPABASE_URL/auth/v1/.well-known/jwks.json` | no | |
| `STATE_SIGNING_KEY` or `_FILE` | required | **yes** | at least 32 characters |
| `RUNNER_TOKEN` or `_FILE` | required (HTTP); the per-job worker signs with it | **yes** | at least 32 characters; `RUNNER_TOKEN_PREVIOUS` still verifies during a rotation |
| `CACHE_SIGNING_KEY` or `_FILE` | per-job worker only | **yes** | RSA private key (PEM): signs one shared-cache token per job, for its installation's cache organization |
| `GITHUB_API_URL` | `https://api.github.com` | no | GitHub Enterprise Server: `https://HOST/api/v3` |
| `GITHUB_WEB_URL` | `https://github.com` | no | links and the install page |
| `GITHUB_OAUTH_URL` | `GITHUB_WEB_URL` | no | where the OAuth code is exchanged |
| `FENVIX_RUNS_ON` | `fenvix` | no | the label written into `runs-on:` and the label that marks a fenvix job |
| `ONBOARDING_BRANCH` | `fenvix/runs-on` | no | branch of the onboarding pull request |
| `ONBOARD_ALL_REPOSITORIES` | `false` | no | `true`: open onboarding pull requests by themselves also when the installation covers "All repositories" |
| `SUMMARY_WAIT_SECONDS` | `600` | no | a completed job whose runner summary never came is published without it after this long |
| `RUNNER_PLACEMENT` | none | no | per-job worker: where each region's machines start, JSON `{"us": {"awsRegion": "us-east-1", "launchTemplateId": "lt-..."}, "eu": {"awsRegion": "eu-central-1", "launchTemplateId": "lt-...", "machineEnv": {...optional overrides}}}`. Without a `us` entry, `RUNNER_LAUNCH_TEMPLATE_ID` is the US placement (in the function's own AWS region). A region with no placement gets no machine |
| `SWEEP_SECONDS` | `60` | no | how often that check runs; `0` off |
| `WARMUP_ENABLED` | `true` | no | warm-up runs of onboarded repositories' default branches (they need a per-job launcher; `docs/data-contract.md` "Warm-up runs") |
| `WARMUP_GRACE_SECONDS` | `180` | no | after a push (or the setup pull request's merge), how long the customer's own push run may cover the commit before a warm-up may start |
| `WARMUP_DAILY_CAP` | `6` | no | warm-ups of one repository that take a machine in any 24 hours |
| `WARMUP_ORG_CONCURRENCY` | `1` | no | warm-ups of one organization on machines at once |
| `WARMUP_RESERVE` | `1` | no | machines of a region's fleet a warm-up never takes (kept for customers' jobs) |
| `WARMUP_START_TIMEOUT_SECONDS`, `WARMUP_MAX_SECONDS`, `WARMUP_WAITING_JOB_WINDOW_SECONDS`, `WARMUP_PREEMPT_BACKOFF_SECONDS`, `WARMUP_MAX_ATTEMPTS` | `900`, `10800`, `3600`, `300`, `3` | no | a machine that never reported "started" is given up; a warm-up running longer is stopped; a customer job queued without a machine this recently blocks warm-ups in its region; a preempted warm-up waits this long; machines per warm-up |
| `WARMUP_TICK_SECONDS` | `60` | no | node server: how often the warm-up scheduler runs (`0` off; on AWS the `warmup` Lambda's schedule runs it) |
| `PORT`, `HOST`, `LOG_LEVEL`, `NODE_ENV`, `DB_POOL_MAX`, `GITHUB_TIMEOUT_MS` | `8790`, `0.0.0.0`, `info`, `development`, `10`, `15000` | no | |

`NODE_ENV=production` refuses plain-http URLs. The service never logs a secret, the `Authorization` header or the
signature header.

---

## How it works

### Connecting an installation to an organization

```
dashboard (signed in, owner/admin)  POST /v1/github/install-link {workspaceId}
   → https://github.com/apps/<slug>/installations/new?state=<signed: organization, person, 1 hour>
GitHub: the person installs the App, chooses repositories        → webhook installation.created (stored, not linked)
GitHub → APP_HOST/github/setup?installation_id&setup_action&code&state
   1. state signature and expiry
   2. code → user token (POST github.com/login/oauth/access_token with the client id and secret)
   3. GET /user/installations with that token must list installation_id
   4. GET /user, GET /app/installations/{id}: the GitHub user administers the installation's account
      (User account: the same user; Organization: GET /user/memberships/orgs/{org} is role admin, state active)
      (review R-016 F1: seeing an installation only takes read access to one of its repositories)
   5. early checks: the person is an owner or admin; the installation is not another organization's
   6. a single-use completion (gh_install_completions, 10 minutes; the state is consumed)
   → 303 to DASHBOARD_URL/projects/connect?github=confirm&installation=<id>&account=<login>#completion=<code>
     (or github=error&reason=...)
dashboard, signed in → POST /v1/github/installations/complete {completion}        (review R-016 F2)
   7. api_complete_github_link: the completion is this signed-in person's, unexpired, unused
   8. gh_link_installation(installation, organization, person): owner or admin; not another organization's
   9. the 30-day shadow trial starts only for an organization's first installation, and only once per GitHub account
   → the worker syncs the installation's projects (work kind installation_linked); the dashboard shows
     ?github=connected&installation=<id>&account=<login>
```

The link is completed in the signed-in person's own session, never by the setup redirect: someone who installs the App
from another person's install link connects nothing to that person's organization.

An organization may link several installations (e.g. two GitHub organizations). Each repository's project records
the installation it came through; runs, usage events and the plan are the organization's; the trial starts at the first
link only; `ci_subscriptions.github_account` keeps the first installation's account (the dashboard lists every
installation). A repository moved (or renamed) between installations of the same organization keeps its project and
its runs.

### What a runner machine sends

The full contract (what, when, every field) is `docs/data-contract.md`, "What the runner sends", and the operations
tagged `runner` of `openapi/fenvix-api.yaml`. In short: progress while the job runs (`/v1/runner/progress`, at most
every 3 seconds, written at once; an older `seq` is ignored), the results chunks when the test step ends
(`/v1/runner/results`, stored in `gh_run_results` and applied to the run at publish, or on arrival after it), then the
summary. All four routes take the same per-machine credential and check the body against the OpenAPI request schema
(`400` with `error.field`).

When the test step ends, the fenvix machine posts the runner's `summary.json` (as `runner/fenvix-run` writes it):

```
POST APP_HOST/v1/runner/summaries
Authorization: Bearer <this machine's summary credential, fxr1....>
{"repositoryId": $GITHUB_REPOSITORY_ID, "runId": $GITHUB_RUN_ID, "runAttempt": $GITHUB_RUN_ATTEMPT,
 "runnerName": $RUNNER_NAME, "receiptsUrl": "<https link to the receipts, optional>", "summary": {...summary.json...}}
```

The runner name, the repository and (per-job machines) the run come from the credential; a body that names others
is refused (403), and a bare `RUNNER_TOKEN` is not a credential (401). A runner runs one job at a time, so
repository + run + attempt + runner name is one job. The App matches it with
the `workflow_job` events of that job, whichever comes first, and publishes once both are in (or after
`SUMMARY_WAIT_SECONDS` without a summary, or at once when the job was cancelled). The per-test maps (`outcomes`,
`reused_outcomes`) are dropped before the summary is stored.

### Billing rule (usage events)

One `ci_usage_events` row per GitHub job that asked for `runs-on: fenvix`, unique per job id (a webhook delivered
twice is never billed twice):

| case | billable | reason |
|---|---|---|
| summary received, job succeeded | yes | `completed` |
| summary received, job failed | yes | `failed` |
| summary received, job cancelled | yes | `cancelled_after_start` |
| no summary, the job ran on our machine | yes | `no_summary` (a machine was used; e.g. dependency install failed) |
| cancelled or skipped before it started on our machine | no | `cancelled_before_tests` |
| started on our machine, cancelled before a summary | no | `cancelled_before_tests` |

Run rows follow the same rule: a job that never started on our machine gets no `ci_runs` row. A job that started gets
its row at once (status `running`, for the live view); if it then ends without being billable, the row is kept and
marked `cancelled` (the App's role may not delete runs) and its usage event is not billable. Usage and units are
counted from billable usage events only (1 run unit = 10 baseline minutes).

The row carries the plan at that time, test minutes run, minutes saved and other-step minutes. An installation not yet
linked to an organization still gets its usage events (organization empty); linking fills it in. Prices and plan
limits are not applied here (no billing now, RULES.md).

### Which job is "the test job"

Every workflow on the default branch is read. A job scores when a `run:` step runs a test command (pytest,
`python -m pytest`, `uv run pytest`, tox/nox, vitest, jest, `go test`, `npm|pnpm|yarn|bun test`, `make test`),
not counting lines that only install a test runner; a job named like tests scores more, one named like lint, build,
release or docs less. The highest score wins (ties: a file named like CI or tests, then file order). Exactly one job
is changed; the pull request lists other test-like jobs. Not changed, with the reason recorded: jobs already on
`fenvix`, macOS or Windows jobs, a `runs-on` expression other than a matrix of Linux machines, reusable workflow calls.

### Endpoints

| Method and path | Who | What |
|---|---|---|
| `GET /healthz` | anyone | `{"ok": true}` |
| `POST /webhooks/github` | GitHub (signed) | the webhooks above |
| `POST /v1/runner/summaries` | our runners (each machine's own summary credential) | a job's run summary (queued) |
| `POST /v1/runner/progress` | our runners (same credential) | the running job's progress, written at once; `202` |
| `POST /v1/runner/results` | our runners (same credential) | one chunk of per-test results (queued; large bodies through the queue's overflow bucket); `202` |
| `POST /v1/runner/explorations` | our runners (same credential) | one night of exploration of the credential's repository (queued); `202` |
| `GET /github/setup` | the person, sent back by GitHub | checks the GitHub side and stores a single-use completion (above), then `303` to `DASHBOARD_URL/projects/connect?github=confirm&installation=<id>&account=<login>#completion=<code>` (or `github=error&reason=expired\|incomplete\|oauth\|not_yours\|github_not_admin\|not_admin\|other_organization\|removed\|used\|github\|error`, or `github=requested`); the dashboard completes the link with `POST /v1/github/installations/complete` |

The install link (`POST /v1/github/install-link`) and the setup pull request of one repository
(`POST /v1/github/repositories/{repositoryId}/setup-pull-request`) are operations of the dashboard API
(`openapi/fenvix-api.yaml`, `github-app/src/api/`); the latter queues the work kind `onboard` above.

---

## Running it and testing it locally

```
cd github-app
npm install
# A scratch Postgres 15+ (never a Supabase project), e.g. on port 54329:
TEST_DATABASE_URL=postgresql://postgres@localhost:54329/gh_test npm run db:prepare
TEST_DATABASE_URL=postgresql://postgres@localhost:54329/gh_test npm test        # typecheck, unit, integration
TEST_DATABASE_URL=postgresql://postgres@localhost:54329/gh_test npm run e2e:record   # rewrites recordings/
cd .. && TEST_DATABASE_URL=postgresql://postgres@localhost:54329/rls_scratch npm run test:rls   # includes gh-rls.sql
```

The integration tests run the App against a local Postgres (as `fenvix_github_app`, so the real grants and
policies apply) and a fake GitHub on a local port. The fake answers with GitHub's own example responses from GitHub's
OpenAPI description and keeps real state (branches, files, pull requests, check runs, comments). Every webhook
fixture is a payload GitHub recorded (`@octokit/webhooks-examples`) with our values, checked against GitHub's webhook
schema (`@octokit/webhooks-schemas`); every request the App sends and every answer is checked against GitHub's REST
description (`@octokit/openapi`). The run summaries are real ones written by `runner/fenvix-run`
(`github-app/tests/fixtures/runner/`). `github-app/recordings/E2E.md` shows the whole exchange as a customer sees it.

`npm start` runs `node src/server.ts` (Node 22.18 or newer runs TypeScript directly).
