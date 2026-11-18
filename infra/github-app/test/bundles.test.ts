import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { synth } from "./helpers.ts";

describe("the bundled functions (esbuild, ESM)", async () => {
  const { stack } = await synth();
  const outdir = (stack.node.root as unknown as { outdir: string }).outdir;
  const assets = readdirSync(outdir).filter((d) => d.startsWith("asset."));

  it("three bundles; each loads in Node and exports `handler` (nothing runs at import: config is read on the first call)", async () => {
    assert.equal(assets.length, 3);
    for (const a of assets) {
      const file = join(outdir, a, "index.mjs");
      assert.ok(readFileSync(file).length < 5 * 1024 * 1024);
      const mod = (await import(pathToFileURL(file).href)) as { handler?: unknown };
      assert.equal(typeof mod.handler, "function", a);
    }
  });

  it("no test secret or key in a bundle", () => {
    for (const a of assets) {
      const code = readFileSync(join(outdir, a, "index.mjs"), "utf8");
      assert.doesNotMatch(code, /BEGIN (RSA )?PRIVATE KEY|test-webhook-secret|runner-token-for-tests/);
    }
  });

  it("a handler with no settings fails cleanly (and would retry on the next call)", async () => {
    const http = assets.map((a) => join(outdir, a, "index.mjs")).find((f) => readFileSync(f, "utf8").includes("WORK_QUEUE_URL"))!;
    const { handler } = (await import(pathToFileURL(http).href)) as { handler: (e: unknown) => Promise<unknown> };
    const saved = process.env.SSM_PREFIX;
    delete process.env.SSM_PREFIX;
    await assert.rejects(handler({ rawPath: "/healthz", requestContext: { http: { method: "GET" } } }), /SSM_PREFIX is required/);
    if (saved !== undefined) process.env.SSM_PREFIX = saved;
  });
});
