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
import { commonMachineEnv, perJobMachineEnv } from "./runner.ts";
import { RunnerFleet } from "./runner-fleet.ts";
import type { Settings } from "./settings.ts";

/** The managed policy every role of the stack is bounded by (permissions-boundary.json, created by hand). */
export const boundaryName = (env: string) => `fenvix-${env}-github-app-boundary`;

const SERVICE_DIR = fileURLToPath(new URL("../../../github-app/", import.meta.url));

/** Worker timeout; the queue's visibility timeout is six times this (AWS's advice for Lambda consumers). */
const WORKER_TIMEOUT = Duration.seconds(120);

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
 *   runner machines (demo: one per demo, scripts/demo-up.sh; per-job: one per queued job), from the runner image
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
    // modes); the shared cache machine (per-job only: a demo keeps its cache on its own disk)
    const perJob = s.runnerMode === "per-job";
    const net = new RunnerNetwork(this, "Network", this.zone, { cache: perJob });
    const fleet = new RunnerFleet(this, "Fleet", s, net);
    const cache = perJob ? new CacheMachine(this, "Cache", s, net) : null;
    const machineRole = perJob ? "runner-job" : "runner-demo";

    // ---------------------------------------------------------------- the functions
    const env: Record<string, string> = {
      NODE_ENV: "production", NODE_OPTIONS: "--enable-source-maps", LOG_LEVEL: "info", SSM_PREFIX: appPrefix(s.env),
      GITHUB_APP_ID: s.githubAppId, GITHUB_APP_SLUG: s.githubAppSlug, GITHUB_CLIENT_ID: s.githubClientId,
      DASHBOARD_URL: s.dashboardUrl, SUPABASE_URL: s.supabaseUrl, FENVIX_RUNS_ON: s.runsOnLabel,
      SUMMARY_WAIT_SECONDS: String(s.summaryWaitSeconds), SWEEP_SECONDS: "0", DB_POOL_MAX: "2", OVERFLOW_BUCKET: overflow.bucketName,
    };
    const fn = (id: string, entry: string, o: { timeout: Duration; memory: number; extraEnv?: Record<string, string>; reads: string[]; description: string; baseEnv?: Record<string, string>; short?: string }) => {
      const short = o.short ?? id.toLowerCase();
      const logGroup = new logs.LogGroup(this, `${id}Logs`, { logGroupName: `/aws/lambda/${name(short)}`, retention: s.logRetentionDays, removalPolicy: RemovalPolicy.DESTROY });
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
      timeout: Duration.seconds(29), memory: 512, extraEnv: { WORK_QUEUE_URL: queue.queueUrl }, reads: readersOf(s.env, "http"),
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
        WORK_QUEUE_URL: queue.queueUrl, ...(s.apiCorsOrigins ? { API_CORS_ORIGINS: s.apiCorsOrigins } : {}),
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
    const launchEnv: Record<string, string> = perJob ? {
      RUNNER_MODE: "per-job", RUNNER_LAUNCH_TEMPLATE_ID: fleet.launchTemplate.ref, RUNNER_MAX_RUNNING: String(s.runnerMaxRunning), FENVIX_ENV: s.env,
      RUNNER_PLACEMENT: this.toJsonString(placement),
      CACHE_SIGNING_KEY_PARAM: `${cachePrefix(s.env)}/signing-key`,
      ...Object.fromEntries(Object.entries(perJobMachineEnv(s)).map(([k, v]) => [`FENVIX_MACHINE_${k}`, v])),
    } : { RUNNER_MODE: "demo" };
    // Warm-up runs (per-job only; github-app/src/warmup/): the worker requests them (webhooks) and preempts them for a
    // customer job; the warm-up scheduler gives them machines.
    const warmupEnv: Record<string, string> = perJob ? {
      WARMUP_ENABLED: String(s.warmupEnabled), WARMUP_DAILY_CAP: String(s.warmupDailyCap), WARMUP_ORG_CONCURRENCY: String(s.warmupOrgConcurrency),
      WARMUP_RESERVE: String(s.warmupReserve), WARMUP_GRACE_SECONDS: String(s.warmupGraceSeconds), WARMUP_TICK_SECONDS: "0",
    } : { WARMUP_ENABLED: "false" };
    // The worker signs each machine's credentials (per-job only): the summary key and the cache signing key.
    const workerReads = readersOf(s.env, "worker").filter((p) => perJob || !/\/(runner-token|signing-key)$/.test(p));
    const worker = fn("Worker", "worker.ts", {
      timeout: WORKER_TIMEOUT, memory: 512, reads: workerReads, extraEnv: { ...launchEnv, ...warmupEnv },
      description: "fenvix GitHub App: runs queued webhooks and runner summaries",
    });
    worker.addToRolePolicy(new iam.PolicyStatement({ sid: "ReadAndDeleteOverflow", actions: ["s3:GetObject", "s3:DeleteObject"], resources: [overflow.arnForObjects("work/*")] }));
    worker.addEventSource(new SqsEventSource(queue, { batchSize: 5, reportBatchItemFailures: true, maxConcurrency: 2 }));

    // Start a runner machine: only from our launch template, of the configured type, from our own images, only tagged
    // with its role (R-012 F7: the instance, its disk and its network interface must come from the launch template).
    const arn = (r: string) => `arn:${this.partition}:ec2:${this.region}:${this.account}:${r}`;
    const fromTemplate = { "ec2:LaunchTemplate": arn(`launch-template/${fleet.launchTemplate.ref}`) };
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
        conditions: { StringEquals: { "aws:RequestTag/fenvix:role": role, "ec2:InstanceType": s.runnerInstanceType }, ArnEquals: fromTemplate },
      }));
      f.addToRolePolicy(new iam.PolicyStatement({
        sid: "OnlyTaggedJobDisks", actions: ["ec2:RunInstances"], resources: [arn("volume/*")],
        conditions: { StringEquals: { "aws:RequestTag/fenvix:role": role }, ArnEquals: fromTemplate },
      }));
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
    let warmup: lambda.IFunction | null = null;
    if (perJob) {
      mayLaunch(worker, "runner-job");
      // A customer job that finds the fleet full takes a warm-up's machine (preemption).
      mayTerminateWarmups(worker);
      warmup = fn("Warmup", "warmup.ts", {
        timeout: Duration.seconds(120), memory: 256, reads: readersOf(s.env, "warmup"), extraEnv: { ...launchEnv, ...warmupEnv },
        description: "fenvix GitHub App: warm-up runs of onboarded default branches (lowest priority; never billed)",
      });
      mayLaunch(warmup, "runner-job");
      mayTerminateWarmups(warmup);
    }

    // ---------------------------------------------------------------- demo mode: scripts/demo-up.sh and demo-down.sh
    let demo: lambda.IFunction | null = null;
    if (!perJob) {
      // demo-down terminates, waits for the machine to be gone, then deregisters (retrying while GitHub says busy).
      demo = fn("Demo", "demo.ts", {
        timeout: Duration.seconds(180), memory: 256, reads: readersOf(s.env, "demo"),
        extraEnv: {
          GITHUB_APP_ID: s.githubAppId, RUNNER_LAUNCH_TEMPLATE_ID: fleet.launchTemplate.ref, DEMO_REPOSITORY: s.demoRepository, DEMO_MAX_HOURS: String(s.demoMaxHours), FENVIX_ENV: s.env,
          ...Object.fromEntries(Object.entries(commonMachineEnv(s)).map(([k, v]) => [`FENVIX_MACHINE_${k}`, v])),
        },
        description: "fenvix demo mode: registers a runner and starts one fresh machine (up), deregisters and terminates it (down)",
      });
      mayLaunch(demo, "runner-demo");
      mayTerminate(demo, "runner-demo");
    }

    const sweep = fn("Sweep", "sweep.ts", {
      timeout: Duration.seconds(300), memory: 256, reads: readersOf(s.env, "sweep"),
      description: "fenvix GitHub App: publishes completed jobs whose runner summary never came",
    });

    // ---------------------------------------------------------------- the sweep's schedule
    const schedulerRole = new iam.Role(this, "SweepScheduleRole", { assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": this.account } } }) });
    schedulerRole.addToPolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [sweep.functionArn] }));
    new scheduler.CfnSchedule(this, "SweepSchedule", {
      name: name("sweep"),
      description: "Publishes completed fenvix jobs whose summary never came (SUMMARY_WAIT_SECONDS)",
      scheduleExpression: `rate(${s.sweepMinutes} ${s.sweepMinutes === 1 ? "minute" : "minutes"})`,
      flexibleTimeWindow: { mode: "OFF" },
      state: "ENABLED",
      target: { arn: sweep.functionArn, roleArn: schedulerRole.roleArn, retryPolicy: { maximumRetryAttempts: 0 } },
    });

    // ---------------------------------------------------------------- the warm-up scheduler's schedule (per-job)
    if (warmup) {
      schedulerRole.addToPolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [warmup.functionArn] }));
      new scheduler.CfnSchedule(this, "WarmupSchedule", {
        name: name("warmup"),
        description: "Warm-up runs: terminate unneeded warm-up machines, dispatch pending warm-ups when machines are free",
        scheduleExpression: "rate(1 minute)", flexibleTimeWindow: { mode: "OFF" }, state: "ENABLED",
        target: { arn: warmup.functionArn, roleArn: schedulerRole.roleArn, retryPolicy: { maximumRetryAttempts: 0 } },
      });
    }

    // ---------------------------------------------------------------- the reaper: machines past the hard limit
    {
      const hours = perJob ? s.runnerMaxHours : s.demoMaxHours;
      // Demo: the reaper also deregisters the runner of every demo machine that is gone (R-012 F6), so it reads the
      // App's private key. Per-job runners are just-in-time (GitHub removes them after their one job).
      const reaper = fn("Reaper", "reaper.ts", {
        timeout: Duration.seconds(120), memory: 256, reads: perJob ? [] : readersOf(s.env, "reaper-demo"),
        extraEnv: { REAP: `${machineRole}:${hours}`, ...(perJob ? {} : { DEREGISTER_DEMO_RUNNERS: "1" }) },
        description: `fenvix: terminates ${machineRole} machines older than ${hours} hours${perJob ? "" : "; deregisters the runners of demo machines that are gone"}`,
      });
      reaper.addToRolePolicy(new iam.PolicyStatement({ sid: "ListMachines", actions: ["ec2:DescribeInstances"], resources: ["*"] }));
      mayTerminate(reaper, machineRole);
      schedulerRole.addToPolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [reaper.functionArn] }));
      new scheduler.CfnSchedule(this, "ReaperSchedule", {
        name: name("reaper"), description: "Terminates runner machines past the hard limit",
        scheduleExpression: "rate(10 minutes)", flexibleTimeWindow: { mode: "OFF" }, state: "ENABLED",
        target: { arn: reaper.functionArn, roleArn: schedulerRole.roleArn, retryPolicy: { maximumRetryAttempts: 0 } },
      });
    }

    // ---------------------------------------------------------------- HTTPS on the custom domain
    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: s.domainName,
      // DNS stays on Cloudflare: while CloudFormation waits, the deploy pipeline puts the validation CNAME there.
      validation: acm.CertificateValidation.fromDns(),
    });
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
    const accessLogs = new logs.LogGroup(this, "ApiAccessLogs", { logGroupName: `/aws/apigateway/${name("api")}`, retention: s.logRetentionDays, removalPolicy: RemovalPolicy.DESTROY });
    new apigw.HttpStage(this, "Stage", {
      httpApi: api, stageName: "$default", autoDeploy: true,
      throttle: { rateLimit: 50, burstLimit: 100 },
      domainMapping: { domainName: domain },
      accessLogSettings: { destination: new apigw.LogGroupLogDestination(accessLogs) },
    });

    // ---------------------------------------------------------------- alarm: anything in the dead-letter queue
    const alarm = new cloudwatch.Alarm(this, "DeadLettersAlarm", {
      alarmName: name("dead-letters"),
      alarmDescription: "Work failed 5 times and is in the dead-letter queue (docs/DEPLOY-AWS.md, 'When something fails').",
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: "Maximum" }),
      threshold: 0, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    if (s.alarmEmail) {
      const topic = new sns.Topic(this, "Alerts", { topicName: name("alerts"), enforceSSL: true });
      topic.addSubscription(new subs.EmailSubscription(s.alarmEmail));
      alarm.addAlarmAction(new cwActions.SnsAction(topic));
    }


    // ---------------------------------------------------------------- what the founder needs after the deploy
    new CfnOutput(this, "CustomDomain", { value: s.domainName, description: "The App's host" });
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
    new CfnOutput(this, "RunnerImageVersion", { value: fleet.imageVersion, description: "The runner image recipe's version; the deploy pipeline starts a build when no image of it exists" });
    new CfnOutput(this, "GitHubApp", { value: s.githubConfigured ? `configured (App ${s.githubAppId}, ${s.githubAppSlug})` : "not configured: the App's routes answer 503 github_not_configured" });
    new CfnOutput(this, "LaunchTemplateId", { value: fleet.launchTemplate.ref });
    new CfnOutput(this, "ReaperLogGroup", { value: `/aws/lambda/${name("reaper")}` });
    if (warmup) new CfnOutput(this, "WarmupLogGroup", { value: `/aws/lambda/${name("warmup")}` });
    if (demo) {
      new CfnOutput(this, "DemoFunctionName", { value: name("demo"), description: "scripts/demo-up.sh and demo-down.sh invoke it" });
      new CfnOutput(this, "DemoLogGroup", { value: `/aws/lambda/${name("demo")}` });
    }
    if (cache) {
      new CfnOutput(this, "CacheInstanceId", { value: cache.instance.instanceId });
      new CfnOutput(this, "CacheAmiId", { value: (cache.instance.node.defaultChild as unknown as { imageId: string }).imageId, description: "Kept on later deploys by the deploy pipeline (FENVIX_CACHE_AMI_ID)" });
      new CfnOutput(this, "CacheUrl", { value: `http://${s.cachePrivateIp}:8787`, description: "Inside the VPC only; one organization per installation (gh-<installation id>), per-job tokens" });
    }
  }
}
