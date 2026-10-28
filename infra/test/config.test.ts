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
    expect(envVarName('dashboardOrigins')).toBe('FENVIX_DASHBOARD_ORIGINS');
    expect(envVarName('proxyImage')).toBe('FENVIX_PROXY_IMAGE');
    expect(envVarName('engineRetentionWindowSecs')).toBe('FENVIX_ENGINE_RETENTION_WINDOW_SECS');
    expect(envVarName('mongoPort')).toBe('FENVIX_MONGO_PORT');
    expect(envVarName('acmeEmail')).toBe('FENVIX_ACME_EMAIL');
    expect(envVarName('acmeStaging')).toBe('FENVIX_ACME_STAGING');
    expect(envVarName('dnsZone')).toBe('FENVIX_DNS_ZONE');
  });

  test('cdk.json ships no domain, no ACME email and no dashboard origin: synth stops and names the setting', () => {
    const cdk = require('../cdk.json').context as Record<string, string>;
    expect(cdk.baseDomain).toBe('');
    expect(cdk.dashboardOrigins).toBe('');
    expect(cdk.acmeEmail).toBe('');
    expect(() => loadConfig(makeLookup((k) => ({ ...cdk, budgetEmail: 'a@b.co' })[k], { BASE_DOMAIN: 'example.com' }))).toThrow(/Missing setting "acmeEmail".*FENVIX_ACME_EMAIL/);
    expect(() => loadConfig(makeLookup((k) => ({ ...cdk, budgetEmail: 'a@b.co' })[k], {}))).toThrow(/Missing setting "baseDomain".*BASE_DOMAIN/);
    expect(() => loadConfig(makeLookup((k) => ({ ...cdk, budgetEmail: 'a@b.co' })[k], { BASE_DOMAIN: 'example.com', FENVIX_ACME_EMAIL: 'c@d.co' }))).toThrow(/FENVIX_DASHBOARD_ORIGINS/);
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
