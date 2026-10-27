import { envVarName, loadConfig, makeLookup } from '../lib/config';
import { BASE_CONTEXT } from './helpers';

describe('settings lookup', () => {
  test('environment variable names', () => {
    expect(envVarName('baseDomain')).toBe('BASE_DOMAIN');
    expect(envVarName('budgetEmail')).toBe('FENVIX_BUDGET_EMAIL');
    expect(envVarName('instanceType')).toBe('FENVIX_INSTANCE_TYPE');
    expect(envVarName('engineSha256')).toBe('FENVIX_ENGINE_SHA256');
    expect(envVarName('controlPlaneImage')).toBe('FENVIX_CONTROL_PLANE_IMAGE');
    expect(envVarName('hostedZoneId')).toBe('FENVIX_HOSTED_ZONE_ID');
  });

  test('environment beats context; an empty variable does not', () => {
    const get = makeLookup((k) => BASE_CONTEXT[k], { FENVIX_INSTANCE_TYPE: 'c7g.large', BASE_DOMAIN: 'Example.com', FENVIX_VOLUME_GB: '' });
    const c = loadConfig(get);
    expect(c.instanceType).toBe('c7g.large');
    expect(c.baseDomain).toBe('example.com');
    expect(c.volumeGb).toBe(20);
  });

  test('missing required setting names the way to set it', () => {
    expect(() => loadConfig(makeLookup((k) => (k === 'budgetEmail' ? undefined : BASE_CONTEXT[k]), {}))).toThrow(/FENVIX_BUDGET_EMAIL/);
  });

  test('engine URL cannot smuggle shell characters into user-data', () => {
    expect(() => loadConfig((k) => (k === 'engineUrl' ? "https://x/$(id)'" : BASE_CONTEXT[k]))).toThrow(/engineUrl/);
    expect(() => loadConfig((k) => (k === 'controlPlaneImage' ? 'img; rm -rf /' : BASE_CONTEXT[k]))).toThrow(/controlPlaneImage/);
  });
});
