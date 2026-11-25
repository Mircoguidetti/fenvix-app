import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { DescribeImagesCommand, DescribeInstancesCommand, RunInstancesCommand, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import addFormatsModule from "ajv-formats";
import { parse as parseYaml } from "yaml";
import { warmupFromEnv } from "../../src/config.ts";
import { parseWarmupReport, RecordError } from "../../src/results/runner-records.ts";
import { signCacheToken, signSummaryCredential, verifySummaryCredential } from "../../src/runners/credentials.ts";
import { Ec2Launcher, KIND_TAG, RetryLater, WARMUP_TAG, type WarmupLaunch, warmupSpec, warmupUserData } from "../../src/runners/launcher.ts";
import { DEFAULT_WARMUP, decide, type DispatchContext, warmupRunnerName } from "../../src/warmup/policy.ts";

const KEY = "runner-token-for-tests-0123456789abcdef";
const MACHINE = { AWS_DEFAULT_REGION: "eu-west-1", FENVIX_SUMMARIES_URL: "https://api.fenvix.dev/v1/runner/summaries", FENVIX_CACHE_URL: "http://10.42.0.10:8787", FENVIX_IDLE_MINUTES: "20" };
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const warm = (o: Partial<WarmupLaunch> = {}): WarmupLaunch => ({
  warmupId: 17, attempt: 1, repositoryId: 70001, repositoryFullName: "acme/shop", installationId: 4242, commitSha: "a".repeat(40), ref: "refs/heads/main",
  workflowPath: ".github/workflows/ci.yml", job: "test", runnerName: "fenvix-w17", checkoutToken: "ghs_" + "x".repeat(36),
  summaryToken: signSummaryCredential(KEY, { runnerName: "fenvix-w17", repositoryId: 70001, warmupId: 17, exp: exp() }), region: "us", ...o,
});

// ---------------------------------------------------------------- the scheduling rules

describe("warm-ups: when a pending warm-up may take a machine (lowest priority)", () => {
  const free: DispatchContext = { canPlace: true, customerJobsWaiting: 0, running: 1, max: 4, orgActive: 0, repoLast24h: 0, oldestLast24h: null };

  it("a free machine beyond the reserve, no customer waiting, the organization idle, under the cap: dispatch", () => {
    assert.deepEqual(decide(DEFAULT_WARMUP, "us", free), { dispatch: true });
  });

  it("never in another region: no placement for the organization's region means no machine at all", () => {
    const d = decide(DEFAULT_WARMUP, "eu", { ...free, canPlace: false });
    assert.equal(d.dispatch, false);
    assert.match((d as { detail: string }).detail, /\(eu\).*never runs in another region/);
  });

  it("a customer job waiting in the region comes first, even with free machines", () => {
    const d = decide(DEFAULT_WARMUP, "us", { ...free, customerJobsWaiting: 2 });
    assert.match((d as { detail: string }).detail, /2 customer jobs are waiting/);
  });

  it("the reserve: with 4 machines and a reserve of 1, a warm-up takes at most the 3rd", () => {
    assert.equal(decide(DEFAULT_WARMUP, "us", { ...free, running: 2 }).dispatch, true);
    const d = decide(DEFAULT_WARMUP, "us", { ...free, running: 3 });
    assert.match((d as { detail: string }).detail, /3 of 4 busy; 1 kept for customer jobs/);
    assert.equal(decide({ ...DEFAULT_WARMUP, reserve: 0 }, "us", { ...free, running: 3 }).dispatch, true);
  });

  it("per-organization concurrency", () => {
    assert.match((decide(DEFAULT_WARMUP, "us", { ...free, orgActive: 1 }) as { detail: string }).detail, /at most 1 at once/);
    assert.equal(decide({ ...DEFAULT_WARMUP, orgConcurrency: 2 }, "us", { ...free, orgActive: 1 }).dispatch, true);
  });

  it("the daily cap per repository: waits until the oldest of the day is 24 hours old", () => {
    const oldest = new Date("2026-11-18T08:00:00Z");
    const d = decide(DEFAULT_WARMUP, "us", { ...free, repoLast24h: 6, oldestLast24h: oldest }) as { dispatch: false; detail: string; retryAt?: Date };
    assert.equal(d.dispatch, false);
    assert.equal(d.retryAt!.toISOString(), "2026-11-19T08:00:00.000Z");
    assert.match(d.detail, /daily cap reached: 6 warm-ups .* after 2026-11-19 08:00 UTC/);
    assert.equal(decide(DEFAULT_WARMUP, "us", { ...free, repoLast24h: 5, oldestLast24h: oldest }).dispatch, true);
  });

  it("a fresh runner name per attempt (a new machine after a preemption)", () => {
    assert.equal(warmupRunnerName(17, 1), "fenvix-w17");
    assert.equal(warmupRunnerName(17, 2), "fenvix-w17-2");
  });
});

// ---------------------------------------------------------------- credentials

describe("warm-up credentials", () => {
  it("the App credential names the warm-up; it never names a run as well", () => {
    const t = signSummaryCredential(KEY, { runnerName: "fenvix-w17", repositoryId: 70001, warmupId: 17, exp: exp() });
    const s = verifySummaryCredential([KEY], `Bearer ${t}`)!;
    assert.deepEqual({ ...s, exp: 0 }, { runnerName: "fenvix-w17", repositoryId: 70001, warmupId: 17, exp: 0 });
    assert.throws(() => signSummaryCredential(KEY, { runnerName: "fenvix-w17", repositoryId: 70001, runId: 5, warmupId: 17, exp: exp() }), /scope/);
    assert.throws(() => signSummaryCredential(KEY, { runnerName: "fenvix-w17", repositoryId: 70001, warmupId: 0, exp: exp() }), /scope/);
    // A job's credential has no warm-up.
    const job = verifySummaryCredential([KEY], `Bearer ${signSummaryCredential(KEY, { runnerName: "fenvix-j1", repositoryId: 70001, runId: 9, exp: exp() })}`)!;
    assert.equal(job.warmupId, undefined);
  });

  it("the cache token of a warm-up names it and writes", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const t = signCacheToken(privateKey, { installationId: 4242, write: true, exp: exp(), warmupId: 17 });
    const payload = JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString());
    assert.deepEqual({ ...payload, exp: 0 }, { org: "gh-4242", w: true, exp: 0, warm: 17 });
  });
});

// ---------------------------------------------------------------- the machine's user data

describe("warm-up machine: user data", () => {
  it("the settings, the description (base64 JSON), the credentials root only, then fenvix-warmup.target; no just-in-time runner", () => {
    const ud = warmupUserData(warm(), MACHINE);
    for (const line of ["FENVIX_MACHINE=per-job", "FENVIX_KIND=warmup", "FENVIX_MODE=enforce", "FENVIX_REGION=us", "FENVIX_RUNNER_NAME=fenvix-w17",
      "FENVIX_WARMUP_ID=17", "FENVIX_CACHE_ACCESS=write", "FENVIX_CACHE_URL=http://10.42.0.10:8787/gh-4242", "FENVIX_CACHE_ORG=gh-4242",
      "FENVIX_WARMUPS_URL=https://api.fenvix.dev/v1/runner/warmups"]) assert.match(ud, new RegExp(`^${line.replace(/[./]/g, "\\$&")}$`, "m"), line);
    const spec = JSON.parse(Buffer.from(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d >\/etc\/fenvix\/warmup\.json/.exec(ud)![1]!, "base64").toString());
    assert.deepEqual(spec, { v: 1, warmupId: 17, attempt: 1, repository: { id: 70001, fullName: "acme/shop" }, installationId: 4242, commitSha: "a".repeat(40), ref: "refs/heads/main", workflowPath: ".github/workflows/ci.yml", job: "test" });
    assert.match(ud, /^umask 077$/m);
    assert.match(ud, />\/etc\/fenvix\/checkout-token$/m);
    assert.match(ud, />\/etc\/fenvix\/summary-token$/m);
    assert.match(ud, /systemctl start --no-block fenvix-warmup\.target\n$/);
    assert.doesNotMatch(ud, /jitconfig|fenvix-job\.target/);
  });

  it("refuses a description that could escape: a workflow outside .github/workflows, a job id with spaces, a ref with .., a bad token", () => {
    assert.throws(() => warmupSpec(warm({ workflowPath: "../x.yml" })), /workflow/);
    assert.throws(() => warmupSpec(warm({ workflowPath: ".github/workflows/../../x.yml" })), /workflow/);
    assert.throws(() => warmupSpec(warm({ job: "test; rm -rf /" })), /job/);
    assert.throws(() => warmupSpec(warm({ ref: "refs/heads/../x" })), /ref/);
    assert.throws(() => warmupSpec(warm({ commitSha: "main" })), /commit/);
    assert.throws(() => warmupUserData(warm({ checkoutToken: "ghs_x'; reboot #" }), MACHINE), /checkout token/);
    assert.throws(() => warmupUserData(warm({ summaryToken: "secret" }), MACHINE), /credential/);
  });
});

// ---------------------------------------------------------------- the EC2 side

function fakeEc2(o: { instances?: { InstanceId: string; Tags?: { Key: string; Value: string }[] }[]; runError?: string;
  byToken?: Record<string, { InstanceId: string; ImageId?: string; InstanceType?: string }[]> } = {}) {
  const calls: unknown[] = [];
  return {
    calls,
    send: async (c: unknown) => {
      calls.push(c);
      const token = c instanceof DescribeInstancesCommand ? c.input.Filters?.find((f) => f.Name === "client-token")?.Values?.[0] : undefined;
      if (token !== undefined) return { Reservations: [{ Instances: o.byToken?.[token] ?? [] }] };
      if (c instanceof DescribeInstancesCommand) return { Reservations: [{ Instances: o.instances ?? [] }] };
      if (c instanceof DescribeImagesCommand) return { Images: [{ ImageId: "ami-new", CreationDate: "2026-11-17T00:00:00Z" }] };
      if (c instanceof RunInstancesCommand) {
        if (o.runError) throw Object.assign(new Error(o.runError), { name: o.runError });
        return { Instances: [{ InstanceId: "i-warm", ImageId: c.input.ImageId, InstanceType: "m7i.large" }] };
      }
      if (c instanceof TerminateInstancesCommand) return {};
      throw new Error("unexpected command");
    },
  };
}

describe("warm-up machine: EC2", () => {
  const w = { Key: KIND_TAG, Value: "warmup" };
  it("slots: every job machine counts against the limit; warm-ups are counted apart", async () => {
    const ec2 = fakeEc2({ instances: [{ InstanceId: "i-1" }, { InstanceId: "i-2", Tags: [w] }] });
    assert.deepEqual(await new Ec2Launcher({ ec2, launchTemplateId: "lt-1", maxRunning: 4, machineEnv: MACHINE }).slots("us"), { running: 2, warmups: 1, max: 4 });
  });

  it("launch: the job role tag (so the IAM conditions and the reaper apply), the warm-up tags, one machine per attempt", async () => {
    const ec2 = fakeEc2();
    const r = await new Ec2Launcher({ ec2, launchTemplateId: "lt-1", maxRunning: 4, machineEnv: MACHINE, tags: { project: "fenvix" } }).launchWarmup(warm({ attempt: 2, runnerName: "fenvix-w17-2" }));
    assert.deepEqual(r, { instanceId: "i-warm", already: false, imageId: "ami-new", instanceType: "m7i.large" });
    const run = ec2.calls.find((c) => c instanceof RunInstancesCommand) as RunInstancesCommand;
    assert.equal(run.input.ClientToken, "fenvix-warmup-17-2");
    const tags = Object.fromEntries(run.input.TagSpecifications![0]!.Tags!.map((t) => [t.Key, t.Value]));
    assert.deepEqual(tags, { project: "fenvix", "fenvix:role": "runner-job", [KIND_TAG]: "warmup", [WARMUP_TAG]: "17", "fenvix:repository": "acme/shop", "fenvix:region": "us", Name: "fenvix-w17-2" });
    assert.match(Buffer.from(run.input.UserData!, "base64").toString(), /fenvix-warmup\.target/);
  });

  it("launch: the attempt's machine already exists: its image and type, read by the attempt's client token", async () => {
    // protects=a re-run tick records the warm-up machine EC2 started; fails_when=the lookup token is not the attempt's;
    // no_claim=the real EC2 filter semantics.
    const ec2 = fakeEc2({ runError: "IdempotentParameterMismatch", byToken: { "fenvix-warmup-17-2": [{ InstanceId: "i-w", ImageId: "ami-old", InstanceType: "m7i.large" }] } });
    const r = await new Ec2Launcher({ ec2, launchTemplateId: "lt-1", maxRunning: 4, machineEnv: MACHINE }).launchWarmup(warm({ attempt: 2, runnerName: "fenvix-w17-2" }));
    assert.deepEqual(r, { instanceId: "i-w", already: true, imageId: "ami-old", instanceType: "m7i.large" });
  });

  it("launch at the limit: RetryLater (the warm-up stays pending)", async () => {
    const ec2 = fakeEc2({ instances: Array.from({ length: 4 }, (_, i) => ({ InstanceId: `i-${i}` })) });
    await assert.rejects(new Ec2Launcher({ ec2, launchTemplateId: "lt-1", maxRunning: 4, machineEnv: MACHINE }).launchWarmup(warm()), RetryLater);
  });

  it("terminate: only the machines tagged with this warm-up (and kind warmup)", async () => {
    const ec2 = fakeEc2({ instances: [{ InstanceId: "i-w17", Tags: [w] }] });
    assert.deepEqual(await new Ec2Launcher({ ec2, launchTemplateId: "lt-1", maxRunning: 4, machineEnv: MACHINE }).terminateWarmup("us", 17), ["i-w17"]);
    const d = ec2.calls.find((c) => c instanceof DescribeInstancesCommand) as DescribeInstancesCommand;
    assert.deepEqual(d.input.Filters!.map((f) => [f.Name, f.Values]).slice(0, 3), [["tag:fenvix:role", ["runner-job"]], [`tag:${KIND_TAG}`, ["warmup"]], [`tag:${WARMUP_TAG}`, ["17"]]]);
    assert.deepEqual((ec2.calls.find((c) => c instanceof TerminateInstancesCommand) as TerminateInstancesCommand).input.InstanceIds, ["i-w17"]);
    const none = fakeEc2();
    assert.deepEqual(await new Ec2Launcher({ ec2: none, launchTemplateId: "lt-1", maxRunning: 4, machineEnv: MACHINE }).terminateWarmup("us", 18), []);
    assert.ok(!none.calls.some((c) => c instanceof TerminateInstancesCommand));
  });
});

// ---------------------------------------------------------------- the report's schema and the settings

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as new (o: object) => { addSchema(s: object, k: string): void; compile(s: object): ((d: unknown) => boolean) & { errors?: unknown } };
const addFormats = addFormatsModule as unknown as (a: unknown) => void;
const spec = parseYaml(readFileSync(new URL("../../../openapi/fenvix-api.yaml", import.meta.url), "utf8")) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ ...spec, $id: "https://fenvix.dev/openapi" }, "openapi");

describe("POST /v1/runner/warmups: our check accepts and refuses exactly what RunnerWarmupReport does", () => {
  const check = ajv.compile({ $ref: "https://fenvix.dev/openapi#/components/schemas/RunnerWarmupReport" });
  const ours = (b: unknown) => { try { parseWarmupReport(b); return true; } catch (e) { assert.ok(e instanceof RecordError, String(e)); return false; } };
  const cases: [unknown, boolean][] = [
    [{ warmupId: 17, event: "started" }, true],
    [{ warmupId: 17, event: "started", runnerName: "fenvix-w17", repositoryId: 70001 }, true],
    [{ warmupId: 17, event: "finished", outcome: "succeeded", summary: { tests: 1 } }, true],
    [{ warmupId: 17, event: "finished", outcome: "unsupported", detail: "needs: build" }, true],
    [{ warmupId: 17, event: "finished" }, false],
    [{ warmupId: 17, event: "started", outcome: "failed" }, false],
    [{ warmupId: 17, event: "started", summary: {} }, false],
    [{ warmupId: 17, event: "finished", outcome: "great" }, false],
    [{ warmupId: 0, event: "started" }, false],
    [{ warmupId: "17", event: "started" }, false],
    [{ event: "started" }, false],
    [{ warmupId: 17, event: "begun" }, false],
    [{ warmupId: 17, event: "finished", outcome: "failed", detail: "d".repeat(1001) }, false],
    [{ warmupId: 17, event: "finished", outcome: "failed", summary: [] }, false],
    [{ warmupId: 17, event: "started", extra: "kept out" }, true],
    [[], false],
  ];
  for (const [body, valid] of cases) {
    it(`${JSON.stringify(body).slice(0, 90)}: ${valid ? "accepted" : "refused"}`, () => {
      assert.equal(check(body), valid, `the schema says ${!valid}`);
      assert.equal(ours(body), valid, "our check disagrees with the schema");
    });
  }
});

describe("WARMUP_* settings", () => {
  it("defaults, overrides and refusals", () => {
    assert.deepEqual(warmupFromEnv({}), DEFAULT_WARMUP);
    const w = warmupFromEnv({ WARMUP_ENABLED: "false", WARMUP_DAILY_CAP: "2", WARMUP_ORG_CONCURRENCY: "3", WARMUP_RESERVE: "0", WARMUP_GRACE_SECONDS: "0" });
    assert.deepEqual({ en: w.enabled, cap: w.dailyCap, conc: w.orgConcurrency, res: w.reserve, grace: w.graceSeconds }, { en: false, cap: 2, conc: 3, res: 0, grace: 0 });
    assert.throws(() => warmupFromEnv({ WARMUP_ENABLED: "yes" }), /WARMUP_ENABLED/);
    assert.throws(() => warmupFromEnv({ WARMUP_DAILY_CAP: "0" }), /WARMUP_DAILY_CAP/);
  });
});
