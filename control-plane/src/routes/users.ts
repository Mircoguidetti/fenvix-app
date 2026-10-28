import type { FastifyInstance } from "fastify";
import { type Ctx, type Deps, routeHelpers } from "../http.ts";
import * as du from "../services/db-users.ts";

/**
 * A database's own users (docs/database-users.md), under /v1/databases/:id/users. Registered in their own plugin so
 * the headers below apply to these answers (some carry a password) and errors, and to nothing else. Authentication,
 * the workspace rate limit, the origin check for cookie sessions and Idempotency-Key are the same as for every route.
 *
 * Changes use idempotency "no-replay": a request repeated with the same Idempotency-Key is answered 409 instead of
 * making a second user or a second password, and the idempotency record keeps only the status, never the password.
 */
const BASE = "/databases/:id/users";

export function usersRoutes(app: FastifyInstance, d: Deps): void {
  const { s } = d;
  const { read, write } = routeHelpers(app, d);

  app.addHook("onSend", async (_req, reply) => {
    // Passwords: never cached by a browser or a proxy, never framed, no referrer.
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    reply.header("Referrer-Policy", "no-referrer");
  });

  const ctx = (c: Ctx, changing: boolean): du.UsersCtx => {
    const x = { s, caller: c.caller, log: c.req.log };
    du.hitLimit(x, d.limiter, changing);
    return x;
  };

  read(BASE, {}, async (c) => du.listUsers(ctx(c, false), c.params.id));

  write("POST", BASE, { idem: "no-replay", role: "any" }, async (c) => {
    const x = ctx(c, true);
    await du.requireManage(x, c.params.id, "create", (c.body as { username?: unknown } | null)?.username);
    return { status: 201, body: await du.createUser(x, c.params.id, c.body) };
  });

  write("POST", `${BASE}/:username/reset-password`, { idem: "no-replay", role: "any" }, async (c) => {
    const x = ctx(c, true);
    await du.requireManage(x, c.params.id, "reset_password", c.params.username);
    return { status: 200, body: await du.resetPassword(x, c.params.id, c.params.username) };
  });

  write("DELETE", `${BASE}/:username`, { idem: "no-replay", role: "any" }, async (c) => {
    const x = ctx(c, true);
    await du.requireManage(x, c.params.id, "delete", c.params.username);
    return { status: 200, body: await du.deleteUser(x, c.params.id, c.params.username) };
  });
}
