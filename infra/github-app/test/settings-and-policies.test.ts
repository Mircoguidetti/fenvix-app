import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readSettings } from "../lib/settings.ts";
import { cdkContext, SAMPLE, settings, synth } from "./helpers.ts";

type Stmt = { Sid: string; Effect: string; Action: string | string[]; Resource: string | string[]; Condition?: unknown };
const policy = (f: string) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")) as { Statement: Stmt[] };
const arr = <T,>(x: T | T[]) => (Array.isArray(x) ? x : [x]);

describe("settings", () => {
  it("cdk.json leaves the App's own values empty: synth stops and names the setting", async () => {
    const ctx = await cdkContext();
    assert.throws(() => readSettings((k) => ctx[k], {}), /Missing setting "githubAppId" .*GITHUB_APP_ID/);
  });

  it("an environment variable beats cdk.json", async () => {
    const ctx = { ...(await cdkContext()), ...SAMPLE };
    assert.equal(readSettings((k) => ctx[k], { FENVIX_RUNNER_INSTANCE_TYPE: "t3.large" }).runnerInstanceType, "t3.large");
  });

  it("refuses values that would break the deploy or the machine", async () => {
    await assert.rejects(settings({ dashboardUrl: "http://app.fenvix.dev" }), /https/);
    await assert.rejects(settings({ runnerScopeUrl: "https://gitlab.com/x/y" }), /runnerScopeUrl/);
    await assert.rejects(settings({ engineCliCommit: "main" }), /40-character/);
    await assert.rejects(settings({ logRetentionDays: "10" }), /one of/);
    await assert.rejects(settings({ runnerInstanceType: "t4g.medium" }), /x86_64/);
    await assert.rejects(settings({ domainName: "https://github.fenvix.dev" }), /host name/);
    const s = await settings();
    assert.equal(s.domainName, "github.fenvix.dev");
    assert.equal(s.runnerInstanceType, "t3.medium");
    assert.equal(s.runnerVolumeGb, 30);
    assert.equal(s.region, "eu-west-1");
  });
});

describe("IAM policy files", () => {
  const files = ["deploy-policy.json", "cfn-exec-policy-app.json", "cfn-exec-policy-edge.json"];

  it("each fits in one managed policy (6,144 characters without whitespace) and names this account and region only", async () => {
    const ctx = await cdkContext();
    for (const f of files) {
      const p = policy(f);
      assert.ok(JSON.stringify(p).length <= 6144, `${f}: ${JSON.stringify(p).length}`);
      for (const m of JSON.stringify(p).matchAll(/arn:aws:[a-z0-9-]+:([a-z0-9-]*):(\d*):/g)) {
        if (m[1]) assert.ok(m[1] === ctx.region || m[1] === "*", `${f}: region ${m[1]}`);
        if (m[2]) assert.equal(m[2], ctx.account, f);
      }
      for (const st of p.Statement) for (const a of arr(st.Action)) assert.ok(a !== "*" && !/^[a-z0-9-]+:\*$/.test(a), `${f} ${st.Sid}: ${a}`);
    }
  });

  it("the deployer only assumes the CDK bootstrap roles and reads or writes our own parameters, stack, logs", () => {
    const p = policy("deploy-policy.json");
    const actions = p.Statement.filter((s) => s.Effect === "Allow").flatMap((s) => arr(s.Action));
    for (const a of actions) assert.ok(!/^(iam|lambda|ec2:Run|ec2:Terminate|s3|cloudformation:(Create|Update|Delete|Execute))/.test(a), a);
    const assume = p.Statement.find((s) => s.Sid === "CdkDeployThroughBootstrapRoles")!;
    for (const r of arr(assume.Resource)) assert.match(r, /:role\/cdk-hnb659fds-(deploy|file-publishing|lookup)-role-/);
    const put = p.Statement.find((s) => arr(s.Action).includes("ssm:PutParameter"))!;
    for (const r of arr(put.Resource)) assert.match(r, /parameter\/fenvix\/prod\/(github-app|runner)\/\*$/);
  });

  it("CloudFormation may create every resource type of the template (execution policies), never an inbound rule", async () => {
    const { template } = await synth();
    const types = new Set(Object.values(template.toJSON().Resources as Record<string, { Type: string }>).map((r) => r.Type));
    const prefix: Record<string, string> = {
      Lambda: "lambda", IAM: "iam", SQS: "sqs", S3: "s3", Logs: "logs", Scheduler: "scheduler", CertificateManager: "acm",
      ApiGatewayV2: "apigateway", CloudWatch: "cloudwatch", SNS: "sns", EC2: "ec2",
    };
    const allowed = new Set([...policy("cfn-exec-policy-app.json").Statement, ...policy("cfn-exec-policy-edge.json").Statement]
      .filter((s) => s.Effect === "Allow").flatMap((s) => arr(s.Action)).map((a) => a.split(":")[0]));
    for (const t of types) {
      const svc = prefix[t.split("::")[1]!];
      assert.ok(svc, `no mapping for ${t}`);
      assert.ok(allowed.has(svc), `${t}: no ${svc}: action allowed`);
    }
    const edge = policy("cfn-exec-policy-edge.json").Statement;
    assert.ok(edge.some((s) => s.Effect === "Deny" && arr(s.Action).includes("ec2:AuthorizeSecurityGroupIngress")));
    const app = policy("cfn-exec-policy-app.json").Statement;
    const pass = app.find((s) => arr(s.Action).includes("iam:PassRole"))!;
    assert.ok(pass.Condition, "PassRole only to Lambda, EC2, Scheduler");
  });
});
