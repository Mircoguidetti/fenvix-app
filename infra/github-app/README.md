# infra/github-app: the GitHub App on AWS Lambda, and its runner machines on EC2

AWS CDK in TypeScript, one stack, `fenvix-<env>-github-app`. **Read `../../docs/DEPLOY-AWS.md`**: the founder's steps,
the Cloudflare records and the monthly cost.

Runner modes (`runnerMode` in `cdk.json`):

- **`demo`** (default): `scripts/demo-up.sh owner/repo` starts one fresh t3.medium from the runner image and registers
  it on the repository; `scripts/demo-down.sh` deregisters it and terminates it. Nothing crosses demos.
- **`per-job`**: each queued fenvix job gets one EC2 machine with a just-in-time runner, terminated after the job;
  the shared cache runs on a private t4g.nano.
- **Customer mode** (Firecracker microVMs on a c7i.xlarge, Nitro Sandboxes): design in `docs/DEPLOY-AWS.md`, spike in
  `../customer-mode/spike/`.

```
npm run deploy     # the one deploy command (scripts/deploy.sh): checks, tests, diff, confirm, deploy, DNS records
npm test           # typecheck + template, policy, bundle and runner-script tests (no AWS account needed)
npm run synth      # cdk synth with cdk-nag (needs the settings: cdk.json or environment)
bash scripts/build-image.sh                      # per-job: build the runner image (Image Builder), 30-45 min
bash scripts/demo-up.sh owner/repo / demo-down.sh  # demo: one fresh runner machine for a demo / take it down
bash scripts/cache-tokens.sh                     # per-job: the shared cache's two tokens into SSM; prints their SHA-256
```

| Path | What |
|---|---|
| `bin/app.ts` | the app: settings, the stack, cdk-nag (AwsSolutions) |
| `lib/stack.ts` | Lambdas (http, worker, sweep) bundled from `../../github-app/src/lambda/`, SQS + dead-letter queue, S3 overflow, EventBridge Scheduler, API Gateway HTTP API on the custom domain, ACM, logs, alarm |
| `lib/network.ts` | VPC without NAT, one public subnet; the runners' and the cache's security groups |
| `lib/runner.ts`, `lib/runner/files/` | the files baked into the runner image (install.sh, registration, metadata block, hooks, summary poster, per-job units: just-in-time runner, idle watchdog, power-off), bundled as one gzip |
| `lib/runner-fleet.ts` | the Image Builder pipeline (the runner image), the launch template (terminate on shutdown), the machines' role (both modes) |
| `lib/cache.ts`, `lib/cache/` | per-job: the shared cache machine and the engine's cache service, vendored at a pinned commit (`PROVENANCE.md`) |
| `lib/parameters.ts` | the SSM parameters (names, who reads which) |
| `lib/settings.ts`, `cdk.json` | the settings (non-secret) |
| `lib/nag.ts` | the cdk-nag findings that do not apply, each with its reason |
| `deploy-policy.json` | the deploy identity's permissions (assume the CDK bootstrap roles, own parameters, logs, Session Manager) |
| `cfn-exec-policy-app.json`, `-edge.json`, `-fleet.json` | what CloudFormation may create (given to `cdk bootstrap`) |
| `scripts/` | the deploy; the two Cloudflare records read from AWS; the image build; demo up and down; the cache tokens |

Why CDK and not SAM: this repository's `infra/` is already CDK in TypeScript (with cdk-nag), the service is
TypeScript, and `NodejsFunction` bundles it with esbuild locally (no Docker); the EC2 runner, its VPC and IAM are
first-class in CDK, while SAM is aimed at the serverless half and adds a second toolchain (SAM CLI).
