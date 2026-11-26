/*
 * The fenvix dashboard API (openapi/fenvix-api.yaml, operations tagged `dashboard`), under /v1. On AWS it is its own
 * Lambda (src/lambda/api.ts) behind the App's API Gateway: /v1/* except /v1/runner/*.
 *
 * Every request: CORS for the dashboard's origin only; the Supabase session token verified against the project's
 * published keys (401); the request checked against the contract (400); then one database transaction as fenvix_api
 * naming the person and the organization (X-Fenvix-Workspace), in which the API checks the membership (404 for an
 * organization the person is not a member of, the same as for one that does not exist) and the role (403 for a
 * member calling an owner-or-admin operation) before the handler runs. Row level security checks both again.
 */
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { SessionVerifier } from "../auth.ts";
import type { ApiConfig } from "./config.ts";
import { allowed, type Ctx, type Handler, type OnboardQueue, type Org, Reply, type Role } from "./context.ts";
import * as data from "./data.ts";
import { ApiDb } from "./db.ts";
import { ADMINS_ONLY, ApiError, forbidden, NO_ORGANIZATION, notFound, unauthenticated } from "./errors.ts";
import * as github from "./github.ts";
import * as orgs from "./orgs.ts";
import * as sideBySide from "./side-by-side.ts";
import { dashboardOperations, type Operation } from "./spec.ts";

/** Every dashboard operation of the contract, by operationId. */
export const HANDLERS: Record<string, Handler> = {
  getMe: orgs.getMe, listOrganizations: orgs.listOrganizations, createOrganization: orgs.createOrganization,
  getOrganization: orgs.getOrganization, renameOrganization: orgs.renameOrganization, leaveOrganization: orgs.leaveOrganization,
  listMembers: orgs.listMembers, changeMemberRole: orgs.changeMemberRole, removeMember: orgs.removeMember,
  listInvitations: orgs.listInvitations, createInvitation: orgs.createInvitation, revokeInvitation: orgs.revokeInvitation,
  acceptInvitation: orgs.acceptInvitation, getSettings: orgs.getSettings, saveSettings: orgs.saveSettings, getOnboardingKind: orgs.getOnboardingKind, setOnboardingKind: orgs.setOnboardingKind, getSideBySide: sideBySide.getSideBySide,
  getOverview: data.getOverview, listProjects: data.listProjects, getProject: data.getProject, saveProjectSettings: data.saveProjectSettings,
  listRuns: data.listRuns, getSkipShareSeries: data.getSkipShareSeries, listExplorations: data.listExplorations, getAudit: data.getAudit,
  getSetupChange: data.getSetupChange, listActivity: data.listActivity, getRun: data.getRun, listTestResults: data.listTestResults,
  listRunFiles: data.listRunFiles, getSkipReceipt: data.getSkipReceipt, listDefects: data.listDefects, listDefectFamilies: data.listDefectFamilies,
  getDefect: data.getDefect, listUsageMonths: data.listUsageMonths, getUsage: data.getUsage, exportUsage: data.exportUsage,
  listPlans: data.listPlans, getBilling: data.getBilling, search: data.search,
  getGitHubConnection: github.getGitHubConnection, createInstallLink: github.createInstallLink, completeGitHubInstall: github.completeGitHubInstall,
  listGitHubRepositories: github.listGitHubRepositories, openSetupPullRequest: github.openSetupPullRequest,
};

/** What the browser may send and read across origins. */
export const CORS = {
  methods: "GET, POST, PUT, DELETE, OPTIONS",
  allowHeaders: "authorization, content-type, x-fenvix-workspace, if-none-match",
  exposeHeaders: "etag, content-disposition, retry-after",
  maxAge: "600",
};

export interface ApiDeps {
  cfg: ApiConfig;
  db?: ApiDb;
  sessions?: SessionVerifier;
  queue: OnboardQueue;
  logger?: boolean | object;
  /** The clock (tests). */
  now?: () => Date;
}

export interface Api { fastify: FastifyInstance; db: ApiDb; close(): Promise<void> }

declare module "fastify" {
  interface FastifyRequest { apiUserId?: string }
  interface FastifyContextConfig { apiOperation?: Operation }
}

/** Never the Authorization header, never the query string (it can hold a search term). */
export function apiLoggerOptions(level: string) {
  return {
    level, redact: ["req.headers.authorization"],
    serializers: { req: (r: { method: string; url: string; ip?: string }) => ({ method: r.method, url: r.url.split("?")[0], remoteAddress: r.ip }) },
  };
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** Query strings and path parameters arrive as text: numbers where the contract says integer or number. */
function coerce(values: unknown, schema: Operation["querystring"]): void {
  if (!values || typeof values !== "object" || !schema) return;
  const props = (schema.properties ?? {}) as Record<string, { type?: unknown }>;
  const o = values as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    const t = props[k]?.type;
    if ((t === "integer" || t === "number") && typeof v === "string" && NUMERIC.test(v)) o[k] = Number(v);
  }
}

/** The first problem of a request that does not match the contract, in words, with the field. */
export function validationMessage(err: FastifyError): ApiError {
  const v = err.validation?.[0] as { instancePath?: string; keyword?: string; params?: Record<string, unknown>; message?: string } | undefined;
  const where = (err as { validationContext?: string }).validationContext ?? "body";
  let field = v?.keyword === "required" ? String(v.params?.missingProperty ?? "") : (v?.instancePath ?? "").replace(/^\//, "").replace(/\//g, ".");
  if (v?.keyword === "additionalProperties") field = [field, String(v.params?.additionalProperty ?? "")].filter(Boolean).join(".");
  if (where === "headers" && field === "x-fenvix-workspace") {
    return new ApiError(400, "validation_failed", "Name the organization with the X-Fenvix-Workspace header (its id).", "X-Fenvix-Workspace");
  }
  const label = field || (where === "body" ? "The body" : where === "querystring" ? "The query" : where);
  let message: string;
  if (v?.keyword === "required") message = `${field} is required.`;
  else if (v?.keyword === "additionalProperties") message = `${field} is not a field this operation takes.`;
  else if (v?.keyword === "enum") message = `${label} must be one of: ${((v.params?.allowedValues ?? []) as unknown[]).join(", ")}.`;
  else message = `${label} ${v?.message ?? "is not valid"}.`;
  return new ApiError(400, "validation_failed", message, field || undefined);
}

/** A database error as a person should read it. Messages raised by our own functions are written for people. */
function fromDatabase(e: { code?: string; message?: string; constraint?: string }): ApiError | null {
  switch (e.code) {
    case "23514": return new ApiError(409, "conflict", e.constraint ? "That value is not allowed here." : e.message ?? "That is not allowed.");
    case "23505": return new ApiError(409, "conflict", "That already exists.");
    case "42501": return forbidden("Your role in this organization does not allow this.");
    case "22P02": case "22007": case "22008": case "22003": return new ApiError(400, "validation_failed", "A value in the request is not valid.");
    case "40001": case "40P01": case "57014": case "53300": return new ApiError(503, "unavailable", "The database is busy. Try again in a moment.");
    default: return null;
  }
}

function errorReply(reply: FastifyReply, e: ApiError) {
  for (const [k, v] of Object.entries(e.headers)) reply.header(k, v);
  return reply.code(e.status).type("application/json; charset=utf-8").send(e.body());
}

export function buildApi(deps: ApiDeps): Api {
  const { cfg } = deps;
  const db = deps.db ?? new ApiDb(cfg.databaseUrl, cfg.dbPoolMax);
  const sessions = deps.sessions ?? new SessionVerifier(cfg.supabaseUrl, cfg.supabaseJwksUrl);
  const now = deps.now ?? (() => new Date());
  const origins = new Set(cfg.corsOrigins);
  const fastify = Fastify({
    logger: deps.logger ?? apiLoggerOptions(cfg.logLevel),
    bodyLimit: 64 * 1024,
    trustProxy: true,
    // The contract decides: nothing is coerced in a body, nothing unknown silently dropped.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: true, allErrors: false } },
  });

  // JSON bodies; an empty body is no body (a POST without one, e.g. leaving an organization).
  fastify.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = String(body);
    if (!text.trim()) return done(null, undefined);
    try { done(null, JSON.parse(text)); } catch {
      done(new ApiError(400, "validation_failed", "The body is not JSON.") as unknown as Error, undefined);
    }
  });

  // CORS: the dashboard's origin(s) only; ETag and Content-Disposition readable by it.
  fastify.addHook("onSend", async (req, reply, payload) => {
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-expose-headers", CORS.exposeHeaders);
    }
    // Private data: never stored by a cache unless the operation says otherwise (the run page revalidates).
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    const vary = String(reply.getHeader("vary") ?? "");
    if (!/\borigin\b/i.test(vary)) reply.header("vary", vary ? `${vary}, Origin` : "Origin");
    return payload;
  });
  fastify.options("/v1/*", async (req, reply) => {
    const origin = req.headers.origin;
    const method = String(req.headers["access-control-request-method"] ?? "").toUpperCase();
    if (!origin || !origins.has(origin) || !CORS.methods.split(", ").includes(method)) {
      return errorReply(reply, forbidden("This origin may not call the fenvix API."));
    }
    return reply.code(204)
      .header("access-control-allow-methods", CORS.methods)
      .header("access-control-allow-headers", CORS.allowHeaders)
      .header("access-control-max-age", CORS.maxAge)
      .send();
  });

  fastify.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    if (err instanceof ApiError) return errorReply(reply, err);
    if ((err as FastifyError).validation) return errorReply(reply, validationMessage(err as FastifyError));
    const pg = fromDatabase(err as { code?: string });
    if (pg) {
      if (pg.status >= 500) req.log.warn({ code: (err as { code?: string }).code }, "database busy");
      return errorReply(reply, pg);
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status === 413) return errorReply(reply, new ApiError(413, "validation_failed", "The request body is too large."));
    if (status === 415) return errorReply(reply, new ApiError(415, "validation_failed", "Send the body as JSON (Content-Type: application/json)."));
    if (status >= 400 && status < 500) return errorReply(reply, new ApiError(status, "validation_failed", "The request could not be read."));
    req.log.error({ err: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code }, "API error");
    return errorReply(reply, new ApiError(500, "internal", "Something went wrong on our side. Try again; if it keeps happening, tell us."));
  });
  fastify.setNotFoundHandler((_req, reply) => errorReply(reply, notFound("There is no such API operation.")));

  /** 401 before anything else: no request reaches validation or the database without a verified session. */
  const authenticate = async (req: FastifyRequest) => {
    const userId = await sessions.userId(req.headers.authorization);
    if (!userId) throw unauthenticated();
    req.apiUserId = userId.toLowerCase();
  };

  const missing = dashboardOperations().filter((op) => !HANDLERS[op.operationId]).map((op) => op.operationId);
  if (missing.length) throw new Error(`no handler for the dashboard operations ${missing.join(", ")}`);

  for (const op of dashboardOperations()) {
    const handler = HANDLERS[op.operationId]!;
    fastify.route({
      method: op.method,
      url: op.route,
      config: { apiOperation: op },
      schema: {
        ...(op.params ? { params: op.params } : {}),
        ...(op.querystring ? { querystring: op.querystring } : {}),
        ...(op.headers ? { headers: op.headers } : {}),
        ...(op.body ? { body: op.body } : {}),
      },
      onRequest: authenticate,
      preValidation: async (req) => {
        coerce(req.query, op.querystring);
        coerce(req.params, op.params);
      },
      handler: async (req, reply) => {
        const userId = req.apiUserId!;
        const ws = op.workspace ? String(req.headers["x-fenvix-workspace"]).toLowerCase() : null;
        const committed: (() => Promise<void>)[] = [];
        const out = await db.tx(userId, ws, async (t) => {
          let org: Org | null = null;
          let role: Role | null = null;
          if (ws) {
            const m = await t.one<{ role: Role; id: string; name: string; name_confirmed: boolean; region: string; email_notices: boolean }>(
              `select m.role, w.id, w.name, w.name_confirmed, w.region, w.email_notices
                 from public.workspace_members m join public.workspaces w on w.id = m.workspace_id
                where m.workspace_id = $1 and m.user_id = $2`, [ws, userId]);
            if (!m) throw notFound(NO_ORGANIZATION);
            role = m.role;
            if (!allowed(op, role)) throw forbidden(ADMINS_ONLY);
            org = { id: m.id, name: m.name, nameConfirmed: m.name_confirmed, region: m.region === "eu" ? "eu" : "us", emailNotices: m.email_notices };
          }
          const ctx: Ctx = {
            userId, org, role, t, cfg, queue: deps.queue, now: now(),
            params: (req.params ?? {}) as Record<string, unknown>, query: (req.query ?? {}) as Record<string, unknown>, body: req.body ?? {}, headers: req.headers,
            afterCommit: (fn) => { committed.push(fn); },
          };
          return handler(ctx);
        });
        for (const fn of committed) {
          await fn().catch((e: unknown) => req.log.error({ err: e instanceof Error ? e.message : String(e), op: op.operationId }, "work after the commit failed"));
        }
        if (out instanceof Reply) {
          for (const [k, v] of Object.entries(out.headers)) reply.header(k, v);
          reply.code(out.status);
          if (out.status === 204 || out.status === 304) return reply.send();
          return reply.send(out.body);
        }
        return reply.code(200).send(out);
      },
    });
  }

  return {
    fastify, db,
    async close() {
      await fastify.close();
      await db.close();
    },
  };
}
