import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir, userInfo } from 'os';
import { join } from 'path';
import { loadConfig } from '../lib/config';
import { requiredSecretNames } from '../lib/parameters';
import { BASE_CONTEXT } from './helpers';
import { BOOT_SCRIPT_PATH, bootScript, buildUserData, createEngineUsersScript, decodeUserData, FETCH_CONFIG } from '../lib/user-data';
import { ACME_DIRECTORY } from '../lib/acme';
import { INSTANCE_ID_PLACEHOLDER, PATHS } from '../lib/engine-command';

const config = loadConfig((k) => BASE_CONTEXT[k]);
const input = {
  config,
  region: 'eu-central-1',
  bucketName: 'fenvix-prod-data-865859654353-eu-central-1',
  requiredParameters: requiredSecretNames('prod'),
  tlsSecretArn: 'arn:aws:secretsmanager:eu-central-1:865859654353:secret:TlsStore0123ABCD-AbCdEf',
  hostedZoneId: 'Z0123456789ABC',
  runControlPlane: true,
};
/** What the server runs (the compressed part of the user data). */
const lines = bootScript(input);
const script = lines.join('\n');
/** The user data itself, as EC2 receives it. */
const userData = buildUserData(input).join('\n');
const dir = mkdtempSync(join(tmpdir(), 'fenvix-ud-'));
const hasPython = spawnSync('python3', ['--version']).status === 0;

/** The body of the file the boot script writes to `target` (between its heredoc markers). */
function written(target: string, src = lines): string {
  const start = src.indexOf(`cat > ${target} <<'FENVIX_EOF'`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('FENVIX_EOF', start + 1);
  return src.slice(start + 1, end).join('\n');
}

describe('user-data script', () => {
  test('fits the 16 KB EC2 limit, also with a long domain, and is valid bash', () => {
    const f = join(dir, 'userdata.sh');
    writeFileSync(f, userData + '\n');
    execFileSync('bash', ['-n', f]);
    writeFileSync(f, script + '\n');
    execFileSync('bash', ['-n', f]);
    expect(Buffer.byteLength(userData)).toBeLessThan(16384);
    const long = loadConfig((k) => ({ ...BASE_CONTEXT, baseDomain: 'a-rather-long-company-domain-name-for-fenvix.example.com', dnsZone: 'db' })[k]);
    const longUd = buildUserData({ ...input, config: long }).join('\n');
    // eslint-disable-next-line no-console
    console.log(`USER DATA SIZE: ${Buffer.byteLength(userData)} bytes (long domain: ${Buffer.byteLength(longUd)}); boot script ${Buffer.byteLength(script)} bytes`);
    expect(Buffer.byteLength(longUd)).toBeLessThan(16384);
  });

  test('the compressed part is the whole boot script: bash decodes it, checks its SHA-256 and gets it back byte for byte', () => {
    expect(decodeUserData(userData)).toBe(script + '\n');
    // Run the header for real, up to (not including) the line that runs the boot script, with the path moved.
    const target = join(dir, 'boot.sh');
    const header = userData
      .split('\n')
      .filter((l) => l !== `. ${BOOT_SCRIPT_PATH}` && !l.startsWith('exec >') && !l.startsWith('install -d'))
      .join('\n')
      .split(BOOT_SCRIPT_PATH)
      .join(target);
    writeFileSync(join(dir, 'header.sh'), header + '\n');
    const r = spawnSync('bash', [join(dir, 'header.sh')], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(script + '\n');
    // A damaged payload is refused (sha256sum fails, set -e stops the boot).
    const broken = header.replace(/^(H4sI[A-Za-z0-9+/]{10})[A-Za-z0-9+/]/m, (m, a) => a + (m.endsWith('A') ? 'B' : 'A'));
    writeFileSync(join(dir, 'broken.sh'), broken + '\n');
    expect(spawnSync('bash', [join(dir, 'broken.sh')], { encoding: 'utf8' }).status).not.toBe(0);
  });

  test('only the two deploy-time ids are outside the compressed part, and they are checked before use', () => {
    const plain = userData.split('\n').filter((l) => !/^[A-Za-z0-9+/=]{1,76}$/.test(l));
    expect(plain.filter((l) => /^FENVIX_[A-Z_]+=/.test(l))).toEqual([
      `FENVIX_TLS_SECRET_ID='${input.tlsSecretArn}'`,
      `FENVIX_DNS_ZONE_ID='${input.hostedZoneId}'`,
    ]);
    const checks = lines.filter((l) => l.includes('FENVIX_TLS_SECRET_ID" =~') || l.includes('FENVIX_DNS_ZONE_ID" =~'));
    expect(checks).toHaveLength(2);
    // The values arrive through the environment here (never pasted into the script), so a bad one cannot run anything.
    const f = join(dir, 'ids.sh');
    writeFileSync(f, [...checks, 'echo OK'].join('\n') + '\n');
    const run = (secret: string, zone: string) =>
      spawnSync('bash', [f], { encoding: 'utf8', env: { ...process.env, FENVIX_TLS_SECRET_ID: secret, FENVIX_DNS_ZONE_ID: zone } });
    expect(run(input.tlsSecretArn, 'Z0123456789ABC').stdout).toBe('OK\n');
    expect(run("arn:aws:secretsmanager:eu-central-1:865859654353:secret:x' y", 'Z0123456789ABC').status).toBe(1);
    expect(run(input.tlsSecretArn, 'Z1 x').status).toBe(1);
    expect(run('arn:aws:secretsmanager:us-east-1:865859654353:secret:x', 'Z0123456789ABC').status).toBe(1);
  });

  test('every embedded shell script is valid bash', () => {
    for (const t of ['/usr/local/bin/fenvix-tls', '/usr/local/bin/fenvix-acme-dns-hook', '/usr/local/bin/fenvix-create-engine-users']) {
      const f = join(dir, t.split('/').pop()!);
      writeFileSync(f, written(t) + '\n');
      execFileSync('bash', ['-n', f]);
    }
  });

  test('stops with a clear message while the placeholder release location is still in use', () => {
    const f = join(dir, 'ph.sh');
    const ph = bootScript({ ...input, config: { ...config, engineUrl: 'https://example.invalid/REPLACE-ME/x-{arch}' } });
    // Run only the guard: everything up to the first dnf call.
    const guard = ph.slice(0, ph.findIndex((l) => l.startsWith('dnf install')));
    writeFileSync(f, guard.join('\n') + '\n');
    const r = spawnSync('bash', [f], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('placeholder');
  });

  test('carries no secret: no token, password, key or certificate, and the variables the engine never read are gone', () => {
    expect(script).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(script).not.toMatch(/-----BEGIN/);
    expect(userData).not.toMatch(/-----BEGIN/);
    expect(script).not.toMatch(/\bacm\b|export-certificate|CERT_ARN/i);
    expect(script).not.toMatch(/--admin-token[= ]/);
    expect(script).not.toMatch(/FENVIX_(LISTEN|ADMIN_LISTEN|TLS_MODE|S3_BUCKET|AWS_REGION|ADMIN_TOKEN|ACM_CERTIFICATE_ARN|BASE_DOMAIN)/);
    expect(script).not.toContain('self-signed');
    expect(script).not.toContain('session-secret');
  });

  test('the engine unit: flags on ExecStart, token file in a runtime directory, region in the environment', () => {
    const unit = written('/etc/systemd/system/fenvix-engine.service');
    const exec = unit.split('\n').find((l) => l.startsWith('ExecStart='))!;
    expect(exec).toContain('--listen=0.0.0.0:27018');
    expect(exec).toContain('--admin-listen=172.17.0.1:8443');
    expect(exec).toContain('--admin-token-file=/run/fenvix/admin-token');
    expect(exec).toContain('--tls-mode=requireTLS');
    expect(unit).toContain('RuntimeDirectory=fenvix');
    expect(unit).toContain('RuntimeDirectoryMode=0700');
    expect(unit).toContain('Environment=AWS_REGION=eu-central-1');
    expect(unit).toContain('ExecStartPre=+/usr/local/bin/fenvix-fetch-config --region eu-central-1 --prefix /fenvix/prod --group engine --files /run/fenvix --owner fenvix /fenvix/prod/engine/admin-token');
    expect(unit).toContain('ExecStartPre=+/usr/local/bin/fenvix-tls');
    expect(unit).toContain('TimeoutStartSec=15min');
    expect(unit).toContain('User=fenvix');
    expect(unit).not.toContain('EnvironmentFile');
    expect(exec).toContain('--region=eu-central-1');
    expect(exec).toContain(`--holder=${INSTANCE_ID_PLACEHOLDER} `);
    expect(exec.startsWith(`ExecStart=${PATHS.engineBinary} `)).toBe(true);
  });

  test('the lease holder is the instance id from IMDSv2, checked, and put into the unit before it is enabled', () => {
    const at = (p: (l: string) => boolean) => lines.findIndex(p);
    const check = lines.find((l) => l.startsWith('[[ "$INSTANCE_ID" =~'))!;
    const sed = lines.find((l) => l.startsWith('sed -i ') && l.includes(INSTANCE_ID_PLACEHOLDER))!;
    expect(at((l) => l.startsWith('IMDS_TOKEN="$(curl') && l.includes('-X PUT'))).toBeLessThan(at((l) => l === check));
    expect(at((l) => l === sed)).toBeGreaterThan(at((l) => l === "cat > /etc/systemd/system/fenvix-engine.service <<'FENVIX_EOF'"));
    expect(at((l) => l === sed)).toBeLessThan(at((l) => l.startsWith('systemctl enable --now fenvix-engine.service')));
    // Run the real check and the real substitution on a copy of the unit.
    const unitFile = join(dir, 'engine.service');
    const f = join(dir, 'holder.sh');
    writeFileSync(f, [check, sed.split('/etc/systemd/system/fenvix-engine.service').join(unitFile)].join('\n') + '\n');
    const runWith = (id: string) => {
      writeFileSync(unitFile, written('/etc/systemd/system/fenvix-engine.service') + '\n');
      return spawnSync('bash', [f], { encoding: 'utf8', env: { ...process.env, INSTANCE_ID: id } });
    };
    expect(runWith('i-0123456789abcdef0').status).toBe(0);
    const done = readFileSync(unitFile, 'utf8');
    expect(done).toContain('--holder=i-0123456789abcdef0 ');
    expect(done).not.toContain(INSTANCE_ID_PLACEHOLDER);
    for (const bad of ['', 'i-12', 'i-0123456789abcdef0/x', 'i-0123456789ABCDEF0', "i-01234567'; reboot"]) expect(runWith(bad).status).toBe(1);
  });

  test('the admin interface is bound to the pinned Docker bridge, never to all interfaces', () => {
    expect(script).toContain(`echo '{"bip": "172.17.0.1/16"}' > /etc/docker/daemon.json`);
    expect(script).not.toMatch(/--admin-listen=0\.0\.0\.0/);
  });

  test('the control-plane container reaches the engine on the host, publishes no port and requires every control-plane secret', () => {
    const unit = written('/etc/systemd/system/fenvix-control-plane.service');
    const run = unit.split('\n').find((l) => l.startsWith('ExecStart='))!;
    expect(run).toContain('--add-host=host.docker.internal:host-gateway');
    expect(run).toContain('--network fenvix');
    expect(run).not.toMatch(/ -p /);
    expect(run).not.toContain('--network host');
    expect(run).toContain('--cap-drop=ALL');
    for (const n of requiredSecretNames('prod')) expect(unit).toContain(n);
    expect(unit).not.toContain('engine-user-key-previous');
    expect(unit).toContain('--match control-plane/engine-admin-token=engine/admin-token');
    expect(unit).toContain('ExecStartPre=-/usr/bin/docker rm -f fenvix-control-plane');
    expect(unit).not.toMatch(/^-ExecStartPre/m);
  });

  test('the TLS terminator publishes the control-plane port and serves api.<domain> with the same certificate files', () => {
    const unit = written('/etc/systemd/system/fenvix-proxy.service');
    const run = unit.split('\n').find((l) => l.startsWith('ExecStart='))!;
    expect(run).toContain('-p 443:443');
    expect(run).toContain('-v /etc/fenvix/tls:/certs:ro');
    expect(unit).toContain('ExecStartPre=+/usr/local/bin/fenvix-tls');
    const caddy = written('/etc/fenvix/proxy/Caddyfile');
    expect(caddy).toContain('https://api.example.com:443 {');
    expect(caddy).toContain('tls /certs/fullchain.pem /certs/key.pem');
    expect(caddy).toContain('reverse_proxy fenvix-control-plane:3000');
    expect(caddy).toContain('admin off');
  });

  test('the TLS directory belongs to fenvix, mode 0700', () => {
    expect(lines).toContain('install -d -m 0700 -o fenvix -g fenvix /etc/fenvix/tls');
  });

  test('a timer checks the certificate twice a day and restarts what uses it only through fenvix-tls --restart-on-change', () => {
    expect(written('/etc/systemd/system/fenvix-tls.service')).toContain('ExecStart=/usr/local/bin/fenvix-tls --restart-on-change');
    expect(written('/etc/systemd/system/fenvix-tls.timer')).toContain('OnCalendar=*-*-* 00,12:00:00 UTC');
    expect(script).toContain('systemctl enable --now fenvix-engine.service fenvix-tls.timer fenvix-control-plane.service fenvix-proxy.service');
    expect(script).not.toContain('cert-refresh');
  });

  test('certbot comes from PyPI with every package pinned and hashed, wheels only, into a venv on the host', () => {
    const req = written('/opt/fenvix/certbot-requirements.txt');
    const pkgs = req.split('\n').filter((l) => /^[a-z0-9]/i.test(l));
    expect(pkgs.length).toBeGreaterThanOrEqual(10);
    for (const p of pkgs) expect(p).toMatch(/^[A-Za-z0-9._-]+==[0-9][^ ]* \\$/);
    expect(pkgs.map((p) => p.split('==')[0])).toEqual(expect.arrayContaining(['certbot', 'acme', 'cryptography', 'josepy']));
    // Every package line is followed by at least one sha256 hash.
    expect(req.split('\n').filter((l) => l.includes('--hash=sha256:')).every((l) => /--hash=sha256:[0-9a-f]{64}/.test(l))).toBe(true);
    expect(req).not.toMatch(/boto|certbot-dns/);
    expect(lines).toContain('/opt/fenvix/certbot/bin/pip install --quiet --no-cache-dir --disable-pip-version-check --require-hashes --only-binary=:all: -r /opt/fenvix/certbot-requirements.txt');
    expect(script).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
  });

  test('tls.env: names and challenge records of this region, production endpoint by default', () => {
    const env = written('/etc/fenvix/tls.env');
    expect(env).toContain(`ACME_SERVER='${ACME_DIRECTORY.production}'`);
    expect(env).toContain("ACME_EMAIL='certs@example.com'");
    expect(env).toContain("ACME_DOMAINS='*.eu-central-1.db.example.com api.example.com'");
    expect(env).toContain("ACME_RECORDS='eu-central-1.db.example.com=_acme-challenge.eu-central-1.db.example.com api.example.com=_acme-challenge.api.example.com'");
    expect(env).toContain("RESTART_UNITS='fenvix-engine.service fenvix-proxy.service'");
    expect(lines).toContain('chmod 0600 /etc/fenvix/tls.env');
  });

  test('acmeStaging=true changes the ACME endpoint and nothing else in the boot script', () => {
    const staging = bootScript({ ...input, config: { ...config, acmeStaging: true } });
    const diff = staging.map((l, n) => [l, lines[n]]).filter(([a, b]) => a !== b);
    expect(staging).toHaveLength(lines.length);
    expect(diff).toEqual([[`ACME_SERVER='${ACME_DIRECTORY.staging}'`, `ACME_SERVER='${ACME_DIRECTORY.production}'`]]);
  });

  test('a region without the control plane runs the engine and the certificate timer only, with the database names only', () => {
    const other = bootScript({ ...input, runControlPlane: false });
    const otherText = other.join('\n');
    expect(otherText).toContain('systemctl enable --now fenvix-engine.service fenvix-tls.timer\n');
    expect(otherText).not.toContain('fenvix-control-plane.service');
    expect(otherText).not.toContain('fenvix-proxy.service');
    const env = written('/etc/fenvix/tls.env', other);
    expect(env).toContain("ACME_DOMAINS='*.eu-central-1.db.example.com'");
    expect(env).not.toContain('api.example.com');
    expect(env).toContain("RESTART_UNITS='fenvix-engine.service'");
  });

  test('the engine-user script passes passwords by environment, never on a command line, and prints no engine message', () => {
    const s = createEngineUsersScript(config, 'eu-central-1');
    expect(s).toContain('read -r -s');
    expect(s).toContain('-e FENVIX_ROOT_PASSWORD -e FENVIX_PROVISIONER_PASSWORD');
    expect(s).not.toMatch(/-e FENVIX_[A-Z_]+=/);
    expect(s).toContain('--network host');
    expect(s).toContain('mongodb://127.0.0.1:27018/');
    expect(s).not.toMatch(/e\.message|errmsg/);
    expect(s).toContain('"createUser", "dropUser", "viewUser", "changePassword", "changeCustomData", "grantRole", "revokeRole"');
  });
});

describe('fenvix-fetch-config (runs the real embedded script against a fake aws CLI)', () => {
  const py = join(dir, 'fetch.py');
  const bin = join(dir, 'bin');
  const params = [
    { Name: '/fenvix/prod/engine/admin-token', Value: 'tok"en\\1-0123456789' },
    { Name: '/fenvix/prod/control-plane/engine-admin-token', Value: 'tok"en\\1-0123456789' },
    { Name: '/fenvix/prod/control-plane/engine-user-key', Value: 'v1:abc' },
    { Name: '/fenvix/prod/control-plane/nested/ignored', Value: 'x' },
  ];
  const fakeAws = (ps: any[]) => {
    writeFileSync(join(bin, 'aws'), `#!/bin/bash\ncat <<'J'\n${JSON.stringify({ Parameters: ps })}\nJ\n`);
    chmodSync(join(bin, 'aws'), 0o755);
  };
  beforeAll(() => {
    writeFileSync(py, FETCH_CONFIG);
    mkdirSync(bin, { recursive: true });
  });
  const run = (...args: string[]) =>
    spawnSync('python3', ['-I', py, '--region', 'eu-central-1', '--prefix', '/fenvix/prod', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

  (hasPython ? test : test.skip)('engine: one file per parameter, mode 600, owned by the given user, value byte for byte', () => {
    fakeAws(params);
    const out = join(dir, 'run-fenvix');
    mkdirSync(out, { recursive: true });
    const r = run('--group', 'engine', '--files', out, '--owner', userInfo().username, '/fenvix/prod/engine/admin-token');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const f = join(out, 'admin-token');
    expect(readFileSync(f, 'utf8')).toBe('tok"en\\1-0123456789');
    expect((statSync(f).mode & 0o777).toString(8)).toBe('600');
    expect(statSync(f).uid).toBe(userInfo().uid);
    expect(existsSync(join(out, 'engine-user-key'))).toBe(false);
    expect(r.stdout).not.toContain('0123456789');
  });

  (hasPython ? test : test.skip)('control plane: docker env file of its own group only (direct children), mode 600', () => {
    fakeAws(params);
    const f = join(dir, 'cp.env');
    const r = run('--group', 'control-plane', '--env-file', f, '--match', 'control-plane/engine-admin-token=engine/admin-token');
    expect(r.status).toBe(0);
    expect(readFileSync(f, 'utf8')).toBe('ENGINE_ADMIN_TOKEN=tok"en\\1-0123456789\nENGINE_USER_KEY=v1:abc\n');
    expect((statSync(f).mode & 0o777).toString(8)).toBe('600');
  });

  (hasPython ? test : test.skip)('fails and names every missing required parameter, without printing any value', () => {
    fakeAws(params);
    const r = run('--group', 'control-plane', '--env-file', join(dir, 'x.env'), '/fenvix/prod/control-plane/engine-user-key', '/fenvix/prod/control-plane/download-signing-key', '/fenvix/prod/control-plane/supabase-url');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('missing SSM parameters');
    expect(r.stderr).toContain('/fenvix/prod/control-plane/download-signing-key, /fenvix/prod/control-plane/supabase-url');
    expect(r.stderr).not.toContain('v1:abc');
    expect(existsSync(join(dir, 'x.env'))).toBe(false);
  });

  (hasPython ? test : test.skip)('refuses to start the control plane when its admin token differs from the engine one', () => {
    fakeAws([params[0], { ...params[1], Value: 'another-token-000000' }]);
    const r = run('--group', 'control-plane', '--env-file', join(dir, 'y.env'), '--match', 'control-plane/engine-admin-token=engine/admin-token');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('/fenvix/prod/control-plane/engine-admin-token must hold the same value as /fenvix/prod/engine/admin-token');
    expect(r.stderr).not.toContain('another-token');
  });
});
