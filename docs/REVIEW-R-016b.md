FIX 2

# Review R-016b: the R-016 fixes on `claude/dashboard-wiring` (last round)

Reviewed 2026-11-19 at `48ae9c1` (report `docs/REPORT-dashboard-wiring-2.md`). Review branch: `claude/review-r016b`.

**Verdict: FIX 2.** There are two findings: one High, one Medium. Each has a failing test in
`github-app/tests/integration/review-r016b.test.ts`. Both tests fail on `claude/dashboard-wiring`.

Six of the eight R-016 fixes hold end to end: F1, F2, F4, F5, F6 and F8. The other two are only partly fixed:

- **F3.** The units are now GitHub's held minutes, but whether a job is billed at all still depends on `summary.json`
  (G1).
- **F7.** The limits apply to results only. The same credential still has no limit on explorations (G2).

No new tenancy, auth or RLS defect was introduced.

**How to run the failing tests.** Start a scratch Postgres on `localhost:54329` with a `gh_test` database, then:

```
cd github-app && npm run db:prepare && node --test --test-reporter=spec --test-concurrency=1 tests/integration/review-r016b.test.ts
```

## Findings

| # | Severity | Area | Finding | Test |
| --- | --- | --- | --- | --- |
| G1 | High | Billing (F3 not complete) | A job that held our machine for any length of time is billed nothing if it sends no summary and ends `cancelled`. Both conditions are the customer's to choose | `G1 …` |
| G2 | Medium | Runner ingestion (F7 not complete) | One job's credential stores any number of explorations, each up to 6 MB and kept for good. The F7 limits cover `/v1/runner/results` only | `G2 …` |

### G1 (High): whether a job is billed is still the job's choice

**Where.**

- `github-app/src/service.ts`, `publish()`:

  ```
  if (summary) billable = true
  else if (conclusion is cancelled or skipped, or the job did not start on fenvix) billable = false, reason "cancelled_before_tests"
  ```

- `docs/data-contract.md`, "Run units": "a job that started on our machine and was cancelled before its tests (no
  summary) is not billable either".

**The problem.**

- Since F3, the units are the held minutes from GitHub's own timings. That part is correct.
- But the `billable` flag gates those units, and it is decided by two things the customer controls:
  - **Whether a summary exists.** The customer's workflow decides whether `fenvix-run` runs, and can delete
    `$RUNNER_TEMP/fenvix/summary.json`. A body that fails validation gets `422` and is not stored either.
  - **Whether the conclusion is `cancelled`.** The job can end that way in three ways:
    - a last step cancels its own run (`POST /repos/{o}/{r}/actions/runs/{id}/cancel` with the job's `GITHUB_TOKEN`
      and `permissions: actions: write`);
    - a person clicks Cancel;
    - a job-level `timeout-minutes` is reached. My understanding is that GitHub reports a timed-out job as
      `cancelled`; this was not checked against GitHub.
- "Before its tests" cannot be checked. The App reads it from a missing file.

**The effect.**

- Any job, of any length, that does not need a green status runs on fenvix machines for free: nightly or compute
  jobs, a separate workflow, a job whose status is not a required check.
- This is the F3 bypass again by another route. The contract's claim "Nothing the job writes changes them" is true of
  the units, but not of whether they are billed.

**Test.** `G1` runs a job on `fenvix-m1` from 10:00 to 11:00 (GitHub's timings), with conclusion `cancelled` and no
summary.

- `held_minutes` is 60.
- `billable` is `false`, reason `cancelled_before_tests`.

**Fix.**

- Decide `billable` only from GitHub's data. A job that started on our machine (`runner_name` and `started_at` from
  `workflow_job`) is billed its held minutes, whatever its summary and conclusion.
- If the "cancelled before the tests" courtesy should stay, bound it by GitHub's timings, for example not billable only
  when `held_minutes` is below a small threshold. Never base it on the summary being missing.
- `connect-flow.test.ts` step 14 asserts today's rule (`billable: false` for job 81002). It must change with the fix.
- Update `docs/data-contract.md` "Run units" to match.

### G2 (Medium): explorations have none of the F7 limits

**Where.**

- `github-app/src/app.ts`: `POST /v1/runner/explorations`, bodyLimit 6 MB, any valid per-machine credential;
- `github-app/src/service.ts`: `receiveExploration`;
- `github-app/src/results/apply.ts`: `applyExploration` inserts one `ci_explorations` row per
  `(project, startedAt, commitSha)`.

**The problem.**

- F7 was "one job's credential can fill the shared database". The fix covers results:
  - the credential names the run attempt;
  - at most 200 chunks and 256 MB per job;
  - staged rows are deleted after 7 days.
- The same per-job credential, which the job can read (R-016 F3), can still post explorations. Each distinct
  `startedAt` is a new row of up to 6 MB, and each can bring up to 500 defects, upserted into `ci_defects`.
- There is no count, byte or rate limit. There is no check that the credential's job is a night of exploration.
  Nothing is ever deleted.
- The only limit is the stage throttle that every customer shares.

**Test.** `G2` uses exactly the credential that `launchRunner` issues (runner, repository, run and attempt). It posts
30 small explorations with distinct `startedAt`: all get `202`, and 30 rows are stored. It asserts at most one.

**Fix.** Do one of these:

- issue explorations their own credential kind, only for the nightly exploration job;
- or allow one exploration per per-job credential (one job is one night), with a byte cap per project and night and an
  upper bound on stored nights.

Also refuse explorations from a CI job's credential.

## The eight R-016 fixes, checked beyond their tests

- **F1 (holds).**
  - `/github/setup` is the only path that leads to a link. `linkInstallation` is called only from tests.
  - Neither the webhooks (`installation.created`) nor the `installation_linked` work kind link anything. The work kind
    only syncs projects for repositories already linked.
  - Setup requires all of these:
    - the state;
    - the OAuth code;
    - the installation in `GET /user/installations`;
    - admin of the installation's account, as GitHub reports it now (`GET /app/installations/{id}`):
      - for a User account, the same id;
      - for an Organization, `GET /user/memberships/orgs/{org}` with `admin` and `active`;
      - any other type is refused.
  - `gh_link_installation` stays App-only (`fenvix_api` has no grant). It still checks the organization role, removal,
    and an installation belonging to another organization.
- **F2 (holds).**
  - Setup stores a completion bound to the state's fenvix user and organization:
    - a 256-bit code, of which only the sha256 is stored;
    - valid 10 minutes;
    - single use;
    - `state_hash` is unique, so a state completes once. Completions are swept a day after expiry, by which time the
      state's own hour is over.
  - `api_complete_github_link` links only when `api_user()` (the verified token's `sub`) is that user. Any other case
    gets the same 404. A rollback in `gh_link_installation` also rolls back `completed_at`.
  - The code travels in the fragment.
  - **Replay** of the GitHub redirect fails twice over: the OAuth code is single-use at GitHub, and the state is
    `used`.
  - **Code planted in another browser.** If an attacker makes a victim's dashboard auto-complete the attacker's code,
    it is refused, because the user does not match.
  - **Attacker's link opened by a victim.** If a victim installs from the attacker's link, the completion belongs to
    the attacker, but the code exists only in the victim's browser.
- **F3 (partly fixed).**
  - `held_minutes` comes from GitHub's `started_at` → `completed_at`. Publishing waits for `status = completed`.
  - The machine powers off at `fenvix-job-done`, so nothing runs after the billed window.
  - The 0015 backfill is sound.
  - Remaining defect: the `billable` gate (G1).
- **F4 (holds).**
  - The mode is recorded at launch (`gh_jobs.mode`) or at run start. The summary's and the results' `mode` are ignored.
  - Test durations are capped at the job's duration, `would_save_ms` at the run's test time, and `trialFrom` clamps
    each value to [0, 1].
  - The gate still rests on engine data, as R-016 observed.
- **F5 and F6 (hold).**
  - `ci_trial_accounts` is checked per `account_id`, under an advisory lock.
  - There is no trial when the organization has, or had, another installation.
  - Organizations linked before 0014 get trial dates in the past. The backfill covers accounts linked today.
- **F7 (partly fixed).**
  - The credential names the attempt (`403` otherwise). Without one, the attempt must be known in `gh_jobs`.
  - `chunk < chunks` is enforced at intake and in the worker (under a per-job advisory lock).
  - There are limits of 200 chunks and 256 MB, applied chunks are not replaced, and staged rows go after 7 days.
  - Remaining defect: explorations (G2).
- **F8 (holds).** Read against `0015`:
  - an admin updates or removes members only, never themselves, and never to admin or owner;
  - only an owner invites or revokes an admin.

  `api-rls.sql` and `gh-rls.sql` assert this.

**New code checked for tenancy.**

- `completeGitHubInstall` runs without the organization header, and the database checks the role.
- `afterCommit` queueing runs after the commit.
- `gh_install_completions` is granted to the App only, with RLS on.
- `api_complete_github_link` is `security definer`, granted to `fenvix_api` only.

No defect found.

## Observations (no failing test; for the founder to weigh)

- **The F1 admin check against real GitHub.** `GET /user/memberships/orgs/{org}` is called with the App's user token.
  `docs/GITHUB-APP.md` lists **no organization permissions**. GitHub's REST page does not say which fine-grained
  permission, if any, this endpoint needs for GitHub App user tokens. If it needs "Members: read", every Organization
  install ends in `github_not_admin`. Only the fake GitHub has been exercised. Check once against real GitHub with a
  test organization before release.
- **The time saved is not bounded, contrary to the contract.** `test_time_skipped_ms` and `minutes_saved` are stored
  unbounded, but the contract says the summary's `test_seconds_saved` is "bounded by the job's duration". Saved time can
  honestly exceed held time, so fix the sentence, or bound the value. It is not billed.
- **A trial per new GitHub organization.** GitHub organizations cost nothing to create, so "one trial per GitHub
  account" still allows a new trial per new GitHub organization. This is inherent to the account key.
- **A queueing failure after a link.** If queueing `installation_linked` fails after the commit, the link stands but its
  projects are created only when a run or onboarding touches them. The failure is only logged.
- **Unchanged from R-016:**
  - one stage throttle;
  - the API Lambda may send any work kind (it can also set `attemptBound`);
  - sessions are not revoked;
  - 0014 is irreversible;
  - dead chart code.

## Suites (on this branch: `48ae9c1` plus the review test)

| Command | Result |
| --- | --- |
| `npm run api:lint` | `openapi/fenvix-api.yaml` valid |
| `npm run build` | passes (`api:check`, `tsc`, `vite build`) |
| `npm run test:unit` | 59 / 59 |
| `npm run check` (mock) | behaviour 34 / 34, organizations 10 / 10, status colours 18 / 18; screenshots: all checks pass, 140 pictures |
| `node scripts/e2e-real-api.mjs` (local Supabase, real tokens) | 164 / 164 |
| `cd github-app && npm test` | typecheck clean; unit 95 / 95; integration 132 / 132 on the fix branch (summed per file). With this review's file: 132 pass, plus the **2 R-016b tests, which fail as intended** |
| `cd infra/github-app && npm test` | 56 / 56, cdk-nag clean |
| `npm run test:rls` (scratch Postgres 16; 0014 and 0015 each applied twice) | API RLS OK, CI RLS OK, CI EXPLORE RLS OK, GH RLS OK |

**Notes on the counts.**

- Node 22.23 prints `tests 103` for the combined `npm run test:integration`, with 0 failed, 0 skipped and exit 0.
- Run file by file, the 14 integration files give 132 tests, which matches the report. All 9 R-016 tests pass.

**Environment.**

- Postgres 16 on port 54329 (`gh_test`, plus a scratch database for `test:rls`).
- Local Supabase from `scripts/local-supabase/up.sh`: `supabase/postgres:15.8.1.085` and `supabase/gotrue:v2.186.0`
  in Docker.
- The screenshots that the check and the real-API pass regenerated were not committed.

**Changes on this branch besides this document:** `github-app/tests/integration/review-r016b.test.ts`, the failing
tests. Nothing else changed.
