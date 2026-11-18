import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { signCacheToken } from "../../../github-app/src/runners/credentials.ts";
import { cacheKeyJson, cacheUserData } from "../lib/cache.ts";
import { CACHE_KEY, settings } from "./helpers.ts";

const FILE = fileURLToPath(new URL("../lib/cache/cache_service.py", import.meta.url));
const AUTH = fileURLToPath(new URL("../lib/cache/fenvix_cache_auth.py", import.meta.url));

describe("the shared cache service (vendored, pinned)", () => {
  it("is byte for byte the file PROVENANCE.md names", () => {
    const sha = createHash("sha256").update(readFileSync(FILE)).digest("hex");
    assert.equal(sha, "2b93cd9aac59ba160bc28ae0e9c4b725b0abd29ec6784e5ed910f479eeea33a8");
    assert.match(readFileSync(new URL("../lib/cache/PROVENANCE.md", import.meta.url), "utf8"), new RegExp(sha));
    assert.match(readFileSync(new URL("../cdk.json", import.meta.url), "utf8"), /"engineCliCommit": "a20b93d7f840b23f71c73c03efdaee3d6a233252"/);
  });

  it("serves with per-job signed tokens only: own organization, read-only for pull requests, expiry, signature (R-012 F3)", async () => {
    // The tokens are made by the App's own signer (the worker), the key file by the stack's own code.
    const s = await settings({ runnerMode: "per-job" });
    const data = mkdtempSync(join(tmpdir(), "fenvix-cache-"));
    const keyFile = join(data, "signing-key.json");
    writeFileSync(keyFile, cacheKeyJson(s));
    // A static token in tokens.json (the old scheme) must not be accepted any more.
    const legacy = "fxc_static-token-0123456789";
    writeFileSync(join(data, "tokens.json"), JSON.stringify({ tokens: [{ sha256: createHash("sha256").update(legacy).digest("hex"), org: "gh-1", write: true }] }));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const p = spawn("python3", ["-I", AUTH, "serve", "--data", data, "--key", keyFile, "--host", "127.0.0.1", "--port", String(port), "--quiet"], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        p.stdout.on("data", (b: Buffer) => { if (b.toString().includes("fenvix cache service on")) resolve(); });
        p.on("exit", (c) => reject(new Error(`exited ${c}`)));
      });
      const call = (path: string, token: string | null, body?: object) => fetch(`http://127.0.0.1:${port}${path}`, {
        method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const tok = (installationId: number, write: boolean, e = exp) => signCacheToken(CACHE_KEY.privateKey, { installationId, write, exp: e, jobId: 1 });
      const acmeWrite = tok(1, true), acmeRead = tok(1, false), globexRead = tok(2, false);
      assert.equal((await call("/v1/health", null)).status, 200);
      const doc = { kind: "file", path: "a.py", sha: "x" };
      const docId = createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(doc).sort()))).digest("hex");
      assert.equal((await call("/v1/blobs/put", acmeWrite, { docs: { [docId]: doc } })).status, 200);
      assert.equal((await call("/v1/ns/acme%2Fshop/keys", acmeWrite, { put: [{ key: "k1", doc: docId, run: "r1" }] })).status, 200);
      // A pull request of the same customer: reads, never writes.
      assert.equal((await call("/v1/blobs/put", acmeRead, { docs: { [docId]: doc } })).status, 403);
      const got = await (await call("/v1/blobs/get", acmeRead, { ids: [docId] })).json() as { docs: Record<string, unknown> };
      assert.deepEqual(got.docs[docId], doc);
      // Another customer: nothing of acme's, by any route.
      const other = await (await call("/v1/blobs/get", globexRead, { ids: [docId] })).json() as { docs: Record<string, unknown>; missing: string[] };
      assert.deepEqual(other, { docs: {}, missing: [docId] });
      const lookup = async (t: string) => ((await (await call("/v1/ns/acme%2Fshop/lookup", t, { keys: ["k1"] })).json()) as { found: Record<string, string[]> }).found.k1 ?? [];
      assert.deepEqual(await lookup(acmeRead), [docId], "the same customer's pull request finds the entry");
      assert.deepEqual(await lookup(globexRead), [], "another customer finds nothing under the same namespace");
      // Refused: expired, tampered, signed with another key, the old static token, none.
      assert.equal((await call("/v1/stats", tok(1, true, Math.floor(Date.now() / 1000) - 5))).status, 401);
      const [, body, sig] = acmeRead.split(".");
      const forged = Buffer.from(JSON.stringify({ org: "gh-1", w: true, exp, job: 1 })).toString("base64url");
      assert.equal((await call("/v1/stats", `fxs1.${forged}.${sig}`)).status, 401);
      assert.equal((await call("/v1/stats", `fxs1.${body}.${sig}A`)).status, 401);
      const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
      assert.equal((await call("/v1/stats", signCacheToken(stranger, { installationId: 1, write: true, exp, jobId: 1 }))).status, 401);
      assert.equal((await call("/v1/stats", legacy)).status, 401);
      assert.equal((await call("/v1/stats", null)).status, 401);
    } finally {
      p.kill();
    }
  });

  it("the cache machine's user data: the public key only, both service files, the wrapper as the service", async () => {
    const s = await settings({ runnerMode: "per-job" });
    const ud = cacheUserData(s);
    assert.match(ud, /\/opt\/fenvix-cache\/fenvix_cache_auth\.py/);
    assert.match(ud, /\/etc\/fenvix-cache\/signing-key\.json/);
    assert.doesNotMatch(ud, /PRIVATE|tokens\.json/);
    const svc = readFileSync(new URL("../lib/cache/fenvix-cache.service", import.meta.url), "utf8");
    assert.match(svc, /^ExecStart=\/usr\/bin\/python3 -I \/opt\/fenvix-cache\/fenvix_cache_auth\.py serve .*--key \/etc\/fenvix-cache\/signing-key\.json/m);
  });
});
