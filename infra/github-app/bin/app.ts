// cdk app: the fenvix GitHub App (Lambda, SQS, API Gateway, Scheduler) and the runner machine (EC2). One stack.
import { App, Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { applySuppressions } from "../lib/nag.ts";
import { readSettings } from "../lib/settings.ts";
import { FenvixGitHubAppStack } from "../lib/stack.ts";

const app = new App();
const settings = readSettings((k) => app.node.tryGetContext(k));
const stack = new FenvixGitHubAppStack(app, `fenvix-${settings.env}-github-app`, {
  env: { account: settings.account, region: settings.region },
  description: "fenvix GitHub App (Lambda + SQS + API Gateway) and the self-hosted runner machine (EC2). infra/github-app",
  settings,
});
applySuppressions(stack);
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
