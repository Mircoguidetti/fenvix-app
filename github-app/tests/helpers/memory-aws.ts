import type { BlobPort } from "../../src/queue/sqs.ts";

/** The overflow bucket in memory. */
export class MemoryBlobs implements BlobPort {
  readonly objects = new Map<string, string>();
  async put(key: string, body: string) { this.objects.set(key, body); }
  async get(key: string) { const v = this.objects.get(key); if (v === undefined) throw new Error("NoSuchKey"); return v; }
  async delete(key: string) { this.objects.delete(key); }
}
