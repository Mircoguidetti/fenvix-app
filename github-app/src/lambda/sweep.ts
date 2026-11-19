// AWS Lambda entry: the EventBridge schedule that publishes completed jobs whose runner summary never came.
import { githubAppConfigured } from "../not-configured.ts";
import { makeSweepHandler, notConfiguredSweep } from "./handlers.ts";
import { refreshing, workerCore } from "./runtime.ts";

const configured = makeSweepHandler(refreshing(() => workerCore(process.env)));
// While the GitHub App is not configured there are no jobs: the schedule's call does nothing.
export const handler = () => (githubAppConfigured(process.env) ? configured() : notConfiguredSweep());
