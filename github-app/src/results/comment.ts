/**
 * The ONE fenvix comment of a pull request, made from every fenvix job of its head commit (review gap G-0189): a matrix
 * of jobs, or two test jobs, gives one combined comment in which no job's result hides another's. Per job: its state
 * and its counts; then each flaky defect seen in those jobs with its cause (the first divergent event), the seed and
 * the minimal order, the replay command and the replay link; then the skip-with-proof summary. The culprit and the
 * dependency verdict (Passo 3) are shown when a defect carries them. Pure: tests/unit/comment.test.ts.
 */
import { COMMENT_MARKER, minutes } from "./render.ts";
import type { RunSummary } from "./summary.ts";

export interface JobView {
  jobId: number;
  /** "<workflow> / <job>" (a matrix job's name carries its values, e.g. "test (3.12)"). */
  name: string;
  status: "queued" | "waiting" | "in_progress" | "completed";
  /** GitHub's conclusion once completed. */
  conclusion: string | null;
  /** The runner's summary, once the job published. */
  summary: RunSummary | null;
  /** Published by fenvix (the run row and the check run are final). */
  published: boolean;
  /** No fenvix machine will come (not linked, suspended, disconnected, no region): why, for a person. */
  noMachine: string | null;
  dashboardRunUrl: string | null;
  checkRunUrl: string | null;
  jobUrl: string | null;
}

export interface DefectView {
  id: string;
  testId: string;
  status: "reproduced" | "replay_unstable" | "reported";
  state: "open" | "fixed" | "muted";
  cause: string;
  causeTests: string[];
  minimalOrder: string[];
  seed: number | null;
  divergence: { index: number; reason: string; description: string } | null;
  exception: { type: string; message: string; location: string };
  replays: { runs: number; fails: number };
  replayCommand: string;
  pullCommand: string;
  dashboardUrl: string;
  /** Runs that saw it, and pull requests of this repository it was seen in (this one included). */
  occurrences: number;
  pullRequests: number;
  /** The jobs (names) of this commit that saw it. */
  jobs: string[];
  culprit: { summary: string; url?: string | null } | null;
  dependencyVerdict: { summary: string } | null;
  lastReplay: { status: string; runs: number | null; fails: number | null } | null;
}

export type Overall = "running" | "failure" | "success" | "neutral";

const n = (x: number) => x.toLocaleString("en-US");
const code = (s: string) => "`" + s.replace(/`/g, "'").replace(/\n/g, " ") + "`";
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function jobOutcome(j: JobView): Overall {
  if (j.noMachine) return "failure";
  if (j.status !== "completed" || !j.published) return "running";
  if (j.conclusion === "cancelled" || j.conclusion === "skipped") return "neutral";
  const s = j.summary;
  if (!s) return j.conclusion === "success" ? "neutral" : "failure";
  return s.failed.length || s.flaky.length || s.exit !== 0 || j.conclusion === "failure" ? "failure" : "success";
}

/** The comment's verdict: any job failed → failure; else any still running → running; all passed → success. */
export function overallOf(jobs: JobView[]): Overall {
  const o = jobs.map(jobOutcome);
  if (o.includes("failure")) return "failure";
  if (o.includes("running")) return "running";
  if (o.length && o.every((x) => x === "success")) return "success";
  return "neutral";
}

const ICON: Record<Overall, string> = { failure: "❌", running: "⏳", success: "✅", neutral: "⚪" };

function jobCell(j: JobView): string {
  if (j.noMachine) return `❌ no fenvix machine: ${j.noMachine}`;
  const o = jobOutcome(j);
  if (o === "running") return j.status === "completed" ? "⏳ reporting" : j.status === "in_progress" ? "⏳ running" : "⏳ queued";
  if (!j.summary) return j.conclusion === "cancelled" ? "⚪ cancelled" : `${ICON[o]} no fenvix summary`;
  const s = j.summary;
  const fails = s.failed.length + s.flaky.length;
  return fails ? `❌ ${n(fails)} failed${s.flaky.length ? ` (${n(s.flaky.length)} flaky)` : ""}` : `${ICON[o]} passed`;
}

/** The first divergent event, in words: the engine's description, else the order dependence it found. */
export function causeText(d: DefectView): string {
  if (d.divergence) {
    const what = d.divergence.description || d.divergence.reason;
    return `runs diverge at event ${n(d.divergence.index)} (${d.divergence.reason}): ${what}`;
  }
  switch (d.cause) {
    case "polluter": return `order-dependent: ${d.causeTests.map(code).join(" + ") || "an earlier test"} leaves state behind`;
    case "state_setter": return `order-dependent: it needs ${d.causeTests.map(code).join(" + ") || "an earlier test"} to run first`;
    case "fails_alone": return "fails when run alone";
    case "unknown": return "failed in the suite and passed alone; the engine has not minimised it yet";
    default: return `${d.cause.replace(/_/g, " ")} (the divergent event's kind)`;
  }
}

export interface CommentContext {
  repository: string;
  headSha: string;
  dashboardUrl: string;
  /** The combined skip-with-proof receipts (the dashboard), when there is one place for them. */
  receiptsUrl: string | null;
}

/** The comment of one pull request: every fenvix job of the head commit and the defects they saw. */
export function combinedComment(jobs: JobView[], defects: DefectView[], ctx: CommentContext): string {
  const overall = overallOf(jobs);
  const done = jobs.filter((j) => j.summary);
  const sum = (f: (s: RunSummary) => number) => done.reduce((a, j) => a + f(j.summary!), 0);
  const tests = sum((s) => s.tests), skipped = sum((s) => s.reusedWithProof), saved = sum((s) => s.testSecondsSaved);
  const fails = sum((s) => s.failed.length + s.flaky.length);
  const open = defects.filter((d) => d.state !== "muted");
  const head = overall === "running"
    ? `${jobs.filter((j) => jobOutcome(j) === "running").length} of ${jobs.length} fenvix job${jobs.length === 1 ? "" : "s"} still running`
    : overall === "failure" ? `${n(fails)} failed${open.length ? ` · ${n(open.length)} flaky defect${open.length === 1 ? "" : "s"}` : ""}`
    : overall === "success" ? "all tests passed" : "no result";
  const L = [COMMENT_MARKER, `### ${ICON[overall]} fenvix · ${head}`, ""];

  L.push("| Job | Result | Tests | Skipped with proof | Saved | |", "|---|---|---|---|---|---|");
  for (const j of jobs) {
    const s = j.summary;
    const links = [j.dashboardRunUrl && `[run](${j.dashboardRunUrl})`, j.checkRunUrl && `[check](${j.checkRunUrl})`, j.jobUrl && `[log](${j.jobUrl})`].filter(Boolean).join(" · ");
    L.push(`| ${cell(j.name)} | ${cell(jobCell(j))} | ${s ? n(s.tests) : "–"} | ${s ? n(s.reusedWithProof) : "–"} | ${s ? cell(minutes(s.testSecondsSaved)) : "–"} | ${links} |`);
  }

  if (open.length) {
    L.push("", "### Flaky defects", "", "Each one is reproducible: the replay fails the same way every time.");
    for (const d of open.slice(0, 10)) {
      L.push("", `**${code(d.testId)}**${d.state === "fixed" ? " (fixed)" : ""} · [defect](${d.dashboardUrl})`);
      L.push(`- cause: ${causeText(d)}`);
      if (d.exception.type || d.exception.message) L.push(`- error: ${code([d.exception.type, d.exception.message].filter(Boolean).join(": ").slice(0, 300))}${d.exception.location ? ` at ${code(d.exception.location)}` : ""}`);
      const facts = [d.seed !== null ? `seed ${d.seed}` : "collection order", d.minimalOrder.length > 1 ? `minimal order ${d.minimalOrder.map(code).join(" → ")}` : null,
        d.replays.runs ? `replays ${d.replays.fails}/${d.replays.runs}` : null].filter(Boolean);
      L.push(`- ${facts.join(" · ")}`);
      L.push("- replay:", "  ```sh", `  ${d.pullCommand}`, `  ${d.replayCommand}`, "  ```");
      L.push(`- [replay it on fenvix](${d.dashboardUrl}?replay=1)${d.lastReplay ? ` · last replay: ${d.lastReplay.status}${d.lastReplay.runs ? ` ${d.lastReplay.fails ?? 0}/${d.lastReplay.runs}` : ""}` : ""}`);
      if (d.culprit) L.push(`- culprit: ${d.culprit.url ? `[${cell(d.culprit.summary)}](${d.culprit.url})` : cell(d.culprit.summary)}`);
      if (d.dependencyVerdict) L.push(`- dependency verdict: ${cell(d.dependencyVerdict.summary)}`);
      L.push(`- seen in ${n(d.occurrences)} run${d.occurrences === 1 ? "" : "s"}${d.pullRequests > 1 ? ` across ${n(d.pullRequests)} pull requests` : ""}${jobs.length > 1 ? ` · jobs: ${d.jobs.map(cell).join(", ")}` : ""}`);
    }
    if (open.length > 10) L.push("", `and ${n(open.length - 10)} more on the [dashboard](${ctx.dashboardUrl}/defects)`);
  }

  const real = done.flatMap((j) => j.summary!.failed.map((t) => ({ t, job: j.name })));
  if (real.length) {
    L.push("", "### Failures", "");
    for (const f of real.slice(0, 15)) L.push(`- ${code(f.t)}${jobs.length > 1 ? ` (${cell(f.job)})` : ""}`);
    if (real.length > 15) L.push(`- and ${n(real.length - 15)} more`);
  }

  if (done.length) {
    const receipts = ctx.receiptsUrl ? ` ([receipts](${ctx.receiptsUrl}))` : "";
    L.push("", `**Skip with proof:** ${n(skipped)} of ${n(tests)} tests skipped${receipts}, ${minutes(saved)} of test time saved. A test is skipped only when everything it depends on is proven unchanged since a run where it passed.`);
  }
  L.push("", `<sub>commit ${code(ctx.headSha.slice(0, 7))} · ${n(jobs.length)} fenvix job${jobs.length === 1 ? "" : "s"} · this comment is updated as each job reports</sub>`);
  let body = L.join("\n");
  if (body.length > 65_000) body = body.slice(0, 64_800) + "\n\n(cut: see the dashboard)";
  return body;
}

