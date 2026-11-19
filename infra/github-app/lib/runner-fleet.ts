import { createHash } from "node:crypto";
import { Stack, Tags } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as imagebuilder from "aws-cdk-lib/aws-imagebuilder";
import { Construct } from "constructs";
import type { RunnerNetwork } from "./network.ts";
import { imageBuildScript, UBUNTU_2404_AMI_PARAMETER } from "./runner.ts";
import type { Settings } from "./settings.ts";

/** EC2 Image Builder caps a component's document at 16,000 characters. */
export const COMPONENT_LIMIT = 16_000;

export function componentDocument(s: Settings): string {
  const script = imageBuildScript(s).trimEnd().split("\n").map((l) => `        ${l}`).join("\n");
  return [
    "name: fenvix-runner",
    "description: fenvix runner machine (tools, users, engine, GitHub runner, hooks, units); nothing started",
    "schemaVersion: 1.0",
    "phases:",
    "- name: build",
    "  steps:",
    "  - name: InstallFenvixRunner",
    "    action: ExecuteBash",
    "    timeoutSeconds: 3600",
    "    inputs:",
    "      commands:",
    "      - |",
    script,
    "",
  ].join("\n");
}

/** A semantic version that changes with the content (Image Builder versions are immutable). */
export const contentVersion = (text: string) => `1.0.${parseInt(createHash("sha256").update(text).digest("hex").slice(0, 7), 16)}`;

/**
 * One machine per job: the prebuilt image (EC2 Image Builder: Ubuntu 24.04 + install.sh, i.e. tools, strace, uv,
 * Python, the engine wheel, the GitHub runner, the hooks and units), the launch template every job machine starts
 * from (shutdown = terminate), and the machines' role, which may do nothing: every credential a machine holds is
 * per machine (per job or per demo), minted by the worker or the demo function and passed in its user data
 * (docs/REVIEW-R-012.md F1, F2, F3). No role-wide secret is ever readable from a runner machine.
 */
export class RunnerFleet extends Construct {
  readonly launchTemplate: ec2.CfnLaunchTemplate;
  readonly jobRole: iam.Role;
  readonly pipeline: imagebuilder.CfnImagePipeline;
  /** The recipe's version: an image built from this recipe is current (the deploy pipeline builds one when missing). */
  readonly imageVersion: string;

  constructor(scope: Construct, id: string, s: Settings, net: RunnerNetwork) {
    super(scope, id);
    const stack = Stack.of(this);
    const name = (x: string) => `fenvix-${s.env}-${x}`;
    const param = (n: string) => `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${n}`;

    // ---------------------------------------------------------------- the image
    const doc = componentDocument(s);
    if (doc.length > COMPONENT_LIMIT) throw new Error(`the image component is ${doc.length} characters (limit ${COMPONENT_LIMIT})`);
    const version = contentVersion(doc + s.runnerVolumeGb);
    this.imageVersion = version;
    const component = new imagebuilder.CfnComponent(this, "Component", {
      name: name("runner"), platform: "Linux", version, data: doc,
      description: "fenvix runner: install.sh from infra/github-app/lib/runner/files",
      supportedOsVersions: ["Ubuntu 24"],
    });
    const recipe = new imagebuilder.CfnImageRecipe(this, "Recipe", {
      name: name("runner"), version,
      parentImage: `ssm:${UBUNTU_2404_AMI_PARAMETER}`,
      components: [{ componentArn: component.attrArn }],
      blockDeviceMappings: [{ deviceName: "/dev/sda1", ebs: { volumeSize: s.runnerVolumeGb, volumeType: "gp3", encrypted: true, deleteOnTermination: true } }],
    });
    const buildRole = new iam.Role(this, "BuildRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "fenvix: the Image Builder build machine (managed by Image Builder through Systems Manager)",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("EC2InstanceProfileForImageBuilder"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });
    // AmazonSSMManagedInstanceCore allows ssm:GetParameter(s) on "*": the build runs third-party code (pip, cargo,
    // the GitHub runner), so it must never reach our parameters (R-012 F5). An explicit Deny beats the managed Allow.
    buildRole.addToPolicy(new iam.PolicyStatement({
      sid: "NeverOurParameters", effect: iam.Effect.DENY,
      actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:GetParameterHistory"],
      resources: [param("/fenvix/*")],
    }));
    const buildProfile = new iam.CfnInstanceProfile(this, "BuildProfile", { roles: [buildRole.roleName] });
    const infra = new imagebuilder.CfnInfrastructureConfiguration(this, "BuildMachine", {
      name: name("runner-build"),
      instanceProfileName: buildProfile.ref,
      instanceTypes: [s.runnerInstanceType],
      subnetId: net.subnet.subnetId,
      securityGroupIds: [net.runnerSg.securityGroupId],
      terminateInstanceOnFailure: true,
      instanceMetadataOptions: { httpTokens: "required", httpPutResponseHopLimit: 1 },
    });
    const dist = new imagebuilder.CfnDistributionConfiguration(this, "Distribution", {
      name: name("runner"),
      distributions: [{
        region: stack.region,
        // Untyped in CDK: CloudFormation's own key names.
        amiDistributionConfiguration: { Name: `fenvix-${s.env}-runner-{{ imagebuilder:buildDate }}`, AmiTags: { "fenvix:image": "runner", project: "fenvix", env: s.env } },
      }],
    });
    this.pipeline = new imagebuilder.CfnImagePipeline(this, "Pipeline", {
      name: name("runner"),
      description: "Builds the per-job runner image. Run by hand: scripts/build-image.sh (docs/DEPLOY-AWS.md)",
      imageRecipeArn: recipe.attrArn,
      infrastructureConfigurationArn: infra.attrArn,
      distributionConfigurationArn: dist.attrArn,
      imageTestsConfiguration: { imageTestsEnabled: false },
      status: "ENABLED",
    });

    // ---------------------------------------------------------------- the job machines
    // No permission at all (R-012 F2): the summary credential and the cache token are per job, in the user data.
    this.jobRole = new iam.Role(this, "JobRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "fenvix runner machine (demo or per-job): no permission; its credentials are per machine, in its user data",
    });
    const jobProfile = new iam.CfnInstanceProfile(this, "JobProfile", { roles: [this.jobRole.roleName] });

    this.launchTemplate = new ec2.CfnLaunchTemplate(this, "LaunchTemplate", {
      launchTemplateName: name("runner-job"),
      launchTemplateData: {
        instanceType: s.runnerInstanceType,
        iamInstanceProfile: { arn: jobProfile.attrArn },
        networkInterfaces: [{ deviceIndex: 0, associatePublicIpAddress: true, subnetId: net.subnet.subnetId, groups: [net.runnerSg.securityGroupId], deleteOnTermination: true }],
        blockDeviceMappings: [{ deviceName: "/dev/sda1", ebs: { volumeSize: s.runnerVolumeGb, volumeType: "gp3", encrypted: true, deleteOnTermination: true } }],
        metadataOptions: { httpTokens: "required", httpPutResponseHopLimit: 1, httpEndpoint: "enabled" },
        // The machine powers itself off when its job ends (or never comes): AWS then deletes it and its disk.
        instanceInitiatedShutdownBehavior: "terminate",
        // T3 gets no launch credits: in "standard" mode a fresh machine runs at its 20% baseline (R-012 F8). The
        // default is c6i.large (not burstable); a T3 type runs "unlimited".
        ...(s.runnerInstanceType.startsWith("t3.") ? { creditSpecification: { cpuCredits: "unlimited" } } : {}),
      },
    });
    Tags.of(this).add("component", "github-app");
  }
}
