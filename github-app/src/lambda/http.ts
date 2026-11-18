// AWS Lambda entry: API Gateway HTTP API (payload 2.0) → the Fastify app. Bundled by infra/github-app.
import { makeHttpHandler } from "./handlers.ts";
import { httpApp, refreshing } from "./runtime.ts";

// Secrets are reloaded every SECRETS_TTL_SECONDS (a rotated webhook secret or runner token takes effect without a deploy).
export const handler = makeHttpHandler(refreshing(() => httpApp(process.env)));
