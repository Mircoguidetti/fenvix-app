# Report: deploy pipeline, second pass (R-024 fixes, dashboard on console.fenvix.dev)

Branch `claude/deploy-pipeline`, after merging `claude/review-r024` (5f2c49a). Founder rule unchanged: deploy = pull
request → merge on `main` → GitHub Actions → AWS; nobody runs anything from a laptop; one-time setup is browser clicks.

Labels: **MEASURED** = run here (this container: Node 22, Docker 29.10.0, `postgres:16` scratch server on 54329 with
trust auth, the local Supabase of `scripts/local-supabase/up.sh`: `supabase/postgres:15.8.1.085` + GoTrue v2.186.0).
**UNKNOWN** = needs the real AWS account, Supabase project, Cloudflare zone or a GitHub Actions run. Nothing was deployed.

The reviewer's files are unchanged: `deploy/test/review-r024.test.mjs`, `infra/github-app/test/review-r024.test.ts`,
`deploy/test/r024-founder-state.sh` (checked with `git diff 5f2c49a -- <file>`: empty).

## 1. Findings

### F1. The deploy role could decrypt every parameter (`ssm:GetParameterHistory`)

- **Change.** `infra/github-app/deploy-policy.json`, `ManageOwnSecrets`: `ssm:GetParameterHistory` removed (nothing
  used it). The role's only SSM value reads are now `ssm:GetParameter` on the five named parameters (plus the CDK
  version parameter and Ubuntu's two public AMI parameters, outside `/fenvix/`). `DescribeParameters` (names only),
  `PutParameter` and `DeleteParameter` stay. Template rebuilt (`node infra/bootstrap/build.mjs`; `--check` up to date).
- **Test.** The existing policy test (`settings-and-policies.test.ts`, "deploy role") now covers every SSM action that
  returns a value (`GetParameter`, `GetParameters`, `GetParametersByPath`, `GetParameterHistory`, wildcards), refuses
  any SSM wildcard action, and refuses `GetParameterHistory`/`GetParameters`/`GetParametersByPath` outright.
  **Before:** reviewer's F1 test fails (lists `GetParameterHistory` on both prefixes); the old test passed.
  **After:** both pass (MEASURED, section 3).

### F2. The deploy role trusted `ref:refs/heads/main` too

- **Change.** `infra/bootstrap/build.mjs`: the trust's `sub` is exactly
  `repo:${GitHubOwner}/${GitHubRepository}:environment:production`; statement id `GitHubActionsProductionEnvironmentOnly`.
  The workflow's only job with `id-token: write` is the deploy job, in that environment. Template rebuilt.
- **Test.** `bootstrap.test.ts` updated to the single `sub`. **Before:** reviewer's F2 test fails (two subs).
  **After:** passes.
- **Founder.** Nothing extra: the stack is not created yet. (Had it been, "Update" with the new file: DEPLOY-AWS.md
  section A step 2, last paragraph.)

### F3. One transient pooler error rotated a role's password

- **Change** (`deploy/lib/roles.mjs`):
  - `tryLogin` returns `"refused"` **only** for SQLSTATE `28P01` (invalid password). Supavisor's
    `Tenant or user not found` (XX000), 28000, timeouts and network errors are never "refused".
  - The stored string is tried **4 times, 10 s apart**; the **last** attempt decides: `ok` on any success; `28P01` →
    rotate; anything else → the step stops with "the password was NOT changed", the running services keep it.
  - Rotation happens only after the admin connection is up (the pooler answers) and `pg_roles` shows the role exists
    and may log in (checked before any login attempt).
  - `begin; alter role ... password '<SCRAM verifier>'; PutParameter; commit`: if the SSM write fails, `rollback`, the
    role keeps its old password, the step stops ("rolled back, nothing changed").
- **Tests.**
  - Reviewer's F3 (a proxy answers the first connection with `FATAL XX000 Tenant or user not found`, then forwards to
    the local Supabase). **Before:** fails (`'refused' !== 'ok'`, the role rotated). **After:** passes, result `kept`,
    the old password still logs in.
  - New (`deploy/test/pipeline-2.test.mjs`, scratch Postgres): a login that fails every time without 28P01 → Stop, the
    role's `pg_authid` verifier unchanged, no `PutParameter`; 28P01 with a failing `PutParameter` → Stop "rolled back",
    verifier unchanged, the stored string tried with `attempts: 4`; then with SSM working → `set`, a new SCRAM verifier.
  - The authors' real-login test (local Supabase) passes `checkAttempts: 1` to stay fast; still: wrong password →
    `refused` → new password; unreachable port → error, no rotation.
- **Residual.** If `PutParameter` succeeds and the `commit` then fails (connection lost in between), SSM holds a
  string whose password the role never got; services that reload it fail until the next deploy, which sees 28P01 and
  rotates again. The window is one round trip; noted, not closed.

### F4. The anon key was not checked

- **Change** (`deploy/lib/supabase.mjs` `checkAnonKey`, called by `preflight`):
  - refuses `sb_secret_...`; refuses a JWT whose `role` is not `anon` (`service_role` named as such); refuses anything
    that is neither a publishable key (`sb_publishable_...`) nor a JWT; refuses an anon JWT whose `ref` differs from
    the project of `SUPABASE_DB_URL`. Every message names `SUPABASE_ANON_KEY`, never the value; for a service_role or
    secret key it also says to roll that key.
  - The key is now read from an **environment secret** `SUPABASE_ANON_KEY` (falls back to a variable of the same
    name): a variable is printed unmasked in the step's `env:` header **before** any check runs, so a wrong paste
    would already be in the log; a secret is masked. The docs ask for the secret.
- **Tests.** Reviewer's F4: **before** `preflight` exits 0 for a service_role JWT and an `sb_secret_` key; **after**
  exit 1, the key not in stdout/stderr; the anon key still accepted. New: another project's anon JWT (unit and through
  `cli.mjs preflight`), an `authenticated` JWT, garbage refused; publishable key accepted; no message contains the key.
- **Limit.** A publishable key carries no project ref: a publishable key of another project is not caught (the
  dashboard's calls then answer 401; DEPLOY-AWS.md "When something fails" says so).

### F5. Probes checked only a migration's first objects

- **Change** (`deploy/lib/migrate.mjs`): each probe is `{ first, last }`. First true and last false = **half-applied →
  Stop, nothing recorded or changed**; found = both true. Last effects:

  | | first (unchanged) | last |
  |---|---|---|
  | 0011 | `ci_runs`, `ci_test_results`, `ci_projects` | RLS on `ci_test_results` and (policy `ci_test_results_control_plane` **or** 0014 has run: `ci_audit_reruns` exists) |
  | 0012 | `ci_explorations`, `ci_runs.skip_misses` | RLS on `ci_explorations` and (policy `ci_explorations_control_plane` **or** 0014 has run) |
  | 0013 | `gh_installations`, `gh_jobs`, role `fenvix_github_app` | policy `ci_usage_events_github_app` |
  | 0014 | `ci_audit_reruns`, no `databases`, role `fenvix_api`, `ci_runs.audit_rerun` | policy `workspaces_github_app` and `gh_link_installation` executable by `fenvix_github_app`, not by `anon` |
  | 0015 | `gh_install_completions`, `ci_trial_accounts`, `api_complete_github_link(text)` | policy `workspace_invites_api_revoke` defined on `api_owner_workspace()` |
  | 0016 | `ci_explorations.received_at` | index `gh_run_summaries_received` |
  | 0017 | `gh_warmups`, `gh_repositories.cache_warm_sha` | RLS on `gh_warmups` and policy `gh_warmups_api_read` |

  Two departures from the review's suggestion, found by testing: **(a)** 0014 drops every `fenvix_control_plane`
  policy, i.e. the last effects of 0011 and 0012; with the suggested probes every fully migrated database (the
  founder's included) would stop as "half-applied". 0014's own evidence (`ci_audit_reruns`, created after that drop)
  stands in for them. **(b)** The suggested last effects of 0014 (`gh_link_installation` grant) and 0015
  (`workspace_invites_api_revoke`) already exist from 0013/0014 (`create or replace` keeps grants; the policy is
  re-created): a cut 0014/0015 was still recorded as found. The table above uses effects only that file makes.
  `has_function_privilege` is wrapped in `CASE` (it raises on a missing role or function; `AND` has no order).
- **Tests.** Reviewer's F5 (0017 cut before its RLS): **before** recorded `found` with `relrowsecurity = false`;
  **after** Stop "0017 looks half-applied", nothing recorded. New: 0013, 0014, 0015 each cut before their last
  statements → Stop, nothing recorded (0014 and 0015 failed with the review's suggested probes, passed after);
  every file applied by hand on a fresh database → found 0001–0017, nothing run. The authors' tests (local Supabase
  fully migrated, migrations 0014+ applied twice by `up.sh`; hand-applied up to 0013; half-applied; foreign) pass.
- **Founder-state reproduction** (`bash deploy/test/r024-founder-state.sh <scenario>`, MEASURED after the change):

  | Scenario | Run 1 | Run 2 | Public schema changed by the runner |
  |---|---|---|---|
  | `founder` (0001–0010, then 0011–0017 as one text) | probes 0011–0017 all yes; records 0001–0017 `found`; runs nothing | "nothing new to apply" | no |
  | `upto0013` | records 0001–0013 `found`; applies 0014–0017 | nothing | yes (expected) |
  | `upto0010` | Stop: "tables in public but none of migration 0011's" | same | no |

  Identical to the review's table.

## 2. The review's notes

| Note | Done |
|---|---|
| **TLS to the pooler** | **Not verified against Supabase's CA by default, said plainly:** whether the pooler's certificate chains to the CA Supabase lets you download could not be checked here (no route to `*.pooler.supabase.com` from this container, no access to the project to download its CA; Supabase's SSL page shows `sslmode=verify-full` against a pooler host, which suggests it does, and mentions CA rotations). Shipping an unchecked CA in the repository would stop every deploy if wrong. Instead: an **optional** environment variable `SUPABASE_CA_CERT` (the downloaded certificate, public): when set, the admin connection (the one carrying the database password) verifies chain and host name (`rejectUnauthorized: true`, `servername` = pooler host: libpq's `verify-full`), and a verification failure stops with its own message. MEASURED with a stand-in pooler (SSLRequest → `S` → TLS with a certificate from a test CA for `localhost`): right CA + host → handshake completes (then the stand-in's 28P01); another CA → `SELF_SIGNED_CERT_IN_CHAIN`; right CA, wrong host → `ERR_TLS_CERT_ALTNAME_INVALID`; in both failures no password is sent. Not done: the roles' strings used by Lambda stay `sslmode=require` (verify-full there needs the CA inside the Lambda bundle; next step once the real chain is known). |
| **Concurrency** | `group`: `deploy-production` only for non-PR runs on `refs/heads/main`; everything else `test-<event>-<ref>`; `cancel-in-progress` only off `main`. A dispatch from another branch is in its own group and cannot cancel or replace a pending main deploy. (Within the main group GitHub keeps one pending run: a newer push replaces an older *pending* one, which deploys a superset; the running one is never cancelled.) Test asserts both expressions. |
| **Cloudflare token only where needed** | Passed as `CLOUDFLARE_API_TOKEN` to steps 6 (dashboard certificate) and 9 (DNS). Step 8 (CDK) receives it as `FENVIX_CF_TOKEN`, hands it to the background watcher's command only (`CLOUDFLARE_API_TOKEN="$FENVIX_CF_TOKEN" node ... watch-certificate &`) and `unset`s it before `cdk deploy`, so the CDK app and its dependencies never see it. Steps 1 and 12 get only `FENVIX_CLOUDFLARE_MANAGED` (`true`/`false`). Test asserts which steps hold the value. |
| **The `production` branch rule** | Documented as **required** and as the **first** step (before the AWS stack: the review's order gap), including "open `production` if it is already listed" (gap 2). Checked by every deploy: `preflight` reads `GET /repos/{repo}/environments/production` and `.../deployment-branch-policies` with the job's `GITHUB_TOKEN` (job permission `actions: read`, passed to step 1 only) and **stops** when there is no rule, when it is "protected branches", or when the rules are anything but exactly branch `main` (tests with a fake API: 5 refusals, 1 pass). If the token is refused (HTTP 401/403) it warns and the summary says "NOT checked" instead of blocking every deploy: GitHub documents these endpoints as readable with the Actions read permission, but no real run confirmed it (UNKNOWN until the first run; the summary line shows which case happened). It cannot stop an edited workflow on another branch (that workflow skips the check); the rule itself does. |
| **Ruleset on `main`** (review gap 3) | Added as a recommended click (section 4, click 5). |
| **Rotation note** | "Rotating a secret" now says running functions' new connections fail for up to 5 minutes. |

## 3. Founder decision: the dashboard is `console.fenvix.dev`

Changed everywhere it was `app.fenvix.dev`: `infra/github-app/cdk.json` (`dashboardUrl` = `https://console.fenvix.dev`
→ the Lambdas' `DASHBOARD_URL` and the API's CORS origin; `dashboardDomain` = `console.fenvix.dev` → the CloudFront
alias, the us-east-1 certificate the pipeline requests, the Cloudflare CNAME `console`, the smoke check
`https://console.fenvix.dev/`), the workflow's environment URL, `deploy/` comments and tests, the infra tests
(CloudFront `Aliases`, settings, stack variables), the API's unit tests (CORS, redirects), `github-app/.env.example`,
`README.md`, `docs/GITHUB-APP.md` (`DASHBOARD_URL` example), `docs/DEPLOY-AWS.md` (diagram, Supabase Site URL and
redirect, App homepage, steps, troubleshooting). The GitHub App's callback stays `https://github.fenvix.dev/github/setup`
(the API's host). A test fails if `app.fenvix.dev` appears in any file but the old reports and reviews.

The pipeline never touches a record named `app`: if `app.fenvix.dev` points somewhere today (for example Vercel), it
stays until removed in Cloudflare by hand.

## 4. Suites (MEASURED, this container)

| Suite | Before (5f2c49a: branch + R-024 tests) | After |
|---|---|---|
| `deploy` `npm test` | 26/30 (F3, F4 ×2, F5 fail) | **49/49** (30 + 19 new in `pipeline-2.test.mjs`) |
| `infra/github-app` `npm test` (typecheck, CDK synth, cdk-nag, policies, bootstrap) | 83/85 (F1, F2 fail; per the review) | **85/85**, typecheck clean |
| `github-app` `npm test` (typecheck, unit, integration) | 135/135, 165/165 (review) | typecheck clean, unit **135/135**, integration **165/165**, 0 skipped |
| `npm run test:rls` | 5 × OK (review) | API, CI, CI EXPLORE, GH, WARM RLS **OK** |
| Dashboard `api:lint`, `build`, `test:unit`, `api:check` | valid, builds, 66/66, matches (review) | valid, builds, **66/66**, matches |
| `actionlint` 1.7.12 (`rhysd/actionlint:1.7.12`, as the workflow) | no finding | **no finding** |
| `cfn-lint` 1.60.1 on `infra/bootstrap/fenvix-bootstrap.json` | no finding | **no finding** |
| `node infra/bootstrap/build.mjs --check` | up to date | **up to date** (rebuilt) |
| `cdk synth --all` with the App's values empty (`-c githubAppId= -c githubAppSlug= -c githubClientId=`) | succeeds | **succeeds** (both stacks; `GITHUB_APP_ID` empty in all 5 functions; `DASHBOARD_URL`/CORS `https://console.fenvix.dev`; with a certificate ARN the CloudFront `Aliases` is `["console.fenvix.dev"]`) |
| `deploy/test/r024-founder-state.sh` founder / upto0013 / upto0010 | as the review's table | **same** (section 1, F5) |

## 5. The founder's one-time clicks (browser only), in order

Exact pages and fields are also in `docs/DEPLOY-AWS.md`, section A.

1. **GitHub → the environment `production` (do this first).**
   <https://github.com/Mircoguidetti/fenvix-app/settings/environments> → **New environment** → Name `production` →
   **Configure environment** (if `production` is already listed, click it instead).
   1. **Deployment branches and tags** → **Selected branches and tags** → **Add deployment branch or tag rule** → Ref
      type **Branch**, Name pattern `main` → **Add rule**. Required: every deploy checks it and stops without it.
   2. **Required reviewers:** leave unticked.
   3. **Environment secrets → Add environment secret:** `SUPABASE_DB_URL` = Supabase → project → **Connect** →
      **Session pooler** URI with `[YOUR-PASSWORD]` replaced by the database password (Project Settings → Database).
   4. **Add environment secret:** `SUPABASE_ANON_KEY` = Supabase → Project Settings → **API Keys** → the `anon`
      `public` key (or the publishable key). Never `service_role` or `sb_secret_...` (the deploy refuses them).
2. **AWS → CloudFormation stack `fenvix-bootstrap`.** Download
   <https://github.com/Mircoguidetti/fenvix-app/blob/main/infra/bootstrap/fenvix-bootstrap.json> (**Download raw file**)
   → <https://eu-west-1.console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks/create> (account
   865859654353, as administrator) → "Choose an existing template" → "Upload a template file" → **Choose file** →
   **Next** → Stack name `fenvix-bootstrap`, parameters unchanged → **Next** → **Next** → tick "I acknowledge that AWS
   CloudFormation might create IAM resources with custom names." → **Submit** → wait for **CREATE_COMPLETE**.
3. **Cloudflare → API token.** <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → **Edit zone DNS**
   → **Use template** → **+ Add more**: `Zone` · `Zone` · `Read` → Zone Resources `Include` · `Specific zone` ·
   `fenvix.dev` → **Continue to summary** → **Create Token** → **Copy** → back in GitHub (`production` →
   **Add environment secret**): `CLOUDFLARE_API_TOKEN` = the token.
4. **Supabase → Authentication → URL Configuration.** **Site URL** `https://console.fenvix.dev` → **Save**;
   **Redirect URLs → Add URL** `https://console.fenvix.dev/**` → **Save URLs** (remove an old `app.fenvix.dev` entry
   if one is listed).
5. **(Recommended) GitHub → ruleset on `main`.** <https://github.com/Mircoguidetti/fenvix-app/settings/rules> →
   **New ruleset** → **New branch ruleset** → name `main`, Enforcement **Active**, Target branches → **Add target** →
   **Include default branch** → tick **Restrict deletions**, **Require a pull request before merging** (approvals 0),
   **Block force pushes** → **Create**.
6. **Merge** the pull request (GitHub → Actions → Deploy runs; first run 30–60 minutes).

Optional, any time: **GitHub → `production` → Environment variables → Add variable** `SUPABASE_CA_CERT` = the
content of Supabase → Project Settings → Database → **SSL Configuration** → **Download certificate** (turns on
certificate verification of the pooler for the admin connection).

Later, the GitHub App (DEPLOY-AWS.md section C):

7. **AWS → Systems Manager → Parameter Store** →
   <https://eu-west-1.console.aws.amazon.com/systems-manager/parameters/?region=eu-west-1> →
   `/fenvix/prod/github-app/webhook-secret` → **Show decrypted value** → copy.
8. **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App:** name `fenvix`; **Homepage URL**
   `https://console.fenvix.dev`; **Callback URL** `https://github.fenvix.dev/github/setup`; Expire user authorization
   tokens on; Request user authorization (OAuth) during installation **on**; Device Flow off; Redirect on update on;
   Webhook Active on, **Webhook URL** `https://github.fenvix.dev/webhooks/github`, **Webhook secret** = click 7; SSL
   verification Enable; repository permissions Actions Read-only, Administration Read and write, Checks Read and
   write, Contents Read and write, Metadata Read-only, Pull requests Read and write, Workflows Read and write; events
   Pull request, Push, Workflow job; "Only on this account" → **Create GitHub App**.
9. On the App's page: **Generate a new client secret** (copy) and **Private keys → Generate a private key** (`.pem`).
10. **GitHub → `production`:** variables `FENVIX_GITHUB_APP_ID`, `FENVIX_GITHUB_APP_SLUG`,
    `FENVIX_GITHUB_APP_CLIENT_ID`; secrets `FENVIX_GITHUB_APP_CLIENT_SECRET`, `FENVIX_GITHUB_APP_PRIVATE_KEY` (whole
    `.pem`); delete the `.pem` file.
11. **Actions → Deploy → Run workflow → Run workflow**; then the App → **Advanced → Recent Deliveries** → the `ping`
    → **Redeliver** (expect `200 {"ok":true,"pong":true}`).
12. **https://console.fenvix.dev → Projects → Connect GitHub** → install on a repository → open the setup pull request.

## 6. Still UNKNOWN (needs the real accounts or a real run)

Everything in `docs/REPORT-deploy-pipeline.md` section 5, plus: whether the job's `GITHUB_TOKEN` with `actions: read`
may read the environment's branch policies (the first run's summary says "checked" or "NOT checked"); whether
Supavisor answers a wrong role password with SQLSTATE 28P01 (if it answered only with a message and no code, a
genuinely wrong stored password would now stop the step instead of rotating: the fix is to delete the parameter,
DEPLOY-AWS.md "Rotating a secret"); whether the pooler's certificate verifies against the CA Supabase lets you
download (`SUPABASE_CA_CERT`); the ACM certificate and CloudFront alias for `console.fenvix.dev`.
