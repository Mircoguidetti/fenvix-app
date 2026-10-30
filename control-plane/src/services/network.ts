import type { FastifyBaseLogger } from "fastify";
import type { Caller, Services } from "../context.ts";
import type { Client } from "../db.ts";
import { auditWho, writeAudit } from "../audit.ts";
import { ApiError, conflict, internal, notFound, unavailable, validation } from "../errors.ts";
import { type EngineAllowlist, EngineError } from "../engine/types.ts";
import { AllowlistError, MAX_ENTRIES, canonicalAddress, networkContains, validateEntries } from "../engine/netlist.ts";
import { isUuid, type Obj } from "../validate.ts";

/**
 * The IP allowlist of a database and the network blocks the engine holds (docs/network-allowlist.md).
 *
 * The engine checks the list: when a client signs in to a database, its TCP address must be in the database's list (an
 * empty list allows every address), otherwise it gets the same "Authentication failed" as a wrong password. The engine
 * keeps the list in the database's metadata; `public.database_ip_allowlists` (migration 0009) is this service's copy.
 *
 * Order of a change: who (http.ts: owner or admin, or an API key) -> the entries, checked with the engine's own rules
 * (netlist.ts) -> the database row, locked -> the engine -> Postgres and the audit row, in one transaction. If the engine
 * refuses or does not answer, nothing is saved. If Postgres fails after the engine said yes, the engine is put back to the
 * previous list; should that fail too, the next read shows the two lists as different and "apply again" repairs it.
 */
export interface NetCtx { s: Services; caller: Caller; log: FastifyBaseLogger }

const NOT_FOUND = "That database does not exist.";

interface Row { id: string; region: string; engine_state: string }
interface Saved { entries: string[]; updated_at: Date; updated_by_type: "user" | "api_key" | "system"; updated_by: string | null }

async function readRow(x: NetCtx, c: Client, id: unknown, lock: boolean): Promise<Row> {
  if (!isUuid(id)) throw notFound(NOT_FOUND);
  const row = (await c.query(
    `select id, region, engine_state from public.databases
      where workspace_id = $1 and id = $2 and engine_state <> 'provisioning'${lock ? " for update" : ""}`,
    [x.caller.workspaceId, id.toLowerCase()],
  )).rows[0] as Row | undefined;
  if (!row) throw notFound(NOT_FOUND);
  return { ...row, id: String(row.id) };
}

function changeable(row: Row): void {
  if (row.engine_state === "restoring") throw conflict("This database is being restored. Change its IP allowlist when the restore has finished.");
  if (row.engine_state === "erasing") throw conflict("This database is being erased.");
}

async function savedList(x: NetCtx, c: Client, id: string): Promise<Saved | null> {
  return ((await c.query(
    "select entries, updated_at, updated_by_type, updated_by from public.database_ip_allowlists where workspace_id = $1 and database_id = $2",
    [x.caller.workspaceId, id],
  )).rows[0] as Saved | undefined) ?? null;
}

/** Who made the last change, with a name a person recognises (a member's name, an API key's name). */
async function author(x: NetCtx, c: Client, saved: Saved | null) {
  if (!saved || saved.updated_by_type === "system" || !saved.updated_by) return saved ? { type: saved.updated_by_type, id: saved.updated_by, name: null } : null;
  let name: string | null = null;
  if (saved.updated_by_type === "user") {
    const m = (await c.query("select name from public.fenvix_cp_members() where user_id = $1", [saved.updated_by])).rows[0] as { name: string } | undefined;
    name = m?.name ?? null;
  } else {
    const k = (await c.query("select name from public.api_keys where workspace_id = $1 and id = $2", [x.caller.workspaceId, saved.updated_by])).rows[0] as { name: string } | undefined;
    name = k?.name ?? null;
    // A public API key (fvx_, migration 0010; the table may not be there before that migration).
    if (name === null && (await c.query("select to_regclass('public.public_api_keys') is not null as ok")).rows[0].ok) {
      const p = (await c.query("select name from public.public_api_keys where workspace_id = $1 and id::text = $2", [x.caller.workspaceId, saved.updated_by])).rows[0] as { name: string } | undefined;
      name = p?.name ?? null;
    }
  }
  return { type: saved.updated_by_type, id: saved.updated_by, name };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

/**
 * Whether the engine of a region trusts this control plane's address (then the Data Explorer and the provisioner skip the
 * lists and are never counted or blocked): the engine's `--trusted-networks` against the address this process connects
 * to the engine's MongoDB port from. Null when it cannot be told (engine or listener not reachable).
 */
export async function controlPlaneTrusted(s: Services, region: string): Promise<boolean | null> {
  try {
    const [nets, me] = await Promise.all([s.engine.trustedNetworks(region), s.data.sourceAddress(region)]);
    return me ? nets.some((n) => networkContains(n, me)) : null;
  } catch {
    return null;
  }
}

async function view(x: NetCtx, c: Client, row: Row, saved: Saved | null, engine?: EngineAllowlist) {
  const entries = saved?.entries ?? [];
  let status: "in_sync" | "different" | "unavailable" = "unavailable";
  let engineEntries: string[] | undefined;
  let enforced: boolean | null = null;
  try {
    const e = engine ?? await x.s.engine.getIpAllowlist(row.id);
    status = sameList(e.entries, entries) ? "in_sync" : "different";
    if (status === "different") engineEntries = e.entries;
    enforced = e.enforced;
  } catch (e) {
    x.log.warn({ kind: e instanceof EngineError ? e.kind : "unknown", databaseId: row.id }, "ip allowlist: could not read the engine's list");
  }
  return {
    entries,
    allowAll: entries.length === 0,
    maxEntries: MAX_ENTRIES,
    updatedAt: saved ? new Date(saved.updated_at).toISOString() : null,
    updatedBy: await author(x, c, saved),
    engine: { status, ...(engineEntries ? { entries: engineEntries } : {}), enforced },
    dataExplorer: { trusted: await controlPlaneTrusted(x.s, row.region) },
  };
}

export async function getAllowlist(x: NetCtx, databaseId: unknown) {
  return x.s.db.tx(x.caller.workspaceId, async (c) => {
    const row = await readRow(x, c, databaseId, false);
    return view(x, c, row, await savedList(x, c, row.id));
  });
}

/** `{ "entries": [...] }` and nothing else, every entry checked with the engine's rules. */
export function parseAllowlistBody(body: unknown): string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw validation("The request body must be a JSON object: {\"entries\": [...]}.");
  const b = body as Obj;
  const extra = Object.keys(b).find((k) => k !== "entries");
  if (extra !== undefined) throw validation("Unknown field. Send only entries.", extra.length <= 40 && /^[A-Za-z0-9_]+$/.test(extra) ? extra : undefined);
  if (!("entries" in b)) throw validation("Send entries: a list of addresses or networks. An empty list allows every address.", "entries");
  try {
    return validateEntries(b.entries);
  } catch (e) {
    if (e instanceof AllowlistError) {
      const msg = e.message.charAt(0).toUpperCase() + e.message.slice(1);
      throw validation(msg, e.index === null ? "entries" : `entries[${e.index}]`);
    }
    throw e;
  }
}

function fromEngine(x: NetCtx, e: unknown, what: string): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof EngineError) {
    x.log.warn({ kind: e.kind, op: what }, "network: the engine refused or did not answer");
    if (e.kind === "unavailable") return unavailable("The database engine did not answer. Nothing was changed. Try again in a moment.");
    if (e.kind === "invalid") return validation("The database engine refused the list. Nothing was changed. Check the entries and try again.", "entries");
    if (e.kind === "not_found") return conflict("The database engine does not have this database. Nothing was changed.");
    return conflict("The database engine could not do this right now. Nothing was changed. Try again in a moment.");
  }
  x.log.error({ err: e instanceof Error ? e.name : "error", op: what }, "network: unexpected failure");
  return internal();
}

type Action = "set" | "reapply";

async function auditFailure(x: NetCtx, id: string, action: Action, before: string[] | null, after: string[], code: string): Promise<void> {
  await x.s.db.tx(x.caller.workspaceId, (c) => writeAudit(c, auditWho(x.caller), {
    action: `database.ip_allowlist.${action}`, targetType: "database", targetId: id, outcome: "failed",
    metadata: { before: before ?? [], after, code },
  })).catch((err) => x.log.error({ err: err instanceof Error ? err.message : String(err) }, "could not record a failed IP allowlist change in the audit log"));
}

/**
 * Sets the list: the engine first, then Postgres. `entries` is already in the engine's form. "reapply" sends the saved
 * list again (after the engine was found to hold another one).
 */
async function apply(x: NetCtx, databaseId: unknown, action: Action, wanted: string[] | null) {
  const { s, caller } = x;
  let engineDone: { id: string; previous: string[] } | null = null;
  let id: string | null = null;
  let before: string[] | null = null;
  let after: string[] = wanted ?? [];
  try {
    return await s.db.tx(caller.workspaceId, async (c) => {
      const row = await readRow(x, c, databaseId, true);
      id = row.id;
      changeable(row);
      const saved = await savedList(x, c, row.id);
      // What the engine holds now is the "before" of the audit (for a reapply it is what is being repaired).
      before = saved?.entries ?? [];
      if (action === "reapply") {
        after = saved?.entries ?? [];
        try { before = (await s.engine.getIpAllowlist(row.id)).entries; } catch { /* the set below says whether the engine answers */ }
      }
      const result = await s.engine.setIpAllowlist({ id: row.id, entries: after });
      engineDone = { id: row.id, previous: before };
      await c.query(
        `insert into public.database_ip_allowlists (database_id, workspace_id, entries, updated_at, updated_by_type, updated_by)
         values ($1, $2, $3, now(), $4, $5)
         on conflict (database_id) do update set entries = excluded.entries, updated_at = excluded.updated_at,
           updated_by_type = excluded.updated_by_type, updated_by = excluded.updated_by`,
        [row.id, caller.workspaceId, result.entries, caller.actor.type, caller.actor.id],
      );
      await writeAudit(c, auditWho(caller), {
        action: `database.ip_allowlist.${action}`, targetType: "database", targetId: row.id, outcome: "ok", metadata: { before, after: result.entries },
      });
      return view(x, c, row, await savedList(x, c, row.id), result);
    });
  } catch (e) {
    const done = engineDone as { id: string; previous: string[] } | null;
    if (done && !(e instanceof EngineError)) {
      // The engine took the new list but Postgres did not: put the engine back, so the two agree again.
      await s.engine.setIpAllowlist({ id: done.id, entries: done.previous }).catch(() =>
        x.log.error({ databaseId: done.id }, "ip allowlist: the engine has a list that was not saved; the page will show it as different until it is applied again"));
    }
    const api = fromEngine(x, e, `ip allowlist ${action}`);
    // A database that is not theirs (404) is not recorded against it.
    if (id && !(api.code === "not_found" && api.message === NOT_FOUND)) {
      await auditFailure(x, id, action, before, after, api.code);
    }
    throw api;
  }
}

export const setAllowlist = (x: NetCtx, databaseId: unknown, body: unknown) => apply(x, databaseId, "set", parseAllowlistBody(body));
export const reapplyAllowlist = (x: NetCtx, databaseId: unknown) => apply(x, databaseId, "reapply", null);

// ---------------------------------------------------------------- blocks

export async function listBlocks(x: NetCtx, databaseId: unknown) {
  const row = await x.s.db.tx(x.caller.workspaceId, (c) => readRow(x, c, databaseId, false));
  try {
    const items = await x.s.engine.networkBlocks(row.id);
    // Only the address and when the block ends: the engine records no user name or password, and nothing else is passed on.
    return { items: items.map((b) => ({ ip: b.ip, until: b.until, remainingSecs: b.remainingSecs })) };
  } catch (e) {
    throw fromEngine(x, e, "blocks");
  }
}

/** An address as a person may type it (or as the list shows it: an IPv6 /64). */
function parseBlockedAddress(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 50) throw validation("Enter the blocked address, for example 203.0.113.9.", "ip");
  const v6net = /\/64$/.test(v) ? v.slice(0, -3) : null;
  const ip = canonicalAddress(v6net ?? v);
  if (!ip || (v6net !== null && !ip.includes(":"))) throw validation("That is not an IP address. Enter it as the list of blocks shows it.", "ip");
  return v6net !== null ? `${ip}/64` : ip;
}

export async function unblock(x: NetCtx, databaseId: unknown, body: unknown) {
  const b = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Obj;
  const ip = parseBlockedAddress(b.ip);
  const row = await x.s.db.tx(x.caller.workspaceId, (c) => readRow(x, c, databaseId, false));
  let blocked: string[];
  try { blocked = (await x.s.engine.networkBlocks(row.id)).map((z) => z.ip); } catch (e) { throw fromEngine(x, e, "blocks"); }
  // Only an address blocked on this database: lifting the block of another customer's database is not theirs to do.
  if (!blocked.includes(ip)) throw notFound("That address is not blocked on this database.");
  let done: { unblocked: boolean };
  try {
    done = await x.s.engine.unblockAddress({ id: row.id, ip });
  } catch (e) {
    throw fromEngine(x, e, "unblock");
  }
  await x.s.db.tx(x.caller.workspaceId, (c) => writeAudit(c, auditWho(x.caller), {
    action: "database.network.unblock", targetType: "database", targetId: row.id, outcome: "ok", metadata: { ip },
  }));
  return { ip, unblocked: done.unblocked };
}
