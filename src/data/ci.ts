/*
 * Pure functions over the contract's records (docs/data-contract.md), shared by every backend: the mock and Supabase
 * load rows, these turn them into what the screens show. No I/O here, so tests/unit/ci.test.ts covers all of it.
 */
import type {
  BillingOverview, DayPoint, Defect, DefectFamily, GitHubRate, Overview, Plan, Project, ProjectRow, Run, SetupChange, UsageProjectRow, UsageReport,
} from "./types";

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

const finished = (r: Run) => r.status === "passed" || r.status === "failed";
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
  return {
    ...project,
    runsThisMonth: thisMonth.length,
    medianSkipShare: median(thisMonth.filter(finished).map((r) => r.skipShare)),
    openDefects: defects.filter((d) => d.projectId === project.id && d.state === "open").length,
    minutesSavedThisMonth: round(thisMonth.reduce((a, r) => a + r.minutesSaved, 0), 1),
    lastRunAt: last?.startedAt ?? null,
    lastRunStatus: last?.status ?? null,
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
export function overviewFrom(projects: Project[], runs: Run[], defects: Defect[], plan: Plan | null, rate: GitHubRate, now: Date): Overview {
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
  const githubMinutes = round(thisMonth.reduce((a, r) => a + r.githubEquivalentMinutes, 0), 1);
  const rows = projects.map((p) => projectRow(p, runs, defects, now));
  const open = defects.filter((d) => d.state === "open");
  return {
    month,
    runs: { thisMonth: thisMonth.length, lastMonthSameDays, perDay: perDay(window, days, (rs) => rs.length) },
    minutesSaved: { thisMonth: round(thisMonth.reduce((a, r) => a + r.minutesSaved, 0), 1), perDay: perDay(window, days, (rs) => round(rs.reduce((a, r) => a + r.minutesSaved, 0), 1)) },
    timeToGreen: { beforeMedianS: median(baselines), withMedianS: ttg.medianS, commits: ttg.commits },
    skipShare: {
      median: median(thisMonth.filter(finished).map((r) => r.skipShare)),
      perDay: perDay(window, days, (rs) => median(rs.filter(finished).map((r) => r.skipShare)) ?? 0),
    },
    cost: { githubEquivalentUsd: githubUsd(githubMinutes, rate), githubEquivalentMinutes: githubMinutes, plan, rate },
    projects: rows,
    openDefects: open.length,
    recentDefects: [...open].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 5),
  };
}

export function usageFrom(month: string, projects: Project[], runs: Run[], plan: Plan | null, rate: GitHubRate): UsageReport {
  const { start, end } = monthBounds(month);
  const inMonth = runs.filter((r) => r.startedAt >= start.toISOString() && r.startedAt < end.toISOString());
  const rows: UsageProjectRow[] = projects
    .map((p) => {
      const rs = inMonth.filter((r) => r.projectId === p.id);
      const gh = round(rs.reduce((a, r) => a + r.githubEquivalentMinutes, 0), 1);
      return {
        projectId: p.id,
        fullName: p.fullName,
        runs: rs.length,
        minutesSaved: round(rs.reduce((a, r) => a + r.minutesSaved, 0), 1),
        testMinutesRan: round(rs.reduce((a, r) => a + r.testTimeMs.ran, 0) / 60000, 1),
        githubEquivalentMinutes: gh,
        githubEquivalentUsd: githubUsd(gh, rate),
      };
    })
    .sort((a, b) => b.runs - a.runs || a.fullName.localeCompare(b.fullName));
  const sum = (k: "runs" | "minutesSaved" | "testMinutesRan" | "githubEquivalentMinutes" | "githubEquivalentUsd") => round(rows.reduce((a, r) => a + r[k], 0), k === "runs" ? 0 : 2);
  const last = new Date(Math.min(end.getTime() - DAY, Math.max(start.getTime(), ...inMonth.map((r) => new Date(r.startedAt).getTime()))));
  const days = daysBetween(start, last);
  const index = new Map(days.map((d, i) => [d, i]));
  const series = rows
    .filter((r) => r.runs > 0)
    .map((row) => {
      const values = days.map(() => 0);
      for (const r of inMonth) if (r.projectId === row.projectId) values[index.get(dayStart(new Date(r.startedAt)).toISOString()) ?? 0]++;
      return { label: row.fullName, values };
    });
  return {
    month,
    plan,
    runsUsed: inMonth.length,
    runsIncluded: plan?.runsPerMonth ?? null,
    totals: { runs: sum("runs"), minutesSaved: sum("minutesSaved"), testMinutesRan: sum("testMinutesRan"), githubEquivalentMinutes: sum("githubEquivalentMinutes"), githubEquivalentUsd: sum("githubEquivalentUsd") },
    rows,
    daily: { days, series },
    rate,
  };
}

const csvCell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** One row per project, header first, UTF-8 and \n line ends. */
export function usageCsv(report: UsageReport): string {
  const head = "project,runs,minutes_saved,test_minutes_ran,github_equivalent_minutes,github_equivalent_usd";
  const lines = report.rows.map((r) => [r.fullName, r.runs, r.minutesSaved, r.testMinutesRan, r.githubEquivalentMinutes, r.githubEquivalentUsd.toFixed(2)].map(csvCell).join(","));
  return [head, ...lines].join("\n") + "\n";
}

export const usageCsvName = (month: string) => `fenvix-usage-${month}.csv`;

/** The smallest plan (by runs) that holds the projects and the runs. Plans with no limit fit everything. */
export function suggestPlan(plans: Plan[], projects: number, monthlyRuns: number): Plan | null {
  const fits = plans.filter((p) => (p.maxProjects === null || p.maxProjects >= projects) && (p.runsPerMonth === null || p.runsPerMonth >= monthlyRuns));
  return fits.sort((a, b) => (a.runsPerMonth ?? Infinity) - (b.runsPerMonth ?? Infinity))[0] ?? null;
}

export function billingFrom(plans: Plan[], projects: Project[], runs: Run[], now: Date): BillingOverview {
  const plan = plans.find((p) => p.current) ?? null;
  const month = monthOf(now);
  const { start, end } = monthBounds(month);
  const prev = [1, 2, 3].map((k) => monthOf(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - k, 1))));
  const counts = prev.map((m) => runs.filter((r) => monthOf(r.startedAt) === m).length).filter((n) => n > 0);
  const averageMonthlyRuns = counts.length ? Math.round(counts.reduce((a, b) => a + b, 0) / counts.length) : runs.filter((r) => monthOf(r.startedAt) === month).length;
  return {
    currency: "USD",
    plan,
    period: { start: start.toISOString(), end: end.toISOString() },
    runsUsed: runs.filter((r) => monthOf(r.startedAt) === month).length,
    runsIncluded: plan?.runsPerMonth ?? null,
    projects: projects.length,
    averageMonthlyRuns,
    suggestedPlanId: suggestPlan(plans, projects.length, averageMonthlyRuns)?.id ?? null,
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
export function replayCommand(d: Pick<Defect, "id" | "seed" | "language" | "testRunner">): string {
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
