import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { json, startHarness, type Fixture, type Harness } from "../helpers/harness.ts";

/**
 * Scale check against the dashboard's own seed (3,000 databases, ~200 customers, 61 days of usage).
 * Skipped unless SEEDED_DATABASE_URL points at a scratch database that has had
 * supabase/tests/run-local.sh run on it and 0002_control_plane.sql applied.
 */
const seeded = process.env.SEEDED_DATABASE_URL;
process.env.TEST_DATABASE_URL = seeded ?? process.env.TEST_DATABASE_URL;

let h: Harness;
let u: Fixture;
before(async () => {
  if (!seeded) return;
  h = await startHarness({ RATE_LIMIT_PER_MINUTE: "100000" });
  const row = (await h.admin.query("select u.id, m.workspace_id from auth.users u join public.workspace_members m on m.user_id = u.id where u.email = 'mircoguidetti1994@gmail.com'")).rows[0];
  u = { userId: row.id, email: "mircoguidetti1994@gmail.com", name: "Mirco", workspaceId: row.workspace_id, token: await h.signer.token({ id: row.id, email: "mircoguidetti1994@gmail.com" }) };
});
after(async () => { if (h) await h.close(); });

const timed = async (label: string, fn: () => Promise<{ statusCode: number; body: string }>, maxMs = 3000) => {
  const t = Date.now();
  const res = await fn();
  const ms = Date.now() - t;
  assert.equal(res.statusCode, 200, `${label}: ${res.body.slice(0, 200)}`);
  assert.ok(ms < maxMs, `${label} took ${ms} ms`);
  console.log(`  ${label}: ${ms} ms`);
  return json(res);
};

test("3,000 databases: every read endpoint answers correctly and quickly", { skip: !seeded && "set SEEDED_DATABASE_URL" }, async () => {
  const list = await timed("list page 1", () => h.as(u).get("/databases?pageSize=200"));
  assert.equal(list.total, 3000);
  assert.equal(list.items.length, 200);
  const filtered = await timed("list filtered", () => h.as(u).get("/databases?state=awake&tag=env:prod&search=a"));
  assert.ok(filtered.total > 0 && filtered.total < 3000);
  const ids = await timed("ids", () => h.as(u).get("/databases/ids?tag=env:prod"));
  assert.ok(ids.ids.length > 100);
  const groups = await timed("groups", () => h.as(u).get("/databases/groups?groupBy=customer"));
  assert.equal(groups.total, 3000);
  assert.ok(groups.groups.length >= 150);
  assert.equal(groups.groups.reduce((n: number, g: { count: number }) => n + g.count, 0), 3000);
  await timed("tags", () => h.as(u).get("/tags"));
  const breakdown = await timed("breakdown", () => h.as(u).get("/tags/breakdown?key=customer&limit=8"));
  assert.equal(breakdown.items.length, 8);
  for (const range of ["24h", "7d", "30d"]) {
    const o = await timed(`overview ${range}`, () => h.as(u).get(`/overview?range=${range}`));
    assert.equal(o.totals.databases, 3000);
    assert.ok(o.totals.requests > 0, "the seed has requests");
    assert.equal(o.topDatabases.length, 10);
  }
  const months = await timed("months", () => h.as(u).get("/usage/months"));
  assert.ok(months.items.length >= 2);
  const month = months.items[0];
  const byDb = await timed("usage by database", () => h.as(u).get(`/usage?month=${month}&by=database&pageSize=200`));
  assert.equal(byDb.total, 3000);
  assert.equal(byDb.totals.databases, 3000);
  const byTag = await timed("usage by tag", () => h.as(u).get(`/usage?month=${month}&by=tag&tagKey=customer&pageSize=200`));
  assert.ok(byTag.total >= 150);
  assert.equal(byTag.totals.requests, byDb.totals.requests, "the same total however it is cut");
  assert.equal(byTag.items.reduce((n: number, r: { requests: number }) => n + r.requests, 0), byDb.totals.requests);
  const trend = await timed("trend", () => h.as(u).get(`/usage/trend?month=${month}&tagKey=customer`));
  assert.ok(trend.series.length === 6 && trend.series.at(-1).label === "Other");
  const trendSum = trend.series.reduce((n: number, s: { values: number[] }) => n + s.values.reduce((a, b) => a + b, 0), 0);
  assert.equal(trendSum, byDb.totals.requests, "the trend adds up to the report");
  await timed("history", () => h.as(u).get("/usage/history"));
  const csv = await timed("csv export", () => h.as(u).get(`/usage/export?month=${month}&by=database`));
  const file = await h.app.fastify.inject(new URL(csv.downloadUrl).pathname);
  assert.equal(file.body.trim().split("\n").length, 3001);
  await timed("billing", () => h.as(u).get("/billing"));
  await timed("invoices", () => h.as(u).get("/invoices"));
  const one = list.items[0];
  await timed("series 24h", () => h.as(u).get(`/databases/${one.id}/usage?range=24h`));
  await timed("series 7d", () => h.as(u).get(`/databases/${one.id}/usage?range=7d`));
  await timed("series 30d", () => h.as(u).get(`/databases/${one.id}/usage?range=30d`));
  const idsAll = (await h.as(u).get("/databases/ids")).body;
  assert.equal(json({ body: idsAll }).ids.length, 3000);
});
