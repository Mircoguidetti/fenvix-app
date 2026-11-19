// AWS Lambda entry: the warm-up scheduler (EventBridge schedule, every minute; per-job mode only). It starts and
// terminates warm-up machines, so it has the worker's launch rights and secrets (src/lambda/runtime.ts "launcher").
import { makeWarmupHandler } from "./handlers.ts";
import { refreshing, workerCore } from "./runtime.ts";

export const handler = makeWarmupHandler(refreshing(() => workerCore(process.env, { launches: true })));
