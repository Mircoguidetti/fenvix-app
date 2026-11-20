// cdk app: the fenvix GitHub App and dashboard API (Lambda, SQS, API Gateway, Scheduler), the runner machines (EC2),
// and, only with the setting dashboardOnAws (off by default: the dashboard is on Vercel, docs/DEPLOY-VERCEL.md), the
// dashboard (S3 + CloudFront). Deployed by .github/workflows/deploy.yml (docs/DEPLOY-AWS.md). Stacks: lib/app.ts.
import { App } from "aws-cdk-lib";
import { buildApp } from "../lib/app.ts";
import { readSettings } from "../lib/settings.ts";

const app = new App();
buildApp(app, readSettings((k) => app.node.tryGetContext(k)));
