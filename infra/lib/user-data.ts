import { FenvixConfig } from './config';

export interface UserDataInput {
  config: FenvixConfig;
  region: string;
  /** Bucket name; may be a CDK token. */
  bucketName: string;
  /** Names (under the SSM prefix) that must exist, or the services refuse to start. */
  requiredParameters: string[];
  /** ACM certificate ARN when a domain is configured; passed to the engine only as information. */
  certificateArn?: string;
}

export function ssmPrefix(envName: string): string {
  return `/fenvix/${envName}`;
}

// Turns every SecureString under one SSM path into KEY=value lines.
// systemd format (quoted, escaped) for the engine, raw format for `docker --env-file`.
export const FETCH_CONFIG = String.raw`#!/usr/bin/env python3
import json, subprocess, sys, os
region, prefix, out_systemd, out_docker, group, env_prefix, *required = sys.argv[1:]
def fetch(path):
    r = subprocess.run(["aws", "ssm", "get-parameters-by-path", "--region", region, "--path", path,
                        "--with-decryption", "--recursive", "--output", "json"], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("fenvix-fetch-config: cannot read " + path + ": " + r.stderr.strip())
    return json.loads(r.stdout)["Parameters"]
params = fetch(prefix + "/" + group)
found = {p["Name"] for p in params}
missing = [n for n in required if n not in found]
if missing:
    sys.exit("fenvix-fetch-config: missing SSM parameters (create them as SecureString in the console): " + ", ".join(missing))
def key(p):
    return env_prefix + p["Name"].rsplit("/", 1)[1].upper().replace("-", "_")
sysd, dock = [], []
for p in params:
    v = p["Value"]
    if "\n" in v:
        sys.exit("fenvix-fetch-config: " + p["Name"] + " contains a newline")
    sysd.append(key(p) + '="' + v.replace("\\", "\\\\").replace('"', '\\"') + '"')
    dock.append(key(p) + "=" + v)
for path, lines, in ((out_systemd, sysd), (out_docker, dock)):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines) + "\n")
`;

export function buildUserData(i: UserDataInput): string[] {
  const c = i.config;
  const prefix = ssmPrefix(c.envName);
  const heredoc = (target: string, body: string, mode = '0644') => [
    `cat > ${target} <<'FENVIX_EOF'`,
    ...body.replace(/\n$/, '').split('\n'),
    'FENVIX_EOF',
    `chmod ${mode} ${target}`,
  ];
  const required = (group: string) =>
    i.requiredParameters.filter((p) => p.startsWith(`${prefix}/${group}/`)).join(' ');

  return [
    '#!/bin/bash',
    'set -euo pipefail',
    'exec > >(tee -a /var/log/fenvix-bootstrap.log) 2>&1',
    'echo "fenvix bootstrap start $(date -u +%FT%TZ)"',
    '',
    '# Settings baked in at synth time (no secrets here; secrets come from SSM at service start).',
    `ENGINE_URL='${c.engineUrl}'`,
    `ENGINE_SHA256='${c.engineSha256 ?? ''}'`,
    `CONTROL_PLANE_IMAGE='${c.controlPlaneImage}'`,
    '',
    'case "$ENGINE_URL $CONTROL_PLANE_IMAGE" in',
    '  *example.invalid*|*REPLACE-ME*) echo "FATAL: release location still has the placeholder value. Set engineUrl and controlPlaneImage (infra/README.md) and redeploy." >&2; exit 1;;',
    'esac',
    '',
    'dnf install -y docker',
    'systemctl enable --now docker',
    'id fenvix >/dev/null 2>&1 || useradd --system --home-dir /var/lib/fenvix --shell /sbin/nologin fenvix',
    'install -d -o fenvix -g fenvix /opt/fenvix/bin /var/lib/fenvix',
    'install -d -m 0750 -o root -g fenvix /etc/fenvix',
    '',
    'ARCH="$(uname -m)"',
    'URL="${ENGINE_URL//\\{arch\\}/$ARCH}"',
    'curl --fail --silent --show-error --location --retry 5 --output /opt/fenvix/bin/fenvix-engine "$URL"',
    'if [ -n "$ENGINE_SHA256" ]; then echo "$ENGINE_SHA256  /opt/fenvix/bin/fenvix-engine" | sha256sum -c -; fi',
    'chmod 0755 /opt/fenvix/bin/fenvix-engine',
    '',
    ...heredoc('/usr/local/bin/fenvix-fetch-config', FETCH_CONFIG, '0755'),
    '',
    '# Non-secret settings for the engine (names are the contract with the engine; see infra/README.md).',
    ...heredoc(
      '/etc/fenvix/engine.static.env',
      [
        `FENVIX_S3_BUCKET=${i.bucketName}`,
        `FENVIX_AWS_REGION=${i.region}`,
        `FENVIX_LISTEN=0.0.0.0:${c.mongoPort}`,
        `FENVIX_ADMIN_LISTEN=0.0.0.0:${c.adminPort}`,
        'FENVIX_TLS_MODE=self-signed',
        ...(c.baseDomain ? [`FENVIX_BASE_DOMAIN=${c.baseDomain}`] : []),
        ...(i.certificateArn ? [`FENVIX_ACM_CERTIFICATE_ARN=${i.certificateArn}`] : []),
      ].join('\n'),
    ),
    ...heredoc(
      '/etc/fenvix/control-plane.static.env',
      [`FENVIX_REGION=${i.region}`, `PORT=8443`, ...(c.baseDomain ? [`BASE_DOMAIN=${c.baseDomain}`] : [])].join('\n'),
    ),
    '',
    ...heredoc(
      '/etc/systemd/system/fenvix-engine.service',
      [
        '[Unit]',
        'Description=FENVIX engine',
        'After=network-online.target',
        'Wants=network-online.target',
        '[Service]',
        'User=fenvix',
        'EnvironmentFile=/etc/fenvix/engine.static.env',
        'EnvironmentFile=/etc/fenvix/engine.env',
        `ExecStartPre=+/usr/local/bin/fenvix-fetch-config ${i.region} ${prefix} /etc/fenvix/engine.env /dev/null engine FENVIX_ ${required('engine')}`,
        'ExecStart=/opt/fenvix/bin/fenvix-engine',
        'Restart=always',
        'RestartSec=5',
        'LimitNOFILE=65536',
        'NoNewPrivileges=true',
        'ProtectSystem=strict',
        'StateDirectory=fenvix',
        'ReadWritePaths=/var/lib/fenvix',
        '[Install]',
        'WantedBy=multi-user.target',
      ].join('\n'),
    ),
    ...heredoc(
      '/etc/systemd/system/fenvix-control-plane.service',
      [
        '[Unit]',
        'Description=FENVIX control plane (container)',
        'After=docker.service network-online.target',
        'Requires=docker.service',
        '[Service]',
        `ExecStartPre=+/usr/local/bin/fenvix-fetch-config ${i.region} ${prefix} /dev/null /etc/fenvix/control-plane.env control-plane "" ${required('control-plane')}`,
        `ExecStartPre=/usr/bin/docker pull ${c.controlPlaneImage}`,
        '-ExecStartPre=/usr/bin/docker rm -f fenvix-control-plane',
        `ExecStart=/usr/bin/docker run --rm --name fenvix-control-plane --env-file /etc/fenvix/control-plane.static.env --env-file /etc/fenvix/control-plane.env -p ${c.controlPlanePort}:8443 ${c.controlPlaneImage}`,
        'ExecStop=/usr/bin/docker stop fenvix-control-plane',
        'Restart=always',
        'RestartSec=5',
        '[Install]',
        'WantedBy=multi-user.target',
      ].join('\n'),
    ),
    '',
    'systemctl daemon-reload',
    'systemctl enable --now fenvix-engine.service fenvix-control-plane.service',
    'echo "fenvix bootstrap done $(date -u +%FT%TZ)"',
  ];
}
