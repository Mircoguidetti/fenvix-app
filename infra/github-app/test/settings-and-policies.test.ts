import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readSettings } from "../lib/settings.ts";
import { cdkContext, PER_JOB, SAMPLE, settings, synth } from "./helpers.ts";

type Stmt = { Sid: string; Effect: string; Action: string | string[]; Resource: string | string[]; Condition?: unknown };
const policy = (f: string) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")) as { Statement: Stmt[] };
const arr = <T,>(x: T | T[]) => (Array.isArray(x) ? x : [x]);
const json = (x: unknown) => JSON.stringify(x);
// The founder's values in SSM (deploy/lib/bootstrap.mjs FOUNDER_VALUES; deploy/test/bootstrap.test.mjs checks the two agree).
const FOUNDER = ["supabase-db-url", "supabase-anon-key", "supabase-ca-cert", "cloudflare-api-token", "github-app-id", "github-app-slug", "github-app-client-id"]
  .map((n) => `arn:aws:ssm:eu-west-1:865859654353:parameter/fenvix/prod/bootstrap/${n}`);

describe("settings", () => {
  it("cdk.json leaves the GitHub App and Supabase empty: the pipeline gives Supabase; the App may stay unset", async () => {
    const ctx = await cdkContext();
    assert.throws(() => readSettings((k) => ctx[k], {}), /Missing setting "supabaseUrl" .*SUPABASE_URL/);
    const s = readSettings((k) => ctx[k], { SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", FENVIX_CACHE_SIGNING_PUBLIC_KEY: SAMPLE.cacheSigningPublicKey });
    assert.equal(s.githubConfigured, false);
    assert.equal(s.runnerMode, "per-job", "per-job is the default");
    assert.equal(s.dashboardUrl, "https://console.fenvix.dev");
    assert.equal(s.dashboardDomain, "console.fenvix.dev");
  });

  it("the GitHub App: all three of id, slug and client id, or none; demo mode needs it", async () => {
    await assert.rejects(settings({ githubAppId: "", githubAppSlug: "", githubClientId: "Iv1.x" }), /all three, or none \(missing: githubAppId, githubAppSlug\)/);
    await assert.rejects(settings({ githubAppId: "abc" }), /numeric/);
    await assert.rejects(settings({ githubAppId: "", githubAppSlug: "", githubClientId: "", runnerMode: "demo" }), /demo needs the GitHub App/);
    assert.equal((await settings({ githubAppId: "", githubAppSlug: "", githubClientId: "" })).githubConfigured, false);
    assert.equal((await settings()).githubConfigured, true);
    await assert.rejects(settings({ dashboardCertificateArn: "arn:aws:acm:eu-west-1:865859654353:certificate/12345678-1234-1234-1234-123456789012" }), /us-east-1/);
  });

  it("an environment variable beats cdk.json", async () => {
    const ctx = { ...(await cdkContext()), ...SAMPLE };
    assert.equal(readSettings((k) => ctx[k], { FENVIX_RUNNER_INSTANCE_TYPE: "t3.large" }).runnerInstanceType, "t3.large");
  });

  it("refuses values that would break the deploy or the machine", async () => {
    await assert.rejects(settings({ dashboardUrl: "http://console.fenvix.dev" }), /https/);
    await assert.rejects(settings({ demoRepository: "https://github.com/x/y" }), /owner\/name/);
    await assert.rejects(settings({ runnerMode: "always-on" }), /demo or per-job/);
    await assert.rejects(settings({ cachePrivateIp: "10.42.1.10" }), /cachePrivateIp/);
    await assert.rejects(settings({ cacheSigningPublicKey: "abc" }), /RSA public key/);
    await assert.rejects(settings({ runnerMode: "per-job", cacheSigningPublicKey: "" }), /required in per-job mode/);
    await assert.rejects(settings({ runnerMode: "demo", demoRepository: "" }), /demoRepository" is required in demo mode/);
    await assert.rejects(settings({ engineCliCommit: "main" }), /40-character/);
    await assert.rejects(settings({ logRetentionDays: "10" }), /one of/);
    await assert.rejects(settings({ runnerInstanceType: "t4g.medium" }), /x86_64/);
    await assert.rejects(settings({ domainName: "https://api.fenvix.dev" }), /host name/);
    await assert.rejects(settings({ apiCorsOrigins: "https://preview.fenvix.dev/path" }), /apiCorsOrigins/);
    await assert.rejects(settings({ apiCorsOrigins: "http://preview.fenvix.dev" }), /apiCorsOrigins/);
    await assert.rejects(settings({ fenvixRegion: "asia" }), /us or eu/);
    await assert.rejects(settings({ secondFenvixRegion: "eu" }), /all three, or none/);
    await assert.rejects(settings({ secondFenvixRegion: "us", secondAwsRegion: "us-east-1", secondLaunchTemplateId: "lt-0123456789abcdef0" }), /the other of us and eu/);
    await assert.rejects(settings({ secondFenvixRegion: "eu", secondAwsRegion: "us-east-1", secondLaunchTemplateId: "template" }), /lt-/);
    await assert.rejects(settings({ secondCacheUrl: "http://10.43.0.10:8787" }), /secondCacheUrl/);
    const s = await settings();
    assert.equal(s.domainName, "api.fenvix.dev");
    assert.equal(s.runnerInstanceType, "c6i.large");
    assert.equal(s.runnerMode, "per-job");
    assert.equal(s.demoMaxHours, 12);
    assert.equal(s.runnerVolumeGb, 30);
    assert.equal(s.region, "eu-west-1");
    assert.equal(s.fenvixRegion, "us", "this stack's machines serve the us region unless set");
    assert.equal(s.apiCorsOrigins, "");
  });
});

describe("IAM policy files", () => {
  const files = ["deploy-policy.json", "cfn-exec-policy-app.json", "cfn-exec-policy-edge.json", "cfn-exec-policy-fleet.json", "cfn-exec-policy-dashboard.json"];

  it("each fits in one managed policy (6,144 characters without whitespace) and names this account and region only", async () => {
    const ctx = await cdkContext();
    for (const f of files) {
      const p = policy(f);
      assert.ok(JSON.stringify(p).length <= 6144, `${f}: ${JSON.stringify(p).length}`);
      for (const m of JSON.stringify(p).matchAll(/arn:aws:[a-z0-9-]+:([a-z0-9-]*):(\d*):/g)) {
        if (m[1]) assert.ok(m[1] === ctx.region || m[1] === "*", `${f}: region ${m[1]}`);
        if (m[2]) assert.equal(m[2], ctx.account, f);
      }
      // The only other region: us-east-1, for the dashboard's certificate (CloudFront takes certificates from there only).
      for (const st of p.Statement) {
        const regions = JSON.stringify(st.Condition ?? {}).match(/"aws:RequestedRegion":"([a-z0-9-]+)"/)?.[1];
        if (regions && regions !== ctx.region) {
          assert.equal(regions, "us-east-1", `${f} ${st.Sid}`);
          for (const a of arr(st.Action)) assert.match(a, /^acm:(RequestCertificate|DescribeCertificate|ListCertificates|AddTagsToCertificate)$/, `${f} ${st.Sid}`);
        }
      }
      for (const st of p.Statement) for (const a of arr(st.Action)) assert.ok(a !== "*" && !/^[a-z0-9-]+:\*$/.test(a), `${f} ${st.Sid}: ${a}`);
    }
  });

  it("the deployer only assumes the deploy roles of the one-click template and reads or writes our own parameters, stack, logs, dashboard files", () => {
    const p = policy("deploy-policy.json");
    const allows = p.Statement.filter((s) => s.Effect === "Allow");
    // The one exception: ClearAFailedFirstCreate (deploy/lib/recover.mjs deletes a stack only in ROLLBACK_COMPLETE, and
    // the dashboard bucket only once no stack holds it and it is empty; deploy/test/recover.test.mjs).
    const clear = allows.find((s) => s.Sid === "ClearAFailedFirstCreate")!;
    assert.deepEqual(arr(clear.Action).sort(), ["cloudformation:DeleteStack", "s3:DeleteBucket"]);
    assert.deepEqual(arr(clear.Resource).sort(), [
      "arn:aws:cloudformation:eu-west-1:865859654353:stack/fenvix-prod-dashboard/*",
      "arn:aws:cloudformation:eu-west-1:865859654353:stack/fenvix-prod-github-app/*",
      "arn:aws:s3:::fenvix-prod-dashboard-865859654353",
    ]);
    // The CDK CLI reads CloudTrail to explain a failed deploy (no lookup role: it uses the deployer). Read-only, this region.
    const trail = allows.find((s) => s.Sid === "DiagnoseAFailedDeploy")!;
    assert.deepEqual([arr(trail.Action), arr(trail.Resource), json(trail.Condition)], [["cloudtrail:LookupEvents"], ["*"], json({ StringEquals: { "aws:RequestedRegion": "eu-west-1" } })]);
    for (const a of allows.flatMap((s) => arr(s.Action))) assert.ok(!a.startsWith("cloudtrail:") || a === "cloudtrail:LookupEvents", a);
    for (const a of allows.filter((s) => s !== clear).flatMap((s) => arr(s.Action))) assert.ok(!/^(iam|lambda:(?!InvokeFunction$)|ec2:Run|ec2:Terminate|cloudformation:(Create|Update|Delete|Execute)|s3:DeleteBucket)/.test(a), a);
    // S3: only the dashboard's own bucket (aws s3 sync of the build); nothing else, no bucket setting.
    for (const st of allows.filter((x) => x !== clear && arr(x.Action).some((a) => a.startsWith("s3:")))) {
      for (const a of arr(st.Action)) assert.match(a, /^s3:(ListBucket|PutObject|GetObject|DeleteObject)$/);
      for (const r of arr(st.Resource)) assert.match(r, /^arn:aws:s3:::fenvix-prod-dashboard-865859654353(\/\*)?$/);
    }
    // SSM reads: the two database URLs (checked by logging in), the App's two secrets (compared, never printed), the
    // cache key's public half. Never the runner token, the webhook secret, the state key or the cache signing key.
    // R-024 F1: by ANY SSM action that returns a value (GetParameterHistory returns every version, decrypted).
    const valueReads = /^ssm:(GetParameter|GetParameters|GetParametersByPath|GetParameterHistory|GetParameter\*|GetParameters\*|Get\*|\*)$/;
    for (const a of allows.flatMap((x) => arr(x.Action))) assert.ok(!(a.startsWith("ssm:") && a.includes("*")), `no SSM wildcard action: ${a}`);
    const reads = allows.filter((x) => arr(x.Action).some((a) => valueReads.test(a))).flatMap((x) => arr(x.Resource)).filter((r) => r.includes(":parameter/fenvix/"));
    for (const r of reads) assert.match(r, /\/fenvix\/prod\/(github-app\/(database-url|api-database-url|private-key|client-secret)|cache\/signing-public-key|bootstrap\/(supabase-db-url|supabase-anon-key|supabase-ca-cert|cloudflare-api-token|github-app-id|github-app-slug|github-app-client-id))$/);
    // The founder's values (/fenvix/prod/bootstrap/): read by exact name only (deploy/lib/bootstrap.mjs is the list),
    // never written or deleted by the deployer, never readable by the stacks' roles (the boundary does not cover them).
    const founder = allows.find((s) => s.Sid === "ReadFounderValues")!;
    assert.deepEqual(arr(founder.Action), ["ssm:GetParameter"]);
    assert.deepEqual(arr(founder.Resource).sort(), [...FOUNDER].sort());
    for (const st of allows) for (const r of arr(st.Resource)) {
      if (r.includes("/bootstrap/") && r.includes(":parameter/fenvix/")) {
        assert.ok(!r.includes("*"), `${st.Sid}: no wildcard on the founder's values: ${r}`);
        assert.equal(st.Sid, "ReadFounderValues", `${st.Sid}: only ReadFounderValues may touch ${r}`);
      }
      if (arr(st.Action).some((a) => /^ssm:(Put|Delete|Label|AddTags|Remove)/.test(a))) assert.ok(!/fenvix\/prod\/(bootstrap|\*)/.test(r) && !r.endsWith(":parameter/fenvix/*"), `${st.Sid} may write ${r}`);
    }
    const boundary = JSON.stringify(policy("permissions-boundary.json"));
    assert.ok(!boundary.includes("/bootstrap"), "the stacks' roles never read the founder's values");
    for (const st of allows) for (const a of arr(st.Action)) assert.ok(!/^ssm:(GetParameterHistory|GetParameters|GetParametersByPath)$/.test(a), `${st.Sid}: ${a} is not needed by the pipeline`);
    const invoke = p.Statement.find((s) => arr(s.Action).includes("lambda:InvokeFunction"))!;
    assert.deepEqual(arr(invoke.Resource), ["arn:aws:lambda:eu-west-1:865859654353:function:fenvix-prod-github-app-demo"], "only demo-up / demo-down");
    const assume = p.Statement.find((s) => s.Sid === "CdkDeployThroughBootstrapRoles")!;
    for (const r of arr(assume.Resource)) assert.match(r, /:role\/cdk-fenvix-(deploy|file-publishing)-role-/);
    const put = p.Statement.find((s) => arr(s.Action).includes("ssm:PutParameter"))!;
    for (const r of arr(put.Resource)) assert.match(r, /parameter\/fenvix\/prod\/(github-app|runner|cache)\/\*$/);
  });

  it("the permissions boundary: every service the stack's roles use, no IAM change, our parameters only (R-012 F4)", () => {
    const b = policy("permissions-boundary.json");
    assert.ok(JSON.stringify(b).length <= 6144);
    const allows = b.Statement.filter((x) => x.Effect === "Allow");
    for (const st of allows) for (const a of arr(st.Action)) assert.ok(a !== "*" && !/^[a-z0-9-]+:\*$/.test(a) && (!a.startsWith("iam:") || a === "iam:PassRole"), a);
    const ssm = allows.filter((x) => arr(x.Action).includes("ssm:GetParameters"));
    for (const r of ssm.flatMap((x) => arr(x.Resource))) assert.match(r, /parameter\/(fenvix\/prod\/(github-app|cache)|aws\/service\/canonical)\/\*$/);
    const app = policy("cfn-exec-policy-app.json").Statement;
    const boundary = "arn:aws:iam::865859654353:policy/fenvix-prod-github-app-boundary";
    assert.equal(json(app.find((x) => x.Sid === "WriteRolesOnlyWithTheBoundary")!.Condition), json({ StringEquals: { "iam:PermissionsBoundary": boundary } }));
    assert.ok(arr(app.find((x) => x.Sid === "NeverRemoveTheBoundary")!.Action).includes("iam:DeleteRolePermissionsBoundary"));
  });

  it("CloudFormation may create every resource type of both modes (execution policies); inbound only from a security group", async () => {
    const execs = ["cfn-exec-policy-app.json", "cfn-exec-policy-edge.json", "cfn-exec-policy-fleet.json", "cfn-exec-policy-dashboard.json"].flatMap((f) => policy(f).Statement);
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
