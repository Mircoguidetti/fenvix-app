import { App, BootstraplessSynthesizer, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { FenvixConfig, loadConfig } from '../lib/config';
import { FenvixStack } from '../lib/fenvix-stack';

export const BASE_CONTEXT: Record<string, string> = {
  account: '865859654353',
  regions: 'eu-central-1',
  env: 'prod',
  instanceType: 't3.medium',
  volumeGb: '20',
  retentionDays: '30',
  budgetAmount: '100',
  budgetEmail: 'founder@example.com',
  mongoPort: '27018',
  adminPort: '8443',
  controlPlanePort: '443',
  engineUrl: 'https://releases.example.com/fenvix-engine-{arch}',
  engineSha256: '',
  controlPlaneImage: 'ghcr.io/example/fenvix-control-plane:1.0.0',
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
