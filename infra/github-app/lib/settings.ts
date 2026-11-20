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
  /**
   * The API's public host (api.fenvix.dev in prod): the dashboard API (/v1), the GitHub App (webhooks, /github/setup),
   * the runner and warm-up reports (/v1/runner/*) and /healthz. The ONE source of every URL that names the API: the
   * stack, the runner machines' configuration and the deploy pipeline (deploy/cli.mjs) all read it from here. API
   * Gateway serves it with an ACM certificate; DNS stays on Cloudflare.
   */
  domainName: string;
  /**
   * The ACM certificate of domainName, in this stack's region. The deploy pipeline requests it and has it validated
   * before CDK runs (deploy/cli.mjs api-certificate), so a missing DNS record stops the run with the record to add
   * instead of leaving CloudFormation waiting. Empty (a stack deployed without the pipeline): the stack requests the
   * certificate itself and CloudFormation waits for its DNS validation.
   */
  apiCertificateArn: string;
  // ---------------------------------------------------------------- the App (plain settings of src/config.ts)
  /**
   * The GitHub App's id, URL name and OAuth client id: all three, or none. None (the default until the App is created:
   * docs/DEPLOY-AWS.md, "Connecting the GitHub App") deploys everything; the App's routes then answer 503
   * github_not_configured and its functions do nothing.
   */
  githubAppId: string;
  githubAppSlug: string;
  githubClientId: string;
  /** True when githubAppId, githubAppSlug and githubClientId are set. */
  githubConfigured: boolean;
  // ---------------------------------------------------------------- the dashboard (S3 + CloudFront, lib/dashboard.ts)
  /**
   * Whether this app includes the AWS dashboard stack (fenvix-<env>-dashboard, S3 + CloudFront). Default false: the
   * dashboard is hosted on Vercel (docs/DEPLOY-VERCEL.md) because the AWS account cannot create CloudFront resources
   * until AWS verifies it. Off, `cdk deploy --all` plans the API stack only. The deploy workflow sets it from the
   * repository variable FENVIX_DASHBOARD_ON_AWS ("true" turns the AWS dashboard back on, with its certificate, upload
   * and DNS steps).
   */
  dashboardOnAws: boolean;
  /** The dashboard's host (CloudFront or Vercel; DNS on Cloudflare). dashboardUrl is https://<this>. */
  dashboardDomain: string;
  /**
   * The ACM certificate of dashboardDomain, in us-east-1 (CloudFront takes certificates from there only). The deploy
   * pipeline requests it and passes its ARN. Empty: the distribution answers on its cloudfront.net name only.
   */
  dashboardCertificateArn: string;
  dashboardUrl: string;
  supabaseUrl: string;
  runsOnLabel: string;
  summaryWaitSeconds: number;
  /** How often the sweep runs (EventBridge Scheduler rate, minutes). */
  sweepMinutes: number;
  logRetentionDays: number;
  /** Optional: an email for the dead-letter queue alarm. */
  alarmEmail: string;
  /**
   * The dashboard API: more origins the browser may call it from (comma separated, e.g. a preview of the dashboard),
   * besides dashboardUrl's own. Optional.
   */
  apiCorsOrigins: string;
  // ---------------------------------------------------------------- where organizations' jobs run (us | eu)
  /** The fenvix region (an organization's setting, us or eu) this stack's runner machines serve. Default us. */
  fenvixRegion: "us" | "eu";
  /**
   * Optional: the other fenvix region, served by another deploy of the runner fleet (another AWS region): its fenvix
   * region, AWS region and launch template id. All three, or none.
   */
  secondFenvixRegion: string;
  secondAwsRegion: string;
  secondLaunchTemplateId: string;
  /**
   * Optional, per-job: the shared cache URL of the other region's fleet (its own private cache machine), given to the
   * machines started there (RUNNER_PLACEMENT.<region>.machineEnv.FENVIX_CACHE_URL). Without it they get this stack's.
   */
  secondCacheUrl: string;
  // ---------------------------------------------------------------- runner machines
  /**
   * "pool", the only mode since 2026-11-20 (our machines, github-app/src/machines/): a machine belongs to one customer
   * at a time, each job in its own sandboxed slot; one machine always on, a stopped reserve, spot for bursts. The
   * per-job and demo modes were retired (their image built the engine from an old pinned commit, audit G-0186).
   */
  runnerMode: "pool";
  /**
   * Our machines (github-app/src/machines/settings.ts, FENVIX_POOL): JSON with the sizes ({name: {instanceType, slots}}),
   * the default size, the always-on and reserve counts, the region's machine limit, the spot threshold, the per-customer
   * caps and the timings. The founder's design of 2026-11-20 by default: c7a.xlarge always on, 2 in reserve.
   */
  pool: string;
  /**
   * The engine the runner image installs: the trunk artifact of fenvix-engine-cli (claude/release-1), by version, URL
   * and sha256 (fenvix-engine-<version>-r<run>.<sha7>-linux-x86_64.tar.gz). The image build fails closed on a
   * missing pin or a different checksum (audit G-0186). Set them when the packages session publishes a build.
   */
  engineVersion: string;
  engineUrl: string;
  engineSha256: string;
  /** The reaper's backstop: it terminates a pool machine older than this plus one hour (the pool's own maxHours first). */
  runnerMaxHours: number;
  // ---------------------------------------------------------------- warm-up runs (per-job only; github-app/src/warmup/)
  /** per-job: warm the shared cache of onboarded repositories' default branches (never billed). Default true. */
  warmupEnabled: boolean;
  /** per-job: at most this many warm-ups of one repository take a machine in any 24 hours. */
  warmupDailyCap: number;
  /** per-job: at most this many warm-ups of one organization on machines at once. */
  warmupOrgConcurrency: number;
  /** per-job: machines of a region's fleet a warm-up never takes (kept for customers' jobs); below runnerMaxRunning. */
  warmupReserve: number;
  /** per-job: a push waits this long for the customer's own run of the commit before its warm-up may start. */
  warmupGraceSeconds: number;
  /** per-job: the shared cache machine (docs/SHARED-CACHE.md of fenvix-engine-cli), private, no public address. */
  cacheInstanceType: string;
  cachePrivateIp: string;
  cacheVolumeGb: number;
  cacheAmiId: string;
  /**
   * per-job: the public half of the cache signing key (base64 DER; the deploy pipeline generates the pair and passes it as FENVIX_CACHE_SIGNING_PUBLIC_KEY). The worker
   * signs one token per job with the private half (SSM); the cache machine verifies with this. Each customer
   * repository is its own cache organization (gh-<installation id>-r<repository id>); pull requests get read-only tokens.
   */
  cacheSigningPublicKey: string;
  /**
   * The launch template's instance type (the pool's default size; each launch names its size's type) and the disk.
   * Default c7a.xlarge (4 physical cores, not burstable); a T3 gets no launch credits, so T3 types run "unlimited".
   */
  runnerInstanceType: string;
  runnerVolumeGb: number;
}

type Ctx = (key: string) => unknown;

const ENV: Record<keyof Settings, string> = {
  account: "FENVIX_ACCOUNT", region: "FENVIX_REGION", env: "FENVIX_ENV", domainName: "FENVIX_API_DOMAIN", apiCertificateArn: "FENVIX_API_CERTIFICATE_ARN",
  githubAppId: "GITHUB_APP_ID", githubAppSlug: "GITHUB_APP_SLUG", githubClientId: "GITHUB_CLIENT_ID", githubConfigured: "",
  dashboardOnAws: "FENVIX_DASHBOARD_ON_AWS", dashboardDomain: "FENVIX_DASHBOARD_DOMAIN", dashboardCertificateArn: "FENVIX_DASHBOARD_CERTIFICATE_ARN", dashboardUrl: "DASHBOARD_URL",
  supabaseUrl: "SUPABASE_URL", runsOnLabel: "FENVIX_RUNS_ON", summaryWaitSeconds: "SUMMARY_WAIT_SECONDS", sweepMinutes: "FENVIX_SWEEP_MINUTES",
  logRetentionDays: "FENVIX_LOG_RETENTION_DAYS", alarmEmail: "FENVIX_ALARM_EMAIL", apiCorsOrigins: "FENVIX_API_CORS_ORIGINS",
  fenvixRegion: "FENVIX_RUNNER_REGION", secondFenvixRegion: "FENVIX_SECOND_RUNNER_REGION", secondAwsRegion: "FENVIX_SECOND_AWS_REGION",
  secondLaunchTemplateId: "FENVIX_SECOND_LAUNCH_TEMPLATE_ID", secondCacheUrl: "FENVIX_SECOND_CACHE_URL",
  runnerInstanceType: "FENVIX_RUNNER_INSTANCE_TYPE", runnerVolumeGb: "FENVIX_RUNNER_VOLUME_GB", pool: "FENVIX_POOL", engineVersion: "FENVIX_ENGINE_VERSION", engineUrl: "FENVIX_ENGINE_URL", engineSha256: "FENVIX_ENGINE_SHA256",
  runnerMode: "FENVIX_RUNNER_MODE", runnerMaxHours: "FENVIX_RUNNER_MAX_HOURS", warmupEnabled: "FENVIX_WARMUP_ENABLED", warmupDailyCap: "FENVIX_WARMUP_DAILY_CAP",
  warmupOrgConcurrency: "FENVIX_WARMUP_ORG_CONCURRENCY", warmupReserve: "FENVIX_WARMUP_RESERVE", warmupGraceSeconds: "FENVIX_WARMUP_GRACE_SECONDS", cacheInstanceType: "FENVIX_CACHE_INSTANCE_TYPE", cachePrivateIp: "FENVIX_CACHE_PRIVATE_IP",
  cacheVolumeGb: "FENVIX_CACHE_VOLUME_GB", cacheAmiId: "FENVIX_CACHE_AMI_ID",
  cacheSigningPublicKey: "FENVIX_CACHE_SIGNING_PUBLIC_KEY",
};

/** CloudWatch Logs accepts only these retention periods (days). */
const RETENTIONS = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365];

export function readSettings(ctx: Ctx, env: Record<string, string | undefined> = process.env): Settings {
  const get = (k: keyof Settings): string => {
    const fromEnv = ENV[k] ? env[ENV[k]] : undefined;
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
    account: need("account"), region: need("region"), env: need("env"), domainName: need("domainName"), apiCertificateArn: get("apiCertificateArn"),
    githubAppId: get("githubAppId"), githubAppSlug: get("githubAppSlug"), githubClientId: get("githubClientId"), githubConfigured: false,
    dashboardOnAws: (get("dashboardOnAws") || "false") === "true",
    dashboardDomain: need("dashboardDomain"), dashboardCertificateArn: get("dashboardCertificateArn"),
    dashboardUrl: https("dashboardUrl"), supabaseUrl: https("supabaseUrl"), runsOnLabel: need("runsOnLabel"),
    summaryWaitSeconds: int("summaryWaitSeconds", 60, 86_400), sweepMinutes: int("sweepMinutes", 1, 60),
    logRetentionDays: int("logRetentionDays", 1, 365), alarmEmail: get("alarmEmail"),
    apiCorsOrigins: get("apiCorsOrigins"), fenvixRegion: (get("fenvixRegion") || "eu") as Settings["fenvixRegion"],
    secondFenvixRegion: get("secondFenvixRegion"), secondAwsRegion: get("secondAwsRegion"), secondLaunchTemplateId: get("secondLaunchTemplateId"),
    secondCacheUrl: get("secondCacheUrl"),
    runnerMode: need("runnerMode") as Settings["runnerMode"],
    runnerMaxHours: int("runnerMaxHours", 1, 120),
    warmupEnabled: (get("warmupEnabled") || "true") === "true", warmupDailyCap: int("warmupDailyCap", 1, 48),
    warmupOrgConcurrency: int("warmupOrgConcurrency", 1, 20), warmupReserve: int("warmupReserve", 0, 99), warmupGraceSeconds: int("warmupGraceSeconds", 0, 3600),
    cacheInstanceType: need("cacheInstanceType"), cachePrivateIp: need("cachePrivateIp"), cacheVolumeGb: int("cacheVolumeGb", 8, 500),
    cacheAmiId: get("cacheAmiId"), cacheSigningPublicKey: get("cacheSigningPublicKey").replace(/\s+/g, ""),
    runnerInstanceType: need("runnerInstanceType"),
    runnerVolumeGb: int("runnerVolumeGb", 20, 500), pool: need("pool"),
    engineVersion: get("engineVersion"), engineUrl: get("engineUrl"), engineSha256: get("engineSha256"),
  };
  if (!/^\d{12}$/.test(s.account)) throw new Error('Setting "account" must be a 12-digit AWS account id');
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(s.region)) throw new Error('Setting "region" is not an AWS region');
  if (!/^[a-z0-9-]{1,12}$/.test(s.env)) throw new Error('Setting "env" must be lowercase letters, digits, dashes');
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(s.domainName)) throw new Error('Setting "domainName" must be a host name like api.fenvix.dev');
  if (s.apiCertificateArn && !new RegExp(`^arn:aws:acm:${s.region}:${s.account}:certificate/[0-9a-f-]{36}$`).test(s.apiCertificateArn)) {
    throw new Error(`Setting "apiCertificateArn" must be an ACM certificate ARN of account ${s.account} in ${s.region} (API Gateway takes a regional API's certificate from its own region)`);
  }
  const app = [s.githubAppId, s.githubAppSlug, s.githubClientId];
  if (app.some(Boolean) && !app.every(Boolean)) {
    const missing = (["githubAppId", "githubAppSlug", "githubClientId"] as const).filter((k) => !s[k]);
    throw new Error(`Settings "githubAppId", "githubAppSlug" and "githubClientId": all three, or none (missing: ${missing.join(", ")})`);
  }
  s.githubConfigured = app.every(Boolean);
  if (s.githubAppId && !/^\d+$/.test(s.githubAppId)) throw new Error('Setting "githubAppId" must be the numeric App ID');
  if (s.githubAppSlug && !/^[a-z0-9][a-z0-9-]{0,33}$/.test(s.githubAppSlug)) throw new Error('Setting "githubAppSlug" must be the App\'s URL name');
  if (s.githubClientId && !/^[A-Za-z0-9._-]{1,100}$/.test(s.githubClientId)) throw new Error('Setting "githubClientId" must be the App\'s Client ID');
  if (!["true", "false"].includes(get("dashboardOnAws") || "false")) throw new Error('Setting "dashboardOnAws" must be true or false');
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(s.dashboardDomain)) throw new Error('Setting "dashboardDomain" must be a host name like console.fenvix.dev');
  if (s.dashboardCertificateArn && !/^arn:aws:acm:us-east-1:\d{12}:certificate\/[0-9a-f-]{36}$/.test(s.dashboardCertificateArn)) {
    throw new Error('Setting "dashboardCertificateArn" must be an ACM certificate ARN in us-east-1 (CloudFront takes certificates from there only)');
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(s.runsOnLabel)) throw new Error('Setting "runsOnLabel" must be one runner label');
  if (!RETENTIONS.includes(s.logRetentionDays)) throw new Error(`Setting "logRetentionDays" must be one of ${RETENTIONS.join(", ")}`);
  if (s.alarmEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.alarmEmail)) throw new Error('Setting "alarmEmail" is not an email address');
  if ((s.runnerMode as string) !== "pool") throw new Error('Setting "runnerMode" must be pool (our machines, 2026-11-20); per-job and demo were retired with it');
  checkPool(s.pool);
  checkEngine(s);
  if (!["true", "false"].includes(get("warmupEnabled") || "true")) throw new Error('Setting "warmupEnabled" must be true or false');
  const poolMax = (JSON.parse(s.pool) as { maxMachines?: number }).maxMachines ?? 8;
  if (s.warmupReserve >= poolMax) throw new Error('Setting "warmupReserve" must be below the pool\'s maxMachines (warm-ups would never get a machine)');
  for (const o of s.apiCorsOrigins.split(",").map((x) => x.trim()).filter(Boolean)) {
    let u: URL | null = null;
    try { u = new URL(o); } catch { u = null; }
    if (!u || u.protocol !== "https:" || u.origin !== o.replace(/\/+$/, "")) throw new Error('Setting "apiCorsOrigins" must be https:// origins (scheme://host, no path), comma separated');
  }
  if (s.fenvixRegion !== "us" && s.fenvixRegion !== "eu") throw new Error('Setting "fenvixRegion" must be us or eu');
  // The label must be where the machines are (audit G-0185, G-0190): an eu-* AWS region is "eu", a us-* one "us".
  const continent = (awsRegion: string) => (awsRegion.startsWith("eu-") ? "eu" : awsRegion.startsWith("us-") ? "us" : null);
  if (continent(s.region) !== s.fenvixRegion) throw new Error(`Setting "fenvixRegion" is "${s.fenvixRegion}" but the machines run in ${s.region}: the label must be ${continent(s.region) ?? "a region fenvix offers (us-*, eu-*)"}`);
  const second = [s.secondFenvixRegion, s.secondAwsRegion, s.secondLaunchTemplateId];
  if (second.some(Boolean)) {
    if (!second.every(Boolean)) throw new Error('Settings "secondFenvixRegion", "secondAwsRegion" and "secondLaunchTemplateId": all three, or none');
    if (!["us", "eu"].includes(s.secondFenvixRegion) || s.secondFenvixRegion === s.fenvixRegion) throw new Error('Setting "secondFenvixRegion" must be the other of us and eu');
    if (!/^[a-z]{2}-[a-z]+-\d$/.test(s.secondAwsRegion)) throw new Error('Setting "secondAwsRegion" is not an AWS region');
    if (continent(s.secondAwsRegion) !== s.secondFenvixRegion) throw new Error(`Setting "secondFenvixRegion" is "${s.secondFenvixRegion}" but its machines run in ${s.secondAwsRegion}`);
    if (!/^lt-[0-9a-f]{8,17}$/.test(s.secondLaunchTemplateId)) throw new Error('Setting "secondLaunchTemplateId" must look like lt-0123456789abcdef0');
  }
  if (s.secondCacheUrl && (!s.secondFenvixRegion || !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(s.secondCacheUrl))) {
    throw new Error('Setting "secondCacheUrl" must be the other region\'s cache origin (http://<private address>:8787), with the second region set');
  }
  if (!/^t4g\.(nano|micro|small)$/.test(s.cacheInstanceType)) throw new Error('Setting "cacheInstanceType" must be t4g.nano, t4g.micro or t4g.small (arm64)');
  if (!/^10\.42\.0\.([4-9]|[1-5][0-9]|6[0-2])$/.test(s.cachePrivateIp)) throw new Error('Setting "cachePrivateIp" must be an address of the runner subnet 10.42.0.0/26 (10.42.0.4 to 10.42.0.62)');
  if (s.cacheAmiId && !/^ami-[0-9a-f]{8,17}$/.test(s.cacheAmiId)) throw new Error('Setting "cacheAmiId" must look like ami-0123456789abcdef0');
  if (s.cacheSigningPublicKey) {
    let bits = 0;
    try {
      const k = createPublicKey({ key: Buffer.from(s.cacheSigningPublicKey, "base64"), format: "der", type: "spki" });
      bits = k.asymmetricKeyType === "rsa" ? (k.asymmetricKeyDetails?.modulusLength ?? 0) : 0;
    } catch { bits = 0; }
    if (bits < 2048) throw new Error('Setting "cacheSigningPublicKey" must be an RSA public key of 2048 bits or more, base64 DER (the deploy pipeline generates it)');
  } else {
    throw new Error('Setting "cacheSigningPublicKey" is required (the deploy pipeline generates the key pair: FENVIX_CACHE_SIGNING_PUBLIC_KEY)');
  }
  if (!/^t3\.(medium|large|xlarge)$|^(c6i|m6i)\.(large|xlarge)$|^c7a\.(large|xlarge|2xlarge|4xlarge)$/.test(s.runnerInstanceType)) throw new Error('Setting "runnerInstanceType" must be an x86_64 type like c7a.xlarge');
  return s;
}

/** The instance types every policy allows (cfn-exec-policy-fleet.json "Ec2OnlyTheseSizes", the boundary). */
export const POOL_TYPES = /^(c7a\.(large|xlarge|2xlarge|4xlarge)|c6i\.(large|xlarge)|m6i\.(large|xlarge)|t3\.(medium|large|xlarge))$/;

function checkPool(raw: string): void {
  let p: { sizes?: Record<string, { instanceType?: string; slots?: number }>; defaultSize?: string };
  try { p = JSON.parse(raw); } catch { throw new Error('Setting "pool" is not JSON'); }
  const sizes = Object.entries(p.sizes ?? {});
  if (!sizes.length) throw new Error('Setting "pool": at least one size');
  for (const [n, z] of sizes) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(n)) throw new Error(`Setting "pool": bad size name "${n}"`);
    if (!z.instanceType || !POOL_TYPES.test(z.instanceType)) throw new Error(`Setting "pool": size ${n} must be an allowed x86_64 type (c7a, c6i, m6i, t3), not "${z.instanceType}"`);
    if (!Number.isInteger(z.slots) || z.slots! < 1 || z.slots! > 16) throw new Error(`Setting "pool": size ${n} slots must be 1 to 16`);
  }
  if (!p.defaultSize || !p.sizes![p.defaultSize]) throw new Error('Setting "pool": defaultSize must be one of the sizes');
}

/** The engine pin: all three or none (none: the image build stops, nothing is installed). */
function checkEngine(s: Settings): void {
  const pin = [s.engineVersion, s.engineUrl, s.engineSha256];
  if (!pin.some(Boolean)) return;
  if (!pin.every(Boolean)) throw new Error('Settings "engineVersion", "engineUrl" and "engineSha256": all three, or none');
  if (!/^[0-9a-f]{64}$/.test(s.engineSha256)) throw new Error('Setting "engineSha256" must be 64 lowercase hex digits');
  if (!/^[0-9A-Za-z.+-]{1,80}$/.test(s.engineVersion)) throw new Error('Setting "engineVersion" is not a version');
  const file = `fenvix-engine-${s.engineVersion}-linux-x86_64.tar.gz`;
  if (!/^https:\/\/github\.com\/Mircoguidetti\/fenvix-engine-cli\/releases\/download\/engine-[0-9A-Za-z.+-]{1,80}\/[^/]+$/.test(s.engineUrl) || !s.engineUrl.endsWith(`/${file}`)) {
    throw new Error(`Setting "engineUrl" must be the fenvix-engine-cli release asset of that version (.../releases/download/engine-${s.engineVersion}/${file})`);
  }
}
