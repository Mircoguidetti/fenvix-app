import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Catalogue, type Limits, loadJson, parseCatalogue, parseLimits } from "./limits.ts";
import { type EngineUserKey, parseEngineUserKey, sameSecret } from "./engine/credentials.ts";

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

/**
 * How the Data Explorer reaches the engine's MongoDB listener (not the admin interface). Every value comes from the
 * environment; the credentials are never logged, never put in an error and never sent to a browser.
 */
export interface DataSettings {
  /** `mongo`: the official driver against `endpoints`; `fake`: in memory (only with ENGINE_DRIVER=fake); `off`: not set up. */
  driver: "mongo" | "fake" | "off";
  /** host:port of the engine's MongoDB listener per region. */
  endpoints: Record<string, string>;
  username: string | undefined;
  /** Secret. */
  password: string | undefined;
  authMechanism: "SCRAM-SHA-256" | "SCRAM-SHA-1";
  authSource: string;
  tls: boolean;
  /** PEM file of the CA that signs the engine's certificate (path; the driver reads it). */
  tlsCaFile: string | undefined;
  /** Name to check the engine's certificate against when it differs from the host. */
  tlsServerName: string | undefined;
  /** Development only: allows no TLS and no credentials. Refused with NODE_ENV=production. */
  insecureLocal: boolean;
  poolMax: number;
  /** A connection unused this long is closed by the driver. */
  poolIdleMs: number;
  /** The whole client (and its monitoring connections) is closed after this long without a Data Explorer request. */
  clientIdleCloseMs: number;
  connectTimeoutMs: number;
  /** maxTimeMS of each command on the engine; the client gives up a little later. */
  commandTimeoutMs: number;
  /** maxTimeMS of a find whose filter has a $regex (a bad pattern costs engine CPU until it stops). */
  regexTimeoutMs: number;
  /**
   * true: every database is reached as its own engine user (`cp_<hex>`, password derived from ENGINE_USER_KEY); there
   * is no shared credential. false: the shared DATA_ENGINE_USERNAME (or none, local development only).
   */
  perDatabaseUsers: boolean;
  /** Per-database users need one driver client per database: at most this many are kept open. */
  maxClients: number;
  defaultPageSize: number;
  maxPageSize: number;
  maxSkip: number;
  /** BSON size of a document a browser may insert or save. */
  maxDocumentBytes: number;
  /** Total size of the documents in one answer; a page stops early when it is reached. */
  maxResponseBytes: number;
  ratePerMinute: number;
  writeRatePerMinute: number;
}

/**
 * Per-database engine users (docs/data-explorer-security.md). The master key derives each database's password; the
 * provisioner is the engine user that creates and drops those users on the MongoDB listener. They are separate
 * secrets from each other and from the admin token, and the Data Explorer never receives the provisioner.
 */
export interface EngineUserSettings {
  /** ENGINE_USER_KEY: the key new passwords are made with. Secret. */
  current: EngineUserKey;
  /** ENGINE_USER_KEY_PREVIOUS: during a rotation, the key some users still have. Secret. */
  previous: EngineUserKey | null;
  /** The engine's administrative user for createUser / dropUser / updateUser / usersInfo. Secret. */
  provisioner: { username: string; password: string; authSource: string };
  /** How often the users on the engine are compared with Postgres (orphans dropped, missing ones made). 0: never. */
  sweepSeconds: number;
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
  data: DataSettings;
  /** Set when ENGINE_USER_KEY is. Required with ENGINE_DRIVER=real when the Data Explorer is on. */
  engineUsers: EngineUserSettings | null;
  operationWaitMs: number;
  operationSweepSeconds: number;
  usageSyncSeconds: number;
  hourlyRetentionDays: number;
  operationRetentionDays: number;
  rateLimitPerMinute: number;
  rateLimitAnonPerMinute: number;
  /** Requests per minute for each public API key (fvx_), on top of the workspace's limit. docs/public-api.md */
  publicApiRateLimitPerMinute: number;
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

/** Hard ceilings the environment cannot raise. */
export const DATA_HARD_MAX_PAGE_SIZE = 100;
/** Below Fastify's request body limit (256 KiB), which also covers the JSON around the document. */
export const DATA_HARD_MAX_DOCUMENT_BYTES = 200 * 1024;

function bounded(env: Env, name: string, fallback: number, min: number, max: number): number {
  const n = int(env, name, fallback, min);
  if (n > max) throw new Error(`${name} must be at most ${max}`);
  return n;
}

/**
 * Data Explorer settings. Safe defaults: TLS on, SCRAM-SHA-256, credentials required. Turning either off needs
 * DATA_ENGINE_INSECURE_LOCAL=true, which refuses to start in production.
 */
export function dataSettings(env: Env, nodeEnv: string, engineDriver: string, regions: string[]): DataSettings {
  const insecureLocal = env.DATA_ENGINE_INSECURE_LOCAL === "true";
  if (insecureLocal && nodeEnv === "production") throw new Error("DATA_ENGINE_INSECURE_LOCAL=true is for local development only and is refused with NODE_ENV=production");
  const raw = list(env, "DATA_ENGINE_ENDPOINTS", []);
  const endpoints: Record<string, string> = {};
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    const region = eq > 0 ? entry.slice(0, eq).trim() : (regions.length === 1 ? regions[0]! : "");
    const addr = eq > 0 ? entry.slice(eq + 1).trim() : entry;
    if (!region) throw new Error(`DATA_ENGINE_ENDPOINTS: "${entry}" needs a region (region=host:port) because REGIONS lists more than one`);
    if (!regions.includes(region)) throw new Error(`DATA_ENGINE_ENDPOINTS: "${region}" is not in REGIONS`);
    if (endpoints[region]) throw new Error(`DATA_ENGINE_ENDPOINTS: region ${region} is listed twice`);
    // host:port only: no scheme, no credentials, no options. Credentials and TLS have their own settings.
    if (!/^[A-Za-z0-9.-]{1,253}:\d{1,5}$/.test(addr) && !/^\[[0-9A-Fa-f:.]{2,45}\]:\d{1,5}$/.test(addr)) {
      throw new Error(`DATA_ENGINE_ENDPOINTS: ${region}: write host:port (no mongodb://, no user, no options)`);
    }
    const port = Number(addr.slice(addr.lastIndexOf(":") + 1));
    if (port < 1 || port > 65535) throw new Error(`DATA_ENGINE_ENDPOINTS: ${region}: the port is out of range`);
    endpoints[region] = addr;
  }
  const driver: DataSettings["driver"] = raw.length > 0 ? "mongo" : engineDriver === "fake" ? "fake" : "off";
  if (driver === "mongo") {
    const missing = regions.filter((r) => !endpoints[r]);
    if (missing.length) throw new Error(`DATA_ENGINE_ENDPOINTS: no address for region ${missing.join(", ")}`);
  }

  const username = env.DATA_ENGINE_USERNAME?.trim() || undefined;
  const password = (env.DATA_ENGINE_PASSWORD ?? fileText(env, "DATA_ENGINE_PASSWORD_FILE") ?? "").replace(/\r?\n$/, "") || undefined;
  if (!!username !== !!password) throw new Error("DATA_ENGINE_USERNAME and DATA_ENGINE_PASSWORD (or DATA_ENGINE_PASSWORD_FILE) go together");
  const perDatabaseUsers = !!(env.ENGINE_USER_KEY || env.ENGINE_USER_KEY_FILE);
  if (perDatabaseUsers && username) {
    throw new Error("DATA_ENGINE_USERNAME cannot be set together with ENGINE_USER_KEY: with per-database users the Data Explorer has no shared credential");
  }
  const tlsRaw = env.DATA_ENGINE_TLS ?? "true";
  if (tlsRaw !== "true" && tlsRaw !== "false") throw new Error('DATA_ENGINE_TLS must be "true" or "false"');
  const tls = tlsRaw === "true";
  if (driver === "mongo") {
    if (!tls && !insecureLocal) throw new Error("DATA_ENGINE_TLS=false needs DATA_ENGINE_INSECURE_LOCAL=true (local development only)");
    if (!username && !perDatabaseUsers && !insecureLocal) throw new Error("ENGINE_USER_KEY (one engine user per database) is required for the Data Explorer (SCRAM); DATA_ENGINE_USERNAME (one shared credential) is accepted outside production only, and only DATA_ENGINE_INSECURE_LOCAL=true allows none");
    if (username && !perDatabaseUsers && nodeEnv === "production") throw new Error("DATA_ENGINE_USERNAME (one credential for every database) is refused in production: set ENGINE_USER_KEY so each database is reached as its own engine user");
  }
  const mech = env.DATA_ENGINE_AUTH_MECHANISM ?? "SCRAM-SHA-256";
  if (mech !== "SCRAM-SHA-256" && mech !== "SCRAM-SHA-1") throw new Error('DATA_ENGINE_AUTH_MECHANISM must be "SCRAM-SHA-256" or "SCRAM-SHA-1"');
  const authSource = env.DATA_ENGINE_AUTH_SOURCE || "admin";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(authSource)) throw new Error("DATA_ENGINE_AUTH_SOURCE is not a valid database name");
  const tlsCaFile = env.DATA_ENGINE_TLS_CA_FILE || undefined;
  if (tlsCaFile) fileText(env, "DATA_ENGINE_TLS_CA_FILE");

  const maxPageSize = bounded(env, "DATA_MAX_PAGE_SIZE", DATA_HARD_MAX_PAGE_SIZE, 1, DATA_HARD_MAX_PAGE_SIZE);
  const defaultPageSize = bounded(env, "DATA_DEFAULT_PAGE_SIZE", 25, 1, maxPageSize);
  const commandTimeoutMs = bounded(env, "DATA_COMMAND_TIMEOUT_MS", 10_000, 100, 60_000);
  return {
    driver, endpoints, username, password, authMechanism: mech, authSource, tls, tlsCaFile, perDatabaseUsers,
    regexTimeoutMs: Math.min(bounded(env, "DATA_REGEX_TIMEOUT_MS", 2000, 100, 60_000), commandTimeoutMs),
    maxClients: bounded(env, "DATA_ENGINE_MAX_CLIENTS", 100, 1, 10_000),
    tlsServerName: env.DATA_ENGINE_TLS_SERVER_NAME || undefined,
    insecureLocal,
    poolMax: bounded(env, "DATA_ENGINE_POOL_MAX", 5, 1, 50),
    poolIdleMs: bounded(env, "DATA_ENGINE_POOL_IDLE_MS", 30_000, 1000, 600_000),
    clientIdleCloseMs: bounded(env, "DATA_ENGINE_CLIENT_IDLE_CLOSE_MS", 60_000, 1000, 3_600_000),
    connectTimeoutMs: bounded(env, "DATA_ENGINE_CONNECT_TIMEOUT_MS", 5000, 100, 60_000),
    commandTimeoutMs,
    defaultPageSize,
    maxPageSize,
    maxSkip: bounded(env, "DATA_MAX_SKIP", 10_000, 0, 100_000),
    maxDocumentBytes: bounded(env, "DATA_MAX_DOCUMENT_BYTES", 192 * 1024, 1024, DATA_HARD_MAX_DOCUMENT_BYTES),
    maxResponseBytes: bounded(env, "DATA_MAX_RESPONSE_BYTES", 4 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024),
    ratePerMinute: bounded(env, "DATA_RATE_LIMIT_PER_MINUTE", 120, 1, 100_000),
    writeRatePerMinute: bounded(env, "DATA_WRITE_RATE_LIMIT_PER_MINUTE", 30, 1, 100_000),
  };
}

function secretText(env: Env, name: string): string | undefined {
  const v = env[name] ?? fileText(env, `${name}_FILE`);
  return v === undefined || v === "" ? undefined : v.replace(/\r?\n$/, "");
}

/**
 * Per-database engine users: the master key (current and, during a rotation, previous) and the provisioner. Null
 * when ENGINE_USER_KEY is not set.
 */
export function engineUserSettings(env: Env, data: DataSettings, adminToken: string | undefined): EngineUserSettings | null {
  const raw = secretText(env, "ENGINE_USER_KEY");
  if (raw === undefined) {
    if (secretText(env, "ENGINE_USER_KEY_PREVIOUS") !== undefined) throw new Error("ENGINE_USER_KEY_PREVIOUS needs ENGINE_USER_KEY");
    return null;
  }
  const current = parseEngineUserKey(raw, "ENGINE_USER_KEY");
  const prevRaw = secretText(env, "ENGINE_USER_KEY_PREVIOUS");
  const previous = prevRaw === undefined ? null : parseEngineUserKey(prevRaw, "ENGINE_USER_KEY_PREVIOUS");
  if (previous && previous.version === current.version) throw new Error("ENGINE_USER_KEY_PREVIOUS must have another version than ENGINE_USER_KEY");
  if (previous && sameSecret(previous.secret, current.secret)) throw new Error("ENGINE_USER_KEY_PREVIOUS must be another secret than ENGINE_USER_KEY");
  if (data.driver !== "mongo") throw new Error("ENGINE_USER_KEY needs DATA_ENGINE_ENDPOINTS: the users are made on the engine's MongoDB listener");
  const username = env.ENGINE_PROVISIONER_USERNAME?.trim();
  const password = secretText(env, "ENGINE_PROVISIONER_PASSWORD");
  if (!username || !password) throw new Error("ENGINE_PROVISIONER_USERNAME and ENGINE_PROVISIONER_PASSWORD (or ENGINE_PROVISIONER_PASSWORD_FILE) are required with ENGINE_USER_KEY: the engine user that creates and drops the per-database users");
  if (/^cp_/.test(username)) throw new Error("ENGINE_PROVISIONER_USERNAME must not start with cp_ (that prefix is for per-database users)");
  const authSource = env.ENGINE_PROVISIONER_AUTH_SOURCE || "admin";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(authSource)) throw new Error("ENGINE_PROVISIONER_AUTH_SOURCE is not a valid database name");
  // One secret, one purpose: a leak of one must not open the others.
  const secrets = [current.secret, ...(previous ? [previous.secret] : [])];
  const others = [Buffer.from(password, "utf8"), ...(adminToken ? [Buffer.from(adminToken, "utf8")] : [])];
  for (const a of secrets) for (const b of others) if (sameSecret(a, b)) throw new Error("ENGINE_USER_KEY must be its own secret: not the admin token and not the provisioner's password");
  if (adminToken && password === adminToken) throw new Error("ENGINE_PROVISIONER_PASSWORD must be its own secret, not the admin token");
  return { current, previous, provisioner: { username, password, authSource }, sweepSeconds: int(env, "ENGINE_USER_SWEEP_SECONDS", 3600) };
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
    data: dataSettings(env, nodeEnv, required(env, "ENGINE_DRIVER"), regions),
    engineUsers: null,
    operationWaitMs: int(env, "OPERATION_WAIT_MS", 20000),
    operationSweepSeconds: int(env, "OPERATION_SWEEP_SECONDS", 15),
    usageSyncSeconds: int(env, "USAGE_SYNC_SECONDS", 0),
    hourlyRetentionDays: int(env, "HOURLY_RETENTION_DAYS", 8, 2),
    operationRetentionDays: int(env, "OPERATION_RETENTION_DAYS", 90, 1),
    rateLimitPerMinute: int(env, "RATE_LIMIT_PER_MINUTE", 600, 1),
    rateLimitAnonPerMinute: int(env, "RATE_LIMIT_ANON_PER_MINUTE", 30, 1),
    publicApiRateLimitPerMinute: int(env, "PUBLIC_API_RATE_LIMIT_PER_MINUTE", 120, 1),
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
  cfg.engineUsers = engineUserSettings(env, cfg.data, cfg.engine?.token);
  if (cfg.engineDriver === "real" && cfg.data.driver === "mongo" && !cfg.engineUsers && !cfg.data.insecureLocal) {
    throw new Error("ENGINE_USER_KEY is required with ENGINE_DRIVER=real and the Data Explorer on: every database gets its own engine user");
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
