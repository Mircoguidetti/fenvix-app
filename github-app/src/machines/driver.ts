import {
  DescribeInstancesCommand, EC2Client, ModifyInstanceAttributeCommand, RunInstancesCommand, StartInstancesCommand, StopInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import type { Region } from "../runners/launcher.ts";

/** What the pool asks of the cloud. The tests use an in-memory driver (tests/helpers/fake-machines.ts). */
export interface MachineDriver {
  /** Starts a new machine from the clean image; returns its instance id. `clientToken` makes a retry start nothing new. */
  launch(o: { region: Region; instanceType: string; market: "on-demand" | "spot"; userData: string; tags: Record<string, string>; clientToken: string }): Promise<string>;
  /** Replaces a STOPPED machine's user data (its new single-use boot secret), then starts it. */
  start(o: { region: Region; instanceId: string; userData: string }): Promise<void>;
  stop(o: { region: Region; instanceId: string }): Promise<void>;
  terminate(o: { region: Region; instanceIds: string[] }): Promise<void>;
  /** Every machine of ours in the region that is not terminated. */
  list(region: Region): Promise<{ instanceId: string; state: string; machineId: number | null }[]>;
}

export const POOL_ROLE = "runner-pool";
export const MACHINE_TAG = "fenvix:machine";

export interface Ec2Placement { ec2: Pick<EC2Client, "send">; launchTemplateId: string; awsRegion?: string }

/**
 * EC2: machines from the launch template (the runner image, no instance role permission, IMDSv2 hop limit 1), tagged
 * fenvix:role=runner-pool (the only machines the dispatcher's role may start, stop, modify or terminate).
 */
export class Ec2Driver implements MachineDriver {
  private readonly placements: Partial<Record<Region, Ec2Placement>>;
  private readonly imageOf: (region: Region) => Promise<string>;
  private readonly baseTags: Record<string, string>;
  constructor(placements: Partial<Record<Region, Ec2Placement>>, imageOf: (region: Region) => Promise<string>, baseTags: Record<string, string> = {}) {
    this.placements = placements; this.imageOf = imageOf; this.baseTags = baseTags;
  }

  private p(region: Region): Ec2Placement {
    const p = this.placements[region];
    if (!p) throw new Error(`no machine placement for region ${region}`);
    return p;
  }

  async launch(o: Parameters<MachineDriver["launch"]>[0]): Promise<string> {
    const p = this.p(o.region);
    const tags = Object.entries({ ...this.baseTags, ...o.tags, "fenvix:role": POOL_ROLE, "fenvix:region": o.region }).map(([Key, Value]) => ({ Key, Value }));
    const r = await p.ec2.send(new RunInstancesCommand({
      LaunchTemplate: { LaunchTemplateId: p.launchTemplateId, Version: "$Latest" },
      ImageId: await this.imageOf(o.region),
      InstanceType: o.instanceType as never,
      MinCount: 1, MaxCount: 1, ClientToken: o.clientToken,
      UserData: Buffer.from(o.userData).toString("base64"),
      // A spot machine is terminated (not stopped) when EC2 takes it back: its jobs are re-run elsewhere.
      ...(o.market === "spot" ? { InstanceMarketOptions: { MarketType: "spot", SpotOptions: { SpotInstanceType: "one-time", InstanceInterruptionBehavior: "terminate" } } } : {}),
      TagSpecifications: [{ ResourceType: "instance", Tags: tags }, { ResourceType: "volume", Tags: tags }],
    }));
    const id = r.Instances?.[0]?.InstanceId;
    if (!id) throw new Error("RunInstances returned no instance");
    return id;
  }

  async start(o: { region: Region; instanceId: string; userData: string }): Promise<void> {
    const p = this.p(o.region);
    await p.ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: o.instanceId, UserData: { Value: Buffer.from(o.userData) } }));
    await p.ec2.send(new StartInstancesCommand({ InstanceIds: [o.instanceId] }));
  }

  async stop(o: { region: Region; instanceId: string }): Promise<void> {
    await this.p(o.region).ec2.send(new StopInstancesCommand({ InstanceIds: [o.instanceId] }));
  }

  async terminate(o: { region: Region; instanceIds: string[] }): Promise<void> {
    if (o.instanceIds.length) await this.p(o.region).ec2.send(new TerminateInstancesCommand({ InstanceIds: o.instanceIds }));
  }

  async list(region: Region): Promise<{ instanceId: string; state: string; machineId: number | null }[]> {
    const r = await this.p(region).ec2.send(new DescribeInstancesCommand({
      Filters: [{ Name: "tag:fenvix:role", Values: [POOL_ROLE] }, { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] }],
    }));
    return (r.Reservations ?? []).flatMap((x) => x.Instances ?? []).filter((i) => i.InstanceId).map((i) => {
      const t = (i.Tags ?? []).find((x) => x.Key === MACHINE_TAG)?.Value;
      return { instanceId: i.InstanceId!, state: i.State?.Name ?? "unknown", machineId: t && /^\d+$/.test(t) ? Number(t) : null };
    });
  }
}
