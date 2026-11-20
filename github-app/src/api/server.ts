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
import * as backend from "./backend.ts";
import { mcpRoute } from "./mcp.ts";
import { createHash } from "node:crypto";
import * as orgs from "./orgs.ts";
import { dashboardOperations, type Operation } from "./spec.ts";

/** Every dashboard operation of the contract, by operationId. */
export const HANDLERS: Record<string, Handler> = {
  getMe: orgs.getMe, listOrganizations: orgs.listOrganizations, createOrganization: orgs.createOrganization,
  getOrganization: orgs.getOrganization, renameOrganization: orgs.renameOrganization, leaveOrganization: orgs.leaveOrganization,
  listMembers: orgs.listMembers, changeMemberRole: orgs.changeMemberRole, removeMember: orgs.removeMember,
  listInvitations: orgs.listInvitations, createInvitation: orgs.createInvitation, revokeInvitation: orgs.revokeInvitation,
  acceptInvitation: orgs.acceptInvitation, getSettings: orgs.getSettings, saveSettings: orgs.saveSettings,
  getOverview: data.getOverview, listProjects: data.listProjects, getProject: data.getProject, saveProjectSettings: data.saveProjectSettings,
  listRuns: data.listRuns, getSkipShareSeries: data.getSkipShareSeries, listExplorations: data.listExplorations, getAudit: data.getAudit,
  getSetupChange: data.getSetupChange, listActivity: data.listActivity, getRun: data.getRun, listTestResults: data.listTestResults,
  listRunFiles: data.listRunFiles, getSkipReceipt: data.getSkipReceipt, listDefects: data.listDefects, listDefectFamilies: data.listDefectFamilies,
  getDefect: data.getDefect, listUsageMonths: data.listUsageMonths, getUsage: data.getUsage, exportUsage: data.exportUsage,
  listPlans: data.listPlans, getBilling: data.getBilling,
  listDefectOccurrences: backend.listDefectOccurrences, setDefectState: backend.setDefectState, getDefectBundle: backend.getDefectBundle,
  listDefectReplays: backend.listDefectReplays, requestDefectReplay: backend.requestDefectReplay, getReplay: backend.getReplay,
  downloadDefectBundle: backend.downloadDefectBundle, stopRun: backend.stopRun, replayTest: backend.replayTest, listReplays: backend.listReplays,
  listLiveTests: backend.listLiveTests, listFailures: backend.listFailures, getTestLog: backend.getTestLog, saveExplorationSettings: backend.saveExplorationSettings,
  listExplorationJobs: backend.listExplorationJobs, requestExploration: backend.requestExploration, resumeSkip: backend.resumeSkip,
  deleteProject: backend.deleteProject, deleteOrganization: backend.deleteOrganization, exportOrganization: backend.exportOrganization,
  deleteMe: backend.deleteMe, listApiKeys: backend.listApiKeys, createApiKey: backend.createApiKey, revokeApiKey: backend.revokeApiKey,
  unlinkInstallation: backend.unlinkInstallation, listAuditEvents: backend.listAuditEvents,
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

/** Who a request acts for: a signed-in person, or an organization's API key. */
export interface Caller { userId: string; apiKey?: { id: string; workspaceId: string; scopes: ("read" | "replay")[] }; viaMcp?: boolean }

/** Runs one operation for a caller (the HTTP routes and the remote MCP server both use it). */
export type Execute = (op: Operation, caller: Caller, req: { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string | string[] | undefined>; log?: { error(o: object, m?: string): void } }) => Promise<unknown>;

export interface Api { fastify: FastifyInstance; db: ApiDb; execute: Execute; close(): Promise<void> }

/** Requests per minute (DECLARED here, G-1627): a person, an API key. Past it: 429 with Retry-After. */
export const RATE_LIMITS = { person: 600, key: 300 } as const;

/** An API key's text: fxk_ and 40 letters and digits. */
const API_KEY = /^Bearer\s+(fxk_[A-Za-z0-9]{40})$/i;

declare module "fastify" {
  interface FastifyRequest { apiUserId?: string; apiCaller?: Caller }
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

  /**
   * 401 before anything else: no request reaches validation or the database without a verified session or a valid API
   * key. A key is accepted only by operations marked x-fenvix-key (read; replay needs the replay scope) and always acts
   * for its own organization: X-Fenvix-Workspace, when given, must name it (else 404, as for any other organization).
   */
  const authenticate = async (req: FastifyRequest, op: Operation) => {
    const key = API_KEY.exec(String(req.headers.authorization ?? ""));
    if (key) {
      if (!op.key) throw forbidden("An API key cannot call this operation; sign in to the dashboard.");
      const hash = createHash("sha256").update(key[1]!).digest("hex");
      const k = await db.tx("", null, (t) => t.one<{ key_id: string; workspace_id: string; scopes: ("read" | "replay")[] }>(
        "select key_id, workspace_id, scopes from public.api_key_lookup($1)", [hash]));
      if (!k) throw new ApiError(401, "unauthenticated", "This API key is not valid: it was revoked, it expired, or it never existed.");
      if (op.key === "replay" && !k.scopes.includes("replay")) throw forbidden("This API key cannot ask for replays (it lacks the replay scope).");
      const named = req.headers["x-fenvix-workspace"];
      if (named !== undefined && String(named).toLowerCase() !== k.workspace_id) throw notFound(NO_ORGANIZATION);
      req.headers["x-fenvix-workspace"] = k.workspace_id;
      req.apiCaller = { userId: "", apiKey: { id: k.key_id, workspaceId: k.workspace_id, scopes: k.scopes } };
      return;
    }
    const v = await sessions.verify(req.headers.authorization);
    if (v.hs256) throw new ApiError(401, "unauthenticated", "This Supabase project signs sessions with a shared secret (HS256); the fenvix API accepts asymmetric signing keys only (Supabase: Project settings → JWT Keys → migrate to signing keys).");
    if (!v.userId) throw unauthenticated();
    req.apiUserId = v.userId.toLowerCase();
    req.apiCaller = { userId: req.apiUserId, ...(v.sessionId ? { sessionId: v.sessionId } : {}) } as Caller;
  };

  /** One operation for one caller, in one transaction (see the top of this file). */
  const execute: Execute = async (op, caller, r) => {
    const handler = HANDLERS[op.operationId]!;
    const ws = caller.apiKey ? caller.apiKey.workspaceId : op.workspace ? String(r.headers?.["x-fenvix-workspace"] ?? "").toLowerCase() : null;
    const committed: (() => Promise<void>)[] = [];
    const out = await db.tx(caller.userId, ws, async (t) => {
      // The person's session must still exist (signed out or deleted: refused before its token expires, G-2234).
      const sid = (caller as Caller & { sessionId?: string }).sessionId;
      if (sid && !(await t.one<{ ok: boolean }>("select public.api_session_alive($1::uuid) as ok", [sid]))?.ok) throw unauthenticated();
      const subject = caller.apiKey ? `key:${caller.apiKey.id}` : `user:${caller.userId}`;
      const ok = await t.one<{ ok: boolean }>("select public.api_rate_hit($1, $2) as ok", [subject, caller.apiKey ? RATE_LIMITS.key : RATE_LIMITS.person]);
      if (ok?.ok === false) throw new ApiError(429, "rate_limited", "Too many requests this minute. Wait a moment and try again.", undefined, { "retry-after": "60" });
      let org: Org | null = null;
      let role: Role | null = null;
      if (ws && caller.apiKey) {
        const w = await t.one<{ id: string; name: string; name_confirmed: boolean; region: string; email_notices: boolean }>(
          "select w.id, w.name, w.name_confirmed, w.region, w.email_notices from public.workspaces w where w.id = public.api_workspace()");
        if (!w) throw notFound(NO_ORGANIZATION);
        role = "member";
        org = { id: w.id, name: w.name, nameConfirmed: w.name_confirmed, region: w.region === "eu" ? "eu" : "us", emailNotices: w.email_notices };
      } else if (ws) {
        const m = await t.one<{ role: Role; id: string; name: string; name_confirmed: boolean; region: string; email_notices: boolean }>(
          `select m.role, w.id, w.name, w.name_confirmed, w.region, w.email_notices
             from public.workspace_members m join public.workspaces w on w.id = m.workspace_id
            where m.workspace_id = $1 and m.user_id = $2`, [ws, caller.userId]);
        if (!m) throw notFound(NO_ORGANIZATION);
        role = m.role;
        if (!allowed(op, role)) throw forbidden(ADMINS_ONLY);
        org = { id: m.id, name: m.name, nameConfirmed: m.name_confirmed, region: m.region === "eu" ? "eu" : "us", emailNotices: m.email_notices };
      }
      const ctx: Ctx = {
        userId: caller.userId, org, role, t, cfg, queue: deps.queue, now: now(),
        params: (r.params ?? {}) as Record<string, unknown>, query: (r.query ?? {}) as Record<string, unknown>, body: r.body ?? {}, headers: r.headers ?? {},
        ...(caller.apiKey ? { apiKey: { id: caller.apiKey.id, scopes: caller.apiKey.scopes } } : {}), ...(caller.viaMcp ? { viaMcp: true } : {}),
        afterCommit: (fn) => { committed.push(fn); },
      };
      return handler(ctx);
    }, caller.apiKey?.id ?? null);
    for (const fn of committed) {
      await fn().catch((e: unknown) => r.log?.error({ err: e instanceof Error ? e.message : String(e), op: op.operationId }, "work after the commit failed"));
    }
    return out;
  };

  const missing = dashboardOperations().filter((op) => !HANDLERS[op.operationId]).map((op) => op.operationId);
  if (missing.length) throw new Error(`no handler for the dashboard operations ${missing.join(", ")}`);

  for (const op of dashboardOperations()) {
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
      onRequest: async (req) => authenticate(req, op),
      preValidation: async (req) => {
        coerce(req.query, op.querystring);
        coerce(req.params, op.params);
      },
      handler: async (req, reply) => {
        const out = await execute(op, req.apiCaller!, { params: req.params as Record<string, unknown>, query: req.query as Record<string, unknown>, body: req.body, headers: req.headers, log: req.log });
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

  // A defect bundle's signed, short-lived link (GET /v1/defects/{id}/bundle makes it): the token is the credential.
  fastify.get("/v1/bundles", async (req: FastifyRequest<{ Querystring: { token?: string } }>, reply) => {
    const t = backend.verifyBundleToken(cfg.stateSigningKey, String(req.query.token ?? ""));
    if (!t) return errorReply(reply, notFound("This link expired or is not valid. Ask for the bundle again."));
    const b = await db.tx("", null, (x) => x.one<{ content: Buffer; sha256: string }>("select content, sha256 from public.api_signed_bundle($1, $2, $3)", [t.ws, t.defect, t.bundle]));
    if (!b) return errorReply(reply, notFound("This bundle no longer exists."));
    return reply.code(200).header("content-type", "application/gzip").header("content-disposition", `attachment; filename="fenvix-defect-${t.defect}.tar.gz"`)
      .header("x-fenvix-bundle-sha256", b.sha256).header("cache-control", "private, no-store").send(b.content);
  });

  // The remote MCP server (src/api/mcp.ts): POST /v1/mcp with an API key, backed by the same operations.
  mcpRoute(fastify, { db, execute, operations: dashboardOperations() });

  return {
    fastify, db, execute,
    async close() {
      await fastify.close();
      await db.close();
    },
  };
}
