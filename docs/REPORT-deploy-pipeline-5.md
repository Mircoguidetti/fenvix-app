# Report: deploy pipeline, round 5 (review R-024c: K1–K5)

Branch `claude/deploy-pipeline` (PR #15, not merged), with `origin/claude/review-r024c` merged in. Nothing was
deployed. No AWS, Supabase, Cloudflare or GitHub Actions access was used.

**MEASURED** = run in this container (Node 22.23.5, Docker 29.10, `postgres:16` scratch on 54329 with `gh_test` and
`rls_scratch`, local Supabase from `scripts/local-supabase/up.sh`). **DOCUMENTED** = taken from GitHub's or AWS's
documentation as quoted in `docs/REVIEW-R-024c.md`, not checked against the real accounts. **UNKNOWN** = needs a real
run.

## 1. What changed

| # | Finding | Change |
|---|---|---|
| K1 | Blocker: the trust's `sub` never matched (immutable subject format) | `infra/bootstrap/build.mjs` gains the parameters `GitHubOwnerId` (default `17613795`) and `GitHubRepositoryId` (default `1434576189`), both `^[0-9]{1,20}$`. The trust's `sub` is exactly `repo:${GitHubOwner}@${GitHubOwnerId}/${GitHubRepository}@${GitHubRepositoryId}:ref:refs/heads/main`, which resolves to `repo:Mircoguidetti@17613795/fenvix-app@1434576189:ref:refs/heads/main`. The trust also requires `token.actions.githubusercontent.com:repository_id` = `${GitHubRepositoryId}`. The review lists it as an STS key (DOCUMENTED). It adds no founder click: the defaults are right, so the founder leaves the parameters unchanged. |
| K2–K4 | The tripwire matched text with regular expressions | `infra/github-app/test/workflows.test.ts` now parses each workflow with the `yaml` package, now a devDependency of `infra/github-app` (lockfile updated, so `npm ci` in `test.yml` installs it). The settings are `parseAllDocuments`, YAML 1.2, `strict`, `uniqueKeys`, `merge: false`. Details below the table. |
| K5 | `job_workflow_ref` | The trust requires `token.actions.githubusercontent.com:job_workflow_ref` = `${GitHubOwner}/${GitHubRepository}/.github/workflows/deploy.yml@refs/heads/main`. As a result, only a job of `deploy.yml` on `main` can assume the role. A new workflow file on `main` (`workflow_run`, `issue_comment`, `schedule`, …) cannot, whatever the tripwire says. The deploy job stays written directly in `deploy.yml`, not in a reusable workflow; the review warns that a reusable workflow would let any caller on `main` match. Role description: "jobs of deploy.yml on its branch main only". `actor_id` (the review's optional extra) was **not** added: it was not in this round's scope, and it would refuse deploys started by anyone but the founder. Adding it is one template line if wanted later. |
| – | Docs | `DEPLOY-AWS.md`: the deploy access row, step 1 and "What keeps other code away from AWS" are rewritten (the three claims, the narrower residual risk, the UNKNOWN). There is a new line on the GitHub Free Actions minutes quota (review §6). The comments in `deploy.yml` are updated. REPORT-4 §1 (residual risk, "Not used") and §5 ("real `sub` claim") are marked out of date and point here. |

The new tripwire (K2–K4) works in three layers:

- **It refuses the file outright** on:
  - any parse error or warning;
  - more than one document;
  - any alias, anchor, explicit tag, merge key `<<` or non-scalar key;
  - any multi-line quoted string;
  - any line other than the top-level `on:` that looks like an `on` key: `^\s*["']?on["']?\s*:`. This closes the K4 class even for parsers more lenient than `yaml`.
- **It then asserts on the parsed object:**
  - `deploy.yml`: `on` equals `{push: {branches: [main]}, workflow_dispatch: null}`. The jobs are exactly `test` and `deploy`, and only `deploy` grants the token, as `{contents: read, id-token: write}`. `deploy.if` is `github.ref == 'refs/heads/main'`, `needs` is `test`, and `deploy` has no `uses`. `test.uses` is `./.github/workflows/test.yml`. Third-party steps are pinned to commit SHAs.
  - `test.yml`: `on` equals `{pull_request: null, workflow_call: null}` and `permissions` equals `{contents: read}`. No job grants the token and no job calls a workflow.
  - Every workflow: no string that reads `${{ … secrets … }}`, and no job `environment` or `secrets`.
  - Rule for "grants the token": any string permission other than `read-all`, or any key matching `id[-_]?token`.
- **File list:** the extension filter is now case-insensitive (`/\.ya?ml$/i`).

### Residual risk (stated plainly, after K1 + K5)

- **What AWS enforces (as configured; DOCUMENTED, not yet exercised):**
  - The token must come from a job running on `refs/heads/main`, of the repository with id `1434576189`, in the workflow file `.github/workflows/deploy.yml`.
  - Refused: a branch, a tag, a pull request (also from a fork), a `merge_group`, any other workflow file on `main`, and a re-created repository with the same name.
- **What remains:** someone with write access puts a change on `main`, by a direct push (GitHub Free cannot forbid it on a private repository) or by a merged pull request. The change is to `deploy.yml` itself, or to code it runs: npm packages, the CDK app, `deploy/` scripts. Its first run gets the role before any test can object. The role can deploy code that reads the App's secrets, and it reads the Supabase admin connection string and the Cloudflare token. Mitigation: give write access only to people and tools you would let deploy, and read every change before merging. The tripwire is still only a tripwire: it fails the PR and the deploy run of a bad change. It cannot stop a change pushed straight to `main` from running once.
- **What K5 cannot catch:** a job added *inside* `deploy.yml` has the same `job_workflow_ref` as the deploy job. Only the tripwire and the review of `deploy.yml` changes catch that.
- **What is VERIFIED here:**
  - The template contains exactly these four `StringEquals` keys (`aud`, `sub`, `repository_id`, `job_workflow_ref`), with no wildcard and no `StringLike`.
  - The parameter defaults resolve to the values above, and cfn-lint is clean.
  - The tripwire catches all of the review's bypasses plus 20 more. The bypass cases are listed in §2.
- **What is UNKNOWN until the first real run:**
  - Whether IAM accepts `repository_id` and `job_workflow_ref` as trust conditions on stack creation. DOCUMENTED as STS keys. If IAM refused, click 1 would roll back, and nothing would be created.
  - The real `sub`. DOCUMENTED as the immutable format; the ids are MEASURED by the review.
  - The value GitHub puts in `job_workflow_ref` for a job written directly in `deploy.yml`. GitHub documents the claim for reusable workflows only.
  - Whether GitHub's own YAML parser accepts the K4 file (irrelevant now: the tripwire refuses it either way).
  - If any of the trust's three claims differs, the deploy run stops at step "AWS credentials" and changes nothing (fail safe). The fix would be one template value, by an agent; the founder would update the stack once with the new file (click 1's update path).

## 2. Reviewer tests

| File | Status |
|---|---|
| `infra/github-app/test/review-r024c.test.ts` | **Unchanged** (`git diff f704090` empty). **7/7 pass** under `npm test`. See the harness note below. |
| `infra/github-app/test/review-r024.test.ts` F1 | Unchanged, passes. |
| `infra/github-app/test/review-r024.test.ts` F2 | **Updated to the K1/K5 trust.** It asserts that `Condition` is only `StringEquals`, and that `sub`, `repository_id` and `job_workflow_ref` are exactly the values above. It finds the job with the token by **parsing** `deploy.yml` with `yaml` (strict, unique keys, no merge), not by a regex split (the K2a gap). That job must be exactly `deploy`, with the main-only `if` and no environment. The review asked for `job_workflow_ref` in F2; this restores "only `deploy.yml`" at the AWS side. Passes. |
| `infra/github-app/test/review-r012.test.ts` | Unchanged, passes. |
| `deploy/test/review-r024.test.mjs`, `review-r024b.test.mjs`, `r024-founder-state.sh` | Unchanged, pass. The founder-state table is the review's: founder 0001–0017 `found`, schema unchanged · upto0013 0014–0017 applied · upto0010 STOP "none of migration 0011's", unchanged. |

**A defect in the review's harness, and how it is handled (MEASURED).**

- **The defect:** the K2–K4 tests spawn `node --test` from inside a test. When the test file itself runs in a
  `node --test` child process (Node's default "process" isolation), the child inherits `NODE_TEST_CONTEXT`. It then
  prints "run() is being called recursively… skipping running files" and exits 0, whatever the workflows contain. So
  under plain `node --test test/review-r024c.test.ts`, or the old `npm test`, K2–K4 could never pass, even with a
  perfect tripwire. MEASURED: 2 pass (K1, K5), 5 fail.
- **The fix, without touching the review's file:** `infra/github-app/package.json` now runs the suite with
  `--experimental-test-isolation=none`, so test files run in the runner's own process and the review's child
  `node --test` really runs the tripwire. The full suite was checked under this mode: **125/125**. The review's file
  also passes **7/7** when run directly (`node test/review-r024c.test.ts`), or with
  `node --test --experimental-test-isolation=none test/review-r024c.test.ts`.
- **Proof the passes are real:** new `infra/github-app/test/workflows-harness.test.ts` runs the same harness with
  `NODE_TEST_CONTEXT` removed from the child's environment. It asserts:
  1. **The control:** the real workflows **pass** the copied tripwire.
  2. **Each mutation:** the tripwire loaded (its first check ran, and there is no "Cannot find module") and failed
     on a check.
- **The cases it covers:** the review's five, byte for byte, plus 20 more:
  - unquoted and single-quoted `id-token` keys;
  - flow-mapping permissions;
  - `write-all` on `deploy.yml`'s `test` job;
  - `"on"` and `'on'` keys;
  - `workflow_run` added plainly;
  - `branches: [main, '**']`;
  - a duplicate `on`;
  - a second document, and `...` followed by more;
  - a merge key and a `!!str` tag;
  - the deploy `if` removed or widened;
  - `environment: production`;
  - `${{ secrets.X }}`;
  - a third workflow file, and `Other.YML`;
  - workflow-level `write-all` in `test.yml`.
- **Before the fix (MEASURED):** with this round's changes stashed, the review's file run directly fails 7/7, as the
  review states.

## 3. Gates (MEASURED, final tree)

| Gate | Result |
|---|---|
| `infra/github-app` `npm test` (typecheck, synth, cdk-nag, policies, bootstrap, workflows, harness, R-012/R-024/R-024c) | **125/125**, 0 skipped. The count is 91 earlier − 6 old tripwire checks + 7 new tripwire checks + 7 R-024c + 26 harness |
| `deploy` `npm test` (local Supabase up) | **57/57**, 0 skipped |
| `github-app` `npm test` | typecheck clean, unit **135/135**, integration **165/165**, 0 skipped |
| `npm run test:rls` (scratch `rls_scratch`) | API, CI, CI EXPLORE, GH, WARM RLS **OK** |
| Dashboard `api:lint`, `build`, `test:unit`, `api:check` | valid, builds, **66/66**, matches |
| `actionlint` 1.7.12 (the CI's Docker image `rhysd/actionlint:1.7.12`, with shellcheck) | no finding |
| `cfn-lint` 1.60.1 on `infra/bootstrap/fenvix-bootstrap.json` | no finding |
| `node infra/bootstrap/build.mjs --check` | up to date |
| `r024-founder-state.sh` ×3 | as in §2 |

## 4. FINAL: the founder's one-time browser clicks, in order

Everything is done in a browser, and nothing runs on a laptop. **Nothing is set in GitHub before the merge.** K1 and
K5 add no click: the new template parameters (`GitHubOwnerId`, `GitHubRepositoryId`) already hold the right values,
so leave every parameter as it is. `docs/DEPLOY-AWS.md` section A has the same steps with more explanation.

1. **AWS → CloudFormation: create the stack `fenvix-bootstrap`.**
   1. Open
      <https://github.com/Mircoguidetti/fenvix-app/blob/claude/deploy-pipeline/infra/bootstrap/fenvix-bootstrap.json>
      → **Download raw file** (the download icon above the file, on the right).
   2. Open <https://eu-west-1.console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks/create>, signed in
      as an administrator of account `865859654353`, region Europe (Ireland).
   3. **Prerequisite – Prepare template:** "Choose an existing template". **Specify template:** "Upload a template
      file" → **Choose file** → select the downloaded `fenvix-bootstrap.json` → **Next**.
   4. **Stack name:** `fenvix-bootstrap`. **Parameters:** leave all of them unchanged (`GitHubOwner` `Mircoguidetti`,
      `GitHubRepository` `fenvix-app`, `GitHubOwnerId` `17613795`, `GitHubRepositoryId` `1434576189`,
      `CreateOidcProvider` `true`) → **Next**.
   5. **Configure stack options:** change nothing → **Next**.
   6. **Review:** tick "I acknowledge that AWS CloudFormation might create IAM resources with custom names." →
      **Submit**.
   7. Wait until the stack's status is **CREATE_COMPLETE** (Events tab; a few minutes).
   - If a `fenvix-bootstrap` stack already exists from an earlier file: select it → **Update** → "Replace existing
     template" → "Upload a template file" → **Choose file** → **Next** → leave the parameters (the two new ones show
     their defaults) → **Next** → **Next** → tick the acknowledgement → **Submit** → wait for
     **UPDATE_COMPLETE**.
   - If `CreateOidcProvider` fails because the account already has the provider
     `token.actions.githubusercontent.com`: delete the failed stack, then repeat this click with `CreateOidcProvider`
     set to `false`.
2. **AWS → Systems Manager → Parameter Store: the two Supabase values.**
   1. Open <https://eu-west-1.console.aws.amazon.com/systems-manager/parameters/create?region=eu-west-1>.
   2. For each row below, fill in **Name**, **Description** (leave empty), **Tier** Standard, **Type**, **Data type**
      `text` and **Value**, then **Create parameter**. A SecureString keeps **KMS key source** "My current account"
      and **KMS Key ID** `alias/aws/ssm`.

   | Name | Type | Value |
   |---|---|---|
   | `/fenvix/prod/bootstrap/supabase-db-url` | SecureString | Supabase → your project → **Connect** → **Session pooler** → the URI, with `[YOUR-PASSWORD]` replaced by the database password (Project Settings → Database → Database password; reset it there if unknown) |
   | `/fenvix/prod/bootstrap/supabase-anon-key` | String | Supabase → Project Settings → **API Keys** → the `anon` `public` key (or the publishable key `sb_publishable_…`). Never `service_role` or `sb_secret_…` |

3. **Cloudflare → API token, then into Parameter Store.**
   1. Open <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → template **Edit zone DNS** →
      **Use template**.
   2. **Permissions:** keep `Zone` · `DNS` · `Edit`, then **+ Add more** → `Zone` · `Zone` · `Read`.
   3. **Zone Resources:** `Include` · `Specific zone` · `fenvix.dev`.
   4. **Continue to summary** → **Create Token** → **Copy** the token.
   5. Open the Parameter Store link from click 2 → Name `/fenvix/prod/bootstrap/cloudflare-api-token`, Tier
      Standard, Type **SecureString**, Data type `text`, Value = the token → **Create parameter**.
4. **Supabase → Authentication → URL Configuration.**
   1. **Site URL:** `https://console.fenvix.dev` → **Save changes**.
   2. **Redirect URLs** → **Add URL** → `https://console.fenvix.dev/**` → **Save URLs**.
   3. If an old `app.fenvix.dev` entry is listed, delete it (the bin icon on its row).
5. **GitHub → merge PR #15.** Open <https://github.com/Mircoguidetti/fenvix-app/pull/15> → **Merge pull request** →
   **Confirm merge**.

What happens next: GitHub → **Actions** → **Deploy** runs on its own. It runs the Tests, then "Deploy to production".
The first run takes 30–60 minutes and ends with the dashboard on <https://console.fenvix.dev>. If it stops at "AWS
credentials", that is the UNKNOWN of §1 (a claim value differs). Nothing will have been changed. Send the run's link
to an agent; the fix is a template value, followed by click 1's update path.

The GitHub App (`docs/DEPLOY-AWS.md` section C, clicks 6–11 of REPORT-deploy-pipeline-4 §4) comes later, after this
first deploy, and is unchanged by this round. The optional CA certificate parameter (REPORT-4 §4, "Optional") is also
unchanged.
