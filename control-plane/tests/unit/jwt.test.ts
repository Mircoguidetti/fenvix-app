import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";
import { JwtVerifier } from "../../src/auth/jwt.ts";

const URL_ = "https://p.supabase.invalid";
const uid = "11111111-1111-4111-8111-111111111111";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" };
  const verifier = new JwtVerifier(URL_, "unused", createLocalJWKSet({ keys: [jwk] }));
  const sign = (o: { alg?: string; iss?: string; aud?: string; exp?: string; sub?: string; key?: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"] } = {}) =>
    new SignJWT({ email: "a@b.invalid", user_metadata: { full_name: "Ann Lee", avatar_url: "https://img.invalid/a.png" } })
      .setProtectedHeader({ alg: (o.alg ?? "ES256") as "ES256", kid: "k" })
      .setIssuer(o.iss ?? `${URL_}/auth/v1`).setAudience(o.aud ?? "authenticated").setSubject(o.sub ?? uid).setIssuedAt()
      .setExpirationTime(o.exp ?? "1h").sign(o.key ?? privateKey);
  return { verifier, sign };
}

test("a valid token gives the user; claims map to name, email and avatar", async () => {
  const { verifier, sign } = await setup();
  const r = await verifier.verify(await sign());
  assert.ok(r.ok);
  assert.deepEqual({ ...r.claims, expiresAt: 0 }, { userId: uid, email: "a@b.invalid", name: "Ann Lee", avatarUrl: "https://img.invalid/a.png", expiresAt: 0 });
});

test("expired, wrong issuer, wrong audience, wrong key and bad subject are all refused", async () => {
  const { verifier, sign } = await setup();
  assert.deepEqual(await verifier.verify(await sign({ exp: "-1m" })), { ok: false, reason: "expired" });
  assert.deepEqual(await verifier.verify(await sign({ iss: "https://evil.invalid/auth/v1" })), { ok: false, reason: "invalid" });
  assert.deepEqual(await verifier.verify(await sign({ aud: "anon" })), { ok: false, reason: "invalid" });
  assert.deepEqual(await verifier.verify(await sign({ sub: "not-a-uuid" })), { ok: false, reason: "invalid" });
  const other = await generateKeyPair("ES256");
  assert.deepEqual(await verifier.verify(await sign({ key: other.privateKey })), { ok: false, reason: "invalid" });
  assert.deepEqual(await verifier.verify("not.a.jwt"), { ok: false, reason: "invalid" });
});

test("tokens signed with a shared secret (HS256) or with alg none are refused", async () => {
  const { verifier } = await setup();
  const hs = await new SignJWT({}).setProtectedHeader({ alg: "HS256", kid: "k" }).setIssuer(`${URL_}/auth/v1`).setAudience("authenticated").setSubject(uid).setExpirationTime("1h").sign(new TextEncoder().encode("s".repeat(32)));
  assert.equal((await verifier.verify(hs)).ok, false);
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const none = `${b({ alg: "none", typ: "JWT" })}.${b({ iss: `${URL_}/auth/v1`, aud: "authenticated", sub: uid, exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
  assert.equal((await verifier.verify(none)).ok, false);
});
