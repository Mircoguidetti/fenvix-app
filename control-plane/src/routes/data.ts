import type { FastifyInstance } from "fastify";
import { type Deps, routeHelpers } from "../http.ts";
import { notFound, validation } from "../errors.ts";
import * as db from "../services/databases.ts";
import * as ops from "../services/operations.ts";
import * as usage from "../services/usage.ts";
import * as account from "../services/account.ts";
import {
  asObject, parseBool, parseEnum, parseFilter, parseIds, parseInstant, parseIntParam, parseMonth, parseName, parsePaging, parseRemoveTerms,
  parseTagKey, parseTags, type Obj, isUuid,
} from "../validate.ts";
import { signDownload } from "../downloads.ts";

const SORTS = ["name", "state", "keepAwake", "storageMb", "requests24h", "lastActiveAt"] as const;
const RANGES = ["24h", "7d", "30d"] as const;
const USAGE_SORTS = ["name", "databases", "storageGb", "requests"] as const;

function usageQuery(q: Obj) {
  const by = parseEnum(q.by, ["database", "tag"] as const, "by");
  const tagKey = q.tagKey === undefined || q.tagKey === "" ? undefined : parseTagKey(q.tagKey, "tagKey");
  if (tagKey && by !== "tag") throw validation("tagKey can only be used with by=tag.", "tagKey");
  const sort = parseEnum(q.sort, USAGE_SORTS, "sort", "requests");
  if (sort === "databases" && by !== "tag") throw validation("Sorting by databases only works with by=tag.", "sort");
  return { month: parseMonth(q.month), by, tagKey, sort, dir: parseEnum(q.dir, ["asc", "desc"] as const, "dir", "desc") };
}

export function dataRoutes(app: FastifyInstance, d: Deps): void {
  const { s } = d;
  const { read, write } = routeHelpers(app, d);
  const L = s.cfg.limits;
  const submitted = (op: ops.OperationRow) => ({ submitted: op });

  // ---------------------------------------------------------------- databases (reading)

  read("/databases", {}, async ({ caller, q }) => {
    const { page, pageSize } = parsePaging(q, L);
    return db.listDatabases(s, caller, {
      filter: parseFilter(q), sort: parseEnum(q.sort, SORTS, "sort", "lastActiveAt"), dir: parseEnum(q.dir, ["asc", "desc"] as const, "dir", "desc"), page, pageSize,
    });
  });

  read("/databases/ids", {}, async ({ caller, q }) => ({ ids: await db.listDatabaseIds(s, caller, parseFilter(q)) }));

  read("/databases/groups", {}, async ({ caller, q }) => db.groupDatabases(s, caller, parseTagKey(q.groupBy, "groupBy"), parseFilter(q)));

  read("/tags", {}, async ({ caller }) => db.listTags(s, caller));

  read("/regions", {}, async () => ({ items: s.cfg.regions }));

  read("/databases/:id", {}, async ({ caller, params }) => db.getDatabase(s, caller, String(params.id)));

  read("/databases/:id/usage", {}, async ({ caller, params, q }) =>
    usage.getUsageSeries(s, caller, String(params.id), parseEnum(q.range, RANGES, "range")));

  // ---------------------------------------------------------------- databases (changing)

  write("POST", "/databases", {}, async ({ caller, body }) => {
    const b = asObject(body);
    const name = parseName(b.name, L);
    const region = typeof b.region === "string" ? b.region : "";
    if (!s.cfg.regions.includes(region)) throw validation("Choose a region.", "region");
    return submitted(await ops.submitCreate(s, caller, { name, region, tags: parseTags(b.tags, L) }));
  });

  write("POST", "/databases/:id/fork", {}, async ({ caller, params, body }) => {
    const b = asObject(body);
    const name = parseName(b.name, L);
    if (!isUuid(params.id)) throw notFound("That database does not exist.");
    return submitted(await ops.submitFork(s, caller, String(params.id).toLowerCase(), name));
  });

  write("POST", "/databases/:id/restore", {}, async ({ caller, params, body }) => {
    const at = parseInstant(asObject(body).at, "at");
    if (!isUuid(params.id)) throw notFound("That database does not exist.");
    return submitted(await ops.submitRestore(s, caller, String(params.id).toLowerCase(), at));
  });

  write("POST", "/databases/export", {}, async ({ caller, body }) =>
    submitted(await ops.submitExport(s, caller, parseIds(asObject(body).ids, L.maxIdsExport))));

  write("POST", "/databases/erase", { role: "admin" }, async ({ caller, body }) =>
    submitted(await ops.submitErase(s, caller, parseIds(asObject(body).ids, L.maxIdsBulk))));

  write("POST", "/databases/keep-awake", {}, async ({ caller, body }) => {
    const b = asObject(body);
    const ids = parseIds(b.ids, L.maxIdsBulk);
    const enabled = parseBool(b.enabled, "enabled");
    return { status: 200, body: await db.setKeepAwake(s, caller, ids, enabled) };
  });

  write("PUT", "/databases/:id/tags", {}, async ({ caller, params, body }) => {
    const tags = parseTags(asObject(body).tags ?? [], L);
    if (!isUuid(params.id)) throw notFound("That database does not exist.");
    return { status: 200, body: await db.setTags(s, caller, String(params.id).toLowerCase(), tags) };
  });

  write("POST", "/databases/tags/add", {}, async ({ caller, body }) => {
    const b = asObject(body);
    const ids = parseIds(b.ids, L.maxIdsBulk);
    const tags = parseTags(b.tags, L);
    if (tags.length === 0) throw validation("Choose at least one tag to add.", "tags");
    return { status: 200, body: await db.addTags(s, caller, ids, tags) };
  });

  write("POST", "/databases/tags/remove", {}, async ({ caller, body }) => {
    const b = asObject(body);
    const ids = parseIds(b.ids, L.maxIdsBulk);
    return { status: 200, body: await db.removeTags(s, caller, ids, parseRemoveTerms(b.tags)) };
  });

  // ---------------------------------------------------------------- operations (poll)

  read("/operations", {}, async ({ caller, q }) => {
    const { page, pageSize } = parsePaging(q, L);
    const status = q.status === undefined || q.status === "" ? undefined : parseEnum(q.status, ["queued", "running", "succeeded", "failed"] as const, "status");
    const { rows, total } = await ops.listOperations(s, caller.workspaceId, page, pageSize, status);
    return { items: await Promise.all(rows.map((r) => ops.viewOperation(s, r))), total, page, pageSize };
  });

  read("/operations/:id", {}, async ({ caller, params }) => {
    const op = await ops.loadOperation(s, caller.workspaceId, String(params.id));
    if (!op) throw notFound("That operation does not exist.");
    return ops.viewOperation(s, op);
  });

  // ---------------------------------------------------------------- overview and usage

  read("/overview", {}, async ({ caller, q }) => usage.getOverview(s, caller, parseEnum(q.range, RANGES, "range")));

  read("/tags/breakdown", {}, async ({ caller, q }) =>
    usage.getTagBreakdown(s, caller, parseTagKey(q.key, "key"), parseIntParam(q.limit, "limit", 8, 1, 50)));

  read("/usage/months", {}, async ({ caller }) => usage.listUsageMonths(s, caller));

  read("/usage", {}, async ({ caller, q }) => {
    const { page, pageSize } = parsePaging(q, L);
    return usage.getUsageReport(s, caller, usageQuery(q), page, pageSize);
  });

  read("/usage/export", {}, async ({ caller, q }) => {
    const uq = usageQuery(q);
    // Build it once now so a month without a report fails here, not when the link is opened.
    const { filename } = await usage.buildUsageCsv(s, caller.workspaceId, uq);
    const exp = Math.floor(Date.now() / 1000) + L.exportUrlTtlSeconds;
    const token = signDownload(s.cfg.downloadSigningKey, { ws: caller.workspaceId, kind: "usage-csv", p: uq, exp });
    return { filename, mimeType: "text/csv", downloadUrl: account.downloadUrl(s, token) };
  });

  read("/usage/history", {}, async ({ caller }) => usage.getUsageHistory(s, caller));

  read("/usage/trend", {}, async ({ caller, q }) => usage.getUsageTrend(s, caller, parseMonth(q.month), parseTagKey(q.tagKey, "tagKey")));

  // ---------------------------------------------------------------- plans, billing, invoices

  read("/plans", {}, async ({ caller }) => account.listPlans(s, caller));
  read("/billing", {}, async ({ caller }) => account.getBilling(s, caller));

  read("/invoices", {}, async ({ caller, q }) => {
    const { page, pageSize } = parsePaging(q, L, L.invoicePageSize, 100);
    return account.listInvoices(s, caller, page, pageSize);
  });

  write("POST", "/invoices/:id/download", { idem: "skip" }, async ({ caller, params }) => ({ status: 200, body: await account.downloadInvoice(s, caller, String(params.id)) }));

  // ---------------------------------------------------------------- API keys and settings

  read("/api-keys", { apiKey: false, role: "admin" }, async ({ caller }) => account.listApiKeys(s, caller));

  write("POST", "/api-keys", { apiKey: false, role: "admin", idem: "no-replay" }, async ({ caller, body }) => {
    const b = asObject(body);
    const name = b.name;
    if (typeof name !== "string") throw validation(`Use 1 to ${L.maxApiKeyNameLength} characters for the name.`, "name");
    // Data Explorer: what the key may do with documents. Read only unless asked for.
    const dataAccess = b.dataAccess === undefined ? "read" : parseEnum(b.dataAccess, ["read", "readWrite"] as const, "dataAccess");
    return { status: 201, body: await account.createApiKey(s, caller, name, dataAccess) };
  });

  write("POST", "/api-keys/:id/revoke", { apiKey: false, role: "admin" }, async ({ caller, params }) => ({ status: 200, body: await account.revokeApiKey(s, caller, String(params.id)) }));

  read("/settings", {}, async ({ caller }) => account.getSettings(s, caller));

  write("PUT", "/settings", { apiKey: false, role: "admin" }, async ({ caller, body }) => {
    const b = asObject(body);
    const name = typeof b.workspaceName === "string" ? b.workspaceName.trim() : "";
    if (name.length < 1 || name.length > L.maxWorkspaceNameLength) throw validation(`Enter a workspace name of ${L.maxWorkspaceNameLength} characters or fewer.`, "workspaceName");
    const idle = b.idleMinutes;
    if (typeof idle !== "number" || !L.allowedIdleMinutes.includes(idle)) throw validation(`Choose ${L.allowedIdleMinutes.join(", ")} minutes.`, "idleMinutes");
    const notices = parseBool(b.emailNotices, "emailNotices");
    return { status: 200, body: await account.saveSettings(s, caller, { workspaceName: name, idleMinutes: idle, emailNotices: notices }) };
  });
}
