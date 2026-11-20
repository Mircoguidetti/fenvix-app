PASS

# Review R-018b: warm cache at install, last round (branch `claude/warm-cache-install`)

Reviewed 2026-11-19 at `8b1c9c2` (report `docs/REPORT-warm-cache-install-2.md`). Round 1 was
`docs/REVIEW-R-018.md` (branch `claude/review-r018`, FIX 2). Review branch: `claude/review-r018b`.

**Verdict: PASS.** I found no new High or Medium defect, so this round adds no failing test.

- Both R-018 fixes are real. I checked the code, and I checked by mutation that each fix is what makes its test
  pass.
- The merge of `claude/dashboard-wiring` did not bring back the R-016 link takeover or billing from files the
  customer writes on any warm-up path.
- The warm-up code does not depend on what R-016b changes. One merge constraint is listed below.

The Low items at the end do not count toward the verdict.

## 1. The two fixes

### F1: a commit taken off the default branch never gets a warm-up machine

The fix is in three places in `github-app/src/warmup/warmups.ts`:

| Part | Where | What it does | Checked |
| --- | --- | --- | --- |
| (a) | `request()` calls `supersedeOlder()` (`:115`, `:179-187`) | Runs **before** the `cache_warm_sha` answer and the "exists" answer. Every warm-up in flight for another commit with an earlier push time is superseded. A dispatched or running warm-up also gets `terminate_requested_at`. | The SQL is right. The push time is `repository.pushed_at` from the signed push payload, which is GitHub's clock, not the committer date. A replayed delivery has the same push time, so it supersedes nothing newer. |
| (b) | `dispatchOne()` (`:477-494`) | Reads `GET /git/ref/heads/<default>` with the installation token after `decide()` and **before** the claim. If the commit is not the head, the warm-up becomes `superseded` (`where status = 'pending'`), no machine starts, and the head is requested in its place. | This catches every way a non-head commit reaches dispatch: a late push, a same-second reset that (a) misses (`pushed_at < $3`), a lost webhook, and re-dispatch after preemption, a stuck machine or `RetryLater`. All of those go back to `pending` and through this check. |
| (c) | The `have` branch of `request()` (`:133-153`) | Re-arms a warm-up that was superseded before it had a machine, only when the same commit is pushed again later. | It is safe because (b) still checks the head at dispatch. A replay changes nothing (same push time). |

Race between (a) and (b): suppose a reset push arrives between the head check and the claim.

- If (a) runs first, the claim's `where status = 'pending'` fails, and no machine starts.
- If (a) runs after the claim, the row is `dispatched`. (a) marks it superseded with `terminate_requested_at`, and
  tick step 2 terminates the machine within one tick.

**Mutation checks** (I edited `warmups.ts`, then ran `review-r018.test.ts` and `warmup.test.ts`, 26 tests):

| Mutation | Result |
| --- | --- |
| Remove the `supersedeOlder` call (a) | F1 still passes, because (b) catches the pending warm-up. Only the follow-up test "superseded before its machine … warmed again" fails. |
| Remove the head check (b) | F1 still passes, because (a) supersedes the pending warm-up. Only the follow-up test "branch moved with no webhook" fails. |
| Remove both | F1 fails, plus both follow-ups. |
| Remove `j.published_at is null` (F2) | F2 fails. |

So (a) and (b) each close F1 independently, and each has its own test.

One gap: no committed test covers (a) against a machine that is **already running**. I checked it with a scratch test,
not committed:

1. Dispatch B and report `started`.
2. Push the reset to H.
3. B is `superseded` with `terminate_requested_at` set, and the next tick terminates its machine.
4. B's late `finished` report gets 202, is ignored (its usage is already recorded), and does not mark B warm.

See L1.

### F2: a published run never covers its warm-up again

Tick step 4 (`:413-419`) now covers a pending warm-up only with a trusted job where `published_at is null`, and still
excludes cancelled and skipped jobs.

I traced every path that sets `covered`:

- `onTrustedJob` runs only from `launchRunner`, so the job is unpublished.
- `markWarm(…, "run")` runs only when a summary was published, so the cache really is warm.
- `dispatchOne` marks covered only when `cache_warm_sha` equals the commit.

None of them can bring back the job that ran without results. If `tryPublish` fails after `onJobPublished`,
`published_at` goes back to null. Step 4 may then cover the warm-up again, but the retried publish re-arms it again.
The exception, after 5 failed attempts, is in L4.

## 2. The R-016 holes on the warm-up paths, after the merge

**Link takeover (R-016 F1, F2): not reintroduced.**

- `/github/setup` (`src/app.ts:268`) only verifies and hands out a one-time code. It calls neither
  `linkInstallation` nor any warm-up.
- `linkInstallation` (`service.ts:1001`) is used by the tests only.
- The only production trigger for "linked" warm-ups is `onInstallationLinked`. It is reached from the
  `installation_linked` work item, which `POST /v1/github/installations/complete` enqueues after
  `api_complete_github_link` and `gh_link_installation`. Both are still the 0015 versions: 0016 redefines no function
  and adds only the `gh_warmups` policies.
- A forged queue message for an installation that is not linked is refused by `Warmups.refuse()`.
- `POST …/setup-pull-request` → `onboard` → `requestHead` only works on a repository of the caller's organization
  (row level security plus `r.workspace_id = $1`).
- The region is read from `workspaces.region` of the linked organization at dispatch.

**Billing from customer-written files (R-016 F3): not reintroduced.**

- A warm-up's usage event takes `held_minutes` from `machine_seconds`, which is the App's clock from dispatch to the
  report or to termination.
- `test_minutes_ran` is bounded by `held_minutes`.
- The event is `billable = false`, `reason = 'warm-up'`, and a CHECK constraint enforces both.
- `billableIn` and the trial (`src/data/ci.ts`) and `api/data.ts` (`… and billable`) count billable events only.

**Credentials.** The merged credential keeps R-016 F7 (`a` requires `u`) and the warm-up rule (`w` forbids `u`).

- A warm-up credential gets 403 on `/summaries`, `/progress`, `/results` and `/explorations`.
- A job credential gets 403 on `/warmups`.
- `report()` checks the warm-up, the repository and the runner name, and the runner name includes the attempt.

**R-016b (in progress on `claude/dashboard-wiring`).** The warm-up code does not depend on the old behaviour:

- **Billability from GitHub job state.** Warm-up usage never reads `billable` or a job's minutes. The only coupling is
  `publish()` → `warmups.onJobPublished(job, !!summary, completedAt)` (`service.ts:872`). The cache state and the F2
  re-arm depend on whether a valid summary arrived, not on billability. When R-016b lands and is merged here, keep that
  call with a valid-summary flag, and keep `gh_jobs.published_at` set once per publish, because the F2 fix relies on
  it.
- **Exploration ingestion limits.** A warm-up credential is refused on `/explorations`, so warm-ups neither use nor get
  around those limits. Warm-up reports have their own limits: a 4 MB body, `trimSummary`, and one report counted per
  warm-up.

## 3. New defects from the fixes

There is no High or Medium defect. The Low items are below.

## Low (not counted)

- **L1: no test of the reset against a running warm-up.** Part (a)'s main job is to terminate a machine that is
  already running a commit the reset removed, and no committed test covers that. It works today: I checked it with a
  scratch test (section 1). Add that test so a later change cannot remove (a) unnoticed. Today, removing it fails only
  the re-arm follow-up test.
- **L2: a lost reset webhook while a warm-up is running.** Part (b) checks the head only before dispatch. If the reset
  push is never delivered, a machine that is already running the removed commit keeps its write token until it ends or
  hits `WARMUP_MAX_SECONDS`. Fix: check the head again when the machine reports `started` and answer
  "stop", or have the tick check the head of running warm-ups.
- **L3: a warm-up that already had a machine is never re-armed.** Suppose the head moves back to a commit whose
  warm-up already had a machine and was superseded, and that commit is not `cache_warm_sha`. The dispatch-time
  re-request answers `exists`, so nothing warms the head until the next push. This costs coverage only.
- **L4: a covering job that is never published keeps its warm-up covered.** This happens when a job's `completed`
  webhook is lost, or after 5 failed publish attempts. The F2 fix relies on publication. This existed before the fix.
- **L5: a re-pushed commit keeps its first push time.** `gh_pushes` uses `on conflict do nothing`. After a reset to H,
  the run of H calls `markWarm(H)` with H's first push time, which loses to a removed commit B that was already marked
  warm. Connect then shows "warm since B" until the next push. This affects the display only.
- **L6: the head check adds a GitHub call to each dispatch.**
  - Errors other than 404 and 409 throw, so the warm-up stays pending and is retried every tick without counting an
    attempt.
  - Longer ticks make the overlapping ticks already noted in R-018 (no reserved concurrency of 1, no advisory lock) a
    little more likely. The claim stays atomic.

## Suites the reports list (run at `8b1c9c2`)

| Command | Result |
| --- | --- |
| `cd github-app && npm test` (Postgres 16 on :54329, `gh_test` created empty) | typecheck clean; unit **127/127**; integration **129/129** without the local Supabase (the dashboard-API block skips) |
| `npm run test:integration` with the local Supabase (`scripts/local-supabase/up.sh`, then `source env.sh`) | **161/161**, 0 skipped |
| `review-r018.test.ts` | **2/2 pass** (F1, F2) |
| Mutations of the fixes (section 1) | each fix is what makes its test pass |
| `npm run test:rls` (fresh scratch database) | API, CI, CI EXPLORE, GH, **WARM RLS OK**; 0014, 0015 and 0016 each applied twice |
| `cd infra/github-app && npm test` | **69/69**; cdk-nag clean, including the warm-up function |
| `npm run build` | passes |
| `npm run api:lint` | valid |
| `npm run test:unit` (dashboard) | **66/66** |
| `npm run check` | status colours **18/18**, layout and screenshot checks pass, 140 screenshots (the tracked screenshots it rewrote were not committed) |
| `node scripts/e2e-real-api.mjs` | **170/170** (the screenshots it rewrites were not committed) |
| Secret scan (private keys, AWS access keys) | nothing found |
