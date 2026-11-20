// The GitHub App not configured yet (GITHUB_APP_ID empty): the stack deploys and the API works; the App's own
// functions answer "not configured" and touch no secret, no database, no queue (docs/DEPLOY-AWS.md).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeNotConfiguredWorkerHandler, notConfiguredSweep, notConfiguredWarmup } from "../../src/lambda/handlers.ts";
import { httpApp } from "../../src/lambda/runtime.ts";
import { githubAppConfigured, notConfiguredHttp } from "../../src/not-configured.ts";

describe("GitHub App not configured", () => {
  it("configured means GITHUB_APP_ID is set", () => {
    assert.equal(githubAppConfigured({}), false);
    assert.equal(githubAppConfigured({ GITHUB_APP_ID: " " }), false);
    assert.equal(githubAppConfigured({ GITHUB_APP_ID: "123" }), true);
  });

  it("the HTTP function: /healthz answers ok, every other route 503 github_not_configured; no SSM read", async () => {
    // No SSM_PREFIX, no WORK_QUEUE_URL, no secret: the configured path would throw on each.
    const app = await httpApp({ GITHUB_APP_ID: "", LOG_LEVEL: "silent" });
    const h = await app.fastify.inject({ method: "GET", url: "/healthz" });
    const ready = await app.fastify.inject({ method: "GET", url: "/readyz" });
    assert.deepEqual([ready.statusCode, ready.json()], [503, { ok: false, github: "not_configured" }], "the smoke test accepts exactly this");
    assert.deepEqual([h.statusCode, h.json()], [200, { ok: true, github: "not_configured" }]);
    for (const [method, url] of [["POST", "/webhooks/github"], ["GET", "/github/setup?code=x&state=y"], ["POST", "/v1/runner/summaries"], ["GET", "/anything"]] as const) {
      const r = await app.fastify.inject({ method, url, payload: method === "POST" ? '{"zen":"x"}' : undefined, headers: { "content-type": "application/json" } });
      assert.equal(r.statusCode, 503, url);
      assert.equal(r.json().error.code, "github_not_configured", url);
      assert.equal(r.headers["retry-after"], "3600");
    }
    await app.close();
  });

  it("the worker keeps every message (reported failed: it comes back, then waits in the dead-letter queue)", async () => {
    const lines: unknown[] = [];
    const log = { info: () => {}, warn: (o: unknown) => { lines.push(o); }, error: () => {}, debug: () => {} };
    const h = makeNotConfiguredWorkerHandler(log as never);
    const r = await h({ Records: [{ messageId: "m1", body: "{}" }, { messageId: "m2", body: "{}" }] });
    assert.deepEqual(r, { batchItemFailures: [{ itemIdentifier: "m1" }, { itemIdentifier: "m2" }] });
    assert.equal(lines.length, 1);
  });

  it("the sweep and the warm-up scheduler do nothing", async () => {
    assert.deepEqual(await notConfiguredSweep(), { due: 0, github: "not_configured" });
    assert.equal((await notConfiguredWarmup()).dispatched, 0);
  });

  it("the not-configured app never echoes a request", async () => {
    const app = notConfiguredHttp("silent");
    const r = await app.fastify.inject({ method: "POST", url: "/webhooks/github", payload: "secret-looking-body", headers: { "content-type": "text/plain" } });
    assert.doesNotMatch(r.body, /secret-looking-body/);
    await app.close();
  });
});
