import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir, userInfo } from 'os';
import { join } from 'path';
import { loadConfig } from '../lib/config';
import { requiredSecretNames } from '../lib/parameters';
import { BASE_CONTEXT } from './helpers';
import { gzipSync } from 'zlib';
import { BOOT_CHUNK, bootChunks, buildBoot, buildUserData, createEngineUsersScript, FETCH_CONFIG } from '../lib/user-data';

const config = loadConfig((k) => BASE_CONTEXT[k]);
const input = {
  config,
  region: 'eu-central-1',
  bucketName: 'fenvix-prod-data-865859654353-eu-central-1',
  requiredParameters: requiredSecretNames('prod'),
  zoneId: 'Z0123456789ABC',
  runControlPlane: true,
};
const boot = buildBoot(input);
const lines = boot.userData;
const bundleLines = boot.bundle.split('\n');
/** User data and bundle together: everything the server runs at boot. */
const script = lines.join('\n') + '\n' + boot.bundle;
const dir = mkdtempSync(join(tmpdir(), 'fenvix-ud-'));
const hasPython = spawnSync('python3', ['--version']).status === 0;

/** The body of the file the boot script writes to `target` (between its heredoc markers). */
function written(target: string): string {
  const src = lines.includes(`cat > ${target} <<'FENVIX_EOF'`) ? lines : bundleLines;
  const start = src.indexOf(`cat > ${target} <<'FENVIX_EOF'`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('FENVIX_EOF', start + 1);
  return src.slice(start + 1, end).join('\n');
}

describe('user-data script', () => {
  test('user data and boot bundle are valid bash; the user data fits the 16 KB EC2 limit, every bundle part a Standard parameter', () => {
    const f = join(dir, 'userdata.sh');
    writeFileSync(f, lines.join('\n') + '\n');
    execFileSync('bash', ['-n', f]);
    writeFileSync(join(dir, 'bundle.sh'), boot.bundle);
    execFileSync('bash', ['-n', join(dir, 'bundle.sh')]);
    expect(Buffer.byteLength(lines.join('\n'))).toBeLessThan(16384);
    const parts = bootChunks(gzipSync(Buffer.from(boot.bundle), { level: 9 }).toString('base64'));
    expect(parts.length).toBe(boot.parts);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(BOOT_CHUNK);
  });

  test('the user data fetches the bundle and refuses it unless its SHA-256 matches', () => {
    const ud = lines.join('\n');
    expect(ud).toContain('/fenvix-boot/prod/scripts-0');
    expect(ud).toContain(`echo "${boot.bundleSha256}  /root/fenvix-boot.sh" | sha256sum -c -`);
    const fetchAt = lines.findIndex((l) => l.includes('/root/fenvix-boot.sh') && l.startsWith('for p in'));
    expect(lines[fetchAt + 1]).toContain('sha256sum -c -');
    expect(lines[fetchAt + 2]).toBe('bash /root/fenvix-boot.sh');
    for (const l of lines) expect(l).not.toContain('\n');
  });

  test('the boot bundle is the same whatever the stack creates (no CloudFormation value in it)', () => {
    const other = buildBoot({ ...input, bucketName: 'another-bucket', zoneId: 'ZOTHER' });
    expect(other.bundleSha256).toBe(boot.bundleSha256);
    expect(other.userData.join('\n')).toContain("echo 'ZOTHER' > /etc/fenvix/acme-zone-id");
  });

  test('lego is downloaded at a pinned version and refused unless its SHA-256 matches; never piped into a shell', () => {
    const ud = lines.join('\n');
    expect(ud).toContain('https://github.com/go-acme/lego/releases/download/v5.5.2/lego_v5.5.2_linux_$LEGO_ARCH.tar.gz');
    expect(ud).toContain('LEGO_SHA256=2a35505089e7772c92e1e9ac144df91151ef2eca8568630db0ff91fca06d9bef');
    expect(ud).toContain('LEGO_SHA256=15b14ec2ab14fde69cc8396eb0204c5ce4327e31a486953225a6059b26db3e8c');
    const sha = lines.findIndex((l) => l.includes('/tmp/lego.tar.gz" | sha256sum -c -') || l === 'echo "$LEGO_SHA256  /tmp/lego.tar.gz" | sha256sum -c -');
    const untar = lines.findIndex((l) => l.startsWith('tar -xzf /tmp/lego.tar.gz'));
    expect(sha).toBeGreaterThan(0);
    expect(untar).toBe(sha + 1);
    expect(script).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
  });

  test('every embedded shell script is valid bash', () => {
    for (const t of ['/usr/local/bin/fenvix-tls', '/usr/local/bin/fenvix-create-engine-users']) {
      const f = join(dir, t.split('/').pop()!);
      writeFileSync(f, written(t) + '\n');
      execFileSync('bash', ['-n', f]);
    }
  });

  test('stops with a clear message while the placeholder release location is still in use', () => {
    const f = join(dir, 'ph.sh');
    const ph = buildUserData({ ...input, config: { ...config, engineUrl: 'https://example.invalid/REPLACE-ME/x-{arch}' } });
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
    expect(script).not.toMatch(/--admin-token[= ]/);
    expect(script).not.toMatch(/\bacm\b|export-certificate|cert-refresh|CertificateArn/i);
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
    expect(unit).toContain('User=fenvix');
    expect(unit).not.toContain('EnvironmentFile');
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

  test('the TLS terminator publishes the control-plane port and serves console.<domain> from the engine PEM file', () => {
    const unit = written('/etc/systemd/system/fenvix-proxy.service');
    const run = unit.split('\n').find((l) => l.startsWith('ExecStart='))!;
    expect(run).toContain('-p 443:443');
    expect(run).toContain('-v /etc/fenvix/tls:/certs:ro');
    expect(unit).toContain('ExecStartPre=+/usr/local/bin/fenvix-tls');
    const caddy = written('/etc/fenvix/proxy/Caddyfile');
    expect(caddy).toContain('https://console.example.com:443 {');
    expect(caddy).toContain('tls /certs/engine.pem /certs/engine.pem');
    expect(caddy).toContain('auto_https off');
    expect(caddy).toContain('reverse_proxy fenvix-control-plane:3000');
    expect(caddy).toContain('admin off');
  });

  test('a timer checks the certificate twice a day and restarts what uses it only on change', () => {
    expect(written('/etc/systemd/system/fenvix-tls.service')).toContain('ExecStart=/usr/local/bin/fenvix-tls --restart-on-change');
    expect(written('/etc/systemd/system/fenvix-tls.timer')).toContain('OnCalendar=*-*-* 04,16:20:00 UTC');
    expect(written('/usr/local/bin/fenvix-tls')).toContain('systemctl try-restart fenvix-engine.service fenvix-proxy.service');
    expect(script).toContain('systemctl enable --now fenvix-engine.service fenvix-tls.timer fenvix-control-plane.service fenvix-proxy.service');
  });

  test('certificate directory owned by fenvix, 0700; the instance knows its zone id from the stack', () => {
    expect(script).toContain('install -d -m 0700 -o fenvix -g fenvix /etc/fenvix/tls');
    expect(script).toContain("echo 'Z0123456789ABC' > /etc/fenvix/acme-zone-id");
    expect(script).not.toContain('/etc/fenvix/tls/proxy');
  });

  test('acmeStaging changes the ACME endpoint and nothing else', () => {
    const staging = buildBoot({ ...input, config: { ...config, acmeStaging: true } });
    const a = boot.bundle.split('\n');
    const b = staging.bundle.split('\n');
    expect(b.length).toBe(a.length);
    const diff = a.map((l, n) => [l, b[n]]).filter(([x, y]) => x !== y);
    expect(diff).toEqual([["SERVER='https://acme-v02.api.letsencrypt.org/directory'", "SERVER='https://acme-staging-v02.api.letsencrypt.org/directory'"]]);
    const ua = lines.filter((l) => !l.includes(boot.bundleSha256));
    const ub = staging.userData.filter((l) => !l.includes(staging.bundleSha256));
    expect(ub).toEqual(ua);
  });

  test('a region without the control plane runs the engine and the certificate timer only', () => {
    const o = buildBoot({ ...input, runControlPlane: false });
    const other = o.userData.join('\n') + '\n' + o.bundle;
    expect(o.bundle).toContain("DOMAINS=('*.eu-central-1.db.example.com')");
    expect(o.bundle).toContain('systemctl try-restart fenvix-engine.service;');
    expect(other).toContain('systemctl enable --now fenvix-engine.service fenvix-tls.timer\n');
    expect(other).not.toContain('fenvix-control-plane.service');
    expect(other).not.toContain('fenvix-proxy.service');
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
