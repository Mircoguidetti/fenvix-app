// AWS Lambda entry: the EventBridge schedule that publishes completed jobs whose runner summary never came.
import { makeSweepHandler } from "./handlers.ts";
import { refreshing, workerCore } from "./runtime.ts";

export const handler = makeSweepHandler(refreshing(() => workerCore(process.env)));
