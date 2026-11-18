import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { Stack, Tags } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { appPrefix, registrationTokenName } from "./parameters.ts";
import type { Settings } from "./settings.ts";

export const UBUNTU_2404_AMI_PARAMETER = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id";

const FILES_DIR = new URL("./runner/files/", import.meta.url);
/** Installed on the machine: [file in lib/runner/files, path on the machine, mode]. */
export const RUNNER_FILES: [string, string, string][] = [
  ["setup.sh", "/opt/fenvix/setup.sh", "0755"],
  ["fenvix-imds-block", "/opt/fenvix/bin/fenvix-imds-block", "0755"],
  ["fenvix-register", "/opt/fenvix/bin/fenvix-register", "0755"],
  ["fenvix-fetch-runner-token", "/opt/fenvix/bin/fenvix-fetch-runner-token", "0755"],
  ["fenvix-job-completed", "/opt/fenvix/bin/fenvix-job-completed", "0755"],
  ["fenvix-summary-poster", "/opt/fenvix/bin/fenvix-summary-poster", "0755"],
  ["fenvix-imds-block.service", "/etc/systemd/system/fenvix-imds-block.service", "0644"],
  ["fenvix-runner.service", "/etc/systemd/system/fenvix-runner.service", "0644"],
  ["fenvix-summary-poster.service", "/etc/systemd/system/fenvix-summary-poster.service", "0644"],
];

/** The machine's plain settings (no secret): /etc/fenvix/runner.env. */
export function runnerEnv(s: Settings): Record<string, string> {
  return {
    AWS_DEFAULT_REGION: s.region,
    FENVIX_ENGINE_CLI_COMMIT: s.engineCliCommit,
    FENVIX_REPO_URL: s.runnerScopeUrl,
    FENVIX_RUNNER_NAME: s.runnerName,
    FENVIX_REGISTRATION_TOKEN_PARAM: registrationTokenName(s.env),
    FENVIX_RUNNER_TOKEN_PARAM: `${appPrefix(s.env)}/runner-token`,
    FENVIX_SUMMARIES_URL: `https://${s.domainName}/v1/runner/summaries`,
  };
}

/** The EC2 user data: settings, the files (gzip + base64, to stay well under the 16 KB limit), then setup.sh. */
export function runnerUserData(s: Settings): string {
  const lines = ["#!/bin/bash", "set -euo pipefail", "install -d -m 0755 /etc/fenvix /opt/fenvix/bin"];
  const env = Object.entries(runnerEnv(s)).map(([k, v]) => {
    if (!/^[A-Za-z0-9_./:@-]+$/.test(v)) throw new Error(`runner setting ${k} has characters the env file does not allow`);
    return `${k}=${v}`;
  });
  lines.push(`cat >/etc/fenvix/runner.env <<'FENVIX_ENV'`, ...env, "FENVIX_ENV", "chmod 0644 /etc/fenvix/runner.env");
  for (const [file, dest, mode] of RUNNER_FILES) {
    const b64 = gzipSync(readFileSync(new URL(file, FILES_DIR)), { level: 9 }).toString("base64");
    lines.push(`echo '${b64}' | base64 -d | gunzip >${dest}`, `chmod ${mode} ${dest}`);
  }
  lines.push("bash /opt/fenvix/setup.sh");
  return lines.join("\n") + "\n";
}

/**
 * One always-on EC2 machine that runs our self-hosted GitHub runner (labels self-hosted, fenvix). No inbound port:
 * the runner long-polls GitHub over HTTPS; people connect with Session Manager. Outbound: HTTPS and HTTP (Ubuntu's
 * package mirrors) only.
 */
export class RunnerMachine extends Construct {
  readonly instance: ec2.Instance;
  readonly amiId: string;

  constructor(scope: Construct, id: string, s: Settings) {
    super(scope, id);
    const stack = Stack.of(this);

    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.42.0.0/24"),
      // One zone, named here so that synth needs no AWS call (t3.medium is offered in eu-west-1a).
      availabilityZones: [`${s.region}a`],
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 26, mapPublicIpOnLaunch: true }],
      restrictDefaultSecurityGroup: false,
    });

    const sg = new ec2.SecurityGroup(this, "Sg", { vpc, allowAllOutbound: false, description: "fenvix runner: no inbound; outbound HTTPS and HTTP only" });
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "GitHub, package registries, the fenvix App");
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "Ubuntu package mirrors");

    const role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "fenvix runner machine: Session Manager, read RUNNER_TOKEN, read and delete the registration token",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    const param = (name: string) => `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${name}`;
    role.addToPolicy(new iam.PolicyStatement({
      sid: "ReadRunnerTokens", actions: ["ssm:GetParameter"],
      resources: [param(`${appPrefix(s.env)}/runner-token`), param(registrationTokenName(s.env))],
    }));
    role.addToPolicy(new iam.PolicyStatement({ sid: "DeleteUsedRegistrationToken", actions: ["ssm:DeleteParameter"], resources: [param(registrationTokenName(s.env))] }));

    const image = s.runnerAmiId
      ? ec2.MachineImage.genericLinux({ [s.region]: s.runnerAmiId })
      : ec2.MachineImage.fromSsmParameter(UBUNTU_2404_AMI_PARAMETER, { os: ec2.OperatingSystemType.LINUX });
    this.amiId = s.runnerAmiId || "resolved at deploy time from " + UBUNTU_2404_AMI_PARAMETER;

    this.instance = new ec2.Instance(this, "Instance", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(s.runnerInstanceType),
      machineImage: image,
      securityGroup: sg,
      role,
      // Credits "standard": no surplus-credit charge; a long build slows to the baseline instead of costing more.
      creditSpecification: ec2.CpuCredits.STANDARD,
      blockDevices: [{
        deviceName: "/dev/sda1",
        volume: ec2.BlockDeviceVolume.ebs(s.runnerVolumeGb, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true, deleteOnTermination: true }),
      }],
      userData: ec2.UserData.custom(runnerUserData(s)),
      userDataCausesReplacement: false,
    });
    // IMDSv2 only, and one hop: nothing in a container on the machine reaches it.
    const cfn = this.instance.node.defaultChild as ec2.CfnInstance;
    cfn.addPropertyOverride("MetadataOptions", { HttpTokens: "required", HttpPutResponseHopLimit: 1, HttpEndpoint: "enabled" });
    Tags.of(this.instance).add("Name", `fenvix-${s.env}-runner`);
  }
}
