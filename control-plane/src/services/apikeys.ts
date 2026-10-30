import { createHash, randomBytes } from "node:crypto";
import { type Caller, type Services } from "../context.ts";
import { iso } from "../db.ts";
import { auditWho, writeAudit } from "../audit.ts";
import { notFound, validation } from "../errors.ts";
import { type Obj, isUuid } from "../validate.ts";

/**
 * API keys of the public API (docs/public-api.md, migration 0010). Not the dashboard's `fnx_` keys (services/account.ts).
 *
 * A key is `fvx_` and 43 base64url characters (32 random bytes). It is in exactly one answer, the one that creates it;
 * Postgres keeps its SHA-256 (hex) and a display prefix (`fvx_` and the next 8 characters). Nothing here logs a key,
 * puts one in an error or writes one to the audit log.
 */

export type KeyRole = "admin" | "read_only";
export const KEY_ROLES: readonly KeyRole[] = ["admin", "read_only"];
export const TOKEN_PREFIX = "fvx_";
/** The whole token: what is accepted in `Authorization: Bearer`. Anything else is refused before any lookup. */
export const TOKEN_RE = /^fvx_[A-Za-z0-9_-]{43}$/;
const NAME_MAX = 60;
/** The furthest a key can be made to expire. */
const MAX_LIFETIME_DAYS = 3 * 365;
const KEY_NOT_FOUND = "That API key does not exist.";

export interface KeyRow {
  id: string; name: string; role: KeyRole; prefix: string; created_at: Date; created_by_type: string; created_by: string;
  last_used_at: Date | null; expires_at: Date | null; revoked_at: Date | null; cursor_at?: string;
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

export function keyStatus(r: Pick<KeyRow, "revoked_at" | "expires_at">, now = Date.now()): "active" | "revoked" | "expired" {
  if (r.revoked_at) return "revoked";
  if (r.expires_at && new Date(r.expires_at).getTime() <= now) return "expired";
  return "active";
}

export const viewKey = (r: KeyRow) => ({
  id: String(r.id), name: r.name, role: r.role, prefix: r.prefix, status: keyStatus(r),
  createdAt: iso(r.created_at)!, lastUsedAt: iso(r.last_used_at), expiresAt: iso(r.expires_at), revokedAt: iso(r.revoked_at),
});

// ---------------------------------------------------------------- cursors

/**
 * A page boundary: the created_at (as Postgres prints it, to the microsecond) and id of the last row of the page.
 * Opaque to clients; anything that does not decode is a 400. It only ever narrows a query of the caller's own workspace.
 */
export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(value: unknown, field = "cursor"): { at: string; id: string } | null {
  if (value === undefined || value === "") return null;
  const bad = () => validation("This cursor is not valid. Use the nextCursor of the previous page.", field);
  if (typeof value !== "string" || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) throw bad();
  const [at, id, ...rest] = Buffer.from(value, "base64url").toString("utf8").split("|");
  if (rest.length || !id || !isUuid(id) || !at || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at)) throw bad();
  return { at, id: id.toLowerCase() };
}

/** `limit` query parameter: 1 to 100, 20 when absent. */
export function parseLimit(value: unknown, fallback = 20, max = 100): number {
  if (value === undefined || value === "") return fallback;
  const n = typeof value === "string" && /^\d{1,4}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > max) throw validation(`limit must be a whole number from 1 to ${max}.`, "limit");
  return n;
}

/** The SQL expression that prints created_at the way cursors carry it. */
export const CURSOR_AT = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// ---------------------------------------------------------------- managing keys

export function parseNewKey(body: unknown, now = new Date()): { name: string; role: KeyRole; expiresAt: Date | null } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw validation("The request body must be a JSON object.");
  const b = body as Obj;
  const extra = Object.keys(b).find((k) => !["name", "role", "expiresAt"].includes(k));
  if (extra !== undefined) throw validation("Unknown field. Send only name, role and expiresAt.", extra.length <= 40 && /^[A-Za-z0-9_]+$/.test(extra) ? extra : undefined);
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name.length < 1 || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) throw validation(`Use 1 to ${NAME_MAX} characters for the name, on one line.`, "name");
  if (!KEY_ROLES.includes(b.role as KeyRole)) throw validation("Choose a role: admin or read_only.", "role");
  let expiresAt: Date | null = null;
  if (b.expiresAt !== undefined && b.expiresAt !== null) {
    const t = typeof b.expiresAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(b.expiresAt) ? new Date(b.expiresAt) : new Date(NaN);
    if (Number.isNaN(t.getTime())) throw validation("expiresAt must be a date and time, for example 2027-01-31T00:00:00Z.", "expiresAt");
    if (t.getTime() <= now.getTime() + 60_000) throw validation("expiresAt must be at least a minute from now.", "expiresAt");
    if (t.getTime() > now.getTime() + MAX_LIFETIME_DAYS * 86_400_000) throw validation(`expiresAt can be at most ${MAX_LIFETIME_DAYS} days from now.`, "expiresAt");
    expiresAt = t;
  }
  return { name, role: b.role as KeyRole, expiresAt };
}

export async function createKey(s: Services, caller: Caller, body: unknown) {
  const k = parseNewKey(body);
  const token = newToken();
  const key = await s.db.tx(caller.workspaceId, async (c) => {
    const row = (await c.query(
      `insert into public.public_api_keys (workspace_id, name, role, key_hash, prefix, created_by_type, created_by, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [caller.workspaceId, k.name, k.role, hashToken(token), token.slice(0, TOKEN_PREFIX.length + 8), caller.actor.type, caller.actor.id, k.expiresAt],
    )).rows[0] as KeyRow;
    await writeAudit(c, auditWho(caller), {
      action: "api_key.public.create", targetType: "public_api_key", targetId: String(row.id),
      metadata: { name: k.name, role: k.role, expiresAt: iso(k.expiresAt) },
    });
    return viewKey(row);
  });
  return { key, token };
}

export async function listKeys(s: Services, caller: Caller, q: { limit: number; cursor: { at: string; id: string } | null }) {
  return s.db.tx(caller.workspaceId, async (c) => {
    const params: unknown[] = [caller.workspaceId];
    let where = "workspace_id = $1";
    if (q.cursor) where += ` and (created_at, id) < ($${params.push(q.cursor.at)}::timestamptz, $${params.push(q.cursor.id)}::uuid)`;
    const rows = (await c.query(
      `select *, ${CURSOR_AT("created_at")} as cursor_at from public.public_api_keys where ${where}
       order by created_at desc, id desc limit $${params.push(q.limit + 1)}`, params)).rows as KeyRow[];
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page.map(viewKey), nextCursor: rows.length > q.limit && last ? encodeCursor(last.cursor_at!, String(last.id)) : null };
  });
}

export async function revokeKey(s: Services, caller: Caller, id: unknown) {
  if (!isUuid(id)) throw notFound(KEY_NOT_FOUND);
  return s.db.tx(caller.workspaceId, async (c) => {
    const row = (await c.query(
      "update public.public_api_keys set revoked_at = coalesce(revoked_at, now()) where workspace_id = $1 and id = $2 returning *",
      [caller.workspaceId, id.toLowerCase()])).rows[0] as KeyRow | undefined;
    if (!row) throw notFound(KEY_NOT_FOUND);
    await writeAudit(c, auditWho(caller), { action: "api_key.public.revoke", targetType: "public_api_key", targetId: String(row.id) });
    return viewKey(row);
  });
}

// ---------------------------------------------------------------- resolving a key

export type Resolved =
  | { ok: true; keyId: string; workspaceId: string; role: KeyRole }
  | { ok: false; reason: "malformed" | "unknown" }
  | { ok: false; reason: "revoked" | "expired"; keyId: string; workspaceId: string };

/**
 * The organization and role of a token. Revoked and expired keys are told apart from unknown ones only so the refusal
 * can be recorded in their organization's audit log; the caller gets the same 401 for all of them. Records use at most
 * once a minute.
 */
export async function resolveKey(s: Services, token: string, now = Date.now()): Promise<Resolved> {
  if (!TOKEN_RE.test(token)) return { ok: false, reason: "malformed" };
  const r = await s.db.system(async (c) => (await c.query("select * from public.fenvix_cp_resolve_public_api_key($1)", [hashToken(token)])).rows[0] as
    { key_id: string; workspace_id: string; role: KeyRole; expires_at: Date | null; revoked_at: Date | null; last_used_at: Date | null } | undefined);
  if (!r) return { ok: false, reason: "unknown" };
  const status = keyStatus(r, now);
  if (status !== "active") return { ok: false, reason: status, keyId: String(r.key_id), workspaceId: String(r.workspace_id) };
  if (!r.last_used_at || now - new Date(r.last_used_at).getTime() > 60_000) {
    await s.db.tx(r.workspace_id, (c) => c.query("update public.public_api_keys set last_used_at = now() where id = $1 and workspace_id = $2", [r.key_id, r.workspace_id])).catch(() => {});
  }
  return { ok: true, keyId: String(r.key_id), workspaceId: String(r.workspace_id), role: r.role };
}

/** A refused sign-in with a key that exists, in its organization's audit log. Never the key, never its hash. */
export async function auditFailedAuth(s: Services, r: { keyId: string; workspaceId: string; reason: string }, req: { id: string; ip: string; method: string; path: string }) {
  await s.db.tx(r.workspaceId, (c) => writeAudit(c,
    { workspaceId: r.workspaceId, actor: { type: "api_key", id: r.keyId }, requestId: req.id, ip: req.ip },
    { action: "api_key.public.auth_failed", targetType: "public_api_key", targetId: r.keyId, outcome: "denied", metadata: { reason: r.reason, method: req.method, path: req.path } },
  )).catch((e) => s.log.error({ err: e instanceof Error ? e.message : String(e) }, "could not record a refused API key in the audit log"));
}
