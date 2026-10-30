import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Caller } from "../../context.ts";
import { ApiError, forbidden, validation } from "../../errors.ts";
import { type Deps, READ_ONLY } from "../../http.ts";
import * as idem from "../../idempotency.ts";
import { type OperationRow, loadOperation, operationError, viewOperation } from "../../services/operations.ts";
import { type PublicCaller, authenticatePublic } from "../../auth/apikeys.ts";
import { auditDenied } from "../../services/apikeys.ts";
import type { Obj } from "../../validate.ts";

/**
 * The plumbing around every public API route (docs/public-api.md): authentication (auth/apikeys.ts), the role check,
 * Idempotency-Key (the same idempotency.ts records and rules as the dashboard routes), and the answer for long
 * operations. The business rules stay in the services the dashboard routes use.
 */

export interface PublicCtx extends PublicCaller {
  req: FastifyRequest;
  reply: FastifyReply;
  q: Obj;
  params: Obj;
  body: unknown;
}

export type PublicOutcome =
  | { status: number; body: unknown }
  /** A long operation was submitted; `present` turns it into the answer once it has succeeded. */
  | { submitted: OperationRow };

export interface RouteOpts {
  /** "admin": owner or admin, or an admin key. "any": every member and every key. Changes default to "admin". */
  role?: "any" | "admin";
  /** Whether a dashboard session may call it too (key management only). */
  session?: boolean;
  /** Idempotency-Key handling for changes: "standard" replays the first answer, "no-replay" answers 409 (secrets). */
  idem?: "standard" | "no-replay";
  /** The query parameters the route reads; any other one is a 400. */
  query?: string[];
  /**
   * Called when the change was made but its answer cannot be given (recording the Idempotency-Key failed): undoes what
   * only this answer would have revealed (a new key, a new password), so nothing is left that nobody can use.
   */
  undo?: (ctx: PublicCtx, body: unknown) => Promise<void>;
}

/** What each public route was registered with, as "METHOD /v1/public/path" (tests compare it with the OpenAPI document). */
export interface RouteMeta { role: "any" | "admin"; session: boolean; query: string[]; idem: boolean }
export const PUBLIC_ROUTE_META = new Map<string, RouteMeta>();

/**
 * The body of a finished operation. `first` is true only for the answer to the request that submitted it (where a
 * one-time secret such as an initial password may be shown), false for replays and polls.
 */
export type Presenter = (op: OperationRow, caller: Caller, first: boolean) => Promise<unknown>;

const kindStatus = (op: OperationRow) => (op.kind === "create" || op.kind === "fork" ? 201 : 200);

export async function publicOperationView(d: Deps, op: OperationRow) {
  const v = await viewOperation(d.s, op);
  return { id: v.id, kind: v.kind, status: v.status, databaseId: v.databaseId, createdAt: v.createdAt, updatedAt: v.updatedAt, finishedAt: v.finishedAt, error: v.error };
}

export function publicHelpers(app: FastifyInstance, d: Deps, present: Presenter) {
  const { s } = d;

  async function auth(req: FastifyRequest, reply: FastifyReply, opts: RouteOpts, changing: boolean): Promise<PublicCtx> {
    const who = await authenticatePublic(d, req, reply, { session: opts.session ?? false });
    const role = opts.role ?? (changing ? "admin" : "any");
    if (role === "admin" && who.caller.role === "member") {
      // A read-only key (or a member) trying to change something: refused before anything is read, and recorded.
      if (who.key) await auditDenied(s, who.caller, who.key.id, { method: req.method, route: req.routeOptions.url ?? "" });
      throw forbidden(who.key ? "This API key is read only. Use a key with the admin role." : READ_ONLY);
    }
    reply.header("Cache-Control", "no-store");
    const q = (req.query ?? {}) as Obj;
    const unknown = Object.keys(q).find((k) => !(opts.query ?? []).includes(k));
    if (unknown !== undefined) {
      const allowed = opts.query?.length ? `Use only ${opts.query.join(" and ")}.` : "This route takes none.";
      throw validation(`Unknown query parameter. ${allowed}`, unknown.length <= 40 && /^[A-Za-z0-9_]+$/.test(unknown) ? unknown : undefined);
    }
    return { ...who, req, reply, q, params: (req.params ?? {}) as Obj, body: req.body };
  }

  /** A finished operation as the route's answer; still running: 202 with the operation and where to poll it. */
  async function render(op: OperationRow, caller: Caller, first: boolean): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
    const headers: Record<string, string> = { "Operation-Id": op.id };
    if (op.status === "failed") {
      const e = operationError(op);
      throw Object.assign(e, { headers: { ...e.headers, ...headers } });
    }
    if (op.status === "succeeded") return { status: kindStatus(op), body: await present(op, caller, first), headers };
    return {
      status: 202,
      body: { operation: await publicOperationView(d, op) },
      headers: { ...headers, Location: `${s.cfg.apiPublicUrl}/public/operations/${op.id}`, "Retry-After": "2" },
    };
  }

  function send(reply: FastifyReply, r: { status: number; body: unknown; headers?: Record<string, string> }) {
    for (const [k, v] of Object.entries(r.headers ?? {})) reply.header(k, v);
    return reply.code(r.status).send(r.body);
  }

  return {
    render,

    read(url: string, opts: RouteOpts, handler: (ctx: PublicCtx) => Promise<unknown>): void {
      PUBLIC_ROUTE_META.set(`GET ${app.prefix}${url}`, { role: opts.role ?? "any", session: opts.session ?? false, query: opts.query ?? [], idem: false });
      app.get(url, async (req, reply) => {
        const ctx = await auth(req, reply, opts, false);
        return reply.code(200).send(await handler(ctx));
      });
    },

    write(method: "POST" | "PUT" | "DELETE", url: string, opts: RouteOpts, handler: (ctx: PublicCtx) => Promise<PublicOutcome>): void {
      const mode = opts.idem ?? "standard";
      PUBLIC_ROUTE_META.set(`${method} ${app.prefix}${url}`, { role: opts.role ?? "admin", session: opts.session ?? false, query: opts.query ?? [], idem: true });
      app.route({
        method, url,
        handler: async (req, reply) => {
          const ctx = await auth(req, reply, opts, true);
          const { caller } = ctx;
          const rawKey = req.headers["idempotency-key"];
          const key = typeof rawKey === "string" ? rawKey : undefined;
          if (key !== undefined && !idem.KEY_RE.test(key)) throw validation("The Idempotency-Key must be 1 to 255 visible characters.", "Idempotency-Key");

          if (key) {
            const path = req.url.split("?")[0]!;
            const begun = await idem.begin(s, caller, key, method, path, idem.requestHash(method, path, req.body));
            if (begun.state === "replay") {
              reply.header("Idempotent-Replay", "true");
              if (begun.operationId) {
                const first = await loadOperation(s, caller.workspaceId, begun.operationId);
                if (first) return send(reply, await render(await d.runner.runAndWait(first, s.cfg.operationWaitMs), caller, false));
              }
              if (mode === "no-replay" && begun.status !== null && begun.status < 300) {
                throw new ApiError("conflict", "This request was already completed, and its result cannot be shown a second time.");
              }
              return send(reply, { status: begun.status ?? 200, body: begun.body });
            }
          }

          try {
            const out = await handler(ctx);
            if ("submitted" in out) {
              if (key) await idem.finish(s, caller, key, { operationId: out.submitted.id });
              const op = await d.runner.runAndWait(out.submitted, s.cfg.operationWaitMs);
              const r = await render(op, caller, true);
              reply.header("Pragma", "no-cache");
              return send(reply, r);
            }
            if (key) {
              try {
                await idem.finish(s, caller, key, mode === "no-replay" ? { status: out.status } : { status: out.status, body: out.body });
              } catch (e) {
                // The change is made but this answer will not be sent: take back what only it would have shown.
                if (opts.undo) await opts.undo(ctx, out.body).catch((u) => req.log.error({ err: u instanceof Error ? u.message : String(u) }, "could not undo a change whose answer was not sent"));
                throw e;
              }
            }
            if (mode === "no-replay") reply.header("Pragma", "no-cache");
            return send(reply, out);
          } catch (e) {
            if (key) {
              // As on the dashboard routes: keep refusals (403, 404, 409), free the key for anything worth retrying.
              if (e instanceof ApiError && [403, 404, 409].includes(e.status)) await idem.finish(s, caller, key, { status: e.status, body: e.body() });
              else await idem.abandon(s, caller, key);
            }
            throw e;
          }
        },
      });
    },
  };
}
