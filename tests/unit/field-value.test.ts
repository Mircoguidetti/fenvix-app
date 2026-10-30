// The "Add field" form: what each type becomes in canonical Extended JSON, and what is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldNameProblem, fieldTypeOf, textOf, toEjson, typeLabel } from "../../src/lib/fieldValue.ts";
import { buildFilter, conditionProblem, filterText, parseFilter } from "../../src/lib/queryBuilder.ts";

const ok = (type: Parameters<typeof toEjson>[0], text: string) => {
  const r = toEjson(type, text);
  assert.ok(r.ok, `${type} ${text}: ${r.ok ? "" : r.error}`);
  return r.ok ? r.value : null;
};
const refused = (type: Parameters<typeof toEjson>[0], text: string) => assert.equal(toEjson(type, text).ok, false, `${type} ${text} should be refused`);

test("numbers become int, long or double in canonical form", () => {
  assert.deepEqual(ok("Number", "42"), { $numberInt: "42" });
  assert.deepEqual(ok("Number", "-2147483648"), { $numberInt: "-2147483648" });
  assert.deepEqual(ok("Number", "2147483648"), { $numberLong: "2147483648" });
  assert.deepEqual(ok("Number", "42.5"), { $numberDouble: "42.5" });
  assert.deepEqual(ok("Number", "1e3"), { $numberDouble: "1000" });
  for (const t of ["", "abc", "1,5", "NaN", "Infinity", "9007199254740993", "1e999"]) refused("Number", t);
});

test("boolean, null and string", () => {
  assert.equal(ok("Boolean", "true"), true);
  assert.equal(ok("Boolean", " False "), false);
  refused("Boolean", "yes");
  assert.equal(ok("Null", "anything"), null);
  assert.equal(ok("String", "  spaces kept  "), "  spaces kept  ");
  assert.equal(ok("String", ""), "");
});

test("dates are read as UTC unless they say otherwise", () => {
  assert.deepEqual(ok("Date", "2026-10-30T17:48:12Z"), { $date: { $numberLong: String(Date.UTC(2026, 9, 30, 17, 48, 12)) } });
  assert.deepEqual(ok("Date", "2026-10-30"), { $date: { $numberLong: String(Date.UTC(2026, 9, 30)) } });
  assert.deepEqual(ok("Date", "2026-10-30T18:48:12+01:00"), { $date: { $numberLong: String(Date.UTC(2026, 9, 30, 17, 48, 12)) } });
  assert.deepEqual(ok("Date", "2026-10-30T17:48"), { $date: { $numberLong: String(Date.UTC(2026, 9, 30, 17, 48)) } });
  for (const t of ["", "yesterday", "2026-13-40"]) refused("Date", t);
});

test("object ids, arrays and objects", () => {
  assert.deepEqual(ok("ObjectId", "6AE4C8D2269F379558BAA0B7"), { $oid: "6ae4c8d2269f379558baa0b7" });
  for (const t of ["", "6ae4c8d2", "zzzzzzzzzzzzzzzzzzzzzzzz"]) refused("ObjectId", t);
  assert.deepEqual(ok("Array", '[1, "a"]'), [1, "a"]);
  refused("Array", "{}");
  refused("Array", "[1,");
  assert.deepEqual(ok("Object", '{"a": 1}'), { a: 1 });
  refused("Object", "[]");
});

test("field names", () => {
  assert.equal(fieldNameProblem("total"), null);
  assert.equal(fieldNameProblem("created_at"), null);
  for (const n of ["", "$set", "a.b"]) assert.ok(fieldNameProblem(n));
});

test("a stored value goes back to its form type and text", () => {
  assert.equal(fieldTypeOf({ $numberInt: "5" }), "Number");
  assert.equal(fieldTypeOf({ $oid: "6ae4c8d2269f379558baa0b7" }), "ObjectId");
  assert.equal(fieldTypeOf({ $date: { $numberLong: "0" } }), "Date");
  assert.equal(fieldTypeOf({ $numberDecimal: "1.5" }), null);
  assert.equal(typeLabel(true), "boolean");
  assert.equal(textOf("hello"), "hello");
  assert.equal(textOf({ $date: { $numberLong: "0" } }), "1970-01-01T00:00:00.000Z");
  assert.equal(textOf({ $oid: "6ae4c8d2269f379558baa0b7" }), "6ae4c8d2269f379558baa0b7");
  // What the form shows is what it stores again.
  for (const v of [{ $numberInt: "5" }, { $numberDouble: "42.5" }, { $date: { $numberLong: "1793382492000" } }, true, "x", null, [1, 2], { a: 1 }]) {
    const t = fieldTypeOf(v)!;
    const back = toEjson(t, textOf(v));
    assert.ok(back.ok, `${JSON.stringify(v)}`);
  }
});

test("the query builder writes only operators the engine accepts", () => {
  assert.deepEqual(buildFilter([{ field: "status", op: "$eq", value: '"paid"' }], "all"), { status: { $eq: "paid" } });
  assert.deepEqual(buildFilter([{ field: "status", op: "$eq", value: "paid" }, { field: "total", op: "$gt", value: "10" }], "all"), { $and: [{ status: { $eq: "paid" } }, { total: { $gt: 10 } }] });
  assert.deepEqual(buildFilter([{ field: "a", op: "$eq", value: "1" }, { field: "b", op: "$lte", value: "2" }], "any"), { $or: [{ a: { $eq: 1 } }, { b: { $lte: 2 } }] });
  assert.deepEqual(buildFilter([{ field: "a", op: "$in", value: "1, 2, x" }], "all"), { a: { $in: [1, 2, "x"] } });
  assert.deepEqual(buildFilter([{ field: "a", op: "$notexists", value: "" }], "all"), { a: { $exists: false } });
  assert.deepEqual(buildFilter([{ field: "a", op: "$regex", value: "^ab" }], "all"), { a: { $regex: "^ab" } });
  assert.deepEqual(buildFilter([], "all"), {});
  const allowed = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$and", "$or", "$not", "$exists", "$regex"]);
  const used = (o: unknown): string[] => (typeof o === "object" && o ? Object.entries(o).flatMap(([k, v]) => [...(k.startsWith("$") ? [k] : []), ...used(v)]) : []);
  const all = ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$exists", "$notexists", "$regex"] as const;
  for (const op of all) for (const k of used(buildFilter([{ field: "f", op, value: "1" }], "all"))) assert.ok(allowed.has(k), `${op} writes ${k}`);
});

test("rows are checked, and a filter in JSON comes back as rows when it can", () => {
  assert.ok(conditionProblem({ field: "", op: "$eq", value: "1" }));
  assert.ok(conditionProblem({ field: "a", op: "$eq", value: "" }));
  assert.ok(conditionProblem({ field: "a", op: "$regex", value: "(" }));
  assert.equal(conditionProblem({ field: "a", op: "$exists", value: "" }), null);
  const rows = [{ field: "status", op: "$eq" as const, value: '"paid"' }, { field: "total", op: "$gt" as const, value: "10" }];
  assert.deepEqual(parseFilter(filterText(rows, "all")), { conditions: rows, match: "all" });
  assert.deepEqual(parseFilter(filterText(rows, "any"))?.match, "any");
  assert.deepEqual(parseFilter('{"status":"paid"}'), { conditions: [{ field: "status", op: "$eq", value: '"paid"' }], match: "all" });
  assert.equal(parseFilter('{"$and":[{"$or":[{"a":1}]}]}'), null);
  assert.equal(parseFilter("{not json"), null);
  assert.deepEqual(parseFilter(""), { conditions: [], match: "all" });
});
