import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resources, settings, synth } from "./helpers.ts";

type Stmt = { Effect: string; Action: string | string[]; Resource: unknown; Sid?: string };
const arr = <T,>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);
const json = (x: unknown) => JSON.stringify(x);
const PNAP = { customerMode: "pnap", pnapRegions: "ASH:0:3,NLD:0:2", pnapFirecrackerSha256: "c".repeat(64) };

describe("customer mode on phoenixNAP (customerMode pnap, beside demo mode)", async () => {
  const { template: t, nagErrors } = await synth(PNAP);
  const fns = resources(t, "AWS::Lambda::Function");
  const policies = resources(t, "AWS::IAM::Policy");
  const byName = (n: string) => fns.find(([, f]) => f.Properties.FunctionName === `fenvix-prod-github-app-${n}`)?.[1];
  const roleOf = (n: string) => ((byName(n)!.Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"])[0]!;
  const statementsOf = (roleId: string): Stmt[] => policies
    .filter(([, p]) => json((p.Properties as { Roles: unknown }).Roles).includes(`"${roleId}"`))
    .flatMap(([, p]) => (p.Properties as { PolicyDocument: { Statement: Stmt[] } }).PolicyDocument.Statement);
  const reads = (n: string) => statementsOf(roleOf(n)).filter((x) => arr(x.Action).includes("ssm:GetParameters"))
    .flatMap((x) => arr(x.Resource)).map((r) => json(r).match(/parameter(\/fenvix[^"]*)/)![1]!).sort();
  const vars = (n: string) => (byName(n)!.Properties.Environment as { Variables: Record<string, string> }).Variables;

  it("cdk-nag (AwsSolutions): nothing left unsuppressed", () => assert.deepEqual(nagErrors, []));

  it("adds the hosts and scaler functions; demo mode stays", () => {
    assert.deepEqual(fns.map(([, f]) => f.Properties.FunctionName).sort(), ["demo", "hosts", "http", "reaper", "scaler", "sweep", "worker"].map((x) => `fenvix-prod-github-app-${x}`));
  });

  it("the scaler reads the database URL and the phoenixNAP API client only; one run at a time, every minute", () => {
    assert.deepEqual(reads("scaler"), ["/fenvix/prod/github-app/database-url", "/fenvix/prod/pnap/client-id", "/fenvix/prod/pnap/client-secret"]);
    assert.equal(byName("scaler")!.Properties.ReservedConcurrentExecutions, 1);
    const sched = resources(t, "AWS::Scheduler::Schedule").find(([, r]) => r.Properties.Name === "fenvix-prod-github-app-scaler")![1];
    assert.equal(sched.Properties.ScheduleExpression, "rate(1 minute)");
    for (const x of statementsOf(roleOf("scaler"))) for (const a of arr(x.Action)) assert.ok(!/^(ec2|sqs|s3):/.test(a), a);
  });

  it("the hosts function: the App key, RUNNER_TOKEN, the host and cache signing keys; never the webhook, OAuth or state secrets", () => {
    assert.deepEqual(reads("hosts"), [
      "/fenvix/prod/cache/signing-key", "/fenvix/prod/github-app/database-url", "/fenvix/prod/github-app/host-signing-key",
      "/fenvix/prod/github-app/host-signing-key-previous", "/fenvix/prod/github-app/private-key", "/fenvix/prod/github-app/runner-token",
    ]);
    for (const n of ["http", "worker", "sweep", "scaler", "demo"]) assert.ok(!reads(n).some((p) => p.includes("host-signing")), n);
    assert.ok(!reads("http").some((p) => p.includes("/pnap/")), "the HTTP function never sees the phoenixNAP client");
  });

  it("the worker places jobs by region; no secret value in any function's environment", () => {
    assert.equal(vars("worker").CUSTOMER_MODE, "pnap");
    assert.equal(vars("worker").PNAP_REGIONS, "ASH:0:3,NLD:0:2");
    for (const n of ["hosts", "scaler"]) {
      const v = vars(n);
      assert.equal(v.PNAP_CONTROL_URL, "https://github.fenvix.dev");
      assert.equal(v.PNAP_FIRECRACKER_SHA256, "c".repeat(64));
      for (const k of Object.keys(v)) if (!k.endsWith("_PARAM") && !k.startsWith("PNAP_CACHE_PUBLIC_KEY") && k !== "PNAP_FIRECRACKER_SHA256") assert.doesNotMatch(k, /SECRET|PRIVATE|TOKEN|DATABASE_URL|SIGNING/, `${n} ${k}`);
    }
    assert.match(vars("scaler").PNAP_CACHE_PUBLIC_KEY_N!, /^[0-9a-f]{512}$/, "public half only");
  });

  it("API Gateway routes POST /v1/hosts/{proxy+} to the hosts function, everything else to the HTTP function", () => {
    const routes = resources(t, "AWS::ApiGatewayV2::Route").map(([, r]) => r.Properties.RouteKey);
    assert.ok(routes.includes("POST /v1/hosts/{proxy+}"), json(routes));
    const ints = resources(t, "AWS::ApiGatewayV2::Integration");
    assert.ok(ints.some(([, i]) => json(i.Properties.IntegrationUri).includes("Hosts")));
  });

  it("the permissions boundary allows the phoenixNAP parameters (and nothing else new)", () => {
    const b = JSON.parse(readFileSync(new URL("../permissions-boundary.json", import.meta.url), "utf8")) as { Statement: Stmt[] };
    const ssm = b.Statement.find((x) => x.Sid === "OwnParametersAndUbuntuImages")!;
    assert.ok(arr(ssm.Resource as string | string[]).includes("arn:aws:ssm:eu-west-1:865859654353:parameter/fenvix/prod/pnap/*"));
  });

  it("settings: refused when wrong", async () => {
    const bad: Record<string, string>[] = [{ pnapFirecrackerSha256: "" }, { pnapRegions: "FRA:0:1" }, { runnerMode: "per-job" }, { pnapDefaultRegion: "SEA" }, { pnapCacheMode: "shared" }, { pnapSshKeyIds: "a;b" }];
    for (const over of bad) {
      await assert.rejects(settings({ ...PNAP, ...over }), Error, json(over));
    }
  });
});

describe("customer mode off (the default): nothing of it in the stack", async () => {
  const { template: t } = await synth();
  it("no hosts or scaler function, no /v1/hosts route", () => {
    const names = resources(t, "AWS::Lambda::Function").map(([, f]) => f.Properties.FunctionName as string);
    assert.ok(!names.some((n) => /hosts|scaler/.test(n)));
    assert.ok(!resources(t, "AWS::ApiGatewayV2::Route").some(([, r]) => String(r.Properties.RouteKey).includes("/v1/hosts")));
  });
});
