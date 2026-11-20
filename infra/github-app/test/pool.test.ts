import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { cacheParameters, appPrefix } from "../lib/parameters.ts";
import { COMPONENT_LIMIT } from "../lib/runner-fleet.ts";
import { IMAGE_FILES, unbundle } from "../lib/runner.ts";
import { resources, synth } from "./helpers.ts";

type Stmt = { Effect: string; Action: string | string[]; Resource: unknown; Sid?: string; Condition?: Record<string, Record<string, unknown>> };
const arr = <T,>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);
const json = (x: unknown) => JSON.stringify(x);

describe("the stack: our machines (pool)", async () => {
  const { template: t, s, nagErrors } = await synth();
  const fns = resources(t, "AWS::Lambda::Function");
  const policies = resources(t, "AWS::IAM::Policy");
  const roles = Object.fromEntries(resources(t, "AWS::IAM::Role"));
  const statementsOf = (roleId: string): Stmt[] => policies
    .filter(([, p]) => json((p.Properties as { Roles: unknown }).Roles).includes(`"${roleId}"`))
    .flatMap(([, p]) => (p.Properties as { PolicyDocument: { Statement: Stmt[] } }).PolicyDocument.Statement);
  const fnRole = (n: string) => ((fns.find(([, r]) => (r.Properties.FunctionName as string).endsWith(n))![1].Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"])[0]!;
  const fnEnv = (n: string) => (fns.find(([, r]) => (r.Properties.FunctionName as string).endsWith(n))![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;

  it("cdk-nag: nothing left unsuppressed; six functions (http, api, worker, sweep, reaper, warmup); machines come from the pool, not the template", () => {
    assert.deepEqual(nagErrors, []);
    assert.deepEqual(fns.map(([, f]) => (f.Properties.FunctionName as string).replace("fenvix-prod-github-app-", "")).sort(), ["api", "http", "reaper", "sweep", "warmup", "worker"]);
    assert.equal(resources(t, "AWS::EC2::Instance").length, 1, "only the cache machine");
    assert.ok(!("RunnerInstanceId" in (t.toJSON().Outputs as object)));
  });

  it("the worker, the warm-up scheduler and the sweep run the pool: its settings, the launch template, the machines' plain settings (no secret)", () => {
    const e = fnEnv("worker");
    assert.equal(e.RUNNER_MODE, "pool");
    for (const f of ["warmup", "sweep"]) assert.deepEqual([fnEnv(f).RUNNER_MODE, fnEnv(f).FENVIX_POOL], ["pool", e.FENVIX_POOL], f);
    const pool = JSON.parse(String(e.FENVIX_POOL));
    assert.deepEqual({ type: pool.sizes[pool.defaultSize].instanceType, alwaysOn: pool.alwaysOn, reserve: pool.reserve }, { type: "c7a.xlarge", alwaysOn: 1, reserve: 2 }, "the design of 2026-11-20");
    assert.equal(e.FENVIX_API_URL, "https://api.fenvix.dev");
    assert.match(json(e.RUNNER_LAUNCH_TEMPLATE_ID), /FleetLaunchTemplate/);
    // The worker appends the job's installation (gh-<id>) and signs that job's cache token.
    assert.equal(e.FENVIX_MACHINE_FENVIX_CACHE_URL, "http://10.42.0.10:8787");
    assert.equal(e.FENVIX_MACHINE_FENVIX_SUMMARIES_URL, "https://api.fenvix.dev/v1/runner/summaries");
    assert.equal(e.CACHE_SIGNING_KEY_PARAM, "/fenvix/prod/cache/signing-key");
    for (const k of Object.keys(e)) assert.doesNotMatch(k, /^FENVIX_MACHINE_.*TOKEN/, "no machine reads a parameter");
    for (const k of Object.keys(e)) if (!k.endsWith("_PARAM")) assert.doesNotMatch(k, /SECRET|PRIVATE_KEY|DATABASE_URL|SIGNING/, k);
    // The HTTP function answers the machines (hello, poll, events) and has no EC2 right at all.
    assert.equal(fnEnv("http").RUNNER_MODE, "pool");
    assert.ok(!statementsOf(fnRole("http")).some((x) => arr(x.Action).some((a) => a.startsWith("ec2:"))), "no EC2 call from the HTTP function");
  });

  it("runner placement by the organization's region: this stack's fleet under its fenvix region (eu: the machines are in eu-west-1)", async () => {
    const placement = (v: unknown) => {
      // { "Fn::Join": ["", [...parts]] }: the launch template id is a reference; the rest is the JSON around it.
      const parts = (v as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1];
      return JSON.parse(parts.map((x) => (typeof x === "string" ? x : "LT")).join("")) as Record<string, { awsRegion: string; launchTemplateId: string }>;
    };
    assert.deepEqual(placement(fnEnv("worker").RUNNER_PLACEMENT), { eu: { awsRegion: "eu-west-1", launchTemplateId: "LT" } });
    assert.match(json(fnEnv("worker").RUNNER_PLACEMENT), /FleetLaunchTemplate/);
    assert.match(json(fnEnv("worker").RUNNER_LAUNCH_TEMPLATE_ID), /FleetLaunchTemplate/, "kept");
    const two = await synth({ fenvixRegion: "eu", secondFenvixRegion: "us", secondAwsRegion: "us-east-1", secondLaunchTemplateId: "lt-0123456789abcdef0", secondCacheUrl: "http://10.43.0.10:8787" });
    const env2 = (resources(two.template, "AWS::Lambda::Function").find(([, r]) => (r.Properties.FunctionName as string).endsWith("worker"))![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    assert.deepEqual(placement(env2.RUNNER_PLACEMENT), {
      eu: { awsRegion: "eu-west-1", launchTemplateId: "LT" },
      us: { awsRegion: "us-east-1", launchTemplateId: "lt-0123456789abcdef0", machineEnv: { FENVIX_CACHE_URL: "http://10.43.0.10:8787" } },
    });
    assert.deepEqual(two.nagErrors, []);
  });

  it("the worker, the warm-up scheduler and the sweep may start only tagged pool machines of the pool's sizes, from our launch template and our own images", () => {
    const ec2Of = (f: string) => statementsOf(fnRole(f)).filter((x) => arr(x.Action).some((a) => a.startsWith("ec2:") || a === "iam:PassRole")).map((x) => json(x)).sort();
    for (const f of ["warmup", "sweep"]) assert.deepEqual(ec2Of(f), ec2Of("worker"), `${f}: the same EC2 rights as the worker`);
    const st = statementsOf(fnRole("worker"));
    const run = st.filter((x) => arr(x.Action).includes("ec2:RunInstances"));
    assert.equal(run.length, 6);
    const tagged = run.find((x) => x.Sid === "OnlyTaggedJobMachines")!;
    assert.deepEqual(tagged.Condition!.StringEquals, { "aws:RequestTag/fenvix:role": "runner-pool", "ec2:InstanceType": ["c7a.2xlarge", "c7a.xlarge"] });
    assert.match(json(run.find((x) => x.Sid === "SpotRequestsAtLaunch")!.Resource), /spot-instances-request\/\*/);
    // Instance, disk and network interface: only through our launch template (R-012 F7).
    for (const sid of ["OnlyTaggedJobMachines", "OnlyTaggedJobDisks", "NetworkInterfaceFromTemplate"]) {
      assert.match(json(run.find((x) => x.Sid === sid)!.Condition!.ArnEquals), /"ec2:LaunchTemplate":.*launch-template\//, sid);
    }
    assert.deepEqual(run.find((x) => x.Sid === "RunFromOwnImages")!.Condition, { StringEquals: { "ec2:Owner": s.account } });
    assert.match(json(run.find((x) => x.Sid === "RunJobMachines")!.Resource), /launch-template\//);
    assert.deepEqual(st.find((x) => x.Sid === "TagAtLaunchOnly")!.Condition, { StringEquals: { "ec2:CreateAction": "RunInstances" } });
    const pass = st.find((x) => arr(x.Action).includes("iam:PassRole"))!;
    assert.match(json(pass.Resource), /FleetJobRole/);
    // Start, stop, replace the user data of (a stopped reserve machine), terminate: pool machines only.
    const manage = st.filter((x) => arr(x.Action).some((a) => ["ec2:TerminateInstances", "ec2:StartInstances", "ec2:StopInstances", "ec2:ModifyInstanceAttribute"].includes(a)));
    assert.equal(manage.length, 1);
    assert.deepEqual(manage[0]!.Condition, { StringEquals: { "aws:ResourceTag/fenvix:role": "runner-pool" } });
  });

  it("the reaper (a backstop) may only terminate pool machines; it runs every 10 minutes; the limit is runnerMaxHours + 1", () => {
    const st = statementsOf(fnRole("reaper"));
    const term = st.find((x) => arr(x.Action).includes("ec2:TerminateInstances"))!;
    assert.deepEqual(term.Condition, { StringEquals: { "aws:ResourceTag/fenvix:role": "runner-pool" } });
    assert.ok(!st.some((x) => arr(x.Action).some((a) => a.startsWith("ssm:"))), "no secret");
    assert.equal(fnEnv("reaper").REAP, "runner-pool:7");
    t.hasResourceProperties("AWS::Scheduler::Schedule", { Name: "fenvix-prod-github-app-reaper", ScheduleExpression: "rate(10 minutes)" });
  });

  it("launch template: c7a.xlarge (not burstable), terminate on shutdown, IMDSv2, 30 GB gp3 encrypted, runner security group, public address", () => {
    const [, lt] = resources(t, "AWS::EC2::LaunchTemplate")[0]!;
    const d = lt.Properties.LaunchTemplateData as Record<string, unknown>;
    assert.equal(d.InstanceType, "c7a.xlarge");
    assert.equal(d.InstanceInitiatedShutdownBehavior, "terminate");
    assert.deepEqual(d.MetadataOptions, { HttpTokens: "required", HttpPutResponseHopLimit: 1, HttpEndpoint: "enabled" });
    assert.deepEqual(d.BlockDeviceMappings, [{ DeviceName: "/dev/sda1", Ebs: { VolumeSize: 30, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: true } }]);
    assert.equal(d.CreditSpecification, undefined, "no credit option on a non-burstable type");
    const ni = (d.NetworkInterfaces as Record<string, unknown>[])[0]!;
    assert.equal(ni.AssociatePublicIpAddress, true);
    assert.match(json(ni.Groups), /NetworkRunnerSg/);
  });

  it("job machines' role: no permission at all; the worker reads the summary key and the cache signing key (R-012 F2)", () => {
    const roleId = Object.entries(roles).find(([id]) => id.startsWith("FleetJobRole"))![0];
    assert.deepEqual(statementsOf(roleId), []);
    assert.equal(roles[roleId]!.Properties.ManagedPolicyArns, undefined);
    const reads = statementsOf(fnRole("worker")).filter((x) => json(x.Action).includes("ssm:")).flatMap((x) => arr(x.Resource)).map((r) => json(r).match(/parameter(\/fenvix[^"]*)/)![1]).sort();
    const launch = [`${appPrefix("prod")}/database-url`, `${appPrefix("prod")}/private-key`, `${appPrefix("prod")}/runner-token`, `${appPrefix("prod")}/database-ca-cert`, ...cacheParameters("prod").map((p) => p.name)].sort();
    assert.deepEqual(reads, launch);
    const sweepReads = statementsOf(fnRole("sweep")).filter((x) => json(x.Action).includes("ssm:")).flatMap((x) => arr(x.Resource)).map((r) => json(r).match(/parameter(\/fenvix[^"]*)/)![1]).sort();
    assert.deepEqual(sweepReads, launch, "the sweep dispatches waiting jobs: the same launch secrets, nothing of HTTP");
  });

  it("the image: Ubuntu 24.04 parent, install.sh in a component under the 16,000-character limit, AMI tagged for the launcher", () => {
    const comps = resources(t, "AWS::ImageBuilder::Component");
    assert.equal(comps.length, 2, "the install component and the image tests (G-1745)");
    const [, comp] = comps.find(([id]) => !id.includes("TestComponent"))!;
    const [, tests] = comps.find(([id]) => id.includes("TestComponent"))!;
    assert.match(tests.Properties.Data as string, /- name: test\n[\s\S]*fenvix-replay[\s\S]*fenvix machine image: ok/);
    const data = comp.Properties.Data as string;
    assert.ok(data.length <= COMPONENT_LIMIT, `${data.length}`);
    assert.match(data, /bash \/opt\/fenvix\/install\.sh/);
    const files = unbundle(data.split("\n").map((l) => l.trim()).find((l) => l.startsWith("echo '"))!);
    for (const [file, dest, mode] of IMAGE_FILES) {
      assert.equal(files[dest]?.text, readFileSync(new URL(`../lib/runner/files/${file}`, import.meta.url), "utf8"), dest);
      assert.equal(files[dest]?.mode, mode, dest);
    }
    assert.doesNotMatch(data, /BEGIN|PRIVATE KEY|registration-token=/, "no secret in the image");
    t.hasResourceProperties("AWS::ImageBuilder::ImageRecipe", { ParentImage: "ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id" });
    const [, dist] = resources(t, "AWS::ImageBuilder::DistributionConfiguration")[0]!;
    const ami = (dist.Properties.Distributions as { AmiDistributionConfiguration: Record<string, unknown> }[])[0]!.AmiDistributionConfiguration;
    assert.deepEqual(ami.AmiTags, { "fenvix:image": "runner", project: "fenvix", env: "prod" });
    assert.match(String(ami.Name), /^fenvix-prod-runner-\{\{ imagebuilder:buildDate \}\}$/);
    t.hasResourceProperties("AWS::ImageBuilder::InfrastructureConfiguration", { InstanceTypes: ["c7a.xlarge"], TerminateInstanceOnFailure: true });
    // The engine is the trunk artifact, pinned by version and sha256; nothing clones or builds the engine (G-0186, G-2306).
    assert.doesNotMatch(data, /git clone|engine-cli\.git|bootstrap\.sh install|rustup|astral\.sh/);
    assert.match(data, /FENVIX_ENGINE_SHA256=/);
    assert.match(data, /FENVIX_RUNNER_SHA256=[0-9a-f]{64}/);
    t.hasOutput("ImagePipelineArn", {});
  });

  it("the cache machine: t4g.nano, fixed private address, no public address, reachable only from runners on 8787", () => {
    const [, i] = resources(t, "AWS::EC2::Instance")[0]!;
    assert.equal(i.Properties.InstanceType, "t4g.nano");
    assert.match(json(i.Properties.ImageId), /arm64/);
    const ni = (i.Properties.NetworkInterfaces as Record<string, unknown>[])[0]!;
    assert.equal(ni.AssociatePublicIpAddress, false);
    assert.equal(ni.PrivateIpAddress, "10.42.0.10");
    assert.match(json(ni.GroupSet), /NetworkCacheSg/);
    const ud = (i.Properties.UserData as { "Fn::Base64": string })["Fn::Base64"];
    // The public half of the signing key only (it verifies per-job tokens; it can mint none).
    const key = JSON.parse(Buffer.from(ud.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d >\/etc\/fenvix-cache\/signing-key\.json/)![1]!, "base64").toString());
    assert.deepEqual(Object.keys(key).sort(), ["e", "n"]);
    assert.equal(key.e, 65537);
    assert.doesNotMatch(ud, /tokens\.json|PRIVATE/);
    assert.ok(i.Properties.LaunchTemplate, "IMDSv2 through a launch template, so cdk-nag evaluates EC26 (R-012 F14)");
    const ingress = resources(t, "AWS::EC2::SecurityGroupIngress");
    assert.equal(ingress.length, 1);
    assert.equal(ingress[0]![1].Properties.FromPort, 8787);
    assert.match(json(ingress[0]![1].Properties.SourceSecurityGroupId), /NetworkRunnerSg/);
    for (const [, sg] of resources(t, "AWS::EC2::SecurityGroup")) assert.equal(sg.Properties.SecurityGroupIngress, undefined, "no inline inbound rule, none from the internet");
    const cacheSg = resources(t, "AWS::EC2::SecurityGroup").find(([id]) => id.startsWith("NetworkCacheSg"))![1];
    assert.match(json(cacheSg.Properties.SecurityGroupEgress), /255\.255\.255\.255\/32/, "no outbound (CDK's placeholder rule)");
  });
});
