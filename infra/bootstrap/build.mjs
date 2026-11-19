// Builds fenvix-bootstrap.json, the one-click CloudFormation template the founder creates once in the AWS console
// (docs/DEPLOY-AWS.md, step 1), from the policy files of infra/github-app, so that the two never drift apart.
//   node infra/bootstrap/build.mjs           # writes the template
//   node infra/bootstrap/build.mjs --check   # fails if the committed template is not the built one (the tests run it)
import { readFileSync, writeFileSync } from "node:fs";

const here = new URL("./", import.meta.url);
const infra = new URL("../github-app/", import.meta.url);
const policy = (f) => JSON.parse(readFileSync(new URL(f, infra), "utf8"));

export const ACCOUNT = "865859654353";
export const REGION = "eu-west-1";
export const QUALIFIER = "fenvix";
const suffix = `${ACCOUNT}-${REGION}`;
export const NAMES = {
  deployerRole: "fenvix-github-deployer",
  deployerPolicy: "fenvix-github-deployer",
  boundary: "fenvix-prod-github-app-boundary",
  assetsBucket: `cdk-${QUALIFIER}-assets-${suffix}`,
  cdkDeployRole: `cdk-${QUALIFIER}-deploy-role-${suffix}`,
  cdkPublishRole: `cdk-${QUALIFIER}-file-publishing-role-${suffix}`,
  cfnExecRole: `cdk-${QUALIFIER}-cfn-exec-role-${suffix}`,
  versionParameter: `/cdk-bootstrap/${QUALIFIER}/version`,
  stacks: ["fenvix-prod-github-app", "fenvix-prod-dashboard"],
};
const EXEC = ["app", "edge", "fleet", "dashboard"];

export function template() {
  const sub = (s) => ({ "Fn::Sub": s });
  const repo = "${GitHubOwner}/${GitHubRepository}";
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "fenvix: what the deploy pipeline (.github/workflows/deploy.yml) needs in AWS, created once: GitHub's OIDC provider, the deploy role trusted only for the branch main of one repository (no GitHub environment), the permissions boundary of every role the stacks create, and the CDK deploy resources (assets bucket, deploy, publishing and CloudFormation roles). No access key. docs/DEPLOY-AWS.md",
    Parameters: {
      GitHubOwner: { Type: "String", Default: "Mircoguidetti", AllowedPattern: "^[A-Za-z0-9-]{1,39}$", Description: "The GitHub account that owns the repository (as it appears in the repository's URL)" },
      GitHubRepository: { Type: "String", Default: "fenvix-app", AllowedPattern: "^[A-Za-z0-9._-]{1,100}$" },
      CreateOidcProvider: { Type: "String", Default: "true", AllowedValues: ["true", "false"], Description: "false only if this account already has the provider token.actions.githubusercontent.com (IAM > Identity providers)" },
    },
    Rules: {
      ThisAccountAndRegion: {
        Assertions: [
          { Assert: { "Fn::Equals": [{ Ref: "AWS::AccountId" }, ACCOUNT] }, AssertDescription: `Create this stack in account ${ACCOUNT}` },
          { Assert: { "Fn::Equals": [{ Ref: "AWS::Region" }, REGION] }, AssertDescription: `Create this stack in ${REGION} (Europe, Ireland)` },
        ],
      },
    },
    Conditions: { MakeOidcProvider: { "Fn::Equals": [{ Ref: "CreateOidcProvider" }, "true"] } },
    Resources: {
      GitHubOidcProvider: {
        Type: "AWS::IAM::OIDCProvider",
        Condition: "MakeOidcProvider",
        Properties: {
          Url: "https://token.actions.githubusercontent.com",
          ClientIdList: ["sts.amazonaws.com"],
          // AWS checks GitHub's certificate against its own trusted authorities; the thumbprints are kept for older accounts.
          ThumbprintList: ["6938fd4d98bab03faadb97b34396831e3780aea1", "1c58a3a8518e8759bf075b76b750d4f2df264fcd"],
        },
      },
      Boundary: {
        Type: "AWS::IAM::ManagedPolicy",
        Properties: { ManagedPolicyName: NAMES.boundary, Description: "fenvix: the most any role of the fenvix stacks may ever do (infra/github-app/permissions-boundary.json)", PolicyDocument: policy("permissions-boundary.json") },
      },
      ...Object.fromEntries(EXEC.map((x) => [`CfnExec${x[0].toUpperCase()}${x.slice(1)}`, {
        Type: "AWS::IAM::ManagedPolicy",
        Properties: { ManagedPolicyName: `fenvix-github-app-cfn-exec-${x}`, Description: `fenvix: what CloudFormation may do for the fenvix stacks (infra/github-app/cfn-exec-policy-${x}.json)`, PolicyDocument: policy(`cfn-exec-policy-${x}.json`) },
      }])),
      AssetsBucket: {
        Type: "AWS::S3::Bucket",
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
        Properties: {
          BucketName: NAMES.assetsBucket,
          BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
          PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
          OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
          LifecycleConfiguration: { Rules: [{ Id: "abort-uploads", Status: "Enabled", AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] },
        },
      },
      AssetsBucketPolicy: {
        Type: "AWS::S3::BucketPolicy",
        Properties: {
          Bucket: { Ref: "AssetsBucket" },
          PolicyDocument: { Version: "2012-10-17", Statement: [{
            Sid: "TlsOnly", Effect: "Deny", Principal: "*", Action: "s3:*",
            Resource: [sub("arn:aws:s3:::${AssetsBucket}"), sub("arn:aws:s3:::${AssetsBucket}/*")],
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }] },
        },
      },
      VersionParameter: {
        Type: "AWS::SSM::Parameter",
        // The CDK CLI checks that the deploy resources exist (and are recent enough) by reading this parameter.
        Properties: { Name: NAMES.versionParameter, Type: "String", Value: "30", Description: "fenvix: CDK deploy resources made by the one-click template (infra/bootstrap)" },
      },
      CfnExecRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: NAMES.cfnExecRole,
          Description: "fenvix: the role CloudFormation creates and changes the fenvix stacks with",
          AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "cloudformation.amazonaws.com" }, Action: "sts:AssumeRole" }] },
          ManagedPolicyArns: EXEC.map((x) => ({ Ref: `CfnExec${x[0].toUpperCase()}${x.slice(1)}` })),
        },
      },
      CdkDeployRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: NAMES.cdkDeployRole,
          Description: "fenvix: the CDK CLI submits the fenvix stacks to CloudFormation with this role (assumed by the GitHub deployer only)",
          AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: { "Fn::GetAtt": ["DeployerRole", "Arn"] } }, Action: ["sts:AssumeRole", "sts:TagSession"] }] },
          Policies: [{
            PolicyName: "deploy",
            PolicyDocument: { Version: "2012-10-17", Statement: [
              { Sid: "OwnStacks", Effect: "Allow", Action: ["cloudformation:CreateChangeSet", "cloudformation:DeleteChangeSet", "cloudformation:DescribeChangeSet", "cloudformation:ExecuteChangeSet", "cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents", "cloudformation:DescribeStackResources", "cloudformation:GetTemplate", "cloudformation:GetTemplateSummary", "cloudformation:CreateStack", "cloudformation:UpdateStack", "cloudformation:RollbackStack", "cloudformation:ContinueUpdateRollback", "cloudformation:ListStackResources"],
                Resource: NAMES.stacks.map((s) => sub(`arn:aws:cloudformation:\${AWS::Region}:\${AWS::AccountId}:stack/${s}/*`)) },
              { Sid: "ValidateTemplates", Effect: "Allow", Action: ["cloudformation:ValidateTemplate"], Resource: "*" },
              { Sid: "PassTheExecutionRoleToCloudFormation", Effect: "Allow", Action: "iam:PassRole", Resource: { "Fn::GetAtt": ["CfnExecRole", "Arn"] }, Condition: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } } },
              { Sid: "ReadTemplatesAndAssets", Effect: "Allow", Action: ["s3:GetObject", "s3:GetBucketLocation", "s3:ListBucket"], Resource: [sub("arn:aws:s3:::${AssetsBucket}"), sub("arn:aws:s3:::${AssetsBucket}/*")] },
              { Sid: "Version", Effect: "Allow", Action: "ssm:GetParameter", Resource: sub(`arn:aws:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter${NAMES.versionParameter}`) },
            ] },
          }],
        },
      },
      CdkPublishRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: NAMES.cdkPublishRole,
          Description: "fenvix: the CDK CLI uploads the functions' code and the templates with this role (assumed by the GitHub deployer only)",
          AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: { "Fn::GetAtt": ["DeployerRole", "Arn"] } }, Action: ["sts:AssumeRole", "sts:TagSession"] }] },
          Policies: [{
            PolicyName: "publish",
            PolicyDocument: { Version: "2012-10-17", Statement: [
              { Sid: "Assets", Effect: "Allow", Action: ["s3:GetObject*", "s3:PutObject*", "s3:AbortMultipartUpload", "s3:GetBucketLocation", "s3:GetEncryptionConfiguration", "s3:ListBucket"], Resource: [sub("arn:aws:s3:::${AssetsBucket}"), sub("arn:aws:s3:::${AssetsBucket}/*")] },
            ] },
          }],
        },
      },
      DeployerPolicy: {
        Type: "AWS::IAM::ManagedPolicy",
        Properties: { ManagedPolicyName: NAMES.deployerPolicy, Description: "fenvix: what the deploy pipeline does itself (infra/github-app/deploy-policy.json)", PolicyDocument: policy("deploy-policy.json") },
      },
      DeployerRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: NAMES.deployerRole,
          Description: sub(`fenvix: the deploy pipeline of ${repo} (GitHub Actions, OIDC): jobs on its branch main only`),
          MaxSessionDuration: 7200,
          ManagedPolicyArns: [{ Ref: "DeployerPolicy" }],
          AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{
            Sid: "GitHubActionsMainBranchOnly",
            Effect: "Allow",
            Principal: { Federated: sub("arn:aws:iam::${AWS::AccountId}:oidc-provider/token.actions.githubusercontent.com") },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                // Exactly the token of a job running on refs/heads/main (a push to main, or "Run workflow" on main).
                // Never an environment, a pull request, a tag or another branch.
                "token.actions.githubusercontent.com:sub": [sub(`repo:${repo}:ref:refs/heads/main`)],
              },
            },
          }] },
        },
      },
    },
    Outputs: {
      DeployRoleArn: { Value: { "Fn::GetAtt": ["DeployerRole", "Arn"] }, Description: "The role the deploy workflow assumes (already written in .github/workflows/deploy.yml)" },
      AssetsBucket: { Value: { Ref: "AssetsBucket" } },
    },
  };
}

export const rendered = () => `${JSON.stringify(template(), null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = new URL("fenvix-bootstrap.json", here);
  if (process.argv.includes("--check")) {
    if (readFileSync(file, "utf8") !== rendered()) { console.error("infra/bootstrap/fenvix-bootstrap.json is stale: run node infra/bootstrap/build.mjs"); process.exit(1); }
    console.log("fenvix-bootstrap.json is up to date");
  } else {
    writeFileSync(file, rendered());
    console.log("wrote infra/bootstrap/fenvix-bootstrap.json");
  }
}
