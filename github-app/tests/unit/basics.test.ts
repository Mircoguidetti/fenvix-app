import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { runnerTokenOk, signState, verifyState } from "../../src/auth.ts";
import { loadConfig } from "../../src/config.ts";
import { appJwt } from "../../src/github/client.ts";
import { sign, verifySignature } from "../../src/github/signature.ts";

describe("webhook signature", () => {
  // GitHub's documented test vector (docs: "Validating webhook deliveries").
  it("matches GitHub's example", () => {
    const secret = "It's a Secret to Everybody";
    const body = Buffer.from("Hello, World!");
    const header = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    assert.equal(sign(secret, body), header);
    assert.equal(verifySignature(secret, body, header), true);
  });

  it("refuses a wrong, missing, SHA-1 or malformed signature", () => {
    const body = Buffer.from("{}");
    const good = sign("s3cret-s3cret-s3cret", body);
    assert.equal(verifySignature("s3cret-s3cret-s3cret", Buffer.from("{} "), good), false);
    assert.equal(verifySignature("other-secret-other", body, good), false);
    assert.equal(verifySignature("s3cret-s3cret-s3cret", body, undefined), false);
    assert.equal(verifySignature("s3cret-s3cret-s3cret", body, "sha1=" + "0".repeat(40)), false);
    assert.equal(verifySignature("s3cret-s3cret-s3cret", body, "sha256=zz"), false);
  });
});

describe("App token", () => {
  it("is an RS256 JWT issued 60 s back, valid under 10 minutes, iss = App id", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = Date.UTC(2026, 10, 18, 12, 0, 0);
    const jwt = appJwt(12345, privateKey, now);
    const [h, p, s] = jwt.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(h!, "base64url").toString()), { alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    assert.equal(payload.iss, "12345");
    assert.equal(payload.iat, now / 1000 - 60);
    assert.ok(payload.exp - payload.iat <= 600);
    assert.equal(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, "base64url")), true);
  });
});

describe("install state", () => {
  const key = "k".repeat(40);
  const ids = { workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
  it("round-trips and expires after an hour", () => {
    const now = Date.now();
    const st = signState(key, ids, now);
    assert.deepEqual({ ...verifyState(key, st, now), expiresAt: 0 }, { ...ids, expiresAt: 0 });
    assert.equal(verifyState(key, st, now + 3601_000), null);
  });
  it("refuses a state signed with another key or changed", () => {
    const st = signState(key, ids);
    assert.equal(verifyState("x".repeat(40), st), null);
    const [body, mac] = st.split(".");
    const forged = Buffer.from(JSON.stringify({ w: "33333333-3333-4333-8333-333333333333", u: ids.userId, e: 9e9 })).toString("base64url");
    assert.equal(verifyState(key, `${forged}.${mac}`), null);
    assert.equal(verifyState(key, `${body}`), null);
    assert.equal(verifyState(key, undefined), null);
  });
});

describe("runner token", () => {
  it("accepts the current and the previous token only", () => {
    const tokens = ["a".repeat(32), "b".repeat(32)];
    assert.equal(runnerTokenOk(tokens, `Bearer ${"a".repeat(32)}`), true);
    assert.equal(runnerTokenOk(tokens, `Bearer ${"b".repeat(32)}`), true);
    assert.equal(runnerTokenOk(tokens, `Bearer ${"c".repeat(32)}`), false);
    assert.equal(runnerTokenOk(tokens, undefined), false);
    assert.equal(runnerTokenOk(tokens, "a".repeat(32)), false);
  });
});

describe("config", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const base = {
    DATABASE_URL: "postgresql://fenvix_github_app@localhost/db", GITHUB_APP_ID: "123", GITHUB_APP_SLUG: "fenvix",
    GITHUB_APP_PRIVATE_KEY: pem, GITHUB_WEBHOOK_SECRET: "w".repeat(32), GITHUB_CLIENT_ID: "Iv1.abc", GITHUB_CLIENT_SECRET: "c".repeat(40),
    DASHBOARD_URL: "https://app.fenvix.dev", SUPABASE_URL: "https://x.supabase.co", STATE_SIGNING_KEY: "s".repeat(40), RUNNER_TOKEN: "r".repeat(40),
  };
  it("loads with defaults", () => {
    const c = loadConfig(base);
    assert.equal(c.runsOnLabel, "fenvix");
    assert.equal(c.apiUrl, "https://api.github.com");
    assert.equal(c.onboardingBranch, "fenvix/runs-on");
    assert.equal(c.supabaseJwksUrl, "https://x.supabase.co/auth/v1/.well-known/jwks.json");
    assert.equal(c.onboardAllRepositories, false);
  });
  it("accepts the key with literal \\n (as some secret stores write it)", () => {
    assert.ok(loadConfig({ ...base, GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n") }).privateKey);
  });
  it("names each missing or weak setting, never its value", () => {
    for (const k of Object.keys(base)) {
      const env: Record<string, string> = { ...base };
      delete env[k];
      assert.throws(() => loadConfig(env), new RegExp(k), k);
    }
    assert.throws(() => loadConfig({ ...base, GITHUB_WEBHOOK_SECRET: "short" }), /at least 20/);
    assert.throws(() => loadConfig({ ...base, GITHUB_APP_PRIVATE_KEY: "nope" }), (e: Error) => /PEM/.test(e.message) && !e.message.includes("nope"));
    assert.throws(() => loadConfig({ ...base, DASHBOARD_URL: "http://app.fenvix.dev", NODE_ENV: "production" }), /https/);
    assert.throws(() => loadConfig({ ...base, FENVIX_RUNS_ON: "fenvix, linux" }), /one runner label/);
  });
});
