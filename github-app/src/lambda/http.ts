// AWS Lambda entry: API Gateway HTTP API (payload 2.0) → the Fastify app. Bundled by infra/github-app.
import { makeHttpHandler } from "./handlers.ts";
import { httpApp, once } from "./runtime.ts";

export const handler = makeHttpHandler(once(() => httpApp(process.env)));
