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
  adminPort: number;
  controlPlanePort: number;
  /** Engine release URL. `{arch}` is replaced on the instance with `uname -m` (x86_64 or aarch64). */
  engineUrl: string;
  /** Optional sha256 of the engine binary; when set the instance refuses a binary that does not match. */
  engineSha256?: string;
  /** Control-plane container image reference. */
  controlPlaneImage: string;
  /** Set to create DNS + certificate resources. Leave unset for none. */
  baseDomain?: string;
  /** Use an existing Route 53 hosted zone instead of creating one (only with baseDomain). */
  hostedZoneId?: string;
}

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
    if (!/^[a-z]{2}-[a-z]+-\d$/.test(r)) throw new Error(`"${r}" is not an AWS region name like eu-central-1`);
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

  const adminPort = int('adminPort', need('adminPort'), 1024, 65535);
  const controlPlanePort = int('controlPlanePort', need('controlPlanePort'), 1, 65535);
  if ([27017, controlPlanePort].includes(adminPort)) throw new Error('adminPort must differ from 27017 and controlPlanePort');
  if (controlPlanePort === 27017) throw new Error('controlPlanePort must differ from 27017');

  const baseDomain = val('baseDomain')?.toLowerCase();
  if (baseDomain !== undefined && !/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(baseDomain)) {
    throw new Error(`BASE_DOMAIN "${baseDomain}" is not a domain name like example.com`);
  }
  const hostedZoneId = val('hostedZoneId');
  if (hostedZoneId !== undefined && !/^Z[A-Z0-9]+$/.test(hostedZoneId)) throw new Error('hostedZoneId looks wrong (expected Z...)');
  const engineSha256 = val('engineSha256')?.toLowerCase();
  if (engineSha256 !== undefined && !/^[0-9a-f]{64}$/.test(engineSha256)) throw new Error('engineSha256 must be 64 hex characters');

  const engineUrl = need('engineUrl');
  if (!/^https:\/\/[^\s'"$`\\]+$/.test(engineUrl)) throw new Error('engineUrl must be an https:// URL without spaces or shell characters');
  const controlPlaneImage = need('controlPlaneImage');
  if (!/^[A-Za-z0-9._\-/:@]+$/.test(controlPlaneImage)) throw new Error('controlPlaneImage is not a valid image reference');

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
    adminPort,
    controlPlanePort,
    engineUrl,
    engineSha256,
    controlPlaneImage,
    baseDomain,
    hostedZoneId,
  };
}
