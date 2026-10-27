import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type Fixture, type Harness, json, startHarness } from "../helpers/harness.ts";

/** Numbers below are fixtures for the tests only. The shipped plans.json carries no price. */
const TEST_RATES = { storagePerGbMonth: 0.5, requestsPerMillion: 2 };
const GIB = 1073741824;
const DAY = 86400000;

let h: Harness;
let u: Fixture;
const dbs: { id: string; name: string; customer: string | null; storage: number }[] = [];
const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const FIRST_DAY = today.getTime() - 45 * DAY;
/** Requests of database i on a day (fixture formula). */
const req = (i: number, ms: number) => (i + 1) * 100 + (Math.round((ms - FIRST_DAY) / DAY) % 7) * 10;

const err = (res: { body: string }) => json(res).error as { code: string; message: string; field?: string };
const round2 = (n: number) => Math.round(n * 100) / 100;

before(async () => {
  const plans = JSON.parse(readFileSync(new URL("../../config/plans.json", import.meta.url), "utf8"));
  plans.rates = TEST_RATES;
  const f = join(mkdtempSync(join(tmpdir(), "cp-usage-")), "plans.json");
  writeFileSync(f, JSON.stringify(plans));
  h = await startHarness({ PLANS_FILE: f, RATE_LIMIT_PER_MINUTE: "100000" });
  u = await h.user("Usage Ursula");

  const defs: [string, string | null][] = [["use-a-01", "acme"], ["use-b-01", "acme"], ["use-c-01", "zeta"], ["use-d-01", null]];
  for (const [i, [name, customer]] of defs.entries()) {
    const r = await h.as(u).post("/databases", { name, region: "eu-central-1", tags: customer ? [`customer:${customer}`, "env:prod"] : ["env:dev"] });
    assert.equal(r.statusCode, 201, r.body);
    dbs.push({ id: json(r).id, name, customer, storage: (i + 1) * GIB });
    await h.admin.query("update public.databases set created_at = now() - interval '50 days', storage_bytes = $2, requests_24h = $3, state = $4 where id = $1", [json(r).id, (i + 1) * GIB, (i + 1) * 1000, i === 0 ? "awake" : "asleep"]);
  }
  for (const [i, d] of dbs.entries()) {
    for (let ms = FIRST_DAY; ms <= today.getTime(); ms += DAY) {
      await h.admin.query("insert into public.usage_daily (database_id, workspace_id, day, requests, storage_bytes) values ($1, $2, $3, $4, $5)", [d.id, u.workspaceId, dayKey(ms), req(i, ms), d.storage]);
    }
    const hour = Math.floor(Date.now() / 3600000) * 3600000;
    for (let k = 0; k < 60; k++) {
      await h.admin.query("insert into public.usage_hourly (database_id, workspace_id, hour, requests, storage_bytes) values ($1, $2, $3, $4, $5)", [d.id, u.workspaceId, new Date(hour - k * 3600000), i === 3 ? 0 : (k % 5 === 0 ? 0 : 10 * (i + 1)), d.storage]);
    }
    await h.admin.query("insert into public.wake_events (database_id, workspace_id, at, first_request_ms) values ($1, $2, now() - ($3 || ' minutes')::interval, $4)", [d.id, u.workspaceId, String(i * 10), 500 + i]);
  }
  for (let m = 0; m < 14; m++) {
    await h.admin.query("insert into public.invoices (workspace_id, number, month, issued_at, amount_cents, status) values ($1, $2, $3, $4, $5, $6)",
      [u.workspaceId, `FNX-T-${String(m).padStart(2, "0")}`, new Date(Date.UTC(2025, m, 1)), new Date(Date.UTC(2025, m + 1, 1)), 10000 + m, m === 13 ? "open" : "paid"]);
  }
});
after(async () => { await h.close(); });

describe("overview", () => {
  test("7d: the shape, the series and the totals match the data", async () => {
    const res = await h.as(u).get("/overview?range=7d");
    assert.equal(res.statusCode, 200, res.body);
    const o = json(res);
    assert.equal(o.range, "7d");
    assert.deepEqual(Object.keys(o).sort(), ["awakeSeries", "costSeries", "range", "recentWakeUps", "requestSeries", "sparks", "topDatabases", "totals"]);
    assert.equal(o.requestSeries.length, 7);
    const expectedDays = Array.from({ length: 7 }, (_, k) => today.getTime() - (6 - k) * DAY);
    assert.deepEqual(o.requestSeries.map((p: { at: string }) => p.at), expectedDays.map((ms) => new Date(ms).toISOString().replace(".000Z", "Z")));
    assert.deepEqual(o.requestSeries.map((p: { requests: number }) => p.requests), expectedDays.map((ms) => dbs.reduce((n, _d, i) => n + req(i, ms), 0)));
    assert.deepEqual(o.awakeSeries.map((p: { awake: number }) => p.awake), expectedDays.map(() => 4), "every database served requests every day");
    assert.ok(o.awakeSeries.every((p: { total: number }) => p.total === 4));
    assert.equal(o.totals.requests, o.requestSeries.reduce((n: number, p: { requests: number }) => n + p.requests, 0));
    assert.deepEqual({ ...o.totals, costMtd: 0, requests: 0 }, { databases: 4, awake: 1, asleep: 3, asleepPercent: 75, requests: 0, storageGb: 10, costMtd: 0, currency: "USD" });
  });

  test("cost this month: running totals from the rates in the plans file; reference is the month before", async () => {
    const o = json(await h.as(u).get("/overview?range=7d"));
    const dim = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const y = today.getUTCFullYear(), m = today.getUTCMonth();
    const costOn = (ms: number, days: number) => dbs.reduce((n, d, i) => n + (req(i, ms) / 1e6) * TEST_RATES.requestsPerMillion + (d.storage / GIB) * TEST_RATES.storagePerGbMonth / days, 0);
    assert.equal(o.costSeries.length, dim(y, m));
    let run = 0;
    for (const [k, p] of o.costSeries.entries()) {
      const ms = Date.UTC(y, m, 1 + k);
      if (ms <= today.getTime()) { run += costOn(ms, dim(y, m)); assert.equal(p.cost, round2(run), `day ${k + 1}`); } else assert.equal(p.cost, 0, `future day ${k + 1}`);
      assert.equal(p.at, new Date(ms).toISOString().replace(".000Z", "Z"));
    }
    assert.equal(o.totals.costMtd, round2(run));
    assert.ok(o.totals.costMtd > 0);
    const prevDays = dim(y, m - 1);
    o.costSeries.forEach((p: { reference: number | null }, k: number) => { if (k >= prevDays) assert.equal(p.reference, null); else assert.equal(typeof p.reference, "number"); });
    const sparks = o.sparks;
    assert.deepEqual(Object.keys(sparks).sort(), ["awake", "cost", "databases", "requests", "storageGb"]);
    for (const k of Object.keys(sparks)) assert.ok(sparks[k].length >= 1 && sparks[k].length <= 12, k);
    assert.deepEqual(sparks.requests, o.requestSeries.map((p: { requests: number }) => p.requests), "7 points are kept as they are");
  });

  test("24h: 24 hourly points; 30d: 30 daily points", async () => {
    const day = json(await h.as(u).get("/overview?range=24h"));
    assert.equal(day.requestSeries.length, 24);
    assert.equal(new Date(day.requestSeries[23].at).getUTCMinutes(), 0);
    const thisHour = Math.floor(Date.now() / 3600000) * 3600000;
    assert.equal(new Date(day.requestSeries[23].at).getTime(), thisHour);
    assert.equal(day.requestSeries[23].requests, 0, "hour k=0 has no requests (k % 5 = 0)");
    assert.equal(day.requestSeries[22].requests, 10 + 20 + 30 + 0, "hour k=1: databases a, b, c serve 10, 20, 30; d serves nothing");
    assert.deepEqual(day.awakeSeries[22].awake, 3);
    const month = json(await h.as(u).get("/overview?range=30d"));
    assert.equal(month.requestSeries.length, 30);
    assert.ok(month.sparks.requests.length === 12);
  });

  test("top databases are the ten busiest by 24h requests; recent wake-ups newest first", async () => {
    const o = json(await h.as(u).get("/overview?range=7d"));
    assert.deepEqual(o.topDatabases.map((t: { name: string }) => t.name), ["use-d-01", "use-c-01", "use-b-01", "use-a-01"]);
    assert.deepEqual(o.topDatabases[0], { id: dbs[3]!.id, name: "use-d-01", requests: 4000 });
    assert.deepEqual(o.recentWakeUps.map((w: { name: string }) => w.name), ["use-a-01", "use-b-01", "use-c-01", "use-d-01"]);
    assert.deepEqual(Object.keys(o.recentWakeUps[0]).sort(), ["at", "id", "latencyMs", "name"]);
    assert.equal(o.recentWakeUps[0].latencyMs, 500);
  });

  test("400 for a missing or unknown range", async () => {
    assert.equal(err(await h.as(u).get("/overview")).field, "range");
    assert.equal((await h.as(u).get("/overview?range=1y")).statusCode, 400);
  });

  test("an empty workspace gets zeros, not errors", async () => {
    const e = await h.user("Empty");
    const o = json(await h.as(e).get("/overview?range=7d"));
    assert.equal(o.totals.databases, 0);
    assert.equal(o.totals.asleepPercent, 0);
    assert.equal(o.requestSeries.length, 7);
    assert.deepEqual(o.topDatabases, []);
  });
});

describe("tag breakdown", () => {
  test("biggest first by requests (ties: storage, then value), databases without the key under (none), limit applies", async () => {
    const res = await h.as(u).get("/tags/breakdown?key=customer");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(res).items, [
      { value: "(none)", databases: 1, storageGb: 4, requests: 4000 },
      { value: "acme", databases: 2, storageGb: 3, requests: 3000 },
      { value: "zeta", databases: 1, storageGb: 3, requests: 3000 },
    ]);
    assert.equal(json(await h.as(u).get("/tags/breakdown?key=customer&limit=1")).items.length, 1);
    assert.equal((await h.as(u).get("/tags/breakdown")).statusCode, 400);
    assert.equal((await h.as(u).get("/tags/breakdown?key=customer&limit=51")).statusCode, 400);
  });
});

describe("one database's usage", () => {
  test("24h: 24 hourly points oldest first; 7d: 28 six-hourly; 30d: 30 daily", async () => {
    const d = dbs[0]!;
    const h24 = json(await h.as(u).get(`/databases/${d.id}/usage?range=24h`)).items;
    assert.equal(h24.length, 24);
    assert.deepEqual(h24.map((p: { at: string }) => p.at), [...h24.map((p: { at: string }) => p.at)].sort());
    const thisHour = Math.floor(Date.now() / 3600000) * 3600000;
    assert.equal(new Date(h24[23].at).getTime(), thisHour);
    assert.deepEqual(h24[23], { at: new Date(thisHour).toISOString().replace(".000Z", "Z"), requests: 0, storageMb: 1024, awake: false });
    assert.deepEqual(h24[22], { at: new Date(thisHour - 3600000).toISOString().replace(".000Z", "Z"), requests: 10, storageMb: 1024, awake: true });

    const d7 = json(await h.as(u).get(`/databases/${d.id}/usage?range=7d`)).items;
    assert.equal(d7.length, 28);
    assert.ok(d7.every((p: { at: string }) => new Date(p.at).getUTCHours() % 6 === 0));
    const total7 = d7.reduce((n: number, p: { requests: number }) => n + p.requests, 0);
    const expected = (await h.admin.query("select sum(requests)::int as n from public.usage_hourly where database_id = $1 and hour >= $2", [d.id, new Date(Math.floor(Date.now() / 21600000) * 21600000 - 27 * 21600000)])).rows[0].n;
    assert.equal(total7, expected);

    const d30 = json(await h.as(u).get(`/databases/${d.id}/usage?range=30d`)).items;
    assert.equal(d30.length, 30);
    assert.deepEqual(d30.map((p: { requests: number }) => p.requests), Array.from({ length: 30 }, (_, k) => req(0, today.getTime() - (29 - k) * DAY)));
    assert.deepEqual(Object.keys(d30[0]).sort(), ["at", "awake", "requests", "storageMb"]);
    assert.ok(d30.every((p: { awake: boolean }) => p.awake));
  });

  test("a database with no data still answers with the full number of points", async () => {
    const e = await h.user("NoData");
    const id = json(await h.as(e).post("/databases", { name: "nodata-01", region: "eu-central-1" })).id;
    for (const [range, n] of [["24h", 24], ["7d", 28], ["30d", 30]] as const) {
      const items = json(await h.as(e).get(`/databases/${id}/usage?range=${range}`)).items;
      assert.equal(items.length, n);
      assert.ok(items.every((p: { requests: number; awake: boolean }) => p.requests === 0 && p.awake === false));
    }
  });

  test("400 for a missing or unknown range, 404 for an unknown database", async () => {
    assert.equal((await h.as(u).get(`/databases/${dbs[0]!.id}/usage`)).statusCode, 400);
    assert.equal((await h.as(u).get(`/databases/${dbs[0]!.id}/usage?range=1h`)).statusCode, 400);
    assert.equal((await h.as(u).get("/databases/00000000-0000-4000-8000-000000000000/usage?range=7d")).statusCode, 404);
  });
});

describe("monthly usage", () => {
  const thisMonth = today.toISOString().slice(0, 7);
  const monthsSeeded = (() => { const out = new Set<string>(); for (let ms = FIRST_DAY; ms <= today.getTime(); ms += DAY) out.add(dayKey(ms).slice(0, 7)); return [...out].sort().reverse(); })();
  const inMonth = (i: number, month: string) => { let sum = 0; let n = 0; for (let ms = FIRST_DAY; ms <= today.getTime(); ms += DAY) if (dayKey(ms).startsWith(month)) { sum += req(i, ms); n++; } return { sum, n }; };

  test("months with a report, newest first, the running month first", async () => {
    const res = await h.as(u).get("/usage/months");
    assert.deepEqual(json(res).items, monthsSeeded);
    assert.equal(json(res).items[0], thisMonth);
  });

  test("by database: rows, totals over everything, paging, sorting", async () => {
    const res = await h.as(u).get(`/usage?month=${thisMonth}&by=database&sort=requests&dir=desc`);
    assert.equal(res.statusCode, 200, res.body);
    const r = json(res);
    assert.deepEqual([r.month, r.page, r.pageSize, r.total], [thisMonth, 1, 50, 4]);
    assert.deepEqual(r.items.map((x: { name: string }) => x.name), ["use-d-01", "use-c-01", "use-b-01", "use-a-01"]);
    assert.deepEqual(r.items[0], { id: dbs[3]!.id, name: "use-d-01", tags: ["env:dev"], databases: 1, storageGb: 4, requests: inMonth(3, thisMonth).sum });
    assert.equal(r.totals.databases, 4);
    assert.equal(r.totals.storageGb, 10);
    assert.equal(r.totals.requests, [0, 1, 2, 3].reduce((n, i) => n + inMonth(i, thisMonth).sum, 0));
    const p2 = json(await h.as(u).get(`/usage?month=${thisMonth}&by=database&sort=name&dir=asc&page=2&pageSize=3`));
    assert.deepEqual([p2.items.map((x: { name: string }) => x.name), p2.total, p2.page, p2.pageSize], [["use-d-01"], 4, 2, 3]);
    assert.equal(p2.totals.databases, 4, "totals cover every database, not only this page");
    assert.deepEqual(json(await h.as(u).get(`/usage?month=${thisMonth}&by=database&page=9`)).items, []);
    const asc = json(await h.as(u).get(`/usage?month=${thisMonth}&by=database&sort=storageGb&dir=asc`)).items.map((x: { name: string }) => x.name);
    assert.deepEqual(asc, ["use-a-01", "use-b-01", "use-c-01", "use-d-01"]);
  });

  test("by tag with tagKey: one row per value, databases without the key as key:(none)", async () => {
    const r = json(await h.as(u).get(`/usage?month=${thisMonth}&by=tag&tagKey=customer&sort=name&dir=asc`));
    assert.deepEqual(r.items.map((x: { name: string }) => x.name), ["customer:(none)", "customer:acme", "customer:zeta"]);
    const acme = r.items.find((x: { name: string }) => x.name === "customer:acme");
    assert.deepEqual(acme, { id: "customer:acme", name: "customer:acme", tags: [], databases: 2, storageGb: 3, requests: inMonth(0, thisMonth).sum + inMonth(1, thisMonth).sum });
    assert.equal(r.total, 3);
    assert.equal(r.totals.databases, 4);
    assert.equal(json(await h.as(u).get(`/usage?month=${thisMonth}&by=tag&tagKey=customer&sort=databases&dir=desc`)).items[0].name, "customer:acme");
  });

  test("by tag without tagKey: one row per key:value; a database with two tags counts once in totals", async () => {
    const r = json(await h.as(u).get(`/usage?month=${thisMonth}&by=tag&sort=name&dir=asc`));
    assert.deepEqual(r.items.map((x: { name: string }) => x.name), ["customer:acme", "customer:zeta", "env:dev", "env:prod"]);
    assert.equal(r.items.find((x: { name: string }) => x.name === "env:prod").databases, 3);
    assert.equal(r.totals.databases, 4);
    assert.equal(r.totals.requests, [0, 1, 2, 3].reduce((n, i) => n + inMonth(i, thisMonth).sum, 0));
  });

  test("400: month without a report, bad month, missing or unknown by/sort, tagKey without by=tag, sort=databases by database", async () => {
    for (const [q, field] of [
      ["month=2020-01&by=database", "month"], ["month=202010&by=database", "month"], ["by=database", "month"], [`month=${thisMonth}`, "by"],
      [`month=${thisMonth}&by=team`, "by"], [`month=${thisMonth}&by=database&tagKey=customer`, "tagKey"], [`month=${thisMonth}&by=database&sort=databases`, "sort"],
      [`month=${thisMonth}&by=database&sort=color`, "sort"], [`month=${thisMonth}&by=database&dir=sideways`, "dir"],
    ] as const) {
      const res = await h.as(u).get(`/usage?${q}`);
      assert.equal(res.statusCode, 400, q);
      assert.equal(err(res).field, field, q);
    }
  });

  test("history: totals per month, oldest first", async () => {
    const items = json(await h.as(u).get("/usage/history")).items;
    assert.deepEqual(items.map((x: { month: string }) => x.month), [...monthsSeeded].reverse());
    const last = items.at(-1);
    assert.deepEqual(Object.keys(last).sort(), ["databases", "month", "requests", "storageGb"]);
    assert.equal(last.databases, 4);
    assert.equal(last.storageGb, 10);
    assert.equal(last.requests, [0, 1, 2, 3].reduce((n, i) => n + inMonth(i, thisMonth).sum, 0));
  });
});

describe("usage trend", () => {
  test("days and series have equal length; the top five values plus Other, Other last", async () => {
    const e = await h.user("Trend");
    const month = today.toISOString().slice(0, 7);
    for (let i = 0; i < 7; i++) {
      const id = json(await h.as(e).post("/databases", { name: `trend-${i}-01`, region: "eu-central-1", tags: [`customer:c${i}`] })).id;
      for (let ms = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1); ms <= today.getTime(); ms += DAY) {
        await h.admin.query("insert into public.usage_daily (database_id, workspace_id, day, requests, storage_bytes) values ($1, $2, $3, $4, 1)", [id, e.workspaceId, dayKey(ms), (i + 1) * 1000]);
      }
    }
    const r = json(await h.as(e).get(`/usage/trend?month=${month}&tagKey=customer`));
    const n = today.getUTCDate();
    assert.equal(r.days.length, n);
    assert.equal(r.days[0], `${month}-01T00:00:00Z`);
    assert.deepEqual(r.series.map((s: { label: string }) => s.label), ["c6", "c5", "c4", "c3", "c2", "Other"]);
    for (const s of r.series) assert.equal(s.values.length, r.days.length, s.label);
    assert.deepEqual(r.series[0].values, new Array(n).fill(7000));
    assert.deepEqual(r.series[5].values, new Array(n).fill(3000), "c0 + c1 = 1000 + 2000");
    const few = json(await h.as(u).get(`/usage/trend?month=${month}&tagKey=customer`));
    assert.deepEqual(few.series.map((s: { label: string }) => s.label).sort(), ["(none)", "acme", "zeta"], "no Other when five or fewer");
    assert.deepEqual(json(await h.as(u).get(`/usage/trend?month=2100-01&tagKey=customer`)), { days: [], series: [] });
    assert.equal((await h.as(u).get("/usage/trend?tagKey=customer")).statusCode, 400);
    assert.equal((await h.as(u).get(`/usage/trend?month=${month}`)).statusCode, 400);
  });
});

describe("usage export (CSV)", () => {
  const month = today.toISOString().slice(0, 7);
  const fetchLink = async (url: string) => h.app.fastify.inject({ method: "GET", url: new URL(url).pathname });

  test("by database: an ExportResult whose link serves the CSV with the documented header, without any session", async () => {
    const res = await h.as(u).get(`/usage/export?month=${month}&by=database&sort=name&dir=asc`);
    assert.equal(res.statusCode, 200, res.body);
    const r = json(res);
    assert.deepEqual(Object.keys(r).sort(), ["downloadUrl", "filename", "mimeType"]);
    assert.equal(r.mimeType, "text/csv");
    assert.equal(r.filename, `fenvix-usage-${month}-by-database.csv`);
    assert.ok(r.downloadUrl.startsWith("https://api.fenvix.test/v1/downloads/"));
    const file = await fetchLink(r.downloadUrl);
    assert.equal(file.statusCode, 200);
    assert.match(String(file.headers["content-type"]), /^text\/csv/);
    assert.match(String(file.headers["content-disposition"]), /attachment; filename="fenvix-usage-/);
    const lines = file.body.split("\n");
    assert.equal(lines[0], "database,tags,storage_gb_avg,requests");
    assert.equal(lines.length, 6, "header, 4 rows, trailing newline");
    assert.equal(lines.at(-1), "");
    assert.match(lines[1]!, /^use-a-01,customer:acme env:prod,1,\d+$/);
    assert.ok(!file.body.includes("\r"));
  });

  test("by tag: header tag,databases,storage_gb_avg,requests", async () => {
    const r = json(await h.as(u).get(`/usage/export?month=${month}&by=tag&tagKey=customer&sort=name&dir=asc`));
    assert.equal(r.filename, `fenvix-usage-${month}-by-customer.csv`);
    const lines = (await fetchLink(r.downloadUrl)).body.split("\n");
    assert.equal(lines[0], "tag,databases,storage_gb_avg,requests");
    assert.match(lines[1]!, /^customer:\(none\),1,4,\d+$/);
  });

  test("the link is good for 15 minutes only and cannot be forged or reused for another workspace", async () => {
    const r = json(await h.as(u).get(`/usage/export?month=${month}&by=database`));
    const token = r.downloadUrl.split("/").pop() as string;
    const claim = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString());
    assert.ok(Math.abs(claim.exp - (Date.now() / 1000 + 900)) < 5, "expires in 15 minutes");
    assert.equal(claim.ws, u.workspaceId);
    const forged = Buffer.from(JSON.stringify({ ...claim, ws: "11111111-1111-4111-8111-111111111111" })).toString("base64url");
    assert.equal((await h.app.fastify.inject(`/v1/downloads/${forged}.${token.split(".")[1]}`)).statusCode, 404);
    assert.equal((await h.app.fastify.inject("/v1/downloads/nonsense")).statusCode, 404);
  });

  test("400 for a month without a report, with the same validation as the report", async () => {
    assert.equal((await h.as(u).get("/usage/export?month=2020-01&by=database")).statusCode, 400);
    assert.equal((await h.as(u).get("/usage/export?by=database")).statusCode, 400);
  });
});

describe("plans, billing, invoices", () => {
  test("plans: exactly one is current; the managed plan is the default; no price is shipped", async () => {
    const res = await h.as(u).get("/plans");
    const items = json(res).items;
    assert.equal(items.filter((p: { current: boolean }) => p.current).length, 1);
    assert.equal(items.find((p: { current: boolean }) => p.current).id, "managed");
    assert.deepEqual(Object.keys(items[0]).sort(), ["current", "description", "features", "id", "name", "period", "price"]);
    await h.admin.query("update public.workspace_settings set plan = 'dedicated' where workspace_id = $1", [u.workspaceId]);
    assert.equal(json(await h.as(u).get("/plans")).items.find((p: { current: boolean }) => p.current).id, "dedicated");
    await h.admin.query("update public.workspace_settings set plan = 'retired-plan' where workspace_id = $1", [u.workspaceId]);
    assert.equal(json(await h.as(u).get("/plans")).items.filter((p: { current: boolean }) => p.current).length, 1, "an unknown plan id still leaves exactly one current");
    await h.admin.query("update public.workspace_settings set plan = 'managed' where workspace_id = $1", [u.workspaceId]);
  });

  test("billing: month to date from usage and the configured rates, in the documented shape", async () => {
    const b = json(await h.as(u).get("/billing"));
    assert.deepEqual(Object.keys(b).sort(), ["currency", "monthToDate", "paymentMethod", "plan"]);
    assert.equal(b.currency, "USD");
    assert.deepEqual(b.plan, { name: "Managed", description: "Pay for what you use." });
    const dim = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
    let requests = 0; let storage = 0;
    for (let ms = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1); ms <= today.getTime(); ms += DAY) dbs.forEach((d, i) => { requests += req(i, ms); storage += d.storage; });
    const gbMonths = round2(storage / GIB / dim);
    assert.equal(b.monthToDate.lines[0].label, "Storage");
    assert.equal(b.monthToDate.lines[0].quantity, `${gbMonths.toFixed(2)} GB-months`.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
    assert.equal(b.monthToDate.lines[0].rate, "$0.50 per GB-month");
    assert.equal(b.monthToDate.lines[0].cost, round2(gbMonths * 0.5));
    assert.equal(b.monthToDate.lines[1].label, "Requests");
    assert.equal(b.monthToDate.lines[1].quantity, `${new Intl.NumberFormat("en-US").format(requests)} requests`);
    assert.equal(b.monthToDate.lines[1].rate, "$2.00 per million");
    assert.equal(b.monthToDate.lines[1].cost, round2((requests / 1e6) * 2));
    assert.equal(b.monthToDate.total, round2(b.monthToDate.lines[0].cost + b.monthToDate.lines[1].cost));
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    assert.equal(b.monthToDate.periodLabel, `${months[today.getUTCMonth()]} 1 to ${today.getUTCDate()}, ${today.getUTCFullYear()}`);
    assert.deepEqual(Object.keys(b.paymentMethod).sort(), ["brand", "expires", "last4"]);
    assert.equal(b.total, undefined);
  });

  test("with the shipped plans file (no rates) every cost is 0 and the page says pricing is not set", async () => {
    const t = await startHarness();
    try {
      const w = await t.user();
      const id = json(await t.as(w).post("/databases", { name: "norate-01", region: "eu-central-1" })).id;
      await t.admin.query("insert into public.usage_daily (database_id, workspace_id, day, requests, storage_bytes) values ($1, $2, current_date, 5000000, 5368709120)", [id, w.workspaceId]);
      const b = json(await t.as(w).get("/billing"));
      assert.equal(b.monthToDate.total, 0);
      assert.deepEqual(b.monthToDate.lines.map((l: { rate: string; cost: number }) => [l.rate, l.cost]), [["Pricing not set", 0], ["Pricing not set", 0]]);
      assert.equal(json(await t.as(w).get("/overview?range=7d")).totals.costMtd, 0);
      assert.deepEqual(json(await t.as(w).get("/plans")).items.map((p: { price: string }) => p.price), ["", "", "", ""]);
    } finally { await t.close(); }
  });

  test("invoices: newest first, 12 per page by default, paging and the Invoice shape", async () => {
    const r = json(await h.as(u).get("/invoices"));
    assert.deepEqual([r.items.length, r.total, r.page, r.pageSize], [12, 14, 1, 12]);
    assert.equal(r.items[0].month, "2026-02");
    assert.deepEqual(Object.keys(r.items[0]).sort(), ["amount", "currency", "id", "issuedAt", "month", "number", "status"]);
    assert.equal(r.items[0].amount, 100.13);
    assert.equal(r.items[0].status, "open");
    assert.equal(r.items[1].status, "paid");
    const p2 = json(await h.as(u).get("/invoices?page=2"));
    assert.equal(p2.items.length, 2);
    assert.equal(p2.items.at(-1).month, "2025-01");
    assert.equal((await h.as(u).get("/invoices?pageSize=101")).statusCode, 400);
  });

  test("invoice download: an ExportResult for application/pdf whose link serves a PDF; 404 when missing", async () => {
    const inv = json(await h.as(u).get("/invoices")).items[0];
    const res = await h.as(u).post(`/invoices/${inv.id}/download`);
    assert.equal(res.statusCode, 200, res.body);
    const r = json(res);
    assert.deepEqual([r.filename, r.mimeType], [`${inv.number}.pdf`, "application/pdf"]);
    const file = await h.app.fastify.inject(new URL(r.downloadUrl).pathname);
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers["content-type"], "application/pdf");
    assert.ok(file.rawPayload.subarray(0, 8).toString().startsWith("%PDF-1.4"));
    assert.ok(file.body.includes(`Invoice ${inv.number}`));
    assert.equal((await h.as(u).post("/invoices/00000000-0000-4000-8000-000000000000/download")).statusCode, 404);
    assert.equal((await h.as(u).post("/invoices/nope/download")).statusCode, 404);
  });
});

describe("API keys", () => {
  test("create returns the secret once; list shows hint only; revoke is repeatable", async () => {
    const created = await h.as(u).post("/api-keys", { name: "  CI pipeline " });
    assert.equal(created.statusCode, 201, created.body);
    const c = json(created);
    assert.deepEqual(Object.keys(c).sort(), ["key", "secret"]);
    assert.deepEqual(Object.keys(c.key).sort(), ["createdAt", "hint", "id", "lastUsedAt", "name", "revokedAt"]);
    assert.equal(c.key.name, "CI pipeline");
    assert.match(c.secret, /^fnx_[0-9a-f]{64}$/);
    const list = await h.as(u).get("/api-keys");
    assert.ok(!list.body.includes(c.secret));
    const mine = json(list).items.find((k: { id: string }) => k.id === c.key.id);
    assert.equal(mine.hint, c.secret.slice(-4));
    assert.equal(mine.revokedAt, null);
    const first = json(await h.as(u).post(`/api-keys/${c.key.id}/revoke`));
    assert.ok(first.revokedAt);
    const second = await h.as(u).post(`/api-keys/${c.key.id}/revoke`);
    assert.equal(second.statusCode, 200);
    assert.equal(json(second).revokedAt, first.revokedAt, "revoking twice changes nothing");
    assert.equal((await h.as(u).post("/api-keys/00000000-0000-4000-8000-000000000000/revoke")).statusCode, 404);
    const times = json(await h.as(u).get("/api-keys")).items.map((k: { createdAt: string }) => k.createdAt);
    assert.deepEqual([...times].sort().reverse(), times, "newest first");
  });

  test("400 for an empty or too long name; a retried create with the same Idempotency-Key never shows the secret again", async () => {
    for (const name of ["", "   ", "x".repeat(61), 5, undefined]) {
      const res = await h.as(u).post("/api-keys", { name });
      assert.equal(res.statusCode, 400, String(name));
      assert.equal(err(res).field, "name");
    }
    assert.equal((await h.as(u).post("/api-keys", { name: "x".repeat(60) })).statusCode, 201);
    const before = Number((await h.admin.query("select count(*) from public.api_keys where workspace_id = $1", [u.workspaceId])).rows[0].count);
    const first = await h.as(u).post("/api-keys", { name: "once" }, { "idempotency-key": "key-create-1" });
    const retry = await h.as(u).post("/api-keys", { name: "once" }, { "idempotency-key": "key-create-1" });
    assert.equal(first.statusCode, 201);
    assert.equal(retry.statusCode, 409);
    assert.ok(!retry.body.includes("fnx_"));
    assert.equal(Number((await h.admin.query("select count(*) from public.api_keys where workspace_id = $1", [u.workspaceId])).rows[0].count), before + 1);
    assert.ok(!JSON.stringify((await h.admin.query("select response_body from public.idempotency_keys")).rows).includes(json(first).secret), "the secret is not kept in the idempotency table");
  });
});

describe("settings", () => {
  test("get and save round trip; the dashboard sees the new workspace name", async () => {
    const got = json(await h.as(u).get("/settings"));
    assert.deepEqual(Object.keys(got).sort(), ["emailNotices", "idleMinutes", "workspaceName"]);
    assert.equal(got.workspaceName, "Usage Ursula");
    const saved = await h.as(u).put("/settings", { workspaceName: "  Ursula Labs ", idleMinutes: 15, emailNotices: false });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(json(saved), { workspaceName: "Ursula Labs", idleMinutes: 15, emailNotices: false });
    assert.deepEqual(json(await h.as(u).get("/settings")), { workspaceName: "Ursula Labs", idleMinutes: 15, emailNotices: false });
    assert.equal((await h.admin.query("select name from public.workspaces where id = $1", [u.workspaceId])).rows[0].name, "Ursula Labs");
  });

  test("400: empty or too long name, an idle time that is not allowed, a non-boolean flag", async () => {
    for (const [body, field] of [
      [{ workspaceName: "", idleMinutes: 5, emailNotices: true }, "workspaceName"],
      [{ workspaceName: "   ", idleMinutes: 5, emailNotices: true }, "workspaceName"],
      [{ workspaceName: "x".repeat(61), idleMinutes: 5, emailNotices: true }, "workspaceName"],
      [{ workspaceName: "ok", idleMinutes: 7, emailNotices: true }, "idleMinutes"],
      [{ workspaceName: "ok", idleMinutes: "5", emailNotices: true }, "idleMinutes"],
      [{ workspaceName: "ok", idleMinutes: 5, emailNotices: "yes" }, "emailNotices"],
      [{ idleMinutes: 5, emailNotices: true }, "workspaceName"],
    ] as const) {
      const res = await h.as(u).put("/settings", body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(err(res).field, field);
    }
    for (const idle of [1, 5, 15, 60]) assert.equal((await h.as(u).put("/settings", { workspaceName: "ok", idleMinutes: idle, emailNotices: true })).statusCode, 200);
  });
});

describe("audit log", () => {
  test("every change is recorded with who, what, the request id, and no secrets", async () => {
    const rid = `audit-${randomUUID()}`;
    const res = await h.app.fastify.inject({ method: "POST", url: "/v1/databases", headers: { cookie: `fnx_session=${u.token}`, "x-request-id": rid }, payload: { name: "audited-01", region: "eu-central-1", tags: ["a:b"] } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.headers["x-request-id"], rid);
    const rows = (await h.admin.query("select * from public.audit_log where request_id = $1 order by id", [rid])).rows;
    assert.deepEqual(rows.map((r) => r.action), ["database.create.requested", "database.create.completed"]);
    assert.ok(rows.every((r) => r.workspace_id === u.workspaceId && r.actor_type === "user" && r.actor_id === u.userId && r.outcome === "ok"));
    const actions = (await h.admin.query("select distinct action from public.audit_log where workspace_id = $1", [u.workspaceId])).rows.map((r) => r.action);
    for (const a of ["api_key.create", "api_key.revoke", "settings.save"]) assert.ok(actions.includes(a), a);
    const everything = JSON.stringify((await h.admin.query("select * from public.audit_log")).rows);
    assert.ok(!/fnx_[0-9a-f]{64}|mongodb:\/\/|Bearer /.test(everything));
  });

  test("an API key's changes are recorded as the key", async () => {
    const key = await h.apiKey(u.workspaceId);
    const rid = `audit-${randomUUID()}`;
    await h.app.fastify.inject({ method: "POST", url: "/v1/databases/tags/add", headers: { authorization: `Bearer ${key}`, "x-request-id": rid }, payload: { ids: [dbs[0]!.id], tags: ["via:key"] } });
    const row = (await h.admin.query("select actor_type, actor_id, action from public.audit_log where request_id = $1", [rid])).rows[0];
    assert.equal(row.actor_type, "api_key");
    assert.equal(row.action, "database.tags.add");
  });
});

describe("usage sync (engine to Postgres)", () => {
  test("copies state, storage, hourly and daily usage; pruning keeps recent hours", async () => {
    const { syncWorkspaceUsage } = await import("../../src/services/usage.ts");
    const e = await h.user("Syncer");
    const id = json(await h.as(e).post("/databases", { name: "sync-01", region: "eu-central-1" })).id;
    const now = new Date();
    const hour = (back: number) => new Date(Math.floor(now.getTime() / 3600000) * 3600000 - back * 3600000).toISOString();
    h.engine.dbs.get(id)!.db.storageBytes = 3 * 1048576;
    h.engine.dbs.get(id)!.db.state = "awake";
    h.engine.setUsage(id, { [hour(0)]: 7, [hour(1)]: 5, [hour(30)]: 100 });
    const out = await syncWorkspaceUsage(h.app.deps.s, e.workspaceId, now);
    assert.deepEqual(out, { databases: 1, failed: 0 });
    const row = (await h.admin.query("select state, storage_bytes, requests_24h from public.databases where id = $1", [id])).rows[0];
    assert.deepEqual(row, { state: "awake", storage_bytes: 3 * 1048576, requests_24h: 12 });
    assert.equal((await h.admin.query("select count(*)::int as n from public.usage_hourly where database_id = $1", [id])).rows[0].n, 3);
    const daily = (await h.admin.query("select sum(requests)::int as n from public.usage_daily where database_id = $1", [id])).rows[0].n;
    assert.equal(daily, 112);
    const again = await syncWorkspaceUsage(h.app.deps.s, e.workspaceId, now);
    assert.equal(again.databases, 1);
    assert.equal((await h.admin.query("select count(*)::int as n from public.usage_hourly where database_id = $1", [id])).rows[0].n, 3, "running it again does not duplicate");
    assert.equal((await h.admin.query("select sum(requests)::int as n from public.usage_daily where database_id = $1", [id])).rows[0].n, 112);
    h.engine.failNext("usage", "unavailable", 1);
    assert.deepEqual(await syncWorkspaceUsage(h.app.deps.s, e.workspaceId, now), { databases: 0, failed: 1 });
    assert.equal(json(await h.as(e).get(`/databases/${id}`)).requests24h, 12, "a failed sync leaves the last values");
  });
});

describe("csv quoting", () => {
  test("fields with a comma, quote or newline are quoted with doubled quotes", async () => {
    const { csvField } = await import("../../src/services/usage.ts");
    assert.equal(csvField("plain"), "plain");
    assert.equal(csvField("a,b"), '"a,b"');
    assert.equal(csvField('say "hi"'), '"say ""hi"""');
    assert.equal(csvField("line\nbreak"), '"line\nbreak"');
    assert.equal(csvField(12.5), "12.5");
  });
});
