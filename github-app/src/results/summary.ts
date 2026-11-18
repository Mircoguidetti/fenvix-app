/**
 * The run summary the runner writes (fenvix-engine-cli, branch claude/runner-prototype-ee21he, `runner/fenvix-run`,
 * `<out>/summary.json`). Snake case, as the runner writes it. Only the fields the App uses are checked; the per-test
 * maps (`outcomes`, `reused_outcomes`) and the runtime's distribution list are dropped before the summary is stored,
 * because they grow with the suite and the App never shows them.
 */
export interface FlakyTest { nodeid: string; replay: string; minimise: string | null }

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
}

export class SummaryError extends Error {}

const DROP = ["outcomes", "reused_outcomes", "pytest_args"] as const;

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

/** The stored form: the runner's summary without the per-test maps. */
export function trimSummary(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const k of DROP) delete out[k];
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
      const m = typeof d === "string" ? /^detpy==([^:]+)/.exec(d) : null;
      if (m) return m[1]!;
    }
  }
  return "";
}

export function parseSummary(raw: unknown): RunSummary {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SummaryError("summary must be a JSON object");
  const o = raw as Record<string, unknown>;
  const tests = num(o, "tests", { required: true, int: true });
  const reused = num(o, "reused_with_proof", { required: true, int: true });
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
  };
}
