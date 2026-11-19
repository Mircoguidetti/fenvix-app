# Review R-024b: deploy pipeline, second pass (`claude/deploy-pipeline` at 64c4c9a)

**Verdict: FIX 4** (G1–G4 below). G1 and G2 are backed by failing tests in `deploy/test/review-r024b.test.mjs`. G3 and
G4 are in the founder's click list and are backed by reproductions. None of them lets a fork, a pull request or a
non-`main` branch reach the role or the secrets. F1–F5 from R-024 are fixed as described, except that F5 still has
one gap in 0014 (G1). The move to `console.fenvix.dev` is complete. Every suite count in the report reproduces.

Reviewer branch: `claude/review-r024b`. **MEASURED** means run here: Node 22.23.5, Docker, a `postgres:16` scratch
server on 54329, and the local Supabase from `scripts/local-supabase/up.sh`. **UNKNOWN** means it needs the real
accounts. Nothing was deployed, and no AWS, Supabase, Cloudflare or Actions access was used.

## Findings

| # | Severity | Finding | Evidence |
|---|---|---|---|
| G1 | Low | **F5 is still open for 0014.** The probe treats 0014 as finished when it sees the policy `workspaces_github_app` (line 457), plus `gh_link_installation` executable by the App and not by `anon`. 0014's last real work is the next statement, line 460: `create or replace function gh_link_installation`, which makes linking start the 30-day trial (the `ci_subscriptions` insert). 0013's version of that function already has the same grants, so a paste or statement-by-statement run cut between line 457 and line 460 passes the probe. 0014 is then recorded as `found` and never run, and linking an installation never starts a trial. The failure is silent and permanent, which is F5's class. **How it was found:** a sweep that cut every migration 0011–0017 before each top-level statement (306 cuts on the scratch server; each file applied on top of the earlier migrations, then `migrate`). Every other cut stops as half-applied or is run, apart from these harmless ones: (a) cuts before the trailing `notify pgrst`; (b) cuts at 0014 lines 493/494, after the function is already replaced, where 0013's grants survive `create or replace`. The founder's database is not affected: it was pasted as one text, and `r024-founder-state.sh founder` still records 0001–0017 without running anything. | `G1: 0014 cut before its re-creation of gh_link_installation`: `migrate` records `found: … 0013, 0014`. |
| G2 | Low | **The commit-after-PutParameter window is mis-reported, and SSM is not restored.** Suppose `PutParameter` succeeds and the admin connection is then lost, so `commit` fails. `ensureRoles` then stops with "the new connection string could not be stored …; the password change was rolled back, **nothing changed**". In fact SSM holds the new string and the role still has its old password. The report mentions this window but says nothing about what the step prints. It matters for the documented rotation ("delete the parameter, run the workflow"): the running API and App still have a working password, they reload SSM within 5 minutes, and from then on they fail until someone reruns the workflow. The message gives no reason to rerun soon. | `G2: the commit fails after PutParameter` (scratch Postgres; the admin backend is terminated right after the SSM write): `SSM holds a new connection string but the role kept its old password; the step said: "… rolled back, nothing changed …"`. |
| G3 | Medium | **Founder click 2 links to a file that does not exist when the click happens.** Report §5, click 2: "Download <https://github.com/Mircoguidetti/fenvix-app/blob/main/infra/bootstrap/fenvix-bootstrap.json>". The merge is click 6, and `main` (091d4c2) has no `infra/bootstrap/` at all, so the page is a 404 at that point. `DEPLOY-AWS.md` A2.1 has the fallback ("before the merge: the same path on the branch `claude/deploy-pipeline`"), but the final list, which is what the founder follows, leaves it out. | `git show origin/main:infra/bootstrap/fenvix-bootstrap.json` → `fatal: path … exists on disk, but not in 'origin/main'`. |
| G4 | Medium (blocking UNKNOWN) | **Click 1 depends on a GitHub plan that the list does not mention.** `Mircoguidetti/fenvix-app` is **private** (GitHub API: `visibility: private`). GitHub's documentation (Deployments and environments) says environment secrets in private repositories need "GitHub Pro, GitHub Team, or GitHub Enterprise", and that deployment branches and tags are available for private repositories on Pro or Team. On GitHub Free, click 1.1 (the branch rule) and clicks 1.3/1.4/3 (environment secrets) cannot be done as written. The deploy would then stop safely: the preflight reads no rule and stops, and the secrets are empty. It would not go live, though, and nothing in the list says why. The account's plan is not visible from here. | Repository visibility from the GitHub API; the documentation page above. |

### Fixes (suggested; checked here, none committed)

- **G1:** add `prosrc like '%trial_ends_at%'` to 0014's `last` (only 0014's version of the function contains it):
  ```js
  … else false end
    and coalesce((select prosrc like '%trial_ends_at%' from pg_proc
                  where oid = to_regprocedure('public.gh_link_installation(bigint,uuid,uuid)')), false)
  ```
- **G2:** record that `PutParameter` succeeded. If `commit` then fails, put back the previous value (`stored`), or
  delete the parameter when there was none, and only then say "nothing changed". If that restore also fails, say
  plainly that SSM holds a string the role does not accept and that the workflow must be rerun now.
- With both patches applied temporarily: `review-r024b`, `review-r024`, `pipeline-2` and `database` gave **37/37**,
  including the "every file applied by hand → found" test and the founder state. The patches were then reverted.
- **G3:** in click 2, link `…/blob/claude/deploy-pipeline/infra/bootstrap/fenvix-bootstrap.json`, or say "on the pull
  request's branch".
- **G4:** add a click 0: GitHub → Settings → Billing and plans → confirm the plan is **Pro** (or Team), or upgrade.
  Making the repository public instead would also unlock environments, but that is the founder's call.

## 1. The reviewer's files (MEASURED)

`git diff origin/claude/review-r024 HEAD -- deploy/test/review-r024.test.mjs infra/github-app/test/review-r024.test.ts
deploy/test/r024-founder-state.sh` is empty. All of them pass: R-024 tests in `deploy` 5/5, in `infra` 2/2.
`r024-founder-state.sh` gives the same table as R-024 and the report:

| Scenario | Run 1 | Run 2 | Public schema changed |
|---|---|---|---|
| founder | probes 0011–0017 all yes; records 0001–0017 `found`; runs nothing | nothing new | no |
| upto0013 | records 0001–0013; applies 0014–0017 | nothing new | yes (expected) |
| upto0010 | STOP "none of migration 0011's" | same | no |

## 2. F1–F5, attacked

- **F1. Fixed.** In `deploy-policy.json`, the only SSM actions that return a value are `ssm:GetParameter` on the five
  named parameters, the CDK version parameter and Ubuntu's two public AMI parameters. `GetParameterHistory`,
  `GetParameters`, `GetParametersByPath` and `ssm:*`/`Get*` are not granted anywhere in the policy. The template
  (`build.mjs --check`: up to date) embeds that policy. The other paths go through roles the deploy role can assume:
  the CDK deploy role reads only the version parameter, and the CloudFormation execution role reads only through
  templates. They are the "deploying code" power R-024 already accepted; they are not a read path.
- **F2. Fixed.** Trust `sub` is exactly `repo:Mircoguidetti/fenvix-app:environment:production`, and `aud` is
  `sts.amazonaws.com` (StringEquals). The owner's casing matches GitHub's canonical `full_name`
  (`Mircoguidetti/fenvix-app`), so the claim will match. Variants such as `ref:refs/heads/main`, `pull_request` or
  another environment are not accepted. A `workflow_run`/`pull_request_target` job that names `production` still
  passes the `main` rule: R-024's warning still applies.
- **F3. Fixed, apart from G2.** Only SQLSTATE `28P01` counts as "refused". XX000, 28000, network errors and timeouts
  stop with "NOT changed" (reviewer's F3 passes; MEASURED). `pg_roles` is checked first. A failed `PutParameter` rolls
  back. The window between `PutParameter` and `commit` is G2. Note, not a finding: the *last* of the 4 attempts
  decides, so 3 timeouts followed by one 28P01 rotates. R-024 suggested "every attempt refused". This is harmless
  unless the pooler can answer 28P01 transiently (UNKNOWN, report §6).
- **F4. Fixed.** MEASURED with `checkAnonKey`:
  - Accepted: `sb_publishable_…` and an anon JWT of the project.
  - Refused: `sb_secret_…`, `service_role`, `authenticated`, `role: ["anon"]`, an anon JWT whose `ref` belongs to
    another project, garbage, and an empty key. No message contained the key.
  - Accepted although wrong: an anon JWT with no `ref`, a publishable key of another project (disclosed), and a value
    with a `Bearer ` prefix or surrounding whitespace. The check trims the value, but the build does not. Each of these
    gives dashboard 401s, not a leak (note).
  - The secret-first expression (`secrets.SUPABASE_ANON_KEY || vars.SUPABASE_ANON_KEY`) is identical in step 1 and
    step 10.
- **F5. Fixed for 0011, 0012, 0013, 0015, 0016 and 0017; 0014 has the G1 gap** (sweep in G1).

## 3. Domain: `console.fenvix.dev`

- `git grep app.fenvix.dev` outside old reports and reviews finds only the test that forbids it.
- `cdk synth --all` (empty App values; with a certificate ARN):
  - CloudFront `Aliases` is `["console.fenvix.dev"]`.
  - `DASHBOARD_URL` is `https://console.fenvix.dev` in all 6 occurrences, and `GITHUB_APP_ID` is empty in all 5.
  - `app.fenvix.dev` appears nowhere in `cdk.out`.
- In the pipeline, `deploy/cli.mjs` takes `APP_DOMAIN` from `cdk.json` `dashboardDomain`, and that one value drives
  the ACM request, the DNS CNAME and the smoke URL.
- Docs: the Supabase Site URL and redirect (`DEPLOY-AWS.md` step 4) and the App's homepage are updated. The App's
  callback stays on `github.fenvix.dev`.
- The dashboard builds its sign-in redirects from `window.location.origin`, so no hostname is hard-coded.
- **CORS is exact.** The origins are a `Set` holding `new URL(DASHBOARD_URL).origin`, and `apiCorsOrigins` is empty
  in `cdk.json`. An exact string compare refuses `http://`, a trailing `/`, other case, and `console.fenvix.dev.evil`.
  The unit test checks both the allowed and the refused origin (MEASURED: 135/135).

## 4. New code paths

- **Branch-policy preflight.** It stops when there is no rule, when the rule is protected branches, or when the rules
  are anything other than exactly `branch:main` (tag rules are typed; one page of up to 100 rules, and any count
  other than 1 fails). A 404 stops. It does not stop on 401/403: it warns and the summary says "NOT checked" (fail
  open, disclosed). GitHub documents the list endpoint as "Anyone with read access to the repository"; whether
  `actions: read` is enough for the job token is UNKNOWN until the first run. The first run of a never-configured
  environment, which GitHub auto-creates with no rule, stops. That closes R-024's ordering gap on `main`.
- **TLS to the pooler.** With `SUPABASE_CA_CERT` set, the admin connection uses `ca` + `rejectUnauthorized` +
  `servername` (verify-full). It is passed to steps 2 and 3, which are the only ones that call `admin()`. The authors'
  stand-in tests pass. The roles' strings (the runner's login check and the Lambdas) stay `sslmode=require`, as
  disclosed.
- **Concurrency.** `deploy-production` applies only to non-PR runs on `refs/heads/main`. Everything else is in
  `test-<event>-<ref>`, with cancel-in-progress only off `main`. A dispatch from another branch can no longer replace
  a pending main deploy. Correct.
- **Cloudflare token.** Only steps 6 and 9 get it as `CLOUDFLARE_API_TOKEN`. Steps 1 and 12 get only a boolean.
  Note: the report says "the CDK app and its dependencies never see it", which overstates it. `unset` clears the
  shell's variable, but `/proc/$PPID/environ` of the step's bash still holds `FENVIX_CF_TOKEN`. MEASURED:
  `FOO_TOKEN=x bash -c 'unset FOO_TOKEN; node -e "…readFileSync(/proc/ppid/environ)…"; true'` → `true`. Any code in
  `cdk deploy` can read it, just as it can read the AWS session in the same step. This narrows the token's exposure
  but does not isolate it; correct the wording.
- **Token scope.** "Edit zone DNS" for `fenvix.dev` plus `Zone · Zone · Read` is what `cloudflare.mjs` uses (zone
  lookup, DNS records). Minimal.

## 5. Founder click list (report §5)

Pages and fields were checked against the current GitHub, AWS, Cloudflare and Supabase UIs as documented: environment
"Deployment branches and tags → Selected branches and tags → Add deployment branch or tag rule"; ruleset fields;
CloudFormation "Choose an existing template / Upload a template file" and the IAM acknowledgement; Cloudflare template
plus "+ Add more"; Supabase URL Configuration. Every step is in a browser, nothing runs on a laptop, and every
variable or secret the workflow reads is either listed or optional (`CLOUDFLARE_ZONE_ID`, `FENVIX_ALARM_EMAIL`,
`FENVIX_RUNNER_MODE`, `FENVIX_DEMO_REPOSITORY`, `SUPABASE_CA_CERT`). Gaps: **G3** (dead link at click 2) and **G4**
(plan prerequisite). Nothing can be removed.

## 6. Suites (MEASURED)

| Suite | Report | Here (branch) | With R-024b tests |
|---|---|---|---|
| `deploy` `npm test` | 49/49 | **49/49** | 49/51 (G1, G2 fail) |
| `infra/github-app` `npm test` (typecheck, synth, nag, policies, bootstrap) | 85/85 | **85/85** | unchanged |
| `github-app` `npm test` | clean, 135/135, 165/165 | typecheck clean, **135/135**, **165/165**, 0 skipped (needs database `gh_test` on 54329) | unchanged |
| `npm run test:rls` | 5 × OK | API, CI, CI EXPLORE, GH, WARM **OK** (`TEST_DATABASE_URL` = scratch) | unchanged |
| Dashboard `api:lint`, `build`, `test:unit`, `api:check` | valid, builds, 66/66, matches | **valid, builds, 66/66, matches** | |
| `actionlint` 1.7.12 | no finding | **no finding** | |
| `cfn-lint` 1.60.1 on the bootstrap template | no finding | **no finding** | |
| `build.mjs --check` | up to date | **up to date** | |
| `cdk synth --all`, App values empty | succeeds | **succeeds** (§3) | |
| `r024-founder-state.sh` ×3 | review's table | **same** (§1) | |
