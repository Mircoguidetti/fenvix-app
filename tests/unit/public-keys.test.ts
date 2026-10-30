// The public API keys (fvx_) of the API keys page: what is read from the API, what is sent, and what a person reads.
//   npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPIRY_OPTIONS, NAME_MAX, curlExample, expiresAtFor, keyErrorMessage, keyStatus, mapCreatedKey, mapPublicKey, mapPublicKeyPage, nameProblem, openApiUrl,
} from "../../src/data/public-keys.ts";
import { ExplorerError } from "../../src/data/explorer.ts";

const NOW = new Date("2026-10-30T12:00:00Z");

// As viewKey in control-plane/src/services/apikeys.ts sends it.
const wire = (over: Record<string, unknown> = {}) => ({
  id: "0b6f2c1e-7a4d-4e1b-9c55-1f2e3d4c5b01", name: "ci deploys", role: "read_only", prefix: "fvx_Qm3xT8aL", status: "active",
  createdAt: "2026-10-01T09:00:00.000Z", lastUsedAt: null, expiresAt: "2027-06-30T00:00:00.000Z", revokedAt: null, ...over,
});

test("a key keeps the API's field names and values", () => {
  assert.deepEqual(mapPublicKey(wire({ lastUsedAt: "2026-10-29T08:00:00.000Z" }), NOW), {
    id: "0b6f2c1e-7a4d-4e1b-9c55-1f2e3d4c5b01", name: "ci deploys", role: "read_only", prefix: "fvx_Qm3xT8aL", status: "active",
    createdAt: "2026-10-01T09:00:00.000Z", lastUsedAt: "2026-10-29T08:00:00.000Z", expiresAt: "2027-06-30T00:00:00.000Z", revokedAt: null,
  });
  assert.equal(mapPublicKey(wire({ role: "admin" }), NOW).role, "admin");
});

test("missing or odd fields become empty values, never undefined, and an unknown role is read only", () => {
  const k = mapPublicKey({ id: 5, role: "owner", expiresAt: "", lastUsedAt: 0 }, NOW);
  assert.equal(k.id, "");
  assert.equal(k.name, "");
  assert.equal(k.role, "read_only");
  assert.equal(k.expiresAt, null);
  assert.equal(k.lastUsedAt, null);
  assert.equal(k.status, "active");
  assert.equal(mapPublicKey(null, NOW).prefix, "");
});

test("status: revoked wins, then a passed expiry, then what the API said", () => {
  assert.equal(keyStatus({ revokedAt: null, expiresAt: null }, NOW), "active");
  assert.equal(keyStatus({ revokedAt: null, expiresAt: "2026-11-01T00:00:00Z" }, NOW), "active");
  assert.equal(keyStatus({ revokedAt: null, expiresAt: "2026-10-30T12:00:00Z" }, NOW), "expired", "expired at exactly now, as on the API");
  assert.equal(keyStatus({ revokedAt: null, expiresAt: "2026-10-01T00:00:00Z" }, NOW), "expired");
  assert.equal(keyStatus({ revokedAt: "2026-10-02T00:00:00Z", expiresAt: "2026-10-01T00:00:00Z" }, NOW), "revoked");
  assert.equal(keyStatus({ revokedAt: null, expiresAt: null, status: "expired" }, NOW), "expired", "the API's word is kept when the dates say nothing");
  assert.equal(keyStatus({ revokedAt: null, expiresAt: null, status: "revoked" }, NOW), "revoked");
  // A key that expired since the API answered.
  assert.equal(mapPublicKey(wire({ status: "active", expiresAt: "2026-10-30T11:00:00Z" }), NOW).status, "expired");
});

test("a page keeps its items and its cursor; the last page has none", () => {
  const p = mapPublicKeyPage({ items: [wire(), wire({ id: "2", status: "revoked", revokedAt: "2026-10-20T00:00:00Z" })], nextCursor: "abc" });
  assert.equal(p.items.length, 2);
  assert.equal(p.items[1].status, "revoked");
  assert.equal(p.nextCursor, "abc");
  assert.deepEqual(mapPublicKeyPage({ items: [], nextCursor: null }), { items: [], nextCursor: null });
  assert.deepEqual(mapPublicKeyPage(null), { items: [], nextCursor: null });
});

test("a created key carries its token, once", () => {
  const token = `fvx_${"a".repeat(43)}`;
  const c = mapCreatedKey({ key: wire(), token });
  assert.equal(c.token, token);
  assert.equal(c.key.prefix, "fvx_Qm3xT8aL");
});

test("expiry choices: never is null, the others are whole days from now", () => {
  assert.deepEqual(EXPIRY_OPTIONS.map((o) => o.value), ["never", "30", "90", "365"]);
  assert.equal(expiresAtFor("never", NOW), null);
  assert.equal(expiresAtFor("30", NOW), "2026-11-29T12:00:00.000Z");
  assert.equal(expiresAtFor("90", NOW), "2027-01-28T12:00:00.000Z");
  assert.equal(expiresAtFor("365", NOW), "2027-10-30T12:00:00.000Z");
  // Inside the API's window: more than a minute ahead and at most 3 years.
  for (const o of EXPIRY_OPTIONS) {
    const at = expiresAtFor(o.value, NOW);
    if (at) assert.ok(new Date(at).getTime() - NOW.getTime() > 60_000 && new Date(at).getTime() - NOW.getTime() <= 3 * 365 * 86_400_000);
  }
});

test("names follow the API's rule: 1 to 60 characters, one line", () => {
  assert.equal(nameProblem("ci deploys"), null);
  assert.equal(nameProblem("  x  "), null);
  assert.match(nameProblem("   ") ?? "", /Enter a name/);
  assert.equal(nameProblem("a".repeat(NAME_MAX)), null);
  assert.match(nameProblem("a".repeat(NAME_MAX + 1)) ?? "", /60 characters or fewer/);
  assert.match(nameProblem("a\tb") ?? "", /one line/);
});

test("errors: the API's own message where it is clear, a plain one where it is not", () => {
  const limit = new ExplorerError("conflict", "An organization can have up to 100 active API keys. Revoke one first.", 409);
  assert.equal(keyErrorMessage(limit, "create"), "An organization can have up to 100 active API keys. Revoke one first.");
  const notAllowed = new ExplorerError("forbidden", "Only an owner or admin of this organization can create API keys.", 403);
  assert.equal(keyErrorMessage(notAllowed, "create"), notAllowed.message);
  const invalid = new ExplorerError("validation_failed", "Use 1 to 60 characters for the name, on one line.", 400, "name");
  assert.equal(keyErrorMessage(invalid, "create"), invalid.message);
  const noOrg = new ExplorerError("validation_failed", "Name the organization with the X-Fenvix-Workspace header (its id) to manage its API keys.", 400, "X-Fenvix-Workspace");
  assert.match(keyErrorMessage(noOrg, "list"), /Choose an organization/);
  const replay = new ExplorerError("conflict", "This request was already completed, and its result cannot be shown a second time.", 409);
  assert.match(keyErrorMessage(replay, "create"), /never shown twice\. Revoke the new key/);
  assert.match(keyErrorMessage(new ExplorerError("network", "Could not reach FENVIX.", 0), "create"), /If the new key appears in the list, revoke it/);
  assert.match(keyErrorMessage(new ExplorerError("not_found", "That API key does not exist.", 404), "revoke"), /no longer exists\. Reload/);
  assert.equal(keyErrorMessage(new Error("Your role in this organization is read only."), "list"), "Your role in this organization is read only.");
  assert.match(keyErrorMessage("boom", "revoke"), /Could not revoke the key/);
});

test("the example reads the key from an environment variable and never holds one", () => {
  const ex = curlExample("https://api.example.test/v1");
  assert.match(ex, /^export FENVIX_API=https:\/\/api\.example\.test\/v1\/public$/m);
  assert.match(ex, /Authorization: Bearer \$FENVIX_KEY/);
  assert.ok(!/fvx_[A-Za-z0-9_-]{8,}/.test(ex), "the example holds something that looks like a key");
  assert.equal(openApiUrl("https://api.example.test/v1"), "https://api.example.test/v1/openapi.json");
});
