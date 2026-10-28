import type { FastifyBaseLogger } from "fastify";
import type { Caller, Services } from "../context.ts";
import type { Client } from "../db.ts";
import { auditWho, writeAudit } from "../audit.ts";
import { ApiError, conflict, forbidden, internal, notFound, unavailable, validation } from "../errors.ts";
import { renderHost } from "../config.ts";
import { randomPassword } from "../engine/credentials.ts";
import { EngineError } from "../engine/types.ts";
import { type CustomerRole, type CustomerUser, CUSTOMER_ROLES, isCustomerRole } from "../engine/users.ts";
import { connectionString } from "./databases.ts";
import { isUuid, type Obj } from "../validate.ts";

/**
 * A database's own users, for the customer's applications ("Database Access", docs/database-users.md).
 *
 * The order of every request is fixed: who is calling (http.ts) -> rate limit per person or key -> may they
 * (`requireManage` for changes) -> are the inputs allowed (`parseUsername`, `parseRole`, unknown fields refused) -> is the
 * database theirs and ready (`lockDatabase`, same 404 for "another workspace's" and "does not exist") -> the engine.
 *
 * Users live in the engine only (defined on `db_<hex>`, one role on that database from CUSTOMER_ROLES). The control
 * plane keeps no list of them and never a password: a password is made here, sent to the engine (which keeps its SCRAM
 * hash) and put in exactly one answer. The control plane's own `cp_<hex>` user is never listed and cannot be named.
 */

export interface UsersCtx { s: Services; caller: Caller; log: FastifyBaseLogger }

/** 3 to 32 characters: a lowercase letter, then lowercase letters, digits, `_` or `-`. */
export const USERNAME_RE = /^[a-z][a-z0-9_-]{2,31}$/;
export const USERNAME_RULE = "Use 3 to 32 lowercase letters, numbers, _ or -, starting with a letter.";
/** Names a customer cannot take: the engine's and ours, whatever database they would be on. */
const RESERVED = new Set(["admin", "root", "system", "local", "config", "fenvix", "provisioner", "superuser", "backup", "restore", "monitor", "cluster", "internal", "support", "readwrite", "read", "dbowner"]);
const RESERVED_PREFIXES = ["cp_", "cp-", "fenvix", "mongo", "system", "__"];

export const DEFAULT_APP_USER = "app";
const NOT_FOUND = "That database does not exist.";
const USER_NOT_FOUND = "That user does not exist.";

/** A user name from a request, or a 400. Nothing is trimmed or lowercased: what is checked is what is used. */
export function parseUsername(value: unknown, s: Pick<Services, "cfg">, field = "username"): string {
  if (typeof value !== "string" || !USERNAME_RE.test(value)) throw validation(USERNAME_RULE, field);
  const provisioner = s.cfg.engineUsers?.provisioner.username.toLowerCase();
  if (RESERVED.has(value) || RESERVED_PREFIXES.some((p) => value.startsWith(p)) || value === provisioner) {
    throw validation("That name is reserved. Choose another one.", field);
  }
  return value;
}

/** A user name from a URL: anything that is not a name a customer can have is a user that does not exist. */
function pathUsername(value: unknown, s: Pick<Services, "cfg">): string {
  try { return parseUsername(value, s); } catch { throw notFound(USER_NOT_FOUND); }
}

/** One of the fixed roles, by its name only. Objects, lists, other databases and every other role are refused. */
export function parseRole(value: unknown, field = "role"): CustomerRole {
  if (!isCustomerRole(value)) throw validation(`Choose one of: ${Object.keys(CUSTOMER_ROLES).join(", ")}.`, field);
  return value;
}

/** The body has only these keys; anything else (roles, db, privileges, customData, pwd, ...) is refused, not ignored. */
function only(b: Obj, keys: string[]): void {
  const extra = Object.keys(b).find((k) => !keys.includes(k));
  if (extra !== undefined) throw validation(`Unknown field. Send only ${keys.join(" and ")}.`, extra.length <= 40 && /^[A-Za-z0-9_]+$/.test(extra) ? extra : undefined);
}

export function parseNewUser(body: unknown, s: Pick<Services, "cfg">): { username: string; role: CustomerRole } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw validation("The request body must be a JSON object.");
  const b = body as Obj;
  only(b, ["username", "role"]);
  return { username: parseUsername(b.username, s), role: b.role === undefined ? "readWrite" : parseRole(b.role) };
}

/** Rate limits per person and per API key, on top of the workspace's (http.ts). */
export function hitLimit(x: UsersCtx, limiter: { hit(key: string, limit: number): void }, changing: boolean): void {
  const who = `${x.caller.actor.type}:${x.caller.actor.id}`;
  const L = x.s.cfg.limits;
  limiter.hit(`users:${who}`, L.userListsPerMinute + L.userChangesPerMinute);
  if (changing) limiter.hit(`users-change:${who}`, L.userChangesPerMinute);
}

type Action = "create" | "reset_password" | "delete";

async function audit(x: UsersCtx, c: Client | null, a: { action: Action; databaseId: string | null; username: string | null; role?: CustomerRole; outcome: "ok" | "failed" | "denied"; code?: string }): Promise<void> {
  const entry = {
    action: `database.user.${a.action}`, targetType: "database", targetId: a.databaseId ?? undefined, outcome: a.outcome,
    metadata: { username: a.username, ...(a.role ? { role: a.role } : {}), ...(a.code ? { code: a.code } : {}) },
  };
  if (c) return writeAudit(c, auditWho(x.caller), entry);
  await x.s.db.tx(x.caller.workspaceId, (cc) => writeAudit(cc, auditWho(x.caller), entry)).catch((e) =>
    x.log.error({ err: e instanceof Error ? e.message : String(e) }, "could not record a database user change in the audit log"));
}

/**
 * Creating, resetting and deleting users. People: owner and admin (members can only list). API keys: only keys made
 * with `userAccess: "manage"` (migration 0007; every key is "none" unless made otherwise). Refusals are audited.
 */
export async function requireManage(x: UsersCtx, databaseId: unknown, action: Action, username: unknown): Promise<void> {
  const { s, caller } = x;
  let ok: boolean;
  if (caller.actor.type === "user") {
    ok = caller.role === "owner" || caller.role === "admin";
  } else {
    const r = await s.db.tx(caller.workspaceId, async (c) =>
      (await c.query("select user_access from public.api_keys where workspace_id = $1 and id = $2 and revoked_at is null", [caller.workspaceId, caller.actor.id])).rows[0] as { user_access: string } | undefined);
    ok = r?.user_access === "manage";
  }
  if (ok) return;
  // Record only what is ours to name: an id of the right form, a name of the right form.
  const name = typeof username === "string" && USERNAME_RE.test(username) ? username : null;
  await audit(x, null, { action, databaseId: isUuid(databaseId) ? databaseId.toLowerCase() : null, username: name, outcome: "denied" });
  throw forbidden(caller.actor.type === "api_key"
    ? "This API key cannot manage database users. Create a key with user access manage."
    : "Only a workspace owner or admin can manage database users.");
}

interface DbRow { id: string; name: string; region: string; workspace_id: string; engine_state: string; app_user: string | null }

/** The database row of the caller's workspace (locked for update when `c` is a transaction that changes users). */
async function readRow(x: UsersCtx, c: Client, id: unknown, lock: boolean): Promise<DbRow> {
  if (!isUuid(id)) throw notFound(NOT_FOUND);
  const row = (await c.query(
    `select id, name, region, workspace_id, engine_state, app_user from public.databases
      where workspace_id = $1 and id = $2 and engine_state <> 'provisioning'${lock ? " for update" : ""}`,
    [x.caller.workspaceId, id.toLowerCase()],
  )).rows[0] as DbRow | undefined;
  if (!row) throw notFound(NOT_FOUND);
  if (row.engine_state === "restoring") throw conflict("This database is being restored. Manage its users when the restore has finished.");
  if (row.engine_state === "erasing") throw conflict("This database is being erased.");
  return { ...row, id: String(row.id) };
}

/** An engine failure as an answer: never the engine's words, never a password (they are not in EngineError anyway). */
function fromEngine(x: UsersCtx, e: unknown, what: string): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof EngineError) {
    x.log.warn({ kind: e.kind, op: what }, "database users: the engine refused or did not answer");
    if (e.kind === "conflict") return conflict("A user with that name already exists on this database.", "username");
    if (e.kind === "not_found") return notFound(USER_NOT_FOUND);
    if (e.kind === "unavailable") return unavailable("The database engine did not answer. Try again in a moment.");
    return internal("The user could not be changed. Try again in a moment.");
  }
  x.log.error({ err: e instanceof Error ? e.name : "error", op: what }, "database users: unexpected failure");
  return internal();
}

const userView = (u: CustomerUser) => ({ username: u.username, role: u.role, createdAt: u.createdAt });
const hostOf = (x: UsersCtx, r: DbRow) => renderHost(x.s.cfg, { name: r.name, region: r.region, workspace: r.workspace_id });
const ensureOn = (x: UsersCtx) => {
  if (!x.s.users.customerUsers) throw unavailable("Database users are not set up on this deployment yet.", 60);
};

export async function listUsers(x: UsersCtx, databaseId: unknown) {
  ensureOn(x);
  const row = await x.s.db.tx(x.caller.workspaceId, (c) => readRow(x, c, databaseId, false));
  let users: CustomerUser[];
  try { users = await x.s.users.listCustomer(row.id, row.region); } catch (e) { throw fromEngine(x, e, "list"); }
  return { items: users.map(userView), limit: x.s.cfg.limits.maxUsersPerDatabase };
}

/**
 * Runs `work` (the engine call) while the database row is locked, so an erase or a restore cannot start in the middle
 * and two changes to the same database's users go one after the other. Audits the outcome either way.
 */
async function change<T>(x: UsersCtx, databaseId: unknown, a: { action: Action; username: string; role?: CustomerRole }, work: (c: Client, row: DbRow) => Promise<T>): Promise<T> {
  const id = isUuid(databaseId) ? databaseId.toLowerCase() : null;
  try {
    return await x.s.db.tx(x.caller.workspaceId, async (c) => {
      const row = await readRow(x, c, databaseId, true);
      const out = await work(c, row);
      await audit(x, c, { action: a.action, databaseId: row.id, username: a.username, role: a.role, outcome: "ok" });
      return out;
    });
  } catch (e) {
    const api = fromEngine(x, e, a.action);
    // A database that is not theirs (404) is not recorded against it: the audit log is per workspace and the id is not theirs.
    if (!(api.code === "not_found" && api.message === NOT_FOUND)) {
      await audit(x, null, { action: a.action, databaseId: id, username: a.username, role: a.role, outcome: "failed", code: api.code });
    }
    throw api;
  }
}

export async function createUser(x: UsersCtx, databaseId: unknown, body: unknown) {
  ensureOn(x);
  const { username, role } = parseNewUser(body, x.s);
  const { s } = x;
  let made: { id: string; region: string } | null = null;
  try {
    return await change(x, databaseId, { action: "create", username, role }, async (c, row) => {
      let existing: CustomerUser[];
      try { existing = await s.users.listCustomer(row.id, row.region); } catch (e) { throw fromEngine(x, e, "list"); }
      if (existing.some((u) => u.username === username)) throw conflict("A user with that name already exists on this database.", "username");
      if (existing.length >= s.cfg.limits.maxUsersPerDatabase) throw conflict(`A database can have up to ${s.cfg.limits.maxUsersPerDatabase} users. Delete one first.`);
      const password = randomPassword();
      const createdAt = new Date().toISOString();
      await s.users.createCustomer(row.id, row.region, { username, role, password, createdAt });
      made = { id: row.id, region: row.region };
      // A database without a user in its connection string gets this one.
      if (row.app_user === null) await c.query("update public.databases set app_user = $3 where workspace_id = $1 and id = $2", [x.caller.workspaceId, row.id, username]);
      return {
        user: { username, role, createdAt },
        password,
        connectionString: connectionString(s.cfg, { id: row.id, name: row.name, host: hostOf(x, row) }, username, password),
      };
    });
  } catch (e) {
    // The engine made the user but the record of it failed (Postgres): drop it again, nobody has its password.
    const m = made as { id: string; region: string } | null;
    if (m) await s.users.dropCustomer(m.id, m.region, username).catch(() => x.log.warn("database users: could not undo a user whose creation was not recorded"));
    throw e;
  }
}

export async function resetPassword(x: UsersCtx, databaseId: unknown, rawName: unknown) {
  ensureOn(x);
  const username = pathUsername(rawName, x.s);
  const { s } = x;
  return change(x, databaseId, { action: "reset_password", username }, async (_c, row) => {
    let user: CustomerUser | undefined;
    try { user = (await s.users.listCustomer(row.id, row.region)).find((u) => u.username === username); } catch (e) { throw fromEngine(x, e, "list"); }
    if (!user) throw notFound(USER_NOT_FOUND);
    const password = randomPassword();
    await s.users.setCustomerPassword(row.id, row.region, username, password);
    return {
      user: userView(user),
      password,
      connectionString: connectionString(s.cfg, { id: row.id, name: row.name, host: hostOf(x, row) }, username, password),
    };
  });
}

export async function deleteUser(x: UsersCtx, databaseId: unknown, rawName: unknown) {
  ensureOn(x);
  const username = pathUsername(rawName, x.s);
  return change(x, databaseId, { action: "delete", username }, async (c, row) => {
    // The engine drops it at once: a connection already open as this user is refused its next command.
    const { dropped } = await x.s.users.dropCustomer(row.id, row.region, username);
    if (!dropped) throw notFound(USER_NOT_FOUND);
    if (row.app_user === username) await c.query("update public.databases set app_user = null where workspace_id = $1 and id = $2", [x.caller.workspaceId, row.id]);
    return { username, deleted: true };
  });
}
