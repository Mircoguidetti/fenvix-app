import type { Logger } from "./service.ts";
import type { GitHubService } from "./service.ts";

/**
 * The work an HTTP request hands off after it has been checked (signature, runner token, body): the request is
 * answered 202 at once and this runs elsewhere.
 *
 *   - node server mode (src/server.ts, the tests): in the same process, in the background (InProcessQueue);
 *   - AWS Lambda (src/lambda/): sent to an SQS queue and run by the worker Lambda (src/queue/sqs.ts), so no work
 *     happens after the HTTP response, which Lambda would freeze.
 *
 * Running the same Work twice is safe: deliveries are recorded once (gh_webhook_deliveries), summaries are upserted,
 * and a run is published once (gh_jobs.published_at) with one usage event per GitHub job.
 */
export type Work =
  | { kind: "webhook"; event: string; delivery: string; payload: Record<string, unknown> }
  | {
    kind: "summary"; repositoryId: number; runId: number; runAttempt: number; runnerName: string; receiptsUrl: string | null;
    summary: Record<string, unknown>;
  };

export interface WorkQueue {
  /** Resolves once the work is accepted (queued durably, or started in this process). Rejects if it was not. */
  enqueue(work: Work): Promise<void>;
}

export function describeWork(w: Work): string {
  return w.kind === "webhook" ? `webhook ${w.event} ${w.delivery}` : `summary ${w.repositoryId}/${w.runId}/${w.runAttempt}`;
}

/** Runs one piece of work. Throws if it failed (the queue then retries it). */
export async function runWork(service: GitHubService, w: Work): Promise<void> {
  if (w.kind === "webhook") {
    await service.handle(w.event, w.delivery, w.payload);
    return;
  }
  if (w.kind === "summary") {
    const { repositoryId, runId, runAttempt, runnerName, receiptsUrl, summary } = w;
    await service.receiveSummary({ repositoryId, runId, runAttempt, runnerName, receiptsUrl, summary });
    return;
  }
  throw new Error(`unknown work kind ${(w as { kind?: unknown }).kind}`);
}

/** Checks a Work read back from a queue (it crossed a process boundary). */
export function parseWork(v: unknown): Work {
  const o = v as Record<string, unknown> | null;
  const posInt = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x > 0;
  const isObj = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x);
  if (o?.kind === "webhook" && typeof o.event === "string" && typeof o.delivery === "string" && isObj(o.payload)) {
    return { kind: "webhook", event: o.event, delivery: o.delivery, payload: o.payload as Record<string, unknown> };
  }
  if (o?.kind === "summary" && posInt(o.repositoryId) && posInt(o.runId) && posInt(o.runAttempt) && typeof o.runnerName === "string"
    && (o.receiptsUrl === null || typeof o.receiptsUrl === "string") && isObj(o.summary)) {
    return {
      kind: "summary", repositoryId: o.repositoryId as number, runId: o.runId as number, runAttempt: o.runAttempt as number,
      runnerName: o.runnerName, receiptsUrl: o.receiptsUrl as string | null, summary: o.summary as Record<string, unknown>,
    };
  }
  throw new Error("not a work message");
}

/** Node server mode: the work runs in this process after the response; `service.idle()` waits for it. */
export class InProcessQueue implements WorkQueue {
  private readonly service: GitHubService;
  constructor(service: GitHubService) { this.service = service; }
  async enqueue(work: Work): Promise<void> {
    this.service.background(describeWork(work), () => runWork(this.service, work));
  }
}

/** A minimal JSON-lines logger for the Lambda worker and sweep (the HTTP side uses Fastify's logger). */
export function jsonLogger(level: string, write: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const order = ["debug", "info", "warn", "error"];
  const min = level === "silent" ? Infinity : Math.max(0, order.indexOf(level));
  const at = (lvl: string) => (o: object, msg?: string) => {
    if (order.indexOf(lvl) < min) return;
    write(JSON.stringify({ level: lvl, time: new Date().toISOString(), ...o, ...(msg ? { msg } : {}) }));
  };
  return { info: at("info"), warn: at("warn"), error: at("error") };
}
