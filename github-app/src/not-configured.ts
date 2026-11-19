import Fastify, { type FastifyInstance } from "fastify";
import { loggerOptions } from "./app.ts";

type Env = Record<string, string | undefined>;

/**
 * The GitHub App is configured on a deployment when its id is set (GITHUB_APP_ID; on AWS the setting githubAppId, from
 * the repository variable FENVIX_GITHUB_APP_ID: docs/DEPLOY-AWS.md, "Connecting the GitHub App"). Until then the API,
 * the dashboard and the database work; everything that needs the App answers "not configured" and does nothing else.
 */
export function githubAppConfigured(env: Env): boolean {
  return (env.GITHUB_APP_ID ?? "").trim() !== "";
}

export const NOT_CONFIGURED_CODE = "github_not_configured";
export const NOT_CONFIGURED_MESSAGE = "The fenvix GitHub App is not configured on this server yet. Nothing was received or stored.";

/**
 * The App's HTTP side while the App is not configured: /healthz answers (and says so), every other route answers 503
 * github_not_configured. It holds no secret and reaches no database: there is nothing to check a webhook with.
 */
export function notConfiguredHttp(logLevel = "info"): { fastify: FastifyInstance; close(): Promise<void> } {
  const fastify = Fastify({ logger: loggerOptions(logLevel), bodyLimit: 1024 * 1024, trustProxy: true });
  // Any body is accepted unread: nothing is processed.
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser("*", (_req, _payload, done) => done(null, undefined));
  fastify.get("/healthz", async () => ({ ok: true, github: "not_configured" }));
  fastify.setNotFoundHandler(async (_req, reply) => reply.code(503).header("retry-after", "3600").send({ error: { code: NOT_CONFIGURED_CODE, message: NOT_CONFIGURED_MESSAGE } }));
  return { fastify, close: () => fastify.close() };
}
