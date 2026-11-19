# Review R-024c: deploy pipeline, round 4 (GitHub Free, founder values in SSM)

**Verdict: FIX 5** (K1–K5). Each finding has a failing test in `infra/github-app/test/review-r024c.test.ts`: 7 tests,
all fail on `claude/deploy-pipeline` at `fc5257d`. Nothing was deployed. No AWS, Supabase or Cloudflare access was used.
GitHub was used read-only, to read the repository's id and creation date.

Labels: **MEASURED** = run in this container. **DOCUMENTED** = read in GitHub's or AWS's current documentation (fetched
2026-11-19), not checked against the real accounts. **UNKNOWN** = needs a real run.

| # | Severity | Finding | Test |
|---|---|---|---|
| K1 | **Blocker** (fails safe) | The trust's `sub` can never match: this repository's tokens use GitHub's immutable subject format | `K1` |
| K2 | Medium | Tripwire bypass: quoted keys and values (`"id-token": write`, `permissions: "write-all"`, a quoted job name) | `K2a`–`K2c` |
| K3 | Medium | Tripwire bypass: YAML alias (`id-token: *w`) | `K3` |
| K4 | Medium | Tripwire bypass: a fake `on:` inside a multi-line quoted `name`, with the real triggers (incl. `workflow_run`) under `"on":` | `K4` |
| K5 | Medium | Residual risk can be narrowed for free: AWS STS matches `job_workflow_ref` directly; the report says this was UNKNOWN | `K5` |

## K1. The deploy role can never be assumed: wrong `sub` format (blocker)

- **DOCUMENTED:** GitHub, *OpenID Connect reference → Immutable subject claims*: "repositories created after July 15,
  2026 now use an immutable default subject format that includes both the owner ID and repository ID". The syntax is
  `repo:OWNER@OWNER-ID/REPO@REPO-ID:ref:refs/heads/BRANCH`. The page also says: "Repository renames and transfers after
  July 15, 2026 also move to the immutable subject format", and with claim customization "owner_id and repo_id are
  always included … You can't remove these IDs".
- **MEASURED (GitHub API, read-only):** `Mircoguidetti/fenvix-app` was created on `2026-10-26T15:32:56Z`. Repository
  id `1434576189`, owner `Mircoguidetti` with id `17613795`. The login's casing matches the template default.
- **Consequence:** the deploy job's token carries
  `repo:Mircoguidetti@17613795/fenvix-app@1434576189:ref:refs/heads/main`. The trust is `StringEquals`
  `repo:Mircoguidetti/fenvix-app:ref:refs/heads/main`, so step "AWS credentials" fails on every run. It fails safe
  (nothing deploys), but click 5 of REPORT-4 §4 ("Merge PR #15 … ends with the dashboard on console.fenvix.dev") cannot
  happen. The R-024/R-024b `environment:production` trust had the same defect, and both earlier reviews missed it.
- REPORT-4 §5 ("The real `sub` claim … GitHub's documented default is `repo:Mircoguidetti/fenvix-app:ref:refs/heads/main`")
  is out of date.
- **Fix:**
  - Add template parameters `GitHubOwnerId` (default `17613795`) and `GitHubRepositoryId` (default `1434576189`),
    and set the `sub` to `repo:${GitHubOwner}@${GitHubOwnerId}/${GitHubRepository}@${GitHubRepositoryId}:ref:refs/heads/main`.
  - Optionally add `token.actions.githubusercontent.com:repository_id` = `1434576189` as a second key (DOCUMENTED,
    see K5).
  - This also closes namespace recycling, which is why GitHub made the change.
  - It adds no founder click: the defaults are right.
  - Update `bootstrap.test.ts`, `review-r024.test.ts` F2 and REPORT-4 §5.

## K2–K4. The tripwire (`workflows.test.ts`) is a set of regular expressions; valid workflows get past it

**MEASURED.** Each case is built from the real `deploy.yml`/`test.yml`. The test copies `workflows.test.ts` beside the
mutated files and runs it. The tripwire passes **6/6** on every case. Each mutated file was also parsed:

| Case | What the YAML really says | js-yaml | `yaml` (strict) | PyYAML | actionlint 1.7.12 (Go yaml.v3) | Tripwire |
|---|---|---|---|---|---|---|
| K2a | `deploy.yml` gains job `"cleanup":` with `id-token: write`, no `if`, no `needs` | parses | parses | – | clean | **passes** |
| K2b | `test.yml` top-level `"id-token": write` | parses | parses | – | clean | **passes** |
| K2c | `test.yml` job `permissions: "write-all"` | parses | parses | – | clean | **passes** |
| K3 | `test.yml` `W: &w write` … `id-token: *w` | parses | parses | – | clean | **passes** |
| K4 | `name: "Deploy⏎on:⏎  push: …⏎"` (the fake `on:` is at column 0 inside the string), real `"on":` adds `workflow_run: {workflows: [Tests], types: [completed]}` | `on` = push, workflow_dispatch, **workflow_run** | rejects (continuation line at column 0) | same as js-yaml | clean | **passes** |

Control (MEASURED): the same harness with an unquoted `id-token: write` in `test.yml` makes the tripwire fail (5/6),
so the harness is sound.

**Impact:**

- **K4 is the dangerous one.** `workflow_run` on `deploy.yml` runs on `main`, so its `sub` is the trusted one, after
  the Tests of *any* pull request, a fork's included. That is R-024 F2's original attack. Whether GitHub's own parser
  accepts the file is **UNKNOWN**. Go yaml.v3 (actionlint) and js-yaml do.
- **K2a** gives a second job the role on push to main, with no `needs: test` and no `if`. That is no more than `main`
  can already do, but the tripwire's stated rule ("only the deploy job") is false.
- **K2b, K2c and K3** make `test.yml` ask for the token. Through `workflow_call` the caller's `contents: read` caps it,
  so GitHub refuses the run. Through `pull_request` the `sub` is `…:pull_request`, which AWS refuses. So none of the
  three reaches AWS today. Each still breaks a rule the test claims to enforce, and a later trigger change would make
  it live.
- The replaced R-024 F2 test (`review-r024.test.ts`) splits jobs with the same kind of regex, so K2a passes it too.

**Fix:** parse the workflows instead of matching text.

- Use `yaml` (already a dependency of `github-app`; add it to `infra/github-app` devDependencies):
  `parseDocument(src, { uniqueKeys: true, strict: true, merge: false })`.
- Fail on any `errors` or `warnings`, on any alias or anchor node, and on more than one document.
- Then assert on the parsed object:
  - the `on` keys (`push` with `branches: ["main"]` exactly, `workflow_dispatch`);
  - every job's and the workflow's `permissions` (`write-all`, or any `id-token` key, only on `jobs.deploy`);
  - `jobs.deploy.if`;
  - the `uses` of every job.
- Also fail if the raw text contains the string `on:` anywhere but the top-level key line. That closes the K4 class
  even for parsers more lenient than `yaml`.
- Keep the file-list check. Also make it case-insensitive (`/\.ya?ml$/i`): whether GitHub runs `x.YML` is UNKNOWN.

**Checked and not bypasses:**

- **A workflow in a subdirectory of `.github/workflows`:** GitHub does not run it (DOCUMENTED).
- **`.yaml` vs `.yml`:** both are counted by the file list.
- **A local reusable workflow:** it must be in `.github/workflows`, so the file list catches it.
- **A remote reusable workflow called from `deploy.yml`:** a second job with `id-token` fails the tripwire, unless its
  name is quoted (K2a).
- **A composite action under `.github/actions`:** it cannot request permissions. It gets the token only inside a job
  that already has `id-token: write`, which is the deploy job.
- **Actions that request tokens:** in the deploy job, `ACTIONS_ID_TOKEN_REQUEST_*` is visible to every step after the
  job starts, including the `npm ci` install scripts (before "AWS credentials"). That is the same trust as the `cdk
  deploy` step, so it is not new.

## K5. The residual risk can be narrowed now, with no paid plan and no GitHub click

REPORT-4 §1 says: "Not used: GitHub's OIDC subject customization (it could bind the token to `job_workflow_ref`) … whether STS
matches that claim was UNKNOWN". That is no longer UNKNOWN:

- **DOCUMENTED (AWS IAM User Guide, *IAM and AWS STS condition context keys* → GitHub tab):** STS exposes these
  GitHub claims as trust-policy condition keys: `actor`, `actor_id`, `job_workflow_ref`, `repository`,
  `repository_id`, `repository_owner_id`, `workflow`, `ref`, `environment`, `enterprise_id`. They are string
  operators, and none of them is available in the session. `event_name` and `workflow_sha` are **not** keys.
- **So, in the CloudFormation template only, with no GitHub-side customization (which is REST-only):**
  - `token.actions.githubusercontent.com:job_workflow_ref` =
    `Mircoguidetti/fenvix-app/.github/workflows/deploy.yml@refs/heads/main`. Only jobs of `deploy.yml` on `main` get
    the role. A *new* workflow file on `main` (issue_comment, workflow_run, schedule) no longer does, whatever the
    tripwire says. Caveat: GitHub documents the claim only for reusable workflows. The value it carries for a job
    written directly in `deploy.yml` is **UNKNOWN** until the first run, which fails safe at "AWS credentials" if it
    is wrong. Do **not** move the job into a reusable workflow to make the claim documented: then any caller on main
    would match.
  - Recommended as well: `token.actions.githubusercontent.com:actor_id` = `17613795` (the founder). AWS: "the ID of
    the personal account that initiated the workflow run". Then:
    - a push or merge to `main` by any other collaborator, bot or agent token is refused;
    - so is a `workflow_run` or `issue_comment` started by an outsider.

    The trade-off: only runs the founder starts can deploy, which REPORT-4 already assumes.
- With K1 + K5, the residual risk becomes: *the founder merges a change to `deploy.yml` (or code it runs) without
  reading it.* REPORT-4's current statement ("anyone with write access … any workflow on main") then shrinks to that.
- **Not real:**
  - Pinning a hash of the workflow file in a pipeline step is self-referential: whoever edits `deploy.yml` edits the
    check, and STS cannot see `workflow_sha`.
  - A CloudFormation `Condition` cannot see anything at token time.

## Checks that pass

**1. OIDC.** With K1 fixed, the trusted `sub` is presented only by jobs on `refs/heads/main`. DOCUMENTED subjects for
the other cases:

- **Pull request, a fork's included:** `…:pull_request`, refused.
- **Tag:** `…:ref:refs/tags/…`, refused.
- **Another branch, or `workflow_dispatch` from another ref:** `…:ref:refs/heads/<other>`, refused. The deploy job's
  `if` also skips it.
- **`merge_group`:** `refs/heads/gh-readonly-queue/…`, refused.
- **Reusable workflow:** the caller's `sub`.
- **Composite action:** the job's token.
- **Events that run on the default branch** (`workflow_run`, `issue_comment`, `schedule`, `pull_request_target`,
  `repository_dispatch`): they present the trusted `sub`, but only for workflow files already on `main`. That is the
  stated residual risk, narrowed by K5.
- **Casing:** `Mircoguidetti` equals the GitHub login (MEASURED). IAM `StringEquals` is case-sensitive.

**3. SSM (MEASURED by reading the policy files and the template):**

- `ReadFounderValues` is `ssm:GetParameter` on exactly the seven ARNs, with no wildcard, and no `Put`/`Delete` on
  `bootstrap/`.
- The permissions boundary allows reads under `github-app/*`, `cache/*` and `aws/service/canonical/*` only.
- The four CloudFormation execution policies read only the Ubuntu public parameters.
- The CloudFormation execution role creates roles only with the boundary (`WriteRolesOnlyWithTheBoundary`).
- `CdkDeployRole` and `CdkPublishRole` have no SSM reads beyond the CDK version parameter.
- No stack role can read `/fenvix/prod/bootstrap/*`.
- `readFounderValue` masks before returning; the database password is masked again after parsing.
- `GITHUB_ENV` gets only `SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `FENVIX_CLOUDFLARE_MANAGED`, the cache public key,
  App id/slug/client id and the certificate ARN.
- The step summary gets no founder secret.
- Vite inlines only `VITE_*`: `VITE_API_URL`, `VITE_SUPABASE_URL` and the anon key.

**4. Earlier fixes:**

- `deploy/test/review-r024.test.mjs`, `review-r024b.test.mjs` and `r024-founder-state.sh` are byte-identical to the
  reviewers' commits (`git diff 5f2c49a` / `01cd037`: empty).
- **F1 extension:** equivalent. Only the seven exact names were added, and the test still fails on wildcards and
  `GetParameters*`.
- **F2 replacement:** weaker than the original, unavoidably on Free (an environment admitted only the deploy job; the
  ref trust admits any job on main). It is not stronger, and its regex job split is beaten by K2a. K5's
  `job_workflow_ref` would restore "only `deploy.yml`" at the AWS side. Add it to F2 when fixing.

**6. Founder click list (REPORT-4 §4):**

- It is complete and minimal for this design, browser-only, with exact pages and fields.
- K1 and K5 add no click: template defaults.
- Two notes:
  - Click 5 cannot succeed until K1 is fixed.
  - Private repositories on Free have a monthly Actions minutes quota (DOCUMENTED; the run length against it is
    UNKNOWN). A 30–60 minute first deploy plus a Tests run per pull request is worth one line in DEPLOY-AWS.md.

## 7. Suites (MEASURED, this container, `fc5257d` + this review's test file)

| Suite | Result |
|---|---|
| `deploy` `npm test` (local Supabase up) | **57/57**, 0 skipped: matches |
| `infra/github-app` `npm test` | typecheck clean. **91/91** of the authors' tests pass, matching the report. This review adds 7, which fail (98 total, 7 fail) |
| `github-app` `npm test` | typecheck clean, unit **135/135**, integration **165/165**, 0 skipped: matches |
| `npm run test:rls` (scratch `rls_scratch`) | API, CI, CI EXPLORE, GH, WARM RLS **OK**: matches |
| Dashboard `api:lint`, `build`, `test:unit`, `api:check` | valid, builds, **66/66**, matches: matches |
| `actionlint` 1.7.12 (repo) | no finding: matches |
| `cfn-lint` 1.60.1 on the bootstrap template | no finding: matches |
| `node infra/bootstrap/build.mjs --check` | up to date: matches |
| `r024-founder-state.sh` founder / upto0013 / upto0010 | 0001–0017 `found`, nothing applied, schema unchanged · 0014–0017 applied · STOP "none of migration 0011's", unchanged: matches |
| `cdk synth --all` | ran inside `infra/github-app` `npm test` (synth tests pass). The standalone empty-App-values run was not repeated |

Sources:

- GitHub, OpenID Connect reference: <https://docs.github.com/en/actions/reference/security/oidc>
- AWS, IAM and AWS STS condition context keys:
  <https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html>
