# Report: deploy pipeline (P-031), push to main → AWS

Branch `claude/deploy-pipeline`, from `main` at 091d4c2. Founder rule (2026-11-19): deploy is "pull request, merge on
main, deploy done"; nobody runs anything from a laptop; one-time setup is browser clicks only.

Labels: **MEASURED** = run here, with the result shown. **UNKNOWN** = not run, because it needs the real AWS account,
Supabase project, Cloudflare zone or a GitHub Actions run. Nothing was deployed.

## 1. What was built

| Piece | Where | What it does |
|---|---|---|
| The workflow | `.github/workflows/deploy.yml` | On every pull request: the job **Tests**. On push to `main` (and "Run workflow"): **Tests**, then **Deploy to production** in the GitHub environment `production`, with AWS credentials from OpenID Connect. One deploy at a time (`concurrency`, never cancelled half way). Actions pinned by commit SHA. |
| Deploy steps | `deploy/` (Node, `pg`, AWS SDK SSM and ACM) | `cli.mjs` subcommands, one per workflow step: `preflight`, `migrate`, `db-roles`, `secrets`, `github-app`, `dashboard-certificate`, `watch-certificate`, `dns`, `smoke`. Libraries in `deploy/lib/`, tests in `deploy/test/`. |
| Migration runner | `deploy/lib/migrate.mjs` | Applies `supabase/migrations/NNNN_*.sql` once each, in order, each in its own transaction together with its record in `fenvix_deploy.schema_migrations` (version, file, SHA-256, time, `applied`/`found`); advisory lock; `-- fenvix:no-transaction` on line 1 for the rare migration that cannot run in a transaction. **First run on a hand-migrated database:** probes the objects each of 0011–0017 leaves (tables, columns, functions, roles, an index), takes the highest found, requires every lower probe true, records 0001..N as `found`, runs none of them. Stops (changing nothing) on: a half-applied database, tables in `public` with none of 0011's, an applied file whose checksum changed, a new file numbered below an applied one. |
| Role passwords | `deploy/lib/roles.mjs`, `deploy/lib/supabase.mjs` | For `fenvix_github_app` (pooler session mode, 5432) and `fenvix_api` (pooler transaction mode, 6543): logs in with the connection string stored in SSM; if none, or the database answers "wrong password", generates 32 random bytes (base64url), sets only its SCRAM-SHA-256 verifier on the role (the existing `scripts/scram-verifier.mjs`), stores the full connection string (`<role>.<ref>@<pooler>`, `sslmode=require`) as SecureString, and checks the login (retrying while the pooler catches up). A network error never rotates a password. |
| Generated secrets | `deploy/lib/secrets.mjs` | `webhook-secret`, `state-signing-key`, `runner-token` (64 hex chars each) and the cache signing key pair (RSA 3072: private half SecureString, public half a String parameter the stack is built from). Created only if missing (`Overwrite: false`); never read back, never printed. |
| GitHub App values | `deploy/lib/github-app.mjs` | Variables `FENVIX_GITHUB_APP_ID/_SLUG/_CLIENT_ID`, secrets `FENVIX_GITHUB_APP_PRIVATE_KEY/_CLIENT_SECRET` of the `production` environment. Secrets checked for shape, compared with SSM, written only when different. None set → deployed without the App; some set → the deploy stops, naming what is missing (never a value). Secrets may also be typed into SSM in the console. |
| DNS | `deploy/lib/cloudflare.mjs` | With `CLOUDFLARE_API_TOKEN`: CNAMEs `github` → API Gateway, `app` → CloudFront, and both certificates' validation CNAMEs, all DNS only; replaces A/AAAA/CNAME at exactly those names, never touches another. Without a token: the records are listed in the run's summary. |
| Certificates | `deploy/lib/certificates.mjs` | The dashboard's certificate is requested in us-east-1 by the pipeline (CloudFront requires that region) and passed to the dashboard stack by ARN once issued. The API's stays in the stack (eu-west-1); a background watcher puts its validation record in Cloudflare while CloudFormation waits. |
| One-click AWS template | `infra/bootstrap/fenvix-bootstrap.json`, built by `infra/bootstrap/build.mjs` | GitHub OIDC provider (optional parameter), deploy role `fenvix-github-deployer` (trust: `aud` = `sts.amazonaws.com` and `sub` exactly `repo:Mircoguidetti/fenvix-app:ref:refs/heads/main` or `repo:Mircoguidetti/fenvix-app:environment:production`; policy = `deploy-policy.json`), the permissions boundary (`permissions-boundary.json`), four CloudFormation execution policies, the CloudFormation execution role, the CDK deploy and publishing roles (assumable by the deploy role only), the assets bucket (TLS only, private), the CDK version parameter. A rule refuses any account but 865859654353 and any region but eu-west-1. The JSON is generated from the policy files; a test fails if it drifts. |
| CDK deploys without `cdk bootstrap` | `infra/github-app/lib/synthesizer.ts`, `cdk.json` | Qualifier `fenvix`: the stacks use the template's roles, bucket and version parameter, so a laptop `cdk bootstrap` is never needed and nothing collides with another CDK bootstrap in the account. |
| Dashboard hosting | `infra/github-app/lib/dashboard.ts` (stack `fenvix-prod-dashboard`) | Private S3 bucket (fixed name, block public access, SSE, TLS only, kept on stack deletion), CloudFront with origin access control, the us-east-1 certificate, TLS 1.2 (2021 policy), HTTP→HTTPS, AWS's managed security-headers policy, a CloudFront Function serving `index.html` for client routes (the rule of `vercel.json`). No Lambda, no IAM role. The workflow uploads the build (`assets/` cached a year, the rest `no-cache`) and invalidates. New execution policy `cfn-exec-policy-dashboard.json`. |
| Deploy without the GitHub App | `github-app/src/not-configured.ts`, `src/lambda/*`, `src/api/{config,errors,github}.ts`, `infra/github-app/lib/settings.ts` | `githubAppId`/`Slug`/`ClientId`: all three or none. None: the stack synthesizes; the `http` Lambda serves `/healthz` → `{"ok":true,"github":"not_configured"}` and every other route → **503** `{"error":{"code":"github_not_configured",...}}` with `Retry-After`, reading no secret; the worker keeps any message (reported failed → dead-letter queue, redrivable later); sweep and warm-up return without touching the database; the reaper skips deregistering; the dashboard API's install link, installation completion and setup pull request answer **503** `github_not_configured` (added to the contract's error codes), everything else works. Demo mode requires the App. |
| Runner mode | `cdk.json` | `per-job` by default; `demo` kept, off, needs the App and the variables `FENVIX_RUNNER_MODE`/`FENVIX_DEMO_REPOSITORY`. No demo repository is needed for anything. |
| Docs | `docs/DEPLOY-AWS.md` | Rewritten: what gets created; the founder's one-time browser steps (numbered, exact pages and fields); what one push does; connecting the GitHub App (browser only); optional settings; demo mode from the console; failures, rotation, removal, all in the browser. The false claim that 0011/0012 were already applied is gone: the page says what the pipeline finds on the first run. Laptop scripts `scripts/deploy.sh`, `cache-key.sh`, `dns-records.sh` and `npm run deploy` are removed. |

Smaller changes: `deploy-policy.json` (assumes the template's CDK roles instead of `cdk-hnb659fds-*`; reads exactly
five parameters: the two database URLs, the App's key and client secret, the cache public key; requests the
dashboard certificate in us-east-1 only; syncs only the dashboard bucket; invalidates CloudFront);
`cfn-exec-policy-app.json` (the new assets bucket); `cfn-exec-policy-edge.json` (two invalid action names removed,
flagged by cfn-lint); three `# shellcheck disable=SC2016` lines in runner scripts (deliberate single quotes; the
existing test runs shellcheck when installed, and GitHub's runner has it); stack outputs `RunnerImageVersion` and
`GitHubApp`.

### Why S3 + CloudFront for the dashboard (as asked; no decisive reason against)

- It deploys in the same run, from the same lock-step build, with the same OIDC role: no second hosting account or
  token.
- Static files only; the bucket is private (origin access control), so nothing is publicly listable.
- The one complication is the certificate, which CloudFront takes only from us-east-1. The pipeline requests it there
  with two extra permissions (`acm:RequestCertificate`/`DescribeCertificate`/`ListCertificates`/`AddTagsToCertificate`,
  conditioned on `us-east-1`), instead of a second CDK stack in us-east-1 (which would need a second bootstrap).
- Until that certificate is issued, the dashboard is deployed on its `cloudfront.net` name and `app.fenvix.dev` is not
  pointed at it (no certificate error is ever served); the next deploy adds it.
- `vercel.json` is left in the repository, unused by the pipeline. If `app.fenvix.dev` points elsewhere today, the
  pipeline replaces that record (with a Cloudflare token) once CloudFront has the certificate.

## 2. The founder's one-time clicks (all in a browser)

Exact pages and fields are in `docs/DEPLOY-AWS.md`, section A.

1. **AWS → CloudFormation → Create stack**: download `infra/bootstrap/fenvix-bootstrap.json` from GitHub ("Download
   raw file"), upload it, stack name `fenvix-bootstrap`, defaults, tick the IAM acknowledgement, Submit.
   *Why not one link:* CloudFormation's quick-create links only load templates from S3, and the account has no bucket
   before this stack exists.
2. **Cloudflare → API Tokens → Create Token** from "Edit zone DNS", add `Zone · Zone · Read`, zone `fenvix.dev`.
3. **GitHub → Settings → Environments → New environment `production`**: deployment branch rule `main`; environment
   secrets `SUPABASE_DB_URL` (Supabase → Connect → Session pooler, password filled in) and `CLOUDFLARE_API_TOKEN`;
   environment variable `SUPABASE_ANON_KEY`; leave "Required reviewers" off.
4. **Supabase → Authentication → URL Configuration**: Site URL `https://app.fenvix.dev`, Redirect URL
   `https://app.fenvix.dev/**` (likely already set if the dashboard ran there before).

Then merge. Beyond the target "(1) CloudFormation, (2) the secrets", and why:

- **The branch rule on `production`** is a security setting: without it, a workflow on any branch that names the
  environment could read its secrets (the database admin connection string) and assume the deploy role (whose trust
  includes `environment:production`, as asked).
- **`SUPABASE_ANON_KEY`** is public, but cannot be read from the database; the only other source is the Supabase
  management API, which needs a token that controls the whole Supabase account.
- **Step 4** is Supabase's own sign-in setting; only the management API could set it (same reason).
- **Cloudflare token** is the "if used" of the brief; it makes DNS hands-off. Without it the pipeline lists the four
  records in each run's summary.

Later, for the GitHub App (section C of the page): create the App (webhook secret copied from SSM → "Show decrypted
value"), add three environment variables and two environment secrets, run the workflow, redeliver the ping.

## 3. What one push to `main` does

1. **Tests** (any failure stops the run; nothing is deployed): actionlint; the AWS template matches the policy files;
   `github-app` typecheck, unit, integration (local Supabase, scratch Postgres 16); RLS; infrastructure tests (CDK
   synth of both stacks, cdk-nag, policies, bundles); deploy-step tests; dashboard `api:lint`, build, unit.
2. **AWS credentials** by OIDC (`fenvix-github-deployer`, 2 hours at most); the account must be 865859654353.
3. **Check the one-time setup**: the connection string's form; `SUPABASE_URL` derived from it; Cloudflare and anon key
   present or not (names only).
4. **Database migrations** (first run: records 0001–0017 as found, runs nothing; later: new files only).
5. **Database roles**: each role logs in with its stored string, or gets a new password (verifier only) and string.
6. **Generated secrets**: created if missing.
7. **GitHub App**: configured, or not, or stop.
8. **Dashboard certificate** (us-east-1): requested once, validated through Cloudflare, ARN passed on once issued.
9. **Cache machine image** kept from the previous deploy.
10. **CDK deploy** of `fenvix-prod-github-app` and `fenvix-prod-dashboard` (API certificate validated through
    Cloudflare while CloudFormation waits).
11. **DNS**: `github.fenvix.dev` and `app.fenvix.dev`.
12. **Dashboard**: build with the API URL, Supabase URL and anon key; upload; invalidate.
13. **Runner image**: build started if none of the current recipe exists (not waited for).
14. **Check**: `/healthz` 200, `/v1/me` 401, `https://app.fenvix.dev/` 200 (strict with a Cloudflare token; a warning
    without one, since the records may not be added yet).

## 4. What was tested, and how (MEASURED)

Environment: this container, Node 22.23.5, Docker 29.10.0, Postgres 16 (`postgres:16`, port 54329, trust auth), the
local Supabase of `scripts/local-supabase/up.sh` (`supabase/postgres:15.8.1.085`, GoTrue v2.186.0, password auth).

| Suite / check | Result |
|---|---|
| `cd github-app && npm test` (typecheck, unit, integration) | typecheck clean; unit **135/135** (127 before + 8 new: not-configured HTTP, worker, sweep, warm-up, no echo; API: settings, three 503s, `/v1/github` still 200); integration **165/165**, 0 skipped |
| `npm run test:rls` (fresh scratch database) | API RLS OK, CI RLS OK, CI EXPLORE RLS OK, GH RLS OK, WARM RLS OK |
| `cd infra/github-app && npm test` | **83/83** (69 before): new dashboard stack tests (nag clean with and without the certificate, private bucket with OAC, no Lambda or role, TLS 1.2, rewrite rule executed against sample paths, resource types allowed by the execution policies), bootstrap template tests (no drift, policies embedded verbatim, trust policy exact, role and bucket names match the synthesized manifest and the workflow), settings (App optional, all-or-none, demo needs the App, per-job default), the HTTP bundle answering 503 without the App; existing tests updated for per-job default and the `fenvix` qualifier |
| `cd deploy && npm test` | **25/25**: see below |
| Dashboard: `npm run api:lint`, `npm run build`, `npm run test:unit`, `npm run api:check` | valid; build passes; **66/66**; `schema.d.ts` matches the YAML |
| `npm run check` (mock UI behaviour, organizations, colours, layout, axe, screenshots) | 34/34, 10/10, 18/18, layout and axe pass, 140 screenshots, none changed in the tree |
| `actionlint` 1.7.12 (pip binary, and the `rhysd/actionlint:1.7.12` image the workflow uses) | no finding |
| `cfn-lint` 1.60.1 on `infra/bootstrap/fenvix-bootstrap.json` | no finding (after removing three invalid action names it found) |
| `cfn-lint` on both synthesized templates | no error; W3005 (redundant DependsOn, CDK-generated), W3010 (hardcoded AZ, deliberate) and W3037 ignored |
| `cdk synth --all` with the App's values empty, as the workflow calls it (`-c githubAppId=` ...) | succeeds; every Lambda has `GITHUB_APP_ID` empty; the manifest names `cdk-fenvix-deploy-role-...`, `cdk-fenvix-cfn-exec-role-...`, `cdk-fenvix-assets-...`, `/cdk-bootstrap/fenvix/version` (the template's names) |
| `shellcheck` 0.11.0 on the runner scripts | clean |

**Migration runner** (`deploy/test/database.test.mjs`, real Postgres):

- *The founder's database:* stand-ins, 0001–0010 one by one, then 0011–0017 **concatenated into one file and run
  once** (as in the SQL editor on 2026-11-19). First run: every probe "yes", `found` = 0001–0017, `applied` = none,
  and a statement spy proves no migration file's SQL was sent. Second run: "database up to date".
- On the **local Supabase** itself (real Supabase image; up.sh applied everything by hand): detects 0017, records,
  runs nothing; second run nothing.
- A new `0018` after that: runs once, in a transaction, recorded `applied`; not again.
- A failing `0018` (`select 1/0` after a `create table`): the error names the file, `division by zero`, SQLSTATE
  22012; its table does not exist (rolled back); `0019` did not run; nothing recorded.
- An edited applied file: stops ("changed after it was applied"). A badly named file: refused.
- Empty database: all 16 files run in order. Applied by hand up to 0013: 0001–0013 found, 0014–0017 run.
- Half-applied (0017's objects, 0016's column dropped): stops, records nothing. Foreign database: stops.
- `node deploy/cli.mjs migrate` end to end on a fresh scratch database: applied all, second run "nothing new to
  apply"; `preflight` refuses the direct `db.<ref>.supabase.co` host with the one-line instruction.

**Secrets never printed** (`deploy/test/secrets.test.mjs`, `units.test.mjs`, `database.test.mjs`): all output captured
with `GITHUB_ACTIONS=true`; no generated value, no line of the private key, no role password appears outside
`::add-mask::` lines (and the generated secrets produce none at all); every generated parameter is SecureString,
created with `Overwrite: false`; a second run reads only the public key and writes nothing; a parallel creator wins.
Role passwords: 43 URL-safe characters; the database receives `SCRAM-SHA-256$4096:...` (checked in `pg_authid`), and
no statement contains the password; a real password login through the local Supabase works with the stored string,
a wrong password is "refused" (→ a new password), an unreachable port is an error (→ no rotation). The GitHub App's
secrets: copied once, no new SSM version when unchanged, a malformed key refused without echoing it.

**Cloudflare** (fake API): create, keep, update, A record at `app` replaced, other names untouched, wrong zone
refused, a 403 names the permissions the token needs.

## 5. What is untested (UNKNOWN)

Nothing below could run without the real accounts:

- **No GitHub Actions run** of the workflow: environment secrets and variables, masking in the real log, OIDC token,
  `concurrency`, the job summary, the npm cache, the `test` job on GitHub's `ubuntu-24.04` image (Docker, `psql`, the
  local Supabase, timings).
- **AWS:** creating `fenvix-bootstrap` (incl. `AWS::IAM::OIDCProvider` with thumbprints, the rule, IAM names);
  `AssumeRoleWithWebIdentity` with the two `sub` values; the CDK CLI (2.1148.1) accepting the template's deploy
  resources, including the version parameter set to `30` and no lookup role; **whether the execution policies are
  complete** for a first deploy (CloudFront, origin access control, CloudFront Function, the us-east-1 certificate
  reference; and the existing app/edge/fleet policies, which have never been exercised either); `cdk deploy` itself;
  `aws s3 sync`, the invalidation, the image build start; the Lambda's not-configured mode on real Lambda.
- **Supabase (hosted):** the probes against the founder's real database; Supavisor accepting `fenvix_api.<ref>` and
  `fenvix_github_app.<ref>` with a SCRAM verifier set by `postgres`; how long the pooler takes to see a new password
  (the pipeline retries for two minutes); the error text Supavisor returns on a wrong password (matched on SQLSTATE
  28P01/28000 and on "password authentication failed" / "tenant or user not found").
- **TLS to the pooler:** the role strings use `sslmode=require` (libpq semantics: encrypted, the certificate not
  checked against a CA), and the admin connection the same. Lambda's connections had no TLS setting before; they are
  now encrypted. Verifying the pooler's certificate needs Supabase's CA in the bundle (`sslrootcert`); not done,
  because whether the pooler's certificate chains to a public CA could not be checked from here.
- **Cloudflare:** the real API (the token's scopes, `GET /zones?name=` with a zone-scoped token).
- **ACM:** request, validation and issuance timings in us-east-1 and eu-west-1.
- **The dashboard on CloudFront** with the real Supabase sign-in redirect.

## 6. Notes for the reviewer

- The deploy role can read five SecureStrings (the two database URLs, to check them by logging in; the App's key and
  client secret, to compare without writing a new version each time). It already deployed the code that reads every
  secret, so this does not widen what it can reach; the trust policy and the branch rule are what keep it on `main`.
- The deploy job runs dependency code (`npx cdk`, `vite build`) with AWS credentials in the environment, as any CI
  deploy does; the lock files pin every dependency, and `npm ci` runs before the credentials are fetched.
- The GitHub App manifest flow could later remove C2–C4 (one "Create GitHub App" button), but would need the `http`
  function to write SSM; not done (scope, and a wider role).
- `scripts/build-image.sh` and `scripts/demo-{up,down}.sh` remain for an operator; nothing in the founder's path uses
  them.
