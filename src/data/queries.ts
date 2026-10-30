// Pure helpers behind the Supabase DataClient: they turn the dashboard's queries into
// function arguments and turn database rows back into the dashboard's types. They import
// only types, so they can be tested with no browser, no network and no Supabase.
import type { Database, DatabaseFilter, DatabaseGroup, DatabaseQuery, Invoice, Page, TagBreakdownRow, TagCount, UsagePoint, UsageQuery, UsageRow, UsageTrend } from "./types";

export type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** Filter parts shared by the list, ids and group calls. Empty values become null. */
export function filterArgs(f: DatabaseFilter = {}) {
  const search = (f.search ?? "").trim();
  return {
    p_search: search === "" ? null : search,
    p_state: f.state ?? null,
    p_keep: f.keepAwake ?? null,
    p_tags: f.tags && f.tags.length > 0 ? f.tags.map((t) => t.trim().toLowerCase()) : null,
  };
}

export function listArgs(q: DatabaseQuery = {}) {
  return {
    ...filterArgs(q),
    p_sort: q.sort ?? "name",
    p_dir: q.dir ?? "asc",
    p_page: Math.max(1, Math.floor(q.page ?? 1)),
    p_page_size: Math.min(200, Math.max(1, Math.floor(q.pageSize ?? 50))),
  };
}

/** First day of a "YYYY-MM" month, the form the database functions take. */
export function monthStart(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Choose a month.");
  return `${month}-01`;
}

export function usageArgs(q: UsageQuery) {
  return {
    p_month: monthStart(q.month),
    p_by: q.by,
    p_tag_key: q.by === "tag" && q.tagKey ? q.tagKey : null,
    p_sort: q.sort ?? "requests",
    p_dir: q.dir ?? "desc",
    p_page: Math.max(1, Math.floor(q.page ?? 1)),
    p_page_size: Math.min(5000, Math.max(1, Math.floor(q.pageSize ?? 50))),
  };
}

export function mapDatabase(row: Row, connection: (name: string) => { host: string; connectionString: string }): Database {
  const name = str(row.name);
  return {
    id: str(row.id),
    name,
    state: row.state === "awake" ? "awake" : "asleep",
    storageMb: num(row.storage_mb),
    requests24h: num(row.requests_24h),
    lastActiveAt: str(row.last_active_at),
    createdAt: str(row.created_at),
    region: str(row.region),
    ...connection(name),
    tags: Array.isArray(row.tags) ? (row.tags as unknown[]).map(String) : [],
    keepAwake: row.keep_awake === true,
    forkedFrom: row.forked_from ? str(row.forked_from) : null,
    restoredTo: row.restored_to ? str(row.restored_to) : null,
  };
}

export function mapPage<T>(json: Row, items: T[]): Page<T> {
  return { items, total: num(json.total), page: num(json.page) || 1, pageSize: num(json.pageSize) || items.length };
}

export const mapGroup = (r: Row): DatabaseGroup => ({
  value: r.value === null || r.value === undefined ? null : str(r.value),
  count: num(r.count),
  awake: num(r.awake),
  keepAwake: num(r.keep_awake),
  storageMb: num(r.storage_mb),
});

export const mapTag = (r: Row): TagCount => ({ key: str(r.key), value: str(r.value), count: num(r.count) });

export const mapBreakdown = (r: Row): TagBreakdownRow => ({ value: str(r.value), databases: num(r.databases), storageGb: num(r.storage_gb), requests: num(r.requests) });

export const mapUsagePoint = (r: Row): UsagePoint => ({ at: str(r.at), requests: num(r.requests), storageMb: num(r.storage_mb), awake: r.awake === true });

export const mapUsageRow = (r: Row): UsageRow => ({
  id: str(r.id),
  name: str(r.name),
  tags: Array.isArray(r.tags) ? (r.tags as unknown[]).map(String) : [],
  databases: num(r.databases),
  storageGb: num(r.storage_gb),
  requests: num(r.requests),
});

export const mapInvoice = (r: Row): Invoice => ({
  id: str(r.id),
  number: str(r.number),
  month: str(r.month),
  issuedAt: str(r.issuedAt),
  amount: num(r.amount),
  currency: str(r.currency) || "USD",
  status: r.status === "open" ? "open" : "paid",
});

/** The usage trend arrives with dates as "YYYY-MM-DD"; the chart wants ISO timestamps. */
export function mapTrend(json: Row): UsageTrend {
  const days = (Array.isArray(json.days) ? json.days : []).map((d) => `${String(d).slice(0, 10)}T00:00:00Z`);
  const series = (Array.isArray(json.series) ? (json.series as Row[]) : []).map((s) => ({
    label: str(s.label),
    values: (Array.isArray(s.values) ? (s.values as unknown[]) : []).map(num),
  }));
  return { days, series };
}

/** A few evenly spread points of a series, for the small trend lines on number cards. */
export function sparkFrom(values: number[], points = 12): number[] {
  if (values.length <= points) return values.map((v) => Math.round(v * 100) / 100);
  const step = values.length / points;
  return Array.from({ length: points }, (_, i) => Math.round(values[Math.min(values.length - 1, Math.round(i * step))] * 100) / 100);
}

/** What a person should read when a call fails, instead of a database error. */
export function friendlyError(err: { message?: string; code?: string; status?: number } | null | undefined): string {
  const message = (err?.message ?? "").trim();
  const code = err?.code ?? "";
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) return "Could not reach the server. Check your connection and try again.";
  if (/jwt expired|invalid jwt|not authenticated|no api key/i.test(message) || err?.status === 401) return "Your session has ended. Sign in again.";
  if (code === "42501" || /permission denied|row-level security/i.test(message)) return "You do not have access to that.";
  if (code === "23505") return message.includes("already exists") ? message : "That name is already taken.";
  if (code === "57014" || /statement timeout/i.test(message)) return "That took too long. Try a narrower filter.";
  if (!message) return "Something went wrong. Try again.";
  return message;
}
