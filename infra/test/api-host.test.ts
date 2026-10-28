import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { allStatements, synth, userDataText } from './helpers';

// Addresses: fenvix.dev (landing, Vercel), console.fenvix.dev (dashboard, Vercel), api.fenvix.dev (control-plane API,
// this stack), <name>-<ws>.<region>.db.fenvix.dev (databases). console.<domain> must never be the API's host here:
// it may only appear as the dashboard origin the control plane allows (DASHBOARD_ORIGINS).
const PROD = { baseDomain: 'fenvix.dev', dashboardOrigins: 'https://console.fenvix.dev' };

function everything(overrides: Record<string, string>): { text: string; boot: string; json: any } {
  const { json } = synth(overrides);
  const ud = userDataText(json);
  return { text: JSON.stringify(json) + '\n' + ud.all, boot: ud.boot, json };
}

describe('API host is api.<domain>, never console.<domain>', () => {
  for (const dnsZone of ['db', 'domain']) {
    test(`template and user data (dnsZone=${dnsZone}): console.<domain> only as the dashboard origin`, () => {
      const { text, boot } = everything({ ...PROD, dnsZone });
      // The one allowed place: the CORS list of the control plane.
      expect(boot).toContain('\nDASHBOARD_ORIGINS=https://console.fenvix.dev\n');
      const rest = text.split('DASHBOARD_ORIGINS=https://console.fenvix.dev').join('');
      expect(rest).not.toMatch(/console\.fenvix\.dev/);
      expect(rest).not.toMatch(/acme-challenge[.-]console/);
      // And the API host is where it must be.
      expect(boot).toContain('\nAPI_PUBLIC_URL=https://api.fenvix.dev/v1\n');
      expect(boot).toContain('https://api.fenvix.dev:443 {');
      expect(boot).toContain("ACME_DOMAINS='*.eu-central-1.db.fenvix.dev api.fenvix.dev'");
    });
  }

  test('with any other dashboard origin, console.<domain> does not appear at all', () => {
    const { text } = everything({ baseDomain: 'fenvix.dev', dashboardOrigins: 'https://dash.example.org', dnsZone: 'db' });
    expect(text).not.toMatch(/console\.fenvix\.dev/);
  });

  test('outputs, DNS and IAM name api.<domain>', () => {
    const db = everything({ ...PROD, dnsZone: 'db' }).json;
    expect(db.Outputs.ControlPlaneUrl.Value).toBe('https://api.fenvix.dev/v1');
    expect(db.Outputs.ApiChallengeRecordToCreate.Value).toBe('_acme-challenge.api.fenvix.dev CNAME _acme-challenge-api.db.fenvix.dev');
    expect(JSON.stringify(db.Outputs.ApiRecordToCreate.Value)).toContain('api.fenvix.dev A ');
    const names = (json: any) =>
      allStatements(json)
        .filter((s) => s.statement.Sid === 'AcmeDnsChallengeTxtOnly')
        .map((s) => s.statement.Condition['ForAllValues:StringEquals']['route53:ChangeResourceRecordSetsNormalizedRecordNames']);
    expect(names(db)).toEqual([['_acme-challenge.eu-central-1.db.fenvix.dev', '_acme-challenge-api.db.fenvix.dev']]);
    const dom = everything({ ...PROD, dnsZone: 'domain' }).json;
    expect(names(dom)).toEqual([['_acme-challenge.eu-central-1.db.fenvix.dev', '_acme-challenge.api.fenvix.dev']]);
    const records = Object.values<any>(dom.Resources).filter((r) => r.Type === 'AWS::Route53::RecordSet').map((r) => r.Properties.Name).sort();
    expect(records).toEqual(['*.eu-central-1.db.fenvix.dev.', 'api.fenvix.dev.']);
  });

  test('the dashboard origin list cannot hold the API origin or a database host', () => {
    expect(() => synth({ ...PROD, dashboardOrigins: 'https://console.fenvix.dev,https://api.fenvix.dev' })).toThrow(/API's own origin/);
    expect(() => synth({ ...PROD, dashboardOrigins: 'https://api.fenvix.dev:443' })).toThrow(/API's own origin/);
    expect(() => synth({ ...PROD, dashboardOrigins: 'https://orders-1a2b.eu-central-1.db.fenvix.dev' })).toThrow(/database host/);
    expect(() => synth({ ...PROD, dashboardOrigins: ' , ' })).toThrow(/dashboardOrigins/);
    expect(() => synth({ ...PROD, dashboardOrigins: 'https://console.fenvix.dev,https://staging-console.fenvix.dev' })).not.toThrow();
  });

  test('no code in infra/ builds console.<domain> as a host', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(join(root, 'lib'));
    walk(join(root, 'bin'));
    files.push(join(root, 'cdk.json'), join(root, 'deploy-policy.json'));
    const bad = [
      /console\.\$\{/, // `console.${c.baseDomain}`
      /['"`]console\./, // 'console.' + domain
      /_acme-challenge[.-]console/,
      /consoleHost|consoleChallengeTarget|withConsole/,
      /ConsoleRecordToCreate|ConsoleChallengeRecordToCreate/,
    ];
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (bad.some((re) => re.test(line))) hits.push(`${f.slice(root.length + 1)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
