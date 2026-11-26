import { Document, isAlias, isMap, isPair, isScalar, isSeq, Pair, parseDocument, Scalar, YAMLMap, YAMLSeq, type Node } from "yaml";

/**
 * Reads GitHub Actions workflow files, finds the job that runs the tests, and changes only that job's `runs-on:`.
 *
 * The YAML is parsed to find the exact source range of the job's `runs-on` value; the change is then made on the
 * original text, character by character, so everything else (comments, quoting, blank lines, key order, anchors) is
 * byte-for-byte the same. The result is parsed again to prove that only that value changed.
 */

export type Language = "python" | "node" | "go";
export type TestRunner = "pytest" | "vitest" | "jest" | "go test" | "node:test" | "mocha";

export interface WorkflowFile { path: string; text: string }

/** Why a job's `runs-on` can or cannot be changed to fenvix. */
export type RunsOnVerdict =
  | { ok: true; current: string; note?: string }
  | { ok: false; kind: "already_fenvix" | "unsupported"; current: string; reason: string };

export interface JobAnalysis {
  file: string;
  jobId: string;
  name: string;
  /** How much the job looks like the test job; above 0 only with a test command or a test-like name and run steps. */
  score: number;
  reasons: string[];
  isTestJob: boolean;
  language: Language | null;
  testRunner: TestRunner | null;
  runsOn: RunsOnVerdict;
}

export interface FileAnalysis { path: string; jobs: JobAnalysis[]; error?: string }

interface Command { re: RegExp; score: number; language: Language | null; runner: TestRunner | null; label: string }

// Strongest first: the first match per run step decides language and runner.
const COMMANDS: Command[] = [
  { re: /\b(python3?\s+-m\s+)?pytest\b/, score: 6, language: "python", runner: "pytest", label: "runs pytest" },
  { re: /\bvitest\b/, score: 6, language: "node", runner: "vitest", label: "runs vitest" },
  { re: /\bjest\b/, score: 6, language: "node", runner: "jest", label: "runs jest" },
  { re: /\bmocha\b/, score: 6, language: "node", runner: "mocha", label: "runs mocha" },
  // `node --test` with any flags before it (`node --experimental-strip-types --test`), not `--test-reporter` alone
  { re: /\bnode\b[^\n;&|]*\s--test(?![-\w])/, score: 6, language: "node", runner: "node:test", label: "runs node --test" },
  { re: /\bgo\s+test\b/, score: 6, language: "go", runner: "go test", label: "runs go test" },
  { re: /\b(tox|nox)\b/, score: 4, language: "python", runner: "pytest", label: "runs tox/nox" },
  { re: /\b(uv\s+run|poetry\s+run|hatch\s+run|pdm\s+run)\s+(python\s+-m\s+)?(pytest|test)\b/, score: 6, language: "python", runner: "pytest", label: "runs pytest" },
  { re: /\bpython3?\s+-m\s+unittest\b|\bmanage\.py\s+test\b/, score: 4, language: "python", runner: null, label: "runs Python tests" },
  { re: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnpm\s+t\b/, score: 5, language: "node", runner: null, label: "runs the package's test script" },
  { re: /\bmake\s+(test|check)\b/, score: 3, language: null, runner: null, label: "runs make test" },
];
const TEST_NAME = /(^|[^a-z])(test|tests|testing|pytest|unit|integration|e2e|check)([^a-z]|$)/i;
const NOT_TEST_NAME = /(^|[^a-z])(lint|linters?|format|fmt|typecheck|types|mypy|build|deploy|release|publish|docs?|coverage-upload|label|stale|codeql|security)([^a-z]|$)/i;
const NON_LINUX = /\b(windows|macos|mac-|osx)/i;

const scalarText = (n: unknown): string | null => (isScalar(n) && (typeof n.value === "string" || typeof n.value === "number") ? String(n.value) : null);

function pairOf(map: YAMLMap, key: string): Pair<Node, Node> | undefined {
  return map.items.find((p) => isPair(p) && scalarText(p.key) === key) as Pair<Node, Node> | undefined;
}

/** All run commands of a job's steps. */
function runCommands(job: YAMLMap): string[] {
  const steps = pairOf(job, "steps")?.value;
  if (!isSeq(steps)) return [];
  const out: string[] = [];
  for (const s of steps.items) if (isMap(s)) { const r = scalarText(pairOf(s, "run")?.value); if (r) out.push(r); }
  return out;
}

function matrixValues(job: YAMLMap, key: string): string[] | null {
  const strategy = pairOf(job, "strategy")?.value;
  if (!isMap(strategy)) return null;
  const matrix = pairOf(strategy, "matrix")?.value;
  if (!isMap(matrix)) return null;
  const v = pairOf(matrix, key)?.value;
  if (!isSeq(v)) return null;
  const vals = v.items.map(scalarText);
  if (vals.some((x) => x === null)) return null;
  // `include:` entries may add values too.
  const include = pairOf(matrix, "include")?.value;
  if (isSeq(include)) for (const e of include.items) if (isMap(e)) { const x = scalarText(pairOf(e, key)?.value); if (x) vals.push(x); }
  return vals as string[];
}

function runsOnVerdict(job: YAMLMap, label: string): RunsOnVerdict {
  const pair = pairOf(job, "runs-on");
  if (!pair) {
    const uses = scalarText(pairOf(job, "uses")?.value);
    return { ok: false, kind: "unsupported", current: "", reason: uses ? `calls the reusable workflow ${uses}: its own jobs choose their machines` : "has no runs-on" };
  }
  const v = pair.value;
  if (isScalar(v)) {
    const s = scalarText(v) ?? "";
    if (s === label) return { ok: false, kind: "already_fenvix", current: s, reason: `already runs on ${label}` };
    if (!s) return { ok: false, kind: "unsupported", current: s, reason: "runs-on is empty" };
    const expr = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(s);
    if (expr) {
      const vals = matrixValues(job, expr[1]!);
      if (!vals) return { ok: false, kind: "unsupported", current: s, reason: `runs-on comes from matrix.${expr[1]}, which could not be read` };
      const bad = vals.filter((x) => NON_LINUX.test(x));
      if (bad.length) return { ok: false, kind: "unsupported", current: s, reason: `the matrix also runs on ${bad.join(", ")}; fenvix machines are Linux` };
      return { ok: true, current: s, note: `every matrix.${expr[1]} value (${vals.join(", ")}) is Linux, so the matrix keeps its other dimensions and runs on ${label}` };
    }
    if (s.includes("${{")) return { ok: false, kind: "unsupported", current: s, reason: "runs-on is an expression; change it by hand" };
    if (NON_LINUX.test(s)) return { ok: false, kind: "unsupported", current: s, reason: `runs on ${s}; fenvix machines are Linux` };
    return { ok: true, current: s };
  }
  if (isSeq(v)) {
    const vals = v.items.map(scalarText);
    const shown = vals.map((x) => x ?? "?").join(", ");
    if (vals.includes(label)) return { ok: false, kind: "already_fenvix", current: `[${shown}]`, reason: `already runs on ${label}` };
    if (vals.some((x) => x !== null && (NON_LINUX.test(x) || x.includes("${{")))) {
      return { ok: false, kind: "unsupported", current: `[${shown}]`, reason: "runs-on names a non-Linux machine or an expression" };
    }
    return { ok: true, current: `[${shown}]` };
  }
  if (isMap(v)) {
    const group = scalarText(pairOf(v, "group")?.value);
    return { ok: true, current: group ? `group ${group}` : "a runner group" };
  }
  return { ok: false, kind: "unsupported", current: "", reason: "runs-on has a shape fenvix does not know" };
}

export function analyzeWorkflow(file: WorkflowFile, label: string): FileAnalysis {
  // Our own side-by-side file is never one of the customer's workflows (nor his test job).
  if (file.path === SIDE_BY_SIDE_PATH) return { path: file.path, jobs: [] };
  const doc = parseDocument(file.text, { uniqueKeys: false });
  if (doc.errors.length) return { path: file.path, jobs: [], error: `not valid YAML: ${doc.errors[0]!.message.split("\n")[0]}` };
  if (!isMap(doc.contents)) return { path: file.path, jobs: [], error: "not a workflow (no top-level mapping)" };
  const jobsNode = pairOf(doc.contents, "jobs")?.value;
  if (!isMap(jobsNode)) return { path: file.path, jobs: [], error: "no jobs" };
  const jobs: JobAnalysis[] = [];
  for (const p of jobsNode.items) {
    const jobId = scalarText(p.key);
    if (!jobId || !isMap(p.value)) continue;
    const job = p.value;
    const name = scalarText(pairOf(job, "name")?.value) ?? jobId;
    const reasons: string[] = [];
    let score = 0;
    let language: Language | null = null;
    let testRunner: TestRunner | null = null;
    let hasTestCommand = false;
    const cmds = runCommands(job);
    for (const c of cmds) {
      // Ignore commands that only install a test runner (pip install pytest, npm i -D vitest).
      const lines = c.split("\n").filter((l) => !/\b(pip|pip3|uv\s+pip|npm|pnpm|yarn|bun)\s+(install|add|i)\b/.test(l) && !/^\s*#/.test(l));
      const text = lines.join("\n");
      const hit = COMMANDS.find((k) => k.re.test(text));
      if (!hit) continue;
      hasTestCommand = true;
      if (!reasons.includes(hit.label)) reasons.push(hit.label);
      score = Math.max(score, hit.score);
      language ??= hit.language;
      testRunner ??= hit.runner;
    }
    const label2 = `${jobId} ${name}`;
    if (TEST_NAME.test(label2)) { score += 2; reasons.push("named like a test job"); }
    if (NOT_TEST_NAME.test(label2) && !TEST_NAME.test(label2)) { score -= 3; reasons.push("named like a lint, build or release job"); }
    const isTestJob = hasTestCommand ? score >= 3 : TEST_NAME.test(label2) && cmds.length > 0 && score >= 2;
    jobs.push({ file: file.path, jobId, name, score: isTestJob ? score : 0, reasons, isTestJob, language, testRunner, runsOn: runsOnVerdict(job, label) });
  }
  return { path: file.path, jobs };
}

export type Choice =
  | { kind: "change"; job: JobAnalysis; others: JobAnalysis[] }
  | { kind: "already_fenvix"; job: JobAnalysis }
  | { kind: "no_test_job"; seen: JobAnalysis[] }
  | { kind: "unsupported"; job: JobAnalysis };

/**
 * The test job: the highest score across all files; on a tie, the file that looks like CI or tests, then file order,
 * then job order. Exactly one job is changed: a repository with several test jobs gets the strongest one, and the pull
 * request lists the others.
 */
export function chooseTestJob(files: FileAnalysis[]): Choice {
  const all = files.flatMap((f) => f.jobs);
  const tests = all.filter((j) => j.isTestJob);
  if (!tests.length) return { kind: "no_test_job", seen: all };
  if (tests.some((j) => !j.runsOn.ok && j.runsOn.kind === "already_fenvix")) {
    return { kind: "already_fenvix", job: tests.find((j) => !j.runsOn.ok && j.runsOn.kind === "already_fenvix")! };
  }
  const fileBonus = (p: string) => (/(^|\/)(ci|test|tests|pytest|python|node|unit)[^/]*\.ya?ml$/i.test(p) ? 1 : 0);
  const ranked = [...tests].sort((a, b) => (b.score + fileBonus(b.file)) - (a.score + fileBonus(a.file)));
  const changeable = ranked.filter((j) => j.runsOn.ok);
  if (!changeable.length) return { kind: "unsupported", job: ranked[0]! };
  const job = changeable[0]!;
  return { kind: "change", job, others: tests.filter((j) => j !== job) };
}

/** Thrown when a change would touch anything but the one value. Never expected; a guard. */
export class EditError extends Error {}

/**
 * Changes `jobs.<jobId>.runs-on` to `label` in the text. Only the value's characters change: a block list of labels
 * (on the lines below `runs-on:`) becomes the single label on the `runs-on:` line; a trailing comment on the line is kept.
 */
export function setRunsOn(text: string, jobId: string, label: string): string {
  const doc = parseDocument(text, { uniqueKeys: false });
  if (doc.errors.length || !isMap(doc.contents)) throw new EditError("the workflow is not valid YAML");
  const jobs = pairOf(doc.contents, "jobs")?.value;
  if (!isMap(jobs)) throw new EditError("the workflow has no jobs");
  const job = jobs.items.find((p) => scalarText(p.key) === jobId)?.value;
  if (!isMap(job)) throw new EditError(`no job ${jobId}`);
  const pair = pairOf(job, "runs-on");
  if (!pair?.value?.range || !pair.key.range) throw new EditError(`job ${jobId} has no runs-on`);
  const [vStart, vEnd] = pair.value.range;
  let out: string;
  const block = (isSeq(pair.value) || isMap(pair.value)) && !(pair.value as { flow?: boolean }).flow;
  if (block) {
    const colon = text.indexOf(":", pair.key.range[1]);
    if (colon < 0 || colon > vStart) throw new EditError("cannot find the colon after runs-on");
    let end = vEnd;
    while (end > vStart && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
    out = text.slice(0, colon + 1) + " " + label + text.slice(end);
  } else {
    out = text.slice(0, vStart) + label + text.slice(vEnd);
  }
  // Proof: parsed again, the workflow is the same except this one value.
  const before = parseDocument(text, { uniqueKeys: false }).toJS() as Record<string, unknown>;
  const after = parseDocument(out, { uniqueKeys: false });
  if (after.errors.length) throw new EditError("the changed workflow does not parse");
  const afterJs = after.toJS() as { jobs: Record<string, Record<string, unknown>> };
  if (afterJs.jobs[jobId]?.["runs-on"] !== label) throw new EditError("runs-on did not change");
  (before as { jobs: Record<string, Record<string, unknown>> }).jobs[jobId]!["runs-on"] = label;
  if (JSON.stringify(before) !== JSON.stringify(afterJs)) throw new EditError("the change touched more than runs-on");
  return out;
}

/**
 * A unified diff of one file (git style, three lines of context). The change is one contiguous region, so the
 * common prefix and suffix of lines delimit it exactly.
 */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const start = Math.max(0, pre - context);
  const aEnd = Math.min(a.length, a.length - suf + context);
  const bEnd = Math.min(b.length, b.length - suf + context);
  // A trailing newline makes split() end with "": it is not a line.
  const aLines = a.slice(start, aEnd).length - (aEnd === a.length && a[a.length - 1] === "" ? 1 : 0);
  const bLines = b.slice(start, bEnd).length - (bEnd === b.length && b[b.length - 1] === "" ? 1 : 0);
  const out = [`--- a/${path}`, `+++ b/${path}`, `@@ -${start + 1},${aLines} +${start + 1},${bLines} @@`];
  for (let i = start; i < pre; i++) out.push(" " + a[i]);
  for (let i = pre; i < a.length - suf; i++) out.push("-" + a[i]);
  for (let i = pre; i < b.length - suf; i++) out.push("+" + b[i]);
  for (let i = a.length - suf; i < aEnd; i++) if (!(i === a.length - 1 && a[i] === "")) out.push(" " + a[i]);
  return out.join("\n");
}

// ---------------------------------------------------------------- side-by-side runs: a copy of the test job

/** The one file the side-by-side pull request adds. Never read as one of the customer's workflows. */
export const SIDE_BY_SIDE_PATH = ".github/workflows/fenvix-side-by-side.yml";
export const SIDE_BY_SIDE_WORKFLOW_NAME = "fenvix side-by-side";
export const SIDE_BY_SIDE_JOB_ID = "fenvix-side-by-side";
export const SIDE_BY_SIDE_JOB_NAME = "fenvix side-by-side (does not gate)";
export const SIDE_BY_SIDE_GATE_ID = "fenvix_gate";
/** The file a skip machine writes (src/runners/launcher.ts): the gate step then sets run=false and no kept step runs. */
export const SIDE_BY_SIDE_SKIP_FILE = "/etc/fenvix/sbs-skip";
const GATE_RUN = `if [ -f ${SIDE_BY_SIDE_SKIP_FILE} ]; then echo run=false >> "$GITHUB_OUTPUT"; else echo run=true >> "$GITHUB_OUTPUT"; fi`;
const GATE_IF = `steps.${SIDE_BY_SIDE_GATE_ID}.outputs.run == 'true'`;
const FORK_GUARD = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";

export interface SideBySideFile {
  text: string;
  /** The matrix combination the job runs (JSON of its values), or null without a matrix. */
  matrix: string | null;
  /** GitHub's " (v1, v2)" suffix of the customer's job name for that combination, or null. */
  matrixSuffix: string | null;
  /** The customer's test job's name for that combination (its `name:` with matrix values put in, else the job id). */
  jobName: string;
  /** The name GitHub shows for the customer's test step: its `name:`, else "Run " + the first line of its run. */
  testStepName: string;
}

/** Where a value of the customer's file comes from, and its value. */
interface Val { js: unknown; node: unknown }

const OUTER_EXPR = /^\s*\$\{\{([\s\S]*)\}\}\s*$/;
/** An `if:` without its outer `${{ }}` (GitHub reads both forms the same). */
function bareIf(v: unknown): string {
  const s = typeof v === "string" ? v : String(v);
  const m = OUTER_EXPR.exec(s);
  return (m && !m[1]!.includes("}}") ? m[1]! : s).trim();
}

const ALLOWED_ACTIONS = new Set(["actions/checkout", "actions/setup-node", "actions/setup-python", "actions/setup-go", "pnpm/action-setup", "actions/cache", "actions/cache/restore"]);
const WRITES_TO_GITHUB = /\bgit\s+push\b|\bgh\s+(pr|issue|api|release)\b|api\.github\.com/;
const MATRIX_NAME_EXPR = /\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g;

function hasAnchors(node: unknown): boolean {
  let found = false;
  const walk = (n: unknown): void => {
    if (found || !n || typeof n !== "object") return;
    if (isAlias(n) || (n as { anchor?: string }).anchor) { found = true; return; }
    if (isMap(n) || isSeq(n)) for (const it of n.items) { if (isPair(it)) { walk(it.key); walk(it.value); } else walk(it); }
  };
  walk(node);
  return found;
}

/** The index of the step that runs the tests: the last step whose run command matches a test command (analyzeWorkflow's). */
export function testStepIndex(job: YAMLMap): number | null {
  const steps = pairOf(job, "steps")?.value;
  if (!isSeq(steps)) return null;
  let at: number | null = null;
  steps.items.forEach((s, i) => {
    if (!isMap(s)) return;
    const r = scalarText(pairOf(s, "run")?.value);
    if (!r) return;
    const text = r.split("\n").filter((l) => !/\b(pip|pip3|uv\s+pip|npm|pnpm|yarn|bun)\s+(install|add|i)\b/.test(l) && !/^\s*#/.test(l)).join("\n");
    if (COMMANDS.some((k) => k.re.test(text))) at = i;
  });
  return at;
}

/**
 * The first matrix combination GitHub runs: the cartesian product of the matrix's keys in their order (the last key
 * varies fastest), without the combinations `exclude` matches, extended by every `include` entry that can be added to it
 * without changing an original value; an `include` entry that fits no combination is a combination of its own, after them.
 */
export function firstCombination(matrix: YAMLMap): { keys: string[]; values: Map<string, Val> } | { refused: string } {
  const base: [string, Val[]][] = [];
  let include: Val[] = [];
  let exclude: Record<string, unknown>[] = [];
  for (const p of matrix.items) {
    const k = scalarText(p.key);
    if (!k) return { refused: "the matrix has a key that is not text" };
    const v = p.value;
    if (isScalar(v) && typeof v.value === "string" && v.value.includes("${{")) return { refused: `the matrix's ${k} is an expression` };
    if (k === "include" || k === "exclude") {
      if (!isSeq(v)) return { refused: `the matrix's ${k} is not a list` };
      const entries = v.items.map((e) => ({ js: isMap(e) ? (e.toJSON() as unknown) : null, node: e }));
      if (entries.some((e) => !e.js || typeof e.js !== "object")) return { refused: `the matrix's ${k} has an entry that is not a mapping` };
      if (k === "include") include = entries; else exclude = entries.map((e) => e.js as Record<string, unknown>);
      continue;
    }
    if (!isSeq(v)) return { refused: `the matrix's ${k} is not a list` };
    if (v.items.some((x) => isScalar(x) && typeof x.value === "string" && x.value.includes("${{"))) return { refused: `the matrix's ${k} holds an expression` };
    base.push([k, v.items.map((x) => ({ js: isScalar(x) ? x.value : (x as { toJSON(): unknown }).toJSON(), node: x }))]);
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  let combos: Map<string, Val>[] = base.length && base.every(([, vs]) => vs.length) ? [new Map()] : [];
  for (const [k, vs] of base) combos = combos.flatMap((c) => vs.map((v) => new Map([...c, [k, v]])));
  combos = combos.filter((c) => !exclude.some((x) => Object.entries(x).every(([k, v]) => c.has(k) && same(c.get(k)!.js, v))));
  const original = new Set(base.map(([k]) => k));
  const extra: Map<string, Val>[] = [];
  for (const inc of include) {
    const map = inc.node as YAMLMap;
    const entries: [string, Val][] = map.items.map((p) => [scalarText(p.key) ?? "", { js: isScalar(p.value) ? p.value.value : (p.value as { toJSON(): unknown } | null)?.toJSON?.() ?? null, node: p.value }]);
    let fitted = false;
    for (const c of combos) {
      if (entries.every(([k, v]) => !original.has(k) || !c.has(k) || same(c.get(k)!.js, v.js))) {
        for (const [k, v] of entries) if (!original.has(k) || !c.has(k)) c.set(k, v);
        fitted = true;
      }
    }
    if (!fitted) extra.push(new Map(entries));
  }
  const first = [...combos, ...extra][0];
  if (!first) return { refused: "the matrix has no combination" };
  return { keys: [...first.keys()], values: first };
}

/**
 * The whole side-by-side workflow file, built from the customer's workflow `sourceText` and its test job `jobId`: a
 * workflow of its own (his workflow is never changed and never waits for it), with the same push / pull_request /
 * workflow_dispatch triggers, one job on `label` that never gates (continue-on-error everywhere), his steps up to and
 * including his test step behind a gate step, no step that saves into his Actions cache, no write to GitHub, and no
 * fork pull request. Refused (with why) when the copy could not run like his job or could write anything.
 */
export function buildSideBySideWorkflow(sourceText: string, jobId: string, label: string): SideBySideFile | { refused: string } {
  const doc = parseDocument(sourceText, { uniqueKeys: false });
  if (doc.errors.length || !isMap(doc.contents)) return { refused: "the workflow is not valid YAML" };
  const root = doc.contents;
  const jobs = pairOf(root, "jobs")?.value;
  if (!isMap(jobs)) return { refused: "the workflow has no jobs" };
  const job = jobs.items.find((p) => scalarText(p.key) === jobId)?.value;
  if (!isMap(job)) return { refused: `no job ${jobId}` };
  const refuse = (why: string) => ({ refused: `${jobId}: ${why}` });
  if (hasAnchors(job)) return refuse("the job uses YAML anchors or aliases");
  for (const k of ["on", "env", "defaults"]) if (hasAnchors(pairOf(root, k)?.value)) return refuse(`the workflow's ${k} uses YAML anchors or aliases`);
  if (pairOf(job, "uses")) return refuse("the job calls a reusable workflow");
  if (pairOf(job, "container")) return refuse("the job runs in a container (container:)");
  if (pairOf(job, "environment")) return refuse("the job uses a deployment environment (environment:)");
  const runsOn = pairOf(job, "runs-on")?.value;
  const runsOnValues = isSeq(runsOn) ? runsOn.items.map(scalarText) : [scalarText(runsOn)];
  const strategy = pairOf(job, "strategy")?.value;
  if (strategy !== undefined && !isMap(strategy)) return refuse("the job's strategy is an expression");
  const matrixNode = isMap(strategy) ? pairOf(strategy, "matrix")?.value : undefined;
  if (matrixNode !== undefined && !isMap(matrixNode)) return refuse("the matrix is given by an expression");
  for (const v of runsOnValues) {
    const m = v ? /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(v) : null;
    const all = m && isMap(matrixNode) ? matrixValues(job, m[1]!) ?? [] : [v ?? ""];
    if (all.some((x) => NON_LINUX.test(x))) return refuse(`it runs on ${all.filter((x) => NON_LINUX.test(x)).join(", ")}; fenvix machines are Linux`);
  }
  for (const d of [pairOf(root, "defaults")?.value, pairOf(job, "defaults")?.value]) {
    const run = isMap(d) ? pairOf(d, "run")?.value : undefined;
    const shell = isMap(run) ? scalarText(pairOf(run, "shell")?.value) : null;
    if (shell && !["bash", "sh"].includes(shell.trim())) return refuse(`defaults.run.shell is ${shell}; only bash or sh run the same way`);
  }

  // The triggers: push, pull_request (their filters as written) and workflow_dispatch (its inputs), in his order.
  const onPair = pairOf(root, "on") ?? (root.items.find((p) => isScalar(p.key) && p.key.value === true) as Pair<Node, Node> | undefined);
  const onNode = onPair?.value;
  const events: [string, unknown][] = [];
  if (isScalar(onNode)) events.push([String(onNode.value), null]);
  else if (isSeq(onNode)) for (const e of onNode.items) events.push([scalarText(e) ?? "", null]);
  else if (isMap(onNode)) for (const p of onNode.items) events.push([scalarText(p.key) ?? "", p.value]);
  else return refuse("the workflow has no on:");
  const KEEP: Record<string, string[]> = {
    push: ["branches", "branches-ignore", "tags", "tags-ignore", "paths", "paths-ignore"],
    pull_request: ["branches", "branches-ignore", "paths", "paths-ignore", "types"],
    workflow_dispatch: ["inputs"],
  };
  const on = new YAMLMap();
  for (const [name, v] of events) {
    const keep = KEEP[name];
    if (!keep) continue;
    if (v !== null && v !== undefined && !(isScalar(v) && v.value === null) && !isMap(v)) return refuse(`on.${name} has a shape fenvix does not know`);
    const filters = new YAMLMap();
    if (isMap(v)) for (const p of v.items) if (keep.includes(scalarText(p.key) ?? "")) filters.items.push(new Pair(new Scalar(scalarText(p.key)), (p.value as Node).clone()));
    on.items.push(new Pair(new Scalar(name), filters.items.length ? filters : new Scalar(null)));
  }
  if (!on.items.length) {
    const names = events.map(([n]) => n);
    return refuse(names.length === 1 && names[0] === "pull_request_target" ? "the workflow runs only on pull_request_target" : `the workflow runs on none of push, pull_request, workflow_dispatch (${names.join(", ")})`);
  }

  // The matrix: the first combination GitHub runs.
  let combination: { keys: string[]; values: Map<string, Val> } | null = null;
  if (isMap(matrixNode)) {
    const c = firstCombination(matrixNode);
    if ("refused" in c) return refuse(c.refused);
    combination = c;
  }

  // His job's name for that combination, and the suffix GitHub adds when the name does not use the matrix.
  const nameNode = pairOf(job, "name")?.value;
  const rawName = nameNode === undefined ? null : scalarText(nameNode);
  if (nameNode !== undefined && rawName === null) return refuse("the job's name is not text");
  if (rawName && rawName.replace(MATRIX_NAME_EXPR, "").includes("${{")) return refuse("the job's name has expressions other than ${{ matrix.<key> }}");
  const shown = (v: Val | undefined) => (v === undefined ? "" : typeof v.js === "object" && v.js !== null ? JSON.stringify(v.js) : String(v.js));
  const usesMatrix = !!rawName && MATRIX_NAME_EXPR.test(rawName);
  MATRIX_NAME_EXPR.lastIndex = 0;
  const jobName = rawName ? rawName.replace(MATRIX_NAME_EXPR, (_, k: string) => shown(combination?.values.get(k))) : jobId;
  const matrixSuffix = combination && !usesMatrix && combination.keys.length ? ` (${combination.keys.map((k) => shown(combination!.values.get(k))).join(", ")})` : null;

  // The steps: his, up to and including his test step.
  const stepsNode = pairOf(job, "steps")?.value;
  if (!isSeq(stepsNode)) return refuse("the job has no steps");
  const testAt = testStepIndex(job);
  if (testAt === null) return refuse("no step runs the tests");
  const kept: YAMLMap[] = [];
  let testStepName = "";
  for (let i = 0; i <= testAt; i++) {
    const s = stepsNode.items[i];
    if (!isMap(s)) return refuse(`step ${i + 1} is not a mapping`);
    const step = s.clone() as YAMLMap;
    const label2 = scalarText(pairOf(step, "name")?.value) ?? scalarText(pairOf(step, "uses")?.value) ?? `step ${i + 1}`;
    if (scalarText(pairOf(step, "id")?.value) === SIDE_BY_SIDE_GATE_ID) return refuse(`step "${label2}" has the id ${SIDE_BY_SIDE_GATE_ID}`);
    const uses = scalarText(pairOf(step, "uses")?.value);
    const run = scalarText(pairOf(step, "run")?.value);
    const withNode = pairOf(step, "with")?.value;
    if (withNode !== undefined && !isMap(withNode)) return refuse(`step "${label2}" has a with: that is not a mapping`);
    if (uses) {
      if (uses.startsWith("./") || uses.startsWith("docker://")) return refuse(`step "${label2}" uses ${uses}, which fenvix does not run side by side`);
      const at = uses.lastIndexOf("@");
      const action = at > 0 ? uses.slice(0, at) : uses;
      const ref = at > 0 ? uses.slice(at + 1) : "";
      if (!ALLOWED_ACTIONS.has(action)) return refuse(`step "${label2}" uses ${uses}, which fenvix does not run side by side (allowed: checkout, setup-node, setup-python, setup-go, pnpm/action-setup, cache)`);
      if (isMap(withNode) && action !== "actions/checkout" && pairOf(withNode, "token")) return refuse(`step "${label2}" passes a token: to ${action}`);
      const w = isMap(withNode) ? withNode : new YAMLMap();
      const del = (k: string) => { w.items = w.items.filter((p) => scalarText(p.key) !== k); };
      const put = (k: string, v: unknown) => { del(k); w.items.push(new Pair(new Scalar(k), new Scalar(v))); };
      if (action === "actions/cache") {
        const major = /^v(\d+)(\.|$)/.exec(ref);
        if (!major) return refuse(`step "${label2}" uses ${uses}: fenvix needs a vN version of actions/cache to use its restore-only action`);
        if (Number(major[1]) < 3) return refuse(`step "${label2}" uses ${uses}: actions/cache below v3 has no restore-only action`);
        (pairOf(step, "uses")!.value as Scalar).value = `actions/cache/restore@${ref}`;
      }
      if (action === "actions/setup-node") { del("cache"); del("cache-dependency-path"); put("package-manager-cache", false); }
      if (action === "actions/setup-python") { del("cache"); del("cache-dependency-path"); }
      if (action === "actions/setup-go") put("cache", false);
      if (w.items.length && !isMap(withNode)) step.items.push(new Pair(new Scalar("with"), w));
    } else if (run) {
      if (WRITES_TO_GITHUB.test(run)) return refuse(`step "${label2}" may write to GitHub (git push, gh pr/issue/api/release or api.github.com)`);
    } else return refuse(`step "${label2}" has neither uses nor run`);
    const hisIf = pairOf(step, "if")?.value;
    const stepIf = hisIf === undefined ? null : bareIf(scalarText(hisIf) ?? (isScalar(hisIf) ? hisIf.value : ""));
    // Text mixed with ${{ }} is a string to GitHub (always true): the gate would vanish.
    if (stepIf?.includes("${{")) return refuse(`step "${label2}" has an if: that mixes text and \${{ }} expressions`);
    const cond = stepIf === null ? GATE_IF : `(${stepIf}) && ${GATE_IF}`;
    step.items = step.items.filter((p) => !["if", "continue-on-error"].includes(scalarText(p.key) ?? ""));
    step.items.push(new Pair(new Scalar("continue-on-error"), new Scalar(true)), new Pair(new Scalar("if"), new Scalar(cond)));
    if (i === testAt) testStepName = scalarText(pairOf(s, "name")?.value) ?? `Run ${(run ?? "").split("\n")[0]!.trim()}`;
    kept.push(step);
  }

  const jobIf = pairOf(job, "if")?.value;
  const jobIfText = jobIf === undefined ? null : bareIf(scalarText(jobIf) ?? (isScalar(jobIf) ? jobIf.value : ""));
  if (jobIfText?.includes("${{")) return refuse("the job's if: mixes text and ${{ }} expressions");
  const jobCond = jobIfText === null ? FORK_GUARD : `(${jobIfText}) && (${FORK_GUARD})`;
  const needsRef = (n: unknown) => !!n && JSON.stringify((n as { toJSON?: () => unknown }).toJSON?.() ?? n).includes("needs.");
  if ((jobIf !== undefined && needsRef(jobIf)) || needsRef(pairOf(job, "env")?.value) || kept.some(needsRef)) return refuse("a kept step or condition refers to needs., the output of another job");

  // The new file.
  const out = new Document(new YAMLMap());
  const top = out.contents as YAMLMap;
  const add = (m: YAMLMap, k: string, v: unknown) => m.items.push(new Pair(new Scalar(k), v instanceof Object && "clone" in (v as object) ? v : out.createNode(v)));
  add(top, "name", SIDE_BY_SIDE_WORKFLOW_NAME);
  add(top, "on", on);
  add(top, "permissions", { contents: "read" });
  for (const k of ["env", "defaults"]) { const v = pairOf(root, k)?.value; if (v !== undefined) add(top, k, (v as Node).clone()); }
  add(top, "concurrency", { group: "fenvix-side-by-side-${{ github.ref }}", "cancel-in-progress": true });
  const ourJob = new YAMLMap();
  add(ourJob, "name", SIDE_BY_SIDE_JOB_NAME);
  add(ourJob, "runs-on", label);
  add(ourJob, "continue-on-error", true);
  const timeout = pairOf(job, "timeout-minutes")?.value;
  add(ourJob, "timeout-minutes", timeout !== undefined ? (timeout as Node).clone() : 60);
  add(ourJob, "if", jobCond);
  for (const k of ["env", "defaults", "services"]) { const v = pairOf(job, k)?.value; if (v !== undefined) add(ourJob, k, (v as Node).clone()); }
  if (combination) {
    const one = new YAMLMap();
    for (const k of combination.keys) one.items.push(new Pair(new Scalar(k), (combination.values.get(k)!.node as Node).clone()));
    const inc = new YAMLSeq(); inc.items.push(one);
    const matrix = new YAMLMap(); matrix.items.push(new Pair(new Scalar("include"), inc));
    const strat = new YAMLMap(); strat.items.push(new Pair(new Scalar("matrix"), matrix));
    add(ourJob, "strategy", strat);
  }
  const steps = new YAMLSeq();
  steps.items.push(out.createNode({ id: SIDE_BY_SIDE_GATE_ID, shell: "bash", "working-directory": "/tmp", "continue-on-error": true, run: GATE_RUN }) as YAMLMap, ...kept);
  add(ourJob, "steps", steps);
  const jobsOut = new YAMLMap(); jobsOut.items.push(new Pair(new Scalar(SIDE_BY_SIDE_JOB_ID), ourJob));
  add(top, "jobs", jobsOut);
  out.commentBefore = [
    " fenvix side-by-side: runs a copy of your test job on fenvix, next to your own workflow, which stays as it is and",
    " decides green or red alone. This workflow never gates: every step continues on error, nothing is pushed, nothing",
    ` is saved to your Actions cache. Built from ${jobId}. To stop it, delete this file.`,
  ].join("\n");
  const text = out.toString({ lineWidth: 0, nullStr: "" });

  // Proof: parsed again, the file is exactly the intended structure.
  const back = parseDocument(text, { uniqueKeys: false });
  if (back.errors.length) throw new EditError("the side-by-side workflow does not parse");
  if (JSON.stringify(back.toJS()) !== JSON.stringify(out.toJS())) throw new EditError("the side-by-side workflow does not read back as built");
  const matrix = combination ? JSON.stringify(Object.fromEntries(combination.keys.map((k) => [k, combination!.values.get(k)!.js]))) : null;
  return { text, matrix, matrixSuffix, jobName, testStepName };
}
