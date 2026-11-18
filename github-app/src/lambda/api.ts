// AWS Lambda entry of the dashboard API: API Gateway HTTP API (payload 2.0) → Fastify (src/api/server.ts). Bundled by
// infra/github-app; API Gateway sends it /v1/* except /v1/runner/* (which stays on the App's HTTP function).
import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { type ApiConfig, loadApiConfig } from "../api/config.ts";
import type { OnboardQueue } from "../api/context.ts";
import { type Api, buildApi } from "../api/server.ts";
import { SqsWorkQueue, sqsPort } from "../queue/sqs.ts";
import { invoke, type HttpApiEvent, type HttpApiResult } from "./apigw.ts";
import { loadSecrets } from "./secrets.ts";

type Env = Record<string, string | undefined>;

/** The API's settings: plain ones from the environment (set by infra/github-app), its two secrets from SSM. */
export async function apiConfig(env: Env, ssm: Pick<SSMClient, "send"> = new SSMClient({})): Promise<ApiConfig> {
  if (!env.SSM_PREFIX) throw new Error("SSM_PREFIX is required");
  const secrets = await loadSecrets(ssm, env.SSM_PREFIX, "api");
  // One connection per container: Lambda runs one request at a time; the pooler shares the database's connections.
  return loadApiConfig({ DB_POOL_MAX: "1", ...env, ...secrets });
}

/** The API with its queue: the setup pull request goes to the App's worker over SQS. */
export async function apiFromEnv(env: Env, o: { ssm?: Pick<SSMClient, "send">; queue?: OnboardQueue } = {}): Promise<Api> {
  const cfg = await apiConfig(env, o.ssm);
  let queue = o.queue;
  if (!queue) {
    if (!env.WORK_QUEUE_URL) throw new Error("WORK_QUEUE_URL is required");
    const sqs = new SqsWorkQueue({ queue: sqsPort(new SQSClient({}), env.WORK_QUEUE_URL), blobs: null });
    queue = { enqueue: (w) => sqs.enqueue(w) };
  }
  return buildApi({ cfg, queue });
}

/**
 * Kept across warm invocations and made again after SECRETS_TTL_SECONDS (default 300), so that a rotated database
 * password or state key takes effect without a deploy; forgotten if it failed, so the next request tries again.
 */
export function cached(make: () => Promise<Api>, ttlMs = Number(process.env.SECRETS_TTL_SECONDS ?? "300") * 1000 || 300_000, now = Date.now): () => Promise<Api> {
  let cur: { p: Promise<Api>; at: number } | null = null;
  return async () => {
    if (cur && now() - cur.at >= ttlMs) {
      const old = cur.p;
      const next = make();
      try {
        await next;
        cur = { p: next, at: now() };
        void old.then((a) => a.close()).catch(() => undefined);
      } catch {
        cur = { p: old, at: cur.at };
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

export function makeApiHandler(getApi: () => Promise<Api>) {
  return async (event: HttpApiEvent): Promise<HttpApiResult> => invoke((await getApi()).fastify, event);
}

export const handler = makeApiHandler(cached(() => apiFromEnv(process.env)));
