import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../lib/config';
import { BASE_CONTEXT } from './helpers';
import { buildUserData, FETCH_CONFIG } from '../lib/user-data';

const config = loadConfig((k) => BASE_CONTEXT[k]);
const lines = buildUserData({
  config,
  region: 'eu-central-1',
  bucketName: 'fenvix-prod-data-865859654353-eu-central-1',
  requiredParameters: ['/fenvix/prod/engine/admin-token', '/fenvix/prod/control-plane/session-secret'],
});
const dir = mkdtempSync(join(tmpdir(), 'fenvix-ud-'));

describe('user-data script', () => {
  test('is valid bash and fits the 16 KB EC2 limit', () => {
    const f = join(dir, 'userdata.sh');
    writeFileSync(f, lines.join('\n') + '\n');
    execFileSync('bash', ['-n', f]);
    expect(Buffer.byteLength(lines.join('\n'))).toBeLessThan(16384);
  });

  test('stops with a clear message while the placeholder release location is still in use', () => {
    const f = join(dir, 'ph.sh');
    const ph = buildUserData({ config: { ...config, engineUrl: 'https://example.invalid/REPLACE-ME/x-{arch}' }, region: 'r', bucketName: 'b', requiredParameters: [] });
    // Run only the guard: everything up to the first dnf call.
    const guard = ph.slice(0, ph.findIndex((l) => l.startsWith('dnf install')));
    writeFileSync(f, guard.join('\n') + '\n');
    const r = spawnSync('bash', [f], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('placeholder');
  });
});

describe('fenvix-fetch-config (runs the real embedded script against a fake aws CLI)', () => {
  const hasPython = spawnSync('python3', ['--version']).status === 0;
  const script = join(dir, 'fetch.py');
  const bin = join(dir, 'bin');
  beforeAll(() => {
    writeFileSync(script, FETCH_CONFIG);
    execFileSync('mkdir', ['-p', bin]);
    writeFileSync(
      join(bin, 'aws'),
      `#!/bin/bash\ncat <<'J'\n{"Parameters":[{"Name":"/fenvix/prod/engine/admin-token","Value":"tok\\"en\\\\1"},{"Name":"/fenvix/prod/engine/extra-flag","Value":"on"}]}\nJ\n`,
    );
    chmodSync(join(bin, 'aws'), 0o755);
  });
  const run = (...required: string[]) =>
    spawnSync('python3', ['-I', script, 'eu-central-1', '/fenvix/prod', join(dir, 'sys.env'), join(dir, 'docker.env'), 'engine', 'FENVIX_', ...required], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

  (hasPython ? test : test.skip)('writes prefixed KEY=value files with mode 600 and escapes for systemd', () => {
    const r = run('/fenvix/prod/engine/admin-token');
    expect(r.status).toBe(0);
    const sys = readFileSync(join(dir, 'sys.env'), 'utf8');
    expect(sys).toContain('FENVIX_ADMIN_TOKEN="tok\\"en\\\\1"');
    expect(sys).toContain('FENVIX_EXTRA_FLAG="on"');
    expect(readFileSync(join(dir, 'docker.env'), 'utf8')).toContain('FENVIX_ADMIN_TOKEN=tok"en\\1');
    expect((require('fs').statSync(join(dir, 'sys.env')).mode & 0o777).toString(8)).toBe('600');
  });

  (hasPython ? test : test.skip)('fails and names the missing SecureString parameter', () => {
    const r = run('/fenvix/prod/engine/not-created');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('/fenvix/prod/engine/not-created');
  });
});
