// The stacks of the cdk app (bin/app.ts), in a function the tests call: the fenvix GitHub App and dashboard API
// (Lambda, SQS, API Gateway, Scheduler) and the runner machines (EC2) always; the AWS dashboard (S3 + CloudFront) only
// when settings.dashboardOnAws is true. Off (the default) the dashboard is hosted on Vercel (docs/DEPLOY-VERCEL.md) and
// `cdk deploy --all` plans the API stack only.
import { Aspects, type App, type Stack } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { FenvixDashboardStack } from "./dashboard.ts";
import { applyDashboardSuppressions, applySuppressions } from "./nag.ts";
import type { Settings } from "./settings.ts";
import { FenvixGitHubAppStack } from "./stack.ts";
import { synthesizer } from "./synthesizer.ts";

/** The stack names of an environment: the API (always) and the AWS dashboard (only with dashboardOnAws). */
export const stackNames = (env: string) => ({ api: `fenvix-${env}-github-app`, dashboard: `fenvix-${env}-dashboard` });

export function buildApp(app: App, settings: Settings): Stack[] {
  const env = { account: settings.account, region: settings.region };
  const names = stackNames(settings.env);
  const stack = new FenvixGitHubAppStack(app, names.api, {
    env, synthesizer: synthesizer(),
    description: "fenvix GitHub App (Lambda + SQS + API Gateway) and the self-hosted runner machines (EC2). infra/github-app",
    settings,
  });
  applySuppressions(stack);
  const stacks: Stack[] = [stack];
  if (settings.dashboardOnAws) {
    const dashboard = new FenvixDashboardStack(app, names.dashboard, {
      env, synthesizer: synthesizer(),
      description: "fenvix dashboard (S3 + CloudFront). infra/github-app/lib/dashboard.ts",
      settings,
    });
    applyDashboardSuppressions(dashboard, !!settings.dashboardCertificateArn);
    stacks.push(dashboard);
  }
  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  return stacks;
}
