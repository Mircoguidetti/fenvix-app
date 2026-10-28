import { renderHost } from "../config.ts";
import { engineName } from "../engine/names.ts";
import { type Caller, type Services } from "../context.ts";
import { type Client, iso } from "../db.ts";
import { auditWho, writeAudit } from "../audit.ts";
import { conflict, internal, notFound, validation } from "../errors.ts";
import { EngineError } from "../engine/types.ts";
import { type DatabaseFilter, isUuid, type Tag, parseRemoveTerms, splitTag } from "../validate.ts";

export interface Database {
  id: string;
  name: string;
  state: "awake" | "asleep";
  storageMb: number;
  requests24h: number;
  lastActiveAt: string;
  createdAt: string;
  region: string;
  host: string;
  connectionString: string;
  tags: string[];
  keepAwake: boolean;
  forkedFrom: string | null;
  restoredTo: string | null;
}

export const DATABASE_COLUMNS = `
  d.id, d.name, d.state::text as state, d.keep_awake, d.region, d.workspace_id,
  (d.storage_bytes / 1048576)::bigint as storage_mb, d.requests_24h,
  d.created_at, d.last_active_at, d.forked_from, d.restored_to, d.app_user,
  (select coalesce(array_agg(g.key || ':' || g.value order by g.key, g.value), '{}')
     from public.database_tags g where g.database_id = d.id) as tags`;

type Row = Record<string, unknown>;

/** The database name a client names in its connection string, and where its users are defined (their authSource). */
export function connectionDbName(cfg: Services["cfg"], d: { id: string; name: string }): string {
  return cfg.connectionDbName === "engine" ? engineName(d.id) : d.name.replaceAll("-", "_");
}

/**
 * The connection string of a database for one of its users (docs/database-users.md, "Connection string"). Without a
 * user it says <username>; without a password (always, except in the one answer that shows a new password) it says
 * <password>. The user is defined on the database itself, so authSource is the database; TLS is required; the
 * mechanism is the one the engine stores (SCRAM-SHA-256). Names and passwords are letters, digits, _ and - only, so
 * nothing needs escaping, but they are escaped anyway.
 */
export function connectionString(cfg: Services["cfg"], d: { id: string; name: string; host: string }, user: string | null, password: string | null = null): string {
  const db = connectionDbName(cfg, d);
  const u = user === null ? "<username>" : encodeURIComponent(user);
  const p = password === null ? "<password>" : encodeURIComponent(password);
  return `mongodb://${u}:${p}@${d.host}:${cfg.connectionPort}/${db}?tls=true&authSource=${db}&authMechanism=SCRAM-SHA-256`;
}

export function toDatabase(s: Pick<Services, "cfg">, r: Row): Database {
  const name = String(r.name);
  const region = String(r.region);
  const host = renderHost(s.cfg, { name, region, workspace: String(r.workspace_id) });
  return {
    id: String(r.id),
    name,
    state: r.state as "awake" | "asleep",
    storageMb: Number(r.storage_mb),
    requests24h: Number(r.requests_24h),
    lastActiveAt: iso(r.last_active_at as Date)!,
    createdAt: iso(r.created_at as Date)!,
    region,
    host,
    // The password is never stored or sent here: it is written as <password>. The user is the database's initial user
    // (migration 0007, databases.app_user), or <username> when there is none.
    connectionString: connectionString(s.cfg, { id: String(r.id), name, host }, r.app_user ? String(r.app_user) : null),
    tags: r.tags as string[],
    keepAwake: Boolean(r.keep_awake),
    forkedFrom: r.forked_from ? String(r.forked_from) : null,
    restoredTo: iso(r.restored_to as Date | null),
  };
}

/** SQL conditions for a filter, appended to `params`. Rows still being provisioned are never shown. */
export function filterSql(f: DatabaseFilter, params: unknown[]): string {
  const out: string[] = ["d.engine_state <> 'provisioning'"];
  const p = (v: unknown) => `$${params.push(v)}`;
  if (f.search) out.push(`d.name ilike ${p(`%${f.search.replace(/[\\%_]/g, "\\$&")}%`)}`);
  if (f.state) out.push(`d.state = ${p(f.state)}::public.database_state`);
  if (f.keepAwake !== undefined) out.push(`d.keep_awake = ${p(f.keepAwake)}`);
  for (const term of f.tags) {
    if (term.startsWith("!")) {
      out.push(`not exists (select 1 from public.database_tags g where g.database_id = d.id and g.key = ${p(term.slice(1))})`);
    } else if (term.includes(":")) {
      const t = splitTag(term);
      out.push(`exists (select 1 from public.database_tags g where g.database_id = d.id and g.key = ${p(t.key)} and g.value = ${p(t.value)})`);
    } else {
      out.push(`exists (select 1 from public.database_tags g where g.database_id = d.id and g.key = ${p(term)})`);
    }
  }
  return out.join(" and ");
}

const SORT_COLUMNS: Record<string, string> = {
  name: "d.name",
  state: "d.state::text",
  keepAwake: "d.keep_awake::int",
  storageMb: "d.storage_bytes",
  requests24h: "d.requests_24h",
  lastActiveAt: "d.last_active_at",
};

export async function listDatabases(
  s: Services, caller: Caller,
  q: { filter: DatabaseFilter; sort: string; dir: "asc" | "desc"; page: number; pageSize: number },
) {
  return s.db.tx(caller.workspaceId, async (c) => {
    const params: unknown[] = [caller.workspaceId];
    const where = filterSql(q.filter, params);
    const total = (await c.query(`select count(*)::bigint as n from public.databases d where d.workspace_id = $1 and ${where}`, params)).rows[0].n as number;
    const order = `${SORT_COLUMNS[q.sort]} ${q.dir === "asc" ? "asc" : "desc"}, d.name asc, d.id asc`;
    const res = await c.query(
      `select ${DATABASE_COLUMNS} from public.databases d where d.workspace_id = $1 and ${where}
       order by ${order} limit $${params.push(q.pageSize)} offset $${params.push((q.page - 1) * q.pageSize)}`,
      params,
    );
    return { items: res.rows.map((r) => toDatabase(s, r)), total, page: q.page, pageSize: q.pageSize };
  });
}

export async function listDatabaseIds(s: Services, caller: Caller, filter: DatabaseFilter): Promise<string[]> {
  return s.db.tx(caller.workspaceId, async (c) => {
    const params: unknown[] = [caller.workspaceId];
    const where = filterSql(filter, params);
    const n = (await c.query(`select count(*)::bigint as n from public.databases d where d.workspace_id = $1 and ${where}`, params)).rows[0].n as number;
    if (n > s.cfg.limits.maxIdsListIds) {
      throw validation(`More than ${s.cfg.limits.maxIdsListIds} databases match. Narrow the filter and try again.`);
    }
    const res = await c.query(`select d.id from public.databases d where d.workspace_id = $1 and ${where} order by d.name, d.id`, params);
    return res.rows.map((r) => String(r.id));
  });
}

export async function groupDatabases(s: Services, caller: Caller, groupBy: string, filter: DatabaseFilter) {
  return s.db.tx(caller.workspaceId, async (c) => {
    const params: unknown[] = [caller.workspaceId, groupBy];
    const where = filterSql(filter, params);
    const res = await c.query(
      `with picked as (
         select d.state, d.keep_awake, d.storage_bytes,
                (select g.value from public.database_tags g where g.database_id = d.id and g.key = $2) as value
         from public.databases d where d.workspace_id = $1 and ${where})
       select value, count(*)::bigint as count,
              (count(*) filter (where state = 'awake'))::bigint as awake,
              (count(*) filter (where keep_awake))::bigint as keep_awake,
              (coalesce(sum(storage_bytes), 0) / 1048576)::bigint as storage_mb
       from picked group by value
       order by (value is null), count(*) desc, value`,
      params,
    );
    const groups = res.rows.map((r) => ({
      value: r.value === null ? null : String(r.value),
      count: Number(r.count), awake: Number(r.awake), keepAwake: Number(r.keep_awake), storageMb: Number(r.storage_mb),
    }));
    return { groupBy, total: groups.reduce((n, g) => n + g.count, 0), groups };
  });
}

export async function listTags(s: Services, caller: Caller) {
  return s.db.tx(caller.workspaceId, async (c) => {
    const res = await c.query(
      `select g.key, g.value, count(*)::bigint as count
       from public.database_tags g join public.databases d on d.id = g.database_id
       where g.workspace_id = $1 and d.engine_state <> 'provisioning'
       group by g.key, g.value order by g.key, count(*) desc, g.value`,
      [caller.workspaceId],
    );
    return { items: res.rows.map((r) => ({ key: String(r.key), value: String(r.value), count: Number(r.count) })) };
  });
}

export async function readDatabase(s: Services, c: Client, workspaceId: string, id: string): Promise<Database | null> {
  if (!isUuid(id)) return null;
  const res = await c.query(`select ${DATABASE_COLUMNS} from public.databases d where d.workspace_id = $1 and d.id = $2 and d.engine_state <> 'provisioning'`, [workspaceId, id]);
  return res.rows[0] ? toDatabase(s, res.rows[0]) : null;
}

export async function getDatabase(s: Services, caller: Caller, id: string): Promise<Database> {
  const db = await s.db.tx(caller.workspaceId, (c) => readDatabase(s, c, caller.workspaceId, id));
  if (!db) throw notFound("That database does not exist.");
  return db;
}

// ---------------------------------------------------------------- tags

async function assertTagCapacity(s: Services, c: Client, ws: string, ids: string[], add: Tag[]) {
  // A database that would end up with more tags than allowed (keys it already has are replaced, not added).
  const res = await c.query(
    `select d.name, count(g.key)::int as have,
            count(g.key) filter (where g.key = any($3::text[]))::int as replaced
     from public.databases d left join public.database_tags g on g.database_id = d.id
     where d.workspace_id = $1 and d.id = any($2::uuid[]) group by d.id, d.name`,
    [ws, ids, add.map((t) => t.key)],
  );
  const max = s.cfg.limits.maxTagsPerDatabase;
  for (const r of res.rows) {
    if (r.have - r.replaced + add.length > max) throw validation(`${r.name} would have more than ${max} tags.`, "tags");
  }
}

export async function setTags(s: Services, caller: Caller, id: string, tags: Tag[]): Promise<Database> {
  return s.db.tx(caller.workspaceId, async (c) => {
    if (!isUuid(id)) throw notFound("That database does not exist.");
    const found = await c.query("select 1 from public.databases where id = $1 and workspace_id = $2 and engine_state <> 'provisioning' for update", [id, caller.workspaceId]);
    if (!found.rowCount) throw notFound("That database does not exist.");
    await c.query("delete from public.database_tags where database_id = $1 and workspace_id = $2", [id, caller.workspaceId]);
    for (const t of tags) {
      await c.query("insert into public.database_tags (database_id, workspace_id, key, value) values ($1, $2, $3, $4)", [id, caller.workspaceId, t.key, t.value]);
    }
    await writeAudit(c, auditWho(caller), { action: "database.tags.set", targetType: "database", targetId: id, metadata: { tags: tags.map((t) => `${t.key}:${t.value}`) } });
    return (await readDatabase(s, c, caller.workspaceId, id))!;
  });
}

async function liveIds(c: Client, ws: string, ids: string[]): Promise<string[]> {
  const res = await c.query("select id from public.databases where workspace_id = $1 and id = any($2::uuid[]) and engine_state <> 'provisioning'", [ws, ids]);
  return res.rows.map((r) => String(r.id));
}

export async function addTags(s: Services, caller: Caller, ids: string[], tags: Tag[]): Promise<{ affected: number }> {
  return s.db.tx(caller.workspaceId, async (c) => {
    const live = await liveIds(c, caller.workspaceId, ids);
    await assertTagCapacity(s, c, caller.workspaceId, live, tags);
    if (live.length && tags.length) {
      await c.query(
        `insert into public.database_tags (database_id, workspace_id, key, value)
         select d, $1, t.key, t.value from unnest($2::uuid[]) d cross join unnest($3::text[], $4::text[]) as t(key, value)
         on conflict (database_id, key) do update set value = excluded.value`,
        [caller.workspaceId, live, tags.map((t) => t.key), tags.map((t) => t.value)],
      );
    }
    await writeAudit(c, auditWho(caller), { action: "database.tags.add", metadata: { databases: live.length, tags: tags.map((t) => `${t.key}:${t.value}`) } });
    return { affected: live.length };
  });
}

export async function removeTags(s: Services, caller: Caller, ids: string[], terms: ReturnType<typeof parseRemoveTerms>): Promise<{ affected: number }> {
  return s.db.tx(caller.workspaceId, async (c) => {
    const live = await liveIds(c, caller.workspaceId, ids);
    for (const t of terms) {
      await c.query(
        `delete from public.database_tags where workspace_id = $1 and database_id = any($2::uuid[]) and key = $3 and ($4::text is null or value = $4)`,
        [caller.workspaceId, live, t.key, t.value],
      );
    }
    await writeAudit(c, auditWho(caller), { action: "database.tags.remove", metadata: { databases: live.length, tags: terms.map((t) => (t.value ? `${t.key}:${t.value}` : t.key)) } });
    return { affected: live.length };
  });
}

// ---------------------------------------------------------------- keep awake

/**
 * Pins or unpins databases in the engine, then records it. Engine calls are repeatable, so a
 * retry after a partial failure finishes the job. Databases whose engine call failed are left
 * as they were in Postgres, so the two never disagree.
 */
export async function setKeepAwake(s: Services, caller: Caller, ids: string[], enabled: boolean): Promise<{ affected: number }> {
  const live = await s.db.tx(caller.workspaceId, async (c) => {
    const res = await c.query(
      "select id, engine_state from public.databases where workspace_id = $1 and id = any($2::uuid[]) and engine_state <> 'provisioning'",
      [caller.workspaceId, ids],
    );
    return res.rows as { id: string; engine_state: string }[];
  });
  const busy = live.find((r) => r.engine_state === "erasing");
  if (busy) throw conflict("A database in this selection is being erased.");

  const done: string[] = [];
  const failed: string[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      const row = live[i];
      if (!row) return;
      try {
        await s.engine.setKeepAwake({ id: row.id, enabled });
        done.push(row.id);
      } catch (e) {
        // An id the engine does not know cannot be pinned; it is an inconsistency, not the caller's mistake.
        s.log.error({ err: e instanceof Error ? e.message : String(e), databaseId: row.id, kind: e instanceof EngineError ? e.kind : "unknown" }, "keep awake failed in the engine");
        failed.push(row.id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, live.length) }, worker));

  await s.db.tx(caller.workspaceId, async (c) => {
    if (done.length) {
      await c.query(
        `update public.databases set keep_awake = $3,
                state = case when $3 then 'awake'::public.database_state else state end
         where workspace_id = $1 and id = any($2::uuid[])`,
        [caller.workspaceId, done, enabled],
      );
    }
    await writeAudit(c, auditWho(caller), {
      action: enabled ? "database.keep_awake.pin" : "database.keep_awake.unpin",
      outcome: failed.length ? "failed" : "ok",
      metadata: { databases: done.length, failed: failed.length },
    });
  });
  if (failed.length) throw internal(`${failed.length} of ${live.length} databases could not be updated. Try again.`);
  return { affected: done.length };
}
