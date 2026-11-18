DONE

# Block 4 part 1: the fenvix GitHub App (P-017), session 2026-11-18

The GitHub side of fenvix is built as a service in fenvix-app `github-app/` (branch `claude/github-app`, not merged,
nothing deployed): webhooks with signature verification, installations stored per organization (migration 0013 with
row level security), the onboarding pull request that changes only the test job's `runs-on:` to `fenvix`, the run
result on GitHub (check run + one pull request comment updated in place), `ci_runs` rows and one usage event per run.
Everything is tested locally against a local Postgres and a fake GitHub checked against GitHub's own schemas. The App
itself does not exist on GitHub yet: `docs/GITHUB-APP.md` has the clicks for the founder.

## Numbers against "Exit"

| exit item | result | label |
|---|---|---|
| unit tests green locally | **34 / 34** pass (`npm run test:unit`) | MEASURED |
| integration tests green locally (local Postgres 16, the App connected as the restricted role `fenvix_github_app`, fake GitHub on a local port) | **37 / 37** pass (`npm run test:integration`); whole `npm test` (typecheck + unit + integration) **15.5 s** wall | MEASURED (this container, 4 CPUs, nothing else running) |
| row level security of the new tables | `npm run test:rls` on a fresh scratch database: every earlier check still passes, plus **GH RLS OK** (new `supabase/tests/gh-rls.sql`, 0013 applied twice) | MEASURED |
| recorded end to end: installation → onboarding PR content → workflow_job completed → check run + PR comment | `github-app/recordings/E2E.md` (readable) and `e2e.json` (machine-readable): **16 webhooks, 3 runner summaries, 23 App → GitHub calls**, ending with 3 check runs created and completed and **1 PR comment created then updated in place** | MEASURED |
| ... all verified against GitHub's API schemas | **16 / 16 webhooks** valid against GitHub's webhook schema (`@octokit/webhooks-schemas` 7.6.1); **22 / 22 REST calls**, request body, query and response, valid against GitHub's OpenAPI description (`@octokit/openapi` 24.0.0, `api.github.com.deref.json`); the 23rd call is the OAuth code exchange on github.com, which is not part of the REST description | MEASURED |
| docs/GITHUB-APP.md: clicks to create the App, permissions, events, env variables | done (fenvix-app `docs/GITHUB-APP.md`) | — |
| no secrets in git | none: keys and tokens of the tests are generated at run time; the recording redacts tokens; grep of the branch diff for private keys and token prefixes: 0 hits | MEASURED |
| no GitHub Actions workflow added, nothing deployed | none added, nothing deployed | — |

What the tests cover (MEASURED, all green): signature refused when wrong, missing or SHA-1; GitHub's documented
signature test vector; a delivery handled once; onboarding PR content (diff in the body, only `runs-on` changed on
the branch, comments kept byte for byte), idempotent re-adding, "All repositories" opens nothing by itself; onboarding
merged/closed tracking; push time recorded for time to green; check run in progress → completed (not duplicated);
comment updated in place and found again by its marker if our record is lost; summary arriving before or after the
job's completion; no summary at all (published by the sweep after 10 minutes); cancelled before start (not billable);
GitHub answering 502 on the check run (retried by the sweep, billed once, one run row); an installation not linked yet
(check run still posted, usage event without organization, filled in by the link); the link flow (forged/expired
state, missing code, an installation the person cannot see, a member who is not admin, another organization trying
to take it over, the owner linking); the dashboard-triggered onboarding endpoint.

## Real run summaries as input (not hand-made)

I built the engine from fenvix-engine-cli branch `claude/runner-prototype-ee21he` (`maturin build --release`, compile
21.7 s, MEASURED) and ran `runner/fenvix-run` three times on one machine with a persistent cache, on a small synthetic
project (56 tests, one order-dependent pair), commits N, N+1 (a real bug), N+2 (the fix). The three `summary.json`
files are the App's test input (`github-app/tests/fixtures/runner/`, paths rewritten, nothing else):

| job | tests | reused with proof | ran | failures | flaky | label |
|---|---|---|---|---|---|---|
| N, cold | 56 | 0 | 56 | 0 | 1 (with replay command) | MEASURED |
| N+1, warm | 56 | 45 | 11 | 1 real | 0 | MEASURED |
| N+2, warm | 56 | 46 | 10 | 0 | 0 | MEASURED |

The recorded end to end uses them in that order (first run on `main` after the onboarding merge, then two runs on a
developer's pull request).

## What I decided and why

* **Workflow edit by source range, not by re-serialising YAML.** The YAML is parsed (`yaml` 2.9) only to find the exact
  characters of the test job's `runs-on` value; the change is made on the original text and the result is parsed again
  to prove that only that value changed. Comments, quoting, CRLF, anchors and every other line stay byte for byte.
  A trailing comment on the same line is kept too (in the e2e: `runs-on: fenvix  # GitHub-hosted, 2 cores`), as the
  prompt asked; it may read stale.
* **Which job:** the strongest test command wins (pytest, vitest, jest, go test, npm/pnpm/yarn/bun test, tox/nox, make
  test; install-only lines ignored), a test-like name adds, a lint/build/release/docs name subtracts. Exactly one job
  is changed; the PR lists the other test-like jobs. Not changed, with the reason stored: already on fenvix, macOS or
  Windows, a `runs-on` expression other than a matrix of Linux machines, reusable workflow calls.
* **"All repositories" installations get no automatic PRs** (it would open PRs across a whole account); the dashboard
  opens them per repository (`POST /v1/repositories/{id}/onboarding`). `ONBOARD_ALL_REPOSITORIES=true` changes that.
  Chosen repositories get their PR at once, as the prompt says.
* **Installation per organization, safely.** An installation is stored when GitHub announces it but belongs to no
  organization until the installer returns through the setup callback with (1) a signed one-hour `state` naming the
  organization and person, (2) an OAuth code, and (3) GitHub listing the installation among those that person can see
  (`GET /user/installations`); then `gh_link_installation()` (security definer) checks owner/admin and refuses an
  installation another organization already has. Without these checks anyone could claim someone else's installation
  id.
* **A dedicated database role** `fenvix_github_app` (no BYPASSRLS, no password in git): all rows of its own `gh_*`
  tables (keyed by GitHub ids from signed webhooks), but on `ci_projects`, `ci_runs`, `ci_usage_events` only the
  organization of the transaction, like the control plane. A usage event takes its installation's organization by
  trigger, whatever the writer says.
* **How the summary reaches the App:** the runner machine posts `summary.json` to `POST /v1/runner/summaries` with a
  runner token; the App matches it to the job by repository + run + attempt + runner name (a runner runs one job at a
  time) and publishes when both the summary and `workflow_job.completed` are in, whichever comes first. The per-test
  maps are dropped before storing (they grow with the suite).
* **Billing rule:** one usage event per GitHub job id (unique: never billed twice). Billable when the job used our
  machine (summary received, or started on our runner without a summary); not billable when cancelled before it
  started there. Plan at that time and the minutes are stored on the event. No prices applied (no billing now).
* **The App writes `ci_runs`** (summary level) because it is the one holding the summary; per-test results, receipts
  and defects stay for the control plane's planned ingest (`POST /v1/runs`), as `docs/data-contract.md` says.
* **Webhooks answered `202` at once, handled in the background** (GitHub waits 10 s; onboarding makes about 9 API
  calls). A failed handling leaves the delivery unprocessed so GitHub's redelivery is processed again.
* **Fake GitHub = GitHub's own example responses** from the OpenAPI description, with real state. Three of GitHub's
  own examples do not satisfy GitHub's own schema (`repos/get` lacks `language`; `pulls/create` labels lack
  `archived_at`/`archived_by`, a team lacks `type`); the fake adds those fields, documented in the code. Webhook
  fixtures are the first recorded example per event/action that passes GitHub's webhook schema, with our values.
* **Environment variable `GITHUB_APP_DATABASE_URL`** (like the control plane's `CONTROL_PLANE_DATABASE_URL`).
* Data contract extended (installation, repository, usage event, and the exact mapping from the runner's
  `summary.json` to the Run summary), with a dated change entry.

## What blocks or what is missing

* **Not tested against real GitHub** (the App does not exist yet; never deploy). Behaviour beyond the schemas (e.g.
  exact refusal messages, rate limits, token scopes in practice) is UNKNOWN until the founder creates the App and a
  test installation runs (`docs/GITHUB-APP.md`, about 15 minutes, $0) and the service runs somewhere reachable by
  GitHub (that needs a host: spending, founder's yes).
* **`runner/fenvix-run` does not post the summary yet.** One step in the runner (or the job wrapper on our machine):
  `POST /v1/runner/summaries` with `RUNNER_TOKEN` and `$GITHUB_REPOSITORY_ID`, `$GITHUB_RUN_ID`, `$GITHUB_RUN_ATTEMPT`,
  `$RUNNER_NAME`, plus an https `receiptsUrl` where the receipts are uploaded. I did not change fenvix-engine-cli
  (read-only here). Until then the App publishes "no summary" after 10 minutes.
* **How the engine gets into a customer's unchanged test step** on a fenvix machine (the onboarding PR changes only
  `runs-on`, as asked; the customer's step still says `pytest`): the runner machine must inject `--det --det-cache`
  (e.g. `PYTEST_ADDOPTS` from a runner job-started hook). Runner fleet work, Block 4 part 2.
* **One comment per pull request shows the latest fenvix job only**: a matrix of several fenvix jobs on one PR
  overwrites itself. Next: one section per job name inside the same comment.
* **Delivery lost if the process dies between `202` and handling**: the delivery row stays unprocessed and GitHub does
  not redeliver by itself. Remedy and test: a sweep that asks GitHub to redeliver unprocessed deliveries
  (`POST /app/hook/deliveries/{id}/attempts`, App JWT).
* **The dashboard is not wired to the new endpoints** (`/v1/github/install-link`, the onboarding endpoint, reading
  `gh_installations`/`gh_repositories`/`ci_usage_events`); it still runs on its mock for onboarding.
* Workflow events outside push, pull_request, merge_group, schedule, workflow_dispatch are stored as
  `workflow_dispatch` in `ci_runs.trigger` (the 0011 check allows only those five); the raw event is not kept.

## Links

* fenvix-app, branch `claude/github-app`, commit `bc610c1` (no PR opened: the prompt did not ask; RULES says a draft PR
  at the end, left to the coordinator).
* `github-app/` (service, tests, `recordings/E2E.md`, `recordings/e2e.json`, `tests/fixtures/runner/`),
  `docs/GITHUB-APP.md`, `docs/data-contract.md` (new section "GitHub App records"),
  `supabase/migrations/0013_github_app.sql`, `supabase/tests/gh-rls.sql`, `supabase/tests/run-local.sh`.
* Commands: `cd github-app && npm install && TEST_DATABASE_URL=postgresql://postgres@localhost:54329/gh_test npm test`;
  `npm run e2e:record`; at the root `TEST_DATABASE_URL=<empty scratch db> npm run test:rls`.

## Errors or gaps in the brain

* **P-017's permission list is missing `Workflows: Read and write`.** GitHub refuses a GitHub App's commit that
  creates or changes a file under `.github/workflows/` unless the App has the `workflows` permission; `Contents:
  write` is not enough. This is GitHub's documented behaviour as I know it, not re-read from a primary page in this
  session (no web) and not testable without a real App: to confirm on the first real install. `docs/GITHUB-APP.md`
  lists it with the reason.
* For the runner fleet (Block 4 part 2), minting just-in-time runners needs `Administration: write` (repository
  runners) or the organization permission `Self-hosted runners: write` (`docs/RUNNER-PROTOTYPE.md` on the engine branch
  already says `administration`). Not requested now; customers must approve every added permission later.
* This session could not push to fenvix-brain-cli (attaching it with push access and pushing to its `main` were both
  refused by the session's permission check). As the coordinator asked, the report is delivered here (fenvix-app,
  branch `claude/github-app`, `docs/REPORT-github-app.md`) for the coordinator to copy to
  `sessions/2026-11-18-github-app/REPORT.md`.
