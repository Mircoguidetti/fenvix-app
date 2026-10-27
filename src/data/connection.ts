/** Every database answers on this host. The one place the address is written down. */
export const DB_HOST = "db.fenvix.cloud";

export function connectionStringFor(name: string): { host: string; connectionString: string } {
  const host = `${name}.${DB_HOST}`;
  return { host, connectionString: `mongodb://app_user:<password>@${host}:27017/${name.replace(/-/g, "_")}?tls=true` };
}
