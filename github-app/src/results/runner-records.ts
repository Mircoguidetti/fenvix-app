/**
 * What fenvix machines send besides the run summary (openapi/fenvix-api.yaml, tag `runner`; docs/data-contract.md
 * "What the runner sends"): live progress, per-test results in chunks, and nightly explorations. The request schemas
 * of the OpenAPI description are the contract; these checks implement them exactly (no type coercion), and
 * tests/unit/runner-records.test.ts compares them with the schemas themselves.
 */

export type RunMode = "enforce" | "shadow";
export type Phase = "setup" | "collecting" | "testing" | "reporting";

/** Which job (RunnerJob). The identity (runner, repository, run for per-job machines) comes from the credential. */
export interface RunnerJob { runId: number; runAttempt: number; repositoryId?: number; runnerName?: string }

export interface RunnerProgress extends RunnerJob {
  seq: number; phase: Phase; testsTotal: number | null; testsDone: number; passed: number; failed: number; skippedWithProof: number;
  currentTest: string | null; elapsedMs: number; mode?: RunMode;
}

export interface RunnerFailure {
  kind: "real" | "flaky_defect"; phase?: string; exceptionType?: string; message?: string; location?: string; defectFingerprint?: string;
}
/** A failed test re-run alone by the runner, without the cache (spec C1): its outcome and, when it failed, its failure. */
export interface RunnerRerunAlone { ran: boolean; outcome?: "passed" | "failed" | "not_proven"; failure?: RunnerFailure }
export interface RunnerTestOutcome {
  testId: string; outcome: "passed" | "failed" | "skipped_with_proof" | "not_proven"; durationMs: number; failure?: RunnerFailure | null;
  cacheKey?: string | null; wouldSkip?: boolean; notProvenCause?: string | null;
  /** A failed test's place among the run's failed tests (0-based, run order). */
  failSeq?: number; rerunAlone?: RunnerRerunAlone;
}
export interface RunnerReceipt {
  testId: string; cacheKey: string; reusedEngineRunId: string; fingerprint: string; reusedDurationMs: number;
  code?: { path: string; qualname: string; digest: string }[];
  modules?: { path: string; kind: "content" | "skeleton" | "hooks"; digest: string }[];
  filesRead?: { path: string; dep: string }[];
  envRead?: { name: string; digest: string }[];
  runtime?: Record<string, unknown>; config?: Record<string, unknown>; changedFilesProven?: number;
}
export interface RunnerDefect {
  testId: string; status: "reproduced" | "replay_unstable"; kind: "order" | "brittle" | "fails-alone";
  polluters?: string[]; setters?: string[]; order: string[]; prefixLength?: number; seed?: number | null; fingerprint: string;
  replay: { runs: number; fails: number; identicalFingerprint: boolean }; outcome?: string;
  exception: { type: string; phase: string; message: string; location: string };
  divergence?: { index: number; reason: string; description: string } | null;
  engineVersion?: string; language?: "python" | "node"; replayCommand?: string;
}
export interface RunnerAuditRerun { testId: string; cacheKey: string; outcome: "confirmed" | "wrong_skip"; untrusted?: boolean; detail?: string }
export type MissKind = "new" | "failed-before" | "config" | "runtime" | "clock" | "env" | "data" | "code";
export interface MissDetail { kind: MissKind; detail: string; tests: number }

export interface RunnerResults extends RunnerJob {
  chunk: number; chunks?: number; engineRunId?: string; seed?: number | null; mode?: RunMode;
  tests?: RunnerTestOutcome[]; receipts?: RunnerReceipt[]; defects?: RunnerDefect[]; audit?: RunnerAuditRerun[]; missDetails?: MissDetail[];
}

export interface RunnerExploration {
  startedAt: string; finishedAt: string; commitSha: string; branch: string; seeds: number; runs: number; collected: number; seconds: number;
  flakyFailing?: string[]; alwaysFailing?: string[]; notReproduced?: string[]; familiesByPolluter?: Record<string, string[]>;
  seedsLog?: { seed: number; seconds: number; failing: string[] }[]; defects?: RunnerDefect[];
}

/** The first problem found, with the JSON path of the field (e.g. `tests[3].durationMs`). */
export class RecordError extends Error {
  readonly field: string;
  constructor(field: string, message: string) { super(`${field}: ${message}`); this.field = field; }
}

// ---------------------------------------------------------------- the checks, one per schema keyword in use

type Obj = Record<string, unknown>;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX40 = /^[0-9a-f]{40}$/;
/** RFC 3339 date-time, as JSON Schema's `format: date-time`. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const at = (path: string, k: string | number) => (typeof k === "number" ? `${path}[${k}]` : path ? `${path}.${k}` : k);

function obj(v: unknown, path: string): Obj {
  if (!isObj(v)) throw new RecordError(path || "body", "must be an object");
  return v;
}
function need(o: Obj, k: string, path: string): unknown {
  if (!(k in o) || o[k] === undefined) throw new RecordError(at(path, k), "is required");
  return o[k];
}
function int(v: unknown, path: string, min?: number, max?: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new RecordError(path, "must be an integer");
  if (min !== undefined && v < min) throw new RecordError(path, `must be ${min} or more`);
  if (max !== undefined && v > max) throw new RecordError(path, `must be ${max} or less`);
  return v;
}
function numb(v: unknown, path: string, min?: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new RecordError(path, "must be a number");
  if (min !== undefined && v < min) throw new RecordError(path, `must be ${min} or more`);
  return v;
}
function text(v: unknown, path: string, max?: number, re?: RegExp): string {
  if (typeof v !== "string") throw new RecordError(path, "must be a string");
  if (max !== undefined && v.length > max) throw new RecordError(path, `must be at most ${max} characters`);
  if (re && !re.test(v)) throw new RecordError(path, `must match ${re.source}`);
  return v;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") throw new RecordError(path, "must be true or false");
  return v;
}
function oneOf<T extends string>(v: unknown, path: string, values: readonly T[]): T {
  if (typeof v !== "string" || !values.includes(v as T)) throw new RecordError(path, `must be one of ${values.join(", ")}`);
  return v as T;
}
function list<T>(v: unknown, path: string, item: (x: unknown, p: string) => T, o: { max?: number; min?: number } = {}): T[] {
  if (!Array.isArray(v)) throw new RecordError(path, "must be a list");
  if (o.max !== undefined && v.length > o.max) throw new RecordError(path, `must have at most ${o.max} items`);
  if (o.min !== undefined && v.length < o.min) throw new RecordError(path, `must have at least ${o.min} item${o.min === 1 ? "" : "s"}`);
  return v.map((x, i) => item(x, at(path, i)));
}
/** An optional property: absent stays absent; present is checked. */
function opt<T>(o: Obj, k: string, path: string, check: (v: unknown, p: string) => T): T | undefined {
  return k in o && o[k] !== undefined ? check(o[k], at(path, k)) : undefined;
}
const orNull = <T>(check: (v: unknown, p: string) => T) => (v: unknown, p: string): T | null => (v === null ? null : check(v, p));
const strings = (max?: number) => (v: unknown, p: string) => list(v, p, (x, q) => text(x, q, max));
const def = <T extends Obj>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function job(o: Obj): RunnerJob {
  return def({
    runId: int(need(o, "runId", ""), "runId", 1),
    runAttempt: opt(o, "runAttempt", "", (v, p) => int(v, p, 1)) ?? 1,
    repositoryId: opt(o, "repositoryId", "", (v, p) => int(v, p)),
    runnerName: opt(o, "runnerName", "", (v, p) => text(v, p)),
  });
}

const MODES = ["enforce", "shadow"] as const;
const PHASES = ["setup", "collecting", "testing", "reporting"] as const;
const MISS_KINDS = ["new", "failed-before", "config", "runtime", "clock", "env", "data", "code"] as const;

export function parseProgress(raw: unknown): RunnerProgress {
  const o = obj(raw, "");
  const nonNeg = (k: string) => int(need(o, k, ""), k, 0);
  return def({
    ...job(o),
    seq: nonNeg("seq"),
    phase: oneOf(need(o, "phase", ""), "phase", PHASES),
    testsTotal: opt(o, "testsTotal", "", orNull((v, p) => int(v, p, 0))) ?? null,
    testsDone: nonNeg("testsDone"), passed: nonNeg("passed"), failed: nonNeg("failed"), skippedWithProof: nonNeg("skippedWithProof"),
    currentTest: opt(o, "currentTest", "", orNull((v, p) => text(v, p, 2000))) ?? null,
    elapsedMs: nonNeg("elapsedMs"),
    mode: opt(o, "mode", "", (v, p) => oneOf(v, p, MODES)),
  });
}

function failure(v: unknown, path: string): RunnerFailure {
  const o = obj(v, path);
  return def({
    kind: oneOf(need(o, "kind", path), at(path, "kind"), ["real", "flaky_defect"] as const),
    phase: opt(o, "phase", path, (x, p) => text(x, p)),
    exceptionType: opt(o, "exceptionType", path, (x, p) => text(x, p)),
    message: opt(o, "message", path, (x, p) => text(x, p, 4000)),
    location: opt(o, "location", path, (x, p) => text(x, p)),
    defectFingerprint: opt(o, "defectFingerprint", path, (x, p) => text(x, p, undefined, HEX32)),
  });
}

function rerunAlone(v: unknown, path: string): RunnerRerunAlone {
  const o = obj(v, path);
  return def({
    ran: bool(need(o, "ran", path), at(path, "ran")),
    outcome: opt(o, "outcome", path, (x, p) => oneOf(x, p, ["passed", "failed", "not_proven"] as const)),
    failure: opt(o, "failure", path, failure),
  });
}

function testOutcome(v: unknown, path: string): RunnerTestOutcome {
  const o = obj(v, path);
  return def({
    testId: text(need(o, "testId", path), at(path, "testId"), 2000),
    outcome: oneOf(need(o, "outcome", path), at(path, "outcome"), ["passed", "failed", "skipped_with_proof", "not_proven"] as const),
    durationMs: int(need(o, "durationMs", path), at(path, "durationMs"), 0),
    failure: opt(o, "failure", path, orNull(failure)),
    cacheKey: opt(o, "cacheKey", path, orNull((x, p) => text(x, p, undefined, HEX32))),
    wouldSkip: opt(o, "wouldSkip", path, bool),
    notProvenCause: opt(o, "notProvenCause", path, orNull((x, p) => text(x, p, 500))),
    failSeq: opt(o, "failSeq", path, (x, p) => int(x, p, 0)),
    rerunAlone: opt(o, "rerunAlone", path, rerunAlone),
  });
}

function fields<K extends string>(keys: K[], extra: Partial<Record<K, readonly string[]>> = {}) {
  return (v: unknown, path: string): Record<K, string> => {
    const o = obj(v, path);
    const out = {} as Record<K, string>;
    for (const k of keys) {
      const p = at(path, k);
      out[k] = extra[k] ? oneOf(need(o, k, path), p, extra[k]!) : text(need(o, k, path), p);
    }
    return out;
  };
}

function receipt(v: unknown, path: string): RunnerReceipt {
  const o = obj(v, path);
  return def({
    testId: text(need(o, "testId", path), at(path, "testId"), 2000),
    cacheKey: text(need(o, "cacheKey", path), at(path, "cacheKey"), undefined, HEX32),
    reusedEngineRunId: text(need(o, "reusedEngineRunId", path), at(path, "reusedEngineRunId"), 100),
    fingerprint: text(need(o, "fingerprint", path), at(path, "fingerprint"), undefined, HEX32),
    reusedDurationMs: int(need(o, "reusedDurationMs", path), at(path, "reusedDurationMs"), 0),
    code: opt(o, "code", path, (x, p) => list(x, p, fields(["path", "qualname", "digest"]))),
    modules: opt(o, "modules", path, (x, p) => list(x, p, fields(["path", "kind", "digest"], { kind: ["content", "skeleton", "hooks"] }))) as RunnerReceipt["modules"],
    filesRead: opt(o, "filesRead", path, (x, p) => list(x, p, fields(["path", "dep"]))),
    envRead: opt(o, "envRead", path, (x, p) => list(x, p, fields(["name", "digest"]))),
    runtime: opt(o, "runtime", path, obj),
    config: opt(o, "config", path, obj),
    changedFilesProven: opt(o, "changedFilesProven", path, (x, p) => int(x, p, 0)),
  });
}

export function parseDefect(v: unknown, path: string): RunnerDefect {
  const o = obj(v, path);
  const replay = obj(need(o, "replay", path), at(path, "replay"));
  const rp = at(path, "replay");
  const exception = fields(["type", "phase", "message", "location"])(need(o, "exception", path), at(path, "exception"));
  if (exception.message.length > 4000) throw new RecordError(at(path, "exception.message"), "must be at most 4000 characters");
  return def({
    testId: text(need(o, "testId", path), at(path, "testId"), 2000),
    status: oneOf(need(o, "status", path), at(path, "status"), ["reproduced", "replay_unstable"] as const),
    kind: oneOf(need(o, "kind", path), at(path, "kind"), ["order", "brittle", "fails-alone"] as const),
    polluters: opt(o, "polluters", path, strings()),
    setters: opt(o, "setters", path, strings()),
    order: list(need(o, "order", path), at(path, "order"), (x, p) => text(x, p), { min: 1 }),
    prefixLength: opt(o, "prefixLength", path, (x, p) => int(x, p, 0)),
    seed: opt(o, "seed", path, orNull((x, p) => int(x, p))),
    fingerprint: text(need(o, "fingerprint", path), at(path, "fingerprint"), undefined, HEX32),
    replay: {
      runs: int(need(replay, "runs", rp), at(rp, "runs")),
      fails: int(need(replay, "fails", rp), at(rp, "fails")),
      identicalFingerprint: bool(need(replay, "identicalFingerprint", rp), at(rp, "identicalFingerprint")),
    },
    outcome: opt(o, "outcome", path, (x, p) => text(x, p)),
    exception,
    divergence: opt(o, "divergence", path, orNull((x, p) => {
      const d = obj(x, p);
      return { index: int(need(d, "index", p), at(p, "index")), reason: text(need(d, "reason", p), at(p, "reason")), description: text(need(d, "description", p), at(p, "description")) };
    })),
    engineVersion: opt(o, "engineVersion", path, (x, p) => text(x, p)),
    language: opt(o, "language", path, (x, p) => oneOf(x, p, ["python", "node"] as const)),
    replayCommand: opt(o, "replayCommand", path, (x, p) => text(x, p, 4000)),
  });
}

function audit(v: unknown, path: string): RunnerAuditRerun {
  const o = obj(v, path);
  return def({
    testId: text(need(o, "testId", path), at(path, "testId"), 2000),
    cacheKey: text(need(o, "cacheKey", path), at(path, "cacheKey"), undefined, HEX32),
    outcome: oneOf(need(o, "outcome", path), at(path, "outcome"), ["confirmed", "wrong_skip"] as const),
    untrusted: opt(o, "untrusted", path, bool),
    detail: opt(o, "detail", path, (x, p) => text(x, p, 2000)),
  });
}

function missDetail(v: unknown, path: string): MissDetail {
  const o = obj(v, path);
  return {
    kind: oneOf(need(o, "kind", path), at(path, "kind"), MISS_KINDS),
    detail: text(need(o, "detail", path), at(path, "detail")),
    tests: int(need(o, "tests", path), at(path, "tests")),
  };
}

/** Per-chunk limits (RunnerResults). */
export const RESULTS_LIMITS = { tests: 5000, receipts: 2000, defects: 500, audit: 5000, missDetails: 5 } as const;

export function parseResults(raw: unknown): RunnerResults {
  const o = obj(raw, "");
  return def({
    ...job(o),
    chunk: int(need(o, "chunk", ""), "chunk", 0, 9999),
    chunks: opt(o, "chunks", "", (v, p) => int(v, p, 1, 10000)),
    engineRunId: opt(o, "engineRunId", "", (v, p) => text(v, p, 100)),
    seed: opt(o, "seed", "", orNull((v, p) => int(v, p))),
    mode: opt(o, "mode", "", (v, p) => oneOf(v, p, MODES)),
    tests: opt(o, "tests", "", (v, p) => list(v, p, testOutcome, { max: RESULTS_LIMITS.tests })),
    receipts: opt(o, "receipts", "", (v, p) => list(v, p, receipt, { max: RESULTS_LIMITS.receipts })),
    defects: opt(o, "defects", "", (v, p) => list(v, p, parseDefect, { max: RESULTS_LIMITS.defects })),
    audit: opt(o, "audit", "", (v, p) => list(v, p, audit, { max: RESULTS_LIMITS.audit })),
    missDetails: opt(o, "missDetails", "", (v, p) => list(v, p, missDetail, { max: RESULTS_LIMITS.missDetails })),
  });
}

export function parseExploration(raw: unknown): RunnerExploration {
  const o = obj(raw, "");
  const nonNeg = (k: string) => int(need(o, k, ""), k, 0);
  const time = (k: string) => text(need(o, k, ""), k, undefined, DATE_TIME);
  const out: RunnerExploration = def({
    startedAt: time("startedAt"),
    finishedAt: time("finishedAt"),
    commitSha: text(need(o, "commitSha", ""), "commitSha", undefined, HEX40),
    branch: text(need(o, "branch", ""), "branch"),
    seeds: nonNeg("seeds"), runs: nonNeg("runs"), collected: nonNeg("collected"),
    seconds: numb(need(o, "seconds", ""), "seconds", 0),
    flakyFailing: opt(o, "flakyFailing", "", strings()),
    alwaysFailing: opt(o, "alwaysFailing", "", strings()),
    notReproduced: opt(o, "notReproduced", "", strings()),
    familiesByPolluter: opt(o, "familiesByPolluter", "", (v, p) => {
      const f = obj(v, p);
      return Object.fromEntries(Object.entries(f).map(([k, x]) => [k, strings()(x, at(p, k))]));
    }),
    seedsLog: opt(o, "seedsLog", "", (v, p) => list(v, p, (x, q) => {
      const s = obj(x, q);
      return { seed: int(need(s, "seed", q), at(q, "seed")), seconds: numb(need(s, "seconds", q), at(q, "seconds")), failing: strings()(need(s, "failing", q), at(q, "failing")) };
    })),
    defects: opt(o, "defects", "", (v, p) => list(v, p, parseDefect, { max: 500 })),
  });
  if (Number.isNaN(Date.parse(out.startedAt)) || Number.isNaN(Date.parse(out.finishedAt))) throw new RecordError("startedAt", "is not a valid time");
  return out;
}

// ---------------------------------------------------------------- mapping a defect bundle to the dashboard's record

export type DefectCause = "polluter" | "state_setter" | "fails_alone";

/** order → polluter, brittle → state_setter (the test fails without it), fails-alone → fails_alone. */
export const causeOf = (kind: RunnerDefect["kind"]): DefectCause => (kind === "order" ? "polluter" : kind === "brittle" ? "state_setter" : "fails_alone");

/** polluters for order, setters for brittle, none for fails-alone. */
export const causeTestsOf = (d: Pick<RunnerDefect, "kind" | "polluters" | "setters">): string[] =>
  d.kind === "order" ? (d.polluters ?? []) : d.kind === "brittle" ? (d.setters ?? []) : [];

/** The same key as `families_by_polluter` of `detpy explore` (and familyKeyOf in src/data/ci.ts). */
export const familyKeyOf = (causeTests: string[]): string => (causeTests.length ? causeTests.join(" + ") : "<none>");

/** Runner progress as ci_runs.progress stores it (src/data/ci-rows.ts mapProgress reads these keys), plus `seq`. */
export function progressRecord(p: RunnerProgress): Record<string, unknown> {
  return {
    seq: p.seq, phase: p.phase, testsTotal: p.testsTotal, testsDone: p.testsDone, passed: p.passed, failed: p.failed,
    skippedWithProof: p.skippedWithProof, currentTest: p.currentTest, elapsedMs: p.elapsedMs,
  };
}

/** Only a newer record replaces the stored one: records can overtake each other on the way. */
export const isNewerProgress = (stored: { seq?: unknown } | null | undefined, seq: number): boolean => {
  const s = stored && typeof stored.seq === "number" ? stored.seq : -1;
  return seq > s;
};

// ---------------------------------------------------------------- warm-up machines (POST /v1/runner/warmups)

/** What a warm-up machine reports (RunnerWarmupReport): it started; or it finished, how, with the summary if any. */
export interface RunnerWarmupReport {
  warmupId: number; event: "started" | "finished"; outcome?: "succeeded" | "failed" | "unsupported"; detail?: string;
  summary?: Record<string, unknown>; repositoryId?: number; runnerName?: string;
}

export function parseWarmupReport(raw: unknown): RunnerWarmupReport {
  const o = obj(raw, "");
  const event = oneOf(need(o, "event", ""), "event", ["started", "finished"] as const);
  const r = def({
    warmupId: int(need(o, "warmupId", ""), "warmupId", 1),
    event,
    outcome: opt(o, "outcome", "", (v, p) => oneOf(v, p, ["succeeded", "failed", "unsupported"] as const)),
    detail: opt(o, "detail", "", (v, p) => text(v, p, 1000)),
    summary: opt(o, "summary", "", (v, p) => obj(v, p)),
    repositoryId: opt(o, "repositoryId", "", (v, p) => int(v, p)),
    runnerName: opt(o, "runnerName", "", (v, p) => text(v, p)),
  });
  if (event === "finished" && r.outcome === undefined) throw new RecordError("outcome", "is required when event is finished");
  if (event === "started" && (r.outcome !== undefined || r.summary !== undefined)) throw new RecordError(r.outcome !== undefined ? "outcome" : "summary", "is only sent when event is finished");
  return r;
}
