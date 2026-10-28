import type { FastifyInstance } from "fastify";
import { type Ctx, type Deps, routeHelpers } from "../http.ts";
import { unavailable } from "../errors.ts";
import { parseCollection, parseDocumentId } from "../explorer/rules.ts";
import * as ex from "../services/explorer.ts";

/**
 * The Data Explorer's routes, under /v1/databases/:id/data/. Registered in their own plugin so the headers below
 * apply to them, answers and errors alike, and to nothing else. Authentication, the workspace rate limit, the
 * origin check for cookie sessions and Idempotency-Key are the same as for every route (http.ts).
 */
const BASE = "/databases/:id/data/collections";

export function explorerRoutes(app: FastifyInstance, d: Deps): void {
  const { s } = d;
  const { read, write } = routeHelpers(app, d);

  app.addHook("onSend", async (_req, reply) => {
    // Customer data: never cached, never framed, never sniffed, no referrer.
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    reply.header("Referrer-Policy", "no-referrer");
  });

  /** Per person and per key, on top of the workspace's limit; writes have a lower one. */
  const ctx = (c: Ctx, writing: boolean): ex.ExplorerCtx => {
    const who = `${c.caller.actor.type}:${c.caller.actor.id}`;
    d.limiter.hit(`data:${who}`, s.cfg.data.ratePerMinute);
    if (writing) d.limiter.hit(`data-write:${who}`, s.cfg.data.writeRatePerMinute);
    if (s.cfg.data.driver === "off") throw unavailable("The data explorer is not set up on this deployment yet.", 60);
    return { s, caller: c.caller, log: c.req.log };
  };
  const collection = (c: Ctx) => parseCollection(c.params.collection);
  const docId = (c: Ctx) => parseDocumentId(c.params.docId);

  read(BASE, {}, async (c) => ex.listCollections(ctx(c, false), c.params.id));

  read(`${BASE}/:collection/documents`, {}, async (c) => ex.findDocuments(ctx(c, false), c.params.id, collection(c), c.q));

  read(`${BASE}/:collection/documents/:docId`, {}, async (c) => ex.getDocument(ctx(c, false), c.params.id, collection(c), docId(c)));

  // "no-replay": a retried insert with the same Idempotency-Key is refused instead of inserting twice, and the
  // idempotency record keeps only the status, never the document.
  write("POST", `${BASE}/:collection/documents`, { idem: "no-replay", role: "any" }, async (c) =>
    ({ status: 201, body: await ex.insertDocument(ctx(c, true), c.params.id, collection(c), c.body) }));

  write("PUT", `${BASE}/:collection/documents/:docId`, { idem: "no-replay", role: "any" }, async (c) =>
    ({ status: 200, body: await ex.replaceDocument(ctx(c, true), c.params.id, collection(c), docId(c), c.body) }));

  write("DELETE", `${BASE}/:collection/documents/:docId`, { idem: "no-replay", role: "any" }, async (c) =>
    ({ status: 200, body: await ex.deleteDocument(ctx(c, true), c.params.id, collection(c), docId(c), c.q.version) }));
}
