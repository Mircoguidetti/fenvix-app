import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { Stack, Tags } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import type { RunnerNetwork } from "./network.ts";
import { appPrefix, cachePrefix, registrationTokenName } from "./parameters.ts";
import type { Settings } from "./settings.ts";

export const UBUNTU_2404_AMI_PARAMETER = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id";

const FILES_DIR = new URL("./runner/files/", import.meta.url);
/** Installed on every runner machine (always-on user data, and the per-job image): [file, path on the machine, mode]. */
export const RUNNER_FILES: [string, string, string][] = [
  ["install.sh", "/opt/fenvix/install.sh", "0755"],
  ["setup.sh", "/opt/fenvix/setup.sh", "0755"],
  ["fenvix-imds-block", "/opt/fenvix/bin/fenvix-imds-block", "0755"],
  ["fenvix-register", "/opt/fenvix/bin/fenvix-register", "0755"],
  ["fenvix-fetch-runner-token", "/opt/fenvix/bin/fenvix-fetch-runner-token", "0755"],
  ["fenvix-job-completed", "/opt/fenvix/bin/fenvix-job-completed", "0755"],
  ["fenvix-job-started", "/opt/fenvix/bin/fenvix-job-started", "0755"],
  ["fenvix-summary-poster", "/opt/fenvix/bin/fenvix-summary-poster", "0755"],
  ["fenvix-jit-prepare", "/opt/fenvix/bin/fenvix-jit-prepare", "0755"],
  ["fenvix-job-done", "/opt/fenvix/bin/fenvix-job-done", "0755"],
  ["fenvix-idle-watchdog", "/opt/fenvix/bin/fenvix-idle-watchdog", "0755"],
  ["fenvix-imds-block.service", "/etc/systemd/system/fenvix-imds-block.service", "0644"],
  ["fenvix-runner.service", "/etc/systemd/system/fenvix-runner.service", "0644"],
  ["fenvix-summary-poster.service", "/etc/systemd/system/fenvix-summary-poster.service", "0644"],
  ["fenvix-runner-jit.service", "/etc/systemd/system/fenvix-runner-jit.service", "0644"],
  ["fenvix-job.target", "/etc/systemd/system/fenvix-job.target", "0644"],
  ["fenvix-idle-watchdog.service", "/etc/systemd/system/fenvix-idle-watchdog.service", "0644"],
  ["fenvix-idle-watchdog.timer", "/etc/systemd/system/fenvix-idle-watchdog.timer", "0644"],
];

/** The per-job image: everything but what only the always-on machine uses (its setup, registration and unit). */
export const IMAGE_FILES = RUNNER_FILES.filter(([f]) => !["setup.sh", "fenvix-register", "fenvix-runner.service"].includes(f));

/** Shell lines that write files (gzip + base64, to stay well under the user data and component size limits). */
export function fileLines(files: [string, string, string][], dir: URL = FILES_DIR): string[] {
  const out: string[] = [];
  for (const [file, dest, mode] of files) {
    const b64 = gzipSync(readFileSync(new URL(file, dir)), { level: 9 }).toString("base64");
    out.push(`echo '${b64}' | base64 -d | gunzip >${dest}`, `chmod ${mode} ${dest}`);
  }
  return out;
}

export function envLines(path: string, env: Record<string, string>): string[] {
  const lines = Object.entries(env).map(([k, v]) => {
    if (!/^[A-Za-z0-9_./:@-]*$/.test(v)) throw new Error(`machine setting ${k} has characters the env file does not allow`);
    return `${k}=${v}`;
  });
  return [`cat >${path} <<'FENVIX_ENV'`, ...lines, "FENVIX_ENV", `chmod 0644 ${path}`];
}

/** The settings every runner machine needs, without the per-job ones (no secret). */
export function commonMachineEnv(s: Settings): Record<string, string> {
  return {
    AWS_DEFAULT_REGION: s.region,
    FENVIX_ENGINE_CLI_COMMIT: s.engineCliCommit,
    FENVIX_RUNNER_TOKEN_PARAM: `${appPrefix(s.env)}/runner-token`,
    FENVIX_SUMMARIES_URL: `https://${s.domainName}/v1/runner/summaries`,
  };
}

/** Per-job machines: what the worker Lambda writes into each one's user data, besides the job's own values. */
export function perJobMachineEnv(s: Settings): Record<string, string> {
  return {
    ...commonMachineEnv(s),
    FENVIX_IDLE_MINUTES: String(s.runnerIdleMinutes),
    FENVIX_CACHE_URL: `http://${s.cachePrivateIp}:8787/${s.cacheOrg}`,
    FENVIX_CACHE_WRITE_TOKEN_PARAM: `${cachePrefix(s.env)}/write-token`,
    FENVIX_CACHE_READ_TOKEN_PARAM: `${cachePrefix(s.env)}/read-token`,
  };
}

/** The always-on machine's plain settings: /etc/fenvix/runner.env. */
export function runnerEnv(s: Settings): Record<string, string> {
  return {
    ...commonMachineEnv(s),
    FENVIX_MODE: "always-on",
    FENVIX_REPO_URL: s.runnerScopeUrl,
    FENVIX_RUNNER_NAME: s.runnerName,
    FENVIX_REGISTRATION_TOKEN_PARAM: registrationTokenName(s.env),
  };
}

const DIRS = "install -d -m 0755 /etc/fenvix /opt/fenvix/bin /etc/systemd/system";

/** The always-on machine's user data: settings, the files, then setup.sh. */
export function runnerUserData(s: Settings): string {
  return ["#!/bin/bash", "set -euo pipefail", DIRS, ...envLines("/etc/fenvix/runner.env", runnerEnv(s)), ...fileLines(RUNNER_FILES),
    "bash /opt/fenvix/setup.sh"].join("\n") + "\n";
}

/** The image build (EC2 Image Builder component): the files and install.sh; the settings file is removed after. */
export function imageBuildScript(s: Settings): string {
  return ["set -euo pipefail", DIRS, ...envLines("/etc/fenvix/runner.env", commonMachineEnv(s)), ...fileLines(IMAGE_FILES),
    "bash /opt/fenvix/install.sh", "rm -f /etc/fenvix/runner.env", "rm -rf /var/log/fenvix-runner-setup.log"].join("\n") + "\n";
}

/**
 * The optional always-on machine (runnerMode "always-on"): registered once, serves jobs, keeps its local cache on its
 * disk. scripts/runner-stop.sh and runner-start.sh stop and start it; it comes back without a new token.
 */
export class RunnerMachine extends Construct {
  readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, s: Settings, net: RunnerNetwork) {
    super(scope, id);
    const stack = Stack.of(this);
    const role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "fenvix always-on runner: Session Manager, read RUNNER_TOKEN, read and delete the registration token",
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

    this.instance = new ec2.Instance(this, "Instance", {
      vpc: net.vpc,
      vpcSubnets: { subnets: [net.subnet] },
      instanceType: new ec2.InstanceType(s.runnerInstanceType),
      machineImage: image,
      securityGroup: net.runnerSg,
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
