// AWS Lambda entry: the SQS work queue (webhooks and runner summaries handed off by the HTTP function).
import { githubAppConfigured } from "../not-configured.ts";
import { jsonLogger } from "../work.ts";
import { makeNotConfiguredWorkerHandler, makeWorkerHandler, type SqsEvent } from "./handlers.ts";
import { refreshing, workerCore } from "./runtime.ts";

const configured = makeWorkerHandler(refreshing(() => workerCore(process.env, { launches: true })));
// Decided at each call (nothing runs at import): the App is configured when GITHUB_APP_ID is set.
export const handler = (event: SqsEvent) => githubAppConfigured(process.env)
  ? configured(event)
  : makeNotConfiguredWorkerHandler(jsonLogger(process.env.LOG_LEVEL ?? "info"))(event);
