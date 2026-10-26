// All mock data lives in this file. Every number and name here is fake.
import type { DataClient } from "./client";
import type { ApiKey, BillingSummary, Database, DbState, Settings, UsagePoint, UsageRange } from "./types";

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
}

const SEEDS: Seed[] = [
  { id: "db_01", name: "orders-prod", state: "awake", storageMb: 4820, requests24h: 182340, lastActiveMs: 2 * MIN, ageDays: 210, region: "eu-west" },
  { id: "db_02", name: "agent-memory", state: "awake", storageMb: 912, requests24h: 54210, lastActiveMs: 9 * MIN, ageDays: 64, region: "us-east" },
  { id: "db_03", name: "staging-copy", state: "asleep", storageMb: 1730, requests24h: 1204, lastActiveMs: 5 * HOUR, ageDays: 120, region: "eu-west" },
  { id: "db_04", name: "ci-test-4417", state: "asleep", storageMb: 38, requests24h: 311, lastActiveMs: 19 * HOUR, ageDays: 2, region: "us-east" },
  { id: "db_05", name: "analytics-sandbox", state: "asleep", storageMb: 12400, requests24h: 0, lastActiveMs: 6 * DAY, ageDays: 300, region: "eu-west" },
  { id: "db_06", name: "support-bot", state: "awake", storageMb: 256, requests24h: 9120, lastActiveMs: 41 * MIN, ageDays: 33, region: "ap-south" },
  { id: "db_07", name: "feature-flags", state: "asleep", storageMb: 12, requests24h: 4410, lastActiveMs: 3 * HOUR, ageDays: 400, region: "eu-west" },
  { id: "db_08", name: "demo-tenant-acme", state: "asleep", storageMb: 640, requests24h: 87, lastActiveMs: 2 * DAY, ageDays: 18, region: "us-east" },
  { id: "db_09", name: "billing-events", state: "awake", storageMb: 7305, requests24h: 98560, lastActiveMs: 30_000, ageDays: 180, region: "us-east" },
  { id: "db_10", name: "preview-pr-982", state: "asleep", storageMb: 54, requests24h: 0, lastActiveMs: 11 * DAY, ageDays: 12, region: "eu-west" },
  { id: "db_11", name: "research-notes", state: "asleep", storageMb: 2210, requests24h: 530, lastActiveMs: 8 * HOUR, ageDays: 75, region: "ap-south" },
  { id: "db_12", name: "load-test-run", state: "asleep", storageMb: 20480, requests24h: 12, lastActiveMs: 26 * HOUR, ageDays: 5, region: "us-east" },
];

const databases: Database[] = SEEDS.map((s) => {
  const host = `${s.name}.sample.invalid`;
  return {
    id: s.id,
    name: s.name,
    state: s.state,
    storageMb: s.storageMb,
    requests24h: s.requests24h,
    lastActiveAt: ago(s.lastActiveMs),
    createdAt: ago(s.ageDays * DAY),
    region: s.region,
    host,
    connectionString: `postgresql://app_user:<password>@${host}:5432/${s.name.replace(/-/g, "_")}?sslmode=require`,
  };
});

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

function usageFor(db: Database, range: UsageRange): UsagePoint[] {
  const seed = Number(db.id.slice(3)) * 7919;
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
  const lines = databases.map((d) => {
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
  listDatabases: () => wait(databases.map((d) => ({ ...d }))),
  getDatabase: (id) => wait(databases.find((d) => d.id === id) ?? null),
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
