DONE

# Report 3: warm cache at install, merged with review R-016b (branch `claude/warm-cache-install`)

Written 2026-11-19. Review R-018b of this branch was PASS. Since then the base branch `claude/dashboard-wiring`
received the last R-016b fixes:

- **G1:** whether a job is billable now comes from GitHub's job data, not from `summary.json`;
- **G2:** limits on exploration ingestion and on staged summaries (migration `0016_review_r016b.sql`);
- the report `docs/REPORT-dashboard-wiring-3.md`.

This round merged the latest `claude/dashboard-wiring` (`41421af`) into this branch and kept both behaviours. Warm-up
runs stay non-billable, and their billing inputs are the App's own: `billable = false` is fixed in code and enforced
by a CHECK constraint, and `held_minutes` comes from the App's clock. Nothing was deployed, and the runner (another
repository) was not edited.

Commits, oldest first:

| Commit | What |
| --- | --- |
| `28e08de` | Merge `claude/dashboard-wiring` (R-016b), with the conflicts resolved as described below |
| `a2deded` | A new merge test in `warmup.test.ts` covering G1, R-018 F2 and the warm-up rules together |
| this commit | This report and the refreshed real-API screenshots |

## What conflicted and how it was resolved

Git reported five conflicting files. There was also a sixth clash that git could not see: two new migrations with the
same number.

| File | Conflict | Resolution |
| --- | --- | --- |
| `supabase/migrations/` (no textual conflict) | Both branches had a `0016_*`: R-016b's `0016_review_r016b.sql` and this branch's `0016_warm_cache.sql`. | The base lands first, so R-016b keeps **0016**. The warm cache migration is renamed **`0017_warm_cache.sql`** with the same content; its header now says "Run it AFTER 0001 to 0016". The two migrations touch different objects (R-016b: `ci_explorations.received_at` and its index, plus `delete` grants on `ci_explorations` and `gh_run_summaries`; warm cache: `gh_warmups`, `cache_warm_*`, warm-up usage events). Both are safe to run twice, in either order. |
| `github-app/scripts/prepare-test-db.sh` | Both sides added `apply 0016_…` twice, and both changed the comment and echo line. | Applies 0014, 0015, `0016_review_r016b` and `0017_warm_cache`, each twice. The comment and echo now say "0014 to 0017 twice". |
| `supabase/tests/run-local.sh` | Same as above, on `migrate`. | Migrates `0016_review_r016b` twice, then `0017_warm_cache` twice. The comments name 0017 for `warm-rls.sql`. |
| `github-app/tests/helpers/harness.ts` | Each side added a "database prepared before …" upgrade step for its own 0016, and each had its own `truncate` list. | Both upgrade steps are kept, in migration order: 0015, then 0016 (when `ci_explorations.received_at` is missing), then 0017 (when `gh_warmups` is missing). The `truncate` list is this branch's, which includes `gh_warmups`; R-016b added no table. |
| `github-app/src/api/openapi.gen.ts` | Generated file. | Regenerated from the merged `openapi/fenvix-api.yaml` (`node src/api/gen-openapi.ts`). The YAML and `src/api/schema.d.ts` merged cleanly, and `npm run api:check` confirms they match. |
| `docs/data-contract.md` | (1) The `ci_usage_events.reason` row: R-016b's "only `cancelled_before_tests` is not billable, by GitHub's data" against this branch's `warm-up` reason. (2) R-016b's exploration "Limits" block and this branch's section "5. Warm-up runs" were both inserted at the end of section 4. | (1) One row with every reason, `warm-up` included: for a job, only `cancelled_before_tests` is not billable (by GitHub's data); a `warm-up` event is never billable (database check). (2) The Limits block stays at the end of section 4 (explorations), followed by section 5. Migration references for warm-ups now say 0017. The changelog keeps both sides' entries; the warm-up entry says "migration 0017 (0016 before the R-016b merge)". |

Files that git merged without conflict but that still had to change for the renumbering, so that every reference
points at a file that exists:

- `docs/DEPLOY-AWS.md` step 7: now runs 0015, then `0016_review_r016b.sql`, then `0017_warm_cache.sql`. R-016b had not
  yet added its 0016 there.
- `github-app/README.md`: the list of migrations.
- `supabase/tests/warm-rls.sql`
- source comments in `github-app/src/api/github.ts`, `src/data/ci-rows.ts` and `scripts/e2e-real-api.mjs`.

`scripts/local-supabase/up.sh` uses a glob and applied 0016 and 0017 with no change.

### Code: how both behaviours hold after the merge

The R-016b code changes (`src/service.ts` publish and `receiveExploration`, the `src/app.ts` exploration route, and the
sweep) merged without textual conflicts. These are the points where they meet this branch:

- **Customer jobs (R-016b G1).** `billable = startedOnFenvix`, where `startedOnFenvix` means the signed `workflow_job`
  has a `runner_name` and a `started_at`. `summary.json` and the "cancelled" conclusion only choose the `reason`.
- **Warm-ups.** They never reach that code path. Their usage event is written by `Warmups.recordUsage`
  (`src/warmup/warmups.ts`) with these values:
  - `billable = false` and `reason = 'warm-up'`, also enforced by the CHECK constraint from 0017;
  - `held_minutes` from `machine_seconds`, measured by the App's clock from dispatch to the report or to termination;
  - `test_minutes_ran` capped at `held_minutes`.

  No input to a warm-up's billing comes from the job user. That is the same rule G1 now applies to jobs.
- **Covering runs.** `onJobPublished(job, !!summary, …)` still uses the presence of a summary for one thing only: it
  decides whether the cache is warm, or whether the warm-up is re-armed (R-018 F2). It plays no part in billing.
- **G2 explorations.** The intake now refuses a credential that names a run (a CI job's credential). A warm-up
  machine's credential was already refused there earlier: `runnerBody` answers 403 to any credential carrying a
  `warmupId`. The rule "one new exploration per project and UTC day, 90 kept" therefore applies only to exploration
  machines, and warm-ups cannot add explorations.
- **G2 sweep.** The sweep also deletes staged summaries older than 7 days. Warm-up summaries are stored on
  `gh_warmups.summary`, not in `gh_run_summaries`, so the sweep does not touch them.

**New merge test** (`warmup.test.ts`, in the block "review R-018 follow-ups"): "merge R-016b: a covering run that
cancels itself without results is billed (GitHub's data); its re-armed warm-up runs and is never billed". Its steps:

1. A trusted push run covers the warm-up.
2. The run starts on our machine, then cancels itself 30 minutes later without sending a summary.
3. The job is billed: `billable = true`, `cancelled_after_start`, 30 held minutes. That is G1.
4. The warm-up is re-armed and gets a machine on the next tick. That is R-018 F2.
5. That warm-up machine's credential gets 403 on `/v1/runner/explorations`.
6. Its forged summary claims 7,200 test seconds. Its usage event is still `billable = false`, `warm-up`, with about
   three held minutes by the App's clock and `test_minutes_ran` no higher than that.

The existing credential test also gained `/v1/runner/explorations` in its list of routes that refuse a warm-up
credential.

## Suites (all on this branch's HEAD, from a fresh test database and a fresh local Supabase)

| Command | Result |
| --- | --- |
| `cd github-app && npm test` (typecheck, unit, then integration on a local Postgres 16 on :54329, with `gh_test` recreated empty and the local Supabase up) | typecheck clean; unit **127/127**; integration **165/165**, 0 skipped (the 161 from report 2, plus 2 R-016b and 1 new connect-flow test from the base, plus 1 new merge test) |
| `review-r016b.test.ts` alone | **2/2 pass** (G1 billing, G2 explorations) |
| `review-r018.test.ts` alone | **2/2 pass** (F1, F2) |
| `warmup.test.ts` alone | **25/25 pass**, including the new merge test |
| `npm run test:rls` (fresh scratch Postgres 16; 0014 to 0017 each applied twice) | API RLS OK, CI RLS OK, CI EXPLORE RLS OK, GH RLS OK, WARM RLS OK |
| `cd infra/github-app && npm test` | **69/69**; cdk-nag clean. One script test intentionally prints a Python `JSONDecodeError` traceback to stderr; it passes. |
| `npm run build` (`api:check` → `tsc` → `vite build`) | passes; `src/api/schema.d.ts` matches the YAML |
| `npm run api:lint` (Redocly) | valid |
| `npm run test:unit` (dashboard) | **66/66** |
| `npm run check` (mock: behaviour, organizations, status colours, layout, axe, screenshots) | 34/34, 10/10, 18/18, layout checks pass, 140 screenshots (unchanged in the tree) |
| `node scripts/e2e-real-api.mjs` (every page against the real API, on a local Supabase from `scripts/local-supabase/up.sh`, where 0016 and 0017 were applied) | **170/170**; `docs/screenshots-real-api/` refreshed and committed (only the run time and random organization names differ) |
| Secret scan of the tree (private keys, AWS access keys) | nothing found |

**Environment.**

- Postgres 16 on port 54329, with `gh_test` and a scratch database for the RLS suite.
- Local Supabase in Docker: `supabase/postgres:15.8.1.085` and `supabase/gotrue:v2.186.0`.
- Dependencies installed with `npm ci` in the root, `github-app/` and `infra/github-app/`.
