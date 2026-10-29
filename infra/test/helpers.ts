import { App, BootstraplessSynthesizer, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { FenvixConfig, loadConfig } from '../lib/config';
import { FenvixStack } from '../lib/fenvix-stack';
import { decodeUserData } from '../lib/user-data';

export const BASE_CONTEXT: Record<string, string> = {
  account: '865859654353',
  regions: 'eu-west-1',
  env: 'prod',
  instanceType: 't3.medium',
  volumeGb: '20',
  retentionDays: '30',
  budgetAmount: '100',
  budgetEmail: 'founder@example.com',
  mongoPort: '27018',
  adminPort: '8443',
  controlPlanePort: '443',
  engineVersion: '20261029-628273b0a1b2-r1',
  engineSha256: 'e'.repeat(64),
  controlPlaneVersion: '20261029-61e1378c3d4e-r1',
  controlPlaneSha256: 'c'.repeat(64),
  engineRepo: 'Mircoguidetti/test5',
  engineRepoBranches: 'main',
  controlPlaneRepo: 'Mircoguidetti/olvix-app',
  controlPlaneRepoBranches: 'main',
  proxyImage: 'public.ecr.aws/docker/library/caddy:2.8.4',
  baseDomain: 'example.com',
  dnsZone: 'domain',
  acmeEmail: 'certs@example.com',
  acmeStaging: 'false',
  dashboardOrigins: 'https://console.fenvix.dev',
  engineRetentionWindowSecs: '604800',
};

/** Builds the app exactly as bin/fenvix.ts does, but from an explicit context (never reads the real environment). */
export function buildApp(overrides: Record<string, string> = {}): { app: App; stacks: FenvixStack[]; config: FenvixConfig } {
  const ctx = { ...BASE_CONTEXT, ...overrides };
  const app = new App({ analyticsReporting: false });
  const config = loadConfig((k) => ctx[k]);
  const stacks = config.regions.map(
    (region, i) =>
      new FenvixStack(app, `fenvix-${config.envName}-${region}`, {
        env: { account: config.account, region },
        config,
        region,
        createDns: i === 0,
        synthesizer: new BootstraplessSynthesizer(),
      }),
  );
  return { app, stacks, config };
}

export function synth(overrides: Record<string, string> = {}): { template: Template; json: any; stack: Stack } {
  const { stacks } = buildApp(overrides);
  const template = Template.fromStack(stacks[0]);
  return { template, json: template.toJSON(), stack: stacks[0] };
}

/** Every IAM policy statement in the template (inline policies, role policies, bucket policies). */
export function allStatements(json: any): { owner: string; type: string; statement: any }[] {
  const out: { owner: string; type: string; statement: any }[] = [];
  for (const [id, r] of Object.entries<any>(json.Resources)) {
    const docs: any[] = [];
    if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::S3::BucketPolicy') docs.push(r.Properties.PolicyDocument);
    if (r.Type === 'AWS::IAM::Role') {
      docs.push(r.Properties.AssumeRolePolicyDocument);
      for (const p of r.Properties.Policies ?? []) docs.push(p.PolicyDocument);
    }
    for (const d of docs) for (const s of [].concat(d.Statement)) out.push({ owner: id, type: r.Type, statement: s });
  }
  return out;
}

/**
 * The engine instance's user data from a template: the plain header (CloudFormation references shown as JSON, e.g.
 * {"Ref":"TlsStore..."}) followed by the decompressed boot script.
 */
export function userDataText(json: any): { header: string; boot: string; all: string } {
  const inst = Object.values<any>(json.Resources).find((r) => r.Type === 'AWS::EC2::Instance');
  const b64 = inst.Properties.UserData['Fn::Base64'];
  const parts: any[] = typeof b64 === 'string' ? [b64] : b64['Fn::Join'][1];
  const header = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('');
  const boot = decodeUserData(header);
  return { header, boot, all: header + '\n' + boot };
}
