// All mock data lives in this file. Every number and name here is fake.
import type { DataClient } from "./client";
import type { ApiKey, BillingSummary, BulkResult, Database, ExportResult, DatabaseFilter, DatabaseGroup, DatabaseSort, DbState, GroupedDatabases, Page, Settings, TagCount, UsagePoint, UsageRange } from "./types";
import { matchesTagFilter, mergeTags, parseTag, sortTags, splitTag } from "../lib/tags";

const NOW = new Date("2026-10-26T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

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
  { id: "db_0001", name: "orders-prod", state: "awake", storageMb: 4820, requests24h: 182340, lastActiveMs: 2 * MIN, ageDays: 210, region: "eu-west", tags: ["customer:internal", "env:prod", "app:orders"], keepAwake: true },
  { id: "db_0002", name: "agent-memory", state: "awake", storageMb: 912, requests24h: 54210, lastActiveMs: 9 * MIN, ageDays: 64, region: "us-east", tags: ["customer:internal", "env:prod", "app:agents"] },
  { id: "db_0003", name: "staging-copy", state: "asleep", storageMb: 1730, requests24h: 1204, lastActiveMs: 5 * HOUR, ageDays: 120, region: "eu-west", tags: ["customer:internal", "env:staging", "app:orders"] },
  { id: "db_0004", name: "ci-test-4417", state: "asleep", storageMb: 38, requests24h: 311, lastActiveMs: 19 * HOUR, ageDays: 2, region: "us-east", tags: ["customer:internal", "env:dev"] },
  { id: "db_0005", name: "analytics-sandbox", state: "asleep", storageMb: 12400, requests24h: 0, lastActiveMs: 6 * DAY, ageDays: 300, region: "eu-west", tags: ["customer:internal", "env:dev", "app:analytics"] },
  { id: "db_0006", name: "support-bot", state: "awake", storageMb: 256, requests24h: 9120, lastActiveMs: 41 * MIN, ageDays: 33, region: "ap-south", tags: ["customer:internal", "env:prod", "app:agents"] },
  { id: "db_0007", name: "feature-flags", state: "asleep", storageMb: 12, requests24h: 4410, lastActiveMs: 3 * HOUR, ageDays: 400, region: "eu-west", tags: ["customer:internal", "env:prod"] },
  { id: "db_0008", name: "demo-tenant-acme", state: "asleep", storageMb: 640, requests24h: 87, lastActiveMs: 2 * DAY, ageDays: 18, region: "us-east", tags: ["customer:acme-labs", "env:preview"] },
  { id: "db_0009", name: "billing-events", state: "awake", storageMb: 7305, requests24h: 98560, lastActiveMs: 30_000, ageDays: 180, region: "us-east", tags: ["customer:internal", "env:prod", "app:billing"] },
  { id: "db_0010", name: "preview-pr-982", state: "asleep", storageMb: 54, requests24h: 0, lastActiveMs: 11 * DAY, ageDays: 12, region: "eu-west", tags: ["customer:internal", "env:preview"] },
  { id: "db_0011", name: "research-notes", state: "asleep", storageMb: 2210, requests24h: 530, lastActiveMs: 8 * HOUR, ageDays: 75, region: "ap-south", tags: ["customer:internal", "env:dev"] },
  { id: "db_0012", name: "load-test-run", state: "asleep", storageMb: 20480, requests24h: 12, lastActiveMs: 26 * HOUR, ageDays: 5, region: "us-east", tags: ["customer:internal", "env:dev"] },
];

export const REGIONS = ["eu-west", "us-east", "us-west", "ap-south"];

export function connectionStringFor(name: string): { host: string; connectionString: string } {
  const host = `${name}.sample.invalid`;
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

/** Small deterministic pseudo-random generator so screenshots are stable. */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const FLEET_SIZE = 3000;
const CUSTOMER_FIRST = ["acme", "brio", "cald", "dyna", "elan", "fenn", "glim", "hexa", "ivor", "juno", "kest", "lumo", "mera", "nova", "orbi", "pyra", "quil", "rhea", "sova", "tavi"];
const CUSTOMER_SECOND = ["labs", "works", "corp", "soft", "pay", "data", "logic", "cloud", "bank", "mart"];
/** 200 customers: "internal" plus 199 generated names. */
const CUSTOMERS = ["internal", ...CUSTOMER_FIRST.flatMap((a) => CUSTOMER_SECOND.map((b) => `${a}-${b}`)).slice(0, 199)];
const ENVS = ["prod", "prod", "prod", "staging", "dev", "dev", "preview"];

/** About 3,000 databases over 200 customers; a few large customers and a long tail. Most are asleep. */
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
      const awake = rand() < 0.08;
      const tags = [`customer:${customer}`, `env:${env}`];
      if (rand() < 0.3) tags.push(`app:${["orders", "agents", "analytics", "billing"][Math.floor(rand() * 4)]}`);
      fleet.push(
        makeDatabase({
          id: `db_${String(n).padStart(4, "0")}`,
          name: `${customer}-${env}-${String(seq).padStart(2, "0")}`,
          state: awake ? "awake" : "asleep",
          storageMb: awake ? Math.round(200 + rand() * 8800) : Math.max(2, Math.round(Math.exp(Math.log(5) + rand() * Math.log(800)))),
          requests24h: awake ? Math.round(5000 + rand() * 195000) : rand() < 0.6 ? Math.round(rand() * 50) : Math.round(rand() * 3000),
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

/** Like parseTags, but a bare "key" is allowed (removes the key). */
function parseTagsOrKeys(tags: string[]): string[] {
  return tags.map((t) => (t.includes(":") ? parseTags([t])[0] : t.trim().toLowerCase()));
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

function parseTags(tags: string[]): string[] {
  return tags.map((t) => {
    const parsed = parseTag(t);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed.tag;
  });
}

/** Stable number from a string, for seeding. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) % 100000;
}

function usageFor(db: Database, range: UsageRange): UsagePoint[] {
  const seed = hash(db.id) * 7919;
  const rand = rng(seed + range.length);
  const [count, step] = range === "24h" ? [24, HOUR] : range === "7d" ? [7 * 4, 6 * HOUR] : [30, DAY];
  const perBucket = Math.max(db.requests24h, 40) / (range === "24h" ? 24 : range === "7d" ? 4 : 1);
  const startStorage = db.storageMb * 0.82;
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(NOW.getTime() - (count - i) * step).toISOString();
    const wave = 0.55 + 0.45 * Math.sin((i / count) * Math.PI * (range === "24h" ? 2 : 4) + seed);
    const idle = db.state === "asleep" && rand() < 0.45 ? 0.04 : 1;
    const requests = Math.round(perBucket * wave * idle * (0.6 + rand() * 0.8));
    const storageMb = Math.round(startStorage + (db.storageMb - startStorage) * (i / (count - 1)));
    return { at, requests, storageMb };
  });
}

const billing: BillingSummary = (() => {
  const lines = databases.slice(0, 12).map((d) => {
    const requests = Math.round(d.requests24h * 26 * 0.8);
    const awakeHours = d.state === "awake" ? 120 + (d.requests24h % 90) : 6 + (d.requests24h % 25);
    const storageGbHours = Math.round((d.storageMb / 1024) * 24 * 26);
    const amount = Math.round((requests / 1e6) * 100 + awakeHours * 0.37 + storageGbHours * 0.0021 * 10) / 100;
    return { databaseId: d.id, name: d.name, requests, awakeHours, storageGbHours, amount };
  });
  const total = Math.round(lines.reduce((sum, l) => sum + l.amount, 0) * 100) / 100;
  return { periodLabel: "Sample period: Oct 1 to Oct 26, 2026", currency: "USD", lines, total };
})();

let apiKeys: ApiKey[] = [
  { id: "key_1", name: "Production backend", hint: "a91f", createdAt: ago(90 * DAY), lastUsedAt: ago(4 * MIN), revokedAt: null },
  { id: "key_2", name: "CI pipeline", hint: "3c07", createdAt: ago(41 * DAY), lastUsedAt: ago(19 * HOUR), revokedAt: null },
  { id: "key_3", name: "Agent runner", hint: "e5d2", createdAt: ago(12 * DAY), lastUsedAt: ago(3 * DAY), revokedAt: null },
  { id: "key_4", name: "Old laptop", hint: "77b0", createdAt: ago(200 * DAY), lastUsedAt: ago(120 * DAY), revokedAt: ago(100 * DAY) },
];

let settings: Settings = { workspaceName: "Sample workspace", idleMinutes: 5, emailNotices: true };

const wait = <T,>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 120));

function randomHex(n: number) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, n);
}

export const mockClient: DataClient = {
  isSample: true,
  now: () => NOW,
  listDatabases(query = {}) {
    const { sort = "lastActiveAt", dir = "desc", page = 1, pageSize = 50 } = query;
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
    const body = { sample: true, exportedAt: NOW.toISOString(), databases: picked.map((d) => ({ name: d.name, region: d.region, tags: d.tags, storageMb: d.storageMb, collections: [{ name: "items", documents: [{ _id: "sample-1" }, { _id: "sample-2" }] }] })) };
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
  getDatabase: (id) => wait(copyOrNull(databases.find((d) => d.id === id))),
  getUsage: (id, range) => {
    const db = databases.find((d) => d.id === id);
    return wait(db ? usageFor(db, range) : []);
  },
  getBilling: () => wait(billing),
  listApiKeys: () => wait(apiKeys.map((k) => ({ ...k }))),
  async createApiKey(name) {
    const secret = `sample_${randomHex(32)}`;
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
