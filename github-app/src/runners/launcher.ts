import { DescribeImagesCommand, DescribeInstancesCommand, RunInstancesCommand, TerminateInstancesCommand, type EC2Client } from "@aws-sdk/client-ec2";

/**
 * "One machine per job": when GitHub queues a job with the fenvix label, the App asks GitHub for a just-in-time runner
 * configuration (one runner, one job) and starts one machine with it. The runner takes a job, the machine powers off
 * when it ends and AWS terminates it (shutdown behaviour "terminate"). A machine that never got a job powers off after
 * an idle limit (on the machine), and the reaper terminates anything older than the hard limit.
 */
export interface RunnerLaunch {
  jobId: number;
  runId: number;
  repositoryId: number;
  repositoryFullName: string;
  installationId: number;
  /** The runner's name on GitHub; the run summary is matched to the job by it. */
  runnerName: string;
  /** GitHub's encoded just-in-time configuration (single use). */
  jitConfig: string;
  /** "write" only for trusted refs (a push, schedule or manual run on the default branch of the repository itself). */
  cacheAccess: "write" | "read";
}

export interface RunnerLauncher {
  launch(l: RunnerLaunch): Promise<{ instanceId: string | null; already: boolean }>;
}

/** Thrown when the fleet is at its limit: the queue retries the job later. */
export class RetryLater extends Error {}

/** The tag every per-job machine carries (the reaper and the IAM conditions use it). */
export const ROLE_TAG = "fenvix:role";
export const ROLE_VALUE = "runner-job";
export const IMAGE_TAG = "fenvix:image";

const SAFE = /^[A-Za-z0-9_./:@+=-]*$/;

/** The machine's per-job settings, written by its user data (root only), then the services start. */
export function jobUserData(l: RunnerLaunch, machineEnv: Record<string, string>): string {
  if (!/^[A-Za-z0-9+/=]+$/.test(l.jitConfig)) throw new Error("the just-in-time configuration is not base64");
  const env: Record<string, string> = {
    ...machineEnv,
    FENVIX_MODE: "per-job",
    FENVIX_RUNNER_NAME: l.runnerName,
    FENVIX_JOB_ID: String(l.jobId),
    FENVIX_CACHE_ACCESS: l.cacheAccess,
  };
  const lines = ["#!/bin/bash", "set -euo pipefail", "umask 022", "install -d -m 0755 /etc/fenvix", "cat >/etc/fenvix/runner.env <<'FENVIX_ENV'"];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || !SAFE.test(v)) throw new Error(`machine setting ${k} has characters the env file does not allow`);
    lines.push(`${k}=${v}`);
  }
  lines.push("FENVIX_ENV", "umask 077", `printf '%s' '${l.jitConfig}' >/etc/fenvix/jitconfig`, "systemctl start --no-block fenvix-job.target");
  return lines.join("\n") + "\n";
}

export interface Ec2LauncherOptions {
  ec2: Pick<EC2Client, "send">;
  launchTemplateId: string;
  /** At most this many per-job machines pending or running at once. */
  maxRunning: number;
  /** Plain settings every machine needs (summaries URL, parameter names, region, cache URL). */
  machineEnv: Record<string, string>;
  /** Tags copied onto every machine (project, env). */
  tags?: Record<string, string>;
  log?: { info(o: object, msg?: string): void };
  now?: () => number;
}

export class Ec2Launcher implements RunnerLauncher {
  private readonly o: Ec2LauncherOptions;
  private image: { id: string; at: number } | null = null;

  constructor(o: Ec2LauncherOptions) { this.o = o; }

  /** The newest runner image this account built (EC2 Image Builder tags it), looked up at most every 5 minutes. */
  async imageId(): Promise<string> {
    const now = (this.o.now ?? Date.now)();
    if (this.image && now - this.image.at < 5 * 60_000) return this.image.id;
    const r = await this.o.ec2.send(new DescribeImagesCommand({ Owners: ["self"], Filters: [{ Name: `tag:${IMAGE_TAG}`, Values: ["runner"] }, { Name: "state", Values: ["available"] }] }));
    const newest = (r.Images ?? []).filter((i) => i.ImageId).sort((a, b) => String(b.CreationDate).localeCompare(String(a.CreationDate)))[0];
    if (!newest?.ImageId) throw new Error("no runner image yet: run the image pipeline (docs/DEPLOY-AWS.md)");
    this.image = { id: newest.ImageId, at: now };
    return newest.ImageId;
  }

  async running(): Promise<number> {
    const r = await this.o.ec2.send(new DescribeInstancesCommand({
      Filters: [{ Name: `tag:${ROLE_TAG}`, Values: [ROLE_VALUE] }, { Name: "instance-state-name", Values: ["pending", "running"] }],
    }));
    return (r.Reservations ?? []).reduce((n, x) => n + (x.Instances?.length ?? 0), 0);
  }

  async launch(l: RunnerLaunch): Promise<{ instanceId: string | null; already: boolean }> {
    const n = await this.running();
    if (n >= this.o.maxRunning) throw new RetryLater(`${n} fenvix machines are running (limit ${this.o.maxRunning}); job ${l.jobId} waits`);
    const imageId = await this.imageId();
    const tags = [
      ...Object.entries(this.o.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
      { Key: ROLE_TAG, Value: ROLE_VALUE }, { Key: "fenvix:job", Value: String(l.jobId) },
      { Key: "fenvix:repository", Value: l.repositoryFullName }, { Key: "Name", Value: l.runnerName },
    ];
    try {
      const r = await this.o.ec2.send(new RunInstancesCommand({
        LaunchTemplate: { LaunchTemplateId: this.o.launchTemplateId, Version: "$Latest" },
        ImageId: imageId,
        MinCount: 1, MaxCount: 1,
        // One machine per job, even if the queue delivers the job twice: EC2 returns the first launch.
        ClientToken: `fenvix-job-${l.jobId}`,
        UserData: Buffer.from(jobUserData(l, this.o.machineEnv)).toString("base64"),
        TagSpecifications: [{ ResourceType: "instance", Tags: tags }, { ResourceType: "volume", Tags: tags }],
      }));
      const id = r.Instances?.[0]?.InstanceId ?? null;
      this.o.log?.info({ job: l.jobId, instance: id, image: imageId, cache: l.cacheAccess }, "runner machine started");
      return { instanceId: id, already: false };
    } catch (e) {
      // The same token with other parameters (a retry that got a new just-in-time configuration): the machine exists.
      if ((e as { name?: string }).name === "IdempotentParameterMismatch") return { instanceId: null, already: true };
      throw e;
    }
  }
}

/** Terminates per-job machines older than `maxHours` (a job never runs that long; such a machine is stuck). */
export async function reap(ec2: Pick<EC2Client, "send">, maxHours: number, now = Date.now()): Promise<string[]> {
  const r = await ec2.send(new DescribeInstancesCommand({
    Filters: [{ Name: `tag:${ROLE_TAG}`, Values: [ROLE_VALUE] }, { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] }],
  }));
  const old = (r.Reservations ?? []).flatMap((x) => x.Instances ?? [])
    .filter((i) => i.InstanceId && i.LaunchTime && now - new Date(i.LaunchTime).getTime() > maxHours * 3_600_000)
    .map((i) => i.InstanceId!);
  if (old.length) await ec2.send(new TerminateInstancesCommand({ InstanceIds: old }));
  return old;
}
