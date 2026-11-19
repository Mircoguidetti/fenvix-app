DONE

# Report: warm cache at install (branch `claude/warm-cache-install`)

Written 2026-11-19. The branch starts from `claude/dashboard-wiring`. Nothing was deployed. The runner (another
repository) was not edited: what it must do is in `docs/data-contract.md`, "5. Warm-up runs".

**What it does.** A customer should almost never see a cold first run. fenvix now runs the repository's test job
**once** on the default branch, on our runners, so the shared cache with proof is warm before the customer's first
pull request. It does this:

- when the setup pull request is merged;
- when an installation is linked and its repositories are already onboarded (setup merged earlier, or already on
  `runs-on: fenvix`);
- after every push to the default branch.

These warm-up runs are off the critical path and are never billed: each one records a non-billable usage event with
reason `warm-up`.

## Test results (final run)

| Command | Result |
| --- | --- |
| `cd github-app && npm test` (typecheck, unit, integration on a local Postgres 16 and the local Supabase: real Postgres image and GoTrue, real tokens) | typecheck clean; unit **127/127** (32 new); integration **141/141**, 0 skipped (21 new: `warmup.test.ts` 18, `api-warm-cache.test.ts` 3) |
| `npm run test:rls` (fresh scratch Postgres; 0014 and **0015 applied twice**) | API RLS OK, CI RLS OK, CI EXPLORE RLS OK, GH RLS OK, **WARM RLS OK** (new `supabase/tests/warm-rls.sql`) |
| `cd infra/github-app && npm test` | **69/69**; **cdk-nag clean** in per-job mode, demo mode and with two regions (new `test/warmup.test.ts`, 8 tests; machine-script tests, 5 new) |
| `npm run build` (`api:check` → `tsc` → `vite build`) | passes; `src/api/schema.d.ts` regenerated, matches the OpenAPI file |
| `npm run api:lint` (Redocly) | valid, 0 warnings |
| `npm run test:unit` (dashboard) | **66/66** (7 new: `tests/unit/warm.test.ts`) |
| `npm run check` (mock: behaviour, organizations, status colours, layout, axe WCAG 2.0/2.1 A+AA, screenshots) | 34/34, 10/10, 18/18, all layout checks pass, 140 screenshots |
| `node scripts/e2e-real-api.mjs` (every page against the real API, locally) | **163/163** (157 before; the new checks look for "Cache warm since …", "Warming up …" and "Warm-up not possible …" on Projects and Connect); `docs/screenshots-real-api/` updated |
| Secret scan of the tree (private keys, AWS keys) | nothing found |

## 1. Trigger points and how the run is started

**Triggers** (`github-app/src/service.ts` calls `src/warmup/warmups.ts`):

1. **Setup pull request merged.** On a `pull_request` closed+merged event for the onboarding branch, the App requests a
   warm-up of `merge_commit_sha`. It is ordered by `merged_at`, which is GitHub's own clock. If there is no merge SHA,
   or the base is not the default branch, it asks GitHub for the head of the default branch instead.
2. **Installation linked while repositories are already onboarded.** After `gh_link_installation`, every repository in
   state `merged` or `already_fenvix` gets a warm-up of its default branch's head (`GET /git/ref/heads/<branch>`), with
   no grace period. A repository that onboarding finds `already_fenvix` gets the same.
3. **Push to the default branch** (`refs/heads/<default_branch>`): a warm-up of `after`, ordered by the push time.

Nothing happens for an installation that is not linked to an organization, is suspended or removed, for a removed
repository, or for one that is not onboarded.

**Decision: a dedicated warm-up job dispatched to our runner pool, not `workflow_dispatch`.**

`workflow_dispatch` does not fit:

- it needs `on: workflow_dispatch` in the customer's workflow (a second edit in the setup pull request) and the
  `actions: write` permission;
- it runs the **whole** workflow: lint, build and deploy-like jobs, and GitHub-hosted jobs billed to the customer;
- GitHub shows its check suite on the customer's commit, which the brief rules out.

How the dedicated job works:

- The App starts one of our per-job machines in the organization's region.
- The machine is not a GitHub runner, so there is no just-in-time configuration. It gets:
  - a description: repository, commit, ref, and the workflow file and job id that the setup pull request moved to
    `runs-on: fenvix`;
  - a checkout token for **that one repository**, `contents: read` only. GitHub refuses any write with it, which the
    fake GitHub enforces in the tests (404 on another repository, 403 on `POST check-runs`);
  - a write cache token for the installation's cache organization;
  - its own App credential, accepted by `POST /v1/runner/warmups` only.
- The runner's warm-up executor runs **the customer's own workflow file at that commit**: the same steps, `env`,
  `with:` inputs, runner image and workspace path. The engine therefore computes the cache keys of the customer's pull
  request runs.

**Coverage.** When the customer's own workflow already runs the fenvix job on pushes to the default branch, that run
(cache write access) **covers** the commit. A pending warm-up becomes `covered` and no machine starts. A push waits
`WARMUP_GRACE_SECONDS` (180) so that this can happen first. If the covering run ends without results, the warm-up is
re-armed.

## 2. Scheduling

Every minute the `warmup` Lambda runs `Warmups.tick()`. In the node server this is `WARMUP_TICK_SECONDS`.

- **Lowest priority.**
  - No warm-up gets a machine in a region while a customer job there is queued without one
    (`gh_jobs.launched_at is null`).
  - The last `WARMUP_RESERVE` (1) machines of the region are never used by warm-ups.
  - A customer job that finds the fleet full **preempts** the newest warm-up: its machine is terminated at once, the
    job gets its machine in the same delivery, and the warm-up goes back to pending (5-minute back-off; fresh machine
    and runner name `fenvix-w<id>-2`).
- **Concurrency per organization:** `WARMUP_ORG_CONCURRENCY` (1).
- **Daily cap per repository:** `WARMUP_DAILY_CAP` (6) warm-ups that take a machine in any rolling 24 hours. The next
  one waits until the oldest in the window is 24 hours old.
- **After `unsupported`:** the repository's next warm-up waits 24 hours, so there is one try a day rather than a
  machine per push.
- **Cancellation when superseded:** a newer default-branch commit (by push time) supersedes the warm-up in flight, and
  a running machine is terminated. An older commit delivered late is stored as superseded at once. A partial unique
  index allows one warm-up in flight per repository.
- **Region:** the warm-up runs in `workspaces.region` or not at all. If that region has no placement, the warm-up waits
  with a detail that says so.
- **Stuck machines:**
  - a machine with no `started` report after 15 minutes is terminated and the warm-up is retried (at most 3 machines);
  - a warm-up running longer than 3 hours is stopped (`failed`);
  - suspending or uninstalling the App, or removing the repository, cancels its warm-ups.
- **Infra:**
  - New `Warmup` Lambda on a 1-minute EventBridge Scheduler (per-job mode only). It has the worker's launch rights and
    secrets, and nothing else.
  - The worker and the warm-up function may terminate **only** machines tagged `fenvix:role=runner-job` **and**
    `fenvix:kind=warmup`. Customer job machines are still terminated only by the reaper.
  - New settings: `warmupEnabled`, `warmupDailyCap`, `warmupOrgConcurrency`, `warmupReserve` (must be below
    `runnerMaxRunning`) and `warmupGraceSeconds`.
  - New machine units and scripts in the image: `fenvix-warmup.target`, `.service`, `-prepare`, `-done` and `-report`.

## 3. Runner contract

This is written in `docs/data-contract.md`, "5. Warm-up runs" (the full text), plus the new records "Warm-up" and
"Repository cache state" and the changed usage-event fields. OpenAPI: `POST /runner/warmups` and `RunnerWarmupReport`.

**What the machine sends.** Two reports, made by root with the machine's credential:

- `{"warmupId", "runnerName", "event": "started"}`;
- `{..., "event": "finished", "outcome": "succeeded" | "failed" | "unsupported", "detail", "summary"}`.

**What it never does.**

- It never creates a check run, status or comment. It holds no token that could.
- Its credential is refused (403) on `/v1/runner/summaries`, `/progress`, `/results` and `/explorations`, so a warm-up
  is never a run: no `ci_runs` row and no PR comment.
- A job's credential is refused on `/v1/runner/warmups`.

**What the runner repository must add:** `runner/warmup.sh <warmup.json> <out-dir>`. It checks out the commit, runs the
job's steps with the default variables of a push to that ref, wraps the tests in the engine as `fenvix-run` does, and
writes `outcome.json` and `summary.json`. The contract lists:

- matrix: the first Linux combination;
- `secrets.*`: empty;
- `unsupported` for `needs:` outputs, `services:` / `container:`, and reusable workflows.

Until it exists, the machine's shim reports `unsupported` and powers off.

## 4. Dashboard

- **API.** `warmCache` on `Project` and on `GitHubRepository`:
  - fields: `state` (warm / warming / cold), `commitSha`, `warmAt`, `source` (warmup / run), and the latest `warmup`
    (`status`, `commitSha`, `detail`, `updatedAt`);
  - it is computed by `mapWarmCache` in `src/data/ci-rows.ts`, the mapper the API and the mock share;
  - row level security on `gh_warmups` applies (`fenvix_api` reads its organization only).
- **Client.** Regenerated from the OpenAPI file.
- **Projects.** Under the setup pill: "Cache warm since 159a387 · 2 h ago", and "by a fenvix warm-up" / "by your run on
  the default branch" / "Warming up 10658ed".
- **Connect.** Each onboarded repository shows the same line plus the warm-up's own words, for example "Warm-up not
  possible (ccccccc): the job needs the outputs of job build". Step 3's text says the warm-up is free.
- **Cache state from customer runs.** It also follows the customer's own trusted runs: a published push run with a
  summary marks the cache warm, even where warm-ups are off.

## 5. Data

Migration `supabase/migrations/0015_warm_cache.sql` is safe to run twice:

- `gh_warmups`;
- `gh_repositories.cache_warm_*`;
- `gh_jobs.cache_access` and `launched_at`;
- `ci_usage_events`:
  - `github_job_id` and `github_run_id` are now nullable;
  - `warmup_id` is unique;
  - `kind` gains `warmup`;
  - a check that every `warmup` event has `billable = false` and `reason = 'warm-up'`.

Row level security:

- the App reads and writes every row;
- the API reads its own organization's rows;
- the browser reads nothing.

The tests are `supabase/tests/warm-rls.sql` and `tests/integration/api-warm-cache.test.ts`. A warm-up usage event
records our machine time (test minutes from the summary, the rest as other steps). Because only billable events count,
the usage, billing and trial figures are unchanged.

## Open items (decisions or work outside this repository)

- **The runner's executor `runner/warmup.sh` (fenvix-engine-cli) does not exist yet.** Until it ships and
  `engineCliCommit` points at it, each warm-up machine reports `unsupported` within about 2 minutes. The next warm-up of
  that repository then waits a day, so the cost is about $0.005 per repository per day. If you want no machines at all
  until then, set `warmupEnabled=false`. Faithfully executing Actions steps (`uses:` actions, expressions) outside GitHub
  is the main risk: cache keys match only if the executor reproduces paths and environment exactly. That should be
  verified on a real repository by comparing a warm-up's cache keys with the next PR run's skip rate.
- **Matrix jobs warm only the first Linux combination.** Warming every leg would multiply cost. Decide if needed.
- **Cost estimate** (ESTIMATE, in `docs/DEPLOY-AWS.md`): 10 repositories × 6 warm-ups × 22 working days ≈ 1,320
  machines ≈ $22 a month, not billed. The daily cap and grace period are the levers.
- **Deploy order:** apply `0015_warm_cache.sql` after 0014 (step 7 in `docs/DEPLOY-AWS.md`), deploy the stack, then
  rebuild the runner image so it carries the warm-up units. Nothing was deployed from this session.
