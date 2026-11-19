DONE

# Report: review R-016 fixed (branch `claude/dashboard-wiring`)

Written 2026-11-19. Review R-016 (`claude/review-r016`, `docs/REVIEW-R-016.md`) found eight defects in the dashboard
wiring: two High, five Medium, one Low. All eight are fixed, High first. The review's 9 tests were copied unchanged
(`github-app/tests/integration/review-r016.test.ts`, plus the fake GitHub's `GET /user` and
`GET /user/memberships/orgs/{org}` from the same branch; `git diff origin/claude/review-r016 HEAD` on both files is
empty). Each test failed before its fix and passes after it. No existing check was weakened; the four places where an
existing test had to change are listed under "Existing tests changed", with the reason.

## Findings: fix and test, before and after

"Before" is the review branch (`daa9b17` plus the tests) run here on a fresh test database:
`node --test tests/integration/review-r016.test.ts` gave **0 / 9 pass**. "After" is this branch's HEAD: **9 / 9 pass**.

| # | Severity | Finding | Fix | Test before (failure message) | After |
| --- | --- | --- | --- | --- | --- |
| F1 | High | Anyone who can see an installation (read access to one repository) links it to their own organization | `/github/setup` also requires the GitHub user to administer the installation's account: `account.id === GET /user .id` for a User account; `GET /user/memberships/orgs/{org}` with `role: admin`, `state: active` for an Organization. Otherwise `?github=error&reason=github_not_admin` | fail: "acme's installation … was linked to mallory's organization … redirect …?github=connected" | pass (redirect `reason=github_not_admin`; nothing linked) |
| F2 | Medium | The install-link state is not bound to the person who completes the install | `/github/setup` no longer links. It stores a single-use completion (`gh_install_completions`: sha256 of a one-time code, 10 minutes; the state's hash is unique, so a state is used once) and redirects to `/projects/connect?github=confirm&installation&account#completion=<code>`. The dashboard completes the link with the signed-in person's token: `POST /v1/github/installations/complete` (new operation `completeGitHubInstall`). The database function `api_complete_github_link` links only when that person is the one the state names (any other case: the same 404), then the worker syncs the projects (work kind `installation_linked`, queued after the commit) | fail: "globex's installation was linked to mallory's organization (redirect …?github=connected…)" | pass (a completion is stored for mallory; alice's session cannot complete it; nothing linked) |
| F3 | High | The job's own `summary.json` sets the billed baseline minutes; a forged one makes every job 0 units | Units count **the minutes the job held our machine, by GitHub's job timings** (`workflow_job` `completed_at − started_at`, in webhooks GitHub signs): new `ci_usage_events.held_minutes`; `baseline_minutes` and `units` are now generated from it (migration 0015, with a backfill from `gh_jobs` for earlier events). The summary's `test_seconds_run`, `test_seconds_saved`, `wall_seconds` are still stored and shown, bounded by the job's duration, and never billed. Specified in `docs/data-contract.md`, "Run units" | fail: "a 60-minute job on our machine is billed 0 baseline minutes (0 units)" | pass (60 baseline minutes) |
| F4 | Medium | The run's mode and its would-have-saved time come from the job; the trial share can exceed 1 | The App records the mode it starts the machine with on the job (`gh_jobs.mode`; or the organization's mode when the run row starts) and the run keeps it; the `mode` in `summary.json` and in the results is ignored. Each test's duration is capped at the job's duration, `would_save_ms` at the run's own test time (ran + skipped), `test_time_ran_ms` at the job's duration; `trialFrom` clamps each run and the share to [0, 1] | F4a fail: "the run was stored as "enforce"…"; F4b fail: "would_save_ms = 1000000000 for a run whose tests took 298 ms" | pass, pass |
| F5 | Medium | A new 30-day trial per reinstall and new organization | `gh_link_installation` starts no trial for a GitHub account (`account_id`) that had one through any organization: new table `ci_trial_accounts`, filled at each first link and backfilled with every account linked today | fail: "the same GitHub account (acme) got a second 30-day trial …" | pass |
| F6 | Medium | Migration 0014 puts an existing customer into a 30-day shadow trial when it links another installation | `gh_link_installation` starts a trial only when the organization has no other installation linked, now or before. 0015 also gives organizations linked before 0014 trial dates in the past | fail: "an existing customer linked a second GitHub account after 0014 and its 30-day shadow trial started now" | pass |
| F7 | Medium | One per-job credential stores results for any attempt and up to 10,000 chunks of 6 MB, kept for good | The per-job credential now names the run attempt (a body for another attempt: `403`). Without it (demo machine, older credential) the attempt must be one GitHub ran on that runner (`gh_jobs`); until the job's start is recorded the worker retries; otherwise the chunk is dropped. `chunk ≥ chunks` is `400` on chunk 0 and dropped later (stored ones past the count are removed when chunk 0 arrives). At most 200 chunks and 256 MB per job. An applied chunk is not replaced. Staged results are deleted after 7 days (the sweep; the App may now delete `gh_run_results`) | fail: "one job's credential stored 41 result chunks for attempts and chunk numbers that are not its job's (answers: 202)" | pass (0 foreign chunks) |
| F8 | Low | Row level security does not hold the owner-only rules | New `api_owner_workspace()`. As `fenvix_api`, an admin changes or removes members only (never an admin or owner, never themselves, never to admin or owner); only an owner invites an admin or revokes an admin's invitation. `orgs.ts` is unchanged | fail: "the database lets the API's role do, for an admin: admin promotes themselves to owner; admin invites an admin; admin removes an owner" | pass |

### F3: where the billed minutes come from now

The founder's rule was: units only from data the customer cannot forge, either the runner's own signed measurement or
GitHub's job timings. A signed measurement from the runner is not possible today. The job runs on the same machine as
the poster and can write the poster's spool, so anything signed with a key the job can reach is forgeable. So the
units come from **GitHub's job timings**:

- **Source.** `started_at` and `completed_at` of the `workflow_job`, as GitHub delivers them in webhooks signed with
  the App's secret.
- **Consequence for pricing (a decision for the founder).** A run unit is now 10 minutes of a held machine. Time saved
  by skipping tests is no longer billed, so a job fenvix makes faster costs less. The billing page and the usage note
  say so.
- **Making saved time billable again.** `docs/data-contract.md` ("Run units") names two sources that would allow it:
  - a measurement signed by a root-only process the job user cannot reach (work in the runner repository);
  - a value derived from GitHub's timings, such as the same job's duration in shadow runs.
- **The trial's 35% gate** still rests on what the engine reports. The review noted this, and it is unchanged apart
  from the bounds of F4.

### F2: what a person sees

**The normal case.** An owner or admin clicks Install and finishes on GitHub as an admin of the GitHub account. They
come back to the Connect page, which shows "Connecting the GitHub installation…" for a moment and then the usual
"installed on <account>".

**Someone else's link.** The person sees: "This GitHub connection link is not valid for your account: it was started
by another fenvix account, has already been used, or has expired. Nothing was connected." The page never says
"connected" for an installation that went to someone else's organization.

**The one-time code** travels after `#`, so it never reaches a server log or a Referer header. The page removes it
from the address bar at once.

**New error reasons:**

- `github_not_admin`: the GitHub user does not administer the account;
- `used`: the install link was used already;
- `removed`: the installation was removed on GitHub.

A side effect of the new rule: the person who links must be **both** an admin of the GitHub account **and** an owner or
admin of the fenvix organization. If those are two different people, the GitHub admin installs the App, and then a
fenvix admin who is also a GitHub admin links it.

## Existing tests changed, and why

None of these removes or loosens an assertion. Each follows a behaviour the review asked for, or adds checks.

| Test | Change | Why |
| --- | --- | --- |
| `link.test.ts`, `connect-flow.test.ts` step 2, `e2e.test.ts` step 3 | The link is completed in two steps: setup, then `completeLink` as the signed-in person. The same final assertions follow (linked, trial, repositories, projects). The GitHub users of the fake are admins of their account (`githubUser`) | F1, F2: `/github/setup` no longer links. `link.test.ts` gains the F1 refusals (organization member, outside collaborator) and F2 cases (state used once; another person's, an unknown and an expired code refused) |
| `connect-flow.test.ts` step 12 | Run 31001's chunk 0 declares `chunks: 3`; it declared 1 and then sent chunks 1 and 2 | F7: "refuse `chunk ≥ chunks`". The data contract always said chunk 0 carries the total. Step 13 now also checks that a 4th chunk is dropped |
| `supabase/tests/api-rls.sql` | The admin block asserted that an admin **can** make a member an admin. It now asserts that an admin cannot, and that an admin cannot make themselves owner, demote or remove the owner, or invite an admin. The units check sets `held_minutes`, and a new check shows units follow the held minutes only | F8: the earlier assertion contradicted the API's own rule in `orgs.ts`. F3 |
| `api-dashboard.test.ts`, `tests/unit/api.test.ts` | The operation count goes from 41 to 42; `completeGitHubInstall` joins the operations without the organization header; a new test calls it with real tokens | F2, the new operation |
| `tests/api/seed.ts` | Seeded usage events set `held_minutes` to the sum of their three parts, so the seeded months keep their unit totals | F3 |
| `runners.test.ts`, `basics.test.ts` | The credential scope includes `runAttempt: 1`; the job records its mode; the install state carries its hash | F7, F4, F2 (assertions added) |

New tests besides the review's:

- `link.test.ts`: 2 new tests;
- `api-dashboard.test.ts`: 1 new test;
- `tests/unit/ci.test.ts`: the trial share is clamped;
- `gh-rls.sql`: one trial per account, none for an existing customer, the completion function (only its person, not
  expired, once; the API cannot write completions);
- `scripts/e2e-real-api.mjs`: 7 new checks of the confirm step in a real browser against the real API.

## Suites (run on this branch's HEAD, from a fresh test database and a fresh local Supabase)

| Command | Result |
| --- | --- |
| `npm run api:lint` | `openapi/fenvix-api.yaml` valid |
| `npm run build` (`api:check`, `tsc`, `vite build`) | passes; `src/api/schema.d.ts` regenerated and in step with the YAML |
| `npm run test:unit` (dashboard) | 59 / 59 |
| `npm run check` (mock: behaviour, organizations, status colours, layout, axe, screenshots) | behaviour **34 / 34**, organizations **10 / 10**, status colours **18 / 18**; screenshots: all layout checks pass, 140 pictures (the mock's install button now goes through the confirm step) |
| `node scripts/e2e-real-api.mjs` (local Supabase, real tokens) | **164 / 164** (the earlier 157 and 7 new checks of the confirm step) |
| `cd github-app && npm test` | typecheck clean; unit **95 / 95**; integration **132 / 132** (the 120 earlier tests, the 9 R-016 tests, 3 new), none skipped |
| `cd infra/github-app && npm test` | **56 / 56**, cdk-nag clean (all modes) |
| `npm run test:rls` (scratch Postgres 16; 0014 and 0015 each applied twice) | API RLS OK, CI RLS OK, CI EXPLORE RLS OK, GH RLS OK |

**Environment.**

- The App's test database and the RLS scratch database: a local Postgres 16 on port 54329.
- The local Supabase: `scripts/local-supabase/up.sh` (`supabase/postgres:15.8.1.085`, `supabase/gotrue:v2.186.0`,
  Docker). It applies 0014 and 0015 twice each.
- The screenshots that `npm run check` and the real-API pass regenerate were not committed, as in the review.

## What changed where

- **Migration `supabase/migrations/0015_review_r016.sql`** (new; safe to run twice):
  - `gh_install_completions` and `api_complete_github_link`;
  - `ci_trial_accounts` and the new `gh_link_installation`;
  - `ci_usage_events.held_minutes`, with `baseline_minutes` and `units` regenerated from it;
  - `gh_jobs.mode`;
  - delete on `gh_run_results` for the App;
  - `api_owner_workspace()` and the owner-only policies.

  The test scripts apply it (`github-app/scripts/prepare-test-db.sh`, `supabase/tests/run-local.sh`). The harness
  applies it to a test database prepared before it.
- **The App:**
  - `src/app.ts`: `/github/setup`, the runner attempt and chunk checks;
  - `src/service.ts`: `prepareLink`, held minutes, run mode, result limits, the sweep;
  - `src/results/apply.ts`: bounds, mode ignored;
  - `src/runners/credentials.ts`: attempt `a`;
  - `src/work.ts`: work kind `installation_linked`;
  - `src/auth.ts`: the state's hash.
- **The API:**
  - `src/api/github.ts`: `completeGitHubInstall`;
  - `src/api/server.ts`, `context.ts`: an after-commit hook for queueing;
  - `openapi/fenvix-api.yaml`: the new operation and the setup redirect's description;
  - regenerated `openapi.gen.ts` and `src/api/schema.d.ts`.
- **The dashboard:**
  - `src/pages/Connect.tsx`: completes `?github=confirm` and shows the new reasons;
  - `src/data/{client,api,mock}.ts`: `completeGitHubInstall`;
  - `src/data/ci.ts`: `trialFrom` clamp;
  - billing and usage wording.
- **Docs:**
  - `docs/data-contract.md`: run units, mode, result limits, linking, trial, Changes;
  - `docs/GITHUB-APP.md`: the connect flow.

## Notes for the parallel session (`claude/warm-cache-install`)

The commits are one per finding:

- the review tests;
- F1+F2;
- F3;
- F4;
- F5+F6;
- F7;
- F8;
- the real-API check;
- the data contract.

Each fix commit carries its part of `0015_review_r016.sql`. Only the final HEAD was run through the suites, not each
commit on its own.

**Merge points to watch:**

- **Migration number.** If that branch adds its own `0015_*`, renumber one of them. Both are written to be applied after
  0014.
- **`Work`.** It has a new kind, `installation_linked`, and `results` has an optional `attemptBound`.
- **The per-job credential.** It carries `a`, the run attempt. `launchRunner` passes `run_attempt`.
- **Launch.** `gh_jobs` gets `mode` at launch, next to `region`.

## Open items (decisions, not missing code)

- **Billing model.** Units now count held machine minutes (see F3). If saved time should be billed again, the runner
  repository needs a measurement the job cannot write.
- **The runner repository.** Nothing it sends changes, except:
  - results limits: 200 chunks and 256 MB per job, chunk numbers below `chunks`;
  - the `mode` it reports is now ignored.

  Its per-job credential stays opaque to it.
- **Other observations from the review** were not in the eight findings and are unchanged:
  - one throttle for the whole stage;
  - the API Lambda may send any work kind;
  - sessions are not revoked;
  - 0014 is irreversible;
  - dead chart code.
