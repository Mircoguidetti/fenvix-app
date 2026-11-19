import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { App, Aspects } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { dashboardBucketName, FenvixDashboardStack, SPA_REWRITE } from "../lib/dashboard.ts";
import { applyDashboardSuppressions } from "../lib/nag.ts";
import { synthesizer } from "../lib/synthesizer.ts";
import { settings } from "./helpers.ts";

const CERT = "arn:aws:acm:us-east-1:865859654353:certificate/12345678-1234-1234-1234-123456789012";

async function synthDashboard(over: Record<string, string> = {}) {
  const s = await settings(over);
  const app = new App({ outdir: mkdtempSync(`${tmpdir()}/fenvix-dash-`) });
  const stack = new FenvixDashboardStack(app, "dash", { env: { account: s.account, region: s.region }, settings: s, synthesizer: synthesizer() });
  applyDashboardSuppressions(stack, !!s.dashboardCertificateArn);
  Aspects.of(app).add(new AwsSolutionsChecks());
  app.synth();
  const nag = Annotations.fromStack(stack).findError("*", Match.stringLikeRegexp("AwsSolutions-.*")).map((m) => String(m.entry.data));
  return { t: Template.fromStack(stack), nag };
}

describe("the dashboard stack (S3 + CloudFront)", async () => {
  const { t, nag } = await synthDashboard({ dashboardCertificateArn: CERT });

  it("cdk-nag (AwsSolutions): nothing left unsuppressed", () => assert.deepEqual(nag, []));

  it("a private bucket with a fixed name, read only by CloudFront (origin access control); no Lambda, no IAM role", () => {
    t.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: dashboardBucketName("prod", "865859654353"),
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    t.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    t.resourceCountIs("AWS::Lambda::Function", 0);
    t.resourceCountIs("AWS::IAM::Role", 0);
    const policy = JSON.stringify(t.findResources("AWS::S3::BucketPolicy"));
    assert.match(policy, /cloudfront\.amazonaws\.com/);
    assert.match(policy, /AWS:SourceArn/);
  });

  it("console.fenvix.dev with the us-east-1 certificate, TLS 1.2+, HTTPS only, security headers, client routes to index.html", () => {
    t.hasResourceProperties("AWS::CloudFront::Distribution", { DistributionConfig: Match.objectLike({
      Aliases: ["console.fenvix.dev"],
      ViewerCertificate: Match.objectLike({ AcmCertificateArn: CERT, MinimumProtocolVersion: "TLSv1.2_2021", SslSupportMethod: "sni-only" }),
      DefaultRootObject: "index.html",
      DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https", ResponseHeadersPolicyId: Match.anyValue() }),
    }) });
    t.hasResourceProperties("AWS::CloudFront::Function", { FunctionConfig: Match.objectLike({ Runtime: "cloudfront-js-2.0" }) });
  });

  it("the rewrite: the same rule as vercel.json", () => {
    // eslint-disable-next-line no-new-func
    const handler = new Function(`${SPA_REWRITE}; return handler;`)() as (e: { request: { uri: string } }) => { uri: string };
    const route = (uri: string) => handler({ request: { uri } }).uri;
    assert.equal(route("/"), "/index.html");
    assert.equal(route("/projects/abc/runs/1"), "/index.html");
    assert.equal(route("/assets/index-abc123.js"), "/assets/index-abc123.js");
    assert.equal(route("/favicon.svg"), "/favicon.svg");
  });

  it("without the certificate (not issued yet) it still synthesizes, on its cloudfront.net name", async () => {
    const { t: t2, nag: nag2 } = await synthDashboard({ dashboardCertificateArn: "" });
    assert.deepEqual(nag2, []);
    const d = JSON.stringify(t2.findResources("AWS::CloudFront::Distribution"));
    assert.doesNotMatch(d, /Aliases/);
  });

  it("deploys through the one-click template's roles (qualifier fenvix), not a laptop bootstrap", () => {
    const json = JSON.stringify(t.toJSON());
    assert.doesNotMatch(json, /hnb659fds/);
  });
});

describe("the dashboard stack's resources are all allowed by the CloudFormation execution policies", () => {
  it("every resource type has an allowed action of its service", async () => {
    const { readFileSync } = await import("node:fs");
    const execs = ["app", "edge", "fleet", "dashboard"].flatMap((x) => (JSON.parse(readFileSync(new URL(`../cfn-exec-policy-${x}.json`, import.meta.url), "utf8")) as { Statement: { Effect: string; Action: string | string[] }[] }).Statement);
    const allowed = new Set(execs.filter((x) => x.Effect === "Allow").flatMap((x) => (Array.isArray(x.Action) ? x.Action : [x.Action])));
    const need: Record<string, string> = {
      "AWS::S3::Bucket": "s3:CreateBucket", "AWS::S3::BucketPolicy": "s3:PutBucketPolicy", "AWS::CloudFront::Distribution": "cloudfront:CreateDistribution",
      "AWS::CloudFront::OriginAccessControl": "cloudfront:CreateOriginAccessControl", "AWS::CloudFront::Function": "cloudfront:CreateFunction",
    };
    const { t } = await synthDashboard({ dashboardCertificateArn: CERT });
    for (const type of new Set(Object.values(t.toJSON().Resources as Record<string, { Type: string }>).map((r) => r.Type))) {
      assert.ok(need[type], `no expectation for ${type}`);
      assert.ok(allowed.has(need[type]!), `${type}: ${need[type]} not allowed`);
    }
  });
});
