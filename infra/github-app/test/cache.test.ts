import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
    // It is the protocol of the engine commit PROVENANCE.md names; the machines run the trunk artifact (engineVersion), whose
    // cache client must speak it (docs/REPORT-our-machines.md, G-1742).
  });

  it("serves with per-job signed tokens only: own organization, read-only for pull requests, expiry, signature (R-012 F3)", async () => {
    // The tokens are made by the App's own signer (the worker), the key file by the stack's own code.
    const s = await settings();
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
      const tok = (installationId: number, write: boolean, e = exp, repositoryId = 11) => signCacheToken(CACHE_KEY.privateKey, { installationId, repositoryId, write, exp: e, jobId: 1 });
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
      // Audit G-0192/G-0193: another REPOSITORY of the same account (same installation) is another organization:
      // its read token (a fork's pull request included) finds nothing of acme/shop, and its write token's entries
      // land in its own namespace only, never in acme/shop's.
      const siblingRead = tok(1, false, exp, 12), siblingWrite = tok(1, true, exp, 12);
      assert.deepEqual(await lookup(siblingRead), [], "a sibling repository's pull request reads nothing of acme/shop");
      const sib = await (await call("/v1/blobs/get", siblingRead, { ids: [docId] })).json() as { docs: Record<string, unknown> };
      assert.deepEqual(sib.docs, {}, "a sibling repository downloads no entry of acme/shop");
      const planted = { kind: "file", path: "a.py", sha: "planted" };
      const plantedId = createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(planted).sort()))).digest("hex");
      assert.equal((await call("/v1/blobs/put", siblingWrite, { docs: { [plantedId]: planted } })).status, 200);
      assert.equal((await call("/v1/ns/acme%2Fshop/keys", siblingWrite, { put: [{ key: "k1", doc: plantedId, run: "r9" }] })).status, 200);
      assert.deepEqual(await lookup(acmeRead), [docId], "a sibling repository's write never adds a result to acme/shop's cache");
      // A token in the older per-installation form (gh-<id>) is refused outright.
      const [, , oldSig] = acmeRead.split(".");
      const oldForm = Buffer.from(JSON.stringify({ org: "gh-1", w: false, exp, job: 1 })).toString("base64url");
      assert.equal((await call("/v1/stats", `fxs1.${oldForm}.${oldSig}`)).status, 401);
      // Refused: expired, tampered, signed with another key, the old static token, none.
      assert.equal((await call("/v1/stats", tok(1, true, Math.floor(Date.now() / 1000) - 5))).status, 401);
      const [, body, sig] = acmeRead.split(".");
      const forged = Buffer.from(JSON.stringify({ org: "gh-1", w: true, exp, job: 1 })).toString("base64url");
      assert.equal((await call("/v1/stats", `fxs1.${forged}.${sig}`)).status, 401);
      assert.equal((await call("/v1/stats", `fxs1.${body}.${sig}A`)).status, 401);
      const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
      assert.equal((await call("/v1/stats", signCacheToken(stranger, { installationId: 1, repositoryId: 11, write: true, exp, jobId: 1 }))).status, 401);
      assert.equal((await call("/v1/stats", legacy)).status, 401);
      assert.equal((await call("/v1/stats", null)).status, 401);
      // G-2320: one repository's flood gets 429 with Retry-After; another customer's cache still answers.
      let limited: Response | null = null;
      for (let i = 0; i < 400 && !limited; i++) { const r = await call("/v1/stats", acmeRead); if (r.status === 429) limited = r; else await r.arrayBuffer(); }
      assert.ok(limited, "a flood of one repository is limited");
      assert.equal(limited.headers.get("retry-after"), "1");
      assert.equal((await call("/v1/stats", globexRead)).status, 200);
    } finally {
      p.kill();
    }
  });

  it("G-2320 limits: request and byte buckets per repository, at most two at once per repository, four on the machine", () => {
    const script = `
import sys; sys.path.insert(0, ${JSON.stringify(join(AUTH, ".."))})
import fenvix_cache_auth as a
t = [0.0]
L = a.Limits(now=lambda: t[0], rate=1, burst=3, byte_rate=100, byte_burst=1000, per_org_inflight=2, inflight=4)
out = []
out.append(L.admit("a", 10)); out.append(L.admit("a", 10)); out.append(L.admit("a", 10))  # two admitted, third: two at once
L.done("a"); L.done("a")
out.append(L.admit("a", 10)); L.done("a")                                              # the third request of the burst
out.append(L.admit("a", 10))                                                           # bucket empty
t[0] = 1.0; out.append(L.admit("a", 5000))                                             # bytes over the bucket
out.append(L.admit("b", 10)); out.append(L.admit("c", 10)); out.append(L.admit("d", 10)); out.append(L.admit("e", 10)); out.append(L.admit("f", 10))
import json; print(json.dumps([o[0] if o else None for o in out]))
`;
    const r = spawnSync("python3", ["-I", "-c", script], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [null, null, 429, null, 429, 429, null, null, null, null, 503]);
  });

  it("the cache machine's user data: the public key only, both service files, the wrapper as the service", async () => {
    const s = await settings();
    const ud = cacheUserData(s);
    assert.match(ud, /\/opt\/fenvix-cache\/fenvix_cache_auth\.py/);
    assert.match(ud, /\/etc\/fenvix-cache\/signing-key\.json/);
    assert.doesNotMatch(ud, /PRIVATE|tokens\.json/);
    // EC2 refuses user data over 16 KB (before base64): the launch would fail, not the deploy (G-2320 made the wrapper grow).
    assert.ok(Buffer.byteLength(ud) <= 16 * 1024, `user data ${Buffer.byteLength(ud)} bytes`);
    const svc = readFileSync(new URL("../lib/cache/fenvix-cache.service", import.meta.url), "utf8");
    assert.match(svc, /^ExecStart=\/usr\/bin\/python3 -I \/opt\/fenvix-cache\/fenvix_cache_auth\.py serve .*--key \/etc\/fenvix-cache\/signing-key\.json/m);
  });
});
