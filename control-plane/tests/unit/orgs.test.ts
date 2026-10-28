import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../../src/errors.ts";
import { loadJson, parseLimits } from "../../src/limits.ts";
import { hashToken, parseOrgName } from "../../src/services/orgs.ts";

const L = parseLimits(loadJson(new URL("../../config/limits.json", import.meta.url).pathname));
const s = { cfg: { limits: L } } as Parameters<typeof parseOrgName>[1];
const bad = (v: unknown) => assert.throws(() => parseOrgName(v, s), (e: unknown) => e instanceof ApiError && e.code === "validation_failed" && e.field === "name");

test("organization limits: 2 to 64 characters, 50 members, 20 invitations a day, 7 days", () => {
  assert.equal(L.organizationNameMinLength, 2);
  assert.equal(L.organizationNameMaxLength, 64);
  assert.equal(L.maxMembersPerOrganization, 50);
  assert.equal(L.invitationsPerOrganizationPerDay, 20);
  assert.equal(L.invitationTtlDays, 7);
  // A limits file written before organizations gets the same values.
  const old = parseLimits({ ...loadJson(new URL("../../config/limits.json", import.meta.url).pathname) as object, maxMembersPerOrganization: undefined, invitationTtlDays: undefined });
  assert.equal(old.maxMembersPerOrganization, 50);
  assert.equal(old.invitationTtlDays, 7);
});

test("organization names: trimmed plain text, counted in characters, markup kept as text", () => {
  assert.equal(parseOrgName("  Acme Labs  ", s), "Acme Labs");
  assert.equal(parseOrgName("<script>alert(1)</script>", s), "<script>alert(1)</script>");
  assert.equal(parseOrgName("Ünïcödé & Co. 👩‍💻", s), "Ünïcödé & Co. 👩‍💻");
  assert.equal(parseOrgName("ab", s), "ab");
  assert.equal(parseOrgName("🚀".repeat(64), s), "🚀".repeat(64));
  for (const v of ["", " ", "a", "   b   ", "a".repeat(65), "🚀".repeat(65), "x".repeat(5000), "a\nb", "a\tb", "a\u0000b", "a‮b", "a b", 1, null, undefined, ["ab"], { a: 1 }]) bad(v);
});

test("invitation tokens are stored as SHA-256 hex", () => {
  assert.equal(hashToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
