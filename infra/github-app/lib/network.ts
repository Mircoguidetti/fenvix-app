import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

/**
 * The runners' network: one VPC, one public subnet (10.42.0.0/26), no NAT gateway. Runner machines get a public
 * address for outbound HTTPS/HTTP and accept nothing. The shared cache machine has no public address; only runner
 * machines reach it, on its port, inside the VPC.
 */
export class RunnerNetwork extends Construct {
  readonly vpc: ec2.Vpc;
  readonly runnerSg: ec2.SecurityGroup;
  /** Only with the shared cache (per-job mode). */
  readonly cacheSg: ec2.SecurityGroup | null;
  readonly subnet: ec2.ISubnet;
  static readonly CACHE_PORT = 8787;

  constructor(scope: Construct, id: string, zone: string, opts: { cache: boolean }) {
    super(scope, id);
    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.42.0.0/24"),
      // One zone, named here so that synth needs no AWS call.
      availabilityZones: [zone],
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 26, mapPublicIpOnLaunch: true }],
      restrictDefaultSecurityGroup: false,
    });
    this.subnet = this.vpc.publicSubnets[0]!;
    this.runnerSg = new ec2.SecurityGroup(this, "RunnerSg", { vpc: this.vpc, allowAllOutbound: false, description: "fenvix runners: no inbound; outbound HTTPS, HTTP, the cache" });
    this.runnerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "GitHub, package registries, the fenvix App, AWS APIs");
    this.runnerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "Ubuntu package mirrors");
    this.cacheSg = null;
    if (opts.cache) {
      this.cacheSg = new ec2.SecurityGroup(this, "CacheSg", { vpc: this.vpc, allowAllOutbound: false, description: "fenvix shared cache: inbound from runners only, no outbound" });
      this.cacheSg.addIngressRule(this.runnerSg, ec2.Port.tcp(RunnerNetwork.CACHE_PORT), "runner machines");
      this.runnerSg.addEgressRule(this.cacheSg, ec2.Port.tcp(RunnerNetwork.CACHE_PORT), "the shared cache");
    }
  }
}
