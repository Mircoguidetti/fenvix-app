import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { GetParametersCommand } from "@aws-sdk/client-ssm";
import Fastify from "fastify";
import { buildApp, loggerOptions } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { invoke } from "../../src/lambda/apigw.ts";
import { once, refreshing } from "../../src/lambda/runtime.ts";
import { loadSecrets, parameterNames } from "../../src/lambda/secrets.ts";
import { readMessage, s3Port, SqsWorkQueue, sqsPort } from "../../src/queue/sqs.ts";
import { MemoryBlobs } from "../helpers/memory-aws.ts";
import { jsonLogger, parseWork, type Work } from "../../src/work.ts";

const webhook: Work = { kind: "webhook", event: "push", delivery: "d-1", payload: { after: "a".repeat(40) } };
const summary: Work = { kind: "summary", repositoryId: 7, runId: 9, runAttempt: 1, runnerName: "fenvix-m1", receiptsUrl: null, summary: { tests: 3 } };

describe("queue hand-off: messages", () => {
  it("small work travels inline in the message", async () => {
    const sent: string[] = [];
    const q = new SqsWorkQueue({ queue: { send: async (b) => { sent.push(b); } }, blobs: new MemoryBlobs() });
    await q.enqueue(webhook);
    await q.enqueue(summary);
    assert.equal(sent.length, 2);
    assert.deepEqual(await readMessage(sent[0]!, null), { work: webhook, s3Key: null });
    assert.deepEqual(await readMessage(sent[1]!, null), { work: summary, s3Key: null });
  });

  it("large work goes to the overflow bucket; the message carries only its key", async () => {
    const sent: string[] = [];
    const blobs = new MemoryBlobs();
    const q = new SqsWorkQueue({ queue: { send: async (b) => { sent.push(b); } }, blobs, maxInlineBytes: 100, now: () => new Date("2026-11-18T12:00:00Z") });
    const big: Work = { ...webhook, payload: { repositories: Array.from({ length: 50 }, (_, i) => ({ id: i, full_name: `acme/r${i}` })) } };
    await q.enqueue(big);
    const msg = JSON.parse(sent[0]!) as { v: number; s3Key: string };
    assert.match(msg.s3Key, /^work\/2026-11-18\/[0-9a-f-]{36}\.json$/);
    assert.ok(Buffer.byteLength(sent[0]!) < 100);
    assert.equal(blobs.objects.size, 1);
    assert.deepEqual(await readMessage(sent[0]!, blobs), { work: big, s3Key: msg.s3Key });
  });

  it("large work without an overflow bucket is refused (the HTTP side answers 503)", async () => {
    const q = new SqsWorkQueue({ queue: { send: async () => {} }, blobs: null, maxInlineBytes: 10 });
    await assert.rejects(q.enqueue(webhook), /larger than a queue message/);
  });

  it("a message is checked when read back", async () => {
    await assert.rejects(readMessage(JSON.stringify({ v: 2, work: webhook }), null), /version/);
    await assert.rejects(readMessage(JSON.stringify({ v: 1, s3Key: "../../etc/passwd" }), new MemoryBlobs()), /bad overflow key/);
    await assert.rejects(readMessage(JSON.stringify({ v: 1, work: { kind: "summary", repositoryId: -1 } }), null), /not a work message/);
    await assert.rejects(readMessage("not json", null));
    assert.throws(() => parseWork({ kind: "webhook", event: "push", delivery: "x", payload: [] }), /not a work message/);
  });

  it("the AWS SDK commands: SendMessage to the queue URL; Put/Get/Delete in the bucket, encrypted", async () => {
    const cmds: unknown[] = [];
    const client = { send: async (c: unknown) => { cmds.push(c); return { Body: { transformToString: async () => "{}" } }; } };
    await sqsPort(client as never, "https://sqs.eu-west-1.amazonaws.com/1/q").send("hello");
    const b = s3Port(client as never, "bucket-1");
    await b.put("work/k.json", "{}");
    assert.equal(await b.get("work/k.json"), "{}");
    await b.delete("work/k.json");
    assert.ok(cmds[0] instanceof SendMessageCommand);
    assert.deepEqual((cmds[0] as SendMessageCommand).input, { QueueUrl: "https://sqs.eu-west-1.amazonaws.com/1/q", MessageBody: "hello" });
    assert.ok(cmds[1] instanceof PutObjectCommand);
    assert.equal((cmds[1] as PutObjectCommand).input.ServerSideEncryption, "AES256");
    assert.ok(cmds[2] instanceof GetObjectCommand);
    assert.ok(cmds[3] instanceof DeleteObjectCommand);
  });
});

describe("secrets from SSM", () => {
  const prefix = "/fenvix/prod/github-app";
  const ssm = (values: Record<string, string>, seen: GetParametersCommand[] = []) => ({
    send: async (c: GetParametersCommand) => {
      seen.push(c);
      const names = c.input.Names ?? [];
      return { Parameters: names.filter((n) => n in values).map((n) => ({ Name: n, Value: values[n] })), InvalidParameters: names.filter((n) => !(n in values)) };
    },
  });
  const all = Object.fromEntries(["database-url", "private-key", "webhook-secret", "client-secret", "state-signing-key", "runner-token"].map((n) => [`${prefix}/${n}`, `value-of-${n}`]));

  it("the HTTP function reads every secret; the worker and the sweep only the database URL and the private key", async () => {
    assert.equal(parameterNames(prefix, "all").length, 7);
    assert.deepEqual(parameterNames(prefix, "worker"), [`${prefix}/database-url`, `${prefix}/private-key`]);
    const seen: GetParametersCommand[] = [];
    const env = await loadSecrets(ssm(all, seen) as never, prefix, "all");
    assert.equal(seen[0]!.input.WithDecryption, true);
    assert.equal(env.GITHUB_WEBHOOK_SECRET, "value-of-webhook-secret");
    assert.equal(env.RUNNER_TOKEN, "value-of-runner-token");
    assert.equal(env.RUNNER_TOKEN_PREVIOUS, undefined, "optional");
    const w = await loadSecrets(ssm(all) as never, prefix, "worker");
    assert.deepEqual(Object.keys(w).sort(), ["GITHUB_APP_DATABASE_URL", "GITHUB_APP_PRIVATE_KEY"]);
  });

  it("the per-job worker (launcher) also reads the summary signing key, never the HTTP-only secrets (R-012 F1)", async () => {
    assert.deepEqual(parameterNames(prefix, "launcher"), [`${prefix}/database-url`, `${prefix}/private-key`, `${prefix}/runner-token`]);
    const w = await loadSecrets(ssm(all) as never, prefix, "launcher");
    assert.deepEqual(Object.keys(w).sort(), ["GITHUB_APP_DATABASE_URL", "GITHUB_APP_PRIVATE_KEY", "RUNNER_TOKEN"]);
  });

  it("a missing parameter is named; no value appears in the error", async () => {
    const some = { ...all };
    delete some[`${prefix}/webhook-secret`];
    await assert.rejects(loadSecrets(ssm(some) as never, prefix, "all"), (e: Error) => e.message === `missing SSM parameters: ${prefix}/webhook-secret` && !e.message.includes("value-of"));
    await assert.rejects(loadSecrets(ssm(all) as never, "relative/path", "all"), /SSM_PREFIX/);
  });
});

describe("config surfaces", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const base = {
    GITHUB_APP_DATABASE_URL: "postgresql://fenvix_github_app@localhost/db", GITHUB_APP_ID: "123", GITHUB_APP_SLUG: "fenvix",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(), GITHUB_CLIENT_ID: "Iv1.x",
    DASHBOARD_URL: "https://console.fenvix.dev", SUPABASE_URL: "https://x.supabase.co", NODE_ENV: "production",
  };

  it("the worker surface needs no HTTP secret, and holds none", async () => {
    const c = loadConfig(base, { surface: "worker" });
    assert.equal(c.surface, "worker");
    assert.equal(c.webhookSecret, "");
    assert.deepEqual(c.runnerTokens, []);
    assert.throws(() => loadConfig(base), /RUNNER_TOKEN/, "the HTTP surface still needs them");
    await assert.rejects(buildApp({ cfg: c, logger: false }), /surface/);
  });
});

describe("API Gateway (HTTP API, payload 2.0) to Fastify", () => {
  const app = Fastify();
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.post("/echo", async (req) => ({ len: (req.body as Buffer).length, hex: (req.body as Buffer).toString("hex"), q: req.query, cookie: req.headers.cookie ?? null, ip: req.ip }));
  app.get("/go", async (_req, reply) => reply.header("set-cookie", ["a=1", "b=2"]).redirect("https://console.fenvix.dev/x?y=1", 303));
  app.get("/bin", async (_req, reply) => reply.type("application/octet-stream").send(Buffer.from([0, 255, 1])));
  const ev = (method: string, path: string, more: Partial<Parameters<typeof invoke>[1]> = {}) =>
    ({ version: "2.0", rawPath: path, rawQueryString: "", headers: {}, requestContext: { http: { method, sourceIp: "203.0.113.9" } }, ...more });

  it("keeps the exact body bytes (base64 or text), the query string, cookies and the caller's address", async () => {
    const bytes = Buffer.from('{"a":"é\\u00e9"}', "utf8");
    const r = await invoke(app, ev("POST", "/echo", { rawQueryString: "x=1&y=%20", headers: { "content-type": "application/json", "content-length": "999" }, cookies: ["s=1", "t=2"], body: bytes.toString("base64"), isBase64Encoded: true }));
    assert.equal(r.statusCode, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.hex, bytes.toString("hex"));
    assert.deepEqual(j.q, { x: "1", y: " " });
    assert.equal(j.cookie, "s=1; t=2");
    assert.equal(j.ip, "203.0.113.9");
    const t = await invoke(app, ev("POST", "/echo", { headers: { "content-type": "application/json" }, body: '{"b":"ü"}', isBase64Encoded: false }));
    assert.equal(JSON.parse(t.body).hex, Buffer.from('{"b":"ü"}', "utf8").toString("hex"));
  });

  it("returns redirects, cookies and binary bodies the way API Gateway expects", async () => {
    const r = await invoke(app, ev("GET", "/go"));
    assert.equal(r.statusCode, 303);
    assert.equal(r.headers.location, "https://console.fenvix.dev/x?y=1");
    assert.deepEqual(r.cookies, ["a=1", "b=2"]);
    const b = await invoke(app, ev("GET", "/bin"));
    assert.equal(b.isBase64Encoded, true);
    assert.deepEqual([...Buffer.from(b.body, "base64")], [0, 255, 1]);
  });
});

describe("request log (R-012 F18)", () => {
  it("never logs the query string (the OAuth code of /github/setup)", () => {
    const req = loggerOptions("info").serializers.req({ method: "GET", url: "/github/setup?code=one-time-code&state=s&installation_id=1", hostname: "h", ip: "1.2.3.4" });
    assert.deepEqual(req, { method: "GET", url: "/github/setup", hostname: "h", remoteAddress: "1.2.3.4" });
    assert.ok(!JSON.stringify(req).includes("one-time-code"));
  });
});

describe("secrets reload (R-012 F15)", () => {
  it("refreshing(): made again after the TTL, the old one closed; a failed reload keeps the old one", async () => {
    let t = 0, n = 0, fail = false;
    const closed: number[] = [];
    const get = refreshing(async () => { if (fail) throw new Error("ssm down"); const id = ++n; return { id, close: async () => { closed.push(id); } }; }, 1000, () => t);
    assert.equal((await get()).id, 1);
    t = 999; assert.equal((await get()).id, 1);
    t = 1000; assert.equal((await get()).id, 2);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(closed, [1]);
    fail = true; t = 2500;
    assert.equal((await get()).id, 2, "keeps serving with the old secrets");
    fail = false;
    assert.equal((await get()).id, 3);
  });
});

describe("small pieces", () => {
  it("once(): kept when it worked, retried when it failed", async () => {
    let n = 0;
    const get = once(async () => { n++; if (n === 1) throw new Error("cold start failed"); return n; });
    await assert.rejects(get());
    assert.equal(await get(), 2);
    assert.equal(await get(), 2);
  });

  it("jsonLogger writes one JSON line per entry, above its level", () => {
    const lines: string[] = [];
    const log = jsonLogger("warn", (l) => lines.push(l));
    log.info({ a: 1 }, "hidden");
    log.warn({ a: 2 }, "shown");
    assert.equal(lines.length, 1);
    assert.deepEqual({ ...JSON.parse(lines[0]!), time: 0 }, { level: "warn", time: 0, a: 2, msg: "shown" });
    const silent: string[] = [];
    jsonLogger("silent", (l) => silent.push(l)).error({}, "x");
    assert.equal(silent.length, 0);
  });
});
