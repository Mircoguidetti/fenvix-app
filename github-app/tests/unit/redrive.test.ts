import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isWorkMessage, redriveOnce, type DeadLetter } from "../../src/queue/redrive.ts";

function fakeDlq(msgs: DeadLetter[]) {
  const live = [...msgs];
  const deleted: string[] = [];
  let calls = 0;
  return {
    deleted,
    port: {
      async receive(max: number) { calls++; return calls > 20 ? [] : live.slice(0, max); },
      async delete(receipt: string) { deleted.push(receipt); const i = live.findIndex((m) => m.receipt === receipt); if (i >= 0) live.splice(i, 1); },
    },
  };
}

describe("dead letters redriven once (G-1736)", () => {
  const work = JSON.stringify({ v: 1, work: { kind: "webhook", event: "workflow_job" } });
  const claim = JSON.stringify({ v: 1, s3Key: "work/2026-11-20/x.json" });

  it("a work message is sent back once, marked, and deleted from the dead-letter queue", async () => {
    const d = fakeDlq([{ id: "1", body: work, receipt: "r1", redriven: false }, { id: "2", body: claim, receipt: "r2", redriven: false }]);
    const sent: [string, boolean][] = [];
    const r = await redriveOnce(d.port, { async send(b, f) { sent.push([b, f]); } });
    assert.deepEqual(r, { redriven: 2, kept: 0 });
    assert.deepEqual(sent, [[work, true], [claim, true]]);
    assert.deepEqual(d.deleted, ["r1", "r2"]);
  });

  it("a message already redriven once, or not ours (a failed schedule call), is kept for a person", async () => {
    const d = fakeDlq([{ id: "1", body: work, receipt: "r1", redriven: true }, { id: "2", body: '{"source":"aws.scheduler"}', receipt: "r2", redriven: false }, { id: "3", body: "not json", receipt: "r3", redriven: false }]);
    const sent: string[] = [];
    const r = await redriveOnce(d.port, { async send(b) { sent.push(b); } });
    assert.deepEqual(r, { redriven: 0, kept: 3 });
    assert.deepEqual([sent, d.deleted], [[], []]);
  });

  it("stops when the same messages come back and at the per-sweep cap", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i), body: work, receipt: `r${i}`, redriven: false }));
    const r = await redriveOnce(fakeDlq(many).port, { async send() {} }, 12);
    assert.deepEqual(r, { redriven: 12, kept: 0 });
    assert.equal(isWorkMessage('{"v":2,"work":{}}'), false);
  });
});
