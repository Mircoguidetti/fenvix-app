import { fileURLToPath } from "node:url";
import { type Catalogue, type Limits, loadJson, parseCatalogue, parseLimits } from "./limits.ts";

export interface Config {
  port: number;
  host: string;
  logLevel: string;
  nodeEnv: string;
  /** Connection string of the restricted role fenvix_control_plane. Never logged. */
  databaseUrl: string;
  supabaseUrl: string;
  /** Where Supabase publishes the keys that sign session tokens. */
  supabaseJwksUrl: string;
  /** The public (anon) key, used only to call Supabase Auth. Not a secret and not the service_role key. */
  supabaseAnonKey: string;
  baseDomain: string;
  hostTemplate: string;
  connectionPort: number;
  regions: string[];
  /** Public URL of this API including /v1, for the OAuth callback and download links. */
  apiPublicUrl: string;
  dashboardOrigins: string[];
  cookieSecure: boolean;
  cookieDomain: string | undefined;
  /** Key that signs 15 minute download links (usage CSV, invoice PDF). */
  downloadSigningKey: string;
  engineDriver: string;
  operationWaitMs: number;
  operationSweepSeconds: number;
  usageSyncSeconds: number;
  hourlyRetentionDays: number;
  operationRetentionDays: number;
  rateLimitPerMinute: number;
  rateLimitAnonPerMinute: number;
  trustProxy: boolean;
  dbPoolMax: number;
  dbStatementTimeoutMs: number;
  limits: Limits;
  catalogue: Catalogue;
}

type Env = Record<string, string | undefined>;

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

function int(env: Env, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer of ${min} or more`);
  return n;
}

function list(env: Env, name: string, fallback: string[]): string[] {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export const DEFAULT_HOST_TEMPLATE = "<name>.<region>.db.<BASE_DOMAIN>";

/** Reads the settings from environment variables. Throws a readable error listing what is missing or wrong. */
export function loadConfig(env: Env = process.env): Config {
  const nodeEnv = env.NODE_ENV ?? "development";
  const regions = list(env, "REGIONS", ["eu-central-1"]);
  for (const r of regions) if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(r)) throw new Error(`REGIONS: "${r}" is not a valid region name`);
  const origins = list(env, "DASHBOARD_ORIGINS", []);
  for (const o of origins) {
    let u: URL;
    try { u = new URL(o); } catch { throw new Error(`DASHBOARD_ORIGINS: "${o}" is not a URL`); }
    if (u.origin !== o) throw new Error(`DASHBOARD_ORIGINS: write "${u.origin}" (no path, no trailing slash)`);
  }
  const apiPublicUrl = required(env, "API_PUBLIC_URL").replace(/\/+$/, "");
  try { new URL(apiPublicUrl); } catch { throw new Error("API_PUBLIC_URL must be a full URL such as https://api.example.com/v1"); }
  const supabaseUrl = required(env, "SUPABASE_URL").replace(/\/+$/, "");
  const cfg: Config = {
    port: int(env, "PORT", 3000, 1),
    host: env.HOST ?? "0.0.0.0",
    logLevel: env.LOG_LEVEL ?? "info",
    nodeEnv,
    databaseUrl: required(env, "CONTROL_PLANE_DATABASE_URL"),
    supabaseUrl,
    supabaseJwksUrl: env.SUPABASE_JWKS_URL || `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
    supabaseAnonKey: required(env, "SUPABASE_ANON_KEY"),
    baseDomain: (env.BASE_DOMAIN ?? "").trim().replace(/^\.+|\.+$/g, ""),
    hostTemplate: env.HOST_TEMPLATE?.trim() || DEFAULT_HOST_TEMPLATE,
    connectionPort: int(env, "CONNECTION_PORT", 27017, 1),
    regions,
    apiPublicUrl,
    dashboardOrigins: origins,
    cookieSecure: (env.COOKIE_SECURE ?? "true") !== "false",
    cookieDomain: env.COOKIE_DOMAIN || undefined,
    downloadSigningKey: required(env, "DOWNLOAD_SIGNING_KEY"),
    engineDriver: required(env, "ENGINE_DRIVER"),
    operationWaitMs: int(env, "OPERATION_WAIT_MS", 20000),
    operationSweepSeconds: int(env, "OPERATION_SWEEP_SECONDS", 15),
    usageSyncSeconds: int(env, "USAGE_SYNC_SECONDS", 0),
    hourlyRetentionDays: int(env, "HOURLY_RETENTION_DAYS", 8, 2),
    operationRetentionDays: int(env, "OPERATION_RETENTION_DAYS", 90, 1),
    rateLimitPerMinute: int(env, "RATE_LIMIT_PER_MINUTE", 600, 1),
    rateLimitAnonPerMinute: int(env, "RATE_LIMIT_ANON_PER_MINUTE", 30, 1),
    trustProxy: env.TRUST_PROXY === "true",
    dbPoolMax: int(env, "DB_POOL_MAX", 10, 1),
    dbStatementTimeoutMs: int(env, "DB_STATEMENT_TIMEOUT_MS", 30000, 1000),
    limits: parseLimits(loadJson(env.LIMITS_FILE ?? here("../config/limits.json")), "limits"),
    catalogue: parseCatalogue(loadJson(env.PLANS_FILE ?? here("../config/plans.json")), "plans"),
  };
  if (cfg.downloadSigningKey.length < 32) throw new Error("DOWNLOAD_SIGNING_KEY must be at least 32 characters");
  if (cfg.nodeEnv === "production") {
    if (!cfg.apiPublicUrl.startsWith("https://")) throw new Error("API_PUBLIC_URL must be an https:// URL in production");
    if (!cfg.cookieSecure) throw new Error("COOKIE_SECURE=false is not allowed in production");
    // Behind a load balancer every client has the load balancer's address unless this is true, and
    // the per-address limits would then be shared by everyone. Make the choice explicit.
    if (env.TRUST_PROXY !== "true" && env.TRUST_PROXY !== "false") throw new Error("TRUST_PROXY must be set to true (behind a load balancer) or false in production");
    if (cfg.dashboardOrigins.length === 0) throw new Error("DASHBOARD_ORIGINS is required in production");
  }
  return cfg;
}

/** The host a database is reached at, from the template. Empty parts and doubled dots are removed. */
export function renderHost(cfg: Pick<Config, "hostTemplate" | "baseDomain">, vars: { name: string; region: string; workspace: string }): string {
  return cfg.hostTemplate
    .replaceAll("<name>", vars.name)
    .replaceAll("<region>", vars.region)
    .replaceAll("<workspace>", vars.workspace.replaceAll("-", "").slice(0, 8))
    .replaceAll("<BASE_DOMAIN>", cfg.baseDomain)
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "");
}
