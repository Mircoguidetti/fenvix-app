// The AWS dashboard switch (FENVIX_DASHBOARD_ON_AWS, deploy.yml): off (the default, the dashboard is on Vercel,
// docs/DEPLOY-VERCEL.md) no deploy step requests the dashboard's certificate or writes console.<zone>; on, the AWS
// dashboard steps work as before. Offline: no Cloudflare token, so the records the pipeline would write are listed in
// the step summary instead, which is what these tests read. The dns step then checks public DNS once (--wait-minutes
// 0): the sample targets exist nowhere, so it stops naming the missing records (P-037), after listing them all.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const CLI = new URL("../cli.mjs", import.meta.url).pathname;
const CERT = "arn:aws:acm:us-east-1:865859654353:certificate/12345678-1234-1234-1234-123456789012";

function run(step, extraEnv = {}, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), "fenvix-switch-"));
  const outputs = join(dir, "cdk-outputs.json");
  writeFileSync(outputs, JSON.stringify({
    "fenvix-prod-github-app": { DnsTarget: "d-abc123.execute-api.eu-west-1.amazonaws.com" },
    "fenvix-prod-dashboard": { DashboardDnsTarget: "d111111abcdef8.cloudfront.net" },
  }));
  const summaryFile = join(dir, "summary.md");
  writeFileSync(summaryFile, "");
  const wait = step === "dns" ? ["--wait-minutes", "0"] : [];
  const r = spawnSync(process.execPath, [CLI, step, "--outputs", outputs, ...wait, ...extraArgs], {
    encoding: "utf8",
    // SUPABASE_DB_URL set: founder values come from the environment (no SSM); no CLOUDFLARE_API_TOKEN: nothing is written.
    env: { PATH: process.env.PATH, SUPABASE_DB_URL: "postgresql://x:y@localhost:1/postgres", GITHUB_STEP_SUMMARY: summaryFile, ...extraEnv },
  });
  return { ...r, summary: readFileSync(summaryFile, "utf8") };
}

describe("FENVIX_DASHBOARD_ON_AWS off (the default): the dashboard is on Vercel", () => {
  it("dns writes the API's record only, never console.fenvix.dev (even with a certificate ARN around)", () => {
    const r = run("dns", { FENVIX_DASHBOARD_CERTIFICATE_ARN: CERT });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /STOP: api\.fenvix\.dev is not a CNAME to d-abc123\.execute-api\.eu-west-1\.amazonaws\.com yet \(the API\)\..*Type CNAME, Name api, Target d-abc123\.execute-api\.eu-west-1\.amazonaws\.com, Proxy status DNS only/);
    assert.match(r.summary, /`api`.*d-abc123\.execute-api/);
    assert.doesNotMatch(r.summary, /console|cloudfront\.net/);
    assert.match(r.stdout, /console\.fenvix\.dev: the dashboard is on Vercel/);
  });

  it("FENVIX_DASHBOARD_ON_AWS=false is the same as unset", () => {
    const r = run("dns", { FENVIX_DASHBOARD_ON_AWS: "false", FENVIX_DASHBOARD_CERTIFICATE_ARN: CERT });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.summary, /console|cloudfront\.net/);
  });

  it("dashboard-certificate does nothing (no AWS call: it would fail here without credentials)", () => {
    const r = run("dashboard-certificate", { AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "", AWS_EC2_METADATA_DISABLED: "true" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /FENVIX_DASHBOARD_ON_AWS is off/);
    assert.doesNotMatch(r.stdout, /FENVIX_DASHBOARD_CERTIFICATE_ARN/);
  });
});

describe("FENVIX_DASHBOARD_ON_AWS=true: the AWS dashboard comes back as before", () => {
  it("dns writes console.fenvix.dev → CloudFront once the certificate is issued", () => {
    const r = run("dns", { FENVIX_DASHBOARD_ON_AWS: "true", FENVIX_DASHBOARD_CERTIFICATE_ARN: CERT });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.summary, /`api`.*d-abc123\.execute-api/);
    assert.match(r.summary, /`console`.*d111111abcdef8\.cloudfront\.net/);
    assert.match(r.stdout, /STOP: .*api\.fenvix\.dev is not a CNAME.*console\.fenvix\.dev is not a CNAME to d111111abcdef8\.cloudfront\.net/);
  });

  it("dns leaves console.fenvix.dev alone while its certificate is not issued", () => {
    const r = run("dns", { FENVIX_DASHBOARD_ON_AWS: "true" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.summary, /console/);
  });
});
