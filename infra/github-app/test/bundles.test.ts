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

  it("six bundles; each loads in Node and exports `handler` (nothing runs at import: config is read on the first call)", async () => {
    assert.equal(assets.length, 6, "http, api, worker, sweep, reaper, warmup");
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
    const http = assets.map((a) => join(outdir, a, "index.mjs")).find((f) => readFileSync(f, "utf8").includes("/webhooks/github") && !readFileSync(f, "utf8").includes("openSetupPullRequest"))!;
    const { handler } = (await import(pathToFileURL(http).href)) as { handler: (e: unknown) => Promise<unknown> };
    const saved = process.env.SSM_PREFIX;
    const savedId = process.env.GITHUB_APP_ID;
    delete process.env.SSM_PREFIX;
    process.env.GITHUB_APP_ID = "123456";
    try {
      await assert.rejects(handler({ rawPath: "/healthz", requestContext: { http: { method: "GET" } } }), /SSM_PREFIX is required/);
    } finally {
      if (saved !== undefined) process.env.SSM_PREFIX = saved;
      if (savedId === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = savedId;
    }
  });

  it("the App's HTTP bundle without the GitHub App (GITHUB_APP_ID empty): /healthz ok, webhooks 503 github_not_configured, no SSM read", async () => {
    const http = assets.map((a) => join(outdir, a, "index.mjs")).find((f) => readFileSync(f, "utf8").includes("/webhooks/github") && !readFileSync(f, "utf8").includes("openSetupPullRequest"))!;
    // A fresh copy of the module: the handler decides at its first call and keeps its app.
    const { handler } = (await import(`${pathToFileURL(http).href}?no-app`)) as { handler: (e: unknown) => Promise<{ statusCode: number; body: string }> };
    const savedId = process.env.GITHUB_APP_ID;
    const saved = process.env.SSM_PREFIX;
    delete process.env.GITHUB_APP_ID;
    delete process.env.SSM_PREFIX;
    try {
      const h = await handler({ rawPath: "/healthz", requestContext: { http: { method: "GET" } }, headers: {} });
      assert.equal(h.statusCode, 200);
      assert.match(h.body, /not_configured/);
      const w = await handler({ rawPath: "/webhooks/github", requestContext: { http: { method: "POST" } }, headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(w.statusCode, 503);
      assert.match(w.body, /github_not_configured/);
    } finally {
      if (savedId !== undefined) process.env.GITHUB_APP_ID = savedId;
      if (saved !== undefined) process.env.SSM_PREFIX = saved;
    }
  });

  it("the dashboard API's bundle: the contract compiled in, the dashboard's own calculations bundled, the same clean failure without settings", async () => {
    const file = assets.map((a) => join(outdir, a, "index.mjs")).find((f) => readFileSync(f, "utf8").includes("openSetupPullRequest"))!;
    assert.ok(file, "a bundle with the contract");
    const code = readFileSync(file, "utf8");
    assert.match(code, /Repositories not set up as projects/, "src/data/ci.ts is in the bundle");
    assert.match(code, /fenvix-usage-/);
    assert.doesNotMatch(code, /is not a PEM private key|login\/oauth\/access_token|webhooks\/github/, "not the App: no key parsing, no OAuth exchange, no webhook route");
    const { handler } = (await import(pathToFileURL(file).href)) as { handler: (e: unknown) => Promise<unknown> };
    const saved = process.env.SSM_PREFIX;
    delete process.env.SSM_PREFIX;
    await assert.rejects(handler({ rawPath: "/v1/me", requestContext: { http: { method: "GET" } } }), /SSM_PREFIX is required/);
    if (saved !== undefined) process.env.SSM_PREFIX = saved;
  });
});
