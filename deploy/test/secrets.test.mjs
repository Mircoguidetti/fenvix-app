// Generated secrets: made once, straight into SSM, never printed (the job's log is the only output there is).
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { describe, it } from "node:test";
import { cacheKeyPair, ensureGenerated, GENERATED, randomHex } from "../lib/secrets.mjs";
import { newPassword } from "../lib/roles.mjs";
import { captured, MemorySsm } from "./helpers.mjs";

describe("generated secrets", () => {
  it("formats: 64 hex characters (256 bits); role passwords 43 URL-safe characters; fresh each time", () => {
    const a = randomHex(), b = randomHex();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
    const p = newPassword();
    assert.match(p, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(p, newPassword());
  });

  it("first run: every secret is created as a SecureString, without Overwrite, and no value is printed", async () => {
    const ssm = new MemorySsm();
    process.env.GITHUB_ACTIONS = "true"; // the job's own output format (::add-mask:: etc.)
    const [pub, out] = await captured(() => ensureGenerated(ssm, "prod"));
    delete process.env.GITHUB_ACTIONS;
    for (const g of GENERATED) {
      const p = ssm.params.get(`/fenvix/prod/github-app/${g.name}`);
      assert.equal(p.Type, "SecureString", g.name);
      assert.match(p.Value, /^[0-9a-f]{64}$/);
      assert.ok(!out.includes(p.Value), `${g.name}'s value was printed`);
    }
    for (const c of ssm.calls.filter((c) => c.name === "PutParameterCommand" && c.input.Name.includes("/github-app/"))) assert.equal(c.input.Overwrite, false);
    const priv = ssm.params.get("/fenvix/prod/cache/signing-key");
    assert.equal(priv.Type, "SecureString");
    assert.ok(!out.includes(priv.Value.split("\n")[1]), "a line of the private key was printed");
    assert.equal(createPrivateKey(priv.Value).asymmetricKeyDetails.modulusLength, 3072);
    assert.equal(ssm.params.get("/fenvix/prod/cache/signing-public-key").Type, "String", "the public half is not secret");
    assert.equal(pub, ssm.params.get("/fenvix/prod/cache/signing-public-key").Value);
    // The public half is the private half's.
    assert.equal(createPublicKey(createPrivateKey(priv.Value)).export({ type: "spki", format: "der" }).toString("base64"), pub);
    assert.doesNotMatch(out, /add-mask/, "nothing to mask: nothing secret is ever written out");
  });

  it("later runs keep every existing secret: never read, never overwritten", async () => {
    const ssm = new MemorySsm();
    await captured(() => ensureGenerated(ssm, "prod"));
    const before = new Map([...ssm.params].map(([k, v]) => [k, v.Value]));
    ssm.calls = [];
    const [, out] = await captured(() => ensureGenerated(ssm, "prod"));
    for (const [k, v] of before) assert.equal(ssm.params.get(k).Value, v, k);
    assert.equal(ssm.calls.filter((c) => c.name === "PutParameterCommand").length, 0);
    const reads = ssm.calls.filter((c) => c.name === "GetParameterCommand").map((c) => c.input.Name);
    assert.deepEqual(reads, ["/fenvix/prod/cache/signing-public-key"], "only the public half is read");
    assert.match(out, /present \(kept\)/);
  });

  it("a parallel run that created the secret first wins (ParameterAlreadyExists is fine)", async () => {
    const ssm = new MemorySsm();
    const racing = { send: async (cmd) => (cmd.constructor.name === "DescribeParametersCommand" ? { Parameters: [] } : ssm.send(cmd)) };
    await ssm.send({ constructor: { name: "PutParameterCommand" }, input: { Name: "/fenvix/prod/github-app/webhook-secret", Value: "first", Type: "SecureString" } });
    await captured(() => ensureGenerated(racing, "prod"));
    assert.equal(ssm.params.get("/fenvix/prod/github-app/webhook-secret").Value, "first");
  });

  it("the cache key pair: RSA 3072, the public half as base64 DER", () => {
    const k = cacheKeyPair();
    assert.match(k.privatePem, /^-----BEGIN PRIVATE KEY-----/);
    assert.equal(createPublicKey({ key: Buffer.from(k.publicDerBase64, "base64"), format: "der", type: "spki" }).asymmetricKeyDetails.modulusLength, 3072);
  });
});
