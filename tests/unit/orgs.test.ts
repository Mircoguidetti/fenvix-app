// Unit tests for the organization rules the dashboard uses to explain and hide things: npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import { canManage, memberActions, orgNameProblem, type Member } from "../../src/data/orgs.ts";

test("organization names: 2 to 64 characters after trimming, one line, markup allowed as text", () => {
  for (const ok of ["ab", "  Acme Labs  ", "<script>alert(1)</script>", "🚀".repeat(64), "Ünïcödé & Co."]) assert.equal(orgNameProblem(ok), null, ok);
  for (const bad of ["", "   ", "a", "a".repeat(65), "x".repeat(5000), "🚀".repeat(65), "a\nb", "a\u202eb"]) assert.notEqual(orgNameProblem(bad), null, JSON.stringify(bad).slice(0, 20));
});

test("only owner and admin manage", () => {
  assert.equal(canManage("owner"), true);
  assert.equal(canManage("admin"), true);
  assert.equal(canManage("member"), false);
  assert.equal(canManage(null), false);
});

test("what each role is offered for another member", () => {
  const m = (role: Member["role"], you = false): Member => ({ userId: "u", name: "n", email: "e", role, joinedAt: null, you });
  assert.deepEqual(memberActions("owner", m("admin")), { roles: ["owner", "admin", "member"], remove: true });
  assert.deepEqual(memberActions("owner", m("owner", true)), { roles: [], remove: false });
  assert.deepEqual(memberActions("admin", m("member")), { roles: [], remove: true });
  assert.deepEqual(memberActions("admin", m("admin")), { roles: [], remove: false });
  assert.deepEqual(memberActions("admin", m("owner")), { roles: [], remove: false });
  assert.deepEqual(memberActions("member", m("member")), { roles: [], remove: false });
});
