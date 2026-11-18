import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { buildApp, buildCore, type App, type Core } from "../app.ts";
import { type Config, loadConfig } from "../config.ts";
import { type BlobPort, s3Port, SqsWorkQueue, sqsPort } from "../queue/sqs.ts";
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

/** The worker's and the sweep's service (no HTTP secrets). */
export async function workerCore(env: Env): Promise<Core & { log: Logger; blobs: BlobPort | null }> {
  const cfg = await lambdaConfig(env, "worker");
  const log = jsonLogger(cfg.logLevel);
  return { ...buildCore(cfg, log), log, blobs: overflowBlobs(env) };
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
