import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Match } from "aws-cdk-lib/assertions";
import { appParameters } from "../lib/parameters.ts";
import { resources, synth } from "./helpers.ts";

type Stmt = { Effect: string; Action: string | string[]; Resource: unknown; Sid?: string; Condition?: unknown };
const arr = <T,>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);
const json = (x: unknown) => JSON.stringify(x);

describe("the stack (shared properties)", async () => {
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

  it("functions: Node 22, x86_64, the plain settings only (no secret in any environment variable)", () => {
    assert.deepEqual(fns.map(([, f]) => f.Properties.FunctionName).sort(), ["fenvix-prod-github-app-api", "fenvix-prod-github-app-http", "fenvix-prod-github-app-reaper", "fenvix-prod-github-app-sweep", "fenvix-prod-github-app-warmup", "fenvix-prod-github-app-worker"]);
    for (const [, f] of fns) {
      assert.equal(f.Properties.Runtime, "nodejs22.x");
      assert.deepEqual(f.Properties.Architectures, ["x86_64"]);
      const vars = (f.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
      assert.equal(vars.SSM_PREFIX, "/fenvix/prod/github-app");
      if (f.Properties.FunctionName !== "fenvix-prod-github-app-api") assert.equal(vars.SWEEP_SECONDS, "0", "no timer inside a Lambda");
      // Parameter names (…_PARAM) are fine; values never are.
      for (const k of Object.keys(vars)) if (!k.endsWith("_PARAM")) assert.doesNotMatch(k, /SECRET|PRIVATE_KEY|TOKEN|DATABASE_URL|SIGNING/, k);
      for (const [k, v] of Object.entries(vars)) if (k.endsWith("_PARAM")) assert.match(String(v), /^\/fenvix\/prod\//, k);
    }
    const http = fns.find(([, f]) => f.Properties.FunctionName === "fenvix-prod-github-app-http")![1];
    assert.ok("WORK_QUEUE_URL" in (http.Properties.Environment as { Variables: object }).Variables);
    assert.equal(http.Properties.Timeout, 29);
  });

  it("least privilege: each function reads only its own parameters, by exact name; no managed policy, no '*' action", () => {
    // The launchers (worker, sweep) also read the cache signing key (its own prefix, below).
    const want = (who: string) => [...appParameters("prod").filter((p) => p.readers.includes(who as never)).map((p) => `parameter${p.name}`),
      ...(who === "worker" || who === "sweep" ? ["parameter/fenvix/prod/cache/signing-key"] : [])].sort();
    for (const who of ["http", "worker", "sweep", "api"] as const) {
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
    assert.ok(!statementsOf(fnRole("sweep")).some((x) => json(x.Action).includes("s3:")), "the sweep touches no bucket");
    // On SQS only the dead-letter redrive (G-1736): consume the dead-letter queue, send to the work queue.
    for (const x of statementsOf(fnRole("sweep")).filter((x) => json(x.Action).includes("sqs:"))) {
      const send = arr(x.Action).includes("sqs:SendMessage");
      assert.match(json(x.Resource), send ? /Work/ : /DeadLetters/);
      if (!send) assert.ok(arr(x.Action).every((a) => /^sqs:(ReceiveMessage|DeleteMessage|ChangeMessageVisibility|GetQueueAttributes|GetQueueUrl)$/.test(a)), json(x.Action));
    }
    assert.ok(!statementsOf(fnRole("http")).some((x) => json(x.Action).includes("ec2:")), "the HTTP function calls no EC2 API");
    const httpS3 = statementsOf(fnRole("http")).filter((x) => json(x.Action).includes("s3:"));
    assert.deepEqual(httpS3.flatMap((x) => arr(x.Action)), ["s3:PutObject"]);
  });

  it("SQS: dead-letter queue after 5 tries, visibility six times the worker timeout, encrypted, TLS only", () => {
    const qs = resources(t, "AWS::SQS::Queue");
    const work = qs.find(([, q]) => q.Properties.QueueName === "fenvix-prod-github-app-work")![1].Properties;
    assert.equal((work.RedrivePolicy as { maxReceiveCount: number }).maxReceiveCount, 5);
    assert.equal(work.VisibilityTimeout, 1800, "six times the 300 s worker timeout (G-1747)");
    for (const [, q] of qs) assert.equal(q.Properties.SqsManagedSseEnabled, true);
    assert.equal(resources(t, "AWS::SQS::QueuePolicy").length, 2);
    t.hasResourceProperties("AWS::Lambda::EventSourceMapping", { BatchSize: 5, FunctionResponseTypes: ["ReportBatchItemFailures"], ScalingConfig: { MaximumConcurrency: 10 } });
    // Every function has an errors alarm; with the DLQ, throttles, API 5xx and the cache machine, all to one topic (G-1760).
    const alarms = resources(t, "AWS::CloudWatch::Alarm");
    for (const n of ["dead-letters", "http-errors", "worker-errors", "sweep-errors", "warmup-errors", "api-errors", "http-throttles", "worker-throttles", "api-5xx", "cache-machine"]) {
      const a = alarms.find(([, x]) => x.Properties.AlarmName === `fenvix-prod-github-app-${n}`);
      assert.ok(a, n);
      assert.match(json(a[1].Properties.AlarmActions), /Alerts/, `${n} notifies the topic`);
    }
    for (const [, g] of resources(t, "AWS::Logs::LogGroup")) assert.equal(g.Properties.RetentionInDays, 90, "logs kept 90 days (G-1763)");
    // The sweep redrives dead-lettered work once (G-1736): it may receive and delete on the DLQ and send to the work queue.
    const sweepFn = resources(t, "AWS::Lambda::Function").find(([, f]) => String(f.Properties.FunctionName).endsWith("-sweep"))![1];
    const sweepEnv = (sweepFn.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    assert.match(json(sweepEnv.DEAD_LETTER_QUEUE_URL), /DeadLetters/);
    assert.match(json(sweepEnv.WORK_QUEUE_URL), /Work/);
    const sweepRole = (sweepFn.Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]!;
    const st = resources(t, "AWS::IAM::Policy").filter(([, p]) => json(p.Properties.Roles).includes(`"${sweepRole}"`)).map(([, p]) => json(p.Properties.PolicyDocument)).join(" ");
    assert.match(st, /sqs:ReceiveMessage.*DeadLetters|DeadLetters[^]*sqs:ReceiveMessage/);
    assert.match(st, /sqs:SendMessage/);
  });

  it("the sweep runs on an EventBridge Scheduler rate, invoking only the sweep function", () => {
    t.hasResourceProperties("AWS::Scheduler::Schedule", { ScheduleExpression: "rate(1 minute)", FlexibleTimeWindow: { Mode: "OFF" } });
    const [, sch] = resources(t, "AWS::Scheduler::Schedule")[0]!;
    assert.match(json(sch.Properties.Target), /Sweep/);
  });

  it("HTTPS only on api.fenvix.dev: ACM certificate validated by DNS, the execute-api URL off, throttled, access logs", () => {
    t.hasResourceProperties("AWS::CertificateManager::Certificate", { DomainName: "api.fenvix.dev", ValidationMethod: "DNS" });
    const [, cert] = resources(t, "AWS::CertificateManager::Certificate")[0]!;
    assert.equal(cert.Properties.DomainValidationOptions, undefined, "no Route 53 zone: the record goes to Cloudflare by hand");
    t.hasResourceProperties("AWS::ApiGatewayV2::DomainName", { DomainName: "api.fenvix.dev" });
    t.hasResourceProperties("AWS::ApiGatewayV2::Api", { ProtocolType: "HTTP", DisableExecuteApiEndpoint: true });
    t.hasResourceProperties("AWS::ApiGatewayV2::Stage", { StageName: "$default", AutoDeploy: true, DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 } });
    const [, stage] = resources(t, "AWS::ApiGatewayV2::Stage")[0]!;
    assert.ok(stage.Properties.AccessLogSettings);
    t.hasResourceProperties("AWS::ApiGatewayV2::Integration", { IntegrationType: "AWS_PROXY", PayloadFormatVersion: "2.0" });
    t.hasOutput("DnsTarget", {});
  });

  it("the deploy pipeline's certificate (apiCertificateArn, P-037): used by ARN, no certificate resource, no DNS wait", async () => {
    const arn = "arn:aws:acm:eu-west-1:865859654353:certificate/12345678-1234-1234-1234-123456789012";
    const { template: tc } = await synth({ apiCertificateArn: arn });
    assert.equal(resources(tc, "AWS::CertificateManager::Certificate").length, 0, "CloudFormation never waits for a DNS record");
    tc.hasResourceProperties("AWS::ApiGatewayV2::DomainName", { DomainName: "api.fenvix.dev", DomainNameConfigurations: [Match.objectLike({ CertificateArn: arn })] });
    tc.hasOutput("CertificateArn", { Value: arn });
    tc.hasOutput("CustomDomain", { Value: "api.fenvix.dev" });
    tc.hasOutput("WebhookUrl", { Value: "https://api.fenvix.dev/webhooks/github" });
    tc.hasOutput("SetupUrl", { Value: "https://api.fenvix.dev/github/setup" });
  });

  it("logs: every log group kept 90 days and kept when the stack is deleted (G-1763)", () => {
    const lgs = resources(t, "AWS::Logs::LogGroup");
    assert.equal(lgs.length, 7, "http, api, worker, sweep, reaper, warmup, API Gateway access logs");
    for (const [, lg] of lgs) assert.equal(lg.Properties.RetentionInDays, s.logRetentionDays);
    for (const [id] of lgs) assert.equal((t.toJSON().Resources as Record<string, { DeletionPolicy?: string }>)[id]!.DeletionPolicy, "Retain", id);
  });

  it("the dashboard API function: its own settings, its two parameters, may only send to the work queue", () => {
    const vars = (fns.find(([, f]) => f.Properties.FunctionName === "fenvix-prod-github-app-api")![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    assert.deepEqual(Object.keys(vars).sort(), ["DASHBOARD_URL", "DB_POOL_MAX", "FENVIX_MACHINE_REGIONS", "GITHUB_APP_SLUG", "LOG_LEVEL", "NODE_ENV", "NODE_OPTIONS", "SSM_PREFIX", "SUPABASE_URL", "WORK_QUEUE_URL"]);
    assert.equal(vars.DASHBOARD_URL, "https://console.fenvix.dev");
    assert.equal(vars.DB_POOL_MAX, "1");
    assert.equal(vars.FENVIX_MACHINE_REGIONS, "eu", "only regions with machines (audit G-0190)");
    const st = statementsOf(fnRole("api"));
    const reads = st.filter((x) => arr(x.Action).some((a) => a.startsWith("ssm:"))).flatMap((x) => arr(x.Resource)).map((r) => json(r).match(/parameter\/fenvix[^"]*/)![0]).sort();
    assert.deepEqual(reads, ["parameter/fenvix/prod/github-app/api-database-url", "parameter/fenvix/prod/github-app/state-signing-key"], "no App key, webhook or client secret, no runner token");
    const actions = st.flatMap((x) => arr(x.Action)).sort();
    assert.deepEqual([...new Set(actions)], ["logs:CreateLogStream", "logs:PutLogEvents", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:SendMessage", "ssm:GetParameters"]);
    // The App's functions never read the API's database URL.
    for (const who of ["http", "worker", "sweep", "warmup", "reaper"]) assert.doesNotMatch(json(statementsOf(fnRole(who))), /api-database-url/, who);
  });

  it("routes: /v1/* to the dashboard API (CORS answered there), /v1/runner/* and everything else to the App's HTTP function", () => {
    const routes = Object.fromEntries(resources(t, "AWS::ApiGatewayV2::Route").map(([, r]) => [r.Properties.RouteKey as string, json(r.Properties.Target)]));
    assert.deepEqual(Object.keys(routes).sort(), ["$default", "ANY /v1/runner/{proxy+}", "ANY /v1/{proxy+}"]);
    const integrations = Object.fromEntries(resources(t, "AWS::ApiGatewayV2::Integration").map(([id, r]) => [id, json(r.Properties.IntegrationUri)]));
    const fnOf = (target: string) => integrations[target.match(/"Ref":"([^"]+)"/)![1]!]!;
    assert.match(fnOf(routes["ANY /v1/{proxy+}"]!), /DashboardApi/);
    assert.match(fnOf(routes["ANY /v1/runner/{proxy+}"]!), /"Http[0-9A-F]+"/);
    assert.match(fnOf(routes.$default!), /"Http[0-9A-F]+"/);
    assert.equal(resources(t, "AWS::ApiGatewayV2::Api")[0]![1].Properties.CorsConfiguration, undefined, "no API Gateway CORS: preflights reach the API, which allows the dashboard's origin only");
    t.hasOutput("DashboardApiUrl", { Value: "https://api.fenvix.dev/v1" });
  });

  it("every role carries the permissions boundary the execution policy requires (R-012 F4)", () => {
    for (const [id, r] of Object.entries(roles)) assert.match(json(r.Properties.PermissionsBoundary), /:policy\/fenvix-prod-github-app-boundary"/, id);
  });

  it("the image build machine may read none of our parameters, and runs no file the job user owns as root (R-012 F5)", () => {
    const build = Object.keys(roles).find((id) => id.startsWith("FleetBuildRole"))!;
    const deny = statementsOf(build).find((x) => x.Effect === "Deny")!;
    assert.match(json(deny.Resource), /parameter\/fenvix\/\*/);
    const install = readFileSync(new URL("../lib/runner/files/install.sh", import.meta.url), "utf8");
    // Every line that touches the job user's files: a variable, a test, a directory made before any job-user code
    // runs (step 2), or run AS the job user.
    for (const line of install.split("\n").filter((l) => !l.trim().startsWith("#") && /\$(FENVIX_HOME|RUNNER_HOME|ENGINE_DIR)\//.test(l))) {
      assert.match(line.trim(), /^[A-Z_]+=|^if \[ ! -d|^install -d -m 0700 -o fenvix|^runuser -u fenvix /, `run as root on a path the job user owns: ${line.trim()}`);
    }
    assert.doesNotMatch(install, /^[^#]*installdependencies\.sh/m);
  });
});
