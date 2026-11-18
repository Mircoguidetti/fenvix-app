// AWS Lambda entry: the SQS work queue (webhooks and runner summaries handed off by the HTTP function).
import { makeWorkerHandler } from "./handlers.ts";
import { once, workerCore } from "./runtime.ts";

export const handler = makeWorkerHandler(once(() => workerCore(process.env, { launches: true })));
