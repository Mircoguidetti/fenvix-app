import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { DescribeImagesCommand, DescribeInstancesCommand, RunInstancesCommand, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { GitHubApp } from "../../src/github/client.ts";
import { demoDown, demoStatus, demoUp, demoUserData, deregisterGoneDemoRunners, type DemoDeps } from "../../src/runners/demo.ts";
import { verifySummaryCredential } from "../../src/runners/credentials.ts";
import { parseReap } from "../../src/lambda/reaper.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";

/** EC2 in memory: images, instances with tags and states. */
class FakeEc2 {
  instances: { InstanceId: string; State: { Name: string }; LaunchTime: Date; Tags: { Key: string; Value: string }[]; input: RunInstancesCommand["input"] }[] = [];
  async send(c: unknown): Promise<unknown> {
    if (c instanceof DescribeImagesCommand) return { Images: [{ ImageId: "ami-runner", CreationDate: "2026-11-18T00:00:00Z" }] };
    if (c instanceof DescribeInstancesCommand) {
      const f = Object.fromEntries((c.input.Filters ?? []).map((x) => [x.Name, x.Values]));
      return { Reservations: [{ Instances: this.instances.filter((i) => (f["instance-state-name"] ?? []).includes(i.State.Name) && i.Tags.some((t) => t.Key === "fenvix:role" && (f["tag:fenvix:role"] ?? []).includes(t.Value))) }] };
    }
    if (c instanceof RunInstancesCommand) {
      const id = `i-${this.instances.length + 1}`;
      this.instances.push({ InstanceId: id, State: { Name: "pending" }, LaunchTime: new Date(), Tags: c.input.TagSpecifications![0]!.Tags as { Key: string; Value: string }[], input: c.input });
      return { Instances: [{ InstanceId: id }] };
    }
    if (c instanceof TerminateInstancesCommand) {
      for (const i of this.instances) if (c.input.InstanceIds!.includes(i.InstanceId)) i.State.Name = "terminated";
      return {};
    }
    throw new Error("unexpected EC2 command");
  }
}

const MACHINE = { AWS_DEFAULT_REGION: "eu-west-1", FENVIX_SUMMARIES_URL: "https://github.fenvix.dev/v1/runner/summaries" };

describe("demo mode: one fresh machine per demo (demo-up / demo-down)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const gh = new FakeGitHub(4242, publicKey);
  const ec2 = new FakeEc2();
  let d: DemoDeps;

  before(async () => {
    await gh.start();
    gh.addInstallation({ id: 77, account: { login: "acme", id: 9001, type: "Organization" }, repos: [70001], selection: "selected" });
    gh.addRepo({ id: 70001, fullName: "acme/demo", ownerId: 9001, files: { "README.md": "demo\n" } });
    gh.addRepo({ id: 70002, fullName: "acme/elsewhere", ownerId: 9001, files: {} });
    d = { gh: new GitHubApp({ apiUrl: gh.url, appId: 4242, privateKey }), ec2, launchTemplateId: "lt-demo", machineEnv: MACHINE, tags: { project: "fenvix", env: "prod" }, now: () => new Date("2026-11-18T15:04:00Z") };
  });
  after(async () => { await gh.stop(); });

  it("up: a registration token from GitHub (as the App), one machine from the runner image, tagged as a demo machine", async () => {
    const r = await demoUp(d, "acme/demo");
    assert.deepEqual(r, { instanceId: "i-1", runnerName: "fenvix-demo-202611181504", already: false });
    const i = ec2.instances[0]!;
    assert.equal(i.input.ImageId, "ami-runner");
    assert.deepEqual(i.input.LaunchTemplate, { LaunchTemplateId: "lt-demo", Version: "$Latest" });
    assert.deepEqual(Object.fromEntries(i.Tags.map((t) => [t.Key, t.Value])), { project: "fenvix", env: "prod", "fenvix:role": "runner-demo", "fenvix:repository": "acme/demo", Name: "fenvix-demo-202611181504" });
    const ud = Buffer.from(i.input.UserData!, "base64").toString();
    const token = gh.repos.get("acme/demo")!.registrationTokens[0]!;
    assert.ok(ud.includes(`printf '%s' '${token}' >/etc/fenvix/registration-token`));
    assert.match(ud, /^FENVIX_MACHINE=demo$/m);
    assert.match(ud, /^FENVIX_MODE=enforce$/m);
    assert.match(ud, /^FENVIX_REPO_URL=https:\/\/github\.com\/acme\/demo$/m);
    assert.match(ud, /systemctl start --no-block fenvix-summary-poster\.service fenvix-runner\.service/);
    assert.doesNotMatch(ud, /FENVIX_CACHE_URL/, "a demo keeps its cache on its own disk: nothing crosses demos");
  });

  it("up again: the same machine; up for another repository while one runs: refused", async () => {
    assert.deepEqual(await demoUp(d, "acme/demo"), { instanceId: "i-1", runnerName: "fenvix-demo-202611181504", already: true });
    await assert.rejects(demoUp(d, "acme/elsewhere"), /already runs for acme\/demo/);
    await assert.rejects(demoUp(d, "acme/x; rm"), /not a repository name/);
  });

  it("status: the machine and the runner GitHub sees", async () => {
    const repo = gh.repos.get("acme/demo")!;
    repo.runners.push({ id: 501, name: "fenvix-demo-202611181504", status: "online", busy: false }, { id: 502, name: "someone-elses-runner", status: "online", busy: false });
    ec2.instances[0]!.State.Name = "running";
    const s = await demoStatus(d, null);
    assert.deepEqual(s.machines.map((m) => [m.instanceId, m.state, m.repository]), [["i-1", "running", "acme/demo"]]);
    assert.deepEqual(s.runners.map((r) => [r.name, r.status]), [["fenvix-demo-202611181504", "online"]]);
  });

  it("down: terminates the demo machines first, then deregisters only fenvix-demo-* runners; one still busy is reported", async () => {
    const repo = gh.repos.get("acme/demo")!;
    repo.runners.push({ id: 503, name: "fenvix-demo-old", status: "online", busy: true });
    const r = await demoDown(d, null, { retryMs: 0 });
    assert.deepEqual(r.deregistered, ["fenvix-demo-202611181504"]);
    assert.deepEqual(r.terminated, ["i-1"]);
    assert.match(r.problems.join(), /fenvix-demo-old still busy on GitHub: the reaper deregisters it/);
    assert.deepEqual(repo.runners.map((x) => x.name).sort(), ["fenvix-demo-old", "someone-elses-runner"]);
    assert.equal(ec2.instances[0]!.State.Name, "terminated");
    // A new demo: a new machine, a new runner name.
    d.now = () => new Date("2026-11-19T09:00:00Z");
    assert.deepEqual(await demoUp(d, "acme/demo"), { instanceId: "i-2", runnerName: "fenvix-demo-202611190900", already: false });
    assert.deepEqual(gh.validateAll().map((x) => `${x.method} ${x.path}: ${JSON.stringify(x.problems)}`), []);
  });

  it("the machine's summary credential: its runner name and the demo repository only; the reaper deregisters gone machines' runners", async () => {
    await demoDown(d, null, { retryMs: 0 });
    const key = "k".repeat(40);
    d.now = () => new Date();
    const up = await demoUp({ ...d, summaryKey: key, maxHours: 12 }, "acme/demo");
    const ud = Buffer.from(ec2.instances.at(-1)!.input.UserData!, "base64").toString();
    const tok = /printf '%s' '(fxr1\.[^']+)' >\/etc\/fenvix\/summary-token/.exec(ud)![1]!;
    const scope = verifySummaryCredential([key], `Bearer ${tok}`)!;
    assert.deepEqual({ ...scope, exp: 0 }, { runnerName: up.runnerName, repositoryId: 70001, exp: 0 });
    // A runner left registered after its machine was terminated (demo-down never ran to the end): the reaper removes it.
    gh.repos.get("acme/demo")!.runners.push({ id: 601, name: up.runnerName, status: "offline", busy: false });
    ec2.instances.at(-1)!.State.Name = "terminated";
    assert.deepEqual(await deregisterGoneDemoRunners(d), [up.runnerName]);
    assert.ok(!gh.repos.get("acme/demo")!.runners.some((r) => r.name === up.runnerName));
    d.now = () => new Date("2026-11-19T09:00:00Z");
  });

  it("only the demo repository (setting demoRepository): up, down and status refuse any other", async () => {
    const scoped = { ...d, allowedRepositories: ["acme/demo"] };
    for (const f of [demoUp(scoped, "acme/elsewhere"), demoDown(scoped, "acme/elsewhere"), demoStatus(scoped, "acme/elsewhere")]) {
      await assert.rejects(f, /not the demo repository/);
    }
  });

  it("the App not installed on the repository: a clear error", async () => {
    await demoDown(d, null, { retryMs: 0 });
    gh.addRepo({ id: 70009, fullName: "acme/not-installed", ownerId: 9001, files: {} });
    await assert.rejects(demoUp(d, "acme/not-installed"), /not installed on acme\/not-installed/);
  });

  it("user data refuses a token or a setting that could break out of the script", () => {
    assert.throws(() => demoUserData({ repository: "acme/demo", runnerName: "x", registrationToken: "A'B", machineEnv: MACHINE }), /token format/);
    assert.throws(() => demoUserData({ repository: "acme/demo", runnerName: "x y", registrationToken: "AB", machineEnv: MACHINE }), /env file/);
  });

  it("the reaper's REAP setting", () => {
    assert.deepEqual(parseReap("runner-job:6,runner-demo:12"), [["runner-job", 6], ["runner-demo", 12]]);
    assert.throws(() => parseReap(""), /REAP is required/);
    assert.throws(() => parseReap("i-123:5"), /role:hours/);
  });
});
