// The AWS dashboard switch (CDK setting dashboardOnAws; the deploy's repository variable FENVIX_DASHBOARD_ON_AWS).
// Off (the default: the dashboard is on Vercel, docs/DEPLOY-VERCEL.md) the deploy plans the API stack only and skips the
// dashboard's certificate and upload steps; on, the AWS dashboard stack and its steps come back unchanged.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { App } from "aws-cdk-lib";
import YAML from "yaml";
import { buildApp, stackNames } from "../lib/app.ts";
import { readSettings } from "../lib/settings.ts";
import { CACHE_KEY, cdkContext, SAMPLE, settings } from "./helpers.ts";

const HERE = new URL("..", import.meta.url).pathname;
const PUBLIC_KEY = CACHE_KEY.publicKey.export({ type: "spki", format: "der" }).toString("base64");

describe("the AWS dashboard switch (dashboardOnAws)", async () => {
  it("is off by default (cdk.json), and only true or false are accepted", async () => {
    assert.equal((await cdkContext()).dashboardOnAws, "false");
    assert.equal((await settings()).dashboardOnAws, false);
    assert.equal((await settings({ dashboardOnAws: "true" })).dashboardOnAws, true);
    const ctx = { ...(await cdkContext()), ...SAMPLE };
    assert.equal(readSettings((k) => ctx[k], { FENVIX_DASHBOARD_ON_AWS: "true" }).dashboardOnAws, true);
    assert.equal(readSettings((k) => ctx[k], { FENVIX_DASHBOARD_ON_AWS: "false" }).dashboardOnAws, false);
    assert.throws(() => readSettings((k) => ctx[k], { FENVIX_DASHBOARD_ON_AWS: "yes" }), /dashboardOnAws/);
  });

  it("off: `cdk ls` (what the deploy's `cdk deploy --all` deploys) lists the API stack only", () => {
    const out = mkdtempSync(join(tmpdir(), "fenvix-cdk-ls-"));
    const env: Record<string, string | undefined> = { ...process.env, SUPABASE_URL: "https://example.supabase.co", FENVIX_CACHE_SIGNING_PUBLIC_KEY: PUBLIC_KEY };
    delete env.FENVIX_DASHBOARD_ON_AWS;
    const r = spawnSync("npx", ["--no-install", "cdk", "ls", "-o", out], { cwd: HERE, env, encoding: "utf8", timeout: 600_000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(r.stdout.trim().split(/\s+/), [stackNames("prod").api]);
  });

  it("on: the app has the API stack and the dashboard stack (CloudFront), as before", async () => {
    const s = await settings({ dashboardOnAws: "true" });
    const app = new App({ outdir: mkdtempSync(join(tmpdir(), "fenvix-cdk-on-")) });
    const stacks = buildApp(app, s);
    assert.deepEqual(stacks.map((x) => x.stackName), [stackNames("prod").api, stackNames("prod").dashboard]);
    const asm = app.synth();
    const dash = JSON.stringify(asm.getStackByName(stackNames("prod").dashboard).template);
    assert.match(dash, /AWS::CloudFront::Distribution/);
  });
});

describe("deploy.yml: the dashboard steps follow the one switch", () => {
  const wf = YAML.parse(readFileSync(new URL("../../../.github/workflows/deploy.yml", import.meta.url), "utf8")) as {
    jobs: { deploy: { env: Record<string, string>; steps: { name: string; if?: string; run?: string }[] } };
  };
  const job = wf.jobs.deploy;
  const step = (re: RegExp) => { const s = job.steps.find((x) => re.test(x.name)); assert.ok(s, String(re)); return s; };
  const ON = "env.FENVIX_DASHBOARD_ON_AWS == 'true'";

  it("the job's FENVIX_DASHBOARD_ON_AWS is \"true\" only when the repository variable is exactly true", () => {
    assert.equal(job.env.FENVIX_DASHBOARD_ON_AWS, "${{ vars.FENVIX_DASHBOARD_ON_AWS == 'true' }}");
  });

  it("the certificate (step 6) and the upload (step 10) run only with the switch on", () => {
    assert.equal(step(/^6\. Dashboard certificate/).if, ON);
    assert.equal(step(/^10\. Dashboard on AWS/).if, ON);
  });

  it("every other step that touches the dashboard runs always and is switch-aware (CDK setting, deploy/cli.mjs)", () => {
    // CDK reads FENVIX_DASHBOARD_ON_AWS (job env) as dashboardOnAws; dns and smoke read it in deploy/cli.mjs.
    for (const re of [/^8\. /, /^9\. DNS/, /^12\. /]) assert.equal(step(re).if, undefined, String(re));
    const cli = readFileSync(new URL("../../../deploy/cli.mjs", import.meta.url), "utf8");
    assert.match(cli, /const DASHBOARD_ON_AWS = process\.env\.FENVIX_DASHBOARD_ON_AWS === "true";/);
    for (const k of Object.keys(job.env)) assert.notEqual(k, "FENVIX_DASHBOARD_CERTIFICATE_ARN");
    // Nothing besides step 10 uploads to the bucket or touches CloudFront.
    const others = job.steps.filter((x) => !/^10\. /.test(x.name)).map((x) => x.run ?? "").join("\n");
    assert.doesNotMatch(others, /aws s3 |aws cloudfront /);
  });
});
