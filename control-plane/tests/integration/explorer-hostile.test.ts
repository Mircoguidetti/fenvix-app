import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type Fixture, type Harness, json, startHarness } from "../helpers/harness.ts";
import { dataTarget } from "../../src/engine/data.ts";

/**
 * Hostile payloads over HTTP: forbidden operators, filters that are too deep or too big, huge bodies, strange
 * collection names and ids, prototype pollution, and ids of other workspaces seen by a read-only key. Each one must
 * be a clean 4xx, must not reach the engine (when the input is refused), and must not change any data.
 */
let h: Harness;
let o: Fixture;
let db = "";
const enc = encodeURIComponent;
const cookie = { origin: "https://app.fenvix.test" };
const docs = (c = "c") => `/databases/${db}/data/collections/${c}/documents`;
const engineCalls = () => Object.values(h.data.calls).reduce((n, x) => n + x, 0);

before(async () => {
  h = await startHarness({ RATE_LIMIT_PER_MINUTE: "100000", DATA_RATE_LIMIT_PER_MINUTE: "100000", DATA_WRITE_RATE_LIMIT_PER_MINUTE: "100000" });
  o = await h.user("Mallory");
  db = json(await h.as(o).post("/databases", { name: "hostile-db", region: "eu-central-1" }, cookie)).id;
  h.data.seed(dataTarget({ id: db, region: "eu-central-1" }), "c", [{ _id: 1, a: 1 }]);
});
after(async () => { await h.close(); });

/** The request is refused with `status`, the body is a clean error, and the engine was not called. */
async function refusedBeforeEngine(send: () => Promise<{ statusCode: number; body: string }>, status = 400) {
  const before = engineCalls();
  const res = await send();
  assert.equal(res.statusCode, status, res.body);
  const body = json(res);
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.ok(!/stack|Error:|at \/|node_modules/.test(res.body), res.body);
  assert.equal(engineCalls(), before, "the engine was called for a refused request");
  return body.error as { code: string; message: string; field?: string };
}

describe("filters", () => {
  const filters: [string, unknown][] = [
    ["$where", { $where: "while(true){}" }],
    ["$function", { a: { $function: { body: "function(){return true}", args: [], lang: "js" } } }],
    ["$accumulator", { a: { $accumulator: {} } }],
    ["$expr", { $expr: { $eq: ["$a", "$b"] } }],
    ["$lookup", { $lookup: { from: "users" } }],
    ["$out", { $out: "stolen" }],
    ["$merge", { $merge: { into: "x" } }],
    ["$where inside $or", { $or: [{ a: 1 }, { $where: "1" }] }],
    ["$where inside $not", { a: { $not: { $where: "1" } } }],
    ["$where as a nested value", { a: { b: { $where: "1" } } }],
    ["$elemMatch", { a: { $elemMatch: { $where: "1" } } }],
    ["$text", { $text: { $search: "x" } }],
    ["$jsonSchema", { $jsonSchema: {} }],
    ["$regex with x option", { a: { $regex: "a", $options: "x" } }],
    ["$regex too long", { a: { $regex: "(a+)+".repeat(60) } }],
    ["$code value", { a: { $code: "function(){}" } }],
    ["DBRef", { a: { $ref: "users", $id: 1 } }],
    ["__proto__", JSON.parse('{"__proto__": {"isAdmin": true}}')],
  ];
  for (const [name, f] of filters) {
    test(`refused: ${name}`, async () => {
      const err = await refusedBeforeEngine(() => h.as(o).get(`${docs()}?filter=${enc(JSON.stringify(f))}`));
      assert.equal(err.code, "validation_failed");
      assert.equal(err.field, "filter");
    });
  }

  test("refused: too deep, too many keys, too big, not JSON, an array, a repeated parameter", async () => {
    let deep: unknown = { a: 1 };
    for (let i = 0; i < 20; i++) deep = { $and: [deep] };
    await refusedBeforeEngine(() => h.as(o).get(`${docs()}?filter=${enc(JSON.stringify(deep))}`));
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`f${i}`, i]));
    await refusedBeforeEngine(() => h.as(o).get(`${docs()}?filter=${enc(JSON.stringify(many))}`));
    await refusedBeforeEngine(() => h.as(o).get(`${docs()}?filter=${enc(JSON.stringify({ a: "x".repeat(9000) }))}`));
    await refusedBeforeEngine(() => h.as(o).get(`${docs()}?filter=${enc("{not json")}`));
    await refusedBeforeEngine(() => h.as(o).get(`${docs()}?filter=${enc("[{}]")}`));
    await refusedBeforeEngine(() => h.as(o).get(`${docs()}?filter=${enc("{}")}&filter=${enc("{}")}`));
  });

  test("refused: hostile sort and projection", async () => {
    for (const s of ['{"$natural": 1}', '{"a": {"$meta": "textScore"}}', '{"a": 5}', "[]"]) {
      await refusedBeforeEngine(() => h.as(o).get(`${docs()}?sort=${enc(s)}`));
    }
    for (const p of ['{"a": {"$function": {}}}', '{"_id": 0}', '{"a": 1, "b": 0}', '{"$where": 1}', '{"a.$": 1}']) {
      await refusedBeforeEngine(() => h.as(o).get(`${docs()}?projection=${enc(p)}`));
    }
  });

  test("Object.prototype was not polluted by anything above", () => {
    assert.equal(({} as Record<string, unknown>).isAdmin, undefined);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

describe("collection names and document ids in the URL", () => {
  const names = ["system.users", "system.js", "%24cmd", "a%00b", "..", ".hidden", "a..b", "na%C3%AFve", "a%20b", "x".repeat(121), "%2Fetc%2Fpasswd", "users%24"];
  for (const n of names) {
    test(`collection ${decodeURIComponent(n).slice(0, 30)} is refused`, async () => {
      const before = engineCalls();
      const res = await h.as(o).get(`/databases/${db}/data/collections/${n}/documents`);
      // Fastify itself answers 404 for some paths that are not routes (".." segments); either way nothing ran.
      assert.ok(res.statusCode === 400 || res.statusCode === 404, `${n}: ${res.statusCode}`);
      assert.equal(engineCalls(), before);
      const ins = await h.as(o).post(`/databases/${db}/data/collections/${n}/documents`, { document: { a: 1 } }, cookie);
      assert.ok(ins.statusCode === 400 || ins.statusCode === 404, `${n}: ${ins.statusCode}`);
      assert.equal(engineCalls(), before);
    });
  }

  test("document ids that are not one value are refused", async () => {
    for (const id of ['{"$where":"1"}', '{"$ne":null}', '{"$gt":""}', "[1,2]", "not json", '{"$regularExpression":{"pattern":".*","options":""}}', "x".repeat(2000)]) {
      await refusedBeforeEngine(() => h.as(o).get(`${docs()}/${enc(id)}`));
      await refusedBeforeEngine(() => h.as(o).del(`${docs()}/${enc(id)}?version=${"a".repeat(32)}`, cookie));
    }
  });
});

describe("bodies", () => {
  test("a body over the request limit is refused before anything runs", async () => {
    const before = engineCalls();
    const res = await h.as(o).post(docs(), { document: { blob: "x".repeat(300 * 1024) } }, cookie);
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error.message, "The request body is too large.");
    assert.equal(engineCalls(), before);
  });

  test("documents with $ fields, dotted names, NUL, prototype keys, code or refs are refused", async () => {
    const bad = [
      { $set: { a: 1 } }, { a: { $where: "1" } }, { "a.b": 1 }, { "a\u0000": 1 }, JSON.parse('{"__proto__": {"x": 1}}'),
      { a: { $code: "x" } }, { a: { $ref: "x", $id: 1 } }, { _id: [1] }, { _id: { $regularExpression: { pattern: "a", options: "" } } },
    ];
    for (const d of bad) await refusedBeforeEngine(() => h.as(o).post(docs(), { document: d }, cookie));
    for (const body of [[], "x", { doc: { a: 1 } }, { document: [] }, { document: null }]) {
      await refusedBeforeEngine(() => h.as(o).post(docs(), body, cookie));
    }
  });

  test("a document nested 40 levels deep is refused", async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { x: deep };
    await refusedBeforeEngine(() => h.as(o).post(docs(), { document: { deep } }, cookie));
  });

  test("an update cannot smuggle operators in place of a document", async () => {
    const got = json(await h.as(o).get(`${docs()}/${enc('{"$numberInt":"1"}')}`));
    await refusedBeforeEngine(() => h.as(o).put(`${docs()}/${enc(got.id)}`, { document: { $set: { a: 2 } }, version: got.version }, cookie));
    await refusedBeforeEngine(() => h.as(o).put(`${docs()}/${enc(got.id)}`, { document: { a: 2 }, version: { $ne: null } }, cookie));
    assert.deepEqual(json(await h.as(o).get(`${docs()}/${enc(got.id)}`)).document.a, { $numberInt: "1" });
  });
});

describe("ids of other workspaces with a read-only key", () => {
  test("writes are 403 whether the database is theirs, someone else's or nowhere (nothing is revealed)", async () => {
    const other = await h.user("Other");
    const otherDb = json(await h.as(other).post("/databases", { name: "other-db", region: "eu-central-1" }, cookie)).id;
    const key = await h.apiKey(o.workspaceId, "reader", "read");
    const answers = [];
    for (const target of [db, otherDb, randomUUID()]) {
      const res = await h.as(key).post(`/databases/${target}/data/collections/c/documents`, { document: { a: 1 } });
      answers.push([res.statusCode, res.body]);
    }
    assert.equal(answers[0]![0], 403);
    assert.deepEqual(answers[1], answers[0]);
    assert.deepEqual(answers[2], answers[0]);
    const reads = [];
    for (const target of [otherDb, randomUUID(), "not-a-uuid"]) {
      const res = await h.as(key).get(`/databases/${target}/data/collections`);
      reads.push([res.statusCode, res.body]);
    }
    assert.equal(reads[0]![0], 404);
    assert.deepEqual(reads[1], reads[0]);
    assert.deepEqual(reads[2], reads[0]);
  });
});
