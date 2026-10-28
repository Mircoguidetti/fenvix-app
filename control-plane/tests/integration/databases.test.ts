import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { type Fixture, type Harness, json, startHarness } from "../helpers/harness.ts";

let h: Harness;
let u: Fixture;
before(async () => { h = await startHarness({ REGIONS: "eu-central-1,us-east-1", BASE_DOMAIN: "db.example.test" }); u = await h.user("Ann"); });
after(async () => { await h.close(); });

const err = (res: { body: string }) => json(res).error as { code: string; message: string; field?: string };
const create = (name: string, tags: string[] = [], region = "eu-central-1", who: Fixture = u) => h.as(who).post("/databases", { name, region, tags });

describe("regions", () => {
  test("GET /regions lists the configured regions", async () => {
    const res = await h.as(u).get("/regions");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(res), { items: ["eu-central-1", "us-east-1"] });
  });
});

describe("createDatabase", () => {
  test("201 with the full Database shape, asleep, configured host and a password placeholder", async () => {
    const res = await create("Acme-Labs-Prod-01", ["env:prod", "customer:acme-labs"]);
    assert.equal(res.statusCode, 201, res.body);
    const d = json(res);
    assert.match(d.id, /^[0-9a-f-]{36}$/);
    // The Database of the contract, plus the initial user (docs/database-users.md): its password in this answer only.
    assert.deepEqual(Object.keys(d).sort(), ["connectionString", "createdAt", "forkedFrom", "host", "id", "initialUser", "keepAwake", "lastActiveAt", "name", "region", "requests24h", "restoredTo", "state", "storageMb", "tags"]);
    assert.equal(d.initialUser.username, "app");
    assert.equal(d.initialUser.role, "readWrite");
    assert.match(d.initialUser.password, /^[A-Za-z0-9]{40}$/);
    assert.equal(d.name, "acme-labs-prod-01");
    assert.equal(d.state, "asleep");
    assert.equal(d.keepAwake, false);
    assert.equal(d.forkedFrom, null);
    assert.equal(d.restoredTo, null);
    assert.equal(d.storageMb, 0);
    assert.deepEqual(d.tags, ["customer:acme-labs", "env:prod"]);
    assert.equal(d.host, "acme-labs-prod-01.eu-central-1.db.db.example.test");
    assert.equal(d.connectionString, "mongodb://app:<password>@acme-labs-prod-01.eu-central-1.db.db.example.test:27017/acme_labs_prod_01?tls=true&authSource=acme_labs_prod_01&authMechanism=SCRAM-SHA-256");
    assert.equal(d.initialUser.connectionString, d.connectionString.replace("<password>", d.initialUser.password));
    assert.match(d.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    assert.ok(h.engine.dbs.has(d.id), "the engine has it");
    assert.equal(h.engine.dbs.get(d.id)!.db.workspaceId, u.workspaceId);
  });

  test("400 for a bad name, region or tags, with the field named", async () => {
    for (const [body, field] of [
      [{ name: "ab", region: "eu-central-1" }, "name"],
      [{ name: "bad_name", region: "eu-central-1" }, "name"],
      [{ name: "good-name", region: "mars-1" }, "region"],
      [{ name: "good-name" }, "region"],
      [{ name: "good-name", region: "eu-central-1", tags: ["nope"] }, "tags"],
      [{ name: "good-name", region: "eu-central-1", tags: ["a:1", "a:2"] }, "tags"],
      [{ name: "good-name", region: "eu-central-1", tags: Array.from({ length: 21 }, (_, i) => `k${i}:v`) }, "tags"],
    ] as const) {
      const res = await h.as(u).post("/databases", body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      const e = err(res);
      assert.equal(e.code, "validation_failed");
      assert.equal(e.field, field);
      assert.ok(e.message.length > 5);
    }
    assert.equal((await h.as(u).post("/databases", [1, 2])).statusCode, 400);
  });

  test("409 when the name is taken, case-insensitively, with the message the dashboard shows", async () => {
    assert.equal((await create("taken-name-01")).statusCode, 201);
    const res = await create("TAKEN-name-01");
    assert.equal(res.statusCode, 409);
    assert.deepEqual(err(res), { code: "conflict", message: "A database named taken-name-01 already exists.", field: "name" });
  });

  test("nothing is left behind when the engine refuses: no database, name free again", async () => {
    h.engine.failNext("create", "conflict", 1);
    const res = await create("engine-refuses-01");
    assert.equal(res.statusCode, 409);
    const after = await h.as(u).get("/databases?search=engine-refuses");
    assert.equal(json(after).total, 0);
    assert.equal((await create("engine-refuses-01")).statusCode, 201);
  });

  test("the same name in two workspaces is fine", async () => {
    const other = await h.user("Bo");
    assert.equal((await create("shared-name-01")).statusCode, 201);
    assert.equal((await create("shared-name-01", [], "eu-central-1", other)).statusCode, 201);
  });
});

describe("reading", () => {
  let fx: Fixture;
  const ids: Record<string, string> = {};
  before(async () => {
    fx = await h.user("Reader");
    const defs: [string, string[]][] = [
      ["alpha-prod-01", ["customer:alpha", "env:prod"]],
      ["alpha-dev-01", ["customer:alpha", "env:dev"]],
      ["beta-prod-01", ["customer:beta", "env:prod"]],
      ["gamma-sbx-01", ["env:sandbox"]],
      ["delta-bare-01", []],
    ];
    for (const [n, t] of defs) {
      const r = await create(n, t, "eu-central-1", fx);
      ids[n] = json(r).id;
    }
    await h.admin.query(`update public.databases set last_active_at = now() - interval '10 hours' where workspace_id = $1`, [fx.workspaceId]);
    // give the rows distinct sizes, activity and states, as the usage sync would
    await h.admin.query(`update public.databases set storage_bytes = 5 * 1048576, requests_24h = 50, state = 'awake', last_active_at = now() - interval '1 hour' where id = $1`, [ids["alpha-prod-01"]]);
    await h.admin.query(`update public.databases set storage_bytes = 2 * 1048576, requests_24h = 10, last_active_at = now() - interval '2 hours', keep_awake = true, state = 'awake' where id = $1`, [ids["beta-prod-01"]]);
    await h.admin.query(`update public.databases set storage_bytes = 9 * 1048576, requests_24h = 99, last_active_at = now() - interval '3 hours' where id = $1`, [ids["gamma-sbx-01"]]);
  });

  const names = (res: { body: string }) => json(res).items.map((d: { name: string }) => d.name);

  test("list: default sort is lastActiveAt descending; page envelope is exact", async () => {
    const res = await h.as(fx).get("/databases");
    assert.equal(res.statusCode, 200);
    const b = json(res);
    assert.equal(b.total, 5);
    assert.equal(b.page, 1);
    assert.equal(b.pageSize, 50);
    assert.deepEqual(names(res).slice(0, 3), ["alpha-prod-01", "beta-prod-01", "gamma-sbx-01"]);
  });

  test("list: sort keys and direction; ties broken by name then id", async () => {
    assert.deepEqual(names(await h.as(fx).get("/databases?sort=name&dir=asc")), ["alpha-dev-01", "alpha-prod-01", "beta-prod-01", "delta-bare-01", "gamma-sbx-01"]);
    assert.deepEqual(names(await h.as(fx).get("/databases?sort=storageMb&dir=desc")).slice(0, 3), ["gamma-sbx-01", "alpha-prod-01", "beta-prod-01"]);
    assert.deepEqual(names(await h.as(fx).get("/databases?sort=requests24h&dir=desc")).slice(0, 2), ["gamma-sbx-01", "alpha-prod-01"]);
    assert.deepEqual(names(await h.as(fx).get("/databases?sort=keepAwake&dir=desc"))[0], "beta-prod-01");
    // both zero-request databases tie: name decides
    assert.deepEqual(names(await h.as(fx).get("/databases?sort=requests24h&dir=asc")).slice(0, 2), ["alpha-dev-01", "delta-bare-01"]);
    assert.equal((await h.as(fx).get("/databases?sort=color")).statusCode, 400);
    assert.equal((await h.as(fx).get("/databases?dir=up")).statusCode, 400);
  });

  test("list: paging, a page past the end is empty, total counts all pages", async () => {
    const p1 = json(await h.as(fx).get("/databases?sort=name&dir=asc&page=1&pageSize=2"));
    const p3 = json(await h.as(fx).get("/databases?sort=name&dir=asc&page=3&pageSize=2"));
    const p9 = json(await h.as(fx).get("/databases?sort=name&dir=asc&page=9&pageSize=2"));
    assert.deepEqual([p1.items.length, p1.total, p1.pageSize], [2, 5, 2]);
    assert.deepEqual(p3.items.map((d: { name: string }) => d.name), ["gamma-sbx-01"]);
    assert.deepEqual([p9.items, p9.total, p9.page], [[], 5, 9]);
    assert.equal((await h.as(fx).get("/databases?pageSize=201")).statusCode, 400);
    assert.equal((await h.as(fx).get("/databases?page=0")).statusCode, 400);
  });

  test("list: filters combine with AND (search, state, keepAwake, tags)", async () => {
    assert.deepEqual(names(await h.as(fx).get("/databases?search=ALPHA&sort=name&dir=asc")), ["alpha-dev-01", "alpha-prod-01"]);
    assert.equal(json(await h.as(fx).get("/databases?search=%25")).total, 0, "% is not a wildcard");
    assert.equal(json(await h.as(fx).get("/databases?search=_")).total, 0, "_ is not a wildcard");
    assert.deepEqual(names(await h.as(fx).get("/databases?state=awake&sort=name&dir=asc")), ["alpha-prod-01", "beta-prod-01"]);
    assert.deepEqual(names(await h.as(fx).get("/databases?keepAwake=true")), ["beta-prod-01"]);
    assert.deepEqual(names(await h.as(fx).get("/databases?tag=customer:alpha&tag=env:prod")), ["alpha-prod-01"]);
    assert.deepEqual(names(await h.as(fx).get("/databases?tag=customer&sort=name&dir=asc")), ["alpha-dev-01", "alpha-prod-01", "beta-prod-01"]);
    assert.deepEqual(names(await h.as(fx).get("/databases?tag=!customer&sort=name&dir=asc")), ["delta-bare-01", "gamma-sbx-01"]);
    assert.deepEqual(names(await h.as(fx).get("/databases?tag=!customer&tag=env&search=gamma")), ["gamma-sbx-01"]);
    assert.equal(json(await h.as(fx).get("/databases?tag=customer:nobody")).total, 0);
  });

  test("ids: the ids of everything matching; 400 over the cap", async () => {
    const res = await h.as(fx).get("/databases/ids?tag=env:prod");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(res).ids.sort(), [ids["alpha-prod-01"], ids["beta-prod-01"]].sort());
    const tiny = await startHarness({ LIMITS_FILE: await writeLimits({ maxIdsListIds: 2 }) });
    try {
      const w = await tiny.user();
      for (const n of ["cap-aaa-01", "cap-bbb-01", "cap-ccc-01"]) await tiny.as(w).post("/databases", { name: n, region: "eu-central-1" });
      const over = await tiny.as(w).get("/databases/ids");
      assert.equal(over.statusCode, 400);
      assert.match(err(over).message, /Narrow the filter/);
      assert.equal((await tiny.as(w).get("/databases/ids?search=cap-aaa")).statusCode, 200);
    } finally { await tiny.close(); }
  });

  test("groups: counts per tag value, count desc then value, null group last, filter applies", async () => {
    const res = await h.as(fx).get("/databases/groups?groupBy=customer");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(res), {
      groupBy: "customer", total: 5,
      groups: [
        { value: "alpha", count: 2, awake: 1, keepAwake: 0, storageMb: 5 },
        { value: "beta", count: 1, awake: 1, keepAwake: 1, storageMb: 2 },
        { value: null, count: 2, awake: 0, keepAwake: 0, storageMb: 9 },
      ],
    });
    const filtered = json(await h.as(fx).get("/databases/groups?groupBy=customer&tag=env:prod"));
    assert.equal(filtered.total, 2);
    assert.deepEqual(filtered.groups.map((g: { value: string }) => g.value), ["alpha", "beta"]);
    assert.equal((await h.as(fx).get("/databases/groups")).statusCode, 400);
    assert.equal((await h.as(fx).get("/databases/groups?groupBy=Bad%20Key")).statusCode, 400);
  });

  test("tags: every tag in use, by key then count descending", async () => {
    const res = await h.as(fx).get("/tags");
    assert.deepEqual(json(res).items, [
      { key: "customer", value: "alpha", count: 2 },
      { key: "customer", value: "beta", count: 1 },
      { key: "env", value: "prod", count: 2 },
      { key: "env", value: "dev", count: 1 },
      { key: "env", value: "sandbox", count: 1 },
    ]);
  });

  test("get: 200 for mine, 404 for a missing or malformed id", async () => {
    const ok = await h.as(fx).get(`/databases/${ids["alpha-prod-01"]}`);
    assert.equal(ok.statusCode, 200);
    assert.equal(json(ok).storageMb, 5);
    const missing = await h.as(fx).get("/databases/00000000-0000-4000-8000-000000000000");
    assert.equal(missing.statusCode, 404);
    assert.equal(err(missing).code, "not_found");
    assert.equal((await h.as(fx).get("/databases/not-a-uuid")).statusCode, 404);
  });
});

describe("tags", () => {
  let fx: Fixture;
  let a: string;
  let b: string;
  before(async () => {
    fx = await h.user("Tagger");
    a = json(await create("tag-a-01", ["customer:acme", "env:dev", "app:orders"], "eu-central-1", fx)).id;
    b = json(await create("tag-b-01", ["customer:beta"], "eu-central-1", fx)).id;
  });

  test("setTags replaces the whole list; 400 for a bad tag, two values for a key, or too many", async () => {
    const ok = await h.as(fx).put(`/databases/${a}/tags`, { tags: ["customer:acme-labs", "env:staging"] });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(json(ok).tags, ["customer:acme-labs", "env:staging"]);
    assert.deepEqual(json(await h.as(fx).put(`/databases/${a}/tags`, { tags: [] })).tags, []);
    await h.as(fx).put(`/databases/${a}/tags`, { tags: ["customer:acme", "env:dev", "app:orders"] });
    for (const tags of [["nope"], ["a:1", "a:2"], Array.from({ length: 21 }, (_, i) => `k${i}:v`), "x"]) {
      const res = await h.as(fx).put(`/databases/${a}/tags`, { tags });
      assert.equal(res.statusCode, 400, JSON.stringify(tags));
      assert.equal(err(res).field, "tags");
    }
    assert.deepEqual(json(await h.as(fx).get(`/databases/${a}`)).tags, ["app:orders", "customer:acme", "env:dev"], "a failed change leaves the tags as they were");
    assert.equal((await h.as(fx).put("/databases/00000000-0000-4000-8000-000000000000/tags", { tags: [] })).statusCode, 404);
  });

  test("addTags adds, replaces the value of an existing key, counts databases", async () => {
    const res = await h.as(fx).post("/databases/tags/add", { ids: [a, b], tags: ["customer:zeta", "team:core"] });
    assert.deepEqual(json(res), { affected: 2 });
    assert.deepEqual(json(await h.as(fx).get(`/databases/${a}`)).tags, ["app:orders", "customer:zeta", "env:dev", "team:core"]);
    assert.deepEqual(json(await h.as(fx).get(`/databases/${b}`)).tags, ["customer:zeta", "team:core"]);
    assert.equal((await h.as(fx).post("/databases/tags/add", { ids: [a], tags: [] })).statusCode, 400);
    assert.equal((await h.as(fx).post("/databases/tags/add", { ids: [], tags: ["a:b"] })).statusCode, 400);
    assert.equal((await h.as(fx).post("/databases/tags/add", { ids: ["x"], tags: ["a:b"] })).statusCode, 400);
    assert.deepEqual(json(await h.as(fx).post("/databases/tags/add", { ids: [a, "00000000-0000-4000-8000-000000000000"], tags: ["x:y"] })), { affected: 1 });
  });

  test("addTags refuses to push a database past the tag limit", async () => {
    const w = await h.user("Full");
    const id = json(await create("full-tags-01", Array.from({ length: 20 }, (_, i) => `k${i}:v`), "eu-central-1", w)).id;
    const res = await h.as(w).post("/databases/tags/add", { ids: [id], tags: ["extra:one"] });
    assert.equal(res.statusCode, 400);
    assert.match(err(res).message, /more than 20 tags/);
    assert.equal((await h.as(w).post("/databases/tags/add", { ids: [id], tags: ["k3:changed"] })).statusCode, 200, "replacing a key does not add one");
  });

  test("removeTags: key:value removes that tag only, a bare key removes the key", async () => {
    await h.as(fx).put(`/databases/${a}/tags`, { tags: ["env:dev", "app:orders", "customer:acme"] });
    await h.as(fx).put(`/databases/${b}/tags`, { tags: ["env:prod", "app:billing"] });
    const res = await h.as(fx).post("/databases/tags/remove", { ids: [a, b], tags: ["env:dev", "app"] });
    assert.deepEqual(json(res), { affected: 2 });
    assert.deepEqual(json(await h.as(fx).get(`/databases/${a}`)).tags, ["customer:acme"]);
    assert.deepEqual(json(await h.as(fx).get(`/databases/${b}`)).tags, ["env:prod"], "env:dev did not match env:prod");
    assert.equal((await h.as(fx).post("/databases/tags/remove", { ids: [a], tags: [] })).statusCode, 400);
  });
});

async function writeLimits(over: Record<string, number>): Promise<string> {
  const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = JSON.parse(readFileSync(new URL("../../config/limits.json", import.meta.url), "utf8"));
  const f = join(mkdtempSync(join(tmpdir(), "cp-limits-")), "limits.json");
  writeFileSync(f, JSON.stringify({ ...base, ...over }));
  return f;
}
