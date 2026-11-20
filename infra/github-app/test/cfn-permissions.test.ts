// CloudFormation creates, tags, updates, reads and deletes every resource of both stacks with one role
// (cdk-fenvix-cfn-exec-role, the four cfn-exec-policy-*.json). Its first real deploy failed because CloudFormation
// could create a CloudFront function but not tag it (cloudfront:TagResource; CDK tags every resource: project, env,
// component). This test walks every synthesized template and, for every resource type in it, checks the policies
// against the IAM actions CloudFormation's own resource handlers call (test/cfn-handler-permissions.json, from the
// resource-provider schemas cfn-lint ships; scripts/cfn-handler-permissions.py), so that this class of failure is
// found here and not in a deploy:
//   - the create action and the tag actions of every taggable type, on that resource's own ARN (as named in prod);
//   - every other action of the create, update, delete and read handlers, and of tagging, unless it is listed in
//     NOT_NEEDED below with the reason (a feature the stacks do not use), or IAM does not know it as an action.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { FenvixDashboardStack } from "../lib/dashboard.ts";
import { synthesizer } from "../lib/synthesizer.ts";
import { DEMO, NO_APP, PER_JOB, settings, synth } from "./helpers.ts";

type Stmt = { Sid?: string; Effect: "Allow" | "Deny"; Action: string | string[]; Resource: string | string[]; Condition?: Record<string, Record<string, unknown>> };
type Perms = { create: string[]; update: string[]; delete: string[]; read: string[]; tagging: string[]; taggable: boolean; tagOnCreate: boolean; notIamActions: string[] };

const arr = <T>(x: T | T[]) => (Array.isArray(x) ? x : [x]);
const A = "865859654353";
const R = "eu-west-1";
const EXEC = ["app", "edge", "fleet", "dashboard"].flatMap((x) => (JSON.parse(readFileSync(new URL(`../cfn-exec-policy-${x}.json`, import.meta.url), "utf8")) as { Statement: Stmt[] }).Statement);
const FIX = JSON.parse(readFileSync(new URL("./cfn-handler-permissions.json", import.meta.url), "utf8")) as { source: string; types: Record<string, Perms> };
const CERT = `arn:aws:acm:us-east-1:${A}:certificate/12345678-1234-1234-1234-123456789012`;

const glob = (pattern: string, value: string, caseless = false) => {
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, caseless ? "i" : "");
  return re.test(value);
};

/** Whether a statement's condition holds for CloudFormation acting in this stack's region (keys it sets itself). */
function conditionHolds(c: Stmt["Condition"]): boolean {
  if (!c) return true;
  const region = JSON.stringify(c).match(/"aws:RequestedRegion":"([a-z0-9-]+)"/)?.[1];
  return !region || region === R;
}

/** Allowed by the execution policies? With an ARN: on that resource; without: on some resource. */
export function allowed(action: string, arn?: string): boolean {
  const matches = (s: Stmt) => arr(s.Action).some((a) => glob(a, action, true)) && (arn === undefined || arr(s.Resource).some((r) => glob(r, arn)));
  // A Deny with a condition (instance sizes, managed policies) narrows a case; an unconditional one removes the action.
  if (EXEC.some((s) => s.Effect === "Deny" && !s.Condition && matches(s))) return false;
  return EXEC.some((s) => s.Effect === "Allow" && conditionHolds(s.Condition) && matches(s));
}

/** Each resource as it is named in prod (the stacks' names: fenvix-prod-github-app-*, fenvix-prod-dashboard-*). */
const ARN: Record<string, string> = {
  "AWS::ApiGatewayV2::Api": `arn:aws:apigateway:${R}::/apis/a1b2c3`,
  "AWS::ApiGatewayV2::ApiMapping": `arn:aws:apigateway:${R}::/domainnames/api.fenvix.dev/apimappings/m1`,
  "AWS::ApiGatewayV2::DomainName": `arn:aws:apigateway:${R}::/domainnames/api.fenvix.dev`,
  "AWS::ApiGatewayV2::Integration": `arn:aws:apigateway:${R}::/apis/a1b2c3/integrations/i1`,
  "AWS::ApiGatewayV2::Route": `arn:aws:apigateway:${R}::/apis/a1b2c3/routes/r1`,
  "AWS::ApiGatewayV2::Stage": `arn:aws:apigateway:${R}::/apis/a1b2c3/stages/$default`,
  "AWS::CertificateManager::Certificate": `arn:aws:acm:${R}:${A}:certificate/12345678-1234-1234-1234-123456789012`,
  "AWS::CloudFront::Distribution": `arn:aws:cloudfront::${A}:distribution/E1ABCDEF`,
  "AWS::CloudFront::Function": `arn:aws:cloudfront::${A}:function/fenvix-prod-dashboard-spa`,
  "AWS::CloudFront::OriginAccessControl": `arn:aws:cloudfront::${A}:origin-access-control/E2ABCDEF`,
  "AWS::CloudWatch::Alarm": `arn:aws:cloudwatch:${R}:${A}:alarm:fenvix-prod-github-app-dead-letters`,
  "AWS::EC2::Instance": `arn:aws:ec2:${R}:${A}:instance/i-0123456789abcdef0`,
  "AWS::EC2::InternetGateway": `arn:aws:ec2:${R}:${A}:internet-gateway/igw-0123`,
  "AWS::EC2::LaunchTemplate": `arn:aws:ec2:${R}:${A}:launch-template/lt-0123`,
  "AWS::EC2::Route": `arn:aws:ec2:${R}:${A}:route-table/rtb-0123`,
  "AWS::EC2::RouteTable": `arn:aws:ec2:${R}:${A}:route-table/rtb-0123`,
  "AWS::EC2::SecurityGroup": `arn:aws:ec2:${R}:${A}:security-group/sg-0123`,
  "AWS::EC2::SecurityGroupEgress": `arn:aws:ec2:${R}:${A}:security-group/sg-0123`,
  "AWS::EC2::SecurityGroupIngress": `arn:aws:ec2:${R}:${A}:security-group/sg-0123`,
  "AWS::EC2::Subnet": `arn:aws:ec2:${R}:${A}:subnet/subnet-0123`,
  "AWS::EC2::SubnetRouteTableAssociation": `arn:aws:ec2:${R}:${A}:route-table/rtb-0123`,
  "AWS::EC2::VPC": `arn:aws:ec2:${R}:${A}:vpc/vpc-0123`,
  "AWS::EC2::VPCGatewayAttachment": `arn:aws:ec2:${R}:${A}:vpc/vpc-0123`,
  "AWS::IAM::InstanceProfile": `arn:aws:iam::${A}:instance-profile/fenvix-prod-github-app-RunnerProfile-ABC`,
  "AWS::IAM::Policy": `arn:aws:iam::${A}:role/fenvix-prod-github-app-HttpRole-ABC`,
  "AWS::IAM::Role": `arn:aws:iam::${A}:role/fenvix-prod-github-app-HttpRole-ABC`,
  "AWS::ImageBuilder::Component": `arn:aws:imagebuilder:${R}:${A}:component/fenvix-prod-runner/1.0.0/1`,
  "AWS::ImageBuilder::DistributionConfiguration": `arn:aws:imagebuilder:${R}:${A}:distribution-configuration/fenvix-prod-runner`,
  "AWS::ImageBuilder::ImagePipeline": `arn:aws:imagebuilder:${R}:${A}:image-pipeline/fenvix-prod-runner`,
  "AWS::ImageBuilder::ImageRecipe": `arn:aws:imagebuilder:${R}:${A}:image-recipe/fenvix-prod-runner/1.0.0`,
  "AWS::ImageBuilder::InfrastructureConfiguration": `arn:aws:imagebuilder:${R}:${A}:infrastructure-configuration/fenvix-prod-runner-build`,
  "AWS::Lambda::EventSourceMapping": `arn:aws:lambda:${R}:${A}:event-source-mapping:12345678-1234-1234-1234-123456789012`,
  "AWS::Lambda::Function": `arn:aws:lambda:${R}:${A}:function:fenvix-prod-github-app-http`,
  "AWS::Lambda::Permission": `arn:aws:lambda:${R}:${A}:function:fenvix-prod-github-app-http`,
  "AWS::Logs::LogGroup": `arn:aws:logs:${R}:${A}:log-group:/aws/lambda/fenvix-prod-github-app-http`,
  "app AWS::S3::Bucket": `arn:aws:s3:::fenvix-prod-github-app-overflowabc-1a2b3c`,
  "app AWS::S3::BucketPolicy": `arn:aws:s3:::fenvix-prod-github-app-overflowabc-1a2b3c`,
  "dashboard AWS::S3::Bucket": `arn:aws:s3:::fenvix-prod-dashboard-${A}`,
  "dashboard AWS::S3::BucketPolicy": `arn:aws:s3:::fenvix-prod-dashboard-${A}`,
  "AWS::SNS::Subscription": `arn:aws:sns:${R}:${A}:fenvix-prod-github-app-alerts`,
  "AWS::SNS::Topic": `arn:aws:sns:${R}:${A}:fenvix-prod-github-app-alerts`,
  "AWS::SNS::TopicPolicy": `arn:aws:sns:${R}:${A}:fenvix-prod-github-app-alerts`,
  "AWS::SQS::Queue": `arn:aws:sqs:${R}:${A}:fenvix-prod-github-app-work`,
  "AWS::SQS::QueuePolicy": `arn:aws:sqs:${R}:${A}:fenvix-prod-github-app-work`,
  "AWS::Scheduler::Schedule": `arn:aws:scheduler:${R}:${A}:schedule/default/fenvix-prod-github-app-sweep`,
};
const arnOf = (stack: string, type: string) => ARN[`${stack} ${type}`] ?? ARN[type];

/** The resource's own create action(s): the API call that makes it. */
const CREATE: Record<string, string[]> = {
  "AWS::ApiGatewayV2::Api": ["apigateway:POST"], "AWS::ApiGatewayV2::ApiMapping": ["apigateway:POST"], "AWS::ApiGatewayV2::DomainName": ["apigateway:POST"],
  "AWS::ApiGatewayV2::Integration": ["apigateway:POST"], "AWS::ApiGatewayV2::Route": ["apigateway:POST"], "AWS::ApiGatewayV2::Stage": ["apigateway:POST"],
  "AWS::CertificateManager::Certificate": ["acm:RequestCertificate"], "AWS::CloudFront::Distribution": ["cloudfront:CreateDistribution"],
  "AWS::CloudFront::Function": ["cloudfront:CreateFunction", "cloudfront:PublishFunction"], "AWS::CloudFront::OriginAccessControl": ["cloudfront:CreateOriginAccessControl"],
  "AWS::CloudWatch::Alarm": ["cloudwatch:PutMetricAlarm"], "AWS::EC2::Instance": ["ec2:RunInstances"], "AWS::EC2::InternetGateway": ["ec2:CreateInternetGateway"],
  "AWS::EC2::LaunchTemplate": ["ec2:CreateLaunchTemplate"], "AWS::EC2::Route": ["ec2:CreateRoute"], "AWS::EC2::RouteTable": ["ec2:CreateRouteTable"],
  "AWS::EC2::SecurityGroup": ["ec2:CreateSecurityGroup"], "AWS::EC2::SecurityGroupEgress": ["ec2:AuthorizeSecurityGroupEgress"],
  "AWS::EC2::SecurityGroupIngress": ["ec2:AuthorizeSecurityGroupIngress"], "AWS::EC2::Subnet": ["ec2:CreateSubnet"],
  "AWS::EC2::SubnetRouteTableAssociation": ["ec2:AssociateRouteTable"], "AWS::EC2::VPC": ["ec2:CreateVpc"], "AWS::EC2::VPCGatewayAttachment": ["ec2:AttachInternetGateway"],
  "AWS::IAM::InstanceProfile": ["iam:CreateInstanceProfile", "iam:AddRoleToInstanceProfile"], "AWS::IAM::Policy": ["iam:PutRolePolicy"], "AWS::IAM::Role": ["iam:CreateRole"],
  "AWS::ImageBuilder::Component": ["imagebuilder:CreateComponent"], "AWS::ImageBuilder::DistributionConfiguration": ["imagebuilder:CreateDistributionConfiguration"],
  "AWS::ImageBuilder::ImagePipeline": ["imagebuilder:CreateImagePipeline"], "AWS::ImageBuilder::ImageRecipe": ["imagebuilder:CreateImageRecipe"],
  "AWS::ImageBuilder::InfrastructureConfiguration": ["imagebuilder:CreateInfrastructureConfiguration"],
  "AWS::Lambda::EventSourceMapping": ["lambda:CreateEventSourceMapping"], "AWS::Lambda::Function": ["lambda:CreateFunction"], "AWS::Lambda::Permission": ["lambda:AddPermission"],
  "AWS::Logs::LogGroup": ["logs:CreateLogGroup"], "AWS::S3::Bucket": ["s3:CreateBucket"], "AWS::S3::BucketPolicy": ["s3:PutBucketPolicy"],
  "AWS::SNS::Subscription": ["sns:Subscribe"], "AWS::SNS::Topic": ["sns:CreateTopic"], "AWS::SNS::TopicPolicy": ["sns:SetTopicAttributes"],
  "AWS::SQS::Queue": ["sqs:CreateQueue"], "AWS::SQS::QueuePolicy": ["sqs:SetQueueAttributes"], "AWS::Scheduler::Schedule": ["scheduler:CreateSchedule"],
};

/**
 * Handler actions the execution role deliberately does not have: each for a property or feature the stacks do not
 * use (the handler calls it only when that property is set). A new property that needs one fails a deploy: move it
 * out of here into the policy then. Keys: a resource type, or "*" for every type.
 */
const NOT_NEEDED: { types: string[]; actions: RegExp; why: string }[] = [
  { types: ["*"], actions: /^kms:/, why: "no customer-managed KMS key: S3, SQS, SNS, logs and Lambda use AWS-owned or AWS-managed keys" },
  { types: ["*"], actions: /^iam:PassRole$/, why: "allowed only to the stack's own roles and services (PassRolesOfThisStackToTheirServices); checked by settings-and-policies" },
  { types: ["AWS::CertificateManager::Certificate"], actions: /^(route53:|acm-pca:)/, why: "validated by a DNS record in Cloudflare (no Route 53 zone), public certificate (no private CA)" },
  { types: ["AWS::CloudFront::Distribution"], actions: /^cloudfront:(CreateConnectionGroup|GetConnectionGroup|GetVpcOrigin|UpdateDistributionWithStagingConfig)$/, why: "no connection group, VPC origin or staging distribution" },
  { types: ["AWS::EC2::Instance"], actions: /^(ssm:(Create|Delete|Describe|List)Association|ssm:ListAssociations|ec2:(AttachVolume|DetachVolume|ModifyInstancePlacement))$/, why: "no SsmAssociations, no attached Volumes, default placement" },
  { types: ["AWS::EC2::VPC"], actions: /^ec2:(CreateVpcEncryptionControl|ModifyVpcTenancy)$/, why: "no VPC encryption control, default tenancy" },
  { types: ["AWS::EC2::Subnet"], actions: /^ec2:(Associate|Disassociate)SubnetCidrBlock$/, why: "IPv4 only, one CIDR" },
  { types: ["AWS::EC2::VPCGatewayAttachment"], actions: /^ec2:(Attach|Detach)VpnGateway$/, why: "an internet gateway, no VPN gateway" },
  { types: ["AWS::IAM::Policy"], actions: /^iam:(Get|Put|Delete)(User|Group)Policy$/, why: "inline policies on the stack's roles only (no IAM user or group)" },
  { types: ["AWS::IAM::Role"], actions: /^iam:(DeleteRolePermissionsBoundary|PutRolePermissionsBoundary)$/, why: "denied on purpose: no role may lose or change the permissions boundary (NeverRemoveTheBoundary)" },
  { types: ["AWS::ImageBuilder::Component"], actions: /^s3:/, why: "the component's document is inline (Data), not an S3 URI" },
  { types: ["AWS::ImageBuilder::DistributionConfiguration"], actions: /^ecr:/, why: "AMI distribution only, no container" },
  { types: ["AWS::ImageBuilder::ImagePipeline"], actions: /^(ecr:|inspector2:|imagebuilder:(GetContainerRecipe|GetWorkflow)$)/, why: "an image recipe (no container recipe), no image scanning, no custom workflow" },
  { types: ["AWS::ImageBuilder::InfrastructureConfiguration"], actions: /^(sns:Publish|autoscaling:)/, why: "no SNS topic for build notifications, no Auto Scaling placement" },
  { types: ["AWS::Lambda::Function"], actions: /^(elasticfilesystem:|s3files:|lambda:(GetCodeSigningConfig|PutFunctionCodeSigningConfig|DeleteFunctionCodeSigningConfig|GetLayerVersion|PutFunctionScalingConfig|PassCapacityProvider|PublishVersion))$|^(elasticfilesystem|s3files):/, why: "no EFS or S3 Files mount, no code signing, no layers, no capacity provider, no published versions (AutoPublishAlias)" },
  { types: ["AWS::Logs::LogGroup"], actions: /^(firehose:|logs:(PutDataProtectionPolicy|DeleteDataProtectionPolicy|PutIndexPolicy|DeleteIndexPolicy|PutBearerTokenAuthentication|AssociateKmsKey|DisassociateKmsKey|PutLogGroupDeletionProtection|DeleteResourcePolicy))$|^firehose:/, why: "no data protection or index policy, no bearer-token ingestion, no KMS key, no deletion protection, no delivery to Firehose" },
  { types: ["AWS::S3::Bucket"], actions: /^(s3tables:|s3:(PutBucketAbac|PutAnalyticsConfiguration|PutBucketCORS|PutInventoryConfiguration|PutMetricsConfiguration|PutBucketNotification|PutBucketWebsite|PutAccelerateConfiguration|PutReplicationConfiguration|PutObjectAcl|PutBucketAcl|PutBucketObjectLockConfiguration|DeleteObject|PutBucketLogging|PutBucketVersioning|PutIntelligentTieringConfiguration|CreateBucketMetadataTableConfiguration|DeleteBucketMetadataTableConfiguration|UpdateBucketMetadata\w+TableConfiguration|DeleteBucketWebsite))$|^s3tables:/, why: "private bucket, no versioning, ACLs, CORS, website, notifications, replication, analytics, inventory, metrics, logging, object lock, intelligent tiering or metadata tables" },
  { types: ["AWS::SNS::Topic"], actions: /^sns:PutDataProtectionPolicy$/, why: "no data protection policy" },
];

/**
 * Names a schema lists that the IAM reference cfn-lint ships does not know (test/cfn-handler-permissions.json,
 * notIamActions). They are NOT skipped on that ground: cfn-lint's list lags AWS (apigateway:TagResource is missing
 * from it, yet the second deploy failed on exactly that action). Each one is either granted (in GRANTED_ANYWAY) or
 * named here with the action(s) IAM authorizes the call as, which must then be allowed. A new name fails the test.
 */
const NOT_AN_IAM_ACTION: Record<string, { as: string[]; why: string }> = {
  "cloudfront:CreateDistributionWithTags": { as: ["cloudfront:CreateDistribution", "cloudfront:TagResource"], why: "IAM authorizes CreateDistributionWithTags as CreateDistribution plus TagResource" },
  "s3:DeleteBucketTagging": { as: ["s3:PutBucketTagging"], why: "authorized as PutBucketTagging" },
  "s3:DeleteBucketEncryption": { as: ["s3:PutEncryptionConfiguration"], why: "authorized as PutEncryptionConfiguration" },
  "s3:DeleteBucketLifecycle": { as: ["s3:PutLifecycleConfiguration"], why: "authorized as PutLifecycleConfiguration" },
  "s3:DeleteBucketCors": { as: [], why: "authorized as PutBucketCORS; no CORS on the buckets (NOT_NEEDED)" },
  "s3:DeleteBucketAnalyticsConfiguration": { as: [], why: "authorized as PutAnalyticsConfiguration; no analytics (NOT_NEEDED)" },
  "s3:DeleteBucketMetricsConfiguration": { as: [], why: "authorized as PutMetricsConfiguration; no metrics (NOT_NEEDED)" },
  "s3:DeleteBucketReplication": { as: [], why: "authorized as PutReplicationConfiguration; no replication (NOT_NEEDED)" },
  "s3:PutBucketReplication": { as: [], why: "authorized as PutReplicationConfiguration; no replication" },
  "s3:PutObjectLockConfiguration": { as: [], why: "authorized as PutBucketObjectLockConfiguration; no object lock" },
  "s3:GetBucketDefaultStorageClass": { as: ["s3:GetBucketLocation"], why: "no such IAM action; the read handler's other bucket reads are allowed (s3:GetBucket*)" },
  "s3:PutBucketDefaultStorageClass": { as: [], why: "no default storage class set" },
  "s3:HeadBucket": { as: [], why: "authorized as ListBucket; the Image Builder component's document is inline (no S3 URI)" },
  "s3:REST.PUT.OBJECT": { as: [], why: "an S3 log line, not an action; no log delivery to S3" },
  "lambda:AssociateRuntimeAlias": { as: [], why: "no runtime alias (a Lambda Managed Instances feature) on the functions" },
};

/** Real actions cfn-lint's list does not know that the policies grant all the same (proven by a deploy). */
const GRANTED_ANYWAY = ["apigateway:TagResource", "apigateway:UntagResource"];

/**
 * Known schema gaps: actions a handler really calls that its schema does not list. The ApiGatewayV2 schemas list only
 * the HTTP verbs (apigateway:POST, ...) for tagging, but the Stage handler calls apigateway:TagResource (second deploy,
 * run 44558615825: AccessDenied on .../apis/<id>/stages). Required on the resource's own ARN.
 */
const SCHEMA_GAPS: Record<string, string[]> = {
  "AWS::ApiGatewayV2::Api": ["apigateway:TagResource", "apigateway:UntagResource"],
  "AWS::ApiGatewayV2::DomainName": ["apigateway:TagResource", "apigateway:UntagResource"],
  "AWS::ApiGatewayV2::Stage": ["apigateway:TagResource", "apigateway:UntagResource"],
};

/**
 * The tag actions of each service, whatever its schema says: required on the resource's own ARN for every resource
 * the template gives tags (CDK's Tags.of(stack) reaches every taggable one). A tagged resource of a service missing
 * here fails the test.
 */
const TAG_ACTIONS: Record<string, string[]> = {
  apigateway: ["apigateway:TagResource", "apigateway:UntagResource", "apigateway:POST", "apigateway:DELETE"],
  acm: ["acm:AddTagsToCertificate", "acm:RemoveTagsFromCertificate"],
  cloudfront: ["cloudfront:TagResource", "cloudfront:UntagResource", "cloudfront:ListTagsForResource"],
  cloudwatch: ["cloudwatch:TagResource", "cloudwatch:UntagResource"],
  ec2: ["ec2:CreateTags", "ec2:DeleteTags"],
  iam: ["iam:TagRole", "iam:UntagRole"],
  imagebuilder: ["imagebuilder:TagResource", "imagebuilder:UntagResource"],
  lambda: ["lambda:TagResource", "lambda:UntagResource", "lambda:ListTags"],
  logs: ["logs:TagResource", "logs:UntagResource", "logs:ListTagsForResource"],
  s3: ["s3:PutBucketTagging", "s3:GetBucketTagging"],
  sns: ["sns:TagResource", "sns:UntagResource"],
  sqs: ["sqs:TagQueue", "sqs:UntagQueue", "sqs:ListQueueTags"],
};
/** iam: tag actions differ by resource kind. */
const TAG_ACTIONS_BY_TYPE: Record<string, string[]> = { "AWS::IAM::InstanceProfile": ["iam:TagInstanceProfile"] };

const exempt = (type: string, action: string) =>
  NOT_AN_IAM_ACTION[action]?.why ?? NOT_NEEDED.find((n) => (n.types.includes("*") || n.types.includes(type)) && n.actions.test(action))?.why;

/** Every template the stacks synthesize to: both runner modes, without the App, with an alarm address; the dashboard with and without its certificate. */
type Synth = { stack: "app" | "dashboard"; name: string; types: Set<string>; tagged: Set<string> };
const TAG_PROPS = ["Tags", "TagSpecifications", "LaunchTemplateTagSpecifications"];
async function templates(): Promise<Synth[]> {
  const out: Synth[] = [];
  const res = (t: Template) => Object.values(t.toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>);
  const typesOf = (t: Template) => ({
    types: new Set(res(t).map((r) => r.Type)),
    // Resources the template gives tags: CloudFormation tags them on create, with the service's tag action.
    tagged: new Set(res(t).filter((r) => TAG_PROPS.some((k) => r.Properties?.[k] !== undefined) || JSON.stringify(r.Properties?.LaunchTemplateData ?? {}).includes("TagSpecifications")).map((r) => r.Type)),
  });
  for (const [name, over] of Object.entries({ "per-job": PER_JOB, demo: DEMO, "no GitHub App": NO_APP, "alarm email": { alarmEmail: "alerts@fenvix.dev" } })) {
    out.push({ stack: "app", name, ...typesOf((await synth(over)).template) });
  }
  for (const [name, over] of Object.entries<Record<string, string>>({ "with certificate": { dashboardCertificateArn: CERT }, "without certificate": {} })) {
    const s = await settings(over);
    const app = new App({ outdir: mkdtempSync(`${tmpdir()}/fenvix-perm-`) });
    const st = new FenvixDashboardStack(app, "dash", { env: { account: s.account, region: s.region }, settings: s, synthesizer: synthesizer() });
    out.push({ stack: "dashboard", name, ...typesOf(Template.fromStack(st)) });
  }
  return out;
}

describe("CloudFormation's execution role can do what its resource handlers do, for every resource type of both stacks", async () => {
  const all = await templates();
  const types = [...new Set(all.flatMap((t) => [...t.types].map((x) => `${t.stack} ${x}`)))].sort();
  const tagged = [...new Set(all.flatMap((t) => [...t.tagged].map((x) => `${t.stack} ${x}`)))].sort();

  it("the stacks synthesize to the resource types this test knows (a new type: add it to scripts/cfn-handler-permissions.py and here)", () => {
    for (const st of types) {
      const type = st.split(" ")[1]!;
      assert.ok(FIX.types[type], `${type}: run python3 infra/github-app/scripts/cfn-handler-permissions.py ${type}`);
      assert.ok(arnOf(st.split(" ")[0]!, type), `${st}: no sample ARN in this test`);
      assert.ok(CREATE[type], `${type}: no create action in this test`);
    }
    // The 'with certificate' dashboard has the same types; both modes of the app add up to the full list.
    assert.ok(types.includes("dashboard AWS::CloudFront::Function") && types.includes("app AWS::ImageBuilder::ImagePipeline") && types.includes("app AWS::SNS::Subscription"));
  });

  it("the create action of every resource, on its own ARN", () => {
    const missing: string[] = [];
    for (const st of types) {
      const [stack, type] = st.split(" ") as [string, string];
      for (const a of CREATE[type] ?? []) if (!allowed(a, arnOf(stack, type))) missing.push(`${st}: ${a} on ${arnOf(stack, type)}`);
    }
    assert.deepEqual(missing, []);
  });

  it("the tag actions of every taggable resource (CDK tags all of them), on its own ARN: the first deploy's failure", () => {
    const missing: string[] = [];
    for (const st of types) {
      const [stack, type] = st.split(" ") as [string, string];
      const p = FIX.types[type]!;
      if (!p.taggable) continue;
      assert.ok(p.tagging.length > 0, `${type}: taggable, but the schema names no tag action`);
      // The schema's tag actions, and those the create handler calls (tagOnCreate): the first deploy's failure.
      for (const a of [...p.tagging, ...p.create.filter((x) => /tag/i.test(x) && !NOT_NEEDED.some((n) => (n.types.includes("*") || n.types.includes(type)) && n.actions.test(x)))]) {
        const alias = NOT_AN_IAM_ACTION[a];
        for (const b of alias ? alias.as : [a]) if (!allowed(b, arnOf(stack, type))) missing.push(`${st}: ${b}${alias ? ` (for ${a})` : ""} on ${arnOf(stack, type)}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it("every resource the template tags: its service's tag actions on its own ARN, whatever the schema lists (the second deploy's failure)", () => {
    const missing: string[] = [];
    assert.ok(tagged.length >= 20, `only ${tagged.length} tagged resource types found: the template walk is broken`);
    for (const st of tagged) {
      const [stack, type] = st.split(" ") as [string, string];
      const svc = CREATE[type]![0]!.split(":")[0]!;
      const need = TAG_ACTIONS_BY_TYPE[type] ?? TAG_ACTIONS[svc];
      assert.ok(need, `${st} is tagged, but this test has no tag actions for ${svc}: add them to TAG_ACTIONS`);
      for (const a of need) if (!allowed(a, arnOf(stack, type))) missing.push(`${st}: ${a} on ${arnOf(stack, type)}`);
    }
    assert.deepEqual(missing, []);
    assert.ok(tagged.includes("app AWS::ApiGatewayV2::Stage") && tagged.includes("dashboard AWS::CloudFront::Function"), "both failures are among the tagged resources");
  });

  it("known schema gaps: what the handlers call beyond their schemas, on the resource's own ARN", () => {
    const missing: string[] = [];
    for (const [type, actions] of Object.entries(SCHEMA_GAPS)) {
      const st = types.find((x) => x.endsWith(` ${type}`));
      assert.ok(st, `SCHEMA_GAPS names ${type}, which no stack has`);
      for (const a of actions) if (!allowed(a, arnOf(st.split(" ")[0]!, type))) missing.push(`${st}: ${a} on ${arnOf(st.split(" ")[0]!, type)}`);
    }
    assert.deepEqual(missing, []);
    // The second deploy's call exactly: TagResource on the stages collection of the API.
    assert.ok(allowed("apigateway:TagResource", `arn:aws:apigateway:${R}::/apis/x2urpi2v7a/stages`));
    assert.ok(allowed("apigateway:UntagResource", `arn:aws:apigateway:${R}::/apis/x2urpi2v7a/stages/$default`));
  });

  it("every name a schema lists that cfn-lint's IAM list lacks is either granted or mapped to what IAM authorizes it as", () => {
    const unknown = new Set(types.flatMap((st) => FIX.types[st.split(" ")[1]!]!.notIamActions));
    for (const a of unknown) assert.ok(GRANTED_ANYWAY.includes(a) || NOT_AN_IAM_ACTION[a], `${a}: not in cfn-lint's IAM list; grant it (GRANTED_ANYWAY) or say what IAM authorizes it as (NOT_AN_IAM_ACTION)`);
    for (const a of GRANTED_ANYWAY) assert.ok(allowed(a), `${a} is listed as granted but is not`);
    for (const a of Object.keys(NOT_AN_IAM_ACTION)) assert.ok(unknown.has(a), `NOT_AN_IAM_ACTION has ${a}, which no schema of the stacks lists any more`);
  });

  it("the regression itself: cloudfront:TagResource on the dashboard's CloudFront function", () => {
    assert.ok(allowed("cloudfront:TagResource", `arn:aws:cloudfront::${A}:function/fenvix-prod-dashboard-spa`));
    assert.ok(!allowed("cloudfront:TagResource", `arn:aws:cloudfront::${A}:function/someone-elses`), "scoped to the stack's functions");
  });

  it("every other action of the create, update, delete and read handlers is allowed or named in NOT_NEEDED with its reason", () => {
    const missing: string[] = [];
    for (const st of types) {
      const [stack, type] = st.split(" ") as [string, string];
      const p = FIX.types[type]!;
      for (const op of ["create", "update", "delete", "read", "tagging"] as const) {
        for (const a of p[op]) {
          if (exempt(type, a)) continue;
          // An action of the resource's own service: on the resource itself. Another service's: on some resource.
          const own = a.split(":")[0]!.toLowerCase() === CREATE[type]![0]!.split(":")[0];
          if (!allowed(a, own ? arnOf(stack, type) : undefined)) missing.push(`${st} ${op}: ${a}${own ? ` on ${arnOf(stack, type)}` : ""}`);
        }
      }
    }
    assert.deepEqual([...new Set(missing)], []);
  });

  it("NOT_NEEDED holds nothing the role is in fact allowed on that resource (no stale exemption), and each entry still matches its schema", () => {
    for (const n of NOT_NEEDED) {
      let matched = 0;
      for (const st of types) {
        const [stack, type] = st.split(" ") as [string, string];
        if (!n.types.includes("*") && !n.types.includes(type)) continue;
        const p = FIX.types[type]!;
        for (const a of (["create", "update", "delete", "read", "tagging"] as const).flatMap((op) => p[op]).filter((x) => n.actions.test(x))) {
          matched++;
          if (n.actions.source !== "^iam:PassRole$") assert.ok(!allowed(a, arnOf(stack, type)), `${type}: ${a} is allowed: drop it from NOT_NEEDED (${n.why})`);
        }
      }
      for (const t of n.types) assert.ok(t === "*" || types.some((x) => x.endsWith(` ${t}`)), `NOT_NEEDED names ${t}, which no stack has`);
      assert.ok(matched > 0, `NOT_NEEDED entry matches no handler action: ${n.actions}`);
    }
  });

  it("the handler permissions file is from cfn-lint's schemas", () => {
    assert.match(FIX.source, /^cfn-lint \d+\.\d+\.\d+ resource-provider schemas, eu-west-1$/);
  });
});
