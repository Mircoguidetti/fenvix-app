/*
 * GET /v1/projects/{projectId}/side-by-side: the console's "Today" (his test job's last 30 days: runs, time, cost) and
 * "Side by side" (per commit and event: his job beside ours, and the comparison result). Read as fenvix_api: row level
 * security limits gh_customer_jobs and the side-by-side gh_jobs rows to the organization's repositories.
 */
import { type Handler, orgOf } from "./context.ts";
import type { Row } from "./db.ts";
import { notFound } from "./errors.ts";
import { type HisJob, jobCost, median, type OurJob, pairJobs, type Price, priceOf, priceText, type Rate, seconds } from "../sidebyside/compare.ts";

const DAY = 86_400_000;
const PAGE = 50;
const date = (v: unknown): Date | null => (v instanceof Date ? v : v ? new Date(String(v)) : null);
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const range = (r: { min: number; max: number } | null) => (r ? { min: round(r.min), max: round(r.max) } : null);

function hisJob(r: Row): HisJob {
  return {
    jobId: Number(r.job_id), runAttempt: Number(r.run_attempt), headSha: String(r.head_sha), event: (r.event as string | null) ?? null,
    prNumber: r.pr_number === null || r.pr_number === undefined ? null : Number(r.pr_number), matrixSuffix: (r.matrix_suffix as string | null) ?? null,
    conclusion: (r.conclusion as string | null) ?? null, startedAt: date(r.started_at), completedAt: date(r.completed_at), labels: (r.labels as string[]) ?? [],
    steps: Array.isArray(r.steps) ? (r.steps as { name: string; conclusion: string | null }[]) : null,
  };
}

function ourJob(r: Row): OurJob & { checkoutSha: string | null } {
  return {
    jobId: Number(r.job_id), runAttempt: Number(r.run_attempt), headSha: String(r.head_sha), event: (r.event as string | null) ?? null,
    prNumber: r.pr_number === null || r.pr_number === undefined ? null : Number(r.pr_number), status: String(r.status), conclusion: (r.conclusion as string | null) ?? null,
    startedAt: date(r.started_at), completedAt: date(r.completed_at), skipMachine: r.skip_machine === true, hasSummary: (r.has_summary as boolean | null) ?? null,
    runStatus: (r.run_status as string | null) ?? null, testsRan: Number(r.tests_ran ?? 0), wouldSkipTests: Number(r.would_skip_tests ?? 0), wouldSaveMs: Number(r.would_save_ms ?? 0),
    checkoutSha: (r.checkout_sha as string | null) ?? null,
  };
}

const NOTES_DIFFERENT = [
  "A different result can come from other checks your test command runs (for example lint inside npm test), or from a model API answering differently between your run and ours.",
  "Two fenvix jobs of one repository running at once can swap machines (runners match by label only): the swapped side then shows no summary.",
];

export const getSideBySide: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const t = ctx.t;
  const project = await t.one("select id from public.ci_projects where workspace_id = $1 and id = $2", [ws, ctx.params.projectId]);
  if (!project) throw notFound("That project does not exist in this organization.");
  const repo = await t.one(
    `select repository_id, full_name, private, onboarding_state, side_by_side_matrix_suffix, side_by_side_test_step, side_by_side_job_name, history_cursor
       from public.gh_repositories where workspace_id = $1 and project_id = $2 order by removed_at nulls first, repository_id limit 1`, [ws, project.id]);
  const page = Math.max(1, Number(ctx.query.page ?? 1) || 1);
  const ours = { instanceType: ctx.cfg.sideBySideInstanceType, vcpus: ctx.cfg.sideBySideVcpus, usdPerHour: ctx.cfg.sideBySideUsdPerHour };
  const empty = { available: false, repository: null, today: null, header: null, ours, items: [], total: 0, page, pageSize: PAGE };
  if (!repo || !["side_by_side_pr_open", "side_by_side"].includes(String(repo.onboarding_state))) return empty;

  const rates = new Map<string, Rate>((await t.q(
    `select l.label, r.key, r.usd_per_minute, r.usd_per_minute_max, r.runner from public.ci_runner_label_rates l join public.ci_reference_rates r on r.key = l.rate_key`))
    .map((r) => [String(r.label), { key: String(r.key), usdPerMinute: Number(r.usd_per_minute), usdPerMinuteMax: r.usd_per_minute_max === null ? null : Number(r.usd_per_minute_max), runner: String(r.runner) }]));
  const his = (await t.q("select * from public.gh_customer_jobs where repository_id = $1 and completed_at > $2 order by completed_at desc limit 5000",
    [repo.repository_id, new Date(ctx.now.getTime() - 90 * DAY)])).map(hisJob);
  const mine = (await t.q(
    `select j.*, r.status as run_status, r.tests_ran, r.would_skip_tests, r.would_save_ms from public.gh_jobs j left join public.ci_runs r on r.id = j.ci_run_id
      where j.repository_id = $1 and j.kind = 'side_by_side' and coalesce(j.completed_at, j.created_at, j.updated_at) > $2 order by j.job_id desc limit 5000`,
    [repo.repository_id, new Date(ctx.now.getTime() - 90 * DAY)])).map(ourJob);
  const suffix = (repo.side_by_side_matrix_suffix as string | null) ?? null;
  const isPrivate = repo.private !== false;
  const priceOfJob = (h: HisJob): Price => priceOf(h.labels, isPrivate, rates);

  // ---------------------------------------------------------------- Today: his test job, the last 30 days
  const since = new Date(ctx.now.getTime() - 30 * DAY);
  const recent = his.filter((h) => (h.matrixSuffix ?? null) === suffix && h.completedAt && h.completedAt >= since);
  const finished = recent.filter((h) => h.conclusion === "success" || h.conclusion === "failure");
  const perDay = new Map<string, number>();
  for (const h of recent) { const k = h.completedAt!.toISOString().slice(0, 10); perDay.set(k, (perDay.get(k) ?? 0) + 1); }
  const daily = Array.from({ length: 30 }, (_, i) => perDay.get(new Date(ctx.now.getTime() - i * DAY).toISOString().slice(0, 10)) ?? 0);
  const medSeconds = median(finished.map((h) => seconds(h.startedAt, h.completedAt) ?? 0));
  const labels = new Map<string, number>();
  for (const h of finished) { const p = priceOfJob(h); labels.set(p.label, (labels.get(p.label) ?? 0) + 1); }
  const label = [...labels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const price = label ? priceOfJob(finished.find((h) => priceOfJob(h).label === label)!) : null;
  const perRun = medSeconds !== null && price ? jobCost(medSeconds, price) : null;
  const runsPerDay = recent.length ? median(daily) : null;
  const notes = ["GitHub plans include monthly minutes: the cost shown is before those.", `From your last ${recent.length} runs (30 days).`];
  if (price?.kind === "rate" && price.rate.key.startsWith("ubicloud")) notes.push("Ubicloud includes 1,250 free minutes a month.");
  const today = {
    runs: recent.length, runsPerDay, medianSeconds: medSeconds === null ? null : Math.round(medSeconds), runnerLabel: label,
    price: price ? priceText(price) : "no finished run yet", costPerRun: range(perRun),
    costPerMonth: perRun && runsPerDay !== null ? range({ min: perRun.min * runsPerDay * 30, max: perRun.max * runsPerDay * 30 }) : null,
    history: (repo.history_cursor as { done?: boolean } | null)?.done ? "read" : "reading", notes,
  };

  // ---------------------------------------------------------------- Side by side: the pairs
  const pairs = pairJobs(his, mine, { matrixSuffix: suffix, testStep: String(repo.side_by_side_test_step ?? ""), now: ctx.now });
  const heldMinutes = (u: OurJob) => (seconds(u.startedAt, u.completedAt) ?? 0) / 60;
  const view = pairs.map((p) => {
    const h = p.his;
    const u = p.ours as (OurJob & { checkoutSha: string | null }) | null;
    const hs = h ? seconds(h.startedAt, h.completedAt) : null;
    const hp = h ? priceOfJob(h) : null;
    return {
      headSha: p.key.headSha, event: p.key.event, prNumber: p.key.prNumber, result: p.result, detail: p.detail,
      notes: p.result === "different" ? NOTES_DIFFERENT : [],
      his: h ? { jobId: h.jobId, attempt: h.runAttempt, conclusion: h.conclusion, completedAt: iso(h.completedAt), seconds: hs === null ? null : Math.round(hs), price: priceText(hp!), cost: range(hs === null ? null : jobCost(hs, hp!)) } : null,
      ours: u ? {
        jobId: u.jobId, attempt: u.runAttempt, completedAt: iso(u.completedAt), seconds: Math.round(heldMinutes(u) * 60), vcpuMinutes: round(ours.vcpus * heldMinutes(u), 2),
        machineCost: round(heldMinutes(u) * ours.usdPerHour / 60), testsRan: u.testsRan, wouldSkipTests: u.wouldSkipTests, wouldSaveMs: u.wouldSaveMs,
        skipMachine: u.skipMachine, checkoutSha: u.checkoutSha,
      } : null,
    };
  });
  const comparable = view.filter((v) => (v.result === "same" || v.result === "different") && v.his && v.ours).slice(0, 20);
  const med = (xs: (number | null | undefined)[]) => { const m = median(xs.filter((x): x is number => typeof x === "number")); return m === null ? null : round(m); };
  const header = {
    pairs: comparable.length,
    same: comparable.filter((v) => v.result === "same").length,
    hisSeconds: med(comparable.map((v) => v.his!.seconds)), oursSeconds: med(comparable.map((v) => v.ours!.seconds)),
    hisCost: med(comparable.map((v) => v.his!.cost?.min)), oursMachineCost: med(comparable.map((v) => v.ours!.machineCost)),
    oursVcpuMinutes: med(comparable.map((v) => v.ours!.vcpuMinutes)),
  };
  return {
    available: true,
    repository: { fullName: String(repo.full_name), state: String(repo.onboarding_state), jobName: (repo.side_by_side_job_name as string | null) ?? null, testStep: (repo.side_by_side_test_step as string | null) ?? null, matrixSuffix: suffix },
    today, header, ours, items: view.slice((page - 1) * PAGE, page * PAGE), total: view.length, page, pageSize: PAGE,
  };
};
