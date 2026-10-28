import "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Caller, Services } from "./context.ts";
import { ApiError, forbidden, unauthenticated, validation } from "./errors.ts";
import { type JwtVerifier, type SessionClaims } from "./auth/jwt.ts";
import { type AuthGateway, type Tokens } from "./auth/gateway.ts";
import { resolveApiKey } from "./services/account.ts";
import { RateLimiter } from "./ratelimit.ts";
import * as idem from "./idempotency.ts";
import { type OperationRow, type OperationRunner, loadOperation, operationError, viewOperation } from "./services/operations.ts";
import { type Obj } from "./validate.ts";

export const SESSION_COOKIE = "fnx_session";
export const REFRESH_COOKIE = "fnx_refresh";
const REFRESH_COOKIE_SECONDS = 30 * 86400;

export interface Deps {
  s: Services;
  gateway: AuthGateway;
  verifier: JwtVerifier;
  runner: OperationRunner;
  limiter: RateLimiter;
}

export interface Access {
  /** "admin" means owner or admin of the workspace. */
  role?: "any" | "admin";
  /** Whether an API key may call this. Keys cannot manage keys or settings. */
  apiKey?: boolean;
}

export interface Ctx {
  caller: Caller;
  req: FastifyRequest;
  reply: FastifyReply;
  q: Obj;
  params: Obj;
  body: unknown;
}

export type Outcome =
  | { status: number; body: unknown; headers?: Record<string, string> }
  /**
   * A long operation was submitted; the wrapper runs it and answers with its result or a 202. `reveal` may add to the
   * FIRST answer of the request that submitted it (an initial password, docs/database-users.md); a replay of the
   * request with its Idempotency-Key and a poll of the operation never call it.
   */
  | { submitted: OperationRow; reveal?: (op: OperationRow, body: unknown) => unknown };

export function setSessionCookies(d: Deps, reply: FastifyReply, t: Tokens): void {
  const base = { httpOnly: true, secure: d.s.cfg.cookieSecure, sameSite: "lax" as const, path: "/", domain: d.s.cfg.cookieDomain };
  reply.setCookie(SESSION_COOKIE, t.accessToken, { ...base, maxAge: Math.max(60, t.expiresIn) });
  reply.setCookie(REFRESH_COOKIE, t.refreshToken, { ...base, maxAge: REFRESH_COOKIE_SECONDS });
}

export function clearSessionCookies(d: Deps, reply: FastifyReply): void {
  const base = { path: "/", domain: d.s.cfg.cookieDomain };
  reply.clearCookie(SESSION_COOKIE, base);
  reply.clearCookie(REFRESH_COOKIE, base);
}

export const clientIp = (req: FastifyRequest) => req.ip;

/** Counts a request against the unauthenticated budget of its address. */
export function hitAnon(d: Deps, req: FastifyRequest): void {
  d.limiter.hit(`anon:${clientIp(req)}`, d.s.cfg.rateLimitAnonPerMinute);
}

/** The signed-in user of a request, from the session cookie (refreshed when it has expired) or a bearer token. */
export async function sessionFromRequest(d: Deps, req: FastifyRequest, reply: FastifyReply): Promise<{ claims: SessionClaims; viaCookie: boolean } | null> {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ") && !auth.startsWith("Bearer fnx_")) {
    const r = await d.verifier.verify(auth.slice(7).trim());
    return r.ok ? { claims: r.claims, viaCookie: false } : null;
  }
  const access = req.cookies[SESSION_COOKIE];
  const refresh = req.cookies[REFRESH_COOKIE];
  if (access) {
    const r = await d.verifier.verify(access);
    if (r.ok) return { claims: r.claims, viaCookie: true };
    if (r.reason !== "expired") return null;
  }
  if (refresh) {
    try {
      const t = await d.gateway.refresh(refresh);
      const r = await d.verifier.verify(t.accessToken);
      if (!r.ok) return null;
      setSessionCookies(d, reply, t);
      return { claims: r.claims, viaCookie: true };
    } catch (e) {
      req.log.info({ err: e instanceof Error ? e.message : String(e) }, "session refresh failed");
      clearSessionCookies(d, reply);
    }
  }
  return null;
}

/** Who is calling, for which workspace, or an ApiError. Also counts the request against the rate limits. */
export async function authenticate(d: Deps, req: FastifyRequest, reply: FastifyReply, access: Access): Promise<Caller> {
  const { s } = d;
  d.limiter.check(`anon:${clientIp(req)}`, s.cfg.rateLimitAnonPerMinute);
  const fail = (e: ApiError): never => {
    // Wrong keys and bad tokens count against the address, so guessing is slow.
    d.limiter.hit(`anon:${clientIp(req)}`, s.cfg.rateLimitAnonPerMinute);
    throw e;
  };

  let caller: Caller;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer fnx_")) {
    if (access.apiKey === false) throw forbidden("API keys cannot do this. Sign in to the dashboard.");
    const key = await resolveApiKey(s, auth.slice(7).trim());
    if (!key) return fail(unauthenticated("That API key is not valid or has been revoked."));
    caller = { workspaceId: key.workspaceId, actor: { type: "api_key", id: key.keyId }, role: null, requestId: req.id, ip: clientIp(req) };
  } else {
    const session = await sessionFromRequest(d, req, reply);
    if (!session) return fail(unauthenticated());
    if (session.viaCookie && req.method !== "GET" && req.method !== "HEAD") {
      // Cookies are sent by the browser on its own, so a state-changing request must come from the dashboard.
      const origin = req.headers.origin;
      if (origin !== undefined && !s.cfg.dashboardOrigins.includes(origin)) throw forbidden("This request did not come from the dashboard.");
    }
    const m = await s.db.system(async (c) => (await c.query("select * from public.fenvix_cp_workspace_for_user($1)", [session.claims.userId])).rows[0] as { workspace_id: string; role: "owner" | "admin" | "member" } | undefined);
    if (!m) throw forbidden("Your account is not part of a workspace.");
    caller = { workspaceId: m.workspace_id, actor: { type: "user", id: session.claims.userId }, role: m.role, requestId: req.id, ip: clientIp(req) };
  }

  if (access.role === "admin" && caller.role === "member") throw forbidden("Only a workspace owner or admin can do this.");
  d.limiter.hit(`ws:${caller.workspaceId}`, s.cfg.rateLimitPerMinute);
  req.log = req.log.child({ workspaceId: caller.workspaceId, actor: caller.actor });
  // The built-in "request completed" line is written before this binding exists, so say who it was once.
  req.log.info("request authenticated");
  return caller;
}

const kindStatus = (op: OperationRow) => (op.kind === "create" || op.kind === "fork" ? 201 : 200);

/** Turns an operation into the contract answer: its result, its error, or 202 while it is still going. */
export async function renderOperation(d: Deps, op: OperationRow): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const headers: Record<string, string> = { "Operation-Id": op.id };
  if (op.status === "failed") throw Object.assign(operationError(op), { headers: { ...operationError(op).headers, ...headers } });
  const view = await viewOperation(d.s, op);
  if (op.status === "succeeded") return { status: kindStatus(op), body: view.result, headers };
  return { status: 202, body: { operation: view }, headers: { ...headers, Location: `${d.s.cfg.apiPublicUrl}/operations/${op.id}`, "Retry-After": "2" } };
}

function send(reply: FastifyReply, r: { status: number; body: unknown; headers?: Record<string, string> }) {
  for (const [k, v] of Object.entries(r.headers ?? {})) reply.header(k, v);
  return reply.code(r.status).send(r.body);
}

export interface RouteHelpers {
  read(url: string, access: Access, handler: (ctx: Ctx) => Promise<unknown>): void;
  write(method: "POST" | "PUT" | "DELETE", url: string, opts: Access & { idem?: "standard" | "no-replay" | "skip" }, handler: (ctx: Ctx) => Promise<Outcome>): void;
}

export function routeHelpers(app: FastifyInstance, d: Deps): RouteHelpers {
  const mk = (req: FastifyRequest, reply: FastifyReply, caller: Caller): Ctx => ({
    caller, req, reply, q: (req.query ?? {}) as Obj, params: (req.params ?? {}) as Obj, body: req.body,
  });

  return {
    read(url, access, handler) {
      app.get(url, async (req, reply) => {
        const caller = await authenticate(d, req, reply, access);
        reply.header("Cache-Control", "no-store");
        return reply.code(200).send(await handler(mk(req, reply, caller)));
      });
    },

    write(method, url, opts, handler) {
      const mode = opts.idem ?? "standard";
      app.route({
        method,
        url,
        handler: async (req, reply) => {
          const caller = await authenticate(d, req, reply, opts);
          const ctx = mk(req, reply, caller);
          reply.header("Cache-Control", "no-store");

          const rawKey = req.headers["idempotency-key"];
          const key = typeof rawKey === "string" && mode !== "skip" ? rawKey : undefined;
          if (key !== undefined && !idem.KEY_RE.test(key)) throw validation("The Idempotency-Key must be 1 to 255 visible characters.", "Idempotency-Key");

          let claimed = false;
          if (key) {
            const path = req.url.split("?")[0]!;
            const begun = await idem.begin(d.s, caller, key, method, path, idem.requestHash(method, path, req.body));
            if (begun.state === "replay") {
              reply.header("Idempotent-Replay", "true");
              if (begun.operationId) {
                const first = await loadOperation(d.s, caller.workspaceId, begun.operationId);
                // A retry that arrives while the first request is still working waits for it too.
                if (first) return send(reply, await renderOperation(d, await d.runner.runAndWait(first, d.s.cfg.operationWaitMs)));
              }
              if (mode === "no-replay") throw new ApiError("conflict", "This request was already completed, and its result cannot be shown a second time.");
              return send(reply, { status: begun.status ?? 200, body: begun.body });
            }
            claimed = true;
          }

          try {
            const out = await handler(ctx);
            if ("submitted" in out) {
              if (key) await idem.finish(d.s, caller, key, { operationId: out.submitted.id });
              const op = await d.runner.runAndWait(out.submitted, d.s.cfg.operationWaitMs);
              const r = await renderOperation(d, op);
              if (out.reveal) {
                r.body = out.reveal(op, r.body);
                reply.header("Pragma", "no-cache");
              }
              return send(reply, r);
            }
            if (key) await idem.finish(d.s, caller, key, mode === "no-replay" ? { status: out.status } : { status: out.status, body: out.body });
            return send(reply, out);
          } catch (e) {
            if (claimed && key) {
              // Keep the answer to a request that was understood and refused; free the key when
              // the request was malformed or something broke, so the retry can go through.
              if (e instanceof ApiError && [403, 404, 409].includes(e.status)) await idem.finish(d.s, caller, key, { status: e.status, body: e.body() });
              else await idem.abandon(d.s, caller, key);
            }
            throw e;
          }
        },
      });
    },
  };
}
