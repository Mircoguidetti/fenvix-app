import { type Caller, type Services } from "../context.ts";
import { type Client, iso } from "../db.ts";
import { notFound, validation } from "../errors.ts";
import { writeAudit } from "../audit.ts";
import { type Obj, isUuid, parseEnum, parseMonth, parseTagKey } from "../validate.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const GIB = 1_073_741_824;
const round2 = (n: number) => Math.round(n * 100) / 100;
const startOfUtcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysInMonth = (ms: number) => { const d = new Date(ms); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); };

export type UsageRange = "24h" | "7d" | "30d";

/** The buckets of a database's usage chart, oldest first: 24 hourly, 28 six-hourly (UTC 00/06/12/18), or 30 UTC days. */
function rangeGrid(range: UsageRange, now: Date) {
  if (range === "30d") return { daily: true, step: DAY, count: 30, first: startOfUtcDay(now) - 29 * DAY };
  const step = range === "24h" ? HOUR : 6 * HOUR;
  const count = range === "24h" ? 24 : 28;
  return { daily: false, step, count, first: Math.floor(now.getTime() / step) * step - (count - 1) * step };
}

/** 404 unless the database is the caller's and its creation has finished (as everywhere else). */
async function assertVisibleDatabase(c: Client, ws: string, id: string) {
  if (!isUuid(id)) throw notFound("That database does not exist.");
  const found = await c.query("select 1 from public.databases where workspace_id = $1 and id = $2 and engine_state <> 'provisioning'", [ws, id]);
  if (!found.rowCount) throw notFound("That database does not exist.");
}

// ---------------------------------------------------------------- one database

export async function getUsageSeries(s: Services, caller: Caller, id: string, range: UsageRange, now = new Date()) {
  return s.db.tx(caller.workspaceId, async (c) => {
    await assertVisibleDatabase(c, caller.workspaceId, id);
    const { step, count, first } = rangeGrid(range, now);

    if (range === "30d") {
      const rows = (await c.query("select day::text as day, requests, storage_bytes from public.usage_daily where database_id = $1 and day >= $2::date", [id, dayKey(first)])).rows;
      const by = new Map(rows.map((r) => [r.day as string, r]));
      return { items: Array.from({ length: count }, (_, i) => {
        const at = first + i * DAY;
        const r = by.get(dayKey(at));
        return { at: iso(new Date(at))!, requests: r ? Number(r.requests) : 0, storageMb: r ? Math.floor(Number(r.storage_bytes) / 1048576) : 0, awake: r ? Number(r.requests) > 0 : false };
      }) };
    }

    const rows = (await c.query("select hour, requests, storage_bytes from public.usage_hourly where database_id = $1 and hour >= $2 order by hour", [id, new Date(first)])).rows;
    const buckets = Array.from({ length: count }, (_, i) => ({ at: first + i * step, requests: 0, storageBytes: 0, awake: false }));
    for (const r of rows) {
      const i = Math.floor((new Date(r.hour).getTime() - first) / step);
      const b = buckets[i];
      if (!b) continue;
      b.requests += Number(r.requests);
      b.storageBytes = Number(r.storage_bytes); // rows come oldest first, so the last one wins
      b.awake = b.awake || Number(r.requests) > 0;
    }
    return { items: buckets.map((b) => ({ at: iso(new Date(b.at))!, requests: b.requests, storageMb: Math.floor(b.storageBytes / 1048576), awake: b.awake })) };
  });
}

// ---------------------------------------------------------------- public API (docs/public-api.md, "Usage")

export interface PublicUsageBucket { at: string; requests: number; storageBytes: number; activeDatabases: number }

/**
 * Usage of the organization, or of one of its databases, on the grid of the database charts (rangeGrid), from the
 * same rows (usage_hourly for 24h and 7d, usage_daily for 30d). Per bucket and database: requests are summed and
 * storage is the database's newest value in the bucket, as getUsageSeries does; the organization's bucket adds those
 * up. `activeDatabases` counts databases that served a request in the bucket (the database chart's "awake").
 */
export async function getPublicUsage(s: Services, caller: Caller, range: UsageRange, databaseId: string | null, now = new Date()) {
  const ws = caller.workspaceId;
  return s.db.tx(ws, async (c) => {
    if (databaseId !== null) await assertVisibleDatabase(c, ws, databaseId);
    const g = rangeGrid(range, now);
    const end = g.first + g.count * g.step;
    // Days as UTC day keys, as everywhere in this file (a timestamp cast to date would use the session's time zone).
    const params: unknown[] = g.daily ? [ws, dayKey(g.first), dayKey(end)] : [ws, new Date(g.first), new Date(end), g.step / 1000];
    const only = databaseId === null ? "" : ` and database_id = $${params.push(databaseId.toLowerCase())}`;
    const source = g.daily
      ? `select database_id, (day - $2::date) as i, requests, storage_bytes, day as t from public.usage_daily
          where workspace_id = $1 and day >= $2::date and day < $3::date${only}`
      : `select database_id, floor(extract(epoch from hour - $2::timestamptz) / $4::int)::int as i, requests, storage_bytes, hour as t from public.usage_hourly
          where workspace_id = $1 and hour >= $2 and hour < $3${only}`;
    const per = `per as (select database_id, i, sum(requests)::bigint as requests, (array_agg(storage_bytes order by t desc))[1] as storage
                           from (${source}) r group by database_id, i)`;
    const rows = (await c.query(
      `with ${per} select i, sum(requests)::bigint as requests, sum(storage)::bigint as storage, (count(*) filter (where requests > 0))::int as active
         from per group by i`, params)).rows;
    // Storage at the end of the range: each database's newest bucket that has a value, added up.
    const latest = (await c.query(
      `with ${per} select coalesce(sum(storage), 0)::bigint as storage from (select distinct on (database_id) storage from per order by database_id, i desc) l`,
      params)).rows[0];
    const by = new Map(rows.map((r) => [Number(r.i), r]));
    const items: PublicUsageBucket[] = Array.from({ length: g.count }, (_, i) => {
      const r = by.get(i);
      return { at: iso(new Date(g.first + i * g.step))!, requests: r ? Number(r.requests) : 0, storageBytes: r ? Number(r.storage) : 0, activeDatabases: r ? Number(r.active) : 0 };
    });
    return {
      range,
      databaseId: databaseId === null ? null : databaseId.toLowerCase(),
      from: iso(new Date(g.first))!,
      to: iso(new Date(end))!,
      bucketSeconds: g.step / 1000,
      totals: { requests: items.reduce((n, b) => n + b.requests, 0), storageBytes: Number(latest.storage) },
      items,
    };
  });
}

// ---------------------------------------------------------------- overview

/** At most `points` values, oldest first, spread evenly (as the dashboard's own sparklines do). */
export function sparkFrom(values: number[], points = 12): number[] {
  if (values.length <= points) return values.map(round2);
  const step = values.length / points;
  return Array.from({ length: points }, (_, i) => round2(values[Math.min(values.length - 1, Math.round(i * step))]!));
}

export async function getOverview(s: Services, caller: Caller, range: UsageRange, now = new Date()) {
  const ws = caller.workspaceId;
  const rates = s.cfg.catalogue.rates;
  const requestRate = rates.requestsPerMillion ?? 0;
  const storageRate = rates.storagePerGbMonth ?? 0;

  return s.db.tx(ws, async (c) => {
    const hourly = range === "24h";
    const step = hourly ? HOUR : DAY;
    const count = range === "24h" ? 24 : range === "7d" ? 7 : 30;
    const last = hourly ? Math.floor(now.getTime() / HOUR) * HOUR : startOfUtcDay(now);
    const first = last - (count - 1) * step;

    const rows = hourly
      ? (await c.query(
          `select hour as at, sum(requests)::bigint as requests, (count(distinct database_id) filter (where requests > 0))::bigint as awake, coalesce(sum(storage_bytes), 0)::bigint as storage
             from public.usage_hourly where workspace_id = $1 and hour >= $2 group by hour`, [ws, new Date(first)])).rows
      : (await c.query(
          `select (day::timestamp at time zone 'UTC') as at, sum(requests)::bigint as requests, (count(distinct database_id) filter (where requests > 0))::bigint as awake, coalesce(sum(storage_bytes), 0)::bigint as storage
             from public.usage_daily where workspace_id = $1 and day >= $2::date group by day`, [ws, dayKey(first)])).rows;
    const by = new Map(rows.map((r) => [new Date(r.at).getTime(), r]));

    const totals = (await c.query(
      `select d_at, (select count(*)::bigint from public.databases d where d.workspace_id = $1 and d.engine_state <> 'provisioning' and d.created_at < d_at + ($3 || ' milliseconds')::interval) as total
         from unnest($2::timestamptz[]) as d_at`,
      [ws, Array.from({ length: count }, (_, i) => new Date(first + i * step)), String(step)])).rows;
    const totalAt = new Map(totals.map((r) => [new Date(r.d_at).getTime(), Number(r.total)]));

    const buckets = Array.from({ length: count }, (_, i) => {
      const at = first + i * step;
      const r = by.get(at);
      return { at, requests: r ? Number(r.requests) : 0, awake: r ? Number(r.awake) : 0, storageGb: r ? round2(Number(r.storage) / GIB) : 0, total: totalAt.get(at) ?? 0 };
    });

    // Cost of this month so far, day by day, against the same days of the month before.
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const prevStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
    const monthDays = daysInMonth(monthStart);
    const prevDays = daysInMonth(prevStart);
    const dailyRows = (await c.query(
      `select day::text as day, sum(requests)::bigint as requests, coalesce(sum(storage_bytes), 0)::bigint as storage
         from public.usage_daily where workspace_id = $1 and day >= $2::date and day < $3::date group by day`,
      [ws, dayKey(prevStart), dayKey(monthStart + monthDays * DAY)])).rows;
    const daily = new Map(dailyRows.map((r) => [r.day as string, r]));
    const costOf = (key: string, dim: number) => {
      const r = daily.get(key);
      return r ? (Number(r.requests) / 1e6) * requestRate + (Number(r.storage) / GIB) * storageRate / dim : 0;
    };
    const today = startOfUtcDay(now);
    let run = 0;
    let prevRun = 0;
    const costSeries = Array.from({ length: monthDays }, (_, i) => {
      const day = monthStart + i * DAY;
      run += day <= today ? costOf(dayKey(day), monthDays) : 0;
      prevRun += i < prevDays ? costOf(dayKey(prevStart + i * DAY), prevDays) : 0;
      return { at: iso(new Date(day))!, cost: day <= today ? round2(run) : 0, reference: i < prevDays ? round2(prevRun) : null };
    });
    const costMtd = costSeries.reduce((m, p) => Math.max(m, p.cost), 0);

    const fleet = (await c.query(
      `select count(*)::bigint as n, (count(*) filter (where state = 'awake'))::bigint as awake, coalesce(sum(storage_bytes), 0)::bigint as storage
         from public.databases where workspace_id = $1 and engine_state <> 'provisioning'`, [ws])).rows[0];
    const currency = (await c.query("select currency from public.workspace_settings where workspace_id = $1", [ws])).rows[0]?.currency ?? "USD";
    const top = (await c.query(
      "select id, name, requests_24h from public.databases where workspace_id = $1 and engine_state <> 'provisioning' order by requests_24h desc, name, id limit 10", [ws])).rows;
    const wakes = (await c.query(
      `select w.database_id as id, d.name, w.at, w.first_request_ms from public.wake_events w join public.databases d on d.id = w.database_id
        where w.workspace_id = $1 order by w.at desc, w.id desc limit 8`, [ws])).rows;

    const n = Number(fleet.n);
    const awake = Number(fleet.awake);
    return {
      range,
      totals: {
        databases: n, awake, asleep: n - awake, asleepPercent: n === 0 ? 0 : Math.round((100 * (n - awake)) / n),
        requests: buckets.reduce((a, b) => a + b.requests, 0), storageGb: round2(Number(fleet.storage) / GIB), costMtd, currency,
      },
      sparks: {
        databases: sparkFrom(buckets.map((b) => b.total)),
        awake: sparkFrom(buckets.map((b) => b.awake)),
        requests: sparkFrom(buckets.map((b) => b.requests)),
        storageGb: sparkFrom(buckets.map((b) => b.storageGb)),
        cost: sparkFrom(costSeries.filter((p) => new Date(p.at).getTime() <= today).map((p) => p.cost)),
      },
      awakeSeries: buckets.map((b) => ({ at: iso(new Date(b.at))!, awake: b.awake, total: b.total })),
      requestSeries: buckets.map((b) => ({ at: iso(new Date(b.at))!, requests: b.requests })),
      costSeries,
      topDatabases: top.map((r) => ({ id: String(r.id), name: String(r.name), requests: Number(r.requests_24h) })),
      recentWakeUps: wakes.map((r) => ({ id: String(r.id), name: String(r.name), at: iso(r.at)!, latencyMs: Number(r.first_request_ms) })),
    };
  });
}

export async function getTagBreakdown(s: Services, caller: Caller, key: string, limit: number) {
  return s.db.tx(caller.workspaceId, async (c) => {
    const rows = (await c.query(
      `select coalesce(g.value, '(none)') as value, count(*)::bigint as databases,
              coalesce(sum(d.storage_bytes), 0)::bigint as storage, coalesce(sum(d.requests_24h), 0)::bigint as requests
         from public.databases d left join public.database_tags g on g.database_id = d.id and g.key = $2
        where d.workspace_id = $1 and d.engine_state <> 'provisioning'
        group by 1 order by requests desc, storage desc, value limit $3`,
      [caller.workspaceId, key, limit])).rows;
    return { items: rows.map((r) => ({ value: String(r.value), databases: Number(r.databases), storageGb: round2(Number(r.storage) / GIB), requests: Number(r.requests) })) };
  });
}

// ---------------------------------------------------------------- monthly reports

export async function listUsageMonths(s: Services, caller: Caller) {
  return s.db.tx(caller.workspaceId, async (c) => {
    const rows = (await c.query(
      "select to_char(m, 'YYYY-MM') as month from (select distinct date_trunc('month', day) as m from public.usage_daily where workspace_id = $1) t order by m desc", [caller.workspaceId])).rows;
    return { items: rows.map((r) => String(r.month)) };
  });
}

export interface UsageQuery {
  month: string;
  by: "database" | "tag";
  tagKey?: string;
  sort: "name" | "databases" | "storageGb" | "requests";
  dir: "asc" | "desc";
}

const USAGE_SORTS = ["name", "databases", "storageGb", "requests"] as const;

/** A monthly report's query (`month`, `by`, `tagKey`, `sort`, `dir`), for the dashboard and the public API alike. */
export function parseUsageQuery(q: Obj) {
  const by = parseEnum(q.by, ["database", "tag"] as const, "by");
  const tagKey = q.tagKey === undefined || q.tagKey === "" ? undefined : parseTagKey(q.tagKey, "tagKey");
  if (tagKey && by !== "tag") throw validation("tagKey can only be used with by=tag.", "tagKey");
  const sort = parseEnum(q.sort, USAGE_SORTS, "sort", "requests");
  if (sort === "databases" && by !== "tag") throw validation("Sorting by databases only works with by=tag.", "sort");
  return { month: parseMonth(q.month), by, tagKey, sort, dir: parseEnum(q.dir, ["asc", "desc"] as const, "dir", "desc") };
}

export interface UsageRowOut { id: string; name: string; tags: string[]; databases: number; storageGb: number; requests: number }

const monthRange = (month: string) => {
  const start = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
  return { start: dayKey(start), end: dayKey(start + daysInMonth(start) * DAY) };
};

async function readUsageRows(c: Client, ws: string, q: UsageQuery, paging: { limit: number; offset: number } | null) {
  const { start, end } = monthRange(q.month);
  const has = await c.query("select 1 from public.usage_daily where workspace_id = $1 and day >= $2::date and day < $3::date limit 1", [ws, start, end]);
  if (!has.rowCount) throw validation(`There is no usage report for ${q.month}.`, "month");

  const order = `${{ name: "name", databases: "databases", storageGb: "storage_gb", requests: "requests" }[q.sort]} ${q.dir === "asc" ? "asc" : "desc"}, name asc, id asc`;
  const params: unknown[] = [ws, start, end];
  const picked = `
    picked as (
      select d.id, d.name,
             (select coalesce(array_agg(g.key || ':' || g.value order by g.key, g.value), '{}') from public.database_tags g where g.database_id = d.id) as tags,
             round((avg(u.storage_bytes) / 1073741824.0)::numeric, 2) as storage_gb,
             sum(u.requests)::bigint as requests
        from public.databases d join public.usage_daily u on u.database_id = d.id and u.day >= $2::date and u.day < $3::date
       where d.workspace_id = $1 and d.engine_state <> 'provisioning' group by d.id, d.name)`;
  let rowsSql: string;
  if (q.by === "database") {
    rowsSql = `${picked}, rows as (select id::text as id, name, tags, 1::bigint as databases, storage_gb, requests from picked)`;
  } else if (q.tagKey) {
    const k = `$${params.push(q.tagKey)}`;
    rowsSql = `${picked},
      tagged as (select p.id, p.storage_gb, p.requests,
                        ${k} || ':' || coalesce((select g.value from public.database_tags g where g.database_id = p.id and g.key = ${k}), '(none)') as label from picked p),
      rows as (select label as id, label as name, '{}'::text[] as tags, count(*)::bigint as databases, round(sum(storage_gb)::numeric, 2) as storage_gb, sum(requests)::bigint as requests from tagged group by label)`;
  } else {
    rowsSql = `${picked},
      tagged as (select p.id, p.storage_gb, p.requests, g.key || ':' || g.value as label from picked p join public.database_tags g on g.database_id = p.id),
      rows as (select label as id, label as name, '{}'::text[] as tags, count(*)::bigint as databases, round(sum(storage_gb)::numeric, 2) as storage_gb, sum(requests)::bigint as requests from tagged group by label)`;
  }
  let pageSql = `select * from rows order by ${order}`;
  if (paging) pageSql += ` limit $${params.push(paging.limit)} offset $${params.push(paging.offset)}`;
  const items = (await c.query(`with ${rowsSql} ${pageSql}`, params)).rows;
  const total = (await c.query(`with ${rowsSql} select count(*)::bigint as n from rows`, params.slice(0, q.tagKey && q.by === "tag" ? 4 : 3))).rows[0].n as number;
  const totals = (await c.query(
    `with ${picked} select count(*)::bigint as databases, coalesce(round(sum(storage_gb)::numeric, 2), 0) as storage_gb, coalesce(sum(requests), 0)::bigint as requests from picked`,
    [ws, start, end])).rows[0];
  return {
    items: items.map((r): UsageRowOut => ({ id: String(r.id), name: String(r.name), tags: r.tags as string[], databases: Number(r.databases), storageGb: Number(r.storage_gb), requests: Number(r.requests) })),
    total,
    totals: { databases: Number(totals.databases), storageGb: Number(totals.storage_gb), requests: Number(totals.requests) },
  };
}

export async function getUsageReport(s: Services, caller: Caller, q: UsageQuery, page: number, pageSize: number) {
  return s.db.tx(caller.workspaceId, async (c) => {
    const r = await readUsageRows(c, caller.workspaceId, q, { limit: pageSize, offset: (page - 1) * pageSize });
    return { month: q.month, page, pageSize, total: r.total, totals: r.totals, items: r.items };
  });
}

export const csvField = (v: string | number) => {
  const t = String(v);
  return /[",\n\r]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
};

export async function buildUsageCsv(s: Services, workspaceId: string, q: UsageQuery): Promise<{ filename: string; csv: string }> {
  const r = await s.db.tx(workspaceId, (c) => readUsageRows(c, workspaceId, q, null));
  const lines = q.by === "database"
    ? ["database,tags,storage_gb_avg,requests", ...r.items.map((x) => [x.name, x.tags.join(" "), x.storageGb, x.requests].map(csvField).join(","))]
    : ["tag,databases,storage_gb_avg,requests", ...r.items.map((x) => [x.name, x.databases, x.storageGb, x.requests].map(csvField).join(","))];
  const suffix = q.by === "database" ? "by-database" : q.tagKey ? `by-${q.tagKey}` : "by-tag";
  return { filename: `fenvix-usage-${q.month}-${suffix}.csv`, csv: `${lines.join("\n")}\n` };
}

export async function getUsageHistory(s: Services, caller: Caller) {
  return s.db.tx(caller.workspaceId, async (c) => {
    const rows = (await c.query(
      `select * from (
         select to_char(date_trunc('month', day), 'YYYY-MM') as month, count(distinct database_id)::bigint as databases,
                coalesce(sum(storage_bytes), 0)::numeric / count(distinct day) / 1073741824.0 as storage_gb, sum(requests)::bigint as requests,
                date_trunc('month', day) as m
           from public.usage_daily where workspace_id = $1 group by date_trunc('month', day) order by m desc limit $2) t order by m`,
      [caller.workspaceId, s.cfg.limits.historyMonths])).rows;
    return { items: rows.map((r) => ({ month: String(r.month), databases: Number(r.databases), storageGb: round2(Number(r.storage_gb)), requests: Number(r.requests) })) };
  });
}

export async function getUsageTrend(s: Services, caller: Caller, month: string, tagKey: string, now = new Date()) {
  return s.db.tx(caller.workspaceId, async (c) => {
    const { start, end } = monthRange(month);
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const endMs = Math.min(Date.parse(`${end}T00:00:00Z`), startOfUtcDay(now) + DAY);
    const dayCount = Math.max(0, Math.round((endMs - startMs) / DAY));
    const days = Array.from({ length: dayCount }, (_, i) => iso(new Date(startMs + i * DAY))!);
    if (dayCount === 0) return { days, series: [] };

    const rows = (await c.query(
      `select u.day::text as day, coalesce(g.value, '(none)') as value, sum(u.requests)::bigint as requests
         from public.usage_daily u join public.databases d on d.id = u.database_id
         left join public.database_tags g on g.database_id = u.database_id and g.key = $2
        where u.workspace_id = $1 and u.day >= $3::date and u.day < $4::date group by 1, 2`,
      [caller.workspaceId, tagKey, start, dayKey(endMs)])).rows;
    const totals = new Map<string, number>();
    for (const r of rows) totals.set(r.value, (totals.get(r.value) ?? 0) + Number(r.requests));
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
    const top = ranked.slice(0, 5);
    const series = top.map((label) => ({ label, values: new Array<number>(dayCount).fill(0) }));
    const other = { label: "Other", values: new Array<number>(dayCount).fill(0) };
    for (const r of rows) {
      const i = Math.round((Date.parse(`${r.day}T00:00:00Z`) - startMs) / DAY);
      const k = top.indexOf(r.value);
      (k >= 0 ? series[k]!.values : other.values)[i] = (k >= 0 ? series[k]!.values : other.values)[i]! + Number(r.requests);
    }
    if (ranked.length > 5) series.push(other);
    return { days, series };
  });
}

// ---------------------------------------------------------------- usage sync (engine -> Postgres)

/**
 * Copies what the engine knows into Postgres: state, storage, hourly and daily usage, wake-ups.
 * Runs for one workspace at a time so every write stays inside that workspace's policies.
 */
export async function syncWorkspaceUsage(s: Services, workspaceId: string, now = new Date()): Promise<{ databases: number; failed: number }> {
  const dbs = await s.db.tx(workspaceId, async (c) =>
    (await c.query("select id from public.databases where workspace_id = $1 and engine_state = 'ready'", [workspaceId])).rows.map((r) => String(r.id)));
  const from = new Date(startOfUtcDay(now) - DAY);
  const results: { id: string; u: Awaited<ReturnType<typeof s.engine.usage>> }[] = [];
  let failed = 0;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const id = dbs[next++];
      if (!id) return;
      try { results.push({ id, u: await s.engine.usage({ id, from: from.toISOString(), to: now.toISOString() }) }); }
      catch (e) { failed++; s.log.warn({ err: e instanceof Error ? e.message : String(e), databaseId: id }, "usage sync: engine call failed"); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, dbs.length) }, worker));

  await s.db.tx(workspaceId, async (c) => {
    const since24 = now.getTime() - DAY;
    for (const { id, u } of results) {
      const days = new Map<string, { requests: number; storage: number }>();
      let r24 = 0;
      for (const b of u.buckets) {
        const t = Date.parse(b.hour);
        await c.query(
          `insert into public.usage_hourly (database_id, workspace_id, hour, requests, storage_bytes) values ($1, $2, $3, $4, $5)
           on conflict (database_id, hour) do update set requests = excluded.requests, storage_bytes = excluded.storage_bytes`,
          [id, workspaceId, new Date(t), b.requests, b.storageBytes]);
        const k = dayKey(t);
        const d = days.get(k) ?? { requests: 0, storage: 0 };
        d.requests += b.requests;
        d.storage = b.storageBytes;
        days.set(k, d);
        if (t > since24) r24 += b.requests;
      }
      if (days.size === 0) days.set(dayKey(now.getTime()), { requests: 0, storage: u.storageBytes });
      for (const [day, d] of days) {
        await c.query(
          `insert into public.usage_daily (database_id, workspace_id, day, requests, storage_bytes) values ($1, $2, $3::date, $4, $5)
           on conflict (database_id, day) do update set requests = excluded.requests, storage_bytes = excluded.storage_bytes`,
          [id, workspaceId, day, d.requests, d.storage]);
      }
      await c.query(
        `update public.databases set state = $3::public.database_state, storage_bytes = $4, requests_24h = $5, last_active_at = $6
          where workspace_id = $1 and id = $2 and engine_state = 'ready'`,
        [workspaceId, id, u.state, u.storageBytes, r24, new Date(u.lastActiveAt)]);
      for (const w of u.wakeUps) {
        await c.query(
          `insert into public.wake_events (database_id, workspace_id, at, first_request_ms)
           select $1, $2, $3, $4 where not exists (select 1 from public.wake_events where database_id = $1 and at = $3)`,
          [id, workspaceId, new Date(w.at), Math.min(600000, Math.max(0, Math.round(w.firstRequestMs)))]);
      }
    }
    await writeAudit(c, { workspaceId, actor: { type: "system", id: "usage-sync" }, requestId: null }, { action: "usage.sync", metadata: { databases: results.length, failed } });
  });
  return { databases: results.length, failed };
}

export async function syncAllUsage(s: Services, now = new Date()): Promise<void> {
  const ids = await s.db.system(async (c) => (await c.query("select workspace_id from public.fenvix_cp_sync_workspaces()")).rows.map((r) => String(r.workspace_id)));
  for (const ws of ids) {
    try { await syncWorkspaceUsage(s, ws, now); }
    catch (e) { s.log.error({ err: e instanceof Error ? e.message : String(e), workspaceId: ws }, "usage sync failed for a workspace"); }
  }
  await s.db.system((c) => c.query("select public.fenvix_cp_prune($1, $2)", [s.cfg.hourlyRetentionDays, s.cfg.operationRetentionDays]));
}
