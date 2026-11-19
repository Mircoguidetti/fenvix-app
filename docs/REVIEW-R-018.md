FIX 2

# Review R-018: warm cache at install (branch `claude/warm-cache-install`)

Reviewed 2026-11-19 at `b6e7744` (report `docs/REPORT-warm-cache-install.md`, contract `docs/data-contract.md`
"5. Warm-up runs"). Review branch: `claude/review-r018`.

**Verdict: FIX 2.** There are two Medium findings, each with a failing test in
`github-app/tests/integration/review-r018.test.ts`. Both tests fail on `claude/warm-cache-install`. I found no High
finding. The Low items and the dependencies on R-016 are listed after the findings; they do not count toward the
verdict.

Threat model, as asked:

- hostile customer code runs in the warm-up job;
- another customer shares the runners;
- GitHub events can be replayed or forged.

**How to run the failing tests.** Start a scratch Postgres on `localhost:54329` with a `gh_test` database, then:

```
cd github-app && node --test --test-reporter=spec --test-concurrency=1 tests/integration/review-r018.test.ts
```

`npm run test:integration` runs them too.

## Findings

| # | Severity | Area | Finding | Test |
| --- | --- | --- | --- | --- |
| F1 | Medium | Cache integrity | If the default branch is reset to the last warm commit, the warm-up of the commit that was removed is not superseded. It later runs that commit's code with a **write** cache token | `F1 …` |
| F2 | Medium | Correctness | The claim "a warm-up is re-armed when the covering run ends without results" holds only for cancelled runs. After a failed run, the next tick marks the warm-up covered again. That commit is never warmed | `F2 …` |

### F1 (Medium): a commit removed from the default branch still gets a warm-up with cache write access

**Where.**

- `github-app/src/warmup/warmups.ts:109`: `if (r.cache_warm_sha === o.sha) return "exists"`.
- `github-app/src/warmup/warmups.ts:128-129`: `if (have) return "exists"`.
- Both checks return before the update at `:140-144`, which supersedes the warm-up in flight.
- `dispatchOne` (`:395-472`) never checks that the commit is still on the default branch.

**Scenario.**

1. A bad commit `B` reaches `main`: a compromised token, or a merge that should not have happened. Its warm-up is
   `pending` for the 180-second grace period, or longer when the daily cap or capacity holds it.
2. The maintainers reset `main` to the last good commit `H` (`git push --force origin H:main`), and cancel `B`'s push
   run.
3. GitHub sends a push with `after = H`. That commit is already warm, or already has a warm-up row, so `request()`
   answers `exists` and stops.
4. `B`'s warm-up stays `pending`. Cancelling the covering run re-arms it anyway (`onJobPublished`).
5. The next tick starts a machine for `B`. That machine gets:
   - `FENVIX_CACHE_ACCESS=write`;
   - a write cache token for the installation's cache organization.
6. `B`'s code runs, and the engine writes its proofs to the shared cache. Later pull request runs trust that cache and
   skip tests with proof.

**Why it matters.** The cache's write rule is "trusted refs only". The warm-up turns that into "any commit that was
ever pushed to the default branch, up to a day later", even after the people who own the branch removed it. Cancelling
the bad push run makes this more likely, not less: the cancel re-arms the warm-up.

**Test.** `F1` warms `H` at the link, pushes `B`, then pushes `H` again (the reset), and ticks. `B` gets a machine, and
its warm-up is still `pending` before the tick.

**Fix.**

- In `request()`, supersede every in-flight warm-up of another commit on any default-branch push that is newer by push
  time. Do it before the `exists` and `cache_warm_sha` short-circuits.
- In `dispatchOne`, before starting a machine, check that the commit is still the default branch's head. Use
  `GET /git/ref/heads/<branch>` (the installation token is already in hand), or compare with
  `GET /compare/<sha>...<branch>` and accept `identical` or `behind`. If the check fails, mark the warm-up `superseded`.

### F2 (Medium): a covering run that fails before its tests leaves the commit cold

**Where.**

- `github-app/src/warmup/warmups.ts:202-214`: `onJobPublished` re-arms the warm-up.
- Step 4 of `tick()` (`:371-377`) marks a `pending` warm-up `covered` by any `gh_jobs` row with `cache_access = 'write'`
  on the same commit, unless its conclusion is `cancelled` or `skipped`.

**Scenario.**

1. A push to `main` creates a warm-up. The customer's push run on fenvix covers it (`covered_by_job = J`).
2. Job `J` fails before its test step, for example when `npm ci` fails. There is no summary. The sweep publishes it,
   and `onJobPublished` puts the warm-up back to `pending`. This part works.
3. One minute later, `tick()` step 4 finds `J` again: `cache_access = 'write'`, conclusion `failure`. It marks the
   warm-up `covered` by `J` again.
4. `J` is already published, so nothing re-arms the warm-up. The commit stays cold until the next push.

The report says, in section 1: "If the covering run ends without results, the warm-up is re-armed." The existing test
checks only a **cancelled** run, which step 4 excludes, so it passes.

**Test.** `F2` covers a warm-up with a trusted push job, completes that job as `failure` without a summary, publishes
it, and confirms the warm-up is `pending` again. After one tick it is `covered` again, not `dispatched`.

**Fix.** Pick one:

- Step 4 covers only with jobs that are not yet published (`published_at is null`) or that published with a summary.
- `covered_by_job` remembers the job that was rejected, and step 4 skips it.

## What holds up (checked, no finding)

**1. Ownership, namespace and region.**

- Every warm-up comes from a signed webhook or from the link, and goes through `refuse()`, which requires all of:
  - a linked, unsuspended, not deleted installation;
  - a repository still in it;
  - `merged` or `already_fenvix`;
  - a known job and default branch.
- The cache token's organization is `gh-<installation id>` of the repository itself.
- The App credential names the warm-up, the repository and the runner name, and `report()` checks all three. A warm-up
  credential gets 403 on `/summaries`, `/progress`, `/results` and `/explorations`. A job credential gets 403 on
  `/warmups`.
- The region is always `workspaces.region`, read when the warm-up is dispatched. There is no fallback region, and
  without a placement the warm-up waits.
- The org concurrency limit uses `gh_warmups.workspace_id`, which the trigger sets from the installation.

**2. Cache poisoning from other refs.**

- Only `refs/heads/<default_branch>` pushes and the merged setup pull request's `merge_commit_sha` (base equal to the
  default branch) start a warm-up.
- A fork is a different repository and, when installed elsewhere, a different cache organization.
- On the machine (`fenvix-warmup-prepare` / `-done`):
  - the App credential stays root-only;
  - the job user's files are read as the job user;
  - the checkout token is `contents: read` for one repository, so the warm-up cannot push. That rules out a loop where
    a warm-up triggers a push.

**3. Cost.**

- Preemption terminates only instances tagged `fenvix:kind=warmup`, and IAM enforces this.
- The supersede, cancel and timeout paths terminate machines.
- The daily cap counts warm-ups per repository.
- The usage event is `billable = false`, `reason = 'warm-up'`, and a CHECK constraint enforces both.
- Billing (`src/data/ci.ts`) counts billable events only.

**4. Correctness.**

- The machine is given the onboarding workflow file and job id.
- No check run, status or comment is created. The fake GitHub returns 403 when the checkout token tries
  `POST check-runs`.

## Low (not counted)

- **Overlapping ticks.** The warm-up Lambda runs every minute with a 120-second timeout and no reserved concurrency of
  1. Two ticks that overlap each read `org_active` and their own `slots` before either claims. That can break the
  organization's concurrency limit and the reserve. Preemption limits the damage to customers. Fix: set
  `reservedConcurrentExecutions: 1`, or take an advisory lock in `tick()`.
- **Free CI on the default branch.** Warm-ups run the customer's job for free, up to 6 a day per repository and up to
  3 hours each, for any linked organization: there is no plan or trial check. With
  `WARMUP_ORG_CONCURRENCY = 1`, the most one organization can take is about one machine around the clock.
  - A customer can drop the push trigger from their fenvix job, or cancel the push run before its tests (not billable),
    and get default-branch runs as warm-ups. The pass or fail and the `detail` are shown on Connect.
  - This is a product decision. Consider a per-organization budget of machine minutes, and a `WARMUP_MAX_SECONDS` close
    to the job's own `timeout-minutes`.
- **Late or old pushes start machines.** A push for an older commit, delivered late when nothing is in flight, still
  gets a machine, even when a newer commit is already warm. `request()` does not compare against
  `cache_warm_pushed_at`. A replayed delivery can do the same for a commit that was never warmed. There is no new
  write path: this is a cost issue.

## Dependencies on R-016 (base branch `claude/dashboard-wiring`)

This branch does not change `/github/setup` or the summary path of jobs, so it does not reintroduce F1, F2 or F3. It
does make them worse until those fixes land.

**R-016 F1 and F2 (link takeover).**

- `linkInstallation` now warms every onboarded repository at once, with no grace period.
- An attacker who takes over a link therefore starts machines right away. They run the victim's private code in the
  **attacker's organization's region**, a data-residency break for an EU victim.
- The attacker's dashboard shows those warm-ups' `detail` and cache state.
- `POST /v1/github/repositories/{id}/setup-pull-request` now also starts a warm-up (`already_fenvix` →
  `requestHead`).
- Nothing changes in the cache namespace: the token is the victim installation's.
- Fixing R-016 F1 and F2 closes this. Rebase this branch on those fixes before merge.

**R-016 F3 (summary from a file the customer writes).**

- The warm-up's `summary.json` and `outcome.json` are also written by the job user. Root reads them as the job user and
  sends them.
- They only set the non-billable event's minutes and the "warm since" label. Billing and the trial do not read them.
- There is no new billing exposure. Keep it that way: never derive units or trial figures from `kind = 'warmup'`
  events.

## Suites the report lists (run at `b6e7744` plus the review test file)

| Command | Result |
| --- | --- |
| `cd github-app && npm test` (local Postgres 16 on :54329; local Supabase in Docker from `scripts/local-supabase/up.sh`) | typecheck clean; unit **127/127**; integration **141/141**, 0 skipped (before the review file was added) |
| `review-r018.test.ts` | **2/2 fail** as intended (F1: the removed commit gets a machine; F2: `covered` instead of `dispatched`) |
| `npm run test:rls` (fresh scratch database) | API, CI, CI EXPLORE, GH and **WARM RLS OK** |
| `cd infra/github-app && npm test` | **69/69**; cdk-nag clean, including the warm-up function |
| `npm run build` | passes |
| `npm run api:lint` | valid |
| `npm run test:unit` (dashboard) | **66/66** |
| `npm run check` | see below |
| `node scripts/e2e-real-api.mjs` | see below |
| Secret scan (private keys, AWS keys) | see below |
