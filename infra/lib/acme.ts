import { readFileSync } from 'fs';
import { join } from 'path';
import { FenvixConfig } from './config';
import { consoleHost } from './control-plane-env';

/**
 * Let's Encrypt on the server: certbot (pinned, installed from PyPI with --require-hashes into a venv on the host)
 * answers DNS-01 challenges in the stack's Route 53 zone through a small hook that calls the AWS CLI. The issued
 * certificate and key are kept in a Secrets Manager secret of the stack, so a replaced server reuses them instead of
 * requesting a new one (Let's Encrypt allows 5 identical certificates a week). README.md, "TLS certificate".
 */
export const ACME_DIRECTORY = {
  production: 'https://acme-v02.api.letsencrypt.org/directory',
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
} as const;

export function acmeServer(c: FenvixConfig): string {
  return c.acmeStaging ? ACME_DIRECTORY.staging : ACME_DIRECTORY.production;
}

/** certbot and its dependencies, each pinned with the SHA-256 of its wheels (scripts/gen-acme-requirements.py). */
export const ACME_REQUIREMENTS = readFileSync(join(__dirname, 'acme-requirements.txt'), 'utf8');

/** The scripts copied to the server as they are (no value is substituted into them; settings are in /etc/fenvix/tls.env). */
export const TLS_SCRIPT = readFileSync(join(__dirname, 'scripts', 'fenvix-tls.sh'), 'utf8');
export const DNS_HOOK_SCRIPT = readFileSync(join(__dirname, 'scripts', 'fenvix-acme-dns-hook.sh'), 'utf8');

/** Name of the Route 53 zone the stack creates or is given. */
export function zoneName(c: FenvixConfig): string {
  return c.dnsZone === 'db' ? `db.${c.baseDomain}` : c.baseDomain;
}

/**
 * With dnsZone=db the zone is db.<domain> and console.<domain> lives at the domain's own DNS provider. Its challenge
 * name is then delegated with a CNAME made there by hand (README.md) to this name in the Route 53 zone.
 */
export function consoleChallengeTarget(c: FenvixConfig): string {
  return `_acme-challenge-console.db.${c.baseDomain}`;
}

export interface ChallengeRecord {
  /** Name in the certificate. */
  certName: string;
  /** What certbot puts in CERTBOT_DOMAIN for it (a wildcard's base name). */
  certbotDomain: string;
  /** TXT record the hook writes in the Route 53 zone (lowercase, no trailing dot: the form IAM compares). */
  record: string;
}

/**
 * The names of a region's certificate and the only TXT records its server may write. The console name is in the
 * certificate of the region that runs the control plane only (the other regions have no use for it, and their role
 * then cannot touch its challenge record).
 */
export function challengeRecords(c: FenvixConfig, region: string, withConsole: boolean): ChallengeRecord[] {
  const db = `${region}.db.${c.baseDomain}`;
  const out: ChallengeRecord[] = [{ certName: `*.${db}`, certbotDomain: db, record: `_acme-challenge.${db}` }];
  if (withConsole) {
    const host = consoleHost(c);
    out.push({
      certName: host,
      certbotDomain: host,
      record: c.dnsZone === 'db' ? consoleChallengeTarget(c) : `_acme-challenge.${host}`,
    });
  }
  return out;
}

export interface TlsEnvInput {
  config: FenvixConfig;
  region: string;
  withConsole: boolean;
  /** Units restarted when a new certificate is installed. */
  restartUnits: string[];
}

/**
 * /etc/fenvix/tls.env without the two values only CloudFormation knows (secret ARN and zone id, appended at boot).
 * Every value is checked by loadConfig to hold no quote, so single quotes are safe.
 */
export function tlsEnv(i: TlsEnvInput): string[] {
  const recs = challengeRecords(i.config, i.region, i.withConsole);
  return [
    `ACME_SERVER='${acmeServer(i.config)}'`,
    `ACME_EMAIL='${i.config.acmeEmail}'`,
    `ACME_DOMAINS='${recs.map((r) => r.certName).join(' ')}'`,
    `ACME_RECORDS='${recs.map((r) => `${r.certbotDomain}=${r.record}`).join(' ')}'`,
    `AWS_REGION='${i.region}'`,
    `RESTART_UNITS='${i.restartUnits.join(' ')}'`,
  ];
}
