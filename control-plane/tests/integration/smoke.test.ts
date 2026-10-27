import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { type Harness, json, startHarness } from "../helpers/harness.ts";

let h: Harness;
before(async () => { h = await startHarness(); });
after(async () => { await h.close(); });

test("health, and a signed-in user can create a database and read it back", async () => {
  assert.equal((await h.app.fastify.inject("/healthz")).statusCode, 200);
  assert.equal((await h.app.fastify.inject("/readyz")).statusCode, 200);
  const u = await h.user();
  const res = await h.as(u).post("/databases", { name: "acme-prod-01", region: "eu-central-1", tags: ["customer:acme"] });
  assert.equal(res.statusCode, 201, res.body);
  const db = json(res);
  assert.equal(db.name, "acme-prod-01");
  const got = await h.as(u).get(`/databases/${db.id}`);
  assert.equal(got.statusCode, 200);
  assert.deepEqual(json(got).tags, ["customer:acme"]);
});
