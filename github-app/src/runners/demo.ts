import { DescribeInstancesCommand, RunInstancesCommand, TerminateInstancesCommand, type EC2Client } from "@aws-sdk/client-ec2";
import { repoPath, type GitHubApp } from "../github/client.ts";
import { signSummaryCredential } from "./credentials.ts";
import { DEMO_VALUE, newestRunnerImage, ROLE_TAG } from "./launcher.ts";

/**
 * Demo mode: one fresh machine per demo. `up` registers one runner (labels self-hosted, fenvix) on a repository the
 * App is installed on and starts one machine from the runner image; `down` deregisters it and terminates the machine.
 * Each demo gets a new machine and a new disk, with the engine's cache local to it, so nothing of one demo is seen by
 * the next. The App, the queue and the dashboard stay up all the time.
 */
export interface DemoDeps {
  gh: Pick<GitHubApp, "app" | "installation">;
  ec2: Pick<EC2Client, "send">;
  launchTemplateId: string;
  /** Plain machine settings (summaries URL, runner-token parameter name, region). */
  machineEnv: Record<string, string>;
  tags?: Record<string, string>;
  now?: () => Date;
  /**
   * The only repositories a demo runner may be registered on (the founder's own: setting demoRepository). The demo
   * function always sets it: our runner on a customer's repository would receive its jobs, their GITHUB_TOKEN and
   * secrets (R-012 F13). Unset only in tests of the other functions.
   */
  allowedRepositories?: string[];
  /** Signs the demo machine's summary credential (RUNNER_TOKEN): bound to its runner name and the repository. */
  summaryKey?: string;
  /** demoMaxHours: the credential lives a day longer than the machine may. */
  maxHours?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DemoMachine { instanceId: string; state: string; launchTime: string | null; repository: string | null; runnerName: string | null }

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SAFE = /^[A-Za-z0-9_./:@+=-]*$/;

export function demoUserData(o: { repository: string; runnerName: string; registrationToken: string; machineEnv: Record<string, string>; summaryToken?: string }): string {
  if (!/^[A-Za-z0-9]+$/.test(o.registrationToken)) throw new Error("unexpected registration token format");
  if (o.summaryToken !== undefined && !/^fxr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(o.summaryToken)) throw new Error("unexpected credential format");
  const common = Object.fromEntries(Object.entries(o.machineEnv).filter(([k]) => !/_TOKEN_PARAM$/.test(k)));
  const env: Record<string, string> = {
    ...common, FENVIX_MODE: "demo", FENVIX_REPO_URL: `https://github.com/${o.repository}`, FENVIX_RUNNER_NAME: o.runnerName,
  };
  const lines = ["#!/bin/bash", "set -euo pipefail", "install -d -m 0755 /etc/fenvix", "cat >/etc/fenvix/runner.env <<'FENVIX_ENV'"];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || !SAFE.test(v)) throw new Error(`machine setting ${k} has characters the env file does not allow`);
    lines.push(`${k}=${v}`);
  }
  // The one-hour token: root only; fenvix-register uses it once and shreds it.
  lines.push("FENVIX_ENV", "umask 077", `printf '%s' '${o.registrationToken}' >/etc/fenvix/registration-token`);
  if (o.summaryToken) lines.push(`printf '%s' '${o.summaryToken}' >/etc/fenvix/summary-token`);
  lines.push("systemctl start --no-block fenvix-summary-poster.service fenvix-runner.service");
  return lines.join("\n") + "\n";
}

async function machines(ec2: DemoDeps["ec2"], states = ["pending", "running", "stopping", "stopped"]): Promise<DemoMachine[]> {
  const r = await ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: `tag:${ROLE_TAG}`, Values: [DEMO_VALUE] }, { Name: "instance-state-name", Values: states }] }));
  return (r.Reservations ?? []).flatMap((x) => x.Instances ?? []).map((i) => {
    const tag = (k: string) => i.Tags?.find((t) => t.Key === k)?.Value ?? null;
    return { instanceId: i.InstanceId!, state: i.State?.Name ?? "unknown", launchTime: i.LaunchTime ? new Date(i.LaunchTime).toISOString() : null, repository: tag("fenvix:repository"), runnerName: tag("Name") };
  });
}

async function installationOf(gh: DemoDeps["gh"], repository: string): Promise<number> {
  const r = await gh.app.request<{ id: number }>("GET", `${repoPath(repository)}/installation`, { allow: [404] });
  if (r.status === 404) throw new Error(`the App is not installed on ${repository}: install it there first`);
  return r.data.id;
}

/** Refuses any repository but the demo repository (when the deps name it). */
function allowed(d: DemoDeps, repository: string): void {
  if (!REPO.test(repository)) throw new Error(`not a repository name: ${repository}`);
  if (d.allowedRepositories && !d.allowedRepositories.some((r) => r.toLowerCase() === repository.toLowerCase())) {
    throw new Error(`${repository} is not the demo repository (${d.allowedRepositories.join(", ") || "none set"}): a demo runner is never registered on another repository`);
  }
}

export async function demoUp(d: DemoDeps, repository: string): Promise<{ instanceId: string; runnerName: string; already: boolean }> {
  allowed(d, repository);
  const running = await machines(d.ec2, ["pending", "running"]);
  if (running.length) {
    const m = running[0]!;
    if (m.repository !== repository) throw new Error(`a demo machine already runs for ${m.repository} (${m.instanceId}): take it down first`);
    return { instanceId: m.instanceId, runnerName: m.runnerName ?? "", already: true };
  }
  const installation = await installationOf(d.gh, repository);
  const gh = d.gh.installation(installation);
  const tok = await gh.request<{ token: string; expires_at: string }>("POST", `${repoPath(repository)}/actions/runners/registration-token`);
  const stamp = (d.now ?? (() => new Date()))().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const runnerName = `fenvix-demo-${stamp}`;
  const imageId = await newestRunnerImage(d.ec2);
  // The machine's own summary credential: this runner name, this repository (any run of it), for demoMaxHours + 24 h.
  let summaryToken: string | undefined;
  if (d.summaryKey) {
    const repositoryId = (await gh.request<{ id: number }>("GET", repoPath(repository))).data.id;
    const nowS = Math.floor((d.now ?? (() => new Date()))().getTime() / 1000);
    summaryToken = signSummaryCredential(d.summaryKey, { runnerName, repositoryId, exp: nowS + ((d.maxHours ?? 12) + 24) * 3600 });
  }
  const tags = [
    ...Object.entries(d.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
    { Key: ROLE_TAG, Value: DEMO_VALUE }, { Key: "fenvix:repository", Value: repository }, { Key: "Name", Value: runnerName },
  ];
  const r = await d.ec2.send(new RunInstancesCommand({
    LaunchTemplate: { LaunchTemplateId: d.launchTemplateId, Version: "$Latest" },
    ImageId: imageId, MinCount: 1, MaxCount: 1,
    UserData: Buffer.from(demoUserData({ repository, runnerName, registrationToken: tok.data.token, machineEnv: d.machineEnv, ...(summaryToken ? { summaryToken } : {}) })).toString("base64"),
    TagSpecifications: [{ ResourceType: "instance", Tags: tags }, { ResourceType: "volume", Tags: tags }],
  }));
  return { instanceId: r.Instances?.[0]?.InstanceId ?? "", runnerName, already: false };
}

interface Runner { id: number; name: string; status: string; busy: boolean }

async function demoRunners(d: DemoDeps, repository: string): Promise<{ gh: ReturnType<DemoDeps["gh"]["installation"]>; runners: Runner[] }> {
  const gh = d.gh.installation(await installationOf(d.gh, repository));
  const r = await gh.request<{ runners: Runner[] }>("GET", `${repoPath(repository)}/actions/runners`, { query: { per_page: 100 } });
  return { gh, runners: r.data.runners.filter((x) => x.name.startsWith("fenvix-demo-")) };
}

export async function demoStatus(d: DemoDeps, repository: string | null): Promise<{ machines: DemoMachine[]; runners: Runner[] }> {
  if (repository) allowed(d, repository);
  const ms = await machines(d.ec2);
  const repo = repository ?? ms[0]?.repository ?? null;
  const runners = repo ? (await demoRunners(d, repo)).runners : [];
  return { machines: ms, runners };
}

/**
 * Terminates every demo machine, waits until they are gone, then deregisters every fenvix-demo-* runner of the
 * repository (R-012 F6). In that order: GitHub refuses (422) to delete a runner that is running a job, and a
 * non-ephemeral runner stays registered (offline) for days after its machine is gone, so deleting first left it behind
 * whenever a job was running. A 422 is retried while the job's end reaches GitHub (up to `retryMs`).
 */
export async function demoDown(d: DemoDeps, repository: string | null, o: { waitMs?: number; retryMs?: number } = {}): Promise<{ deregistered: string[]; terminated: string[]; problems: string[] }> {
  if (repository) allowed(d, repository);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ms = await machines(d.ec2);
  const repos = new Set([...(repository ? [repository] : []), ...ms.map((m) => m.repository).filter((x): x is string => !!x && REPO.test(x))]);
  const problems: string[] = [];
  const ids = ms.filter((m) => m.state !== "terminated").map((m) => m.instanceId);
  if (ids.length) {
    await d.ec2.send(new TerminateInstancesCommand({ InstanceIds: ids }));
    const until = Date.now() + (o.waitMs ?? 90_000);
    for (;;) {
      const left = (await machines(d.ec2, ["pending", "running", "stopping", "stopped", "shutting-down"])).filter((m) => ids.includes(m.instanceId));
      if (!left.length) break;
      if (Date.now() > until) { problems.push(`still shutting down: ${left.map((m) => m.instanceId).join(", ")}`); break; }
      await sleep(5_000);
    }
  }
  const deregistered: string[] = [];
  for (const repo of repos) {
    try {
      deregistered.push(...await deregisterDemoRunners(d, repo, { retryMs: o.retryMs ?? 60_000, sleep, problems }));
    } catch (e) {
      problems.push(`${repo}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { deregistered, terminated: ids, problems };
}

/** Deletes the repository's fenvix-demo-* runners (only `names`, when given), retrying "busy" (422) for `retryMs`. */
export async function deregisterDemoRunners(d: DemoDeps, repo: string, o: { names?: string[]; retryMs?: number; sleep?: (ms: number) => Promise<void>; problems?: string[] } = {}): Promise<string[]> {
  const sleep = o.sleep ?? d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = Date.now() + (o.retryMs ?? 0);
  const done: string[] = [];
  for (;;) {
    const { gh, runners } = await demoRunners(d, repo);
    const todo = runners.filter((x) => !o.names || o.names.includes(x.name));
    const busy: string[] = [];
    for (const x of todo) {
      const del = await gh.request("DELETE", `${repoPath(repo)}/actions/runners/${x.id}`, { allow: [404, 422] });
      if (del.status === 422) busy.push(x.name);
      else done.push(x.name);
    }
    if (!busy.length) return done;
    if (Date.now() > until) {
      o.problems?.push(`${busy.join(", ")} still busy on GitHub: the reaper deregisters it within the hour`);
      return done;
    }
    await sleep(5_000);
  }
}

/**
 * The reaper's second job in demo mode: the runners of demo machines that are gone (terminated by demo-down or by the
 * reaper; EC2 lists terminated machines for about an hour, and the reaper runs every 10 minutes).
 */
export async function deregisterGoneDemoRunners(d: DemoDeps): Promise<string[]> {
  const gone = await machines(d.ec2, ["shutting-down", "terminated"]);
  const byRepo = new Map<string, string[]>();
  for (const m of gone) if (m.repository && REPO.test(m.repository) && m.runnerName) byRepo.set(m.repository, [...(byRepo.get(m.repository) ?? []), m.runnerName]);
  const out: string[] = [];
  for (const [repo, names] of byRepo) out.push(...await deregisterDemoRunners(d, repo, { names }));
  return out;
}
