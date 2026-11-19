import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { Settings } from "./settings.ts";

/** The site bucket's name: fixed, so that the deploy identity's policy can name it (deploy-policy.json). */
export const dashboardBucketName = (env: string, account: string) => `fenvix-${env}-dashboard-${account}`;

/**
 * Every path the dashboard routes itself (react-router: /projects/..., /settings, ...) is served index.html; the built
 * files under /assets/ and the icon are served as they are. The same rule as vercel.json.
 */
export const SPA_REWRITE = `function handler(event) {
  var r = event.request;
  if (r.uri.indexOf("/assets/") !== 0 && r.uri !== "/favicon.svg") r.uri = "/index.html";
  return r;
}`;

export interface DashboardProps extends StackProps { settings: Settings }

/**
 * The dashboard (the Vite build of this repository) on https://<dashboardDomain>: a private S3 bucket read only by
 * CloudFront (origin access control), TLS 1.2+, HTTP redirected to HTTPS, the managed security headers (HSTS, nosniff,
 * frame options, referrer policy). The deploy pipeline uploads the build with `aws s3 sync` and invalidates the cache;
 * the bucket keeps nothing else. No Lambda, no IAM role: the permissions boundary has nothing to bound here.
 */
export class FenvixDashboardStack extends Stack {
  constructor(scope: Construct, id: string, props: DashboardProps) {
    super(scope, id, props);
    const s = props.settings;
    Tags.of(this).add("project", "fenvix");
    Tags.of(this).add("env", s.env);
    Tags.of(this).add("component", "dashboard");

    const bucket = new s3.Bucket(this, "Site", {
      bucketName: dashboardBucketName(s.env, s.account),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: false,
      // The build is in git: a deleted stack keeps the bucket rather than run a custom resource (a Lambda) to empty it.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const rewrite = new cloudfront.Function(this, "SpaRewrite", {
      functionName: `fenvix-${s.env}-dashboard-spa`,
      comment: "fenvix dashboard: client-side routes are served index.html",
      code: cloudfront.FunctionCode.fromInline(SPA_REWRITE),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    const custom = s.dashboardCertificateArn
      ? { domainNames: [s.dashboardDomain], certificate: acm.Certificate.fromCertificateArn(this, "Certificate", s.dashboardCertificateArn) }
      : {};
    const distribution = new cloudfront.Distribution(this, "Cdn", {
      comment: `fenvix ${s.env} dashboard (${s.dashboardDomain})`,
      ...custom,
      ...(s.dashboardCertificateArn ? { minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021 } : {}),
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultRootObject: "index.html",
      enableIpv6: true,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
        functionAssociations: [{ function: rewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      errorResponses: [{ httpStatus: 403, responseHttpStatus: 404, responsePagePath: "/index.html", ttl: Duration.minutes(1) }],
    });

    new CfnOutput(this, "DashboardBucket", { value: bucket.bucketName, description: "The deploy pipeline syncs the dashboard build here" });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId, description: "Invalidated after each upload" });
    new CfnOutput(this, "DashboardDnsTarget", { value: distribution.distributionDomainName, description: `Cloudflare: CNAME ${s.dashboardDomain} -> this value (DNS only)` });
    new CfnOutput(this, "DashboardUrl", { value: s.dashboardCertificateArn ? `https://${s.dashboardDomain}` : `https://${distribution.distributionDomainName}` });
  }
}
