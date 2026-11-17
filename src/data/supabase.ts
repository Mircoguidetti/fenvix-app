// The DataClient on Supabase: reads the CI tables of supabase/migrations/0011_ci_runs.sql as the signed-in user, so
// row level security decides what is visible. The numbers on the screens are computed by src/data/ci.ts from those rows,
// exactly as for the mock. Writes the browser may make: a project's settings (owner or admin) and the organization's
// notification setting. Connecting a repository needs the fenvix GitHub App and the control plane, which this
// deployment does not have yet: those calls say so.
import type { DataClient } from "./client";
import type { Defect, Page, Plan, Project, Run, Settings, TestOutcome, TestPage } from "./types";
import { getSupabase } from "../lib/supabaseClient";
import { activeOrgId } from "../lib/org";
import { blobUrl } from "./files";
import { PUBLIC_API_NOT_SET_UP } from "./public-keys";
import { activityFrom, billingFrom, dayStart, familiesOf, median, monthBounds, monthOf, overviewFrom, projectRow, setupChange, usageCsv, usageCsvName, usageFrom } from "./ci";
import { mapExploration, mapDefect, mapPlan, mapProject, mapRate, mapReceipt, mapRun, mapTestResult, friendlyError, type Row } from "./ci-rows";

const DAY = 86_400_000;
const NO_GITHUB_APP = "Connecting repositories needs the fenvix GitHub App, which is not set up for this deployment yet.";

type Query = PromiseLike<{ data: unknown; error: { message: string } | null; count?: number | null }>;

async function rows<T = Row>(q: Query): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new Error(friendly(error.message));
  return (data as T[]) ?? [];
}

const friendly = (message: string) => friendlyError({ message });

const db = () => getSupabase();

/** The organization the browser shows (current_workspace() honours the X-Fenvix-Workspace header for a member). */
const workspaces = new Map<string, Promise<string>>();
function ws(): Promise<string> {
  const key = activeOrgId() ?? "";
  let found = workspaces.get(key);
  if (!found) {
    found = (async () => {
      const { data, error } = await db().rpc("current_workspace");
      if (error || !data) throw new Error(error ? friendly(error.message) : "You are not a member of any organization yet.");
      return String(data);
    })();
    found.catch(() => workspaces.delete(key));
    workspaces.set(key, found);
  }
  return found;
}

async function projects(): Promise<Project[]> {
  return (await rows(db().from("ci_projects").select("*").eq("workspace_id", await ws()).order("full_name"))).map(mapProject);
}

/** Runs since `from`, newest first. */
async function runsSince(from: Date): Promise<Run[]> {
  const q = db().from("ci_runs").select("*").eq("workspace_id", await ws()).gte("started_at", from.toISOString()).order("started_at", { ascending: false }).limit(20000);
  return (await rows(q)).map(mapRun);
}

async function defects(): Promise<Defect[]> {
  const [ps, rs] = await Promise.all([projects(), rows(db().from("ci_defects").select("*").eq("workspace_id", await ws()).order("last_seen_at", { ascending: false }))]);
  const byId = new Map(ps.map((p) => [p.id, p]));
  return rs.map((r) => mapDefect(r, byId.get(String(r.project_id))));
}

async function plans(): Promise<Plan[]> {
  const [ps, sub] = await Promise.all([rows(db().from("ci_plans").select("*").order("sort")), rows(db().from("ci_subscriptions").select("plan_id").eq("workspace_id", await ws()))]);
  const current = sub[0] ? String(sub[0].plan_id) : null;
  return ps.map((p) => mapPlan(p, current));
}

async function rate() {
  const r = await rows(db().from("ci_reference_rates").select("*").eq("key", "github-linux-2core"));
  return mapRate(r[0]);
}

const startOfPreviousMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

export const supabaseClient: DataClient = {
  now: () => new Date(),
  sample: false,

  async getOverview() {
    const now = new Date();
    const [ps, rs, ds, pl, rt] = await Promise.all([projects(), runsSince(new Date(Math.min(startOfPreviousMonth(now).getTime(), now.getTime() - 30 * DAY))), defects(), plans(), rate()]);
    return overviewFrom(ps, rs, ds, pl.find((p) => p.current) ?? null, rt, now);
  },

  async listProjects() {
    const now = new Date();
    const [ps, rs, ds] = await Promise.all([projects(), runsSince(monthBounds(monthOf(now)).start), defects()]);
    return ps.map((p) => projectRow(p, rs, ds, now));
  },
  async getProject(id) {
    return (await this.listProjects()).find((p) => p.id === id) ?? null;
  },
  async saveProjectSettings(id, s) {
    const q = db()
      .from("ci_projects")
      .update({ skip_with_proof: s.skipWithProof, comment_on_pull_requests: s.commentOnPullRequests, nightly_exploration: s.nightlyExploration, test_command: s.testCommand.trim() })
      .eq("id", id)
      .select("*");
    const r = await rows(q);
    if (!r[0]) throw new Error("Your role in this organization is read only. Ask an owner or admin to do this.");
    return mapProject(r[0]);
  },
  async listRuns(projectId, q = {}) {
    const { page = 1, pageSize = 25 } = q;
    let query = db().from("ci_runs").select("*", { count: "exact" }).eq("project_id", projectId);
    if (q.scope === "pr") query = query.not("pull_request", "is", null);
    if (q.status === "passed" || q.status === "failed") query = query.eq("status", q.status);
    const { data, error, count } = await query.order("started_at", { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
    if (error) throw new Error(friendly(error.message));
    let items = ((data as Row[]) ?? []).map(mapRun);
    if (q.scope === "default") {
      const p = (await projects()).find((x) => x.id === projectId);
      items = items.filter((r) => r.branch === p?.defaultBranch);
    }
    return { items, total: count ?? items.length, page, pageSize } satisfies Page<Run>;
  },
  async getSkipShareSeries(projectId, days) {
    const now = new Date();
    const from = dayStart(new Date(now.getTime() - (days - 1) * DAY));
    const rs = (await rows(db().from("ci_runs").select("started_at, skip_share, status").eq("project_id", projectId).gte("started_at", from.toISOString()))).filter((r) => r.status === "passed" || r.status === "failed");
    const out = [];
    for (let t = from.getTime(); t <= now.getTime(); t += DAY) {
      const k = new Date(t).toISOString().slice(0, 10);
      const v = rs.filter((r) => String(r.started_at).slice(0, 10) === k).map((r) => Number(r.skip_share));
      out.push({ at: new Date(t).toISOString(), value: median(v) ?? 0, runs: v.length });
    }
    return out;
  },

  async getRun(id) {
    const r = await rows(db().from("ci_runs").select("*").eq("id", id));
    if (!r[0]) return null;
    const p = await rows(db().from("ci_projects").select("*").eq("id", String(r[0].project_id)));
    return p[0] ? { run: mapRun(r[0]), project: mapProject(p[0]) } : null;
  },
  async listTestResults(runId, q = {}) {
    const { page = 1, pageSize = 50 } = q;
    let query = db().from("ci_test_results").select("*", { count: "exact" }).eq("run_id", runId);
    if (q.outcome && q.outcome !== "all") query = query.eq("outcome", q.outcome);
    if (q.search?.trim()) query = query.ilike("test_id", `%${q.search.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`);
    const { data, error, count } = await query.order("outcome").order("test_id").range((page - 1) * pageSize, page * pageSize - 1);
    if (error) throw new Error(friendly(error.message));
    const run = await rows(db().from("ci_runs").select("tests_passed, tests_failed, tests_skipped").eq("id", runId));
    const counts: Record<TestOutcome, number> = { passed: Number(run[0]?.tests_passed ?? 0), failed: Number(run[0]?.tests_failed ?? 0), skipped_with_proof: Number(run[0]?.tests_skipped ?? 0) };
    return { items: ((data as Row[]) ?? []).map(mapTestResult), total: count ?? 0, page, pageSize, counts } satisfies TestPage;
  },
  async listRunFiles(runId) {
    const rs = await rows(db().from("ci_test_results").select("test_id, outcome").eq("run_id", runId).limit(100000));
    const files = new Map<string, { file: string; tests: number; ran: number; skipped: number; failed: number }>();
    for (const r of rs) {
      const file = String(r.test_id).split(/::| > /)[0];
      const f = files.get(file) ?? { file, tests: 0, ran: 0, skipped: 0, failed: 0 };
      f.tests++;
      if (r.outcome === "failed") f.failed++;
      else if (r.outcome === "skipped_with_proof") f.skipped++;
      else f.ran++;
      files.set(file, f);
    }
    return [...files.values()];
  },
  async listExplorations(projectId) {
    return (await rows(db().from("ci_explorations").select("*").eq("project_id", projectId).order("started_at", { ascending: false }).limit(90))).map(mapExploration);
  },
  async listActivity(projectId, limit = 8) {
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    let rq = db().from("ci_runs").select("*").eq("workspace_id", await ws()).gte("started_at", since).order("started_at", { ascending: false }).limit(60);
    let eq = db().from("ci_explorations").select("*").eq("workspace_id", await ws()).gte("started_at", since).order("started_at", { ascending: false }).limit(30);
    if (projectId) {
      rq = rq.eq("project_id", projectId);
      eq = eq.eq("project_id", projectId);
    }
    const [ps, rs, ds, es] = await Promise.all([projects(), rows(rq), defects(), rows(eq)]);
    const keep = <T extends { projectId: string }>(xs: T[]) => (projectId ? xs.filter((x) => x.projectId === projectId) : xs);
    return activityFrom(projectId ? ps.filter((p) => p.id === projectId) : ps, rs.map(mapRun), keep(ds), es.map(mapExploration), limit);
  },
  async listRunsSince(projectId, since) {
    return (await rows(db().from("ci_runs").select("*").eq("project_id", projectId).gte("started_at", since).order("started_at", { ascending: false }).limit(20000))).map(mapRun);
  },
  async getSkipReceipt(id) {
    const r = await rows(db().from("ci_skip_receipts").select("*").eq("id", id));
    if (!r[0]) return null;
    const reused = r[0].reused_run_id ? await rows(db().from("ci_runs").select("number").eq("id", String(r[0].reused_run_id))) : [];
    return mapReceipt(r[0], reused[0] ? Number(reused[0].number) : null);
  },

  async listDefects(q = {}) {
    return (await defects()).filter((d) => (!q.projectId || d.projectId === q.projectId) && (q.state === "all" || d.state === (q.state ?? "open")));
  },
  async listDefectFamilies(q) {
    return familiesOf(await this.listDefects(q));
  },
  async getDefect(id) {
    return (await defects()).find((d) => d.id === id) ?? null;
  },

  async listUsageMonths() {
    const rs = await rows(db().from("ci_runs").select("started_at").eq("workspace_id", await ws()).order("started_at", { ascending: true }).limit(1));
    const now = new Date();
    const first = rs[0] ? new Date(String(rs[0].started_at)) : now;
    const out: string[] = [];
    for (let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); d >= new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1)); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))) out.push(monthOf(d));
    return out;
  },
  async getUsage(month) {
    const { start, end } = monthBounds(month);
    const [ps, pl, rt, rs] = await Promise.all([projects(), plans(), rate(), runsSince(start)]);
    return usageFrom(month, ps, rs.filter((r) => r.startedAt < end.toISOString()), pl.find((p) => p.current) ?? null, rt);
  },
  async exportUsage(month) {
    const report = await this.getUsage(month);
    return { filename: usageCsvName(month), mimeType: "text/csv", downloadUrl: blobUrl(usageCsv(report), "text/csv") };
  },

  listPlans: () => plans(),
  async getBilling() {
    const now = new Date();
    const [pl, ps, rs] = await Promise.all([plans(), projects(), runsSince(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)))]);
    return billingFrom(pl, ps, rs, now);
  },

  async getGitHubConnection() {
    const sub = await rows(db().from("ci_subscriptions").select("github_account").eq("workspace_id", await ws()));
    return { account: sub[0]?.github_account ? String(sub[0].github_account) : null, installUrl: null };
  },
  async listGitHubRepositories() {
    return (await projects()).map((p) => ({ fullName: p.fullName, private: true, language: p.language, testRunner: p.testRunner, connected: true }));
  },
  installGitHubApp: () => Promise.reject(new Error(NO_GITHUB_APP)),
  completeInstallation: () => Promise.reject(new Error(NO_GITHUB_APP)),
  async getSetupChange(projectId) {
    const p = (await projects()).find((x) => x.id === projectId);
    if (!p) throw new Error("That project does not exist.");
    return setupChange(p);
  },
  openSetupPullRequest: () => Promise.reject(new Error(NO_GITHUB_APP)),

  listPublicApiKeys: () => Promise.reject(new Error(PUBLIC_API_NOT_SET_UP)),
  createPublicApiKey: () => Promise.reject(new Error(PUBLIC_API_NOT_SET_UP)),
  revokePublicApiKey: () => Promise.reject(new Error(PUBLIC_API_NOT_SET_UP)),

  async getSettings(): Promise<Settings> {
    const { data, error } = await db().rpc("fenvix_settings");
    if (error) throw new Error(friendly(error.message));
    const s = (data ?? {}) as Row;
    return { workspaceName: String(s.workspaceName ?? ""), emailNotices: s.emailNotices === true };
  },
  async saveSettings(next) {
    const { data, error } = await db().rpc("fenvix_save_settings", { p_name: next.workspaceName, p_idle: 5, p_notices: next.emailNotices });
    if (error) throw new Error(friendly(error.message));
    const s = (data ?? {}) as Row;
    return { workspaceName: String(s.workspaceName ?? next.workspaceName), emailNotices: s.emailNotices === true };
  },
};
