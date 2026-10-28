/**
 * The name a database has inside the engine.
 *
 * The engine has one flat namespace of database names: a Mongo client picks the database with the `$db` of
 * each command, and the hostname plays no part in routing. Names in the control plane are unique per workspace only,
 * so the engine name is derived from the database id (a UUID, unique everywhere) and never from the user's name.
 * The same string is the database name in the connection string (see `CONNECTION_DB_NAME`).
 */
const PREFIX = "db_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^db_[0-9a-f]{32}$/;

export function engineName(id: string): string {
  if (!UUID.test(id)) throw new Error(`not a database id: ${id}`);
  return PREFIX + id.replaceAll("-", "").toLowerCase();
}

export const isEngineName = (name: string): boolean => NAME.test(name);

/** The database id behind an engine name, or null for a name this service did not make. */
export function idFromEngineName(name: string): string | null {
  if (!NAME.test(name)) return null;
  const h = name.slice(PREFIX.length);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
