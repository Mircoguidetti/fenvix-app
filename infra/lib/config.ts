import { SHA256_RE, VERSION_RE } from './artifacts';
export const ALLOWED_INSTANCE_TYPES = ['t3.medium', 'c6i.large', 'c7g.large'] as const;
export type AllowedInstanceType = (typeof ALLOWED_INSTANCE_TYPES)[number];

/** The only value the project tag may have. The CI test role touches `fenvix-tests`; production must never use it. */
export const PROJECT_TAG = 'fenvix';

export interface FenvixConfig {
  /** AWS account id, or undefined to take it from the credentials at synth time. */
  account?: string;
  /** One stack per region. Adding a region is one more entry here. */
  regions: string[];
  /** Value of the `env` tag and part of every resource name and SSM path. */
  envName: string;
  instanceType: AllowedInstanceType;
  volumeGb: number;
  /** Days a non-current object version is kept before S3 deletes it. */
  retentionDays: number;
  budgetAmountUsd: number;
  budgetEmail: string;
  /** The engine's MongoDB listener, open to the internet (customers connect here). */
  mongoPort: number;
  /** The engine's control (admin) interface, reachable only from the server's own security group. */
  adminPort: number;
  controlPlanePort: number;
  /**
   * Release artifacts (lib/artifacts.ts): version and SHA-256 of the engine binary and of the control-plane image archive,
   * as the publish workflows print them. All four or none: with none (first deploy, before anything is published) the
   * server prepares everything and gets its certificate but starts no service. The SHA-256 is the one the server checks;
   * nothing in the bucket can change it.
   */
  engineVersion?: string;
  engineSha256?: string;
  controlPlaneVersion?: string;
  controlPlaneSha256?: string;
  /** GitHub repository (owner/name) whose release workflow may write engine/ in the artifacts bucket, and its branches. */
  engineRepo: string;
  engineRepoBranches: string[];
  /** GitHub repository whose release workflow may write control-plane/, and its branches. */
  controlPlaneRepo: string;
  controlPlaneRepoBranches: string[];
  /**
   * Numeric GitHub ids of the owner and of each repository. GitHub now writes them into the OIDC `sub` claim
   * (repo:<owner>@<ownerId>/<repo>@<repoId>:ref:...), so when they are set the publish roles trust that form too.
   */
  githubOwnerId?: string;
  engineRepoId?: string;
  controlPlaneRepoId?: string;
  /**
   * ARN of the account's GitHub OIDC provider (token.actions.githubusercontent.com) when it exists already (an account
   * can have only one per URL). Empty: the first region's stack creates it.
   */
  githubOidcProviderArn?: string;
  /**
   * Name of the artifacts bucket, for regions after the first (the bucket lives in the first region's stack, output
   * ArtifactsBucketName). Not used by the first region, whose stack creates the bucket.
   */
  artifactsBucket?: string;
  /** TLS terminator in front of the control plane (it serves plain HTTP). Public image, pulled without a login. */
  proxyImage: string;
  /**
   * The domain. Required: the engine only serves TLS from a certificate file, and the certificate is issued for
   * `*.<region>.db.<baseDomain>` (database hosts) and `api.<baseDomain>` (the control-plane API).
   */
  baseDomain: string;
  /**
   * Which name the Route 53 zone has. `db`: the zone is `db.<baseDomain>` (only that subdomain is delegated to Route 53;
   * the rest of the domain stays where it is, and api.<baseDomain> is made by hand there). `domain`: the zone is
   * `<baseDomain>` itself (the whole domain is delegated to Route 53). README.md, "The domain and DNS".
   */
  dnsZone: DnsZone;
  /** Use an existing Route 53 hosted zone (named as `dnsZone` says) instead of creating one. Required with more than one region. */
  hostedZoneId?: string;
  /** Contact address of the Let's Encrypt account (expiry and incident notices). Required, no default. */
  acmeEmail: string;
  /** Use the Let's Encrypt staging environment (certificates NOT trusted by drivers or browsers; for a first trial). */
  acmeStaging: boolean;
  /**
   * Browser origins of the dashboard allowed by the control plane (CORS), e.g. https://console.fenvix.dev. Required, no
   * default. Never the API's own origin (https://api.<baseDomain>) nor a database host (*.db.<baseDomain>).
   */
  dashboardOrigins: string[];
  /** Restore-point window (seconds) the control plane sets on every new database; 0 keeps none. */
  engineRetentionWindowSecs: number;
}

export const DNS_ZONES = ['db', 'domain'] as const;
export type DnsZone = (typeof DNS_ZONES)[number];

export type Lookup = (key: string) => string | undefined;

const ENV_NAMES: Record<string, string> = { baseDomain: 'BASE_DOMAIN' };

/** Environment variable that can supply a setting: BASE_DOMAIN, or FENVIX_<SNAKE_CASE_KEY>. */
export function envVarName(key: string): string {
  return ENV_NAMES[key] ?? `FENVIX_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
}

function int(name: string, raw: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number, got "${raw}"`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}, got ${n}`);
  return n;
}

/**
 * Environment variables win over CDK context (cdk.json and -c), because cdk.json ships placeholder defaults
 * and the founder sets the real values with `export` in the shell. An empty variable counts as not set.
 */
export function makeLookup(context: Lookup, env: Record<string, string | undefined>): Lookup {
  return (key) => {
    const fromEnv = env[envVarName(key)];
    if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv;
    return context(key);
  };
}

export function loadConfig(get: Lookup): FenvixConfig {
  const val = (key: string): string | undefined => {
    const v = get(key);
    return v === undefined || String(v).trim() === '' ? undefined : String(v).trim();
  };
  const need = (key: string): string => {
    const v = val(key);
    if (v === undefined) {
      throw new Error(`Missing setting "${key}". Pass -c ${key}=... or set ${envVarName(key)} (see README.md).`);
    }
    return v;
  };

  const regions = need('regions').split(',').map((r) => r.trim()).filter(Boolean);
  for (const r of regions) {
    if (!/^[a-z]{2}-[a-z]+-\d$/.test(r)) throw new Error(`"${r}" is not an AWS region name like eu-west-1`);
  }
  if (new Set(regions).size !== regions.length) throw new Error('regions contains a duplicate');

  const envName = need('env');
  if (!/^[a-z][a-z0-9-]{0,15}$/.test(envName)) throw new Error('env must be lowercase letters, digits or "-" (max 16)');

  const instanceType = need('instanceType');
  if (!(ALLOWED_INSTANCE_TYPES as readonly string[]).includes(instanceType)) {
    throw new Error(`instanceType must be one of ${ALLOWED_INSTANCE_TYPES.join(', ')}, got "${instanceType}"`);
  }

  const budgetEmail = need('budgetEmail');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(budgetEmail)) throw new Error('budgetEmail is not an email address');
  const budgetAmountUsd = Number(need('budgetAmount'));
  if (!Number.isFinite(budgetAmountUsd) || budgetAmountUsd <= 0) throw new Error('budgetAmount must be a number above 0');

  const mongoPort = int('mongoPort', need('mongoPort'), 1024, 65535);
  const adminPort = int('adminPort', need('adminPort'), 1024, 65535);
  const controlPlanePort = int('controlPlanePort', need('controlPlanePort'), 1, 65535);
  if ([mongoPort, controlPlanePort].includes(adminPort)) throw new Error('adminPort must differ from mongoPort and controlPlanePort');
  if (controlPlanePort === mongoPort) throw new Error('controlPlanePort must differ from mongoPort');

  const baseDomain = need('baseDomain').toLowerCase();
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(baseDomain)) {
    throw new Error(`BASE_DOMAIN "${baseDomain}" is not a domain name like example.com`);
  }
  const hostedZoneId = val('hostedZoneId');
  if (hostedZoneId !== undefined && !/^Z[A-Z0-9]+$/.test(hostedZoneId)) throw new Error('hostedZoneId looks wrong (expected Z...)');
  // Every region needs its own DNS record and challenge records in the zone, so a second region must find an existing zone.
  if (regions.length > 1 && hostedZoneId === undefined) {
    throw new Error('More than one region needs hostedZoneId (an existing Route 53 zone, named as dnsZone says) so every region can add its own records.');
  }

  const dnsZone = val('dnsZone') ?? 'db';
  if (!(DNS_ZONES as readonly string[]).includes(dnsZone)) throw new Error(`dnsZone must be "db" or "domain", got "${dnsZone}"`);

  const acmeEmail = need('acmeEmail');
  if (!/^[^@\s'"$`\\]+@[^@\s'"$`\\]+\.[^@\s'"$`\\]+$/.test(acmeEmail)) throw new Error('acmeEmail is not an email address');
  const acmeStagingRaw = (val('acmeStaging') ?? 'false').toLowerCase();
  if (acmeStagingRaw !== 'true' && acmeStagingRaw !== 'false') throw new Error(`acmeStaging must be "true" or "false", got "${acmeStagingRaw}"`);

  const dashboardOrigins = need('dashboardOrigins').split(',').map((o) => o.trim()).filter(Boolean);
  for (const o of dashboardOrigins) {
    if (!/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(o)) throw new Error(`dashboardOrigins: "${o}" must be an https:// origin without path or trailing slash`);
    // The dashboard (console.<domain>, Vercel) and the API (api.<domain>, this stack) are different origins: allowing
    // the API's own origin, or a database host, would only widen CORS to hosts that are not the dashboard.
    const host = o.slice('https://'.length).replace(/:\d+$/, '');
    if (host === `api.${baseDomain}`) throw new Error(`dashboardOrigins: "${o}" is the API's own origin, not the dashboard's`);
    if (host === `db.${baseDomain}` || host.endsWith(`.db.${baseDomain}`)) throw new Error(`dashboardOrigins: "${o}" is a database host, not the dashboard`);
  }
  if (dashboardOrigins.length === 0) throw new Error('dashboardOrigins: give at least one origin, e.g. https://console.fenvix.dev');
  const proxyImage = need('proxyImage');
  if (!/^[A-Za-z0-9._\-/:@]+$/.test(proxyImage)) throw new Error('proxyImage is not a valid image reference');
  for (const gone of ['engineUrl', 'controlPlaneImage']) {
    if (val(gone) !== undefined) {
      throw new Error(`"${gone}" is no longer used: the server takes the engine and the control plane from the artifacts bucket. Set engineVersion, engineSha256, controlPlaneVersion, controlPlaneSha256 instead (docs/deploy-checklist.md).`);
    }
  }
  const pinKeys = ['engineVersion', 'engineSha256', 'controlPlaneVersion', 'controlPlaneSha256'] as const;
  const pins = Object.fromEntries(pinKeys.map((k) => [k, val(k)])) as Record<(typeof pinKeys)[number], string | undefined>;
  const setPins = pinKeys.filter((k) => pins[k] !== undefined);
  if (setPins.length !== 0 && setPins.length !== pinKeys.length) {
    throw new Error(`Set all of ${pinKeys.join(', ')} or none of them (none = first deploy, nothing published yet). Missing: ${pinKeys.filter((k) => pins[k] === undefined).join(', ')}`);
  }
  for (const k of ['engineVersion', 'controlPlaneVersion'] as const) {
    if (pins[k] !== undefined && !VERSION_RE.test(pins[k]!)) throw new Error(`${k} must be letters, digits, ".", "_" or "-" (as the publish workflow prints it), got "${pins[k]}"`);
  }
  for (const k of ['engineSha256', 'controlPlaneSha256'] as const) {
    if (pins[k] !== undefined) {
      pins[k] = pins[k]!.toLowerCase();
      if (!SHA256_RE.test(pins[k]!)) throw new Error(`${k} must be 64 hex characters`);
    }
  }
  const repo = (key: string) => {
    const v = need(key);
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(v)) throw new Error(`${key} must be owner/repository, got "${v}"`);
    return v;
  };
  const numericId = (key: string) => {
    const v = val(key);
    if (v === undefined || v === '') return undefined;
    if (!/^\d{1,20}$/.test(v)) throw new Error(`${key} must be a number (the GitHub id), got "${v}"`);
    return v;
  };
  const branches = (key: string) => {
    const list = need(key).split(',').map((b) => b.trim()).filter(Boolean);
    for (const b of list) {
      // No wildcard: the trust policy names each branch exactly.
      if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(b)) throw new Error(`${key}: "${b}" is not a plain branch name (no wildcards)`);
    }
    if (list.length === 0) throw new Error(`${key}: give at least one branch`);
    return list;
  };
  const githubOidcProviderArn = val('githubOidcProviderArn');
  if (githubOidcProviderArn !== undefined && !/^arn:aws:iam::\d{12}:oidc-provider\/token\.actions\.githubusercontent\.com$/.test(githubOidcProviderArn)) {
    throw new Error('githubOidcProviderArn must be arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com');
  }
  const artifactsBucket = val('artifactsBucket');
  if (artifactsBucket !== undefined && !/^fenvix-[a-z0-9.-]{1,55}[a-z0-9]$/.test(artifactsBucket)) throw new Error('artifactsBucket must be the ArtifactsBucketName output of the first region (fenvix-...)');
  if (regions.length > 1 && artifactsBucket === undefined) {
    throw new Error('More than one region needs artifactsBucket: the ArtifactsBucketName output of the first region, where the artifacts are published.');
  }

  const account = val('account');
  if (account !== undefined && !/^\d{12}$/.test(account)) throw new Error('account must be 12 digits');

  return {
    account,
    regions,
    envName,
    instanceType: instanceType as AllowedInstanceType,
    volumeGb: int('volumeGb', need('volumeGb'), 8, 200),
    retentionDays: int('retentionDays', need('retentionDays'), 1, 3650),
    budgetAmountUsd,
    budgetEmail,
    mongoPort,
    adminPort,
    controlPlanePort,
    ...pins,
    engineRepo: repo('engineRepo'),
    engineRepoBranches: branches('engineRepoBranches'),
    controlPlaneRepo: repo('controlPlaneRepo'),
    controlPlaneRepoBranches: branches('controlPlaneRepoBranches'),
    githubOwnerId: numericId('githubOwnerId'),
    engineRepoId: numericId('engineRepoId'),
    controlPlaneRepoId: numericId('controlPlaneRepoId'),
    githubOidcProviderArn,
    artifactsBucket,
    proxyImage,
    baseDomain,
    dnsZone: dnsZone as DnsZone,
    hostedZoneId,
    acmeEmail,
    acmeStaging: acmeStagingRaw === 'true',
    dashboardOrigins,
    engineRetentionWindowSecs: int('engineRetentionWindowSecs', need('engineRetentionWindowSecs'), 0, 31_536_000),
  };
}
