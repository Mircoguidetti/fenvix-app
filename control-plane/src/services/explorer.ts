import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { BSONRegExp, type Document, EJSON } from "bson";
import type { Caller, Services } from "../context.ts";
import { type ApiError, conflict, forbidden, notFound, unavailable, validation } from "../errors.ts";
import { DataError, type DataTarget, dataTarget } from "../engine/data.ts";
import { isUuid } from "../validate.ts";
import { idText, isAllowedCollection, parseDocument, parseFilter, parseProjection, parseSort, toCanonical } from "../explorer/rules.ts";

/**
 * The Data Explorer: a customer browses and edits the documents of one of their databases from the dashboard.
 *
 * The order of every request is fixed: who is calling (http.ts) -> may they (read: anyone in the workspace; write:
 * see `requireWrite`) -> are the inputs allowed (explorer/rules.ts) -> is the database theirs (`resolveTarget`, the
 * only place a `DataTarget` is made) -> the engine. A database of another workspace and a database that does not
 * exist give the same 404, from the same query.
 *
 * What is logged: workspace, actor (bound by http.ts), database id, operation, outcome, duration, number of
 * documents. Never a document, a filter, a value, an `_id`, a collection name or an engine message.
 */

export type DataOp = "collections" | "find" | "get" | "insert" | "replace" | "delete";

const NOT_FOUND = "That database does not exist.";
const DOC_NOT_FOUND = "That document does not exist.";
/** Collections listed per database, and how many of them get an estimated count. */
const MAX_COLLECTIONS = 500;
const MAX_COUNTED = 100;
/** A document bigger than this (canonical Extended JSON) is not sent in a list; it can be opened on its own. */
const MAX_LISTED_DOC_CHARS = 1024 * 1024;

export interface ExplorerCtx { s: Services; caller: Caller; log: FastifyBaseLogger }

/** The version of a document as last read: a hash of its canonical Extended JSON. Compared before a save or delete. */
export function versionOf(doc: Document): string {
  return createHash("sha256").update(JSON.stringify(EJSON.serialize(doc, { relaxed: false }))).digest("hex").slice(0, 32);
}

/** The database row of the caller's workspace, or the same 404 for "another workspace's" and "does not exist". */
export async function resolveTarget(s: Services, caller: Caller, id: unknown): Promise<DataTarget> {
  if (!isUuid(id)) throw notFound(NOT_FOUND);
  const row = await s.db.tx(caller.workspaceId, async (c) =>
    (await c.query(
      "select id, region, engine_state from public.databases where workspace_id = $1 and id = $2 and engine_state <> 'provisioning'",
      [caller.workspaceId, id.toLowerCase()],
    )).rows[0] as { id: string; region: string; engine_state: string } | undefined);
  if (!row) throw notFound(NOT_FOUND);
  if (row.engine_state === "restoring") throw conflict("This database is being restored. Open its data again when the restore has finished.");
  if (row.engine_state === "erasing") throw conflict("This database is being erased.");
  return dataTarget({ id: String(row.id), region: String(row.region) });
}

/**
 * Inserting, saving and deleting documents. People: owner, admin and member (the roles that can already create, fork
 * and restore, which also change data). API keys: only keys whose `data_access` is `read_write` (migration 0004; keys
 * are `read` unless made otherwise). Refusals are audited.
 */
export async function requireWrite(x: ExplorerCtx, databaseId: unknown, op: DataOp): Promise<void> {
  const { s, caller } = x;
  let ok: boolean;
  if (caller.actor.type === "user") {
    ok = caller.role === "owner" || caller.role === "admin" || caller.role === "member";
  } else {
    const r = await s.db.tx(caller.workspaceId, async (c) =>
      (await c.query("select data_access from public.api_keys where workspace_id = $1 and id = $2 and revoked_at is null", [caller.workspaceId, caller.actor.id])).rows[0] as { data_access: string } | undefined);
    ok = r?.data_access === "read_write";
  }
  if (!ok) {
    await audit(x, { databaseId: isUuid(databaseId) ? databaseId.toLowerCase() : null, collection: null, operation: op, documentId: null, outcome: "denied" });
    throw forbidden(caller.actor.type === "api_key"
      ? "This API key can only read data. Create a key with data access readWrite to change documents."
      : "Your role cannot change documents in this workspace.");
  }
}

interface AuditRow { databaseId: string | null; collection: string | null; operation: DataOp; documentId: string | null; outcome: "attempted" | "ok" | "failed" | "conflict" | "denied" }

/** One row in public.data_audit_log. Never the document, never a value other than the `_id`. */
async function audit(x: ExplorerCtx, a: AuditRow): Promise<void> {
  const { s, caller } = x;
  await s.db.tx(caller.workspaceId, (c) => c.query(
    `insert into public.data_audit_log (workspace_id, actor_type, actor_id, database_id, collection, operation, document_id, outcome, request_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [caller.workspaceId, caller.actor.type, caller.actor.id, a.databaseId, a.collection, a.operation, a.documentId?.slice(0, 1024) ?? null, a.outcome, caller.requestId],
  ));
}

/** Engine failures as clean API errors: never the engine's text, address or code names. */
function toApiError(e: DataError): ApiError {
  switch (e.kind) {
    case "duplicate": return conflict("A document with this _id already exists in this collection.", "document");
    case "refused": return validation("The database refused this request. Check the filter and the document.");
    case "timeout": return unavailable("The database took too long to answer. If it was asleep it is waking up: try again in a few seconds. Otherwise narrow the filter.");
    default: return unavailable("The database is not answering yet. If it was asleep it is waking up: try again in a few seconds.");
  }
}

/** The client's own deadline: the engine's maxTimeMS plus this, whatever the client implementation does. */
const DEADLINE_GRACE_MS = 2000;

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DataError("timeout", "deadline")), ms); });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** Runs one engine call with the log line every Data Explorer request writes, a deadline, and clean errors. */
async function engineCall<T>(x: ExplorerCtx, t: DataTarget, op: DataOp, work: () => Promise<T>, count: (r: T) => number): Promise<T> {
  const started = Date.now();
  try {
    const r = await withDeadline(work(), x.s.cfg.data.commandTimeoutMs + DEADLINE_GRACE_MS);
    x.log.info({ dataExplorer: { databaseId: t.id, op, outcome: "ok", durationMs: Date.now() - started, documents: count(r) } }, "data explorer");
    return r;
  } catch (e) {
    const kind = e instanceof DataError ? e.kind : "unknown";
    x.log.warn({ dataExplorer: { databaseId: t.id, op, outcome: "failed", kind, code: e instanceof DataError && typeof e.code === "number" ? e.code : undefined, durationMs: Date.now() - started } }, "data explorer");
    if (e instanceof DataError) throw toApiError(e);
    throw unavailable("The database is not answering yet. Try again in a few seconds.");
  }
}

const opts = (x: ExplorerCtx) => ({ maxTimeMS: x.s.cfg.data.commandTimeoutMs });

/** Whether a (validated) filter matches with a regular expression anywhere: `$regex`, or a BSON regex value. */
export function hasRegex(v: unknown, depth = 0): boolean {
  if (depth > 16 || v === null || typeof v !== "object") return false;
  if (v instanceof BSONRegExp || v instanceof RegExp) return true;
  if (Array.isArray(v)) return v.some((x) => hasRegex(x, depth + 1));
  return Object.entries(v as Record<string, unknown>).some(([k, x]) => k === "$regex" || hasRegex(x, depth + 1));
}

function item(doc: Document, partial: boolean) {
  // A view can return documents without an _id: shown, but they cannot be opened, saved or deleted from here.
  if (doc._id === undefined) return { id: "", version: null, partial: true, document: toCanonical(doc) as Document };
  const document = toCanonical(doc) as Document;
  const text = JSON.stringify(document);
  if (text.length > MAX_LISTED_DOC_CHARS) return { id: idText(doc._id), version: null, partial: true, tooLarge: true, sizeBytes: text.length };
  return { id: idText(doc._id), version: partial ? null : versionOf(doc), partial, document };
}

// ---------------------------------------------------------------- reading

export async function listCollections(x: ExplorerCtx, databaseId: unknown) {
  const t = await resolveTarget(x.s, x.caller, databaseId);
  const all = await engineCall(x, t, "collections", () => x.s.data.listCollections(t, { ...opts(x), limit: MAX_COLLECTIONS + 50 }), (r) => r.length);
  const names = all.filter((c) => !/^system\./i.test(c.name)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_COLLECTIONS);
  // Estimates come from collection metadata; a slow or failed one is shown as unknown, never as a full count.
  const counts = new Map<string, number | null>();
  let next = 0;
  const counted = names.filter((c) => isAllowedCollection(c.name) && c.type === "collection").slice(0, MAX_COUNTED);
  await Promise.all(Array.from({ length: Math.min(4, counted.length) }, async () => {
    for (;;) {
      const c = counted[next++];
      if (!c) return;
      counts.set(c.name, await withDeadline(x.s.data.estimatedCount(t, c.name, opts(x)), x.s.cfg.data.commandTimeoutMs + DEADLINE_GRACE_MS).catch(() => null));
    }
  }));
  return {
    items: names.map((c) => ({
      name: c.name,
      type: c.type === "view" ? "view" : "collection",
      // Names outside the allowlist are listed (they exist) but cannot be opened from here.
      browsable: isAllowedCollection(c.name),
      estimatedCount: counts.get(c.name) ?? null,
    })),
    truncated: all.length > MAX_COLLECTIONS,
  };
}

export async function findDocuments(x: ExplorerCtx, databaseId: unknown, collection: string, q: Record<string, unknown>) {
  const cfg = x.s.cfg.data;
  const filter = parseFilter(q.filter);
  const sort = parseSort(q.sort);
  const projection = parseProjection(q.projection);
  const pageSize = pageParam(q.pageSize, "pageSize", cfg.defaultPageSize, cfg.maxPageSize);
  const page = pageParam(q.page, "page", 1, Number.MAX_SAFE_INTEGER);
  const skip = (page - 1) * pageSize;
  if (skip > cfg.maxSkip) throw validation(`Pages go up to ${cfg.maxSkip} documents deep. Narrow the filter or change the sort instead.`, "page");
  const t = await resolveTarget(x.s, x.caller, databaseId);
  // A pattern can cost the engine CPU until it stops, so a filter with one gets the shorter regex time limit.
  const maxTimeMS = hasRegex(filter) ? cfg.regexTimeoutMs : cfg.commandTimeoutMs;
  const r = await engineCall(x, t, "find", () => x.s.data.find(t, collection, {
    maxTimeMS, filter, sort, projection, skip, limit: pageSize + 1, maxBytes: cfg.maxResponseBytes,
  }), (r) => r.docs.length);
  const hasMore = r.docs.length > pageSize || r.stoppedEarly;
  const docs = r.docs.slice(0, pageSize);
  return { items: docs.map((d) => item(d, projection !== undefined)), page, pageSize, hasMore, truncated: r.stoppedEarly };
}

function pageParam(v: unknown, field: string, fallback: number, max: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) throw validation(`${field} must be a whole number from 1 to ${max}.`, field);
  return n;
}

export async function getDocument(x: ExplorerCtx, databaseId: unknown, collection: string, id: unknown) {
  const t = await resolveTarget(x.s, x.caller, databaseId);
  const doc = await engineCall(x, t, "get", () => x.s.data.findOne(t, collection, { _id: id }, opts(x)), (r) => (r ? 1 : 0));
  if (!doc) throw notFound(DOC_NOT_FOUND);
  const text = JSON.stringify(toCanonical(doc));
  if (text.length > x.s.cfg.data.maxResponseBytes) throw validation("This document is too large to show in the dashboard.");
  return { id: idText(doc._id), version: versionOf(doc), partial: false, document: toCanonical(doc) };
}

// ---------------------------------------------------------------- changing

export async function insertDocument(x: ExplorerCtx, databaseId: unknown, collection: string, body: unknown) {
  await requireWrite(x, databaseId, "insert");
  const raw = (body as { document?: unknown } | null)?.document;
  const { doc } = parseDocument(raw, x.s.cfg.data.maxDocumentBytes);
  const t = await resolveTarget(x.s, x.caller, databaseId);
  const documentId = idText(doc._id);
  await audit(x, { databaseId: t.id, collection, operation: "insert", documentId, outcome: "attempted" });
  try {
    await engineCall(x, t, "insert", () => x.s.data.insertOne(t, collection, doc, opts(x)), () => 1);
  } catch (e) {
    await audit(x, { databaseId: t.id, collection, operation: "insert", documentId, outcome: (e as ApiError).status === 409 ? "conflict" : "failed" });
    throw e;
  }
  await audit(x, { databaseId: t.id, collection, operation: "insert", documentId, outcome: "ok" });
  return { id: documentId, version: versionOf(doc) };
}

/**
 * The filter that makes a save or delete apply only to the document as it was read: its `_id` and every top-level
 * field with `$eq`. If someone changed any of those fields in between, nothing matches and the caller gets 409.
 * (A field ADDED in between is not caught by the filter; the version check just before narrows that window.)
 */
function unchangedFilter(current: Document): Document {
  const f: Document = { _id: current._id };
  for (const [k, v] of Object.entries(current)) {
    if (k === "_id") continue;
    if (k.startsWith("$") || k.includes(".") || k.includes("\0")) return { _id: current._id };
    f[k] = { $eq: v };
  }
  return f;
}

async function readForChange(x: ExplorerCtx, t: DataTarget, collection: string, id: unknown, version: unknown): Promise<Document> {
  if (typeof version !== "string" || !/^[0-9a-f]{32}$/.test(version)) throw validation("Send the version of the document you last read.", "version");
  const current = await engineCall(x, t, "get", () => x.s.data.findOne(t, collection, { _id: id }, opts(x)), (r) => (r ? 1 : 0));
  if (!current) throw notFound(DOC_NOT_FOUND);
  if (versionOf(current) !== version) throw conflict("Someone changed this document after you opened it. Reload it and make your change again.", "version");
  return current;
}

export async function replaceDocument(x: ExplorerCtx, databaseId: unknown, collection: string, id: unknown, body: unknown) {
  await requireWrite(x, databaseId, "replace");
  const b = (body ?? {}) as { document?: unknown; version?: unknown };
  const { doc } = parseDocument(b.document, x.s.cfg.data.maxDocumentBytes);
  // A saved document without an _id keeps the one in the URL.
  if (typeof b.document === "object" && b.document !== null && !Object.hasOwn(b.document, "_id")) doc._id = id;
  if (idText(doc._id) !== idText(id)) throw validation("The _id of a document cannot be changed. Insert a new document instead.", "document");
  if (typeof b.version !== "string" || !/^[0-9a-f]{32}$/.test(b.version)) throw validation("Send the version of the document you last read.", "version");
  const t = await resolveTarget(x.s, x.caller, databaseId);
  const documentId = idText(id);
  const current = await readForChange(x, t, collection, id, b.version);
  await audit(x, { databaseId: t.id, collection, operation: "replace", documentId, outcome: "attempted" });
  let matched: number;
  try {
    ({ matched } = await engineCall(x, t, "replace", () => x.s.data.replaceOne(t, collection, unchangedFilter(current), doc, opts(x)), (r) => r.matched));
  } catch (e) {
    await audit(x, { databaseId: t.id, collection, operation: "replace", documentId, outcome: "failed" });
    throw e;
  }
  if (matched === 0) {
    await audit(x, { databaseId: t.id, collection, operation: "replace", documentId, outcome: "conflict" });
    throw conflict("Someone changed this document after you opened it. Reload it and make your change again.", "version");
  }
  await audit(x, { databaseId: t.id, collection, operation: "replace", documentId, outcome: "ok" });
  return { id: documentId, version: versionOf(doc) };
}

export async function deleteDocument(x: ExplorerCtx, databaseId: unknown, collection: string, id: unknown, version: unknown) {
  await requireWrite(x, databaseId, "delete");
  if (typeof version !== "string" || !/^[0-9a-f]{32}$/.test(version)) throw validation("Send the version of the document you last read.", "version");
  const t = await resolveTarget(x.s, x.caller, databaseId);
  const documentId = idText(id);
  const current = await readForChange(x, t, collection, id, version);
  await audit(x, { databaseId: t.id, collection, operation: "delete", documentId, outcome: "attempted" });
  let deleted: number;
  try {
    ({ deleted } = await engineCall(x, t, "delete", () => x.s.data.deleteOne(t, collection, unchangedFilter(current), opts(x)), (r) => r.deleted));
  } catch (e) {
    await audit(x, { databaseId: t.id, collection, operation: "delete", documentId, outcome: "failed" });
    throw e;
  }
  if (deleted === 0) {
    await audit(x, { databaseId: t.id, collection, operation: "delete", documentId, outcome: "conflict" });
    throw conflict("Someone changed this document after you opened it. Reload it and try again.", "version");
  }
  await audit(x, { databaseId: t.id, collection, operation: "delete", documentId, outcome: "ok" });
  return { deleted: true };
}
