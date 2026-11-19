// The founder's Supabase connection string (SUPABASE_DB_URL: the SSM parameter /fenvix/prod/bootstrap/supabase-db-url) and the connection strings of
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
  if (!raw || !raw.trim()) throw new Stop("SUPABASE_DB_URL is missing: the SSM parameter /fenvix/prod/bootstrap/supabase-db-url (AWS console → Systems Manager → Parameter Store). docs/DEPLOY-AWS.md, section A step 2.");
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

/**
 * The optional SUPABASE_CA_CERT (SSM /fenvix/prod/bootstrap/supabase-ca-cert): Supabase's CA certificate (public; Project Settings → Database →
 * SSL Configuration → Download certificate), PEM. Returns it, or null when unset; refuses anything else.
 */
export function parseCaCert(raw) {
  const pem = (raw ?? "").trim();
  if (!pem) return null;
  if (!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(pem)) throw new Stop("SUPABASE_CA_CERT is set but is not a PEM certificate (-----BEGIN CERTIFICATE----- ... -----END CERTIFICATE-----). Paste the whole downloaded file, or delete the parameter.");
  return pem;
}

/**
 * node-postgres options for the admin connection. TLS to the pooler: with SUPABASE_CA_CERT (`ca`), verified like libpq's
 * sslmode=verify-full (the chain must end at that CA and the certificate must name the pooler's host: a man in the
 * middle cannot receive the admin password); without it, encrypted only (sslmode=require), see roleUrl.
 */
export function adminClientConfig(a, { ca = null } = {}) {
  return {
    host: a.host, port: a.port, database: a.database, user: a.user, password: a.password,
    ssl: a.kind === "supabase" ? (ca ? { ca, rejectUnauthorized: true, servername: a.host } : { rejectUnauthorized: false }) : false,
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

/**
 * The key the dashboard is built with (SUPABASE_ANON_KEY → VITE_SUPABASE_ANON_KEY, public: every browser receives it).
 * Supabase shows it next to the service_role key and the secret key, which bypass row level security: a wrong paste
 * would publish one of those. Accepted: a publishable key (sb_publishable_...) or a JWT whose role is "anon" and whose
 * project ref, if it has one, is the project of SUPABASE_DB_URL. Every message names the variable, never the value.
 * Returns what was accepted ("publishable" or "anon JWT").
 */
export function checkAnonKey(raw, ref) {
  const key = (raw ?? "").trim();
  const where = "Supabase → Project Settings → API Keys";
  if (key.startsWith("sb_secret_")) throw new Stop(`SUPABASE_ANON_KEY holds a SECRET key (sb_secret_...), which bypasses row level security and would be published in the dashboard. Nothing was deployed. Put the publishable or anon key there instead (${where}), and roll the secret key in Supabase: it was stored where it is readable.`);
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return "publishable";
  const parts = key.split(".");
  let payload = null;
  if (parts.length === 3) {
    try { payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { payload = null; }
  }
  if (!payload || typeof payload !== "object") throw new Stop(`SUPABASE_ANON_KEY is neither a publishable key (sb_publishable_...) nor the anon JWT (${where}). Nothing was deployed.`);
  if (payload.role !== "anon") {
    const what = payload.role === "service_role" ? "the service_role key, which bypasses row level security" : "a key whose role is not anon";
    throw new Stop(`SUPABASE_ANON_KEY holds ${what}; it would be published in the dashboard. Nothing was deployed. Put the anon key there instead (${where})${payload.role === "service_role" ? ", and roll the JWT secret in Supabase: the service_role key was stored where it is readable" : ""}.`);
  }
  if (ref && payload.ref && payload.ref !== ref) throw new Stop(`SUPABASE_ANON_KEY belongs to another Supabase project than SUPABASE_DB_URL (the project refs differ): every dashboard call would answer 401. Nothing was deployed. Copy both from the same project.`);
  return "anon JWT";
}
