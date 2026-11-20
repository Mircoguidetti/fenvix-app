import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { fileURLToPath } from "node:url";
import { Construct } from "constructs";
import { appPrefix, cachePrefix, readersOf } from "./parameters.ts";
import { CacheMachine } from "./cache.ts";
import { RunnerNetwork } from "./network.ts";
import { perJobMachineEnv } from "./runner.ts";
import { RunnerFleet } from "./runner-fleet.ts";
import type { Settings } from "./settings.ts";

/** The managed policy every role of the stack is bounded by (permissions-boundary.json, created by hand). */
export const boundaryName = (env: string) => `fenvix-${env}-github-app-boundary`;

const SERVICE_DIR = fileURLToPath(new URL("../../../github-app/", import.meta.url));

/** Worker timeout; the queue's visibility timeout is six times this (AWS's advice for Lambda consumers). */
// 300 s per batch (G-1747): a slow GitHub call or a large results chunk no longer runs out of time, and with 10
// concurrent batches one customer's slow work does not hold back the others.
const WORKER_TIMEOUT = Duration.seconds(300);

export interface FenvixGitHubAppProps extends StackProps { settings: Settings }

/**
 * The fenvix GitHub App on AWS (docs/DEPLOY-AWS.md):
 *
 *   GitHub ─HTTPS─▶ github.<domain> (API Gateway HTTP API, ACM certificate) ─▶ http Lambda
 *                     checks the signature / runner token, sends the work to SQS, answers 202
 *   dashboard ─HTTPS─▶ github.<domain>/v1/* (except /v1/runner/*) ─▶ api Lambda (the dashboard API,
 *                     openapi/fenvix-api.yaml): Supabase session, membership and role, Postgres as fenvix_api
 *   SQS work queue (dead-letter queue after 5 tries; large payloads via the overflow bucket) ─▶ worker Lambda
 *   EventBridge Scheduler, every few minutes ─▶ sweep Lambda (runs whose summary never came)
 *   EventBridge Scheduler, every minute (per-job) ─▶ warm-up Lambda (warm-up runs of onboarded default branches:
 *     a machine only when no customer job needs one; github-app/src/warmup/)
 *   our machines (github-app/src/machines/: one customer per machine, jobs in sandboxed slots), from the runner image
 *     ─▶ POST https://github.<domain>/v1/runner/summaries
 *
 * Secrets: SSM SecureString parameters under /fenvix/<env>/, created by hand, read by exact name, by functions only.
 * A runner machine's credentials are minted for that machine and passed in its user data (R-012 F1, F2, F3).
 */
export class FenvixGitHubAppStack extends Stack {
  private readonly zone: string;

  /** Named here, so that synth needs no AWS call; the runner uses the first ("a"). */
  override get availabilityZones(): string[] { return [this.zone]; }

  constructor(scope: Construct, id: string, props: FenvixGitHubAppProps) {
    super(scope, id, props);
    const s = props.settings;
    this.zone = `${s.region}a`;
    Tags.of(this).add("project", "fenvix");
    Tags.of(this).add("env", s.env);
    Tags.of(this).add("component", "github-app");
    const name = (x: string) => `fenvix-${s.env}-github-app-${x}`;
    // Every role of this stack carries the permissions boundary the founder creates from permissions-boundary.json
    // (docs/DEPLOY-AWS.md): CloudFormation's execution role may create or change a role only with it (R-012 F4).
    iam.PermissionsBoundary.of(this).apply(iam.ManagedPolicy.fromManagedPolicyName(this, "Boundary", boundaryName(s.env)));
    const paramArn = (p: string) => `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${p}`;

    // ---------------------------------------------------------------- queue, dead-letter queue, overflow bucket
    const dlq = new sqs.Queue(this, "DeadLetters", {
      queueName: name("dead-letters"), retentionPeriod: Duration.days(14), encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true,
    });
    const queue = new sqs.Queue(this, "Work", {
      queueName: name("work"), visibilityTimeout: Duration.seconds(WORKER_TIMEOUT.toSeconds() * 6), retentionPeriod: Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true, deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });
    const overflow = new s3.Bucket(this, "Overflow", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED, versioned: false,
      lifecycleRules: [{ id: "expire-work", prefix: "work/", expiration: Duration.days(5) }],
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---------------------------------------------------------------- runner machines: image and launch template (both
    // the shared cache machine
    // Our machines (the design of 2026-11-20, github-app/src/machines/): the only runner mode. The per-job and demo
    // modes were retired with it (audit G-0186: they ran an engine built from an old pinned commit; G-2307).
    const net = new RunnerNetwork(this, "Network", this.zone, { cache: true });
    const fleet = new RunnerFleet(this, "Fleet", s, net);
    const cache = new CacheMachine(this, "Cache", s, net);
    const machineRole = "runner-pool";

    // ---------------------------------------------------------------- the functions
    const env: Record<string, string> = {
      NODE_ENV: "production", NODE_OPTIONS: "--enable-source-maps", LOG_LEVEL: "info", SSM_PREFIX: appPrefix(s.env),
      GITHUB_APP_ID: s.githubAppId, GITHUB_APP_SLUG: s.githubAppSlug, GITHUB_CLIENT_ID: s.githubClientId,
      DASHBOARD_URL: s.dashboardUrl, SUPABASE_URL: s.supabaseUrl, FENVIX_RUNS_ON: s.runsOnLabel,
      SUMMARY_WAIT_SECONDS: String(s.summaryWaitSeconds), SWEEP_SECONDS: "0", DB_POOL_MAX: "2", OVERFLOW_BUCKET: overflow.bucketName,
    };
    const logGroups: Record<string, logs.ILogGroup> = {};
    const fn = (id: string, entry: string, o: { timeout: Duration; memory: number; extraEnv?: Record<string, string>; reads: string[]; description: string; baseEnv?: Record<string, string>; short?: string }) => {
      const short = o.short ?? id.toLowerCase();
      const logGroup = new logs.LogGroup(this, `${id}Logs`, { logGroupName: `/aws/lambda/${name(short)}`, retention: s.logRetentionDays, removalPolicy: RemovalPolicy.RETAIN });
      logGroups[id] = logGroup;
      // Own role, no managed policy: write to its own log group, read its own parameters.
      const role = new iam.Role(this, `${id}Role`, { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"), description: `fenvix GitHub App: ${id} function` });
      role.addToPolicy(new iam.PolicyStatement({ sid: "OwnLogGroup", actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`] }));
      if (o.reads.length) role.addToPolicy(new iam.PolicyStatement({ sid: "OwnSecrets", actions: ["ssm:GetParameters"], resources: o.reads.map(paramArn) }));
      const f = new NodejsFunction(this, id, {
        functionName: name(short),
        description: o.description,
        entry: `${SERVICE_DIR}src/lambda/${entry}`,
        handler: "handler",
        projectRoot: SERVICE_DIR,
        depsLockFilePath: `${SERVICE_DIR}package-lock.json`,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.X86_64,
        memorySize: o.memory,
        timeout: o.timeout,
        role,
        logGroup,
        // X-Ray (G-1762): each invocation's time in Lambda, SSM, SQS and the rest, in the X-Ray console.
        tracing: lambda.Tracing.ACTIVE,
        environment: { ...(o.baseEnv ?? env), ...(o.extraEnv ?? {}) },
        bundling: {
          format: OutputFormat.ESM,
          target: "node22",
          minify: true,
          sourceMap: true,
          // pg's optional native binding is never used; the AWS SDK clients are bundled (pinned by the lock file).
          externalModules: ["pg-native"],
          banner: "import { createRequire as __fenvixRequire } from 'module'; const require = __fenvixRequire(import.meta.url);",
        },
      });
      return f;
    };

    const http = fn("Http", "http.ts", {
      // RUNNER_MODE=pool: the HTTP function serves the machines' hello, poll and events (no EC2 call from it).
      timeout: Duration.seconds(29), memory: 512, extraEnv: { WORK_QUEUE_URL: queue.queueUrl, RUNNER_MODE: "pool", FENVIX_POOL: s.pool }, reads: readersOf(s.env, "http"),
      description: "fenvix GitHub App: webhooks (signature, then SQS), runner summaries, setup and onboarding routes",
    });
    queue.grantSendMessages(http);
    http.addToRolePolicy(new iam.PolicyStatement({ sid: "PutOverflow", actions: ["s3:PutObject"], resources: [overflow.arnForObjects("work/*")] }));

    // The dashboard API: its own settings only (no App id, no OAuth client, no machine settings), its two parameters
    // (the fenvix_api database URL and the state signing key), and the work queue (the setup pull request is queued).
    const dashboardApi = fn("DashboardApi", "api.ts", {
      timeout: Duration.seconds(29), memory: 512, reads: readersOf(s.env, "api"), short: "api",
      baseEnv: {
        NODE_ENV: "production", NODE_OPTIONS: "--enable-source-maps", LOG_LEVEL: "info", SSM_PREFIX: appPrefix(s.env),
        SUPABASE_URL: s.supabaseUrl, DASHBOARD_URL: s.dashboardUrl, GITHUB_APP_SLUG: s.githubAppSlug, DB_POOL_MAX: "1",
        WORK_QUEUE_URL: queue.queueUrl,
        // The regions that have machines: the API lets an organization choose only these (audit G-0190).
        FENVIX_MACHINE_REGIONS: [s.fenvixRegion, ...(s.secondFenvixRegion ? [s.secondFenvixRegion] : [])].join(","),
        ...(s.apiCorsOrigins ? { API_CORS_ORIGINS: s.apiCorsOrigins } : {}),
      },
      description: "fenvix dashboard API (openapi/fenvix-api.yaml): /v1/* except /v1/runner/*",
    });
    queue.grantSendMessages(dashboardApi);

    // Where an organization's jobs run, by its region (us | eu): this stack's fleet under its fenvix region, and the other
    // region's fleet when the settings name one, with its own shared cache when given (placementsFromEnv in
    // github-app/src/runners/launcher.ts reads it; a placement's machineEnv overrides the FENVIX_MACHINE_* settings).
    // Each AWS region's machines are reaped by the reaper of the stack deployed there (the reaper's EC2 client and IAM
    // permissions are for its own region): deploy this stack in the second region too.
    const placement: Record<string, { awsRegion: string; launchTemplateId: string; machineEnv?: Record<string, string> }> = {
      [s.fenvixRegion]: { awsRegion: this.region, launchTemplateId: fleet.launchTemplate.ref },
      ...(s.secondFenvixRegion ? { [s.secondFenvixRegion]: {
        awsRegion: s.secondAwsRegion, launchTemplateId: s.secondLaunchTemplateId,
        ...(s.secondCacheUrl ? { machineEnv: { FENVIX_CACHE_URL: s.secondCacheUrl } } : {}),
      } } : {}),
    };
    const launchEnv: Record<string, string> = {
      RUNNER_MODE: "pool", RUNNER_LAUNCH_TEMPLATE_ID: fleet.launchTemplate.ref, FENVIX_ENV: s.env,
      RUNNER_PLACEMENT: this.toJsonString(placement),
      // The pool's sizes, always-on and reserve counts, caps (github-app/src/machines/settings.ts).
      FENVIX_POOL: s.pool,
      FENVIX_API_URL: `https://${s.domainName}`,
      CACHE_SIGNING_KEY_PARAM: `${cachePrefix(s.env)}/signing-key`,
      ...Object.fromEntries(Object.entries(perJobMachineEnv(s)).map(([k, v]) => [`FENVIX_MACHINE_${k}`, v])),
    };
    // Warm-up runs (per-job only; github-app/src/warmup/): the worker requests them (webhooks) and preempts them for a
    // customer job; the warm-up scheduler gives them machines.
    const warmupEnv: Record<string, string> = {
      WARMUP_ENABLED: String(s.warmupEnabled), WARMUP_DAILY_CAP: String(s.warmupDailyCap), WARMUP_ORG_CONCURRENCY: String(s.warmupOrgConcurrency),
      WARMUP_RESERVE: String(s.warmupReserve), WARMUP_GRACE_SECONDS: String(s.warmupGraceSeconds), WARMUP_TICK_SECONDS: "0",
    };
    // The worker signs each machine's credentials (per-job only): the summary key and the cache signing key.
    const workerReads = readersOf(s.env, "worker");
    const worker = fn("Worker", "worker.ts", {
      timeout: WORKER_TIMEOUT, memory: 512, reads: workerReads, extraEnv: { ...launchEnv, ...warmupEnv },
      description: "fenvix GitHub App: runs queued webhooks and runner summaries",
    });
    worker.addToRolePolicy(new iam.PolicyStatement({ sid: "ReadAndDeleteOverflow", actions: ["s3:GetObject", "s3:DeleteObject"], resources: [overflow.arnForObjects("work/*")] }));
    worker.addEventSource(new SqsEventSource(queue, { batchSize: 5, reportBatchItemFailures: true, maxConcurrency: 10 }));

    // Start a runner machine: only from our launch template, of the configured type, from our own images, only tagged
    // with its role (R-012 F7: the instance, its disk and its network interface must come from the launch template).
    const arn = (r: string) => `arn:${this.partition}:ec2:${this.region}:${this.account}:${r}`;
    const fromTemplate = { "ec2:LaunchTemplate": arn(`launch-template/${fleet.launchTemplate.ref}`) };
    const poolTypes = [...new Set(Object.values((JSON.parse(s.pool) as { sizes: Record<string, { instanceType: string }> }).sizes).map((x) => x.instanceType))].sort();
    const mayLaunch = (f: lambda.IFunction, role: string) => {
      f.addToRolePolicy(new iam.PolicyStatement({
        sid: "RunJobMachines", actions: ["ec2:RunInstances"],
        resources: [arn(`launch-template/${fleet.launchTemplate.ref}`), arn(`subnet/${net.subnet.subnetId}`), arn(`security-group/${net.runnerSg.securityGroupId}`)],
      }));
      f.addToRolePolicy(new iam.PolicyStatement({
        sid: "NetworkInterfaceFromTemplate", actions: ["ec2:RunInstances"], resources: [arn("network-interface/*")],
        conditions: { ArnEquals: fromTemplate },
      }));
      f.addToRolePolicy(new iam.PolicyStatement({
        sid: "RunFromOwnImages", actions: ["ec2:RunInstances"], resources: [`arn:${this.partition}:ec2:${this.region}::image/*`],
        conditions: { StringEquals: { "ec2:Owner": this.account } },
      }));
      f.addToRolePolicy(new iam.PolicyStatement({
        sid: "OnlyTaggedJobMachines", actions: ["ec2:RunInstances"], resources: [arn("instance/*")],
        // The pool's sizes only (FENVIX_POOL); a spot request is a RunInstances with market options, same conditions.
        conditions: { StringEquals: { "aws:RequestTag/fenvix:role": role, "ec2:InstanceType": poolTypes }, ArnEquals: fromTemplate },
      }));
      f.addToRolePolicy(new iam.PolicyStatement({
        sid: "OnlyTaggedJobDisks", actions: ["ec2:RunInstances"], resources: [arn("volume/*")],
        conditions: { StringEquals: { "aws:RequestTag/fenvix:role": role }, ArnEquals: fromTemplate },
      }));
      // Spot (bursts and nightly exploration): RunInstances with market options also creates a spot request.
      f.addToRolePolicy(new iam.PolicyStatement({ sid: "SpotRequestsAtLaunch", actions: ["ec2:RunInstances"], resources: [arn("spot-instances-request/*")] }));
      f.addToRolePolicy(new iam.PolicyStatement({
        sid: "TagAtLaunchOnly", actions: ["ec2:CreateTags"], resources: [arn("instance/*"), arn("volume/*")],
        conditions: { StringEquals: { "ec2:CreateAction": "RunInstances" } },
      }));
      f.addToRolePolicy(new iam.PolicyStatement({
        sid: "PassJobMachineRole", actions: ["iam:PassRole"], resources: [fleet.jobRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } },
      }));
      f.addToRolePolicy(new iam.PolicyStatement({ sid: "FindImageAndCountMachines", actions: ["ec2:DescribeImages", "ec2:DescribeInstances"], resources: ["*"] }));
    };
    const mayTerminate = (f: lambda.IFunction, role: string) => f.addToRolePolicy(new iam.PolicyStatement({
      sid: "TerminateOnlyTheseMachines", actions: ["ec2:TerminateInstances"], resources: [arn("instance/*")],
      conditions: { StringEquals: { "aws:ResourceTag/fenvix:role": role } },
    }));
    // Only warm-up machines (fenvix:kind=warmup): a customer's job machine is never terminated by a function but the reaper.
    const mayTerminateWarmups = (f: lambda.IFunction) => f.addToRolePolicy(new iam.PolicyStatement({
      sid: "TerminateOnlyWarmupMachines", actions: ["ec2:TerminateInstances"], resources: [arn("instance/*")],
      conditions: { StringEquals: { "aws:ResourceTag/fenvix:role": "runner-job", "aws:ResourceTag/fenvix:kind": "warmup" } },
    }));
    // The pool's machines: started, stopped (the reserve), their user data replaced while stopped (a new boot secret),
    // terminated: only machines tagged fenvix:role=runner-pool (set at launch by the statements above).
    const mayManage = (f: lambda.IFunction) => f.addToRolePolicy(new iam.PolicyStatement({
      sid: "ManageOnlyPoolMachines", actions: ["ec2:StartInstances", "ec2:StopInstances", "ec2:ModifyInstanceAttribute", "ec2:TerminateInstances"], resources: [arn("instance/*")],
      conditions: { StringEquals: { "aws:ResourceTag/fenvix:role": machineRole } },
    }));
    mayLaunch(worker, machineRole);
    mayManage(worker);
    const warmup: lambda.IFunction = fn("Warmup", "warmup.ts", {
      timeout: Duration.seconds(120), memory: 256, reads: readersOf(s.env, "warmup"), extraEnv: { ...launchEnv, ...warmupEnv },
      description: "fenvix GitHub App: warm-up runs of onboarded default branches (lowest priority; never billed)",
    });
    mayLaunch(warmup, machineRole);
    mayManage(warmup);
    void mayTerminateWarmups;

    // The sweep is also the pool's minute (github-app/src/machines/pool.ts tick): it retires, reconciles and tops up
    // machines, and dispatches waiting jobs (registering their just-in-time runners: the launch secrets).
    const sweep = fn("Sweep", "sweep.ts", {
      timeout: Duration.seconds(300), memory: 512, reads: readersOf(s.env, "sweep"), extraEnv: { ...launchEnv, ...warmupEnv, WORK_QUEUE_URL: queue.queueUrl, DEAD_LETTER_QUEUE_URL: dlq.queueUrl },
      description: "fenvix GitHub App: the machine pool's minute (retire, reconcile, reserve, waiting jobs); publishes completed jobs whose runner summary never came",
    });
    mayLaunch(sweep, machineRole);
    mayManage(sweep);
    // Dead-lettered work goes back to the work queue once (G-1736, github-app/src/queue/redrive.ts).
    dlq.grantConsumeMessages(sweep);
    queue.grantSendMessages(sweep);

    // ---------------------------------------------------------------- the sweep's schedule
    const schedulerRole = new iam.Role(this, "SweepScheduleRole", { assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": this.account } } }) });
    schedulerRole.addToPolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [sweep.functionArn] }));
    new scheduler.CfnSchedule(this, "SweepSchedule", {
      name: name("sweep"),
      description: "Publishes completed fenvix jobs whose summary never came (SUMMARY_WAIT_SECONDS)",
      scheduleExpression: `rate(${s.sweepMinutes} ${s.sweepMinutes === 1 ? "minute" : "minutes"})`,
      flexibleTimeWindow: { mode: "OFF" },
      state: "ENABLED",
      target: { arn: sweep.functionArn, roleArn: schedulerRole.roleArn, retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 }, deadLetterConfig: { arn: dlq.queueArn } },
    });

    // ---------------------------------------------------------------- the warm-up scheduler's schedule
    {
      schedulerRole.addToPolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [warmup.functionArn] }));
      new scheduler.CfnSchedule(this, "WarmupSchedule", {
        name: name("warmup"),
        description: "Warm-up runs: terminate unneeded warm-up machines, dispatch pending warm-ups when machines are free",
        scheduleExpression: "rate(1 minute)", flexibleTimeWindow: { mode: "OFF" }, state: "ENABLED",
        target: { arn: warmup.functionArn, roleArn: schedulerRole.roleArn, retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 }, deadLetterConfig: { arn: dlq.queueArn } },
      });
    }

    // ---------------------------------------------------------------- the reaper: machines past the hard limit
    {
      // A backstop independent of the pool's database: any pool machine older than the pool's hard limit plus one hour.
      const hours = s.runnerMaxHours + 1;
      const reaper = fn("Reaper", "reaper.ts", {
        timeout: Duration.seconds(120), memory: 256, reads: [],
        extraEnv: { REAP: `${machineRole}:${hours}` },
        description: `fenvix: terminates ${machineRole} machines older than ${hours} hours (backstop of the pool's own limit)`,
      });
      reaper.addToRolePolicy(new iam.PolicyStatement({ sid: "ListMachines", actions: ["ec2:DescribeInstances"], resources: ["*"] }));
      mayTerminate(reaper, machineRole);
      schedulerRole.addToPolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [reaper.functionArn] }));
      new scheduler.CfnSchedule(this, "ReaperSchedule", {
        name: name("reaper"), description: "Terminates runner machines past the hard limit",
        scheduleExpression: "rate(10 minutes)", flexibleTimeWindow: { mode: "OFF" }, state: "ENABLED",
        target: { arn: reaper.functionArn, roleArn: schedulerRole.roleArn, retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 }, deadLetterConfig: { arn: dlq.queueArn } },
      });
    }

    // ---------------------------------------------------------------- HTTPS on the custom domain
    // The deploy pipeline requests the certificate and waits for it before CDK (deploy/cli.mjs api-certificate) and
    // passes its ARN: CloudFormation never waits for a DNS record. Without one (a stack deployed by hand) the stack
    // requests it and CloudFormation waits until its validation CNAME is in Cloudflare.
    const certificate = s.apiCertificateArn
      ? acm.Certificate.fromCertificateArn(this, "ApiCertificate", s.apiCertificateArn)
      : new acm.Certificate(this, "Certificate", { domainName: s.domainName, validation: acm.CertificateValidation.fromDns() });
    const domain = new apigw.DomainName(this, "Domain", { domainName: s.domainName, certificate, securityPolicy: apigw.SecurityPolicy.TLS_1_2 });
    const httpIntegration = new HttpLambdaIntegration("Http", http, { payloadFormatVersion: apigw.PayloadFormatVersion.VERSION_2_0 });
    const api = new apigw.HttpApi(this, "Api", {
      apiName: name("api"),
      description: "fenvix GitHub App and dashboard API",
      // Webhooks, /github/setup, /healthz and anything else: the App's HTTP function.
      defaultIntegration: httpIntegration,
      createDefaultStage: false,
      // Only https://<domain>: the execute-api URL is switched off.
      disableExecuteApiEndpoint: true,
    });
    // The dashboard API takes /v1/* (every method, OPTIONS too: it answers CORS preflights itself); the runner routes
    // under /v1/runner/* stay on the App's HTTP function (the more specific route wins).
    api.addRoutes({ path: "/v1/{proxy+}", methods: [apigw.HttpMethod.ANY], integration: new HttpLambdaIntegration("DashboardApi", dashboardApi, { payloadFormatVersion: apigw.PayloadFormatVersion.VERSION_2_0 }) });
    api.addRoutes({ path: "/v1/runner/{proxy+}", methods: [apigw.HttpMethod.ANY], integration: httpIntegration });
    const accessLogs = new logs.LogGroup(this, "ApiAccessLogs", { logGroupName: `/aws/apigateway/${name("api")}`, retention: s.logRetentionDays, removalPolicy: RemovalPolicy.RETAIN });
    new apigw.HttpStage(this, "Stage", {
      httpApi: api, stageName: "$default", autoDeploy: true,
      throttle: { rateLimit: 50, burstLimit: 100 },
      domainMapping: { domainName: domain },
      accessLogSettings: { destination: new apigw.LogGroupLogDestination(accessLogs) },
    });

    // ---------------------------------------------------------------- alarm: anything in the dead-letter queue
    // A schedule's invocation that failed three times goes to the dead-letter queue too (G-1737).
    dlq.grantSendMessages(schedulerRole);
    const alarm = new cloudwatch.Alarm(this, "DeadLettersAlarm", {
      alarmName: name("dead-letters"),
      alarmDescription: "Work failed 5 times and is in the dead-letter queue (docs/DEPLOY-AWS.md, 'When something fails').",
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: "Maximum" }),
      threshold: 0, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // Every function's errors, the HTTP function's and the worker's throttles, the API's 5xx and the cache machine's
    // health (G-1760, G-1737). All go to one topic; it notifies the alarm e-mail (the founder sets FENVIX_ALARM_EMAIL,
    // then confirms the subscription mail: G-1761, G-2313).
    const alarms: cloudwatch.Alarm[] = [alarm];
    const errorsOf = (id: string, f: lambda.IFunction, what: string) => alarms.push(new cloudwatch.Alarm(this, `${id}ErrorsAlarm`, {
      alarmName: name(`${id.toLowerCase()}-errors`), alarmDescription: `The ${what} function failed (docs/DEPLOY-AWS.md, 'When something fails').`,
      metric: f.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }), threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));
    // Error reporting (G-1762): an error the code logged (and handled: no failed invocation) is mailed too. The App's
    // logger writes level "error", Fastify's level 50.
    const loggedErrorsOf = (id: string, fnId: string, what: string) => {
      const mf = new logs.MetricFilter(this, `${id}LoggedErrors`, {
        logGroup: logGroups[fnId]!, metricNamespace: "fenvix", metricName: `${id}LoggedErrors`, metricValue: "1", defaultValue: 0,
        filterPattern: logs.FilterPattern.any(logs.FilterPattern.stringValue("$.level", "=", "error"), logs.FilterPattern.numberValue("$.level", ">=", 50)),
      });
      alarms.push(new cloudwatch.Alarm(this, `${id}LoggedErrorsAlarm`, {
        alarmName: name(`${id.toLowerCase()}-logged-errors`), alarmDescription: `The ${what} function logged an error: its log group, filter level = error or level >= 50 (docs/DEPLOY-AWS.md, 'When something fails').`,
        metric: mf.metric({ period: Duration.minutes(5), statistic: "Sum" }), threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }));
    };
    for (const [id, fnId, what] of [["Http", "Http", "HTTP"], ["Worker", "Worker", "worker"], ["Sweep", "Sweep", "sweep"], ["Warmup", "Warmup", "warm-up scheduler"], ["Api", "DashboardApi", "dashboard API"]] as const) loggedErrorsOf(id, fnId, what);
    errorsOf("Http", http, "HTTP (webhooks, machines' hello and poll)");
    errorsOf("Worker", worker, "worker (dispatcher)");
    errorsOf("Sweep", sweep, "sweep (the machine pool's minute)");
    errorsOf("Warmup", warmup, "warm-up scheduler");
    errorsOf("Api", dashboardApi, "dashboard API");
    for (const [id, f] of [["Http", http], ["Worker", worker]] as const) alarms.push(new cloudwatch.Alarm(this, `${id}ThrottlesAlarm`, {
      alarmName: name(`${id.toLowerCase()}-throttles`), alarmDescription: `The ${id.toLowerCase()} function was throttled.`,
      metric: f.metricThrottles({ period: Duration.minutes(5), statistic: "Sum" }), threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));
    alarms.push(new cloudwatch.Alarm(this, "Api5xxAlarm", {
      alarmName: name("api-5xx"), alarmDescription: "The API answered 5xx (GitHub, the machines or the dashboard got an error).",
      metric: new cloudwatch.Metric({ namespace: "AWS/ApiGateway", metricName: "5xx", dimensionsMap: { ApiId: api.apiId }, period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 5, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));
    alarms.push(new cloudwatch.Alarm(this, "CacheMachineAlarm", {
      alarmName: name("cache-machine"), alarmDescription: "The shared cache machine fails its status checks.",
      metric: new cloudwatch.Metric({ namespace: "AWS/EC2", metricName: "StatusCheckFailed", dimensionsMap: { InstanceId: cache.instance.instanceId }, period: Duration.minutes(5), statistic: "Maximum" }),
      threshold: 0, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, evaluationPeriods: 2, treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }));
    const topic = new sns.Topic(this, "Alerts", { topicName: name("alerts"), enforceSSL: true });
    if (s.alarmEmail) topic.addSubscription(new subs.EmailSubscription(s.alarmEmail));
    for (const a of alarms) a.addAlarmAction(new cwActions.SnsAction(topic));


    // ---------------------------------------------------------------- what the founder needs after the deploy
    new CfnOutput(this, "CustomDomain", { value: s.domainName, description: "The API's host (dashboard API, GitHub App, runner reports)" });
    new CfnOutput(this, "DnsTarget", { value: domain.regionalDomainName, description: `Cloudflare: CNAME ${s.domainName} -> this value (DNS only, grey cloud)` });
    new CfnOutput(this, "WebhookUrl", { value: `https://${s.domainName}/webhooks/github` });
    new CfnOutput(this, "SetupUrl", { value: `https://${s.domainName}/github/setup` });
    new CfnOutput(this, "CertificateArn", { value: certificate.certificateArn });
    new CfnOutput(this, "WorkQueueUrl", { value: queue.queueUrl });
    new CfnOutput(this, "DeadLetterQueueUrl", { value: dlq.queueUrl });
    new CfnOutput(this, "HttpLogGroup", { value: `/aws/lambda/${name("http")}` });
    new CfnOutput(this, "DashboardApiUrl", { value: `https://${s.domainName}/v1`, description: "The dashboard's VITE_API_URL" });
    new CfnOutput(this, "ApiLogGroup", { value: `/aws/lambda/${name("api")}` });
    new CfnOutput(this, "WorkerLogGroup", { value: `/aws/lambda/${name("worker")}` });
    new CfnOutput(this, "SweepLogGroup", { value: `/aws/lambda/${name("sweep")}` });
    new CfnOutput(this, "RunnerMode", { value: s.runnerMode });
    new CfnOutput(this, "ImagePipelineArn", { value: fleet.pipeline.attrArn, description: "scripts/build-image.sh builds the runner image with it" });
    new CfnOutput(this, "EngineVersion", { value: fleet.engineVersion, description: "The trunk engine the machine image installs (none: not pinned; no image is built)" });
    new CfnOutput(this, "RunnerImageVersion", { value: fleet.imageVersion, description: "The runner image recipe's version; the deploy pipeline starts a build when no image of it exists" });
    new CfnOutput(this, "GitHubApp", { value: s.githubConfigured ? `configured (App ${s.githubAppId}, ${s.githubAppSlug})` : "not configured: the App's routes answer 503 github_not_configured" });
    new CfnOutput(this, "LaunchTemplateId", { value: fleet.launchTemplate.ref });
    new CfnOutput(this, "ReaperLogGroup", { value: `/aws/lambda/${name("reaper")}` });
    if (warmup) new CfnOutput(this, "WarmupLogGroup", { value: `/aws/lambda/${name("warmup")}` });
    {
      new CfnOutput(this, "CacheInstanceId", { value: cache.instance.instanceId });
      new CfnOutput(this, "CacheAmiId", { value: (cache.instance.node.defaultChild as unknown as { imageId: string }).imageId, description: "Kept on later deploys by the deploy pipeline (FENVIX_CACHE_AMI_ID)" });
      new CfnOutput(this, "CacheUrl", { value: `http://${s.cachePrivateIp}:8787`, description: "Inside the VPC only; one organization per repository (gh-<installation id>-r<repository id>), per-job tokens" });
    }
  }
}
