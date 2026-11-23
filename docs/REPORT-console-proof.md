DONE

# Console: parallel with proof, NOT PROVEN, and the audit fixes (F-001 to F-008)

Branch `claude/console-proof`, from `origin/claude/node-runner` @ 07dfac3. Not merged into main, not deployed.

## Commands (run 2026-11-23, local Postgres 16 on :54329 for the App's tests)

| Command | Base branch (07dfac3) | This branch |
| --- | --- | --- |
| `npm run api:check` | exit 0 | exit 0 ("schema.d.ts matches openapi/fenvix-api.yaml") |
| `npm run test:unit` | exit 0, 73 pass | exit 0, 80 pass, 0 fail |
| `cd github-app && npm test` | exit 0 (unit 151, integration 136) | exit 0 (typecheck clean; unit 168/168, integration 137/137) |
| `npm run check` | exit 0 (checks 42, orgs 10, status colours 18, screenshots 140) | exit 0 (checks 60/60, orgs 10/10, status colours 18/18, screenshots: all checks passed, 170 pictures) |

Not run here, on both branches: the two integration suites that need a local Supabase in Docker
(`dashboard API: every operation…` and `…the shared cache…`) are skipped by their own guard ("no local Supabase"), as
on the base branch. I updated them (below) but could not run them. Also run: `TEST_DATABASE_URL=… bash supabase/tests/run-local.sh`
(migrations 0001–0019, 0014–0019 twice, all RLS checks and the new `run-proof-check.sql`): all OK.

## Per step

1. **Contract** — `openapi/fenvix-api.yaml`, `src/api/schema.d.ts` (`npm run api:generate`), `github-app/src/api/openapi.gen.ts`,
   `docs/data-contract.md` (Run summary table, per-test outcome, section 3 mapping, new "Parallel with proof" section, Changes):
   `RunStatus`/`TestOutcome` + `not_proven`; `RunProof` and `Run.proof`; `RunTests.notProven`; `TestResult.notProvenCause`
   and `RunnerTestOutcome.notProvenCause`; `ActivityItem.kind` + `run_not_proven`; tests list `counts.not_proven` and
   `outcome=not_proven`; runs list `status=not_proven`; Overview `proof {runsWithProof, provenIdentical, notProven}`;
   `GET /search?q=` + `SearchResult`. N rule and "runner does not send proof yet" documented in Changes.
2. **Server and database** — `supabase/migrations/0019_run_proof.sql` (proof, tests_not_proven, exit_code, status and
   outcome checks, not_proven_cause); `github-app/src/results/summary.ts` (`proof`, `notProven` = N, `proofRecord`),
   `status.ts` (new `runStatus`), `render.ts` (`conclusionOf` failure when N > 0; title "N not proven"; a table row),
   `runner-records.ts`, `apply.ts` (cause stored), `service.ts` (`runFields` uses `runStatus`; passed − N; insert/finish
   columns), `api/data.ts` (filters, counts, `search`), `api/server.ts`, `api/shared.js|.d.ts`; `src/data/ci.ts`,
   `ci-rows.ts` (shared mappers/calculations: `finished`, activity kind, Overview block, `searchFrom`). Every
   `passed || failed` comparison listed in the spec now includes `not_proven` (data.ts 161/180/235, ci.ts `finished` and
   `activityFrom`, Project.tsx, ProjectSections.tsx, mock.ts); time to green still counts `passed` only.
   Tests: `github-app/tests/unit/status.test.ts` (runStatus 6 cases + non-zero exit; `node-mocha-verify-failed` → N=1,
   `not_proven`, conclusion failure, title "1 not proven"; proof present/absent/malformed; a results chunk with
   `not_proven` and its cause); `tests/integration/results.test.ts` (published fixture → `ci_runs.status = not_proven`,
   tests_not_proven 1, passed 4, check run failure; a proof block stored as RunProof).
3. **Mock** — `src/data/mock.ts`: homehub's last 30 days mostly parallel with proof (all proven, some re-run in one lane),
   ~1 in 4 serial; three `not_proven` runs among the newest 10, never the newest: #4298 (proof, 14 × "file read outside the
   project", exit 1), #4296 (proof, 3 × "environment variable read outside any test", exit 0), #4294 (N = 2, proof null,
   no cause, per-test rows). Overview block, `search`, own filter fixed. `src/data/api.ts`, `client.ts`, `types.ts`.
4. **Run page card** — `src/pages/Run.tsx` (`ProofCard`, `notProvenSentence`, callout under KPIs when proof is null).
5. **NOT PROVEN state** — `src/components/StateBadge.tsx` (`RunStatusPill count`, amber, `ShieldQuestion`),
   `src/components/ci.tsx` (`OutcomePill` not_proven, cause as tooltip and a line under the test), tests filter
   (Run.tsx), runs filter (Project.tsx), Projects list pill count (`ProjectRow.lastRunNotProven`), `docs/status-colors.md`.
6. **Project page "Parallel with proof"** — `src/pages/ProjectSections.tsx` (`ParallelWithProofPage`), `src/data/ci.ts`
   (`parallelProofFrom`, `notProvenCausesOf`), `src/components/Shell.tsx` (section after Runs, `ShieldCheck`),
   `src/App.tsx` (route), `charts.tsx` (`CostLineChart` takes line names).
7. **Overview KPI** — `src/pages/Overview.tsx` ("Proven identical", after Runs).
8. **F-001** — `Project.tsx`: `PageHeader … title="Runs"`, hidden h1 and LatestRun kicker/h2 removed, "Latest run · #N"
   line with pill, "Copy replay command" removed, running banner kept.
9. **F-003** — `PageHeader.tsx` sets `document.title` (one place; `docTitle` override for Overview and a defect).
10. **F-004** — `Shell.tsx` `JumpSearch`: `/search` from 2 characters, debounced 200 ms; "Run" / "Defect" rows naming the project.
11. **F-005** — drawer back link removed (`Shell.tsx`).
12. **F-006** — `.card h2, .card-head h2` 17 px / 600.
13. **F-007** — `src/components/Skeleton.tsx`; run, project (+ its sections' new page) and overview loading states.
14. **F-008** — `timeToGreenPerDay` (ci.ts), card "Time to green, per day", `BeforeWithChart` `data-points`.
15. **Checks** — `scripts/checks.mjs` (9 new checks × 2 viewports), `scripts/lib.mjs` (`proofRuns`), `scripts/screenshots.mjs`
    (8 new screens), `tests/unit/proof.test.ts` (7 tests).

## Deviations from the spec (decided, please review)

- **`Run.exitCode` and `ci_runs.exit_code`** (not in the spec's field list): the callout must say "the run exits 1" only
  when the summary's `exit` ≠ 0, and the Run record carried no exit code.
- **`ProjectRow.lastRunNotProven`**: the projects list's pill must always show the count (rule 2).
- **`src/styles.css`**: besides F-006 and the skeleton rules, three grid lines (`.kpis-7`) so the seventh Overview tile
  ("242 of 244 runs") fits: it spans two columns, 4 columns on wide screens. No token, font, radius or spacing value changed.
- The tab title of the Overview is "Overview · fenvix" (its header title is the organization's name).

## Changes to tests, checks and test helpers (each with its reason)

- `tests/unit/status-colors.test.ts`: the two assertions quoting `RunStatusPill`'s tone expression and its use in
  `Project.tsx` now quote the new code (`… running || not_proven ? "warn" …`, `count={r.tests.notProven}`). Same strength.
- `scripts/checks.mjs` "sign in and out", "overview", "projects, a project…": waited for the hidden h1
  "northwind/homehub: runs" that F-001 removes → now the h1 "Runs" (and the kicker); "overview" expects 7 tiles with
  "Proven identical" second (the other six are checked as before).
- `github-app/tests/integration/dashboard-contract.test.ts`: the exact `run.tests` object gains `notProven: 0`; asserts
  `proof` null and `exitCode` 1 (contract change).
- `github-app/tests/integration/api-dashboard.test.ts` (skipped here, needs Docker Supabase): `counts` gains
  `not_proven: 0`, operation count 42 → 43, new `search` test. **Not run.**
- `github-app/tests/integration/results.test.ts`: new test added (no existing assertion changed).
- `github-app/scripts/prepare-test-db.sh` and `tests/helpers/harness.ts`: also apply 0018 and 0019 (0018 was missing there;
  0019 is needed by the App's new columns). `supabase/tests/run-local.sh`: 0019 twice and `run-proof-check.sql`.
- No test or check was skipped, removed or weakened.

## Screenshots (`npm run check` writes them to `docs/screenshots/`, git-ignored, so not in the commit)

Each as `<name>-1440-light.png`, `<name>-1440-dark.png`, `<name>-390-light.png`, `<name>-390-dark.png`:
`run-proven` (card, all proven), `run-not-proven` (card + note), `run-not-proven-tests` (Not proven filter, test pills),
`run-not-proven-no-proof` (note without card, "The runner did not report why"), `run` (serial run, no card),
`project-runs` (title "Runs", latest-run line, time to green per day), `project-runs-not-proven` (runs filter),
`parallel-with-proof`, `parallel-with-proof-empty`, `overview` (Proven identical), `drawer` (390 only, one "All projects"),
`search` (1440 only). All other screens are regenerated too (card headings 17 px everywhere).

## Not claimed

- The runner does not send `proof` yet (engine task): real runs show no proof card; real Node runs with a non-zero
  `not_proven` or a diverged verify get the `not_proven` status, the amber pill and a failed check on GitHub.
- The proof card, filters and Overview block are proven on fixtures and the mock only, not on real data.

## Review fixes (coordinator's /review, 2026-11-23, decision D1 A)

`origin/main` (ccc1170) merged into the branch first (merge 1df9f9f, no conflict).

### Commands after the fixes (run 2026-11-23, Postgres 16 on :54329)

| Command | Result |
| --- | --- |
| `npm run api:check` | exit 0, "schema.d.ts matches openapi/fenvix-api.yaml" |
| `npm run test:unit` | exit 0, 82 pass, 0 fail |
| `cd github-app && npm test` | exit 0; typecheck clean; unit 171/171; integration 138/138 (the two local-Supabase suites skip themselves, as on main) |
| `cd deploy && npm test` | exit 0; 88 tests, 87 pass, 0 fail, 1 skipped ("detects the newest migration" on the local Supabase: none here) |
| `npm run check` | exit 0; checks 64/64, organizations 10/10, status colours 18/18, screenshots: all checks passed, 170 pictures |

I could not start the local Supabase (Docker), so `api-dashboard.test.ts` and the deploy test on the local Supabase were not run.

### Per item

1. **Migration probe**: `deploy/lib/migrate.mjs` has a "0019" probe (first: column `ci_runs.proof`; last:
   `ci_test_results_outcome_check` contains 'not_proven'); `deploy/test/pipeline-2.test.mjs` gets the case "0019 cut before
   its last statement". (`scripts/local-supabase/up.sh` already applies `00{14..99}`, so 0019 is in it.) Test: `cd deploy && npm test` as above.
2. **Rollout compatibility**: new `src/data/compat.ts`: every client is wrapped (`src/data/index.ts`), so missing `proof`,
   `exitCode`, `tests.notProven`, Overview `proof`, `counts.not_proven` and `lastRunNotProven` read as null or 0; a 404/405
   from `/search` gives no results (other errors still throw). Loose checks in the screens too (`!= null`,
   `o.proof?.… ?? 0`, `counts.not_proven ?? 0`; `src/data/ci.ts`, `Run.tsx`, `Overview.tsx`). The mock can answer as the API
   did before (`sessionStorage["fenvix-mock-api"] = "before-proof"`). Tests: the behaviour check "an API one release older
   …: the Overview and Parallel with proof still render" (both viewports); unit test "an API one release older" (`tests/unit/proof.test.ts`).
3. **Verify fails closed**: `notProvenOf` (`github-app/src/results/summary.ts`): any `verify_status` other than "identical",
   or none with a non-zero `verify_exit`, gives N = max(1, not_proven + diverged + missing + wrong_reuse). Unit cases:
   "not_proven" (with and without counts), null + verify_exit 2, absent + verify_exit 2, null + exit 0 (0), wrong_reuse 3,
   an unknown status, "identical" with wrong_reuse (stays 0).
4. **Proof never hides tests**: N = max(proof.not_proven, top-level not_proven, the verify count), and max(N, ran − proven)
   when proof.proven + proof.not_proven ≠ ran. The card shows "n of {run.tests.ran}" and uses the run's N. Unit cases for both.
5. **Malformed proof**: `parseProof` returns null on any invalid field and never throws, so the summary is kept and N comes
   from the other sources. Unit cases: a list, rerun_one_lane null, order_digest "", a 501-character cause, parallel_seconds
   null, workers −1, an empty cause; each one is still `not_proven` with top-level not_proven 4.
6. **Regression tests**: `status.test.ts` "tests not proven with exit 1 … not_proven" (with proof, and top-level not_proven 2
   without proof); `results.test.ts` "a results chunk with not_proven tests, with and without a cause, is stored through
   apply.ts" (passes); `api-dashboard.test.ts` "a not-proven run (console proof): …" (runs filter, activity
   `run_not_proven`, skip-share series +1, tests filter with `counts.not_proven`, order). It inserts into organization B and
   deletes after, so the other assertions keep their seeded counts. **Not run here (needs Docker).**
7. **One N**: `service.ts` stores `s.notProven` itself (no `min(N, ran)`); `passed` is reduced by it (floor 0).
8. **/search**: defects `limit 20` in SQL (`defects()` takes a limit); minimum 2 characters (`SEARCH_MIN`, also
   `minLength: 2` in the OpenAPI); commit prefix `commit_sha like $n || '%'`.
9. **proofOverview** uses `finished()`; unit: a cancelled run with a proof is not counted.
10. **Proof card "See the N tests"** shows only when per-test `not_proven` rows exist (the same probe as the no-proof callout).
11. **Unknown statuses**: `RunStatusPill` and `OutcomePill` show a grey "Unknown" for a value they do not know.
12. **Migration 0019**: `set local lock_timeout = '5s'` at the top; the rollback path written in its comment.
13. **Small fixes**: `proof.test.ts` asserts `skipShare` (median 0.3 with the not-proven runs, 0.2 without); search cap is
    exactly 20 and newest first, and one character finds nothing; `notProvenSentence` moved to `src/data/ci.ts` with a unit
    test (exit 0, 1 and 2, both causes, the largest of two, an unknown cause, no cause, n = 1); `checks.mjs` asserts
    `npOnlyCommits > 0` and the outcome pill's `data-tone` "warn"; new check "overview: no parallel run yet reads '–' and
    'no parallel runs yet'" (Harbor); the contract's `tests[]` row names `not_proven` and `notProvenCause`, and the N section
    and Changes describe the fail-closed rule; the stale "unchanged from main" comment is removed.

### Changed tests (each with its reason)

- `github-app/tests/unit/status.test.ts`: "proof.not_proven wins over the top-level not_proven and the verify counts" became
  "with a proof: the largest of …" (expected N 3 → 9 and 15 for those inputs), because item 4 changes the rule. "a malformed
  proof is refused" (expected a throw) became "a malformed proof never discards the summary", because item 5 changes the
  behaviour. All other cases were added, none removed.
- `tests/unit/proof.test.ts`: fixture runs get distinct `skipShare` values (so the median assertion can fail); the search cap
  assertion is now `=== 20` with ordering. Before, it searched for "7", which is below the new 2-character minimum.
- `scripts/checks.mjs` "an API one release older": expects either the empty state or the runs table. The old-shape mock still
  holds `not_proven` statuses, which an older API would never send.
- No test or check was skipped, removed or weakened.

### Process note

This container had been reset between the two tasks: the checkout was on `claude/node-runner`, and `git merge origin/main`
first fast-forwarded that local branch. I reset it to `origin/claude/node-runner` (nothing was pushed) and merged into
`claude/console-proof` as asked.

## Review fixes 2 (coordinator's second /review at 6056820, decision D1 A)

The principle behind all of these: when we are not sure, the run is never green; and a run is never red for something
the runner did not report as unproven.

### Commands (run 2026-11-23 on 3c008b7, Postgres 16 on :54329)

| Command | Result |
| --- | --- |
| `npm run api:check` | exit 0, "schema.d.ts matches openapi/fenvix-api.yaml" |
| `npm run test:unit` | exit 0, 86 pass, 0 fail |
| `cd github-app && npm test` | exit 0; typecheck clean; unit 175/175; integration 142/142 (the two local-Supabase suites skip themselves) |
| `cd deploy && npm test` | exit 0; 88 tests, 87 pass, 0 fail, 1 skipped (local Supabase) |
| `npm run check` | exit 0; checks 66/66, organizations 10/10, status colours 18/18, screenshots: all checks passed, 170 pictures |

Also run: `supabase/tests/run-local.sh` (migrations 0014–0019 twice, all RLS checks, `run-proof-check.sql`): all OK.
Not run (needs Docker): `api-dashboard.test.ts` (its new search-cap and one-character tests) and the deploy test on the local Supabase.

### Per item

1. **Malformed proof**: `notProvenOf` (`github-app/src/results/summary.ts`) treats a `proof` that is present but unreadable as
   N ≥ max(1, its readable `not_proven`, ranExecuted − its readable `proven`), with reason "the proof of the parallel run
   could not be read". Unit test "a malformed proof with no other signal …" covers `{}`, `true`, order_digest "",
   parallel_seconds null, rerun_one_lane null and a 501-character cause, each with verify absent and with verify "identical".
   All are `not_proven` with conclusion failure.
2. **Unreadable summary**: `service.ts` `publish` logs the error and stores `not_proven`, N 1, reason "the runner's summary
   could not be read". `runStatus` and `conclusionOf` take `summaryUnreadable` (conclusion failure; its own title and
   comment). With no summary at all, the old rule still applies. Unit and integration tests: a stored summary with
   reused + ran ≠ tests and job success → not_proven, check run failure. The intake already refuses such a summary
   (422), so the test stores it directly, as one accepted earlier.
3. **Proven over time** (`src/data/ci.ts` `parallelProofFrom`): (ranExecuted − N) / ranExecuted per run, N = max(run's,
   proof's); 0 when nothing is proven; runs that ran nothing are left out. Unit: proven 95, not_proven 0, ran 100,
   N 5 → 0.95.
4. **Per-test rows raise the run**: `service.ts` `reconcileNotProven` runs after each application of chunks:
   tests_not_proven = greatest(stored, rows), passed lowered, a `passed` run becomes `not_proven`. `publish` counts the
   rows for its check run. Late chunks re-publish through `publish` (same check run, one usage event). Integration tests
   cover both orders: rows before the summary → not_proven, check failure "2 not proven"; rows after publication →
   passed becomes not_proven, the check run is updated in place to failure, billed once.
5. **ranExecuted** = ran − `outcome_counts.skipped`. It is used in the proof-coverage rule, stored in the proof
   (`RunProof.ranExecuted`, null for older rows), and shown in the card as "Proven n of ranExecuted". Documented.
   Unit: the node-jest-cold-0-reused shape (ran 5, 1 skipped) with proof 4 + 0 → passed.
6. **Contradictory verify**: the verify counts always count, and a non-zero (or non-numeric) `verify_exit` is a failed
   verify whatever `verify_status` says. Only "identical" with all-zero counts and exit 0 keeps N at 0.
7. **No double count**: verify N = not_proven + max(diverged, wrong_reuse) + missing. `input_differs` alone → N 1 with
   reason "inputs differ". The console says "The parallel and serial runs could not be compared: their inputs differ."
   (no "1 test"). Unit tests for both.
8. **Missing or invalid `exit`**: `RunSummary.exit` is null, giving N ≥ 1 with reason "exit code missing" →
   `not_proven`, conclusion failure. Unit: undefined, null, "0", 1.5.
9. **One predicate**: `isNotProven` (`src/data/ci.ts`, status not_proven or tests.notProven > 0) is used by the Overview
   block and the Parallel with proof page. Unit: a failed run with 3 not proven counts on both.
10. **Filter counts**: the tests list gains `rowCounts` (per-test rows per outcome; `counts` stays the run's own). The
    filters show row counts. When they differ, a line says "N not proven, M with per-test detail" (same for passed).
    The mock's #4296 sends its proof but no per-test rows. Checks: the filter reads 0 and the line reads
    "3 not proven, 0 with per-test detail".
11. **Older API filters**: `compat.ts` turns a 400 on `status`/`outcome` = not_proven into an empty page (other errors
    still throw). The old-API mock refuses those filters, and the compat check opens both filters (runs list and tests)
    and asserts "No runs match." and "No test matches.", with no error.
12. **Migration 0019**: the rollback comment now reads as given, and `set local statement_timeout = '60s'` sits next
    to the lock timeout. Also new in 0019: the column `not_proven_reason` (≤ 200 characters). This is safe to change
    because 0019 has not been deployed; its probes (first: `proof`; last: the outcome check) are unchanged.
13. **Tests for earlier fixes**:
    - One N: integration "nothing ran and verify crashed" → not_proven, tests_not_proven 1.
    - The proof card's "Proven n of ranExecuted" and its Not proven = the run's N: check.
    - No "See the N tests" on a proof run with N > 0 and no rows: check.
    - "Unknown" pill for an unknown status and outcome (text and `data-tone` neutral): check on the styleguide, which
      now shows both.
    - `/search` at the API: more than 20 matching open defects → exactly 20, newest first; one character → `[]`
      (api-dashboard, not run). Because of this I put the OpenAPI `minLength` back to 1, since 2 would answer 400; the
      handler returns `[]` below 2 characters.
    - The compat search check now always calls the search through the client (no visibility condition).
14. **docs/data-contract.md**: the N section is rewritten to the fail-closed rule (with ranExecuted, the unreadable
    summary, per-test rows, reasons). The malformed-proof sentence is corrected, and the Changes entry covers both review rounds.

### Changed tests (each with its reason)

- `github-app/tests/unit/status.test.ts`:
  - "verify fails closed": the case "identical + wrong_reuse 3 → 0" is now "→ 3, not_proven" (item 6, as asked).
  - "without proof": "identical with verify_counts.not_proven 4 → 0" is now "→ 4" (item 6: the counts always count).
  - "a malformed proof never discards the summary": the "a list" case now expects N 374 (ranExecuted − 0 readable
    proven; item 1) instead of 4.
  - `proofRecord` now takes ranExecuted, and the expected record includes `ranExecuted: 374`.
- `github-app/tests/integration/results.test.ts`, "a test not proven …": the proof in its second summary was
  inconsistent (50 proven for 10 tests that ran). It is now 4 proven + 6 not proven, and the expected record includes
  `ranExecuted: 10`.
- `tests/unit/proof.test.ts`, "rows: proof and exit code only once finished": the mapped proof now includes
  `ranExecuted: null` for a row stored without it.
- `scripts/checks.mjs`, "an API one release older": the search part now runs on every screen size through the client
  (no `isVisible` condition); it also covers the two filters.
- `github-app/tests/helpers/harness.ts`: its migration probe now looks for the newest 0019 column (`not_proven_reason`).
- Nothing was skipped, removed or weakened.

### Accepted risk (founder, D1 A)

A browser tab still holding the old console from before the deploy shows a `not_proven` test as "Skipped with proof"
(its outcome pill fell through to that branch) until the tab is reloaded. There are no customers today.
