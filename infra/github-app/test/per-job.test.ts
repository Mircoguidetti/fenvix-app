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

describe("the stack, per-job mode", async () => {
  const { template: t, s, nagErrors } = await synth({ runnerMode: "per-job" });
  const fns = resources(t, "AWS::Lambda::Function");
  const policies = resources(t, "AWS::IAM::Policy");
  const roles = Object.fromEntries(resources(t, "AWS::IAM::Role"));
  const statementsOf = (roleId: string): Stmt[] => policies
    .filter(([, p]) => json((p.Properties as { Roles: unknown }).Roles).includes(`"${roleId}"`))
    .flatMap(([, p]) => (p.Properties as { PolicyDocument: { Statement: Stmt[] } }).PolicyDocument.Statement);
  const fnRole = (n: string) => ((fns.find(([, r]) => (r.Properties.FunctionName as string).endsWith(n))![1].Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"])[0]!;
  const fnEnv = (n: string) => (fns.find(([, r]) => (r.Properties.FunctionName as string).endsWith(n))![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;

  it("cdk-nag: nothing left unsuppressed; four functions (http, worker, sweep, reaper); no always-on machine", () => {
    assert.deepEqual(nagErrors, []);
    assert.deepEqual(fns.map(([, f]) => (f.Properties.FunctionName as string).replace("fenvix-prod-github-app-", "")).sort(), ["http", "reaper", "sweep", "worker"]);
    assert.equal(resources(t, "AWS::EC2::Instance").length, 1, "only the cache machine");
    assert.ok(!("RunnerInstanceId" in (t.toJSON().Outputs as object)));
  });

  it("the worker launches: per-job settings, the launch template, the machines' plain settings (no secret)", () => {
    const e = fnEnv("worker");
    assert.equal(e.RUNNER_MODE, "per-job");
    assert.equal(e.RUNNER_MAX_RUNNING, "4");
    assert.match(json(e.RUNNER_LAUNCH_TEMPLATE_ID), /FleetLaunchTemplate/);
    // The worker appends the job's installation (gh-<id>) and signs that job's cache token.
    assert.equal(e.FENVIX_MACHINE_FENVIX_CACHE_URL, "http://10.42.0.10:8787");
    assert.equal(e.FENVIX_MACHINE_FENVIX_SUMMARIES_URL, "https://github.fenvix.dev/v1/runner/summaries");
    assert.equal(e.FENVIX_MACHINE_FENVIX_IDLE_MINUTES, "20");
    assert.equal(e.CACHE_SIGNING_KEY_PARAM, "/fenvix/prod/cache/signing-key");
    for (const k of Object.keys(e)) assert.doesNotMatch(k, /^FENVIX_MACHINE_.*TOKEN/, "no machine reads a parameter");
    for (const k of Object.keys(e)) if (!k.endsWith("_PARAM")) assert.doesNotMatch(k, /SECRET|PRIVATE_KEY|DATABASE_URL|SIGNING/, k);
    assert.equal(fnEnv("http").RUNNER_MODE, undefined, "the HTTP function never launches");
  });

  it("the worker may start only tagged job machines, from our launch template and our own images, and pass only their role", () => {
    const st = statementsOf(fnRole("worker"));
    const run = st.filter((x) => arr(x.Action).includes("ec2:RunInstances"));
    assert.equal(run.length, 5);
    const tagged = run.find((x) => x.Sid === "OnlyTaggedJobMachines")!;
    assert.deepEqual(tagged.Condition!.StringEquals, { "aws:RequestTag/fenvix:role": "runner-job", "ec2:InstanceType": "c6i.large" });
    // Instance, disk and network interface: only through our launch template (R-012 F7).
    for (const sid of ["OnlyTaggedJobMachines", "OnlyTaggedJobDisks", "NetworkInterfaceFromTemplate"]) {
      assert.match(json(run.find((x) => x.Sid === sid)!.Condition!.ArnEquals), /"ec2:LaunchTemplate":.*launch-template\//, sid);
    }
    assert.deepEqual(run.find((x) => x.Sid === "RunFromOwnImages")!.Condition, { StringEquals: { "ec2:Owner": s.account } });
    assert.match(json(run.find((x) => x.Sid === "RunJobMachines")!.Resource), /launch-template\//);
    assert.deepEqual(st.find((x) => x.Sid === "TagAtLaunchOnly")!.Condition, { StringEquals: { "ec2:CreateAction": "RunInstances" } });
    const pass = st.find((x) => arr(x.Action).includes("iam:PassRole"))!;
    assert.match(json(pass.Resource), /FleetJobRole/);
    assert.ok(!st.some((x) => arr(x.Action).includes("ec2:TerminateInstances")), "the worker never terminates");
  });

  it("the reaper may only terminate job machines; it runs every 10 minutes; the limit is runnerMaxHours", () => {
    const st = statementsOf(fnRole("reaper"));
    const term = st.find((x) => arr(x.Action).includes("ec2:TerminateInstances"))!;
    assert.deepEqual(term.Condition, { StringEquals: { "aws:ResourceTag/fenvix:role": "runner-job" } });
    assert.ok(!st.some((x) => arr(x.Action).some((a) => a.startsWith("ssm:"))), "no secret");
    assert.equal(fnEnv("reaper").REAP, "runner-job:6");
    t.hasResourceProperties("AWS::Scheduler::Schedule", { Name: "fenvix-prod-github-app-reaper", ScheduleExpression: "rate(10 minutes)" });
  });

  it("launch template: c6i.large (not burstable), terminate on shutdown, IMDSv2, 30 GB gp3 encrypted, runner security group, public address", () => {
    const [, lt] = resources(t, "AWS::EC2::LaunchTemplate")[0]!;
    const d = lt.Properties.LaunchTemplateData as Record<string, unknown>;
    assert.equal(d.InstanceType, "c6i.large");
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
    assert.deepEqual(reads, [`${appPrefix("prod")}/database-url`, `${appPrefix("prod")}/private-key`, `${appPrefix("prod")}/runner-token`, ...cacheParameters("prod").map((p) => p.name)].sort());
  });

  it("the image: Ubuntu 24.04 parent, install.sh in a component under the 16,000-character limit, AMI tagged for the launcher", () => {
    const [, comp] = resources(t, "AWS::ImageBuilder::Component")[0]!;
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
    t.hasResourceProperties("AWS::ImageBuilder::InfrastructureConfiguration", { InstanceTypes: ["c6i.large"], TerminateInstanceOnFailure: true });
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
