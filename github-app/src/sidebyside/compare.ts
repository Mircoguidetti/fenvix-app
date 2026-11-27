/*
 * Side-by-side runs, the pure part (docs/data-contract.md "Side-by-side runs"): what the customer's runner costs, the
 * pairing of his test job with ours, and the comparison rule. No database, no clock but the one given.
 */

// ---------------------------------------------------------------- prices of his runner

export interface Rate { key: string; usdPerMinute: number; usdPerMinuteMax: number | null; runner: string }

/** The price of one job of his, by its runner labels. */
export type Price =
  | { kind: "rate"; label: string; rate: Rate }
  /** A public repository on GitHub-hosted runners: GitHub does not bill it. */
  | { kind: "free"; label: string }
  | { kind: "unknown"; label: string };

/** GitHub's own runners (the rows mapped to the GitHub-hosted rate). */
export const GITHUB_HOSTED_RATE = "github-linux-2core";

/** The first of his labels with a known rate; a public repository on GitHub-hosted runners costs $0. */
export function priceOf(labels: string[], isPrivate: boolean, byLabel: ReadonlyMap<string, Rate>): Price {
  for (const label of labels) {
    const rate = byLabel.get(label);
    if (!rate) continue;
    if (!isPrivate && rate.key === GITHUB_HOSTED_RATE) return { kind: "free", label };
    return { kind: "rate", label, rate };
  }
  return { kind: "unknown", label: labels.find((l) => l !== "self-hosted") ?? labels[0] ?? "no label" };
}

/** GitHub bills each job in whole minutes, rounded up. */
export const billedMinutes = (seconds: number): number => Math.max(0, Math.ceil(seconds / 60));

/** The cost of one job of `seconds` at that price: a range for a ranged rate, null when the price is unknown. */
export function jobCost(seconds: number, p: Price): { min: number; max: number } | null {
  if (p.kind === "unknown") return null;
  if (p.kind === "free") return { min: 0, max: 0 };
  const m = billedMinutes(seconds);
  return { min: m * p.rate.usdPerMinute, max: m * (p.rate.usdPerMinuteMax ?? p.rate.usdPerMinute) };
}

export function priceText(p: Price): string {
  if (p.kind === "unknown") return `price unknown for ${p.label}`;
  if (p.kind === "free") return `$0 (public repository on ${p.label})`;
  const r = p.rate;
  return r.usdPerMinuteMax !== null && r.usdPerMinuteMax !== r.usdPerMinute ? `$${r.usdPerMinute}-${r.usdPerMinuteMax} per minute (${r.runner})` : `$${r.usdPerMinute} per minute (${r.runner})`;
}

// ---------------------------------------------------------------- the two jobs of one commit and event

/** One of his completed test jobs (gh_customer_jobs). */
export interface HisJob {
  jobId: number; runAttempt: number; headSha: string; event: string | null; prNumber: number | null; matrixSuffix: string | null;
  conclusion: string | null; startedAt: Date | null; completedAt: Date | null; labels: string[];
  steps: { name: string; conclusion: string | null }[] | null;
}

/** One of our side-by-side jobs (gh_jobs kind side_by_side), with its run row when it has one. */
export interface OurJob {
  jobId: number; runAttempt: number; headSha: string; event: string | null; prNumber: number | null;
  status: string; conclusion: string | null; startedAt: Date | null; completedAt: Date | null;
  skipMachine: boolean; hasSummary: boolean | null;
  /** Its full machine was stopped so that a paying job got the slots (gh_jobs.sbs_stopped_at). */
  stoppedForCustomer?: boolean;
  /** ci_runs.status: passed / failed / not_proven / cancelled / running, or null without a row. */
  runStatus: string | null;
  testsRan: number; wouldSkipTests: number; wouldSaveMs: number;
}

export type Result = "same" | "different" | "not_comparable" | "not_proven" | "waiting";

/** Our machine: its type, vCPUs and on-demand price (SIDE_BY_SIDE_*). */
export interface OurMachine { instanceType: string; vcpus: number; usdPerHour: number }

/** A skip machine is the launch template's c6i.large (2 vCPU), priced at the full machine's price per vCPU (c6i prices scale with the size). */
const SKIP_VCPUS = 2;

/** Our job's vCPU-minutes and machine cost for its held minutes, on a full machine or on a skip machine. */
export function ourCost(heldMinutes: number, skipMachine: boolean, full: OurMachine): { vcpuMinutes: number; machineCost: number } {
  const vcpus = skipMachine ? SKIP_VCPUS : full.vcpus;
  const usdPerHour = full.usdPerHour * vcpus / full.vcpus;
  const r = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
  return { vcpuMinutes: r(vcpus * heldMinutes, 2), machineCost: r(heldMinutes * usdPerHour / 60, 6) };
}

export interface Pair {
  key: { headSha: string; event: string | null; prNumber: number | null };
  his: HisJob | null;
  ours: OurJob | null;
  result: Result;
  detail: string;
  /** For the order of the list: the latest completion of the two. */
  at: Date;
}

/** How long one side waits for the other before it is "not seen". */
export const NOT_SEEN_MS = 6 * 3_600_000;
const HIS_ENDED = ["cancelled", "timed_out", "skipped", "action_required"];

/** His failing step: the first step whose conclusion is failure (GET /actions/jobs/{id} steps). */
export function failingStep(h: HisJob): string | null {
  return h.steps?.find((s) => s.conclusion === "failure")?.name ?? null;
}

/**
 * The comparison rule (first matching row wins). `his`/`ours` null: not seen (yet). Ours is judged from the runner's
 * summary only (our job always concludes success: every step continues on error).
 */
export function compare(his: HisJob | null, ours: OurJob | null, testStep: string, o: { hisMissing?: string; oursMissing?: string } = {}): { result: Result; detail: string } {
  const nc = (detail: string) => ({ result: "not_comparable" as const, detail });
  if (!his) return o.hisMissing === "waiting" ? { result: "waiting", detail: "waiting for your job" } : nc("your job not seen");
  if (HIS_ENDED.includes(his.conclusion ?? "")) return nc(`your job: ${his.conclusion}`);
  if (!ours) return o.oursMissing === "waiting" ? { result: "waiting", detail: "waiting for our job" } : nc("our job not seen (daily cap, trigger filters, or no machine)");
  if (ours.skipMachine) return nc("our job ran on a skip machine (no test ran)");
  if (ours.stoppedForCustomer) return nc("stopped for a customer job");
  if (ours.conclusion === "cancelled" || ours.runStatus === "cancelled") return nc("our job was cancelled");
  if (ours.conclusion === "timed_out") return nc("our job timed out");
  if (!ours.hasSummary) return nc("no summary from the runner");
  if (ours.runStatus === "not_proven") return { result: "not_proven", detail: "the engine could not prove the run (NOT PROVEN)" };
  if (his.conclusion === "failure") {
    const at = failingStep(his);
    if (at !== testStep) return nc(`your job failed at step ${at ?? "(unknown)"}`);
    if (ours.runStatus === "failed") return { result: "same", detail: "both failed at the tests" };
    if (ours.runStatus === "passed") return { result: "different", detail: "your tests failed; ours all passed" };
  }
  if (his.conclusion === "success") {
    if (ours.runStatus === "passed") return { result: "same", detail: "both passed" };
    if (ours.runStatus === "failed") return { result: "different", detail: "your tests passed; at least one of ours failed" };
  }
  return nc(`your job: ${his.conclusion ?? "no conclusion"}; ours: ${ours.runStatus ?? "no run"}`);
}

const keyOf = (j: { headSha: string; event: string | null; prNumber: number | null }) => `${j.headSha}|${j.event ?? ""}|${j.prNumber ?? ""}`;
const latest = <T extends { runAttempt: number; completedAt: Date | null }>(xs: T[]): T | null =>
  xs.reduce<T | null>((a, b) => (!a || b.runAttempt > a.runAttempt || (b.runAttempt === a.runAttempt && (b.completedAt?.getTime() ?? 0) > (a.completedAt?.getTime() ?? 0)) ? b : a), null);

/**
 * Pairs by (head sha, event, pull request) his jobs of the repository's matrix suffix with ours: the latest completed
 * attempt of each side. A side missing NOT_SEEN_MS after the other completed is "not seen"; before, "waiting".
 */
export function pairJobs(his: HisJob[], ours: OurJob[], o: { matrixSuffix: string | null; testStep: string; now: Date }): Pair[] {
  const byKey = new Map<string, { his: HisJob[]; ours: OurJob[]; key: Pair["key"] }>();
  const slot = (j: HisJob | OurJob) => {
    const k = keyOf(j);
    return byKey.get(k) ?? byKey.set(k, { his: [], ours: [], key: { headSha: j.headSha, event: j.event, prNumber: j.prNumber } }).get(k)!;
  };
  for (const h of his) if ((h.matrixSuffix ?? null) === (o.matrixSuffix ?? null) && h.completedAt) slot(h).his.push(h);
  for (const u of ours) if (u.status === "completed") slot(u).ours.push(u);
  const out: Pair[] = [];
  for (const g of byKey.values()) {
    const h = latest(g.his);
    const u = latest(g.ours);
    const since = (d: Date | null | undefined) => (d ? o.now.getTime() - d.getTime() : 0);
    const r = compare(h, u, o.testStep, {
      hisMissing: !h && since(u?.completedAt) < NOT_SEEN_MS ? "waiting" : undefined,
      oursMissing: !u && since(h?.completedAt) < NOT_SEEN_MS ? "waiting" : undefined,
    });
    const at = new Date(Math.max(h?.completedAt?.getTime() ?? 0, u?.completedAt?.getTime() ?? 0));
    out.push({ key: g.key, his: h, ours: u, ...r, at });
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

// ---------------------------------------------------------------- small statistics

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export const seconds = (a: Date | null, b: Date | null): number | null => (a && b ? Math.max(0, (b.getTime() - a.getTime()) / 1000) : null);
