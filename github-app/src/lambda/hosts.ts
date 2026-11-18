// AWS Lambda entry: API Gateway route /v1/hosts/* → the phoenixNAP host routes (src/pnap/hosts.ts). Its own function,
// so the HTTP function never holds the host signing key and this one never holds the webhook or OAuth secrets.
import { makeHttpHandler } from "./handlers.ts";
import { hostsApp, refreshing } from "./runtime.ts";

export const handler = makeHttpHandler(refreshing(() => hostsApp(process.env)));
