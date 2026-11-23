/**
 * The run summary the runner writes (fenvix-engine-cli, branch claude/runner-prototype-ee21he, `runner/fenvix-run`,
 * `<out>/summary.json`). Snake case, as the runner writes it. Only the fields the App uses are checked; the per-test
 * maps (`outcomes`, `reused_outcomes`) and the runtime's distribution list are dropped before the summary is stored,
 * because they grow with the suite and the App never shows them.
 */
import { type Stack, stackFromSummary } from "./detect.ts";

export interface FlakyTest { nodeid: string; replay: string; minimise: string | null }

/** The summary's `proof` (docs/data-contract.md, "Parallel with proof"): the test command ran in parallel lanes. */
export interface SummaryProof {
  workers: number;
  proven: number;
  notProven: number;
  rerunOneLane: number;
  parallelSeconds: number;
  serialSecondsEstimate: number | null;
  orderDigest: string | null;
  notProvenCauses: { cause: string; tests: number }[];
}

export interface RunSummary {
  commit: string;
  cacheWasWarm: boolean;
  exit: number;
  wallSeconds: number;
  tests: number;
  ran: number;
  reusedWithProof: number;
  testSecondsSaved: number;
  testSecondsRun: number;
  shareOfTestTimeSaved: number;
  /** Real failures: failed in the suite and again alone. */
  failed: string[];
  /** Failed in the suite, passed alone: order-dependent, with the replay command. */
  flaky: FlakyTest[];
  outcomeCounts: Record<string, number>;
  notReusedReasons: Record<string, number>;
  notCached: Record<string, number>;
  engineVersion: string;
  runtimeChanged: string[];
  /**
   * The language and test runner the run says it used: `language` / `test_runner` when the runner sends them, else
   * inferred from the runtime (src/results/detect.ts). Null: unknown.
   */
  stack: Stack | null;
  /** The mode the runner ran in (`mode`): shadow during the trial. Null: not sent. */
  mode: "shadow" | "enforce" | null;
  /** Null: a serial run (or a runner that does not send it yet). */
  proof: SummaryProof | null;
  /**
   * N, the tests not proven identical to the serial run: `proof.not_proven` when `proof` is present; else the larger of
   * the top-level `not_proven` and, when `verify_status` is "diverged", `verify_counts.not_proven + diverged + missing`;
   * else 0. `status.not_proven` is not used. The status, the check run and `tests.notProven` all use this one value.
   */
  notProven: number;
}

export class SummaryError extends Error {}

// `runner_args` is the Node runner's name for `pytest_args` (fenvix-run node)
const DROP = ["outcomes", "reused_outcomes", "pytest_args", "runner_args"] as const;

function num(o: Record<string, unknown>, k: string, opts: { required?: boolean; int?: boolean } = {}): number {
  const v = o[k];
  if (v === undefined || v === null) {
    if (opts.required) throw new SummaryError(`summary.${k} is missing`);
    return 0;
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (opts.int && !Number.isInteger(v))) throw new SummaryError(`summary.${k} must be a ${opts.int ? "whole " : ""}number of 0 or more`);
  return v;
}

function counts(o: Record<string, unknown>, k: string): Record<string, number> {
  const v = o[k];
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new SummaryError(`summary.${k} must be an object of counts`);
  const out: Record<string, number> = {};
  for (const [kk, vv] of Object.entries(v)) {
    if (typeof vv !== "number" || !Number.isInteger(vv) || vv < 0) throw new SummaryError(`summary.${k}.${kk} must be a count`);
    if (!/^[A-Za-z0-9_.:-]{1,40}$/.test(kk)) throw new SummaryError(`summary.${k} has an unexpected key`);
    out[kk] = vv;
  }
  return out;
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

/**
 * The stored form: the runner's summary without the per-test maps. What the dropped distribution list told (the
 * engine's version, the language and test runner) is kept as `engine_version`, `language` and `test_runner`.
 */
export function trimSummary(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const k of DROP) delete out[k];
  const stack = stackFromSummary(raw);
  if (stack) {
    out.language = stack.language;
    if (stack.testRunner) out.test_runner = stack.testRunner; else delete out.test_runner;
  }
  if (out.runtime && typeof out.runtime === "object") {
    const { dist_list: _drop, ...rest } = out.runtime as Record<string, unknown>;
    out.runtime = rest;
    out.engine_version = engineVersionOf(raw);
  }
  return out;
}

function engineVersionOf(raw: Record<string, unknown>): string {
  if (typeof raw.engine_version === "string") return raw.engine_version;
  const rt = raw.runtime as { dist_list?: unknown } | undefined;
  if (rt && Array.isArray(rt.dist_list)) {
    for (const d of rt.dist_list) {
      const m = typeof d === "string" ? /^det(?:py|js)(?:==|@)([^:]+)/.exec(d) : null;
      if (m) return m[1]!;
    }
  }
  return "";
}

function parseProof(v: unknown): SummaryProof | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new SummaryError("summary.proof must be an object");
  const o = v as Record<string, unknown>;
  const p = (k: string, int = true) => {
    try { return num(o, k, { required: true, int }); } catch { throw new SummaryError(`summary.proof.${k} must be a ${int ? "whole " : ""}number of 0 or more`); }
  };
  const orNull = (k: string, int: boolean) => (o[k] === undefined || o[k] === null ? null : p(k, int));
  const causesRaw = o.not_proven_causes ?? [];
  if (!Array.isArray(causesRaw)) throw new SummaryError("summary.proof.not_proven_causes must be a list");
  const notProvenCauses = causesRaw.slice(0, 50).map((c, i) => {
    const cc = (c ?? {}) as Record<string, unknown>;
    const cause = str(cc.cause, 500);
    if (!cause || typeof cc.tests !== "number" || !Number.isInteger(cc.tests) || cc.tests < 0) throw new SummaryError(`summary.proof.not_proven_causes[${i}] needs cause and tests`);
    return { cause, tests: cc.tests };
  });
  const digest = o.order_digest;
  if (digest !== undefined && digest !== null && !str(digest, 200)) throw new SummaryError("summary.proof.order_digest must be text");
  return {
    workers: p("workers"), proven: p("proven"), notProven: p("not_proven"), rerunOneLane: o.rerun_one_lane === undefined ? 0 : p("rerun_one_lane"),
    parallelSeconds: p("parallel_seconds", false), serialSecondsEstimate: orNull("serial_seconds_estimate", false),
    orderDigest: typeof digest === "string" ? digest : null, notProvenCauses,
  };
}

/** N of a summary: see RunSummary.notProven. */
export function notProvenOf(o: Record<string, unknown>, proof: SummaryProof | null): number {
  if (proof) return proof.notProven;
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0);
  const top = count(o.not_proven);
  const vc = (o.verify_counts && typeof o.verify_counts === "object" ? o.verify_counts : {}) as Record<string, unknown>;
  const verify = o.verify_status === "diverged" ? count(vc.not_proven) + count(vc.diverged) + count(vc.missing) : 0;
  return Math.max(top, verify);
}

export function parseSummary(raw: unknown): RunSummary {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SummaryError("summary must be a JSON object");
  const o = raw as Record<string, unknown>;
  const tests = num(o, "tests", { required: true, int: true });
  const reused = num(o, "reused_with_proof", { required: true, int: true });
  if (reused > tests) throw new SummaryError("summary: reused_with_proof is larger than tests");
  const ran = o.ran === undefined ? tests - reused : num(o, "ran", { int: true });
  if (reused + ran !== tests) throw new SummaryError("summary: reused_with_proof + ran must equal tests");
  const failedRaw = o.failed ?? [];
  if (!Array.isArray(failedRaw) || failedRaw.some((x) => !str(x, 2000))) throw new SummaryError("summary.failed must be a list of test ids");
  const flakyRaw = o.flaky ?? [];
  if (!Array.isArray(flakyRaw)) throw new SummaryError("summary.flaky must be a list");
  const flaky: FlakyTest[] = flakyRaw.map((f, i) => {
    const ff = f as Record<string, unknown>;
    const nodeid = str(ff?.nodeid, 2000);
    const replay = str(ff?.replay, 4000);
    if (!nodeid || !replay) throw new SummaryError(`summary.flaky[${i}] needs nodeid and replay`);
    return { nodeid, replay, minimise: str(ff.minimise, 4000) };
  });
  const commit = typeof o.commit === "string" ? o.commit : "";
  const exit = typeof o.exit === "number" && Number.isInteger(o.exit) ? o.exit : 0;
  const rc = o.runtime_changed_since_previous_job;
  const saved = num(o, "test_seconds_saved");
  const proof = parseProof(o.proof);
  const spent = num(o, "test_seconds_run");
  return {
    commit,
    cacheWasWarm: o.cache_was_warm === true,
    exit,
    wallSeconds: num(o, "wall_seconds"),
    tests,
    ran,
    reusedWithProof: reused,
    testSecondsSaved: saved,
    testSecondsRun: spent,
    shareOfTestTimeSaved: saved + spent > 0 ? saved / (saved + spent) : 0,
    failed: failedRaw as string[],
    flaky,
    outcomeCounts: counts(o, "outcome_counts"),
    notReusedReasons: counts(o, "not_reused_reasons"),
    notCached: counts(o, "not_cached"),
    engineVersion: engineVersionOf(o),
    runtimeChanged: Array.isArray(rc) ? rc.filter((x): x is string => typeof x === "string").slice(0, 50) : [],
    stack: stackFromSummary(o),
    mode: o.mode === "shadow" || o.mode === "enforce" ? o.mode : null,
    proof,
    notProven: notProvenOf(o, proof),
  };
}

/** The summary's proof as ci_runs.proof stores it: the contract's RunProof (camelCase, milliseconds). */
export function proofRecord(p: SummaryProof) {
  return {
    workers: p.workers, proven: p.proven, notProven: p.notProven, rerunOneLane: p.rerunOneLane, parallelMs: Math.round(p.parallelSeconds * 1000),
    serialMsEstimate: p.serialSecondsEstimate === null ? null : Math.round(p.serialSecondsEstimate * 1000), orderDigest: p.orderDigest,
    notProvenCauses: p.notProvenCauses,
  };
}
