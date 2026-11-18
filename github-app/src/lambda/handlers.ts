import type { App, Core } from "../app.ts";
import { readMessage, type BlobPort } from "../queue/sqs.ts";
import type { Logger } from "../service.ts";
import { describeWork, runWork } from "../work.ts";
import { invoke, type HttpApiEvent, type HttpApiResult } from "./apigw.ts";

/** The parts of an SQS event the worker reads. */
export interface SqsEvent { Records: { messageId: string; body: string; attributes?: { ApproximateReceiveCount?: string } }[] }
export interface SqsBatchResponse { batchItemFailures: { itemIdentifier: string }[] }

type WorkerCore = Pick<Core, "service"> & { log: Logger; blobs: BlobPort | null };

/**
 * HTTP: API Gateway → Fastify. Every route answers before the function returns; webhooks and runner summaries are
 * checked, queued, and answered 202 (nothing runs after the response).
 */
export function makeHttpHandler(getApp: () => Promise<App>) {
  return async (event: HttpApiEvent): Promise<HttpApiResult> => {
    const app = await getApp();
    return invoke(app.fastify, event);
  };
}

/**
 * Worker: one SQS batch. A message that failed is reported alone (ReportBatchItemFailures) and comes back after the
 * visibility timeout; after maxReceiveCount tries it goes to the dead-letter queue.
 */
export function makeWorkerHandler(getCore: () => Promise<WorkerCore>) {
  return async (event: SqsEvent): Promise<SqsBatchResponse> => {
    const { service, log, blobs } = await getCore();
    const batchItemFailures: { itemIdentifier: string }[] = [];
    for (const r of event.Records) {
      let what = "unreadable message";
      try {
        const { work, s3Key } = await readMessage(r.body, blobs);
        what = describeWork(work);
        await runWork(service, work);
        if (s3Key && blobs) await blobs.delete(s3Key).catch((e: unknown) => log.warn({ key: s3Key, err: e instanceof Error ? e.message : String(e) }, "could not delete the overflow object"));
        log.info({ work: what, messageId: r.messageId }, "work done");
      } catch (e) {
        log.error({ work: what, messageId: r.messageId, receiveCount: r.attributes?.ApproximateReceiveCount, err: e instanceof Error ? e.message : String(e) }, "work failed");
        batchItemFailures.push({ itemIdentifier: r.messageId });
      }
    }
    return { batchItemFailures };
  };
}

/** Sweep (EventBridge schedule): completed jobs whose summary never came are published after SUMMARY_WAIT_SECONDS. */
export function makeSweepHandler(getCore: () => Promise<WorkerCore>) {
  return async (): Promise<{ due: number }> => {
    const { service, log } = await getCore();
    const due = await service.sweep();
    if (due) log.info({ due }, "sweep: jobs published without a summary (or retried)");
    return { due };
  };
}
