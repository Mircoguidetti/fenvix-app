import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { parseWork, type Work, type WorkQueue } from "../work.ts";

/**
 * The hand-off on AWS: the HTTP Lambda sends the checked work to SQS and answers 202; the worker Lambda runs it.
 *
 * An SQS message holds at most 1 MiB, a webhook up to 25 MB (an installation on "All repositories" lists every
 * repository; API Gateway and Lambda cap a request at 6 MB before that). Work larger than `maxInlineBytes` is put in
 * the overflow S3 bucket and the message carries only its key ("claim check"); the worker reads it back and deletes
 * it after success; a lifecycle rule deletes what is left after a few days.
 */
export type Message = { v: 1; work: Work } | { v: 1; s3Key: string };

export interface QueuePort { send(body: string): Promise<void> }
export interface BlobPort {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string>;
  delete(key: string): Promise<void>;
}

/** Below SQS's 1 MiB message limit, with room for the envelope and attributes. */
export const DEFAULT_MAX_INLINE_BYTES = 200 * 1024;

export class SqsWorkQueue implements WorkQueue {
  private readonly queue: QueuePort;
  private readonly blobs: BlobPort | null;
  private readonly maxInlineBytes: number;
  private readonly now: () => Date;

  constructor(o: { queue: QueuePort; blobs: BlobPort | null; maxInlineBytes?: number; now?: () => Date }) {
    this.queue = o.queue; this.blobs = o.blobs; this.maxInlineBytes = o.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES; this.now = o.now ?? (() => new Date());
  }

  async enqueue(work: Work): Promise<void> {
    const inline = JSON.stringify({ v: 1, work } satisfies Message);
    if (Buffer.byteLength(inline) <= this.maxInlineBytes) return this.queue.send(inline);
    if (!this.blobs) throw new Error(`work of ${Buffer.byteLength(inline)} bytes is larger than a queue message and no overflow bucket is set`);
    const key = `work/${this.now().toISOString().slice(0, 10)}/${randomUUID()}.json`;
    await this.blobs.put(key, JSON.stringify(work));
    await this.queue.send(JSON.stringify({ v: 1, s3Key: key } satisfies Message));
  }
}

/** Reads one queue message back into its work (from the overflow bucket if needed). */
export async function readMessage(body: string, blobs: BlobPort | null): Promise<{ work: Work; s3Key: string | null }> {
  const m = JSON.parse(body) as Partial<{ v: number; work: unknown; s3Key: unknown }>;
  if (m.v !== 1) throw new Error("unknown message version");
  if (typeof m.s3Key === "string") {
    if (!/^work\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.json$/.test(m.s3Key)) throw new Error("bad overflow key");
    if (!blobs) throw new Error("an overflow message, and no overflow bucket is set");
    return { work: parseWork(JSON.parse(await blobs.get(m.s3Key))), s3Key: m.s3Key };
  }
  return { work: parseWork(m.work), s3Key: null };
}

// ---------------------------------------------------------------- the AWS SDK behind the two ports

export function sqsPort(client: Pick<SQSClient, "send">, queueUrl: string): QueuePort {
  return { async send(body) { await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body })); } };
}

export function s3Port(client: Pick<S3Client, "send">, bucket: string): BlobPort {
  return {
    async put(key, body) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json", ServerSideEncryption: "AES256" }));
    },
    async get(key) {
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!r.Body) throw new Error(`overflow object ${key} has no body`);
      return r.Body.transformToString("utf8");
    },
    async delete(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
  };
}
