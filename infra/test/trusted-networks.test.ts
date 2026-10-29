import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../lib/config';
import { requiredSecretNames } from '../lib/parameters';
import { bootScript } from '../lib/user-data';
import {
  DOCKER_BRIDGE_IP,
  DOCKER_BRIDGE_PREFIX,
  DOCKER_BRIDGE_SUBNET,
  DOCKER_NETWORK,
  DOCKER_NETWORK_SUBNET,
  TRUSTED_NETWORKS,
  engineArgs,
} from '../lib/engine-command';
import { BASE_CONTEXT } from './helpers';

/**
 * --trusted-networks of the engine (Mircoguidetti/test5 network-limits @ 1c9fee7): the networks whose connections skip
 * the per-database IP allowlists, the authentication blocks and the per-address connection limit. Only the processes of
 * the server itself may be in it: loopback, the host's default Docker bridge, and the Docker network of the control plane
 * and its TLS terminator, whose containers reach the engine through the host (host.docker.internal). Never a network
 * customers can come from.
 */
const config = loadConfig((k) => BASE_CONTEXT[k]);
const input = {
  config, region: 'eu-west-1', bucketName: 'b', requiredParameters: requiredSecretNames('prod'),
  tlsSecretArn: 'arn:aws:secretsmanager:eu-west-1:865859654353:secret:TlsStore0123ABCD-AbCdEf', hostedZoneId: 'Z0123456789ABC', runControlPlane: true,
  artifactsBucket: 'fenvix-prod-eu-west-1-artifactsbucket1a2b3c4d-0123456789ab', artifactsRegion: 'eu-west-1', arch: 'x86_64' as const,
};
const lines = bootScript(input);
const script = lines.join('\n');
const VPC_CIDR = '10.40.0.0/24';

/** IPv4 CIDR -> [first, last] as numbers; refuses host bits after the prefix (as the engine does). */
function range(cidr: string): [number, number] {
  const [a, p] = cidr.split('/');
  const parts = a.split('.').map(Number);
  expect(parts).toHaveLength(4);
  const n = parts.reduce((x, y) => x * 256 + y, 0);
  const bits = Number(p);
  const size = 2 ** (32 - bits);
  expect(n % size).toBe(0);
  return [n, n + size - 1];
}
const ip = (s: string) => s.split('.').map(Number).reduce((x, y) => x * 256 + y, 0);
const inside = (cidr: string, addr: string) => { const [lo, hi] = range(cidr); return ip(addr) >= lo && ip(addr) <= hi; };
const overlap = (a: string, b: string) => { const [a0, a1] = range(a); const [b0, b1] = range(b); return a0 <= b1 && b0 <= a1; };

describe('trusted networks of the engine', () => {
  test('loopback, the default Docker bridge and the control plane\'s Docker network; nothing else', () => {
    expect(TRUSTED_NETWORKS).toEqual(['127.0.0.0/8', '::1/128', DOCKER_BRIDGE_SUBNET, DOCKER_NETWORK_SUBNET]);
    expect(engineArgs({ config, region: 'eu-west-1', bucketName: 'b', holder: 'i-0123456789abcdef0' }))
      .toContain('--trusted-networks=127.0.0.0/8,::1/128,172.17.0.0/16,172.18.0.0/24');
  });

  test('the bridge address the engine and the containers use (172.17.0.1) is inside the bridge subnet, which is the pinned bip', () => {
    expect(DOCKER_BRIDGE_SUBNET).toBe('172.17.0.0/16');
    expect(inside(DOCKER_BRIDGE_SUBNET, DOCKER_BRIDGE_IP)).toBe(true);
    expect(inside(DOCKER_BRIDGE_SUBNET, '172.17.0.1')).toBe(true);
    expect(script).toContain(`echo '{"bip": "${DOCKER_BRIDGE_IP}/${DOCKER_BRIDGE_PREFIX}"}' > /etc/docker/daemon.json`);
    const [lo] = range(`${DOCKER_BRIDGE_IP.split('.').slice(0, 2).join('.')}.0.0/${DOCKER_BRIDGE_PREFIX}`);
    expect(lo).toBe(range(DOCKER_BRIDGE_SUBNET)[0]);
  });

  test('every IPv4 network is private, none is the VPC or the whole internet, and they do not overlap', () => {
    const v4 = TRUSTED_NETWORKS.filter((n) => !n.includes(':'));
    for (const n of v4) {
      expect(inside('127.0.0.0/8', n.split('/')[0]) || inside('172.16.0.0/12', n.split('/')[0])).toBe(true);
      expect(overlap(n, VPC_CIDR)).toBe(false);
      expect(Number(n.split('/')[1])).toBeGreaterThanOrEqual(8);
    }
    expect(overlap(DOCKER_BRIDGE_SUBNET, DOCKER_NETWORK_SUBNET)).toBe(false);
    expect(TRUSTED_NETWORKS.filter((n) => n.includes(':'))).toEqual(['::1/128']);
    expect(TRUSTED_NETWORKS).not.toContain('0.0.0.0/0');
    expect(TRUSTED_NETWORKS).not.toContain('::/0');
  });

  test('the control plane\'s Docker network is created with its subnet pinned, in both units that use it', () => {
    for (const unit of ['fenvix-control-plane.service', 'fenvix-proxy.service']) {
      const start = lines.indexOf(`cat > /etc/systemd/system/${unit} <<'FENVIX_EOF'`);
      const body = lines.slice(start, lines.indexOf('FENVIX_EOF', start + 1)).join('\n');
      expect(body).toContain(`ExecStartPre=-/usr/bin/docker network create --subnet=${DOCKER_NETWORK_SUBNET} ${DOCKER_NETWORK}`);
      expect(body).toContain('ExecStartPre=/usr/local/bin/fenvix-check-network');
      expect(body).not.toMatch(/network create (?!--subnet)/);
    }
  });

  test('a fenvix network that already exists with another subnet stops the units (run with a stand-in docker)', () => {
    const start = lines.indexOf("cat > /usr/local/bin/fenvix-check-network <<'FENVIX_EOF'");
    expect(start).toBeGreaterThanOrEqual(0);
    const check = lines.slice(start + 1, lines.indexOf('FENVIX_EOF', start + 1)).join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'fenvix-net-'));
    const run = (subnet: string) => {
      writeFileSync(join(dir, 'docker'), `#!/bin/sh\necho '${subnet}'\n`, { mode: 0o755 });
      writeFileSync(join(dir, 'check.sh'), check.split('/usr/bin/docker').join(join(dir, 'docker')) + '\n', { mode: 0o755 });
      return spawnSync('bash', [join(dir, 'check.sh')], { encoding: 'utf8' });
    };
    expect(run(DOCKER_NETWORK_SUBNET).status).toBe(0);
    const bad = run('172.19.0.0/16');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain(DOCKER_NETWORK_SUBNET);
    expect(run('').status).not.toBe(0);
  });
});
