DONE

# Remove a project and delete an account: report (2026-11-27)

Branch `claude/remove-and-delete` from `origin/main` 50d7fd9 (`git fetch origin` on 2026-11-27, head recorded then).
Spec: `gstack/projects/Mircoguidetti-fenvix-app/specs/20261127-remove-and-delete.md` rev 3. The spec was relayed by the
coordinator session, because this session had no access to Mircoguidetti/new-brain.

## What was built

- **Migration `supabase/migrations/0021_remove_and_delete.sql`** (additive, safe to run twice):
  - `gh_repositories.excluded_at`.
  - `gh_installations.uninstall_requested_at` (added after review; see "Review" below).
  - `api_remove_project(uuid)` (checks `api_admin_workspace()`), `api_restore_repository(bigint)` (checks
    `api_admin_workspace()`) and `api_delete_organization()` (checks `api_owner_workspace()`). All three are security
    definer with `search_path = public, pg_temp`; execute is revoked from public, anon and authenticated and granted to
    fenvix_api, as in 0014:395-406.
  - Probe in `deploy/lib/migrate.mjs`: the `excluded_at` column first, `api_delete_organization` in `pg_proc` last.
  - Appended twice to `supabase/tests/run-local.sh` and to `github-app/scripts/prepare-test-db.sh`.
- **API**: `DELETE /projects/{projectId}` returns 204. `POST /github/repositories/{repositoryId}/restore` returns 202
  with the repository and queues `sync_repository`. `DELETE /organization` returns 204: the contract marks it admin,
  and the handler plus the SQL function both refuse anyone who is not an owner. After the commit it queues one
  `uninstall_installation` per installation. The repository listing returns `excludedAt`. Setting up a pull request
  for an excluded repository returns 409. `OnboardWork` (api/context.ts) and `Work`/`parseWork` (work.ts) both carry
  the two new kinds.
- **App service**: an excluded repository is skipped by:
  - `syncProject`, which reads the repository row `for update` and logs "repository removed from fenvix by its
    organization";
  - `syncInstallation`;
  - `launchRunner` and `launchSideBySide`;
  - `onboard`, `refreshDefaultBranch` and `readHistory`;
  - the history sweep (:1293);
  - the awaiting_link query (:1643) and the onboarded query (:1656) in `onInstallationLinked`;
  - warm-ups (`warmups.ts` `refuse`).

  New handlers:
  - `syncRepository`.
  - `uninstallInstallation`. It calls `DELETE /app/installations/{id}` with the App credential and treats 404 as done.
    It only runs for an installation with no organization that was marked `uninstall_requested_at`. Other errors throw,
    so the queue retries. The sweep also retries marked installations after 10 minutes.

  A removal does not follow the repository into another installation, and it is cleared when its organization is
  deleted.
- **Console**: a "Remove project" block at the bottom of the project's Settings, for owners and admins. A "Delete
  account" block at the bottom of Settings (General), for the owner only. Both use `TypedConfirmDialog`, which wraps
  `ConfirmDialog`; its button is enabled only by the exact repository full name or organization name. After a removal,
  one "Removed <repo>" toast appears and the page goes to /projects. After an account deletion the console signs out
  and lands on the sign-in page, because console-cleanup has not merged, so there is no `/welcome`. The installation link
  goes to `github.com/settings/installations/<id>` for a user account or `github.com/organizations/<login>/settings/installations/<id>`
  for an organization. The mock backend covers both flows.
- **Not built yet:** Connect's "Removed from fenvix" row with "Add again" in `RepoRow`. The spec says to wait until the
  console-cleanup PR merges, and PR #30 is open, not merged. The API (`restoreRepository`) and the mock are in place.

## Checks (branch head ed6bf78 plus this report; Postgres 16.15 scratch cluster on localhost)

| Command | Branch | origin/main 50d7fd9 |
|---|---|---|
| `npm ci` (root) / (`github-app/`) | exit 0 / exit 0 | (same install) |
| `npm run typecheck` | exit 0 | exit 0 |
| `npm run test:unit` | exit 0, 88 tests, 88 pass | exit 0, 88/88 |
| `npm run build` | exit 0 | exit 0 |
| `npm run check` | exit 0: checks 72/72, organization checks 10/10, **remove/delete checks 6/6**, status colour checks 18/18, screenshots: all checks passed (170 pictures) | exit 0: 72/72, 10/10, 18/18, 170 pictures |
| `npm run api:lint` | exit 0 ("Your API description is valid") | exit 0 |
| `github-app/`: `npm run db:prepare` | exit 0 ("0014 to 0021 twice") | exit 0 |
| `github-app/`: `npm test` | exit 0: typecheck, unit 237/237, integration 185/185 | exit 0: unit 237/237, integration 173/173 |
| `npm run test:rls` (`TEST_DATABASE_URL` = scratch `rls_final`) | exit 0: API, CI, CI EXPLORE, GH, WARM RLS OK, RUNNERS, RUN PROOF, SIDE BY SIDE CHECK OK, **REMOVE DELETE RLS OK**, SIDE BY SIDE ROLLBACK OK | exit 0 (without the new check) |
| `deploy/`: `npm test` (`FENVIX_DEPLOY_TEST_DB` = scratch) | exit 0: 90 tests, 89 pass, 1 skipped (needs a local Supabase; skipped on main as well), including "0021 cut before its last statement: the deploy stops" | not run on main |

Notes on the runs:
- **First `npm run check` run on the branch:** it reported 6 remove/delete failures. A `vite preview` left over from
  the origin/main run was still holding port 4173, so the branch run was served the main build. After that process
  stopped, the branch build passed 6/6, and the final run above passed.
- **First final `npm run test:rls`:** it failed with "the control plane's role is still there". Roles belong to the
  whole Postgres cluster, and my earlier scratch databases still held grants to `fenvix_control_plane`, so 0014 could
  not drop it. After dropping those scratch databases and the leftover role, it passed. This is environment state, not
  the change: the script expects an otherwise empty cluster.

Not proven here:
- The `auth.users` delete was checked locally only, against the stub `auth.users` table (`supabase/tests/local-stub.sql`).
  Production migrations run as `postgres` through the session pooler, and the function runs as its owner there. Whether
  that delete succeeds on Supabase's real `auth.users` (with auth.identities and auth.sessions cascading) is not proven
  by anything run here.
- Nothing ran against a remote database.

## Changes to tests and check scripts (each with its reason first)

- Reason: the unit test lists exactly the operations marked admin, and this PR adds three.
  Change: `github-app/tests/unit/api.test.ts` `ADMIN_OPS` gains `deleteOrganization`, `removeProject` and `restoreRepository`.
- Reason: every migration with a probe gets a half-applied test.
  Change: `deploy/test/pipeline-2.test.mjs` adds `["0021", "create or replace function public.api_delete_organization()"]`.
- Reason: test databases prepared before 0021 must get it, as for 0015 to 0020.
  Change: `github-app/tests/helpers/harness.ts` applies 0021 when `excluded_at` is missing.
- Reason: the App calls `DELETE /app/installations/{id}` now.
  Change: `github-app/tests/helpers/fake-github.ts` answers it (204, then 404 for that id).
- Reason: the new SQL check.
  Change: `supabase/tests/run-local.sh` runs `remove-delete-rls.sql`, and both migration lists apply 0021 twice.
- Reason: the UI checks for this feature run in `npm run check`.
  Change: `scripts/run.mjs` runs `scripts/remove-delete-checks.mjs`.
- No timeout or threshold was changed.

## Test cards

| Test | protects | fails_when | no_claim |
|---|---|---|---|
| `remove-and-delete.test.ts` "DELETE /v1/projects/{id}: a member gets 403, another organization's owner and an unknown id get 404" | only owners/admins of the project's organization can remove it | the role or organization check is missing in the handler or in `api_remove_project` | production RLS (the scratch database has the same migrations) |
| "an admin removes the project: 204, the project and its runs are gone, the repository is excluded" | runs, defects (pointing at the runs) and skip receipts go; `excluded_at` set; the listing shows `excludedAt` and no project | the cascade fails or the repository is not marked | explorations and test results (they cascade the same way, but are not seeded) |
| "the App skips the excluded repository: no project on sync, no machine for its queued job, no setup pull request" | `syncInstallation`, `launchRunner`, `onboard`, a redelivered `installation.created` and the API's setup PR all respect the removal | a guard is removed (mutation-checked: dropping the `launchRunner` guard and the `syncInstallation` filter fails it) | side-by-side launches, warm-ups and history (guarded the same way, not separately tested) |
| "a removal and a sync at the same moment: the sync waits for the removal and creates no project" | a sync or publish racing a removal cannot recreate the project | `syncProject` reads `excluded_at` without the row lock (mutation-checked: fails without `for update`) | the publish path specifically (it goes through the same `syncProject`) |
| "Add again: a member gets 403, another organization 404; the owner gets 202, sync_repository is queued and the project comes back"; then a queued job starts one machine | restore clears the exclusion and the project and machines come back | restore leaves `excluded_at` set, or the work kind is not handled | the Connect UI (not built yet) |
| "DELETE /v1/organization: an admin and a member get 403; nothing changes" | owner-only deletion | the owner check is missing | — |
| "the owner deletes it: one uninstall_installation per installation, its rows gone, another organization untouched, the owner's login deleted" | the organization's workspace, members, projects (with runs, defects, receipts) and subscription go; installations are unlinked and marked; the removal is cleared; the owner's `auth.users` row (stub) goes; other members keep their logins; another organization is untouched; queued jobs start no machine | the cascade fails, too much or too little is deleted, or the messages are wrong | the real Supabase `auth.users` |
| "uninstall_installation: DELETE /app/installations/{id} once per message; GitHub's 404 counts as done; only a deleted organization's installation" | one DELETE per message, idempotent on redelivery, 404 treated as done, marker cleared | the call is repeated, or a 404 throws | GitHub's real API (the fake answers with GitHub's documented statuses) |
| "a forged uninstall_installation changes nothing: a never-linked installation, or one linked again before it ran" | a forged or late message cannot uninstall a customer's App | the guard checks only `workspace_id is null` | — |
| "a lost message: the sweep uninstalls a marked installation later" | an uninstall still happens if the queue message is lost after the commit | the sweep retry is missing | the Lambda sweep schedule |
| "a removal stays with its installation" | a repository under a new installation (another organization) is not excluded there | `upsertRepositories` keeps `excluded_at` across installations | — |
| "an owner who belongs to another organization keeps their login" | the login is deleted only when no membership is left | the `auth.users` delete ignores other memberships | — |
| `supabase/tests/remove-delete-rls.sql` | the three functions are not executable by anon, authenticated or fenvix_github_app, are executable by fenvix_api, and `excluded_at` exists | a grant is wrong | — |
| `scripts/remove-delete-checks.mjs` (desktop 1440x900 and mobile 390x844) | both buttons stay disabled for an empty, case-changed, truncated or padded name and are enabled by the exact one; one "Removed <repo>" toast; the project is gone from /projects; after account deletion the browser is signed out and the mock no longer has the organization; a member sees neither block; no console errors; no horizontal scroll | the gate, the toast, the removal, the sign-out or the role gate breaks | the real API (the mock backend) |

## Shots

`remove-and-delete/2026-11-27/shots/` holds 8 PNGs: `remove-project-*` and `delete-account-*`, desktop 1440x900 and
mobile 390x844, light and dark. They were taken with the mock backend, the pre-installed Playwright and
`deviceScaleFactor: 2`, using `SHOTS=<dir> node scripts/remove-delete-checks.mjs`. The run printed
"console errors: 0" for all four contexts.

## Review

**gstack `/review`** (non-interactive). Specialists: security, data-migration, testing; plus the adversarial pass. Gate
edits: 4 eligible hunks read, none relax a gate (no RH tags). Findings and what happened:
- [CRITICAL, fixed + test] A removal racing a sync or publish could recreate the project. Fix: `syncProject` locks the
  repository row; `api_remove_project` updates the repository before deleting the project.
- [CRITICAL, fixed + test] Losing the `uninstall_installation` message after the commit would leave the App installed.
  Fix: `gh_installations.uninstall_requested_at` plus a sweep retry.
- [INFORMATIONAL, fixed + test] A forged `uninstall_installation` for a never-linked installation would uninstall it.
  Fix: it now requires the marker.
- [INFORMATIONAL, fixed] If sign-out threw after the account was deleted, the dialog showed "Could not delete". Fix: the
  sign-out is separate from the deletion.
- [INFORMATIONAL, fixed] Test gaps: a same-installation redelivery keeps the removal; the UI delete check now verifies
  the organization is gone.
- [CRITICAL claimed, refuted by test] "The cascade fails on defects and receipts through `ci_workspace_from_parent`."
  A project with a defect pointing at both runs and a receipt with `reused_run_id` is removed, and its organization
  deleted, without error (integration test `seedHistory`, PG16).
- [INFORMATIONAL, open]
  - The side-by-side, warm-up and history guards have no separate test.
  - Uninstall check-then-call without a lock: an installation relinked during the GitHub call could be marked deleted.
  - A machine can still start if a removal commits between `launchRunner`'s check and the launch. Its run publishes
    with no project.
  - If the `sync_repository` enqueue fails after a restore, the project returns only on the next sync. Restoring again
    re-queues it.
  - Usage records go with the organization. The spec lists them as deleted.

**`security-review` skill**: no findings with confidence 8 or higher. It verified the role checks in SQL and in the
handlers, that every write filters on the caller's organization, `search_path`, the grants, that the `auth.users`
delete is limited to the caller (`api_user()` comes from the verified session), bound parameters, and the uninstall
guard.

By design (reported, not a vulnerability): a fenvix owner who is not an admin of the linked GitHub account can uninstall
the App from that account by deleting the organization. This removes the integration and exposes no data.

## Diff

`git diff --stat origin/main...claude/remove-and-delete` (the commit that added this report; this stat edit adds no new file):

```
 deploy/lib/migrate.mjs                             |   6 +
 deploy/test/pipeline-2.test.mjs                    |   2 +-
 github-app/scripts/prepare-test-db.sh              |   6 +-
 github-app/src/api/context.ts                      |   9 +-
 github-app/src/api/data.ts                         |  12 +
 github-app/src/api/github.ts                       |  16 ++
 github-app/src/api/openapi.gen.ts                  |   2 +-
 github-app/src/api/orgs.ts                         |  19 ++
 github-app/src/api/server.ts                       |   6 +-
 github-app/src/service.ts                          |  85 ++++++-
 github-app/src/warmup/warmups.ts                   |   5 +-
 github-app/src/work.ts                             |  21 +-
 github-app/tests/helpers/fake-github.ts            |   8 +
 github-app/tests/helpers/harness.ts                |   4 +
 .../tests/integration/remove-and-delete.test.ts    | 283 +++++++++++++++++++++
 github-app/tests/unit/api.test.ts                  |   3 +-
 openapi/fenvix-api.yaml                            |  42 ++-
 remove-and-delete/2026-11-27/REPORT.md             | 163 ++++++++++++
 .../shots/delete-account-desktop-1440x900-dark.png | Bin 0 -> 305300 bytes
 .../delete-account-desktop-1440x900-light.png      | Bin 0 -> 293581 bytes
 .../shots/delete-account-mobile-390x844-dark.png   | Bin 0 -> 141857 bytes
 .../shots/delete-account-mobile-390x844-light.png  | Bin 0 -> 135568 bytes
 .../shots/remove-project-desktop-1440x900-dark.png | Bin 0 -> 336298 bytes
 .../remove-project-desktop-1440x900-light.png      | Bin 0 -> 326294 bytes
 .../shots/remove-project-mobile-390x844-dark.png   | Bin 0 -> 126551 bytes
 .../shots/remove-project-mobile-390x844-light.png  | Bin 0 -> 120864 bytes
 scripts/remove-delete-checks.mjs                   | 153 +++++++++++
 scripts/run.mjs                                    |   2 +-
 src/api/schema.d.ts                                | 123 ++++++++-
 src/components/TypedConfirmDialog.tsx              |  67 +++++
 src/data/api.ts                                    |   7 +
 src/data/ci-rows.ts                                |   1 +
 src/data/client.ts                                 |   7 +
 src/data/compat.ts                                 |   2 +
 src/data/mock.ts                                   |  32 ++-
 src/data/orgs-mock.ts                              |  13 +
 src/data/orgs.ts                                   |   5 +
 src/pages/Project.tsx                              |  83 +++++-
 src/pages/Settings.tsx                             |  73 +++++-
 src/styles.css                                     |   4 +
 supabase/migrations/0021_remove_and_delete.sql     | 101 ++++++++
 supabase/tests/remove-delete-rls.sql               |  16 ++
 supabase/tests/run-local.sh                        |   9 +-
 43 files changed, 1358 insertions(+), 32 deletions(-)
```
