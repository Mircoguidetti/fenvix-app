import type { FastifyInstance } from "fastify";
import type { Deps } from "../../http.ts";
import { conflict, notFound, validation } from "../../errors.ts";
import { asObject, isUuid, parseName, parseTags } from "../../validate.ts";
import * as ops from "../../services/operations.ts";
import * as du from "../../services/db-users.ts";
import * as net from "../../services/network.ts";
import * as orgs from "../../services/orgs.ts";
import * as keys from "../../services/apikeys.ts";
import * as pdb from "../../services/public-api.ts";
import { type PublicCtx, type Presenter, publicHelpers, publicOperationView } from "./http.ts";

/**
 * The public API, under /v1/public (docs/public-api.md; the OpenAPI document is GET /v1/openapi.json, openapi.ts).
 *
 * Every route is a thin layer over the services the dashboard routes use: the same validation, the same engine calls,
 * the same audit rows. What is different is the way in (public API keys, auth/apikeys.ts), cursor pages, and the shape
 * of a few answers. A key never names its organization: it is the key's, so another organization's ids are a 404.
 */
export const PUBLIC_PREFIX = "/v1/public";

export function publicRoutes(app: FastifyInstance, d: Deps): void {
  const { s } = d;
  const L = s.cfg.limits;

  /** The answer for a finished create (the database as it is now, with its initial user) or delete. */
  const present: Presenter = async (op, caller, first) => {
    if (op.kind === "create") {
      const result = (op.result ?? {}) as Record<string, unknown> & { initialUser?: { username: string; role: string } | null };
      const now = await pdb.findDatabase(s, caller, op.database_id);
      const body = { ...result, ...(now ?? {}), initialUser: result.initialUser ?? null };
      if (!body.initialUser) return body;
      // The initial password is in the answer to the request that created the database, once (operations.ts).
      return first ? ops.revealInitialPassword(s, caller, op, body) : { ...body, initialUser: { ...body.initialUser, password: null, connectionString: null } };
    }
    if (op.kind === "erase") return { id: ((op.params.ids as string[] | undefined) ?? [])[0] ?? null, deleted: true };
    return (await publicOperationView(d, op));
  };

  const { read, write } = publicHelpers(app, d, present);

  // Refusals held back by the audit throttle are written as a summary row once a key goes quiet (services/apikeys.ts).
  const flush = setInterval(() => {
    keys.auditThrottle(s).flushDue().catch((e) => s.log.error({ err: e instanceof Error ? e.message : String(e) }, "audit summary flush failed"));
  }, 15_000);
  flush.unref();
  app.addHook("onClose", async () => {
    clearInterval(flush);
    await keys.auditThrottle(s).flushDue(true).catch(() => 0);
  });

  /** A database id from a path: anything that is not one is a database that does not exist. */
  const dbId = (c: PublicCtx) => {
    if (!isUuid(c.params.id)) throw notFound("That database does not exist.");
    return String(c.params.id).toLowerCase();
  };
  const usersCtx = (c: PublicCtx, changing: boolean): du.UsersCtx => {
    const x = { s, caller: c.caller, log: c.req.log };
    du.hitLimit(x, d.limiter, changing);
    return x;
  };
  const netCtx = (c: PublicCtx): net.NetCtx => ({ s, caller: c.caller, log: c.req.log });

  // ---------------------------------------------------------------- databases

  const PAGE = ["cursor", "limit"];

  read("/databases", { query: PAGE }, async ({ caller, q }) =>
    pdb.listDatabases(s, caller, { limit: keys.parseLimit(q.limit), cursor: keys.decodeCursor(q.cursor) }));

  // Same rules as the dashboard's create (routes/data.ts): name, region, tags, initial user.
  write("POST", "/databases", {}, async ({ caller, body }) => {
    const b = asObject(body);
    const name = parseName(b.name, L);
    const region = typeof b.region === "string" ? b.region : "";
    if (!s.cfg.regions.includes(region)) throw validation(`Choose a region: ${s.cfg.regions.join(", ")}.`, "region");
    const appUser = b.appUser === undefined || b.appUser === null ? du.DEFAULT_APP_USER : du.parseUsername(b.appUser, s, "appUser");
    return { submitted: await ops.submitCreate(s, caller, { name, region, tags: parseTags(b.tags ?? [], L), appUser }) };
  });

  read("/databases/:id", {}, async (c) => pdb.getDatabase(s, c.caller, dbId(c)));

  // The dashboard's erase, for one database. Unlike the bulk erase, an id that is not there is a 404.
  write("DELETE", "/databases/:id", {}, async (c) => {
    const id = dbId(c);
    const db = await pdb.getDatabase(s, c.caller, id);
    // Already being erased: say so rather than answer for an erase this request did not start.
    if (db.status === "erasing") throw conflict("This database is already being erased.");
    return { submitted: await ops.submitErase(s, c.caller, [id]) };
  });

  // ---------------------------------------------------------------- database users

  read("/databases/:id/users", { query: PAGE }, async (c) => {
    const limit = keys.parseLimit(c.q.limit);
    const after = c.q.cursor === undefined || c.q.cursor === "" ? null : decodeUserCursor(c.q.cursor);
    const all = (await du.listUsers(usersCtx(c, false), dbId(c))).items.sort((a, b) => (a.username < b.username ? -1 : 1));
    const rest = after === null ? all : all.filter((u) => u.username > after);
    const page = rest.slice(0, limit);
    return { items: page, nextCursor: rest.length > limit ? Buffer.from(page[page.length - 1]!.username).toString("base64url") : null };
  });

  // The password is in this answer only: a repeat with the same Idempotency-Key is a 409 (as on the dashboard).
  // If the answer cannot be sent, the user is dropped again: nobody would have its password.
  const dropUndelivered = async (c: PublicCtx, body: unknown) => {
    const username = (body as { user?: { username?: string } } | null)?.user?.username;
    if (username) await du.deleteUser({ s, caller: c.caller, log: c.req.log }, dbId(c), username);
  };
  write("POST", "/databases/:id/users", { idem: "no-replay", undo: dropUndelivered }, async (c) =>
    ({ status: 201, body: await du.createUser(usersCtx(c, true), dbId(c), c.body) }));

  write("DELETE", "/databases/:id/users/:username", {}, async (c) =>
    ({ status: 200, body: await du.deleteUser(usersCtx(c, true), dbId(c), c.params.username) }));

  // ---------------------------------------------------------------- network allowlist

  read("/databases/:id/ip-allowlist", {}, async (c) => net.getAllowlist(netCtx(c), dbId(c)));

  write("PUT", "/databases/:id/ip-allowlist", {}, async (c) =>
    ({ status: 200, body: await net.setAllowlist(netCtx(c), dbId(c), c.body) }));

  // ---------------------------------------------------------------- organization

  read("/organization", {}, async ({ caller, key }) => {
    const o = await orgs.getOrganization(s, caller);
    return { id: o.id, name: o.name, members: o.members, apiKey: key ? { id: key.id, role: key.role } : null };
  });

  // ---------------------------------------------------------------- operations (where a 202 says to poll)

  read("/operations/:id", {}, async ({ caller, params }) => {
    const op = await ops.loadOperation(s, caller.workspaceId, String(params.id));
    if (!op) throw notFound("That operation does not exist.");
    return { ...(await publicOperationView(d, op)), result: op.status === "succeeded" ? await present(op, caller, false) : null };
  });

  // ---------------------------------------------------------------- API keys (owner or admin, or an admin key)

  read("/api-keys", { role: "admin", session: true, query: PAGE }, async ({ caller, q }) =>
    keys.listKeys(s, caller, { limit: keys.parseLimit(q.limit), cursor: keys.decodeCursor(q.cursor) }));

  // The key is in this answer only: a repeat with the same Idempotency-Key is a 409, never a second key. If the answer
  // cannot be sent, the key is revoked at once: nobody would have its token.
  const revokeUndelivered = async (c: PublicCtx, body: unknown) => {
    const id = (body as { key?: { id?: string } } | null)?.key?.id;
    if (id) await keys.revokeUndelivered(s, c.caller, id);
  };
  write("POST", "/api-keys", { role: "admin", session: true, idem: "no-replay", undo: revokeUndelivered }, async ({ caller, body }) =>
    ({ status: 201, body: await keys.createKey(s, caller, body) }));

  write("DELETE", "/api-keys/:id", { role: "admin", session: true }, async ({ caller, params }) =>
    ({ status: 200, body: await keys.revokeKey(s, caller, params.id) }));
}

function decodeUserCursor(v: unknown): string {
  const name = typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? Buffer.from(v, "base64url").toString("utf8") : "";
  if (!du.USERNAME_RE.test(name)) throw validation("This cursor is not valid. Use the nextCursor of the previous page.", "cursor");
  return name;
}
