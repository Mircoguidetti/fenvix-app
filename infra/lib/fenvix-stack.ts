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
import { challengeRecords, apiChallengeTarget, zoneName } from './acme';
import { ARTIFACT_PREFIXES, Arch, artifactPins } from './artifacts';
import { FenvixConfig, PROJECT_TAG } from './config';
import { apiHost } from './control-plane-env';
import { requiredSecretNames, ssmPrefix } from './parameters';
import { buildUserData } from './user-data';

export { requiredSecretNames };

export interface FenvixStackProps extends StackProps {
  config: FenvixConfig;
  /** Region this stack deploys to (also in props.env). */
  region: string;
  /**
   * The first region of the list: it creates the hosted zone (unless hostedZoneId is given), the api.<domain> record, and
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

/** Issuer of GitHub Actions OIDC tokens. */
export const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

/** The `sub` claim GitHub puts in the token of a workflow run on a branch (default claim format). */
export function publishSubjects(repo: string, branches: string[], ids?: { ownerId?: string; repoId?: string }): string[] {
  const byName = branches.map((b) => `repo:${repo}:ref:refs/heads/${b}`);
  if (!ids?.ownerId || !ids.repoId) return byName;
  // GitHub also writes the numeric ids into the claim: repo:<owner>@<ownerId>/<name>@<repoId>:ref:...
  const [owner, name] = repo.split('/');
  return [...byName, ...branches.map((b) => `repo:${owner}@${ids.ownerId}/${name}@${ids.repoId}:ref:refs/heads/${b}`)];
}

const instanceType_ = (c: FenvixConfig) => new ec2.InstanceType(c.instanceType);

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

    // ---- Release artifacts: private bucket, read by the instance, written by GitHub Actions (OIDC) -----------
    // One bucket for every region, in the first region's stack (lib/artifacts.ts). CloudFormation picks its name (stack
    // name + random suffix), so it cannot be guessed; the server gets it through the user-data header.
    const arch: Arch = instanceType_(c).architecture === ec2.InstanceArchitecture.ARM_64 ? 'aarch64' : 'x86_64';
    const engineRolePattern = this.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: `${name}-engine-*` });
    let artifactsBucketName: string;
    let artifactsBucketArn: string;
    if (props.createDns) {
      const artifacts = new s3.Bucket(this, 'ArtifactsBucket', {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        versioned: true,
        lifecycleRules: [
          {
            // Every version stays under its own key (needed to go back); only overwritten or deleted copies expire.
            id: 'expire-replaced-copies',
            noncurrentVersionExpiration: Duration.days(30),
            abortIncompleteMultipartUploadAfter: Duration.days(1),
            expiredObjectDeleteMarker: true,
          },
        ],
        // Kept by a stack delete: the running server and a rollback need these files.
        removalPolicy: RemovalPolicy.RETAIN,
      });
      artifactsBucketName = artifacts.bucketName;
      artifactsBucketArn = artifacts.bucketArn;

      // GitHub's OIDC provider (one per account): the publish roles trust tokens it signs for the named repositories.
      const providerArn =
        c.githubOidcProviderArn ??
        new iam.CfnOIDCProvider(this, 'GithubOidc', {
          url: `https://${GITHUB_OIDC_HOST}`,
          clientIdList: ['sts.amazonaws.com'],
          // Not used by AWS for GitHub (it trusts GitHub's certificate authority), still accepted as GitHub's published values.
          thumbprintList: ['6938fd4d98bab03faadb97b34396831e3780aea1', '1c58a3a8518e8759bf075b76b750d4f2df264fcd'],
        }).attrArn;

      // One role per repository, one prefix per role, PutObject only: no read, no list, no delete, no other prefix.
      const publishers: { id: string; roleName: string; repo: string; repoId?: string; branches: string[]; prefix: string }[] = [
        { id: 'PublishEngineRole', roleName: `${name}-publish-engine`, repo: c.engineRepo, repoId: c.engineRepoId, branches: c.engineRepoBranches, prefix: ARTIFACT_PREFIXES.engine },
        { id: 'PublishControlPlaneRole', roleName: `${name}-publish-control-plane`, repo: c.controlPlaneRepo, repoId: c.controlPlaneRepoId, branches: c.controlPlaneRepoBranches, prefix: ARTIFACT_PREFIXES.controlPlane },
      ];
      const publishRoles = publishers.map((pub) => {
        const r = new iam.Role(this, pub.id, {
          roleName: pub.roleName,
          description: `GitHub Actions of ${pub.repo} (${pub.branches.join(', ')}): write ${pub.prefix} in the artifacts bucket`,
          maxSessionDuration: Duration.hours(1),
          assumedBy: new iam.FederatedPrincipal(
            providerArn,
            {
              StringEquals: {
                [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
                // Exact subjects only (no wildcard): this repository, a run on one of these branches.
                [`${GITHUB_OIDC_HOST}:sub`]: publishSubjects(pub.repo, pub.branches, { ownerId: c.githubOwnerId, repoId: pub.repoId }),
              },
            },
            'sts:AssumeRoleWithWebIdentity',
          ),
        });
        r.addToPolicy(
          new iam.PolicyStatement({ sid: 'WriteOwnPrefixOnly', actions: ['s3:PutObject'], resources: [`${artifacts.bucketArn}/${pub.prefix}*`] }),
        );
        return { ...pub, role: r };
      });

      // Bucket policy, on top of the roles' own policies: whatever else gets attached to a role later, reads are for the
      // engine roles of this env and writes for the publisher of that prefix (plus the account root, for recovery).
      const root = new iam.AccountRootPrincipal().arn;
      artifacts.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'ReadOnlyByEngineRoles',
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:GetObjectAttributes', 's3:ListBucket', 's3:ListBucketVersions'],
          resources: [artifacts.bucketArn, artifacts.arnForObjects('*')],
          conditions: { ArnNotLike: { 'aws:PrincipalArn': [engineRolePattern, root] } },
        }),
      );
      for (const pub of publishRoles) {
        artifacts.addToResourcePolicy(
          new iam.PolicyStatement({
            sid: `WritesTo${pub.id.replace(/Role$/, '')}PrefixByItsPublisherOnly`,
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'],
            resources: [artifacts.arnForObjects(`${pub.prefix}*`)],
            conditions: { ArnNotEquals: { 'aws:PrincipalArn': [pub.role.roleArn, root] } },
          }),
        );
      }
      artifacts.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'OtherWritesByRootOnly',
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'],
          notResources: publishRoles.map((pub) => artifacts.arnForObjects(`${pub.prefix}*`)),
          conditions: { ArnNotEquals: { 'aws:PrincipalArn': root } },
        }),
      );

      new CfnOutput(this, 'ArtifactsBucketName', { value: artifacts.bucketName, description: 'GitHub secret ARTIFACTS_BUCKET of both repositories (docs/deploy-checklist.md)' });
      for (const pub of publishRoles) {
        new CfnOutput(this, `${pub.id}Arn`, { value: pub.role.roleArn, description: `GitHub secret AWS_PUBLISH_ROLE_ARN of ${pub.repo}` });
      }
    } else {
      artifactsBucketName = c.artifactsBucket!;
      artifactsBucketArn = `arn:${this.partition}:s3:::${c.artifactsBucket}`;
    }
    // The server reads the two prefixes it installs from, nothing else: no list, no write, no delete.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadReleaseArtifacts',
        actions: ['s3:GetObject'],
        resources: [`${artifactsBucketArn}/${ARTIFACT_PREFIXES.engine}*`, `${artifactsBucketArn}/${ARTIFACT_PREFIXES.controlPlane}*`],
      }),
    );

    // ---- DNS zone, certificate store and the DNS-01 permission ----------------------------------------------
    // Database hosts are <name>-<workspace>.<region>.db.<domain>: two labels before "db", which *.db.<domain> does not
    // cover. Each region's server gets a Let's Encrypt certificate for *.<region>.db.<domain> (and, where the control
    // plane runs, api.<domain>) with certbot and a DNS-01 challenge in this zone (lib/acme.ts, lib/scripts/).
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
    const instanceType = instanceType_(c);
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
        artifactsBucket: artifactsBucketName,
        artifactsRegion: c.regions[0],
        arch,
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
    // With dnsZone=db, api.<domain> is not in the Route 53 zone: it is made by hand at the domain's DNS (outputs below).
    if (props.createDns && c.dnsZone === 'domain') new route53.ARecord(this, 'Api', { zone, recordName: apiHost(c), target });

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
    if (props.createDns) new CfnOutput(this, 'ControlPlaneUrl', { value: `https://${apiHost(c)}/v1` });
    // The release pins, readable with cloudformation:DescribeStacks. The versions themselves live only inside the
    // compressed user data, so without these outputs nothing outside the shell that ran the deploy can tell which
    // engine and which control plane a running stack is pinned to. The deploy workflow
    // (.github/workflows/deploy-control-plane.yml) reads them to keep the engine exactly as it is and to print the
    // previous control-plane version for a rollback. No cost: an output is part of the stack description.
    const pinsOut = artifactPins(c);
    if (pinsOut) {
      new CfnOutput(this, 'EngineVersion', { value: pinsOut.engineVersion, description: 'Engine release pinned in this stack (stack setting engineVersion)' });
      new CfnOutput(this, 'EngineSha256', { value: pinsOut.engineSha256, description: 'SHA-256 the server checks for that engine (stack setting engineSha256)' });
      new CfnOutput(this, 'ControlPlaneVersion', { value: pinsOut.controlPlaneVersion, description: 'Control-plane release pinned in this stack (stack setting controlPlaneVersion)' });
      new CfnOutput(this, 'ControlPlaneSha256', { value: pinsOut.controlPlaneSha256, description: 'SHA-256 the server checks for that control-plane image (stack setting controlPlaneSha256)' });
    }
    if (props.createDns && c.dnsZone === 'db') {
      new CfnOutput(this, 'ApiRecordToCreate', {
        value: Fn.join('', [`${apiHost(c)} A `, eip.ref]),
        description: 'Create this record by hand where your domain DNS is (README.md, "The domain and DNS"); DNS only, not proxied',
      });
      new CfnOutput(this, 'ApiChallengeRecordToCreate', {
        value: `_acme-challenge.${apiHost(c)} CNAME ${apiChallengeTarget(c)}`,
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
