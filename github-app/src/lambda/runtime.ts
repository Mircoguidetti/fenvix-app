import { EC2Client } from "@aws-sdk/client-ec2";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { buildApp, buildCore, type App, type Core } from "../app.ts";
import { type Config, loadConfig } from "../config.ts";
import { type BlobPort, s3Port, SqsWorkQueue, sqsPort } from "../queue/sqs.ts";
import { Ec2Launcher, placementsFromEnv, type RunnerLauncher } from "../runners/launcher.ts";
import type { Logger } from "../service.ts";
import { githubAppConfigured, notConfiguredHttp } from "../not-configured.ts";
import { jsonLogger } from "../work.ts";
import { loadParameter, loadSecrets, type Surface } from "./secrets.ts";

type Env = Record<string, string | undefined>;

/**
 * What a Lambda needs at cold start: the plain settings from its environment (set by infra/github-app), the secrets
 * from SSM, then the config check of src/config.ts (the same rules as the node server).
 */
export async function lambdaConfig(env: Env, surface: Surface, ssm: SSMClient = new SSMClient({})): Promise<Config> {
  const prefix = env.SSM_PREFIX;
  if (!prefix) throw new Error("SSM_PREFIX is required");
  const secrets = await loadSecrets(ssm, prefix, surface);
  if (surface === "launcher" && env.CACHE_SIGNING_KEY_PARAM) secrets.CACHE_SIGNING_KEY = await loadParameter(ssm, env.CACHE_SIGNING_KEY_PARAM);
  return loadConfig({ ...env, ...secrets }, { surface: surface === "all" ? "all" : "worker" });
}

export function overflowBlobs(env: Env): BlobPort | null {
  return env.OVERFLOW_BUCKET ? s3Port(new S3Client({}), env.OVERFLOW_BUCKET) : null;
}

/**
 * The HTTP Lambda's app: checked requests go to SQS. While the GitHub App is not configured (GITHUB_APP_ID empty),
 * /healthz answers and every other route answers 503 github_not_configured; no secret is read.
 */
export async function httpApp(env: Env): Promise<Pick<App, "fastify" | "close">> {
  if (!githubAppConfigured(env)) return notConfiguredHttp(env.LOG_LEVEL ?? "info");
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

/**
 * RUNNER_MODE=per-job: the launcher of runner machines (the worker only). RUNNER_PLACEMENT places each organization's
 * machines in its region (src/runners/launcher.ts placementsFromEnv); RUNNER_LAUNCH_TEMPLATE_ID alone is the "us" one.
 */
export function launcherFrom(env: Env, log: Logger, ec2: EC2Client = new EC2Client({})): RunnerLauncher | null {
  if (env.RUNNER_MODE !== "per-job") return null;
  const placements = placementsFromEnv(env, (awsRegion) => (awsRegion ? new EC2Client({ region: awsRegion }) : ec2));
  if (!Object.keys(placements).length) throw new Error("RUNNER_LAUNCH_TEMPLATE_ID (or RUNNER_PLACEMENT) is required with RUNNER_MODE=per-job");
  const max = Number(env.RUNNER_MAX_RUNNING ?? "4");
  if (!Number.isInteger(max) || max < 1) throw new Error("RUNNER_MAX_RUNNING must be a positive integer");
  const tags: Record<string, string> = { project: "fenvix" };
  if (env.FENVIX_ENV) tags.env = env.FENVIX_ENV;
  return new Ec2Launcher({ placements, maxRunning: max, machineEnv: machineEnv(env), tags, log });
}

/** The worker's and the sweep's service (no HTTP secrets). Only the worker starts runner machines. */
export async function workerCore(env: Env, opts: { launches?: boolean } = {}): Promise<Core & { log: Logger; blobs: BlobPort | null; close(): Promise<void> }> {
  const launches = !!opts.launches && env.RUNNER_MODE === "per-job";
  const cfg = await lambdaConfig(env, launches ? "launcher" : "worker");
  const log = jsonLogger(cfg.logLevel);
  if (launches && !cfg.runnerTokens.length) throw new Error("RUNNER_TOKEN is required to start machines (each gets its own summary credential)");
  const core = buildCore(cfg, log, launches ? launcherFrom(env, log) : null);
  const blobs = overflowBlobs(env);
  // Side-by-side histories go through the queue (work kind side_by_side_history) when the function may send to it.
  if (env.WORK_QUEUE_URL) {
    const queue = new SqsWorkQueue({ queue: sqsPort(new SQSClient({}), env.WORK_QUEUE_URL), blobs });
    core.service.enqueueHistory = (repositoryId) => queue.enqueue({ kind: "side_by_side_history", repositoryId });
  }
  return { ...core, log, blobs, close: () => core.db.close() };
}

/**
 * Like once(), but made again after `ttlMs` (default SECRETS_TTL_SECONDS, 300 s), so that a rotated secret takes effect
 * within minutes without a deploy (R-012 F15). The previous value is closed after the new one is ready; a Lambda
 * container handles one invocation at a time, so nothing is in flight on it then.
 */
export function refreshing<T extends { close(): Promise<void> }>(make: () => Promise<T>, ttlMs = ttlFromEnv(), now = Date.now): () => Promise<T> {
  let cur: { p: Promise<T>; at: number } | null = null;
  return async () => {
    if (cur && now() - cur.at >= ttlMs) {
      const old = cur.p;
      const next = make();
      try {
        await next;
        cur = { p: next, at: now() };
        void old.then((o) => o.close()).catch(() => undefined);
      } catch {
        // Keep serving with the old secrets; try again on the next invocation.
        cur = { p: old, at: cur.at };
        return old;
      }
    }
    if (!cur) {
      const p = make();
      cur = { p, at: now() };
      p.catch(() => { if (cur?.p === p) cur = null; });
    }
    return cur.p;
  };
}

const ttlFromEnv = () => {
  const n = Number(process.env.SECRETS_TTL_SECONDS ?? "300");
  return (Number.isFinite(n) && n > 0 ? n : 300) * 1000;
};

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
