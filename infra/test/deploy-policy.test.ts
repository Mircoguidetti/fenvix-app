import { readFileSync } from 'fs';
import { join } from 'path';
import { synth } from './helpers';

const policy = JSON.parse(readFileSync(join(__dirname, '..', 'deploy-policy.json'), 'utf8'));
const cdkJson = JSON.parse(readFileSync(join(__dirname, '..', 'cdk.json'), 'utf8'));
const stmts: any[] = policy.Statement;
const arr = (x: any): any[] => (x === undefined ? [] : [].concat(x));
const actions = stmts.flatMap((s) => arr(s.Action) as string[]);

describe('deploy-policy.json', () => {
  test('is valid, Allow-only, with unique Sids', () => {
    expect(policy.Version).toBe('2012-10-17');
    expect(stmts.every((s) => s.Effect === 'Allow')).toBe(true);
    const sids = stmts.map((s) => s.Sid);
    expect(new Set(sids).size).toBe(sids.length);
  });

  test('has no wildcard action and no dangerous IAM actions', () => {
    for (const a of actions) expect(a).not.toContain('*');
    const forbidden = ['iam:AttachRolePolicy', 'iam:CreatePolicy', 'iam:CreateUser', 'iam:CreateAccessKey', 'iam:PutUserPolicy', 'iam:CreatePolicyVersion', 'sts:AssumeRole', 'ssm:PutParameter', 'ssm:GetParameter*'];
    for (const f of forbidden) expect(actions).not.toContain(f);
  });

  test('Resource "*" is used only where AWS has no resource-level permission', () => {
    const star = stmts.filter((s) => arr(s.Resource).includes('*')).flatMap((s) => arr(s.Action) as string[]);
    for (const a of star) {
      expect(/^(ec2:Describe|cloudwatch:DescribeAlarms$|cloudformation:ValidateTemplate$|route53:CreateHostedZone$)/.test(a)).toBe(true);
    }
  });

  test('every resource ARN is in this account, in the chosen regions, or a named fenvix/AWS-public resource', () => {
    const regions = ['eu-central-1'];
    for (const r of stmts.flatMap((s) => arr(s.Resource) as string[]).filter((x) => x !== '*')) {
      const [, , service, region, account, rest] = r.split(':');
      if (['s3', 'route53', 'iam', 'budgets'].includes(service)) {
        if (service === 'iam' || service === 'budgets') expect(account).toBe('865859654353');
        if (service === 's3') expect(r.startsWith('arn:aws:s3:::fenvix-')).toBe(true);
        continue;
      }
      expect(regions).toContain(region);
      if (!(service === 'ssm' && account === '') && !(service === 'ec2' && account === '')) expect(account).toBe('865859654353');
      expect(rest).toBeDefined();
    }
  });

  test('IAM and CloudFormation resources are named fenvix-*', () => {
    for (const s of stmts) {
      for (const r of arr(s.Resource) as string[]) {
        if (r.includes(':iam::')) expect(r).toMatch(/(role|instance-profile)\/fenvix-\*$/);
        if (r.includes(':cloudformation:')) expect(r).toMatch(/stack\/fenvix-\*\/\*$/);
        if (r.includes(':cloudwatch:')) expect(r).toMatch(/alarm:fenvix-\*$/);
        if (r.includes(':budgets:')) expect(r).toMatch(/budget\/fenvix-\*$/);
      }
    }
  });

  test('EC2 create/modify/launch statements are scoped to project=fenvix; every EC2 action sits behind a region, tag or ARN scope', () => {
    for (const s of stmts) {
      const as = arr(s.Action) as string[];
      if (!as.some((a) => a.startsWith('ec2:') && !a.startsWith('ec2:Describe'))) continue;
      const cond = JSON.stringify(s.Condition ?? {});
      const tagged = cond.includes('"fenvix"');
      const arnOnly = ['Ec2ElasticIpAssociation', 'Ec2LaunchOtherParts'].includes(s.Sid);
      expect({ sid: s.Sid, ok: tagged || arnOnly }).toEqual({ sid: s.Sid, ok: true });
    }
  });

  test('only project=fenvix is referenced; the CI test tag is not', () => {
    const text = JSON.stringify(policy);
    expect(text).not.toContain('fenvix-tests');
    expect(text).toMatch(/"aws:RequestTag\/project":\s*"fenvix"/);
    expect(text).toMatch(/"aws:ResourceTag\/project":\s*"fenvix"/);
  });

  test('PassRole is limited to fenvix-* roles and to EC2 / Budgets', () => {
    const pass = stmts.find((s) => arr(s.Action).includes('iam:PassRole'));
    expect(pass.Resource).toBe('arn:aws:iam::865859654353:role/fenvix-*');
    expect(pass.Condition.StringEquals['iam:PassedToService']).toEqual(['ec2.amazonaws.com', 'budgets.amazonaws.com']);
  });

  test('no ACM permission is left (the certificate comes from Let\'s Encrypt on the server)', () => {
    expect(actions.filter((a) => a.startsWith('acm:'))).toEqual([]);
  });

  test('Secrets Manager: only fenvix-* secrets, created with the project tag; the deploy role can never read a secret value', () => {
    const sm = stmts.filter((s) => arr(s.Action).some((a: string) => a.startsWith('secretsmanager:')));
    for (const s of sm) expect(s.Resource).toBe('arn:aws:secretsmanager:eu-central-1:865859654353:secret:fenvix-*');
    const create = sm.find((s) => arr(s.Action).includes('secretsmanager:CreateSecret'));
    expect(create.Condition).toEqual({ StringEquals: { 'aws:RequestTag/project': 'fenvix' } });
    const all = sm.flatMap((s) => arr(s.Action));
    for (const a of ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue', 'secretsmanager:PutResourcePolicy', 'secretsmanager:RestoreSecret']) {
      expect(all).not.toContain(a);
    }
  });

  test('regions in cdk.json are covered by the policy', () => {
    const regions = String(cdkJson.context.regions).split(',');
    const text = JSON.stringify(policy);
    for (const r of regions) expect(text).toContain(r);
  });

  test('covers a create action for every resource type the stack produces', () => {
    const needed: Record<string, string> = {
      'AWS::S3::Bucket': 's3:CreateBucket',
      'AWS::S3::BucketPolicy': 's3:PutBucketPolicy',
      'AWS::EC2::Instance': 'ec2:RunInstances',
      'AWS::EC2::VPC': 'ec2:CreateVpc',
      'AWS::EC2::Subnet': 'ec2:CreateSubnet',
      'AWS::EC2::SecurityGroup': 'ec2:CreateSecurityGroup',
      'AWS::EC2::SecurityGroupIngress': 'ec2:AuthorizeSecurityGroupIngress',
      'AWS::EC2::RouteTable': 'ec2:CreateRouteTable',
      'AWS::EC2::Route': 'ec2:CreateRoute',
      'AWS::EC2::SubnetRouteTableAssociation': 'ec2:AssociateRouteTable',
      'AWS::EC2::InternetGateway': 'ec2:CreateInternetGateway',
      'AWS::EC2::VPCGatewayAttachment': 'ec2:AttachInternetGateway',
      'AWS::EC2::VPCEndpoint': 'ec2:CreateVpcEndpoint',
      'AWS::EC2::EIP': 'ec2:AllocateAddress',
      'AWS::IAM::Role': 'iam:CreateRole',
      'AWS::IAM::Policy': 'iam:PutRolePolicy',
      'AWS::IAM::InstanceProfile': 'iam:CreateInstanceProfile',
      'AWS::CloudWatch::Alarm': 'cloudwatch:PutMetricAlarm',
      'AWS::Budgets::Budget': 'budgets:ModifyBudget',
      'AWS::Budgets::BudgetsAction': 'budgets:CreateBudgetAction',
      'AWS::Route53::HostedZone': 'route53:CreateHostedZone',
      'AWS::Route53::RecordSet': 'route53:ChangeResourceRecordSets',
      'AWS::SecretsManager::Secret': 'secretsmanager:CreateSecret',
    };
    const { json } = synth({ baseDomain: 'example.com' });
    const types = new Set(Object.values<any>(json.Resources).map((r) => r.Type));
    for (const t of types) {
      expect({ type: t, mapped: needed[t] !== undefined }).toEqual({ type: t, mapped: true });
      expect(actions).toContain(needed[t]);
    }
  });
});
