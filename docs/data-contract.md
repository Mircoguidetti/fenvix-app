# Data contract: runner → dashboard

Written 2026-11-17, runner part rewritten 2026-11-18. This is **our** contract between the fenvix runner (the machines
behind `runs-on: fenvix`, which run the engine) and the customer dashboard. It is not the engine's internal file
format: the runner reads the engine's files and sends these records to the fenvix GitHub App (`github-app/`), which
writes them to Postgres; the dashboard reads them through the fenvix API (`openapi/fenvix-api.yaml`), never from the
database directly. The tables (`supabase/migrations/0011` to `0017`), the API's schemas, the mock (`src/data/mock.ts`)
and the TypeScript types (`src/data/types.ts`) all follow it. **What the runner must send, and when, is the section
"What the runner sends" below.**

> **The engine formats it is taken from are not final.** Field names and shapes below come from what the engine
> writes today (read on 2026-11-17 from fenvix-engine-cli, read-only):
>
> - defect bundles: `bundle.json` and `order.txt` written by `python/detpy/repro.py`, 427 bundles under
>   `harness/results/block2*/` (branch `claude/gracious-rubin-eyswxd`), fingerprints from
>   `crates/detpy-core/src/fingerprint.rs`;
> - skip with proof: `receipts.jsonl` and `proof-cache.json` of `pytest --det --det-cache=DIR`
>   (`tracks/cache-proof/`, patches 1 to 7, branch `claude/loving-maxwell-58mv2w`; still in progress);
> - per-commit skip data: `harness/skip_study2/results/summary.json` and `REPORT.md` (same branch).
>
> When the engine changes, the runner's mapping changes first; this contract changes only when the dashboard needs
> something new. Every change here is listed at the end with its date.

## Conventions

- JSON, camelCase in the API and the TypeScript types, snake_case in the Postgres tables. Times are ISO 8601 UTC.
  Durations are milliseconds (`…Ms`) unless the name says otherwise. Shares are numbers from 0 to 1.
- Ids are opaque strings (UUIDs in Postgres). A test is named by its **test id**: the pytest node id
  (`tests/test_init.py::TestInit::test_get`) or the Vitest/Jest id (`packages/core/src/a.test.ts > suite > case`).
- Hashes are lowercase hex as the engine writes them: BLAKE3 truncated to 16 bytes (32 hex characters) for cache
  keys, digests and execution fingerprints (`6fc828330e79296ba4e94163743199dd`); git SHAs are 40 hex characters.
- Every record belongs to one **organization**; row level security keeps organizations apart.

## Organization

The dashboard's existing organization (the `workspaces` table of the earlier product, reused as is, with its members,
roles, invitations and API keys).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `name` | string | 2 to 64 characters |
| `planId` | string | the plan the organization is on (see Plan) |
| `githubAccount` | string \| null | the GitHub account of the first installation linked (an organization may link several installations; each one is listed with its account) |
| `region` | `"us"` \| `"eu"` | where its data and its machines are (`workspaces.region`); a job never runs outside it |
| `trial` | `{ startedAt, endsAt }` \| null | the 30-day shadow trial, started when the organization links its first GitHub installation (`ci_subscriptions.trial_started_at`, `trial_ends_at`) |

## Project

One GitHub repository connected through the fenvix GitHub App.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `fullName` | string | `owner/name` on GitHub |
| `language` | `"python"` \| `"node"` \| `"go"` | |
| `testRunner` | `"pytest"` \| `"vitest"` \| `"jest"` \| `"go test"` | |
| `defaultBranch` | string | |
| `installationId` | number | the GitHub App installation that gave access |
| `setupState` | `"app_installed"` \| `"pr_open"` \| `"active"` | `active` once the first run arrived on `runs-on: fenvix` |
| `setupPullRequest` | `{ number, url, state: "open" \| "merged" \| "closed" }` \| null | the pull request fenvix opened to change the test job |
| `connectedAt` | time | |
| `baseline` | `{ medianTimeToGreenS, medianJobMinutes, runsSampled, from, to }` \| null | measured from the repository's GitHub Actions history when it was connected: the "before fenvix" numbers |
| `settings` | `{ skipWithProof, commentOnPullRequests, nightlyExploration, testCommand }` | |
| `warmCache` | `{ state, commitSha, warmAt, source, warmup }` | the shared cache of the default branch: "cache warm since `commitSha`" (see "Repository cache state" and "Warm-up runs") |

## Run summary

One test job that ran on `runs-on: fenvix`. The App creates the row (status `running`) when GitHub says the job started
on a fenvix machine (`workflow_job` `in_progress`), keeps the runner's latest progress in it while it runs, and finishes
the same row when the job completes (from the `workflow_job` event, the runner's summary and its results chunks).

| Field | Type | From |
| --- | --- | --- |
| `id` | string | dashboard |
| `projectId` | string | |
| `number` | number | per project, increasing |
| `engineRunId` | string | the engine's run id, `%Y%m%dT%H%M%S-<pid>` (`proof-cache.json` → `Entry.run`); receipts point at it |
| `commitSha`, `commitMessage` | string | GitHub event |
| `branch` | string | |
| `pullRequest` | number \| null | |
| `trigger` | `"push"` \| `"pull_request"` \| `"merge_group"` \| `"schedule"` \| `"workflow_dispatch"` | GitHub event |
| `status` | `"running"` \| `"passed"` \| `"failed"` \| `"cancelled"` \| `"not_proven"` | `not_proven`: no failure, but at least one test was not proven identical to the serial run (see "Parallel with proof"). Finished, never green |
| `pushedAt`, `startedAt`, `finishedAt` | time | `pushedAt` is when the commit reached GitHub: time to green = `finishedAt − pushedAt` of the first passing run of a commit |
| `durationMs` | number | wall time of the test job |
| `tests` | `{ total, ran, passed, failed, skippedWithProof, flakyDefects, notProven }` | `failed` counts every failure; `flakyDefects` is the part of it that is a reproducible flaky defect; `notProven` is N (see "Parallel with proof"), never counted in `passed`, so `passed + failed + notProven` ≤ `ran` |
| `testTimeMs` | `{ ran, skipped }` | `skipped` is the recorded duration of the reused results (`reused_recorded_seconds` of the cache summary) |
| `skipShare` | number | `testTimeMs.skipped / (ran + skipped)`: the share of test time skipped with proof (the skip study's "time" rule) |
| `otherStepMinutes` | number | `other_step_minutes` in Postgres. The job's other steps that fenvix still runs: checkout, dependency install, build (the job's wall time on fenvix outside the test command, measured by the runner) |
| `minutesSaved` | number | `testTimeMs.skipped / 60000`: skipped test minutes **only**. fenvix skips no other step today; if it ever does, those minutes get a field of their own and are added here with a note |
| `githubEquivalentMinutes` | number | what the same job would take on a GitHub-hosted runner without fenvix: `testTimeMs.ran / 60000 + testTimeMs.skipped / 60000 + otherStepMinutes` (a generated column in Postgres); the run's **baseline minutes** (see Run units) |
| `engineVersion` | string | the engine's version, e.g. `0.1.0` (`detpy==X` or `detjs@X` of the runtime) |
| `seed` | number \| null | `--det-seed` the run used; null for collection order (`"fixed"`) |
| `mode` | `"shadow"` \| `"enforce"` | `shadow` during the organization's trial: every test ran and the engine recorded what it would have skipped; `enforce`: unchanged tests were skipped with proof |
| `wouldSkipTests`, `wouldSaveMs` | number | shadow mode: the tests the engine would have skipped and their duration (from the per-test outcomes with `wouldSkip`) |
| `audit` | `{ rerun, wrongSkips }` | audit reruns: skipped tests the engine ran anyway (5%), and how many of them failed (a wrong skip; expected 0) |
| `region` | `"us"` \| `"eu"` \| null | where the machine ran (the organization's region when the App placed it; null when the App did not place it, e.g. an always-on runner) |
| `progress` | Run progress \| null | while `status` is `running`: the runner's latest progress record |
| `exitCode` | number \| null | the test command's exit code (summary.json `exit`, `ci_runs.exit_code`); null while running, without a summary, and for runs stored before migration 0019 |
| `proof` | `{ workers, proven, notProven, rerunOneLane, parallelMs, serialMsEstimate, orderDigest, notProvenCauses: { cause, tests }[] }` \| null | the summary's `proof` (`ci_runs.proof`, jsonb): the test command ran in parallel lanes and each test was checked against the serial run. null for a serial run, and for every run until the runner sends it |

**Minutes add up on screen.** Wherever the dashboard shows minutes it shows the three parts and their total:
"875 run + 1,959 skipped with proof + 1,296 setup and build = 4,130 min". The parts are rounded with the
largest-remainder rule (`roundToSum` in `src/data/ci.ts`), so the shown parts always sum to the shown total; a
month's totals are the sums of the per-project rows, so rows and columns both add up. Costs in dollars are split to
the cent the same way.

**Why tests ran.** For every test that was not reused the engine writes `{"reused": false, "why": "<kind>: <detail>"}`
(kinds `new`, `failed-before`, `config`, `runtime`, `clock`, `env`, `data`, `code`; detail e.g. `src/x.py::func`,
`(module level)`, `(pytest hooks)`, `(content)`). The run summary carries them summed:

| Field | Type | Notes |
| --- | --- | --- |
| `skipMisses` | `{ [kind]: number }` | tests that ran, by reason (`skip_misses`, jsonb) |
| `missDetails` | `{ kind, detail, tests }[]` | the details that made the most tests run, top 5 (`miss_details`, jsonb) |

## Run progress

The runner's latest progress record of a running run (`ci_runs.progress`, jsonb, with `progress_at`; shown only while
the run is `running`).

| Field | Type | Notes |
| --- | --- | --- |
| `phase` | `"setup"` \| `"collecting"` \| `"testing"` \| `"reporting"` | |
| `testsTotal` | number \| null | null until collection ends |
| `testsDone`, `passed`, `failed`, `skippedWithProof` | number | so far |
| `currentTest` | string \| null | the test running now |
| `elapsedMs` | number | since the job started |
| `updatedAt` | time | when the App stored it (`progress_at`) |

Stored as sent (camelCase keys) plus `seq`; a record whose `seq` is not higher than the stored one is ignored.

## Per-test outcome

One row per test of a run. Large suites have tens of thousands; the dashboard reads them a page at a time.

| Field | Type | Notes |
| --- | --- | --- |
| `runId`, `testId` | string | |
| `file` | string | the part of the test id before `::` (or ` > `) |
| `outcome` | `"passed"` \| `"failed"` \| `"skipped_with_proof"` \| `"not_proven"` | a test the framework itself skipped (`@skip`) is not sent; `not_proven`: its parallel result could not be proven equal to the serial one (its serial result is what the run reports) |
| `durationMs` | number | for a skipped test: the duration recorded in the reused run |
| `failure` | `{ kind: "real" \| "flaky_defect", phase, exceptionType, message, location, defectId }` \| null | from the bundle's `exception` = `[type, phase, message, location]`; `flaky_defect` when the engine reproduced it (a defect exists) |
| `receiptId` | string \| null | set when `outcome` is `skipped_with_proof` |
| `notProvenCause` | string \| null | `not_proven`: why, when the runner said (`ci_test_results.not_proven_cause`); optional |

## Skip receipt

Why a test could be skipped: everything it depended on was checked and is unchanged since a run where it passed.
The engine writes one line per reused test to `receipts.jsonl`:

```json
{"nodeid": "...", "reused": true, "key": "<32 hex>", "run": "20261117T101502-4412", "outcome": "passed",
 "fingerprint": "<32 hex>", "duration": 0.84, "config": "<32 hex>", "runtime": "<32 hex>", "epoch": "...",
 "n_units": 41, "n_skeleton": 6, "n_hooks": 2, "n_content": 3, "n_data": 4, "n_env": 2, "n_changed_files_proven": 7}
```

The dashboard record adds the lists behind those counts, taken from the test's entry in `proof-cache.json`
(`Entry.units`, `content`, `skeleton`, `hooks`, `data`, `env`, `runtime`, `config`):

| Field | Type | From |
| --- | --- | --- |
| `id`, `runId`, `testId` | string | |
| `cacheKey` | 32 hex | `key` |
| `reusedRunId` | string | the dashboard run whose `engineRunId` equals `run` |
| `reusedOutcome` | `"passed"` | `outcome` (only passes are reused: failures, network, subprocess and OS entropy are never reused) |
| `fingerprint` | 32 hex | execution fingerprint of the reused run |
| `reusedDurationMs` | number | `duration` × 1000 |
| `code` | `{ path, qualname, digest }[]` | `Entry.units`: each function the test executed, with its syntax-tree digest (`q`, `d`) |
| `modules` | `{ path, kind: "content" \| "skeleton" \| "hooks", digest }[]` | whole files, module skeletons and conftest hook sets the test depends on |
| `filesRead` | `{ path, dep }[]` | `Entry.data`; `dep` is `f:<digest>` (file), `d:<digest>` (directory listing), `missing`, or `s:<kind>` |
| `envRead` | `{ name, digest }[]` | `Entry.env`; `digest` is `-` when the variable was unset, the name `*` means the whole environment |
| `runtime` | `{ digest, interpreter, system, machine, libc, distributions }` | the runtime identity; `interpreter` is e.g. `python 3.12.7` or `node 22.11.0` (`runtime` digests `{python, cache_tag, executable, libpython, system, machine, libc, stdlib, distributions, n_distributions}`) |
| `config` | `{ digest, runner, engine, inifile, options }` | the configuration identity (`runner` e.g. `pytest 8.3.3`, `engine` e.g. `detpy 0.1.0`) (`config` digests the pytest and Level 0 settings) |
| `changedFilesProven` | number | `n_changed_files_proven`: files changed since the reused run that were proven irrelevant |

`receipts.jsonl` carries only the counts; the lists are in `proof-cache.json`, so the runner joins the two and sends
each receipt with its lists (`RunnerReceipt`, below). A test that is not reused has `{"reused": false, "why":
"<kind>: <detail>"}` (kinds `new`, `failed-before`, `config`, `runtime`, `clock`, `env`, `data`, `code`): the run's
`skipMisses` and `missDetails` sum them.

## Defect bundle

A flaky test turned into a reproducible defect. Taken from `bundle.json` (24 keys) and `order.txt`:

```json
{"test": "test/integration/test_flask_multi_redis.py::test_aggregated_delitem_method", "status": "reproduced",
 "config": "3", "seed": 3, "kind": "order", "prefix_length": 31, "minimal_length": 2,
 "polluters": ["test/unit/test_flask_multi_redis.py::test_redis_import_error"], "setters": [],
 "order": ["test/unit/...::test_redis_import_error", "test/integration/...::test_aggregated_delitem_method"],
 "outcome": "error", "exception": ["TypeError", "setup", "TypeError: 'NoneType' object is not callable", "flask_multi_redis/redis_node.py:18"],
 "replay": {"runs": 10, "fails": 10, "fingerprints": ["6fc828330e79296ba4e94163743199dd"], "identical_fingerprint": true},
 "divergence": {"index": 1, "reason": "outcome-only", "description": "..."},
 "detpy": "0.1.0", "command": "pytest --det --det-seed=3 --det-order=<bundle>/order.txt -n 0", ...}
```

| Field | Type | From |
| --- | --- | --- |
| `id`, `projectId` | string | dashboard |
| `testId` | string | `test` |
| `status` | `"reproduced"` \| `"replay_unstable"` | `status` (`reproduced` only when `fails == runs` and the fingerprint is identical) |
| `state` | `"open"` \| `"fixed"` | dashboard: `fixed` once the minimal order passes 10/10 on a later commit |
| `cause` | `"polluter"` \| `"state_setter"` \| `"fails_alone"` | `kind`: `order` → polluter, `brittle` → state setter (the test fails without it), `fails-alone` |
| `causeTests` | string[] | `polluters` for `order`, `setters` for `brittle`, empty for `fails-alone` |
| `minimalOrder` | string[] | `order` (= `order.txt`, the target last; usually 2 tests) |
| `prefixLength` | number | `prefix_length`: the length of the order it was minimised from |
| `seed` | number \| null | `seed`; null when `config` is `"fixed"` |
| `fingerprint` | 32 hex | `replay.fingerprints[0]` |
| `replays` | `{ runs, fails, identicalFingerprint }` | `replay` ("replays 10/10") |
| `outcome` | string | `outcome` (`failed`, `error`, `error+teardown-error`) |
| `exception` | `{ type, phase, message, location }` | `exception` |
| `divergence` | `{ index, reason, description }` \| null | `divergence`; `reason` is `outcome-only`, `time`, `entropy`, `thread`, `random` or `fs` |
| `familyKey` | string | `causeTests` joined by `" + "`, or `"<none>"`: the same key as `families_by_polluter` of `detpy explore` |
| `firstSeenAt`, `lastSeenAt` | time | dashboard |
| `firstRunId`, `lastRunId` | string | dashboard |
| `occurrences` | number | runs where this failure was seen |
| `engineVersion` | string | `detpy` |
| `language` | `"python"` \| `"node"` | the bundle's, else the project's |
| `replayCommand` | string \| null | the engine's own command, as the runner sent it with the bundle (`command` of `bundle.json`); null: the dashboard builds it, see below |

**Replay command.** The runner sends the engine's command; when it did not, the dashboard builds one. Python: `pytest --det --det-seed=S --det-order=<bundle>/order.txt` (no `--det-seed` when the seed
is null), after `fenvix defects pull <id>` writes the bundle to `<bundle>`. Node: the engine has no `--det-order`,
minimiser or bundle yet (branch `claude/node-l0`), so the command is the seed only:
`detjs vitest run --det --det-seed=S` (or `detjs jest --det --det-seed=S`), and the dashboard says that the order is
not replayed. The engine's own `detpy replay <bundle>` works as well and is shown next to it.

## Audit rerun

One skipped test the engine ran anyway to check its skip (5% of the tests skipped with proof, chosen by the engine).
Table `ci_audit_reruns` (migration 0014), one row per run and test.

| Field | Type | Notes |
| --- | --- | --- |
| `runId`, `runNumber`, `testId` | | |
| `cacheKey` | 32 hex | the receipt's key that was checked |
| `outcome` | `"confirmed"` \| `"wrong_skip"` | `confirmed`: it passed, as the receipt said; `wrong_skip`: it failed although it would have been skipped |
| `untrusted` | boolean | the engine stopped trusting that cache key (after a wrong skip, or when its inputs could not be re-proven) |
| `detail` | string | why, in a sentence |
| `at` | time | |

## Exploration

One night of exploration of a project (`detpy explore`, on fenvix machines; the nightly exploration add-on). Taken from the
engine's `explore.json`: `{seeds, seconds, runs, collected, failing_tests, always_failing, flaky_failing, bundles,
not_reproduced_budget, families_by_divergence, families_by_polluter, seeds_log, run_log}`. Table `ci_explorations`
(`supabase/migrations/0012_ci_explorations.sql`).

| Field | Type | From |
| --- | --- | --- |
| `id`, `projectId` | string | dashboard |
| `startedAt`, `finishedAt`, `commitSha`, `branch` | | the runner |
| `seeds`, `runs`, `collected`, `seconds` | number | `seeds`, `runs`, `collected`, `seconds` |
| `flakyFailing`, `alwaysFailing` | string[] | `flaky_failing`, `always_failing` (always failing = a real failure, not flaky) |
| `notReproduced` | string[] | `not_reproduced_budget`: flaky tests the time budget did not reach |
| `newDefectIds` | string[] | defects whose bundle this night produced for the first time |
| `familiesByPolluter` | `{ key, tests }[]` | `families_by_polluter`, counted |
| `seedsLog` | `{ seed, seconds, failing }[]` | `seeds_log`, `failing` counted |

## Usage

Computed from runs and usage events, not sent by the runner.

| Field | Type | Notes |
| --- | --- | --- |
| `month` | `YYYY-MM` | |
| `runsUsed` | number | billable usage events of the month |
| `unitsUsed`, `unitsIncluded` | number, number \| null | run units (see Run units); `unitsIncluded` from the plan, null = not set yet |
| per project: `runs`, `testMinutesRan`, `minutesSaved`, `otherStepMinutes`, `githubEquivalentMinutes`, `githubEquivalentUsd` | number | whole minutes; `testMinutesRan + minutesSaved + otherStepMinutes = githubEquivalentMinutes` in every row and in the totals |
| `githubRate` | `{ usdPerMinute, runner, source, checkedOn }` | the GitHub-hosted price the comparison uses |

`githubEquivalentUsd = githubEquivalentMinutes × githubRate.usdPerMinute`. The rate is stored in
`public.ci_reference_rates`; today `0.008` USD per minute for a Linux 2-core GitHub-hosted runner, DECLARED by GitHub's
Actions pricing page as quoted in fenvix-brain-cli `PRODUCT.md`, **to verify** before it is shown to a customer.

## Plan

Monthly plans by run units (and the nightly exploration add-on).

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `name`, `description` | string | |
| `kind` | `"plan"` \| `"addon"` | |
| `unitsIncluded` | number \| null | run units included each month; null = not set yet |
| `maxProjects` | number \| null | null = no limit |
| `priceUsdMonth` | number \| null | set by the founder on 2026-11-18 (migration 0014); null for the add-on until set |
| `features` | string[] | |

## GitHub App records (migration 0013)

Written by the GitHub App (`github-app/`, `docs/GITHUB-APP.md`) as the restricted role `fenvix_github_app`.

**Installation** (`gh_installations`): one installation of the App on a GitHub account. `installationId`,
`accountLogin`, `accountType` (`User` | `Organization` | `Enterprise`), `repositorySelection` (`all` | `selected`),
`permissions`, `events`, `suspendedAt`, `deletedAt`, `linkedBy`, `linkedAt`; `workspaceId` is null until an owner or
admin links it. Members read their organization's installations.

**Linking an installation** (review R-016 F1, F2; migration 0015). GitHub's return to the App's `/github/setup` only
prepares a link: the App checks the install link's signed state (organization, person, one hour, usable once), the
GitHub user's OAuth code, that GitHub lists the installation for that GitHub user, **and that the GitHub user
administers the installation's account** (the account itself for a `User` account; an active `admin` of the
organization for an `Organization`; seeing an installation takes only read access to one of its repositories). It then
stores a **completion** (`gh_install_completions`: the sha256 of a one-time code, the state's hash, the installation,
the organization and the fenvix person the state names, the GitHub user; valid 10 minutes, used once) and redirects to
`/projects/connect?github=confirm&installation=<id>&account=<login>#completion=<code>`. The dashboard completes the link
with the signed-in person's own session (`POST /v1/github/installations/complete`); the database
(`api_complete_github_link`) links only if that person is the one the state names and is still an owner or admin of
the organization. Someone who installs the App from another person's link connects nothing to that person's
organization. Error reasons of the redirect: `expired`, `incomplete`, `oauth`, `not_yours`, `github_not_admin`,
`not_admin`, `other_organization`, `removed`, `used`, `github`, `error`.

**Repository** (`gh_repositories`): a repository an installation gives access to. `repositoryId` (GitHub's id),
`fullName`, `defaultBranch`, `removedAt`, `projectId` (the Project once created), `onboardingState`
(`pending` | `pr_open` | `merged` | `closed` | `no_workflow` | `no_test_job` | `already_fenvix` | `unsupported` |
`failed`), `onboardingDetail` (why), `onboardingWorkflowPath`, `onboardingJob`, `setupPrNumber`, `setupPrUrl`,
`detectedLanguage`, `detectedTestRunner`. Every state is stored with a detail a person can read. A Project is created
for a linked repository once its language **and** test runner are known: from the workflow analysis, else from the
run's summary (its `language` / `test_runner`, else the runtime: `detpy` is Python and pytest, `detjs` is Node with
vitest or jest named by the summary), else not yet (a Node repository is never labelled pytest). Its `setupState` and
`setupPullRequest` follow the onboarding pull request. A repository renamed or moved to another installation of the
same organization keeps its project.

**Job** (`gh_jobs`): one GitHub job that asked for `runs-on: fenvix`; `region` is where its machine was placed, `mode`
the run mode the App chose for it (`FENVIX_MODE`, migration 0015), `ciRunId` its run row.

**Warm-up** (`gh_warmups`, migration 0017): one warm-up run of a repository's default branch at one commit (unique
per repository and commit; at most one pending or running per repository). `commitSha`, `ref`, `trigger`
(`onboarded` | `push` | `linked`), `status` (`pending` | `dispatched` | `running` | `succeeded` | `failed` |
`unsupported` | `covered` | `superseded` | `cancelled`), `detail` (why it waits or how it ended, for a person),
`pushedAt` (ordering), `notBefore`, `region`, `runnerName`, `attempts`, `preemptions`, `coveredByJob`,
`machineSeconds` (our cost), `summary` (the runner's, trimmed). Members read their organization's warm-ups through the
API; the App writes them.

**Repository cache state** (`gh_repositories.cache_warm_sha`, `cache_warm_at`, `cache_warm_source` = `warmup` | `run`,
`cache_warm_pushed_at`, migration 0017): the newest default-branch commit (by push time) whose proofs are in the shared
cache. The API shows it as `warmCache` on every Project and GitHub repository:

| Field | Type | Notes |
| --- | --- | --- |
| `state` | `"warm"` \| `"warming"` \| `"cold"` | warming: a warm-up is pending or running; warm: `commitSha` is set; else cold |
| `commitSha` | string \| null | "cache warm since" this commit (40 hex) |
| `warmAt` | time \| null | when it became warm at that commit |
| `source` | `"warmup"` \| `"run"` \| null | one of fenvix's warm-ups, or the customer's own trusted run on the default branch |
| `warmup` | `{status, commitSha, detail, updatedAt}` \| null | the repository's latest warm-up (the one in flight first) |

**Results staging** (`gh_run_results`, migration 0014): the runner's results chunks as received, one row per job and
chunk (sent again: replaced), with `appliedAt` once applied to the run and `applyError` when not (yet).

**Usage event** (`ci_usage_events`, per-run billing): one per GitHub job that asked for `runs-on: fenvix`, and one per
warm-up run that used one of our machines (migration 0017, never billable: see "Warm-up runs").

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `workspaceId` | string \| null | the installation's organization; null until it is linked, filled in by the link |
| `installationId`, `repositoryId` | number | GitHub ids |
| `repositoryFullName` | string | |
| `projectId`, `runId` | string \| null | the Project and the Run summary, when the organization is linked |
| `githubJobId` | number \| null | unique: a job is billed once; null for a warm-up |
| `githubRunId`, `githubRunAttempt` | number \| null, number | null for a warm-up |
| `warmupId` | number \| null | the warm-up (`gh_warmups.id`), unique: a warm-up is recorded once; null for a job |
| `kind` | `"ci_run"` \| `"warmup"` | |
| `quantity` | number | 1 |
| `billable` | boolean | see `reason` |
| `reason` | `"completed"` \| `"failed"` \| `"cancelled_after_start"` \| `"no_summary"` \| `"cancelled_before_tests"` \| `"warm-up"` | for a job, only `cancelled_before_tests` is not billable: the job never started on our machine, by GitHub's data (see Run units); a `warm-up` event is never billable (database check) |
| `planId` | string \| null | the organization's plan when the run ended |
| `conclusion` | string \| null | GitHub's conclusion of the job; for a warm-up, how it ended (its status) |
| `testMinutesRan`, `minutesSaved`, `otherStepMinutes` | number | as in the Run summary (from `summary.json`, bounded by the job's duration): shown, not billed |
| `heldMinutes` | number | the minutes the job held the fenvix machine, by GitHub's timings (`completed_at − started_at`): what run units count (migration 0015). For a warm-up, the minutes its machine ran by the App's own clock (dispatch to report or termination); never billed |
| `baselineMinutes`, `units` | number | generated: `heldMinutes`, and `heldMinutes / 10` (see Run units) |
| `occurredAt` | time | when the job completed |
| `month` | date | first day of the month of `occurredAt` (UTC), generated |

The Usage record's `runsUsed` is the count of billable usage events of the month, `unitsUsed` their run units.

## What the runner sends

The runner is the fenvix machine's side (another repository): the GitHub Actions runner plus `runner/fenvix-run`, which
wraps the job's test command in the engine (`detpy` for Python/pytest, `detjs` for Node vitest/jest). It sends four
kinds of records to the App (`https://api.fenvix.dev/v1`, operations tagged `runner` in `openapi/fenvix-api.yaml`;
the request schemas there are the contract and the App checks every body against them).

**Credential.** Every call carries the machine's own credential, `Authorization: Bearer fxr1....`, minted by the App for
that machine (file `/etc/fenvix/summary-token`, root only): it names the runner, the repository and, on a per-job
machine, the run and (since review R-016) the run attempt. A body that names another runner, repository, run or attempt
is refused (`403`); no credential or a bad one
is `401`; a body that does not match the schema is `400` with `error.field` naming the field. Accepted records are
answered `202 {"ok": true}`. On `5xx` or a network error the runner retries with backoff (the records are idempotent);
it never retries a `4xx`.

Every record of a job names it the same way: `runId` (`GITHUB_RUN_ID`), `runAttempt` (`GITHUB_RUN_ATTEMPT`, default 1),
and optionally `repositoryId` and `runnerName`, which must match the credential. Repository + run + attempt + runner
name is one job (a runner runs one job at a time).

### What the machine receives

A per-job machine's user data writes `/etc/fenvix/runner.env` (root only) with the plain settings and these per-job
values the runner reads:

| Variable | Value |
| --- | --- |
| `FENVIX_MODE` | `shadow` while the organization's 30-day trial runs, else `enforce` (see Trial). The runner runs the engine in that mode. It is the run's mode: the App records it on the job when it starts the machine, and a `mode` the runner reports back is ignored (review R-016 F4) |
| `FENVIX_REGION` | `us` or `eu`: the organization's region; the machine runs there (the App never starts an EU organization's job anywhere else; with no machine available in the region the job stays queued and GitHub times it out) |
| `FENVIX_MACHINE` | `per-job` (a demo machine: `demo`, with `FENVIX_MODE=enforce`) |
| `FENVIX_RUNNER_NAME`, `FENVIX_JOB_ID` | the just-in-time runner's name and the GitHub job id |
| `FENVIX_CACHE_ACCESS`, `FENVIX_CACHE_URL`, `FENVIX_CACHE_ORG` | the shared cache: `write` only on trusted refs; the installation's own cache organization |

and the credentials `/etc/fenvix/summary-token` (the App credential above), `/etc/fenvix/cache-token` (shared cache),
`/etc/fenvix/jitconfig` (GitHub's just-in-time runner configuration). Until 2026-11-18 `FENVIX_MODE` held the kind of
machine (`per-job`, `demo`); that is `FENVIX_MACHINE` now.

### 1. Progress, while the job runs: `POST /v1/runner/progress`

Sent at the start of each phase (`setup`, `collecting`, `testing`, `reporting`), at most every 3 seconds while tests
run, and once more when the test step ends. Written at once (no queue), so the dashboard's live view sees it on its
next poll.

```json
{"runId": 31000, "runAttempt": 1, "seq": 17, "phase": "testing", "testsTotal": 1840, "testsDone": 912,
 "passed": 900, "failed": 1, "skippedWithProof": 11, "currentTest": "tests/test_tax.py::test_vat[3]",
 "elapsedMs": 48200, "mode": "shadow"}
```

`seq` increases with every record of the job (start at 0): a record that arrives after a newer one is ignored.
`testsTotal` is null until collection ends. A record sent before GitHub reported the job as started, for a job whose
repository has no project yet, or after the run finished is accepted and not stored. Body at most 64 KB.

### 2. Results, before the summary: `POST /v1/runner/results`

The job's per-test outcomes, skip receipts, defect bundles and audit reruns, in numbered chunks: at most 5,000 tests,
2,000 receipts, 500 defects and 5,000 audit reruns per chunk, 6 MB per request. Chunk numbers start at 0; chunk 0
carries `chunks`, the total. Send them when the test step ends, **before the summary**; a chunk sent again before it was
applied replaces the stored one (once applied it stays as applied). The App stores each chunk and applies them to the
run when the job is published (after the summary and GitHub's `completed`); a chunk that arrives later is applied when
it arrives. Applying is idempotent.

**What one job may store** (review R-016 F7). The records of a job are kept only for that job:

- the attempt: a per-job credential names it, and a record for another attempt is `403`. For a credential that does not
  name it (a demo machine, or a credential minted before this change), the attempt must be one GitHub ran on that
  runner (`gh_jobs`: repository, run, attempt, runner name); until the job's start is recorded the App retries the
  chunk, and a chunk for an attempt that runner did not run is dropped;
- the chunk number: below `chunks`. A chunk 0 whose `chunk` is not below its own `chunks` is `400`; a later chunk at or
  past the count chunk 0 declared is dropped, and chunks stored past that count go when chunk 0 arrives;
- at most **200 chunks and 256 MB per job** (one million tests at 5,000 a chunk); a chunk past either is dropped;
- staged chunks are deleted **7 days** after they arrived (the credentials live 24 hours).

A dropped chunk is still answered `202` (it is checked after the queue) and logged.

```json
{"runId": 31000, "chunk": 0, "chunks": 2, "engineRunId": "20261118T094005-4412", "seed": 3, "mode": "enforce",
 "tests": [
   {"testId": "tests/test_tax.py::test_vat[3]", "outcome": "failed", "durationMs": 12,
    "failure": {"kind": "real", "phase": "call", "exceptionType": "AssertionError", "message": "assert 30 == 31", "location": "tests/test_tax.py:40"}},
   {"testId": "tests/test_money.py::test_default_currency_is_eur", "outcome": "failed", "durationMs": 3,
    "failure": {"kind": "flaky_defect", "defectFingerprint": "<32 hex>"}},
   {"testId": "tests/test_cart.py::test_total", "outcome": "skipped_with_proof", "durationMs": 8, "cacheKey": "<32 hex>"}],
 "receipts": [{"testId": "tests/test_cart.py::test_total", "cacheKey": "<32 hex>", "reusedEngineRunId": "20261117T101502-4412",
   "fingerprint": "<32 hex>", "reusedDurationMs": 8, "code": [...], "modules": [...], "filesRead": [...], "envRead": [...],
   "runtime": {...}, "config": {...}, "changedFilesProven": 2}],
 "defects": [{"testId": "...", "status": "reproduced", "kind": "order", "polluters": ["..."], "setters": [], "order": ["...", "..."],
   "prefixLength": 31, "seed": 3, "fingerprint": "<32 hex>", "replay": {"runs": 10, "fails": 10, "identicalFingerprint": true},
   "outcome": "failed", "exception": {"type": "...", "phase": "call", "message": "...", "location": "..."}, "divergence": null,
   "engineVersion": "0.1.0", "language": "python", "replayCommand": "pytest --det --det-seed=3 --det-order=<bundle>/order.txt -n 0"}],
 "audit": [{"testId": "tests/test_cart.py::test_tax", "cacheKey": "<32 hex>", "outcome": "wrong_skip", "untrusted": true, "detail": "failed on rerun"}],
 "missDetails": [{"kind": "code", "detail": "shop/tax.py::vat", "tests": 10}]}
```

| Field | What the runner puts there | Becomes |
| --- | --- | --- |
| `engineRunId` | the engine's run id (`proof-cache.json` → `Entry.run` of this run) | the run's `engineRunId`; later receipts that reuse this run point at it |
| `seed` | `--det-seed`, null for collection order | the run's `seed` |
| `mode` | the mode the engine ran in (`FENVIX_MODE`) | ignored: the run's `mode` is the App's (`FENVIX_MODE` it gave the machine) |
| `missDetails` | the top 5 reasons tests were not reused (summed `why` of `receipts.jsonl`) | the run's `missDetails` |
| `tests[]` | one per test of the run (`passed`, `failed`, `skipped_with_proof`, `not_proven`; a test the framework skipped is not sent); `notProvenCause` (optional, at most 500 characters) for a `not_proven` test: why it could not be proven identical to the serial run (stored for that outcome only); `durationMs` (for a skipped test: the recorded one; stored at most the job's own duration, GitHub's timings); `failure` for a failed test: `kind` `flaky_defect` when the engine reproduced it as a defect (with the bundle's `defectFingerprint`), else `real`; `cacheKey` of a skipped test | Per-test outcome (`ci_test_results`); `failure.defectId` is found by the defect's test and fingerprint, `receiptId` by the receipt's test |
| `tests[].wouldSkip` | **shadow mode**: true when the engine would have skipped the test with proof (it ran anyway) | the run's `wouldSkipTests` (count) and `wouldSaveMs` (their `durationMs`, each at most the job's duration; the sum at most the run's own test time, `testTimeMs.ran + testTimeMs.skipped`, so a share computed from it is within 0 to 1) |
| `receipts[]` | one per test skipped with proof: the `receipts.jsonl` line joined with the test's `proof-cache.json` entry (the lists: `code` = `Entry.units`, `modules` = content/skeleton/hooks, `filesRead` = `Entry.data`, `envRead` = `Entry.env`, `runtime`, `config`) | Skip receipt (`ci_skip_receipts`); `reusedRunId` = the project's run whose `engineRunId` is `reusedEngineRunId`. A skipped test and its receipt go in the same chunk (a skipped test whose receipt has not arrived waits for it) |
| `defects[]` | each defect bundle the engine wrote this run (`bundle.json` + `order.txt`) with the engine's replay command (`command`, `replayCommand`) | Defect (`ci_defects`), by project, test and fingerprint: new, or seen again (`occurrences` + 1 once per run, `lastSeenAt`, `lastRunId`, reopened if it was fixed). `cause` from `kind`: `order` → polluter, `brittle` → state_setter, `fails-alone` → fails_alone; `causeTests` = `polluters` / `setters` / none; `familyKey` = them joined by `" + "`, or `"<none>"` |
| `audit[]` | the audit reruns (5% of the tests skipped with proof, run anyway): `confirmed` or `wrong_skip`, `untrusted` when the engine stopped trusting the key | Audit rerun (`ci_audit_reruns`); the run's `audit.rerun` and `audit.wrongSkips` |

### 3. The run summary, when the test step ends: `POST /v1/runner/summaries`

`runner/fenvix-run`'s `summary.json` (unchanged), after the results chunks:

```json
{"runId": 31000, "runAttempt": 1, "receiptsUrl": "<https link to the receipts, optional>", "summary": {...summary.json...}}
```

Two optional additions to `summary.json`: `language` (`python` | `node` | `go`) and `test_runner` (`pytest` | `vitest` |
`jest` | `go test`), so the App knows a repository's stack when its workflow did not tell (without them it reads the
runtime: a `detpy==` distribution is Python and pytest; `detjs` is Node, with vitest or jest from the summary's
`runner` or `config.runner` when present); and `mode` (`shadow` | `enforce`), which the App ignores (the run's mode is
its own, see Trial). The App publishes the run once both the
summary and GitHub's `completed` are in (or `SUMMARY_WAIT_SECONDS` after `completed` without a summary, or at once
when the job was cancelled before it started). The per-test maps (`outcomes`, `reused_outcomes`) and the runtime's
distribution list are dropped before the summary is stored.

From the summary (and the job) to the Run summary:

| Run summary | From |
| --- | --- |
| `commitSha`, `branch`, `startedAt`, `finishedAt`, `durationMs` | the `workflow_job` event (`head_sha`, `head_branch`, `started_at`, `completed_at`) |
| `commitMessage`, `trigger`, `pullRequest` | the workflow run (`GET /repos/{o}/{r}/actions/runs/{id}`: `head_commit.message` first line, `event`, `pull_requests`), or the App's `pull_request` events. `pull_request_target` → `pull_request`; any other event outside the five → `workflow_dispatch` |
| `pushedAt` | the `push` event of that commit (`repository.pushed_at`), else the workflow run's `created_at` |
| `status` | `running` from the job's start; then, first match wins: `cancelled` if the job was; with no summary, `passed` if the job succeeded, else `failed`; `failed` when the summary has failures or flaky tests; `not_proven` when N > 0 (see "Parallel with proof"); `failed` for a non-zero `exit`; else `passed` (`runStatus` in `github-app/src/results/status.ts`) |
| `tests.total`, `tests.ran`, `tests.skippedWithProof` | `tests`, `ran`, `reused_with_proof` |
| `tests.failed`, `tests.flakyDefects` | `len(failed) + len(flaky)`, `len(flaky)` (the runner's `failed` holds only real failures; `flaky` = failed in the suite, passed alone) |
| `tests.passed` | `outcome_counts.passed − reused_with_proof` (tests that ran and passed), minus N (at least 0): a test not proven is never counted as passed |
| `tests.notProven` | N (see "Parallel with proof") |
| `proof` | `proof`, camelCase, seconds as milliseconds (`parallel_seconds` → `parallelMs`, `serial_seconds_estimate` → `serialMsEstimate`); null when absent |
| `testTimeMs.ran`, `testTimeMs.skipped` | `test_seconds_run` × 1000, at most the job's duration (`durationMs`); `test_seconds_saved` × 1000 |
| `otherStepMinutes` | (job duration − `wall_seconds` of the test command, at most the job's duration) / 60 |
| `engineVersion` | the `detpy==X` (or `detjs@X`) entry of `runtime.dist_list` |
| `skipMisses` | `not_reused_reasons` |
| `mode` | the App's: the `FENVIX_MODE` it started the machine with (`gh_jobs.mode`), else the organization's when the job started (`shadow` during the trial). Never the results' or the summary's (review R-016 F4) |
| `region` | where the App placed the machine |
| `engineRunId`, `seed`, `missDetails`, `wouldSkipTests`, `wouldSaveMs`, `audit` | the results chunks |

### Parallel with proof

When the test command ran with parallel lanes, `summary.json` carries an optional `proof` object (absent for a serial
run):

```json
"proof": {"workers": 4, "proven": 360, "not_proven": 14, "rerun_one_lane": 14,
          "parallel_seconds": 39.2, "serial_seconds_estimate": 151.0, "order_digest": "7c1e...9a04",
          "not_proven_causes": [{"cause": "file read outside the project", "tests": 14}]}
```

`serial_seconds_estimate` and `order_digest` may be null; `proven + not_proven` = the tests that ran.

**N, the not-proven count of a run** (`RunSummary.notProven`, `notProvenOf` in `github-app/src/results/summary.ts`; one
value used by the status, the check run's conclusion and title, and `tests.notProven`). One rule: **when we are not
sure, the run is never green**; and a run is never red for something the runner did not report. N is the largest of:

1. `proof.not_proven`; and, when `proof.proven + proof.not_proven` is not **`ranExecuted`**, `ranExecuted - proof.proven`
   (a proof never hides tests). `ranExecuted` = `ran - outcome_counts.skipped`: the tests the framework skipped itself
   did not run, so the engine's proof does not count them.
2. A `proof` that is present (not absent, not null) but cannot be read (not an object, a field of the wrong type, an
   empty `order_digest`, a cause over 500 characters, more than 50 causes): stored as null, the rest of the summary is
   kept, and N is at least `max(1, proof.not_proven, ranExecuted - proof.proven)` from what can be read.
3. The summary's top-level `not_proven`.
4. The verify counts, always: `verify_counts.not_proven + max(diverged, wrong_reuse) + missing` (a wrong reuse is also a
   divergence, so it is not counted twice); at least 1 when verify failed: a `verify_status` present and not
   `"identical"` (`"diverged"`, `"not_proven"`, or a value this version does not know), or a non-zero (or non-numeric)
   `verify_exit` whatever `verify_status` says. `"identical"` with all-zero counts and `verify_exit` 0 adds nothing.
   When verify failed only because the inputs differ (`input_differs` > 0, no other count), N is 1 and the reason is
   "inputs differ": the console says the runs could not be compared, not "1 test".
5. A missing or invalid `exit` (not a whole number): at least 1, reason "exit code missing" (unknown is never green).

When no proof cause explains N, the run keeps why (`ci_runs.not_proven_reason`, the Run's `notProvenReason`): the
summary could not be read, exit code missing, the proof could not be read, the proof does not cover every test that ran,
inputs differ, the check against the serial run failed. `status.not_proven` is not used. Example: the Node fixture
`node-mocha-verify-failed` (`exit` 0, `verify_status: diverged`, one diverged test) has N = 1 and status `not_proven`.

**A summary that came but cannot be read** (it was accepted, then today's parser refuses it) never falls back to the
job's conclusion: the run is `not_proven` with N = 1 and the reason "the runner's summary could not be read", and its check
run concludes `failure`. No summary at all keeps the rule above (passed if the job succeeded, else failed).

**Per-test rows count too**: after results chunks are applied, `tests_not_proven` becomes at least the run's number of
per-test `not_proven` rows (`passed` lowered by as many) and a `passed` run becomes `not_proven`; when that happens after
the run was published, its check run and comment are published again (same check run, one usage event).

A run with N > 0 is never green: its status is `not_proven` (unless it failed), its check run on GitHub concludes
`failure` (even with `exit` 0) and its title says "N not proven" instead of "no failures". Per-test results may carry
`outcome: "not_proven"` with an optional `notProvenCause` (`POST /v1/runner/results`).

### 4. Nightly exploration: `POST /v1/runner/explorations`

After a night of `detpy explore` (the nightly exploration add-on) on a machine whose credential names the repository:
the summary of `explore.json` and the defect bundles it produced (each with its replay command), at most 500 defects,
6 MB:

```json
{"startedAt": "2026-11-19T02:00:00Z", "finishedAt": "2026-11-19T02:40:00Z", "commitSha": "<40 hex>", "branch": "main",
 "seeds": 20, "runs": 20, "collected": 1840, "seconds": 2400, "flakyFailing": ["..."], "alwaysFailing": ["..."],
 "notReproduced": [], "familiesByPolluter": {"<polluter>": ["<test>", "..."]},
 "seedsLog": [{"seed": 1, "seconds": 120, "failing": ["..."]}], "defects": [ {...RunnerDefect...} ]}
```

The App writes one Exploration for the repository's project (sent again: the same one, updated) and upserts its
defects; `newDefectIds` are the defects this exploration found first. An exploration is not a run: it does not count
as a defect occurrence. A repository without a project keeps nothing (logged).

**Limits** (review R-016b G2, migration 0016), the same kind as the results' limits:

- **Not from a CI job's credential.** A per-job credential (it names a run; the job's own steps can read it) is refused
  with `403`. Explorations come from a machine whose credential names the repository only.
- **One new exploration per project and UTC day**, by the App's clock (`ci_explorations.received_at`), so at most 6 MB
  a night. The same one sent again (same `startedAt` and `commitSha`) is updated; another one that day is dropped
  (`202`, logged).
- **90 nights kept per project**: the newest by `received_at`; older ones are deleted when a new one is stored. The
  defects they found stay.

### 5. Warm-up runs: `POST /v1/runner/warmups`

**Why.** A customer should almost never see a cold first run. When a repository goes on fenvix (its setup pull request
merged, or it already ran on `runs-on: fenvix`) in an installation linked to an organization, when such an installation
is linked, and after every push to its default branch, the App runs the repository's test job **once** at that
default-branch commit on our machines, so the shared cache holds the default branch's proofs before the customer's
next pull request. A warm-up is **not a run**: no run row, no check run and no status on the customer's commit, no pull
request comment, no GitHub Actions run (so no Actions minutes and none of the customer's other jobs run), and it is
**never billed** (its usage event is non-billable, reason `warm-up`, kept for our own cost).

**How it is started (decided 2026-11-18): a dedicated warm-up job on our runner pool, not `workflow_dispatch`.**
`workflow_dispatch` would need an `on: workflow_dispatch` trigger in the customer's workflow (a second change in the
setup pull request) and the `actions: write` permission; it would run the **whole** workflow (lint, build, deploy jobs
on `push`-like conditions, GitHub-hosted jobs billed to the customer) and GitHub would show its check suite on the
customer's commit. The warm-up machine instead runs only the test job, from **the customer's own workflow file at that
commit** (the file and job the setup pull request moved to `runs-on: fenvix`: the same steps, `env`, `with:` inputs and
runner image as the customer's runs, so the engine computes the same cache keys as their pull request runs), outside
GitHub Actions. When the customer's own workflow already runs the fenvix job on pushes to the default branch, that run
(cache write access: a trusted ref) **covers** the commit and no warm-up machine starts: the App waits
`WARMUP_GRACE_SECONDS` (180 s) after a push before it gives a warm-up a machine.

**Scheduling (the App's warm-up scheduler, every minute).** Lowest priority: a warm-up takes a machine only when no
customer job is waiting for one in the region, and never the last `WARMUP_RESERVE` (1) machines of the region's fleet;
a customer job that finds the fleet full **preempts** the newest warm-up (its machine is terminated at once; the warm-up
goes back to pending and runs later on a new machine). At most `WARMUP_ORG_CONCURRENCY` (1) warm-ups of an
organization on machines at once; at most `WARMUP_DAILY_CAP` (6) warm-ups of a repository take a machine in any 24
hours (the next waits until the oldest of the window is 24 hours old). A newer default-branch commit **supersedes** the
warm-up in flight (a running machine is terminated); an older commit delivered late is stored superseded. Any
default-branch push newer than a warm-up in flight for another commit supersedes it, also when the pushed commit is
already warm (a reset of the branch to the last warm commit stops the warm-up of the commit it removed; review R-018
F1). **Only the branch's head runs:** right before a machine starts, the App reads `GET /git/ref/heads/<branch>`; a
warm-up whose commit is no longer the head is `superseded` with no machine, and the current head is requested in its
place. A commit whose warm-up was superseded before it had a machine is warmed again when it is pushed again later (a
replayed delivery, same push time, changes nothing). A customer's trusted run covers a pending warm-up only until that
run is published: one published without results re-arms the warm-up, which it never covers again (review R-018 F2).
The machine runs in the **organization's region** (`workspaces.region`) or not at all. A machine that has not reported `started`
after `WARMUP_START_TIMEOUT_SECONDS` (900 s) is terminated and the warm-up tried again (3 machines at most); a warm-up
running longer than `WARMUP_MAX_SECONDS` (3 h) is stopped (`failed`). Suspending or uninstalling the App, or removing
the repository from it, cancels its warm-ups (machines terminated). After a warm-up of a repository ends `unsupported`,
its next warm-up waits 24 hours (one try a day, not one machine per push).

**What the warm-up machine receives** (user data, root only; the machine is no GitHub runner: no just-in-time
configuration). `/etc/fenvix/runner.env` with the plain settings and:

| Variable | Value |
| --- | --- |
| `FENVIX_KIND` | `warmup` (a job's machine has none) |
| `FENVIX_MACHINE` | `per-job` |
| `FENVIX_MODE` | `enforce`: skip with proof what is already proven, run the rest, write the results to the cache |
| `FENVIX_REGION` | the organization's region |
| `FENVIX_WARMUP_ID`, `FENVIX_RUNNER_NAME` | the warm-up and this machine's name (`fenvix-w<id>`, `fenvix-w<id>-<attempt>` after a preemption) |
| `FENVIX_CACHE_ACCESS`, `FENVIX_CACHE_URL`, `FENVIX_CACHE_ORG` | `write`, the installation's own cache organization (`gh-<installation id>`) |
| `FENVIX_WARMUPS_URL` | `https://api.fenvix.dev/v1/runner/warmups` |

and the files `/etc/fenvix/warmup.json`:

```json
{"v": 1, "warmupId": 17, "attempt": 1, "repository": {"id": 70001, "fullName": "acme/shop"}, "installationId": 4242,
 "commitSha": "<40 hex>", "ref": "refs/heads/main", "workflowPath": ".github/workflows/ci.yml", "job": "test"}
```

`/etc/fenvix/checkout-token` (an installation token for **this one repository**, `contents: read` and `metadata: read`
only, one hour: it can check out the commit and nothing else; GitHub refuses any write with it, so no check run or
comment can be made from the machine), `/etc/fenvix/cache-token` (shared cache, write, this installation's organization
only), `/etc/fenvix/summary-token` (this machine's App credential, naming the warm-up; it stays root only and is
accepted by `POST /v1/runner/warmups` only). The machine starts `fenvix-warmup.target` (infra/github-app/lib/runner/files):
root moves the description, the checkout token and the cache token to the job user and reports `started`; the job user
runs the runner's warm-up executor; root reports `finished` and powers the machine off.

**What the runner must provide** (fenvix-engine-cli, `runner/warmup.sh <warmup.json> <out-dir>`, run as the job user
with `HOME=/home/fenvix`; not in that repository yet, an image without it reports `unsupported`):

1. check out `commitSha` of `repository.fullName` with the checkout token into the same workspace path a GitHub runner
   uses (`/home/fenvix/fenvix/actions-runner/_work/<repo>/<repo>`), so paths the engine records match;
2. read `workflowPath` at that commit and run job `job`: its steps in order (`uses:` actions at their pinned refs,
   `run:` steps with the job's `shell`, `env` at workflow, job and step level, `with:` inputs), with the default
   variables of a `push` run on `ref` (`GITHUB_EVENT_NAME=push`, `GITHUB_REF`, `GITHUB_SHA`, `GITHUB_REPOSITORY`,
   `GITHUB_WORKSPACE`, `RUNNER_OS=Linux`, `CI=true`, ...), wrapping the test command in the engine exactly as
   `runner/fenvix-run` does for a job (`FENVIX_MODE=enforce`, the shared cache with the cache token). A matrix job runs
   its first Linux combination (in the matrix's order). `secrets.*` evaluate to empty strings, as for a pull request
   from a fork; `if:` conditions are evaluated for a push to the default branch;
3. never call GitHub except to fetch the commit and public actions (no check run, no status, no comment, no artifact,
   no cache API of GitHub Actions) and never the App (root reports);
4. write `<out-dir>/outcome.json` = `{"outcome": "succeeded" | "failed" | "unsupported", "detail": "<for a person>"}`
   and, when the test step ran, `<out-dir>/summary.json` = `runner/fenvix-run`'s `summary.json`. `unsupported`: the
   job cannot run outside GitHub Actions (it `needs:` another job's outputs or artifacts, uses `services:` or a
   `container:` the runner does not run, a dynamic `runs-on`/`matrix` it cannot evaluate, a reusable workflow);
   `failed`: a step or the tests failed (the engine still wrote what passed).

**The two reports** (root, `fenvix-warmup-report`, with this machine's credential; `4xx` is not retried, `5xx` is):

```json
{"warmupId": 17, "runnerName": "fenvix-w17", "event": "started"}
{"warmupId": 17, "runnerName": "fenvix-w17", "event": "finished", "outcome": "succeeded", "detail": "...", "summary": {...summary.json...}}
```

Schema `RunnerWarmupReport` in `openapi/fenvix-api.yaml`: `outcome` is required with `finished` and refused with
`started` (so is `summary`). Answers: `202` stored (or a late or repeated report: nothing changes); `400` the body;
`401` no or a bad credential; `403` a credential that is not this warm-up's machine (a job's credential, another
warm-up, the machine of an earlier attempt), and a warm-up credential on any other runner route; `404` no such
warm-up. A `succeeded` warm-up with its summary makes the repository's cache **warm since** its commit (unless a newer
commit is already warm); every warm-up that used a machine gets its one non-billable usage event (test minutes from
the summary, the rest of the machine time as other steps).

### Trial, mode and the 35% gate

Linking an organization's first GitHub installation starts its **30-day shadow trial** (`gh_link_installation`,
migrations 0014 and 0015; linking more installations does not restart it). Since review R-016 (migration 0015) a link
starts the trial only when the organization never had one, has no other installation linked (now or before: an
existing customer adding a GitHub account is not put into shadow mode), and the installation's GitHub account
(`account_id`) never had one through any organization (`ci_trial_accounts`: reinstalling the App and linking it to a
new organization does not start another). Organizations linked before 0014 get trial dates in the past. While it runs, the App starts machines with
`FENVIX_MODE=shadow` and the run rows get `mode: "shadow"`: every test runs, and the engine records, per test, whether
it would have skipped it with proof (`wouldSkip`). The trial's would-have-saved share is the shadow runs' `wouldSaveMs`
(each at most the run's own test time) over their test time (run + skipped), time-weighted over the trial's finished
runs, between 0 and 1; the **gate is met at 35%**
(`TRIAL_GATE` in `src/data/ci.ts`). After the trial, jobs run in `enforce` mode: unchanged tests are skipped with proof,
and 5% of the skipped ones are rerun as an audit.

### Run units

Billing is by **run units**: 1 unit = 10 **baseline minutes**. Since review R-016 (F3, migration 0015) the baseline
minutes of a job are **the minutes it held a fenvix machine, by GitHub's own timings of the job**: `completed_at −
started_at` of the `workflow_job` (delivered in webhooks GitHub signs with the App's secret), stored as
`ci_usage_events.held_minutes`; `baseline_minutes` and `units` are generated from it. Nothing the job writes changes
them: `summary.json` is a file the customer's own workflow can write (and the spool directory the poster sends from is
writable by the job user), so its `test_seconds_run`, `test_seconds_saved` and `wall_seconds` are shown (bounded by the
job's duration) but never billed. A job with no summary is billed the same minutes as one with a forged summary.

The time a job saved by skipping tests with proof is therefore **not** part of the units today. It can become billable
only from a measurement the job cannot write: either a measurement the runner signs with a key the job user cannot
read (a root-only process on the machine, outside the job's reach; the runner repository would have to add it), or a
value the App derives from GitHub's own timings (for example the same job's duration in shadow runs, where nothing is
skipped). Until one of those exists, `minutes_saved` on the usage event is a claim, kept for the dashboard only.

Units are counted on **billable usage events only** (`ci_usage_events.units`, generated; a month's units are the exact
sum rounded up to a whole unit). **Whether** an event is billable also rests on GitHub's data only (review R-016b G1): a
job that started on our machine (`runner_name` and `started_at` of the `workflow_job`) is billable, and is billed its
held minutes, whatever its summary and its conclusion (a job that sends no summary, or cancels its own run, a click on
Cancel, a `timeout-minutes`, is billed the minutes it held the machine; a job cancelled a few seconds after its start
holds a few seconds). A job that never started on our machine is not billable and has no run row. The summary and the
conclusion only name the `reason`.

### Region

An organization's region (`us` | `eu`) decides where its jobs' machines run (`RUNNER_PLACEMENT` of the App's worker:
one AWS region and launch template per region). The App records the region on the job (`gh_jobs.region`) and the run
(`ci_runs.region`), and passes it to the machine (`FENVIX_REGION`). A region with no placement gets no machine.

### Side-by-side runs (migration 0020)

An organization chooses how its repositories are onboarded (`workspaces.onboarding_kind`, `GET`/`PUT
/v1/organization/onboarding-kind`, owner or admin): `move` (the setup pull request changes the test job's `runs-on`)
or `side_by_side`. Not to be confused with the trial's `FENVIX_MODE=shadow`: side-by-side jobs always run in shadow.

- **The pull request.** Repositories chosen one by one get their pull request once the installation is linked
  (before: `gh_repositories.awaiting_link`, detail "waiting for the organization link"). A side-by-side pull request
  comes from branch `fenvix/side-by-side` and adds one file, `.github/workflows/fenvix-side-by-side.yml`, built from
  the customer's test job (`buildSideBySideWorkflow`: his push / pull_request / workflow_dispatch triggers, one job on
  the fenvix label that never gates, his steps up to his test step behind a gate step, no cache save, no write to
  GitHub, no fork pull request; refused with a reason otherwise). States `side_by_side_pr_open`, then `side_by_side`.
- **Our job** (`gh_jobs.kind = 'side_by_side'`: the fenvix label and the workflow run's `path` is that file): no check
  run, no comment; `FENVIX_MODE=shadow`; the machine `SIDE_BY_SIDE_INSTANCE_TYPE`; at most `SIDE_BY_SIDE_DAILY_CAP`
  full machines per repository per rolling 24 hours, else a skip machine (`gh_jobs.skip_machine`; the machine writes
  `/etc/fenvix/sbs-skip`, the gate step reads it and no kept step runs), at most `SIDE_BY_SIDE_SKIP_DAILY_CAP` a day.
  Hard lifetimes: a skip machine powers off 10 minutes after boot; a full machine at our job's `timeout-minutes`
  (his, at most 60: `gh_repositories.side_by_side_timeout_minutes`) plus 10 minutes, whatever the file says later.
  A full machine counts 4 slots of the fleet limit (one slot = a c6i.large, 2 vCPU) and starts only while its slots
  plus the warm-up reserve (`WARMUP_RESERVE`, default 1) are free, else the job gets a skip machine: with
  `RUNNER_MAX_RUNNING` 4 that is never, so full side-by-side machines need a higher limit. A paying job that finds the
  fleet full stops a warm-up first, else the newest full side-by-side machine (`gh_jobs.sbs_stopped_at`; the pair
  reads "not comparable: stopped for a customer job"). Skip machines take no slot; at most 4 run at once per region,
  above that the job gets no machine (it waits; his workflow is not affected). A machine only for code of the
  repository itself: a run GitHub does not show, a fork's pull request or a run without its head repository gets
  none; a failed lookup of the run is retried, never guessed. A repository being moved (setup pull request open or
  merged) is not onboarded side by side; one that runs side by side is not moved until its side-by-side file is gone
  from the default branch.
  Its run row is `ci_runs.kind = 'side_by_side'` (without a summary: `not_proven`, never passed); every reader of runs
  reads `kind = 'ci_run'` only. Its usage event is `kind = 'side_by_side'`, `billable = false`, `reason =
  'side-by-side'`. `gh_jobs.has_summary` and `gh_jobs.checkout_sha` (summary.json `commit`) are recorded at publish.
- **His job** (`gh_customer_jobs`, from completed `workflow_job` webhooks and from his last 30 days of runs, work
  `side_by_side_history`): the test job's resolved name (`gh_repositories.side_by_side_job_name`), or that name plus
  ` (` matrix values `)`; its steps, conclusion and timings; event and pull request from the workflow run.
- **Pairs and result** (`GET /v1/projects/{projectId}/side-by-side`): by head SHA, event and pull request, his job of
  the repository's matrix suffix with ours, the latest completed attempt of each; the comparison rule (first match):
  his job cancelled / timed out / skipped / waiting or missing → not comparable; ours on a skip machine, cancelled,
  timed out or without summary → not comparable; the engine NOT PROVEN → not proven; his failure at another step than
  his test step → not comparable; then same or different. A side missing 6 hours after the other is "not seen".
- **Prices** of his runner: `ci_runner_label_rates` (label → `ci_reference_rates`, which gains `usd_per_minute_max`
  for a range); minutes billed per job rounded up; a public repository on GitHub-hosted runners costs $0; an unknown
  label says "price unknown for <label>". `github-linux-2core` is 0.006 a minute since 0020 (it was 0.008).

## How records reach the dashboard

The runner sends the records above to the App; the App writes Postgres as the restricted role `fenvix_github_app`,
in transactions that name the organization (row level security keeps the others out): `ci_runs`, `ci_test_results`,
`ci_skip_receipts`, `ci_defects`, `ci_audit_reruns`, `ci_explorations`, `ci_usage_events` and its own `gh_*` tables.
The dashboard reads them only through the fenvix API (`openapi/fenvix-api.yaml`, role `fenvix_api`), never from the
database directly.

## Changes

- 2026-11-26 (migration 0020): **side-by-side runs** (section above): the organization's onboarding kind, the pull
  request after the link, `gh_customer_jobs`, the job and run kind `side_by_side` (never billed, never in the runs
  readers), runner label prices, `GET /v1/projects/{projectId}/side-by-side`. The GitHub-hosted reference rate is now
  0.006 a minute (it was 0.008): "On GitHub-hosted" amounts are 25% lower from then on.
- 2026-11-23 (console proof review, two rounds): N fails closed (the rule above: a malformed proof, contradictory or
  failed verify, a missing exit code, a proof that does not cover `ranExecuted`); an unreadable stored summary is
  `not_proven`, never the job's conclusion; per-test `not_proven` rows raise the run and re-publish its check run; new
  fields `Run.notProvenReason` (`ci_runs.not_proven_reason`), `RunProof.ranExecuted` and the tests list's `rowCounts`
  (the per-test rows the filters count; `counts` stays the run's own); `GET /search` finds nothing for one character.
  The console reads every response through `src/data/compat.ts`, so it works against the API one release older (no
  proof fields, no not-proven counts, no Overview proof block, no `/search`, the `not_proven` filters refused with 400).
- 2026-11-23 (console proof, migration 0019): **parallel with proof and NOT PROVEN**. `summary.json` gains an optional
  `proof` object; the Run gains `proof` and `tests.notProven`, the status `not_proven` (rule above, first match wins:
  cancelled, no summary, failures, N > 0, non-zero `exit`, passed), the per-test outcome `not_proven` with
  `notProvenCause`, the activity kind `run_not_proven`, the tests list's `counts.not_proven` and filter, the runs list's
  `status=not_proven` filter, the Overview's `proof` block (`runsWithProof`, `provenIdentical`, `notProven`) and
  `exitCode` (the summary's `exit`, so the run page can say whether the run exited 1), the project row's
  `lastRunNotProven` (the pill of a not-proven run always shows its count) and
  `GET /search?q=` (runs by number or commit prefix, open defects by test name; at most 20, newest first). N is
  `proof.not_proven`, else the larger of the top-level `not_proven` and (when `verify_status` is `diverged`)
  `verify_counts.not_proven + diverged + missing`, else 0; `status.not_proven` is not used. **The runner does not send
  `proof` yet** (a separate engine task): until it does, real runs show no proof card, but Node runs with a non-zero
  `not_proven` (or a diverged verify) already get the `not_proven` status and pill.

- 2026-11-19 (review R-016b): **whether a job is billable comes from GitHub's data only**: a job that started on our
  machine is billed its held minutes whatever its summary and conclusion (`cancelled_before_tests` now means "never
  started on our machine").
- 2026-11-19 (review R-016b, migration 0016): **explorations are bounded**: none from a CI job's credential, one new
  per project and UTC day (`ci_explorations.received_at`), 90 nights kept per project; staged summaries
  (`gh_run_summaries`) are deleted after 7 days, as staged results are.
- 2026-11-18 (review R-016, migration 0015): **run units from GitHub's job timings** (`held_minutes`; summary.json no
  longer sets what is billed); the **run's mode is the App's** (`FENVIX_MODE` recorded on the job; the results' and the
  summary's `mode` are ignored); test durations and `wouldSaveMs` bounded by the job's duration and the run's test time;
  **one trial per GitHub account**, none for an organization that already had an installation; the per-job credential
  names the **run attempt**; results limited to the job's own attempt, chunk numbers below `chunks`, 200 chunks and
  256 MB per job, deleted after 7 days; connecting GitHub is completed by the signed-in person through
  `POST /v1/github/installations/complete` (see "GitHub App records").
- 2026-11-18: Warm-up runs (migration 0017 (0016 before the R-016b merge), `github-app/src/warmup/`): `gh_warmups`, the repository's cache state
  (`cache_warm_*`), `warmCache` on Project and GitHub repository in the API, `POST /v1/runner/warmups` with the
  warm-up machine's own credential (refused on every other runner route), what a warm-up machine receives and what the
  runner's warm-up executor must do; usage events of kind `warmup`, reason `warm-up`, never billable (`githubJobId` and
  `githubRunId` null for them, `warmupId` set); `gh_jobs.cache_access` and `launched_at`.
- 2026-11-19 (merge with review R-016): a warm-up's `heldMinutes` is its machine time by the App's clock and bounds its
  `testMinutesRan`; linking through `POST /v1/github/installations/complete` (the worker's `installation_linked`) warms
  the repositories already on fenvix, as the link did before.
- 2026-11-19 (review R-018): only the default branch's head gets a warm-up machine (checked against GitHub right before
  it starts); any newer default-branch push supersedes warm-ups in flight for other commits, also when its commit is
  already warm; a covering run that was published without results never covers its warm-up again.

- 2026-11-18: "What the runner sends" (replaces the planned direct posting): live progress (`POST /v1/runner/progress`),
  per-test results in chunks with receipts, defect bundles with the engine's replay command, audit reruns and shadow
  mode's `wouldSkip` (`POST /v1/runner/results`), explorations (`POST /v1/runner/explorations`), summary additions
  (`language`, `test_runner`, `mode`), the machine's `FENVIX_MODE` (now the run mode; the machine kind is
  `FENVIX_MACHINE`) and `FENVIX_REGION`. New Run fields `mode`, `wouldSkipTests`, `wouldSaveMs`, `audit`, `region`,
  `progress`; new records Run progress and Audit rerun; the defect's `replayCommand` comes from the runner; the
  organization's region and 30-day trial with the 35% gate; plans and usage by run units (migration 0014). Records
  reach the dashboard through the API only.
- 2026-11-18: GitHub App records (installation, repository, usage event) and the mapping from the runner's
  `summary.json` to the Run summary (migration 0013, `docs/GITHUB-APP.md`).
- 2026-11-17: run summary gets `skipMisses` and `missDetails`; new Exploration record (migration 0012).

- 2026-11-17: first version.
- 2026-11-17 (addendum to P-015): `otherStepMinutes` added to the run summary; `githubEquivalentMinutes` is now the sum
  of test minutes run, skipped with proof and other steps (it was the project's median job before fenvix);
  minutes shown on screen add up.
