import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { appParameters, registrationTokenName } from "../lib/parameters.ts";
import { RUNNER_FILES } from "../lib/runner.ts";
import { resources, synth, type Res } from "./helpers.ts";

type Stmt = { Effect: string; Action: string | string[]; Resource: unknown; Sid?: string };
const arr = <T,>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);
const json = (x: unknown) => JSON.stringify(x);

describe("the stack (cdk synth)", async () => {
  const { template: t, s, nagErrors } = await synth();
  const fns = resources(t, "AWS::Lambda::Function");
  const roles = Object.fromEntries(resources(t, "AWS::IAM::Role").map(([id, r]) => [id, r]));
  const policies = resources(t, "AWS::IAM::Policy");
  /** Every statement attached to a role, by role logical id. */
  const statementsOf = (roleId: string): Stmt[] => policies
    .filter(([, p]) => json((p.Properties as { Roles: unknown }).Roles).includes(`"${roleId}"`))
    .flatMap(([, p]) => (p.Properties as { PolicyDocument: { Statement: Stmt[] } }).PolicyDocument.Statement);
  const fnRole = (fnName: string) => {
    const [, f] = fns.find(([, r]) => (r.Properties.FunctionName as string).endsWith(fnName))!;
    return ((f.Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"])[0]!;
  };

  it("cdk-nag (AwsSolutions): nothing left unsuppressed", () => {
    assert.deepEqual(nagErrors, []);
  });

  it("three functions: Node 22, x86_64, the plain settings only (no secret in any environment variable)", () => {
    assert.deepEqual(fns.map(([, f]) => f.Properties.FunctionName).sort(), ["fenvix-prod-github-app-http", "fenvix-prod-github-app-sweep", "fenvix-prod-github-app-worker"]);
    for (const [, f] of fns) {
      assert.equal(f.Properties.Runtime, "nodejs22.x");
      assert.deepEqual(f.Properties.Architectures, ["x86_64"]);
      const vars = (f.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
      assert.equal(vars.SSM_PREFIX, "/fenvix/prod/github-app");
      assert.equal(vars.SWEEP_SECONDS, "0", "no timer inside a Lambda");
      for (const k of Object.keys(vars)) assert.doesNotMatch(k, /SECRET|PRIVATE_KEY|TOKEN|DATABASE_URL|SIGNING/, k);
    }
    const http = fns.find(([, f]) => f.Properties.FunctionName === "fenvix-prod-github-app-http")![1];
    assert.ok("WORK_QUEUE_URL" in (http.Properties.Environment as { Variables: object }).Variables);
    assert.equal(http.Properties.Timeout, 29);
  });

  it("least privilege: each function reads only its own parameters, by exact name; no managed policy, no '*' action", () => {
    const want = (who: string) => appParameters("prod").filter((p) => p.readers.includes(who as never)).map((p) => `parameter${p.name}`).sort();
    for (const who of ["http", "worker", "sweep"]) {
      const roleId = fnRole(who);
      assert.equal(roles[roleId]!.Properties.ManagedPolicyArns, undefined, `${who}: no managed policy`);
      const st = statementsOf(roleId);
      const ssm = st.filter((x) => arr(x.Action).some((a) => a.startsWith("ssm:")));
      assert.deepEqual(ssm.flatMap((x) => arr(x.Action)), ["ssm:GetParameters"]);
      const names = ssm.flatMap((x) => arr(x.Resource)).map((r) => json(r).match(/parameter\/fenvix[^"]*/)![0]).sort();
      assert.deepEqual(names, want(who), who);
      for (const x of st) for (const a of arr(x.Action)) assert.ok(a !== "*" && !a.endsWith(":*"), `${who}: ${a}`);
    }
    assert.ok(!statementsOf(fnRole("worker")).some((x) => arr(x.Action).includes("sqs:SendMessage")), "the worker does not send");
    assert.ok(!statementsOf(fnRole("sweep")).some((x) => json(x.Action).includes("sqs:") || json(x.Action).includes("s3:")), "the sweep touches neither queue nor bucket");
    const httpS3 = statementsOf(fnRole("http")).filter((x) => json(x.Action).includes("s3:"));
    assert.deepEqual(httpS3.flatMap((x) => arr(x.Action)), ["s3:PutObject"]);
  });

  it("SQS: dead-letter queue after 5 tries, visibility six times the worker timeout, encrypted, TLS only", () => {
    const qs = resources(t, "AWS::SQS::Queue");
    const work = qs.find(([, q]) => q.Properties.QueueName === "fenvix-prod-github-app-work")![1].Properties;
    assert.equal((work.RedrivePolicy as { maxReceiveCount: number }).maxReceiveCount, 5);
    assert.equal(work.VisibilityTimeout, 720);
    for (const [, q] of qs) assert.equal(q.Properties.SqsManagedSseEnabled, true);
    assert.equal(resources(t, "AWS::SQS::QueuePolicy").length, 2);
    t.hasResourceProperties("AWS::Lambda::EventSourceMapping", { BatchSize: 5, FunctionResponseTypes: ["ReportBatchItemFailures"], ScalingConfig: { MaximumConcurrency: 2 } });
  });

  it("the sweep runs on an EventBridge Scheduler rate, invoking only the sweep function", () => {
    t.hasResourceProperties("AWS::Scheduler::Schedule", { ScheduleExpression: "rate(1 minute)", FlexibleTimeWindow: { Mode: "OFF" } });
    const [, sch] = resources(t, "AWS::Scheduler::Schedule")[0]!;
    assert.match(json(sch.Properties.Target), /Sweep/);
  });

  it("HTTPS only on github.fenvix.dev: ACM certificate validated by DNS, the execute-api URL off, throttled, access logs", () => {
    t.hasResourceProperties("AWS::CertificateManager::Certificate", { DomainName: "github.fenvix.dev", ValidationMethod: "DNS" });
    const [, cert] = resources(t, "AWS::CertificateManager::Certificate")[0]!;
    assert.equal(cert.Properties.DomainValidationOptions, undefined, "no Route 53 zone: the record goes to Cloudflare by hand");
    t.hasResourceProperties("AWS::ApiGatewayV2::DomainName", { DomainName: "github.fenvix.dev" });
    t.hasResourceProperties("AWS::ApiGatewayV2::Api", { ProtocolType: "HTTP", DisableExecuteApiEndpoint: true });
    t.hasResourceProperties("AWS::ApiGatewayV2::Stage", { StageName: "$default", AutoDeploy: true, DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 } });
    const [, stage] = resources(t, "AWS::ApiGatewayV2::Stage")[0]!;
    assert.ok(stage.Properties.AccessLogSettings);
    t.hasResourceProperties("AWS::ApiGatewayV2::Integration", { IntegrationType: "AWS_PROXY", PayloadFormatVersion: "2.0" });
    t.hasOutput("DnsTarget", {});
  });

  it("logs: every log group kept 14 days", () => {
    const lgs = resources(t, "AWS::Logs::LogGroup");
    assert.equal(lgs.length, 4);
    for (const [, lg] of lgs) assert.equal(lg.Properties.RetentionInDays, s.logRetentionDays);
  });

  it("runner machine: t3.medium, 30 GB gp3 encrypted, IMDSv2, no inbound, outbound 80/443 only", () => {
    const [, i] = resources(t, "AWS::EC2::Instance")[0]!;
    assert.equal(i.Properties.InstanceType, "t3.medium");
    assert.deepEqual(i.Properties.BlockDeviceMappings, [{ DeviceName: "/dev/sda1", Ebs: { DeleteOnTermination: true, Encrypted: true, VolumeSize: 30, VolumeType: "gp3" } }]);
    assert.deepEqual(i.Properties.MetadataOptions, { HttpTokens: "required", HttpPutResponseHopLimit: 1, HttpEndpoint: "enabled" });
    assert.match(json(i.Properties.ImageId), /canonicalubuntuserver2404/, "Ubuntu 24.04 when no AMI is pinned");
    const sgs = resources(t, "AWS::EC2::SecurityGroup");
    assert.equal(sgs.length, 1);
    const sg = sgs[0]![1].Properties;
    assert.equal(sg.SecurityGroupIngress, undefined);
    assert.equal(resources(t, "AWS::EC2::SecurityGroupIngress").length, 0);
    assert.deepEqual((sg.SecurityGroupEgress as { FromPort: number; IpProtocol: string }[]).map((e) => `${e.IpProtocol}/${e.FromPort}`).sort(), ["tcp/443", "tcp/80"]);
    assert.equal(resources(t, "AWS::EC2::NatGateway").length, 0, "no NAT gateway (it costs by the hour)");
  });

  it("runner role: Session Manager, read the runner token and the registration token, delete only the registration token", () => {
    const roleId = Object.entries(roles).find(([, r]) => json(r.Properties.AssumeRolePolicyDocument).includes("ec2.amazonaws.com"))![0];
    const st = statementsOf(roleId);
    const get = st.find((x) => x.Sid === "ReadRunnerTokens")!;
    assert.deepEqual(arr(get.Action), ["ssm:GetParameter"]);
    assert.match(json(get.Resource), /parameter\/fenvix\/prod\/github-app\/runner-token/);
    assert.match(json(get.Resource), /parameter\/fenvix\/prod\/runner\/registration-token/);
    assert.doesNotMatch(json(get.Resource), /private-key|webhook-secret|database-url/);
    const del = st.find((x) => x.Sid === "DeleteUsedRegistrationToken")!;
    assert.deepEqual(arr(del.Action), ["ssm:DeleteParameter"]);
    assert.match(json(del.Resource), new RegExp(`parameter${registrationTokenName("prod")}`));
    assert.match(json(roles[roleId]!.Properties.ManagedPolicyArns), /AmazonSSMManagedInstanceCore/);
  });

  it("user data: under the 16 KB limit; settings without secrets; every file round-trips byte for byte", () => {
    const [, i] = resources(t, "AWS::EC2::Instance")[0]!;
    const ud = i.Properties.UserData as { "Fn::Base64": string };
    const text = ud["Fn::Base64"];
    assert.equal(typeof text, "string", "no token or reference inside");
    assert.ok(Buffer.byteLength(text) < 16 * 1024, `${Buffer.byteLength(text)} bytes`);
    assert.match(text, /^FENVIX_SUMMARIES_URL=https:\/\/github\.fenvix\.dev\/v1\/runner\/summaries$/m);
    assert.match(text, /^FENVIX_REPO_URL=https:\/\/github\.com\/Mircoguidetti\/fenvix-demo$/m);
    assert.match(text, /^FENVIX_ENGINE_CLI_COMMIT=[0-9a-f]{40}$/m);
    for (const [file, dest] of RUNNER_FILES) {
      const m = text.match(new RegExp(`echo '([A-Za-z0-9+/=]+)' \\| base64 -d \\| gunzip >${dest.replace(/[.]/g, "\\.")}\\n`));
      assert.ok(m, dest);
      assert.equal(gunzipSync(Buffer.from(m[1]!, "base64")).toString(), readFileSync(new URL(`../lib/runner/files/${file}`, import.meta.url), "utf8"), file);
    }
    assert.match(text, /\nbash \/opt\/fenvix\/setup\.sh\n$/);
  });

  it("a pinned AMI is used as is (kept across deploys)", async () => {
    const { settings } = await import("./helpers.ts");
    const s2 = await settings({ runnerAmiId: "ami-0123456789abcdef0" });
    const { App } = await import("aws-cdk-lib");
    const { Template } = await import("aws-cdk-lib/assertions");
    const { FenvixGitHubAppStack } = await import("../lib/stack.ts");
    const app = new App();
    const st = new FenvixGitHubAppStack(app, "pinned", { env: { account: s2.account, region: s2.region }, settings: s2 });
    const [, inst] = Object.entries(Template.fromStack(st).findResources("AWS::EC2::Instance"))[0] as [string, Res];
    assert.equal(inst.Properties.ImageId, "ami-0123456789abcdef0");
  });
});
