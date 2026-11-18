import { EC2Client } from "@aws-sdk/client-ec2";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { buildApp, buildCore, type App, type Core } from "../app.ts";
import { type Config, loadConfig } from "../config.ts";
import { type BlobPort, s3Port, SqsWorkQueue, sqsPort } from "../queue/sqs.ts";
import { Ec2Launcher, type RunnerLauncher } from "../runners/launcher.ts";
import type { Logger } from "../service.ts";
import { jsonLogger } from "../work.ts";
import { loadSecrets, type Surface } from "./secrets.ts";

type Env = Record<string, string | undefined>;

/**
 * What a Lambda needs at cold start: the plain settings from its environment (set by infra/github-app), the secrets
 * from SSM, then the config check of src/config.ts (the same rules as the node server).
 */
export async function lambdaConfig(env: Env, surface: Surface, ssm: SSMClient = new SSMClient({})): Promise<Config> {
  const prefix = env.SSM_PREFIX;
  if (!prefix) throw new Error("SSM_PREFIX is required");
  const secrets = await loadSecrets(ssm, prefix, surface);
  return loadConfig({ ...env, ...secrets }, { surface });
}

export function overflowBlobs(env: Env): BlobPort | null {
  return env.OVERFLOW_BUCKET ? s3Port(new S3Client({}), env.OVERFLOW_BUCKET) : null;
}

/** The HTTP Lambda's app: checked requests go to SQS. */
export async function httpApp(env: Env): Promise<App> {
  const cfg = await lambdaConfig(env, "all");
  if (!env.WORK_QUEUE_URL) throw new Error("WORK_QUEUE_URL is required");
  const queue = new SqsWorkQueue({ queue: sqsPort(new SQSClient({}), env.WORK_QUEUE_URL), blobs: overflowBlobs(env) });
  return buildApp({ cfg, queue });
}

/** The plain settings a per-job machine gets in its user data (the infra sets them as FENVIX_MACHINE_<NAME>). */
export function machineEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (k.startsWith("FENVIX_MACHINE_") && v) out[k.slice("FENVIX_MACHINE_".length)] = v;
  return out;
}

/** RUNNER_MODE=per-job: the launcher of runner machines (the worker only). */
export function launcherFrom(env: Env, log: Logger, ec2: EC2Client = new EC2Client({})): RunnerLauncher | null {
  if (env.RUNNER_MODE !== "per-job") return null;
  if (!env.RUNNER_LAUNCH_TEMPLATE_ID) throw new Error("RUNNER_LAUNCH_TEMPLATE_ID is required with RUNNER_MODE=per-job");
  const max = Number(env.RUNNER_MAX_RUNNING ?? "4");
  if (!Number.isInteger(max) || max < 1) throw new Error("RUNNER_MAX_RUNNING must be a positive integer");
  const tags: Record<string, string> = { project: "fenvix" };
  if (env.FENVIX_ENV) tags.env = env.FENVIX_ENV;
  return new Ec2Launcher({ ec2, launchTemplateId: env.RUNNER_LAUNCH_TEMPLATE_ID, maxRunning: max, machineEnv: machineEnv(env), tags, log });
}

/** The worker's and the sweep's service (no HTTP secrets). Only the worker starts runner machines. */
export async function workerCore(env: Env, opts: { launches?: boolean } = {}): Promise<Core & { log: Logger; blobs: BlobPort | null }> {
  const cfg = await lambdaConfig(env, "worker");
  const log = jsonLogger(cfg.logLevel);
  return { ...buildCore(cfg, log, opts.launches ? launcherFrom(env, log) : null), log, blobs: overflowBlobs(env) };
}

/** A promise kept across warm invocations; forgotten if it failed, so the next invocation tries again. */
export function once<T>(make: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    if (!p) {
      p = make();
      p.catch(() => { p = null; });
    }
    return p;
  };
}
