import { readFileSync } from "node:fs";

/**
 * The dashboard API's settings (docs/DEPLOY-AWS.md, "The dashboard API"). Two secrets only: the connection string of
 * the restricted role fenvix_api and the key that signs the installation link's state. The API never holds the App's
 * private key, the webhook secret, the OAuth client secret or a runner token.
 */
export interface ApiConfig {
  nodeEnv: string;
  logLevel: string;
  port: number;
  host: string;
  /** Postgres URL of the role fenvix_api, through the Supabase pooler in transaction mode (port 6543). Secret. */
  databaseUrl: string;
  dbPoolMax: number;
  supabaseUrl: string;
  supabaseJwksUrl: string;
  /** Signs the installation link's state (the same key as the App's /github/setup). Secret. */
  stateSigningKey: string;
  /** The dashboard: invitation links, and the CORS origin. */
  dashboardUrl: string;
  /** Origins the browser may call the API from: the dashboard's, plus API_CORS_ORIGINS (comma separated). */
  corsOrigins: string[];
  /** The App's URL name; empty while the GitHub App is not configured (the GitHub operations then answer 503). */
  appSlug: string;
  /** False while the GitHub App is not configured (GITHUB_APP_SLUG empty). */
  githubConfigured: boolean;
  webUrl: string;
  /**
   * The fenvix regions that have machines (FENVIX_MACHINE_REGIONS, e.g. "eu"; the stack sets it from RUNNER_PLACEMENT).
   * An organization may choose only one of these: a region without machines would leave its jobs queued (G-0190).
   */
  machineRegions: ("us" | "eu")[];
}

type Env = Record<string, string | undefined>;

function secret(env: Env, name: string, minLength = 1): string {
  let v = env[name];
  const file = env[`${name}_FILE`];
  if ((v === undefined || v === "") && file) {
    try { v = readFileSync(file, "utf8"); } catch (e) { throw new Error(`${name}_FILE: cannot read ${file} (${(e as NodeJS.ErrnoException).code ?? "error"})`); }
  }
  v = (v ?? "").trim();
  if (!v) throw new Error(`${name} (or ${name}_FILE) is required`);
  if (v.length < minLength) throw new Error(`${name} must be at least ${minLength} characters`);
  return v;
}

function url(env: Env, name: string, fallback: string | undefined, nodeEnv: string): string {
  const raw = (env[name] ?? fallback ?? "").trim();
  if (!raw) throw new Error(`${name} is required`);
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`${name}: "${raw}" is not a URL`); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && nodeEnv !== "production")) throw new Error(`${name} must be https:// (plain http only outside production)`);
  if (u.username || u.password) throw new Error(`${name}: put no credentials in the URL`);
  return raw.replace(/\/+$/, "");
}

function int(env: Env, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer of ${min} or more`);
  return n;
}

/** "eu", "us,eu"; unset means "eu" (the only fleet: eu-west-1, audit G-0185). */
export function machineRegions(raw: string | undefined): ("us" | "eu")[] {
  const list = (raw ?? "eu").split(",").map((x) => x.trim()).filter(Boolean);
  for (const r of list) if (r !== "us" && r !== "eu") throw new Error(`FENVIX_MACHINE_REGIONS: unknown region "${r}" (us, eu)`);
  if (!list.length) throw new Error("FENVIX_MACHINE_REGIONS: at least one region");
  return [...new Set(list)] as ("us" | "eu")[];
}

export function loadApiConfig(env: Env = process.env): ApiConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const supabaseUrl = url(env, "SUPABASE_URL", undefined, nodeEnv);
  const dashboardUrl = url(env, "DASHBOARD_URL", undefined, nodeEnv);
  const appSlug = (env.GITHUB_APP_SLUG ?? "").trim();
  if (appSlug && !/^[a-z0-9][a-z0-9-]{0,33}$/.test(appSlug)) throw new Error("GITHUB_APP_SLUG must be the App's URL name (lowercase letters, digits, dashes)");
  const extra = (env.API_CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  const corsOrigins = [...new Set([new URL(dashboardUrl).origin, ...extra.map((o) => {
    let u: URL;
    try { u = new URL(o); } catch { throw new Error(`API_CORS_ORIGINS: "${o}" is not an origin`); }
    if (u.origin !== o.replace(/\/+$/, "")) throw new Error(`API_CORS_ORIGINS: "${o}" is not an origin (scheme://host[:port], no path)`);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && nodeEnv !== "production")) throw new Error("API_CORS_ORIGINS must be https:// origins");
    return u.origin;
  })])];
  return {
    nodeEnv,
    logLevel: env.LOG_LEVEL ?? "info",
    port: int(env, "PORT", 8791, 1),
    host: env.HOST ?? "0.0.0.0",
    databaseUrl: secret(env, "API_DATABASE_URL"),
    dbPoolMax: int(env, "DB_POOL_MAX", 5, 1),
    supabaseUrl,
    supabaseJwksUrl: url(env, "SUPABASE_JWKS_URL", `${supabaseUrl}/auth/v1/.well-known/jwks.json`, nodeEnv),
    stateSigningKey: secret(env, "STATE_SIGNING_KEY", 32),
    dashboardUrl,
    corsOrigins,
    appSlug,
    githubConfigured: appSlug !== "",
    webUrl: url(env, "GITHUB_WEB_URL", "https://github.com", nodeEnv),
    machineRegions: machineRegions(env.FENVIX_MACHINE_REGIONS),
  };
}
