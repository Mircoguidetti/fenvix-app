// All mock data lives in this file. Every number and name here is made up.
import type { DataClient } from "./client";
import type {
  ApiKey, AwakePoint, BillingOverview, BulkResult, CostPoint, Database, DatabaseFilter, DatabaseGroup, DatabaseSort,
  DbState, ExportResult, GroupedDatabases, Invoice, Overview, Page, Plan, RequestPoint, Settings, TagBreakdownRow,
  TagCount, UsagePoint, UsageQuery, UsageRange, UsageReport, UsageRow, UsageSort, UsageTrend, WakeUp,
} from "./types";
import { simplePdf } from "./pdf";
import { matchesTagFilter, mergeTags, parseTag, sortTags, splitTag } from "../lib/tags";

const NOW = new Date("2026-10-26T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Every database answers on this host. */
export const DB_HOST = "db.fenvix.cloud";
export const WORKSPACE = "Northwind Cloud";
export const REGIONS = ["eu-west", "us-east", "us-west", "ap-south"];

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const round2 = (n: number) => Math.round(n * 100) / 100;
const formatNumber = (n: number) => new Intl.NumberFormat("en-US").format(n);

interface Seed {
  id: string;
  name: string;
  state: DbState;
  storageMb: number;
  requests24h: number;
  lastActiveMs: number;
  ageDays: number;
  region: string;
  tags: string[];
  keepAwake?: boolean;
}

const SEEDS: Seed[] = [
  { id: "db_0001", name: "orders-prod", state: "awake", storageMb: 4820, requests24h: 182340, lastActiveMs: 2 * MIN, ageDays: 210, region: "eu-west", tags: ["customer:northwind", "env:prod", "app:orders"], keepAwake: true },
  { id: "db_0002", name: "agent-memory", state: "awake", storageMb: 912, requests24h: 54210, lastActiveMs: 9 * MIN, ageDays: 64, region: "us-east", tags: ["customer:northwind", "env:prod", "app:agents"] },
  { id: "db_0003", name: "orders-staging", state: "asleep", storageMb: 1730, requests24h: 1204, lastActiveMs: 5 * HOUR, ageDays: 120, region: "eu-west", tags: ["customer:northwind", "env:staging", "app:orders"] },
  { id: "db_0004", name: "ci-4417", state: "asleep", storageMb: 38, requests24h: 311, lastActiveMs: 19 * HOUR, ageDays: 2, region: "us-east", tags: ["customer:northwind", "env:dev"] },
  { id: "db_0005", name: "analytics-archive", state: "asleep", storageMb: 12400, requests24h: 0, lastActiveMs: 6 * DAY, ageDays: 300, region: "eu-west", tags: ["customer:northwind", "env:dev", "app:analytics"] },
  { id: "db_0006", name: "support-bot", state: "awake", storageMb: 256, requests24h: 9120, lastActiveMs: 41 * MIN, ageDays: 33, region: "ap-south", tags: ["customer:northwind", "env:prod", "app:agents"] },
  { id: "db_0007", name: "feature-flags", state: "asleep", storageMb: 12, requests24h: 4410, lastActiveMs: 3 * HOUR, ageDays: 400, region: "eu-west", tags: ["customer:northwind", "env:prod"] },
  { id: "db_0008", name: "acme-labs-prod", state: "asleep", storageMb: 640, requests24h: 87, lastActiveMs: 2 * DAY, ageDays: 18, region: "us-east", tags: ["customer:acme-labs", "env:prod"] },
  { id: "db_0009", name: "billing-events", state: "awake", storageMb: 7305, requests24h: 98560, lastActiveMs: 30_000, ageDays: 180, region: "us-east", tags: ["customer:northwind", "env:prod", "app:billing"] },
  { id: "db_0010", name: "branch-982", state: "asleep", storageMb: 54, requests24h: 0, lastActiveMs: 11 * DAY, ageDays: 12, region: "eu-west", tags: ["customer:northwind", "env:sandbox"] },
  { id: "db_0011", name: "research-notes", state: "asleep", storageMb: 2210, requests24h: 530, lastActiveMs: 8 * HOUR, ageDays: 75, region: "ap-south", tags: ["customer:northwind", "env:dev"] },
  { id: "db_0012", name: "bench-run-12", state: "asleep", storageMb: 20480, requests24h: 12, lastActiveMs: 26 * HOUR, ageDays: 5, region: "us-east", tags: ["customer:northwind", "env:dev"] },
];

export function connectionStringFor(name: string): { host: string; connectionString: string } {
  const host = `${name}.${DB_HOST}`;
  return { host, connectionString: `mongodb://app_user:<password>@${host}:27017/${name.replace(/-/g, "_")}?tls=true` };
}

function makeDatabase(s: Seed): Database {
  return {
    id: s.id,
    name: s.name,
    state: s.keepAwake ? "awake" : s.state,
    storageMb: s.storageMb,
    requests24h: s.requests24h,
    lastActiveAt: ago(s.lastActiveMs),
    createdAt: ago(s.ageDays * DAY),
    region: s.region,
    ...connectionStringFor(s.name),
    tags: sortTags(s.tags),
    keepAwake: !!s.keepAwake,
    forkedFrom: null,
    restoredTo: null,
  };
}

/** Small deterministic pseudo-random generator so screens are stable. */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable number from a string, for seeding. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) % 100000;
}

const FLEET_SIZE = 3000;
const CUSTOMER_FIRST = ["acme", "brio", "cald", "dyna", "elan", "fenn", "glim", "hexa", "ivor", "juno", "kest", "lumo", "mera", "nova", "orbi", "pyra", "quil", "rhea", "sova", "tavi"];
const CUSTOMER_SECOND = ["labs", "works", "corp", "soft", "pay", "data", "logic", "cloud", "bank", "mart"];
/** 200 customers: the workspace itself plus 199 generated names. */
const CUSTOMERS = ["northwind", ...CUSTOMER_FIRST.flatMap((a) => CUSTOMER_SECOND.map((b) => `${a}-${b}`)).slice(0, 199)];
const ENVS = ["prod", "prod", "prod", "staging", "dev", "dev", "sandbox"];
const APPS = ["orders", "agents", "analytics", "billing"];

/** About 3,000 databases over 200 customers, a few large ones and a long tail. Around 9 in 10 are asleep. */
function buildFleet(): Database[] {
  const fleet = SEEDS.map(makeDatabase);
  const rand = rng(20261026);
  const weights = CUSTOMERS.map((_, i) => 1 / (i + 1) ** 0.75);
  const remaining = FLEET_SIZE - fleet.length;
  const sum = weights.reduce((a, b) => a + b, 0);
  const counts = weights.map((w) => Math.max(2, Math.round((remaining * w) / sum)));
  counts[0] += remaining - counts.reduce((a, b) => a + b, 0);
  let n = fleet.length;
  CUSTOMERS.forEach((customer, ci) => {
    const perEnv = new Map<string, number>();
    for (let k = 0; k < counts[ci]; k++) {
      n++;
      const env = ENVS[Math.floor(rand() * ENVS.length)];
      const seq = (perEnv.get(env) ?? 0) + 1;
      perEnv.set(env, seq);
      const awake = rand() < 0.085;
      const tags = [`customer:${customer}`, `env:${env}`];
      if (rand() < 0.3) tags.push(`app:${APPS[Math.floor(rand() * APPS.length)]}`);
      fleet.push(
        makeDatabase({
          id: `db_${String(n).padStart(4, "0")}`,
          name: `${customer}-${env}-${String(seq).padStart(2, "0")}`,
          state: awake ? "awake" : "asleep",
          storageMb: awake ? Math.round(200 + rand() * 8800) : Math.max(2, Math.round(Math.exp(Math.log(5) + rand() * Math.log(800)))),
          requests24h: awake ? Math.round((5000 + rand() * 195000) * (rand() < 0.04 ? 3 + rand() * 5 : 1)) : rand() < 0.6 ? Math.round(rand() * 50) : Math.round(rand() * 3000),
          lastActiveMs: awake ? Math.round(rand() * 25 * MIN) : HOUR + Math.round(rand() ** 2 * 45 * DAY),
          ageDays: 1 + Math.round(rand() * 500),
          region: REGIONS[Math.floor(rand() * REGIONS.length)],
          tags,
          keepAwake: awake && rand() < 0.2,
        }),
      );
    }
  });
  return fleet;
}

let databases: Database[] = buildFleet();

function matches(d: Database, f: DatabaseFilter): boolean {
  if (f.state && d.state !== f.state) return false;
  if (f.keepAwake !== undefined && d.keepAwake !== f.keepAwake) return false;
  if (f.search && !d.name.toLowerCase().includes(f.search.trim().toLowerCase())) return false;
  return (f.tags ?? []).every((t) => matchesTagFilter(d.tags, t));
}

function compareBy(a: Database, b: Database, key: DatabaseSort): number {
  if (key === "name" || key === "state") return a[key].localeCompare(b[key]);
  if (key === "keepAwake") return Number(a.keepAwake) - Number(b.keepAwake);
  if (key === "lastActiveAt") return new Date(a.lastActiveAt).getTime() - new Date(b.lastActiveAt).getTime();
  return a[key] - b[key];
}

const copy = (d: Database): Database => ({ ...d, tags: [...d.tags] });
const copyOrNull = (d: Database | undefined): Database | null => (d ? copy(d) : null);

function mutate(ids: string[], change: (d: Database) => Database): BulkResult {
  const wanted = new Set(ids);
  let affected = 0;
  databases = databases.map((d) => {
    if (!wanted.has(d.id)) return d;
    affected++;
    return change(d);
  });
  return { affected };
}

function blank(name: string, region: string): Database {
  return makeDatabase({ id: `db_${randomHex(8)}`, name, state: "asleep", storageMb: 0, requests24h: 0, lastActiveMs: 0, ageDays: 0, region, tags: [] });
}

function checkName(name: string): string {
  const clean = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(clean)) throw new Error("Use 3 to 48 lowercase letters, numbers or dashes, starting and ending with a letter or number.");
  if (databases.some((d) => d.name === clean)) throw new Error(`A database named ${clean} already exists.`);
  return clean;
}

function checkTags(tags: string[]): string[] {
  const next = sortTags(parseTags(tags));
  if (new Set(next.map((t) => splitTag(t).key)).size !== next.length) throw new Error("A database can have one value per tag key.");
  if (next.length > 20) throw new Error("A database can have up to 20 tags.");
  return next;
}

export function blobUrl(content: string, type: string): string {
  return URL.createObjectURL(new Blob([content], { type }));
}

/** Like parseTags, but a bare "key" is allowed (removes the key). */
function parseTagsOrKeys(tags: string[]): string[] {
  return tags.map((t) => (t.includes(":") ? parseTags([t])[0] : t.trim().toLowerCase()));
}

function parseTags(tags: string[]): string[] {
  return tags.map((t) => {
    const parsed = parseTag(t);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed.tag;
  });
}

function usageFor(db: Database, range: UsageRange): UsagePoint[] {
  const seed = hash(db.id) * 7919;
  const rand = rng(seed + range.length);
  const [count, step] = range === "24h" ? [24, HOUR] : range === "7d" ? [7 * 4, 6 * HOUR] : [30, DAY];
  const perBucket = Math.max(db.requests24h, 40) / (range === "24h" ? 24 : range === "7d" ? 4 : 1);
  const startStorage = db.storageMb * 0.82;
  const points = Array.from({ length: count }, (_, i) => {
    const at = new Date(NOW.getTime() - (count - 1 - i) * step).toISOString();
    const wave = 0.55 + 0.45 * Math.sin((i / count) * Math.PI * (range === "24h" ? 2 : 4) + seed);
    const idle = db.state === "asleep" && rand() < 0.45 ? 0.04 : 1;
    const requests = Math.round(perBucket * wave * idle * (0.6 + rand() * 0.8));
    const storageMb = Math.round(startStorage + (db.storageMb - startStorage) * (i / (count - 1)));
    return { at, requests, storageMb, awake: false };
  });
  // A database is awake for a bucket when it kept serving in it, not for a single stray request.
  const peak = Math.max(...points.map((p) => p.requests), 1);
  return points.map((p) => ({ ...p, awake: db.keepAwake || p.requests >= Math.max(3, peak * 0.22) }));
}

// ---------------------------------------------------------------- usage and billing

const USAGE_MONTHS = ["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05"];
const STORAGE_RATE = 0.25; // per GB-month
const REQUEST_RATE = 0.4; // per million requests

/** Usage of one database in a month. The current month is counted up to "now". */
function monthlyUsage(d: Database, month: string): { requests: number; storageGb: number } {
  const [y, m] = month.split("-").map(Number);
  const start = Date.UTC(y, m - 1, 1);
  const end = Math.min(Date.UTC(y, m, 1), NOW.getTime());
  const created = new Date(d.createdAt).getTime();
  if (end <= created || end <= start) return { requests: 0, storageGb: 0 };
  const active = Math.min(1, (end - Math.max(start, created)) / (end - start));
  const days = (end - start) / DAY;
  const jitter = 0.7 + 0.6 * (hash(d.id + month) / 100000);
  const index = USAGE_MONTHS.indexOf(month);
  const trend = 1 - 0.04 * (index < 0 ? 0 : index);
  return { requests: Math.round(d.requests24h * days * active * jitter), storageGb: round2((d.storageMb / 1024) * active * trend) };
}

function usageRows(q: UsageQuery): { rows: UsageRow[]; totals: UsageReport["totals"] } {
  const per = databases.map((d) => ({ d, u: monthlyUsage(d, q.month) }));
  const totals = { databases: per.length, storageGb: round2(per.reduce((a, x) => a + x.u.storageGb, 0)), requests: per.reduce((a, x) => a + x.u.requests, 0) };
  if (q.by === "database") {
    return { rows: per.map(({ d, u }) => ({ id: d.id, name: d.name, tags: d.tags, databases: 1, storageGb: u.storageGb, requests: u.requests })), totals };
  }
  const groups = new Map<string, UsageRow>();
  for (const { d, u } of per) {
    const labels = q.tagKey ? [d.tags.find((t) => splitTag(t).key === q.tagKey) ?? `${q.tagKey}:(none)`] : d.tags;
    for (const label of labels) {
      const g = groups.get(label) ?? { id: label, name: label, tags: [], databases: 0, storageGb: 0, requests: 0 };
      g.databases++;
      g.storageGb = round2(g.storageGb + u.storageGb);
      g.requests += u.requests;
      groups.set(label, g);
    }
  }
  return { rows: [...groups.values()], totals };
}

function sortUsage(rows: UsageRow[], sort: UsageSort, dir: "asc" | "desc"): UsageRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => sign * (sort === "name" ? a.name.localeCompare(b.name) : a[sort] - b[sort]) || a.name.localeCompare(b.name));
}

const csvCell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function monthTotals(month: string) {
  return usageRows({ month, by: "database" }).totals;
}

function costs(t: { storageGb: number; requests: number }, fraction = 1) {
  return { storage: round2(t.storageGb * STORAGE_RATE * fraction), requests: round2((t.requests / 1e6) * REQUEST_RATE) };
}

const monthFraction = (month: string) => (month === "2026-10" ? NOW.getUTCDate() / 31 : 1);
const monthCost = (month: string) => {
  const c = costs(monthTotals(month), monthFraction(month));
  return round2(c.storage + c.requests);
};

const INVOICES: Invoice[] = USAGE_MONTHS.slice(1).map((month) => {
  const [y, m] = month.split("-").map(Number);
  return { id: `inv_${month}`, number: `FNX-${month}`, month, issuedAt: new Date(Date.UTC(y, m, 1)).toISOString(), amount: monthCost(month), currency: "USD", status: "paid" as const };
});

const PLANS: Plan[] = [
  { id: "open-source", name: "Open source", price: "Free", period: "", description: "One database, run by you, on your machine or your cloud storage.", features: ["The complete engine", "MongoDB drivers and tools", "Community support"], current: false },
  { id: "managed", name: "Managed", price: "$29", period: "/ month", description: "Includes 10 GB and 10 million requests, then pay for what you use.", features: ["Unlimited databases", "Asleep databases cost only storage", "Fork, restore, export, erase", "Usage per customer"], current: true },
  { id: "dedicated", name: "Dedicated", price: "$499", period: "/ month", description: "Your own environment in the region you choose, plus usage.", features: ["Servers for you alone", "Region of your choice", "Keep busy customers awake", "Priority support"], current: false },
  { id: "in-your-cloud", name: "In your cloud", price: "Custom", period: "", description: "Runs in your own cloud account. Your data never leaves it.", features: ["Your cloud, your region", "Single sign-on and audit log", "Support with an agreed response time"], current: false },
];

function getBillingOverview(): BillingOverview {
  const t = monthTotals("2026-10");
  const fraction = monthFraction("2026-10");
  const c = costs(t, fraction);
  return {
    currency: "USD",
    plan: { name: "Managed", description: "Includes 10 GB and 10 million requests, then pay for what you use." },
    monthToDate: {
      periodLabel: "October 1 to 26, 2026",
      lines: [
        { label: "Storage", quantity: `${formatNumber(round2(t.storageGb * fraction))} GB-months`, rate: `$${STORAGE_RATE.toFixed(2)} per GB-month`, cost: c.storage },
        { label: "Requests", quantity: `${formatNumber(t.requests)} requests`, rate: `$${REQUEST_RATE.toFixed(2)} per million`, cost: c.requests },
      ],
      total: round2(c.storage + c.requests),
    },
    paymentMethod: { brand: "Visa", last4: "4242", expires: "08/2028" },
  };
}

// ---------------------------------------------------------------- overview

const BUCKETS: Record<UsageRange, { count: number; step: number }> = {
  "24h": { count: 24, step: HOUR },
  "7d": { count: 7, step: DAY },
  "30d": { count: 30, step: DAY },
};

/** Bucket starts for a range, oldest first, ending at the bucket "now" is in. */
function bucketStarts(range: UsageRange): string[] {
  const { count, step } = BUCKETS[range];
  const end = Math.floor(NOW.getTime() / step) * step;
  return Array.from({ length: count }, (_, i) => new Date(end - (count - 1 - i) * step).toISOString());
}

/** Fleet-wide daily rhythm: busier in the European working day, quieter at the weekend. */
function fleetShape(at: Date, range: UsageRange): number {
  const hour = at.getUTCHours() + (range === "24h" ? 0 : 12);
  const day = at.getUTCDay();
  const ofDay = range === "24h" ? 0.62 + 0.38 * Math.sin(((hour - 4) / 24) * 2 * Math.PI) : 1;
  const ofWeek = day === 0 || day === 6 ? 0.72 : 1;
  return ofDay * ofWeek;
}

function awakeSeries(range: UsageRange): AwakePoint[] {
  const total = databases.length;
  const awakeNow = databases.filter((d) => d.state === "awake").length;
  const rand = rng(hash(`awake-${range}`));
  return bucketStarts(range).map((at, i, all) => {
    const shape = fleetShape(new Date(at), range);
    const drift = 1 - 0.12 * ((all.length - 1 - i) / all.length);
    const awake = Math.max(40, Math.round(awakeNow * shape * drift * (0.94 + rand() * 0.12)));
    return { at, awake: i === all.length - 1 ? awakeNow : awake, total: Math.round(total * drift) };
  });
}

function requestSeries(range: UsageRange): RequestPoint[] {
  const perDay = databases.reduce((a, d) => a + d.requests24h, 0);
  const perBucket = range === "24h" ? perDay / 24 : perDay;
  const rand = rng(hash(`requests-${range}`));
  return bucketStarts(range).map((at) => ({ at, requests: Math.round(perBucket * fleetShape(new Date(at), range) * (0.88 + rand() * 0.24)) }));
}

/** Cost so far this month by day, with the same days of the month before for reference. */
function costSeries(): CostPoint[] {
  const thisMonth = monthCost("2026-10");
  const lastMonth = monthCost("2026-09");
  const days = NOW.getUTCDate();
  const rand = rng(hash("cost"));
  const weights = Array.from({ length: 30 }, (_, i) => fleetShape(new Date(Date.UTC(2026, 9, i + 1, 12)), "30d") * (0.9 + rand() * 0.2));
  const totalWeight = weights.slice(0, days).reduce((a, b) => a + b, 0);
  const lastWeight = weights.reduce((a, b) => a + b, 0);
  let run = 0;
  let runRef = 0;
  return Array.from({ length: 30 }, (_, i) => {
    const at = new Date(Date.UTC(2026, 9, i + 1)).toISOString();
    runRef += (lastMonth * weights[i]) / lastWeight;
    if (i < days) run += (thisMonth * weights[i]) / totalWeight;
    return { at, cost: i < days ? round2(run) : 0, reference: round2(runRef) };
  }).slice(0, days + 4);
}

function sparkFrom(values: number[], points = 12): number[] {
  if (values.length <= points) return values.map(round2);
  const step = values.length / points;
  return Array.from({ length: points }, (_, i) => round2(values[Math.min(values.length - 1, Math.round(i * step))]));
}

const WAKE_MINUTES = [2, 6, 13, 21, 34, 52, 78, 115];

function recentWakeUps(): WakeUp[] {
  const rand = rng(hash("wake-ups"));
  return [...databases]
    .filter((d) => !d.keepAwake && d.requests24h > 0)
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
    .slice(0, WAKE_MINUTES.length)
    .map((d, i) => ({ id: d.id, name: d.name, at: ago(WAKE_MINUTES[i] * MIN), latencyMs: 180 + Math.round(rand() * 760) }));
}

function overviewFor(range: UsageRange): Overview {
  const awake = awakeSeries(range);
  const requests = requestSeries(range);
  const cost = costSeries();
  const awakeNow = databases.filter((d) => d.state === "awake").length;
  const storageGb = round2(databases.reduce((a, d) => a + d.storageMb, 0) / 1024);
  const totalRequests = requests.reduce((a, p) => a + p.requests, 0);
  const paid = cost.filter((p) => p.cost > 0);
  return {
    range,
    totals: {
      databases: databases.length,
      awake: awakeNow,
      asleep: databases.length - awakeNow,
      asleepPercent: Math.round(((databases.length - awakeNow) / databases.length) * 100),
      requests: totalRequests,
      storageGb,
      costMtd: paid.length ? paid[paid.length - 1].cost : 0,
      currency: "USD",
    },
    sparks: {
      databases: sparkFrom(awake.map((p) => p.total)),
      awake: sparkFrom(awake.map((p) => p.awake)),
      requests: sparkFrom(requests.map((p) => p.requests)),
      storageGb: sparkFrom(awake.map((_, i) => round2((storageGb * (0.93 + (0.07 * i) / awake.length))))),
      cost: sparkFrom(paid.map((p) => p.cost)),
    },
    awakeSeries: awake,
    requestSeries: requests,
    costSeries: cost,
    topDatabases: [...databases].sort((a, b) => b.requests24h - a.requests24h).slice(0, 10).map((d) => ({ id: d.id, name: d.name, requests: d.requests24h })),
    recentWakeUps: recentWakeUps(),
  };
}

function tagBreakdown(key: string, limit: number): TagBreakdownRow[] {
  const rows = new Map<string, TagBreakdownRow>();
  for (const d of databases) {
    const tag = d.tags.find((t) => splitTag(t).key === key);
    const value = tag ? splitTag(tag).value : "(none)";
    const r = rows.get(value) ?? { value, databases: 0, storageGb: 0, requests: 0 };
    r.databases++;
    r.storageGb = round2(r.storageGb + d.storageMb / 1024);
    r.requests += d.requests24h;
    rows.set(value, r);
  }
  return [...rows.values()].sort((a, b) => b.requests - a.requests || b.storageGb - a.storageGb).slice(0, limit);
}

/** Daily requests of a month, split over the five biggest values of a tag key plus "Other". */
function usageTrend(month: string, tagKey: string): UsageTrend {
  const [y, m] = month.split("-").map(Number);
  const lastDay = month === "2026-10" ? NOW.getUTCDate() : new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = Array.from({ length: lastDay }, (_, i) => new Date(Date.UTC(y, m - 1, i + 1)).toISOString());
  const perValue = new Map<string, number>();
  for (const d of databases) {
    const tag = d.tags.find((t) => splitTag(t).key === tagKey);
    const value = tag ? splitTag(tag).value : "(none)";
    perValue.set(value, (perValue.get(value) ?? 0) + monthlyUsage(d, month).requests);
  }
  const sorted = [...perValue.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 5);
  const otherTotal = sorted.slice(5).reduce((a, x) => a + x[1], 0);
  const entries = otherTotal > 0 ? [...top, ["Other", otherTotal] as [string, number]] : top;
  const weights = days.map((at) => fleetShape(new Date(at), "30d"));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  return {
    days,
    series: entries.map(([label, total]) => ({ label, values: weights.map((w) => Math.round((total * w) / weightSum)) })),
  };
}

// ---------------------------------------------------------------- keys and settings

let apiKeys: ApiKey[] = [
  { id: "key_1", name: "Production backend", hint: "a91f", createdAt: ago(90 * DAY), lastUsedAt: ago(4 * MIN), revokedAt: null },
  { id: "key_2", name: "Deploy pipeline", hint: "3c07", createdAt: ago(41 * DAY), lastUsedAt: ago(19 * HOUR), revokedAt: null },
  { id: "key_3", name: "Agent runner", hint: "e5d2", createdAt: ago(12 * DAY), lastUsedAt: ago(3 * DAY), revokedAt: null },
  { id: "key_4", name: "Old laptop", hint: "77b0", createdAt: ago(200 * DAY), lastUsedAt: ago(120 * DAY), revokedAt: ago(100 * DAY) },
];

let settings: Settings = { workspaceName: WORKSPACE, idleMinutes: 5, emailNotices: true };

const wait = <T,>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 90));

function randomHex(n: number) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, n);
}

export const mockClient: DataClient = {
  isSample: true,
  now: () => NOW,
  listDatabases(query = {}) {
    const { sort = "name", dir = "asc", page = 1, pageSize = 50 } = query;
    const sign = dir === "asc" ? 1 : -1;
    const rows = databases.filter((d) => matches(d, query)).sort((a, b) => sign * compareBy(a, b, sort) || a.name.localeCompare(b.name));
    const items = rows.slice((page - 1) * pageSize, page * pageSize).map(copy);
    return wait<Page<Database>>({ items, total: rows.length, page, pageSize });
  },
  listDatabaseIds: (filter = {}) => wait(databases.filter((d) => matches(d, filter)).map((d) => d.id)),
  groupDatabases(groupBy, filter = {}) {
    const groups = new Map<string | null, DatabaseGroup>();
    let total = 0;
    for (const d of databases) {
      if (!matches(d, filter)) continue;
      total++;
      const tag = d.tags.find((t) => splitTag(t).key === groupBy);
      const value = tag ? splitTag(tag).value : null;
      const g = groups.get(value) ?? { value, count: 0, awake: 0, keepAwake: 0, storageMb: 0 };
      g.count++;
      g.awake += d.state === "awake" ? 1 : 0;
      g.keepAwake += d.keepAwake ? 1 : 0;
      g.storageMb += d.storageMb;
      groups.set(value, g);
    }
    const list = [...groups.values()].sort((a, b) => (a.value === null ? 1 : b.value === null ? -1 : b.count - a.count || a.value.localeCompare(b.value)));
    return wait<GroupedDatabases>({ groupBy, groups: list, total });
  },
  listTags() {
    const counts = new Map<string, number>();
    for (const d of databases) for (const t of d.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    const tags: TagCount[] = [...counts].map(([t, count]) => ({ ...splitTag(t), count })).sort((a, b) => a.key.localeCompare(b.key) || b.count - a.count || a.value.localeCompare(b.value));
    return wait(tags);
  },
  getDatabase: (id) => wait(copyOrNull(databases.find((d) => d.id === id))),
  getOverview: (range) => wait(overviewFor(range)),
  getTagBreakdown: (key, limit = 8) => wait(tagBreakdown(key, limit)),
  getUsageTrend: (month, tagKey) => wait(usageTrend(month, tagKey)),
  listPlans: () => wait(PLANS.map((p) => ({ ...p, features: [...p.features] }))),
  listRegions: () => wait([...REGIONS]),
  async createDatabase({ name, region, tags }) {
    const clean = checkName(name);
    if (!REGIONS.includes(region)) throw new Error("Choose a region.");
    const next = checkTags(tags);
    const db: Database = { ...blank(clean, region), tags: next };
    databases = [db, ...databases];
    return wait(copy(db));
  },
  async forkDatabase(id, name) {
    const source = databases.find((d) => d.id === id);
    if (!source) throw new Error("Database not found");
    const clean = checkName(name);
    const db: Database = { ...blank(clean, source.region), tags: [...source.tags], storageMb: source.storageMb, forkedFrom: source.id };
    databases = [db, ...databases];
    return wait(copy(db));
  },
  async restoreDatabase(id, at) {
    const source = databases.find((d) => d.id === id);
    if (!source) throw new Error("Database not found");
    const t = new Date(at).getTime();
    if (Number.isNaN(t)) throw new Error("Choose a date and time.");
    if (t > NOW.getTime()) throw new Error("Choose a time in the past.");
    if (t < new Date(source.createdAt).getTime()) throw new Error("That is before this database was created.");
    mutate([id], (d) => ({ ...d, restoredTo: new Date(t).toISOString(), lastActiveAt: NOW.toISOString() }));
    return wait(copy(databases.find((d) => d.id === id)!));
  },
  async exportDatabases(ids) {
    const picked = databases.filter((d) => ids.includes(d.id));
    if (picked.length === 0) throw new Error("Nothing to export.");
    const body = { exportedAt: NOW.toISOString(), databases: picked.map((d) => ({ name: d.name, region: d.region, tags: d.tags, storageMb: d.storageMb, collections: [{ name: "orders", documents: 18204 }, { name: "users", documents: 412 }] })) };
    const filename = picked.length === 1 ? `fenvix-export-${picked[0].name}.json` : `fenvix-export-${picked.length}-databases.json`;
    return wait<ExportResult>({ filename, mimeType: "application/json", downloadUrl: blobUrl(JSON.stringify(body, null, 2), "application/json") });
  },
  async eraseDatabases(ids) {
    const gone = new Set(ids);
    const before = databases.length;
    databases = databases.filter((d) => !gone.has(d.id));
    return wait({ affected: before - databases.length });
  },
  async setKeepAwake(ids, enabled) {
    return wait(mutate(ids, (d) => ({ ...d, keepAwake: enabled, state: enabled ? "awake" : d.state })));
  },
  async setTags(id, tags) {
    const next = checkTags(tags);
    if (!databases.some((d) => d.id === id)) throw new Error("Database not found");
    mutate([id], (d) => ({ ...d, tags: next }));
    return wait(copy(databases.find((d) => d.id === id)!));
  },
  async addTags(ids, tags) {
    const add = parseTags(tags);
    return wait(mutate(ids, (d) => ({ ...d, tags: mergeTags(d.tags, add) })));
  },
  async removeTags(ids, tags) {
    const drop = parseTagsOrKeys(tags);
    return wait(mutate(ids, (d) => ({ ...d, tags: d.tags.filter((t) => !drop.some((x) => matchesTagFilter([t], x))) })));
  },
  getUsage: (id, range) => {
    const db = databases.find((d) => d.id === id);
    return wait(db ? usageFor(db, range) : []);
  },
  listUsageMonths: () => wait([...USAGE_MONTHS]),
  async getUsageReport(q) {
    if (!USAGE_MONTHS.includes(q.month)) throw new Error("No usage report for this month.");
    const { rows, totals } = usageRows(q);
    const { sort = "requests", dir = "desc", page = 1, pageSize = 50 } = q;
    const sorted = sortUsage(rows, sort, dir);
    return wait<UsageReport>({ month: q.month, items: sorted.slice((page - 1) * pageSize, page * pageSize), total: sorted.length, page, pageSize, totals });
  },
  async exportUsageReport(q) {
    const { rows } = usageRows(q);
    const sorted = sortUsage(rows, q.sort ?? "requests", q.dir ?? "desc");
    const head = q.by === "database" ? "database,tags,storage_gb_avg,requests" : "tag,databases,storage_gb_avg,requests";
    const lines = sorted.map((r) => (q.by === "database" ? [r.name, r.tags.join(" "), r.storageGb, r.requests] : [r.name, r.databases, r.storageGb, r.requests]).map(csvCell).join(","));
    const filename = `fenvix-usage-${q.month}-${q.by === "database" ? "databases" : q.tagKey ? `by-${q.tagKey}` : "tags"}.csv`;
    return wait<ExportResult>({ filename, mimeType: "text/csv", downloadUrl: blobUrl([head, ...lines].join("\n") + "\n", "text/csv") });
  },
  getBilling: () => wait(getBillingOverview()),
  listInvoices(page = 1, pageSize = 12) {
    return wait<Page<Invoice>>({ items: INVOICES.slice((page - 1) * pageSize, page * pageSize), total: INVOICES.length, page, pageSize });
  },
  async downloadInvoice(id) {
    const inv = INVOICES.find((i) => i.id === id);
    if (!inv) throw new Error("Invoice not found");
    const pdf = simplePdf(["FENVIX", "", `Invoice ${inv.number}`, `Workspace: ${settings.workspaceName}`, `Month: ${inv.month}`, `Issued: ${inv.issuedAt.slice(0, 10)}`, `Amount: ${inv.currency} ${inv.amount.toFixed(2)}`, `Status: ${inv.status}`]);
    return wait<ExportResult>({ filename: `${inv.number}.pdf`, mimeType: "application/pdf", downloadUrl: blobUrl(pdf, "application/pdf") });
  },
  listApiKeys: () => wait(apiKeys.map((k) => ({ ...k }))),
  async createApiKey(name) {
    const secret = `fnx_${randomHex(32)}`;
    const key: ApiKey = { id: `key_${randomHex(6)}`, name, hint: secret.slice(-4), createdAt: NOW.toISOString(), lastUsedAt: null, revokedAt: null };
    apiKeys = [key, ...apiKeys];
    return wait({ key: { ...key }, secret });
  },
  async revokeApiKey(id) {
    const found = apiKeys.find((k) => k.id === id);
    if (!found) throw new Error("Key not found");
    const next = { ...found, revokedAt: NOW.toISOString() };
    apiKeys = apiKeys.map((k) => (k.id === id ? next : k));
    return wait(next);
  },
  getSettings: () => wait({ ...settings }),
  async saveSettings(next) {
    settings = { ...next };
    return wait({ ...settings });
  },
};
