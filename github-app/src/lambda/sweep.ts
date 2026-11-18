// AWS Lambda entry: the EventBridge schedule that publishes completed jobs whose runner summary never came.
import { makeSweepHandler } from "./handlers.ts";
import { once, workerCore } from "./runtime.ts";

export const handler = makeSweepHandler(once(() => workerCore(process.env)));
