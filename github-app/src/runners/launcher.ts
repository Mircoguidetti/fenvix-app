import { DescribeImagesCommand, DescribeInstancesCommand, EC2Client, RunInstancesCommand, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { cacheOrgOf } from "./credentials.ts";

/**
 * "One machine per job": when GitHub queues a job with the fenvix label, the App asks GitHub for a just-in-time runner
 * configuration (one runner, one job) and starts one machine with it. The runner takes a job, the machine powers off
 * when it ends and AWS terminates it (shutdown behaviour "terminate"). A machine that never got a job powers off after
 * an idle limit (on the machine), and the reaper terminates anything older than the hard limit.
 */
/** Where an organization's data and machines live (workspaces.region). */
export type Region = "us" | "eu";
export const REGIONS: readonly Region[] = ["us", "eu"];
/** shadow: the 30-day trial (every test runs; the engine records what it would have skipped). enforce: skip with proof. */
export type RunMode = "shadow" | "enforce";

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
  /** This machine's summary credential: bound to runnerName, repositoryId and runId (credentials.ts). */
  summaryToken?: string;
  /** This job's shared-cache token: its installation's cache organization only, write only if cacheAccess is "write". */
  cacheToken?: string;
  /** The organization's region: the machine starts there or not at all (default "us"). */
  region?: Region;
  /** The organization's mode, given to the machine as FENVIX_MODE (default "enforce"). */
  mode?: RunMode;
}

export interface RunnerLauncher {
  launch(l: RunnerLaunch): Promise<{ instanceId: string | null; already: boolean }>;
  /** False while the fleet (of that region) is at its limit: no just-in-time runner is registered for a job that gets no machine. */
  hasCapacity?(region?: Region): Promise<boolean>;
  /** False when no machine can be placed in that region (no placement configured): the job gets no machine at all. */
  canPlace?(region: Region): boolean;
}

/** No placement for the organization's region: the job is never started elsewhere. */
export class NoPlacement extends Error {}

/** Thrown when the fleet is at its limit: the queue retries the job later. */
export class RetryLater extends Error {}

/** The tag every per-job machine carries (the reaper and the IAM conditions use it). */
export const ROLE_TAG = "fenvix:role";
export const ROLE_VALUE = "runner-job";
/** Demo machines (scripts/demo-up.sh): one registered runner for a demo, terminated by demo-down. */
export const DEMO_VALUE = "runner-demo";
export const IMAGE_TAG = "fenvix:image";

const SAFE = /^[A-Za-z0-9_./:@+=-]*$/;
const TOKEN = /^fx[rs]1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * The machine's per-job settings and credentials, written by its user data (root only; the job user cannot reach the
 * metadata service), then the services start. FENVIX_MODE is the organization's run mode (shadow during the 30-day
 * trial, else enforce) and FENVIX_REGION its region; the runner reads both (docs/data-contract.md). The shared cache is this installation's organization (gh-<id>): two
 * customers' jobs never share a cache credential or namespace (R-012 F3).
 */
export function jobUserData(l: RunnerLaunch, machineEnv: Record<string, string>): string {
  if (!/^[A-Za-z0-9+/=]+$/.test(l.jitConfig)) throw new Error("the just-in-time configuration is not base64");
  for (const t of [l.summaryToken, l.cacheToken]) if (t !== undefined && !TOKEN.test(t)) throw new Error("unexpected credential format");
  // Older settings named SSM parameters the machine read with its role; a machine reads no parameter now.
  const common = Object.fromEntries(Object.entries(machineEnv).filter(([k]) => !/_TOKEN_PARAM$/.test(k)));
  const env: Record<string, string> = {
    ...common,
    // The kind of machine (it was FENVIX_MODE before 2026-11-18); FENVIX_MODE is now the run mode of the trial.
    FENVIX_MACHINE: "per-job",
    FENVIX_MODE: l.mode ?? "enforce",
    FENVIX_REGION: l.region ?? "us",
    FENVIX_RUNNER_NAME: l.runnerName,
    FENVIX_JOB_ID: String(l.jobId),
    FENVIX_CACHE_ACCESS: l.cacheAccess,
  };
  if (common.FENVIX_CACHE_URL) {
    const org = cacheOrgOf(l.installationId);
    env.FENVIX_CACHE_URL = `${new URL(common.FENVIX_CACHE_URL).origin}/${org}`;
    env.FENVIX_CACHE_ORG = org;
  }
  const lines = ["#!/bin/bash", "set -euo pipefail", "umask 022", "install -d -m 0755 /etc/fenvix", "cat >/etc/fenvix/runner.env <<'FENVIX_ENV'"];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || !SAFE.test(v)) throw new Error(`machine setting ${k} has characters the env file does not allow`);
    lines.push(`${k}=${v}`);
  }
  lines.push("FENVIX_ENV", "umask 077", `printf '%s' '${l.jitConfig}' >/etc/fenvix/jitconfig`);
  if (l.summaryToken) lines.push(`printf '%s' '${l.summaryToken}' >/etc/fenvix/summary-token`);
  if (l.cacheToken && env.FENVIX_CACHE_URL) lines.push(`printf '%s' '${l.cacheToken}' >/etc/fenvix/cache-token`);
  lines.push("systemctl start --no-block fenvix-job.target");
  return lines.join("\n") + "\n";
}

/** Where one region's machines start: its AWS region's EC2 client and launch template (and settings of its own). */
export interface Placement {
  ec2: Pick<EC2Client, "send">;
  launchTemplateId: string;
  /** The AWS region (e.g. eu-central-1); informational, the client is already in it. */
  awsRegion?: string;
  /** Machine settings that differ in this region (e.g. its own shared cache URL); added over the common ones. */
  machineEnv?: Record<string, string>;
}

export interface Ec2LauncherOptions {
  /** The "us" placement in the older form (one region): its EC2 client and launch template. */
  ec2?: Pick<EC2Client, "send">;
  launchTemplateId?: string;
  /** One placement per region (RUNNER_PLACEMENT). A region without one gets no machine. */
  placements?: Partial<Record<Region, Placement>>;
  /** At most this many per-job machines pending or running at once, per region. */
  maxRunning: number;
  /** Plain settings every machine needs (summaries URL, parameter names, region, cache URL). */
  machineEnv: Record<string, string>;
  /** Tags copied onto every machine (project, env). */
  tags?: Record<string, string>;
  log?: { info(o: object, msg?: string): void };
  now?: () => number;
}

const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const LAUNCH_TEMPLATE = /^lt-[A-Za-z0-9]+$/;

/**
 * The placements of RUNNER_PLACEMENT, e.g. `{"us": {"awsRegion": "us-east-1", "launchTemplateId": "lt-0abc"}, "eu":
 * {"awsRegion": "eu-central-1", "launchTemplateId": "lt-0def"}}` (set by the infrastructure). Without a "us" entry,
 * RUNNER_LAUNCH_TEMPLATE_ID (if set) is the "us" placement, in the function's own AWS region.
 */
export function placementsFromEnv(env: Record<string, string | undefined>, ec2For: (awsRegion: string | undefined) => Pick<EC2Client, "send"> = (r) => new EC2Client(r ? { region: r } : {})): Partial<Record<Region, Placement>> {
  const out: Partial<Record<Region, Placement>> = {};
  if (env.RUNNER_PLACEMENT && env.RUNNER_PLACEMENT.trim()) {
    let raw: unknown;
    try { raw = JSON.parse(env.RUNNER_PLACEMENT); } catch { throw new Error("RUNNER_PLACEMENT is not JSON"); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("RUNNER_PLACEMENT must be an object by region (us, eu)");
    for (const [region, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!REGIONS.includes(region as Region)) throw new Error(`RUNNER_PLACEMENT: unknown region "${region}" (us, eu)`);
      const p = v as { awsRegion?: unknown; launchTemplateId?: unknown; machineEnv?: unknown } | null;
      if (!p || typeof p !== "object" || typeof p.awsRegion !== "string" || !AWS_REGION.test(p.awsRegion)) throw new Error(`RUNNER_PLACEMENT.${region}.awsRegion must be an AWS region`);
      if (typeof p.launchTemplateId !== "string" || !LAUNCH_TEMPLATE.test(p.launchTemplateId)) throw new Error(`RUNNER_PLACEMENT.${region}.launchTemplateId must be a launch template id (lt-...)`);
      let machineEnv: Record<string, string> | undefined;
      if (p.machineEnv !== undefined) {
        if (!p.machineEnv || typeof p.machineEnv !== "object" || Object.values(p.machineEnv).some((x) => typeof x !== "string")) throw new Error(`RUNNER_PLACEMENT.${region}.machineEnv must be an object of strings`);
        machineEnv = p.machineEnv as Record<string, string>;
      }
      out[region as Region] = { ec2: ec2For(p.awsRegion), launchTemplateId: p.launchTemplateId, awsRegion: p.awsRegion, ...(machineEnv ? { machineEnv } : {}) };
    }
  }
  if (!out.us && env.RUNNER_LAUNCH_TEMPLATE_ID) out.us = { ec2: ec2For(undefined), launchTemplateId: env.RUNNER_LAUNCH_TEMPLATE_ID };
  return out;
}

export class Ec2Launcher implements RunnerLauncher {
  private readonly o: Ec2LauncherOptions;
  private readonly placements: Partial<Record<Region, Placement>>;
  private readonly images = new Map<Region, { id: string; at: number }>();

  constructor(o: Ec2LauncherOptions) {
    this.o = o;
    this.placements = o.placements ?? (o.ec2 && o.launchTemplateId ? { us: { ec2: o.ec2, launchTemplateId: o.launchTemplateId } } : {});
  }

  canPlace(region: Region): boolean { return !!this.placements[region]; }

  private placement(region: Region): Placement {
    const p = this.placements[region];
    if (!p) throw new NoPlacement(`no runner placement for region ${region}: the job gets no machine`);
    return p;
  }

  /** The newest runner image of the region, looked up at most every 5 minutes (images are per AWS region). */
  async imageId(region: Region = "us"): Promise<string> {
    const now = (this.o.now ?? Date.now)();
    const have = this.images.get(region);
    if (have && now - have.at < 5 * 60_000) return have.id;
    const id = await newestRunnerImage(this.placement(region).ec2);
    this.images.set(region, { id, at: now });
    return id;
  }

  async running(region: Region = "us"): Promise<number> {
    const r = await this.placement(region).ec2.send(new DescribeInstancesCommand({
      Filters: [{ Name: `tag:${ROLE_TAG}`, Values: [ROLE_VALUE] }, { Name: "instance-state-name", Values: ["pending", "running"] }],
    }));
    return (r.Reservations ?? []).reduce((n, x) => n + (x.Instances?.length ?? 0), 0);
  }

  async hasCapacity(region: Region = "us"): Promise<boolean> {
    return (await this.running(region)) < this.o.maxRunning;
  }

  async launch(l: RunnerLaunch): Promise<{ instanceId: string | null; already: boolean }> {
    const region = l.region ?? "us";
    const p = this.placement(region);
    const n = await this.running(region);
    if (n >= this.o.maxRunning) throw new RetryLater(`${n} fenvix machines are running in ${region} (limit ${this.o.maxRunning}); job ${l.jobId} waits`);
    const imageId = await this.imageId(region);
    const tags = [
      ...Object.entries(this.o.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
      { Key: ROLE_TAG, Value: ROLE_VALUE }, { Key: "fenvix:job", Value: String(l.jobId) },
      { Key: "fenvix:repository", Value: l.repositoryFullName }, { Key: "fenvix:region", Value: region }, { Key: "Name", Value: l.runnerName },
    ];
    try {
      const r = await p.ec2.send(new RunInstancesCommand({
        LaunchTemplate: { LaunchTemplateId: p.launchTemplateId, Version: "$Latest" },
        ImageId: imageId,
        MinCount: 1, MaxCount: 1,
        // One machine per job, even if the queue delivers the job twice: EC2 returns the first launch.
        ClientToken: `fenvix-job-${l.jobId}`,
        UserData: Buffer.from(jobUserData({ ...l, region }, { ...this.o.machineEnv, ...(p.machineEnv ?? {}) })).toString("base64"),
        TagSpecifications: [{ ResourceType: "instance", Tags: tags }, { ResourceType: "volume", Tags: tags }],
      }));
      const id = r.Instances?.[0]?.InstanceId ?? null;
      this.o.log?.info({ job: l.jobId, instance: id, image: imageId, cache: l.cacheAccess, region, awsRegion: p.awsRegion ?? null, mode: l.mode ?? "enforce" }, "runner machine started");
      return { instanceId: id, already: false };
    } catch (e) {
      // The same token with other parameters (a retry that got a new just-in-time configuration): the machine exists.
      if ((e as { name?: string }).name === "IdempotentParameterMismatch") return { instanceId: null, already: true };
      throw e;
    }
  }
}

/** The newest runner image this account built (EC2 Image Builder tags it fenvix:image=runner). */
export async function newestRunnerImage(ec2: Pick<EC2Client, "send">): Promise<string> {
  const r = await ec2.send(new DescribeImagesCommand({ Owners: ["self"], Filters: [{ Name: `tag:${IMAGE_TAG}`, Values: ["runner"] }, { Name: "state", Values: ["available"] }] }));
  const newest = (r.Images ?? []).filter((i) => i.ImageId).sort((a, b) => String(b.CreationDate).localeCompare(String(a.CreationDate)))[0];
  if (!newest?.ImageId) throw new Error("no runner image yet: run the image pipeline (scripts/build-image.sh, docs/DEPLOY-AWS.md)");
  return newest.ImageId;
}

/**
 * Terminates machines carrying `fenvix:role=<role>` older than `maxHours`: a per-job machine that never finished, a
 * demo machine somebody forgot to take down.
 */
export async function reap(ec2: Pick<EC2Client, "send">, maxHours: number, now = Date.now(), role: string = ROLE_VALUE): Promise<string[]> {
  const r = await ec2.send(new DescribeInstancesCommand({
    Filters: [{ Name: `tag:${ROLE_TAG}`, Values: [role] }, { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] }],
  }));
  const old = (r.Reservations ?? []).flatMap((x) => x.Instances ?? [])
    .filter((i) => i.InstanceId && i.LaunchTime && now - new Date(i.LaunchTime).getTime() > maxHours * 3_600_000)
    .map((i) => i.InstanceId!);
  if (old.length) await ec2.send(new TerminateInstancesCommand({ InstanceIds: old }));
  return old;
}
