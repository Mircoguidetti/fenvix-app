import { test } from "node:test";
import assert from "node:assert/strict";
import { json, sleep, startHarness } from "../helpers/harness.ts";

/** A slow engine: the public API answers 202 with an operation to poll on the public prefix, and the poll finishes. */
test("a slow create gets a 202 pointing at /v1/public/operations/{id}; the poll shows the database, never the password", async () => {
  const t = await startHarness({ OPERATION_WAIT_MS: "100" });
  try {
    const w = await t.user();
    const org = { "x-fenvix-workspace": w.workspaceId };
    const token = json(await t.as(w).post("/public/api-keys", { name: "ops", role: "admin" }, org)).token;
    const ro = json(await t.as(w).post("/public/api-keys", { name: "ops-ro", role: "read_only" }, org)).token;
    t.engine.delay("create", 500);
    const res = await t.as(token).post("/public/databases", { name: "slow-public-01", region: "eu-central-1" });
    assert.equal(res.statusCode, 202, res.body);
    const op = json(res).operation;
    assert.equal(op.kind, "create");
    assert.equal(res.headers["location"], `https://api.fenvix.test/v1/public/operations/${op.id}`);
    assert.equal(res.headers["operation-id"], op.id);
    assert.ok(res.headers["retry-after"]);
    let done = op;
    for (let i = 0; i < 40 && done.status !== "succeeded"; i++) { await sleep(100); done = json(await t.as(ro).get(`/public/operations/${op.id}`)); }
    assert.equal(done.status, "succeeded");
    assert.equal(done.result.name, "slow-public-01");
    assert.equal(done.result.status, "ready");
    assert.equal(done.result.initialUser.password, null);
    assert.equal(done.result.initialUser.connectionString, null);
    assert.equal(json(await t.as(ro).get(`/public/databases/${done.databaseId}`)).name, "slow-public-01");
  } finally { t.engine.delay("create", 0); await t.close(); }
});
