#!/usr/bin/env node
// The measurements of our machines, read from the production database after real jobs ran (docs/REPORT-our-machines.md).
//   DATABASE_URL=<the Supabase admin connection string> node measure.mjs [--since 2026-11-21T00:00:00Z] [--json]
// Prints, every number with its label:
//   1. job start latency per path (MEASURED): GitHub's created_at -> GitHub's started_at (one clock), by how the slot was found:
//      own (a machine of the customer already up), ready (the always-on machine), reserve (a stopped machine started:
//      warm start), new (a new machine: cold start); n, p50, p95, max;
//   2. machine boot per path (MEASURED): launched/started -> the agent's hello;
//   3. the reserve over time (MEASURED): machines per state per minute during the window (burst behaviour);
//   4. cost per minute per size: the DECLARED on-demand prices below x the machine minutes (MEASURED) of the window.
import pg from "../../../../github-app/node_modules/pg/lib/index.js";

// DECLARED, to verify on https://aws.amazon.com/ec2/pricing/on-demand/ (eu-west-1, Linux) before quoting: devzero.io
// instance pages, read 2026-11-20 (third party, rounded, undated).
const USD_PER_HOUR = { "c7a.xlarge": 0.220, "c7a.2xlarge": 0.440 };
const SPOT_USD_PER_HOUR = { "c7a.xlarge": 0.096, "c7a.2xlarge": 0.214 };

const args = process.argv.slice(2);
const since = args.includes("--since") ? args[args.indexOf("--since") + 1] : new Date(Date.now() - 86_400_000).toISOString();
const asJson = args.includes("--json");
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL (the admin connection string) is required"); process.exit(2); }
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);
const stats = (xs) => { const s = xs.map(Number).sort((a, b) => a - b); return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), max: s.at(-1) ?? null }; };

const starts = await q(`
  select l.path, extract(epoch from (j.started_at - j.created_at)) as s
    from gh_jobs j join lateral (select path from gh_leases where job_id = j.job_id order by id limit 1) l on true
   where j.created_at >= $1 and j.started_at is not null and j.started_at >= j.created_at`, [since]);
const boots = await q(`
  select l.path, extract(epoch from (m.hello_at - m.launched_at)) as s
    from gh_machines m join lateral (select path from gh_leases where machine_id = m.id order by id limit 1) l on true
   where m.launched_at >= $1 and m.hello_at is not null`, [since]);
const timeline = await q(`
  with t as (select generate_series(date_trunc('minute', $1::timestamptz), date_trunc('minute', now()), interval '1 minute') as at)
  select t.at,
         count(*) filter (where m.created_at <= t.at and coalesce(m.gone_at, now()) > t.at and m.bound_at is not null and m.bound_at <= t.at) as bound,
         count(*) filter (where m.created_at <= t.at and coalesce(m.gone_at, now()) > t.at and (m.bound_at is null or m.bound_at > t.at)) as clean
    from t left join gh_machines m on m.created_at <= t.at and coalesce(m.gone_at, now()) > t.at
   group by t.at order by t.at`, [since]);
const minutes = await q(`select instance_type, market, sum(extract(epoch from (coalesce(gone_at, now()) - coalesce(launched_at, created_at)))) / 60 as minutes, count(*) as machines
    from gh_machines where created_at >= $1 group by 1, 2`, [since]);
const byPath = (rows) => Object.fromEntries(["own", "ready", "reserve", "new"].map((p) => [p, stats(rows.filter((r) => r.path === p).map((r) => r.s))]));
const out = {
  window: { since, until: new Date().toISOString() },
  jobStartSeconds_MEASURED: byPath(starts),
  machineBootSeconds_MEASURED: byPath(boots),
  costPerMinute_DECLARED_prices: Object.fromEntries(Object.entries(USD_PER_HOUR).map(([t, h]) => [t, { onDemand: +(h / 60).toFixed(5), spot: +(SPOT_USD_PER_HOUR[t] / 60).toFixed(5) }])),
  machineMinutes_MEASURED: minutes.map((m) => ({ ...m, minutes: Number(Number(m.minutes).toFixed(1)), usd_ESTIMATED: Number(((Number(m.minutes) / 60) * ((m.market === "spot" ? SPOT_USD_PER_HOUR : USD_PER_HOUR)[m.instance_type] ?? NaN)).toFixed(3)) })),
  machinesPerMinute_MEASURED: timeline.map((r) => ({ at: r.at, bound: Number(r.bound), clean: Number(r.clean) })),
};
if (asJson) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`window ${out.window.since} .. ${out.window.until}`);
  console.log("job start (queued -> started), seconds, MEASURED:"); for (const [p, s] of Object.entries(out.jobStartSeconds_MEASURED)) console.log(`  ${p.padEnd(8)} n=${s.n} p50=${s.p50} p95=${s.p95} max=${s.max}`);
  console.log("machine boot (launch/start -> hello), seconds, MEASURED:"); for (const [p, s] of Object.entries(out.machineBootSeconds_MEASURED)) console.log(`  ${p.padEnd(8)} n=${s.n} p50=${s.p50} p95=${s.p95}`);
  console.log("cost per minute, USD, DECLARED prices:", JSON.stringify(out.costPerMinute_DECLARED_prices));
  console.log("machine minutes:", JSON.stringify(out.machineMinutes_MEASURED));
  console.log("machines per minute (bound / clean):"); for (const r of out.machinesPerMinute_MEASURED) if (r.bound || r.clean) console.log(`  ${new Date(r.at).toISOString().slice(11, 16)} bound=${r.bound} clean=${r.clean}`);
}
await db.end();
