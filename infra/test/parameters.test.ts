import { readFileSync } from 'fs';
import { join } from 'path';
import { MUST_MATCH, requiredSecretNames, SECRET_PARAMETERS } from '../lib/parameters';

describe('SSM parameters', () => {
  test('the required list, by exact name', () => {
    expect(requiredSecretNames('prod')).toEqual([
      '/fenvix/prod/engine/admin-token',
      '/fenvix/prod/control-plane/engine-admin-token',
      '/fenvix/prod/control-plane/engine-user-key',
      '/fenvix/prod/control-plane/engine-provisioner-password',
      '/fenvix/prod/control-plane/download-signing-key',
      '/fenvix/prod/control-plane/control-plane-database-url',
      '/fenvix/prod/control-plane/supabase-url',
      '/fenvix/prod/control-plane/supabase-anon-key',
    ]);
  });

  test('the rotation key is optional and the unused session secret is gone', () => {
    expect(SECRET_PARAMETERS.find((p) => p.name === 'control-plane/engine-user-key-previous')!.required).toBe(false);
    expect(SECRET_PARAMETERS.map((p) => p.name).join(' ')).not.toContain('session-secret');
  });

  test('control-plane parameters become the variable the fetch script derives from their name', () => {
    for (const p of SECRET_PARAMETERS.filter((x) => x.name.startsWith('control-plane/'))) {
      expect(p.becomes).toBe(p.name.split('/')[1].toUpperCase().replace(/-/g, '_'));
    }
  });

  test('the two admin tokens are checked to be equal', () => {
    expect(MUST_MATCH).toEqual(['control-plane/engine-admin-token', 'engine/admin-token']);
  });

  test('the README table lists every parameter with its required flag', () => {
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    for (const p of SECRET_PARAMETERS) {
      const row = readme.split('\n').find((l) => l.startsWith(`| \`/fenvix/prod/${p.name}\``));
      expect({ name: p.name, row: !!row }).toEqual({ name: p.name, row: true });
      expect(row).toContain(p.required ? '**yes**' : 'no');
    }
  });
});
