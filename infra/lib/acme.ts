import { FenvixConfig } from './config';
import { consoleHost } from './control-plane-env';
import { PATHS } from './engine-command';

/**
 * The ACME client: lego (github.com/go-acme/lego), one static binary, pinned to a version and to the SHA-256 of
 * its release archive. The hashes were computed on the downloaded archives and match the release's
 * lego_5.5.2_checksums.txt. The boot script refuses an archive with another hash. To upgrade: change the version,
 * download both archives, check them against the release checksum file, put the new hashes here.
 */
export const LEGO = {
  version: '5.5.2',
  sha256: {
    x86_64: '2a35505089e7772c92e1e9ac144df91151ef2eca8568630db0ff91fca06d9bef',
    aarch64: '15b14ec2ab14fde69cc8396eb0204c5ce4327e31a486953225a6059b26db3e8c',
  },
} as const;

/** `uname -m` -> release archive. */
export function legoUrl(goArch: 'amd64' | 'arm64'): string {
  return `https://github.com/go-acme/lego/releases/download/v${LEGO.version}/lego_v${LEGO.version}_linux_${goArch}.tar.gz`;
}

export const ACME_DIRECTORY = {
  production: 'https://acme-v02.api.letsencrypt.org/directory',
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
} as const;

/** The certificate is renewed when fewer days than this are left (Let's Encrypt certificates last 90 days). */
export const RENEW_DAYS = 30;

/** After a failed request to Let's Encrypt, no new one for this long (Let's Encrypt allows 5 failed validations an hour). */
export const RETRY_AFTER_FAILURE_SECS = 20 * 60;

/** Where lego keeps its account and certificate on the server (root only); never seen by a container. */
export const ACME_DATA_DIR = '/var/lib/fenvix-acme';

/** The stack's hosted zone id, written by the user data (it is a CloudFormation value, unknown at synth time). */
export const ACME_ZONE_ID_FILE = '/etc/fenvix/acme-zone-id';

/** Name of the Route 53 zone of the stack. */
export function zoneName(c: FenvixConfig): string {
  return c.dnsZone === 'db' ? `db.${c.baseDomain}` : c.baseDomain;
}

/** Names on the region's certificate: its database wildcard, and console.<domain> where the control plane runs. */
export function certificateDomains(c: FenvixConfig, region: string, withConsole: boolean): string[] {
  return [`*.${region}.db.${c.baseDomain}`, ...(withConsole ? [consoleHost(c)] : [])];
}

/**
 * The TXT records lego writes in the stack's zone, as Route 53 normalizes them (lowercase, no final dot). With
 * dnsZone=db, console.<domain> is not in the zone: its `_acme-challenge` is a CNAME (made by hand where the domain's
 * DNS is) to `_acme-challenge.console.db.<domain>`, and lego follows it.
 */
export function challengeRecordNames(c: FenvixConfig, region: string, withConsole: boolean): string[] {
  return [
    `_acme-challenge.${region}.db.${c.baseDomain}`,
    ...(withConsole ? [c.dnsZone === 'db' ? `_acme-challenge.console.db.${c.baseDomain}` : `_acme-challenge.${consoleHost(c)}`] : []),
  ];
}

/** Hand-made CNAME needed with dnsZone=db (empty otherwise): [name, target]. */
export function consoleChallengeCname(c: FenvixConfig): [string, string] | undefined {
  return c.dnsZone === 'db' ? [`_acme-challenge.${consoleHost(c)}`, `_acme-challenge.console.db.${c.baseDomain}`] : undefined;
}

/**
 * SSM parameter (Advanced tier SecureString, 8 KB) where the server keeps the certificate, its key and the ACME
 * account, so a replaced instance reuses them instead of asking Let's Encrypt again. Written by the server, never by
 * the stack (CloudFormation cannot make SecureString parameters). Outside /fenvix/<env>/, which the services read.
 */
export function tlsStateParameter(envName: string): string {
  return `/fenvix-tls/${envName}/acme-state`;
}

export interface TlsScriptInput {
  region: string;
  staging: boolean;
  email: string;
  domains: string[];
  stateParameter: string;
  /** Units restarted when a renewed certificate is installed (--restart-on-change). */
  restartUnits: string[];
  /** Overridable for the tests only. */
  pem?: string;
  dataDir?: string;
  owner?: string;
  tmpBase?: string;
  zoneIdFile?: string;
}

/**
 * fenvix-tls: gets the server its certificate and keeps it current. Run as root on the host (the instance role is
 * reachable from the host only) before the engine and the TLS terminator start, and twice a day by a timer.
 *   1. Nothing usable on disk: restore certificate and ACME account from the SSM parameter.
 *   2. No certificate, or fewer than RENEW_DAYS days left: ask Let's Encrypt (lego, DNS-01 on Route 53).
 *   3. Install it as the engine's PEM file (chain + key, 0600, owner fenvix), only if it changed.
 *   4. Save it in SSM when it changed. 5. Restart the engine and the terminator only if it changed (timer only).
 * Without a valid certificate it exits 1 with the reason, so the services do not start without TLS. It never prints
 * a key: error output of lego and the AWS CLI is shortened and anything long or key-like is removed.
 */
export function tlsScript(i: TlsScriptInput): string {
  const q = (s: string) => `'${s}'`;
  return String.raw`#!/bin/bash
set -euo pipefail
umask 077
REGION=${q(i.region)}
ZONE_ID="$(cat ${q(i.zoneIdFile ?? ACME_ZONE_ID_FILE)} 2>/dev/null || true)"
SERVER=${q(i.staging ? ACME_DIRECTORY.staging : ACME_DIRECTORY.production)}
EMAIL=${q(i.email)}
DOMAINS=(${i.domains.map(q).join(' ')})
STATE=${q(i.stateParameter)}
PEM=${q(i.pem ?? PATHS.enginePem)}
DATA=${q(i.dataDir ?? ACME_DATA_DIR)}
OWNER=${q(i.owner ?? 'fenvix')}
RENEW_DAYS=${RENEW_DAYS}
CRT="$DATA/certificates/fenvix.crt"
KEY="$DATA/certificates/fenvix.key"
WANT="$SERVER ${'$'}{DOMAINS[*]}"
say() { echo "fenvix-tls: $*"; }
die() { echo "fenvix-tls: FATAL: $* The engine and the TLS terminator do not start without a certificate (infra/README.md, Certificate)." >&2; exit 1; }
clean() { sed -E '/-----|PRIVATE/d; s/[A-Za-z0-9_+\/=-]{32,}/[redacted]/g' "$1" | tail -n 15 | cut -c1-300; }
fp() { openssl x509 -in "$1" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2; }
mine() { [ -s "$CRT" ] && [ -s "$KEY" ] && [ "$(cat "$DATA/fenvix.meta" 2>/dev/null)" = "$WANT" ]; }
valid() { openssl x509 -in "$1" -noout -checkend "$2" >/dev/null 2>&1; }
[ -n "$ZONE_ID" ] || die "no hosted zone id in ${i.zoneIdFile ?? ACME_ZONE_ID_FILE}."
install -d -m 0700 "$DATA"
exec 9> "$DATA/.lock"
flock 9
w="$(mktemp -d ${i.tmpBase ?? '/run'}/fenvix-tls.XXXXXX)"
trap 'rm -rf "$w"' EXIT

if ! mine; then
  if aws ssm get-parameter --region "$REGION" --name "$STATE" --with-decryption --query Parameter.Value --output text > "$w/state" 2> "$w/err"; then
    mkdir "$w/r"
    base64 -d "$w/state" 2>/dev/null | tar -xz -C "$w/r" 2>/dev/null || die "the saved state in $STATE is unreadable; delete that parameter to get a new certificate."
    if [ -d "$w/r/accounts" ]; then rm -rf "$DATA/accounts"; cp -a "$w/r/accounts" "$DATA/"; fi
    if [ "$(cat "$w/r/fenvix.meta" 2>/dev/null)" = "$WANT" ]; then
      rm -rf "$DATA/certificates"; cp -a "$w/r/certificates" "$w/r/fenvix.meta" "$DATA/"
      fp "$CRT" > "$DATA/.saved"
      say "certificate restored from $STATE"
    else
      say "the certificate in $STATE is for other names or another ACME server: not used"
    fi
  elif grep -q ParameterNotFound "$w/err"; then
    say "no certificate saved in $STATE yet"
  else
    say "cannot read $STATE:" >&2; clean "$w/err" >&2
    valid "$PEM" 0 || die "no certificate on this server and the saved one cannot be read."
  fi
fi

if mine && valid "$CRT" $((RENEW_DAYS * 86400)); then
  say "certificate valid for more than $RENEW_DAYS days: no request to Let's Encrypt"
elif [ $(( $(date +%s) - $(cat "$DATA/.failed" 2>/dev/null || echo 0) )) -lt ${RETRY_AFTER_FAILURE_SECS} ]; then
  say "the last request to Let's Encrypt failed less than ${RETRY_AFTER_FAILURE_SECS / 60} minutes ago: not asking again yet" >&2
else
  mine || rm -rf "$DATA/certificates" "$DATA/fenvix.meta"
  args=(--accept-tos --server "$SERVER" --email "$EMAIL" --path "$DATA" --dns route53 --key-type ec256 --cert.name fenvix --renew-days "$RENEW_DAYS" --ari-disable --no-random-sleep --force-cert-domains --log.format text)
  for d in "${'$'}{DOMAINS[@]}"; do args+=(--domains "$d"); done
  if AWS_REGION="$REGION" AWS_HOSTED_ZONE_ID="$ZONE_ID" lego run "${'$'}{args[@]}" > "$w/lego" 2>&1; then
    echo "$WANT" > "$DATA/fenvix.meta"; rm -f "$DATA/.failed"
    say "certificate from Let's Encrypt for ${'$'}{DOMAINS[*]} ($SERVER)"
  else
    date +%s > "$DATA/.failed"
    say "the request to Let's Encrypt failed:" >&2; clean "$w/lego" >&2
  fi
fi

if ! { mine && valid "$CRT" 0; }; then
  valid "$PEM" 0 || die "no valid certificate."
  say "WARNING: keeping the installed certificate, $(openssl x509 -in "$PEM" -noout -enddate)" >&2
  exit 0
fi
new="$(fp "$CRT")"
old=none; if [ -s "$PEM" ]; then old="$(fp "$PEM")"; fi
changed=0
if [ "$new" != "$old" ]; then
  cat "$CRT" "$KEY" > "$w/engine.pem"
  install -m 0600 -o "$OWNER" -g "$OWNER" "$w/engine.pem" "$PEM.new" && mv -f "$PEM.new" "$PEM"
  changed=1
  say "certificate installed ($old -> $new), $(openssl x509 -in "$PEM" -noout -enddate)"
else
  say "certificate unchanged ($new)"
fi

if [ "$new" != "$(cat "$DATA/.saved" 2>/dev/null)" ]; then
  tar -C "$DATA" -cz accounts certificates fenvix.meta | base64 -w0 > "$w/state"
  if [ "$(stat -c %s "$w/state")" -gt 8192 ]; then
    say "WARNING: certificate state larger than an SSM parameter (8 KB): not saved" >&2
  elif aws ssm put-parameter --region "$REGION" --name "$STATE" --type SecureString --tier Advanced --overwrite --value "file://$w/state" > /dev/null 2> "$w/err"; then
    echo "$new" > "$DATA/.saved"; say "certificate saved in $STATE"
  else
    say "WARNING: cannot save the certificate in $STATE (tried again at the next run; until then a replaced server asks for a new one):" >&2; clean "$w/err" >&2
  fi
fi

exec 9>&-
if [ "$changed" = 1 ] && [ "${'$'}{1:-}" = "--restart-on-change" ]; then systemctl try-restart ${i.restartUnits.join(' ')}; fi
`;
}
