// The founder's Supabase connection string (the environment secret SUPABASE_DB_URL) and the connection strings of
// the two restricted roles built from it. Lambda and GitHub's runners reach the internet over IPv4 only, and the
// database host db.<ref>.supabase.co answers on IPv6 only: every connection goes through the Supabase pooler.
import { Stop } from "./log.mjs";

const POOLER = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/;

/**
 * The roles the services log in as: the GitHub App (session mode, 5432: it holds a connection across statements) and
 * the dashboard API (transaction mode, 6543: one transaction per request, many short Lambda calls share few
 * connections). The SSM parameter of each holds its whole connection string (SecureString).
 */
export const ROLES = [
  { role: "fenvix_github_app", parameter: "database-url", poolerPort: 5432, mode: "session" },
  { role: "fenvix_api", parameter: "api-database-url", poolerPort: 6543, mode: "transaction" },
];

/**
 * Parses the admin connection string. Supabase: Connect → Session pooler →
 * postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres. A local database (the
 * tests) is accepted when `local` is true: plain role names, the same host and port, no TLS.
 */
export function parseAdminUrl(raw, { local = false } = {}) {
  if (!raw || !raw.trim()) throw new Stop("The environment secret SUPABASE_DB_URL is missing (GitHub → Settings → Environments → production → Environment secrets). docs/DEPLOY-AWS.md, section A step 3.");
  let u;
  try { u = new URL(raw.trim().replace(/^postgres:/, "postgresql:")); } catch { throw new Stop("SUPABASE_DB_URL is not a connection string (postgresql://...). Copy it from Supabase → Connect → Session pooler."); }
  if (u.protocol !== "postgresql:") throw new Stop("SUPABASE_DB_URL must start with postgresql://");
  if (!u.password || u.password.includes("YOUR-PASSWORD")) throw new Stop("SUPABASE_DB_URL has no password: replace [YOUR-PASSWORD] with the database password (Supabase → Project Settings → Database).");
  const database = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
  const host = u.hostname;
  if (/^db\.[a-z0-9]+\.supabase\.co$/.test(host)) {
    throw new Stop("SUPABASE_DB_URL is the direct connection (db.<ref>.supabase.co, IPv6 only, unreachable from GitHub's runners). Use Supabase → Connect → Session pooler instead.");
  }
  if (POOLER.test(host)) {
    const m = /^postgres\.([a-z0-9]{20})$/.exec(decodeURIComponent(u.username));
    if (!m) throw new Stop("SUPABASE_DB_URL: the user must be postgres.<project-ref> (Supabase → Connect → Session pooler).");
    return { kind: "supabase", ref: m[1], host, port: 5432, database, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), supabaseUrl: `https://${m[1]}.supabase.co` };
  }
  if (!local) throw new Stop("SUPABASE_DB_URL must be the Supabase session pooler (aws-0-<region>.pooler.supabase.com). Copy it from Supabase → Connect → Session pooler.");
  return { kind: "local", ref: null, host, port: Number(u.port || 5432), database, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), supabaseUrl: null };
}

/** node-postgres options for the admin connection (TLS to the pooler: encrypted, see roleUrl). */
export function adminClientConfig(a) {
  return {
    host: a.host, port: a.port, database: a.database, user: a.user, password: a.password,
    ssl: a.kind === "supabase" ? { rejectUnauthorized: false } : false,
    application_name: "fenvix-deploy", connectionTimeoutMillis: 20_000, statement_timeout: 0,
  };
}

/**
 * The connection string a service uses for one role. Supabase: the pooler, user <role>.<ref>, the role's pooler mode
 * port, TLS required (libpq's "require": encrypted; the pooler's certificate is not checked against a CA, as
 * libpq does with sslmode=require). Local: the admin's host and port, plain role name, no TLS.
 */
export function roleUrl(a, r, password) {
  if (!/^[A-Za-z0-9_-]{32,}$/.test(password)) throw new Error("role passwords are generated URL-safe (base64url)");
  if (a.kind === "supabase") {
    return `postgresql://${r.role}.${a.ref}:${password}@${a.host}:${r.poolerPort}/${encodeURIComponent(a.database)}?sslmode=require&uselibpqcompat=true`;
  }
  return `postgresql://${r.role}:${password}@${a.host}:${a.port}/${encodeURIComponent(a.database)}`;
}
