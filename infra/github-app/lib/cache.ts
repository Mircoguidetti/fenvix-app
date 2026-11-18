import { readFileSync } from "node:fs";
import { Tags } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import type { RunnerNetwork } from "./network.ts";
import { fileLines } from "./runner.ts";
import type { Settings } from "./settings.ts";

export const UBUNTU_2404_ARM64_AMI_PARAMETER = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id";
const CACHE_DIR = new URL("./cache/", import.meta.url);

/** tokens.json of the cache service: the SHA-256 of each token only (the tokens are SSM parameters). */
export function tokensJson(s: Settings): string {
  const tokens = [];
  if (s.cacheTokenSha256Write) tokens.push({ sha256: s.cacheTokenSha256Write, org: s.cacheOrg, write: true, label: "runners, trusted refs", created: 0 });
  if (s.cacheTokenSha256Read) tokens.push({ sha256: s.cacheTokenSha256Read, org: s.cacheOrg, write: false, label: "runners, pull requests", created: 0 });
  return JSON.stringify({ tokens });
}

export function cacheUserData(s: Settings): string {
  const tokens = Buffer.from(tokensJson(s)).toString("base64");
  return [
    "#!/bin/bash", "set -euo pipefail",
    "id fenvix-cache >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin fenvix-cache",
    "install -d -m 0755 /opt/fenvix-cache /etc/systemd/system",
    "install -d -m 0700 -o fenvix-cache -g fenvix-cache /var/lib/fenvix-cache",
    ...fileLines([["cache_service.py", "/opt/fenvix-cache/cache_service.py", "0644"], ["fenvix-cache.service", "/etc/systemd/system/fenvix-cache.service", "0644"]], CACHE_DIR),
    // Hashes only. A change of a token hash changes the user data, which replaces the machine (and empties the cache).
    `echo '${tokens}' | base64 -d >/var/lib/fenvix-cache/tokens.json`,
    "chown fenvix-cache:fenvix-cache /var/lib/fenvix-cache/tokens.json && chmod 0600 /var/lib/fenvix-cache/tokens.json",
    "systemctl daemon-reload", "systemctl enable --now fenvix-cache.service",
  ].join("\n") + "\n";
}

/**
 * The shared cache (per-job mode): one small arm64 machine with no public address and no outbound route, on a fixed
 * private address; only runner machines reach it (port 8787). It runs the engine's own cache service unchanged
 * (HTTP + SQLite in WAL mode on its disk). See docs/DEPLOY-AWS.md for why not Lambda.
 */
export class CacheMachine extends Construct {
  readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, s: Settings, net: RunnerNetwork) {
    super(scope, id);
    // The vendored file must be the one PROVENANCE.md names (checked again by the tests).
    readFileSync(new URL("cache_service.py", CACHE_DIR));
    const image = s.cacheAmiId
      ? ec2.MachineImage.genericLinux({ [s.region]: s.cacheAmiId })
      : ec2.MachineImage.fromSsmParameter(UBUNTU_2404_ARM64_AMI_PARAMETER, { os: ec2.OperatingSystemType.LINUX });
    this.instance = new ec2.Instance(this, "Instance", {
      vpc: net.vpc,
      vpcSubnets: { subnets: [net.subnet] },
      privateIpAddress: s.cachePrivateIp,
      associatePublicIpAddress: false,
      instanceType: new ec2.InstanceType(s.cacheInstanceType),
      machineImage: image,
      securityGroup: net.cacheSg!,
      // It calls no AWS API: a role with nothing in it.
      role: new iam.Role(this, "Role", { assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"), description: "fenvix shared cache machine: no permission" }),
      creditSpecification: ec2.CpuCredits.STANDARD,
      blockDevices: [{
        deviceName: "/dev/sda1",
        volume: ec2.BlockDeviceVolume.ebs(s.cacheVolumeGb, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true, deleteOnTermination: true }),
      }],
      userData: ec2.UserData.custom(cacheUserData(s)),
      userDataCausesReplacement: true,
    });
    const cfn = this.instance.node.defaultChild as ec2.CfnInstance;
    cfn.addPropertyOverride("MetadataOptions", { HttpTokens: "required", HttpPutResponseHopLimit: 1, HttpEndpoint: "enabled" });
    Tags.of(this.instance).add("Name", `fenvix-${s.env}-cache`);
  }
}
