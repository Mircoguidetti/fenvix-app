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
   * N, the tests not proven identical to the serial run (notProvenOf: the largest of every source, failing closed).
   * `status.not_proven` is not used. The status, the check run and `tests.notProven` all use this one value.
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

/**
 * The summary's `proof`, or null when it is absent or malformed. A malformed proof never discards the summary: the run
 * keeps its other fields and N from the other sources (notProvenOf), and is never counted green for it.
 */
export function parseProof(v: unknown): SummaryProof | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const count = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : null);
  const secs = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
  const workers = count(o.workers), proven = count(o.proven), notProven = count(o.not_proven), parallel = secs(o.parallel_seconds);
  const rerun = o.rerun_one_lane === undefined ? 0 : count(o.rerun_one_lane);
  if (workers === null || proven === null || notProven === null || parallel === null || rerun === null) return null;
  const serial = o.serial_seconds_estimate === undefined || o.serial_seconds_estimate === null ? null : secs(o.serial_seconds_estimate);
  if (serial === null && o.serial_seconds_estimate !== undefined && o.serial_seconds_estimate !== null) return null;
  const digest = o.order_digest;
  if (digest !== undefined && digest !== null && !str(digest, 200)) return null;
  const causesRaw = o.not_proven_causes ?? [];
  if (!Array.isArray(causesRaw) || causesRaw.length > 50) return null;
  const causes: SummaryProof["notProvenCauses"] = [];
  for (const c of causesRaw) {
    const cc = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    const cause = str(cc.cause, 500);
    const tests = count(cc.tests);
    if (!cause || tests === null) return null;
    causes.push({ cause, tests });
  }
  return {
    workers, proven, notProven, rerunOneLane: rerun, parallelSeconds: parallel, serialSecondsEstimate: serial,
    orderDigest: typeof digest === "string" ? digest : null, notProvenCauses: causes,
  };
}

/**
 * N of a summary (see RunSummary.notProven). Fails closed: every source that says a test was not proven counts, and the
 * largest wins. Sources: `proof.not_proven`; the top-level `not_proven`; the verify verdict (any `verify_status` other
 * than "identical", or none with a non-zero `verify_exit`: at least 1, else `verify_counts.not_proven + diverged +
 * missing + wrong_reuse`); and, with a proof whose `proven + not_proven` is not the tests that ran, `ran - proven`.
 */
export function notProvenOf(o: Record<string, unknown>, proof: SummaryProof | null, ran: number): number {
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0);
  const vc = (o.verify_counts && typeof o.verify_counts === "object" ? o.verify_counts : {}) as Record<string, unknown>;
  const verifyN = count(vc.not_proven) + count(vc.diverged) + count(vc.missing) + count(vc.wrong_reuse);
  const status = o.verify_status;
  const exit = o.verify_exit;
  const failedVerify = status === undefined || status === null ? typeof exit === "number" && exit !== 0 : status !== "identical";
  let n = Math.max(count(o.not_proven), failedVerify ? Math.max(1, verifyN) : 0);
  if (proof) {
    n = Math.max(n, proof.notProven);
    if (proof.proven + proof.notProven !== ran) n = Math.max(n, ran - proof.proven);
  }
  return n;
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
    notProven: notProvenOf(o, proof, ran),
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
