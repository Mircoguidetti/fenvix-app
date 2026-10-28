import { test } from "node:test";
import assert from "node:assert/strict";
import { Binary, BSONRegExp, Decimal128, Double, EJSON, Int32, Long, ObjectId, Timestamp } from "bson";
import { ApiError } from "../../src/errors.ts";
import {
  LIMITS, idText, isAllowedCollection, parseCollection, parseDocument, parseDocumentId, parseFilter, parseProjection, parseSort, toCanonical,
} from "../../src/explorer/rules.ts";

const refused = (fn: () => unknown, re?: RegExp) => {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof ApiError, `not an ApiError: ${String(e)}`);
    assert.equal(e.status, 400);
    if (re) assert.match(e.message, re);
    return true;
  });
};
const f = (o: unknown) => parseFilter(JSON.stringify(o));

// ---------------------------------------------------------------- collection names

test("collection names: ordinary names pass", () => {
  for (const n of ["orders", "Orders_2024", "a", "events.daily", "user-profiles", "_tmp", "x".repeat(LIMITS.collectionNameMax)]) {
    assert.equal(parseCollection(n), n, n);
  }
});

test("collection names: system, $, NUL, dots, spaces, unicode, too long and non-strings are refused", () => {
  const bad: unknown[] = [
    "", "system.users", "System.Profile", "system.js", "orders$", "$cmd", "a\0b", "\0", ".hidden", "a..b", "a.", "with space", "tab\t",
    "naïve", "😀", "../etc", "a/b", "a\\b", "x".repeat(LIMITS.collectionNameMax + 1), undefined, null, 5, ["orders"], { $ne: 1 },
  ];
  for (const n of bad) {
    assert.equal(isAllowedCollection(n), false, JSON.stringify(n));
    refused(() => parseCollection(n));
  }
});

// ---------------------------------------------------------------- filters: what passes

test("filters: empty, equality, comparison, $in, $exists, $regex, $not, $and, $or pass", () => {
  assert.deepEqual(parseFilter(undefined), {});
  assert.deepEqual(parseFilter(""), {});
  const out = f({
    status: "active", "address.city": "Rome", age: { $gte: 18, $lt: 65 }, tag: { $in: ["a", "b"] }, x: { $nin: [1] }, gone: { $exists: false },
    name: { $regex: "^mar", $options: "i" }, score: { $not: { $gt: 5 } }, $or: [{ a: 1 }, { b: { $ne: null } }], $and: [{ c: true }],
  });
  assert.equal(out.status, "active");
  assert.ok((out.age as { $gte: unknown }).$gte instanceof Int32);
  assert.deepEqual(out.name, { $regex: "^mar", $options: "i" });
  assert.ok(Array.isArray(out.$or));
});

test("filters: Extended JSON values become BSON types", () => {
  const out = f({
    _id: { $oid: "65f1a2b3c4d5e6f708192a3b" }, at: { $gte: { $date: "2024-01-01T00:00:00Z" } }, big: { $numberLong: "9007199254740993" },
    price: { $numberDecimal: "9.99" }, u: { $uuid: "123e4567-e89b-12d3-a456-426614174000" }, d: { $numberDouble: "1.5" },
  });
  assert.ok(out._id instanceof ObjectId);
  assert.ok((out.at as { $gte: unknown }).$gte instanceof Date);
  assert.ok(out.big instanceof Long);
  assert.equal(String(out.big), "9007199254740993");
  assert.ok(out.price instanceof Decimal128);
  assert.ok(out.u instanceof Binary);
  assert.ok(out.d instanceof Double);
});

// ---------------------------------------------------------------- filters: hostile payloads

test("filters: forbidden operators are refused wherever they appear", () => {
  const ops = ["$where", "$function", "$accumulator", "$expr", "$lookup", "$out", "$merge", "$jsonSchema", "$text", "$near", "$geoWithin",
    "$elemMatch", "$size", "$type", "$mod", "$all", "$bitsAllSet", "$comment", "$nor", "$sample", "$set", "$unset", "$rename", "$search", "$eval"];
  for (const op of ops) {
    refused(() => f({ [op]: "x" }), /not allowed/);
    refused(() => f({ a: { [op]: "x" } }), /not allowed/);
    refused(() => f({ $or: [{ [op]: "x" }] }), /not allowed/);
    refused(() => f({ a: { $not: { [op]: 1 } } }), /not allowed/);
  }
  refused(() => f({ $where: "function() { while(true) {} }" }));
  refused(() => f({ $expr: { $function: { body: "return 1", args: [], lang: "js" } } }));
  refused(() => f({ a: { $eq: 1, $where: "1" } }));
});

test("filters: operators hidden in nested values, mixed objects and legacy wrappers are refused", () => {
  refused(() => f({ a: { b: { $where: "1" } } }), /start with "\$"/);
  refused(() => f({ a: { $gt: { $where: "1" } } }));
  refused(() => f({ a: { $in: [{ $where: "1" }] } }));
  refused(() => f({ a: { $gt: 1, b: 2 } }), /mix/);
  refused(() => f({ a: { $regex: "x", $options: "x" } }), /\$options/);
  refused(() => f({ a: { $regex: "x", $options: "ii" } }));
  refused(() => f({ a: { $options: "i" } }), /\$options goes with/);
  refused(() => f({ a: { $regularExpression: { pattern: "x", options: "" } } }), /\$regex/);
  refused(() => f({ a: { $ref: "users", $id: 1 } }));
  refused(() => f({ a: { $code: "function(){}" } }));
  refused(() => f({ a: { $binary: "AAAA", $type: "00" } }));
  refused(() => f({ a: { $oid: "zz" } }), /\$oid/);
  refused(() => f({ a: { $date: "yesterday" } }), /\$date/);
  refused(() => f({ a: { $numberInt: "99999999999" } }));
  refused(() => f({ a: { $not: 5 } }), /\$not takes/);
  refused(() => f({ a: { $exists: "yes" } }));
  refused(() => f({ $and: [] }));
  refused(() => f({ $or: { a: 1 } }));
});

test("filters: field paths with $, NUL, empty parts or __proto__ are refused", () => {
  refused(() => f({ "a.$where": 1 }));
  refused(() => f({ "a..b": 1 }));
  refused(() => f({ ".a": 1 }));
  refused(() => f({ "a\u0000b": 1 }), /NUL/);
  refused(() => parseFilter('{"__proto__": {"polluted": true}}'), /__proto__/);
  refused(() => parseFilter('{"a": {"__proto__": 1}}'), /__proto__/);
  refused(() => f({ ["x".repeat(LIMITS.fieldPathMax + 1)]: 1 }));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("filters: depth, number of conditions, list sizes, regex length and byte size are capped", () => {
  let deep: unknown = { leaf: 1 };
  for (let i = 0; i < LIMITS.filterMaxDepth + 2; i++) deep = { $and: [deep] };
  refused(() => f(deep), /nested too deeply/);
  let deepValue: unknown = 1;
  for (let i = 0; i < LIMITS.filterMaxDepth + 2; i++) deepValue = { x: deepValue };
  refused(() => f({ a: deepValue }), /nested too deeply/);
  refused(() => f(Object.fromEntries(Array.from({ length: LIMITS.filterMaxKeys + 1 }, (_, i) => [`k${i}`, i]))), /too many/);
  refused(() => f({ a: { $in: Array.from({ length: LIMITS.inMaxValues + 1 }, (_, i) => i) } }), /at most/);
  refused(() => f({ $or: Array.from({ length: LIMITS.logicalMaxBranches + 1 }, () => ({ a: 1 })) }));
  refused(() => f({ a: { $regex: "a".repeat(LIMITS.regexMaxLength + 1) } }), /\$regex/);
  refused(() => f({ a: "x".repeat(LIMITS.filterMaxBytes) }), /too long/);
  refused(() => f({ a: { $regex: "a\u0000" } }), /NUL/);
});

test("filters: non-JSON, non-objects and non-strings are refused", () => {
  for (const raw of ["{", "not json", "[1,2]", "5", "null", '"x"', "true"]) refused(() => parseFilter(raw));
  refused(() => parseFilter(["{}"]));
  refused(() => parseFilter({ a: 1 }));
});

// ---------------------------------------------------------------- sort and projection

test("sort: fields to 1 or -1, _id appended; anything else refused", () => {
  assert.deepEqual(parseSort(undefined), { _id: 1 });
  assert.deepEqual(parseSort('{"age": -1}'), { age: -1, _id: 1 });
  assert.deepEqual(parseSort('{"_id": -1}'), { _id: -1 });
  for (const raw of ['{"age": 2}', '{"age": "asc"}', '{"$natural": 1}', '{"a": {"$meta": "textScore"}}', "[1]", '{"__proto__": 1}',
    JSON.stringify(Object.fromEntries(Array.from({ length: LIMITS.sortMaxKeys + 1 }, (_, i) => [`k${i}`, 1])))]) {
    refused(() => parseSort(raw));
  }
});

test("projection: show or hide fields, never both, _id always shown, no operators", () => {
  assert.equal(parseProjection(undefined), undefined);
  assert.deepEqual(parseProjection('{"name": 1, "age": true}'), { name: 1, age: 1 });
  assert.deepEqual(parseProjection('{"secret": 0}'), { secret: 0 });
  assert.equal(parseProjection('{"_id": 1}'), undefined);
  for (const raw of ['{"a": 1, "b": 0}', '{"_id": 0}', '{"a": {"$slice": 1}}', '{"a": {"$elemMatch": {}}}', '{"$where": 1}', '{"a": 2}', '{"a.$": 1}', "[]"]) {
    refused(() => parseProjection(raw));
  }
});

// ---------------------------------------------------------------- documents

test("documents: every Extended JSON type survives the trip in and out", () => {
  const ejson = {
    _id: { $oid: "65f1a2b3c4d5e6f708192a3b" }, int: { $numberInt: "5" }, long: { $numberLong: "9007199254740993" }, dbl: { $numberDouble: "5.0" },
    dec: { $numberDecimal: "1234.5678" }, date: { $date: { $numberLong: "1700000000000" } }, bin: { $binary: { base64: "AQID", subType: "00" } },
    uuid: { $binary: { base64: "Ej5FZ+ibEtOkVkJmFBdAAA==", subType: "04" } }, ts: { $timestamp: { t: 1, i: 2 } }, re: { $regularExpression: { pattern: "^a", options: "i" } },
    min: { $minKey: 1 }, max: { $maxKey: 1 }, nested: { list: [{ $numberInt: "1" }, "two", null, true, { deep: { $numberInt: "3" } }] }, str: "<script>alert(1)</script>",
  };
  const { doc } = parseDocument(ejson, 1 << 20);
  assert.ok(doc.int instanceof Int32);
  assert.ok(doc.long instanceof Long);
  assert.ok(doc.dbl instanceof Double);
  assert.ok(doc.dec instanceof Decimal128);
  assert.ok(doc.date instanceof Date);
  assert.ok(doc.ts instanceof Timestamp);
  assert.ok(doc.re instanceof BSONRegExp);
  assert.deepEqual(toCanonical(doc), ejson);
});

test("documents: bare JSON numbers are typed like canonical Extended JSON (int32, int64, double)", () => {
  const { doc } = parseDocument({ a: 5, b: 3000000000, c: 1.5 }, 1 << 20);
  assert.ok(doc.a instanceof Int32);
  assert.ok(doc.b instanceof Long);
  assert.ok(doc.c instanceof Double);
});

test("documents: an _id is added first when missing, kept when given", () => {
  const a = parseDocument({ name: "x" }, 1 << 20).doc;
  assert.ok(a._id instanceof ObjectId);
  assert.deepEqual(Object.keys(a), ["_id", "name"]);
  const b = parseDocument({ name: "x", _id: "custom" }, 1 << 20).doc;
  assert.deepEqual(Object.keys(b), ["_id", "name"]);
  assert.equal(b._id, "custom");
});

test("documents: $-names, dots, NUL, __proto__, array or regex _id, depth and size are refused", () => {
  refused(() => parseDocument({ $where: "1" }, 1 << 20), /start with "\$"/);
  refused(() => parseDocument({ a: { $set: { b: 1 } } }, 1 << 20), /start with "\$"/);
  refused(() => parseDocument({ "a.b": 1 }, 1 << 20), /"\."/);
  refused(() => parseDocument({ "a\u0000": 1 }, 1 << 20), /NUL/);
  refused(() => parseDocument(JSON.parse('{"__proto__": {"admin": true}}'), 1 << 20), /__proto__/);
  refused(() => parseDocument({ _id: [1, 2] }, 1 << 20), /array/);
  refused(() => parseDocument({ _id: { $regularExpression: { pattern: "a", options: "" } } }, 1 << 20), /regular expression/);
  refused(() => parseDocument({ a: { $code: "function(){}" } }, 1 << 20));
  refused(() => parseDocument({ a: { $ref: "x", $id: 1 } }, 1 << 20));
  let deep: unknown = 1;
  for (let i = 0; i < LIMITS.documentMaxDepth + 2; i++) deep = { x: deep };
  refused(() => parseDocument({ deep }, 1 << 20), /nested too deeply/);
  refused(() => parseDocument({ big: "x".repeat(5000) }, 4096), /too large/);
  for (const bad of [null, [], "x", 5]) refused(() => parseDocument(bad, 1 << 20), /JSON object/);
});

test("document ids: canonical Extended JSON in the URL, round trip with idText", () => {
  const oid = new ObjectId();
  assert.ok((parseDocumentId(idText(oid)) as ObjectId).equals(oid));
  assert.equal(parseDocumentId('"abc"'), "abc");
  assert.ok(parseDocumentId("5") instanceof Int32);
  assert.equal(idText(new Int32(5)), '{"$numberInt":"5"}');
  for (const raw of ["", "nope", "[1]", '{"$where": "1"}', '{"$regularExpression": {"pattern": "a", "options": ""}}', "x".repeat(LIMITS.idMaxBytes + 1), undefined, 5]) {
    refused(() => parseDocumentId(raw));
  }
});

test("canonical output never loses a type (what the dashboard edits comes back the same)", () => {
  const doc = { _id: new ObjectId(), n: new Int32(1), d: new Double(1), l: Long.fromNumber(1), when: new Date(0) };
  const text = JSON.stringify(toCanonical(doc));
  const back = parseDocument(JSON.parse(text), 1 << 20).doc;
  assert.equal(JSON.stringify(EJSON.serialize(back, { relaxed: false })), text);
});
