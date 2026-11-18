import { DescribeInstancesCommand, RunInstancesCommand, TerminateInstancesCommand, type EC2Client } from "@aws-sdk/client-ec2";
import { repoPath, type GitHubApp } from "../github/client.ts";
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
}

export interface DemoMachine { instanceId: string; state: string; launchTime: string | null; repository: string | null; runnerName: string | null }

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SAFE = /^[A-Za-z0-9_./:@+=-]*$/;

export function demoUserData(o: { repository: string; runnerName: string; registrationToken: string; machineEnv: Record<string, string> }): string {
  if (!/^[A-Za-z0-9]+$/.test(o.registrationToken)) throw new Error("unexpected registration token format");
  const env: Record<string, string> = {
    ...o.machineEnv, FENVIX_MODE: "demo", FENVIX_REPO_URL: `https://github.com/${o.repository}`, FENVIX_RUNNER_NAME: o.runnerName,
  };
  const lines = ["#!/bin/bash", "set -euo pipefail", "install -d -m 0755 /etc/fenvix", "cat >/etc/fenvix/runner.env <<'FENVIX_ENV'"];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || !SAFE.test(v)) throw new Error(`machine setting ${k} has characters the env file does not allow`);
    lines.push(`${k}=${v}`);
  }
  // The one-hour token: root only; fenvix-register uses it once and shreds it.
  lines.push("FENVIX_ENV", "umask 077", `printf '%s' '${o.registrationToken}' >/etc/fenvix/registration-token`,
    "systemctl start --no-block fenvix-summary-poster.service fenvix-runner.service");
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

export async function demoUp(d: DemoDeps, repository: string): Promise<{ instanceId: string; runnerName: string; already: boolean }> {
  if (!REPO.test(repository)) throw new Error(`not a repository name: ${repository}`);
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
  const tags = [
    ...Object.entries(d.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
    { Key: ROLE_TAG, Value: DEMO_VALUE }, { Key: "fenvix:repository", Value: repository }, { Key: "Name", Value: runnerName },
  ];
  const r = await d.ec2.send(new RunInstancesCommand({
    LaunchTemplate: { LaunchTemplateId: d.launchTemplateId, Version: "$Latest" },
    ImageId: imageId, MinCount: 1, MaxCount: 1,
    UserData: Buffer.from(demoUserData({ repository, runnerName, registrationToken: tok.data.token, machineEnv: d.machineEnv })).toString("base64"),
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
  const ms = await machines(d.ec2);
  const repo = repository ?? ms[0]?.repository ?? null;
  const runners = repo ? (await demoRunners(d, repo)).runners : [];
  return { machines: ms, runners };
}

/** Deregisters every fenvix-demo-* runner of the repository and terminates every demo machine. */
export async function demoDown(d: DemoDeps, repository: string | null): Promise<{ deregistered: string[]; terminated: string[]; problems: string[] }> {
  const ms = await machines(d.ec2);
  const repos = new Set([...(repository ? [repository] : []), ...ms.map((m) => m.repository).filter((x): x is string => !!x && REPO.test(x))]);
  const deregistered: string[] = [];
  const problems: string[] = [];
  for (const repo of repos) {
    try {
      const { gh, runners } = await demoRunners(d, repo);
      for (const x of runners) {
        const del = await gh.request("DELETE", `${repoPath(repo)}/actions/runners/${x.id}`, { allow: [404, 422] });
        if (del.status === 422) problems.push(`${x.name} is running a job; it is removed when the machine stops`);
        else deregistered.push(x.name);
      }
    } catch (e) {
      problems.push(`${repo}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const ids = ms.filter((m) => m.state !== "terminated").map((m) => m.instanceId);
  if (ids.length) await d.ec2.send(new TerminateInstancesCommand({ InstanceIds: ids }));
  return { deregistered, terminated: ids, problems };
}
