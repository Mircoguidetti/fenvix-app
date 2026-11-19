// AWS Lambda entry: the warm-up scheduler (EventBridge schedule, every minute; per-job mode only). It starts and
// terminates warm-up machines, so it has the worker's launch rights and secrets (src/lambda/runtime.ts "launcher").
import { githubAppConfigured } from "../not-configured.ts";
import { makeWarmupHandler, notConfiguredWarmup } from "./handlers.ts";
import { refreshing, workerCore } from "./runtime.ts";

const configured = makeWarmupHandler(refreshing(() => workerCore(process.env, { launches: true })));
// While the GitHub App is not configured there are no repositories to warm: the schedule's call does nothing.
export const handler = () => (githubAppConfigured(process.env) ? configured() : notConfiguredWarmup());
