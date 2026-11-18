# infra/github-app: the GitHub App on AWS Lambda and the runner machine on EC2

AWS CDK in TypeScript, one stack, `fenvix-<env>-github-app`. **Read `../../docs/DEPLOY-AWS.md`**: the founder's steps,
the Cloudflare records and the monthly cost.

```
npm run deploy     # the one deploy command (scripts/deploy.sh): checks, tests, diff, confirm, deploy, DNS records
npm test           # typecheck + template, policy, bundle and runner-script tests (no AWS account needed)
npm run synth      # cdk synth with cdk-nag (needs the settings: cdk.json or environment)
```

| Path | What |
|---|---|
| `bin/app.ts` | the app: settings, the stack, cdk-nag (AwsSolutions) |
| `lib/stack.ts` | Lambdas (http, worker, sweep) bundled from `../../github-app/src/lambda/`, SQS + dead-letter queue, S3 overflow, EventBridge Scheduler, API Gateway HTTP API on the custom domain, ACM, logs, alarm |
| `lib/runner.ts`, `lib/runner/files/` | the EC2 runner machine: VPC without NAT, no inbound, IMDSv2; the user data and the files it installs (setup, registration, metadata block, job-completed hook, summary poster, systemd units) |
| `lib/parameters.ts` | the SSM parameters (names, who reads which) |
| `lib/settings.ts`, `cdk.json` | the settings (non-secret) |
| `lib/nag.ts` | the cdk-nag findings that do not apply, each with its reason |
| `deploy-policy.json` | the deploy identity's permissions (assume the CDK bootstrap roles, own parameters, logs, Session Manager) |
| `cfn-exec-policy-app.json`, `cfn-exec-policy-edge.json` | what CloudFormation may create (given to `cdk bootstrap`) |
| `scripts/deploy.sh`, `scripts/dns-records.sh` | the deploy; the two Cloudflare records read from AWS |

Why CDK and not SAM: this repository's `infra/` is already CDK in TypeScript (with cdk-nag), the service is
TypeScript, and `NodejsFunction` bundles it with esbuild locally (no Docker); the EC2 runner, its VPC and IAM are
first-class in CDK, while SAM is aimed at the serverless half and adds a second toolchain (SAM CLI).
