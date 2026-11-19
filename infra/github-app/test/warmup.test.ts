import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appPrefix, cacheParameters } from "../lib/parameters.ts";
import { IMAGE_FILES } from "../lib/runner.ts";
import { resources, settings, synth } from "./helpers.ts";

type Stmt = { Effect: string; Action: string | string[]; Resource: unknown; Sid?: string; Condition?: Record<string, Record<string, unknown>> };
const arr = <T,>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);
const json = (x: unknown) => JSON.stringify(x);

describe("warm-up runs (per-job mode): the warm-up scheduler function, its schedule and rights", async () => {
  const { template: t, nagErrors } = await synth({ runnerMode: "per-job" });
  const fns = resources(t, "AWS::Lambda::Function");
  const policies = resources(t, "AWS::IAM::Policy");
  const statementsOf = (roleId: string): Stmt[] => policies
    .filter(([, p]) => json((p.Properties as { Roles: unknown }).Roles).includes(`"${roleId}"`))
    .flatMap(([, p]) => (p.Properties as { PolicyDocument: { Statement: Stmt[] } }).PolicyDocument.Statement);
  const fn = (n: string) => fns.find(([, r]) => (r.Properties.FunctionName as string).endsWith(`-${n}`))![1];
  const fnRole = (n: string) => ((fn(n).Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"])[0]!;
  const fnEnv = (n: string) => (fn(n).Properties.Environment as { Variables: Record<string, unknown> }).Variables;

  it("cdk-nag clean with the warm-up function", () => assert.deepEqual(nagErrors, []));

  it("runs every minute, invoked by the scheduler role only, without retries", () => {
    t.hasResourceProperties("AWS::Scheduler::Schedule", { Name: "fenvix-prod-github-app-warmup", ScheduleExpression: "rate(1 minute)", FlexibleTimeWindow: { Mode: "OFF" } });
    const [, sch] = resources(t, "AWS::Scheduler::Schedule").find(([id]) => id.startsWith("WarmupSchedule"))!;
    assert.match(json(sch.Properties.Target), /Warmup/);
    assert.equal((sch.Properties.Target as { RetryPolicy: { MaximumRetryAttempts: number } }).RetryPolicy.MaximumRetryAttempts, 0);
  });

  it("the worker and the scheduler get the WARMUP_* settings from the stack's settings; the node timer is off on AWS", () => {
    for (const who of ["worker", "warmup"]) {
      const e = fnEnv(who);
      assert.deepEqual({ en: e.WARMUP_ENABLED, cap: e.WARMUP_DAILY_CAP, conc: e.WARMUP_ORG_CONCURRENCY, res: e.WARMUP_RESERVE, grace: e.WARMUP_GRACE_SECONDS, tick: e.WARMUP_TICK_SECONDS },
        { en: "true", cap: "6", conc: "1", res: "1", grace: "180", tick: "0" }, who);
    }
    assert.equal(fnEnv("warmup").RUNNER_MODE, "per-job");
    assert.match(json(fnEnv("warmup").RUNNER_PLACEMENT), /FleetLaunchTemplate/, "placement by the organization's region");
    for (const k of Object.keys(fnEnv("warmup"))) if (!k.endsWith("_PARAM")) assert.doesNotMatch(k, /SECRET|PRIVATE_KEY|DATABASE_URL|SIGNING/, k);
  });

  it("it may start only tagged job machines from our template, and terminate only warm-up machines", () => {
    const st = statementsOf(fnRole("warmup"));
    const tagged = st.find((x) => x.Sid === "OnlyTaggedJobMachines")!;
    assert.deepEqual(tagged.Condition!.StringEquals, { "aws:RequestTag/fenvix:role": "runner-job", "ec2:InstanceType": "c6i.large" });
    const term = st.filter((x) => arr(x.Action).includes("ec2:TerminateInstances"));
    assert.equal(term.length, 1);
    assert.deepEqual(term[0]!.Condition, { StringEquals: { "aws:ResourceTag/fenvix:role": "runner-job", "aws:ResourceTag/fenvix:kind": "warmup" } });
    assert.ok(!st.some((x) => arr(x.Action).some((a) => a.startsWith("sqs:") || a.startsWith("s3:"))), "neither queue nor bucket");
  });

  it("it reads exactly the launch secrets (database, App key, summary key, cache signing key), not the HTTP ones", () => {
    const reads = statementsOf(fnRole("warmup")).filter((x) => json(x.Action).includes("ssm:")).flatMap((x) => arr(x.Resource)).map((r) => json(r).match(/parameter(\/fenvix[^"]*)/)![1]).sort();
    assert.deepEqual(reads, [`${appPrefix("prod")}/database-url`, `${appPrefix("prod")}/private-key`, `${appPrefix("prod")}/runner-token`, ...cacheParameters("prod").map((p) => p.name)].sort());
  });

  it("the runner image carries the warm-up machine's units and scripts", () => {
    const dests = IMAGE_FILES.map(([, d]) => d);
    for (const d of ["/etc/systemd/system/fenvix-warmup.target", "/etc/systemd/system/fenvix-warmup.service", "/opt/fenvix/bin/fenvix-warmup",
      "/opt/fenvix/bin/fenvix-warmup-prepare", "/opt/fenvix/bin/fenvix-warmup-done", "/opt/fenvix/bin/fenvix-warmup-report"]) assert.ok(dests.includes(d), d);
  });

  it("demo mode: no warm-up function, warm-ups off", async () => {
    const demo = await synth({});
    const names = resources(demo.template, "AWS::Lambda::Function").map(([, f]) => f.Properties.FunctionName as string);
    assert.ok(!names.some((n) => n.endsWith("-warmup")));
    const worker = resources(demo.template, "AWS::Lambda::Function").find(([, f]) => (f.Properties.FunctionName as string).endsWith("-worker"))![1];
    assert.equal((worker.Properties.Environment as { Variables: Record<string, unknown> }).Variables.WARMUP_ENABLED, "false");
  });

  it("settings: the reserve must stay below the fleet's limit; warmupEnabled is true or false", async () => {
    await assert.rejects(settings({ runnerMode: "per-job", warmupReserve: "4" }), /warmupReserve/);
    await assert.rejects(settings({ runnerMode: "per-job", warmupEnabled: "yes" }), /warmupEnabled/);
    assert.equal((await settings({ runnerMode: "per-job", warmupEnabled: "false" })).warmupEnabled, false);
  });
});
