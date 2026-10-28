import { Match } from 'aws-cdk-lib/assertions';
import { gunzipSync } from 'zlib';
import { requiredSecretNames } from '../lib/parameters';
import { allStatements, buildApp, synth } from './helpers';

const resourcesOf = (json: any, type: string): [string, any][] =>
  Object.entries<any>(json.Resources).filter(([, r]) => r.Type === type);
const one = (json: any, type: string): any => {
  const found = resourcesOf(json, type);
  expect(found).toHaveLength(1);
  return found[0][1];
};
const asArray = (x: any): any[] => (x === undefined ? [] : [].concat(x));
/** The boot bundle as the server rebuilds it from the BootScripts parameters. */
const bundleOf = (json: any): string => {
  const parts = resourcesOf(json, 'AWS::SSM::Parameter')
    .filter(([id]) => id.startsWith('BootScripts'))
    .sort(([, x], [, y]) => Number(x.Properties.Name.split('-').pop()) - Number(y.Properties.Name.split('-').pop()));
  return gunzipSync(Buffer.from(parts.map(([, r]) => r.Properties.Value).join(''), 'base64')).toString();
};

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
    expect(JSON.stringify(one(j, 'AWS::EC2::Instance').Properties.UserData)).toContain('--listen=0.0.0.0:28000');
    expect(bundleOf(j)).toContain('CONNECTION_PORT=28000');
    expect(JSON.stringify(one(synth().json, 'AWS::EC2::Instance').Properties.UserData)).toContain('--admin-listen=172.17.0.1:8443');
  });

  test('a different admin port is still in no rule, and the engine binds it on the bridge', () => {
    const j = synth({ adminPort: '31000' }).json;
    const rs: any[] = [
      ...(resourcesOf(j, 'AWS::EC2::SecurityGroup')[0][1].Properties.SecurityGroupIngress ?? []),
      ...resourcesOf(j, 'AWS::EC2::SecurityGroupIngress').map(([, r]) => r.Properties),
    ];
    for (const r of rs) expect(covers(r, 31000)).toBe(false);
    expect(JSON.stringify(one(j, 'AWS::EC2::Instance').Properties.UserData)).toContain('--admin-listen=172.17.0.1:31000');
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
    expect(ud).toContain('systemctl enable --now fenvix-engine.service fenvix-tls.timer fenvix-control-plane.service fenvix-proxy.service');
    expect(ud).toContain('releases.example.com/fenvix-engine-{arch}');
    expect(ud).toContain('ghcr.io/example/fenvix-control-plane:1.0.0');
  });

  test('user-data refuses to run with the shipped placeholders; the engine gets flags, not FENVIX_* variables', () => {
    const ud = userData();
    expect(ud).toContain('REPLACE-ME');
    expect(ud).not.toContain('FENVIX_TLS_MODE');
    expect(ud).not.toContain('self-signed');
    expect(ud).toContain('--tls-mode=requireTLS --tls-certificate-key-file=/etc/fenvix/tls/engine.pem --store=s3 --bucket=');
  });

  test('user-data and boot bundle list the SecureString parameter names they require and carry no secret values', () => {
    const ud = userData() + bundleOf(synth().json);
    for (const n of requiredSecretNames('prod')) expect(ud).toContain(n);
    expect(ud).not.toContain('session-secret');
    expect(ud).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(ud).not.toMatch(/-----BEGIN/);
  });

  test('the engine is passed the bucket of its own stack, the certificate script the zone of its own stack', () => {
    const ud = userData();
    expect(ud).toMatch(/--bucket=","?\{"Ref":"DataBucket[A-Za-z0-9]+"\}/);
    expect(ud).toMatch(/echo '","?\{"Ref":"Zone[A-Za-z0-9]+"\},"' > \/etc\/fenvix\/acme-zone-id/);
  });

  test('the boot bundle in SSM is the one the user data checks (SHA-256), split into Standard parameters', () => {
    const { json } = synth();
    const bundle = bundleOf(json);
    const sha = require('crypto').createHash('sha256').update(bundle).digest('hex');
    expect(userData()).toContain(`echo \\"${sha}  /root/fenvix-boot.sh\\" | sha256sum -c -`);
    const params = resourcesOf(json, 'AWS::SSM::Parameter').filter(([id]) => id.startsWith('BootScripts'));
    expect(params.length).toBeGreaterThanOrEqual(1);
    params.forEach(([, r]) => {
      expect(r.Properties.Type).toBe('String');
      expect(r.Properties.Tier).toBe('Standard');
      expect(r.Properties.Value.length).toBeLessThanOrEqual(4096);
      expect(r.Properties.Name).toMatch(/^\/fenvix-boot\/prod\/scripts-\d$/);
    });
    expect(bundle).toContain("cat > /usr/local/bin/fenvix-tls <<'FENVIX_EOF'");
    const inst = resourcesOf(json, 'AWS::EC2::Instance')[0][1];
    for (const [id] of params) expect(inst.DependsOn).toContain(id);
  });

  test('the boot lines of the user data, run against the template\'s parameters, rebuild the bundle; a changed part is refused', () => {
    const { mkdtempSync, writeFileSync, chmodSync, readFileSync } = require('fs');
    const { join } = require('path');
    const { spawnSync } = require('child_process');
    const { json } = synth();
    const parts = one(json, 'AWS::EC2::Instance').Properties.UserData['Fn::Base64']['Fn::Join'][1];
    const lines = parts.filter((x: any) => typeof x === 'string').join('').split('\n');
    const at = lines.findIndex((l: string) => l.startsWith('for p in /fenvix-boot/'));
    const d = mkdtempSync(join(require('os').tmpdir(), 'fenvix-boot-'));
    const values: Record<string, string> = {};
    for (const [, r] of resourcesOf(json, 'AWS::SSM::Parameter')) values[r.Properties.Name] = r.Properties.Value;
    const fake = (vals: Record<string, string>) => {
      for (const [n, v] of Object.entries(vals)) writeFileSync(join(d, n.split('/').pop()!), v);
      writeFileSync(join(d, 'aws'), `#!/bin/bash\nwhile [ $# -gt 0 ]; do [ "$1" = --name ] && n="$2"; shift; done\ncat "${d}/$(basename "$n")"; echo\n`);
      chmodSync(join(d, 'aws'), 0o755);
    };
    const script = [lines[at], lines[at + 1]].join('\n').replace(/\/root\//g, `${d}/`) + '\n';
    writeFileSync(join(d, 'boot.sh'), 'set -euo pipefail\n' + script);
    const runBoot = () => spawnSync('bash', [join(d, 'boot.sh')], { encoding: 'utf8', env: { PATH: `${d}:/usr/bin:/bin` } });
    fake(values);
    const ok = runBoot();
    expect(ok.status).toBe(0);
    expect(readFileSync(join(d, 'fenvix-boot.sh'), 'utf8')).toBe(bundleOf(json));
    const name = Object.keys(values)[0];
    const tampered = require('zlib').gzipSync(Buffer.from(bundleOf(json).replace('--ari-disable', '--ari-disable --x'))).toString('base64');
    fake(Object.fromEntries(Object.keys(values).map((k, n) => [k, n === 0 ? tampered : ''])));
    void name;
    const bad = runBoot();
    expect(bad.status).not.toBe(0);
    expect(bad.stdout + bad.stderr).toMatch(/FAILED/);
  });

  test('the user data stays below the 16 KB EC2 limit', () => {
    const parts = one(synth().json, 'AWS::EC2::Instance').Properties.UserData['Fn::Base64']['Fn::Join'][1];
    // A CloudFormation value is at most a bucket name (63 characters).
    const size = Buffer.byteLength(parts.map((x: any) => (typeof x === 'string' ? x : 'x'.repeat(63))).join(''));
    expect(size).toBeLessThan(16384);
  });

  test('sha256 pin is passed to the instance when set', () => {
    expect(userData({ engineSha256: 'a'.repeat(64) })).toContain("ENGINE_SHA256='" + 'a'.repeat(64) + "'");
  });

  test('stack creates no secret parameter: only the String parameters of the boot scripts (secrets are set by hand as SecureString)', () => {
    const params = resourcesOf(synth().json, 'AWS::SSM::Parameter');
    for (const [id, r] of params) {
      expect(id).toMatch(/^BootScripts\d/);
      expect(r.Properties.Type).toBe('String');
    }
    const bundle = bundleOf(synth().json);
    expect(bundle).not.toMatch(/-----BEGIN|AKIA[0-9A-Z]{16}/);
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

  test('S3 permissions only name the project bucket; SSM only the /fenvix/<env>/ path, the saved certificate and the boot scripts', () => {
    for (const { statement: s } of identity) {
      const actions = asArray(s.Action) as string[];
      const res = JSON.stringify(s.Resource);
      if (actions.every((a) => a.startsWith('s3:'))) expect(res).toContain('DataBucket');
      if (actions.some((a) => a.startsWith('ssm:Get') || a.startsWith('ssm:Put'))) {
        expect(res).toMatch(/parameter\/fenvix\/prod"|parameter\/fenvix\/prod\/\*|parameter\/fenvix-tls\/prod\/acme-state"|parameter\/fenvix-boot\/prod\/scripts-\d"/);
        expect(res).not.toMatch(/parameter\/fenvix-tls\/prod\/\*|parameter\/\*/);
      }
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

  test('no ACM at all: no certificate resource, no acm: action anywhere', () => {
    expect(resourcesOf(json, 'AWS::CertificateManager::Certificate')).toHaveLength(0);
    expect(Object.values<any>(json.Resources).some((r) => r.Type.startsWith('AWS::CertificateManager'))).toBe(false);
    for (const { statement: s } of allStatements(json)) for (const x of asArray(s.Action)) expect(x).not.toMatch(/^acm:/);
    expect(JSON.stringify(json)).not.toMatch(/acm:|ExportCertificate|certificatemanager|CertificateExport/i);
  });

  const r53 = () => identity.filter((s) => asArray(s.statement.Action).some((a: string) => a.startsWith('route53:')));

  test('Route 53: TXT records with exactly the _acme-challenge names, in the stack zone only; no "*" on ChangeResourceRecordSets', () => {
    const change = r53().filter((s) => asArray(s.statement.Action).includes('route53:ChangeResourceRecordSets'));
    expect(change).toHaveLength(1);
    const st = change[0].statement;
    expect(asArray(st.Action)).toEqual(['route53:ChangeResourceRecordSets']);
    expect(st.Resource).toEqual({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':route53:::hostedzone/', { Ref: expect.stringMatching(/^Zone/) }]] });
    expect(st.Condition).toEqual({
      'ForAllValues:StringEquals': {
        'route53:ChangeResourceRecordSetsRecordTypes': ['TXT'],
        'route53:ChangeResourceRecordSetsNormalizedRecordNames': ['_acme-challenge.eu-central-1.db.example.com', '_acme-challenge.console.example.com'],
        'route53:ChangeResourceRecordSetsActions': ['UPSERT', 'DELETE'],
      },
    });
  });

  test('Route 53: besides that, only reading the zone\'s records and waiting for a change; nothing else, no ListHostedZonesByName', () => {
    const actions = r53().flatMap((s) => asArray(s.statement.Action)).sort();
    expect(actions).toEqual(['route53:ChangeResourceRecordSets', 'route53:GetChange', 'route53:ListResourceRecordSets']);
    const get = r53().find((s) => asArray(s.statement.Action).includes('route53:GetChange'))!.statement;
    expect(get.Resource).toBe('arn:aws:route53:::change/*');
    const list = r53().find((s) => asArray(s.statement.Action).includes('route53:ListResourceRecordSets'))!.statement;
    expect(JSON.stringify(list.Resource)).toContain(':route53:::hostedzone/');
    for (const s of r53()) expect(asArray(s.statement.Resource)).not.toContain('*');
  });

  test('Route 53, dnsZone=db and existing zone: the console challenge is the CNAME target inside db.<domain>', () => {
    const { json: j } = synth({ dnsZone: 'db', hostedZoneId: 'Z0123456789ABC' });
    const st = allStatements(j).find((s) => asArray(s.statement.Action).includes('route53:ChangeResourceRecordSets'))!.statement;
    expect(JSON.stringify(st.Resource)).toContain('hostedzone/Z0123456789ABC');
    expect(st.Condition['ForAllValues:StringEquals']['route53:ChangeResourceRecordSetsNormalizedRecordNames']).toEqual([
      '_acme-challenge.eu-central-1.db.example.com',
      '_acme-challenge.console.db.example.com',
    ]);
  });

  test('saved certificate: get/put on that one SSM parameter; kms encrypt only through SSM, for that parameter', () => {
    const p = identity.find((s) => s.statement.Sid === 'TlsStateOwnParameter')!.statement;
    expect(asArray(p.Action).sort()).toEqual(['ssm:GetParameter', 'ssm:PutParameter']);
    expect(JSON.stringify(p.Resource)).toMatch(/:parameter\/fenvix-tls\/prod\/acme-state"\]\]\}$/);
    const k = identity.find((s) => s.statement.Sid === 'EncryptTlsStateViaSsmOnly')!.statement;
    expect(asArray(k.Action).sort()).toEqual(['kms:Encrypt', 'kms:GenerateDataKey']);
    expect(k.Condition.StringEquals['kms:ViaService']).toBe('ssm.eu-central-1.amazonaws.com');
    expect(JSON.stringify(k.Condition.StringEquals['kms:EncryptionContext:PARAMETER_ARN'])).toContain('parameter/fenvix-tls/prod/acme-state');
    const puts = identity.filter((s) => asArray(s.statement.Action).includes('ssm:PutParameter'));
    expect(puts).toHaveLength(1);
  });

  test('S3: the engine role gets object get/put/delete, multipart abort and list on its bucket, nothing on old versions', () => {
    const s3 = identity.filter((s) => s.owner.startsWith('EngineRole') && asArray(s.statement.Action).some((a: string) => a.startsWith('s3:')));
    const actions = s3.flatMap((s) => asArray(s.statement.Action)).sort();
    expect(actions).toEqual(['s3:AbortMultipartUpload', 's3:DeleteObject', 's3:GetObject', 's3:ListBucket', 's3:PutObject']);
  });

  test('kms:Decrypt is limited to calls made through SSM', () => {
    const k = identity.find((s) => asArray(s.statement.Action).includes('kms:Decrypt'))!;
    expect(k.statement.Condition).toEqual({ StringEquals: { 'kms:ViaService': 'ssm.eu-central-1.amazonaws.com' } });
  });
});

describe('tags', () => {
  const taggable = [
    'AWS::S3::Bucket', 'AWS::EC2::Instance', 'AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::SecurityGroup', 'AWS::EC2::InternetGateway',
    'AWS::EC2::RouteTable', 'AWS::EC2::EIP', 'AWS::IAM::Role', 'AWS::CloudWatch::Alarm', 'AWS::Route53::HostedZone', 'AWS::SSM::Parameter',
  ];

  test.each([['prod'], ['staging']])('every taggable resource carries project=fenvix and env=%s', (env) => {
    const { json } = synth({ env, baseDomain: 'example.com' });
    let checked = 0;
    for (const [id, r] of Object.entries<any>(json.Resources)) {
      if (!taggable.includes(r.Type)) continue;
      const tags =
        r.Type === 'AWS::SSM::Parameter'
          ? r.Properties.Tags
          : Object.fromEntries((r.Properties.Tags ?? r.Properties.HostedZoneTags ?? []).map((t: any) => [t.Key, t.Value]));
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
  test('BASE_DOMAIN is required: the engine serves TLS only from a certificate of the domain', () => {
    expect(() => synth({ baseDomain: '' })).toThrow(/baseDomain.*BASE_DOMAIN/);
    expect(() => synth({ baseDomain: '   ' })).toThrow(/BASE_DOMAIN/);
  });

  test('dnsZone=domain: zone <domain>, records *.<region>.db.<domain> and console.<domain> to the node IP, no ACM certificate', () => {
    const { template, json } = synth({ baseDomain: 'Example.com' });
    template.resourceCountIs('AWS::Route53::HostedZone', 1);
    template.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'example.com.' });
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    template.hasResourceProperties('AWS::Route53::RecordSet', { Name: '*.eu-central-1.db.example.com.', Type: 'A' });
    template.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'console.example.com.', Type: 'A' });
    const names = resourcesOf(json, 'AWS::Route53::RecordSet').map(([, r]) => r.Properties.Name);
    expect(names).not.toContain('*.db.example.com.');
    expect(bundleOf(json)).toContain("DOMAINS=('*.eu-central-1.db.example.com' 'console.example.com')");
  });

  test('dnsZone=db: zone db.<domain> with the database record only; console.<domain> and its challenge CNAME are listed for the DNS provider', () => {
    const { template, json } = synth({ dnsZone: 'db' });
    template.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'db.example.com.' });
    const names = resourcesOf(json, 'AWS::Route53::RecordSet').map(([, r]) => r.Properties.Name);
    expect(names).toEqual(['*.eu-central-1.db.example.com.']);
    const out = JSON.stringify(json.Outputs.ManualDnsRecords.Value);
    expect(out).toContain('console.example.com A ');
    expect(out).toContain('_acme-challenge.console.example.com CNAME _acme-challenge.console.db.example.com');
    expect(json.Outputs.NameServers.Description).toContain('NS records of db.example.com');
    expect(bundleOf(json)).toContain("DOMAINS=('*.eu-central-1.db.example.com' 'console.example.com')");
  });

  test('dnsZone must be domain or db', () => {
    expect(() => synth({ dnsZone: '' })).toThrow(/dnsZone/);
    expect(() => synth({ dnsZone: 'sub' })).toThrow(/dnsZone must be one of domain, db/);
  });

  test('acmeEmail is required, with no default, and must be an address', () => {
    expect(() => synth({ acmeEmail: '' })).toThrow(/Missing setting "acmeEmail".*FENVIX_ACME_EMAIL/);
    expect(() => synth({ acmeEmail: 'nobody' })).toThrow(/acmeEmail is not an email address/);
    expect(() => synth({ acmeEmail: "a'b@example.com" })).toThrow(/acmeEmail/);
    expect(bundleOf(synth({ acmeEmail: 'tls@example.org' }).json)).toContain("EMAIL='tls@example.org'");
  });

  test('acmeStaging: false by default; true switches the ACME endpoint only', () => {
    const prod = bundleOf(synth().json);
    expect(prod).toContain("SERVER='https://acme-v02.api.letsencrypt.org/directory'");
    expect(prod).not.toContain('acme-staging');
    const stg = bundleOf(synth({ acmeStaging: 'true' }).json);
    expect(stg).toContain("SERVER='https://acme-staging-v02.api.letsencrypt.org/directory'");
    expect(stg.replace('acme-staging-v02', 'acme-v02')).toBe(prod);
    expect(() => synth({ acmeStaging: 'yes' })).toThrow(/acmeStaging must be true or false/);
  });

  test('the certificate covers a database host of the real format, and *.db.<domain> would not', () => {
    const host = 'orders-1a2b3c4d.eu-central-1.db.example.com';
    const covered = (wildcard: string) => wildcard.startsWith('*.') && host.split('.').slice(1).join('.') === wildcard.slice(2);
    expect(covered('*.eu-central-1.db.example.com')).toBe(true);
    expect(covered('*.db.example.com')).toBe(false);
  });

  test('an existing hosted zone id is referenced instead of creating a zone', () => {
    const { template, json } = synth({ baseDomain: 'example.com', hostedZoneId: 'Z0123456789ABC' });
    template.resourceCountIs('AWS::Route53::HostedZone', 0);
    expect(JSON.stringify(one(json, 'AWS::EC2::Instance').Properties.UserData)).toContain("echo 'Z0123456789ABC' > /etc/fenvix/acme-zone-id");
  });

  test('two regions: an existing zone is required; each region its own certificate names and record, console and control plane in the first only', () => {
    expect(() => buildApp({ regions: 'eu-central-1,us-east-1' })).toThrow(/hostedZoneId/);
    const { stacks } = buildApp({ regions: 'eu-central-1,us-east-1', hostedZoneId: 'Z0123456789ABC' });
    const { Template } = require('aws-cdk-lib/assertions');
    const [a, b] = stacks.map((s) => Template.fromStack(s));
    for (const t of [a, b]) t.resourceCountIs('AWS::Route53::HostedZone', 0);
    expect(bundleOf(a.toJSON())).toContain("DOMAINS=('*.eu-central-1.db.example.com' 'console.example.com')");
    expect(bundleOf(b.toJSON())).toContain("DOMAINS=('*.us-east-1.db.example.com')");
    const names = (t: any) =>
      allStatements(t.toJSON()).find((s) => asArray(s.statement.Action).includes('route53:ChangeResourceRecordSets'))!.statement.Condition['ForAllValues:StringEquals'][
        'route53:ChangeResourceRecordSetsNormalizedRecordNames'
      ];
    expect(names(b)).toEqual(['_acme-challenge.us-east-1.db.example.com']);
    const bNames = resourcesOf(b.toJSON(), 'AWS::Route53::RecordSet').map(([, r]) => r.Properties.Name);
    expect(bNames).toEqual(['*.us-east-1.db.example.com.']);
    const ud = (t: any) => JSON.stringify(one(t.toJSON(), 'AWS::EC2::Instance').Properties.UserData);
    expect(ud(a)).toContain('fenvix-control-plane.service');
    expect(ud(b)).not.toContain('fenvix-control-plane.service');
  });

  test('a malformed domain is rejected', () => {
    expect(() => synth({ baseDomain: 'not a domain' })).toThrow(/BASE_DOMAIN/);
  });

  test('dashboard origins must be https origins', () => {
    expect(() => synth({ dashboardOrigins: '' })).toThrow(/dashboardOrigins/);
    expect(() => synth({ dashboardOrigins: 'http://app.example.com' })).toThrow(/dashboardOrigins/);
    expect(() => synth({ dashboardOrigins: 'https://app.example.com/' })).toThrow(/dashboardOrigins/);
  });
});

describe('regions', () => {
  test('one config line adds a region: two stacks, separate names, region-specific values', () => {
    const { stacks } = buildApp({ regions: 'eu-central-1,us-east-1,eu-west-2', hostedZoneId: 'Z0123456789ABC' });
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
