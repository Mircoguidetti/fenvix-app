PARTIAL (founder steps only): (1) approve the merge, which deploys; (2) App permission "Actions: Read and write"; (3) organization permission "Self-hosted runners: Read and write" (G-1726); (4) mail provider credential (G-1756, G-2310); (5) DNS record and certificate for mcp.fenvix.dev; optional (6): the Member, Organization, Membership and Team events plus "Members: Read-only" (G-1631 revocations at once).

# P-048 · Passo 3 · Service back-end, PR comment, remote MCP (F-12, F-14, F-19 API side, F-13 data side)

Branch `claude/service-backend` of fenvix-app. Written 2026-11-20. Scope: the 130 audit rows of
`sessions/2026-11-20-gap-audit/REPORT.md` (fenvix-engine-cli, branch `claude/gap-audit`) whose area starts with
"Service /" or "Branches / App-engine", minus Dashboard, Infra, Security, Runner orchestration, Deploy, Operations,
Multi-language, Tests, Config (P-047/P-049) and Billing, Other platforms, Any runner (out of the go-live scope), plus
G-0187 (named in the task).

**What PARTIAL means here.** Everything else is built, and it is green locally (MEASURED, below), including the end-to-end path on a
scratch merge with P-047's branch and the REAL machine agent (`fenvix-agent`). The founder steps above are the only blocks
on this branch's side:

1. Approve the merge (it deploys to AWS).
2. App permission "Actions: Read and write": the check run's Re-run button, and Stop cancelling the GitHub job. The
   code works without it and says so.
3. Organization permission "Self-hosted runners: Read and write" (G-1726, P-047's runner groups). Personal accounts keep
   repository Administration.
4. A mail provider credential (G-1756, G-2310).
5. DNS record and certificate for `mcp.fenvix.dev`. The MCP server answers at `https://api.fenvix.dev/v1/mcp` today.
6. Optional: tick the events Member, Organization, Membership and Team, with "Members: Read-only", so G-1631
   revocations apply at once instead of within 10 minutes.

**Not a founder step, and not in either repository (said plainly).** Nothing sends progress, results chunks or defect
bundles yet: the engine (fenvix-engine-cli) is the sender of those records. `fenvix-agent` sends the job's summary and
the replay outcomes. Until the engine sends them, a defect in production comes from the summary's `flaky[]`. It is
`reported`, with its replay command, but has no divergent event and no bundle, and the live test view has no per-test
rows. The contract the engine needs is `docs/data-contract.md` "1b", "2b" and "Run progress".

## What is now true (the goal, item by item)

| Item | Now true | Evidence |
| --- | --- | --- |
| 1. Results API | Runner progress, results chunks (tests, receipts, defects, audit reruns), defect **bundles** (`POST /v1/runner/bundles`), replay reports and explorations are received, checked against the contract and stored under row level security. Production tables stay empty until the runner sends (P-047). | `backend.test.ts` steps 2, 3; `backend-rls.sql` |
| 2. Memory across runs, dedup | **One defect per flaky test of a project** across runs and PRs (`ci_defects` unique on project + test), with every sighting in `ci_defect_occurrences` (run, commit, branch, PR, fingerprint, `fingerprintChanged`, divergent event). Replay command, first divergent event and bundle on every defect. Flaky tests named only by the summary are defects too (`reported`). | `backend.test.ts` steps 3, 5, 9, 10 |
| 3. PR comment, check runs | ONE comment per PR made from **every** fenvix job of the head commit (a green job never hides a red one; running jobs shown as running); per defect: cause (first divergent event), seed, minimal order, replay command, pull command, "replay it on fenvix" link, how often seen across PRs; skip-with-proof summary; culprit and dependency verdict lines appear when the defect carries them (`ci_defects.culprit`, `dependency_verdict`). One check run per job (`fenvix / <job>`), with annotations; a job that gets no machine gets an `action_required` check run saying why. Every open PR whose head is the commit gets the comment. | `backend.test.ts` steps 1, 3, 4; `backend-gaps.test.ts` G-2318; `results.test.ts`, `e2e.test.ts` |
| 4. Replay on our machines | Dashboard / API key (scope `replay`) / MCP / PR link → `ci_replays` → scheduler → `launchTask` (P-047's fleet) → machine fetches the bundle and reports → result on the defect; 10/10 passing on a commit that never saw it marks it **fixed**. At most one in flight per defect, 10 a day. | `backend.test.ts` step 8 |
| 5. API keys, documented API | Keys per organization (`fxk_…`, SHA-256 stored, shown once, scopes `read`/`replay`, revocable, optional expiry), owners/admins manage them; keys read runs, defects, bundles, explorations (`x-fenvix-key` in `openapi/fenvix-api.yaml`), never anything else; per-key and per-person rate limit. The contract documents every route, `/healthz`, `/webhooks/github`, `/github/setup` included. | `backend.test.ts` step 6; `api-dashboard.test.ts` (69 operations, real GoTrue tokens) |
| 6. Remote MCP server | `POST /v1/mcp` (MCP 2025-06-18, streamable HTTP, JSON): the agent loop `failures_for`, `get_test_log`, `wait_for_run`, `replay`, and `list_projects`, `list_runs`, `list_defects`, `get_defect`, `pull_bundle`, `request_replay`, `get_replay`; each tool is an API operation run with the key (same RLS, scopes, rate limit). `mcp.fenvix.dev`: DNS/certificate not made (infra). | `backend.test.ts` steps 7, 8 |
| 7. Shadow trial label | **Removed until real**: no runner reads `FENVIX_MODE`, so trial runs are started and labelled `enforce` (what happens). `SHADOW_MODE=true` turns shadow back on once P-047's runner runs it. | `backend-gaps.test.ts` G-0187 |
| 8. Live run control | `POST /v1/runs/{id}/stop` (now, first failure, off; owners and admins, not keys): within a minute the GitHub run is cancelled (needs Actions: write) and the machine ended; `Run.stop` says armed / requested / done / failed. `POST /v1/runs/{id}/replays` replays one test; `GET /v1/runs/{id}/tests/live` the tests as they finish. | `backend.test.ts` step 11; `api-dashboard.test.ts` |

## Round 2 (after the coordination messages)

- **Migration renumbered 0019** (the coordinator gave 0018 to P-047's machines); 0019 runs after it.
- **P-049's "Live test view" contract merged and served**: `listLiveTests`, `stopRun` (now / first failure / off,
  owner or admin; replaces my `cancelRun`), `listReplays`, `replayTest`, `getReplay` (P-049's `Replay` shape; my defect
  replays fill it, `runId` may be null), `listDefectOccurrences` (`/occurrences`, P-049's fields plus mine), `getDefectBundle`
  (a signed 5-minute link; the bytes are `downloadDefectBundle`, which the pull command and MCP use), runs filtered by
  pull request and branch, `Run.stop`/`job`/`githubRunId`/`githubJobId`, `RunProgress.workers`, per-test `worker`/`seq`/
  `finishedAt`, `Defect.firstPullRequest`, divergence `passing`/`failing`. The runner's progress takes `finished` and
  `workers` (docs/data-contract.md "1b").
- **The coding agent's loop (founder addition to F-14)**: MCP tools `failures_for`, `get_test_log`, `wait_for_run`,
  `replay` (waits up to 20 s per call; the API function stops at 29 s), documented in the server's `initialize`
  instructions and the README; API operations `listFailures`, `getTestLog`. A test's full output needs the runner to send
  `output` (P-047).
- **`FENVIX_SKIP`** written for P-047's runner (0 in shadow mode or when skip with proof is off or paused).
- Evidence: `backend.test.ts` steps 5, 7, 8, 11 (signed link, the agent loop on a PR, replay verdict, live tests and the
  first-failure stop, failures and log); `api-dashboard.test.ts` (68 operations, the admin matrix with `stopRun`,
  `replayTest`).

## Round 3 (G-1631 and the decided rows)

- **G-1631 built** (row above): `gh_repo_access` (the App's answers), `gh_github_identity()` (the GitHub sign-in
  Supabase Auth verified, else the GitHub user an install link was completed with; never typed text),
  `api_viewer()`, `api_visible_projects()`, the read and write policies of every project table, `gh_repo_access_due()`
  and `gh_repo_access_forget()` (migration 0019, section 13); `github-app/src/access/visibility.ts` (asked each sweep,
  200 answers per sweep at most, DECLARED); the revocation events. A person who signed in with Google or an email
  link sees public repositories' projects only, until they sign in with GitHub once (P-049: the dashboard can say so).
  The events `member`, `organization`, `membership` and `team` reach the App only if they are ticked in its settings
  (the organization ones also need the organization permission "Members: Read-only"); without them an answer lives 10
  minutes at most. Founder action, optional.
- **The bundle pull command** in the PR comment and the API now downloads `/v1/defects/{id}/bundle/download` (the
  bytes); `/bundle` answers the signed link since round 2, so the old command would have fed JSON to `tar`.
- **Out of scope with the rule**: G-0599, G-0618, G-0625, G-1723, G-2299.
- **G-1726**: agreed with P-047. They implemented the runner side; this branch implemented what the user is told (row above).

## Round 4 (scratch merge with P-047's claude/our-machines; the real agent end to end)

Coordinator, 2026-11-20: merge the two branches as a scratch merge, run the end-to-end path with the real sender, and
make the two PRs merge cleanly. The merge commit is local (`scratch/merge-047`, f28c534). It is pushed nowhere, because
this session pushes only to its own branch. Every suite is green on it (MEASURED, local): App unit **147/147**,
integration **225/225** (local Postgres + local Supabase migrated with 0018 + 0019), RLS **7/7** on scratch Postgres and
on the Supabase image (`machines-rls.sql` included), infra **135/135** (P-047's root sandbox tests ran, with iproute2
installed), deploy **87/87**, dashboard 73 + build + API lint.

**The end-to-end test with the real sender** (`github-app/tests/integration/real-agent.test.ts`, in the merge). The App
is served over HTTP, and the real `fenvix-agent` (Python) runs as each machine of the pool. GitHub and EC2 are the fakes,
and the slot sandbox is a stand-in that plays the job (it writes the engine's summary, or a replay's outcome). Nothing
stands in for the agent. Steps: the pool starts a machine, and the agent says hello with its boot secret. A pull
request's fenvix job is leased to the machine; the agent runs it in a slot and sends the summary with the JOB's
credential. GitHub completes the job: the PR comment and the check run name the flaky test, the API and MCP show the
same defect. A replay asked through MCP becomes a pool lease on that customer's machine; the agent runs it and sends the
outcome with the machine's session, and the API's replay and the defect's `lastReplay` show it. 5/5 green.

**The resolution, so the two PRs merge cleanly.**

- `service.ts`, the jit conflict: P-047's `runnerTarget` (organization runner group or repository) with
  `allow: [403, 409]`. A 403 gives the check run naming the permission for the account type (G-1726, this branch).
- Dispatch: P-047's machine sizes and project test command, plus this branch's skip pause (G-1757). `FENVIX_SKIP=0` and
  no cache credential when skip with proof is off **or paused**.
- **One stop**: the API's `ci_runs.stop_*`. P-047's `Service.stopRun` (Work `stop_run`) now writes the same rows. A stop
  armed for the first failure fires on the progress record that carries it (GitHub run cancelled, the job's slot lease
  ended at once), and the sweep resends only after 2 minutes (`ci_runs.stop_sent_at`). `gh_jobs.stop_*` (0018) is no
  longer used; P-047 may drop it.
- **One replay path**: the API's `ci_replays` (dashboard, key, MCP, PR link) run as P-047's `gh_replays` leases, linked
  by `gh_replays.ci_replay_id` (0019 section 14, applied only where 0018 made the table). The replay's own commit is
  used (`gh_replays.commit_sha`). The agent's outcome comes back to `ci_replays` with the same "fixed on 10 of 10" rule
  (`Tasks.finishPoolReplay`), and a lease lost with its machine fails the API's replay with the reason.
- **One `POST /v1/runner/replays`**: both registered it, and Fastify refuses a duplicate. The single route serves a
  machine session (`fxm1.`, the agent) and a task credential (`fxr1.`).
- Stop on the pool: `PoolLauncher.terminateRunner` ends the job's lease (the agent wipes the slot at its next poll).
- Shadow mode is on with the pool (P-047 runs it: `FENVIX_MODE`, and no cache credential until the engine honours it).
  Without the pool it stays off unless `SHADOW_MODE=true` (G-0187).
- **One webhook redelivery**: P-047's `redeliverFailed` (deduplicated in `gh_redeliveries`), now also skipping a delivery
  GitHub delivered later. This branch's lost-job readback calls it, so a failed delivery gets one new attempt, not two.
- Progress parsing: this branch's fields (`output`, `finishedAt`, worker `state`), with P-047's redaction (G-1787)
  applied to the divergence description and events and to test output, plus a rule for `fxk_` API keys.
- Scripts and docs: migrations 0018 then 0019 in `prepare-test-db.sh` and `run-local.sh`, both RLS checks, and both
  change logs.
- P-047's live-view test asserts the unified stop (`ci_runs`, `ci_test_results`) instead of `gh_jobs.stop_*`.

The parts that do not need P-047's code are already on this branch: the immediate first-failure stop, `stop_sent_at`, the
shared replay finish and the pool hook in `Tasks`, and 0019 section 14. The rest is the merge commit. Proposed order: PR
#23 merges first, then this branch merges `main` with this resolution (re-run green before pushing), and PR #22 then
merges with no conflict.

## Numbers

- Tests, MEASURED on this branch, locally (`npm test` in `github-app`, local Postgres 16 + local Supabase from
  `scripts/local-supabase/up.sh`, 2026-11-20): unit **141/141**, integration **211/211** (on `main`: 141 + 136 with the two local-Supabase API suites skipped,
  MEASURED the same way before any change). New: `backend.test.ts` (13 steps), `backend-gaps.test.ts` (23),
  `api-dashboard.test.ts` +1 test and +11 matrix rows.
- Row level security, MEASURED: `npm run test:rls` 6/6 files OK on scratch Postgres 16, and `backend-rls.sql` OK on the
  real Supabase image `supabase/postgres:15.8.1.085` (new CI step). A mutation check (an API read policy opened to
  `true`) makes `backend-rls.sql` fail with "READ LEAK: A's owner reads B's ci_defect_bundles": the test can fail.
- Infra **142/142**, deploy **87/87** (with the local Supabase test running), dashboard lint + build + unit green, MEASURED locally. Final numbers of the whole
  local run are in the last section.
- Bundle size limit 4 MB decoded: ESTIMATED from API Gateway/Lambda's 6 MB request cap (base64 adds 4/3: 4 MB → 5.3 MB).
- Rate limits 600 requests/minute per person, 300 per key: DECLARED in `github-app/src/api/server.ts` (`RATE_LIMITS`).
- Retention DECLARED in migration 0019: per-test results, receipts, audit reruns 180 days after the run; runs 400
  days; webhook delivery records 30 days; everything of an installation 30 days after its uninstall.

## Per row

Status words: **FIXED** (with the regression test), **OUT OF SCOPE** (with the scope rule), **NOT REPRODUCIBLE**
(with evidence), **OPEN** (not done in this session, with why), **BLOCKED** (needs someone outside this session).

### WRONG-RESULT first

| Row | Status | What is now true / why | Evidence |
| --- | --- | --- | --- |
| G-0184 | FIXED | A flaky test the summary names is a defect (`reported`, `unknown` cause, the summary's replay command); a bundle later replaces it. | `backend.test.ts` "10." |
| G-0187 | FIXED | Shadow label off unless `SHADOW_MODE=true`; trial runs are `enforce`, machines get `FENVIX_MODE=enforce`. | `backend-gaps.test.ts` "G-0187"; `connect-flow`/`review-r016` run with `SHADOW_MODE=true` |
| G-0189 | FIXED | The comment combines every fenvix job of the head commit; a later green job never overwrites a red one. | `backend.test.ts` "4." |
| G-0194 | FIXED (Python/Node) / OUT OF SCOPE (Go, JVM) | A bundle without a language in a project that is not Python or Node is no longer labelled Python: it is left out and logged (`defectRowOrNull`). Go/JVM storage: go-live languages are Python and Node only. | `apply.ts`; unit-tested through `backend.test.ts` (Python), code path for other languages |
| G-1809 | FIXED | Defects become fixed (replay 10/10 on a later commit), muted, reopened (any member; audit-logged). | `backend.test.ts` "5.", "8." |
| G-1811 | FIXED | An organization without members is deleted (trigger). | `backend-rls.sql` "ORPHAN"; `backend-gaps.test.ts` "G-1626, G-1811" |
| G-1813 | FIXED | Usage events survive their organization and installation (`on delete set null`). | `backend-rls.sql`; `backend-gaps.test.ts` retention test |
| G-1814 | FIXED | Writer path anchored: a project must belong to the organization its installation is linked to (trigger); every child row takes its parent's organization; the App naming A cannot write into B's project, run, defect, occurrence or bundle. | `backend-rls.sql` "ANCHOR" checks |
| G-2332 | OUT OF SCOPE | The admin connection string the deploy pipeline holds is a Deploy credential (Deploy area: P-047). FORCE RLS would not stop a role with BYPASSRLS. | — |
| G-2340 | FIXED | An invited sign-up gets no empty organization of its own. | `backend-rls.sql` (invited sign-up) |

### Service / API

| Row | Status | What is now true / why | Evidence |
| --- | --- | --- | --- |
| G-0569 | FIXED | API keys + key-readable documented API. | `backend.test.ts` "6." |
| G-1625 | FIXED | `POST /v1/defects/{id}/state` (fix, mute, reopen) + automatic fix by replay. | `backend.test.ts` "5.", "8." |
| G-1626 | FIXED | Delete organization (owner, typing its name), disconnect project (admin), delete own account; export (G-2283). | `backend-gaps.test.ts`; `api-dashboard.test.ts` |
| G-1627 | FIXED (API) / OUT OF SCOPE (gateway) | Per-person and per-key limits in the API (`api_rate_hit`, 429 + Retry-After). The shared API Gateway stage throttle is Infra (P-047). | `backend-rls.sql` rate limit; `server.ts` |
| G-1628 | FIXED | Defects and families take `limit`/`offset`, answer `total`. | `backend-gaps.test.ts` "G-1628" |
| G-1629 | OPEN | `listRuns?since=` still answers up to 20,000 runs (BUILD-LATER; the dashboard P-049 depends on it). | — |
| G-1630 | OPEN | Overview/usage/billing totals still computed in memory (BUILD-LATER). | — |
| G-1631 | FIXED | Founder decision (coordinator, 2026-11-20): a member sees a project only while GitHub says their GitHub identity can see its repository. The App asks GitHub with the installation's token (`GET /repos/{o}/{r}/collaborators/{login}/permission`, Metadata: read), keeps the answer 10 minutes at most and asks again after 4 (each sweep); no answer, an old answer, "none", or no GitHub identity (Google or email sign-in only) hides the project and **every** row of it (runs, tests, receipts, defects, occurrences, bundles, replays, explorations, warm-ups, usage) from the API, keys (a key acts as the member who made it, and sees nothing private once they leave) and MCP; writes (state, stop, settings, replay, disconnect) follow. Public repositories: every member. Revocation events (`member`, `organization`, `membership`, `team`, `repository.privatized`) drop the answers at once. | `backend.test.ts` step 13; `backend-rls.sql` "G-1631" (scratch + Supabase image; a mutation opening `api_visible_projects()` fails it with "VISIBILITY LEAK") |
| G-2228 | OUT OF SCOPE | The dashboard client (P-049) decides whether to call getOrganization. | — |
| G-2229, G-2230, G-2231 | FIXED | `/healthz`, `/webhooks/github` (answers, headers, events) and `/github/setup` (every redirect reason) are in the contract (tag `app`). | `npm run api:lint` |
| G-2232 | OPEN | `GET /github/repositories` not paginated (MINOR). | — |
| G-2233 | OPEN | No Idempotency-Key (MINOR). | — |
| G-2234 | FIXED | Tokens must carry `exp`; a session that no longer exists in `auth.sessions` is refused at once. | `backend-gaps.test.ts` "G-2234" |
| G-2235 | OUT OF SCOPE | API Gateway's own error responses are Infra (P-047). | — |
| G-2236 | NOT REPRODUCIBLE | By design: Vercel previews build with `VITE_DATA_BACKEND=mock` and never call the API (README "Deploy on Vercel"). | README |
| G-2237 | FIXED | An HS256 token is answered 401 with how to switch Supabase to signing keys. | `backend-gaps.test.ts` "G-2237" |

### Branches / App-engine and Service / Engine contract

| Row | Status | What is now true / why | Evidence |
| --- | --- | --- | --- |
| G-0199 | FIXED (service side) | The printed pull command is now real: `curl` with an API key on `GET /v1/defects/{id}/bundle` + `tar` (`pullCommand`). A `fenvix defects pull` CLI command is engine work. | `backend.test.ts` "3.", "6." |
| G-0200, G-0595 | OUT OF SCOPE (sender) / FIXED (service) | The sender is the runner (P-047). The App now schedules explorations itself and gives them machines (G-0597). | `backend-gaps.test.ts` explorations |
| G-0201, G-0594 | OUT OF SCOPE | The sender of results is the runner (P-047). The API side receives, stores and shows them. | `backend.test.ts` "3." |
| G-0202 | OUT OF SCOPE | The summary's producer is the runner (P-047). | — |
| G-0203, G-1717 | OUT OF SCOPE | The warm-up executor is runner/engine (P-047). | — |
| G-0593 | OUT OF SCOPE (engine CLI) / FIXED (service) | The service now has what a CLI needs: API keys, a documented key-readable API, bundle download, MCP. A CLI login/upload is engine work. | — |
| G-0596 | OUT OF SCOPE | Wrapping the customer's test step in the engine is the runner's (P-047). | — |
| G-0654 | OUT OF SCOPE | The audit page's data needs the engine's audit reruns (engine). The service stores them and pauses skipping on a wrong skip (G-1757). | — |
| G-0655, G-1716 | OUT OF SCOPE (sender) | The runner sends progress (P-047); the API stores it and serves it to the live view. | `backend.test.ts` "2." |
| G-1718 | FIXED (link) / OUT OF SCOPE (receipts) | The comment's receipts link is the dashboard run page, which shows receipts once the runner sends them (P-047). | `backend.test.ts` "4." |
| G-1719 | OUT OF SCOPE | What the poster sends is the runner's (P-047). | — |
| G-2291 | OUT OF SCOPE | The engine/runner reading `FENVIX_*` is P-047's; the contract now also says `FENVIX_CACHE_ACCESS=none` and `FENVIX_KIND=replay|exploration`. | `docs/data-contract.md` |
| G-2292 | OPEN | No schema version on runner records (MINOR; needs both sides). | — |

### Service / GitHub App and webhooks

| Row | Status | What is now true / why | Evidence |
| --- | --- | --- | --- |
| G-0598 | BLOCKED | The App exists (App ID 5846807, DECLARED in the task). A real-GitHub run needs P-047's machines. | — |
| G-0599 | OUT OF SCOPE | GitHub Enterprise Server. Rule: go-live scope: github.com only, Linux x86_64 only, GitHub Actions only, jobs only on our machines, no billing (coordinator, 2026-11-20). | — |
| G-1725 | FIXED | A 403 from `generate-jitconfig` gives an `action_required` check run naming the permission, no silent retries. | `backend-gaps.test.ts` "G-1725" |
| G-1726 | FIXED (with P-047) | Decision (coordinator, 2026-11-20): least privilege. Agreed with P-047, who owns the runner code. **P-047** (claude/our-machines, PR #23, commit 10e9b33b): an organization installation with the organization permission "Self-hosted runners: Read and write" registers each job's runner through `POST /orgs/{org}/actions/runners/generate-jitconfig` into a runner group `fenvix-<repository id>` that only that repository can use (so no organization runner takes another repository's job). A personal account, or an organization without that permission, keeps the repository endpoint, which needs repository "Administration: Read and write". docs/GITHUB-APP.md section 2 lists both; their test is `machines.test.ts` "least privilege (G-1796, G-1726)". **P-048** (this branch): what the user is told. The onboarding pull request says which permission runs the machines and why (organization: Self-hosted runners, no Administration; personal account: Administration, because GitHub offers nothing narrower), and a refused runner registration gives a check run naming the permission for the account type. Founder action: add the organization permission in the App settings (the coordinator collects it). The dashboard's connect page wording is P-049's. | `backend-gaps.test.ts` "G-1725", "G-1726" |
| G-1727 | FIXED | The GitHub client reads `retry-after` / `x-ratelimit-*`, waits up to 10 s once, else fails with when to retry. | `backend-gaps.test.ts` "G-1727" |
| G-2293 | OPEN | No App manifest (MINOR); the missing-permission case is now visible (G-1725). | — |
| G-2294 | OPEN | "All repositories" still needs a click per repository (MINOR). | — |
| G-1728 | OPEN | GitHub organization/member events not mapped to fenvix members (needs a GitHub-identity link; BUILD-LATER). | — |
| G-1729 | FIXED | Each sweep redelivers failed, never-processed deliveries and reads back jobs queued without a machine. | `backend-gaps.test.ts` "G-1729" |
| G-2295 | FIXED | check_suite rerequested re-runs the commit's fenvix jobs. | `backend-gaps.test.ts` "G-1647, G-2295" |
| G-2296 | FIXED | workflow_run completed reads back its jobs that lost their events. | `backend-gaps.test.ts` "G-1729, G-2296" (path) |
| G-2297 | FIXED | repository renamed/transferred/archived/unarchived/deleted handled. | `backend-gaps.test.ts` "G-2297" |
| G-2298 | FIXED | installation_target renamed updates the login. | `backend-gaps.test.ts` "G-2298" |
| G-2299 | OUT OF SCOPE | Marketplace and billing. Rule: go-live scope: github.com only, Linux x86_64 only, GitHub Actions only, jobs only on our machines, no billing (coordinator, 2026-11-20). | — |
| G-2300 | FIXED | github_app_authorization handled and recorded (the App keeps no user token). | `service.ts` route |
| G-2301 | FIXED | A replayed installation.created no longer brings back an uninstalled installation. | `backend-gaps.test.ts` "G-2301" |
| G-2302 | FIXED | Ignored events are recorded. | `backend-gaps.test.ts` "G-2302" |
| G-2303 | OUT OF SCOPE | The 6 MB request cap is API Gateway/Lambda (Infra). | — |

### Service / PR comment and check runs

| Row | Status | What is now true / why | Evidence |
| --- | --- | --- | --- |
| G-1774 | FIXED | Seed, minimal order and the divergent event are in the comment. | `backend.test.ts` "3." |
| G-1775 | FIXED | The replay command is the bundle's minimal-order command (plus the pull command), not the whole suite. | `backend.test.ts` "3." |
| G-1776 | FIXED | Replay commands per language (`replayCommand`, shared with the dashboard; Node: detjs); the check text says detjs for Node. | `src/data/ci.ts` unit tests; `render.ts` |
| G-2316 | OPEN | The comment is still written on every run (MINOR). | — |
| G-2317 | FIXED | The marker search pages through every comment (up to 3,000). | `service.ts upsertComment` |
| G-2318 | FIXED | Every open PR with that head gets the comment. | `backend-gaps.test.ts` "G-2318" |
| G-1645 | FIXED | One check run per job, `fenvix / <job>`. | `backend.test.ts` "1.", `results.test.ts` |
| G-1646 | FIXED | Annotations on file and line (failures, flaky defects). | `backend.test.ts` "4." |
| G-1647 | FIXED (code) / BLOCKED (permission) | Re-run re-runs the job; without the App's "Actions: Read and write" the check run says how. Founder grants the permission. | `backend-gaps.test.ts` "G-1647, G-2295" |
| G-1648 | FIXED | A job that gets no machine gets an `action_required` check run with why. | `backend.test.ts` "12." |

### Service / Supabase

| Row | Status | What is now true / why | Evidence |
| --- | --- | --- | --- |
| G-0611, G-0626 | FIXED | Per sighting: fingerprint kept and compared (`fingerprintChanged`); the bundle (with the run's traces) kept per defect (5 newest). Trace-level diffing is the engine's. | `backend.test.ts` "9." |
| G-0622, G-0627, G-1777 | FIXED | Bundles uploaded, stored under RLS, downloadable by members, keys, MCP and replay machines. | `backend.test.ts` "3.", "5.–8." |
| G-0628 | FIXED | `ci_api_keys`. | `backend-rls.sql` |
| G-0629 | OUT OF SCOPE | Invoices are billing. | — |
| G-0630 | FIXED | `ci_exploration_jobs` + project exploration settings. | `backend-gaps.test.ts` |
| G-0631, G-0632 | OUT OF SCOPE | JVM, Playwright, Cypress, node:test, mocha, unittest: the engine runs pytest, Vitest and Jest (go-live: Python and Node); onboarding refuses the others (G-0617). | — |
| G-0633 | FIXED | Causes for the divergent event's kinds. | contract + `runner-records.ts`; `backend-rls.sql` inserts |
| G-0634 | FIXED | Delete organization. | `backend-gaps.test.ts` |
| G-1805 | FIXED | `audit_events`, written by triggers, read by owners/admins (`GET /v1/organization/audit-log`). | `backend.test.ts` "5." |
| G-1806, G-1807 | OUT OF SCOPE | Machines and cache records are Runner orchestration / Infra (P-047). | — |
| G-1808 | FIXED | Dedup key is (project, test), see G-1701. | `backend.test.ts` "9." |
| G-1810 | FIXED | Disconnect project. | `backend-gaps.test.ts` "G-1810" |
| G-1812 | FIXED | 30 days after an uninstall everything of the installation goes. | `backend-gaps.test.ts` retention |
| G-1815 | OPEN | No down migrations (BUILD-LATER). | — |
| G-1816 | FIXED | Retention (see Numbers). | `backend-gaps.test.ts` retention |
| G-1817 | OPEN | Supabase project settings not as code (needs the founder's project; BUILD-LATER). | — |
| G-2333 | OPEN | Trial accounts unreadable by support (MINOR). | — |
| G-2334, G-2335 | OPEN | Old migrations not repeatable / no squashed baseline (MINOR). README now names 0001–0019. | — |
| G-2336 | BLOCKED | Not changed. GitHub's billing reference lists Linux 2-core at $0.006/min, other GitHub pages still say $0.008 (DECLARED, conflicting, checked 2026-11-20). Founder confirms before the comparison is shown. | sources below |
| G-2337 | FIXED | Deliveries pruned after 30 days, index on received_at. | retention test |
| G-2338 | FIXED | Indexes added (runs by commit/PR/branch, jobs unpublished/installation/run, results/receipts by org, usage by project). | migration 0019 |
| G-2339 | FIXED | Foreign keys to auth.users. | migration 0019 |
| G-2341 | FIXED | `backend-rls.sql` also runs on the real Supabase image in CI. | `.github/workflows/test.yml` |
| G-2342 | FIXED | Default privileges of anon/authenticated revoked for the migrating role; a later table is not readable by the browser. | `backend-rls.sql` (also on the Supabase image) |
| G-2343 | FIXED | Trigger `other`. | `backend-gaps.test.ts` "G-2343" |

### Memory, dedup, replay bundles, exploration, notifications, deletion, onboarding, shared cache, audit log

| Row | Status | What is now true / why | Evidence |
| --- | --- | --- | --- |
| G-1701 | FIXED (fingerprint, engine version, order) | Same test = same defect whatever the fingerprint. One polluter breaking N tests stays N defects grouped as one family (the founder's rule: one defect per flaky test); a renamed test is a new test. | `backend.test.ts` "9." |
| G-1702 | FIXED | History lists every run, commit and PR. | `backend.test.ts` "9." |
| G-1749 | FIXED (service compares) / OUT OF SCOPE (naming the event) | The service compares fingerprints across sightings; naming the first divergent event is the engine's replay. | `backend.test.ts` "9." |
| G-0597 | FIXED (service) | Scheduler, machines through `launchTask`, task credentials. The machine executor is P-047's. | `backend-gaps.test.ts` |
| G-1720, G-1721, G-1722 | FIXED | Switch schedules nightly at its hour; time cap, seeds, `unstable` targeting; scheduled explorations stored whatever else stored that day. | `backend-gaps.test.ts` |
| G-1723 | OUT OF SCOPE | Exploration on customer runners. Rule: go-live scope: github.com only, Linux x86_64 only, GitHub Actions only, jobs only on our machines, no billing (coordinator, 2026-11-20). | — |
| G-1724 | OUT OF SCOPE | Buying the add-on is billing. | — |
| G-1756, G-2310 | BLOCKED | E-mail needs a mail provider and its credential (founder). | — |
| G-1757 | FIXED | A wrong skip pauses skip with proof for the project (no cache for its machines) until an admin resumes; the project says why. | `backend-gaps.test.ts` "G-1757" |
| G-2311 | OPEN | No Slack/outgoing webhooks (MINOR). | — |
| G-1699 | FIXED | Uninstall: 30-day retention then purge and unlink. | retention test |
| G-1700 | FIXED | Unlink an installation. | `backend-gaps.test.ts` |
| G-2283 | FIXED | Organization export. | `backend-gaps.test.ts` "G-2283" |
| G-0617 | FIXED | Setup PR only for pytest/Vitest/Jest jobs (`npm test` resolved through package.json). | `backend-gaps.test.ts` "G-0617" |
| G-0618 | OUT OF SCOPE | macOS, Windows, arm64. Rule: go-live scope: github.com only, Linux x86_64 only, GitHub Actions only, jobs only on our machines, no billing (coordinator, 2026-11-20). | — |
| G-1758, G-1759 | OPEN | One job per repository; reusable workflows (BUILD-LATER). | — |
| G-2312 | OPEN | `testCommand` setting still unused (MINOR; the setting is the dashboard's, P-049). | — |
| G-0625 | OUT OF SCOPE | The shared cache off our machines. Rule: go-live scope: github.com only, Linux x86_64 only, GitHub Actions only, jobs only on our machines, no billing (coordinator, 2026-11-20). | — |
| G-1804, G-2330, G-2331 | OUT OF SCOPE | Cache machine and its tenants are Infra (P-047). | — |
| G-1632 | FIXED | Audit log (see G-1805). | `backend.test.ts` "5." |
| G-2309 | FIXED | Retention (see G-1816). | retention test |

### Founder rule: no machine before go-live except through the master switch (coordinator, 2026-11-20)

Audit of this branch: every EC2 start goes through the launcher, and the launcher exists only when `RUNNER_MODE` (P-047's
switch) is set; unset, there is none (MEASURED: `runners.test.ts` "founder rule"). The one start path this branch had
added, the EC2 launcher's `launchTask` (task machines for replays and explorations), is **removed**. Replays now reach a
machine only as P-047's pool leases (the scratch merge's `Service.poolReplay`). Scheduled explorations wait until
P-047's pool schedules its exploration hook.

### Rows handed over by P-047 (coordinator, 2026-11-20)

Split: API and back end here; `src/` and `vercel.json` to P-049 (G-2285, and the screens for G-2325, G-2329, G-1790,
G-1800).

| Row | Verdict | What | Evidence |
| --- | --- | --- | --- |
| G-0616 | FIXED | Playwright and Cypress are test runners a project can have (DB, contract `TestRunner`, workflow detection, summary detection). fenvix does not run them yet: the setup pull request is not opened, and the reason names the runner. | `backend-gaps.test.ts` "G-0616, G-1750" |
| G-1750 | FIXED | unittest, Django, nose2 and ward (Python); mocha, node:test, ava, tap and bun (Node): recognised and stored as themselves. A `python -m unittest` job is no longer stored as pytest. The engine runs pytest, Vitest and Jest (MEASURED by the engine's sessions); the rest are recognised, not run. | `backend-gaps.test.ts` "G-0616, G-1750" |
| G-1752 | FIXED (Node/any runner); OUT OF SCOPE (Go/JVM) | A summary's flaky test may be named `testId`, not only pytest's `nodeid`. The engine version from `detpy`/`detjs` covers Python and Node. Go and JVM summaries: out of scope. Rule: go-live scope: Python and Node only, Linux x86_64 only, GitHub Actions only, jobs only on our machines, no billing. | `backend-gaps.test.ts` "G-1752" |
| G-1753 | OUT OF SCOPE | Go package and JVM class receipts. Rule: go-live scope: Python and Node only, Linux x86_64 only, GitHub Actions only, jobs only on our machines, no billing. Node receipts fit `{path, qualname, digest}`. | — |
| G-1754 | FIXED | Defect kinds beyond order (thread, async order, clock, randomness, network, files, environment: since 0019). Such a defect needs no order now; its minimal order is the test alone. An order defect still needs one. | `backend-gaps.test.ts` "G-1754" |
| G-1755 | FIXED | Each run keeps its own language and runner from its summary (`ci_runs.language`, `test_runner`; `Run.language`, `Run.testRunner` in the API); its defects and results use them. A repository with Python and TypeScript test jobs reports both. The project keeps its first language for its settings. | `backend-gaps.test.ts` "G-1755" |
| G-1790 | FIXED (before) | `deleteMe` (G-1626): an account is deleted; an only owner of an organization with members is refused. | `backend-gaps.test.ts` "G-1626"; `api-dashboard.test.ts` |
| G-1798 | BLOCKED (founder step 4) | Sending the invitation e-mail needs the mail provider credential (as G-1756, G-2310). The link is returned meanwhile. | — |
| G-1799 | BLOCKED (founder step 4) | E-mail notices need the same mail provider. | — |
| G-1800 | FIXED (before) | `unlinkInstallation` (G-1700): an owner or admin unlinks; it can then be linked to another organization. | `backend-gaps.test.ts` "G-1700" |
| G-2325 | FIXED | `transferOwnership` (owners only, confirmed by typing the organization's name). In one step the member becomes an owner and the caller an admin; the audit log records `organization.ownership_transferred` (besides the two role changes). | `api-dashboard.test.ts` "the service back-end's operations" |
| G-2329 | FIXED | A pending invitation used by someone signed in with another address answers 403 `invitation_other_email` and says what to do; every other refusal stays the same 404. | `api-dashboard.test.ts` "an invitation" |

## What is not true yet

- No per-test production data yet: progress, results chunks and bundles have no sender (the engine, fenvix-engine-cli); fenvix-agent sends summaries and replay outcomes (round 4).
- `mcp.fenvix.dev` is not a host yet; the MCP server is at `https://api.fenvix.dev/v1/mcp`.
- The OPEN rows above (G-1629, G-1630, G-1728, G-1758, G-1759, G-1815, G-1817, G-2232, G-2233, G-2292, G-2293,
  G-2294, G-2311, G-2312, G-2316, G-2333, G-2334, G-2335) are BUILD-LATER/MINOR rows not reached in this session.
- The dashboard pages for the new endpoints (API keys, defect history, replay buttons, Stop, audit log) are P-049's;
  the endpoints and types are in `openapi/fenvix-api.yaml` / `src/api/schema.d.ts`.

## Sources (G-2336)

- [GitHub: Actions runner pricing (billing reference)](https://docs.github.com/en/billing/reference/actions-runner-pricing)
- [GitHub: About billing for GitHub Actions](https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions)
- [GitHub Actions pricing changes in 2026 (third party)](https://dev.to/kalemi/github-actions-pricing-changes-in-2026-4g0j)
