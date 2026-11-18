/**
 * Every setting of the stack: cdk.json "context", `-c name=value`, or an environment variable (which wins). Values
 * here are not secret; the secrets are SSM parameters (lib/parameters.ts), never settings.
 */
export interface Settings {
  account: string;
  region: string;
  /** Part of every name and of the SSM paths: /fenvix/<env>/... */
  env: string;
  /** The App's public host. API Gateway serves it with an ACM certificate; DNS stays on Cloudflare. */
  domainName: string;
  // ---------------------------------------------------------------- the App (plain settings of src/config.ts)
  githubAppId: string;
  githubAppSlug: string;
  githubClientId: string;
  dashboardUrl: string;
  supabaseUrl: string;
  runsOnLabel: string;
  summaryWaitSeconds: number;
  /** How often the sweep runs (EventBridge Scheduler rate, minutes). */
  sweepMinutes: number;
  logRetentionDays: number;
  /** Optional: an email for the dead-letter queue alarm. */
  alarmEmail: string;
  // ---------------------------------------------------------------- runner machines
  /**
   * "demo" (default): no runner machine between demos; scripts/demo-up.sh starts one fresh machine from the runner
   * image and registers it on one repository, scripts/demo-down.sh deregisters and terminates it. Its cache is local to
   * it, so nothing crosses demos. "per-job": each queued fenvix job starts one machine with a just-in-time runner;
   * the shared cache runs on a small private machine. Customer mode (Firecracker on a c7i host) is a design in
   * docs/DEPLOY-AWS.md.
   */
  runnerMode: "demo" | "per-job";
  /** demo: the repository demo-up registers the runner on when none is given (owner/name). */
  demoRepository: string;
  /** demo: the reaper terminates a demo machine older than this (somebody forgot demo-down). */
  demoMaxHours: number;
  /** per-job: most machines at once; more queued jobs wait (the queue retries). */
  runnerMaxRunning: number;
  /** per-job: the reaper terminates a machine older than this. */
  runnerMaxHours: number;
  /** per-job: a machine whose job did not start within this powers off. */
  runnerIdleMinutes: number;
  /** per-job: the shared cache machine (docs/SHARED-CACHE.md of fenvix-engine-cli), private, no public address. */
  cacheInstanceType: string;
  cachePrivateIp: string;
  cacheVolumeGb: number;
  cacheAmiId: string;
  /** The cache service's organization, and the SHA-256 of its two tokens (scripts/cache-tokens.sh prints them). */
  cacheOrg: string;
  cacheTokenSha256Write: string;
  cacheTokenSha256Read: string;
  /** Runner machines (demo and per-job): the instance type and its disk. */
  runnerInstanceType: string;
  runnerVolumeGb: number;
  /** Commit of Mircoguidetti/fenvix-engine-cli whose runner/bootstrap.sh the machine runs. */
  engineCliCommit: string;
}

type Ctx = (key: string) => unknown;

const ENV: Record<keyof Settings, string> = {
  account: "FENVIX_ACCOUNT", region: "FENVIX_REGION", env: "FENVIX_ENV", domainName: "FENVIX_GITHUB_APP_DOMAIN",
  githubAppId: "GITHUB_APP_ID", githubAppSlug: "GITHUB_APP_SLUG", githubClientId: "GITHUB_CLIENT_ID", dashboardUrl: "DASHBOARD_URL",
  supabaseUrl: "SUPABASE_URL", runsOnLabel: "FENVIX_RUNS_ON", summaryWaitSeconds: "SUMMARY_WAIT_SECONDS", sweepMinutes: "FENVIX_SWEEP_MINUTES",
  logRetentionDays: "FENVIX_LOG_RETENTION_DAYS", alarmEmail: "FENVIX_ALARM_EMAIL",
  runnerInstanceType: "FENVIX_RUNNER_INSTANCE_TYPE", runnerVolumeGb: "FENVIX_RUNNER_VOLUME_GB", engineCliCommit: "FENVIX_ENGINE_CLI_COMMIT",
  demoRepository: "FENVIX_DEMO_REPOSITORY", demoMaxHours: "FENVIX_DEMO_MAX_HOURS",
  runnerMode: "FENVIX_RUNNER_MODE", runnerMaxRunning: "FENVIX_RUNNER_MAX_RUNNING", runnerMaxHours: "FENVIX_RUNNER_MAX_HOURS",
  runnerIdleMinutes: "FENVIX_RUNNER_IDLE_MINUTES", cacheInstanceType: "FENVIX_CACHE_INSTANCE_TYPE", cachePrivateIp: "FENVIX_CACHE_PRIVATE_IP",
  cacheVolumeGb: "FENVIX_CACHE_VOLUME_GB", cacheAmiId: "FENVIX_CACHE_AMI_ID", cacheOrg: "FENVIX_CACHE_ORG",
  cacheTokenSha256Write: "FENVIX_CACHE_TOKEN_SHA256_WRITE", cacheTokenSha256Read: "FENVIX_CACHE_TOKEN_SHA256_READ",
};

/** CloudWatch Logs accepts only these retention periods (days). */
const RETENTIONS = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365];

export function readSettings(ctx: Ctx, env: Record<string, string | undefined> = process.env): Settings {
  const get = (k: keyof Settings): string => {
    const fromEnv = env[ENV[k]];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv.trim();
    const v = ctx(k);
    return v === undefined || v === null ? "" : String(v).trim();
  };
  const need = (k: keyof Settings): string => {
    const v = get(k);
    if (!v) throw new Error(`Missing setting "${k}" (cdk.json context, -c ${k}=..., or ${ENV[k]})`);
    return v;
  };
  const int = (k: keyof Settings, min: number, max: number): number => {
    const n = Number(need(k));
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Setting "${k}" must be an integer from ${min} to ${max}`);
    return n;
  };
  const https = (k: keyof Settings): string => {
    const v = need(k).replace(/\/+$/, "");
    let u: URL;
    try { u = new URL(v); } catch { throw new Error(`Setting "${k}" is not a URL`); }
    if (u.protocol !== "https:" || u.username || u.password) throw new Error(`Setting "${k}" must be an https:// URL without credentials`);
    return v;
  };

  const s: Settings = {
    account: need("account"), region: need("region"), env: need("env"), domainName: need("domainName"),
    githubAppId: need("githubAppId"), githubAppSlug: need("githubAppSlug"), githubClientId: need("githubClientId"),
    dashboardUrl: https("dashboardUrl"), supabaseUrl: https("supabaseUrl"), runsOnLabel: need("runsOnLabel"),
    summaryWaitSeconds: int("summaryWaitSeconds", 60, 86_400), sweepMinutes: int("sweepMinutes", 1, 60),
    logRetentionDays: int("logRetentionDays", 1, 365), alarmEmail: get("alarmEmail"),
    runnerMode: need("runnerMode") as Settings["runnerMode"], runnerMaxRunning: int("runnerMaxRunning", 1, 100),
    runnerMaxHours: int("runnerMaxHours", 1, 120), runnerIdleMinutes: int("runnerIdleMinutes", 5, 120),
    cacheInstanceType: need("cacheInstanceType"), cachePrivateIp: need("cachePrivateIp"), cacheVolumeGb: int("cacheVolumeGb", 8, 500),
    cacheAmiId: get("cacheAmiId"), cacheOrg: need("cacheOrg"), cacheTokenSha256Write: get("cacheTokenSha256Write").toLowerCase(),
    cacheTokenSha256Read: get("cacheTokenSha256Read").toLowerCase(),
    demoRepository: get("demoRepository"), demoMaxHours: int("demoMaxHours", 1, 72), runnerInstanceType: need("runnerInstanceType"),
    runnerVolumeGb: int("runnerVolumeGb", 20, 500), engineCliCommit: need("engineCliCommit"),
  };
  if (!/^\d{12}$/.test(s.account)) throw new Error('Setting "account" must be a 12-digit AWS account id');
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(s.region)) throw new Error('Setting "region" is not an AWS region');
  if (!/^[a-z0-9-]{1,12}$/.test(s.env)) throw new Error('Setting "env" must be lowercase letters, digits, dashes');
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(s.domainName)) throw new Error('Setting "domainName" must be a host name like github.fenvix.dev');
  if (!/^\d+$/.test(s.githubAppId)) throw new Error('Setting "githubAppId" must be the numeric App ID');
  if (!/^[a-z0-9][a-z0-9-]{0,33}$/.test(s.githubAppSlug)) throw new Error('Setting "githubAppSlug" must be the App\'s URL name');
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(s.runsOnLabel)) throw new Error('Setting "runsOnLabel" must be one runner label');
  if (!RETENTIONS.includes(s.logRetentionDays)) throw new Error(`Setting "logRetentionDays" must be one of ${RETENTIONS.join(", ")}`);
  if (s.alarmEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.alarmEmail)) throw new Error('Setting "alarmEmail" is not an email address');
  if (s.runnerMode !== "demo" && s.runnerMode !== "per-job") throw new Error('Setting "runnerMode" must be demo or per-job');
  if (s.demoRepository && !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(s.demoRepository)) throw new Error('Setting "demoRepository" must be owner/name');
  if (!/^t4g\.(nano|micro|small)$/.test(s.cacheInstanceType)) throw new Error('Setting "cacheInstanceType" must be t4g.nano, t4g.micro or t4g.small (arm64)');
  if (!/^10\.42\.0\.([4-9]|[1-5][0-9]|6[0-2])$/.test(s.cachePrivateIp)) throw new Error('Setting "cachePrivateIp" must be an address of the runner subnet 10.42.0.0/26 (10.42.0.4 to 10.42.0.62)');
  if (s.cacheAmiId && !/^ami-[0-9a-f]{8,17}$/.test(s.cacheAmiId)) throw new Error('Setting "cacheAmiId" must look like ami-0123456789abcdef0');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(s.cacheOrg)) throw new Error('Setting "cacheOrg" must be letters, digits, . _ -');
  for (const k of ["cacheTokenSha256Write", "cacheTokenSha256Read"] as const) {
    if (s[k] && !/^[0-9a-f]{64}$/.test(s[k])) throw new Error(`Setting "${k}" must be a SHA-256 in hex (scripts/cache-tokens.sh prints it)`);
  }
  if (s.cacheTokenSha256Write && s.cacheTokenSha256Write === s.cacheTokenSha256Read) throw new Error("The write and read cache tokens must differ");
  if (!/^t3\.(medium|large|xlarge)$|^(c6i|m6i)\.(large|xlarge)$/.test(s.runnerInstanceType)) throw new Error('Setting "runnerInstanceType" must be an x86_64 type like t3.medium');
  if (!/^[0-9a-f]{40}$/.test(s.engineCliCommit)) throw new Error('Setting "engineCliCommit" must be a full 40-character commit SHA');
  return s;
}
