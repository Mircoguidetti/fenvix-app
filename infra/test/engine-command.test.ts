import { loadConfig } from '../lib/config';
import { DOCKER_BRIDGE_IP, engineArgs, engineEnvironment, PATHS } from '../lib/engine-command';
import { BASE_CONTEXT } from './helpers';

const config = loadConfig((k) => BASE_CONTEXT[k]);
const args = engineArgs({ config, region: 'eu-central-1', bucketName: 'fenvix-prod-data-865859654353-eu-central-1' });

describe('engine command line (flags of Mircoguidetti/test5 mongo-server, see lib/engine-command.ts)', () => {
  test('exactly the production flags, in one place', () => {
    expect(args).toEqual([
      '--listen=0.0.0.0:27018',
      `--admin-listen=${DOCKER_BRIDGE_IP}:8443`,
      `--admin-token-file=${PATHS.adminTokenFile}`,
      '--auth',
      '--tls-mode=requireTLS',
      `--tls-certificate-key-file=${PATHS.enginePem}`,
      '--store=s3',
      '--bucket=fenvix-prod-data-865859654353-eu-central-1',
    ]);
  });

  test('ports follow the settings', () => {
    const c = loadConfig((k) => ({ ...BASE_CONTEXT, mongoPort: '28000', adminPort: '9443' })[k]);
    const a = engineArgs({ config: c, region: 'r', bucketName: 'b' });
    expect(a).toContain('--listen=0.0.0.0:28000');
    expect(a).toContain(`--admin-listen=${DOCKER_BRIDGE_IP}:9443`);
  });

  test('no test control, no token on the command line, no MinIO endpoint, no admin interface on all interfaces', () => {
    const forbidden = ['--no-leases', '--unsafe-skip-ownership-checks', '--ack-before-durable', '--no-ctl-recovery', '--admin-token=', '--endpoint', '--store=local', '--store=memory', '--tls-mode=disabled', '--tls-mode=allowTLS', '--tls-mode=preferTLS', '--log-commands'];
    for (const f of forbidden) expect(args.filter((a) => a.startsWith(f))).toEqual([]);
    expect(args.find((a) => a.startsWith('--admin-listen='))).not.toContain('0.0.0.0');
    expect(args.join(' ')).not.toMatch(/minioadmin|localhost:9000/);
  });

  test('the token lives in the runtime directory, the certificate under /etc/fenvix/tls', () => {
    expect(PATHS.adminTokenFile).toBe('/run/fenvix/admin-token');
    expect(PATHS.enginePem).toBe('/etc/fenvix/tls/engine.pem');
  });

  test('the region reaches the engine through the environment (S3 client), nothing else', () => {
    expect(engineEnvironment('eu-central-1')).toEqual({ AWS_REGION: 'eu-central-1', AWS_DEFAULT_REGION: 'eu-central-1' });
  });
});
