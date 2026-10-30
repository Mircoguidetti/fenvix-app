/**
 * Every database answers on this host. The one place the address is written down: `db.fenvix.dev` unless
 * VITE_DB_HOST overrides it (for example for a staging environment), so no other file needs to know the domain.
 */
export const DB_HOST = import.meta.env?.VITE_DB_HOST?.trim() || "db.fenvix.dev";

/**
 * The same shape as the control plane's (control-plane/src/services/databases.ts): the first database user ("app"),
 * the password as a placeholder, the user's authentication database, TLS and SCRAM-SHA-256.
 */
export function connectionStringFor(name: string): { host: string; connectionString: string } {
  const host = `${name}.${DB_HOST}`;
  const db = name.replace(/-/g, "_");
  return { host, connectionString: `mongodb://app:<password>@${host}:27017/${db}?tls=true&authSource=${db}&authMechanism=SCRAM-SHA-256` };
}

/** Port and database name, read back from a connection string (they are not separate fields of a Database). */
export function connectionParts(connectionString: string): { port: string; database: string } {
  const m = /@[^/@]+:(\d+)\/([^?]*)/.exec(connectionString);
  return { port: m?.[1] ?? "", database: m?.[2] ?? "" };
}
