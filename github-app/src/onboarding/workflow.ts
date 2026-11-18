import { isMap, isPair, isScalar, isSeq, parseDocument, type Node, type Pair, type YAMLMap } from "yaml";

/**
 * Reads GitHub Actions workflow files, finds the job that runs the tests, and changes only that job's `runs-on:`.
 *
 * The YAML is parsed to find the exact source range of the job's `runs-on` value; the change is then made on the
 * original text, character by character, so everything else (comments, quoting, blank lines, key order, anchors) is
 * byte-for-byte the same. The result is parsed again to prove that only that value changed.
 */

export type Language = "python" | "node" | "go";
export type TestRunner = "pytest" | "vitest" | "jest" | "go test";

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
