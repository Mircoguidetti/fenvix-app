import { readFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../lib/config';
import { requiredSecretNames } from '../lib/parameters';
import { bootScript } from '../lib/user-data';
import { GRANTABLE_ROLES, engineArgs } from '../lib/engine-command';
import { BASE_CONTEXT } from './helpers';

/**
 * --grantable-roles of the engine (Mircoguidetti/test5 engine-round2 @ 3bcd7e5): the only roles a user without root or
 * clusterAdmin (the provisioner `fenvix_provisioner`) may grant, and only on the database the user is defined on; never
 * on admin/local/config, never its own role, never a custom role. The engine accepts only read, readWrite and dbAdmin
 * in the flag and does not start with anything else.
 */
const config = loadConfig((k) => BASE_CONTEXT[k]);
const args = engineArgs({ config, region: 'eu-west-1', bucketName: 'b', holder: 'i-0123456789abcdef0' });

describe('grantable roles of the engine', () => {
  test('exactly read, readWrite, dbAdmin, passed once as --grantable-roles', () => {
    expect(GRANTABLE_ROLES).toEqual(['read', 'readWrite', 'dbAdmin']);
    expect(args.filter((a) => a.startsWith('--grantable-roles'))).toEqual(['--grantable-roles=read,readWrite,dbAdmin']);
  });

  test('only roles the engine accepts in the flag: built-in roles of one database without user administration', () => {
    const accepted = ['read', 'readWrite', 'dbAdmin'];
    for (const r of GRANTABLE_ROLES) {
      expect(accepted).toContain(r);
      expect(r).toMatch(/^[A-Za-z]+$/); // no role@db, no space, no empty item
    }
    for (const never of ['dbOwner', 'userAdmin', 'root', 'clusterAdmin', 'userAdminAnyDatabase', 'readWriteAnyDatabase', 'fenvix_provisioner']) {
      expect(GRANTABLE_ROLES).not.toContain(never);
    }
    expect(new Set(GRANTABLE_ROLES).size).toBe(GRANTABLE_ROLES.length);
  });

  test('covers every role the control plane grants (cp_<id>: readWrite; customer users: readWrite or read)', () => {
    // The customer users (control-plane/docs/database-users.md, CUSTOMER_ROLES in control-plane/src/engine/users.ts of
    // the control-plane branches) are readWrite or read; cp_<id> is USER_ROLE. Read from the source where it is there.
    for (const r of ['readWrite', 'read']) expect(GRANTABLE_ROLES).toContain(r);
    const src = readFileSync(join(__dirname, '..', '..', 'control-plane', 'src', 'engine', 'users.ts'), 'utf8');
    const userRole = /export const USER_ROLE = "([A-Za-z]+)";/.exec(src)?.[1];
    expect(userRole).toBeDefined();
    expect(GRANTABLE_ROLES).toContain(userRole);
    const customer = /export const CUSTOMER_ROLES = \{([^}]*)\}/.exec(src)?.[1];
    for (const m of customer ? customer.matchAll(/:\s*"([A-Za-z]+)"/g) : []) expect(GRANTABLE_ROLES).toContain(m[1]);
  });

  test('the engine unit of the boot script starts the engine with it', () => {
    const script = bootScript({
      config, region: 'eu-west-1', bucketName: 'b', requiredParameters: requiredSecretNames('prod'),
      tlsSecretArn: 'arn:aws:secretsmanager:eu-west-1:865859654353:secret:TlsStore0123ABCD-AbCdEf', hostedZoneId: 'Z0123456789ABC', runControlPlane: true,
      artifactsBucket: 'fenvix-prod-eu-west-1-artifactsbucket1a2b3c4d-0123456789ab', artifactsRegion: 'eu-west-1', arch: 'x86_64' as const,
    }).join('\n');
    expect(script.match(/--grantable-roles=read,readWrite,dbAdmin/g)).toHaveLength(1);
  });
});
