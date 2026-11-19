# Data contract: runner → dashboard

Written 2026-11-17, runner part rewritten 2026-11-18. This is **our** contract between the fenvix runner (the machines
behind `runs-on: fenvix`, which run the engine) and the customer dashboard. It is not the engine's internal file
format: the runner reads the engine's files and sends these records to the fenvix GitHub App (`github-app/`), which
writes them to Postgres; the dashboard reads them through the fenvix API (`openapi/fenvix-api.yaml`), never from the
database directly. The tables (`supabase/migrations/0011` to `0014`), the API's schemas, the mock (`src/data/mock.ts`)
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
| `status` | `"running"` \| `"passed"` \| `"failed"` \| `"cancelled"` | |
| `pushedAt`, `startedAt`, `finishedAt` | time | `pushedAt` is when the commit reached GitHub: time to green = `finishedAt − pushedAt` of the first passing run of a commit |
| `durationMs` | number | wall time of the test job |
| `tests` | `{ total, ran, passed, failed, skippedWithProof, flakyDefects }` | `failed` counts every failure; `flakyDefects` is the part of it that is a reproducible flaky defect |
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
| `outcome` | `"passed"` \| `"failed"` \| `"skipped_with_proof"` | a test the framework itself skipped (`@skip`) is not sent |
| `durationMs` | number | for a skipped test: the duration recorded in the reused run |
| `failure` | `{ kind: "real" \| "flaky_defect", phase, exceptionType, message, location, defectId }` \| null | from the bundle's `exception` = `[type, phase, message, location]`; `flaky_defect` when the engine reproduced it (a defect exists) |
| `receiptId` | string \| null | set when `outcome` is `skipped_with_proof` |

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

**Results staging** (`gh_run_results`, migration 0014): the runner's results chunks as received, one row per job and
chunk (sent again: replaced), with `appliedAt` once applied to the run and `applyError` when not (yet).

**Usage event** (`ci_usage_events`, per-run billing): one per GitHub job that asked for `runs-on: fenvix`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `workspaceId` | string \| null | the installation's organization; null until it is linked, filled in by the link |
| `installationId`, `repositoryId` | number | GitHub ids |
| `repositoryFullName` | string | |
| `projectId`, `runId` | string \| null | the Project and the Run summary, when the organization is linked |
| `githubJobId` | number | unique: a job is billed once |
| `githubRunId`, `githubRunAttempt` | number | |
| `kind` | `"ci_run"` | |
| `quantity` | number | 1 |
| `billable` | boolean | see `reason` |
| `reason` | `"completed"` \| `"failed"` \| `"cancelled_after_start"` \| `"no_summary"` \| `"cancelled_before_tests"` | only `cancelled_before_tests` is not billable: the job never started on our machine, by GitHub's data (see Run units) |
| `planId` | string \| null | the organization's plan when the run ended |
| `conclusion` | string \| null | GitHub's conclusion of the job |
| `testMinutesRan`, `minutesSaved`, `otherStepMinutes` | number | as in the Run summary (from `summary.json`, bounded by the job's duration): shown, not billed |
| `heldMinutes` | number | the minutes the job held the fenvix machine, by GitHub's timings (`completed_at − started_at`): what run units count (migration 0015) |
| `baselineMinutes`, `units` | number | generated: `heldMinutes`, and `heldMinutes / 10` (see Run units) |
| `occurredAt` | time | when the job completed |
| `month` | date | first day of the month of `occurredAt` (UTC), generated |

The Usage record's `runsUsed` is the count of billable usage events of the month, `unitsUsed` their run units.

## What the runner sends

The runner is the fenvix machine's side (another repository): the GitHub Actions runner plus `runner/fenvix-run`, which
wraps the job's test command in the engine (`detpy` for Python/pytest, `detjs` for Node vitest/jest). It sends four
kinds of records to the App (`https://github.fenvix.dev/v1`, operations tagged `runner` in `openapi/fenvix-api.yaml`;
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
| `tests[]` | one per test of the run (`passed`, `failed`, `skipped_with_proof`; a test the framework skipped is not sent); `durationMs` (for a skipped test: the recorded one; stored at most the job's own duration, GitHub's timings); `failure` for a failed test: `kind` `flaky_defect` when the engine reproduced it as a defect (with the bundle's `defectFingerprint`), else `real`; `cacheKey` of a skipped test | Per-test outcome (`ci_test_results`); `failure.defectId` is found by the defect's test and fingerprint, `receiptId` by the receipt's test |
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
| `status` | `running` from the job's start; then `cancelled` if the job was; else `failed` when the summary has failures, flaky tests or a non-zero `exit`; else `passed` |
| `tests.total`, `tests.ran`, `tests.skippedWithProof` | `tests`, `ran`, `reused_with_proof` |
| `tests.failed`, `tests.flakyDefects` | `len(failed) + len(flaky)`, `len(flaky)` (the runner's `failed` holds only real failures; `flaky` = failed in the suite, passed alone) |
| `tests.passed` | `outcome_counts.passed − reused_with_proof` (tests that ran and passed) |
| `testTimeMs.ran`, `testTimeMs.skipped` | `test_seconds_run` × 1000, at most the job's duration (`durationMs`); `test_seconds_saved` × 1000 |
| `otherStepMinutes` | (job duration − `wall_seconds` of the test command, at most the job's duration) / 60 |
| `engineVersion` | the `detpy==X` (or `detjs@X`) entry of `runtime.dist_list` |
| `skipMisses` | `not_reused_reasons` |
| `mode` | the App's: the `FENVIX_MODE` it started the machine with (`gh_jobs.mode`), else the organization's when the job started (`shadow` during the trial). Never the results' or the summary's (review R-016 F4) |
| `region` | where the App placed the machine |
| `engineRunId`, `seed`, `missDetails`, `wouldSkipTests`, `wouldSaveMs`, `audit` | the results chunks |

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

## How records reach the dashboard

The runner sends the records above to the App; the App writes Postgres as the restricted role `fenvix_github_app`,
in transactions that name the organization (row level security keeps the others out): `ci_runs`, `ci_test_results`,
`ci_skip_receipts`, `ci_defects`, `ci_audit_reruns`, `ci_explorations`, `ci_usage_events` and its own `gh_*` tables.
The dashboard reads them only through the fenvix API (`openapi/fenvix-api.yaml`, role `fenvix_api`), never from the
database directly.

## Changes

- 2026-11-19 (review R-016b): **whether a job is billable comes from GitHub's data only**: a job that started on our
  machine is billed its held minutes whatever its summary and conclusion (`cancelled_before_tests` now means "never
  started on our machine").
- 2026-11-18 (review R-016, migration 0015): **run units from GitHub's job timings** (`held_minutes`; summary.json no
  longer sets what is billed); the **run's mode is the App's** (`FENVIX_MODE` recorded on the job; the results' and the
  summary's `mode` are ignored); test durations and `wouldSaveMs` bounded by the job's duration and the run's test time;
  **one trial per GitHub account**, none for an organization that already had an installation; the per-job credential
  names the **run attempt**; results limited to the job's own attempt, chunk numbers below `chunks`, 200 chunks and
  256 MB per job, deleted after 7 days; connecting GitHub is completed by the signed-in person through
  `POST /v1/github/installations/complete` (see "GitHub App records").
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
