import { createHash } from 'crypto';
import { Token } from 'aws-cdk-lib';
import { gunzipSync, gzipSync } from 'zlib';
import { ACME_REQUIREMENTS, DNS_HOOK_SCRIPT, TLS_SCRIPT, tlsEnv } from './acme';
import { FenvixConfig } from './config';
import {
  CONTROL_PLANE_CONTAINER,
  CONTROL_PLANE_INTERNAL_PORT,
  apiHost,
  controlPlaneEnvironment,
} from './control-plane-env';
import { DOCKER_BRIDGE_IP, INSTANCE_ID_PLACEHOLDER, PATHS, engineArgs, engineEnvironment } from './engine-command';
import { MUST_MATCH, ssmPrefix } from './parameters';

export { ssmPrefix };

export interface UserDataInput {
  config: FenvixConfig;
  region: string;
  /** Bucket name. Must be known at synth time (it is inside the compressed part of the boot script). */
  bucketName: string;
  /** Full SSM names that must exist, or the services refuse to start (lib/parameters.ts). */
  requiredParameters: string[];
  /** Secrets Manager secret that keeps the Let's Encrypt certificate and key. May be a CDK token. */
  tlsSecretArn: string;
  /** Route 53 zone the DNS-01 challenge records go to. May be a CDK token. */
  hostedZoneId: string;
  /** The control plane and its TLS terminator run in the first region only (DNS for api.<domain> points there). */
  runControlPlane: boolean;
}

/** Docker network shared by the control plane and its TLS terminator (the control plane publishes no port). */
const DOCKER_NETWORK = 'fenvix';

// Reads the parameters under /fenvix/<env> at every service start. The engine gets one file per parameter of its
// group (0600, owned by the service user); the control plane gets a docker env file (0600, root). Values are never
// printed. A missing required parameter stops the service with its name.
export const FETCH_CONFIG = String.raw`#!/usr/bin/env python3
import argparse, json, os, pwd, subprocess, sys
ap = argparse.ArgumentParser()
for o in ("--region", "--prefix", "--group"):
    ap.add_argument(o, required=True)
ap.add_argument("--files"); ap.add_argument("--owner"); ap.add_argument("--env-file")
ap.add_argument("--match", action="append", default=[])
ap.add_argument("required", nargs="*")
a = ap.parse_args()
def die(msg):
    sys.exit("fenvix-fetch-config: " + msg)
r = subprocess.run(["aws", "ssm", "get-parameters-by-path", "--region", a.region, "--path", a.prefix,
                    "--with-decryption", "--recursive", "--output", "json"], capture_output=True, text=True)
if r.returncode != 0:
    die("cannot read " + a.prefix + ": " + r.stderr.strip()[:500])
values = {p["Name"]: p["Value"] for p in json.loads(r.stdout)["Parameters"]}
missing = [n for n in a.required if n not in values]
if missing:
    die("missing SSM parameters (create them as SecureString, infra/README.md): " + ", ".join(missing))
for m in a.match:
    x, y = (a.prefix + "/" + s for s in m.split("=", 1))
    if values.get(x) != values.get(y):
        die(x + " must hold the same value as " + y)
base = a.prefix + "/" + a.group + "/"
group = {n[len(base):]: v for n, v in values.items() if n.startswith(base) and "/" not in n[len(base):]}
for name, v in group.items():
    if "\n" in v:
        die(base + name + " contains a newline")
def write(path, text, uid=-1, gid=-1):
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chown(path + ".tmp", uid, gid)
    os.rename(path + ".tmp", path)
if a.files:
    u = pwd.getpwnam(a.owner)
    for name, v in group.items():
        write(os.path.join(a.files, name), v, u.pw_uid, u.pw_gid)
if a.env_file:
    write(a.env_file, "".join(k.upper().replace("-", "_") + "=" + v + "\n" for k, v in sorted(group.items())))
`;

/**
 * Run once by an operator (README, Step 10) after the first start. Through the engine's localhost exception it makes
 * the break-glass root user (password typed in, never stored on the server) and the provisioner the control plane
 * uses (role with user-management actions only, password from SSM), as control-plane/docs/data-explorer-security.md
 * says. Uses the control-plane image's MongoDB driver. Prints no password and no engine message (only error codes). Running it again resets the provisioner's password to the SSM value.
 */
export function createEngineUsersScript(c: FenvixConfig, region: string): string {
  const prefix = ssmPrefix(c.envName);
  return String.raw`#!/bin/bash
set -euo pipefail
read -r -s -p "Break-glass root password (from your password manager, 16+ characters): " FENVIX_ROOT_PASSWORD; echo
if [ "${'$'}{#FENVIX_ROOT_PASSWORD}" -lt 16 ]; then echo "fenvix-create-engine-users: the password needs 16 characters or more" >&2; exit 1; fi
FENVIX_PROVISIONER_PASSWORD="$(aws ssm get-parameter --region '${region}' --name '${prefix}/control-plane/engine-provisioner-password' --with-decryption --query Parameter.Value --output text)"
export FENVIX_ROOT_PASSWORD FENVIX_PROVISIONER_PASSWORD
docker run --rm -i --network host -e FENVIX_ROOT_PASSWORD -e FENVIX_PROVISIONER_PASSWORD --entrypoint node '${c.controlPlaneImage}' --input-type=module - <<'JS'
import { MongoClient } from "mongodb";
const url = "mongodb://127.0.0.1:${c.mongoPort}/";
const opts = { directConnection: true, serverSelectionTimeoutMS: 10000, tls: true, tlsAllowInvalidHostnames: true };
const root = { username: "fenvix_root", password: process.env.FENVIX_ROOT_PASSWORD };
const prov = { user: "fenvix_provisioner", pwd: process.env.FENVIX_PROVISIONER_PASSWORD };
const actions = ["createUser", "dropUser", "viewUser", "changePassword", "changeCustomData", "grantRole", "revokeRole"];
const say = (m) => console.log("fenvix-create-engine-users: " + m);
const code = (e) => String((e && (e.codeName || e.code)) || "error");
const anon = new MongoClient(url, opts);
try { await anon.db("admin").command({ createUser: root.username, pwd: root.password, roles: ["root"] }); say("root user fenvix_root created"); }
catch (e) { say("root user not created (" + code(e) + "): it exists already; going on with it"); }
finally { await anon.close(); }
const r = new MongoClient(url, { ...opts, auth: root, authSource: "admin", authMechanism: "SCRAM-SHA-256" });
try {
  const a = r.db("admin");
  try { await a.command({ createRole: "fenvix_provisioner", privileges: [{ resource: { db: "", collection: "" }, actions }], roles: [] }); say("role fenvix_provisioner created"); }
  catch (e) { say("role fenvix_provisioner not created (" + code(e) + "): it exists already"); }
  try { await a.command({ createUser: prov.user, pwd: prov.pwd, roles: [{ role: "fenvix_provisioner", db: "admin" }], mechanisms: ["SCRAM-SHA-256"] }); say("user fenvix_provisioner created"); }
  catch { await a.command({ updateUser: prov.user, pwd: prov.pwd, roles: [{ role: "fenvix_provisioner", db: "admin" }] }); say("user fenvix_provisioner existed: password set from SSM"); }
  say("done");
} catch (e) { say("failed (" + code(e) + ")"); process.exitCode = 1; }
finally { await r.close(); }
JS
`;
}

/** Where the decompressed boot script is kept on the server (no secret in it), for whoever wants to read what ran. */
export const BOOT_SCRIPT_PATH = '/opt/fenvix/boot.sh';
const PAYLOAD_MARK = 'FENVIX_B64';

/**
 * The boot script: everything the server does at first start. It holds no CloudFormation token (it is compressed at
 * synth time); the two deploy-time values arrive as FENVIX_TLS_SECRET_ID and FENVIX_DNS_ZONE_ID from buildUserData.
 */
export function bootScript(i: UserDataInput): string[] {
  const c = i.config;
  if (Token.isUnresolved(i.bucketName)) throw new Error('bucketName must be known at synth time (it goes into the compressed boot script)');
  const prefix = ssmPrefix(c.envName);
  const heredoc = (target: string, body: string, mode = '0644') => [
    `cat > ${target} <<'FENVIX_EOF'`,
    ...body.replace(/\n$/, '').split('\n'),
    'FENVIX_EOF',
    `chmod ${mode} ${target}`,
  ];
  const required = (group: string) => i.requiredParameters.filter((p) => p.startsWith(`${prefix}/${group}/`)).join(' ');
  const fetch = `/usr/local/bin/fenvix-fetch-config --region ${i.region} --prefix ${prefix}`;
  const docker = '/usr/bin/docker';
  const engineEnv = Object.entries(engineEnvironment(i.region)).map(([k, v]) => `Environment=${k}=${v}`);
  const cpEnv = controlPlaneEnvironment({ config: c, region: i.region }).map(([k, v]) => `${k}=${v}`);
  const services = ['fenvix-engine.service', 'fenvix-tls.timer', ...(i.runControlPlane ? ['fenvix-control-plane.service', 'fenvix-proxy.service'] : [])];
  const restartUnits = ['fenvix-engine.service', ...(i.runControlPlane ? ['fenvix-proxy.service'] : [])];

  const controlPlane = !i.runControlPlane
    ? []
    : [
        ...heredoc('/etc/fenvix/control-plane.static.env', cpEnv.join('\n')),
        ...heredoc(
          '/etc/fenvix/proxy/Caddyfile',
          [
            '{',
            '\tadmin off',
            '\tauto_https off',
            '}',
            `https://${apiHost(c)}:443 {`,
            '\ttls /certs/fullchain.pem /certs/key.pem',
            `\treverse_proxy ${CONTROL_PLANE_CONTAINER}:${CONTROL_PLANE_INTERNAL_PORT}`,
            '}',
          ].join('\n'),
        ),
        ...heredoc(
          '/etc/systemd/system/fenvix-control-plane.service',
          [
            '[Unit]',
            'Description=FENVIX control plane (container)',
            'After=docker.service network-online.target fenvix-engine.service',
            'Requires=docker.service',
            '[Service]',
            `ExecStartPre=+${fetch} --group control-plane --env-file /etc/fenvix/control-plane.env --match ${MUST_MATCH.join('=')} ${required('control-plane')} ${required('engine')}`,
            `ExecStartPre=-${docker} network create ${DOCKER_NETWORK}`,
            `ExecStartPre=-${docker} pull ${c.controlPlaneImage}`,
            `ExecStartPre=-${docker} rm -f ${CONTROL_PLANE_CONTAINER}`,
            // No published port: only the TLS terminator reaches it. host-gateway = the Docker bridge, where the engine's
            // admin interface listens; the MongoDB port is reached the same way. IMDS hop limit 1: no AWS credentials here.
            `ExecStart=${docker} run --rm --name ${CONTROL_PLANE_CONTAINER} --network ${DOCKER_NETWORK} --add-host=host.docker.internal:host-gateway --cap-drop=ALL --security-opt=no-new-privileges --env-file /etc/fenvix/control-plane.static.env --env-file /etc/fenvix/control-plane.env ${c.controlPlaneImage}`,
            `ExecStop=${docker} stop ${CONTROL_PLANE_CONTAINER}`,
            'Restart=always',
            'RestartSec=5',
            '[Install]',
            'WantedBy=multi-user.target',
          ].join('\n'),
        ),
        ...heredoc(
          '/etc/systemd/system/fenvix-proxy.service',
          [
            '[Unit]',
            'Description=FENVIX TLS terminator for the control plane (container)',
            'After=docker.service fenvix-control-plane.service',
            'Requires=docker.service',
            '[Service]',
            // A first certificate request can take minutes (DNS changes, validation).
            'TimeoutStartSec=15min',
            'ExecStartPre=+/usr/local/bin/fenvix-tls',
            `ExecStartPre=-${docker} network create ${DOCKER_NETWORK}`,
            `ExecStartPre=-${docker} pull ${c.proxyImage}`,
            `ExecStartPre=-${docker} rm -f fenvix-proxy`,
            `ExecStart=${docker} run --rm --name fenvix-proxy --network ${DOCKER_NETWORK} -p ${c.controlPlanePort}:443 -v /etc/fenvix/proxy/Caddyfile:/etc/caddy/Caddyfile:ro -v ${PATHS.tlsDir}:/certs:ro ${c.proxyImage}`,
            `ExecStop=${docker} stop fenvix-proxy`,
            'Restart=always',
            'RestartSec=5',
            '[Install]',
            'WantedBy=multi-user.target',
          ].join('\n'),
        ),
      ];

  return [
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
    // The two values CloudFormation filled in (buildUserData): checked before they go into a sourced file.
    `[[ "$FENVIX_TLS_SECRET_ID" =~ ^arn:aws[a-z-]*:secretsmanager:${i.region}:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$ ]] || { echo "FATAL: bad TLS secret id" >&2; exit 1; }`,
    '[[ "$FENVIX_DNS_ZONE_ID" =~ ^Z[A-Z0-9]+$ ]] || { echo "FATAL: bad hosted zone id" >&2; exit 1; }',
    // The instance id, the engine's lease holder (engine-command.ts). IMDSv2: a session token first.
    "IMDS_TOKEN=\"$(curl -fsS --retry 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)\"",
    'INSTANCE_ID="$(curl -fsS --retry 3 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)"',
    '[[ "$INSTANCE_ID" =~ ^i-[0-9a-f]{8,17}$ ]] || { echo "FATAL: bad instance id" >&2; exit 1; }',
    '',
    'dnf install -y docker python3.11 python3.11-pip',
    // Pin the bridge address the engine's admin interface binds to (it is Docker's default anyway).
    'install -d /etc/docker',
    `echo '{"bip": "${DOCKER_BRIDGE_IP}/16"}' > /etc/docker/daemon.json`,
    'systemctl enable --now docker',
    'id fenvix >/dev/null 2>&1 || useradd --system --home-dir /var/lib/fenvix --shell /sbin/nologin fenvix',
    'install -d -o fenvix -g fenvix /opt/fenvix/bin /var/lib/fenvix',
    'install -d -m 0750 -o root -g fenvix /etc/fenvix',
    `install -d -m 0700 -o fenvix -g fenvix ${PATHS.tlsDir}`,
    'install -d -m 0700 -o root -g root /etc/fenvix/proxy',
    '',
    'ARCH="$(uname -m)"',
    'URL="${ENGINE_URL//\\{arch\\}/$ARCH}"',
    `curl --fail --silent --show-error --location --retry 5 --output ${PATHS.engineBinary} "$URL"`,
    `if [ -n "$ENGINE_SHA256" ]; then echo "$ENGINE_SHA256  ${PATHS.engineBinary}" | sha256sum -c -; fi`,
    `chmod 0755 ${PATHS.engineBinary}`,
    '',
    // certbot from PyPI: every package pinned with the SHA-256 of its wheels, wheels only (nothing built here).
    ...heredoc('/opt/fenvix/certbot-requirements.txt', ACME_REQUIREMENTS),
    'python3.11 -m venv /opt/fenvix/certbot',
    '/opt/fenvix/certbot/bin/pip install --quiet --no-cache-dir --disable-pip-version-check --require-hashes --only-binary=:all: -r /opt/fenvix/certbot-requirements.txt',
    '/opt/fenvix/certbot/bin/certbot --version',
    ...heredoc('/etc/fenvix/tls.env', tlsEnv({ config: c, region: i.region, withApi: i.runControlPlane, restartUnits }).join('\n'), '0600'),
    `printf "TLS_SECRET_ID='%s'\\nACME_ZONE_ID='%s'\\n" "$FENVIX_TLS_SECRET_ID" "$FENVIX_DNS_ZONE_ID" >> /etc/fenvix/tls.env`,
    '',
    ...heredoc('/usr/local/bin/fenvix-fetch-config', FETCH_CONFIG, '0755'),
    ...heredoc('/usr/local/bin/fenvix-tls', TLS_SCRIPT, '0755'),
    ...heredoc('/usr/local/bin/fenvix-acme-dns-hook', DNS_HOOK_SCRIPT, '0755'),
    ...heredoc('/usr/local/bin/fenvix-create-engine-users', createEngineUsersScript(c, i.region), '0755'),
    '',
    ...heredoc(
      '/etc/systemd/system/fenvix-engine.service',
      [
        '[Unit]',
        'Description=FENVIX engine',
        'After=network-online.target docker.service',
        'Wants=network-online.target docker.service',
        '[Service]',
        'User=fenvix',
        'Group=fenvix',
        ...engineEnv,
        'RuntimeDirectory=fenvix',
        'RuntimeDirectoryMode=0700',
        // A first certificate request can take minutes (DNS changes, validation).
        'TimeoutStartSec=15min',
        `ExecStartPre=+${fetch} --group engine --files /run/fenvix --owner fenvix ${required('engine')}`,
        'ExecStartPre=+/usr/local/bin/fenvix-tls',
        `ExecStart=${PATHS.engineBinary} ${engineArgs({ config: c, region: i.region, bucketName: i.bucketName, holder: INSTANCE_ID_PLACEHOLDER }).join(' ')}`,
        'WorkingDirectory=/var/lib/fenvix',
        'Restart=always',
        'RestartSec=5',
        'LimitNOFILE=65536',
        'NoNewPrivileges=true',
        'ProtectSystem=strict',
        'ProtectHome=true',
        'PrivateTmp=true',
        'StateDirectory=fenvix',
        'ReadWritePaths=/var/lib/fenvix',
        '[Install]',
        'WantedBy=multi-user.target',
      ].join('\n'),
    ),
    `sed -i "s/${INSTANCE_ID_PLACEHOLDER}/$INSTANCE_ID/" /etc/systemd/system/fenvix-engine.service`,
    ...heredoc(
      '/etc/systemd/system/fenvix-tls.service',
      [
        '[Unit]',
        "Description=FENVIX: renew the Let's Encrypt certificate when due and restart what uses it",
        'After=network-online.target',
        '[Service]',
        'Type=oneshot',
        'TimeoutStartSec=15min',
        'ExecStart=/usr/local/bin/fenvix-tls --restart-on-change',
      ].join('\n'),
    ),
    ...heredoc(
      '/etc/systemd/system/fenvix-tls.timer',
      ['[Unit]', 'Description=FENVIX: certificate check twice a day', '[Timer]', 'OnCalendar=*-*-* 00,12:00:00 UTC', 'RandomizedDelaySec=1h', 'Persistent=true', '[Install]', 'WantedBy=timers.target'].join('\n'),
    ),
    ...controlPlane,
    '',
    'systemctl daemon-reload',
    `systemctl enable --now ${services.join(' ')}`,
    'echo "fenvix bootstrap done $(date -u +%FT%TZ)"',
  ];
}

/**
 * EC2 user data (16 KB at most): a short header with the two values only CloudFormation knows, then the boot script
 * gzip-compressed and base64-encoded (it would not fit as plain text), checked against its SHA-256, kept at
 * BOOT_SCRIPT_PATH and run. Nothing is downloaded for it and no check is left out: it is the whole of bootScript().
 */
export function buildUserData(i: UserDataInput): string[] {
  const boot = bootScript(i).join('\n') + '\n';
  const sha = createHash('sha256').update(boot).digest('hex');
  const b64 = gzipSync(Buffer.from(boot), { level: 9 }).toString('base64');
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    'exec > >(tee -a /var/log/fenvix-bootstrap.log) 2>&1',
    '# Deploy-time values (resource ids, no secrets).',
    `FENVIX_TLS_SECRET_ID='${i.tlsSecretArn}'`,
    `FENVIX_DNS_ZONE_ID='${i.hostedZoneId}'`,
    `# The boot script (infra/lib/user-data.ts, bootScript), gzip + base64; plain copy on the server: ${BOOT_SCRIPT_PATH}.`,
    'install -d -m 0755 /opt/fenvix',
    `base64 -d <<'${PAYLOAD_MARK}' | gunzip > ${BOOT_SCRIPT_PATH}`,
    ...(b64.match(/.{1,76}/g) ?? []),
    PAYLOAD_MARK,
    `echo '${sha}  ${BOOT_SCRIPT_PATH}' | sha256sum -c --quiet -`,
    `. ${BOOT_SCRIPT_PATH}`,
  ];
}

/** The boot script back from user data lines (for tests and for reading a synthesized template). */
export function decodeUserData(userData: string): string {
  const m = userData.match(new RegExp(`<<'${PAYLOAD_MARK}'[^\\n]*\\n([A-Za-z0-9+/=\\n]+?)\\n${PAYLOAD_MARK}`));
  if (!m) throw new Error('no compressed boot script in this user data');
  return gunzipSync(Buffer.from(m[1].replace(/\n/g, ''), 'base64')).toString('utf8');
}
