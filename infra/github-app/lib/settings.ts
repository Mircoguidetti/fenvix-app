import { createPublicKey } from "node:crypto";

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
  /**
   * demo: the ONLY repository demo-up may register a runner on (owner/name; the founder's own, private). The demo
   * function refuses any other, so it can never put our runner on a customer's repository (R-012 F13).
   */
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
  /**
   * per-job: the public half of the cache signing key (base64 DER, scripts/cache-tokens.sh prints it). The worker
   * signs one token per job with the private half (SSM); the cache machine verifies with this. Each customer
   * installation is its own cache organization (gh-<installation id>); pull requests get read-only tokens.
   */
  cacheSigningPublicKey: string;
  /**
   * Runner machines (demo and per-job): the instance type and its disk. Default c6i.large (not burstable): a T3 gets
   * no launch credits, so a fresh one in "standard" mode runs at its 20% baseline (R-012 F8); T3 types run "unlimited".
   */
  runnerInstanceType: string;
  runnerVolumeGb: number;
  /** Commit of Mircoguidetti/fenvix-engine-cli whose runner/bootstrap.sh the machine runs. */
  engineCliCommit: string;
  // ---------------------------------------------------------------- customer mode on phoenixNAP (docs/CUSTOMER-MODE-PNAP.md)
  /**
   * "off" (default) or "pnap": customer jobs run on phoenixNAP Bare Metal Cloud hosts rented by the hour, one pool per
   * region, each job in its own Firecracker microVM. Adds the scaler and the hosts functions and the /v1/hosts/* route;
   * the worker then places each queued job in its customer's region. Demo mode keeps working beside it (an
   * installation with no region is never placed).
   */
  customerMode: "off" | "pnap";
  /** REGION:MIN:MAX,... of ASH, PHX, CHI, SEA, NLD (one pool per region). */
  pnapRegions: string;
  /** Region of an installation that has none set; empty: such jobs are not placed. */
  pnapDefaultRegion: string;
  pnapServerType: string;
  pnapPricingModel: string;
  pnapVmVcpus: number;
  pnapVmMemMib: number;
  pnapIdleMinutes: number;
  pnapMaxHostsTotal: number;
  /** "colocated" (a cache in its own namespace on each host; the first test), "dedicated" (one cache server per region) or "off". */
  pnapCacheMode: string;
  /** SHA-256 of firecracker-<version>-x86_64.tgz (from the release page); every host checks its download against it. */
  pnapFirecrackerSha256: string;
  /** phoenixNAP SSH key ids installed on every server (optional; the account's default keys are installed anyway). */
  pnapSshKeyIds: string;
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
  cacheVolumeGb: "FENVIX_CACHE_VOLUME_GB", cacheAmiId: "FENVIX_CACHE_AMI_ID",
  cacheSigningPublicKey: "FENVIX_CACHE_SIGNING_PUBLIC_KEY",
  customerMode: "FENVIX_CUSTOMER_MODE", pnapRegions: "FENVIX_PNAP_REGIONS", pnapDefaultRegion: "FENVIX_PNAP_DEFAULT_REGION",
  pnapServerType: "FENVIX_PNAP_SERVER_TYPE", pnapPricingModel: "FENVIX_PNAP_PRICING_MODEL", pnapVmVcpus: "FENVIX_PNAP_VM_VCPUS",
  pnapVmMemMib: "FENVIX_PNAP_VM_MEM_MIB", pnapIdleMinutes: "FENVIX_PNAP_IDLE_MINUTES", pnapMaxHostsTotal: "FENVIX_PNAP_MAX_HOSTS_TOTAL",
  pnapCacheMode: "FENVIX_PNAP_CACHE_MODE", pnapFirecrackerSha256: "FENVIX_PNAP_FIRECRACKER_SHA256", pnapSshKeyIds: "FENVIX_PNAP_SSH_KEY_IDS",
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
    cacheAmiId: get("cacheAmiId"), cacheSigningPublicKey: get("cacheSigningPublicKey").replace(/\s+/g, ""),
    demoRepository: get("demoRepository"), demoMaxHours: int("demoMaxHours", 1, 72), runnerInstanceType: need("runnerInstanceType"),
    runnerVolumeGb: int("runnerVolumeGb", 20, 500), engineCliCommit: need("engineCliCommit"),
    customerMode: (get("customerMode") || "off") as Settings["customerMode"],
    pnapRegions: get("pnapRegions"), pnapDefaultRegion: get("pnapDefaultRegion"), pnapServerType: get("pnapServerType") || "d3.c1.large",
    pnapPricingModel: get("pnapPricingModel") || "HOURLY",
    pnapVmVcpus: Number(get("pnapVmVcpus") || 2), pnapVmMemMib: Number(get("pnapVmMemMib") || 8192),
    pnapIdleMinutes: Number(get("pnapIdleMinutes") || 20), pnapMaxHostsTotal: Number(get("pnapMaxHostsTotal") || 10),
    pnapCacheMode: get("pnapCacheMode") || "colocated", pnapFirecrackerSha256: get("pnapFirecrackerSha256"), pnapSshKeyIds: get("pnapSshKeyIds"),
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
  if (s.cacheSigningPublicKey) {
    let bits = 0;
    try {
      const k = createPublicKey({ key: Buffer.from(s.cacheSigningPublicKey, "base64"), format: "der", type: "spki" });
      bits = k.asymmetricKeyType === "rsa" ? (k.asymmetricKeyDetails?.modulusLength ?? 0) : 0;
    } catch { bits = 0; }
    if (bits < 2048) throw new Error('Setting "cacheSigningPublicKey" must be an RSA public key of 2048 bits or more, base64 DER (scripts/cache-tokens.sh prints it)');
  } else if (s.runnerMode === "per-job") {
    throw new Error('Setting "cacheSigningPublicKey" is required in per-job mode (scripts/cache-tokens.sh creates the key pair)');
  }
  if (s.runnerMode === "demo" && !s.demoRepository) {
    throw new Error('Setting "demoRepository" is required in demo mode: the only repository demo-up may register a runner on (your own, private)');
  }
  if (!/^t3\.(medium|large|xlarge)$|^(c6i|m6i)\.(large|xlarge)$/.test(s.runnerInstanceType)) throw new Error('Setting "runnerInstanceType" must be an x86_64 type like c6i.large');
  if (!/^[0-9a-f]{40}$/.test(s.engineCliCommit)) throw new Error('Setting "engineCliCommit" must be a full 40-character commit SHA');
  if (s.customerMode !== "off" && s.customerMode !== "pnap") throw new Error('Setting "customerMode" must be off or pnap');
  if (s.customerMode === "pnap") {
    if (s.runnerMode === "per-job") throw new Error('customerMode "pnap" runs customer jobs on phoenixNAP: use it with runnerMode "demo", not "per-job"');
    if (!/^(ASH|PHX|CHI|SEA|NLD):\d{1,2}:\d{1,2}(,(ASH|PHX|CHI|SEA|NLD):\d{1,2}:\d{1,2})*$/.test(s.pnapRegions)) {
      throw new Error('Setting "pnapRegions" must be REGION:MIN:MAX[,...] with regions ASH, PHX, CHI, SEA, NLD (e.g. ASH:0:3,NLD:0:2)');
    }
    if (s.pnapDefaultRegion && !s.pnapRegions.split(",").some((r) => r.startsWith(`${s.pnapDefaultRegion}:`))) throw new Error('Setting "pnapDefaultRegion" must be one of pnapRegions');
    if (!/^[a-z0-9]+\.[a-z0-9.]+$/.test(s.pnapServerType)) throw new Error('Setting "pnapServerType" is not a phoenixNAP server type');
    if (!/^(HOURLY|ONE_MONTH_RESERVATION|TWELVE_MONTHS_RESERVATION|TWENTY_FOUR_MONTHS_RESERVATION|THIRTY_SIX_MONTHS_RESERVATION)$/.test(s.pnapPricingModel)) throw new Error('Setting "pnapPricingModel" is not a phoenixNAP pricing model');
    for (const [k, lo, hi] of [["pnapVmVcpus", 1, 32], ["pnapVmMemMib", 1024, 131072], ["pnapIdleMinutes", 0, 1440], ["pnapMaxHostsTotal", 0, 200]] as const) {
      if (!Number.isInteger(s[k]) || s[k] < lo || s[k] > hi) throw new Error(`Setting "${k}" must be an integer from ${lo} to ${hi}`);
    }
    if (!["colocated", "dedicated", "off"].includes(s.pnapCacheMode)) throw new Error('Setting "pnapCacheMode" must be colocated, dedicated or off');
    if (!/^[0-9a-f]{64}$/.test(s.pnapFirecrackerSha256)) throw new Error('Setting "pnapFirecrackerSha256" is required in customer mode: the SHA-256 of the Firecracker release archive (docs/CUSTOMER-MODE-PNAP.md)');
    if (s.pnapSshKeyIds && !/^[A-Za-z0-9]{1,64}(,[A-Za-z0-9]{1,64})*$/.test(s.pnapSshKeyIds)) throw new Error('Setting "pnapSshKeyIds": phoenixNAP SSH key ids, comma separated');
    if (!s.cacheSigningPublicKey && s.pnapCacheMode !== "off") throw new Error('Setting "cacheSigningPublicKey" is required in customer mode with a cache (scripts/cache-key.sh)');
  }
  return s;
}
