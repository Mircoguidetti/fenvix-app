import { CfnOutput, Duration, Fn, RemovalPolicy, SecretValue, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { challengeRecords, consoleChallengeTarget, zoneName } from './acme';
import { FenvixConfig, PROJECT_TAG } from './config';
import { consoleHost } from './control-plane-env';
import { requiredSecretNames, ssmPrefix } from './parameters';
import { buildUserData } from './user-data';

export { requiredSecretNames };

export interface FenvixStackProps extends StackProps {
  config: FenvixConfig;
  /** Region this stack deploys to (also in props.env). */
  region: string;
  /**
   * The first region of the list: it creates the hosted zone (unless hostedZoneId is given), the console record, and
   * runs the control plane. Every region has its own certificate (Let's Encrypt, on the server) and `*.<region>.db.<domain>` record.
   */
  createDns: boolean;
  /** Extra principals (ARNs) allowed to touch bucket data, e.g. a break-glass admin role. The account root is always allowed. */
  bucketAdminPrincipalArns?: string[];
}

// What the engine's object store client calls: GET/HEAD, PUT (also conditional puts, copies and multipart parts),
// DELETE, abort of a multipart upload, LIST. No version-level access: old versions are only for recovery by a person.
const BUCKET_OBJECT_ACTIONS = ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'];
const BUCKET_LIST_ACTIONS = ['s3:ListBucket'];
// Denied to everyone but the engine role and the account root, a wider list than the role is given.
const BUCKET_DENY_ACTIONS = [
  ...BUCKET_OBJECT_ACTIONS,
  's3:GetObjectVersion',
  's3:DeleteObjectVersion',
  ...BUCKET_LIST_ACTIONS,
  's3:ListBucketVersions',
  's3:ListBucketMultipartUploads',
];

export class FenvixStack extends Stack {
  /** Pinned so synth never performs an AWS availability-zone lookup (we have no credentials at synth time). */
  override get availabilityZones(): string[] {
    return [`${this.region}a`];
  }

  constructor(scope: Construct, id: string, props: FenvixStackProps) {
    super(scope, id, props);
    const c = props.config;
    const region = props.region;
    const name = `fenvix-${c.envName}`;

    Tags.of(this).add('project', PROJECT_TAG);
    Tags.of(this).add('env', c.envName);

    // ---- Network: one public subnet, no NAT, no SSH ---------------------------------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.40.0.0/24'),
      availabilityZones: [`${region}a`],
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 26, mapPublicIpOnLaunch: true }],
      // The default implementation is a Lambda custom resource, which needs a CDK bootstrap bucket.
      restrictDefaultSecurityGroup: false,
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
    });

    const sg = new ec2.SecurityGroup(this, 'EngineSg', {
      vpc,
      description: 'FENVIX engine node: MongoDB wire (TLS) and control-plane HTTPS from the internet; nothing else',
      allowAllOutbound: true,
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(c.mongoPort), 'MongoDB wire protocol; the engine requires TLS');
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(c.controlPlanePort), 'Control-plane HTTPS');
    // No rule for the engine's admin port: it listens on the Docker bridge of the host only (lib/engine-command.ts),
    // so it is reachable from the server itself and its containers, and from nowhere on the network.

    // ---- Data bucket ------------------------------------------------------------------------------
    // The name is also written into the (compressed) boot script, so it must be known at synth time.
    const bucketName = `${name}-data-${this.account}-${region}`;
    const bucket = new s3.Bucket(this, 'DataBucket', {
      bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          id: 'expire-old-versions',
          noncurrentVersionExpiration: Duration.days(c.retentionDays),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
          expiredObjectDeleteMarker: true,
        },
      ],
      // Customer data: never deleted by a stack delete. README explains how to empty and remove it by hand.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- Engine role: own bucket + own SSM path, nothing else ----------------------------------------
    const paramArn = (path: string) => this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: path.replace(/^\//, '') });
    const prefix = ssmPrefix(c.envName);
    const role = new iam.Role(this, 'EngineRole', {
      roleName: `${name}-engine-${region}`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'FENVIX engine node',
    });
    role.addToPolicy(
      new iam.PolicyStatement({ sid: 'DataObjects', actions: BUCKET_OBJECT_ACTIONS, resources: [bucket.arnForObjects('*')] }),
    );
    role.addToPolicy(new iam.PolicyStatement({ sid: 'DataBucket', actions: BUCKET_LIST_ACTIONS, resources: [bucket.bucketArn] }));
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadOwnConfig',
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
        resources: [paramArn(prefix), paramArn(`${prefix}/*`)],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DecryptSecureStringsViaSsmOnly',
        actions: ['kms:Decrypt'],
        resources: [this.formatArn({ service: 'kms', resource: 'key', resourceName: '*' })],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${region}.amazonaws.com` } },
      }),
    );
    // Session Manager (replaces SSH). These APIs do not support resource-level permissions.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SessionManager',
        actions: [
          'ssm:UpdateInstanceInformation',
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel',
          'ec2messages:AcknowledgeMessage',
          'ec2messages:DeleteMessage',
          'ec2messages:FailMessage',
          'ec2messages:GetEndpoint',
          'ec2messages:GetMessages',
          'ec2messages:SendReply',
        ],
        resources: ['*'],
      }),
    );

    // Bucket policy: only the engine role (plus the account root and any named admins) may touch data.
    const allowed = [role.roleArn, new iam.AccountRootPrincipal().arn, ...(props.bucketAdminPrincipalArns ?? [])];
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'EngineRoleOnly',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ArnPrincipal(role.roleArn)],
        actions: [...BUCKET_OBJECT_ACTIONS, ...BUCKET_LIST_ACTIONS],
        resources: [bucket.bucketArn, bucket.arnForObjects('*')],
      }),
    );
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyEveryoneElse',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: BUCKET_DENY_ACTIONS,
        resources: [bucket.bucketArn, bucket.arnForObjects('*')],
        conditions: { ArnNotEquals: { 'aws:PrincipalArn': allowed } },
      }),
    );

    // ---- DNS zone, certificate store and the DNS-01 permission ----------------------------------------------
    // Database hosts are <name>-<workspace>.<region>.db.<domain>: two labels before "db", which *.db.<domain> does not
    // cover. Each region's server gets a Let's Encrypt certificate for *.<region>.db.<domain> (and, where the control
    // plane runs, console.<domain>) with certbot and a DNS-01 challenge in this zone (lib/acme.ts, lib/scripts/).
    const zone: route53.IHostedZone = c.hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: c.hostedZoneId, zoneName: zoneName(c) })
      : new route53.PublicHostedZone(this, 'Zone', { zoneName: zoneName(c) });
    const dbWildcard = `*.${region}.db.${c.baseDomain}`;

    // Certificate and key kept off the server, so a replaced server does not request a new one each time (Let's
    // Encrypt: 5 identical certificates a week). The stack only creates the secret with an empty JSON object; the
    // server writes the certificate. Only the engine role can read or write it (and the account's administrators).
    const tlsStore = new secretsmanager.Secret(this, 'TlsStore', {
      // Named fenvix-* so the deploy role's Secrets Manager permissions can be limited to fenvix-* secrets.
      secretName: `${name}-tls-${region}`,
      description: `FENVIX ${c.envName} ${region}: Let's Encrypt certificate and key of the engine node (written by the server)`,
      secretStringValue: SecretValue.unsafePlainText('{}'),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'TlsStoreReadWrite',
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
        resources: [tlsStore.secretArn],
      }),
    );
    // DNS-01: TXT records with the challenge names of this region only, in this zone only. The A records, other
    // names, other types and other zones stay out of reach. GetChange (waiting for Route 53 to publish) is addressed
    // by change id, which is not known in advance.
    const challengeNames = challengeRecords(c, region, props.createDns).map((r) => r.record);
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AcmeDnsChallengeTxtOnly',
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [zone.hostedZoneArn],
        conditions: {
          'ForAllValues:StringEquals': {
            'route53:ChangeResourceRecordSetsNormalizedRecordNames': challengeNames,
            'route53:ChangeResourceRecordSetsRecordTypes': ['TXT'],
            'route53:ChangeResourceRecordSetsActions': ['UPSERT', 'DELETE'],
          },
          // ForAllValues is also true for a request without the key: require it to be there.
          Null: { 'route53:ChangeResourceRecordSetsNormalizedRecordNames': 'false' },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AcmeDnsWait',
        actions: ['route53:GetChange'],
        resources: [this.formatArn({ service: 'route53', region: '', account: '', resource: 'change', resourceName: '*' })],
      }),
    );

    // ---- Engine node -------------------------------------------------------------------------------
    const instanceType = new ec2.InstanceType(c.instanceType);
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      ...buildUserData({
        config: c,
        region,
        bucketName,
        requiredParameters: requiredSecretNames(c.envName),
        tlsSecretArn: tlsStore.secretArn,
        hostedZoneId: zone.hostedZoneId,
        runControlPlane: props.createDns,
      }),
    );
    const instance = new ec2.Instance(this, 'EngineInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType,
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: instanceType.architecture === ec2.InstanceArchitecture.ARM_64 ? ec2.AmazonLinuxCpuType.ARM_64 : ec2.AmazonLinuxCpuType.X86_64,
      }),
      role,
      securityGroup: sg,
      userData,
      userDataCausesReplacement: true,
      httpTokens: ec2.HttpTokens.REQUIRED,
      // One hop: the engine and the boot scripts on the host can reach the instance role (data bucket, SSM secrets,
      // certificate store and DNS-01 records); a container behind a Docker bridge cannot (one more hop). The control plane and the TLS
      // terminator need no AWS access (their secrets arrive in an env file), so a break-in there gets no AWS credentials.
      httpPutResponseHopLimit: 1,
      detailedMonitoring: true,
      associatePublicIpAddress: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(c.volumeGb, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true, deleteOnTermination: true }),
        },
      ],
    });

    const eip = new ec2.CfnEIP(this, 'EngineIp', { domain: 'vpc', instanceId: instance.instanceId });

    // Automatic recovery from host failure (the services themselves restart via systemd Restart=always).
    new cloudwatch.Alarm(this, 'RecoverAlarm', {
      alarmName: `${name}-recover-${region}`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName: 'StatusCheckFailed_System',
        dimensionsMap: { InstanceId: instance.instanceId },
        statistic: 'Maximum',
        period: Duration.minutes(1),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cw_actions.Ec2Action(cw_actions.Ec2InstanceAction.RECOVER));

    const target = route53.RecordTarget.fromValues(eip.ref);
    new route53.ARecord(this, 'DbWildcard', { zone, recordName: dbWildcard, target });
    // With dnsZone=db, console.<domain> is not in the Route 53 zone: it is made by hand at the domain's DNS (outputs below).
    if (props.createDns && c.dnsZone === 'domain') new route53.ARecord(this, 'Console', { zone, recordName: consoleHost(c), target });

    // ---- Cost guard -------------------------------------------------------------------------------
    const budgetName = `${name}-${region}`;
    const budget = new budgets.CfnBudget(this, 'Budget', {
      budget: {
        budgetName,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: c.budgetAmountUsd, unit: 'USD' },
        // Region filter, not a tag filter: a tag filter reads zero until the tag is activated as a cost allocation tag.
        costFilters: { Region: [region] },
      },
      notificationsWithSubscribers: [50, 80, 100].map((threshold) => ({
        notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
        subscribers: [{ subscriptionType: 'EMAIL', address: c.budgetEmail }],
      })),
    });

    const actionRole = new iam.Role(this, 'BudgetActionRole', {
      roleName: `${name}-budget-stop-${region}`,
      assumedBy: new iam.ServicePrincipal('budgets.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
      description: 'Lets AWS Budgets stop the FENVIX engine instance at 100% of budget',
    });
    actionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:StopInstances'],
        resources: [this.formatArn({ service: 'ec2', resource: 'instance', resourceName: instance.instanceId })],
      }),
    );
    actionRole.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeInstanceStatus'], resources: ['*'] }));
    actionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:StartAutomationExecution'],
        resources: [this.formatArn({ service: 'ssm', resource: 'automation-definition', resourceName: 'AWS-StopEC2Instance:*' })],
      }),
    );
    const stopAction = new budgets.CfnBudgetsAction(this, 'StopEngineAt100', {
      budgetName,
      actionType: 'RUN_SSM_DOCUMENTS',
      actionThreshold: { type: 'PERCENTAGE', value: 100 },
      notificationType: 'ACTUAL',
      approvalModel: 'AUTOMATIC',
      executionRoleArn: actionRole.roleArn,
      subscribers: [{ type: 'EMAIL', address: c.budgetEmail }],
      definition: { ssmActionDefinition: { subtype: 'STOP_EC2_INSTANCES', region, instanceIds: [instance.instanceId] } },
    });
    stopAction.node.addDependency(budget, actionRole);

    // ---- Outputs ----------------------------------------------------------------------------------
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'InstanceId', { value: instance.instanceId, description: 'Connect with: aws ssm start-session --target <id>' });
    new CfnOutput(this, 'PublicIp', { value: eip.ref });
    new CfnOutput(this, 'SecretsPath', { value: `${prefix}/`, description: 'Create the SecureString parameters under this path (README.md)' });
    new CfnOutput(this, 'DatabaseHosts', { value: dbWildcard, description: 'Database hostnames of this region' });
    new CfnOutput(this, 'TlsSecret', { value: tlsStore.secretArn, description: "Where the server keeps its Let's Encrypt certificate" });
    if (props.createDns) new CfnOutput(this, 'ControlPlaneUrl', { value: `https://${consoleHost(c)}/v1` });
    if (props.createDns && c.dnsZone === 'db') {
      new CfnOutput(this, 'ConsoleRecordToCreate', {
        value: Fn.join('', [`${consoleHost(c)} A `, eip.ref]),
        description: 'Create this record by hand where your domain DNS is (README.md, "The domain and DNS"); DNS only, not proxied',
      });
      new CfnOutput(this, 'ConsoleChallengeRecordToCreate', {
        value: `_acme-challenge.${consoleHost(c)} CNAME ${consoleChallengeTarget(c)}`,
        description: 'Create this record by hand where your domain DNS is (README.md, "The domain and DNS"); DNS only, not proxied',
      });
    }
    if (!c.hostedZoneId && zone instanceof route53.PublicHostedZone && zone.hostedZoneNameServers) {
      new CfnOutput(this, 'NameServers', {
        value: Fn.join(', ', zone.hostedZoneNameServers),
        description: `NS records for ${zoneName(c)} at your domain DNS (README.md, "The domain and DNS")`,
      });
    }
  }
}
