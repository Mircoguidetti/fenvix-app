import { Match } from 'aws-cdk-lib/assertions';
import { requiredSecretNames } from '../lib/parameters';
import { challengeRecords } from '../lib/acme';
import { loadConfig } from '../lib/config';
import { allStatements, BASE_CONTEXT, buildApp, synth, userDataText } from './helpers';

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
    // Two bucket policies since the artifacts bucket (test/artifacts.test.ts); this is the data bucket's.
    const dataPolicy = resourcesOf(json, 'AWS::S3::BucketPolicy').filter(([id]) => id.startsWith('DataBucketPolicy'));
    expect(dataPolicy).toHaveLength(1);
    const policy = dataPolicy[0][1].Properties.PolicyDocument.Statement as any[];
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

  test('the admin port (8443) is in no rule at all: it listens on the Docker bridge of the host only', () => {
    for (const r of rules) expect({ rule: r, covers: covers(r, 8443) }).toEqual({ rule: r, covers: false });
    expect(rules).toHaveLength(2);
  });

  test('only TCP, and no self-referencing or other security-group source', () => {
    for (const r of rules) {
      expect(r.IpProtocol).toBe('tcp');
      expect(r.SourceSecurityGroupId).toBeUndefined();
    }
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
    expect(userDataText(j).boot).toContain('--listen=0.0.0.0:28000');
    expect(userDataText(j).boot).toContain('CONNECTION_PORT=28000');
    expect(userDataText(synth().json).boot).toContain('--admin-listen=172.17.0.1:8443');
  });

  test('a different admin port is still in no rule, and the engine binds it on the bridge', () => {
    const j = synth({ adminPort: '31000' }).json;
    const rs: any[] = [
      ...(resourcesOf(j, 'AWS::EC2::SecurityGroup')[0][1].Properties.SecurityGroupIngress ?? []),
      ...resourcesOf(j, 'AWS::EC2::SecurityGroupIngress').map(([, r]) => r.Properties),
    ];
    for (const r of rs) expect(covers(r, 31000)).toBe(false);
    expect(userDataText(j).boot).toContain('--admin-listen=172.17.0.1:31000');
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
    expect(JSON.stringify(synth().json.Resources)).toContain(':automate:eu-west-1:ec2:recover');
  });

  const userData = (ctx: Record<string, string> = {}): string => userDataText(synth(ctx).json).all;

  test('user-data installs and starts engine and control plane with automatic restart', () => {
    const ud = userData();
    expect(ud).toContain('fenvix-engine.service');
    expect(ud).toContain('fenvix-control-plane.service');
    expect(ud).toContain('Restart=always');
    expect(ud).toContain('systemctl enable --now fenvix-engine.service fenvix-tls.timer fenvix-control-plane.service fenvix-proxy.service');
    expect(ud).toContain("ENGINE_VERSION='20261029-628273b0a1b2-r1'");
    expect(ud).toContain("CONTROL_PLANE_VERSION='20261029-61e1378c3d4e-r1'");
    expect(ud).toContain('/usr/local/bin/fenvix-artifact install engine "$ENGINE_VERSION" "$ENGINE_SHA256"');
  });

  // Changed on purpose: no placeholder URL any more (artifacts come from the bucket, test/artifacts.test.ts).
  test('user-data pulls nothing from a registry or a URL; the engine gets flags, not FENVIX_* variables', () => {
    const ud = userData();
    expect(ud).not.toContain('REPLACE-ME');
    expect(ud).not.toMatch(/docker pull \$?\{?CONTROL_PLANE|ENGINE_URL|curl[^\n]*--output \/opt\/fenvix\/bin/);
    expect(ud).not.toContain('FENVIX_TLS_MODE');
    expect(ud).not.toContain('self-signed');
    expect(ud).toContain('--tls-mode=requireTLS --tls-certificate-key-file=/etc/fenvix/tls/engine.pem --store=s3 --bucket=');
  });

  test('user-data lists the SecureString parameter names it requires and carries no secret values', () => {
    const ud = userData();
    for (const n of requiredSecretNames('prod')) expect(ud).toContain(n);
    expect(ud).not.toContain('session-secret');
    expect(ud).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(ud).not.toMatch(/-----BEGIN/);
  });

  test('the engine is passed its bucket; the server is passed the certificate store and the zone of its own stack', () => {
    const { header, boot } = userDataText(synth().json);
    expect(boot).toContain(' --bucket=fenvix-prod-data-865859654353-eu-west-1');
    expect(header).toMatch(/FENVIX_TLS_SECRET_ID='\{"Ref":"TlsStore[A-Za-z0-9]+"\}'/);
    expect(header).toMatch(/FENVIX_DNS_ZONE_ID='\{"Ref":"Zone[A-Za-z0-9]+"\}'/);
    expect(userDataText(synth({ hostedZoneId: 'Z0123456789ABC' }).json).header).toContain("FENVIX_DNS_ZONE_ID='Z0123456789ABC'");
  });

  test('the user data, as EC2 receives it, stays under 16 KB and carries no secret', () => {
    const { header, boot } = userDataText(synth().json);
    expect(Buffer.byteLength(header)).toBeLessThan(16384 - 200); // + the length of two resolved ids
    for (const text of [header, boot]) {
      expect(text).not.toMatch(/-----BEGIN/);
      expect(text).not.toMatch(/AKIA[0-9A-Z]{16}/);
    }
  });

  test('sha256 pin is passed to the instance when set', () => {
    expect(userData({ engineSha256: 'A'.repeat(64) })).toContain("ENGINE_SHA256='" + 'a'.repeat(64) + "'");
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
        if (s.Effect === 'Deny' && a === 's3:*' && /^(DataBucketPolicy|ArtifactsBucketPolicy)/.test(owner) && s.Condition?.Bool?.['aws:SecureTransport'] === 'false') continue;
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
      // The data bucket, or (since the artifacts bucket) one prefix of the artifacts bucket: read by the engine, written by a publisher.
      if (actions.every((a) => a.startsWith('s3:'))) {
        if (res.includes('ArtifactsBucket')) expect([['s3:GetObject'], ['s3:PutObject']]).toContainEqual(actions);
        else expect(res).toContain('DataBucket');
      }
      if (actions.some((a) => a.startsWith('ssm:Get'))) expect(res).toContain('parameter/fenvix/prod');
      if (actions.every((a) => a.startsWith('ec2:Stop'))) expect(res).toContain('instance/');
    }
  });

  test('Resource "*" appears in no Route 53 or Secrets Manager permission', () => {
    for (const { statement: st } of identity) {
      if (asArray(st.Action).some((a: string) => a.startsWith('route53:') || a.startsWith('secretsmanager:'))) {
        expect(asArray(st.Resource)).not.toContain('*');
      }
    }
  });

  test('engine role has no managed policies and EC2 is the only principal that can assume it', () => {
    const roles = resourcesOf(json, 'AWS::IAM::Role');
    // Engine, budget, and (since the artifacts bucket) the two publish roles of GitHub Actions (test/artifacts.test.ts).
    expect(roles.map(([, r]) => r.Properties.RoleName).sort()).toEqual([
      'fenvix-prod-budget-stop-eu-west-1', 'fenvix-prod-engine-eu-west-1', 'fenvix-prod-publish-control-plane', 'fenvix-prod-publish-engine',
    ]);
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

  test('no ACM at all: no certificate resource, no acm: action in any policy', () => {
    const types = Object.values<any>(json.Resources).map((r) => r.Type);
    expect(types.filter((t) => t.startsWith('AWS::CertificateManager'))).toEqual([]);
    for (const { statement: st } of allStatements(json)) for (const a of asArray(st.Action)) expect(a.startsWith('acm:')).toBe(false);
    expect(JSON.stringify(json)).not.toMatch(/acm:|CertificateExport/);
  });

  test('Route 53: the engine role may change only the TXT challenge records of its region, in its zone; and read change status', () => {
    const r53 = identity.filter((s) => s.owner.startsWith('EngineRole') && asArray(s.statement.Action).some((a: string) => a.startsWith('route53:')));
    expect(r53.flatMap((s) => asArray(s.statement.Action)).sort()).toEqual(['route53:ChangeResourceRecordSets', 'route53:GetChange']);
    const change = r53.find((s) => asArray(s.statement.Action).includes('route53:ChangeResourceRecordSets'))!.statement;
    expect(asArray(change.Action)).toEqual(['route53:ChangeResourceRecordSets']);
    expect(change.Resource).toEqual({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':route53:::hostedzone/', { Ref: expect.stringMatching(/^Zone/) }]] });
    expect(change.Condition).toEqual({
      'ForAllValues:StringEquals': {
        'route53:ChangeResourceRecordSetsNormalizedRecordNames': ['_acme-challenge.eu-west-1.db.example.com', '_acme-challenge.api.example.com'],
        'route53:ChangeResourceRecordSetsRecordTypes': ['TXT'],
        'route53:ChangeResourceRecordSetsActions': ['UPSERT', 'DELETE'],
      },
      Null: { 'route53:ChangeResourceRecordSetsNormalizedRecordNames': 'false' },
    });
    const wait = r53.find((s) => asArray(s.statement.Action).includes('route53:GetChange'))!.statement;
    expect(asArray(wait.Action)).toEqual(['route53:GetChange']);
    expect(wait.Resource).toEqual({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':route53:::change/*']] });
  });

  test('Route 53 with an existing zone: the ARN of that zone only', () => {
    const j = synth({ hostedZoneId: 'Z0123456789ABC' }).json;
    const change = allStatements(j).find((s) => asArray(s.statement.Action).includes('route53:ChangeResourceRecordSets'))!.statement;
    expect(change.Resource).toEqual({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':route53:::hostedzone/Z0123456789ABC']] });
  });

  test('Secrets Manager: the engine role may read and write its own certificate store, nothing else', () => {
    const sm = identity.filter((s) => asArray(s.statement.Action).some((a: string) => a.startsWith('secretsmanager:')));
    expect(sm).toHaveLength(1);
    expect(sm[0].owner).toMatch(/^EngineRole/);
    expect(asArray(sm[0].statement.Action).sort()).toEqual(['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue']);
    expect(sm[0].statement.Resource).toEqual({ Ref: expect.stringMatching(/^TlsStore/) });
  });

  test('the certificate store is created holding an empty JSON object, never a certificate', () => {
    const secret = one(json, 'AWS::SecretsManager::Secret');
    expect(secret.Properties.SecretString).toBe('{}');
    expect(secret.Properties.GenerateSecretString).toBeUndefined();
    expect(secret.Properties.Name).toBe('fenvix-prod-tls-eu-west-1');
  });

  test('S3: the engine role gets object get/put/delete, multipart abort and list on its bucket, nothing on old versions', () => {
    const s3 = identity.filter(
      (s) => s.owner.startsWith('EngineRole') && asArray(s.statement.Action).some((a: string) => a.startsWith('s3:')) && JSON.stringify(s.statement.Resource).includes('DataBucket'),
    );
    const actions = s3.flatMap((s) => asArray(s.statement.Action)).sort();
    expect(actions).toEqual(['s3:AbortMultipartUpload', 's3:DeleteObject', 's3:GetObject', 's3:ListBucket', 's3:PutObject']);
  });

  test('kms:Decrypt is limited to calls made through SSM', () => {
    const k = identity.find((s) => asArray(s.statement.Action).includes('kms:Decrypt'))!;
    expect(k.statement.Condition).toEqual({ StringEquals: { 'kms:ViaService': 'ssm.eu-west-1.amazonaws.com' } });
  });
});

describe('tags', () => {
  const taggable = [
    'AWS::S3::Bucket', 'AWS::EC2::Instance', 'AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::SecurityGroup', 'AWS::EC2::InternetGateway',
    'AWS::EC2::RouteTable', 'AWS::EC2::EIP', 'AWS::IAM::Role', 'AWS::CloudWatch::Alarm', 'AWS::Route53::HostedZone', 'AWS::SecretsManager::Secret',
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
    expect(a.Definition.SsmActionDefinition.Region).toBe('eu-west-1');
  });
});

describe('DNS and certificates', () => {
  test('BASE_DOMAIN is required: the engine serves TLS only from a certificate of the domain', () => {
    expect(() => synth({ baseDomain: '' })).toThrow(/baseDomain.*BASE_DOMAIN/);
    expect(() => synth({ baseDomain: '   ' })).toThrow(/BASE_DOMAIN/);
  });

  test('acmeEmail is required and has no default: synth stops and names it', () => {
    expect(() => synth({ acmeEmail: '' })).toThrow(/Missing setting "acmeEmail".*FENVIX_ACME_EMAIL/);
    expect(() => synth({ acmeEmail: 'not-an-address' })).toThrow(/acmeEmail/);
    expect(() => synth({ acmeEmail: "a'b@example.com" })).toThrow(/acmeEmail/);
    expect(require('../cdk.json').context.acmeEmail).toBe('');
  });

  test('acmeStaging: false by default, only "true" or "false"', () => {
    expect(loadConfig((k) => ({ ...BASE_CONTEXT, acmeStaging: undefined as any })[k]).acmeStaging).toBe(false);
    expect(loadConfig((k) => ({ ...BASE_CONTEXT, acmeStaging: 'TRUE' })[k]).acmeStaging).toBe(true);
    expect(() => synth({ acmeStaging: 'yes' })).toThrow(/acmeStaging/);
    expect(require('../cdk.json').context.acmeStaging).toBe('false');
  });

  test('acmeStaging=true changes only the ACME endpoint: same resources, same permissions, same records', () => {
    const a = synth().json;
    const b = synth({ acmeStaging: 'true' }).json;
    const noUd = (j: any) => {
      const copy = JSON.parse(JSON.stringify(j));
      for (const r of Object.values<any>(copy.Resources)) if (r.Type === 'AWS::EC2::Instance') r.Properties.UserData = null;
      return JSON.stringify(copy).replace(/EngineInstance[0-9A-Za-z]+/g, 'EngineInstance');
    };
    expect(noUd(b)).toBe(noUd(a));
    const la = userDataText(a).boot.split('\n');
    const lb = userDataText(b).boot.split('\n');
    expect(lb.filter((l, n) => l !== la[n])).toEqual(["ACME_SERVER='https://acme-staging-v02.api.letsencrypt.org/directory'"]);
  });

  test('dnsZone=domain: zone <domain>, A records *.<region>.db and api to the node IP', () => {
    const { template, json } = synth({ baseDomain: 'Example.com', dnsZone: 'domain' });
    template.resourceCountIs('AWS::Route53::HostedZone', 1);
    template.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'example.com.' });
    template.hasResourceProperties('AWS::Route53::RecordSet', { Name: '*.eu-west-1.db.example.com.', Type: 'A' });
    template.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'api.example.com.', Type: 'A' });
    const names = resourcesOf(json, 'AWS::Route53::RecordSet').map(([, r]) => r.Properties.Name);
    expect(names).not.toContain('*.db.example.com.');
  });

  test('dnsZone=db (the default): zone db.<domain>, the database record only; the api records are outputs to create by hand', () => {
    const { template, json } = synth({ dnsZone: 'db' });
    template.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'db.example.com.' });
    expect(resourcesOf(json, 'AWS::Route53::RecordSet').map(([, r]) => r.Properties.Name)).toEqual(['*.eu-west-1.db.example.com.']);
    expect(json.Outputs.ApiChallengeRecordToCreate.Value).toBe('_acme-challenge.api.example.com CNAME _acme-challenge-api.db.example.com');
    expect(JSON.stringify(json.Outputs.ApiRecordToCreate.Value)).toContain('api.example.com A ');
    const change = allStatements(json).find((s) => asArray(s.statement.Action).includes('route53:ChangeResourceRecordSets'))!.statement;
    expect(change.Condition['ForAllValues:StringEquals']['route53:ChangeResourceRecordSetsNormalizedRecordNames']).toEqual([
      '_acme-challenge.eu-west-1.db.example.com',
      '_acme-challenge-api.db.example.com',
    ]);
    expect(loadConfig((k) => ({ ...BASE_CONTEXT, dnsZone: undefined as any })[k]).dnsZone).toBe('db');
    expect(require('../cdk.json').context.dnsZone).toBe('db');
    expect(() => synth({ dnsZone: 'apex' })).toThrow(/dnsZone/);
  });

  test('every challenge record name lies inside the zone the role may change', () => {
    for (const dnsZone of ['db', 'domain']) {
      const c = loadConfig((k) => ({ ...BASE_CONTEXT, dnsZone })[k]);
      const zone = dnsZone === 'db' ? 'db.example.com' : 'example.com';
      for (const r of challengeRecords(c, 'eu-west-1', true)) expect(r.record.endsWith('.' + zone)).toBe(true);
    }
  });

  test('the certificate covers a database host of the real format, and *.db.<domain> would not', () => {
    const host = 'orders-1a2b3c4d.eu-west-1.db.example.com';
    const covered = (wildcard: string) => wildcard.startsWith('*.') && host.split('.').slice(1).join('.') === wildcard.slice(2);
    expect(covered('*.eu-west-1.db.example.com')).toBe(true);
    expect(covered('*.db.example.com')).toBe(false);
    expect(userDataText(synth().json).boot).toContain("ACME_DOMAINS='*.eu-west-1.db.example.com api.example.com'");
  });

  test('an existing hosted zone id is referenced instead of creating a zone', () => {
    const { template } = synth({ baseDomain: 'example.com', hostedZoneId: 'Z0123456789ABC' });
    template.resourceCountIs('AWS::Route53::HostedZone', 0);
    template.hasResourceProperties('AWS::Route53::RecordSet', { HostedZoneId: 'Z0123456789ABC' });
  });

  test('two regions: an existing zone is required; each region its own certificate names, record and challenge permission; api and control plane in the first only', () => {
    expect(() => buildApp({ regions: 'eu-west-1,us-east-1' })).toThrow(/hostedZoneId/);
    const { stacks } = buildApp({ regions: 'eu-west-1,us-east-1', hostedZoneId: 'Z0123456789ABC', artifactsBucket: 'fenvix-prod-eu-west-1-artifactsbucket1a2b3c4d-0123456789ab' });
    const { Template } = require('aws-cdk-lib/assertions');
    const [a, b] = stacks.map((s) => Template.fromStack(s));
    for (const t of [a, b]) t.resourceCountIs('AWS::Route53::HostedZone', 0);
    const bNames = resourcesOf(b.toJSON(), 'AWS::Route53::RecordSet').map(([, r]) => r.Properties.Name);
    expect(bNames).toEqual(['*.us-east-1.db.example.com.']);
    const names = (t: any) =>
      allStatements(t.toJSON()).find((s) => asArray(s.statement.Action).includes('route53:ChangeResourceRecordSets'))!.statement.Condition['ForAllValues:StringEquals'][
        'route53:ChangeResourceRecordSetsNormalizedRecordNames'
      ];
    expect(names(a)).toEqual(['_acme-challenge.eu-west-1.db.example.com', '_acme-challenge.api.example.com']);
    expect(names(b)).toEqual(['_acme-challenge.us-east-1.db.example.com']);
    const ud = (t: any) => userDataText(t.toJSON()).boot;
    expect(ud(a)).toContain('fenvix-control-plane.service');
    expect(ud(b)).not.toContain('fenvix-control-plane.service');
    expect(ud(b)).toContain("ACME_DOMAINS='*.us-east-1.db.example.com'");
  });

  test('a malformed domain is rejected', () => {
    expect(() => synth({ baseDomain: 'not a domain' })).toThrow(/BASE_DOMAIN/);
  });

  test('dashboard origins must be https origins', () => {
    expect(() => synth({ dashboardOrigins: '' })).toThrow(/dashboardOrigins/);
    expect(() => synth({ dashboardOrigins: 'http://console.fenvix.dev' })).toThrow(/dashboardOrigins/);
    expect(() => synth({ dashboardOrigins: 'https://console.fenvix.dev/' })).toThrow(/dashboardOrigins/);
  });
});

describe('regions', () => {
  test('one config line adds a region: two stacks, separate names, region-specific values', () => {
    const { stacks } = buildApp({ regions: 'eu-west-1,us-east-1,eu-west-2', hostedZoneId: 'Z0123456789ABC', artifactsBucket: 'fenvix-prod-eu-west-1-artifactsbucket1a2b3c4d-0123456789ab' });
    expect(stacks.map((s) => s.stackName)).toEqual(['fenvix-prod-eu-west-1', 'fenvix-prod-us-east-1', 'fenvix-prod-eu-west-2']);
    const { Template } = require('aws-cdk-lib/assertions');
    const names = stacks.map((s) => {
      const t = Template.fromStack(s).toJSON();
      const bucket = resourcesOf(t, 'AWS::S3::Bucket')[0][1].Properties.BucketName;
      const role = resourcesOf(t, 'AWS::IAM::Role')[0][1].Properties.RoleName;
      return { bucket, role };
    });
    expect(names.map((n) => n.bucket)).toEqual([
      'fenvix-prod-data-865859654353-eu-west-1',
      'fenvix-prod-data-865859654353-us-east-1',
      'fenvix-prod-data-865859654353-eu-west-2',
    ]);
    expect(new Set(names.map((n) => n.role)).size).toBe(3);
  });

  test('bad inputs fail loudly', () => {
    expect(() => synth({ regions: 'mars-1' })).toThrow(/not an AWS region/);
    expect(() => synth({ regions: 'eu-west-1,eu-west-1' })).toThrow(/duplicate/);
    expect(() => synth({ budgetEmail: '' })).toThrow(/budgetEmail/);
    expect(() => synth({ retentionDays: '0' })).toThrow(/retentionDays/);
    expect(() => synth({ adminPort: '27018' })).toThrow(/adminPort/);
    expect(() => synth({ controlPlanePort: '27018' })).toThrow(/controlPlanePort/);
  });
});
