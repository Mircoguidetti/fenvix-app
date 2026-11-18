FIX 8

# Review R-016: the dashboard wired to the API (branch `claude/dashboard-wiring`)

Reviewed 2026-11-18 at `daa9b17` (report `docs/REPORT-dashboard-wiring.md`). Review branch: `claude/review-r016`.

**Verdict: FIX 8.** There are eight findings: two High, five Medium and one Low. Each has a failing test in
`github-app/tests/integration/review-r016.test.ts`. All 9 tests fail on `claude/dashboard-wiring`.

**What holds up.** The dashboard API's own tenancy is sound. I found no IDOR, no missing organization or role check and
no token-validation gap on any of the 41 dashboard operations. The two most serious problems are elsewhere:

- **Connecting GitHub.** Someone who does not own an installation can link it to their organization (F1, F2).
- **Billing.** The run units come from a file the customer's own job writes (F3).

Threat model, as asked:

- a signed-in customer trying to read or change another customer's data;
- an attacker without an account;
- a member with a low role.

**How to run the failing tests.** Start a scratch Postgres on `localhost:54329` with a `gh_test` database, then:

```
cd github-app && node --test --test-reporter=spec --test-concurrency=1 tests/integration/review-r016.test.ts
```

`npm run test:integration` runs them too.

## Findings

| # | Severity | Area | Finding | Test |
| --- | --- | --- | --- | --- |
| F1 | High | Connect GitHub | Anyone who can **see** an organization's installation (read access to one repository) can link the whole installation to their own fenvix organization | `F1 …` |
| F2 | Medium | Connect GitHub | The install-link state is not bound to the person who completes the install. A victim who installs from an attacker's link connects their organization to the attacker's | `F2 …` |
| F3 | High | Billing | The job's own `summary.json` sets the billed baseline minutes, with no floor. A forged summary makes every job 0 units | `F3 …` |
| F4 | Medium | Trial | The run's mode (shadow/enforce) and its would-have-saved time come from the job, unchecked. The trial's share and its 35% gate are the customer's choice, and the share can exceed 1 | `F4a …`, `F4b …` |
| F5 | Medium | Trial | One GitHub account gets a new 30-day trial (units not billed) each time it reinstalls and links to a new organization | `F5 …` |
| F6 | Medium | Migration 0014 | Organizations linked before 0014 have no trial dates. Linking another installation puts an existing customer into a 30-day shadow trial: nothing is skipped for 30 days | `F6 …` |
| F7 | Medium | Runner ingestion | One per-job credential can store results for any `runAttempt` and up to 10,000 chunks of 6 MB each. Storage is unbounded and shared by all customers | `F7 …` |
| F8 | Low | RLS (second barrier) | As `fenvix_api`, an admin can make themselves owner, remove an owner, or invite an admin. The owner-only rules exist in the API's code only | `F8 …` |

### F1 (High): a GitHub user with read access to one repository links the whole installation to their own organization

**Where.** `github-app/src/app.ts:205-236` (`/github/setup`).

**What the check does.** The setup callback requires three things:

1. a valid state, signed for the caller's own organization;
2. an OAuth code;
3. that `GET /user/installations` lists the installation for that person.

**Why that is not enough.** GitHub lists an installation for *every* user with explicit access to any repository in it:

- members of the organization;
- outside collaborators, even read-only ones.

**The attack.**

1. The attacker is the owner of their own fenvix organization, and only a read collaborator on one repository of
   `acme`.
2. They take their own install-link state, get an OAuth code for the App (the public `/login/oauth/authorize`), and
   call `/github/setup?installation_id=<acme's>&state=<theirs>&code=<theirs>`.
3. This works on any installation that is not linked yet. That is the normal state after:
   - a Marketplace install;
   - GitHub's own "Install" button;
   - an org owner approving a member's install request (the owner's redirect carries no fenvix state);
   - an earlier `/github/setup` error.

**The result.**

- `gh_link_installation` links it. The attacker's organization then lists every repository of the installation,
  private ones they cannot read on GitHub included.
- The attacker receives those repositories' runs, test ids, failure messages, receipts (file paths, env digests) and
  defects.
- The attacker can make the App open setup pull requests in them (`POST /v1/github/repositories/{id}/setup-pull-request`).
- The real owner is then refused with `other_organization`. There is no unlink.

**Test.** `F1` links `acme`'s installation for a collaborator who is not an `acme` member. It asserts that the
installation must not end up in her organization. It is linked today.

**Fix.**

- Require the OAuth user to be an admin of the installation's account:
  - for a `User` account: `account.id === GET /user .id`;
  - for an `Organization`: `GET /user/memberships/orgs/{org}` with `role: admin` and `state: active`.
- Without that, answer `?github=error&reason=not_admin`.
- The fake GitHub in this branch now answers both calls (`users`, `orgRoles`).

### F2 (Medium): the state proves who asked for the link, not who completes it

**Where.** `github-app/src/app.ts:205-236`, `github-app/src/api/github.ts:23-27`, `github-app/src/auth.ts:33-54`.

**The problem.**

- The state is an HMAC of `{organization, person, expiry}`, valid for 1 hour.
- It is not bound to the browser that completes the install, and it is not single-use.

**The attack.**

1. An attacker who is admin of their own fenvix organization calls `POST /v1/github/install-link`.
2. They send the resulting genuine `https://github.com/apps/<slug>/installations/new?state=…` link to a victim who is
   an admin of a GitHub organization ("install fenvix on globex so we can set up CI").
3. GitHub sends the victim back with the attacker's state and the *victim's* OAuth code. Every check passes, because
   the victim is a real admin.
4. The victim's installation is linked to the attacker's organization, and the victim is shown
   `?github=connected&account=globex`.
5. The same link works again for an hour, for other victims.

This remains after F1 is fixed, because here the person completing the install really is an admin.

**Test.** `F2` asserts that the installation does not end up in the attacker's organization.

**Fix.** Complete the link in the signed-in person's own session:

- `/github/setup` verifies the code and the installation, then redirects to the dashboard with a short-lived,
  single-use completion code;
- the dashboard calls the API with the person's Supabase token;
- the API checks that the token's user is the state's user before calling `gh_link_installation`.

Also consume the state's nonce once it is used.

### F3 (High): the customer's job decides how many units it is billed

**Where.** `github-app/src/service.ts:690-705` (publish) and `supabase/migrations/0014_dashboard_api.sql` (`baseline_minutes`, `units`).

**The formula.**

```
baseline = test_seconds_run/60 + test_seconds_saved/60 + max(0, job minutes - wall_seconds/60)
```

All three inputs come from `summary.json`.

**Why the customer controls it.**

- The job-completed hook reads `summary.json` from `$RUNNER_TEMP/fenvix/summary.json`, or from `FENVIX_SUMMARY_PATH`
  (`infra/github-app/lib/runner/files/fenvix-job-completed`).
- That is a file the customer's workflow writes as the job user, and the poster sends it as is.
- The spool directory is group-writable by the job user, so the job can also queue any spool file directly.

**The effect.**

- A summary with `test_seconds_run: 0`, `test_seconds_saved: 0` and a large `wall_seconds` gives 0 baseline minutes and
  0 units for a job that held our machine for an hour.
- Without a summary, the same job is billed the full 60 minutes. Sending a forged summary is strictly better for the
  customer.

**Test.** `F3` runs a 60-minute job with such a summary and gets `baseline_minutes = 0`.

**Fix.**

- Floor the baseline at the minutes the machine was held (GitHub's `started_at` → `completed_at`, which the job cannot
  change), i.e. `baseline ≥ job minutes`.
- Clamp `wall_seconds` to the job's duration.
- Treat `test_seconds_saved` as a claim to verify (receipts), not as billing input.

### F4 (Medium): the trial's numbers are the job's to choose

**Where.**

- `github-app/src/service.ts:738` (`summary?.mode ?? org.mode`) and `:830` (`mode = coalesce($20, mode)`);
- `github-app/src/results/apply.ts:159` (`mode = coalesce($5, mode)`) and `:231-242` (`would_save_ms`);
- `src/data/ci.ts:312` (the share).

**The mode.**

- The App knows the organization's mode (`orgContext`: shadow while the trial runs) and passes it to the machine.
- But the run row takes the mode from `summary.json` and from the results chunk, both written by the job.
- During the trial, a job can say `enforce`: the engine skips tests during the free trial, and the run drops out of
  the trial's numbers.
- The trial's share, minutes and 35% gate count only the runs the job chose to call shadow.

**The would-have-saved time.**

- `would_save_ms` is the sum of `durationMs` of the tests marked `wouldSkip`, with no bound.
- One test of 1e9 ms makes the would-skip share far above 1. The contract says shares are 0 to 1.
- The gate is then met whatever happened.

**Tests.**

- `F4a`: the run is stored as `enforce` during the trial.
- `F4b`: `would_save_ms` of 1,000,000,000 for a run whose tests took 298 ms.

**Fix.**

- Store `orgContext(c).mode` (decided at job start, on `gh_jobs`), never the job's word.
- Bound `would_save_ms` by the run's own test time.
- Bound each `durationMs` by the job's duration.
- Clamp the share to [0, 1] in `trialFrom`.

### F5 (Medium): a new 30-day trial per reinstall

**Where.** `supabase/migrations/0014_dashboard_api.sql:460-492` (`gh_link_installation`).

**What happens.**

- The trial is per fenvix organization: `coalesce` on that organization's own subscription.
- The same GitHub account can do this:
  1. uninstall the App;
  2. install it again, which gives a new installation id;
  3. create a new organization (`POST /v1/organizations`, up to 50 per person; or a new sign-up);
  4. link the new installation to it.
- It then gets another 30-day trial in which units are not billed, every 30 days.
- `ci_subscriptions.github_account` is recorded but not consulted.

**Test.** `F5` asserts that the second organization gets no trial.

**Fix.** Start a trial only for an installation account (`account_id`) that never had one. Record the trial per
`account_id`, not only per organization.

### F6 (Medium): migration 0014 puts existing customers into a shadow trial

**Where.** `supabase/migrations/0014_dashboard_api.sql:171-174` (new trial columns, null for every existing
subscription) and `:484-489`.

**What happens.**

- An organization whose installation was linked before 0014 has `trial_started_at = null`.
- When it links another installation (another GitHub account, which the report advertises), `coalesce(null, now())`
  starts a 30-day trial.
- For 30 days every job of every repository runs with `FENVIX_MODE=shadow`. Nothing is skipped, so the paying
  customer's CI becomes slower.
- The Overview shows a trial.
- The report's "linking a second installation does not restart the trial" holds only for organizations linked
  after 0014.

**Test.** `F6` models a pre-0014 link and then links a second installation.

**Fix.** Do one of these:

- in 0014, give every organization that already has a linked installation trial dates in the past;
- in `gh_link_installation`, start the trial only when the organization has no other linked installation.

### F7 (Medium): one job's credential can fill the shared database

**Where.**

- `github-app/src/app.ts:186-191`;
- `github-app/src/results/runner-records.ts:124` and `:263-264`;
- `github-app/src/service.ts:562-575`;
- `gh_run_results` in 0014.

**What the credential limits, and what it does not.**

- A per-job credential names the runner, the repository and the run. It does not name `runAttempt`, which comes from
  the body.
- `chunk` may be anything from 0 to 9999, and is not checked against the `chunks` that chunk 0 declares.
- Each `(attempt, chunk)` is a new `gh_run_results` row of up to 6 MB, stored for good. It is never deleted, not even
  once applied.
- As in F3, the job writes what its machine sends.

**The effect.** One job can store 9,999 × 6 MB per attempt, for any number of attempts, in the database every customer
shares. Results for attempts that do not exist are accepted with `202`.

**Test.** `F7` stores 41 foreign chunks (attempts 2–41, chunk 9999, and chunk 9999 after `chunks: 1`) with one job's
credential.

**Fix.**

- Put `runAttempt` in the per-job credential (the App knows it when it launches the machine), or check it against
  `gh_jobs`.
- Refuse `chunk ≥ chunks`.
- Cap the rows and bytes per job.
- Delete applied payloads after the run is published, or after N days.

### F8 (Low): row level security does not hold the owner-only rules

**Where.** `supabase/migrations/0014_dashboard_api.sql:319-331`. These are the update and delete policies on
`workspace_members`, and the insert policy on `workspace_invites`, all keyed on `api_admin_workspace()`.

**The gap.**

- The report calls RLS the second barrier.
- In the database, an admin acting through `fenvix_api` can:
  - promote themselves to owner;
  - delete an owner (when two exist);
  - create an `admin` invitation.
- The rules "only an owner manages admins and owners" and "only an owner invites an admin" live only in
  `github-app/src/api/orgs.ts`.
- One missing check there, and an admin takes the organization over.
- `supabase/tests/api-rls.sql` tests member vs admin, but not admin vs owner.

**Test.** `F8`, run as `fenvix_api` against the test database.

**Fix.** Add policies or a trigger:

- a `with check` on role changes that allows `owner`/`admin` targets only when `app.user_id` is an owner;
- a delete policy that allows removing an owner or admin only for an owner;
- an invite insert check of `role = 'member' or caller is owner`.

## What I attacked and found sound

**1. Tenancy and auth on every endpoint.** All 41 dashboard operations were read against `server.ts`, `orgs.ts`,
`data.ts` and `github.ts`.

- **Token.** Checks on every call:
  - JWKS signature with ES256, RS256 or EdDSA only (no HS256, no `none`);
  - `iss = <supabase>/auth/v1`;
  - `aud = authenticated`;
  - `exp`, checked by jose;
  - `sub` must be a UUID.

  `onRequest` answers 401 before validation or the database.
- **Workspace.** `X-Fenvix-Workspace` is validated as a UUID, then the membership is read in the same transaction. The
  API answers 404 for both a non-member and an unknown organization, and 403 by role from the spec's `x-fenvix-role`.
  Spoofing the header gains nothing.
- **IDOR.** Every path or query id is filtered by `workspace_id` before use: project, run, receipt, defect, repository,
  member, invitation, `projectId` in queries. The run's ETag is computed only after the run is found in the
  organization, so `If-None-Match` cannot probe another organization's runs.
- **Invitations.**
  - Only the hash of the token is stored.
  - One identical 404 covers every refusal.
  - The e-mail must match and be verified.
  - Admins cannot invite admins.
  - There is a 20-a-day limit in the database.
- **Region.** `PUT /settings` needs admin, and the RLS update policy needs `api_admin_workspace()`.
- **Browser access.** On the live local Supabase, `anon` and `authenticated` have no table grants in `public`. The only
  functions they can still execute are `handle_new_user()` and `ci_touch_updated_at()`, both trigger functions that
  cannot be called through RPC.

**2. Setup pull request by repository id.** It checks `workspace_id` and answers 404 otherwise, and the worker uses the
repository's own installation. It is sound in itself, but F1 lets an attacker hold the repositories in the first place.

**3. Runner identity.** The repository, runner and run come from the credential, never the body. Results, progress and
explorations cannot reach another organization's rows: every write uses the job's own workspace transaction with
`cp_workspace()` RLS. The receipt's `reused_run_id` and the defect links are limited to the same project.

**4. ETag and caching.**

- `GET /v1/runs/{id}` sends `private, no-cache` and `Vary: Authorization, X-Fenvix-Workspace, Origin`.
- Everything else sends `no-store`.
- The HTTP API has no stage cache and no CloudFront. `vercel.json` only rewrites the SPA and does not proxy `/v1`.
- The client fetches with `cache: "no-store"` and `credentials: "omit"`, and resets its ETag when the run changes.
- No cross-organization leak.

**5. Old product removed.** I diffed every trigger and policy on a database at 0013 against one after 0014. The
cascades dropped only the old product's objects and the intended `workspace_members_revoke_public_keys`. No kept trigger
or policy was lost.

## Observations (no failing test; for the founder to weigh)

- **0014 is irreversible.** It drops tables with data: `invoices`, `audit_log`, `data_audit_log`, `api_keys` and others.
  There is no down migration and no archive step. Take and keep a dump of those tables before applying 0014 in
  production, especially `invoices` and the audit logs, which may have retention duties.
- **Dead code of the old product** remains in the dashboard:
  - `AwakeAreaChart` and `WakeTimeline` in `src/components/charts.tsx` ("awake databases");
  - other unused chart exports;
  - the database and data-explorer sections of `src/styles.css`;
  - the "Databases" sample in `Styleguide.tsx`.
- **The `DashboardApi` Lambda may send any work kind to the App's work queue,** although it needs `onboard` only. The
  worker trusts every message (webhook, summary, results). If the API Lambda were compromised, it could inject forged
  webhooks or summaries for any repository, bypassing the per-machine credentials of R-012. Consider a separate queue,
  or a message attribute the worker checks.
- **One throttle for the whole stage.** The HTTP API stage throttle (50 rps, burst 100) is shared by dashboard calls,
  GitHub webhooks and runner records. Unauthenticated `/v1/*` requests count against it, so an attacker without an
  account can delay webhook deliveries and runner records. Consider per-route throttles, at least for
  `/webhooks/github` and `/v1/runner/*`.
- **Sessions are not revoked.** A signed-out or deleted Supabase session stays valid until its JWT expires (1 h). The
  API does not reject anonymous Supabase users (`is_anonymous`); keep anonymous sign-ins disabled in the project.
- **The trial gate is computed from engine-reported data.** Even after F4 is fixed, the 35% gate rests on what the
  engine reports from the customer's machine. If the gate ever decides money (a refund, a price), it needs a check the
  job cannot write.

## Suites (run as the report lists, on this branch: `daa9b17` plus the review test)

SUITES_TABLE

Changes on this branch besides this document:

- `github-app/tests/integration/review-r016.test.ts`: the failing tests.
- `github-app/tests/helpers/fake-github.ts`: `GET /user` and `GET /user/memberships/orgs/{org}`, which a fix of F1 needs.
  Nothing else in the fake changed, and every existing test still passes.
