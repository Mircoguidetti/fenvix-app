import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appPrefix, cacheParameters } from "../lib/parameters.ts";
import { resources, settings, synth } from "./helpers.ts";
import { readFileSync } from "node:fs";

type Stmt = { Effect: string; Action: string | string[]; Resource: unknown; Sid?: string; Condition?: Record<string, Record<string, unknown>> };
const arr = <T,>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);
const json = (x: unknown) => JSON.stringify(x);

describe("warm-up runs (our machines): the warm-up scheduler function, its schedule and rights", async () => {
  const { template: t, nagErrors } = await synth();
  const fns = resources(t, "AWS::Lambda::Function");
  const policies = resources(t, "AWS::IAM::Policy");
  const statementsOf = (roleId: string): Stmt[] => policies
    .filter(([, p]) => json((p.Properties as { Roles: unknown }).Roles).includes(`"${roleId}"`))
    .flatMap(([, p]) => (p.Properties as { PolicyDocument: { Statement: Stmt[] } }).PolicyDocument.Statement);
  const fn = (n: string) => fns.find(([, r]) => (r.Properties.FunctionName as string).endsWith(`-${n}`))![1];
  const fnRole = (n: string) => ((fn(n).Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"])[0]!;
  const fnEnv = (n: string) => (fn(n).Properties.Environment as { Variables: Record<string, unknown> }).Variables;

  it("cdk-nag clean with the warm-up function", () => assert.deepEqual(nagErrors, []));

  it("runs every minute, invoked by the scheduler role only; a failed invocation is retried twice, then dead-lettered (G-1737)", () => {
    t.hasResourceProperties("AWS::Scheduler::Schedule", { Name: "fenvix-prod-github-app-warmup", ScheduleExpression: "rate(1 minute)", FlexibleTimeWindow: { Mode: "OFF" } });
    const [, sch] = resources(t, "AWS::Scheduler::Schedule").find(([id]) => id.startsWith("WarmupSchedule"))!;
    assert.match(json(sch.Properties.Target), /Warmup/);
    assert.equal((sch.Properties.Target as { RetryPolicy: { MaximumRetryAttempts: number } }).RetryPolicy.MaximumRetryAttempts, 2);
    assert.match(json((sch.Properties.Target as { DeadLetterConfig: unknown }).DeadLetterConfig), /DeadLetters/);
  });

  it("the worker and the scheduler get the WARMUP_* settings from the stack's settings; the node timer is off on AWS", () => {
    for (const who of ["worker", "warmup"]) {
      const e = fnEnv(who);
      assert.deepEqual({ en: e.WARMUP_ENABLED, cap: e.WARMUP_DAILY_CAP, conc: e.WARMUP_ORG_CONCURRENCY, res: e.WARMUP_RESERVE, grace: e.WARMUP_GRACE_SECONDS, tick: e.WARMUP_TICK_SECONDS },
        { en: "false", cap: "6", conc: "1", res: "1", grace: "180", tick: "0" }, who);
    }
    // Off until the trunk engine ships a warm-up executor (G-1731): no machine is started for a warm-up that cannot run.
    assert.equal(fnEnv("warmup").RUNNER_MODE, "pool");
    assert.match(json(fnEnv("warmup").RUNNER_PLACEMENT), /FleetLaunchTemplate/, "placement by the organization's region");
    for (const k of Object.keys(fnEnv("warmup"))) if (!k.endsWith("_PARAM")) assert.doesNotMatch(k, /SECRET|PRIVATE_KEY|DATABASE_URL|SIGNING/, k);
  });

  it("it may start only tagged pool machines from our template, and manage only pool machines", () => {
    const st = statementsOf(fnRole("warmup"));
    const tagged = st.find((x) => x.Sid === "OnlyTaggedJobMachines")!;
    assert.deepEqual(tagged.Condition!.StringEquals, { "aws:RequestTag/fenvix:role": "runner-pool", "ec2:InstanceType": ["c7a.2xlarge", "c7a.xlarge"] });
    const term = st.filter((x) => arr(x.Action).includes("ec2:TerminateInstances"));
    assert.equal(term.length, 1);
    assert.deepEqual(term[0]!.Condition, { StringEquals: { "aws:ResourceTag/fenvix:role": "runner-pool" } });
    assert.ok(!st.some((x) => arr(x.Action).some((a) => a.startsWith("sqs:") || a.startsWith("s3:"))), "neither queue nor bucket");
  });

  it("it reads exactly the launch secrets (database, App key, summary key, cache signing key), not the HTTP ones", () => {
    const reads = statementsOf(fnRole("warmup")).filter((x) => json(x.Action).includes("ssm:")).flatMap((x) => arr(x.Resource)).map((r) => json(r).match(/parameter(\/fenvix[^"]*)/)![1]).sort();
    assert.deepEqual(reads, [`${appPrefix("prod")}/database-url`, `${appPrefix("prod")}/private-key`, `${appPrefix("prod")}/runner-token`, `${appPrefix("prod")}/database-ca-cert`, ...cacheParameters("prod").map((p) => p.name)].sort());
  });

  it("a warm-up lease on our machines ends at once as unsupported until the engine ships its warm-up executor (G-1731)", () => {
    const agent = readFileSync(new URL("../lib/runner/files/fenvix-agent", import.meta.url), "utf8");
    assert.match(agent, /if lease.get\("kind"\) not in \("job", "replay"\):/);
    assert.match(agent, /unsupported: no .* executor in this engine/);
  });

  it("settings: the reserve must stay below the fleet's limit; warmupEnabled is true or false", async () => {
    await assert.rejects(settings({ warmupReserve: "8" }), /warmupReserve/);
    await assert.rejects(settings({ warmupEnabled: "yes" }), /warmupEnabled/);
    assert.equal((await settings({ warmupEnabled: "false" })).warmupEnabled, false);
  });
});
