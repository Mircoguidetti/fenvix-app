import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { type Fixture, type Harness, json, startHarness } from "../helpers/harness.ts";

/**
 * The public usage routes (docs/public-api.md, "Usage"): GET /usage, GET /databases/{id}/usage, GET /usage/export.
 * The expected numbers are worked out here from the seeded rows, independently of services/usage.ts, and the
 * database route is also compared with the dashboard's own database chart.
 */
let h: Harness;
let owner: Fixture;
let other: Fixture;
let adminKey = "";
let readKey = "";
let otherKey = "";
const db: Record<"a" | "b" | "empty", string> = { a: "", b: "", empty: "" };
let otherDb = "";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const isoZ = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const inOrg = (f: Fixture) => ({ "x-fenvix-workspace": f.workspaceId });

interface Row { db: string; t: number; requests: number; storage: number }
const hourly: Row[] = [];
const daily: Row[] = [];

type Range = "24h" | "7d" | "30d";
/** The grid of the dashboard's database charts, worked out again here. */
function grid(range: Range, now = Date.now()) {
  if (range === "30d") {
    const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    return { step: DAY, count: 30, first: today - 29 * DAY };
  }
  const step = range === "24h" ? HOUR : 6 * HOUR;
  const count = range === "24h" ? 24 : 28;
  return { step, count, first: Math.floor(now / step) * step - (count - 1) * step };
}

/** Per bucket and database: requests summed, newest storage; per bucket: added up over databases. */
function expected(range: Range, dbs: string[]) {
  const g = grid(range);
  const rows = (range === "30d" ? daily : hourly).filter((r) => dbs.includes(r.db));
  const per = new Map<string, { i: number; db: string; requests: number; storage: number; t: number }>();
  for (const r of rows) {
    const i = Math.floor((r.t - g.first) / g.step);
    if (i < 0 || i >= g.count) continue;
    const k = `${r.db}|${i}`;
    const p = per.get(k) ?? { i, db: r.db, requests: 0, storage: 0, t: -Infinity };
    p.requests += r.requests;
    if (r.t > p.t) { p.t = r.t; p.storage = r.storage; }
    per.set(k, p);
  }
  const items = Array.from({ length: g.count }, (_, i) => ({ at: isoZ(g.first + i * g.step), requests: 0, storageBytes: 0, activeDatabases: 0 }));
  const latest = new Map<string, { i: number; storage: number }>();
  for (const p of per.values()) {
    const b = items[p.i]!;
    b.requests += p.requests;
    b.storageBytes += p.storage;
    if (p.requests > 0) b.activeDatabases++;
    if ((latest.get(p.db)?.i ?? -1) < p.i) latest.set(p.db, { i: p.i, storage: p.storage });
  }
  return {
    range, from: isoZ(g.first), to: isoZ(g.first + g.count * g.step), bucketSeconds: g.step / 1000,
    totals: { requests: items.reduce((n, b) => n + b.requests, 0), storageBytes: [...latest.values()].reduce((n, l) => n + l.storage, 0) },
    items,
  };
}

async function seed(table: "usage_hourly" | "usage_daily", ws: string, r: Row) {
  const at = table === "usage_daily" ? dayKey(r.t) : new Date(r.t);
  await h.admin.query(`insert into public.${table} (database_id, workspace_id, ${table === "usage_daily" ? "day" : "hour"}, requests, storage_bytes) values ($1, $2, $3, $4, $5)`,
    [r.db, ws, at, r.requests, r.storage]);
}

async function makeDb(key: string, name: string) {
  const r = await h.as(key).post("/public/databases", { name, region: "eu-central-1" });
  assert.equal(r.statusCode, 201, r.body);
  return json(r).id as string;
}

before(async () => {
  h = await startHarness({ RATE_LIMIT_PER_MINUTE: "100000", PUBLIC_API_RATE_LIMIT_PER_MINUTE: "100000" });
  owner = await h.user("Usage Owner");
  other = await h.user("Other Org");
  adminKey = json(await h.as(owner).post("/public/api-keys", { name: "admin", role: "admin" }, inOrg(owner))).token;
  readKey = json(await h.as(adminKey).post("/public/api-keys", { name: "reader", role: "read_only" })).token;
  otherKey = json(await h.as(other).post("/public/api-keys", { name: "other", role: "admin" }, inOrg(other))).token;
  db.a = await makeDb(adminKey, "pu-a");
  db.b = await makeDb(adminKey, "pu-b");
  db.empty = await makeDb(adminKey, "pu-empty");
  otherDb = await makeDb(otherKey, "pu-other");

  const hour = Math.floor(Date.now() / HOUR) * HOUR;
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  // 200 hours: past the 168 of 7d, so the start of the range is tested; one row 3 hours ahead that no range holds.
  for (let k = -3; k < 200; k++) {
    if (k < 0 && k !== -3) continue;
    hourly.push({ db: db.a, t: hour - k * HOUR, requests: k % 4 === 0 ? 0 : 5 + k, storage: 1_000_000_000 + k * 1000 });
    if (k % 3 === 0) hourly.push({ db: db.b, t: hour - k * HOUR, requests: 3, storage: 2_000_000_000 - k });
    hourly.push({ db: otherDb, t: hour - k * HOUR, requests: 900_000, storage: 9_000_000_000 });
  }
  // 41 days: past the 30 of 30d.
  for (let d = 0; d <= 40; d++) {
    daily.push({ db: db.a, t: today - d * DAY, requests: 1000 + d, storage: 5_000_000_000 - d * 10_000 });
    if (d % 2 === 0) daily.push({ db: db.b, t: today - d * DAY, requests: d === 4 ? 0 : 7 * d, storage: 300_000 + d });
    daily.push({ db: otherDb, t: today - d * DAY, requests: 900_000, storage: 9_000_000_000 });
  }
  const wsOf = (r: Row) => (r.db === otherDb ? other.workspaceId : owner.workspaceId);
  for (const r of hourly) await seed("usage_hourly", wsOf(r), r);
  for (const r of daily) await seed("usage_daily", wsOf(r), r);
});
after(async () => { await h.close(); });

const RANGES: Range[] = ["24h", "7d", "30d"];

describe("numbers", () => {
  for (const range of RANGES) {
    test(`${range}: the organization's usage is every database's, bucket by bucket`, async () => {
      const r = await h.as(adminKey).get(`/public/usage?range=${range}`);
      assert.equal(r.statusCode, 200, r.body);
      assert.ok(r.headers["x-request-id"]);
      assert.equal(r.headers["cache-control"], "no-store");
      const u = json(r);
      assert.deepEqual(u, { ...expected(range, [db.a, db.b, db.empty]), databaseId: null });
      assert.equal(u.items.length, { "24h": 24, "7d": 28, "30d": 30 }[range]);
      assert.ok(u.totals.requests > 0 && u.totals.storageBytes > 0);
      // Never another organization's rows (they would add 900000 a bucket).
      assert.ok(u.items.every((b: { requests: number }) => b.requests < 900_000));
    });

    test(`${range}: one database, by both routes, and the same as the dashboard's database chart`, async () => {
      for (const id of [db.a, db.b]) {
        const byPath = json(await h.as(adminKey).get(`/public/databases/${id}/usage?range=${range}`));
        assert.deepEqual(byPath, { ...expected(range, [id]), databaseId: id });
        const byQuery = json(await h.as(adminKey).get(`/public/usage?range=${range}&databaseId=${id.toUpperCase()}`));
        assert.deepEqual(byQuery, byPath);
        const chart = json(await h.as(owner).get(`/databases/${id}/usage?range=${range}`)).items as { at: string; requests: number; storageMb: number; awake: boolean }[];
        assert.deepEqual(chart.map((p) => p.at), byPath.items.map((b: { at: string }) => b.at));
        assert.deepEqual(chart.map((p) => p.requests), byPath.items.map((b: { requests: number }) => b.requests));
        assert.deepEqual(chart.map((p) => p.storageMb), byPath.items.map((b: { storageBytes: number }) => Math.floor(b.storageBytes / 1048576)));
        assert.deepEqual(chart.map((p) => p.awake), byPath.items.map((b: { activeDatabases: number }) => b.activeDatabases === 1));
      }
    });
  }

  test("spot checks: the current hour, today, a day without requests, and storage at the end of the range", async () => {
    const day = json(await h.as(adminKey).get(`/public/databases/${db.a}/usage?range=24h`));
    assert.equal(day.items[23].requests, 0, "k = 0: no requests");
    assert.equal(day.items[22].requests, 6, "k = 1");
    assert.equal(day.items[23].storageBytes, 1_000_000_000);
    assert.equal(day.totals.storageBytes, 1_000_000_000, "the newest value, not the one 3 hours ahead");
    const month = json(await h.as(adminKey).get("/public/usage?range=30d"));
    assert.equal(month.items[29].requests, 1000 + 0);
    assert.equal(month.items[29].activeDatabases, 1, "today pu-b has a row with 0 requests (7 * 0)");
    assert.equal(month.items[25].activeDatabases, 1, "day 4: pu-b has a row with 0 requests");
    assert.equal(month.items[25].storageBytes, 5_000_000_000 - 40_000 + 300_004, "a database with 0 requests still stores bytes");
    assert.equal(month.totals.storageBytes, 5_000_000_000 + 300_000);
    assert.equal(month.totals.requests, Array.from({ length: 30 }, (_, d) => 1000 + d + (d % 2 === 0 && d !== 4 ? 7 * d : 0)).reduce((a, b) => a + b, 0));
  });
});

describe("no data", () => {
  test("a database without usage: every bucket zero, totals zero", async () => {
    for (const range of RANGES) {
      const r = await h.as(adminKey).get(`/public/databases/${db.empty}/usage?range=${range}`);
      assert.equal(r.statusCode, 200, r.body);
      const u = json(r);
      assert.deepEqual(u.totals, { requests: 0, storageBytes: 0 });
      assert.ok(u.items.length > 0 && u.items.every((b: Record<string, number>) => b.requests === 0 && b.storageBytes === 0 && b.activeDatabases === 0));
    }
  });

  test("an organization without databases: zeros", async () => {
    const lone = await h.user("Lonely");
    const key = json(await h.as(lone).post("/public/api-keys", { name: "k", role: "read_only" }, inOrg(lone))).token;
    for (const range of RANGES) {
      const u = json(await h.as(key).get(`/public/usage?range=${range}`));
      assert.deepEqual(u.totals, { requests: 0, storageBytes: 0 });
      assert.equal(u.items.length, { "24h": 24, "7d": 28, "30d": 30 }[range]);
    }
  });
});

describe("access", () => {
  test("a read_only key reads all three routes", async () => {
    assert.equal((await h.as(readKey).get("/public/usage?range=7d")).statusCode, 200);
    assert.equal((await h.as(readKey).get(`/public/databases/${db.a}/usage?range=30d`)).statusCode, 200);
    assert.equal((await h.as(readKey).get(`/public/usage/export?month=${new Date().toISOString().slice(0, 7)}&by=database`)).statusCode, 200);
  });

  test("a revoked or an expired key is refused with 401", async () => {
    const made = json(await h.as(adminKey).post("/public/api-keys", { name: "soon revoked", role: "read_only" }));
    assert.equal((await h.as(made.token).get("/public/usage?range=24h")).statusCode, 200);
    assert.equal((await h.as(adminKey).del(`/public/api-keys/${made.key.id}`)).statusCode, 200);
    const expired = `fvx_${randomBytes(32).toString("base64url")}`;
    await h.admin.query(
      `insert into public.public_api_keys (workspace_id, name, role, key_hash, prefix, created_by_type, created_by, created_at, expires_at)
       values ($1, 'old', 'read_only', $2, $3, 'user', $4, now() - interval '2 days', now() - interval '1 day')`,
      [owner.workspaceId, sha(expired), expired.slice(0, 12), owner.userId]);
    for (const key of [made.token, expired, "fvx_nope"]) {
      for (const url of ["/public/usage?range=24h", `/public/databases/${db.a}/usage?range=24h`, "/public/usage/export?month=2026-01&by=database"]) {
        const r = await h.as(key).get(url);
        assert.equal(r.statusCode, 401, url);
        assert.equal(json(r).error.code, "unauthenticated");
      }
    }
    // A dashboard session is not a key.
    assert.equal((await h.as(owner).get("/public/usage?range=24h", inOrg(owner))).statusCode, 401);
  });

  test("404 for another organization's database, an id that is not one, and a database still being created", async () => {
    for (const url of [`/public/databases/${otherDb}/usage?range=24h`, `/public/usage?range=24h&databaseId=${otherDb}`,
      "/public/databases/nope/usage?range=24h", "/public/usage?range=24h&databaseId=nope", "/public/usage?range=24h&databaseId="]) {
      const r = await h.as(adminKey).get(url);
      assert.equal(r.statusCode, 404, url);
      assert.equal(json(r).error.code, "not_found");
      assert.ok(!r.body.includes("pu-other"));
    }
    await h.admin.query("update public.databases set engine_state = 'provisioning' where id = $1", [db.b]);
    try {
      assert.equal((await h.as(adminKey).get(`/public/databases/${db.b}/usage?range=24h`)).statusCode, 404);
      assert.equal((await h.as(adminKey).get(`/public/usage?range=24h&databaseId=${db.b}`)).statusCode, 404);
    } finally {
      await h.admin.query("update public.databases set engine_state = 'ready' where id = $1", [db.b]);
    }
  });

  test("400 for a missing or unknown range and for parameters a route does not take", async () => {
    for (const [url, field] of [["/public/usage", "range"], ["/public/usage?range=1y", "range"], [`/public/databases/${db.a}/usage`, "range"],
      ["/public/usage?range=24h&limit=5", "limit"], [`/public/databases/${db.a}/usage?range=24h&databaseId=${db.a}`, "databaseId"],
      ["/public/usage/export?month=2026-13&by=database", "month"], ["/public/usage/export?month=2026-01&by=everything", "by"],
      ["/public/usage/export?month=2026-01&by=database&tagKey=customer", "tagKey"]]) {
      const r = await h.as(adminKey).get(url!);
      assert.equal(r.statusCode, 400, url);
      assert.equal(json(r).error.field, field, url);
    }
  });
});

describe("monthly CSV", () => {
  test("a signed link to the dashboard's CSV, with this organization's databases only", async () => {
    const month = new Date().toISOString().slice(0, 7);
    const r = await h.as(readKey).get(`/public/usage/export?month=${month}&by=database&sort=name&dir=asc`);
    assert.equal(r.statusCode, 200, r.body);
    const x = json(r);
    assert.equal(x.filename, `fenvix-usage-${month}-by-database.csv`);
    assert.equal(x.mimeType, "text/csv");
    assert.ok(x.downloadUrl.startsWith("https://api.fenvix.test/v1/downloads/"));
    assert.ok(Date.parse(x.expiresAt) > Date.now() && Date.parse(x.expiresAt) <= Date.now() + 16 * 60_000);
    const file = await h.app.fastify.inject(x.downloadUrl.replace("https://api.fenvix.test", ""));
    assert.equal(file.statusCode, 200);
    assert.match(String(file.headers["content-type"]), /text\/csv/);
    const lines = file.body.trim().split("\n");
    assert.equal(lines[0], "database,tags,storage_gb_avg,requests");
    const monthStart = Date.parse(`${month}-01T00:00:00Z`);
    const sum = (id: string) => daily.filter((d) => d.db === id && d.t >= monthStart).reduce((n, d) => n + d.requests, 0);
    assert.equal(lines.find((l) => l.startsWith("pu-a,"))!.split(",").at(-1), String(sum(db.a)));
    assert.ok(!file.body.includes("pu-other"));
    assert.ok(!lines.some((l) => l.startsWith("pu-empty,")), "the report lists databases with usage in the month");
    // The other organization's export never holds this one's databases.
    const theirs = json(await h.as(otherKey).get(`/public/usage/export?month=${month}&by=database`));
    const body = (await h.app.fastify.inject(theirs.downloadUrl.replace("https://api.fenvix.test", ""))).body;
    assert.ok(body.includes("pu-other") && !body.includes("pu-a") && !body.includes("pu-b"));
  });

  test("a month without usage is a 400 on month", async () => {
    const r = await h.as(adminKey).get("/public/usage/export?month=2001-01&by=tag");
    assert.equal(r.statusCode, 400);
    assert.equal(json(r).error.field, "month");
  });
});
