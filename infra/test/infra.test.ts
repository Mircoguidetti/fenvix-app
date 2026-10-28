import { Match } from 'aws-cdk-lib/assertions';
import { allStatements, buildApp, synth } from './helpers';

const resourcesOf = (json: any, type: string): [string, any][] =>
  Object.entries<any>(json.Resources).filter(([, r]) => r.Type === type);
const one = (json: any, type: string): any => {
  const found = resourcesOf(json, type);
  expect(found).toHaveLength(1);
  return found[0][1];
};
const asArray = (x: any): any[] => (x === undefined ? [] : [].concat(x));

describe('S3 data bucket', () => {
  const { template, json } = synth({ retentionDays: '45' });

  test('blocks all public access and encrypts by default', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      BucketEncryption: { ServerSideEncryptionConfiguration: [Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } })] },
    });
  });

  test('is versioned, with a noncurrent-version lifecycle rule using the retention parameter', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 45 } })]) },
    });
  });

  test('is retained when the stack is deleted (customer data)', () => {
    const [, b] = resourcesOf(json, 'AWS::S3::Bucket')[0];
    expect(b.DeletionPolicy).toBe('Retain');
  });

  test('has no ACL/website/public-read configuration', () => {
    const [, b] = resourcesOf(json, 'AWS::S3::Bucket')[0];
    expect(b.Properties.AccessControl).toBeUndefined();
    expect(b.Properties.WebsiteConfiguration).toBeUndefined();
  });

  test('bucket policy denies non-TLS requests', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Action: 's3:*', Condition: { Bool: { 'aws:SecureTransport': 'false' } }, Principal: { AWS: '*' } }),
        ]),
      },
    });
  });

  test('bucket policy allows the engine role and denies every other principal except root', () => {
    const policy = one(json, 'AWS::S3::BucketPolicy').Properties.PolicyDocument.Statement as any[];
    const allow = policy.find((s) => s.Sid === 'EngineRoleOnly');
    expect(allow.Effect).toBe('Allow');
    expect(JSON.stringify(allow.Principal)).toContain('EngineRole');
    const deny = policy.find((s) => s.Sid === 'DenyEveryoneElse');
    expect(deny.Effect).toBe('Deny');
    expect(deny.Principal).toEqual({ AWS: '*' });
    const exempt = JSON.stringify(deny.Condition.ArnNotEquals['aws:PrincipalArn']);
    expect(exempt).toContain('EngineRole');
    expect(exempt).toContain(':root');
    expect(asArray(deny.Action)).toEqual(expect.arrayContaining(['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:ListBucket']));
  });
});

describe('network and security group', () => {
  const { json } = synth();
  const sgId = resourcesOf(json, 'AWS::EC2::SecurityGroup')[0][0];
  const inline = resourcesOf(json, 'AWS::EC2::SecurityGroup')[0][1].Properties.SecurityGroupIngress ?? [];
  const separate = resourcesOf(json, 'AWS::EC2::SecurityGroupIngress').map(([, r]) => r.Properties);
  const rules: any[] = [...inline, ...separate];

  const covers = (r: any, port: number) => r.FromPort <= port && port <= r.ToPort;
  const internet = (r: any) => r.CidrIp === '0.0.0.0/0' || r.CidrIpv6 === '::/0';

  test('opens exactly the MongoDB port (27018) and 443 to the internet', () => {
    const open = rules.filter(internet).map((r) => [r.FromPort, r.ToPort]);
    expect(open.sort()).toEqual([[443, 443], [27018, 27018]].sort());
    for (const r of rules.filter(internet)) expect(r.IpProtocol).toBe('tcp');
  });

  test('the admin port (8443) is in no internet-facing rule, even as part of a range', () => {
    for (const r of rules.filter(internet)) expect(covers(r, 8443)).toBe(false);
    for (const r of rules.filter((x) => x.CidrIp !== undefined || x.CidrIpv6 !== undefined || x.SourcePrefixListId !== undefined)) {
      expect(covers(r, 8443)).toBe(false);
    }
  });

  test('the admin port is reachable only from the same security group', () => {
    const admin = rules.filter((r) => covers(r, 8443));
    expect(admin).toHaveLength(1);
    expect(JSON.stringify(admin[0].SourceSecurityGroupId)).toContain(sgId);
    expect(admin[0].GroupId ? JSON.stringify(admin[0].GroupId) : sgId).toContain(sgId);
  });

  test('no SSH (22) rule and no key pair', () => {
    for (const r of rules) expect(covers(r, 22)).toBe(false);
    const inst = one(json, 'AWS::EC2::Instance');
    expect(inst.Properties.KeyName).toBeUndefined();
  });

  test('the MongoDB port follows the parameter and the engine is told to listen on it', () => {
    const j = synth({ mongoPort: '28000' }).json;
    const rs: any[] = [
      ...(resourcesOf(j, 'AWS::EC2::SecurityGroup')[0][1].Properties.SecurityGroupIngress ?? []),
      ...resourcesOf(j, 'AWS::EC2::SecurityGroupIngress').map(([, r]) => r.Properties),
    ];
    expect(rs.filter(internet).map((r) => r.FromPort).sort((a: number, b: number) => a - b)).toEqual([443, 28000]);
    expect(JSON.stringify(one(j, 'AWS::EC2::Instance').Properties.UserData)).toContain('FENVIX_LISTEN=0.0.0.0:28000');
    expect(JSON.stringify(one(synth().json, 'AWS::EC2::Instance').Properties.UserData)).toContain('FENVIX_ADMIN_LISTEN=0.0.0.0:8443');
  });

  test('admin port follows the parameter', () => {
    const j = synth({ adminPort: '31000' }).json;
    const rs: any[] = [
      ...(resourcesOf(j, 'AWS::EC2::SecurityGroup')[0][1].Properties.SecurityGroupIngress ?? []),
      ...resourcesOf(j, 'AWS::EC2::SecurityGroupIngress').map(([, r]) => r.Properties),
    ];
    expect(rs.filter(internet).some((r) => covers(r, 31000))).toBe(false);
    expect(rs.some((r) => covers(r, 31000) && r.SourceSecurityGroupId)).toBe(true);
  });

  test('one public subnet, an internet gateway and no NAT gateway', () => {
    expect(resourcesOf(json, 'AWS::EC2::Subnet')).toHaveLength(1);
    expect(resourcesOf(json, 'AWS::EC2::NatGateway')).toHaveLength(0);
    expect(resourcesOf(json, 'AWS::EC2::InternetGateway')).toHaveLength(1);
  });
});

describe('engine node', () => {
  test('default instance type is t3.medium and the parameter is honoured', () => {
    expect(one(synth().json, 'AWS::EC2::Instance').Properties.InstanceType).toBe('t3.medium');
    expect(one(synth({ instanceType: 'c7g.large' }).json, 'AWS::EC2::Instance').Properties.InstanceType).toBe('c7g.large');
    expect(one(synth({ instanceType: 'c6i.large' }).json, 'AWS::EC2::Instance').Properties.InstanceType).toBe('c6i.large');
  });

  test('Graviton instance gets the arm64 image, x86 gets x86_64', () => {
    const img = (ctx: Record<string, string>) => JSON.stringify(synth(ctx).json.Parameters);
    expect(img({ instanceType: 'c7g.large' })).toContain('arm64');
    expect(img({})).toContain('x86_64');
  });

  test('other instance types are rejected', () => {
    expect(() => synth({ instanceType: 'm5.24xlarge' })).toThrow(/instanceType must be one of/);
  });

  test('has one small encrypted gp3 root volume and requires IMDSv2', () => {
    const { Properties: p } = one(synth({ volumeGb: '30' }).json, 'AWS::EC2::Instance');
    expect(p.BlockDeviceMappings).toEqual([
      expect.objectContaining({ DeviceName: '/dev/xvda', Ebs: expect.objectContaining({ Encrypted: true, VolumeSize: 30, VolumeType: 'gp3', DeleteOnTermination: true }) }),
    ]);
    expect(p.MetadataOptions.HttpTokens).toBe('required');
  });

  test('the instance role is out of reach of containers: the metadata service answers one hop only', () => {
    const { Properties: p } = one(synth().json, 'AWS::EC2::Instance');
    expect(p.MetadataOptions.HttpPutResponseHopLimit).toBe(1);
  });

  test('has an elastic IP and an auto-recovery alarm', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::EC2::EIP', 1);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'StatusCheckFailed_System',
      AlarmActions: [Match.objectLike({ 'Fn::Join': Match.anyValue() })],
    });
    expect(JSON.stringify(synth().json.Resources)).toContain(':automate:eu-central-1:ec2:recover');
  });

  const userData = (ctx: Record<string, string> = {}): string => {
    const { json } = synth(ctx);
    const ud = one(json, 'AWS::EC2::Instance').Properties.UserData['Fn::Base64'];
    return typeof ud === 'string' ? ud : JSON.stringify(ud);
  };

  test('user-data installs and starts engine and control plane with automatic restart', () => {
    const ud = userData();
    expect(ud).toContain('fenvix-engine.service');
    expect(ud).toContain('fenvix-control-plane.service');
    expect(ud).toContain('Restart=always');
    expect(ud).toContain('systemctl enable --now fenvix-engine.service fenvix-control-plane.service');
    expect(ud).toContain('releases.example.com/fenvix-engine-{arch}');
    expect(ud).toContain('ghcr.io/example/fenvix-control-plane:1.0.0');
  });

  test('user-data refuses to run with the shipped placeholders and uses a self-signed cert without a domain', () => {
    const ud = userData();
    expect(ud).toContain('REPLACE-ME');
    expect(ud).toContain('FENVIX_TLS_MODE=self-signed');
    expect(ud).not.toContain('FENVIX_BASE_DOMAIN');
  });

  test('user-data lists the SecureString parameter names it requires and carries no secret values', () => {
    const ud = userData();
    expect(ud).toContain('/fenvix/prod/engine/admin-token');
    expect(ud).toContain('/fenvix/prod/control-plane/session-secret');
    expect(ud).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(ud).not.toMatch(/-----BEGIN/);
  });

  test('sha256 pin is passed to the instance when set', () => {
    expect(userData({ engineSha256: 'a'.repeat(64) })).toContain("ENGINE_SHA256='" + 'a'.repeat(64) + "'");
  });

  test('stack creates no SSM parameters (secrets are set by hand as SecureString)', () => {
    expect(resourcesOf(synth().json, 'AWS::SSM::Parameter')).toHaveLength(0);
  });

  test('no assets, lambdas or custom resources (deployable without CDK bootstrap)', () => {
    const { json } = synth({ baseDomain: 'example.com' });
    const types = Object.values<any>(json.Resources).map((r) => r.Type);
    expect(types.filter((t) => t.startsWith('AWS::Lambda') || t.startsWith('Custom::') || t === 'AWS::CloudFormation::CustomResource')).toEqual([]);
    expect(JSON.stringify(json)).not.toMatch(/cdk-hnb659fds|BootstrapVersion/);
  });
});

describe('IAM', () => {
  const { json } = synth({ baseDomain: 'example.com' });
  const identity = allStatements(json).filter((s) => s.type !== 'AWS::S3::BucketPolicy' && s.statement.Effect === 'Allow' && s.statement.Action);

  test('no wildcard in any action of any statement (identity or resource policy)', () => {
    for (const { statement: s, owner } of allStatements(json)) {
      if (s.Sid === undefined && s.Action === 'sts:AssumeRole') continue;
      for (const a of asArray(s.Action)) {
        // enforceSSL's deny uses s3:* by design (Deny only); every Allow must be explicit.
        if (s.Effect === 'Deny' && a === 's3:*' && owner.startsWith('DataBucketPolicy')) continue;
        expect({ owner, action: a, wildcard: a.includes('*') }).toEqual({ owner, action: a, wildcard: false });
      }
    }
  });

  test('Resource "*" only on the APIs that do not support resource-level permissions', () => {
    const allowedStar = new Set([
      'ssm:UpdateInstanceInformation', 'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel', 'ssmmessages:OpenControlChannel',
      'ssmmessages:OpenDataChannel', 'ec2messages:AcknowledgeMessage', 'ec2messages:DeleteMessage', 'ec2messages:FailMessage',
      'ec2messages:GetEndpoint', 'ec2messages:GetMessages', 'ec2messages:SendReply', 'ec2:DescribeInstanceStatus',
    ]);
    for (const { statement: s } of identity) {
      if (asArray(s.Resource).includes('*')) for (const a of asArray(s.Action)) expect(allowedStar.has(a)).toBe(true);
    }
  });

  test('S3 permissions only name the project bucket; SSM only the /fenvix/<env>/ path', () => {
    for (const { statement: s } of identity) {
      const actions = asArray(s.Action) as string[];
      const res = JSON.stringify(s.Resource);
      if (actions.every((a) => a.startsWith('s3:'))) expect(res).toContain('DataBucket');
      if (actions.some((a) => a.startsWith('ssm:Get'))) expect(res).toContain('parameter/fenvix/prod');
      if (actions.every((a) => a.startsWith('ec2:Stop'))) expect(res).toContain('instance/');
    }
  });

  test('engine role has no managed policies and EC2 is the only principal that can assume it', () => {
    const roles = resourcesOf(json, 'AWS::IAM::Role');
    expect(roles).toHaveLength(2);
    for (const [, r] of roles) expect(r.Properties.ManagedPolicyArns).toBeUndefined();
    const engine = roles.find(([, r]) => r.Properties.RoleName.includes('engine'))![1];
    expect(engine.Properties.AssumeRolePolicyDocument.Statement[0].Principal).toEqual({ Service: 'ec2.amazonaws.com' });
  });

  test('budget role trusts only AWS Budgets from this account and can stop only the engine instance', () => {
    const budgetRole = resourcesOf(json, 'AWS::IAM::Role').find(([, r]) => r.Properties.RoleName.includes('budget'))![1];
    const trust = budgetRole.Properties.AssumeRolePolicyDocument.Statement[0];
    expect(trust.Principal).toEqual({ Service: 'budgets.amazonaws.com' });
    expect(trust.Condition.StringEquals['aws:SourceAccount']).toBe('865859654353');
    const stop = identity.find((s) => asArray(s.statement.Action).includes('ec2:StopInstances'))!;
    expect(JSON.stringify(stop.statement.Resource)).toContain('EngineInstance');
  });

  test('kms:Decrypt is limited to calls made through SSM', () => {
    const k = identity.find((s) => asArray(s.statement.Action).includes('kms:Decrypt'))!;
    expect(k.statement.Condition).toEqual({ StringEquals: { 'kms:ViaService': 'ssm.eu-central-1.amazonaws.com' } });
  });
});

describe('tags', () => {
  const taggable = [
    'AWS::S3::Bucket', 'AWS::EC2::Instance', 'AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::SecurityGroup', 'AWS::EC2::InternetGateway',
    'AWS::EC2::RouteTable', 'AWS::EC2::EIP', 'AWS::IAM::Role', 'AWS::CloudWatch::Alarm', 'AWS::Route53::HostedZone', 'AWS::CertificateManager::Certificate',
  ];

  test.each([['prod'], ['staging']])('every taggable resource carries project=fenvix and env=%s', (env) => {
    const { json } = synth({ env, baseDomain: 'example.com' });
    let checked = 0;
    for (const [id, r] of Object.entries<any>(json.Resources)) {
      if (!taggable.includes(r.Type)) continue;
      const tags = Object.fromEntries((r.Properties.Tags ?? r.Properties.HostedZoneTags ?? []).map((t: any) => [t.Key, t.Value]));
      expect({ id, project: tags.project, env: tags.env }).toEqual({ id, project: 'fenvix', env });
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(12);
  });

  test('the tag used by the CI test role (fenvix-tests) appears nowhere', () => {
    expect(JSON.stringify(synth({ baseDomain: 'example.com' }).json)).not.toContain('fenvix-tests');
  });

  test('stack-level tags are set as well', () => {
    const { stack } = synth();
    expect(stack.tags.tagValues()).toEqual({ project: 'fenvix', env: 'prod' });
  });
});

describe('cost guard', () => {
  const { json } = synth({ budgetAmount: '250', budgetEmail: 'cfo@example.org' });

  test('monthly budget with the amount parameter', () => {
    const b = one(json, 'AWS::Budgets::Budget').Properties;
    expect(b.Budget.BudgetLimit).toEqual({ Amount: 250, Unit: 'USD' });
    expect(b.Budget.TimeUnit).toBe('MONTHLY');
    expect(b.Budget.BudgetType).toBe('COST');
  });

  test('email alerts at 50, 80 and 100 percent to the email parameter', () => {
    const n = one(json, 'AWS::Budgets::Budget').Properties.NotificationsWithSubscribers;
    expect(n.map((x: any) => x.Notification.Threshold).sort((a: number, b: number) => a - b)).toEqual([50, 80, 100]);
    for (const x of n) {
      expect(x.Notification).toMatchObject({ NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', ThresholdType: 'PERCENTAGE' });
      expect(x.Subscribers).toEqual([{ SubscriptionType: 'EMAIL', Address: 'cfo@example.org' }]);
    }
  });

  test('a budget action stops the engine instance automatically at 100 percent', () => {
    const a = one(json, 'AWS::Budgets::BudgetsAction').Properties;
    expect(a.ActionType).toBe('RUN_SSM_DOCUMENTS');
    expect(a.ActionThreshold).toEqual({ Type: 'PERCENTAGE', Value: 100 });
    expect(a.ApprovalModel).toBe('AUTOMATIC');
    expect(a.Definition.SsmActionDefinition.Subtype).toBe('STOP_EC2_INSTANCES');
    expect(JSON.stringify(a.Definition.SsmActionDefinition.InstanceIds)).toContain('EngineInstance');
    expect(a.Definition.SsmActionDefinition.Region).toBe('eu-central-1');
  });
});

describe('DNS and certificates', () => {
  const dnsTypes = (json: any) =>
    Object.values<any>(json.Resources).map((r) => r.Type).filter((t) => t.startsWith('AWS::Route53::') || t.startsWith('AWS::CertificateManager::'));

  test('nothing is created when BASE_DOMAIN is unset or empty', () => {
    expect(dnsTypes(synth().json)).toEqual([]);
    expect(dnsTypes(synth({ baseDomain: '' }).json)).toEqual([]);
    expect(dnsTypes(synth({ baseDomain: '   ' }).json)).toEqual([]);
  });

  test('with BASE_DOMAIN: hosted zone, DNS-validated certificate for *.db and console, records to the node IP', () => {
    const { template, json } = synth({ baseDomain: 'Example.com' });
    template.resourceCountIs('AWS::Route53::HostedZone', 1);
    template.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'example.com.' });
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: '*.db.example.com',
      SubjectAlternativeNames: ['console.example.com'],
      ValidationMethod: 'DNS',
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', { Name: '*.db.example.com.', Type: 'A' });
    template.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'console.example.com.', Type: 'A' });
    expect(JSON.stringify(json)).toContain('FENVIX_BASE_DOMAIN=example.com');
  });

  test('an existing hosted zone id is referenced instead of creating a zone', () => {
    const { template } = synth({ baseDomain: 'example.com', hostedZoneId: 'Z0123456789ABC' });
    template.resourceCountIs('AWS::Route53::HostedZone', 0);
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainValidationOptions: Match.arrayWith([Match.objectLike({ HostedZoneId: 'Z0123456789ABC' })]),
    });
  });

  test('only the first region creates DNS', () => {
    const { stacks } = buildApp({ baseDomain: 'example.com', regions: 'eu-central-1,us-east-1' });
    const { Template } = require('aws-cdk-lib/assertions');
    Template.fromStack(stacks[0]).resourceCountIs('AWS::Route53::HostedZone', 1);
    Template.fromStack(stacks[1]).resourceCountIs('AWS::Route53::HostedZone', 0);
    Template.fromStack(stacks[1]).resourceCountIs('AWS::CertificateManager::Certificate', 0);
  });

  test('a malformed domain is rejected', () => {
    expect(() => synth({ baseDomain: 'not a domain' })).toThrow(/BASE_DOMAIN/);
  });
});

describe('regions', () => {
  test('one config line adds a region: two stacks, separate names, region-specific values', () => {
    const { stacks } = buildApp({ regions: 'eu-central-1,us-east-1,eu-west-2' });
    expect(stacks.map((s) => s.stackName)).toEqual(['fenvix-prod-eu-central-1', 'fenvix-prod-us-east-1', 'fenvix-prod-eu-west-2']);
    const { Template } = require('aws-cdk-lib/assertions');
    const names = stacks.map((s) => {
      const t = Template.fromStack(s).toJSON();
      const bucket = resourcesOf(t, 'AWS::S3::Bucket')[0][1].Properties.BucketName;
      const role = resourcesOf(t, 'AWS::IAM::Role')[0][1].Properties.RoleName;
      return { bucket, role };
    });
    expect(names.map((n) => n.bucket)).toEqual([
      'fenvix-prod-data-865859654353-eu-central-1',
      'fenvix-prod-data-865859654353-us-east-1',
      'fenvix-prod-data-865859654353-eu-west-2',
    ]);
    expect(new Set(names.map((n) => n.role)).size).toBe(3);
  });

  test('bad inputs fail loudly', () => {
    expect(() => synth({ regions: 'mars-1' })).toThrow(/not an AWS region/);
    expect(() => synth({ regions: 'eu-central-1,eu-central-1' })).toThrow(/duplicate/);
    expect(() => synth({ budgetEmail: '' })).toThrow(/budgetEmail/);
    expect(() => synth({ retentionDays: '0' })).toThrow(/retentionDays/);
    expect(() => synth({ adminPort: '27018' })).toThrow(/adminPort/);
    expect(() => synth({ controlPlanePort: '27018' })).toThrow(/controlPlanePort/);
  });
});
