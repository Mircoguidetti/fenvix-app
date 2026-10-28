import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Catalogue, type Limits, loadJson, parseCatalogue, parseLimits } from "./limits.ts";

/** Where and how to reach the engine's admin interface. Every value comes from the environment. */
export interface EngineSettings {
  /** Admin interface of the engine of each region. */
  endpoints: Record<string, URL>;
  /** Bearer token of the admin interface. Never logged. */
  token: string;
  /** PEM of the certificate authority to trust for an https admin interface (a private CA or a self-signed certificate). */
  caPem: string | undefined;
  /** Client certificate and key, when the admin interface asks for one. */
  clientCertPem: string | undefined;
  clientKeyPem: string | undefined;
  /** Name to check the server certificate against when it differs from the host in the URL. */
  tlsServerName: string | undefined;
  requestTimeoutMs: number;
  /** Fork, restore, export and erase work on the whole database and can take long. */
  longRequestTimeoutMs: number;
  forkMode: "clone" | "copy";
  /** Restore points: window and interval set on every new or forked database; null leaves the engine's default. */
  retentionWindowSecs: number | null;
  retentionIntervalSecs: number | null;
}

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
  /** What follows the port in a connection string: the user's name, or the name the engine knows the database by. */
  connectionDbName: "name" | "engine";
  regions: string[];
  /** Public URL of this API including /v1, for the OAuth callback and download links. */
  apiPublicUrl: string;
  dashboardOrigins: string[];
  cookieSecure: boolean;
  cookieDomain: string | undefined;
  /** Key that signs 15 minute download links (usage CSV, invoice PDF). */
  downloadSigningKey: string;
  engineDriver: string;
  /** Set when ENGINE_DRIVER=real. */
  engine: EngineSettings | null;
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

function fileText(env: Env, name: string): string | undefined {
  const path = env[name];
  if (!path) return undefined;
  try { return readFileSync(path, "utf8"); } catch (e) { throw new Error(`${name}: cannot read ${path} (${e instanceof Error ? (e as NodeJS.ErrnoException).code ?? e.message : String(e)})`); }
}

/**
 * Settings of the real engine adapter. Nothing here has a default for an address, a port, a certificate or a
 * secret: they differ per deployment and are never written in the code.
 */
function engineSettings(env: Env, regions: string[], nodeEnv: string): EngineSettings {
  const raw = list(env, "ENGINE_ADMIN_ENDPOINTS", []);
  if (raw.length === 0) throw new Error("ENGINE_ADMIN_ENDPOINTS is required with ENGINE_DRIVER=real: the admin address of the engine, as region=url (for example eu-central-1=https://engine.internal:PORT), or just the url when there is one region");
  const endpoints: Record<string, URL> = {};
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    const hasRegion = eq > 0 && !entry.slice(0, eq).includes(":");
    const region = hasRegion ? entry.slice(0, eq).trim() : (regions.length === 1 ? regions[0]! : "");
    const url = hasRegion ? entry.slice(eq + 1).trim() : entry;
    if (!region) throw new Error(`ENGINE_ADMIN_ENDPOINTS: "${entry}" needs a region (region=url) because REGIONS lists more than one`);
    if (!regions.includes(region)) throw new Error(`ENGINE_ADMIN_ENDPOINTS: "${region}" is not in REGIONS`);
    if (endpoints[region]) throw new Error(`ENGINE_ADMIN_ENDPOINTS: region ${region} is listed twice`);
    let u: URL;
    try { u = new URL(url); } catch { throw new Error(`ENGINE_ADMIN_ENDPOINTS: "${url}" is not a URL`); }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`ENGINE_ADMIN_ENDPOINTS: ${region} must be http:// or https://`);
    if (u.username || u.password) throw new Error("ENGINE_ADMIN_ENDPOINTS: put no credentials in the URL; the token has its own setting");
    if (u.pathname !== "/" || u.search || u.hash) throw new Error(`ENGINE_ADMIN_ENDPOINTS: ${region}: write the address without a path`);
    if (u.protocol === "http:" && nodeEnv === "production" && env.ENGINE_ADMIN_ALLOW_PLAIN_HTTP !== "true") {
      throw new Error(`ENGINE_ADMIN_ENDPOINTS: ${region} is plain http. The engine's admin interface has no TLS of its own; in production either put a TLS terminator in front or set ENGINE_ADMIN_ALLOW_PLAIN_HTTP=true to state that the path to it is private`);
    }
    endpoints[region] = u;
  }
  const missing = regions.filter((r) => !endpoints[r]);
  if (missing.length) throw new Error(`ENGINE_ADMIN_ENDPOINTS: no address for region ${missing.join(", ")}`);

  const token = (env.ENGINE_ADMIN_TOKEN ?? fileText(env, "ENGINE_ADMIN_TOKEN_FILE") ?? "").trim();
  if (token.length < 16) throw new Error("ENGINE_ADMIN_TOKEN (or ENGINE_ADMIN_TOKEN_FILE) is required with ENGINE_DRIVER=real and must be at least 16 characters, as the engine requires");

  const clientCertPem = fileText(env, "ENGINE_ADMIN_CLIENT_CERT_FILE");
  const clientKeyPem = fileText(env, "ENGINE_ADMIN_CLIENT_KEY_FILE");
  if (!!clientCertPem !== !!clientKeyPem) throw new Error("ENGINE_ADMIN_CLIENT_CERT_FILE and ENGINE_ADMIN_CLIENT_KEY_FILE go together");

  const forkMode = env.ENGINE_FORK_MODE ?? "clone";
  if (forkMode !== "clone" && forkMode !== "copy") throw new Error('ENGINE_FORK_MODE must be "clone" or "copy"');
  const optional = (name: string, min: number) => (env[name] === undefined || env[name] === "" ? null : int(env, name, 0, min));
  const retentionWindowSecs = optional("ENGINE_RETENTION_WINDOW_SECS", 0);
  const retentionIntervalSecs = optional("ENGINE_RETENTION_INTERVAL_SECS", 1);
  if (retentionWindowSecs === null && retentionIntervalSecs !== null) throw new Error("ENGINE_RETENTION_INTERVAL_SECS needs ENGINE_RETENTION_WINDOW_SECS");
  return {
    endpoints, token, caPem: fileText(env, "ENGINE_ADMIN_CA_FILE"), clientCertPem, clientKeyPem,
    tlsServerName: env.ENGINE_ADMIN_TLS_SERVER_NAME || undefined,
    requestTimeoutMs: int(env, "ENGINE_REQUEST_TIMEOUT_MS", 15_000, 100),
    longRequestTimeoutMs: int(env, "ENGINE_LONG_REQUEST_TIMEOUT_MS", 600_000, 1000),
    forkMode, retentionWindowSecs, retentionIntervalSecs,
  };
}

export const DEFAULT_HOST_TEMPLATE = "<name>.<region>.db.<BASE_DOMAIN>";

function connectionDbName(env: Env): "name" | "engine" {
  const v = env.CONNECTION_DB_NAME ?? "name";
  if (v !== "name" && v !== "engine") throw new Error('CONNECTION_DB_NAME must be "name" or "engine"');
  return v;
}

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
    connectionDbName: connectionDbName(env),
    regions,
    apiPublicUrl,
    dashboardOrigins: origins,
    cookieSecure: (env.COOKIE_SECURE ?? "true") !== "false",
    cookieDomain: env.COOKIE_DOMAIN || undefined,
    downloadSigningKey: required(env, "DOWNLOAD_SIGNING_KEY"),
    engineDriver: required(env, "ENGINE_DRIVER"),
    engine: null,
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
  if (cfg.engineDriver === "real") {
    cfg.engine = engineSettings(env, regions, nodeEnv);
    // The engine has one flat namespace and no say in hostnames: what a customer connects to has to be unique by itself.
    if (env.CONNECTION_PORT === undefined || env.CONNECTION_PORT === "") throw new Error("CONNECTION_PORT is required with ENGINE_DRIVER=real: the port customers reach the engine's MongoDB listener on");
    if (!cfg.baseDomain) throw new Error("BASE_DOMAIN is required with ENGINE_DRIVER=real: hostnames must be complete");
    if (!cfg.hostTemplate.includes("<workspace>")) throw new Error("HOST_TEMPLATE must contain <workspace> with ENGINE_DRIVER=real: the same database name can exist in two workspaces, and the hostname must tell them apart");
    if (cfg.connectionDbName !== "engine") throw new Error("CONNECTION_DB_NAME must be \"engine\" with ENGINE_DRIVER=real: the engine has one namespace for all workspaces, so connection strings must carry the engine's own database name");
  }
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

/** The short code of a workspace used in hostnames: the first 8 hex characters of its id. Same expression as the index in migration 0003. */
export function workspaceCode(workspaceId: string): string {
  return workspaceId.replaceAll("-", "").slice(0, 8).toLowerCase();
}

/** The host a database is reached at, from the template. Empty parts and doubled dots are removed. */
export function renderHost(cfg: Pick<Config, "hostTemplate" | "baseDomain">, vars: { name: string; region: string; workspace: string }): string {
  return cfg.hostTemplate
    .replaceAll("<name>", vars.name)
    .replaceAll("<region>", vars.region)
    .replaceAll("<workspace>", workspaceCode(vars.workspace))
    .replaceAll("<BASE_DOMAIN>", cfg.baseDomain)
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "");
}
