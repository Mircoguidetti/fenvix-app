// cdk app: the fenvix GitHub App and dashboard API (Lambda, SQS, API Gateway, Scheduler), the runner machines (EC2),
// and the dashboard (S3 + CloudFront). Deployed by .github/workflows/deploy.yml (docs/DEPLOY-AWS.md).
import { App, Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { FenvixDashboardStack } from "../lib/dashboard.ts";
import { applyDashboardSuppressions, applySuppressions } from "../lib/nag.ts";
import { readSettings } from "../lib/settings.ts";
import { FenvixGitHubAppStack } from "../lib/stack.ts";
import { synthesizer } from "../lib/synthesizer.ts";

const app = new App();
const settings = readSettings((k) => app.node.tryGetContext(k));
const env = { account: settings.account, region: settings.region };
const stack = new FenvixGitHubAppStack(app, `fenvix-${settings.env}-github-app`, {
  env, synthesizer: synthesizer(),
  description: "fenvix GitHub App (Lambda + SQS + API Gateway) and the self-hosted runner machines (EC2). infra/github-app",
  settings,
});
applySuppressions(stack);
const dashboard = new FenvixDashboardStack(app, `fenvix-${settings.env}-dashboard`, {
  env, synthesizer: synthesizer(),
  description: "fenvix dashboard (S3 + CloudFront). infra/github-app/lib/dashboard.ts",
  settings,
});
applyDashboardSuppressions(dashboard, !!settings.dashboardCertificateArn);
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
