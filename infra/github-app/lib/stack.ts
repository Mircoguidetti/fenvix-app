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
import { appPrefix, readersOf } from "./parameters.ts";
import { CacheMachine } from "./cache.ts";
import { RunnerNetwork } from "./network.ts";
import { commonMachineEnv, perJobMachineEnv } from "./runner.ts";
import { RunnerFleet } from "./runner-fleet.ts";
import type { Settings } from "./settings.ts";

const SERVICE_DIR = fileURLToPath(new URL("../../../github-app/", import.meta.url));

/** Worker timeout; the queue's visibility timeout is six times this (AWS's advice for Lambda consumers). */
const WORKER_TIMEOUT = Duration.seconds(120);

export interface FenvixGitHubAppProps extends StackProps { settings: Settings }

/**
 * The fenvix GitHub App on AWS (docs/DEPLOY-AWS.md):
 *
 *   GitHub ─HTTPS─▶ github.<domain> (API Gateway HTTP API, ACM certificate) ─▶ http Lambda
 *                     checks the signature / runner token, sends the work to SQS, answers 202
 *   SQS work queue (dead-letter queue after 5 tries; large payloads via the overflow bucket) ─▶ worker Lambda
 *   EventBridge Scheduler, every few minutes ─▶ sweep Lambda (runs whose summary never came)
 *   runner machines (demo: one per demo, scripts/demo-up.sh; per-job: one per queued job), from the runner image
 *     ─▶ POST https://github.<domain>/v1/runner/summaries
 *
 * Secrets: SSM SecureString parameters under /fenvix/<env>/github-app/, created by hand, read by exact name.
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
    const fn = (id: string, entry: string, o: { timeout: Duration; memory: number; extraEnv?: Record<string, string>; reads: string[]; description: string }) => {
      const logGroup = new logs.LogGroup(this, `${id}Logs`, { logGroupName: `/aws/lambda/${name(id.toLowerCase())}`, retention: s.logRetentionDays, removalPolicy: RemovalPolicy.DESTROY });
      // Own role, no managed policy: write to its own log group, read its own parameters.
      const role = new iam.Role(this, `${id}Role`, { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"), description: `fenvix GitHub App: ${id} function` });
      role.addToPolicy(new iam.PolicyStatement({ sid: "OwnLogGroup", actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`] }));
      if (o.reads.length) role.addToPolicy(new iam.PolicyStatement({ sid: "OwnSecrets", actions: ["ssm:GetParameters"], resources: o.reads.map(paramArn) }));
      const f = new NodejsFunction(this, id, {
        functionName: name(id.toLowerCase()),
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
        environment: { ...env, ...(o.extraEnv ?? {}) },
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

    const launchEnv: Record<string, string> = perJob ? {
      RUNNER_MODE: "per-job", RUNNER_LAUNCH_TEMPLATE_ID: fleet.launchTemplate.ref, RUNNER_MAX_RUNNING: String(s.runnerMaxRunning), FENVIX_ENV: s.env,
      ...Object.fromEntries(Object.entries(perJobMachineEnv(s)).map(([k, v]) => [`FENVIX_MACHINE_${k}`, v])),
    } : { RUNNER_MODE: "demo" };
    const worker = fn("Worker", "worker.ts", {
      timeout: WORKER_TIMEOUT, memory: 512, reads: readersOf(s.env, "worker"), extraEnv: launchEnv,
      description: "fenvix GitHub App: runs queued webhooks and runner summaries",
    });
    worker.addToRolePolicy(new iam.PolicyStatement({ sid: "ReadAndDeleteOverflow", actions: ["s3:GetObject", "s3:DeleteObject"], resources: [overflow.arnForObjects("work/*")] }));
    worker.addEventSource(new SqsEventSource(queue, { batchSize: 5, reportBatchItemFailures: true, maxConcurrency: 2 }));

    // Start a runner machine: only from our launch template and our own images, only tagged with its role.
    const arn = (r: string) => `arn:${this.partition}:ec2:${this.region}:${this.account}:${r}`;
    const mayLaunch = (f: lambda.IFunction, role: string) => {
      f.addToRolePolicy(new iam.PolicyStatement({
        sid: "RunJobMachines", actions: ["ec2:RunInstances"],
        resources: [arn(`launch-template/${fleet.launchTemplate.ref}`), arn(`subnet/${net.subnet.subnetId}`), arn(`security-group/${net.runnerSg.securityGroupId}`), arn("network-interface/*")],
      }));
      f.addToRolePolicy(new iam.PolicyStatement({
        sid: "RunFromOwnImages", actions: ["ec2:RunInstances"], resources: [`arn:${this.partition}:ec2:${this.region}::image/*`],
        conditions: { StringEquals: { "ec2:Owner": this.account } },
      }));
      f.addToRolePolicy(new iam.PolicyStatement({
        sid: "OnlyTaggedJobMachines", actions: ["ec2:RunInstances"], resources: [arn("instance/*"), arn("volume/*")],
        conditions: { StringEquals: { "aws:RequestTag/fenvix:role": role } },
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
    if (perJob) mayLaunch(worker, "runner-job");

    // ---------------------------------------------------------------- demo mode: scripts/demo-up.sh and demo-down.sh
    let demo: lambda.IFunction | null = null;
    if (!perJob) {
      demo = fn("Demo", "demo.ts", {
        timeout: Duration.seconds(60), memory: 256, reads: [`${appPrefix(s.env)}/private-key`],
        extraEnv: {
          GITHUB_APP_ID: s.githubAppId, RUNNER_LAUNCH_TEMPLATE_ID: fleet.launchTemplate.ref, DEMO_REPOSITORY: s.demoRepository, FENVIX_ENV: s.env,
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

    // ---------------------------------------------------------------- the reaper: machines past the hard limit
    {
      const hours = perJob ? s.runnerMaxHours : s.demoMaxHours;
      const reaper = fn("Reaper", "reaper.ts", {
        timeout: Duration.seconds(60), memory: 256, reads: [], extraEnv: { REAP: `${machineRole}:${hours}` },
        description: `fenvix: terminates ${machineRole} machines older than ${hours} hours`,
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
      // DNS stays on Cloudflare: the deploy waits until the founder adds the CNAME that scripts/deploy.sh prints.
      validation: acm.CertificateValidation.fromDns(),
    });
    const domain = new apigw.DomainName(this, "Domain", { domainName: s.domainName, certificate, securityPolicy: apigw.SecurityPolicy.TLS_1_2 });
    const api = new apigw.HttpApi(this, "Api", {
      apiName: name("api"),
      description: "fenvix GitHub App",
      defaultIntegration: new HttpLambdaIntegration("Http", http, { payloadFormatVersion: apigw.PayloadFormatVersion.VERSION_2_0 }),
      createDefaultStage: false,
      // Only https://<domain>: the execute-api URL is switched off.
      disableExecuteApiEndpoint: true,
    });
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
    new CfnOutput(this, "WorkerLogGroup", { value: `/aws/lambda/${name("worker")}` });
    new CfnOutput(this, "SweepLogGroup", { value: `/aws/lambda/${name("sweep")}` });
    new CfnOutput(this, "RunnerMode", { value: s.runnerMode });
    new CfnOutput(this, "ImagePipelineArn", { value: fleet.pipeline.attrArn, description: "scripts/build-image.sh builds the runner image with it" });
    new CfnOutput(this, "LaunchTemplateId", { value: fleet.launchTemplate.ref });
    new CfnOutput(this, "ReaperLogGroup", { value: `/aws/lambda/${name("reaper")}` });
    if (demo) {
      new CfnOutput(this, "DemoFunctionName", { value: name("demo"), description: "scripts/demo-up.sh and demo-down.sh invoke it" });
      new CfnOutput(this, "DemoLogGroup", { value: `/aws/lambda/${name("demo")}` });
    }
    if (cache) {
      new CfnOutput(this, "CacheInstanceId", { value: cache.instance.instanceId });
      new CfnOutput(this, "CacheAmiId", { value: (cache.instance.node.defaultChild as unknown as { imageId: string }).imageId, description: "Kept on later deploys by scripts/deploy.sh" });
      new CfnOutput(this, "CacheUrl", { value: `http://${s.cachePrivateIp}:8787/${s.cacheOrg}`, description: "Inside the VPC only" });
    }
  }
}
