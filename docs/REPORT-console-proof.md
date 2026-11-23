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
