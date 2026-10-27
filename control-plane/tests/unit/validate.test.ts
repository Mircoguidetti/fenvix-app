import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLimits } from "../../src/limits.ts";
import { ApiError } from "../../src/errors.ts";
import {
  parseEmail, parseEnum, parseFilter, parseIds, parseInstant, parseMonth, parseName, parsePaging, parseRemoveTerms, parseTags, splitTag,
} from "../../src/validate.ts";
import { loadJson } from "../../src/limits.ts";

const L = parseLimits(loadJson(new URL("../../config/limits.json", import.meta.url).pathname));
const bad = (fn: () => unknown, field?: string) => {
  try { fn(); } catch (e) {
    assert.ok(e instanceof ApiError, String(e));
    assert.equal(e.code, "validation_failed");
    if (field) assert.equal(e.field, field);
    return;
  }
  assert.fail("expected validation_failed");
};

test("names: 3 to 48 characters, lowercase letters, numbers, dashes, trimmed and lowercased", () => {
  assert.equal(parseName("  Acme-Prod-01 ", L), "acme-prod-01");
  assert.equal(parseName("abc", L), "abc");
  assert.equal(parseName("a".repeat(48), L), "a".repeat(48));
  for (const n of ["ab", "a".repeat(49), "-abc", "abc-", "ab_c", "ab c", "", "ünï-db"]) bad(() => parseName(n, L), "name");
  bad(() => parseName(42, L), "name");
});

test("tags: key:value, lowercase, one value per key, at most 20", () => {
  assert.deepEqual(splitTag(" Customer:Acme-Labs "), { key: "customer", value: "acme-labs" });
  for (const t of ["nocolon", ":v", "k:", "-k:v", "k:-v", "k:v w", `${"a".repeat(41)}:v`, `k:${"a".repeat(41)}`]) bad(() => splitTag(t), "tags");
  assert.equal(splitTag(`${"a".repeat(40)}:${"b".repeat(40)}`).key.length, 40);
  bad(() => parseTags(["a:1", "a:2"], L), "tags");
  bad(() => parseTags(Array.from({ length: 21 }, (_, i) => `k${i}:v`), L), "tags");
  assert.equal(parseTags(Array.from({ length: 20 }, (_, i) => `k${i}:v`), L).length, 20);
  bad(() => parseTags("a:b", L));
  assert.deepEqual(parseTags(undefined, L), []);
});

test("remove terms accept key:value and bare key", () => {
  assert.deepEqual(parseRemoveTerms(["env:dev", "app"]), [{ key: "env", value: "dev" }, { key: "app", value: null }]);
  bad(() => parseRemoveTerms([]));
  bad(() => parseRemoveTerms(["!x"]));
});

test("ids: uuids only, deduplicated, between 1 and the maximum", () => {
  const a = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(parseIds([a, a.toUpperCase()], 5), [a]);
  bad(() => parseIds([], 5), "ids");
  bad(() => parseIds([a, "x"], 5), "ids");
  bad(() => parseIds(Array.from({ length: 6 }, (_, i) => `11111111-1111-4111-8111-11111111111${i}`), 5), "ids");
  bad(() => parseIds("nope", 5), "ids");
});

test("paging, enums, months, instants, emails", () => {
  assert.deepEqual(parsePaging({}, L), { page: 1, pageSize: L.defaultPageSize });
  assert.deepEqual(parsePaging({ page: "3", pageSize: "200" }, L), { page: 3, pageSize: 200 });
  bad(() => parsePaging({ pageSize: "201" }, L), "pageSize");
  bad(() => parsePaging({ page: "0" }, L), "page");
  bad(() => parsePaging({ page: "x" }, L), "page");
  assert.equal(parseEnum(undefined, ["a", "b"] as const, "f", "a"), "a");
  bad(() => parseEnum("c", ["a", "b"] as const, "f"), "f");
  assert.equal(parseMonth("2026-10"), "2026-10");
  for (const m of ["2026-13", "2026-1", "26-10", "2026-10-01", 5]) bad(() => parseMonth(m), "month");
  assert.equal(parseInstant("2026-10-20T10:00:00Z", "at").toISOString(), "2026-10-20T10:00:00.000Z");
  assert.equal(parseInstant("2026-10-20T10:00:00+02:00", "at").toISOString(), "2026-10-20T08:00:00.000Z");
  for (const t of ["2026-10-20", "2026-10-20T10:00:00", "yesterday", "2026-13-40T10:00:00Z", 12]) bad(() => parseInstant(t, "at"), "at");
  assert.equal(parseEmail(" You@Company.com "), "you@company.com");
  for (const e of ["you", "you@", "a b@c.de", "x@y"]) bad(() => parseEmail(e), "email");
});

test("filter: search, state, keepAwake and repeated tag terms", () => {
  const f = parseFilter({ search: "acme", state: "awake", keepAwake: "true", tag: ["customer:acme-labs", "!env", "app"] });
  assert.deepEqual(f, { search: "acme", state: "awake", keepAwake: true, tags: ["customer:acme-labs", "!env", "app"] });
  assert.deepEqual(parseFilter({ tag: "env:prod" }).tags, ["env:prod"]);
  assert.deepEqual(parseFilter({}), { tags: [] });
  bad(() => parseFilter({ state: "dead" }), "state");
  bad(() => parseFilter({ keepAwake: "maybe" }), "keepAwake");
  bad(() => parseFilter({ tag: "!" }), "tag");
  bad(() => parseFilter({ tag: "a:" }), "tags");
});
