NOT DONE

# Report: proof to the customer (console follow-ups, honest proof words, the Node runner sends `summary.proof`, one end-to-end test)

Branches: fenvix-app `claude/proof-followups` (from main `906d52b`), fenvix-engine-cli `claude/runner-proof` (from
`claude/release-1` `f67be4a3`). Nothing merged, nothing deployed, `engineCliCommit` unchanged (`f67be4a3`).

| Repo | Branch | Commits |
|---|---|---|
| fenvix-app | `claude/proof-followups` | `b031b6c` Part A, `a4b175b` Part C, then this report |
| fenvix-engine-cli | `claude/runner-proof` | `162aa55` Part B (B1, B2, B3 fixture) |

The engine branch is **not rebased** onto `claude/release-1` after `claude/p0-big-trace`: the coordinator has not said
it merged. B1 touches only `accountRerun`'s cause/`tests` and one `meta.hazard_rerun.tests` line in
`node/src/parallel-rerun.js` (plus one stderr line that prints the cause), so the rebase should be small.

## 1. Changed tests, validators, CI steps and test infrastructure (each with its reason)

App (fenvix-app):

- `github-app/tests/unit/status.test.ts:62` (render test): expects `| Not proven | 1 |`, was `| Not proven identical to the serial run | 1 |`. Reason: A2 row label. This is the only existing render/PR-comment test whose expected text changed.
- `github-app/tests/unit/status.test.ts` ("a malformed proof with no other signal ... is still not proven"): `assert.ok(N >= 1)` became the exact N (374 for a proof `{}` or `true`, 1 for the others). Reason: A1.6 "exact N in every malformed-proof case" (stronger).
- `github-app/tests/integration/results.test.ts:295`: reason text `"the comparison of two runs failed"`, was `"the check against the serial run failed"`. Reason: A2 rename of `NOT_PROVEN_REASONS.verifyFailed`.
- `github-app/tests/integration/results.test.ts` ("a summary that came but cannot be read"): waits for the background work (`idle()`), then stores the old summary with `on conflict ... do update` instead of a plain insert. Reason: A1.2 makes the 422 store a rejected row first, so the plain insert would hit the unique key. The test's assertions are unchanged.
- `github-app/tests/integration/queue.test.ts` ("runner summary and completed job"): "refused requests queue nothing" split into "an unauthorized request queues nothing" (401, still 0) and "a 422 queues one summary_rejected item" (1, kind checked); the final message count 3 became 4. Reason: A1.2 (intended new behaviour).
- `github-app/tests/integration/api-dashboard.test.ts` ("one run: tests ..."): two `rowCounts` assertions added. Reason: A1.6 (stronger).
- `tests/unit/proof.test.ts`: the expected sentences of two tests ("the sentence about tests not proven ..." and "the sentence for a run's own reason ...") use the A2 words ("a conflict between parallel lanes could not be ruled out", "Their result from the one-lane re-run is reported", "were not proven", "The two runs could not be compared"). Reason: A2.
- `scripts/checks.mjs` (browser checks against the mock): expected words updated to A2 (card description = the customer sentence, result "Proven: no conflict between lanes", the note and per-test line, KPI label "Proven", KPI sub-line now prefixed "no conflict between parallel lanes · " in three places, the KPI label list); the check name "overview: Proven identical, ..." became "overview: Proven, ...". **Added** assertions for A1.6 on the run with a proof and no per-test rows (`ranExecuted < ran`, the card's Proven = `proven of ranExecuted`, Not proven = the run's N 3 above the proof's 2). Reason: A2, A1.6.
- `src/data/mock.ts`: the mock's environment-variable not-proven run now has a proof with `ranExecuted = ran − 1` and `proof.notProven` 2 under the run's N 3 (one test no cause explains). Reason: A1.6 mock gap. All 66 checks still pass.
- `deploy/test/pipeline-2.test.mjs`: 0020 added to the cut cases; a new probe test. Reason: A1.7.
- `github-app/tests/helpers/harness.ts`: applies 0020 to a test database prepared before it (as for 0015 to 0019). Reason: A1.7 test infrastructure.
- `github-app/scripts/prepare-test-db.sh`, `supabase/tests/run-local.sh`: apply 0020 twice; header comments "0014 to 0020". Reason: A1.7.

Engine (fenvix-engine-cli):

- `node/test/parallel-rerun-account.test.js:34,51`: the `deepEqual` on `notProvenFiles` expects `cause: "a.test.js: the one-lane re-run ran 0 of its 2 test(s)"` / `"... ran 1 of its 3 test(s)"` and `tests` 2 / 2 (were `"it ran 0 of its 2 test(s)"` / `"it ran 1 of its 3 test(s)"`, no `tests`). Reason: B1.
- `node/test/parallel-rerun-account.test.js:43`: `every(cause === 'its trace is missing')` became a `deepEqual` on `["a.test.js: the one-lane re-run left no trace", "b.test.js: ..."]` plus `tests` `[1, 1]`. Reason: B1 (see deviation 1).
- `node/test/parallel-p041.test.js` ("vitest named project"): one assertion added, `hr.tests` equals the re-run's reported test count (2). Reason: B1 "assert `hazard_rerun.tests` through a `main` test".

Nothing was removed, skipped or loosened; no timeout, tolerance, snapshot or suppression changed; no CI workflow changed.

## 2. Deviations from the brief (decided here, for review)

1. **B1 cause wording.** The brief's form `"<file>: the one-lane re-run <old cause>"` gives "the one-lane re-run it ran 0 of ..." and "the one-lane re-run its trace is missing". The old causes were reworded so the sentence reads: `"<file>: the one-lane re-run ran N of its M test(s)"` (as the App's synthetic fixture in the brief expects) and `"<file>: the one-lane re-run left no trace"`. The engine's stderr line now prints that cause.
2. **B2 fail-closed list, two additions.** A `hazard_rerun.not_proven` that is not a list, and an entry whose `cause` is not a non-empty string, also fail closed (`proof incomplete: hazard_rerun.not_proven[].cause`): the App refuses a proof with an empty cause, so sending one would turn a parallel run into "proof unreadable" anyway.
3. **B2 `workers`.** `workers` an integer ≤ 1 means a run in one lane: no proof, no NOT PROVEN (the engine writes `meta.parallel.workers: 1` for serial runs). `workers` missing or not an integer while `meta.parallel` exists and tests ran fails closed.
4. **B2 `provable_absent` of an unexpected type** is written as its JSON text (so it still fires) rather than dropped.
5. **Synthetic fixture "−2".** Read as "lowered by 2": `proof.proven` 4 → 2 and `status.passed` 4 → 2 (a proof with a negative `proven` is refused by the App's `parseProof`, which would test "proof unreadable", not the brief's step 11).
6. **A1.4 "finishRun never lowers a not_proven status".** Besides the `live_n` rule, `finishRun` keeps `not_proven` when the row is already `not_proven` and the new status is `passed`. `insertRun` applies the same expressions through one shared update right after the insert (`raiseToLiveRows`); a new row has no per-test rows yet, so it changes nothing today.
7. **A1.3/A2 reasons kept.** When the proof is above `ranExecuted`, or a count is malformed, or either engine signal fires, the run-level reason is kept even when the proof's causes cover N (no test cause explains a run-level problem).
8. **KPI help text** is shown as the label's tooltip and as the start of the KPI's sub-line ("no conflict between parallel lanes · 3 not proven this month"), on the Overview and on the project's Parallel with proof page.
9. **e2e API reads** need the local Supabase (a real Auth token). With it (as in CI and in this session) steps 9-11 read the run through `GET /runs/{runId}`; without it they still assert the run row and the check run and say "no local Supabase: the API read was not made" in the test's diagnostics. The API is started on the App's own scratch database (`fenvix_api` role), and the Supabase user is added to the e2e organization there.

## 3. Acceptance criteria

### 1. A1 items closed, A2 words replaced

| Item | What changed | Test (protects / fails_when / no_claim in each test's comment) |
|---|---|---|
| A1.1 no summary + per-test rows | `runStatus`, `conclusionOf`, `title`, `checkRunOutput`, `prComment` take the rows; `publish` counts rows with or without a summary, reconciles the run with its rows at the end of every publish (`reconcileNotProven` under a row lock), passes them to `runFields` | unit `proof-followups.test.ts` "A1.1 ..."; integration `results.test.ts` "A1.1 no summary, per-test not_proven rows ..." (fails on 906d52b: verified by running it with the old `src/`) |
| A1.2 summary rejected at intake | route still answers 422 and enqueues `summary_rejected`; `receiveSummary` upserts the rejection (`where gh_run_summaries.summary is null`); a valid summary clears it; `publish` treats a null summary as unreadable with the stored reason | integration "A1.2 a summary refused at intake ..." and "A1.2 a later valid summary replaces a rejection ..."; unit "A1.2 the summary_rejected work item" (both integration tests fail on 906d52b) |
| A1.3 ranExecuted on warm runs | `trimSummary` writes `skipped_ran`; `parseSummary` uses it; a proof above `ranExecuted` is N ≥ 1 with "the proof does not match the tests that ran" | unit "A1.3 ..." (3 tests) and "the runner's real proof summaries" (the real warm fixture). The item 3 test's report line: it shows a warm run (3 reused, one of them skipped; 2 ran, one skipped) whose stored summary gives `ranExecuted` 1 and passes, while the same summary without `skipped_ran` gives `ranExecuted` 0 and is not proven with `proofShort` |
| A1.4 race | `finishRun`: `select ... for update` on the run row, then the UPDATE with `live_n` (`greatest($n, live_n)`, status, passed); `insertRun` the same | integration "A1.4 finishRun with per-test not_proven rows publish did not count ..." (fails on 906d52b) |
| A1.5 malformed numbers | top-level `not_proven`, each `verify_counts` key, `verify_counts` not an object → N ≥ 1 with `countsUnreadable` | unit "A1.5 malformed counts" (exact N), "a non-numeric verify_exit" |
| A1.6 test gaps | mock run with `ranExecuted < ran` and run N > proof N + its browser check; `rowCounts` asserted at the API; `/search` tests ran once against the local Supabase (below); non-numeric `verify_exit`; exact N in every malformed-proof case | as listed in section 1 |
| A1.7 migration 0020 | `supabase/migrations/0020_summary_rejected.sql` (timeouts, 3 statements, rollback in the comment), probes, cut case, run-local and prepare-test-db lines | `deploy` "0020 cut before its last statement ..." and "0020's probes ..." |
| A2 words | every listed sentence; openapi descriptions regenerated (`npm run api:generate`, `node src/api/gen-openapi.ts`); contract and changelog; `verifyFailed` text; status.ts:4 and styles.css:1736 comments | grep below; render tests in `proof-followups.test.ts` ("A2 the check run's proof rows and causes list", 4 tests); console checks |
| A2 signals | `provable_absent`, `not_proven_outside` in `notProvenOf` (also serial), malformed → `countsUnreadable` | unit "A2 the two engine signals" (5 tests) |

`git grep -n -i -e "serial run" -e "identical" -- src/ github-app/src/ openapi/ docs/data-contract.md` (run on the
final tree; generated files `src/api/schema.d.ts` and `github-app/src/api/openapi.gen.ts` hold only the same API field
and defect names): every remaining line is an allowed exception:

- defects' fingerprint identifiers: `identical_fingerprint` / `identicalFingerprint` in `github-app/src/results/apply.ts:62,73,112,115,118,123`, `github-app/src/results/runner-records.ts:37,223`, `src/data/ci-rows.ts:144`, `src/data/mock.ts:732`, `openapi/fenvix-api.yaml:1084,1085,1397,1398`, `docs/data-contract.md:192,209,461`;
- defects' prose: `docs/data-contract.md:201` ("the fingerprint is identical"), `src/pages/Defects.tsx:265` ("identical fingerprint");
- the API field `provenIdentical` (no API change, labels only): `openapi/fenvix-api.yaml:1184,1185`, `src/data/ci.ts:203`, `src/data/compat.ts:20`, `src/pages/Overview.tsx:91`, `docs/data-contract.md:798` (this change's changelog naming it) and `:818` (an older changelog entry);
- the local variable `identical`: `src/pages/ProjectSections.tsx:582,591`;
- verify's `"identical"` status and its two-run comparison: `github-app/src/results/summary.ts:205,242,248`, `docs/data-contract.md:568,569,573`, `src/data/mock.ts:203`.

### 2. Migration 0020 on local Postgres 16

`cd deploy && npm test` (scratch Postgres 16.x on 54329, local Supabase up): **exit 0, 91 tests, 91 pass, 0 skipped**,
including "0020 cut before its last statement: the deploy stops, nothing recorded" (reported half-applied: the test
asserts the deploy stops with "0020 looks half-applied" and records nothing) and "0020's probes: both false on 0001 to
0019, both true once 0020 ran (and again: safe to repeat)". `npm run test:rls` (`TEST_DATABASE_URL=...54329/rls_scratch`):
0001-0013 once, 0014-0020 twice, every RLS file OK. The local Supabase (`scripts/local-supabase/up.sh`, Supabase
Postgres 15.8 image) applied 0020 twice as well.

### 3. Runner unit tests

`python3 -m pytest -q tests/test_runner_node.py tests/test_runner_proof.py` (engine): **86 passed**, exit 0 (47
existing, 39 new in `tests/test_runner_proof.py`). New tests: one per mapping row (8), serial → no proof, nothing ran in
lanes → no proof and not NOT PROVEN, each fail-closed field (9 pure cases, 7 through the whole wrapper on a stand-in
detjs: no proof, `not_proven ≥ 1`, exit 1, `summary["exit"] == 1`, the field in the log), `not_proven` None + incomplete
proof → 1 without an exception, `proven` < 0 (pure and wrapper), both signals written and firing (exit 1, summary exit
1), the footer read on a 2 MiB synthetic trace through a counting file object (≤ 65,536 bytes read) and its rejection
of a non-footer last line, a fragment, a footer over 64 KiB and invalid UTF-8, 51 cause groups → 50, a 600-unit cause →
500 (also with surrogate pairs), a warm run whose `proven` excludes the reused tests.

### 4. Engine Node suite

Interim: the full engine Node suite (`node --test --test-concurrency=1 test/*.test.js`) is still running at the time of this commit; this section is completed when it ends. Targeted B1 tests: `node --test test/parallel-rerun-account.test.js` 10/10 pass; `parallel-p041.test.js` "vitest named project" 1/1 pass.

### 5. Real fixtures (patched runner, `--det-workers=2`, empty plan state)

Commands (`$ENG` the engine checkout, `$W` a scratch directory; `FENVIX_DETJS="node $ENG/node/bin/detjs.js"`,
`TMPDIR=$W/tmp`, no `FENVIX_FIXTURE_*` variable, each project copied to `$W` and installed with `npm ci`):

```
$ env DETJS_PLAN_STATE=$W/state-a.json FENVIX_CACHE_ROOT=$W/cacheA python3 $ENG/runner/fenvix-run node --project $W/vitest --key fixture/vitest --out $W/out-a -- --det-workers=2
exit 0 (a)
  (then a comment line appended to $W/vitest/entropy.test.js and fail.test.js; reverted after the run, never committed)
$ env DETJS_PLAN_STATE=$W/state-a2.json FENVIX_CACHE_ROOT=$W/cacheA python3 $ENG/runner/fenvix-run node --project $W/vitest --key fixture/vitest --out $W/out-a2 -- --det-workers=2
exit 0 (a2)
$ env DETJS_PLAN_STATE=$W/state-b.json FENVIX_CACHE_ROOT=$W/cacheB python3 $ENG/runner/fenvix-run node --project $W/vitest-hazard --key fixture/vitest-hazard --out $W/out-b -- --det-workers=2
exit 0 (b)
```

Each `state-*.json` was a new empty file. Results (from `summary.json` and the trace header):

| Run | tests / reused / ran | `proof` | header |
|---|---|---|---|
| (a) cold | 5 / 0 / 5 (1 skipped by vitest) | workers 2, proven 4, not_proven 0, rerun_one_lane 0 | hazards 0 |
| (a2) warm, 2 of 3 files edited | 5 / 3 / 2 (1 skipped) | workers 2, proven 1, not_proven 0; `proven + not_proven` = `ranExecuted` 1 | hazards 0 |
| (b) `vitest-hazard`, cold | 4 / 0 / 4 | workers 2, proven 4, not_proven 0, **rerun_one_lane 4** | **hazards 1** (checked > 0 before the copy), `hazard_rerun.tests` 4 |

Copied to the App (paths anonymized as the existing fixtures, rows in `tests/fixtures/runner/README.md`):
`node-vitest-parallel-proof` (a), `node-vitest-parallel-warm` (a2), `node-vitest-parallel-hazard` (b), with
`*.step-summary.md` companions (the existing fixtures have them; written by the runner's own `write_node_step_summary`
from each real `summary.json`, because the runs had no `$GITHUB_STEP_SUMMARY`), and the synthetic
`node-vitest-parallel-notproven` (first key `_synthetic`, the edits of the brief; deviation 5). App unit test
"the runner's real proof summaries": `parseSummary` accepts all four with `proof` not null; (a), (a2), (b) parse to
`passed`; the synthetic one to `not_proven` with N 2.

### 5b. Engine signals on clean projects

`provable_absent` and `not_proven_outside_tests` from each trace header: **null and `[]` on every run** — (a), (a2),
(b), and one runner run (no `--det-workers`, no `FENVIX_FIXTURE_*`) on each existing project:

```
$ env DETJS_PLAN_STATE=$W/state-clean-<p>.json FENVIX_CACHE_ROOT=$W/cache-clean-<p> python3 $ENG/runner/fenvix-run node --project $W/<p> --key fixture/<p> --out $W/out-clean-<p>
exit 0 (clean-vitest)   workers 4, proof 4 of 4
exit 0 (clean-jest)     workers 1 (serial), no proof
exit 0 (clean-node-test) workers 4, proof 4 of 4
exit 0 (clean-mocha)    no meta.parallel.workers (serial), no proof
```

Not blocked: no false red reaches a customer from these signals on the fixtures.

### 6. e2e steps 9-11

`node --test --test-concurrency=1 tests/integration/e2e.test.ts` (inside `npm test`): **11 of 11 pass**; steps 1-8
unchanged (their deep-equal counts too; steps 9-11 come after step 8's assertions). With the local Supabase up, each
of 9-11 read the run through `GET /runs/{runId}` (no "no local Supabase" diagnostic): 9 `passed`, check `success`,
`Proven: no conflict between lanes | 4 of 4`, API `proof.workers` 2, `tests.notProven` 0; 10 the same with
`proof.rerunOneLane` 4; 11 `not_proven`, check `failure`, `tests.notProven` 2, `### Not proven` lists
`b.test.js: the one-lane re-run ran 0 of its 2 test(s): 2 test(s)`.

### 7. App unit: signals and malformed counts

`proof-followups.test.ts`: `provable_absent` (other sources 0) → N 1, "the run could not watch what tests touched";
`not_proven_outside` 3 → N 1, "something not controlled ran outside the tests"; malformed counts → exact N 1 (or the
larger other source, exactly) with "the runner's counts could not be read".

### 8. No test weakened

Section 1 lists every changed test. Each new test states `protects=...; fails_when=...; no_claim=...` (in a comment
above it, or in its docstring for the Python tests).

## 4. Commands run and their results

App (fenvix-app, final tree `a4b175b` + this report; scratch Postgres 16 on 54329; local Supabase from
`scripts/local-supabase/up.sh` in Docker, started in this session):

| Command | Result |
|---|---|
| `npm run api:check` | exit 0, "src/api/schema.d.ts matches openapi/fenvix-api.yaml" |
| `npm run test:unit` | 86 tests, 86 pass |
| `npm run check` | exit 0: checks 66 passed, organization checks 10, status colour checks 18, screenshots 170 |
| `cd github-app && npm test` | exit 0: typecheck; unit 192/192; integration 185/185, 0 skipped |
| `cd deploy && npm test` | exit 0: 91/91, 0 skipped |
| `TEST_DATABASE_URL=.../rls_scratch npm run test:rls` | every RLS check OK |

Baseline before any change (906d52b, scratch Postgres only, no local Supabase yet): github-app unit 175/175,
integration 142/142. The integration count rose to 185 because the local Supabase was started (the API suites no
longer skip) and 4 tests were added. The four A1 integration tests were also run against 906d52b's `src/` (tests from
this branch): all four fail there.

Engine (fenvix-engine-cli `162aa55`): see criterion 3 (`pytest`) and 4 (`cd node && npm test` equivalent:
`node --test --test-concurrency=1 test/*.test.js`, after `npm ci` and `node scripts/build.js`).

## 5. What I verified, what I reused, what I could not check

- Verified by running: every command above; the A1 integration tests failing on the old code; the real runs (a), (a2),
  (b) and the four clean runs.
- Reused: the existing fixtures' anonymization convention; the api-dashboard helpers (`signUp`, `call`) for e2e.
- Not checked: Python summaries (out of scope); a real GitHub Actions job (the fake GitHub of the tests only); the
  production deploy; the rebase onto `claude/release-1` after `claude/p0-big-trace`.
