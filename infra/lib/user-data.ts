import { Token } from 'aws-cdk-lib';
import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import { ACME_ZONE_ID_FILE, LEGO, certificateDomains, legoUrl, tlsScript, tlsStateParameter } from './acme';
import { FenvixConfig } from './config';
import {
  CONTROL_PLANE_CONTAINER,
  CONTROL_PLANE_INTERNAL_PORT,
  consoleHost,
  controlPlaneEnvironment,
} from './control-plane-env';
import { DOCKER_BRIDGE_IP, PATHS, engineArgs, engineEnvironment } from './engine-command';
import { MUST_MATCH, ssmPrefix } from './parameters';

export { ssmPrefix };

export interface UserDataInput {
  config: FenvixConfig;
  region: string;
  /** Bucket name; may be a CDK token. */
  bucketName: string;
  /** Full SSM names that must exist, or the services refuse to start (lib/parameters.ts). */
  requiredParameters: string[];
  /** Route 53 zone where the ACME DNS-01 challenge records are written. May be a CDK token. */
  zoneId: string;
  /** The control plane and its TLS terminator run in the first region only (DNS for console.<domain> points there). */
  runControlPlane: boolean;
}

/**
 * SSM String parameter (made by the stack) holding the boot bundle: every script and unit that is the same for any
 * deployment of this config, gzip + base64. Read once at boot by the host; the user data carries its SHA-256.
 */
export function bootParameter(envName: string, part: number): string {
  return `/fenvix-boot/${envName}/scripts-${part}`;
}

/** Largest value of a Standard (free) SSM parameter. */
export const BOOT_CHUNK = 4096;

export function bootChunks(value: string): string[] {
  const out: string[] = [];
  for (let n = 0; n < value.length; n += BOOT_CHUNK) out.push(value.slice(n, n + BOOT_CHUNK));
  return out;
}

export interface BootScripts {
  userData: string[];
  /** The bash script that writes the bundled files (plain text; stored gzip + base64). */
  bundle: string;
  bundleSha256: string;
  /** Number of SSM parameters the bundle needs (see bootChunks). */
  parts: number;
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
 * says. Uses the control-plane image's MongoDB driver. Prints no password and no engine message (the engine echoes
 * refused commands, password included). Running it again resets the provisioner's password to the SSM value.
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

export function buildBoot(i: UserDataInput): BootScripts {
  const c = i.config;
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
            `https://${consoleHost(c)}:443 {`,
            // The engine's file: Caddy takes the certificates and the key out of the same PEM.
            '\ttls /certs/engine.pem /certs/engine.pem',
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
            'ExecStartPre=+/usr/local/bin/fenvix-tls',
            `ExecStartPre=-${docker} network create ${DOCKER_NETWORK}`,
            `ExecStartPre=-${docker} pull ${c.proxyImage}`,
            `ExecStartPre=-${docker} rm -f fenvix-proxy`,
            `ExecStart=${docker} run --rm --name fenvix-proxy --network ${DOCKER_NETWORK} -p ${c.controlPlanePort}:443 -v /etc/fenvix/proxy/Caddyfile:/etc/caddy/Caddyfile:ro -v /etc/fenvix/tls:/certs:ro ${c.proxyImage}`,
            `ExecStop=${docker} stop fenvix-proxy`,
            'Restart=always',
            'RestartSec=5',
            '[Install]',
            'WantedBy=multi-user.target',
          ].join('\n'),
        ),
      ];

  // Every file that depends on nothing the stack creates goes into the boot bundle (an SSM parameter), so the user
  // data stays below the 16 KB EC2 limit. The bundle must not contain a CDK token: its SHA-256 is fixed at synth time.
  const bundle = [
    '#!/bin/bash',
    'set -euo pipefail',
    ...heredoc('/usr/local/bin/fenvix-fetch-config', FETCH_CONFIG, '0755'),
    ...heredoc(
      '/usr/local/bin/fenvix-tls',
      tlsScript({
        region: i.region,
        staging: c.acmeStaging,
        email: c.acmeEmail,
        domains: certificateDomains(c, i.region, i.runControlPlane),
        stateParameter: tlsStateParameter(c.envName),
        restartUnits: ['fenvix-engine.service', ...(i.runControlPlane ? ['fenvix-proxy.service'] : [])],
      }),
      '0755',
    ),
    ...heredoc('/usr/local/bin/fenvix-create-engine-users', createEngineUsersScript(c, i.region), '0755'),
    ...heredoc(
      '/etc/systemd/system/fenvix-tls.service',
      ['[Unit]', 'Description=FENVIX: renew the certificate when due and restart what uses it if it changed', 'After=network-online.target', '[Service]', 'Type=oneshot', 'ExecStart=/usr/local/bin/fenvix-tls --restart-on-change'].join('\n'),
    ),
    ...heredoc(
      '/etc/systemd/system/fenvix-tls.timer',
      ['[Unit]', 'Description=FENVIX: certificate check twice a day', '[Timer]', 'OnCalendar=*-*-* 04,16:20:00 UTC', 'RandomizedDelaySec=1h', 'Persistent=true', '[Install]', 'WantedBy=timers.target'].join('\n'),
    ),
    ...controlPlane,
  ].join('\n') + '\n';
  if (Token.isUnresolved(bundle)) throw new Error('the boot bundle must not contain CDK tokens (its SHA-256 is computed at synth time)');
  const bundleSha256 = createHash('sha256').update(bundle).digest('hex');
  const parts = bootChunks(gzipSync(Buffer.from(bundle), { level: 9 }).toString('base64')).length;
  const partNames = Array.from({ length: parts }, (_, n) => bootParameter(c.envName, n)).join(' ');

  const userData = [
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
    // Pin the bridge address the engine's admin interface binds to (it is Docker's default anyway).
    'install -d /etc/docker',
    `echo '{"bip": "${DOCKER_BRIDGE_IP}/16"}' > /etc/docker/daemon.json`,
    'systemctl enable --now docker',
    'id fenvix >/dev/null 2>&1 || useradd --system --home-dir /var/lib/fenvix --shell /sbin/nologin fenvix',
    'install -d -o fenvix -g fenvix /opt/fenvix/bin /var/lib/fenvix',
    'install -d -m 0750 -o root -g fenvix /etc/fenvix',
    'install -d -m 0700 -o fenvix -g fenvix /etc/fenvix/tls',
    'install -d -m 0700 -o root -g root /etc/fenvix/proxy',
    `echo '${i.zoneId}' > ${ACME_ZONE_ID_FILE}`,
    '',
    'ARCH="$(uname -m)"',
    'URL="${ENGINE_URL//\\{arch\\}/$ARCH}"',
    `curl --fail --silent --show-error --location --retry 5 --output ${PATHS.engineBinary} "$URL"`,
    `if [ -n "$ENGINE_SHA256" ]; then echo "$ENGINE_SHA256  ${PATHS.engineBinary}" | sha256sum -c -; fi`,
    `chmod 0755 ${PATHS.engineBinary}`,
    '',
    // ACME client: pinned release, refused unless its SHA-256 matches (lib/acme.ts).
    `case "$ARCH" in x86_64) LEGO_ARCH=amd64 LEGO_SHA256=${LEGO.sha256.x86_64};; aarch64) LEGO_ARCH=arm64 LEGO_SHA256=${LEGO.sha256.aarch64};; *) echo "FATAL: no lego build for $ARCH" >&2; exit 1;; esac`,
    `curl --fail --silent --show-error --location --retry 5 --output /tmp/lego.tar.gz "${legoUrl('amd64').replace('amd64', '$LEGO_ARCH')}"`,
    'echo "$LEGO_SHA256  /tmp/lego.tar.gz" | sha256sum -c -',
    'tar -xzf /tmp/lego.tar.gz -C /usr/local/bin lego && chown root:root /usr/local/bin/lego && chmod 0755 /usr/local/bin/lego && rm -f /tmp/lego.tar.gz',
    '',
    // The other scripts and units: from the boot parameter (gzip + base64), refused unless the SHA-256 fixed here matches.
    `for p in ${partNames}; do aws ssm get-parameter --region ${i.region} --name "$p" --query Parameter.Value --output text; done | tr -d '\\n' | base64 -d | gzip -d > /root/fenvix-boot.sh`,
    `echo "${bundleSha256}  /root/fenvix-boot.sh" | sha256sum -c -`,
    'bash /root/fenvix-boot.sh',
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
        `ExecStartPre=+${fetch} --group engine --files /run/fenvix --owner fenvix ${required('engine')}`,
        'ExecStartPre=+/usr/local/bin/fenvix-tls',
        `ExecStart=${PATHS.engineBinary} ${engineArgs({ config: c, region: i.region, bucketName: i.bucketName }).join(' ')}`,
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
    '',
    'systemctl daemon-reload',
    `systemctl enable --now ${services.join(' ')}`,
    'echo "fenvix bootstrap done $(date -u +%FT%TZ)"',
  ];
  return { userData, bundle, bundleSha256, parts };
}

/** The user data only (what the EC2 instance gets). */
export function buildUserData(i: UserDataInput): string[] {
  return buildBoot(i).userData;
}
