import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../lib/config';
import { DOCKER_BRIDGE_IP, ENGINE_BINARY_NAME, engineArgs, engineEnvironment, INSTANCE_ID_PLACEHOLDER, PATHS } from '../lib/engine-command';
import { BASE_CONTEXT } from './helpers';

const config = loadConfig((k) => BASE_CONTEXT[k]);
const args = engineArgs({ config, region: 'eu-west-1', bucketName: 'fenvix-prod-data-865859654353-eu-west-1', holder: 'i-0123456789abcdef0' });

describe('engine command line (flags of the final engine, Mircoguidetti/test5 @ 41ed169, --trusted-networks of network-limits @ 1c9fee7, --grantable-roles of engine-round2 @ 3bcd7e5; see lib/engine-command.ts)', () => {
  test('exactly the production flags, in one place', () => {
    expect(args).toEqual([
      '--listen=0.0.0.0:27018',
      `--admin-listen=${DOCKER_BRIDGE_IP}:8443`,
      `--admin-token-file=${PATHS.adminTokenFile}`,
      '--auth',
      '--tls-mode=requireTLS',
      `--tls-certificate-key-file=${PATHS.enginePem}`,
      '--store=s3',
      '--bucket=fenvix-prod-data-865859654353-eu-west-1',
      '--region=eu-west-1',
      '--holder=i-0123456789abcdef0',
      '--idle-secs=60',
      '--retention-window-secs=604800',
      '--wal-gc-mode=bulk',
      '--trusted-networks=127.0.0.0/8,::1/128,172.17.0.0/16,172.18.0.0/24',
      '--grantable-roles=read,readWrite,dbAdmin',
    ]);
  });

  test('ports, region and retention window follow the settings', () => {
    const c = loadConfig((k) => ({ ...BASE_CONTEXT, mongoPort: '28000', adminPort: '9443', engineRetentionWindowSecs: '86400' })[k]);
    const a = engineArgs({ config: c, region: 'us-east-1', bucketName: 'b', holder: INSTANCE_ID_PLACEHOLDER });
    expect(a).toContain('--listen=0.0.0.0:28000');
    expect(a).toContain(`--admin-listen=${DOCKER_BRIDGE_IP}:9443`);
    expect(a).toContain('--region=us-east-1');
    expect(a).toContain('--retention-window-secs=86400');
    expect(a).toContain(`--holder=${INSTANCE_ID_PLACEHOLDER}`);
  });

  test('no test control, no token on the command line, no MinIO endpoint, no client-certificate CA, no admin interface on all interfaces', () => {
    const forbidden = [
      '--no-leases', '--unsafe-skip-ownership-checks', '--ack-before-durable', '--no-ctl-recovery', '--no-maintenance', '--no-ttl',
      '--gc-control-delete-live', '--l0-', '--serialize-reads', '--no-group-commit', '--durable-reads',
      '--admin-token=', '--endpoint', '--store=local', '--store=memory', '--tls-mode=disabled', '--tls-mode=allowTLS', '--tls-mode=preferTLS',
      '--tls-ca-file', '--tls-allow-connections-without-certificates', '--log-commands', '--wal-gc-mode=slatedb', '--wal-gc-mode=list-only',
    ];
    for (const f of forbidden) expect(args.filter((a) => a.startsWith(f))).toEqual([]);
    expect(args.find((a) => a.startsWith('--admin-listen='))).not.toContain('0.0.0.0');
    expect(args.join(' ')).not.toMatch(/minioadmin|localhost:9000|MONGO_ADMIN_TOKEN/);
  });

  test('the token lives in the runtime directory, the certificate under /etc/fenvix/tls, the binary under /opt/fenvix/bin', () => {
    expect(PATHS.adminTokenFile).toBe('/run/fenvix/admin-token');
    expect(PATHS.enginePem).toBe('/etc/fenvix/tls/engine.pem');
    expect(PATHS.engineBinary).toBe(`/opt/fenvix/bin/${ENGINE_BINARY_NAME}`);
  });

  test('the binary name is written in one place only (lib/engine-command.ts), in code and tests', () => {
    const files = ['lib', 'test'].flatMap((d) => readdirSync(join(__dirname, '..', d)).filter((f) => f.endsWith('.ts')).map((f) => join(d, f)));
    const hits = files.flatMap((f) => (readFileSync(join(__dirname, '..', f), 'utf8').match(new RegExp(ENGINE_BINARY_NAME, 'g')) ?? []).map(() => f));
    expect(hits).toEqual([join('lib', 'engine-command.ts')]);
  });

  test('the region reaches the engine through the flag and the environment (same value), nothing else', () => {
    expect(engineEnvironment('eu-west-1')).toEqual({ AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'eu-west-1' });
  });
});
