import { Stack } from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';

/**
 * Accepted cdk-nag (AwsSolutions) findings, each with the reason. Mirrored in results-infra.md.
 * Everything not listed here fails test/nag.test.ts.
 */
export function applySuppressions(stack: Stack): void {
  const child = (id: string) => stack.node.findChild(id);
  // Only in the first region's stack (the artifacts bucket and its publish roles).
  const maybe = (id: string) => stack.node.tryFindChild(id);

  NagSuppressions.addResourceSuppressions(child('Vpc'), [
    {
      id: 'AwsSolutions-VPC7',
      reason:
        'Flow logs not enabled: one public subnet with one instance; REJECT/ALL logs of an internet-facing MongoDB port are mostly scanner noise and CloudWatch cost. Revisit once there is a security-monitoring need.',
    },
  ], true);

  NagSuppressions.addResourceSuppressions(child('EngineSg'), [
    {
      id: 'AwsSolutions-EC23',
      reason:
        'By design: customers connect to the MongoDB port (27018) from anywhere (the engine requires TLS) and to the control-plane HTTPS port. The engine admin port is in no rule at all and listens on the Docker bridge only (asserted in test/infra.test.ts).',
    },
  ], true);

  NagSuppressions.addResourceSuppressions(child('DataBucket'), [
    {
      id: 'AwsSolutions-S1',
      reason:
        'Server access logging not enabled: it needs a second bucket (which would itself raise S1). Access is limited to one role by bucket policy; use CloudTrail data events if object-level audit is required.',
    },
  ], true);

  NagSuppressions.addResourceSuppressions(child('EngineInstance'), [
    {
      id: 'AwsSolutions-EC29',
      reason:
        'Termination protection would make CloudFormation unable to replace the instance on a user-data change and would block teardown. The node is stateless (all data is in S3) and recoverable.',
    },
  ], true);

  NagSuppressions.addResourceSuppressions(child('EngineRole'), [
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'Object-level S3 access needs <bucket>/*; the release artifacts are read (GetObject only) under their two prefixes engine/* and control-plane/*, whose keys carry a version not known when the role is made; SSM read is the /fenvix/<env>/* path; kms:Decrypt is limited by kms:ViaService to SSM (key id of the AWS-managed aws/ssm key is not known at synth); Session Manager APIs do not support resource-level permissions; route53:GetChange is addressed by a change id only known after the change (change/*), and it only reads the status of a change.',
      appliesTo: [
        'Resource::arn:<AWS::Partition>:route53:::change/*',
        { regex: '/^Resource::<DataBucket.*\\.Arn>/\\*$/' },
        // Release artifacts: read-only, two prefixes (in the first region the bucket is a reference, elsewhere its name).
        { regex: '/^Resource::<ArtifactsBucket.*\\.Arn>/(engine|control-plane)/\\*$/' },
        { regex: '/^Resource::arn:<AWS::Partition>:s3:::fenvix-[a-z0-9.-]+/(engine|control-plane)/\\*$/' },
        { regex: '/^Resource::arn:<AWS::Partition>:ssm:[a-z0-9-]+:\\d+:parameter/fenvix/[a-z0-9-]+/\\*$/' },
        { regex: '/^Resource::arn:<AWS::Partition>:kms:[a-z0-9-]+:\\d+:key/\\*$/' },
        'Resource::*',
      ],
    },
  ], true);

  NagSuppressions.addResourceSuppressions(child('TlsStore'), [
    {
      id: 'AwsSolutions-SMG4',
      reason:
        "Holds the Let's Encrypt certificate and key; it is rewritten by the server at every renewal (about every 60 days), so a Secrets Manager rotation Lambda has nothing to do.",
    },
  ], true);

  NagSuppressions.addResourceSuppressions(child('BudgetActionRole'), [
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'ec2:DescribeInstanceStatus has no resource-level permissions; the SSM automation document is addressed by name with any version (:*). Stopping is limited to the single engine instance ARN.',
      appliesTo: ['Resource::*', { regex: '/^Resource::arn:<AWS::Partition>:ssm:[a-z0-9-]+:\\d+:automation-definition/AWS-StopEC2Instance:\\*$/' }],
    },
  ], true);

  const artifacts = maybe('ArtifactsBucket');
  if (artifacts) {
    NagSuppressions.addResourceSuppressions(artifacts, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'Server access logging not enabled: it needs a second bucket (which would itself raise S1). Release files only (no customer data); reads are limited to the engine roles and writes to one publisher per prefix by bucket policy, and the server checks each file against a SHA-256 from the stack settings.',
      },
    ], true);
  }
  for (const [id, prefix] of [['PublishEngineRole', 'engine'], ['PublishControlPlaneRole', 'control-plane']] as const) {
    const r = maybe(id);
    if (!r) continue;
    NagSuppressions.addResourceSuppressions(r, [
      {
        id: 'AwsSolutions-IAM5',
        reason: `s3:PutObject only, under the ${prefix}/ prefix of the artifacts bucket: a new release is a new key (version in the name), so the key cannot be listed in advance. No read, list or delete.`,
        appliesTo: [{ regex: `/^Resource::<ArtifactsBucket.*\\.Arn>/${prefix}/\\*$/` }],
      },
    ], true);
  }
}
