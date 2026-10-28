import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../lib/config';
import { controlPlaneEnvironment } from '../lib/control-plane-env';
import { SECRET_PARAMETERS } from '../lib/parameters';
import { BASE_CONTEXT } from './helpers';

const config = loadConfig((k) => BASE_CONTEXT[k]);
const env = Object.fromEntries(controlPlaneEnvironment({ config, region: 'eu-central-1' }));

describe('control-plane container environment', () => {
  test('real engine, on the data port and the admin port of the host', () => {
    expect(env).toMatchObject({
      NODE_ENV: 'production',
      ENGINE_DRIVER: 'real',
      ENGINE_ADMIN_ENDPOINTS: 'http://host.docker.internal:8443',
      ENGINE_ADMIN_ALLOW_PLAIN_HTTP: 'true',
      DATA_ENGINE_ENDPOINTS: 'host.docker.internal:27018',
      DATA_ENGINE_TLS: 'true',
      DATA_ENGINE_TLS_SERVER_NAME: 'engine.eu-central-1.db.example.com',
      CONNECTION_PORT: '27018',
      CONNECTION_DB_NAME: 'engine',
      HOST_TEMPLATE: '<name>-<workspace>.<region>.db.<BASE_DOMAIN>',
      BASE_DOMAIN: 'example.com',
      REGIONS: 'eu-central-1',
      API_PUBLIC_URL: 'https://console.example.com/v1',
      DASHBOARD_ORIGINS: 'https://app.example.com',
      TRUST_PROXY: 'true',
      ENGINE_PROVISIONER_USERNAME: 'fenvix_provisioner',
      ENGINE_RETENTION_WINDOW_SECS: '604800',
    });
  });

  test('no variable is set twice and no secret is in the list', () => {
    const names = controlPlaneEnvironment({ config, region: 'eu-central-1' }).map(([k]) => k);
    expect(new Set(names).size).toBe(names.length);
    const secretVars = SECRET_PARAMETERS.filter((p) => p.name.startsWith('control-plane/')).map((p) => p.becomes);
    for (const s of secretVars) expect(names).not.toContain(s);
    expect(names).not.toContain('SESSION_SECRET');
  });

  test('a database host of the real format is covered by the certificate name *.<region>.db.<domain>', () => {
    const host = 'orders-1a2b3c4d.eu-central-1.db.example.com';
    const wildcard = '*.eu-central-1.db.example.com';
    expect(host.split('.').slice(1).join('.')).toBe(wildcard.slice(2));
    expect(env.DATA_ENGINE_TLS_SERVER_NAME.split('.').slice(1).join('.')).toBe(wildcard.slice(2));
  });

  // The control plane's own settings loader decides: run it (read-only, from control-plane/) on this environment
  // plus made-up secrets named like the SSM parameters.
  const cpConfig = join(__dirname, '..', '..', 'control-plane', 'src', 'config.ts');
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 22 && existsSync(cpConfig);
  (nodeOk ? test : test.skip)('is accepted by control-plane/src/config.ts loadConfig with the secrets of lib/parameters.ts', () => {
    const fake: Record<string, string> = {
      ENGINE_ADMIN_TOKEN: 'fake-admin-token-not-a-secret-0000',
      ENGINE_USER_KEY: 'v1:fake-user-key-not-a-secret-000000000000',
      ENGINE_PROVISIONER_PASSWORD: 'fake-provisioner-password-0000',
      DOWNLOAD_SIGNING_KEY: 'f'.repeat(64),
      CONTROL_PLANE_DATABASE_URL: 'postgresql://u:p@db.invalid:5432/x',
      SUPABASE_URL: 'https://ref.supabase.invalid',
      SUPABASE_ANON_KEY: 'anon',
    };
    for (const p of SECRET_PARAMETERS.filter((x) => x.required && x.name.startsWith('control-plane/'))) expect(Object.keys(fake)).toContain(p.becomes);
    const dir = mkdtempSync(join(tmpdir(), 'fenvix-cp-'));
    const runner = join(dir, 'run.mjs');
    writeFileSync(runner, `const { loadConfig } = await import(process.argv[2]);
try { const c = loadConfig(JSON.parse(process.argv[3])); console.log(JSON.stringify({ ok: true, driver: c.engineDriver, data: c.data.driver, users: !!c.engineUsers, engine: !!c.engine })); }
catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); }\n`);
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', runner, cpConfig, JSON.stringify({ ...env, ...fake })], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, driver: 'real', data: 'mongo', users: true, engine: true });
    // And it refuses when a required secret is missing (the boot script stops earlier, but the service agrees).
    const { ENGINE_USER_KEY: _drop, ...without } = fake;
    const r2 = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', runner, cpConfig, JSON.stringify({ ...env, ...without })], { encoding: 'utf8' });
    expect(JSON.parse(r2.stdout).ok).toBe(false);
  });
});
