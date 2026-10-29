import type { DataClient } from "./client";
import type {
  ApiKey, BillingOverview, BulkResult, CreatedApiKey, Database, DatabaseFilter, DatabaseQuery, ExportResult, GroupedDatabases, Invoice, OperationKind,
  OperationOptions, OperationProgress, OperationStatus, Overview, Page, Plan, Settings, TagBreakdownRow, TagCount, UsageHistoryPoint, UsagePoint,
  UsageQuery, UsageReport, UsageTrend,
} from "./types";
import { ExplorerError } from "./explorer.ts";
import type { HttpOptions, HttpResponse, Method } from "./http.ts";
import { isUuid } from "./queries.ts";

/**
 * The DataClient on the control plane (docs/control-plane-api.md, control-plane/src/routes/data.ts). Everything the
 * dashboard reads or changes about databases, usage, billing, keys and settings goes through these routes; nothing
 * here calls a Supabase function.
 *
 * Writes carry an `Idempotency-Key`, one per action: a retry after a lost answer gets the first answer again instead
 * of doing the work twice. Create, fork, restore, export and erase are operations: the control plane waits up to
 * about 20 s and then answers `202 { operation }`; the client then polls `GET /operations/{id}` until it is done.
 *
 * The initial database user's password is only in the FIRST answer to a create or fork (201). When that answer was a
 * 202 or a replay, the finished operation carries `initialUser.password: null` and the screen says to reset it.
 */
export type Request = <T>(method: Method, path: string, opts?: HttpOptions) => Promise<HttpResponse<T>>;

export interface HttpDataDeps {
  request: Request;
  /** A new Idempotency-Key. */
  newKey?: () => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Between two polls of a running operation. */
  pollMs?: number;
  /** How long to keep polling before saying the operation goes on in the background. */
  maxWaitMs?: number;
}

/** What the control plane answers while an operation is still going. */
interface OperationView {
  id: string;
  kind: OperationKind;
  status: "queued" | "running" | "succeeded" | "failed";
  result: unknown;
  error: { code: string; message: string; field?: string } | null;
}

const STATUS_OF_CODE: Record<string, number> = { validation_failed: 400, unauthenticated: 401, forbidden: 403, not_found: 404, conflict: 409, rate_limited: 429, unavailable: 503 };

/** A lost answer, or a gateway that could not reach the service: safe to send again with the same key. */
const retriable = (e: unknown) => e instanceof ExplorerError && (e.code === "network" || e.status === 502 || e.status === 503 || e.status === 504);

function query(params: [string, string | number | boolean | undefined | null][]): string {
  const p = new URLSearchParams();
  for (const [k, v] of params) if (v !== undefined && v !== null && v !== "") p.append(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

function filterParams(f: DatabaseFilter = {}): [string, string | boolean | undefined][] {
  const out: [string, string | boolean | undefined][] = [["search", f.search?.trim() || undefined], ["state", f.state], ["keepAwake", f.keepAwake]];
  for (const t of f.tags ?? []) if (t.trim()) out.push(["tag", t.trim().toLowerCase()]);
  return out;
}

const enc = encodeURIComponent;

/** 128 random bits. randomUUID needs a secure context; getRandomValues works everywhere. */
function randomKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createHttpDataClient(deps: HttpDataDeps): DataClient {
  const { request } = deps;
  const newKey = deps.newKey ?? randomKey;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 1500;
  const maxWaitMs = deps.maxWaitMs ?? 10 * 60_000;

  const get = async <T>(path: string) => (await request<T>("GET", path)).data;

  /** A change, with one Idempotency-Key for the action and up to two resends when the answer was lost. */
  async function write<T>(method: Method, path: string, body?: unknown): Promise<HttpResponse<T>> {
    const headers = { "Idempotency-Key": newKey() };
    for (let attempt = 0; ; attempt++) {
      try {
        return await request<T>(method, path, { body, headers });
      } catch (e) {
        if (attempt >= 2 || !retriable(e)) throw e;
        await sleep(Math.min(5, (e as ExplorerError).retryAfter ?? attempt + 1) * 1000);
      }
    }
  }

  /** Submits an operation and waits for its end, reporting each status. */
  async function operation<T>(kind: OperationKind, path: string, body: unknown, opts: OperationOptions = {}): Promise<T> {
    let last: OperationStatus | null = null;
    let operationId: string | null = null;
    const report = (status: OperationStatus, error: string | null = null) => {
      if (status === last && !error) return;
      last = status;
      const p: OperationProgress = { kind, status, operationId, error };
      opts.onProgress?.(p);
    };
    const fail = (e: unknown): never => {
      report("failed", e instanceof Error ? e.message : "The operation failed.");
      throw e;
    };

    report("submitting");
    let first: HttpResponse<unknown>;
    try {
      first = await write<unknown>("POST", path, body);
    } catch (e) {
      return fail(e);
    }
    if (first.status !== 202) {
      report("succeeded");
      return first.data as T;
    }

    let op = (first.data as { operation: OperationView }).operation;
    operationId = op.id;
    const started = Date.now();
    let misses = 0;
    for (;;) {
      if (op.status === "succeeded") {
        report("succeeded");
        return op.result as T;
      }
      if (op.status === "failed") {
        const err = op.error;
        return fail(new ExplorerError(err?.code ?? "internal", err?.message || "The operation failed. Try again.", STATUS_OF_CODE[err?.code ?? ""] ?? 500, err?.field));
      }
      report(op.status);
      if (opts.signal?.aborted) return fail(new ExplorerError("aborted", "Stopped waiting. The work goes on in the background.", 0));
      if (Date.now() - started > maxWaitMs) {
        return fail(new ExplorerError("timeout", "This is taking longer than usual. It goes on in the background: check again in a few minutes.", 0));
      }
      await sleep(pollMs);
      try {
        op = await get<OperationView>(`/operations/${enc(op.id)}`);
        misses = 0;
      } catch (e) {
        // A blip while polling does not mean the operation failed: keep asking a few times.
        if (!retriable(e) || ++misses > 5) return fail(e);
      }
    }
  }

  return {
    now: deps.now ?? (() => new Date()),

    listDatabases: (q: DatabaseQuery = {}) =>
      get<Page<Database>>(`/databases${query([...filterParams(q), ["sort", q.sort], ["dir", q.dir], ["page", q.page], ["pageSize", q.pageSize]])}`),

    listDatabaseIds: async (filter) => (await get<{ ids: string[] }>(`/databases/ids${query(filterParams(filter))}`)).ids,

    groupDatabases: (groupBy, filter) => get<GroupedDatabases>(`/databases/groups${query([["groupBy", groupBy], ...filterParams(filter)])}`),

    listTags: async () => (await get<{ items: TagCount[] }>("/tags")).items,

    async getDatabase(id) {
      if (!isUuid(id)) return null;
      try {
        return await get<Database>(`/databases/${enc(id)}`);
      } catch (e) {
        if (e instanceof ExplorerError && e.status === 404) return null;
        throw e;
      }
    },

    getOverview: (range) => get<Overview>(`/overview${query([["range", range]])}`),
    getTagBreakdown: async (key, limit = 8) => (await get<{ items: TagBreakdownRow[] }>(`/tags/breakdown${query([["key", key], ["limit", limit]])}`)).items,
    getUsageTrend: (month, tagKey) => get<UsageTrend>(`/usage/trend${query([["month", month], ["tagKey", tagKey]])}`),
    listPlans: async () => (await get<{ items: Plan[] }>("/plans")).items,
    listRegions: async () => (await get<{ items: string[] }>("/regions")).items,

    createDatabase: ({ name, region, tags, appUser }, opts) =>
      operation<Database>("create", "/databases", { name, region, tags, ...(appUser ? { appUser } : {}) }, opts),
    forkDatabase: (id, name, opts) => operation<Database>("fork", `/databases/${enc(id)}/fork`, { name }, opts),
    restoreDatabase: (id, at, opts) => operation<Database>("restore", `/databases/${enc(id)}/restore`, { at }, opts),

    async exportDatabases(ids, opts) {
      if (ids.length === 0) throw new Error("Nothing to export.");
      return operation<ExportResult>("export", "/databases/export", { ids }, opts);
    },

    eraseDatabases: (ids, opts) => operation<BulkResult>("erase", "/databases/erase", { ids }, opts),

    setKeepAwake: async (ids, enabled) => (await write<BulkResult>("POST", "/databases/keep-awake", { ids, enabled })).data,
    setTags: async (id, tags) => (await write<Database>("PUT", `/databases/${enc(id)}/tags`, { tags })).data,
    addTags: async (ids, tags) => (await write<BulkResult>("POST", "/databases/tags/add", { ids, tags })).data,
    removeTags: async (ids, tags) => (await write<BulkResult>("POST", "/databases/tags/remove", { ids, tags })).data,

    async getUsage(databaseId, range) {
      if (!isUuid(databaseId)) return [];
      return (await get<{ items: UsagePoint[] }>(`/databases/${enc(databaseId)}/usage${query([["range", range]])}`)).items;
    },

    listUsageMonths: async () => (await get<{ items: string[] }>("/usage/months")).items,

    getUsageReport: (q: UsageQuery) =>
      get<UsageReport>(`/usage${query([["month", q.month], ["by", q.by], ["tagKey", q.by === "tag" ? q.tagKey : undefined], ["sort", q.sort], ["dir", q.dir], ["page", q.page], ["pageSize", q.pageSize]])}`),

    getUsageHistory: async () => (await get<{ items: UsageHistoryPoint[] }>("/usage/history")).items,

    exportUsageReport: (q: UsageQuery) =>
      get<ExportResult>(`/usage/export${query([["month", q.month], ["by", q.by], ["tagKey", q.by === "tag" ? q.tagKey : undefined], ["sort", q.sort], ["dir", q.dir]])}`),

    getBilling: () => get<BillingOverview>("/billing"),

    listInvoices: (page = 1, pageSize = 12) => get<Page<Invoice>>(`/invoices${query([["page", page], ["pageSize", pageSize]])}`),

    // A download link, not a change: the control plane ignores Idempotency-Key here.
    downloadInvoice: async (id) => (await request<ExportResult>("POST", `/invoices/${enc(id)}/download`)).data,

    listApiKeys: async () => (await get<{ items: ApiKey[] }>("/api-keys")).items,
    // The control plane makes the secret and shows it in this answer only (a replay is a 409, never the secret again).
    createApiKey: async (name) => (await write<CreatedApiKey>("POST", "/api-keys", { name })).data,
    revokeApiKey: async (id) => (await write<ApiKey>("POST", `/api-keys/${enc(id)}/revoke`)).data,

    getSettings: () => get<Settings>("/settings"),
    saveSettings: async (next) => (await write<Settings>("PUT", "/settings", next)).data,
  };
}
