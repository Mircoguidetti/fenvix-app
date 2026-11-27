// One account, several sign-in methods (src/session/methods.ts): Supabase identities → what Settings lists, and the
// words shown when connecting or disconnecting a provider fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONNECTABLE, METHOD_NAMES, connectProblem, toMethods } from "../../src/session/methods.ts";

test("identities become methods: GitHub, Google, Email link, in that order; unknown providers left out", () => {
  const m = toMethods([
    { identity_id: "e", provider: "email", identity_data: { email: "a@b.co" } },
    { identity_id: "g", provider: "google", identity_data: { email: "a@gmail.com" } },
    { identity_id: "x", provider: "azure" },
    { identity_id: "h", provider: "github", identity_data: { email: 42 } },
  ]);
  assert.deepEqual(m, [
    { id: "h", kind: "github", email: null },
    { id: "g", kind: "google", email: "a@gmail.com" },
    { id: "e", kind: "email", email: "a@b.co" },
  ]);
  assert.deepEqual(CONNECTABLE, ["github", "google"]);
  assert.equal(METHOD_NAMES.email, "Email link");
});

test("connect problems: the provider belongs to another account, manual linking off, the last method", () => {
  assert.match(connectProblem("identity_already_exists", "Identity is already linked to another user"), /different FENVIX account/);
  assert.match(connectProblem(null, "Identity is already linked to another user"), /different FENVIX account/);
  assert.match(connectProblem("manual_linking_disabled", "Manual linking is disabled"), /allow manual linking/);
  assert.match(connectProblem("single_identity_not_deletable", null), /only sign-in method/);
  assert.equal(connectProblem(null, "  Something odd  "), "Something odd");
  assert.match(connectProblem(null, ""), /Try again/);
});
