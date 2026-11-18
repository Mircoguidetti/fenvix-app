import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tokensJson } from "../lib/cache.ts";
import { settings } from "./helpers.ts";

const FILE = fileURLToPath(new URL("../lib/cache/cache_service.py", import.meta.url));

describe("the shared cache service (vendored, pinned)", () => {
  it("is byte for byte the file PROVENANCE.md names", () => {
    const sha = createHash("sha256").update(readFileSync(FILE)).digest("hex");
    assert.equal(sha, "2b93cd9aac59ba160bc28ae0e9c4b725b0abd29ec6784e5ed910f479eeea33a8");
    assert.match(readFileSync(new URL("../lib/cache/PROVENANCE.md", import.meta.url), "utf8"), new RegExp(sha));
    assert.match(readFileSync(new URL("../cdk.json", import.meta.url), "utf8"), /"engineCliCommit": "a20b93d7f840b23f71c73c03efdaee3d6a233252"/);
  });

  it("serves with the tokens.json the stack writes: write token records, read token only looks up, others refused", async () => {
    const write = "fxc_write-token-for-the-test-0123456789";
    const read = "fxc_read-token-for-the-test-0123456789";
    const h = (t: string) => createHash("sha256").update(t).digest("hex");
    const s = await settings({ cacheTokenSha256Write: h(write), cacheTokenSha256Read: h(read) });
    const data = mkdtempSync(join(tmpdir(), "fenvix-cache-"));
    writeFileSync(join(data, "tokens.json"), tokensJson(s));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const p = spawn("python3", ["-I", FILE, "serve", "--data", data, "--host", "127.0.0.1", "--port", String(port), "--quiet"], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        p.stdout.on("data", (b: Buffer) => { if (b.toString().includes("fenvix cache service on")) resolve(); });
        p.on("exit", (c) => reject(new Error(`exited ${c}`)));
      });
      const call = (path: string, token: string | null, body?: object) => fetch(`http://127.0.0.1:${port}${path}`, {
        method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal((await call("/v1/health", null)).status, 200);
      const doc = { kind: "file", path: "a.py", sha: "x" };
      const id = createHash("sha256").update(JSON.stringify(doc, Object.keys(doc).sort()).replace(/\s/g, "")).digest("hex");
      const canonical = JSON.stringify(Object.fromEntries(Object.entries(doc).sort()));
      const docId = createHash("sha256").update(canonical).digest("hex");
      assert.equal(id.length, 64);
      assert.equal((await call("/v1/blobs/put", write, { docs: { [docId]: doc } })).status, 200);
      assert.equal((await call("/v1/blobs/put", read, { docs: { [docId]: doc } })).status, 403);
      const got = await (await call("/v1/blobs/get", read, { ids: [docId] })).json() as { docs: Record<string, unknown> };
      assert.deepEqual(got.docs[docId], doc);
      assert.equal((await call("/v1/stats", "fxc_unknown")).status, 401);
    } finally {
      p.kill();
    }
  });
});
