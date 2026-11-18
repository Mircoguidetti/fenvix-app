import type { Stack } from "aws-cdk-lib";
import { NagSuppressions } from "cdk-nag";

/** cdk-nag (AwsSolutions) findings that do not apply, each with its reason. Everything else must pass. */
export function applySuppressions(stack: Stack): void {
  NagSuppressions.addStackSuppressions(stack, [
    { id: "AwsSolutions-APIG4", reason: "Authorization is in the function, per route: GitHub's HMAC signature on /webhooks/github, the runner bearer token on /v1/runner/summaries, a Supabase session (JWKS) on the dashboard routes, a signed state plus GitHub OAuth on /github/setup. API Gateway cannot check an HMAC over the body." },
    { id: "AwsSolutions-L1", reason: "Node.js 22 is the version the service is written and tested for (engines >=22.18, type stripping); it is a supported Lambda runtime. Move to the next LTS together with the service's tests." },
    { id: "AwsSolutions-S1", reason: "The overflow bucket holds only transient work payloads (deleted after use, expired after 5 days), written and read by two functions; CloudTrail covers the account. Access logs would cost more than the data." },
    { id: "AwsSolutions-VPC7", reason: "The VPC holds one runner machine with no inbound rule and outbound 80/443 only; flow logs would add CloudWatch cost for no decision we take on them at this size." },
    { id: "AwsSolutions-EC28", reason: "Basic (5-minute) EC2 monitoring is enough for one CI runner; detailed monitoring is billed per metric." },
    { id: "AwsSolutions-EC29", reason: "One replaceable CI runner, not in an ASG: termination protection would block replacing it on an AMI change and deleting the stack. Nothing on it is unique (it re-registers with a fresh token)." },
    { id: "AwsSolutions-IAM4", reason: "AmazonSSMManagedInstanceCore on the runner machine is the AWS-maintained policy for Session Manager (no SSH, no inbound port).", appliesTo: ["Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore"] },
    {
      id: "AwsSolutions-IAM5",
      reason: "Log streams are created per Lambda container under the function's own log group (`<group arn>:*`), and overflow objects have random keys under work/ in our own bucket. Each is scoped to one resource of this stack.",
      appliesTo: [
        "Resource::<HttpLogs2035DA0F.Arn>:*", "Resource::<WorkerLogsC1193B08.Arn>:*", "Resource::<SweepLogsD6C54147.Arn>:*",
        "Resource::<Overflow8C2F862D.Arn>/work/*",
      ],
    },
  ]);
}
