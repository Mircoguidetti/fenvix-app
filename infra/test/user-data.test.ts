import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir, userInfo } from 'os';
import { join } from 'path';
import { loadConfig } from '../lib/config';
import { requiredSecretNames } from '../lib/parameters';
import { BASE_CONTEXT } from './helpers';
import { buildUserData, certRefreshScript, createEngineUsersScript, FETCH_CONFIG } from '../lib/user-data';

const config = loadConfig((k) => BASE_CONTEXT[k]);
const input = {
  config,
  region: 'eu-central-1',
  bucketName: 'fenvix-prod-data-865859654353-eu-central-1',
  requiredParameters: requiredSecretNames('prod'),
  certificateArn: 'arn:aws:acm:eu-central-1:865859654353:certificate/00000000-0000-0000-0000-000000000000',
  runControlPlane: true,
};
const lines = buildUserData(input);
const script = lines.join('\n');
const dir = mkdtempSync(join(tmpdir(), 'fenvix-ud-'));
const hasPython = spawnSync('python3', ['--version']).status === 0;
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

/** The body of the file the boot script writes to `target` (between its heredoc markers). */
function written(target: string, src = lines): string {
  const start = src.indexOf(`cat > ${target} <<'FENVIX_EOF'`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('FENVIX_EOF', start + 1);
  return src.slice(start + 1, end).join('\n');
}

describe('user-data script', () => {
  test('is valid bash and fits the 16 KB EC2 limit', () => {
    const f = join(dir, 'userdata.sh');
    writeFileSync(f, script + '\n');
    execFileSync('bash', ['-n', f]);
    expect(Buffer.byteLength(script)).toBeLessThan(16384);
  });

  test('every embedded shell script is valid bash', () => {
    for (const t of ['/usr/local/bin/fenvix-cert-refresh', '/usr/local/bin/fenvix-create-engine-users']) {
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
    expect(unit).toContain('ExecStartPre=+/usr/local/bin/fenvix-cert-refresh');
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

  test('the TLS terminator publishes the control-plane port and serves console.<domain> with the exported certificate', () => {
    const run = written('/etc/systemd/system/fenvix-proxy.service').split('\n').find((l) => l.startsWith('ExecStart='))!;
    expect(run).toContain('-p 443:443');
    expect(run).toContain('-v /etc/fenvix/tls/proxy:/certs:ro');
    const caddy = written('/etc/fenvix/proxy/Caddyfile');
    expect(caddy).toContain('https://console.example.com:443 {');
    expect(caddy).toContain('tls /certs/cert.pem /certs/key.pem');
    expect(caddy).toContain('reverse_proxy fenvix-control-plane:3000');
    expect(caddy).toContain('admin off');
  });

  test('a renewal timer re-exports the certificate and restarts what uses it', () => {
    expect(written('/etc/systemd/system/fenvix-cert-refresh.service')).toContain('ExecStart=/usr/local/bin/fenvix-cert-refresh --restart-on-change');
    expect(written('/etc/systemd/system/fenvix-cert-refresh.timer')).toContain('OnCalendar=');
    expect(script).toContain('systemctl enable --now fenvix-engine.service fenvix-cert-refresh.timer fenvix-control-plane.service fenvix-proxy.service');
  });

  test('a region without the control plane runs the engine and the certificate timer only', () => {
    const other = buildUserData({ ...input, runControlPlane: false }).join('\n');
    expect(other).toContain('systemctl enable --now fenvix-engine.service fenvix-cert-refresh.timer\n');
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

describe('fenvix-cert-refresh (real openssl, fake ACM export)', () => {
  const work = join(dir, 'cert');
  const bin = join(work, 'bin');
  const tls = join(work, 'tls');
  const run = (...args: string[]) =>
    spawnSync('bash', [join(work, 'refresh.sh'), ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: work } });
  const ssl = (...a: string[]) => execFileSync('openssl', a, { cwd: work, stdio: 'ignore' });
  const issue = (cn: string) => {
    ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'issued.key', '-out', 'issued.crt', '-days', '2', '-subj', `/CN=${cn}`);
    ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=fake-chain');
  };

  beforeAll(() => {
    if (!hasOpenssl || !hasPython) return;
    mkdirSync(join(tls, 'proxy'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    // Fake `aws acm export-certificate`: encrypts the issued key with the passphrase the script handed over, as ACM does.
    writeFileSync(
      join(bin, 'aws'),
      [
        '#!/bin/bash',
        `[ -f ${work}/fail ] && { echo "AccessDenied" >&2; exit 254; }`,
        'pass=""; while [ $# -gt 0 ]; do [ "$1" = --passphrase ] && pass="${2#fileb://}"; shift; done',
        `openssl pkcs8 -topk8 -v2 aes-256-cbc -in ${work}/issued.key -passout "file:$pass" -out ${work}/enc.key`,
        `python3 -I -c 'import json,sys; print(json.dumps({"Certificate": open(sys.argv[1]).read(), "CertificateChain": open(sys.argv[2]).read(), "PrivateKey": open(sys.argv[3]).read()}))' ${work}/issued.crt ${work}/ca.crt ${work}/enc.key`,
      ].join('\n') + '\n',
    );
    chmodSync(join(bin, 'aws'), 0o755);
    const s = certRefreshScript('arn:aws:acm:eu-central-1:1:certificate/x', 'eu-central-1', true)
      .replace("PEM='/etc/fenvix/tls/engine.pem'", `PEM='${tls}/engine.pem'`)
      .replace("PROXY_DIR='/etc/fenvix/tls/proxy'", `PROXY_DIR='${tls}/proxy'`)
      .replace('mktemp -d /run/fenvix-cert.XXXXXX', 'mktemp -d')
      .replace('-o fenvix -g fenvix ', '')
      .replace('systemctl try-restart', 'echo RESTART');
    writeFileSync(join(work, 'refresh.sh'), s);
    issue('*.eu-central-1.db.example.com');
  });

  (hasOpenssl && hasPython ? test : test.skip)('installs cert chain + decrypted key as one 0600 PEM for the engine, and the proxy files', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('certificate installed (none -> ');
    const pem = readFileSync(join(tls, 'engine.pem'), 'utf8');
    expect(pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(pem).toContain('BEGIN PRIVATE KEY');
    expect(pem).not.toContain('ENCRYPTED');
    expect((statSync(join(tls, 'engine.pem')).mode & 0o777).toString(8)).toBe('600');
    expect((statSync(join(tls, 'proxy', 'key.pem')).mode & 0o777).toString(8)).toBe('600');
    // The key and the leaf certificate belong together.
    const mod = (f: string, kind: string) => execFileSync('openssl', [kind, '-in', f, '-noout', '-modulus']).toString();
    expect(mod(join(tls, 'proxy', 'key.pem'), 'rsa')).toBe(mod(join(tls, 'proxy', 'cert.pem'), 'x509'));
    expect(r.stdout + r.stderr).not.toContain('PRIVATE KEY');
  });

  (hasOpenssl && hasPython ? test : test.skip)('unchanged certificate: nothing written, nothing restarted', () => {
    const r = run('--restart-on-change');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('certificate unchanged');
    expect(r.stdout).not.toContain('RESTART');
  });

  (hasOpenssl && hasPython ? test : test.skip)('renewed certificate: new files and one restart of the engine and the terminator', () => {
    issue('*.eu-central-1.db.example.com');
    const r = run('--restart-on-change');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('certificate installed');
    expect(r.stdout).toContain('RESTART fenvix-engine.service fenvix-proxy.service');
  });

  (hasOpenssl && hasPython ? test : test.skip)('ACM unreachable: keeps the current certificate; with none on disk, stops with a clear message', () => {
    writeFileSync(join(work, 'fail'), '');
    const keep = run();
    expect(keep.status).toBe(0);
    expect(keep.stderr).toContain('keeping the current certificate');
    execFileSync('rm', ['-f', join(tls, 'engine.pem')]);
    const none = run();
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('no certificate on disk');
    execFileSync('rm', ['-f', join(work, 'fail')]);
  });
});
