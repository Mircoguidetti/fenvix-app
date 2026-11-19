DONE

# Report: review R-016b fixed (branch `claude/dashboard-wiring`)

Written 2026-11-19. Review R-016b (`claude/review-r016b`, `docs/REVIEW-R-016b.md`) found two defects left after the
R-016 fixes: G1 (High) and G2 (Medium). Both are fixed. The review's test file was copied unchanged:
`git diff origin/claude/review-r016b HEAD -- github-app/tests/integration/review-r016b.test.ts` is empty.

Each test failed before its fix and passes after it. This was checked commit by commit:

| Code under test | G1 | G2 |
| --- | --- | --- |
| Review branch (`97a9143`: `48ae9c1` plus the tests) | fail | fail |
| After the G1 commit (`246cc95`), G2 not applied | **pass** | fail |
| After the G2 commit (`0fc1b81`, HEAD) | pass | **pass** |

Each run used a fresh test database:
`node --test --test-concurrency=1 tests/integration/review-r016b.test.ts`.

## Findings: fix and test, before and after

| # | Severity | Finding | Fix | Test before (failure message) | After |
| --- | --- | --- | --- | --- | --- |
| G1 | High | Whether a job is billed depends on `summary.json` and on the conclusion `cancelled`, both of which the job controls | `service.publish`: `billable` = the job started on our machine, by GitHub's data (`runner_name` and `started_at` of the signed `workflow_job`). The summary and the conclusion now only name the `reason`. | fail: "a job that held our machine for 60 minutes … is not billed (reason cancelled_before_tests)" | pass (billable, `cancelled_after_start`, 60 held minutes) |
| G2 | Medium | One CI job's credential stores any number of explorations of up to 6 MB each, kept for good | `POST /v1/runner/explorations` refuses a per-job credential (one that names a run) with `403`. For every credential: at most one new exploration per project and UTC day, by the App's clock (new `ci_explorations.received_at`). Sending the same one again updates it. A project keeps its newest 90 nights. Staged summaries are deleted after 7 days, as staged results are. Migration `0016_review_r016b.sql` | fail: "one CI job's credential stored 30 explorations (answers: 202)" | pass (`403`, 0 stored) |

### G1: the rule now

- **What decides billing.** A job is billable only if GitHub's `workflow_job` shows it started on our machine. It is
  billed the minutes it held the machine, by GitHub's timings (unchanged since R-016 F3).
- **What the job's own data does.** The summary and the conclusion only set the reason:

  | Case | Reason |
  | --- | --- |
  | Job cancelled | `cancelled_after_start` |
  | No summary | `no_summary` |
  | Otherwise | `completed` or `failed` |

- **What is not billable.** Only a job that never started on our machine (`cancelled_before_tests`). It gets no run row.
- **The courtesy is gone.** The review allowed keeping "cancelled before its tests is free" if it was bounded by
  GitHub's timings. I left it out. Units are proportional to the held minutes, so a job cancelled seconds after its start
  is billed those seconds (under a minute is under 0.1 unit), so a threshold is not needed. If you want a free threshold, it would be
  one comparison on `held_minutes`.

### G2: what each runner endpoint may store now

| Endpoint | Bound |
| --- | --- |
| `results` | Unchanged from F7: the job's own attempt, 200 chunks and 256 MB per job, deleted after 7 days |
| `explorations` | None from a CI job's credential (`403`). One new exploration per project and UTC day, so at most 6 MB a night. 90 nights kept per project. The defects they found are kept |
| `summaries` | One row per job (runner, run, attempt), replaced when sent again. **New:** deleted after 7 days by the sweep |
| `progress` | Writes only in place on the job's running run row (unchanged) |

## Existing tests changed, and why

| Test | Change | Why |
| --- | --- | --- |
| `connect-flow.test.ts` step 14 | Job 81002 (started on our machine, cancelled, no summary) is now `billable: true`, reason `cancelled_after_start`. The run row is still marked `cancelled` | G1. The review named this test as one that had to change |
| `tests/helpers/harness.ts` | Applies 0016 to a test database that was prepared before it | G2, the new migration |
| `github-app/scripts/prepare-test-db.sh`, `supabase/tests/run-local.sh` | Apply 0016 twice, like 0014 and 0015 | G2. Each migration must be safe to repeat |

**New test.** `connect-flow.test.ts` step 15b checks three things:

- a CI job's credential gets `403`;
- a second, different exploration on the same day is dropped;
- a project with 90 nights loses its oldest one when a new night is stored.

No assertion was removed or loosened.

## Suites (run on HEAD `0fc1b81`, fresh test database, fresh local Supabase)

| Command | Result |
| --- | --- |
| `npm run api:lint` | `openapi/fenvix-api.yaml` valid |
| `npm run build` (`api:check`, `tsc`, `vite build`) | passes. `src/api/schema.d.ts` and `github-app/src/api/openapi.gen.ts` were regenerated because the explorations description changed |
| `npm run test:unit` (dashboard) | 59 / 59 |
| `npm run check` (mock) | behaviour **34 / 34**, organizations **10 / 10**, status colours **18 / 18**. Screenshots: all checks pass, 140 pictures |
| `node scripts/e2e-real-api.mjs` (local Supabase, real tokens) | **164 / 164** |
| `cd github-app && npm test` | Typecheck clean. Unit **95 / 95**. Integration **135 / 135**: the 132 earlier tests, the 2 R-016b tests and step 15b. Counted both combined, with the local Supabase up, and file by file. None skipped |
| `cd infra/github-app && npm test` | **56 / 56**, cdk-nag clean |
| `npm run test:rls` (scratch Postgres 16; 0014, 0015 and 0016 each applied twice) | API RLS OK, CI RLS OK, CI EXPLORE RLS OK, GH RLS OK |

**Environment.**

- Postgres 16 on port 54329, with `gh_test` and `fenvix_scratch` for `test:rls`.
- The local Supabase from `scripts/local-supabase/up.sh` (`supabase/postgres:15.8.1.085`, `supabase/gotrue:v2.186.0`,
  Docker). It applies 0014 to 0016 twice each.
- The screenshots that the check and the real-API pass regenerated were not committed.

## What changed where

The commits:

1. the review tests, copied unchanged;
2. G1;
3. G2.

The files:

- **G1:**
  - `github-app/src/service.ts` (`publish`);
  - `connect-flow.test.ts` step 14;
  - `docs/data-contract.md` ("Run units", the usage event's `reason`, Changes);
  - `docs/GITHUB-APP.md` (the billing rule).
- **G2:**
  - `supabase/migrations/0016_review_r016b.sql` (new; safe to run twice);
  - `github-app/src/app.ts` (the explorations route);
  - `github-app/src/service.ts` (`receiveExploration`, `EXPLORATION_KEEP_NIGHTS`, and the sweep deletes old summaries);
  - `openapi/fenvix-api.yaml`, plus the two regenerated files;
  - the test scripts and the harness;
  - `docs/data-contract.md` (exploration limits, Changes);
  - `docs/GITHUB-APP.md` (endpoints).

## Notes for the parallel session (`claude/warm-cache-install`)

- **Migration number.** `0016_review_r016b.sql` is new. If that branch adds its own `0016_*`, renumber one of them.
  This one only needs 0015 before it.
- **`receiveExploration`.** Its return type gains `"dropped"`. `/v1/runner/explorations` now answers `403` to a
  credential that names a run.
- **`publish`.** The billing rule is three lines. Nothing else in publishing changed.

## Open items (decisions, not missing code)

- **Where nightly explorations run.** A CI job's credential can no longer send them. They must come from a machine whose
  credential names only the repository: the always-on or demo machines, as the connect-flow test does. If the add-on
  later runs on per-job machines, those machines need their own credential kind, issued only for the exploration job.
  The review offered that as its first option.
- **The project setting `nightly_exploration`.** Intake does not check it, as before. Checking it would also refuse
  explorations from projects without the add-on.
- **Summaries from a repository-only credential.** Such a credential, held by the demo and always-on machines, can
  still send summaries for any run number of its repository. Each summary is one row, and is now deleted after 7 days.
  The number of rows within those 7 days is not limited. The per-job credentials that customers' CI jobs get are
  limited to one row per job.
- **From the review, not changed:**
  - the F1 admin check has not been run against real GitHub (it may need "Members: read");
  - the contract's sentence on bounding saved time;
  - a new trial per new GitHub organization;
  - queueing failure after a link;
  - R-016's carried items (one stage throttle, any work kind from the API Lambda, sessions not revoked, 0014
    irreversible, dead chart code).
