import type { Caller, Services } from "../context.ts";
import { notFound } from "../errors.ts";
import { isUuid } from "../validate.ts";
import { DATABASE_COLUMNS, type Database, filterSql, toDatabase } from "./databases.ts";
import { CURSOR_AT, encodeCursor } from "./apikeys.ts";

/**
 * What the public API reads about databases (docs/public-api.md). The same rows, columns and `toDatabase` as the
 * dashboard (services/databases.ts), with keyset (cursor) pages instead of numbered ones, and the database's `status`.
 */

export type PublicDatabase = Database & { status: "ready" | "restoring" | "erasing" };

const COLUMNS = `${DATABASE_COLUMNS}, d.engine_state, ${CURSOR_AT("d.created_at")} as cursor_at`;
const NOT_FOUND = "That database does not exist.";

const toPublic = (s: Services, r: Record<string, unknown>): PublicDatabase =>
  ({ ...toDatabase(s, r), status: r.engine_state as PublicDatabase["status"] });

/** Newest first. Databases still being created are not listed (as on the dashboard). */
export async function listDatabases(s: Services, caller: Caller, q: { limit: number; cursor: { at: string; id: string } | null }) {
  return s.db.tx(caller.workspaceId, async (c) => {
    const params: unknown[] = [caller.workspaceId];
    let where = filterSql({ tags: [] }, params);
    if (q.cursor) where += ` and (d.created_at, d.id) < ($${params.push(q.cursor.at)}::timestamptz, $${params.push(q.cursor.id)}::uuid)`;
    const rows = (await c.query(
      `select ${COLUMNS} from public.databases d where d.workspace_id = $1 and ${where}
       order by d.created_at desc, d.id desc limit $${params.push(q.limit + 1)}`, params)).rows;
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page.map((r) => toPublic(s, r)), nextCursor: rows.length > q.limit && last ? encodeCursor(String(last.cursor_at), String(last.id)) : null };
  });
}

export async function findDatabase(s: Services, caller: Caller, id: unknown): Promise<PublicDatabase | null> {
  if (!isUuid(id)) return null;
  return s.db.tx(caller.workspaceId, async (c) => {
    const r = (await c.query(
      `select ${COLUMNS} from public.databases d where d.workspace_id = $1 and d.id = $2 and d.engine_state <> 'provisioning'`,
      [caller.workspaceId, id.toLowerCase()])).rows[0];
    return r ? toPublic(s, r) : null;
  });
}

export async function getDatabase(s: Services, caller: Caller, id: unknown): Promise<PublicDatabase> {
  const d = await findDatabase(s, caller, id);
  if (!d) throw notFound(NOT_FOUND);
  return d;
}
