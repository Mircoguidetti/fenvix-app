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
  /** "none": skip with proof is off or paused for the project (no cache token is given; every test runs). */
  cacheAccess: "write" | "read" | "none";
  /** This machine's summary credential: bound to runnerName, repositoryId and runId (credentials.ts). */
  summaryToken?: string;
  /** This job's shared-cache token: its installation's cache organization only, write only if cacheAccess is "write". */
  cacheToken?: string;
  /** The organization's region: the machine starts there or not at all (default "us"). */
  region?: Region;
  /** The organization's mode, given to the machine as FENVIX_MODE (default "enforce"). */
  mode?: RunMode;
}

/**
 * A warm-up machine (src/warmup/): it runs the repository's test job, from the customer's own workflow file at one
 * default-branch commit, outside GitHub Actions, to fill the shared cache. No just-in-time runner: nothing is reported
 * to GitHub. docs/data-contract.md "Warm-up runs" is what the machine receives and sends.
 */
export interface WarmupLaunch {
  warmupId: number;
  /** Machines requested for this warm-up so far, this one included (a new machine after a preemption). */
  attempt: number;
  repositoryId: number;
  repositoryFullName: string;
  installationId: number;
  commitSha: string;
  /** refs/heads/<default branch> */
  ref: string;
  /** The workflow file and the job id the setup pull request moved to runs-on: fenvix. */
  workflowPath: string;
  job: string;
  runnerName: string;
  /** Read-only installation token for this one repository (contents: read), for the checkout. Expires in an hour. */
  checkoutToken: string;
  /** This machine's App credential, for POST /v1/runner/warmups only (credentials.ts, warmupId). */
  summaryToken: string;
  /** Shared-cache token, write access (the default branch of the repository itself is a trusted ref). */
  cacheToken?: string;
  region: Region;
}

/**
 * A task machine (src/tasks/): a replay of one defect (`fenvix replay` of its bundle at a commit) or one exploration
 * (`detpy explore` under a time cap and a seed budget) of a repository, on our machines, outside GitHub Actions.
 * docs/data-contract.md "Replays and explorations on our machines" is what the machine receives and sends.
 */
export interface TaskLaunch {
  kind: "replay" | "exploration";
  /** ci_replays.id or ci_exploration_jobs.id (a UUID). */
  taskId: string;
  attempt: number;
  repositoryId: number;
  repositoryFullName: string;
  installationId: number;
  commitSha: string;
  runnerName: string;
  /** Read-only installation token for this one repository (contents: read), for the checkout. */
  checkoutToken: string;
  /** This machine's App credential: POST /v1/runner/replays or /v1/runner/explorations for this task only. */
  summaryToken: string;
  region: Region;
  /** The task's description (/etc/fenvix/task.json). */
  spec: Record<string, unknown>;
}

export interface RunnerLauncher {
  launch(l: RunnerLaunch): Promise<{ instanceId: string | null; already: boolean }>;
  /** False while the fleet (of that region) is at its limit: no just-in-time runner is registered for a job that gets no machine. */
  hasCapacity?(region?: Region): Promise<boolean>;
  /** False when no machine can be placed in that region (no placement configured): the job gets no machine at all. */
  canPlace?(region: Region): boolean;
  /** Warm-ups: the region's machines (jobs and warm-ups) and its limit. Absent: no warm-ups. */
  slots?(region: Region): Promise<{ running: number; warmups: number; max: number }>;
  launchWarmup?(w: WarmupLaunch): Promise<{ instanceId: string | null; already: boolean }>;
  /** Terminates the warm-up's machines in that region (superseded, cancelled, preempted). Returns the instance ids. */
  terminateWarmup?(region: Region, warmupId: number): Promise<string[]>;
  /** Replays and explorations (src/tasks/). Absent: they wait as requested. */
  launchTask?(t: TaskLaunch): Promise<{ instanceId: string | null; already: boolean }>;
  /** Ends a task's machines (cancelled). */
  terminateTask?(region: Region, taskId: string): Promise<string[]>;
  /** Ends the machine of one job's runner (a run stopped from the dashboard). */
  terminateRunner?(region: Region, runnerName: string): Promise<string[]>;
}

const TASK_TAG = "fenvix:task";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A task machine's user data: the plain settings, the task's description, its credentials, then fenvix-task.target. */
export function taskUserData(t: TaskLaunch, machineEnv: Record<string, string>): string {
  if (!UUID.test(t.taskId)) throw new Error("the task id is not a UUID");
  if (!/^[0-9a-f]{40}$/.test(t.commitSha)) throw new Error("the task's commit is not a SHA");
  if (!FULL_NAME.test(t.repositoryFullName)) throw new Error("the task's repository is not owner/name");
  if (!INSTALLATION_TOKEN.test(t.checkoutToken)) throw new Error("unexpected checkout token format");
  if (!TOKEN.test(t.summaryToken)) throw new Error("unexpected credential format");
  const spec = Buffer.from(JSON.stringify({
    v: 1, kind: t.kind, taskId: t.taskId, attempt: t.attempt, repository: { id: t.repositoryId, fullName: t.repositoryFullName },
    installationId: t.installationId, commitSha: t.commitSha, ...t.spec,
  })).toString("base64");
  const common = Object.fromEntries(Object.entries(machineEnv).filter(([k]) => !/_TOKEN_PARAM$/.test(k)));
  const env: Record<string, string> = {
    ...common, FENVIX_MACHINE: "per-job", FENVIX_KIND: t.kind, FENVIX_MODE: "enforce", FENVIX_REGION: t.region,
    FENVIX_RUNNER_NAME: t.runnerName, FENVIX_TASK_ID: t.taskId, FENVIX_CACHE_ACCESS: "none",
  };
  if (common.FENVIX_SUMMARIES_URL) env.FENVIX_TASK_URL = new URL(t.kind === "replay" ? "replays" : "explorations", common.FENVIX_SUMMARIES_URL).toString();
  const lines = ["#!/bin/bash", "set -euo pipefail", "umask 022", "install -d -m 0755 /etc/fenvix", "cat >/etc/fenvix/runner.env <<'FENVIX_ENV'"];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || !SAFE.test(v)) throw new Error(`machine setting ${k} has characters the env file does not allow`);
    lines.push(`${k}=${v}`);
  }
  lines.push("FENVIX_ENV", "umask 077", `printf '%s' '${spec}' | base64 -d >/etc/fenvix/task.json`,
    `printf '%s' '${t.checkoutToken}' >/etc/fenvix/checkout-token`, `printf '%s' '${t.summaryToken}' >/etc/fenvix/summary-token`,
    "systemctl start --no-block fenvix-task.target");
  return lines.join("\n") + "\n";
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
/** What a per-job machine runs: a customer's GitHub job, or a warm-up (the worker may terminate only the latter). */
export const KIND_TAG = "fenvix:kind";
export const WARMUP_TAG = "fenvix:warmup";

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

const WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9._/-]{1,200}\.ya?ml$/;
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const INSTALLATION_TOKEN = /^ghs_[A-Za-z0-9]{20,255}$/;

/** The warm-up's description the machine reads (/etc/fenvix/warmup.json, root only; docs/data-contract.md). */
export function warmupSpec(w: WarmupLaunch): Record<string, unknown> {
  if (!/^[0-9a-f]{40}$/.test(w.commitSha)) throw new Error("the warm-up's commit is not a SHA");
  if (!/^refs\/heads\/[A-Za-z0-9._/-]{1,250}$/.test(w.ref) || w.ref.includes("..")) throw new Error("the warm-up's ref is not a branch");
  if (!WORKFLOW.test(w.workflowPath) || w.workflowPath.includes("..")) throw new Error("the warm-up's workflow path is not a workflow file");
  if (!JOB_ID.test(w.job)) throw new Error("the warm-up's job is not a job id");
  if (!FULL_NAME.test(w.repositoryFullName)) throw new Error("the warm-up's repository is not owner/name");
  return {
    v: 1, warmupId: w.warmupId, attempt: w.attempt,
    repository: { id: w.repositoryId, fullName: w.repositoryFullName },
    installationId: w.installationId, commitSha: w.commitSha, ref: w.ref,
    workflowPath: w.workflowPath, job: w.job,
  };
}

/**
 * A warm-up machine's user data: the same plain settings as a job's machine, the warm-up's description, its
 * credentials (no just-in-time configuration: the machine is no GitHub runner), then fenvix-warmup.target.
 */
export function warmupUserData(w: WarmupLaunch, machineEnv: Record<string, string>): string {
  const spec = Buffer.from(JSON.stringify(warmupSpec(w))).toString("base64");
  if (!INSTALLATION_TOKEN.test(w.checkoutToken)) throw new Error("unexpected checkout token format");
  for (const t of [w.summaryToken, w.cacheToken]) if (t !== undefined && !TOKEN.test(t)) throw new Error("unexpected credential format");
  const common = Object.fromEntries(Object.entries(machineEnv).filter(([k]) => !/_TOKEN_PARAM$/.test(k)));
  const env: Record<string, string> = {
    ...common,
    FENVIX_MACHINE: "per-job",
    FENVIX_KIND: "warmup",
    // A warm-up fills the cache: skip with proof what is already proven, run the rest, write the results.
    FENVIX_MODE: "enforce",
    FENVIX_REGION: w.region,
    FENVIX_RUNNER_NAME: w.runnerName,
    FENVIX_WARMUP_ID: String(w.warmupId),
    FENVIX_CACHE_ACCESS: "write",
  };
  if (common.FENVIX_SUMMARIES_URL) env.FENVIX_WARMUPS_URL = new URL("warmups", common.FENVIX_SUMMARIES_URL).toString();
  if (common.FENVIX_CACHE_URL) {
    const org = cacheOrgOf(w.installationId);
    env.FENVIX_CACHE_URL = `${new URL(common.FENVIX_CACHE_URL).origin}/${org}`;
    env.FENVIX_CACHE_ORG = org;
  }
  const lines = ["#!/bin/bash", "set -euo pipefail", "umask 022", "install -d -m 0755 /etc/fenvix", "cat >/etc/fenvix/runner.env <<'FENVIX_ENV'"];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || !SAFE.test(v)) throw new Error(`machine setting ${k} has characters the env file does not allow`);
    lines.push(`${k}=${v}`);
  }
  lines.push("FENVIX_ENV", "umask 077", `printf '%s' '${spec}' | base64 -d >/etc/fenvix/warmup.json`,
    `printf '%s' '${w.checkoutToken}' >/etc/fenvix/checkout-token`, `printf '%s' '${w.summaryToken}' >/etc/fenvix/summary-token`);
  if (w.cacheToken && env.FENVIX_CACHE_URL) lines.push(`printf '%s' '${w.cacheToken}' >/etc/fenvix/cache-token`);
  lines.push("systemctl start --no-block fenvix-warmup.target");
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

  async slots(region: Region): Promise<{ running: number; warmups: number; max: number }> {
    const r = await this.placement(region).ec2.send(new DescribeInstancesCommand({
      Filters: [{ Name: `tag:${ROLE_TAG}`, Values: [ROLE_VALUE] }, { Name: "instance-state-name", Values: ["pending", "running"] }],
    }));
    const all = (r.Reservations ?? []).flatMap((x) => x.Instances ?? []);
    const warmups = all.filter((i) => (i.Tags ?? []).some((t) => t.Key === KIND_TAG && t.Value === "warmup")).length;
    return { running: all.length, warmups, max: this.o.maxRunning };
  }

  async launchWarmup(w: WarmupLaunch): Promise<{ instanceId: string | null; already: boolean }> {
    const p = this.placement(w.region);
    const n = await this.running(w.region);
    if (n >= this.o.maxRunning) throw new RetryLater(`${n} fenvix machines are running in ${w.region} (limit ${this.o.maxRunning}); warm-up ${w.warmupId} waits`);
    const imageId = await this.imageId(w.region);
    const tags = [
      ...Object.entries(this.o.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
      { Key: ROLE_TAG, Value: ROLE_VALUE }, { Key: KIND_TAG, Value: "warmup" }, { Key: WARMUP_TAG, Value: String(w.warmupId) },
      { Key: "fenvix:repository", Value: w.repositoryFullName }, { Key: "fenvix:region", Value: w.region }, { Key: "Name", Value: w.runnerName },
    ];
    try {
      const r = await p.ec2.send(new RunInstancesCommand({
        LaunchTemplate: { LaunchTemplateId: p.launchTemplateId, Version: "$Latest" },
        ImageId: imageId,
        MinCount: 1, MaxCount: 1,
        // One machine per warm-up attempt, even if the tick runs twice.
        ClientToken: `fenvix-warmup-${w.warmupId}-${w.attempt}`,
        UserData: Buffer.from(warmupUserData(w, { ...this.o.machineEnv, ...(p.machineEnv ?? {}) })).toString("base64"),
        TagSpecifications: [{ ResourceType: "instance", Tags: tags }, { ResourceType: "volume", Tags: tags }],
      }));
      const id = r.Instances?.[0]?.InstanceId ?? null;
      this.o.log?.info({ warmup: w.warmupId, instance: id, image: imageId, region: w.region, awsRegion: p.awsRegion ?? null }, "warm-up machine started");
      return { instanceId: id, already: false };
    } catch (e) {
      if ((e as { name?: string }).name === "IdempotentParameterMismatch") return { instanceId: null, already: true };
      throw e;
    }
  }

  async terminateWarmup(region: Region, warmupId: number): Promise<string[]> {
    const p = this.placement(region);
    const r = await p.ec2.send(new DescribeInstancesCommand({
      Filters: [{ Name: `tag:${ROLE_TAG}`, Values: [ROLE_VALUE] }, { Name: `tag:${KIND_TAG}`, Values: ["warmup"] },
        { Name: `tag:${WARMUP_TAG}`, Values: [String(warmupId)] }, { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] }],
    }));
    const ids = (r.Reservations ?? []).flatMap((x) => x.Instances ?? []).map((i) => i.InstanceId).filter((x): x is string => !!x);
    if (ids.length) await p.ec2.send(new TerminateInstancesCommand({ InstanceIds: ids }));
    return ids;
  }

  async launchTask(t: TaskLaunch): Promise<{ instanceId: string | null; already: boolean }> {
    const p = this.placement(t.region);
    const n = await this.running(t.region);
    if (n >= this.o.maxRunning) throw new RetryLater(`${n} fenvix machines are running in ${t.region} (limit ${this.o.maxRunning}); ${t.kind} ${t.taskId} waits`);
    const imageId = await this.imageId(t.region);
    const tags = [
      ...Object.entries(this.o.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
      { Key: ROLE_TAG, Value: ROLE_VALUE }, { Key: KIND_TAG, Value: t.kind }, { Key: TASK_TAG, Value: t.taskId },
      { Key: "fenvix:repository", Value: t.repositoryFullName }, { Key: "fenvix:region", Value: t.region }, { Key: "Name", Value: t.runnerName },
    ];
    try {
      const r = await p.ec2.send(new RunInstancesCommand({
        LaunchTemplate: { LaunchTemplateId: p.launchTemplateId, Version: "$Latest" }, ImageId: imageId, MinCount: 1, MaxCount: 1,
        ClientToken: `fenvix-${t.kind}-${t.taskId}-${t.attempt}`.slice(0, 64),
        UserData: Buffer.from(taskUserData(t, { ...this.o.machineEnv, ...(p.machineEnv ?? {}) })).toString("base64"),
        TagSpecifications: [{ ResourceType: "instance", Tags: tags }, { ResourceType: "volume", Tags: tags }],
      }));
      return { instanceId: r.Instances?.[0]?.InstanceId ?? null, already: false };
    } catch (e) {
      if ((e as { name?: string }).name === "IdempotentParameterMismatch") return { instanceId: null, already: true };
      throw e;
    }
  }

  private async terminateBy(region: Region, filters: { Name: string; Values: string[] }[]): Promise<string[]> {
    const p = this.placement(region);
    const r = await p.ec2.send(new DescribeInstancesCommand({
      Filters: [{ Name: `tag:${ROLE_TAG}`, Values: [ROLE_VALUE] }, ...filters, { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] }],
    }));
    const ids = (r.Reservations ?? []).flatMap((x) => x.Instances ?? []).map((i) => i.InstanceId).filter((x): x is string => !!x);
    if (ids.length) await p.ec2.send(new TerminateInstancesCommand({ InstanceIds: ids }));
    return ids;
  }

  terminateTask(region: Region, taskId: string): Promise<string[]> { return this.terminateBy(region, [{ Name: `tag:${TASK_TAG}`, Values: [taskId] }]); }

  terminateRunner(region: Region, runnerName: string): Promise<string[]> { return this.terminateBy(region, [{ Name: "tag:Name", Values: [runnerName] }]); }

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
