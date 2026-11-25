/*
 * Pure functions over the contract's records (docs/data-contract.md), shared by every backend: the mock and Supabase
 * load rows, these turn them into what the screens show. No I/O here, so tests/unit/ci.test.ts covers all of it.
 */
import type {
  ActivityItem, AuditRerun, AuditSummary, Exploration, MissKind, SearchResult,
  BillingOverview, DayPoint, Defect, DefectFamily, GitHubRate, MinuteBreakdown, Overview, Plan, Project, ProjectRow, Run, RunProof, SetupChange, Trial, UsageProjectRow, UsageReport,
} from "./types";

/**
 * One usage event (ci_usage_events): one GitHub job that asked for a fenvix machine. Only billable events count.
 * baselineMinutes = the minutes the job held a fenvix machine, by GitHub's own job timings (started_at to
 * completed_at), never by anything the job writes (review R-016 F3; docs/data-contract.md "Run units").
 */
export interface UsageEvent {
  projectId: string | null;
  occurredAt: string;
  billable: boolean;
  baselineMinutes: number;
}

/** The organization's trial dates (ci_subscriptions), when it has one. */
export interface TrialDates {
  startedAt: string;
  endsAt: string;
}

/** 1 run unit = 10 baseline minutes (minutes a job held a fenvix machine, by GitHub's timings). */
export const MINUTES_PER_UNIT = 10;
/** The trial's gate: fenvix would have skipped at least this share of test time. */
export const TRIAL_GATE = 0.35;

const DAY = 86_400_000;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** "YYYY-MM" of a time, in UTC. */
export const monthOf = (iso: string | Date) => (typeof iso === "string" ? iso : iso.toISOString()).slice(0, 7);

/** First instant of a month and of the month after it. */
export function monthBounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

export const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** ISO day starts from `from` to `to` included. */
export function daysBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let t = dayStart(from).getTime(); t <= dayStart(to).getTime(); t += DAY) out.push(new Date(t).toISOString());
  return out;
}

/**
 * Rounds numbers to `decimals` so that the rounded values add up to the rounded sum (largest-remainder rule). A screen
 * that shows parts and their total never shows "1 + 1 = 3".
 */
export function roundToSum(values: number[], decimals = 0): number[] {
  const f = 10 ** decimals;
  const scaled = values.map((v) => v * f);
  const floors = scaled.map((v) => Math.floor(v + 1e-9));
  let left = Math.round(scaled.reduce((a, b) => a + b, 0)) - floors.reduce((a, b) => a + b, 0);
  const order = scaled.map((v, i) => [v - floors[i], i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floors[i]++;
    left--;
  }
  return floors.map((v) => Math.round(v) / f);
}

/** Exact minutes of a set of runs: tests run, tests skipped with proof, other steps. */
function exactMinutes(runs: Run[]): [number, number, number] {
  let ran = 0;
  let skipped = 0;
  let other = 0;
  for (const r of runs) {
    ran += r.testTimeMs.ran / 60000;
    skipped += r.testTimeMs.skipped / 60000;
    other += r.otherStepMinutes;
  }
  return [ran, skipped, other];
}

/** Minutes that add up on screen: ran + skipped + other = total, each rounded to `decimals`. */
export function minuteBreakdown(parts: [number, number, number], decimals = 0): MinuteBreakdown {
  const [ran, skipped, other] = roundToSum(parts, decimals);
  return { ran, skipped, other, total: Math.round((ran + skipped + other) * 10 ** decimals) / 10 ** decimals };
}

/** One run's minutes, to one decimal. */
export const runMinutes = (r: Run): MinuteBreakdown => minuteBreakdown([r.testTimeMs.ran / 60000, r.testTimeMs.skipped / 60000, r.otherStepMinutes], 1);

/** A run not proven: its status says so, or it holds tests not proven (one predicate for every screen). */
export const isNotProven = (r: Pick<Run, "status" | "tests">) => r.status === "not_proven" || (r.tests.notProven ?? 0) > 0;

/** Finished: passed, failed or not proven (finished, never green). Only `passed` is green (time to green). */
export const finished = (r: Run) => r.status === "passed" || r.status === "failed" || r.status === "not_proven";
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Time to green per commit: from the push to the end of the first passing run of that commit, in seconds. Median over
 * the commits whose first passing run started in [from, to).
 */
export function medianTimeToGreen(runs: Run[], from: Date, to: Date): { medianS: number | null; commits: number } {
  const firstGreen = new Map<string, Run>();
  for (const r of runs) {
    if (r.status !== "passed" || !r.finishedAt) continue;
    const key = `${r.projectId}:${r.commitSha}`;
    const seen = firstGreen.get(key);
    if (!seen || r.finishedAt < seen.finishedAt!) firstGreen.set(key, r);
  }
  const values: number[] = [];
  for (const r of firstGreen.values()) {
    const t = new Date(r.startedAt).getTime();
    if (t < from.getTime() || t >= to.getTime()) continue;
    values.push((new Date(r.finishedAt!).getTime() - new Date(r.pushedAt).getTime()) / 1000);
  }
  return { medianS: median(values), commits: values.length };
}

export function projectRow(project: Project, runs: Run[], defects: Defect[], now: Date): ProjectRow {
  const month = monthOf(now);
  const mine = runs.filter((r) => r.projectId === project.id);
  const thisMonth = mine.filter((r) => monthOf(r.startedAt) === month);
  const last = mine.reduce<Run | null>((a, r) => (!a || r.startedAt > a.startedAt ? r : a), null);
  const minutes = minuteBreakdown(exactMinutes(thisMonth));
  return {
    ...project,
    runsThisMonth: thisMonth.length,
    medianSkipShare: median(thisMonth.filter(finished).map((r) => r.skipShare)),
    openDefects: defects.filter((d) => d.projectId === project.id && d.state === "open").length,
    minutesThisMonth: minutes,
    minutesSavedThisMonth: minutes.skipped,
    lastRunAt: last?.startedAt ?? null,
    lastRunStatus: last?.status ?? null,
    lastRunNotProven: last?.tests.notProven ?? 0,
  };
}

function perDay(runs: Run[], days: string[], value: (rs: Run[]) => number): DayPoint[] {
  const byDay = new Map<string, Run[]>();
  for (const r of runs) {
    const k = dayStart(new Date(r.startedAt)).toISOString();
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(r);
  }
  return days.map((at) => ({ at, value: value(byDay.get(at) ?? []) }));
}

export const githubUsd = (minutes: number, rate: GitHubRate) => round(minutes * rate.usdPerMinute, 2);

/** The overview of the current month. `runs` must cover this month and the month before. */
export function overviewFrom(projects: Project[], runs: Run[], defects: Defect[], plan: Plan | null, rate: GitHubRate, now: Date, events: UsageEvent[] = [], trial: Trial | null = null): Overview {
  const month = monthOf(now);
  const { start } = monthBounds(month);
  const thisMonth = runs.filter((r) => monthOf(r.startedAt) === month);
  // The same days of the month before, for a fair comparison.
  const prevStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
  const prevCut = new Date(prevStart.getTime() + (now.getTime() - start.getTime()));
  const lastMonthSameDays = runs.filter((r) => r.startedAt >= prevStart.toISOString() && r.startedAt < prevCut.toISOString()).length;
  const days = daysBetween(new Date(now.getTime() - 29 * DAY), now);
  const window = runs.filter((r) => r.startedAt >= days[0]);
  const ttg = medianTimeToGreen(runs, start, now);
  const baselines = projects.map((p) => p.baseline?.medianTimeToGreenS).filter((v): v is number => typeof v === "number");
  // The month's minutes and cost are the Usage page's, so the two pages always show the same numbers.
  const usage = usageFrom(month, projects, runs, plan, rate, events);
  const rows = projects.map((p) => projectRow(p, runs, defects, now));
  const open = defects.filter((d) => d.state === "open");
  return {
    month,
    trial,
    runs: { thisMonth: thisMonth.length, lastMonthSameDays, perDay: perDay(window, days, (rs) => rs.length) },
    minutesSaved: { thisMonth: usage.totals.minutesSaved, perDay: perDay(window, days, (rs) => round(rs.reduce((a, r) => a + r.minutesSaved, 0), 1)) },
    timeToGreen: { beforeMedianS: median(baselines), withMedianS: ttg.medianS, commits: ttg.commits },
    skipShare: {
      median: median(thisMonth.filter(finished).map((r) => r.skipShare)),
      perDay: perDay(window, days, (rs) => median(rs.filter(finished).map((r) => r.skipShare)) ?? 0),
    },
    proof: proofOverview(thisMonth),
    minutes: { ran: usage.totals.testMinutesRan, skipped: usage.totals.minutesSaved, other: usage.totals.otherStepMinutes, total: usage.totals.githubEquivalentMinutes },
    cost: { githubEquivalentUsd: usage.totals.githubEquivalentUsd, githubEquivalentMinutes: usage.totals.githubEquivalentMinutes, plan, rate },
    units: { used: usage.unitsUsed, included: usage.unitsIncluded },
    projects: rows,
    openDefects: open.length,
    recentDefects: [...open].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 5),
  };
}

/**
 * This month's parallel proof: runs with parallel lanes (`proof`), those of them with every test proven, and every run
 * not proven (with or without lanes).
 */
export function proofOverview(thisMonth: Run[]): Overview["proof"] {
  const withProof = thisMonth.filter((r) => r.proof != null && finished(r));
  return {
    runsWithProof: withProof.length,
    provenIdentical: withProof.filter((r) => !r.tests.notProven && !r.proof!.notProven).length,
    notProven: thisMonth.filter((r) => finished(r) && isNotProven(r)).length,
  };
}

/** Billable events of [start, end). */
const billableIn = (events: UsageEvent[], start: Date, end: Date) =>
  events.filter((e) => e.billable && e.occurredAt >= start.toISOString() && e.occurredAt < end.toISOString());

/** Exact run units of events (not rounded). */
const exactUnits = (events: UsageEvent[]) => events.reduce((a, e) => a + e.baselineMinutes, 0) / MINUTES_PER_UNIT;

/** A month's units as billed: the exact sum, rounded up to a whole unit. */
export const billedUnits = (events: UsageEvent[]) => Math.ceil(round(exactUnits(events), 6));

/**
 * A month's usage. Minutes come from the runs (they add up per row and per column); runs and units from the billable
 * usage events (one per job that ran on a fenvix machine; 1 unit = 10 baseline minutes). Units per row are rounded to
 * one decimal so that the rows add up to the total; the month is billed as the total rounded up (unitsUsed).
 * Billable events of repositories that are not a project (yet) are a row of their own, so the rows still add up.
 */
export function usageFrom(month: string, projects: Project[], runs: Run[], plan: Plan | null, rate: GitHubRate, events: UsageEvent[] = []): UsageReport {
  const { start, end } = monthBounds(month);
  const inMonth = runs.filter((r) => r.startedAt >= start.toISOString() && r.startedAt < end.toISOString());
  const billable = billableIn(events, start, end);
  const known = new Set(projects.map((p) => p.id));
  const unmatched = billable.filter((e) => !e.projectId || !known.has(e.projectId));
  // Whole minutes per project, each row adding up (run + skipped + other = GitHub-equivalent); totals are the sums of
  // the rows, so every row and every column adds up. Costs are split the same way, to the cent.
  const rows: UsageProjectRow[] = projects
    .map((p) => {
      const rs = inMonth.filter((r) => r.projectId === p.id);
      const m = minuteBreakdown(exactMinutes(rs));
      const ev = billable.filter((e) => e.projectId === p.id);
      return { projectId: p.id, fullName: p.fullName, runs: ev.length, units: exactUnits(ev), testMinutesRan: m.ran, minutesSaved: m.skipped, otherStepMinutes: m.other, githubEquivalentMinutes: m.total, githubEquivalentUsd: 0 };
    })
    .sort((a, b) => b.runs - a.runs || a.fullName.localeCompare(b.fullName));
  if (unmatched.length) {
    const minutes = Math.round(unmatched.reduce((a, e) => a + e.baselineMinutes, 0));
    rows.push({ projectId: "", fullName: "Repositories not set up as projects", runs: unmatched.length, units: exactUnits(unmatched), testMinutesRan: 0, minutesSaved: 0, otherStepMinutes: minutes, githubEquivalentMinutes: minutes, githubEquivalentUsd: 0 });
  }
  const units = roundToSum(rows.map((r) => r.units), 1);
  rows.forEach((r, i) => (r.units = units[i]));
  const usd = roundToSum(rows.map((r) => r.githubEquivalentMinutes * rate.usdPerMinute), 2);
  rows.forEach((r, i) => (r.githubEquivalentUsd = usd[i]));
  const sum = (k: "runs" | "units" | "minutesSaved" | "testMinutesRan" | "otherStepMinutes" | "githubEquivalentMinutes" | "githubEquivalentUsd") => round(rows.reduce((a, r) => a + r[k], 0), 2);
  const last = new Date(Math.min(end.getTime() - DAY, Math.max(start.getTime(), ...inMonth.map((r) => new Date(r.startedAt).getTime()))));
  const days = daysBetween(start, last);
  const index = new Map(days.map((d, i) => [d, i]));
  const series = rows
    .filter((r) => r.projectId && inMonth.some((x) => x.projectId === r.projectId))
    .map((row) => {
      const values = days.map(() => 0);
      for (const r of inMonth) if (r.projectId === row.projectId) values[index.get(dayStart(new Date(r.startedAt)).toISOString()) ?? 0]++;
      return { label: row.fullName, values };
    });
  return {
    month,
    plan,
    runsUsed: billable.length,
    unitsUsed: billedUnits(billable),
    unitsIncluded: plan?.unitsIncluded ?? null,
    totals: { runs: sum("runs"), units: round(sum("units"), 1), testMinutesRan: sum("testMinutesRan"), minutesSaved: sum("minutesSaved"), otherStepMinutes: sum("otherStepMinutes"), githubEquivalentMinutes: sum("githubEquivalentMinutes"), githubEquivalentUsd: sum("githubEquivalentUsd") },
    rows,
    daily: { days, series },
    rate,
  };
}

const csvCell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/**
 * One row per project, header first, UTF-8 and \n line ends. In every row test_minutes_ran + minutes_saved +
 * other_step_minutes = github_equivalent_minutes.
 */
export function usageCsv(report: UsageReport): string {
  const head = "project,runs,units,test_minutes_ran,minutes_saved,other_step_minutes,github_equivalent_minutes,github_equivalent_usd";
  const lines = report.rows.map((r) => [r.fullName, r.runs, r.units.toFixed(1), r.testMinutesRan, r.minutesSaved, r.otherStepMinutes, r.githubEquivalentMinutes, r.githubEquivalentUsd.toFixed(2)].map(csvCell).join(","));
  return [head, ...lines].join("\n") + "\n";
}

export const usageCsvName = (month: string) => `fenvix-usage-${month}.csv`;

/**
 * The cheapest plan whose included units hold the monthly units and whose project limit holds the projects. Plans whose
 * included units are not set yet are never suggested (null when none fits or none is set).
 */
export function suggestPlan(plans: Plan[], projects: number, monthlyUnits: number): Plan | null {
  const fits = plans.filter((p) => p.kind === "plan" && p.unitsIncluded !== null && p.unitsIncluded >= monthlyUnits && (p.maxProjects === null || p.maxProjects >= projects));
  return fits.sort((a, b) => (a.priceUsdMonth ?? Infinity) - (b.priceUsdMonth ?? Infinity) || a.unitsIncluded! - b.unitsIncluded!)[0] ?? null;
}

export function billingFrom(plans: Plan[], projects: Project[], events: UsageEvent[], trial: Trial | null, now: Date): BillingOverview {
  const plan = plans.find((p) => p.kind === "plan" && p.current) ?? null;
  const month = monthOf(now);
  const { start, end } = monthBounds(month);
  const thisMonth = billableIn(events, start, end);
  const prev = [1, 2, 3]
    .map((k) => ({ start: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - k, 1)), end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - k + 1, 1)) }))
    .map((m) => billableIn(events, m.start, m.end))
    .filter((ev) => ev.length > 0)
    .map(exactUnits);
  const averageMonthlyUnits = round(prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : exactUnits(thisMonth), 1);
  return {
    currency: "USD",
    plan,
    addons: plans.filter((p) => p.kind === "addon"),
    trial,
    period: { start: start.toISOString(), end: end.toISOString() },
    runsUsed: thisMonth.length,
    unitsUsed: billedUnits(thisMonth),
    unitsIncluded: plan?.unitsIncluded ?? null,
    projects: projects.length,
    averageMonthlyUnits,
    suggestedPlanId: suggestPlan(plans, projects.length, averageMonthlyUnits)?.id ?? null,
  };
}

/**
 * The 30-day shadow trial: what fenvix would have skipped over the trial's finished shadow runs (time-weighted share,
 * minutes), the units its billable runs come to, the days left and whether the 35% gate is met.
 */
export function trialFrom(dates: TrialDates | null, runs: Run[], events: UsageEvent[], now: Date): Trial | null {
  if (!dates) return null;
  const start = new Date(dates.startedAt);
  const end = new Date(dates.endsAt);
  const shadow = runs.filter((r) => r.mode === "shadow" && finished(r) && r.startedAt >= start.toISOString() && r.startedAt < end.toISOString());
  const total = shadow.reduce((a, r) => a + r.testTimeMs.ran + r.testTimeMs.skipped, 0);
  // Each run's would-have-saved time is at most its own test time (the App bounds it too: review R-016 F4), so the
  // share stays within 0 to 1 whatever a run reports.
  const would = shadow.reduce((a, r) => a + Math.min(Math.max(0, r.wouldSaveMs), r.testTimeMs.ran + r.testTimeMs.skipped), 0);
  const share = shadow.length && total > 0 ? Math.min(1, Math.max(0, round(would / total, 4))) : shadow.length ? 0 : null;
  return {
    status: now < end ? "active" : "ended",
    startedAt: start.toISOString(),
    endsAt: end.toISOString(),
    daysLeft: Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY)),
    runs: shadow.length,
    wouldSkipShare: share,
    wouldSaveMinutes: round(would / 60000, 1),
    units: round(exactUnits(billableIn(events, start, end)), 1),
    gate: { threshold: TRIAL_GATE, met: share !== null && share >= TRIAL_GATE },
  };
}

/**
 * Audit reruns over [from, to): totals from the runs' counters (every audited test), the lists from the per-test
 * records. With no wrong skip in n audited tests, the wrong-skip rate is below 3/n with 95% confidence (rule of three).
 */
export function auditFrom(runs: Run[], reruns: AuditRerun[], from: Date, to: Date): AuditSummary {
  const inWindow = runs.filter((r) => r.startedAt >= from.toISOString() && r.startedAt < to.toISOString() && r.audit.rerun > 0);
  const testsRerun = inWindow.reduce((a, r) => a + r.audit.rerun, 0);
  const wrongSkips = inWindow.reduce((a, r) => a + r.audit.wrongSkips, 0);
  const newest = [...reruns].filter((x) => x.at >= from.toISOString() && x.at < to.toISOString()).sort((a, b) => b.at.localeCompare(a.at) || a.testId.localeCompare(b.testId));
  const seen = new Set<string>();
  const untrustedKeys = newest.filter((x) => x.untrusted && !seen.has(x.cacheKey) && seen.add(x.cacheKey));
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    runs: inWindow.length,
    testsRerun,
    wrongSkips,
    expectedWrongSkips: 0,
    ruleOfThreeBound: testsRerun > 0 && wrongSkips === 0 ? round(3 / testsRerun, 6) : null,
    untrustedKeys,
    recent: newest.slice(0, 50),
  };
}

/** Defects grouped by cause: the same polluters or setters in the same project (the engine's families_by_polluter). */
export function familiesOf(defects: Defect[]): DefectFamily[] {
  const map = new Map<string, DefectFamily>();
  for (const d of defects) {
    const k = `${d.projectId}|${d.familyKey}`;
    const f = map.get(k) ?? { key: d.familyKey, projectId: d.projectId, projectName: d.projectName, cause: d.cause, causeTests: d.causeTests, defects: [] };
    f.defects.push(d);
    map.set(k, f);
  }
  return [...map.values()].sort((a, b) => b.defects.length - a.defects.length || b.defects[0].lastSeenAt.localeCompare(a.defects[0].lastSeenAt));
}

/** The engine's family key: the cause tests joined by " + ", or "<none>". */
export const familyKeyOf = (causeTests: string[]) => (causeTests.length ? causeTests.join(" + ") : "<none>");

/** Where `fenvix defects pull` writes a defect's bundle. */
export const bundleDir = (d: Pick<Defect, "id">) => `.fenvix/defects/${d.id}`;

/**
 * The copy-paste replay command. Python: the minimal order and the seed (no --det-seed for collection order). Node: the
 * engine has no --det-order yet, so the seed only.
 */
export function replayCommand(d: Pick<Defect, "id" | "seed" | "language" | "testRunner"> & { replayCommand?: string | null }): string {
  if (d.replayCommand) return d.replayCommand.replace(/<bundle>/g, bundleDir(d));
  const seed = d.seed === null ? "" : ` --det-seed=${d.seed}`;
  if (d.language === "node") return `detjs ${d.testRunner === "jest" ? "jest" : "vitest run"} --det${seed}`;
  return `pytest --det${seed} --det-order=${bundleDir(d)}/order.txt`;
}

export const pullCommand = (d: Pick<Defect, "id">) => `fenvix defects pull ${d.id}`;

/** The workflow change the setup pull request makes: the test job moves to fenvix machines. */
export function setupChange(_project: Pick<Project, "language">): SetupChange {
  return { path: ".github/workflows/ci.yml", job: "test", before: "runs-on: ubuntu-latest", after: "runs-on: fenvix" };
}

/** The setup snippet shown on a project: one line in the test job. */
export function setupSnippet(project: Pick<Project, "language" | "testRunner">): string {
  const run = project.testRunner === "pytest" ? "pytest" : project.testRunner === "go test" ? "go test ./..." : project.testRunner === "jest" ? "npx jest" : "npx vitest run";
  const install = project.language === "python" ? "pip install -e .[test]" : project.language === "node" ? "npm ci" : "go mod download";
  return ["jobs:", "  test:", "    runs-on: fenvix", "    steps:", "      - uses: actions/checkout@v4", `      - run: ${install}`, `      - run: ${run}`].join("\n");
}

/** Plain-English names of the reasons a test could not be reused. */
export const MISS_LABELS: Record<MissKind, string> = {
  code: "Code it runs changed",
  data: "A file it reads changed",
  env: "An environment variable changed",
  runtime: "Runtime changed (interpreter, packages)",
  config: "Configuration changed",
  clock: "It reads the clock",
  new: "New test",
  "failed-before": "Failed before",
};

/** Why tests ran over a set of runs: totals by reason (largest first), and the details that made most tests run. */
export function missSummary(runs: Run[]): { byKind: { kind: MissKind; tests: number }[]; details: { kind: MissKind; detail: string; tests: number; runs: number }[] } {
  const kinds = new Map<MissKind, number>();
  const details = new Map<string, { kind: MissKind; detail: string; tests: number; runs: number }>();
  for (const r of runs) {
    for (const [k, n] of Object.entries(r.skipMisses) as [MissKind, number][]) kinds.set(k, (kinds.get(k) ?? 0) + n);
    for (const d of r.missDetails) {
      const key = `${d.kind}|${d.detail}`;
      const cur = details.get(key) ?? { kind: d.kind, detail: d.detail, tests: 0, runs: 0 };
      cur.tests += d.tests;
      cur.runs += 1;
      details.set(key, cur);
    }
  }
  return {
    byKind: [...kinds.entries()].map(([kind, tests]) => ({ kind, tests })).sort((a, b) => b.tests - a.tests),
    details: [...details.values()].sort((a, b) => b.tests - a.tests).slice(0, 8),
  };
}

/** Time to green of each commit (first passing run), oldest first: seconds from push to green, with the run. */
export function timeToGreenPerCommit(runs: Run[]): { at: string; seconds: number; run: Run }[] {
  const first = new Map<string, Run>();
  for (const r of runs) {
    if (r.status !== "passed" || !r.finishedAt) continue;
    const k = `${r.projectId}:${r.commitSha}`;
    const seen = first.get(k);
    if (!seen || r.finishedAt < seen.finishedAt!) first.set(k, r);
  }
  return [...first.values()]
    .map((run) => ({ at: run.startedAt, seconds: (new Date(run.finishedAt!).getTime() - new Date(run.pushedAt).getTime()) / 1000, run }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Time to green per day: the median of the commits that went green that day (timeToGreenPerCommit), oldest first, the
 * last `days` days at most. One point per day, so the chart stays readable with hundreds of commits.
 */
export function timeToGreenPerDay(runs: Run[], days = 30): { at: string; value: number; commits: number }[] {
  const byDay = new Map<string, number[]>();
  for (const x of timeToGreenPerCommit(runs)) {
    const k = dayStart(new Date(x.at)).toISOString();
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(x.seconds);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-days)
    .map(([at, v]) => ({ at, value: median(v)!, commits: v.length }));
}

/** The value below which `share` of the values fall (0.9 = p90). */
export function percentile(values: number[], share: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(share * s.length))];
}

const sha7 = (s: string) => s.slice(0, 7);

/** Recent activity derived from what the dashboard already holds; newest first. */
export function activityFrom(projects: Project[], runs: Run[], defects: Defect[], explorations: Exploration[], limit = 8): ActivityItem[] {
  const name = new Map(projects.map((p) => [p.id, p.fullName]));
  const items: ActivityItem[] = [];
  for (const r of runs.slice(0, 60)) {
    if (!finished(r) || !r.finishedAt) continue;
    const to = `/projects/${r.projectId}/runs/${r.id}`;
    if (r.status === "not_proven") {
      // Finished, never green, never "failed": its own kind.
      items.push({ id: `run-${r.id}`, at: r.finishedAt, kind: "run_not_proven", projectId: r.projectId, to, title: `Run #${r.number} not proven`, detail: `${r.tests.notProven} not proven · ${sha7(r.commitSha)}` });
      continue;
    }
    items.push({
      id: `run-${r.id}`, at: r.finishedAt, kind: r.status === "passed" ? "run_green" : "run_failed", projectId: r.projectId, to,
      title: r.status === "passed" ? `Run #${r.number} green` : `Run #${r.number} failed`,
      detail: r.status === "passed" ? `${Math.round(r.skipShare * 100)}% skipped with proof · ${sha7(r.commitSha)}` : r.tests.flakyDefects ? `${r.tests.flakyDefects} flaky, reproducible · ${sha7(r.commitSha)}` : `${r.tests.failed} failed · ${sha7(r.commitSha)}`,
    });
  }
  for (const d of defects)
    items.push({ id: `defect-${d.id}`, at: d.firstSeenAt, kind: "defect_reproduced", projectId: d.projectId, to: `/defects/${d.id}`, title: `Defect reproduced ${d.replays.fails} of ${d.replays.runs}`, detail: d.testId.split(/::| > /).pop() ?? d.testId });
  for (const e of explorations)
    items.push({ id: `explore-${e.id}`, at: e.finishedAt, kind: "exploration", projectId: e.projectId, to: `/projects/${e.projectId}/nightly`, title: "Nightly exploration finished", detail: `${e.seeds} seeds · ${e.newDefectIds.length ? `${e.newDefectIds.length} new defect${e.newDefectIds.length > 1 ? "s" : ""}` : "no new defects"}` });
  for (const p of projects)
    if (p.setupPullRequest) items.push({ id: `pr-${p.id}`, at: p.connectedAt, kind: "setup_pr", projectId: p.id, to: `/projects/${p.id}/settings`, title: `Setup pull request #${p.setupPullRequest.number} ${p.setupPullRequest.state === "merged" ? "merged" : "opened"}`, detail: name.get(p.id) ?? "" });
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** "homehub" of "acme/homehub". */
export const shortName = (fullName: string) => fullName.split("/").pop() || fullName;

/** At most this many search results (GET /search), and the shortest search term. */
export const SEARCH_MAX = 20;
export const SEARCH_MIN = 2;

/** What a search term asks for: a run number ("4299", "#4299"), a commit prefix (7+ hex), and test-name text. */
export function searchTerms(q: string): { number: number | null; commitPrefix: string | null; text: string } {
  const t = q.trim();
  const m = /^#?(\d{1,9})$/.exec(t);
  const hex = /^[0-9a-f]{7,40}$/i.test(t) ? t.toLowerCase() : null;
  return { number: m ? Number(m[1]) : null, commitPrefix: hex, text: t.toLowerCase() };
}

/**
 * The ⌘K search over runs and open defects (GET /search): runs by number or commit prefix, open defects by test name
 * (case-insensitive substring); newest first, at most SEARCH_MAX. Each result names its project, so runs with the
 * same number in several projects all show.
 */
export function searchFrom(projects: Project[], runs: Run[], defects: Defect[], q: string): SearchResult[] {
  const t = searchTerms(q);
  // A run number ("6", "#6") is always a search; any other term needs SEARCH_MIN characters.
  if (t.number === null && t.text.length < SEARCH_MIN) return [];
  const name = new Map(projects.map((p) => [p.id, shortName(p.fullName)]));
  const hits: { at: string; r: SearchResult }[] = [];
  for (const r of runs) {
    if (!name.has(r.projectId)) continue;
    if (r.number !== t.number && !(t.commitPrefix && r.commitSha.startsWith(t.commitPrefix))) continue;
    hits.push({ at: r.startedAt, r: { kind: "run", projectId: r.projectId, id: r.id, label: `Run #${r.number}`, sublabel: `${name.get(r.projectId)} · ${r.branch}` } });
  }
  for (const d of defects) {
    if (d.state !== "open" || !name.has(d.projectId) || !d.testId.toLowerCase().includes(t.text)) continue;
    hits.push({ at: d.lastSeenAt, r: { kind: "defect", projectId: d.projectId, id: d.id, label: d.testId.split(/::| > /).pop() ?? d.testId, sublabel: name.get(d.projectId)! } });
  }
  return hits.sort((a, b) => b.at.localeCompare(a.at)).slice(0, SEARCH_MAX).map((h) => h.r);
}

/** Said wherever the runner reported tests not proven without a cause. */
export const NO_CAUSE_LABEL = "The runner did not report why";
/**
 * The customer sentence of a parallel run's proof (founder decision 2026-11-25): bounded to what the engine recorded,
 * with the known limits shown next to it (engine review 2026-11-25; the engine does not record these, so a conflict
 * through them is not ruled out).
 */
export const PROOF_SENTENCE = "Proven: no conflict between parallel lanes in what the engine recorded for each test; files in conflict ran again in one lane.";
export const PROOF_LIMITS = [
  "shared local services (a database or cache the tests connect to)",
  "recursive directory operations",
  "a cache directory at the project root",
  "module reads through Vitest's main process",
  "writes by child processes, native addons or worker threads",
] as const;
export const PROOF_LIMITS_SENTENCE = `Not recorded, so not ruled out: ${PROOF_LIMITS.join("; ")}.`;

/** The App's reason when the verify could not compare the runs (github-app/src/results/summary.ts NOT_PROVEN_REASONS). */
export const NOT_PROVEN_INPUTS_DIFFER = "inputs differ";

/** The engine's causes as the verb phrase of a sentence about tests ("14 tests read a file outside the project"). */
const CAUSE_PHRASES: Record<string, string> = {
  "file read outside the project": "read a file outside the project",
  "environment variable read outside any test": "read an environment variable outside any test",
};

const countOf = (n: number) => `${new Intl.NumberFormat("en-US").format(n)} ${n === 1 ? "test" : "tests"}`;

/**
 * The run page's sentence about its tests not proven (Run.tsx): from the largest cause the runner reported, or that it
 * did not report one; then what the run did with them. "the run exits N" only when the summary's exit was not 0.
 */
export function notProvenSentence(run: Pick<Run, "exitCode" | "tests"> & { notProvenReason?: string | null }, proof: Pick<RunProof, "notProvenCauses"> | null): string {
  const exit = run.exitCode != null && run.exitCode !== 0 ? `the run exits ${run.exitCode}` : "the check on GitHub is marked failed";
  const after = `Their result from the one-lane re-run is reported; ${exit}.`;
  const n = run.tests.notProven ?? 0;
  const top = proof != null ? [...(proof.notProvenCauses ?? [])].filter((c) => c.tests > 0).sort((a, b) => b.tests - a.tests)[0] : undefined;
  const reason = run.notProvenReason ?? null;
  // Inputs that differ: the runs could not be compared at all, so no count of tests is said.
  if (!top && reason === NOT_PROVEN_INPUTS_DIFFER) return `The two runs could not be compared: their inputs differ. The run is not proven; the check on GitHub is marked failed.`;
  if (!top && reason) return `${countOf(n)} ${n === 1 ? "was" : "were"} not proven: ${reason}. ${after}`;
  if (!top) return `${countOf(n)} ${n === 1 ? "was" : "were"} not proven. ${NO_CAUSE_LABEL}. ${after}`;
  const what = CAUSE_PHRASES[top.cause] ?? `${top.tests === 1 ? "was" : "were"} not proven (${top.cause})`;
  return `${countOf(top.tests)} ${what}, so a conflict between parallel lanes could not be ruled out. ${after}`;
}

/** A run's tests not proven by cause (largest first); what the runner did not explain is NO_CAUSE_LABEL. */
export function notProvenCausesOf(r: Run): { cause: string; tests: number }[] {
  const n = r.tests.notProven || r.proof?.notProven || 0;
  if (n <= 0) return [];
  const named = r.proof != null ? (r.proof.notProvenCauses ?? []).filter((c) => c.tests > 0) : [];
  const told = named.reduce((a, c) => a + c.tests, 0);
  const out = told < n ? [...named, { cause: r.notProvenReason ?? NO_CAUSE_LABEL, tests: n - told }] : named;
  return [...out].sort((a, b) => b.tests - a.tests);
}

export interface ParallelProof {
  /** Runs of the window with parallel lanes (`proof`). */
  withProof: Run[];
  /** Runs of the window with a test not proven (with or without lanes), newest first. */
  notProven: Run[];
  /** Per day with parallel runs: the median share of the tests that ran that were proven (no conflict between lanes). */
  proven: { at: string; value: number }[];
  /** Tests not proven by cause over the window, largest first, with the runs they came from. */
  causes: { cause: string; tests: number; runs: number }[];
  /** Per day with parallel runs: the median parallel time and the median serial estimate (null: none reported). */
  speed: { at: string; parallelMs: number; serialMs: number | null }[];
}

/** The project's "Parallel with proof" page over the last `days` days of runs (finished runs only). */
export function parallelProofFrom(runs: Run[], now: Date, days = 30): ParallelProof {
  const since = new Date(now.getTime() - days * DAY).toISOString();
  const window = runs.filter((r) => finished(r) && r.startedAt >= since);
  const withProof = window.filter((r) => r.proof != null);
  const notProven = window.filter(isNotProven).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const byDay = new Map<string, Run[]>();
  for (const r of [...withProof].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const k = dayStart(new Date(r.startedAt)).toISOString();
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(r);
  }
  const daysOf = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  // Per run: (ran − N) / ran, with N the run's (never less than its proof's) and ran the tests the framework ran; a run
  // that ran nothing is left out; nothing proven is 0.
  const shareProven = (r: Run) => {
    const ran = r.proof!.ranExecuted ?? r.tests.ran;
    const n = Math.max(r.tests.notProven ?? 0, r.proof!.notProven ?? 0);
    return ran > 0 ? Math.max(0, ran - n) / ran : null;
  };
  const proven = daysOf
    .map(([at, rs]) => ({ at, values: rs.map(shareProven).filter((v): v is number => v !== null) }))
    .filter((d) => d.values.length > 0)
    .map((d) => ({ at: d.at, value: median(d.values)! }));
  const speed = daysOf.map(([at, rs]) => {
    const serial = rs.map((r) => r.proof!.serialMsEstimate).filter((v): v is number => v !== null);
    return { at, parallelMs: median(rs.map((r) => r.proof!.parallelMs))!, serialMs: median(serial) };
  });
  const causes = new Map<string, { cause: string; tests: number; runs: number }>();
  for (const r of notProven)
    for (const c of notProvenCausesOf(r)) {
      const cur = causes.get(c.cause) ?? { cause: c.cause, tests: 0, runs: 0 };
      cur.tests += c.tests;
      cur.runs += 1;
      causes.set(c.cause, cur);
    }
  return { withProof, notProven, proven, causes: [...causes.values()].sort((a, b) => b.tests - a.tests), speed };
}
