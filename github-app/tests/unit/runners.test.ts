import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DescribeImagesCommand, DescribeInstancesCommand, RunInstancesCommand, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { launcherFrom, machineEnv } from "../../src/lambda/runtime.ts";
import { Ec2Launcher, jobUserData, NoPlacement, placementsFromEnv, reap, RetryLater, type RunnerLaunch } from "../../src/runners/launcher.ts";
import { jsonLogger } from "../../src/work.ts";

const launch: RunnerLaunch = {
  jobId: 601, runId: 9001, repositoryId: 70001, repositoryFullName: "acme/shop", installationId: 4242, runnerName: "fenvix-j601",
  jitConfig: Buffer.from('{"runner":"jit"}').toString("base64"), cacheAccess: "read",
};
const MACHINE = { AWS_DEFAULT_REGION: "eu-west-1", FENVIX_SUMMARIES_URL: "https://api.fenvix.dev/v1/runner/summaries" };

/** An EC2 client in memory: images, running machines, the calls made. */
function fakeEc2(o: { running?: number; images?: { ImageId: string; CreationDate: string }[]; runError?: string; instances?: { InstanceId: string; LaunchTime: Date }[] } = {}) {
  const calls: unknown[] = [];
  return {
    calls,
    send: async (c: unknown) => {
      calls.push(c);
      if (c instanceof DescribeInstancesCommand) {
        const list = o.instances ?? Array.from({ length: o.running ?? 0 }, (_, i) => ({ InstanceId: `i-${i}`, LaunchTime: new Date() }));
        return { Reservations: [{ Instances: list }] };
      }
      if (c instanceof DescribeImagesCommand) return { Images: o.images ?? [{ ImageId: "ami-old", CreationDate: "2026-11-01T00:00:00Z" }, { ImageId: "ami-new", CreationDate: "2026-11-17T00:00:00Z" }] };
      if (c instanceof RunInstancesCommand) {
        if (o.runError) throw Object.assign(new Error(o.runError), { name: o.runError });
        return { Instances: [{ InstanceId: "i-0abc" }] };
      }
      if (c instanceof TerminateInstancesCommand) return {};
      throw new Error("unexpected command");
    },
  };
}

describe("per-job runner machines", () => {
  it("user data: the machine's settings and the just-in-time config, root-only, then the job target starts", () => {
    const ud = jobUserData(launch, MACHINE);
    assert.match(ud, /^FENVIX_RUNNER_NAME=fenvix-j601$/m);
    assert.match(ud, /^FENVIX_MACHINE=per-job$/m);
    // The run mode and region: enforce in the US unless the launch says otherwise.
    assert.match(ud, /^FENVIX_MODE=enforce$/m);
    assert.match(ud, /^FENVIX_REGION=us$/m);
    const trial = jobUserData({ ...launch, mode: "shadow", region: "eu" }, MACHINE);
    assert.match(trial, /^FENVIX_MODE=shadow$/m);
    assert.match(trial, /^FENVIX_REGION=eu$/m);
    assert.match(ud, /^FENVIX_CACHE_ACCESS=read$/m);
    assert.match(ud, /^FENVIX_SUMMARIES_URL=https:\/\/api\.fenvix\.dev\/v1\/runner\/summaries$/m);
    assert.match(ud, /umask 077\nprintf '%s' '[A-Za-z0-9+/=]+' >\/etc\/fenvix\/jitconfig\n/);
    assert.match(ud, /systemctl start --no-block fenvix-job\.target\n$/);
    assert.throws(() => jobUserData({ ...launch, jitConfig: "a'; rm -rf / #" }, MACHINE), /base64/);
    assert.throws(() => jobUserData(launch, { X: "a b" }), /env file/);
  });

  it("user data: the machine's own credentials (root only) and its installation's cache organization; no SSM parameter", () => {
    const ud = jobUserData({ ...launch, summaryToken: "fxr1.abc.def", cacheToken: "fxs1.ghi.jkl" },
      { ...MACHINE, FENVIX_CACHE_URL: "http://10.42.0.10:8787", FENVIX_CACHE_WRITE_TOKEN_PARAM: "/fenvix/prod/cache/write-token" });
    assert.match(ud, /^FENVIX_CACHE_URL=http:\/\/10\.42\.0\.10:8787\/gh-4242$/m);
    assert.match(ud, /^FENVIX_CACHE_ORG=gh-4242$/m);
    assert.doesNotMatch(ud, /TOKEN_PARAM/);
    assert.match(ud, /umask 077\n(.*\n)*printf '%s' 'fxr1\.abc\.def' >\/etc\/fenvix\/summary-token\nprintf '%s' 'fxs1\.ghi\.jkl' >\/etc\/fenvix\/cache-token\n/);
    assert.throws(() => jobUserData({ ...launch, summaryToken: "x'; reboot #" }, MACHINE), /credential format/);
    // No shared cache configured: no cache token is written.
    assert.doesNotMatch(jobUserData({ ...launch, cacheToken: "fxs1.a.b" }, MACHINE), /cache-token/);
  });

  it("hasCapacity: false at the limit (no just-in-time runner is registered then)", async () => {
    assert.equal(await new Ec2Launcher({ ec2: fakeEc2({ running: 4 }), launchTemplateId: "lt", maxRunning: 4, machineEnv: MACHINE }).hasCapacity(), false);
    assert.equal(await new Ec2Launcher({ ec2: fakeEc2({ running: 3 }), launchTemplateId: "lt", maxRunning: 4, machineEnv: MACHINE }).hasCapacity(), true);
  });

  it("launch: newest own image, the launch template, one machine per job (client token), tagged", async () => {
    const ec2 = fakeEc2();
    const l = new Ec2Launcher({ ec2, launchTemplateId: "lt-123", maxRunning: 4, machineEnv: MACHINE, tags: { project: "fenvix", env: "prod" } });
    assert.deepEqual(await l.launch(launch), { instanceId: "i-0abc", already: false });
    const imgs = ec2.calls.find((c) => c instanceof DescribeImagesCommand) as DescribeImagesCommand;
    assert.deepEqual(imgs.input.Owners, ["self"]);
    const run = ec2.calls.find((c) => c instanceof RunInstancesCommand) as RunInstancesCommand;
    assert.equal(run.input.ImageId, "ami-new");
    assert.deepEqual(run.input.LaunchTemplate, { LaunchTemplateId: "lt-123", Version: "$Latest" });
    assert.equal(run.input.ClientToken, "fenvix-job-601");
    assert.equal(run.input.MaxCount, 1);
    const tags = Object.fromEntries(run.input.TagSpecifications![0]!.Tags!.map((t) => [t.Key, t.Value]));
    assert.deepEqual(tags, { project: "fenvix", env: "prod", "fenvix:role": "runner-job", "fenvix:job": "601", "fenvix:repository": "acme/shop", "fenvix:region": "us", Name: "fenvix-j601" });
    assert.match(Buffer.from(run.input.UserData!, "base64").toString(), /FENVIX_RUNNER_NAME=fenvix-j601/);
    // The image is looked up again only after 5 minutes.
    await l.launch({ ...launch, jobId: 602 });
    assert.equal(ec2.calls.filter((c) => c instanceof DescribeImagesCommand).length, 1);
  });

  it("at the limit: RetryLater (the queue tries the job again); no image: a clear error", async () => {
    await assert.rejects(new Ec2Launcher({ ec2: fakeEc2({ running: 4 }), launchTemplateId: "lt", maxRunning: 4, machineEnv: MACHINE }).launch(launch), RetryLater);
    await assert.rejects(new Ec2Launcher({ ec2: fakeEc2({ images: [] }), launchTemplateId: "lt", maxRunning: 4, machineEnv: MACHINE }).launch(launch), /run the image pipeline/);
  });

  it("a retry with a new just-in-time config hits the same client token: the first machine stands", async () => {
    const l = new Ec2Launcher({ ec2: fakeEc2({ runError: "IdempotentParameterMismatch" }), launchTemplateId: "lt", maxRunning: 4, machineEnv: MACHINE });
    assert.deepEqual(await l.launch(launch), { instanceId: null, already: true });
    await assert.rejects(new Ec2Launcher({ ec2: fakeEc2({ runError: "InsufficientInstanceCapacity" }), launchTemplateId: "lt", maxRunning: 4, machineEnv: MACHINE }).launch(launch), /InsufficientInstanceCapacity/);
  });

  it("the reaper terminates only machines past the hard limit", async () => {
    const now = Date.parse("2026-11-18T12:00:00Z");
    const ec2 = fakeEc2({ instances: [{ InstanceId: "i-young", LaunchTime: new Date(now - 30 * 60_000) }, { InstanceId: "i-old", LaunchTime: new Date(now - 7 * 3_600_000) }] });
    assert.deepEqual(await reap(ec2, 6, now), ["i-old"]);
    const t = ec2.calls.find((c) => c instanceof TerminateInstancesCommand) as TerminateInstancesCommand;
    assert.deepEqual(t.input.InstanceIds, ["i-old"]);
    const d = ec2.calls[0] as DescribeInstancesCommand;
    assert.deepEqual(d.input.Filters![0], { Name: "tag:fenvix:role", Values: ["runner-job"] });
    const none = fakeEc2({ instances: [] });
    assert.deepEqual(await reap(none, 6, now), []);
    assert.equal(none.calls.filter((c) => c instanceof TerminateInstancesCommand).length, 0);
  });

  it("Lambda settings: RUNNER_MODE=per-job needs the launch template; machine settings come from FENVIX_MACHINE_*", () => {
    const log = jsonLogger("silent");
    assert.equal(launcherFrom({}, log), null);
    assert.equal(launcherFrom({ RUNNER_MODE: "always-on" }, log), null);
    assert.throws(() => launcherFrom({ RUNNER_MODE: "per-job" }, log), /RUNNER_LAUNCH_TEMPLATE_ID/);
    assert.throws(() => launcherFrom({ RUNNER_MODE: "per-job", RUNNER_LAUNCH_TEMPLATE_ID: "lt", RUNNER_MAX_RUNNING: "0" }, log), /RUNNER_MAX_RUNNING/);
    assert.ok(launcherFrom({ RUNNER_MODE: "per-job", RUNNER_LAUNCH_TEMPLATE_ID: "lt" }, log) instanceof Ec2Launcher);
    assert.deepEqual(machineEnv({ FENVIX_MACHINE_FENVIX_CACHE_URL: "http://10.42.0.10:8787/fenvix", OTHER: "x", FENVIX_MACHINE_EMPTY: "" }), { FENVIX_CACHE_URL: "http://10.42.0.10:8787/fenvix" });
    // RUNNER_PLACEMENT alone is enough.
    const placed = launcherFrom({ RUNNER_MODE: "per-job", RUNNER_PLACEMENT: JSON.stringify({ eu: { awsRegion: "eu-central-1", launchTemplateId: "lt-0eu" } }) }, log) as Ec2Launcher;
    assert.deepEqual([placed.canPlace("eu"), placed.canPlace("us")], [true, false]);
  });
});

describe("region placement (RUNNER_PLACEMENT)", () => {
  const PLACEMENT = JSON.stringify({ us: { awsRegion: "us-east-1", launchTemplateId: "lt-0us" }, eu: { awsRegion: "eu-central-1", launchTemplateId: "lt-0eu", machineEnv: { FENVIX_CACHE_URL: "http://10.52.0.10:8787" } } });

  it("one EC2 client per AWS region; RUNNER_LAUNCH_TEMPLATE_ID is the us placement when RUNNER_PLACEMENT has none", () => {
    const made: (string | undefined)[] = [];
    const ec2For = (r: string | undefined) => { made.push(r); return fakeEc2(); };
    const p = placementsFromEnv({ RUNNER_PLACEMENT: PLACEMENT }, ec2For);
    assert.deepEqual(Object.keys(p).sort(), ["eu", "us"]);
    assert.deepEqual([p.us!.launchTemplateId, p.eu!.launchTemplateId, p.eu!.awsRegion], ["lt-0us", "lt-0eu", "eu-central-1"]);
    assert.deepEqual(made, ["us-east-1", "eu-central-1"]);
    const fallback = placementsFromEnv({ RUNNER_LAUNCH_TEMPLATE_ID: "lt-old", RUNNER_PLACEMENT: JSON.stringify({ eu: { awsRegion: "eu-west-1", launchTemplateId: "lt-0eu" } }) }, () => fakeEc2());
    assert.deepEqual([fallback.us!.launchTemplateId, fallback.eu!.launchTemplateId], ["lt-old", "lt-0eu"]);
    assert.deepEqual(Object.keys(placementsFromEnv({ RUNNER_LAUNCH_TEMPLATE_ID: "lt-old" }, () => fakeEc2())), ["us"]);
    assert.deepEqual(placementsFromEnv({}, () => fakeEc2()), {});
    for (const bad of ["nope", "[]", JSON.stringify({ asia: { awsRegion: "ap-south-1", launchTemplateId: "lt-1" } }), JSON.stringify({ eu: { awsRegion: "Frankfurt", launchTemplateId: "lt-1" } }),
      JSON.stringify({ eu: { awsRegion: "eu-central-1", launchTemplateId: "ami-1" } }), JSON.stringify({ eu: { awsRegion: "eu-central-1", launchTemplateId: "lt-1", machineEnv: { A: 1 } } })]) {
      assert.throws(() => placementsFromEnv({ RUNNER_PLACEMENT: bad }, () => fakeEc2()), /RUNNER_PLACEMENT/, bad);
    }
  });

  it("an EU job starts in the EU region with its launch template and settings; a region without placement gets no machine", async () => {
    const us = fakeEc2();
    const eu = fakeEc2();
    const l = new Ec2Launcher({ placements: { us: { ec2: us, launchTemplateId: "lt-0us" }, eu: { ec2: eu, launchTemplateId: "lt-0eu", awsRegion: "eu-central-1", machineEnv: { FENVIX_CACHE_URL: "http://10.52.0.10:8787" } } }, maxRunning: 2, machineEnv: { ...MACHINE, FENVIX_CACHE_URL: "http://10.42.0.10:8787" } });
    await l.launch({ ...launch, region: "eu", mode: "shadow" });
    assert.equal(us.calls.length, 0, "nothing in the US for an EU job");
    const run = eu.calls.find((c) => c instanceof RunInstancesCommand) as RunInstancesCommand;
    assert.deepEqual(run.input.LaunchTemplate, { LaunchTemplateId: "lt-0eu", Version: "$Latest" });
    const ud = Buffer.from(run.input.UserData!, "base64").toString();
    assert.match(ud, /^FENVIX_MODE=shadow$/m);
    assert.match(ud, /^FENVIX_REGION=eu$/m);
    assert.match(ud, /^FENVIX_CACHE_URL=http:\/\/10\.52\.0\.10:8787\/gh-4242$/m);
    const tags = Object.fromEntries(run.input.TagSpecifications![0]!.Tags!.map((t) => [t.Key, t.Value]));
    assert.equal(tags["fenvix:region"], "eu");

    const usOnly = new Ec2Launcher({ ec2: us, launchTemplateId: "lt-0us", maxRunning: 2, machineEnv: MACHINE });
    assert.equal(usOnly.canPlace("eu"), false);
    await assert.rejects(usOnly.launch({ ...launch, region: "eu" }), NoPlacement);
    assert.equal(us.calls.length, 0);
    // Capacity is counted per region.
    const full = new Ec2Launcher({ placements: { us: { ec2: fakeEc2({ running: 2 }), launchTemplateId: "lt-0us" }, eu: { ec2: fakeEc2({ running: 0 }), launchTemplateId: "lt-0eu" } }, maxRunning: 2, machineEnv: MACHINE });
    assert.deepEqual([await full.hasCapacity("us"), await full.hasCapacity("eu")], [false, true]);
  });
});
