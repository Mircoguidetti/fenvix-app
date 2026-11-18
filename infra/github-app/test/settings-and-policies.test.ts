import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readSettings } from "../lib/settings.ts";
import { cdkContext, PER_JOB, SAMPLE, settings, synth } from "./helpers.ts";

type Stmt = { Sid: string; Effect: string; Action: string | string[]; Resource: string | string[]; Condition?: unknown };
const policy = (f: string) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")) as { Statement: Stmt[] };
const arr = <T,>(x: T | T[]) => (Array.isArray(x) ? x : [x]);
const json = (x: unknown) => JSON.stringify(x);

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
    await assert.rejects(settings({ demoRepository: "https://github.com/x/y" }), /owner\/name/);
    await assert.rejects(settings({ runnerMode: "always-on" }), /demo or per-job/);
    await assert.rejects(settings({ cachePrivateIp: "10.42.1.10" }), /cachePrivateIp/);
    await assert.rejects(settings({ cacheSigningPublicKey: "abc" }), /RSA public key/);
    await assert.rejects(settings({ runnerMode: "per-job", cacheSigningPublicKey: "" }), /required in per-job mode/);
    await assert.rejects(settings({ demoRepository: "" }), /demoRepository" is required in demo mode/);
    await assert.rejects(settings({ engineCliCommit: "main" }), /40-character/);
    await assert.rejects(settings({ logRetentionDays: "10" }), /one of/);
    await assert.rejects(settings({ runnerInstanceType: "t4g.medium" }), /x86_64/);
    await assert.rejects(settings({ domainName: "https://github.fenvix.dev" }), /host name/);
    const s = await settings();
    assert.equal(s.domainName, "github.fenvix.dev");
    assert.equal(s.runnerInstanceType, "c6i.large");
    assert.equal(s.runnerMode, "demo");
    assert.equal(s.demoMaxHours, 12);
    assert.equal(s.runnerVolumeGb, 30);
    assert.equal(s.region, "eu-west-1");
  });
});

describe("IAM policy files", () => {
  const files = ["deploy-policy.json", "cfn-exec-policy-app.json", "cfn-exec-policy-edge.json", "cfn-exec-policy-fleet.json"];

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
    for (const a of actions) assert.ok(!/^(iam|lambda:(?!InvokeFunction$)|ec2:Run|ec2:Terminate|s3|cloudformation:(Create|Update|Delete|Execute))/.test(a), a);
    const invoke = p.Statement.find((s) => arr(s.Action).includes("lambda:InvokeFunction"))!;
    assert.deepEqual(arr(invoke.Resource), ["arn:aws:lambda:eu-west-1:865859654353:function:fenvix-prod-github-app-demo"], "only demo-up / demo-down");
    const assume = p.Statement.find((s) => s.Sid === "CdkDeployThroughBootstrapRoles")!;
    for (const r of arr(assume.Resource)) assert.match(r, /:role\/cdk-hnb659fds-(deploy|file-publishing|lookup)-role-/);
    const put = p.Statement.find((s) => arr(s.Action).includes("ssm:PutParameter"))!;
    for (const r of arr(put.Resource)) assert.match(r, /parameter\/fenvix\/prod\/(github-app|runner|cache)\/\*$/);
  });

  it("the permissions boundary: every service the stack's roles use, no IAM change, our parameters only (R-012 F4)", () => {
    const b = policy("permissions-boundary.json");
    assert.ok(JSON.stringify(b).length <= 6144);
    const allows = b.Statement.filter((x) => x.Effect === "Allow");
    for (const st of allows) for (const a of arr(st.Action)) assert.ok(a !== "*" && !/^[a-z0-9-]+:\*$/.test(a) && (!a.startsWith("iam:") || a === "iam:PassRole"), a);
    const ssm = allows.filter((x) => arr(x.Action).includes("ssm:GetParameters"));
    for (const r of ssm.flatMap((x) => arr(x.Resource))) assert.match(r, /parameter\/(fenvix\/prod\/(github-app|cache|pnap)|aws\/service\/canonical)\/\*$/);
    const app = policy("cfn-exec-policy-app.json").Statement;
    const boundary = "arn:aws:iam::865859654353:policy/fenvix-prod-github-app-boundary";
    assert.equal(json(app.find((x) => x.Sid === "WriteRolesOnlyWithTheBoundary")!.Condition), json({ StringEquals: { "iam:PermissionsBoundary": boundary } }));
    assert.ok(arr(app.find((x) => x.Sid === "NeverRemoveTheBoundary")!.Action).includes("iam:DeleteRolePermissionsBoundary"));
  });

  it("CloudFormation may create every resource type of both modes (execution policies); inbound only from a security group", async () => {
    const execs = ["cfn-exec-policy-app.json", "cfn-exec-policy-edge.json", "cfn-exec-policy-fleet.json"].flatMap((f) => policy(f).Statement);
    const prefix: Record<string, string> = {
      Lambda: "lambda", IAM: "iam", SQS: "sqs", S3: "s3", Logs: "logs", Scheduler: "scheduler", CertificateManager: "acm",
      ApiGatewayV2: "apigateway", CloudWatch: "cloudwatch", SNS: "sns", EC2: "ec2", ImageBuilder: "imagebuilder",
    };
    const allowed = new Set(execs.filter((s) => s.Effect === "Allow").flatMap((s) => arr(s.Action)).map((a) => a.split(":")[0]));
    for (const over of [{}, PER_JOB]) {
      const { template } = await synth(over);
      for (const t of new Set(Object.values(template.toJSON().Resources as Record<string, { Type: string }>).map((r) => r.Type))) {
        const svc = prefix[t.split("::")[1]!];
        assert.ok(svc, `no mapping for ${t}`);
        assert.ok(allowed.has(svc), `${t}: no ${svc}: action allowed`);
      }
      // The only inbound rule in either mode: runner machines → the cache, by security group.
      for (const [, r] of Object.entries(template.toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>)) {
        if (r.Type === "AWS::EC2::SecurityGroupIngress") { assert.ok(r.Properties.SourceSecurityGroupId); assert.equal(r.Properties.CidrIp, undefined); }
        if (r.Type === "AWS::EC2::SecurityGroup") assert.equal(r.Properties.SecurityGroupIngress, undefined);
      }
    }
    const pass = execs.find((s) => arr(s.Action).includes("iam:PassRole"))!;
    assert.ok(pass.Condition, "PassRole only to Lambda, EC2, Scheduler, Image Builder");
    const sizes = execs.find((s) => s.Sid === "Ec2OnlyTheseSizes")!;
    assert.equal(sizes.Effect, "Deny");
  });
});

describe("scripts/scram-verifier.mjs (DEPLOY-AWS.md step 8: the DB password never enters the SQL editor)", () => {
  it("prints a Postgres SCRAM-SHA-256 verifier, never the password; refuses a non-ASCII password", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("node", [new URL("../scripts/scram-verifier.mjs", import.meta.url).pathname], { input: "pw-0123456789-abcdef", encoding: "utf8" }).trim();
    assert.match(out, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    assert.ok(!out.includes("pw-0123456789"));
    const mod: string = "../scripts/scram-verifier.mjs";
    const { scramVerifier } = (await import(mod)) as { scramVerifier: (p: string, s?: Buffer) => string };
    const salt = Buffer.alloc(16, 1);
    assert.equal(scramVerifier("same", salt), scramVerifier("same", salt), "deterministic for a given salt");
    assert.notEqual(scramVerifier("same"), scramVerifier("same"), "a fresh salt each time");
    assert.throws(() => scramVerifier("pässword"), /ASCII/);
  });
});
