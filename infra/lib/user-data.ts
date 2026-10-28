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
  /** ACM certificate (exportable) of this region; exported to PEM files on the server. May be a CDK token. */
  certificateArn: string;
  /** The control plane and its TLS terminator run in the first region only (DNS for console.<domain> points there). */
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
 * Exports the region's ACM certificate (exportable) to the engine's PEM file and the TLS terminator's files. The
 * engine reads its certificate only at start (its rotateCertificates command reloads nothing), so the daily timer
 * runs this with --restart-on-change: when ACM has renewed the certificate, the new files are written and the engine
 * and the terminator are restarted once. The private key is decrypted in /run (memory) and never printed.
 */
export function certRefreshScript(certificateArn: string, region: string, proxy: boolean): string {
  return String.raw`#!/bin/bash
set -euo pipefail
umask 077
CERT_ARN='${certificateArn}'
REGION='${region}'
PEM='${PATHS.enginePem}'
PROXY_DIR='${PATHS.proxyCertDir}'
w="$(mktemp -d /run/fenvix-cert.XXXXXX)"
trap 'rm -rf "$w"' EXIT
openssl rand -hex 32 > "$w/pass"
if ! aws acm export-certificate --region "$REGION" --certificate-arn "$CERT_ARN" --passphrase "fileb://$w/pass" --output json > "$w/out.json" 2> "$w/err"; then
  if [ -s "$PEM" ]; then echo "fenvix-cert-refresh: export failed, keeping the current certificate: $(head -c 300 "$w/err")" >&2; exit 0; fi
  echo "fenvix-cert-refresh: cannot export $CERT_ARN and no certificate on disk: $(head -c 300 "$w/err")" >&2; exit 1
fi
python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); open(sys.argv[2],"w").write(d["Certificate"].strip()+"\n"+d.get("CertificateChain","").strip()+"\n"); open(sys.argv[3],"w").write(d["PrivateKey"])' "$w/out.json" "$w/chain.pem" "$w/key.enc"
openssl pkey -in "$w/key.enc" -passin "file:$w/pass" -out "$w/key.pem"
fp() { openssl x509 -in "$1" -noout -fingerprint -sha256 | cut -d= -f2; }
new="$(fp "$w/chain.pem")"
old="none"; if [ -s "$PEM" ]; then old="$(fp "$PEM")"; fi
if [ "$new" = "$old" ]${proxy ? ' && [ -s "$PROXY_DIR/key.pem" ]' : ''}; then echo "fenvix-cert-refresh: certificate unchanged ($new)"; exit 0; fi
cat "$w/chain.pem" "$w/key.pem" > "$w/engine.pem"
install -m 0600 -o fenvix -g fenvix "$w/engine.pem" "$PEM.new" && mv -f "$PEM.new" "$PEM"
${proxy ? String.raw`install -m 0600 "$w/chain.pem" "$PROXY_DIR/cert.pem"
install -m 0600 "$w/key.pem" "$PROXY_DIR/key.pem"
` : ''}echo "fenvix-cert-refresh: certificate installed ($old -> $new)"
if [ "${'$'}{1:-}" = "--restart-on-change" ]; then systemctl try-restart fenvix-engine.service${proxy ? ' fenvix-proxy.service' : ''}; fi
`;
}

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

export function buildUserData(i: UserDataInput): string[] {
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
  const services = ['fenvix-engine.service', 'fenvix-cert-refresh.timer', ...(i.runControlPlane ? ['fenvix-control-plane.service', 'fenvix-proxy.service'] : [])];

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
            '\ttls /certs/cert.pem /certs/key.pem',
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
            'ExecStartPre=+/usr/local/bin/fenvix-cert-refresh',
            `ExecStartPre=-${docker} network create ${DOCKER_NETWORK}`,
            `ExecStartPre=-${docker} pull ${c.proxyImage}`,
            `ExecStartPre=-${docker} rm -f fenvix-proxy`,
            `ExecStart=${docker} run --rm --name fenvix-proxy --network ${DOCKER_NETWORK} -p ${c.controlPlanePort}:443 -v /etc/fenvix/proxy/Caddyfile:/etc/caddy/Caddyfile:ro -v ${PATHS.proxyCertDir}:/certs:ro ${c.proxyImage}`,
            `ExecStop=${docker} stop fenvix-proxy`,
            'Restart=always',
            'RestartSec=5',
            '[Install]',
            'WantedBy=multi-user.target',
          ].join('\n'),
        ),
      ];

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
    // Pin the bridge address the engine's admin interface binds to (it is Docker's default anyway).
    'install -d /etc/docker',
    `echo '{"bip": "${DOCKER_BRIDGE_IP}/16"}' > /etc/docker/daemon.json`,
    'systemctl enable --now docker',
    'id fenvix >/dev/null 2>&1 || useradd --system --home-dir /var/lib/fenvix --shell /sbin/nologin fenvix',
    'install -d -o fenvix -g fenvix /opt/fenvix/bin /var/lib/fenvix',
    'install -d -m 0750 -o root -g fenvix /etc/fenvix /etc/fenvix/tls',
    `install -d -m 0700 -o root -g root /etc/fenvix/proxy ${PATHS.proxyCertDir}`,
    '',
    'ARCH="$(uname -m)"',
    'URL="${ENGINE_URL//\\{arch\\}/$ARCH}"',
    `curl --fail --silent --show-error --location --retry 5 --output ${PATHS.engineBinary} "$URL"`,
    `if [ -n "$ENGINE_SHA256" ]; then echo "$ENGINE_SHA256  ${PATHS.engineBinary}" | sha256sum -c -; fi`,
    `chmod 0755 ${PATHS.engineBinary}`,
    '',
    ...heredoc('/usr/local/bin/fenvix-fetch-config', FETCH_CONFIG, '0755'),
    ...heredoc('/usr/local/bin/fenvix-cert-refresh', certRefreshScript(i.certificateArn, i.region, i.runControlPlane), '0755'),
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
        `ExecStartPre=+${fetch} --group engine --files /run/fenvix --owner fenvix ${required('engine')}`,
        'ExecStartPre=+/usr/local/bin/fenvix-cert-refresh',
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
    ...heredoc(
      '/etc/systemd/system/fenvix-cert-refresh.service',
      ['[Unit]', 'Description=FENVIX: install a renewed certificate and restart what uses it', '[Service]', 'Type=oneshot', 'ExecStart=/usr/local/bin/fenvix-cert-refresh --restart-on-change'].join('\n'),
    ),
    ...heredoc(
      '/etc/systemd/system/fenvix-cert-refresh.timer',
      ['[Unit]', 'Description=FENVIX: daily check for a renewed certificate', '[Timer]', 'OnCalendar=*-*-* 03:30:00 UTC', 'RandomizedDelaySec=30m', 'Persistent=true', '[Install]', 'WantedBy=timers.target'].join('\n'),
    ),
    ...controlPlane,
    '',
    'systemctl daemon-reload',
    `systemctl enable --now ${services.join(' ')}`,
    'echo "fenvix bootstrap done $(date -u +%FT%TZ)"',
  ];
}
