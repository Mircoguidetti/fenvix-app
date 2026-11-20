# infra/github-app: the GitHub App on AWS Lambda, and its runner machines on EC2

AWS CDK in TypeScript, two stacks: `fenvix-<env>-github-app` (the App, the dashboard API, the runners) and
`fenvix-<env>-dashboard` (S3 + CloudFront, `lib/dashboard.ts`). **Deployed only by `.github/workflows/deploy.yml` on
merge to `main`; read `../../docs/DEPLOY-AWS.md`**: the founder's one-time browser steps, what a deploy does, the
monthly cost. The deploy resources CDK needs come from the one-click template `../bootstrap/fenvix-bootstrap.json`
(qualifier `fenvix`, `lib/synthesizer.ts`), not from `cdk bootstrap`.

Without the GitHub App (`githubAppId`, `githubAppSlug`, `githubClientId` empty: the default until it is created) the
stacks deploy and the API works; the App's routes answer 503 `github_not_configured` and its functions do nothing.

The same stack serves the **dashboard API** (`openapi/fenvix-api.yaml`, operations tagged `dashboard`;
`github-app/src/api/`): its own function `api` behind the same API Gateway, `ANY /v1/{proxy+}`, while
`/v1/runner/{proxy+}`, the webhooks, `/github/setup` and `/healthz` stay on the App's `http` function. The `api`
function reads only `api-database-url` (the role `fenvix_api`, Supabase pooler in transaction mode) and
`state-signing-key`, may only send to the work queue, and answers CORS itself (the dashboard's origin, plus
`apiCorsOrigins`). docs/DEPLOY-AWS.md, "The dashboard API".

Runner modes (`runnerMode` in `cdk.json`):

- **`per-job`** (default): each queued fenvix job gets one EC2 machine with a just-in-time runner, terminated after
  the job; the shared cache runs on a private t4g.nano, one cache organization per customer installation.
- **`demo`** (an option, off; needs the App): the demo function (`{"action":"up"}`, or `scripts/demo-up.sh`) starts one fresh c6i.large from the runner image and registers it on
  `demoRepository` (the only repository allowed); `scripts/demo-down.sh` terminates it, then deregisters it. Nothing
  crosses demos.

No runner machine reads a secret: the machines' role has no permission. Each machine gets its own credentials in its
user data (a summary credential bound to its runner name, repository and run; per-job, a cache token for its
customer's organization only), minted by the worker or the demo function. Every role of the stack carries the
permissions boundary `permissions-boundary.json` (docs/REVIEW-R-012.md, docs/REPORT-aws-deploy-2.md).
- **Customer mode** (Firecracker microVMs on a c7i.xlarge, Nitro Sandboxes): design in `docs/DEPLOY-AWS.md`, spike in
  `../customer-mode/spike/`.

```
npm test           # typecheck + template, policy, bundle and runner-script tests (no AWS account needed)
npm run synth      # cdk synth with cdk-nag (needs the settings: cdk.json or environment)
```

The deploy itself, the secrets, the cache signing key, the DNS records and the runner image build are steps of the
workflow (`../../deploy/`). `scripts/build-image.sh` and `scripts/demo-{up,down}.sh` remain for an operator with AWS
credentials; the founder never needs them (docs/DEPLOY-AWS.md, sections B and E).

| Path | What |
|---|---|
| `bin/app.ts` | the app: settings, both stacks, cdk-nag (AwsSolutions) |
| `lib/dashboard.ts` | the dashboard: private S3 bucket, CloudFront (origin access control, the us-east-1 certificate the pipeline requests, TLS 1.2+, security headers, client routes to `index.html`) |
| `lib/synthesizer.ts` | deploy through the one-click template's roles and bucket (qualifier `fenvix`) |
| `lib/stack.ts` | Lambdas (http, api, worker, sweep, reaper, demo) bundled from `../../github-app/src/lambda/` (the api bundle also takes the dashboard's `src/data/ci.ts` and `ci-rows.ts`), SQS + dead-letter queue, S3 overflow, EventBridge Scheduler, API Gateway HTTP API on the custom domain (`domainName`, `api.fenvix.dev`; routes: `/v1/*` → api, `/v1/runner/*` and the rest → http) with the ACM certificate the pipeline issues before CDK (`apiCertificateArn`), logs, alarm; the worker's `RUNNER_PLACEMENT` (us / eu fleets, settings `fenvixRegion` and `second*`) |
| `lib/network.ts` | VPC without NAT, one public subnet; the runners' and the cache's security groups |
| `lib/runner.ts`, `lib/runner/files/` | the files baked into the runner image (install.sh, registration, metadata block, hooks, summary poster, per-job units: just-in-time runner, idle watchdog, power-off), bundled as one gzip |
| `lib/runner-fleet.ts` | the Image Builder pipeline (the runner image; its build machine may read no /fenvix parameter), the launch template (terminate on shutdown), the machines' role (no permission) |
| `lib/cache.ts`, `lib/cache/` | per-job: the shared cache machine and the engine's cache service, vendored at a pinned commit (`PROVENANCE.md`), behind `fenvix_cache_auth.py` (per-job signed tokens, one organization per installation) |
| `lib/parameters.ts` | the SSM parameters (names, who reads which) |
| Regions | the worker's `RUNNER_PLACEMENT` names this stack's fleet (`fenvixRegion`) and, optionally, another region's (`second*` settings, with its own cache URL as that placement's `machineEnv`). The reaper cleans its own AWS region only: each region's machines are reaped by the stack deployed in that region. |
| `lib/settings.ts`, `cdk.json` | the settings (non-secret); `domainName` is the one source of the API's host (stack, runner URLs, deploy steps) |
| `lib/nag.ts` | the cdk-nag findings that do not apply, each with its reason |
| `deploy-policy.json` | the deploy role's permissions (`fenvix-github-deployer`, GitHub OIDC: assume the CDK deploy and publishing roles, own parameters, logs, the dashboard upload, the image build) |
| `cfn-exec-policy-app.json`, `-edge.json`, `-fleet.json`, `-dashboard.json` | what CloudFormation may create; roles only with the boundary |
| `permissions-boundary.json` | `fenvix-prod-github-app-boundary`: the most any role of the stack may do |
| (all four above) | embedded in `../bootstrap/fenvix-bootstrap.json` by `../bootstrap/build.mjs`; a test fails if they drift |
| `scripts/` | the image build and demo up/down for an operator (not used by the pipeline); `scram-verifier.mjs` (used by the pipeline) |
| `test/cfn-permissions.test.ts`, `test/cfn-handler-permissions.json` | for every resource type of every synthesized template: the execution policies allow its create and tag actions on its own ARN, and every other action CloudFormation's handler calls (create, update, delete, read), unless named as not needed with the reason. The JSON comes from the resource-provider schemas cfn-lint ships: `python3 scripts/cfn-handler-permissions.py [AWS::New::Type]` (CI checks it with `--check`) |

Why CDK and not SAM: CDK in TypeScript (with cdk-nag) matches the service, which is TypeScript, and `NodejsFunction` bundles it with esbuild locally (no Docker); the EC2 runner, its VPC and IAM are
first-class in CDK, while SAM is aimed at the serverless half and adds a second toolchain (SAM CLI).
