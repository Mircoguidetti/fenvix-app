# Review R-024: deploy pipeline (P-031), `claude/deploy-pipeline` at 7b1bb75

**Verdict: FIX 5** (F1–F5 below, each backed by a failing test). Nothing found lets a fork, a pull request or a
non-`main` branch reach the role or the `production` secrets **once the environment's branch rule is set**; no
secret was found in a log line, summary, error message, artifact or the dashboard bundle; the migration runner
handles the founder's exact database correctly. Every suite count in the report was reproduced.

Reviewer branch `claude/review-r024`. New tests (they fail on 7b1bb75 and pass once the fixes land):

- `infra/github-app/test/review-r024.test.ts`: F1, F2
- `deploy/test/review-r024.test.mjs`: F3, F4, F5 (real Postgres: the scratch server and the local Supabase)
- `deploy/test/r024-founder-state.sh`: the founder-state reproduction on a fresh real Supabase image (section 4)

Nothing was deployed; no AWS, Supabase, Cloudflare or GitHub Actions access was used. **MEASURED** = run here.
**UNKNOWN** = needs the real accounts.

## Findings

| # | Severity | Finding | Failing test |
|---|---|---|---|
| F1 | Medium | `deploy-policy.json` `ManageOwnSecrets` grants `ssm:GetParameterHistory` on `parameter/fenvix/prod/github-app/*` and `parameter/fenvix/prod/cache/*`. `GetParameterHistory` with `WithDecryption=true` returns the **decrypted value of every version**, and the parameters use the default `aws/ssm` key, whose key policy lets any principal of the account decrypt through SSM (the pipeline's own `GetParameter ... WithDecryption` calls work without a `kms:Decrypt` grant for exactly this reason). So the deploy role reads the webhook secret, the state signing key, the runner token(s) and the cache signing key: the report's "reads exactly five parameters" is false, and the existing test misses it (it only looks at statements whose action is `ssm:GetParameter`). Nothing in `deploy/` calls `GetParameterHistory`. | `F1: the deployer can read (decrypt) only the five parameters it names, by any SSM read action`: lists `ssm:GetParameterHistory` on both prefixes |
| F2 | Medium | The deploy role's trust accepts `sub` = `...:ref:refs/heads/main` **or** `...:environment:production`. The deploy job declares `environment: production`, so GitHub issues it `...:environment:production` (the environment form replaces the ref form); the `ref:refs/heads/main` entry is **never used by the deploy**. What it does admit: any job *without* an environment, with `id-token: write`, in a workflow running on `main`: a later workflow on `push` to main, `schedule`, `workflow_dispatch`, `issue_comment` or `workflow_run` (the last two always run on the default branch; `workflow_run` is the usual path by which fork-controlled data reaches a privileged run). None of these is subject to the environment's branch rule or required reviewers. Today no such workflow exists, so it is not exploitable now; it is a standing grant that nothing needs. | `F2: the deploy role trusts the production environment only`: the trust lists both subs |
| F3 | Medium | `ensureRoles` checks the stored connection string **once** (`login(stored)`, `attempts = 1`) and rotates on "refused", where "refused" includes any error whose message matches `authentication failed` or `tenant or user not found`. Supavisor's `Tenant or user not found` is reported intermittently by Supabase users. One such answer during a deploy: a new verifier is set (`alter role`) and the password the running API and App hold stops working at once; they recover only on their next secrets reload (up to 5 min, `SECRETS_TTL_SECONDS`), and in the meantime every new connection fails (dashboard 500s, webhooks retried). Also, `alter role` runs before `PutParameter`, outside a transaction: if the SSM write then fails, the role has a password nobody holds until the next deploy. | `F3: ... keeps the stored connection string when the pooler fails once`: a proxy answers the first connection with Supavisor's `FATAL XX000 Tenant or user not found` and forwards the rest to the local Supabase; `ensureRoles` rotates and the old password is refused (`'refused' !== 'ok'`) |
| F4 | Medium | `SUPABASE_ANON_KEY` is not checked. Supabase shows the anon key next to the `service_role` key (and the publishable key next to the secret key) on the same page. It is an environment **variable** (printed unmasked in the log, readable by anyone with read access to the repository's settings), and step 10 builds it into the public bundle as `VITE_SUPABASE_ANON_KEY`. A wrong paste publishes a key that bypasses row level security to every visitor of `app.fenvix.dev`. `preflight` accepts it. | `F4: refuses a service_role JWT` and `refuses a secret API key`: `preflight` exits 0 for both |
| F5 | Low | The "found" probes check the **first** objects each migration creates, not its last. A migration that ran only partly (statement by statement: `psql -f`, another tool, the SQL editor's "run selected", a paste that was cut) is recorded as `found` and is never run again: for 0017 cut before its row level security section, the runner records 0017 as applied while `public.gh_warmups` has RLS off and no revoke from `anon`/`authenticated`. The founder's database is **not** affected (0011–0017 were pasted as one text; the SQL editor sends it as one query, which Postgres runs as one implicit transaction: all or nothing, section 4). But a wrong `found` is silent and permanent, and the probes are the only thing standing between a hand-migrated database and that outcome. | `F5: 0017 stopped before its row level security: not recorded as applied`: the runner records 0017 `found`, `relrowsecurity = false` |

### Fixes (suggested; none applied here)

- **F1:** remove `ssm:GetParameterHistory` from `ManageOwnSecrets` (nothing uses it). Keep `DescribeParameters` (names only). Extend the existing policy test to all SSM read actions, as the new test does. Update the bootstrap template (`node infra/bootstrap/build.mjs`); the founder then updates the `fenvix-bootstrap` stack once (section "When something fails" already explains how).
- **F2:** trust `...:environment:production` only. Optionally also require the workflow file: not possible with `sub` alone, but GitHub's subject customization or the `job_workflow_ref` claim can do it (UNKNOWN whether STS accepts that claim key for GitHub; do not rely on it without a real `AssumeRoleWithWebIdentity`).
- **F3:** retry the stored string a few times (for example 4 attempts, 10 s apart) and rotate only when every attempt is refused; treat `tenant or user not found` as transient unless the admin connection proves the role exists and the pooler answers the admin (it does: `admin()` just connected), i.e. rotate only on SQLSTATE `28P01`. Put `alter role` in a transaction, `PutParameter`, then `commit` (rolled back if the SSM write fails).
- **F4:** in `preflight`: refuse a key starting `sb_secret_`, and a JWT whose payload `role` is not `anon`; the message names the variable, never the value. Optionally refuse a `ref` claim different from the project of `SUPABASE_DB_URL` (that catches the "every call answers 401" case of the docs too).
- **F5:** make each probe also check the migration's **last** effect (0017: `gh_warmups` has `relrowsecurity` and the policy `gh_warmups_api_read`; 0016: index `gh_run_summaries_received` (already the last statement); 0015: policy `workspace_invites_api_revoke`; 0014: `has_function_privilege('fenvix_github_app', 'public.gh_link_installation(bigint,uuid,uuid)', 'execute')`; 0013: policy `ci_usage_events_github_app`; 0012: policy `ci_explorations_control_plane`; 0011: policy `ci_reference_rates_control_plane`). A migration whose first probe is true and last is false is then "half-applied" and stops the deploy, as intended. Alternatively, since 0014–0017 are written to be safe to run twice (`up.sh` runs them twice), the runner could re-run those it finds instead of only recording them.

## 1. OIDC trust and job permissions

| Question | Answer |
|---|---|
| A workflow on another branch | The `push` trigger is `main` only, and the deploy job's `if` requires `refs/heads/main`; but a branch can carry its own edited workflow. Its job then names `environment: production` and gets `sub = ...:environment:production`, which the role trusts. **Only the environment's deployment branch rule stops it** (GitHub refuses the job before it runs). With the rule set: no. |
| A fork pull request | No. `pull_request` from a fork gets a read-only token, no `id-token: write` and no secrets (environment secrets included); the deploy job is skipped (`event_name != pull_request`); its `sub` would be `...:pull_request` anyway, which the role does not trust. |
| `pull_request_target` | None in the repository. With F2 fixed, one added later could not assume the role unless it also named the environment (then the branch rule applies: its ref is `main`, so it **would** pass: never add a `pull_request_target` or `workflow_run` job with `environment: production`). |
| `workflow_dispatch` from a non-main ref | The run's ref is that branch: the deploy job is skipped by its `if`; an edited workflow on that branch is the "another branch" case above. |
| `permissions:` | Workflow default `contents: read`. `test`: inherits `contents: read`, no `id-token` (MEASURED by reading the file). `deploy`: `contents: read`, `id-token: write`. Correct. |
| Is the branch rule required for safety? | **Yes, it is the only control** between any pushed branch and both the AWS role and `SUPABASE_DB_URL` (the database admin's password). It is documented (DEPLOY-AWS.md, A step 3.2, with the reason), not verified by anything. See "Documentation" for two gaps around it. |

Other workflow notes (no finding): actions pinned by SHA; `npm ci` before the credentials; `persist-credentials: false`.
The `concurrency` group `deploy-production` is shared by every non-PR run: a `workflow_dispatch` from another branch
(its deploy job skipped) cancels a *pending* main deploy, whose commit is then deployed only by the next push. The
Cloudflare token is in the environment of `cdk deploy` (the CDK app and its dependencies) though only the background
watcher uses it; it could be passed to the watcher alone (the AWS session in the same environment is the larger power).

## 2. Secrets: log lines, summaries, errors, artifacts, bundle, git

MEASURED, no leak found:

- **Error paths.** `admin()` prints only the SQLSTATE or the error's class name, never `e.message`. `tryLogin` puts
  `e.message` in its error; pg's connection messages carry host and role, not the password (and the string is masked
  before). `parseAdminUrl`: every failure is a fixed sentence; a malformed `%` escape throws `URI malformed` (no
  value). The App's secrets: `checkSecret` never echoes; SSM errors are reduced to the error's `name`. Cloudflare
  errors print Cloudflare's codes and messages, never the token. A failing migration prints Postgres's message (from
  SQL that is in git).
- **Masking.** Every derived value is masked before use (`a.password` decoded from the URL, the stored strings, new
  passwords and their URLs, the App secrets and SSM's current values, line by line for a PEM).
- **Summaries / `GITHUB_ENV`.** Only names, versions, DNS targets, the public cache key, the Supabase URL, App id,
  slug and client id, the certificate ARN, the AMI id.
- **Artifacts.** None uploaded. `cdk-outputs.json` and `cdk.out` hold no secret (the stack never reads values).
- **Dashboard bundle.** Built with every secret of the deploy job set to a marker (`AWS_SECRET_ACCESS_KEY`,
  `AWS_SESSION_TOKEN`, `SUPABASE_DB_URL`, `CLOUDFLARE_API_TOKEN`, `FENVIX_GITHUB_APP_PRIVATE_KEY`): no marker in
  `dist/`; only `VITE_API_URL`, `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are in it. The source reads only
  `VITE_*` variables; `vite.config.ts` sets no `envPrefix` or `define`. (Except F4: whatever is pasted as the anon key.)
- **Git.** No secret file; `.env.example` holds placeholders.

Not a finding, already disclosed by the report: TLS to the pooler is encrypted but unverified (`rejectUnauthorized:
false`, `sslmode=require`). node-postgres answers whatever authentication the server asks for, including cleartext,
so an active man in the middle between GitHub's runner and the pooler would receive the admin password. Shipping
Supabase's CA certificate in the repository and verifying (`ssl: { ca }`, `sslmode=verify-full`) closes it; UNKNOWN
whether the pooler's certificate chains to that CA.

## 3. Least privilege

- **Deploy role** (`deploy-policy.json`): F1. Otherwise: assumes only the two `cdk-fenvix-*` roles; no `iam:*`; S3
  only the dashboard bucket's objects; CloudFormation describe on the two stacks; image builder on the one pipeline;
  `lambda:InvokeFunction` on the demo function only. `ssm:PutParameter`/`DeleteParameter` on our prefixes (needed).
  `acm:RequestCertificate` in us-east-1 for any domain (harmless).
- **CDK deploy role:** change sets on the two stack names only; `iam:PassRole` of the execution role only, to
  CloudFormation only. **Publishing role:** the assets bucket only.
- **CloudFormation execution role** (no boundary itself, by design): may create, change or attach policies to roles
  only under `fenvix-prod-github-app-*` and only with the boundary; cannot remove the boundary or edit any managed
  policy version; may attach two named AWS managed policies only; `iam:PassRole` only to Lambda, EC2, Scheduler, Image
  Builder and only roles of the stack. No way to create an unbounded role found. `iam:UpdateAssumeRolePolicy` on the
  stack's roles lets a template make them assumable by others, but they stay bounded, and the template comes from
  `main` (equivalent to deploying code).
- **Boundary:** `Deny` on every IAM action but `PassRole`; SSM reads limited to our prefixes and Ubuntu's public
  parameters. As before (R-012).
- **Dashboard policy:** S3 actions on the one bucket name; `cloudfront:UpdateDistribution`/`DeleteDistribution` on
  `distribution/*` (every distribution of the account, though reachable only through these two stacks' templates;
  could be narrowed with `aws:ResourceTag/project = fenvix` after the first create).
- **Bootstrap template:** account and region rule; the OIDC provider optional; assets bucket private and TLS-only;
  no user, no access key. Trust: F2.

## 4. Migration runner (MEASURED)

`deploy/test/r024-founder-state.sh` starts a **fresh** `supabase/postgres:15.8.1.085` (with GoTrue to create
`auth.users`), applies 0001–0010 one file at a time, then the chosen later files **pasted as one text and sent as one
query** (`psql -c`, as the SQL editor does), then runs `node deploy/cli.mjs migrate` twice:

| State | Run 1 | Run 2 | Public schema changed by the runner |
|---|---|---|---|
| Founder: 0001–0010 + 0011–0017 as one text | probes 0011–0017 all yes; records 0001–0017 `found`; runs nothing | "nothing new to apply" | no (hash of every relation, kind and RLS flag before and after) |
| 0001–0010 + 0011–0013 as one text | records 0001–0013 `found`; applies 0014, 0015, 0016, 0017 (0014 drops the old product's tables: correct, they were not dropped yet) | nothing | yes (expected) |
| 0001–0010 only (the earlier product) | stops: "tables in public but none of migration 0011's", nothing changed | same | no |

Destructive re-run: none possible on a recorded database (pending = not recorded; a file numbered below the highest
recorded stops; a changed file stops). On first detection, a migration is never run when its probe and all lower
probes are true. The authors' own tests (half-applied, foreign database, failing 0018 rolled back, edited file,
numbering) pass. F5 is the one way to record a migration that is not fully there. The `fenvix:no-transaction`
escape hatch re-runs a partly failed file on the next deploy (none uses it today; any that does must be idempotent:
worth a sentence in the migrations' README).

## 5. Role passwords (MEASURED)

- Verifier only: the statement is `alter role <r> with login password 'SCRAM-SHA-256$4096:...'`; the authors' test
  checks `pg_authid` and that no statement contains the password; re-read and confirmed. The password reaches the
  database only inside the SCRAM exchange of the login check.
- A network error (connection refused, timeout) never rotates: confirmed (`tryLogin` throws).
- A transient *authentication-looking* error does rotate: F3.
- A rotation that is needed (stored password really refused) changes nothing for the running services that was still
  working; the docs' "Delete the parameter, run the workflow" rotation makes new connections of warm functions fail
  for up to 5 minutes after the new password is set (worth one sentence in "Rotating a secret").

## 6. Deploy without the GitHub App (MEASURED by reading and the authors' tests)

The `http` function without `GITHUB_APP_ID` builds `notConfiguredHttp` before reading any secret; its 503 body is a
fixed message and code, it parses no body, logs nothing of the request. The dashboard API's three GitHub operations
answer 503 `github_not_configured` with a fixed message; the API reads only `state-signing-key` and
`api-database-url` (both made by the pipeline). Worker, sweep, warm-up and reaper decide per call and read nothing
without the App; the demo function refuses. Nothing still needs the App's secrets: `private-key` and `client-secret`
are "required" only for the configured surfaces, which never load. No leak.

## 7. Dashboard on S3 + CloudFront

Private bucket (block all public access, owner-enforced, SSE-S3, TLS only, retained), origin access control (bucket
policy for this distribution's ARN only; the authors' test), TLS 1.2 (2021) with the certificate, HTTP → HTTPS,
AWS's managed security-headers policy (HSTS, nosniff, frame options, referrer policy; **no Content-Security-Policy**:
a later improvement), `GET`/`HEAD` only, the SPA rewrite identical to `vercel.json` (`/assets/*` and `/favicon.svg`
served as is; `public/` holds only `favicon.svg`). A missing `/assets/x.js` answers 404 with `index.html` (403 from
S3 mapped), cosmetic. Bundle: section 2.

## 8. Suites (MEASURED, this container: Node 22.23.5, Docker 29.10.0, Postgres 16, local Supabase of `up.sh`)

| Suite | Report | Here, branch as delivered | Here, with the R-024 tests |
|---|---|---|---|
| `github-app` `npm test` | typecheck clean, unit 135/135, integration 165/165 | same: clean, **135/135**, **165/165**, 0 skipped | unchanged |
| `npm run test:rls` | 5 × OK | API, CI, CI EXPLORE, GH, WARM RLS OK | unchanged |
| `infra/github-app` `npm test` | 83/83 | **83/83** (typecheck clean) | 83/85: F1, F2 fail |
| `deploy` `npm test` | 25/25 | **25/25** | 26/30: F3 (1), F4 (2), F5 (1) fail; the anon-key acceptance test passes |
| Dashboard `api:lint`, `build`, `test:unit`, `api:check` | valid, build, 66/66, matches | valid, builds, **66/66**, matches | unchanged |
| `actionlint` 1.7.12 (the workflow's image) | no finding | no finding | |
| `node infra/bootstrap/build.mjs --check` | | up to date | |
| `npm run check` (mock UI, screenshots), `cfn-lint`, `cdk synth` with empty App values | as reported | not re-run (no change in UI; `cdk synth` runs inside the infra tests) | |

## Documentation and the founder's clicks

The four steps are complete for what the pipeline does, and each is justified; I found no click that can be
removed. Gaps:

1. **Order.** Step 1 creates a role that trusts `environment:production` before step 3 creates the environment with
   its branch rule. In between, a pushed branch whose workflow names `production` makes GitHub **create** the
   environment with no rule, and that job gets the role. Do step 3 (environment + rule) **before** step 1, and say
   that the branch rule is mandatory, not a recommendation.
2. **"If you merged before steps 1 to 4"**: that run creates `production` with no rule; step 3.1 says "New
   environment", but it then exists. Say: open `production` if it is already listed, and set the rule.
3. **Recommended extra click: a rule on `main`** (Settings → Rules → Rulesets → New branch ruleset, target `main`:
   "Require a pull request before merging", "Block force pushes"). The founder's model is "PR → merge → deploy", but
   nothing enforces the pull request: anyone (or any agent token) with write access pushing to `main` deploys to
   production directly, and the environment rule (`main`) lets it. One page, four clicks; it is the only control on
   what reaches `main`.
4. **Optional check in the pipeline:** have `preflight` read the environment's deployment branch policy and stop if
   there is none (UNKNOWN whether the job's `GITHUB_TOKEN` can read it with `actions: read`; it cannot stop a branch's
   edited workflow, but it would catch the misconfiguration on the first `main` deploy).
5. Section C1/C2 and the rest are accurate as far as can be checked without the accounts.
