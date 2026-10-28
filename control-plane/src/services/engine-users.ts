import type { Services } from "../context.ts";
import { EngineError } from "../engine/types.ts";

/**
 * The user sweep: the engine's per-database users compared with Postgres, region by region.
 *
 *  - a user whose database has no row in Postgres (any state) is an orphan and is dropped;
 *  - a database that is `ready` or `restoring` without a user gets one (for example a database made before users were
 *    switched on, or a user lost to a failed repair);
 *  - a user whose password was made with another key version than ENGINE_USER_KEY's gets the current one: this is how
 *    a rotation of the master key reaches every database (docs/data-explorer-security.md, "Rotating the master key").
 *
 * Users are listed BEFORE the rows are read. Operations make the row before the user (create, fork) and drop the user
 * before the row (erase), so a user seen here whose row is missing really is an orphan, and a `ready` row whose user was
 * not seen really has none (an erase marks the row `erasing` before it drops the user).
 */
/** `v3` is newer than `v2`; a user without a recorded version is older than any. */
export function olderVersion(have: string | null, current: string): boolean {
  if (have === null) return true;
  const n = (v: string) => Number(v.slice(1));
  return n(have) < n(current);
}

export async function reconcileEngineUsers(s: Services): Promise<{ dropped: number; created: number; rotated: number; failed: number }> {
  let dropped = 0;
  let created = 0;
  let rotated = 0;
  let failed = 0;
  const current = s.users.currentVersion();
  if (current === null) return { dropped, created, rotated, failed }; // per-database users are off
  for (const region of s.cfg.regions) {
    const listed = await s.users.list(region);
    const withUser = new Set(listed.map((u) => u.id));
    const versionOf = new Map(listed.map((u) => [u.id, u.keyVersion]));
    const rows = await s.db.system(async (c) => (await c.query("select id, region, engine_state from public.fenvix_cp_engine_databases() where region = $1", [region])).rows as { id: string; region: string; engine_state: string }[]);
    const known = new Set(rows.map((r) => String(r.id)));
    for (const id of withUser) {
      if (known.has(id)) continue;
      try {
        if ((await s.users.drop(id, region)).dropped) dropped++;
      } catch (e) {
        failed++;
        s.log.warn({ databaseId: id, kind: e instanceof EngineError ? e.kind : "unknown" }, "engine user sweep: could not drop an orphan user");
      }
    }
    for (const r of rows) {
      const id = String(r.id);
      if (r.engine_state !== "ready" && r.engine_state !== "restoring") continue;
      const missing = !withUser.has(id);
      // Only ever forward: an instance not yet restarted with the new key must not move users back to the old one.
      if (!missing && !olderVersion(versionOf.get(id) ?? null, current)) continue;
      try {
        await s.users.ensure(id, region);
        if (missing) created++; else rotated++;
      } catch (e) {
        failed++;
        s.log.warn({ databaseId: id, kind: e instanceof EngineError ? e.kind : "unknown" }, missing ? "engine user sweep: could not make a missing user" : "engine user sweep: could not give a user the current key");
      }
    }
  }
  if (dropped || created || rotated || failed) s.log.info({ engineUsers: { dropped, created, rotated, failed } }, "engine user sweep");
  return { dropped, created, rotated, failed };
}
