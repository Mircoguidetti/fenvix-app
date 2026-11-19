# Report: deploy pipeline, fix round 3 (R-024b, FIX 4)

Branch `claude/deploy-pipeline`. This round merges the reviewer's branch `claude/review-r024b` (01cd037) and fixes
G1–G4 from `docs/REVIEW-R-024b.md`. It is the last round, with no third review, so the reviewer's own failing tests
are the bar. Nothing was deployed. No AWS, Supabase, Cloudflare or Actions access was used.

**MEASURED** means run in this container:

- Node 22.23.5.
- A `postgres:16` scratch server on 54329 (trust auth, with database `gh_test`).
- Docker 29.10, with the local Supabase from `scripts/local-supabase/up.sh`.

**UNKNOWN** means it needs the real accounts.

## 1. Findings

| # | Change | Test before | Test after |
|---|---|---|---|
| G1 | `deploy/lib/migrate.mjs`: 0014's `last` probe now also requires `gh_link_installation(bigint,uuid,uuid)` to contain `trial_ends_at` in its source (`coalesce((select prosrc like '%trial_ends_at%' …), false)`). Only 0014's version of the function contains it, so a paste cut between the policy `workspaces_github_app` and the function's re-creation is no longer recorded as `found`. | `G1: 0014 cut before its re-creation of gh_link_installation`: **fail** (`migrate` records 0014 as `found`) | **pass** (0014 stops as half-applied). `r024-founder-state.sh founder` still records 0001–0017 `found` and runs nothing. |
| G2 | `deploy/lib/roles.mjs`: records that `PutParameter` succeeded. If `commit` then fails, the step rolls back and puts the previous SSM value back (`stored`). If there was no previous value, it deletes the parameter. Only after that does it say "nothing changed". If the restore also fails, it stops with: "SSM now holds a connection string that the role does NOT accept: the API and the GitHub App load it within 5 minutes and will then fail to log in. Run the workflow again NOW". The deploy role already has `ssm:DeleteParameter` on `/fenvix/prod/github-app/*` (bootstrap template, `ManageOwnSecrets`), so the policy is unchanged. The test helper `MemorySsm` gained `DeleteParameterCommand`. | `G2: the commit fails after PutParameter`: **fail** (SSM held the new string, the role kept its old password, and the step said "rolled back, nothing changed") | **pass**. SSM is back to the old string, the role is unchanged, and the message says the value was put back. I also ran an ad-hoc check, not committed, against the scratch server. With no previous value the parameter is removed and the message says "removed". When the restore fails, the message says the role does NOT accept the stored string and asks for a rerun NOW. Both passed. |
| G3 | `docs/DEPLOY-AWS.md` A step 2.1 and click 3 below now link the template on the branch that exists at that moment: `…/blob/claude/deploy-pipeline/infra/bootstrap/fenvix-bootstrap.json`. **Why this rather than merging first:** a merge-first order would make the first `main` run stop at "Check the one-time setup", which is safe. The founder would then see a red run and need an extra **Re-run** click after the setup. The branch link costs nothing: one link, no failed run, and the order already documented is kept. After the merge, the file on `main` is the same file (`build.mjs --check`: up to date). | `git show origin/main:infra/bootstrap/fenvix-bootstrap.json` → path not on `main` (the old link was a 404) | Link points to the pull request's branch, where the file exists. |
| G4 | `docs/DEPLOY-AWS.md` gains **Step 0**: check that the GitHub plan is Pro or Team, because the repository is private. It gives the exact path, says what happens on Free, and links the upgrade. It does not suggest making the repository public. Click 1 below. | Not mentioned | Click 1 below; DEPLOY-AWS.md section A, step 0. |

**Known limit (G2):** a `commit` that reaches the server and succeeds, but whose reply is lost, looks the same as a
failed commit. In that case the restore puts back an old string the role no longer accepts. The message still says
"Run the workflow again". The next run sees `28P01` and sets a fresh password, so the state heals on the next run.
This case is rare and was not reproduced.

**Wording correction (review §4, note):** REPORT-deploy-pipeline-2 said that in step 8 "the CDK app and its
dependencies never see" the Cloudflare token. That overstates it. `unset` clears the shell's variable, but the
step's bash process still holds `FENVIX_CF_TOKEN` in `/proc/<pid>/environ`, so code running in `cdk deploy` could read
it, just as it can read that step's AWS session. The token's exposure is narrowed to steps 6, 8 and 9. It is not
isolated.

## 2. Suites (MEASURED, after the fixes)

| Suite | Result |
|---|---|
| `deploy/test/review-r024b.test.mjs` (identical to `origin/claude/review-r024b`) | before the fixes: **0/2** · after: **2/2** |
| R-024 reviewer files (`deploy/test/review-r024.test.mjs`, `deploy/test/r024-founder-state.sh`, `infra/github-app/test/review-r024.test.ts`; `git diff origin/claude/review-r024` is empty for all three) | deploy R-024 **5/5**, infra R-024 **2/2** (inside the 85) |
| `deploy` `npm test` (local Supabase up, 0 skipped) | **51/51** (49 + the 2 R-024b tests) |
| `infra/github-app` `npm test` (typecheck, synth, nag, policies, bootstrap) | **85/85** |
| `github-app` `npm test` | typecheck clean, unit **135/135**, integration **165/165**, 0 skipped |
| `npm run test:rls` (`TEST_DATABASE_URL` = scratch) | API, CI, CI EXPLORE, GH, WARM RLS **OK** |
| Dashboard `api:lint`, `build`, `test:unit`, `api:check` | valid, builds, **66/66**, matches |
| `actionlint` 1.7.12 (`rhysd/actionlint:1.7.12`) | no finding |
| `cfn-lint` 1.60.1 on `infra/bootstrap/fenvix-bootstrap.json` | no finding |
| `node infra/bootstrap/build.mjs --check` | up to date |
| `cdk synth` (both stacks), App values empty, with a certificate ARN | succeeds. `Aliases` is `["console.fenvix.dev"]`; `DASHBOARD_URL` is `https://console.fenvix.dev` in 6 places; `GITHUB_APP_ID` is empty in 5; `app.fenvix.dev` appears nowhere. |
| `r024-founder-state.sh` founder / upto0013 / upto0010 | founder: 0001–0017 `found`, nothing run, schema unchanged · upto0013: 0014–0017 applied · upto0010: STOP "none of migration 0011's", unchanged. This is the same table as R-024b. |

## 3. FINAL: the founder's one-time browser clicks for console.fenvix.dev, in order

Everything is done in a browser, and nothing runs on a laptop. DEPLOY-AWS.md section A has the same steps with more
explanation.

1. **GitHub → check the plan.** Open <https://github.com/settings/billing/summary>. To get there by clicking: avatar
   (top right) → **Settings** → **Billing and plans** → **Plans and usage**. Under **Current plan**, it must say
   **GitHub Pro** (or Team). If it says **GitHub Free**, click **Upgrade** → **GitHub Pro** → pay.
   - Why: the repository is private, and on Free GitHub does not offer environment secrets or deployment branch rules
     for it. Clicks 2 and 6 need both.
2. **GitHub → environment `production`** (do this before click 3).
   - Open <https://github.com/Mircoguidetti/fenvix-app/settings/environments>.
   - Click **New environment** → Name `production` → **Configure environment**. If `production` is already listed,
     click it instead.
   1. **Deployment branches and tags** → **Selected branches and tags** → **Add deployment branch or tag rule** → Ref
      type **Branch**, Name pattern `main` → **Add rule**. This must be the only rule.
   2. **Required reviewers:** leave unticked.
   3. **Environment secrets → Add environment secret:** Name `SUPABASE_DB_URL`. Value: Supabase → project →
      **Connect** → **Session pooler** URI, with `[YOUR-PASSWORD]` replaced by the database password (Project
      Settings → Database).
   4. **Add environment secret:** Name `SUPABASE_ANON_KEY`. Value: Supabase → Project Settings → **API Keys** → the
      `anon` `public` key (or the publishable key). Never use `service_role` or `sb_secret_…`.
3. **AWS → CloudFormation stack `fenvix-bootstrap`.**
   1. Open
      <https://github.com/Mircoguidetti/fenvix-app/blob/claude/deploy-pipeline/infra/bootstrap/fenvix-bootstrap.json>
      and click **Download raw file**. This is the pull request's branch; `main` does not have the file until the
      merge.
   2. Open <https://eu-west-1.console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks/create>, signed in
      as an administrator of account 865859654353.
   3. "Choose an existing template" → "Upload a template file" → **Choose file** → **Next**.
   4. Stack name `fenvix-bootstrap`; leave the parameters unchanged → **Next** → **Next**.
   5. Tick "I acknowledge that AWS CloudFormation might create IAM resources with custom names." → **Submit**.
   6. Wait for **CREATE_COMPLETE**.
4. **Cloudflare → API token.**
   1. Open <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → **Edit zone DNS** → **Use
      template**.
   2. **+ Add more**: `Zone` · `Zone` · `Read`.
   3. Zone Resources: `Include` · `Specific zone` · `fenvix.dev`.
   4. **Continue to summary** → **Create Token** → **Copy**.
   5. Back in GitHub, `production` → **Add environment secret**: Name `CLOUDFLARE_API_TOKEN`, Value = the token.
5. **Supabase → Authentication → URL Configuration.**
   1. **Site URL** `https://console.fenvix.dev` → **Save**.
   2. **Redirect URLs → Add URL** `https://console.fenvix.dev/**` → **Save URLs**.
   3. Remove an old `app.fenvix.dev` entry if one is listed.
6. **(Recommended) GitHub → ruleset on `main`.**
   1. Open <https://github.com/Mircoguidetti/fenvix-app/settings/rules> → **New ruleset** → **New branch ruleset**.
   2. Name `main`, Enforcement **Active**, Target branches → **Add target** → **Include default branch**.
   3. Tick **Restrict deletions**, **Require a pull request before merging** (approvals 0) and **Block force
      pushes**.
   4. **Create**.
7. **Merge** the pull request. Then GitHub → **Actions** → **Deploy** runs. The first run takes 30–60 minutes and ends
   with the dashboard on <https://console.fenvix.dev>.

**Optional, any time:** GitHub → `production` → **Environment variables** → **Add variable**: Name `SUPABASE_CA_CERT`.
For the value, go to Supabase → Project Settings → Database → **SSL Configuration** → **Download certificate** and
paste the file's content.

**Later, the GitHub App** (DEPLOY-AWS.md section C):

8. **AWS → Systems Manager → Parameter Store.** Open
   <https://eu-west-1.console.aws.amazon.com/systems-manager/parameters/?region=eu-west-1> →
   `/fenvix/prod/github-app/webhook-secret` → **Show decrypted value** → copy.
9. **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.** Fill in:

   | Field | Value |
   |---|---|
   | GitHub App name | `fenvix` |
   | Homepage URL | `https://console.fenvix.dev` |
   | Callback URL | `https://github.fenvix.dev/github/setup` |
   | Expire user authorization tokens | on |
   | Request user authorization (OAuth) during installation | on |
   | Enable Device Flow | off |
   | Redirect on update | on |
   | Webhook: Active | on |
   | Webhook URL | `https://github.fenvix.dev/webhooks/github` |
   | Webhook secret | the value from click 8 |
   | SSL verification | Enable |

   - Repository permissions: Actions Read-only; Administration Read and write; Checks Read and write; Contents Read
     and write; Metadata Read-only; Pull requests Read and write; Workflows Read and write.
   - Subscribe to events: Pull request, Push, Workflow job.
   - Where can this GitHub App be installed: "Only on this account" → **Create GitHub App**.
10. On the App's page, click **Generate a new client secret** and copy it. Then **Private keys → Generate a private
    key**, which downloads a `.pem` file.
11. **GitHub → `production`:**
    - Variables: `FENVIX_GITHUB_APP_ID`, `FENVIX_GITHUB_APP_SLUG`, `FENVIX_GITHUB_APP_CLIENT_ID`.
    - Secrets: `FENVIX_GITHUB_APP_CLIENT_SECRET`, and `FENVIX_GITHUB_APP_PRIVATE_KEY` (the whole `.pem`).
    - Then delete the `.pem` file.
12. **Actions → Deploy → Run workflow → Run workflow.** Then, in the App: **Advanced → Recent Deliveries** → the
    `ping` → **Redeliver**. Expect `200 {"ok":true,"pong":true}`.
13. Open **<https://console.fenvix.dev> → Projects → Connect GitHub** → install the App on a repository → open the
    setup pull request.

## 4. Still UNKNOWN

The UNKNOWNs in REPORT-deploy-pipeline-2 §6 still apply. One is new: the account's current GitHub plan (click 1). It
is not visible from here.
