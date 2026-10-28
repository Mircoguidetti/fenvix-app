// Unit tests for the Data tab's pure parts, and a guard that no code renders HTML from data:
//   npm run test:unit
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { describe, idSummary, jsonError, summary } from "../../src/lib/ejson.ts";

test("Extended JSON values are described with their type, as plain text", () => {
  assert.deepEqual(describe({ $oid: "65f1a2b3c4d5e6f708192a3b" }), { kind: "scalar", text: 'ObjectId("65f1a2b3c4d5e6f708192a3b")', type: "objectId" });
  assert.deepEqual(describe({ $date: { $numberLong: "0" } }), { kind: "scalar", text: 'ISODate("1970-01-01T00:00:00.000Z")', type: "date" });
  assert.equal(describe({ $numberInt: "5" }).type, "int32");
  assert.equal(describe({ $numberLong: "9007199254740993" }).kind === "scalar" && (describe({ $numberLong: "9007199254740993" }) as { text: string }).text, "9007199254740993");
  assert.equal(describe({ $numberDecimal: "9.99" }).type, "decimal128");
  assert.equal((describe({ $binary: { base64: "Ej5FZ+ibEtOkVkJmFBdAAA==", subType: "04" } }) as { text: string }).text, 'UUID("123e4567-e89b-12d3-a456-426614174000")');
  assert.equal((describe({ $regularExpression: { pattern: "^a", options: "i" } }) as { text: string }).text, "/^a/i");
  assert.equal(describe({ a: 1 }).kind, "object");
  assert.equal(describe([1, 2]).kind, "array");
  // A string is shown quoted, character for character: markup stays text.
  assert.equal((describe("<script>alert(1)</script>") as { text: string }).text, '"<script>alert(1)</script>"');
  // An object that only looks like a wrapper (two keys) stays an object.
  assert.equal(describe({ $oid: "x", other: 1 }).kind, "object");
});

test("summaries are short and ids are readable", () => {
  assert.equal(summary({ a: 1, b: 2 }), "{ 2 fields }");
  assert.equal(summary([1]), "[ 1 item ]");
  assert.equal(summary("x".repeat(200), 10).length, 10);
  assert.equal(idSummary('{"$oid":"65f1a2b3c4d5e6f708192a3b"}'), 'ObjectId("65f1a2b3c4d5e6f708192a3b")');
  assert.equal(idSummary('"plain"'), '"plain"');
});

test("JSON typed in a box: a clear message, objects only", () => {
  assert.equal(jsonError("", "The filter"), null);
  assert.equal(jsonError('{"a": 1}', "The filter"), null);
  assert.match(jsonError("{a:", "The filter")!, /^The filter is not valid JSON/);
  assert.match(jsonError("[1]", "The filter")!, /must be a JSON object/);
});

test("no source file renders HTML from a string (no innerHTML, dangerouslySetInnerHTML, insertAdjacentHTML, document.write, eval)", () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?)$/.test(f)) files.push(p);
    }
  };
  walk(new URL("../../src", import.meta.url).pathname);
  assert.ok(files.length > 20);
  const bad = files.filter((f) => /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(readFileSync(f, "utf8")));
  assert.deepEqual(bad, []);
});
