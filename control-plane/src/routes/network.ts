import type { FastifyInstance } from "fastify";
import { type Ctx, type Deps, routeHelpers } from "../http.ts";
import * as net from "../services/network.ts";

/**
 * A database's IP allowlist and the network blocks of the engine (docs/network-allowlist.md).
 *
 * Reading the list: every member and API key of the workspace. Changing it, reading the blocks and unblocking: owner and
 * admin (a member gets 403 READ_ONLY from http.ts before anything is read), and API keys, like the other changes to a
 * database. Authentication, the workspace rate limit, the origin check and Idempotency-Key are the same as everywhere.
 */
export function networkRoutes(app: FastifyInstance, d: Deps): void {
  const { read, write } = routeHelpers(app, d);
  const ctx = (c: Ctx): net.NetCtx => ({ s: d.s, caller: c.caller, log: c.req.log });

  read("/databases/:id/ip-allowlist", {}, async (c) => net.getAllowlist(ctx(c), c.params.id));

  write("PUT", "/databases/:id/ip-allowlist", {}, async (c) => ({ status: 200, body: await net.setAllowlist(ctx(c), c.params.id, c.body) }));

  write("POST", "/databases/:id/ip-allowlist/reapply", {}, async (c) => ({ status: 200, body: await net.reapplyAllowlist(ctx(c), c.params.id) }));

  read("/databases/:id/network/blocks", { role: "admin" }, async (c) => net.listBlocks(ctx(c), c.params.id));

  write("POST", "/databases/:id/network/unblock", {}, async (c) => ({ status: 200, body: await net.unblock(ctx(c), c.params.id, c.body) }));
}
