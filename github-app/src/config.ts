import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_WARMUP, type WarmupSettings } from "./warmup/policy.ts";

/**
 * Every setting comes from the environment. Secrets (the App's private key, the webhook secret, the OAuth client
 * secret, the state signing key, the runner token) are never in the repository, never logged and never put in an
 * error. Each secret can be given inline (NAME) or as a file (NAME_FILE), e.g. a mounted secret.
 * docs/GITHUB-APP.md lists them and says where each one comes from.
 */
export interface Config {
  /**
   * "all": every setting (the HTTP side: webhooks, runner summaries, setup). "worker": what the queue worker and the
   * sweep need; the HTTP-only secrets (webhook secret, OAuth client secret, state signing key, runner tokens) are
   * not read and stay empty, so those functions are never given them (docs/DEPLOY-AWS.md).
   */
  surface: "all" | "worker";
  port: number;
  host: string;
  logLevel: string;
  nodeEnv: string;
  /** Connection string of the restricted role fenvix_github_app. Never logged. */
  databaseUrl: string;
  dbPoolMax: number;

  /** GitHub App settings page: "App ID". */
  appId: number;
  /** The App's URL name: https://github.com/apps/<slug>. */
  appSlug: string;
  /** The App's private key (RS256). Secret. */
  privateKey: KeyObject;
  /** The webhook secret set on the App. Secret. */
  webhookSecret: string;
  /** OAuth client of the App, used once per installation to confirm who installed it. The secret is a secret. */
  clientId: string;
  clientSecret: string;
  /** https://api.github.com (GitHub Enterprise Server: https://HOST/api/v3). */
  apiUrl: string;
  /** https://github.com: links in check runs and comments. */
  webUrl: string;
  /** Where the OAuth code is exchanged (default: webUrl). */
  oauthUrl: string;

  /** The label the onboarding pull request writes into `runs-on:` and the label a fenvix job carries. */
  runsOnLabel: string;
  /** Branch the onboarding pull request comes from. */
  onboardingBranch: string;
  /** Open onboarding pull requests by themselves when the installation covers "All repositories" (default: no). */
  onboardAllRepositories: boolean;

  /** The customer dashboard, for links in check runs, comments and redirects. */
  dashboardUrl: string;
  supabaseUrl: string;
  supabaseJwksUrl: string;
  /** Signs the `state` of the installation link (which organization asked for it). Secret. */
  stateSigningKey: string;
  /**
   * The keys of the per-machine summary credentials (src/runners/credentials.ts): RUNNER_TOKEN signs (the worker, the
   * demo function) and verifies (HTTP); RUNNER_TOKEN_PREVIOUS still verifies during a rotation (HTTP only). No machine
   * ever holds one of these. Secret.
   */
  runnerTokens: string[];
  /** per-job: signs one shared-cache token per job (worker only; CACHE_SIGNING_KEY, RSA PEM). Secret. */
  cacheSigningKey: KeyObject | null;
  /** A completed job whose summary never came is published without it after this long. */
  summaryWaitSeconds: number;
  /** How often the background sweep looks for such jobs (0: never; the tests drive it by hand). */
  sweepSeconds: number;
  /** Warm-up runs (src/warmup/, docs/data-contract.md "Warm-up runs"): the WARMUP_* settings. */
  warmup: WarmupSettings;
  /** How often the node server's warm-up scheduler runs (0: never; on AWS the warm-up Lambda's schedule runs it). */
  warmupTickSeconds: number;
  githubTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer of ${min} or more`);
  return n;
}

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v || v.trim() === "") throw new Error(`${name} is required`);
  return v.trim();
}

/** NAME, or the content of the file NAME_FILE. */
function secret(env: Env, name: string, opts: { required: boolean; minLength?: number } = { required: true }): string {
  let v = env[name];
  const file = env[`${name}_FILE`];
  if ((v === undefined || v === "") && file) {
    try { v = readFileSync(file, "utf8"); } catch (e) {
      throw new Error(`${name}_FILE: cannot read ${file} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    }
  }
  v = (v ?? "").trim();
  if (!v) {
    if (opts.required) throw new Error(`${name} (or ${name}_FILE) is required`);
    return "";
  }
  if (opts.minLength && v.length < opts.minLength) throw new Error(`${name} must be at least ${opts.minLength} characters`);
  return v;
}

function httpsUrl(env: Env, name: string, fallback: string | undefined, nodeEnv: string): string {
  const raw = (env[name] ?? fallback ?? "").trim();
  if (!raw) throw new Error(`${name} is required`);
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`${name}: "${raw}" is not a URL`); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && nodeEnv !== "production")) {
    throw new Error(`${name} must be https:// (plain http only outside production)`);
  }
  if (u.username || u.password) throw new Error(`${name}: put no credentials in the URL`);
  return raw.replace(/\/+$/, "");
}

/** The PEM GitHub gives ("Generate a private key"). Accepts literal "\n" sequences, as some secret stores write them. */
export function parsePrivateKey(pem: string): KeyObject {
  const text = pem.includes("\\n") && !pem.includes("\n") ? pem.replace(/\\n/g, "\n") : pem;
  let key: KeyObject;
  try { key = createPrivateKey(text); } catch {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key (download it from the App's settings page: Private keys > Generate a private key)");
  }
  if (key.asymmetricKeyType !== "rsa") throw new Error("GITHUB_APP_PRIVATE_KEY must be the App's RSA key");
  return key;
}

const LABEL = /^[A-Za-z0-9._-]{1,100}$/;

/** WARMUP_ENABLED (true unless "false"), WARMUP_GRACE_SECONDS, WARMUP_DAILY_CAP, WARMUP_ORG_CONCURRENCY, WARMUP_RESERVE, ... */
export function warmupFromEnv(env: Env): WarmupSettings {
  const d = DEFAULT_WARMUP;
  const enabled = (env.WARMUP_ENABLED ?? "true").trim().toLowerCase();
  if (!["true", "false"].includes(enabled)) throw new Error("WARMUP_ENABLED must be true or false");
  return {
    enabled: enabled === "true",
    graceSeconds: int(env, "WARMUP_GRACE_SECONDS", d.graceSeconds, 0),
    dailyCap: int(env, "WARMUP_DAILY_CAP", d.dailyCap, 1),
    orgConcurrency: int(env, "WARMUP_ORG_CONCURRENCY", d.orgConcurrency, 1),
    reserve: int(env, "WARMUP_RESERVE", d.reserve, 0),
    startTimeoutSeconds: int(env, "WARMUP_START_TIMEOUT_SECONDS", d.startTimeoutSeconds, 60),
    maxRunSeconds: int(env, "WARMUP_MAX_SECONDS", d.maxRunSeconds, 300),
    waitingJobWindowSeconds: int(env, "WARMUP_WAITING_JOB_WINDOW_SECONDS", d.waitingJobWindowSeconds, 60),
    preemptBackoffSeconds: int(env, "WARMUP_PREEMPT_BACKOFF_SECONDS", d.preemptBackoffSeconds, 0),
    maxAttempts: int(env, "WARMUP_MAX_ATTEMPTS", d.maxAttempts, 1),
  };
}

export function loadConfig(env: Env = process.env, opts: { surface?: "all" | "worker" } = {}): Config {
  const surface = opts.surface ?? "all";
  const http = surface === "all";
  const nodeEnv = env.NODE_ENV ?? "development";
  const appIdRaw = required(env, "GITHUB_APP_ID");
  const appId = Number(appIdRaw);
  if (!Number.isInteger(appId) || appId <= 0) throw new Error("GITHUB_APP_ID must be the App's numeric id");
  const appSlug = required(env, "GITHUB_APP_SLUG");
  if (!/^[a-z0-9][a-z0-9-]{0,33}$/.test(appSlug)) throw new Error("GITHUB_APP_SLUG must be the App's URL name (lowercase letters, digits, dashes)");
  const runsOnLabel = (env.FENVIX_RUNS_ON ?? "fenvix").trim();
  if (!LABEL.test(runsOnLabel)) throw new Error("FENVIX_RUNS_ON must be one runner label (letters, digits, . _ -)");
  const onboardingBranch = (env.ONBOARDING_BRANCH ?? "fenvix/runs-on").trim();
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(onboardingBranch) || onboardingBranch.includes("..") || onboardingBranch.endsWith("/")) {
    throw new Error("ONBOARDING_BRANCH is not a valid branch name");
  }
  const supabaseUrl = httpsUrl(env, "SUPABASE_URL", undefined, nodeEnv);
  // The HTTP side verifies summary credentials (RUNNER_TOKEN required); the worker signs them for the machines it
  // starts (per-job mode: RUNNER_TOKEN given to the worker only then).
  const current = secret(env, "RUNNER_TOKEN", { required: http, minLength: 32 });
  const runnerTokens = current ? [current] : [];
  const previous = http ? secret(env, "RUNNER_TOKEN_PREVIOUS", { required: false, minLength: 32 }) : "";
  if (previous) runnerTokens.push(previous);
  const cachePem = secret(env, "CACHE_SIGNING_KEY", { required: false });
  let cacheSigningKey: KeyObject | null = null;
  if (cachePem) {
    try { cacheSigningKey = createPrivateKey(cachePem.includes("\\n") && !cachePem.includes("\n") ? cachePem.replace(/\\n/g, "\n") : cachePem); } catch {
      throw new Error("CACHE_SIGNING_KEY is not a PEM private key (scripts/cache-key.sh creates it)");
    }
    if (cacheSigningKey.asymmetricKeyType !== "rsa") throw new Error("CACHE_SIGNING_KEY must be an RSA key");
  }

  return {
    surface,
    port: int(env, "PORT", 8790, 1),
    host: env.HOST ?? "0.0.0.0",
    logLevel: env.LOG_LEVEL ?? "info",
    nodeEnv,
    databaseUrl: required(env, "GITHUB_APP_DATABASE_URL"),
    dbPoolMax: int(env, "DB_POOL_MAX", 10, 1),
    appId,
    appSlug,
    privateKey: parsePrivateKey(secret(env, "GITHUB_APP_PRIVATE_KEY")),
    webhookSecret: http ? secret(env, "GITHUB_WEBHOOK_SECRET", { required: true, minLength: 20 }) : "",
    clientId: required(env, "GITHUB_CLIENT_ID"),
    clientSecret: http ? secret(env, "GITHUB_CLIENT_SECRET") : "",
    apiUrl: httpsUrl(env, "GITHUB_API_URL", "https://api.github.com", nodeEnv),
    webUrl: httpsUrl(env, "GITHUB_WEB_URL", "https://github.com", nodeEnv),
    oauthUrl: httpsUrl(env, "GITHUB_OAUTH_URL", env.GITHUB_WEB_URL || "https://github.com", nodeEnv),
    runsOnLabel,
    onboardingBranch,
    onboardAllRepositories: env.ONBOARD_ALL_REPOSITORIES === "true",
    dashboardUrl: httpsUrl(env, "DASHBOARD_URL", undefined, nodeEnv),
    supabaseUrl,
    supabaseJwksUrl: httpsUrl(env, "SUPABASE_JWKS_URL", `${supabaseUrl}/auth/v1/.well-known/jwks.json`, nodeEnv),
    stateSigningKey: http ? secret(env, "STATE_SIGNING_KEY", { required: true, minLength: 32 }) : "",
    runnerTokens,
    cacheSigningKey,
    summaryWaitSeconds: int(env, "SUMMARY_WAIT_SECONDS", 600, 0),
    sweepSeconds: int(env, "SWEEP_SECONDS", 60, 0),
    warmup: warmupFromEnv(env),
    warmupTickSeconds: int(env, "WARMUP_TICK_SECONDS", 60, 0),
    githubTimeoutMs: int(env, "GITHUB_TIMEOUT_MS", 15_000, 100),
  };
}
