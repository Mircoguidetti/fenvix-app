import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AuditThrottle, KnownKeys, TOKEN_RE, decodeCursor, encodeCursor, hashToken, keyStatus, newToken, parseLimit, parseNewKey } from "../../src/services/apikeys.ts";
import { ApiError } from "../../src/errors.ts";

test("tokens: fvx_ and 43 base64url characters, all different, hashed with SHA-256", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const t = newToken();
    assert.match(t, TOKEN_RE);
    assert.ok(!seen.has(t));
    seen.add(t);
  }
  const t = newToken();
  assert.equal(hashToken(t), createHash("sha256").update(t).digest("hex"));
  for (const bad of ["fvx_", "fnx_" + "a".repeat(43), "fvx_" + "a".repeat(42), "fvx_" + "a".repeat(44), "fvx_" + "a".repeat(42) + "!"]) assert.ok(!TOKEN_RE.test(bad), bad);
});

test("cursors round-trip, and anything else is a 400", () => {
  const at = "2026-10-30T12:34:56.123456Z";
  const id = "0b9f0e9e-6f4e-4c4f-9a7e-1d2c3b4a5f60";
  assert.deepEqual(decodeCursor(encodeCursor(at, id)), { at, id });
  assert.equal(decodeCursor(undefined), null);
  for (const bad of ["x", "!!", Buffer.from(`${at}|nope`).toString("base64url"), Buffer.from(`yesterday|${id}`).toString("base64url"), Buffer.from(`${at}|${id}|x`).toString("base64url"), ["a"]]) {
    assert.throws(() => decodeCursor(bad), (e: unknown) => e instanceof ApiError && e.code === "validation_failed" && e.field === "cursor");
  }
});

test("limit: 1 to 100, 20 by default", () => {
  assert.equal(parseLimit(undefined), 20);
  assert.equal(parseLimit("100"), 100);
  for (const bad of ["0", "101", "-1", "1.5", "abc", ["1"]]) assert.throws(() => parseLimit(bad), ApiError);
});

test("a new key: name, role and an optional expiry in the future; nothing else", () => {
  const now = new Date("2026-10-30T00:00:00Z");
  assert.deepEqual(parseNewKey({ name: " ci ", role: "read_only" }, now), { name: "ci", role: "read_only", expiresAt: null });
  assert.equal(parseNewKey({ name: "ci", role: "admin", expiresAt: "2027-01-01T00:00:00Z" }, now).expiresAt?.toISOString(), "2027-01-01T00:00:00.000Z");
  for (const [body, field] of [
    [{ name: "ci", role: "owner" }, "role"], [{ name: "", role: "admin" }, "name"], [{ name: "a\nb", role: "admin" }, "name"],
    [{ name: "x".repeat(61), role: "admin" }, "name"], [{ name: "ci", role: "admin", expiresAt: "2026-10-29T00:00:00Z" }, "expiresAt"],
    [{ name: "ci", role: "admin", expiresAt: "2040-01-01T00:00:00Z" }, "expiresAt"], [{ name: "ci", role: "admin", expiresAt: "soon" }, "expiresAt"],
    [{ name: "ci", role: "admin", workspaceId: "x" }, "workspaceId"],
  ] as const) {
    assert.throws(() => parseNewKey(body, now), (e: unknown) => e instanceof ApiError && e.field === field, JSON.stringify(body));
  }
});

test("status: revoked wins, then expired, else active", () => {
  const now = Date.parse("2026-10-30T00:00:00Z");
  assert.equal(keyStatus({ revoked_at: null, expires_at: null }, now), "active");
  assert.equal(keyStatus({ revoked_at: null, expires_at: new Date(now - 1) }, now), "expired");
  assert.equal(keyStatus({ revoked_at: null, expires_at: new Date(now + 1000) }, now), "active");
  assert.equal(keyStatus({ revoked_at: new Date(now - 5), expires_at: new Date(now - 1) }, now), "revoked");
});

test("audit throttle: one row per subject a minute; the next row carries how many were held back", () => {
  let now = 0;
  const t = new AuditThrottle(60_000, () => now);
  const none = async () => {};
  assert.deepEqual(t.begin("denied:k1", none), { write: true, suppressed: 0 });
  t.done("denied:k1", true);
  for (let i = 0; i < 7; i++) assert.deepEqual(t.begin("denied:k1", none), { write: false });
  assert.deepEqual(t.begin("denied:k2", none), { write: true, suppressed: 0 }, "another key has its own window");
  t.done("denied:k2", true);
  assert.deepEqual(t.begin("auth_failed:k1", none), { write: true, suppressed: 0 }, "another kind of row has its own window");
  t.done("auth_failed:k1", true);
  now = 59_999;
  assert.deepEqual(t.begin("denied:k1", none), { write: false });
  now = 60_000;
  assert.deepEqual(t.begin("denied:k1", none), { write: true, suppressed: 8 });
  t.done("denied:k1", true);
  now = 200_000;
  assert.deepEqual(t.begin("denied:k1", none), { write: true, suppressed: 0 });
});

test("audit throttle: the window opens only after a successful write; a failed write gives its count back", () => {
  let now = 0;
  const t = new AuditThrottle(60_000, () => now);
  const none = async () => {};
  assert.deepEqual(t.begin("k", none), { write: true, suppressed: 0 });
  // While the first write is in flight, refusals are held back, not written twice.
  assert.deepEqual(t.begin("k", none), { write: false });
  t.done("k", false);
  // The write failed: no window, so the next refusal writes, and carries the one held back.
  assert.deepEqual(t.begin("k", none), { write: true, suppressed: 1 });
  t.done("k", false);
  assert.deepEqual(t.begin("k", none), { write: true, suppressed: 1 }, "still not lost after a second failure");
  t.done("k", true);
  assert.deepEqual(t.begin("k", none), { write: false });
});

test("audit throttle: a key that goes quiet gets a summary row with the count, once its window has ended", async () => {
  let now = 0;
  const t = new AuditThrottle(60_000, () => now);
  const summaries: number[] = [];
  let failNext = false;
  const summary = async (n: number) => { if (failNext) { failNext = false; throw new Error("db down"); } summaries.push(n); };
  t.begin("k", summary);
  t.done("k", true);
  for (let i = 0; i < 5; i++) t.begin("k", summary);
  assert.equal(await t.flushDue(), 0, "nothing before the window ends");
  now = 60_000;
  failNext = true;
  assert.equal(await t.flushDue(), 0, "a failed summary write");
  assert.equal(t.heldBack("k"), 5, "keeps the count");
  assert.equal(await t.flushDue(), 1);
  assert.deepEqual(summaries, [5]);
  assert.equal(t.heldBack("k"), 0);
  // The summary opened a new window: a refusal now is held back, and a forced flush (shutdown) writes it at once.
  t.begin("k", summary);
  assert.equal(await t.flushDue(), 0);
  assert.equal(await t.flushDue(true), 1);
  assert.deepEqual(summaries, [5, 1]);
  // Nothing left: the subject is forgotten after its window.
  now = 500_000;
  await t.flushDue();
  assert.deepEqual(t.begin("k", summary), { write: true, suppressed: 0 });
});

test("known keys: kept for a while, then forgotten; deleting forgets at once", () => {
  let now = 0;
  const k = new KnownKeys(1000, () => now);
  k.add("h1");
  assert.ok(k.has("h1"));
  assert.ok(!k.has("h2"));
  now = 999;
  assert.ok(k.has("h1"));
  now = 1000;
  assert.ok(!k.has("h1"));
  k.add("h1");
  k.delete("h1");
  assert.ok(!k.has("h1"));
});
