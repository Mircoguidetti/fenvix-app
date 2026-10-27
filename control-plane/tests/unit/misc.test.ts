import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../../src/ratelimit.ts";
import { signDownload, verifyDownload } from "../../src/downloads.ts";
import { sparkFrom } from "../../src/services/usage.ts";
import { simplePdf } from "../../src/pdf.ts";
import { ApiError } from "../../src/errors.ts";
import { FakeEngine } from "../../src/engine/fake.ts";
import { EngineError } from "../../src/engine/types.ts";
import { writeAudit } from "../../src/audit.ts";

test("rate limiter: allows the limit, then 429 with Retry-After, then resets", () => {
  let t = 1_000_000;
  const rl = new RateLimiter(60_000, () => t);
  for (let i = 0; i < 3; i++) rl.hit("k", 3);
  try { rl.hit("k", 3); assert.fail("should limit"); } catch (e) {
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, "rate_limited");
    assert.equal(e.status, 429);
    assert.equal(e.headers["Retry-After"], "60");
  }
  rl.hit("other", 3);
  t += 30_000;
  assert.throws(() => rl.hit("k", 3), (e: ApiError) => e.headers["Retry-After"] === "30");
  t += 31_000;
  rl.hit("k", 3);
});

test("rate limiter: check does not count; custom window", () => {
  let t = 0;
  const rl = new RateLimiter(60_000, () => t);
  rl.hit("a", 2); rl.hit("a", 2);
  assert.throws(() => rl.check("a", 2));
  rl.check("fresh", 2);
  rl.hit("fresh", 2); rl.check("fresh", 2);
  for (let i = 0; i < 5; i++) rl.hit("hour", 5, 3_600_000);
  t += 3_599_000;
  assert.throws(() => rl.hit("hour", 5, 3_600_000));
  t += 2_000;
  rl.hit("hour", 5, 3_600_000);
});

test("download links: signed, expire, and cannot be altered", () => {
  const key = "k".repeat(40);
  const claim = { ws: "w", kind: "usage-csv" as const, p: { month: "2026-10" }, exp: Math.floor(Date.now() / 1000) + 900 };
  const token = signDownload(key, claim);
  assert.deepEqual(verifyDownload(key, token), claim);
  assert.equal(verifyDownload("x".repeat(40), token), null);
  assert.equal(verifyDownload(key, token, Date.now() + 901_000), null);
  const [body, sig] = token.split(".") as [string, string];
  const forged = Buffer.from(JSON.stringify({ ...claim, ws: "other" })).toString("base64url");
  assert.equal(verifyDownload(key, `${forged}.${sig}`), null);
  assert.equal(verifyDownload(key, `${body}.`), null);
  assert.equal(verifyDownload(key, "garbage"), null);
  assert.equal(verifyDownload(key, `${body}.${sig}.extra`), null);
});

test("sparklines: at most 12 points, oldest first", () => {
  assert.deepEqual(sparkFrom([1, 2, 3]), [1, 2, 3]);
  assert.equal(sparkFrom(Array.from({ length: 30 }, (_, i) => i)).length, 12);
  assert.deepEqual(sparkFrom([]), []);
});

test("pdf is a well-formed single page", () => {
  const pdf = simplePdf(["FENVIX", "Invoice (1) \\ ü"]);
  assert.ok(pdf.startsWith("%PDF-1.4") && pdf.trimEnd().endsWith("%%EOF"));
  assert.ok(pdf.includes("Invoice \\(1\\) \\\\ ?"));
});

test("fake engine: a repeated idempotency key does the work once", async () => {
  const e = new FakeEngine();
  const req = { id: "11111111-1111-4111-8111-111111111111", workspaceId: "w", name: "a-b", region: "eu-central-1", idempotencyKey: "op1" };
  const a = await e.createDatabase(req);
  const b = await e.createDatabase(req);
  assert.deepEqual(a, b);
  assert.equal(e.calls.create, 2);
  assert.equal(e.effects.create, 1);
  const fork = { sourceId: req.id, id: "22222222-2222-4222-8222-222222222222", workspaceId: "w", name: "a-b-fork", idempotencyKey: "op2" };
  await e.forkDatabase(fork); await e.forkDatabase(fork);
  assert.equal(e.effects.fork, 1);
  assert.equal(e.dbs.size, 2);
  await e.eraseDatabase({ id: fork.id, idempotencyKey: "op3" });
  assert.deepEqual(await e.eraseDatabase({ id: fork.id, idempotencyKey: "op3" }), { erased: true });
  assert.deepEqual(await e.eraseDatabase({ id: fork.id, idempotencyKey: "op4" }), { erased: false });
  await assert.rejects(e.restoreDatabase({ id: "nope", at: new Date().toISOString(), idempotencyKey: "x" }), (x: EngineError) => x.kind === "not_found");
  e.failNext("get", "unavailable");
  await assert.rejects(e.getDatabase(req.id), (x: EngineError) => x.kind === "unavailable");
  assert.ok(await e.getDatabase(req.id));
});

test("audit entries drop anything that looks like a secret", async () => {
  const seen: unknown[][] = [];
  const client = { query: async (_sql: string, params: unknown[]) => { seen.push(params); return { rows: [] }; } };
  await writeAudit(client as never, { workspaceId: "w", actor: { type: "user", id: "u" }, requestId: "r" }, {
    action: "x", metadata: { name: "ok", secret: "fnx_abc", nested: { token: "t", password: "p", fine: 1 }, connectionString: "mongodb://x" },
  });
  const meta = String(seen[0]![9]);
  assert.ok(!/fnx_abc|"t"|"p"|mongodb/.test(meta), meta);
  assert.ok(meta.includes('"fine":1') && meta.includes('"name":"ok"'));
});
