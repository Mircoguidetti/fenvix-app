import type pg from "pg";

/**
 * TLS to Postgres (audit G-2323). The stored connection strings say sslmode=require: encrypted, any certificate
 * accepted. With Supabase's CA certificate (the optional parameter database-ca-cert, DATABASE_CA_CERT), the pool
 * verifies like libpq's verify-full instead: the chain must end at that CA and the certificate must name the host.
 * node-postgres lets the string's sslmode override the `ssl` option, so the string's TLS settings are taken out then.
 */
export function pgTls(connectionString: string, ca: string | undefined): Pick<pg.PoolConfig, "connectionString" | "ssl"> {
  const pem = (ca ?? "").trim();
  if (!pem) return { connectionString };
  if (!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(pem)) throw new Error("DATABASE_CA_CERT is not a PEM certificate");
  const u = new URL(connectionString);
  for (const k of ["sslmode", "uselibpqcompat", "sslrootcert", "sslcert", "sslkey"]) u.searchParams.delete(k);
  return { connectionString: u.toString(), ssl: { ca: pem, rejectUnauthorized: true, servername: u.hostname } };
}
