// The DataClient on Supabase. Every method is one call to a database function (see
// supabase/migrations/0001_init.sql), so each change is a single transaction: a failure
// leaves nothing half done. The functions run as the signed-in user, so row level security
// decides what they can see and change.
import type { DataClient } from "./client";
import type { BillingOverview, ExportResult, Overview, Plan, Settings, UsageRange } from "./types";
import { getSupabase } from "../lib/supabaseClient";
import { blobUrl, usageCsv, usageCsvName } from "./files";
import { connectionStringFor } from "./connection";
import { simplePdf } from "./pdf";
import { PUBLIC_API_NOT_SET_UP } from "./public-keys";
import {
  filterArgs, friendlyError, isUuid, listArgs, mapBreakdown, mapDatabase, mapGroup, mapInvoice, mapPage, mapTag, mapTrend,
  mapUsagePoint, mapUsageRow, monthStart, sparkFrom, usageArgs, type Row,
} from "./queries";

const REGIONS = ["eu-west", "us-east", "us-west", "ap-south"];

const PLANS: Omit<Plan, "current">[] = [
  { id: "open-source", name: "Open source", price: "Free", period: "", description: "One database, run by you, on your machine or your cloud storage.", features: ["The complete engine", "MongoDB drivers and tools", "Community support"] },
  { id: "managed", name: "Managed", price: "$29", period: "/ month", description: "Includes 10 GB and 10 million requests, then pay for what you use.", features: ["Unlimited databases", "Asleep databases cost only storage", "Fork, restore, export, erase", "Usage per customer"] },
  { id: "dedicated", name: "Dedicated", price: "$499", period: "/ month", description: "Your own environment in the region you choose, plus usage.", features: ["Servers for you alone", "Region of your choice", "Keep busy customers awake", "Priority support"] },
  { id: "in-your-cloud", name: "In your cloud", price: "Custom", period: "", description: "Runs in your own cloud account. Your data never leaves it.", features: ["Your cloud, your region", "Single sign-on and audit log", "Support with an agreed response time"] },
];

const number = (n: number) => new Intl.NumberFormat("en-US").format(n);
const dayLabel = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/** One database function call. Failures become messages a person can read. */
async function call<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    const { data, error } = await getSupabase().rpc(fn, args);
    if (error) throw new Error(friendlyError(error));
    return data as T;
  } catch (e) {
    if (e instanceof Error) throw new Error(friendlyError({ message: e.message }));
    throw new Error(friendlyError(null));
  }
}

const toDatabase = (row: Row) => mapDatabase(row, connectionStringFor);

const noPublicApi = () => new Error(PUBLIC_API_NOT_SET_UP);

function download(filename: string, mimeType: string, content: string): ExportResult {
  return { filename, mimeType, downloadUrl: blobUrl(content, mimeType) };
}

export const supabaseClient: DataClient = {
  now: () => new Date(),

  async listDatabases(query) {
    const json = await call<Row>("fenvix_list_databases", listArgs(query));
    return mapPage(json, ((json.items as Row[]) ?? []).map(toDatabase));
  },

  async listDatabaseIds(filter) {
    return (await call<string[]>("fenvix_database_ids", filterArgs(filter))) ?? [];
  },

  async groupDatabases(groupBy, filter) {
    const json = await call<Row>("fenvix_group_databases", { p_group_by: groupBy, ...filterArgs(filter) });
    return { groupBy, total: Number(json.total ?? 0), groups: ((json.groups as Row[]) ?? []).map(mapGroup) };
  },

  async listTags() {
    return ((await call<Row[]>("fenvix_list_tags")) ?? []).map(mapTag);
  },

  async getDatabase(id) {
    if (!isUuid(id)) return null;
    const row = await call<Row | null>("fenvix_get_database", { p_id: id });
    return row ? toDatabase(row) : null;
  },

  async getOverview(range: UsageRange): Promise<Overview> {
    const json = await call<Row>("fenvix_overview", { p_range: range });
    const totals = (json.totals as Row) ?? {};
    const awakeSeries = ((json.awakeSeries as Row[]) ?? []).map((p) => ({ at: String(p.at), awake: Number(p.awake), total: Number(p.total) }));
    const requestSeries = ((json.requestSeries as Row[]) ?? []).map((p) => ({ at: String(p.at), requests: Number(p.requests) }));
    const costSeries = ((json.costSeries as Row[]) ?? []).map((p) => ({ at: String(p.at), cost: Number(p.cost), reference: p.reference === null ? null : Number(p.reference) }));
    const storage = ((json.storageSeries as unknown[]) ?? []).map(Number);
    const paid = costSeries.filter((p) => p.cost > 0).map((p) => p.cost);
    return {
      range,
      totals: {
        databases: Number(totals.databases ?? 0),
        awake: Number(totals.awake ?? 0),
        asleep: Number(totals.asleep ?? 0),
        asleepPercent: Number(totals.asleepPercent ?? 0),
        requests: Number(totals.requests ?? 0),
        storageGb: Number(totals.storageGb ?? 0),
        costMtd: Number(totals.costMtd ?? 0),
        currency: String(totals.currency ?? "USD"),
      },
      sparks: {
        databases: sparkFrom(awakeSeries.map((p) => p.total)),
        awake: sparkFrom(awakeSeries.map((p) => p.awake)),
        requests: sparkFrom(requestSeries.map((p) => p.requests)),
        storageGb: sparkFrom(storage),
        cost: sparkFrom(paid),
      },
      awakeSeries,
      requestSeries,
      costSeries,
      topDatabases: ((json.topDatabases as Row[]) ?? []).map((d) => ({ id: String(d.id), name: String(d.name), requests: Number(d.requests) })),
      recentWakeUps: ((json.recentWakeUps as Row[]) ?? []).map((w) => ({ id: String(w.id), name: String(w.name), at: String(w.at), latencyMs: Number(w.latencyMs) })),
    };
  },

  async getTagBreakdown(key, limit = 8) {
    return ((await call<Row[]>("fenvix_tag_breakdown", { p_key: key, p_limit: limit })) ?? []).map(mapBreakdown);
  },

  async getUsageTrend(month, tagKey) {
    return mapTrend(await call<Row>("fenvix_usage_trend", { p_month: monthStart(month), p_tag_key: tagKey }));
  },

  async listPlans() {
    const settings = await call<Row>("fenvix_settings");
    const current = String(settings?.plan ?? "managed");
    return PLANS.map((p) => ({ ...p, features: [...p.features], current: p.id === current }));
  },

  listRegions: async () => [...REGIONS],

  async createDatabase({ name, region, tags }) {
    return toDatabase(await call<Row>("fenvix_create_database", { p_name: name, p_region: region, p_tags: tags }));
  },

  async forkDatabase(id, name) {
    return toDatabase(await call<Row>("fenvix_fork_database", { p_id: id, p_name: name }));
  },

  async restoreDatabase(id, at) {
    return toDatabase(await call<Row>("fenvix_restore_database", { p_id: id, p_at: at }));
  },

  async exportDatabases(ids) {
    if (ids.length === 0) throw new Error("Nothing to export.");
    const rows = (await call<Row[]>("fenvix_export_databases", { p_ids: ids })) ?? [];
    if (rows.length === 0) throw new Error("Nothing to export.");
    const filename = rows.length === 1 ? `fenvix-export-${String(rows[0].name)}.json` : `fenvix-export-${rows.length}-databases.json`;
    return download(filename, "application/json", JSON.stringify({ exportedAt: new Date().toISOString(), databases: rows }, null, 2));
  },

  async eraseDatabases(ids) {
    return { affected: Number((await call<Row>("fenvix_erase_databases", { p_ids: ids })).affected ?? 0) };
  },

  async setKeepAwake(ids, enabled) {
    return { affected: Number((await call<Row>("fenvix_set_keep_awake", { p_ids: ids, p_enabled: enabled })).affected ?? 0) };
  },

  async setTags(id, tags) {
    return toDatabase(await call<Row>("fenvix_set_tags", { p_id: id, p_tags: tags }));
  },

  async addTags(ids, tags) {
    return { affected: Number((await call<Row>("fenvix_add_tags", { p_ids: ids, p_tags: tags })).affected ?? 0) };
  },

  async removeTags(ids, tags) {
    return { affected: Number((await call<Row>("fenvix_remove_tags", { p_ids: ids, p_tags: tags })).affected ?? 0) };
  },

  async getUsage(databaseId, range) {
    if (!isUuid(databaseId)) return [];
    return ((await call<Row[]>("fenvix_usage_series", { p_database: databaseId, p_range: range })) ?? []).map(mapUsagePoint);
  },

  async listUsageMonths() {
    return (await call<string[]>("fenvix_usage_months")) ?? [];
  },

  async getUsageReport(query) {
    const json = await call<Row>("fenvix_usage_report", usageArgs(query));
    const totals = (json.totals as Row) ?? {};
    return {
      ...mapPage(json, ((json.items as Row[]) ?? []).map(mapUsageRow)),
      month: String(json.month ?? query.month),
      totals: { databases: Number(totals.databases ?? 0), storageGb: Number(totals.storage_gb ?? 0), requests: Number(totals.requests ?? 0) },
    };
  },

  async getUsageHistory() {
    return ((await call<Row[]>("fenvix_usage_history")) ?? []).map((r) => ({ month: String(r.month), databases: Number(r.databases), storageGb: Number(r.storage_gb), requests: Number(r.requests) }));
  },

  async exportUsageReport(query) {
    const json = await call<Row>("fenvix_usage_export", {
      p_month: monthStart(query.month),
      p_by: query.by,
      p_tag_key: query.by === "tag" && query.tagKey ? query.tagKey : null,
      p_sort: query.sort ?? "requests",
      p_dir: query.dir ?? "desc",
    });
    const rows = ((json.items as Row[]) ?? []).map(mapUsageRow);
    return download(usageCsvName(query.month, query.by, query.tagKey), "text/csv", usageCsv(rows, query.by));
  },

  async getBilling(): Promise<BillingOverview> {
    const b = await call<Row>("fenvix_billing");
    const plan = PLANS.find((p) => p.id === b.plan) ?? PLANS[1];
    const start = String(b.periodStart ?? "");
    const end = String(b.periodEnd ?? "");
    const year = end.slice(0, 4);
    const payment = (b.paymentMethod as Row) ?? {};
    return {
      currency: String(b.currency ?? "USD"),
      plan: { name: plan.name, description: plan.description },
      monthToDate: {
        periodLabel: `${dayLabel(start)} to ${dayLabel(end).replace(/^\w+ /, "")}, ${year}`,
        lines: [
          { label: "Storage", quantity: `${number(Number(b.storageGbMonths ?? 0))} GB-months`, rate: `$${Number(b.storageRate ?? 0).toFixed(2)} per GB-month`, cost: Number(b.storageCost ?? 0) },
          { label: "Requests", quantity: `${number(Number(b.requests ?? 0))} requests`, rate: `$${Number(b.requestRate ?? 0).toFixed(2)} per million`, cost: Number(b.requestCost ?? 0) },
        ],
        total: Number(b.total ?? 0),
      },
      paymentMethod: { brand: String(payment.brand ?? ""), last4: String(payment.last4 ?? ""), expires: String(payment.expires ?? "") },
    };
  },

  async listInvoices(page = 1, pageSize = 12) {
    const json = await call<Row>("fenvix_list_invoices", { p_page: page, p_page_size: pageSize });
    return mapPage(json, ((json.items as Row[]) ?? []).map(mapInvoice));
  },

  async downloadInvoice(id) {
    if (!isUuid(id)) throw new Error("Invoice not found");
    const inv = await call<Row | null>("fenvix_get_invoice", { p_id: id });
    if (!inv) throw new Error("Invoice not found");
    const amount = Number(inv.amount ?? 0).toFixed(2);
    const pdf = simplePdf(["FENVIX", "", `Invoice ${String(inv.number)}`, `Workspace: ${String(inv.workspace ?? "")}`, `Month: ${String(inv.month)}`, `Issued: ${String(inv.issuedAt).slice(0, 10)}`, `Amount: ${String(inv.currency)} ${amount}`, `Status: ${String(inv.status)}`]);
    return { filename: `${String(inv.number)}.pdf`, mimeType: "application/pdf", downloadUrl: blobUrl(pdf, "application/pdf") };
  },

  // Public API keys live in the control plane only: without VITE_API_URL there is nothing to manage them with. The
  // page says so before calling these (pages/ApiKeys.tsx).
  listPublicApiKeys: () => Promise.reject(noPublicApi()),
  createPublicApiKey: () => Promise.reject(noPublicApi()),
  revokePublicApiKey: () => Promise.reject(noPublicApi()),

  async getSettings(): Promise<Settings> {
    const s = await call<Row>("fenvix_settings");
    return { workspaceName: String(s?.workspaceName ?? ""), idleMinutes: Number(s?.idleMinutes ?? 5), emailNotices: s?.emailNotices === true };
  },

  async saveSettings(next) {
    const s = await call<Row>("fenvix_save_settings", { p_name: next.workspaceName, p_idle: next.idleMinutes, p_notices: next.emailNotices });
    return { workspaceName: String(s.workspaceName), idleMinutes: Number(s.idleMinutes), emailNotices: s.emailNotices === true };
  },
};

