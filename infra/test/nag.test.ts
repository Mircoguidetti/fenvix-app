import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { applySuppressions } from '../lib/nag-suppressions';
import { buildApp } from './helpers';

function run(withSuppressions: boolean, overrides: Record<string, string> = {}) {
  const { app, stacks } = buildApp(overrides);
  for (const s of stacks) {
    if (withSuppressions) applySuppressions(s);
    Aspects.of(s).add(new AwsSolutionsChecks({ verbose: true }));
  }
  const findings: string[] = [];
  for (const s of stacks) {
    const a = Annotations.fromStack(s);
    for (const level of ['Error', 'Warning'] as const) {
      const found = level === 'Error' ? a.findError('*', Match.stringLikeRegexp('AwsSolutions')) : a.findWarning('*', Match.stringLikeRegexp('AwsSolutions'));
      for (const f of found) findings.push(`${level}: ${f.id} -> ${String(f.entry.data)}`);
    }
  }
  void app;
  return findings;
}

describe('cdk-nag AwsSolutions pack', () => {
  test('raw findings are printed for the report', () => {
    const raw = run(false, { baseDomain: 'example.com' });
    // eslint-disable-next-line no-console
    console.log('RAW NAG FINDINGS (no suppressions):\n' + raw.join('\n'));
    expect(Array.isArray(raw)).toBe(true);
  });

  test('no unsuppressed findings (default config)', () => {
    expect(run(true)).toEqual([]);
  });

  test('no unsuppressed findings (dnsZone=db, staging)', () => {
    expect(run(true, { dnsZone: 'db', acmeStaging: 'true' })).toEqual([]);
  });

  test('no unsuppressed findings (with BASE_DOMAIN and two regions)', () => {
    expect(run(true, { baseDomain: 'example.com', regions: 'eu-central-1,us-east-1', hostedZoneId: 'Z0123456789ABC' })).toEqual([]);
  });
});
