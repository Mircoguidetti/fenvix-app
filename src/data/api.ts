/**
 * The dashboard's clients over the fenvix API (openapi/fenvix-api.yaml), with openapi-fetch and the `paths` generated
 * from that file (src/api/schema.d.ts): a path, a query name or a field that changes there breaks this build.
 *
 * Every request carries the person's Supabase session token (`Authorization: Bearer`) and, for an organization's data,
 * `X-Fenvix-Workspace: <organization id>`. The dashboard never reaches the database. Nothing is cached: requests use
 * `cache: "no-store"` and the live run view sends its own `If-None-Match`.
 *
 * No Vite or Supabase import here, so tests/unit/api.test.ts drives it with a stub fetch; src/data/index.ts and
 * src/data/orgs-client.ts wire it to the browser (VITE_API_URL, the session, the chosen organization).
 */
import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "../api/schema";
import type { DataClient, RunLive } from "./client.ts";
import type { OrgsClient } from "./orgs.ts";
import type { DefectFamily, Overview, Page, Run, RunDetail } from "./types.ts";
import { ApiError, SESSION_ENDED, UNREACHABLE, errorFromResponse } from "./api-errors.ts";

export interface ApiConfig {
  /** VITE_API_URL, including /v1, no trailing slash. Empty when the deployment has none. */
  baseUrl: string;
  /** The signed-in person's access token, or null when signed out. */
  token(): Promise<string | null>;
  /** The organization chosen in the browser (a UUID), or null. */
  workspace(): string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** The current time, for relative times on the screens. */
  now?: () => Date;
  /** A download link for text (URL.createObjectURL in the browser). */
  blobUrl?: (text: string, type: string) => string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const WORKSPACE = "X-Fenvix-Workspace";

/** The typed openapi-fetch client with the session token and timeouts; errors are left to `call`. */
export function createApi(cfg: ApiConfig) {
  const base = cfg.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const timed: typeof fetch = async (input, init) => {
    try {
      return await base(input, { ...init, signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError("network", UNREACHABLE, 0);
    }
  };
  // Without an address the request is still built (on a placeholder that is never fetched), so the middleware can
  // refuse it with a sentence instead of the browser's "Failed to parse URL".
  const api = createClient<paths>({ baseUrl: cfg.baseUrl || "https://not-configured.invalid/v1", fetch: timed, cache: "no-store", credentials: "omit" });
  const auth: Middleware = {
    async onRequest({ request }) {
      if (!cfg.baseUrl) throw new ApiError("not_configured", "This dashboard is not connected to fenvix yet: VITE_API_URL is not set.", 0);
      const token = await cfg.token();
      if (!token) throw new ApiError("unauthenticated", SESSION_ENDED, 401);
      request.headers.set("Authorization", `Bearer ${token}`);
      return request;
    },
  };
  api.use(auth);
  return api;
}

type Result<T> = { data?: T; error?: unknown; response: Response };

/** The data of a call, or the ApiError a screen can show. */
async function call<T>(p: Promise<Result<T>>): Promise<T> {
  const { data, error, response } = await p;
  if (!response.ok) throw errorFromResponse(response.status, error);
  return data as T;
}

/** The data, or null when the API answered 404 (a lookup by id of something that is not there, or not ours). */
async function orNull<T>(p: Promise<Result<T>>): Promise<T | null> {
  try {
    return await call(p);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** The file name in a Content-Disposition header. */
function fileName(disposition: string | null, fallback: string): string {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition ?? "");
  return m ? decodeURIComponent(m[1]) : fallback;
}

export function createApiDataClient(cfg: ApiConfig): DataClient {
  const api = createApi(cfg);
  /** The organization header every dashboard operation on an organization takes. */
  const ws = () => {
    const id = cfg.workspace();
    if (!id) throw new ApiError("no_organization", "Choose an organization first.", 0);
    return { [WORKSPACE]: id } as { "X-Fenvix-Workspace": string };
  };
  const blobUrl = cfg.blobUrl ?? ((text: string, type: string) => URL.createObjectURL(new Blob([text], { type })));

  return {
    now: cfg.now ?? (() => new Date()),
    sample: false,

    getOverview: () => call(api.GET("/overview", { params: { header: ws() } })) as Promise<Overview>,

    listProjects: async () => (await call(api.GET("/projects", { params: { header: ws() } }))).items,
    getProject: (id) => orNull(api.GET("/projects/{projectId}", { params: { header: ws(), path: { projectId: id } } })),
    saveProjectSettings: (id, settings) => call(api.PUT("/projects/{projectId}/settings", { params: { header: ws(), path: { projectId: id } }, body: settings })),
    listRuns: (projectId, q = {}) =>
      call(
        api.GET("/projects/{projectId}/runs", {
          params: { header: ws(), path: { projectId }, query: { scope: q.scope, status: q.status, since: q.since, page: q.page, pageSize: q.pageSize } },
        }),
      ) as Promise<Page<Run>>,
    getSkipShareSeries: async (projectId, days) => (await call(api.GET("/projects/{projectId}/skip-share", { params: { header: ws(), path: { projectId }, query: { days } } }))).items,
    getAudit: (projectId, days) => call(api.GET("/projects/{projectId}/audit", { params: { header: ws(), path: { projectId }, query: { days } } })),
    getSetupChange: (projectId) => call(api.GET("/projects/{projectId}/setup-change", { params: { header: ws(), path: { projectId } } })),

    getRun: (id) => orNull(api.GET("/runs/{runId}", { params: { header: ws(), path: { runId: id } } })) as Promise<RunDetail | null>,
    async getRunLive(id, etag): Promise<RunLive> {
      const header = etag ? { ...ws(), "If-None-Match": etag } : ws();
      const { data, error, response } = await api.GET("/runs/{runId}", { params: { header, path: { runId: id } } });
      if (response.status === 304) return { notModified: true };
      if (!response.ok) throw errorFromResponse(response.status, error);
      return { notModified: false, detail: data as RunDetail, etag: response.headers.get("ETag") };
    },
    listTestResults: (runId, q = {}) =>
      call(api.GET("/runs/{runId}/tests", { params: { header: ws(), path: { runId }, query: { outcome: q.outcome, search: q.search?.trim() || undefined, page: q.page, pageSize: q.pageSize } } })),
    getSkipReceipt: (id) => orNull(api.GET("/receipts/{receiptId}", { params: { header: ws(), path: { receiptId: id } } })),
    listRunFiles: async (runId) => (await call(api.GET("/runs/{runId}/files", { params: { header: ws(), path: { runId } } }))).items,

    listExplorations: async (projectId) => (await call(api.GET("/projects/{projectId}/explorations", { params: { header: ws(), path: { projectId } } }))).items,
    listActivity: async (projectId, limit) => (await call(api.GET("/activity", { params: { header: ws(), query: { projectId, limit } } }))).items,

    search: async (q) => (await call(api.GET("/search", { params: { header: ws(), query: { q } } }))).items,

    listDefects: async (q = {}) => (await call(api.GET("/defects", { params: { header: ws(), query: { projectId: q.projectId || undefined, state: q.state } } }))).items,
    listDefectFamilies: async (q = {}) =>
      (await call(api.GET("/defect-families", { params: { header: ws(), query: { projectId: q.projectId || undefined, state: q.state } } }))).items as DefectFamily[],
    getDefect: (id) => orNull(api.GET("/defects/{defectId}", { params: { header: ws(), path: { defectId: id } } })),

    listUsageMonths: async () => (await call(api.GET("/usage/months", { params: { header: ws() } }))).items,
    getUsage: (month) => call(api.GET("/usage/{month}", { params: { header: ws(), path: { month } } })),
    async exportUsage(month) {
      const { data, error, response } = await api.GET("/usage/{month}/csv", { params: { header: ws(), path: { month } }, parseAs: "text" });
      if (!response.ok) throw errorFromResponse(response.status, error);
      return { filename: fileName(response.headers.get("Content-Disposition"), `fenvix-usage-${month}.csv`), mimeType: "text/csv", downloadUrl: blobUrl(String(data ?? ""), "text/csv") };
    },

    listPlans: async () => (await call(api.GET("/plans", { params: { header: ws() } }))).items,
    getBilling: () => call(api.GET("/billing", { params: { header: ws() } })),

    getGitHubConnection: () => call(api.GET("/github", { params: { header: ws() } })),
    listGitHubRepositories: async () => (await call(api.GET("/github/repositories", { params: { header: ws() } }))).items,
    createInstallLink: async () => (await call(api.POST("/github/install-link", { params: { header: ws() } }))).url,
    // No organization header: the completion names its organization (the install link's), and the API links only for
    // the person that link was made for.
    completeGitHubInstall: (completion) => call(api.POST("/github/installations/complete", { body: { completion } })),
    openSetupPullRequest: (repositoryId) => call(api.POST("/github/repositories/{repositoryId}/setup-pull-request", { params: { header: ws(), path: { repositoryId } } })),
    getOnboardingKind: () => call(api.GET("/organization/onboarding-kind", { params: { header: ws() } })),
    setOnboardingKind: (kind) => call(api.PUT("/organization/onboarding-kind", { params: { header: ws() }, body: { kind } })),

    getSettings: () => call(api.GET("/settings", { params: { header: ws() } })),
    saveSettings: (next) => call(api.PUT("/settings", { params: { header: ws() }, body: next })),
  };
}

export function createApiOrgsClient(cfg: ApiConfig): OrgsClient {
  const api = createApi(cfg);
  const ws = () => {
    const id = cfg.workspace();
    if (!id) throw new ApiError("no_organization", "Choose an organization first.", 0);
    return { [WORKSPACE]: id } as { "X-Fenvix-Workspace": string };
  };
  return {
    available: cfg.baseUrl !== "",
    me: () => call(api.GET("/me")),
    listOrganizations: async () => (await call(api.GET("/organizations"))).items,
    createOrganization: async (name) => (await call(api.POST("/organizations", { body: { name } }))).organization,
    renameOrganization: (name) => call(api.PUT("/organization", { params: { header: ws() }, body: { name } })),
    async leaveOrganization() {
      await call(api.POST("/organization/leave", { params: { header: ws() } }));
    },
    listMembers: () => call(api.GET("/organization/members", { params: { header: ws() } })),
    async changeRole(userId, role) {
      await call(api.PUT("/organization/members/{userId}", { params: { header: ws(), path: { userId } }, body: { role } }));
    },
    async removeMember(userId) {
      await call(api.DELETE("/organization/members/{userId}", { params: { header: ws(), path: { userId } } }));
    },
    listInvitations: async () => (await call(api.GET("/organization/invitations", { params: { header: ws() } }))).items,
    createInvitation: (email, role) => call(api.POST("/organization/invitations", { params: { header: ws() }, body: { email, role } })),
    async revokeInvitation(id) {
      await call(api.POST("/organization/invitations/{id}/revoke", { params: { header: ws(), path: { id } } }));
    },
    acceptInvitation: async (token) => (await call(api.POST("/invitations/accept", { body: { token } }))).organization,
  };
}
