import type { RunSummary } from "./summary.ts";

/** What GitHub calls the check run on the commit. */
export const CHECK_NAME = "fenvix";
/** Marks the one fenvix comment on a pull request, so it is found and updated in place. */
export const COMMENT_MARKER = "<!-- fenvix:run-summary -->";

export interface RenderContext {
  repository: string;
  headSha: string;
  workflowName: string;
  jobName: string;
  /** The job's page on GitHub. */
  jobUrl: string | null;
  /** Where the receipts of the tests skipped with proof are (the runner's upload, else the dashboard run page). */
  receiptsUrl: string | null;
  /** The run on the fenvix dashboard, when the installation is linked to an organization. */
  dashboardRunUrl: string | null;
  /** The check run, for the comment's link. */
  checkRunUrl?: string | null;
  /** GitHub's conclusion of the job (success, failure, cancelled, ...). */
  jobConclusion: string | null;
  /** A summary came but could not be read: the run is not proven, the check run fails. */
  summaryUnreadable?: boolean;
}

export type Conclusion = "success" | "failure" | "neutral" | "cancelled";

const n = (x: number) => x.toLocaleString("en-US");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Seconds as minutes for people: "12.4 min", or "0.2 min (13.9 s)" under a minute. */
export function minutes(seconds: number): string {
  const m = seconds / 60;
  if (m >= 1) return `${m.toFixed(1)} min`;
  if (m < 0.05) return `under 0.1 min (${seconds.toFixed(1)} s)`;
  return `${m.toFixed(1)} min (${seconds.toFixed(1)} s)`;
}

const code = (s: string) => "`" + s.replace(/`/g, "'") + "`";

function limit<T>(xs: T[], max: number): { shown: T[]; more: number } {
  return { shown: xs.slice(0, max), more: Math.max(0, xs.length - max) };
}

export function conclusionOf(s: RunSummary | null, jobConclusion: string | null, summaryUnreadable = false): Conclusion {
  if (jobConclusion === "cancelled" || jobConclusion === "skipped") return "cancelled";
  if (!s && summaryUnreadable) return "failure";
  if (!s) return jobConclusion === "success" ? "neutral" : "failure";
  // A test not proven identical to the serial run is never a green check, even with exit 0.
  if (s.failed.length || s.flaky.length || s.exit !== 0 || s.notProven > 0) return "failure";  // exit null: unknown, never green
  return "success";
}

export function title(s: RunSummary | null, c: Conclusion, summaryUnreadable = false): string {
  if (!s && summaryUnreadable && c !== "cancelled") return "Not proven: the runner's summary could not be read";
  if (!s) return c === "cancelled" ? "Cancelled before the tests reported" : "No fenvix summary: the job ended before the tests reported";
  const parts = [`${n(s.reusedWithProof)} of ${n(s.tests)} tests skipped with proof`, `${minutes(s.testSecondsSaved)} saved`];
  const fails = s.failed.length + s.flaky.length;
  if (fails > 0) parts.push(`${n(fails)} failed${s.flaky.length ? ` (${n(s.flaky.length)} flaky, reproducible)` : ""}`);
  if (s.notProven > 0) parts.push(`${n(s.notProven)} not proven`);
  else if (fails === 0) parts.push("no failures");
  return parts.join(" · ");
}

function table(s: RunSummary, ctx: RenderContext): string[] {
  const receipts = ctx.receiptsUrl ? ` ([receipts](${ctx.receiptsUrl}))` : "";
  return [
    "| | |",
    "|---|---|",
    `| Tests | **${n(s.tests)}** |`,
    `| Tests run | ${n(s.ran)} |`,
    `| Skipped with proof | **${n(s.reusedWithProof)}**${receipts} |`,
    `| Minutes saved | **${minutes(s.testSecondsSaved)}** (${pct(s.shareOfTestTimeSaved)} of test time) |`,
    `| Failures | ${n(s.failed.length)} |`,
    `| Flaky, reproducible | ${n(s.flaky.length)} |`,
    ...(s.notProven > 0 || s.proof ? [`| Not proven identical to the serial run | ${n(s.notProven)} |`] : []),
  ];
}

function failures(s: RunSummary, maxFailed: number, maxFlaky: number): string[] {
  const L: string[] = [];
  if (s.failed.length) {
    const f = limit(s.failed, maxFailed);
    L.push("", "### Failures", "", ...f.shown.map((id) => `- ${code(id)}`));
    if (f.more) L.push(`- and ${n(f.more)} more`);
  }
  if (s.flaky.length) {
    const f = limit(s.flaky, maxFlaky);
    L.push("", "### Flaky tests, explained", "",
      "Each failed in the suite and passed when run alone: another test leaves state behind (order-dependent). The run is deterministic, so the replay fails the same way every time.", "");
    for (const t of f.shown) {
      L.push(`- ${code(t.nodeid)}`, `  - replay: ${code(t.replay)}`);
      if (t.minimise) L.push(`  - find the test that breaks it: ${code(t.minimise)}`);
    }
    if (f.more) L.push(`- and ${n(f.more)} more`);
  }
  return L;
}

/** The check run's output: title, summary (Markdown, ≤ 65,535 characters) and text. */
export function checkRunOutput(s: RunSummary | null, ctx: RenderContext): { title: string; summary: string; text: string } {
  const c = conclusionOf(s, ctx.jobConclusion, ctx.summaryUnreadable);
  if (!s) {
    const why = c === "cancelled"
      ? "The job was cancelled before the fenvix runner sent its summary."
      : ctx.summaryUnreadable
        ? "The fenvix runner sent a summary that could not be read, so no test of this run is proven: the run is not proven."
        : "The job ended without a fenvix summary (it failed before or during the test step). Its log on GitHub says why.";
    return { title: title(null, c, ctx.summaryUnreadable), summary: why + (ctx.jobUrl ? `\n\n[Job log](${ctx.jobUrl})` : ""), text: "" };
  }
  const S = [
    `**${ctx.workflowName} / ${ctx.jobName}** on fenvix · commit ${code(ctx.headSha.slice(0, 12))} · cache ${s.cacheWasWarm ? "warm" : "cold (first run on this machine)"}`,
    "",
    ...table(s, ctx),
    ...failures(s, 50, 20),
  ];
  const links = [ctx.dashboardRunUrl && `[Run on fenvix](${ctx.dashboardRunUrl})`, ctx.jobUrl && `[Job log](${ctx.jobUrl})`].filter(Boolean);
  if (links.length) S.push("", links.join(" · "));
  const T: string[] = [];
  const why = Object.entries(s.notReusedReasons).sort((a, b) => b[1] - a[1]);
  if (why.length) T.push(`Why the other tests ran (an input changed, or no entry yet): ${why.map(([k, v]) => `${k} ${n(v)}`).join(", ")}.`);
  const nc = Object.entries(s.notCached).sort((a, b) => b[1] - a[1]);
  if (nc.length) T.push(`Not cacheable (the test touched something the engine cannot prove): ${nc.map(([k, v]) => `${k} ${n(v)}`).join(", ")}.`);
  if (s.runtimeChanged.length) T.push(`The machine's runtime changed since the previous run: ${s.runtimeChanged.slice(0, 10).map(code).join(", ")}.`);
  T.push("Test time: run " + minutes(s.testSecondsRun) + ", skipped with proof " + minutes(s.testSecondsSaved) + ".");
  if (s.engineVersion) T.push(`Engine: detpy ${s.engineVersion}.`);
  let summary = S.join("\n");
  if (summary.length > 65_000) summary = summary.slice(0, 64_900) + "\n\n(cut: see the run on fenvix)";
  return { title: title(s, c), summary, text: T.join("\n\n") };
}

/** The short pull request comment, updated in place on every run. */
export function prComment(s: RunSummary | null, ctx: RenderContext): string {
  const c = conclusionOf(s, ctx.jobConclusion, ctx.summaryUnreadable);
  const icon = c === "success" ? "✅" : c === "failure" ? "❌" : "⚪";
  const L = [COMMENT_MARKER, `### ${icon} fenvix · ${title(s, c, ctx.summaryUnreadable)}`, ""];
  if (s) {
    L.push(...table(s, ctx), ...failures(s, 10, 5));
  } else {
    L.push(c === "cancelled" ? "The job was cancelled before the tests reported." : ctx.summaryUnreadable ? "The runner's summary could not be read: the run is not proven." : "The job ended before the tests reported; see the job log.");
  }
  const links = [ctx.checkRunUrl && `[Check run](${ctx.checkRunUrl})`, ctx.dashboardRunUrl && `[Run on fenvix](${ctx.dashboardRunUrl})`, ctx.jobUrl && `[Job log](${ctx.jobUrl})`].filter(Boolean);
  L.push("", `<sub>${ctx.workflowName} / ${ctx.jobName} · commit ${code(ctx.headSha.slice(0, 7))}${links.length ? " · " + links.join(" · ") : ""} · this comment is updated on every run</sub>`);
  return L.join("\n");
}
