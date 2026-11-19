# Report: deploy pipeline, round 4 (GitHub Free: no environment, no GitHub secrets)

Branch `claude/deploy-pipeline` (PR #15, not merged). Founder decision: the account stays on **GitHub Free**, and
`fenvix-app` is private, so GitHub environments' secrets and deployment branch rules are not available. This round
redesigns the pipeline so that it needs **no GitHub environment and no GitHub secret**. Nothing was deployed. No AWS,
Supabase, Cloudflare or Actions access was used.

**MEASURED** means run in this container: Node 22.23.5, Docker 29.10, a `postgres:16` scratch server on 54329 (with
`gh_test` and `rls_scratch`), and the local Supabase from `scripts/local-supabase/up.sh`. **UNKNOWN** means it needs the
real accounts. **DOCUMENTED** means taken from GitHub's or AWS's documentation, not checked against the real account.

## 1. What changed

| # | Requirement | Change |
|---|---|---|
| 1 | Founder secrets in SSM | New `deploy/lib/bootstrap.mjs`: the founder's values live in SSM Parameter Store under `/fenvix/prod/bootstrap/`: `supabase-db-url` (SecureString, required), `supabase-anon-key` (String), `cloudflare-api-token` (SecureString), and the optional `supabase-ca-cert`, `github-app-id`, `github-app-slug`, `github-app-client-id` (String). Each CLI step reads only the values it needs, itself, from SSM (`GetParameter`, `WithDecryption`). No value passes between steps, except the public anon key, which is checked first and exported as `VITE_SUPABASE_ANON_KEY` for the build step. The Supabase URL is **not** a parameter: it is derived from the connection string (`https://<ref>.supabase.co`), as before, which saves the founder one paste that could disagree with it. The GitHub App's **secrets** go straight to `/fenvix/prod/github-app/private-key` and `client-secret`, where the App's functions already read them. The pipeline reads them only to check their shape (masked first) and never copies them, so there is no second copy and no extra read grant. |
| 1 | Deploy role reads exactly these names | `deploy-policy.json` gains `ReadFounderValues`: `ssm:GetParameter` on the seven exact ARNs, with no wildcard. The role has no `Put`/`Delete` on `bootstrap/`: `ManageOwnSecrets` still covers only `github-app/*` and `cache/*`. The permissions boundary does not cover `bootstrap/`, so no role of the stacks can read the admin connection string or the Cloudflare token. Policy size: 5041 of 6144 characters. |
| 2 | Only `main` deploys, enforced by AWS | Bootstrap trust `sub` is exactly `repo:${GitHubOwner}/${GitHubRepository}:ref:refs/heads/main` (StringEquals, one value). `aud` is unchanged (`sts.amazonaws.com`). `environment: production` and the `actions: read` permission are removed from the workflow. The deploy job's `if` is `github.ref == 'refs/heads/main'`. |
| 2 | R-024 F2 mitigation | Tests moved to a new `.github/workflows/test.yml` (`pull_request` and `workflow_call`; `contents: read`; no `id-token`). `deploy.yml` is triggered **only** by `push: branches: [main]` and `workflow_dispatch`, and calls `test.yml` before deploying. New `infra/github-app/test/workflows.test.ts` fails when: the workflows directory holds anything but these two files; any workflow other than `deploy.yml` has `id-token: write` or `write-all`; `deploy.yml` has a trigger other than push-to-main / `workflow_dispatch` (including `pull_request_target`, `workflow_run`, `issue_comment`, `pull_request`, `schedule`, `workflow_call`, `repository_dispatch`); `id-token` is set at workflow level or on a job other than `deploy`; the deploy job's `if` stops requiring `refs/heads/main`; any workflow reads `${{ secrets.* }}`, uses `secrets: inherit` or names an environment. Comments are stripped before matching. **MEASURED (mutation check):** each of these edits made the test fail and the clean file passes: `workflow_run`, `pull_request_target` and `issue_comment` added to deploy.yml; `id-token: write` in test.yml; a third workflow with `id-token: write`; the `if` replaced by `always()`; `push` to `[main, dev]`; `environment: production` re-added. |
| 3 | Masking | `readFounderValue` trims the value, then writes `::add-mask::` (line by line for a PEM), then returns it. `preflight` masks the password parsed out of the connection string as before. **MEASURED** end to end: `cli.mjs preflight` was run as in the workflow (no value in the environment, `GITHUB_ACTIONS=true`, the AWS SDK pointed at a stand-in SSM endpoint through `AWS_ENDPOINT_URL_SSM`). It asked for only the founder names, with `WithDecryption: true`. Each value's mask line came before the first line that uses it. The password and the token appear in no unmasked line and not in `GITHUB_ENV`. |
| 3 | Cloudflare token exposure | It is in **no** step's environment now. `dashboard-certificate`, `watch-certificate` (the background watcher in step 8) and `dns` read it from SSM in their own process. That removes the `/proc/<pid>/environ` note from round 3. Code running in `cdk deploy` can still read it through the role's AWS session, which it could already do for the role's other powers. |
| 4 | Founder clicks | The GitHub plan click and every environment click are removed. `docs/DEPLOY-AWS.md` section A is rewritten: (1) stack, (2) Parameter Store, (3) Cloudflare token into Parameter Store, (4) Supabase URLs, then merge. Section C4 (App values), D (optional), the failure table and rotation are updated. **Main ruleset dropped:** branch protection and rulesets are not available for private repositories on GitHub Free (DOCUMENTED). The page says so and states the consequence. |
| 5 | Template | `build.mjs` rebuilt (`--check`: up to date). Role description and statement Sid are `GitHubActionsMainBranchOnly`. |
| – | Optional settings | `CLOUDFLARE_ZONE_ID`, `FENVIX_ALARM_EMAIL`, `FENVIX_RUNNER_MODE` and `FENVIX_DEMO_REPOSITORY` stay as **repository variables** (`vars.*`). They are not secret and are optional. Repository-level variables are available on Free (DOCUMENTED). `SUPABASE_CA_CERT` moved to SSM (`supabase-ca-cert`). The former fallback `vars.SUPABASE_ANON_KEY` is gone. |
| – | Removed | `deploy/lib/github-environment.mjs` (the read-back of the environment's branch rule) and its four tests, because there is no environment to check. |

### Residual risk (stated plainly)

- **The test is a tripwire, not a gate.** On GitHub Free a private repository cannot require pull requests on `main`
  or block direct pushes. Anyone with write access (a person, or a token or agent with `contents: write`) can put a
  workflow on `main`. That workflow's job on `main` with `id-token: write` gets the deploy role on its first run, before
  any test fails. Through `workflow_run`, `issue_comment`, `schedule`, or a push to main, that job can then deploy code,
  read the Supabase admin connection string and the Cloudflare token from SSM, and (through deployed code) the App's
  secrets.
- **The other environment-based control is also gone.** The round-3 design had a second control (environment + branch
  rule + read-back). The new design has one control, AWS's `sub` check, which is equivalent to "anything on `main`".
- **What still holds:** a branch (even with an edited workflow), a pull request (including one from a fork) and a tag
  cannot assume the role. AWS refuses their `sub`.
- **Mitigation that remains:** give write access only to people and tools you would let deploy, and read every change
  under `.github/workflows/` before merging. A paid plan would add a `main` ruleset and an environment as a second
  check; the pipeline does not need either.
- **Not used:** GitHub's OIDC subject customization (it could bind the token to `job_workflow_ref`). Setting it is an
  API call, not a browser click, and whether STS matches that claim was UNKNOWN in R-024.

## 2. Reviewer tests (R-024, R-024b): what still applies, what was replaced

| File | Status |
|---|---|
| `deploy/test/review-r024.test.mjs` (F3, F4 ×3, F5) | **unchanged** (`git diff origin/claude/review-r024` empty), **5/5 pass**. F4 runs `preflight` with `SUPABASE_DB_URL`/`SUPABASE_ANON_KEY` in the environment. That is the "env" source (bootstrap.mjs: chosen when `SUPABASE_DB_URL` is set; the workflow sets none), so the reviewer's test exercises the same `checkAnonKey` path. |
| `deploy/test/r024-founder-state.sh` | **unchanged**. founder: 0001–0017 `found`, nothing run, schema unchanged · upto0013: 0014–0017 applied · upto0010: STOP "none of migration 0011's", unchanged. This is the same table as R-024/R-024b. |
| `deploy/test/review-r024b.test.mjs` (G1, G2) | **unchanged** (`git diff origin/claude/review-r024b` empty), **2/2 pass**. |
| `infra/github-app/test/review-r024.test.ts` **F1** | **Extended, not weakened.** The allow-set of SSM value reads was "the five parameters"; it is now those five **plus the seven `/fenvix/prod/bootstrap/*` names**. Why: the founder's values moved from GitHub secrets into SSM by decision, so the role must read them. The test still fails on any other name, on any wildcard, and on `GetParameterHistory`/`GetParameters`/`GetParametersByPath`. |
| `infra/github-app/test/review-r024.test.ts` **F2** | **Replaced.** It asserted (a) trust `sub` = exactly `…:environment:production`, and (b) every job with `id-token: write` declares `environment: production`. Both are impossible on Free for a private repository. The equivalent now asserts (a) trust `sub` = exactly `…:ref:refs/heads/main`, and (b) exactly one job in `deploy.yml` has `id-token: write`, its `if` is `github.ref == 'refs/heads/main'`, and it names no environment. R-024 F2's own concern (a job without an environment on `main` getting the role through `workflow_run`/`issue_comment`/…) is now what the trust admits by design. It is held off by `workflows.test.ts` (§1) and disclosed as residual risk. |

Authors' tests changed for the same reason:

- `bootstrap.test.ts`: the trust is `ref:refs/heads/main`, with no `environment:`. The workflow names no environment.
- `settings-and-policies.test.ts`: the read allow-list gains the seven names. `ReadFounderValues` must be exactly
  `ssm:GetParameter` on exactly those ARNs. No other statement may reach `bootstrap/`, and no write action may reach
  it. The boundary must not mention it.
- `pipeline-2.test.mjs`: the four branch-rule tests are removed. The concurrency expression no longer needs
  `event_name` (no `pull_request` trigger). "Token only in steps 6/8/9" becomes "token in no step; only
  `dashboard-certificate`, `watch-certificate`, `dns` read it".
- `units.test.mjs`: the "half configured" message now names the SSM parameters.

New tests:

- `deploy/test/bootstrap.test.mjs` (10):
  - The policy and `founderParameterNames()` agree.
  - SecureString/required types.
  - Exact name, `WithDecryption`, mask first.
  - PEM masked per line.
  - Missing optional → empty, missing connection string → STOP naming it.
  - `AccessDenied` → STOP with the error class only.
  - The env source never calls SSM.
  - CLI end to end ×3 (masking order, `GITHUB_ENV` public only; no token → `FENVIX_CLOUDFLARE_MANAGED=false`; no
    connection string → STOP; a `service_role` key in SSM → STOP, never printed).
- `infra/github-app/test/workflows.test.ts` (6): §1.

## 3. Suites (MEASURED, after the changes)

| Suite | Result |
|---|---|
| `deploy` `npm test` (local Supabase up, 0 skipped) | **57/57** (51 − 4 branch-rule tests + 10 new) |
| `infra/github-app` `npm test` (typecheck, synth, nag, policies, bootstrap, workflows) | **91/91** (85 + 6 new) |
| `github-app` `npm test` | typecheck clean, unit **135/135**, integration **165/165**, 0 skipped |
| `npm run test:rls` (`TEST_DATABASE_URL` = scratch) | API, CI, CI EXPLORE, GH, WARM RLS **OK** |
| Dashboard `api:lint`, `build`, `test:unit`, `api:check` | valid, builds, **66/66**, matches |
| `actionlint` 1.7.12 (both workflows, including the `workflow_call`) | no finding |
| `cfn-lint` 1.60.1 on `infra/bootstrap/fenvix-bootstrap.json` | no finding |
| `node infra/bootstrap/build.mjs --check` | up to date |
| `cdk synth --all`, App values empty, with a certificate ARN | succeeds. `Aliases` is `["console.fenvix.dev"]`; `GITHUB_APP_ID` is empty in all 5; `/bootstrap/` appears in neither template. |
| `r024-founder-state.sh` ×3 | same table as R-024 (§2) |

## 4. FINAL: the founder's one-time browser clicks for console.fenvix.dev, in order

Everything is done in a browser, and nothing runs on a laptop. **Nothing is set in GitHub.** DEPLOY-AWS.md section A
has the same steps with more explanation.

1. **AWS → CloudFormation stack `fenvix-bootstrap`.**
   1. Open
      <https://github.com/Mircoguidetti/fenvix-app/blob/claude/deploy-pipeline/infra/bootstrap/fenvix-bootstrap.json>
      → **Download raw file**. This is the pull request's branch; `main` gets the file at the merge.
   2. Open <https://eu-west-1.console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks/create>, signed in
      as an administrator of account 865859654353.
   3. "Choose an existing template" → "Upload a template file" → **Choose file** → **Next**.
   4. Stack name `fenvix-bootstrap`; leave the parameters unchanged → **Next** → **Next**.
   5. Tick "I acknowledge that AWS CloudFormation might create IAM resources with custom names." → **Submit**.
   6. Wait for **CREATE_COMPLETE**.
   - If a `fenvix-bootstrap` stack already exists from an earlier file: **Update** → "Replace current template" →
     upload → Next → Next → tick → **Submit**.
2. **AWS → Parameter Store: the Supabase values.**
   1. Open <https://eu-west-1.console.aws.amazon.com/systems-manager/parameters/create?region=eu-west-1> (region
      Europe (Ireland)).
   2. For each row: **Name**, **Tier** Standard, **Type**, **Data type** text, **Value** → **Create parameter**.
      SecureString keeps the default key `alias/aws/ssm`.

   | Name | Type | Value |
   |---|---|---|
   | `/fenvix/prod/bootstrap/supabase-db-url` | SecureString | Supabase → project → **Connect** → **Session pooler** URI, with `[YOUR-PASSWORD]` replaced by the database password (Project Settings → Database) |
   | `/fenvix/prod/bootstrap/supabase-anon-key` | String | Supabase → Project Settings → **API Keys** → the `anon` `public` key (or the publishable key `sb_publishable_…`). Never `service_role` or `sb_secret_…`. |

3. **Cloudflare → API token, then into Parameter Store.**
   1. Open <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → **Edit zone DNS** → **Use
      template**.
   2. **+ Add more**: `Zone` · `Zone` · `Read`.
   3. Zone Resources: `Include` · `Specific zone` · `fenvix.dev`.
   4. **Continue to summary** → **Create Token** → **Copy**.
   5. Parameter Store (link of click 2) → **Create parameter**: Name `/fenvix/prod/bootstrap/cloudflare-api-token`,
      Tier Standard, Type **SecureString**, Value = the token → **Create parameter**.
4. **Supabase → Authentication → URL Configuration.**
   1. **Site URL** `https://console.fenvix.dev` → **Save**.
   2. **Redirect URLs → Add URL** `https://console.fenvix.dev/**` → **Save URLs**.
   3. Remove an old `app.fenvix.dev` entry if one is listed.
5. **Merge PR #15.** Then GitHub → **Actions** → **Deploy** runs. The first run takes 30–60 minutes and ends with the
   dashboard on <https://console.fenvix.dev>.

**Dropped:** the GitHub plan check, the `production` environment (branch rule, secrets) and the `main` ruleset. The
ruleset is not available for private repositories on GitHub Free (DOCUMENTED). Consequence: a direct push to `main` by
anyone with write access deploys (§1, residual risk).

**Optional, any time:** Parameter Store → `/fenvix/prod/bootstrap/supabase-ca-cert`, type String. For the value, go to
Supabase → Project Settings → Database → **SSL Configuration** → **Download certificate** and paste the file's content.

**Later, the GitHub App** (DEPLOY-AWS.md section C):

6. **AWS → Parameter Store** → `/fenvix/prod/github-app/webhook-secret` → **Show decrypted value** → copy.
7. **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.** Fill in:

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
   | Webhook secret | the value from click 6 |
   | SSL verification | Enable |

   - Repository permissions: Actions Read-only; Administration Read and write; Checks Read and write; Contents Read
     and write; Metadata Read-only; Pull requests Read and write; Workflows Read and write.
   - Subscribe to events: Pull request, Push, Workflow job.
   - Where can this GitHub App be installed: "Only on this account" → **Create GitHub App**.
8. On the App's page, click **Generate a new client secret** and copy it. Then **Private keys → Generate a private
   key**, which downloads a `.pem` file.
9. **AWS → Parameter Store → Create parameter**, five times (Tier Standard, Data type text):

   | Name | Type | Value |
   |---|---|---|
   | `/fenvix/prod/bootstrap/github-app-id` | String | App ID |
   | `/fenvix/prod/bootstrap/github-app-slug` | String | the last part of `https://github.com/apps/<slug>` |
   | `/fenvix/prod/bootstrap/github-app-client-id` | String | Client ID |
   | `/fenvix/prod/github-app/client-secret` | SecureString | the client secret |
   | `/fenvix/prod/github-app/private-key` | SecureString | the whole `.pem` content |

   Then delete the `.pem` file.
10. **Actions → Deploy → Run workflow** (branch `main`) **→ Run workflow**. Then, in the App: **Advanced → Recent
    Deliveries** → the `ping` → **Redeliver**. Expect `200 {"ok":true,"pong":true}`.
11. Open **<https://console.fenvix.dev> → Projects → Connect GitHub** → install the App on a repository → open the
    setup pull request.

## 5. Still UNKNOWN

The UNKNOWNs in REPORT-deploy-pipeline-2 §6 still apply. New or changed ones:

- **The real `sub` claim.** For a job on `main` with no environment, GitHub's documented default is
  `repo:Mircoguidetti/fenvix-app:ref:refs/heads/main`. If the repository or account has customized OIDC subject claims,
  "AWS credentials" fails safely, with nothing deployed.
- **Decrypting through `aws/ssm`.** The deploy role decrypts the founder's SecureStrings through `aws/ssm` with no
  `kms:Decrypt` grant. This is the same reliance as the existing reads of the database URLs, not new.
- **Two GitHub Free facts.** Both are DOCUMENTED, not verified here: that rulesets are unavailable on private
  repositories, and that repository variables are available.
