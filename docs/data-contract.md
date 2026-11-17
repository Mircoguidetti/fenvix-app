# Data contract: runner → dashboard

Written 2026-11-17. This is **our** contract between the fenvix runner (the machines behind `runs-on: fenvix`, which
run the engine) and the customer dashboard. It is not the engine's internal file format: the runner reads the engine's
files and sends these records. The dashboard, the Supabase tables (`supabase/migrations/0011_ci_runs.sql`), the mock
(`src/data/mock.ts`) and the TypeScript types (`src/data/types.ts`) all follow it.

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
| `githubAccount` | string \| null | the GitHub user or organization the fenvix GitHub App is installed on |

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

One test job that ran on `runs-on: fenvix`. Sent by the runner when the job ends (and once when it starts, with
`status: "running"`).

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
| `minutesSaved` | number | `testTimeMs.skipped / 60000` |
| `githubEquivalentMinutes` | number | what the job would have taken on a GitHub-hosted runner without fenvix: the project's `baseline.medianJobMinutes` (an estimate) |
| `engineVersion` | string | `detpy` field of a bundle, e.g. `0.1.0` |
| `seed` | number \| null | `--det-seed` the run used; null for collection order (`"fixed"`) |

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
| `runtime` | `{ digest, python, system, machine, libc, distributions }` | the runtime identity (`runtime` digests `{python, cache_tag, executable, libpython, system, machine, libc, stdlib, distributions, n_distributions}`) |
| `config` | `{ digest, pytest, detpy, inifile, options }` | the configuration identity (`config` digests the pytest and Level 0 settings) |
| `changedFilesProven` | number | `n_changed_files_proven`: files changed since the reused run that were proven irrelevant |

Gap today: `receipts.jsonl` carries only the counts; the lists exist in `proof-cache.json`. The runner must send
them, or the engine must add them to the receipt. A test that is not reused has `{"reused": false, "why": "<kind>:
<detail>"}` (kinds `new`, `failed-before`, `config`, `runtime`, `clock`, `env`, `data`, `code`); the dashboard does not
show non-reuse reasons yet.

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
| `language` | `"python"` \| `"node"` | |
| `replayCommand` | string | built by the dashboard, see below |

**Replay command.** Python: `pytest --det --det-seed=S --det-order=<bundle>/order.txt` (no `--det-seed` when the seed
is null), after `fenvix defects pull <id>` writes the bundle to `<bundle>`. Node: the engine has no `--det-order`,
minimiser or bundle yet (branch `claude/node-l0`), so the command is the seed only:
`detjs vitest run --det --det-seed=S` (or `detjs jest --det --det-seed=S`), and the dashboard says that the order is
not replayed. The engine's own `detpy replay <bundle>` works as well and is shown next to it.

## Usage

Computed from runs, not sent by the runner.

| Field | Type | Notes |
| --- | --- | --- |
| `month` | `YYYY-MM` | |
| `runsUsed`, `runsIncluded` | number, number \| null | `runsIncluded` from the plan; null = no limit set |
| per project: `runs`, `minutesSaved`, `testMinutesRan`, `githubEquivalentMinutes`, `githubEquivalentUsd` | number | |
| `githubRate` | `{ usdPerMinute, runner, source, checkedOn }` | the GitHub-hosted price the comparison uses |

`githubEquivalentUsd = githubEquivalentMinutes × githubRate.usdPerMinute`. The rate is stored in
`public.ci_reference_rates`; today `0.008` USD per minute for a Linux 2-core GitHub-hosted runner, DECLARED by GitHub's
Actions pricing page as quoted in fenvix-brain-cli `PRODUCT.md`, **to verify** before it is shown to a customer.

## Plan

Monthly plans by number of runs, sized by project.

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `name`, `description` | string | |
| `runsPerMonth` | number \| null | null = no limit |
| `maxProjects` | number \| null | null = no limit |
| `priceUsdMonth` | number \| null | **null today: prices are not set** (the founder sets them after the pricing study) |
| `features` | string[] | |

## How records reach the dashboard (not built yet)

The runner will post each run, its test outcomes, receipts and new bundles to the control plane
(`POST /v1/runs`, `PUT /v1/runs/{id}/results`, `POST /v1/defects`), authenticated by the GitHub App installation, and
the control plane writes the tables above with the `fenvix_control_plane` role. Until then the dashboard reads the
tables directly through Supabase (row level security) or uses the mock.

## Changes

- 2026-11-17: first version.
