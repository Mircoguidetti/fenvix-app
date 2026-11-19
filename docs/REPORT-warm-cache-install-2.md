DONE

# Report 2: warm cache at install, after review R-018 (branch `claude/warm-cache-install`)

Written 2026-11-19. This round did three things on `claude/warm-cache-install`:

1. merged the latest `claude/dashboard-wiring` (review R-016 security fixes) into this branch;
2. fixed the two Medium findings of review R-018 (`docs/REVIEW-R-018.md`). Their tests are in
   `github-app/tests/integration/review-r018.test.ts`, copied unchanged from `claude/review-r018`;
3. went through the review's notes on R-016 against the merged code.

Nothing was deployed. The runner (another repository) was not edited.

Commits, oldest first:

| Commit | What |
| --- | --- |
| `7a6f3f8` | Merge `claude/dashboard-wiring` (R-016), with conflicts resolved and the merge fixes below |
| `177f4e5` | The review's test file and `docs/REVIEW-R-018.md`, copied unchanged (`git diff origin/claude/review-r018 HEAD` on both files is empty) |
| `212e6b6` | R-018 F1 and F2 fixes, follow-up tests, data contract |
| this commit | This report and the real-API screenshots |

## Findings: finding → fix → test before / after

| # | Finding (review R-018) | Fix | Test | Before (at `177f4e5`) | After |
| --- | --- | --- | --- | --- | --- |
| F1 (Medium) | Someone resets the default branch to the last warm commit `H`. The warm-up of the removed commit `B` is not superseded: `request()` answers `exists` first. Later, `B`'s code runs with a **write** cache token. | **(a)** `request()` now starts with `supersedeOlder()`. Any default-branch push ends every warm-up in flight (pending, dispatched or running) for another commit pushed earlier (push time). This runs **before** the "already warm" and "already requested" answers. A running machine is terminated by the next tick. **(b)** `dispatchOne()` reads `GET /git/ref/heads/<default branch>` right before it claims the warm-up. If the commit is not the head, the warm-up is `superseded` with no machine: "… is no longer the head of main (now …)". The current head is then requested in its place, so a lost webhook does not leave the cache cold. **(c)** A commit superseded before it ever had a machine is warmed again when it is pushed again later: the branch was moved back to it. A replayed delivery has the same push time and changes nothing. A commit that already had a machine keeps its single record. | `F1: resetting the default branch to the warm commit cancels the warm-up of the commit that was taken off it` | **fail**: "no machine runs a commit that is no longer on the default branch with a write cache token" (actual `true`, expected `false`) | **pass** |
| F2 (Medium) | A covering push run fails before its tests (no summary). It re-arms the warm-up, but step 4 of the next `tick()` marks the warm-up `covered` by the same job again. The commit is never warmed. | Step 4 of `tick()` covers a pending warm-up only with a trusted job that is **not yet published** (`j.published_at is null`), and still not a cancelled or skipped one. A published job either: <br>• warmed the cache: `dispatchOne()` then finds `cache_warm_sha` and marks the warm-up covered; or <br>• ended without results: it re-armed the warm-up (`onJobPublished`) and never covers it again. | `F2: a warm-up re-armed after its covering run failed without results gets a machine on the next tick` | **fail**: "the re-armed warm-up must get its machine; it is covered" (actual `false`, expected `true`) | **pass** |

Each test failed only on its own finding:

- At `177f4e5` (no fixes), both fail.
- With the F1 fix in place and the F2 fix not yet written, F1 passes and F2 still fails with the same message.
- With both fixes, both pass.

Command: `cd github-app && node --test --test-reporter=spec --test-concurrency=1 tests/integration/review-r018.test.ts`.

**Follow-up tests** (new, in `github-app/tests/integration/warmup.test.ts`, block "review R-018 follow-ups"):

| Test | Without the fix (`warmups.ts` at `177f4e5`) | With it |
| --- | --- | --- |
| The branch moved with no webhook: the warm-up is superseded before any machine starts, and the new head is requested instead | fail | pass |
| A commit superseded before its machine is warmed again when the branch is pushed back to it later; a replay of the old push changes nothing | fail | pass |
| A warm-up's usage event: `held_minutes` is the machine time by the App's clock and bounds the test minutes, even with a forged summary claiming an hour | (merge fix, see below) | pass |

**Test harness.** The (head) check needs the fake GitHub to behave like GitHub, so `Harness.send("push", …)` now moves
the fake's default branch to `after`. It does so only for the newest push it has seen: a late delivery does not move
the branch back.

One existing test, "one warm-up per organization at once", requests a warm-up of `acme/web` at `d…`. It now sets that
repository's branch head in the fake GitHub to the same commit, so that test still checks what it was written to check:
the organization's concurrency limit.

**Review's Low items** (not counted toward the verdict):

- **Late or old pushes start machines: closed by F1 (b).** A late or replayed push for a commit that is not the head
  now gets its warm-up superseded at dispatch, with no machine.
- **Overlapping ticks: not changed.** The Lambda has no reserved concurrency of 1, and `tick()` takes no advisory
  lock.
- **Free CI on the default branch: not changed.** This is a product decision: a per-organization budget of machine
  minutes, and a cap at the job's own `timeout-minutes`.

## Dependencies on R-016 (the review's notes), after the merge

**R-016 F1 and F2 (link takeover).** These are fixed on this branch by the merge.

- `/github/setup` no longer links. It only hands a one-time code to the dashboard, and only for an admin of the
  installation's account.
- The person who started the install completes the link through `POST /v1/github/installations/complete`
  (`api_complete_github_link`, then `gh_link_installation`).
- A warm-up therefore runs only after a legitimate link: in the region of the organization of the account's admin,
  with that organization's dashboard showing its `detail`.

**Merge fix: the R-016 link path did not warm.** After R-016, a link is completed through the API and then the
worker's `installation_linked` work. That work only synced projects, so the warm-up of onboarded repositories at link
time (this branch's trigger 2) was lost in the merge.

- New `GitHubService.onInstallationLinked()`: it syncs the projects, then warms every repository that is `merged` or
  `already_fenvix`.
- The worker (`src/work.ts`) and `linkInstallation` both call it.
- A forged `installation_linked` message still changes nothing for an installation that is not linked:
  `Warmups.refuse()` requires a linked, unsuspended installation.
- New test block in `warmup.test.ts`: "linked through the dashboard (review R-016: …) with the setup pull request
  already merged".
  - Someone who only sees the installation gets no completion code, no link and no warm-up. The tick starts nothing.
  - The account's admin completes the link. The worker requests one warm-up of the default branch's head, trigger
    `linked`, in the admin's organization, and the tick gives it a machine.
  - With the worker still calling only `syncInstallation`, the last test fails (checked); with the fix, it passes.

**`POST /v1/github/repositories/{id}/setup-pull-request`** (→ `already_fenvix` → `requestHead`). The API accepts only a
repository of the caller's organization's linked installations (`REPOSITORIES … and r.repository_id = $2`, under row
level security). With R-016's link fix, this path is closed too.

**R-016 F3 (summary from a file the customer writes).** Still applies to warm-ups: their `summary.json` comes from the
job user. After the merge:

- **Merge fix.** A warm-up's usage event now sets `held_minutes` from the App's own clock: `machine_seconds`, from
  dispatch to the report or to termination.
- R-016 made `baseline_minutes` and `units` generated from `held_minutes`. The warm-up event still has
  `billable = false` and `reason = 'warm-up'`, enforced by the CHECK constraint.
- Its `test_minutes_ran` is bounded by `held_minutes`, as R-016 does for jobs.
- Billing (`billableIn`, `src/data/ci.ts`) and the trial (`trialFrom`) count billable events only. Nothing derives
  units or trial figures from `kind = 'warmup'` events, as the review asked.

## Merge notes (`claude/dashboard-wiring` → `claude/warm-cache-install`)

There were seven conflicting files. All were resolved keeping both behaviours.

- **Migration number.** Both branches added a `0015_*`.
  - R-016's `0015_review_r016.sql` keeps its number, because its branch is the base and lands first.
  - The warm cache migration is renamed **`0016_warm_cache.sql`**, with the same content.
  - Updated to match: `github-app/scripts/prepare-test-db.sh` and `supabase/tests/run-local.sh` (0014, 0015, 0016
    each applied twice); the test harness, which applies 0015 or 0016 to a database prepared before them, in order;
    `supabase/tests/warm-rls.sql`; `docs/DEPLOY-AWS.md` step 7 (0015, then 0016); `github-app/README.md`;
    `docs/data-contract.md`; source comments.
  - `scripts/local-supabase/up.sh` uses a glob (`00{14..99}`) and needed no change.
  - Both migrations are safe to run twice and do not touch the same objects. 0016 inserts no
    `baseline_minutes`/`units` (now generated) and adds only `warmup_id`, the `kind` checks and nullable job ids to
    `ci_usage_events`.
- **`src/runners/credentials.ts`.** The runner credential carries both the run attempt `a` (R-016 F7: needs a run id)
  and the warm-up id `w` (warm-up only: no run id). Signing and verifying check both rules.
- **`src/service.ts`.** The `gh_jobs` row type has both `mode` (R-016 F4) and `cache_access`. `launchRunner` reads
  `run_attempt` and `head_sha`.
- **`src/api/openapi.gen.ts`.** Regenerated from the merged `openapi/fenvix-api.yaml` (`node src/api/gen-openapi.ts`).
  The YAML itself merged cleanly.
- **`tests/helpers/harness.ts`.** `resetDb` truncates both branches' tables (`gh_install_completions`,
  `ci_trial_accounts`, `gh_warmups`).
- **`docs/data-contract.md`.** Both `ci_usage_events` field rows (`heldMinutes` now also covers warm-ups) and both
  changelog entries kept. New changelog entries for the merge and R-018. "5. Warm-up runs" describes the head check,
  supersede-on-any-newer-push and coverage until publish.

## Suites (all on this branch's HEAD, from a fresh test database and a fresh local Supabase)

| Command | Result |
| --- | --- |
| `cd github-app && npm test` (typecheck, unit, integration on a local Postgres 16 on :54329, `gh_test` recreated empty, and the local Supabase) | typecheck clean; unit **127/127**; integration **161/161**, 0 skipped (141 from this branch + 12 from R-016 + 2 R-018 + 6 new: 3 link-path, 3 R-018 follow-ups) |
| `review-r018.test.ts` alone | **2/2 pass** (both failed before the fixes) |
| `npm run test:rls` (fresh scratch Postgres 16; 0014, 0015 and 0016 each applied twice) | API RLS OK, CI RLS OK, CI EXPLORE RLS OK, GH RLS OK, WARM RLS OK |
| `cd infra/github-app && npm test` | **69/69**; cdk-nag clean (per-job, demo, two regions, warm-up function) |
| `npm run build` (`api:check` → `tsc` → `vite build`) | passes; `src/api/schema.d.ts` in step with the YAML |
| `npm run api:lint` (Redocly) | valid |
| `npm run test:unit` (dashboard) | **66/66** |
| `npm run check` (mock: behaviour, organizations, status colours, layout, axe, screenshots) | 34/34, 10/10, 18/18, all layout checks pass, 140 screenshots (unchanged in the tree) |
| `node scripts/e2e-real-api.mjs` (every page against the real API, local Supabase from `scripts/local-supabase/up.sh`) | **170/170** (this branch's 163 and R-016's 7 checks of the confirm step); `docs/screenshots-real-api/` updated and committed |
| Secret scan of the tree (private keys, AWS access keys) | nothing found |

**Environment.**

- Postgres 16 on port 54329 (`gh_test`, plus a scratch database for the RLS suite).
- Local Supabase in Docker: `supabase/postgres:15.8.1.085` and `supabase/gotrue:v2.186.0`. The first pull hit a
  Docker Hub rate limit; a retry worked.
