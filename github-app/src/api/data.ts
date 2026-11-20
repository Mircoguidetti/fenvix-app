/*
 * Overview, projects, runs, tests, receipts, defects, usage, plans and billing: rows read as fenvix_api (row level
 * security limits them to the organization of the request), turned into the contract's records by the dashboard's own
 * mappers and calculations (src/data/ci-rows.ts, src/data/ci.ts, through shared.js).
 */
import { createHash } from "node:crypto";
import { type Ctx, type Handler, orgOf, Reply } from "./context.ts";
import type { Row, Tx } from "./db.ts";
import { notFound } from "./errors.ts";
import { LATEST_WARMUP } from "./github.ts";
import {
  activityFrom, auditFrom, billingFrom, dayStart, familiesOf, mapAuditRerun, mapDefect, mapExploration, mapPlan, mapProject, mapRate, mapReceipt,
  mapRun, mapTestResult, mapUsageEvent, median, monthBounds, monthOf, overviewFrom, type Plan, type Project, projectRow, type Run, setupChange,
  type Trial, trialFrom, usageCsv, usageCsvName, usageFrom,
} from "./shared.js";

const DAY = 86_400_000;
const NO_PROJECT = "That project does not exist in this organization.";
const NO_RUN = "That run does not exist in this organization.";

// ---------------------------------------------------------------- loading

/** Projects with GitHub's repository id (when the App knows the repository) and its shared cache's state. */
const PROJECTS = `select p.*, g.* from public.ci_projects p
  left join lateral (select r.repository_id, r.cache_warm_sha, r.cache_warm_at, r.cache_warm_source, wu.*
    from public.gh_repositories r ${LATEST_WARMUP}
    where r.project_id = p.id order by r.removed_at nulls first, r.repository_id limit 1) g on true
  where p.workspace_id = $1`;

export async function projects(t: Tx, ws: string): Promise<Project[]> {
  return (await t.q(`${PROJECTS} order by p.full_name`, [ws])).map(mapProject);
}

export async function project(t: Tx, ws: string, id: string): Promise<Project> {
  const r = await t.one(`${PROJECTS} and p.id = $2`, [ws, id]);
  if (!r) throw notFound(NO_PROJECT);
  return mapProject(r);
}

const runs = async (t: Tx, sql: string, params: unknown[]): Promise<Run[]> => (await t.q(`select * from public.ci_runs where ${sql}`, params)).map(mapRun);

/** A defect row with its current bundle's facts and its newest replay (the API's Defect record). */
export const DEFECT_ROWS = `select d.*, b.sha256 as bundle_sha256, b.size_bytes as bundle_size, b.received_at as bundle_received_at,
    (select row_to_json(x) from (select * from public.ci_replays rp where rp.id = d.last_replay_id) x) as last_replay
  from public.ci_defects d left join public.ci_defect_bundles b on b.id = d.bundle_id`;

async function defects(t: Tx, ws: string, where: string, params: unknown[], all: Project[], page: { limit: number; offset: number } = { limit: 100_000, offset: 0 }) {
  const byId = new Map(all.map((p) => [p.id, p]));
  const rows = await t.q(`${DEFECT_ROWS} where d.workspace_id = $1 ${where} order by d.last_seen_at desc, d.id limit ${Math.trunc(page.limit)} offset ${Math.trunc(page.offset)}`, [ws, ...params]);
  return rows.map((r) => mapDefect(r, byId.get(String(r.project_id))));
}

const events = async (t: Tx, ws: string, from: Date, to: Date) =>
  (await t.q("select project_id, occurred_at, billable, baseline_minutes from public.ci_usage_events where workspace_id = $1 and occurred_at >= $2 and occurred_at < $3",
    [ws, from, to])).map(mapUsageEvent);

interface Sub { plan_id: string; nightly_exploration_addon: boolean; trial_started_at: Date | null; trial_ends_at: Date | null }

/** Every plan and add-on, the organization's marked current; and its subscription. */
async function plans(t: Tx, ws: string): Promise<{ all: Plan[]; current: Plan | null; sub: Sub | undefined }> {
  const sub = await t.one<Sub & Row>("select * from public.ci_subscriptions where workspace_id = $1", [ws]);
  const rows = await t.q("select * from public.ci_plans order by sort, id");
  const all = rows.map((r) => r.kind === "addon"
    ? mapPlan(r, r.id === "nightly-exploration" && sub?.nightly_exploration_addon ? String(r.id) : null)
    : mapPlan(r, sub?.plan_id ?? null));
  return { all, current: all.find((p) => p.kind === "plan" && p.current) ?? null, sub };
}

const rate = async (t: Tx) => mapRate(await t.one("select * from public.ci_reference_rates where key = 'github-linux-2core'"));

/** The 30-day shadow trial, from the subscription's dates and the shadow runs and billable events of that window. */
async function trial(t: Tx, ws: string, sub: Sub | undefined, now: Date): Promise<Trial | null> {
  if (!sub?.trial_started_at || !sub.trial_ends_at) return null;
  const from = sub.trial_started_at;
  const to = sub.trial_ends_at;
  const shadow = await runs(t, "workspace_id = $1 and mode = 'shadow' and started_at >= $2 and started_at < $3", [ws, from, to]);
  return trialFrom({ startedAt: from.toISOString(), endsAt: to.toISOString() }, shadow, await events(t, ws, from, to), now);
}

const monthStart = (now: Date, back = 0) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));

// ---------------------------------------------------------------- overview and projects

export const getOverview: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const { t, now } = ctx;
  const all = await projects(t, ws);
  // This month and the month before (the same days of it, for the comparison).
  const recent = await runs(t, "workspace_id = $1 and started_at >= $2 order by started_at desc", [ws, monthStart(now, 1)]);
  const open = await defects(t, ws, "and state = 'open'", [], all);
  const p = await plans(t, ws);
  const month = monthBounds(monthOf(now));
  return overviewFrom(all, recent, open, p.current, await rate(t), now, await events(t, ws, month.start, month.end), await trial(t, ws, p.sub, now));
};

/** This month's runs and each project's latest run: what a project row shows. */
async function rowRuns(t: Tx, ws: string, now: Date, projectId?: string): Promise<Run[]> {
  const only = projectId ? " and project_id = $3" : "";
  const params = projectId ? [ws, monthStart(now), projectId] : [ws, monthStart(now)];
  const month = await runs(t, `workspace_id = $1 and started_at >= $2${only}`, params);
  const latest = await t.q(`select distinct on (project_id) * from public.ci_runs where workspace_id = $1 and started_at < $2${only} order by project_id, started_at desc`, params);
  return [...month, ...latest.map(mapRun)];
}

export const listProjects: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const all = await projects(ctx.t, ws);
  const rs = await rowRuns(ctx.t, ws, ctx.now);
  const open = await defects(ctx.t, ws, "and state = 'open'", [], all);
  return { items: all.map((p) => projectRow(p, rs, open, ctx.now)) };
};

/** A project's default branch is read again from GitHub when it was last read longer ago than this. */
export const DEFAULT_BRANCH_MAX_AGE_MS = 5 * 60_000;

/** True when the repository's row (default branch included) was last written longer ago than DEFAULT_BRANCH_MAX_AGE_MS. */
export function defaultBranchIsStale(checkedAt: unknown, now: Date): boolean {
  return !(checkedAt instanceof Date) || now.getTime() - checkedAt.getTime() >= DEFAULT_BRANCH_MAX_AGE_MS;
}

/**
 * A project page that loads with a default branch last stored more than a few minutes ago (gh_repositories.updated_at) asks the App's worker
 * to read it again (the worker holds the installation's token; the API does not). The page shows the stored branch now
 * and the fresh one on its next load. Never fails the request.
 */
async function refreshStaleDefaultBranch(ctx: Ctx, ws: string, projectId: string): Promise<void> {
  const repo = await ctx.t.one<Row>("select repository_id, updated_at from public.gh_repositories where workspace_id = $1 and project_id = $2 and removed_at is null order by repository_id limit 1", [ws, projectId]);
  if (!repo) return;
  if (!defaultBranchIsStale(repo.updated_at, ctx.now)) return;
  const repositoryId = Number(repo.repository_id);
  ctx.afterCommit(() => ctx.queue.enqueue({ kind: "refresh_default_branch", repositoryId }));
}

export const getProject: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const p = await project(ctx.t, ws, ctx.params.projectId);
  await refreshStaleDefaultBranch(ctx, ws, p.id);
  const open = await defects(ctx.t, ws, "and state = 'open' and project_id = $2", [p.id], [p]);
  return projectRow(p, await rowRuns(ctx.t, ws, ctx.now, p.id), open, ctx.now);
};

export const saveProjectSettings: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const s = ctx.body as { skipWithProof: boolean; commentOnPullRequests: boolean; nightlyExploration: boolean; testCommand: string };
  const updated = await ctx.t.q(
    `update public.ci_projects set skip_with_proof = $3, comment_on_pull_requests = $4, nightly_exploration = $5, test_command = $6
      where workspace_id = $1 and id = $2 returning id`,
    [ws, ctx.params.projectId, s.skipWithProof, s.commentOnPullRequests, s.nightlyExploration, s.testCommand.trim()]);
  if (!updated.length) throw notFound(NO_PROJECT);
  return project(ctx.t, ws, ctx.params.projectId);
};

// ---------------------------------------------------------------- runs

/** At most this many runs for `since` (the contract's bound). */
export const SINCE_MAX = 20_000;

export const listRuns: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const p = await project(ctx.t, ws, ctx.params.projectId);
  const q = ctx.query as { scope: "all" | "pr" | "default"; status: "all" | "passed" | "failed"; since?: string; page: number; pageSize: number };
  const where = ["workspace_id = $1", "project_id = $2"];
  const params: unknown[] = [ws, p.id];
  if (q.scope === "pr") where.push("pull_request is not null");
  if (q.scope === "default") { params.push(p.defaultBranch); where.push(`branch = $${params.length}`); }
  if (q.status === "passed" || q.status === "failed") { params.push(q.status); where.push(`status = $${params.length}`); }
  if (q.since) { params.push(new Date(q.since)); where.push(`started_at >= $${params.length}`); }
  const cond = where.join(" and ");
  const total = (await ctx.t.one<{ n: number }>(`select count(*)::int as n from public.ci_runs where ${cond}`, params))!.n;
  if (q.since) {
    const items = await runs(ctx.t, `${cond} order by started_at desc, number desc limit ${SINCE_MAX}`, params);
    return { items, total: Math.min(total, SINCE_MAX), page: 1, pageSize: Math.max(1, items.length) };
  }
  const items = await runs(ctx.t, `${cond} order by started_at desc, number desc limit $${params.length + 1} offset $${params.length + 2}`, [...params, q.pageSize, (q.page - 1) * q.pageSize]);
  return { items, total, page: q.page, pageSize: q.pageSize };
};

/** Median share of test time skipped with proof per day (finished runs), the last `days` days. */
export const getSkipShareSeries: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const p = await project(ctx.t, ws, ctx.params.projectId);
  const days = ctx.query.days as number;
  const from = dayStart(new Date(ctx.now.getTime() - (days - 1) * DAY));
  const rows = await ctx.t.q<{ started_at: Date; skip_share: number }>(
    "select started_at, skip_share from public.ci_runs where workspace_id = $1 and project_id = $2 and started_at >= $3 and status in ('passed', 'failed')", [ws, p.id, from]);
  const byDay = new Map<string, number[]>();
  for (const r of rows) {
    const k = dayStart(r.started_at).toISOString();
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(Number(r.skip_share));
  }
  const items = [];
  for (let t = from.getTime(); t <= ctx.now.getTime(); t += DAY) {
    const at = new Date(t).toISOString();
    const v = byDay.get(at) ?? [];
    items.push({ at, value: median(v) ?? 0, runs: v.length });
  }
  return { items };
};

export const listExplorations: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const p = await project(ctx.t, ws, ctx.params.projectId);
  const rows = await ctx.t.q("select * from public.ci_explorations where workspace_id = $1 and project_id = $2 order by started_at desc, id limit 120", [ws, p.id]);
  return { items: rows.map(mapExploration) };
};

export const getAudit: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const p = await project(ctx.t, ws, ctx.params.projectId);
  const to = new Date(ctx.now.getTime() + 1);
  const from = new Date(ctx.now.getTime() - (ctx.query.days as number) * DAY);
  const audited = await runs(ctx.t, "workspace_id = $1 and project_id = $2 and started_at >= $3 and started_at < $4 and audit_rerun > 0", [ws, p.id, from, to]);
  // The latest 50 and every untrusted key of the window: all auditFrom lists.
  const sql = (extra: string) => `select a.*, r.number as run_number from public.ci_audit_reruns a join public.ci_runs r on r.id = a.run_id
    where a.workspace_id = $1 and r.project_id = $2 and a.at >= $3 and a.at < $4 ${extra}`;
  const latest = await ctx.t.q(sql("order by a.at desc, a.test_id limit 50"), [ws, p.id, from, to]);
  const untrusted = await ctx.t.q(sql("and a.untrusted order by a.at desc limit 1000"), [ws, p.id, from, to]);
  const seen = new Set<string>();
  const reruns = [...latest, ...untrusted].filter((r) => { const k = `${r.run_id}|${r.test_id}`; return !seen.has(k) && !!seen.add(k); }).map(mapAuditRerun);
  return auditFrom(audited, reruns, from, to);
};

export const getSetupChange: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const p = await project(ctx.t, ws, ctx.params.projectId);
  // The workflow file and job the App found, when it has looked; else the usual ones.
  const repo = await ctx.t.one<{ onboarding_workflow_path: string | null; onboarding_job: string | null }>(
    "select onboarding_workflow_path, onboarding_job from public.gh_repositories where workspace_id = $1 and project_id = $2 order by removed_at nulls first limit 1", [ws, p.id]);
  const change = setupChange(p);
  return { ...change, path: repo?.onboarding_workflow_path || change.path, job: repo?.onboarding_job || change.job };
};

export const listActivity: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const projectId = ctx.query.projectId as string | undefined;
  const only = projectId ? [await project(ctx.t, ws, projectId)] : await projects(ctx.t, ws);
  const by = projectId ? " and project_id = $2" : "";
  const params = projectId ? [ws, projectId] : [ws];
  const rs = await runs(ctx.t, `workspace_id = $1${by} and status in ('passed', 'failed') order by finished_at desc nulls last limit 60`, params);
  const ds = (await ctx.t.q(`select * from public.ci_defects where workspace_id = $1${by} order by first_seen_at desc limit 50`, params))
    .map((r) => mapDefect(r, only.find((p) => p.id === String(r.project_id))));
  const es = (await ctx.t.q(`select * from public.ci_explorations where workspace_id = $1${by} order by finished_at desc limit 50`, params)).map(mapExploration);
  return { items: activityFrom(only, rs, ds, es, ctx.query.limit as number) };
};

// ---------------------------------------------------------------- one run: live view, tests, files, receipts

/**
 * The run page's validator: the run row's updated_at and progress_at (both change with every write, the runner's
 * progress included), and the project as shown (its settings can change while the run does not).
 */
export function runEtag(updatedAt: string, progressAt: string | null, project: unknown): string {
  const h = createHash("sha256").update(`${updatedAt}|${progressAt ?? ""}|${JSON.stringify(project)}`).digest("base64url");
  return `"r${h.slice(0, 27)}"`;
}

/** If-None-Match holds this ETag (or *): weak comparison, as RFC 9110 asks for If-None-Match. */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(header) ? header.join(",") : header ?? "";
  if (!raw.trim()) return false;
  const plain = etag.replace(/^W\//, "");
  return raw.split(",").map((s) => s.trim()).some((tag) => tag === "*" || tag.replace(/^W\//, "") === plain);
}

async function runRow(t: Tx, ws: string, id: string): Promise<Row> {
  const r = await t.one("select r.*, r.updated_at::text as etag_updated, r.progress_at::text as etag_progress from public.ci_runs r where r.workspace_id = $1 and r.id = $2", [ws, id]);
  if (!r) throw notFound(NO_RUN);
  return r;
}

export const getRun: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const r = await runRow(ctx.t, ws, ctx.params.runId);
  const p = await project(ctx.t, ws, String(r.project_id));
  const etag = runEtag(String(r.etag_updated), r.etag_progress === null ? null : String(r.etag_progress), p);
  const headers = { etag, "cache-control": "private, no-cache", vary: "Authorization, X-Fenvix-Workspace" };
  if (etagMatches(ctx.headers["if-none-match"], etag)) return new Reply(304, null, headers);
  return new Reply(200, { run: mapRun(r), project: p }, headers);
};

export const listTestResults: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const r = await runRow(ctx.t, ws, ctx.params.runId);
  const q = ctx.query as { outcome: "all" | "passed" | "failed" | "skipped_with_proof"; search?: string; page: number; pageSize: number };
  const where = ["workspace_id = $1", "run_id = $2"];
  const params: unknown[] = [ws, r.id];
  if (q.outcome !== "all") { params.push(q.outcome); where.push(`outcome = $${params.length}`); }
  const term = q.search?.trim().toLowerCase();
  if (term) { params.push(term); where.push(`strpos(lower(test_id), $${params.length}) > 0`); }
  const cond = where.join(" and ");
  const total = (await ctx.t.one<{ n: number }>(`select count(*)::int as n from public.ci_test_results where ${cond}`, params))!.n;
  // Failures first, then the tests that ran, then the skipped ones.
  const rows = await ctx.t.q(`select * from public.ci_test_results where ${cond}
    order by case outcome when 'failed' then 0 when 'passed' then 1 else 2 end, test_id limit $${params.length + 1} offset $${params.length + 2}`, [...params, q.pageSize, (q.page - 1) * q.pageSize]);
  return {
    items: rows.map(mapTestResult), total, page: q.page, pageSize: q.pageSize,
    // The run's own counts, whatever the filter (the run row holds them even when per-test results are not stored).
    counts: { passed: Number(r.tests_passed), failed: Number(r.tests_failed), skipped_with_proof: Number(r.tests_skipped) },
  };
};

export const listRunFiles: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const r = await runRow(ctx.t, ws, ctx.params.runId);
  // The file of a test id: before the first "::" (pytest) or " > " (Vitest, Jest), as fileOfTest (src/data/ci-rows.ts).
  const rows = await ctx.t.q<{ file: string; tests: number; ran: number; skipped: number; failed: number }>(
    `select f.file, count(*)::int as tests, count(*) filter (where outcome <> 'skipped_with_proof')::int as ran,
            count(*) filter (where outcome = 'skipped_with_proof')::int as skipped, count(*) filter (where outcome = 'failed')::int as failed
       from (select outcome, split_part(split_part(test_id, '::', 1), ' > ', 1) as file from public.ci_test_results where workspace_id = $1 and run_id = $2) f
      group by f.file order by f.file`, [ws, r.id]);
  return { items: rows };
};

export const getSkipReceipt: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const r = await ctx.t.one(`select s.*, rr.number as reused_run_number from public.ci_skip_receipts s
    left join public.ci_runs rr on rr.id = s.reused_run_id where s.workspace_id = $1 and s.id = $2`, [ws, ctx.params.receiptId]);
  if (!r) throw notFound("That receipt does not exist in this organization.");
  return mapReceipt(r, r.reused_run_number === null || r.reused_run_number === undefined ? null : Number(r.reused_run_number));
};

// ---------------------------------------------------------------- defects

async function defectList(ctx: Ctx) {
  const { id: ws } = orgOf(ctx);
  const q = ctx.query as { projectId?: string; state: "open" | "fixed" | "muted" | "all"; limit?: number; offset?: number };
  const all = q.projectId ? [await project(ctx.t, ws, q.projectId)] : await projects(ctx.t, ws);
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.projectId) { params.push(q.projectId); where.push(`and d.project_id = $${params.length + 1}`); }
  if (q.state !== "all") { params.push(q.state); where.push(`and d.state = $${params.length + 1}`); }
  const page = { limit: q.limit ?? 1000, offset: q.offset ?? 0 };
  const total = (await ctx.t.one<{ n: number }>(`select count(*)::int as n from public.ci_defects d where d.workspace_id = $1 ${where.join(" ")}`, [ws, ...params]))!.n;
  return { items: await defects(ctx.t, ws, where.join(" "), params, all, page), total };
}

export const listDefects: Handler = async (ctx) => defectList(ctx);
export const listDefectFamilies: Handler = async (ctx) => ({ items: familiesOf((await defectList(ctx)).items) });

export async function defectById(t: Tx, ws: string, id: string) {
  const r = await t.one(`${DEFECT_ROWS} where d.workspace_id = $1 and d.id = $2`, [ws, id]);
  if (!r) throw notFound("That defect does not exist in this organization.");
  return mapDefect(r, await project(t, ws, String(r.project_id)));
}

export const getDefect: Handler = async (ctx) => defectById(ctx.t, orgOf(ctx).id, ctx.params.defectId);

// ---------------------------------------------------------------- usage, plans, billing

export const listUsageMonths: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const rows = await ctx.t.q<{ m: string }>(
    `select to_char(started_at at time zone 'UTC', 'YYYY-MM') as m from public.ci_runs where workspace_id = $1
     union select to_char(month, 'YYYY-MM') from public.ci_usage_events where workspace_id = $1 and billable`, [ws]);
  return { items: [...new Set([monthOf(ctx.now), ...rows.map((r) => r.m)])].sort().reverse() };
};

async function usageReport(ctx: Ctx) {
  const { id: ws } = orgOf(ctx);
  const month = ctx.params.month as string;
  const { start, end } = monthBounds(month);
  const all = await projects(ctx.t, ws);
  const rs = await runs(ctx.t, "workspace_id = $1 and started_at >= $2 and started_at < $3", [ws, start, end]);
  const p = await plans(ctx.t, ws);
  return usageFrom(month, all, rs, p.current, await rate(ctx.t), await events(ctx.t, ws, start, end));
}

export const getUsage: Handler = async (ctx) => usageReport(ctx);

export const exportUsage: Handler = async (ctx) => {
  const report = await usageReport(ctx);
  return new Reply(200, usageCsv(report), {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${usageCsvName(report.month)}"`,
    "cache-control": "private, no-store",
  });
};

export const listPlans: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  return { items: (await plans(ctx.t, ws)).all };
};

export const getBilling: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const p = await plans(ctx.t, ws);
  // This month and the three before it (the average that sizes the suggested plan).
  const ev = await events(ctx.t, ws, monthStart(ctx.now, 3), monthStart(new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth() + 1, 1))));
  return billingFrom(p.all, await projects(ctx.t, ws), ev, await trial(ctx.t, ws, p.sub, ctx.now), ctx.now);
};
