import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { LightMyRequestResponse as Res } from "fastify";
import { type Client, type Fixture, type Harness, json, startHarness } from "../helpers/harness.ts";
import { dataTarget } from "../../src/engine/data.ts";
import { engineName } from "../../src/engine/names.ts";

/**
 * Two workspaces, A and B, each with a database holding documents. A (as a person with a cookie session, and as a
 * read-write API key) tries EVERY Data Explorer route against B's database id. Each answer must be the same 404 as
 * for an id that exists nowhere, B's documents must be unchanged, the engine must never have been asked for B's
 * database, and A's audit log must not gain a row naming B's data beyond the refused id.
 */
let h: Harness;
let a: Fixture;
let b: Fixture;
let aKey = "";
let bDb = "";
let aDb = "";
let bDocId = "";
let bVersion = "";
const enc = encodeURIComponent;
const cookie = { origin: "https://app.fenvix.test" };

const bState = () => JSON.stringify([...(h.data.dbs.get(engineName(bDb))?.entries() ?? [])].map(([k, v]) => [k, v.map((x) => x.toString("hex"))]));

/** The body without the request id, which differs per request. */
const shape = (r: Res) => ({ status: r.statusCode, body: r.body, cache: r.headers["cache-control"] });

before(async () => {
  h = await startHarness({ RATE_LIMIT_PER_MINUTE: "100000", DATA_RATE_LIMIT_PER_MINUTE: "100000", DATA_WRITE_RATE_LIMIT_PER_MINUTE: "100000" });
  a = await h.user("Alice");
  b = await h.user("Bob");
  aKey = await h.apiKey(a.workspaceId, "alice rw", "read_write");
  aDb = json(await h.as(a).post("/databases", { name: "shared-name", region: "eu-central-1" }, cookie)).id;
  // Same name in both workspaces: the engine name comes from the id, so they are different databases.
  bDb = json(await h.as(b).post("/databases", { name: "shared-name", region: "eu-central-1" }, cookie)).id;
  h.data.seed(dataTarget({ id: bDb, region: "eu-central-1" }), "secrets", [{ _id: "b-doc", payload: "BOB-ONLY" }]);
  h.data.seed(dataTarget({ id: aDb, region: "eu-central-1" }), "secrets", [{ _id: "a-doc", payload: "ALICE-ONLY" }]);
  const got = json(await h.as(b).get(`/databases/${bDb}/data/collections/secrets/documents/${enc('"b-doc"')}`));
  bDocId = got.id;
  bVersion = got.version;
});
after(async () => { await h.close(); });

type Route = { name: string; call: (c: Client, db: string) => Promise<Res> };
const ROUTES: Route[] = [
  { name: "list collections", call: (c, db) => c.get(`/databases/${db}/data/collections`) },
  { name: "list documents", call: (c, db) => c.get(`/databases/${db}/data/collections/secrets/documents`) },
  { name: "list documents with a filter", call: (c, db) => c.get(`/databases/${db}/data/collections/secrets/documents?filter=${enc('{"payload": "BOB-ONLY"}')}`) },
  { name: "get one document", call: (c, db) => c.get(`/databases/${db}/data/collections/secrets/documents/${enc(bDocId)}`) },
  { name: "insert", call: (c, db) => c.post(`/databases/${db}/data/collections/secrets/documents`, { document: { _id: "planted", x: 1 } }, cookie) },
  { name: "replace", call: (c, db) => c.put(`/databases/${db}/data/collections/secrets/documents/${enc(bDocId)}`, { document: { payload: "PWNED" }, version: bVersion }, cookie) },
  { name: "delete", call: (c, db) => c.del(`/databases/${db}/data/collections/secrets/documents/${enc(bDocId)}?version=${bVersion}`, cookie) },
];

describe("A against B's database: the same 404 as a database that does not exist", () => {
  for (const r of ROUTES) {
    for (const who of ["person", "api key"] as const) {
      test(`${r.name} (${who})`, async () => {
        const client = h.as(who === "person" ? a : aKey);
        const before = bState();
        const touched = h.data.touched.length;
        const theirs = await r.call(client, bDb);
        const nowhere = await r.call(client, randomUUID());
        assert.equal(theirs.statusCode, 404, theirs.body);
        assert.deepEqual(shape(theirs), shape(nowhere), "another workspace's database must look exactly like one that does not exist");
        assert.deepEqual(json(theirs), { error: { code: "not_found", message: "That database does not exist." } });
        assert.ok(!theirs.body.includes("BOB-ONLY"));
        assert.equal(bState(), before, "B's data did not change");
        assert.ok(!h.data.touched.slice(touched).includes(engineName(bDb)), "the engine was never asked for B's database");
      });
    }
  }

  test("upper-case and malformed ids do not slip past the workspace check", async () => {
    for (const id of [bDb.toUpperCase(), ` ${bDb}`, `${bDb}x`, "db_" + bDb.replaceAll("-", ""), engineName(bDb), "../" + bDb]) {
      const res = await h.as(a).get(`/databases/${enc(id)}/data/collections`);
      assert.equal(res.statusCode, 404, id);
    }
  });
});

describe("B is untouched and A still works", () => {
  test("B still sees exactly its own document; A sees only its own", async () => {
    const bDocs = json(await h.as(b).get(`/databases/${bDb}/data/collections/secrets/documents`)).items;
    assert.deepEqual(bDocs.map((d: { document: { payload: string } }) => d.document.payload), ["BOB-ONLY"]);
    const aDocs = json(await h.as(a).get(`/databases/${aDb}/data/collections/secrets/documents`)).items;
    assert.deepEqual(aDocs.map((d: { document: { payload: string } }) => d.document.payload), ["ALICE-ONLY"]);
  });

  test("audit: B's log has nothing from A; A's refused writes did not reach the engine or B's log", async () => {
    const bRows = (await h.admin.query("select * from public.data_audit_log where workspace_id = $1", [b.workspaceId])).rows;
    assert.equal(bRows.length, 0);
    const aRows = (await h.admin.query("select * from public.data_audit_log where workspace_id = $1 and database_id = $2", [a.workspaceId, bDb])).rows;
    assert.equal(aRows.length, 0, "no attempt on B's database was recorded as an attempt: it failed before the engine");
  });

  test("the restricted role cannot read B's audit rows while acting for A", async () => {
    await h.as(b).post(`/databases/${bDb}/data/collections/c/documents`, { document: { z: 1 } }, cookie);
    const pg = (await import("pg")).default;
    const cp = new pg.Client({ connectionString: h.cpUrl });
    await cp.connect();
    try {
      await cp.query("begin");
      await cp.query("select set_config('app.workspace_id', $1, true)", [a.workspaceId]);
      const seen = (await cp.query("select count(*)::int as n from public.data_audit_log where workspace_id = $1", [b.workspaceId])).rows[0].n;
      assert.equal(seen, 0);
      await assert.rejects(cp.query(
        "insert into public.data_audit_log (workspace_id, actor_type, actor_id, operation, outcome) values ($1, 'user', 'x', 'insert', 'ok')", [b.workspaceId]));
      await cp.query("rollback");
    } finally {
      await cp.end();
    }
  });
});
