import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";

/**
 * Dead letters, redriven once (audit G-1736). A work message reaches the dead-letter queue after five failed tries
 * (a database outage, a GitHub outage, a bug fixed since). Each sweep, at most every 15 minutes, puts every dead-lettered
 * WORK message back on the work queue ONE more time, marked so that it is never redriven twice. What stays in the
 * dead-letter queue is then only what failed again after its redrive, and a failed schedule call (not work): both
 * keep the alarm on for a person (docs/DEPLOY-AWS.md).
 */
export const REDRIVEN = "fenvix-redriven";

export type DeadLetter = { id: string; body: string; receipt: string; redriven: boolean };
export interface DeadLetterPort {
  receive(max: number): Promise<DeadLetter[]>;
  delete(receipt: string): Promise<void>;
}
export interface RedriveTarget { send(body: string, redriven: true): Promise<void> }

/** A queued work message (inline or claim check), as src/queue/sqs.ts writes it; anything else is not ours to resend. */
export function isWorkMessage(body: string): boolean {
  try {
    const m = JSON.parse(body) as Record<string, unknown>;
    return m?.v === 1 && (typeof m.s3Key === "string" || (typeof m.work === "object" && m.work !== null));
  } catch { return false; }
}

export async function redriveOnce(dlq: DeadLetterPort, work: RedriveTarget, max = 100): Promise<{ redriven: number; kept: number }> {
  const out = { redriven: 0, kept: 0 };
  const seen = new Set<string>();
  while (out.redriven + out.kept < max) {
    const batch = (await dlq.receive(Math.min(10, max - out.redriven - out.kept))).filter((m) => !seen.has(m.id));
    if (!batch.length) break;
    for (const m of batch) {
      seen.add(m.id);
      // Kept (it comes back after its visibility timeout): already redriven once, or not a work message.
      if (m.redriven || !isWorkMessage(m.body)) { out.kept++; continue; }
      await work.send(m.body, true);
      await dlq.delete(m.receipt);
      out.redriven++;
    }
  }
  return out;
}

export function sqsDeadLetters(client: Pick<SQSClient, "send">, dlqUrl: string, workUrl: string): { dlq: DeadLetterPort; work: RedriveTarget } {
  return {
    dlq: {
      async receive(max) {
        const r = await client.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: max, WaitTimeSeconds: 0, VisibilityTimeout: 900, MessageAttributeNames: [REDRIVEN] }));
        return (r.Messages ?? []).map((m) => ({ id: m.MessageId ?? "", body: m.Body ?? "", receipt: m.ReceiptHandle ?? "", redriven: !!m.MessageAttributes?.[REDRIVEN] }));
      },
      async delete(receipt) { await client.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: receipt })); },
    },
    work: {
      async send(body) {
        await client.send(new SendMessageCommand({ QueueUrl: workUrl, MessageBody: body, MessageAttributes: { [REDRIVEN]: { DataType: "String", StringValue: "1" } } }));
      },
    },
  };
}
