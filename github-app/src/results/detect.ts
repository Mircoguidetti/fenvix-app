/**
 * Which language and test runner a repository's project gets (ci_projects.language, test_runner), detected, never
 * assumed: a Node repository is never labelled pytest.
 *
 *   1. the onboarding analysis of the repository's workflow (gh_repositories.detected_language / detected_test_runner);
 *   2. else the run summary: its `language` / `test_runner` fields, else the runtime it ran in (a `detpy==` distribution:
 *      python and pytest; `detjs`: node, with vitest or jest from the summary's runner or config fields when present);
 *   3. else no project yet.
 */
export type Language = "python" | "node" | "go";
/** Every runner a project can have (G-0616, G-1750); which ones the engine runs is engineRuns (src/onboarding/onboard.ts). */
export type TestRunner = "pytest" | "unittest" | "django" | "nose2" | "ward" | "vitest" | "jest" | "mocha" | "node:test" | "ava" | "tap" | "bun" | "playwright" | "cypress" | "go test";
export interface Stack { language: Language; testRunner: TestRunner | null }

const LANGUAGES: readonly string[] = ["python", "node", "go"];
export const LANGUAGE_OF: Record<TestRunner, Language> = {
  pytest: "python", unittest: "python", django: "python", nose2: "python", ward: "python",
  vitest: "node", jest: "node", mocha: "node", "node:test": "node", ava: "node", tap: "node", bun: "node", playwright: "node", cypress: "node",
  "go test": "go",
};
export const RUNNERS: readonly string[] = Object.keys(LANGUAGE_OF);

const lang = (v: unknown): Language | null => (typeof v === "string" && LANGUAGES.includes(v) ? (v as Language) : null);
const runner = (v: unknown): TestRunner | null => (typeof v === "string" && RUNNERS.includes(v) ? (v as TestRunner) : null);

/** "vitest", "vitest 2.1.4", "jest@29.7.0", "detjs vitest run": the Node test runner named in a free-form field. */
function nodeRunnerIn(v: unknown): TestRunner | null {
  if (typeof v !== "string") return null;
  if (/\bvitest\b/i.test(v)) return "vitest";
  if (/\bjest\b/i.test(v)) return "jest";
  if (/\bplaywright\b/i.test(v)) return "playwright";
  if (/\bcypress\b/i.test(v)) return "cypress";
  if (/\bmocha\b/i.test(v)) return "mocha";
  if (/\bnode\s+--test\b|\bnode:test\b/i.test(v)) return "node:test";
  if (/\bava\b/i.test(v)) return "ava";
  if (/\btap\b/i.test(v)) return "tap";
  if (/\bbun\s+test\b/i.test(v)) return "bun";
  return null;
}

/** The engine distributions of the runtime (`runtime.dist_list`, e.g. `detpy==0.1.0:<digest>`, `detjs@0.1.0`). */
function engines(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  const rt = raw.runtime as Record<string, unknown> | undefined;
  if (rt && typeof rt === "object" && Array.isArray(rt.dist_list)) for (const d of rt.dist_list) if (typeof d === "string") out.push(d);
  for (const k of ["engine", "engine_name"]) {
    if (typeof raw[k] === "string") out.push(raw[k] as string);
    if (rt && typeof rt === "object" && typeof rt[k] === "string") out.push(rt[k] as string);
  }
  return out;
}

/** What the run summary says about the language and the test runner (null: nothing). */
export function stackFromSummary(raw: Record<string, unknown> | null | undefined): Stack | null {
  if (!raw || typeof raw !== "object") return null;
  const r = runner(raw.test_runner);
  const l = lang(raw.language) ?? (r ? LANGUAGE_OF[r] : null);
  if (l) return { language: l, testRunner: r && LANGUAGE_OF[r] === l ? r : null };
  const eng = engines(raw);
  if (eng.some((d) => /^detpy(==|@|\s|$)/.test(d))) return { language: "python", testRunner: "pytest" };
  if (eng.some((d) => /^detjs(==|@|\s|$)/.test(d))) {
    const cfg = raw.config as Record<string, unknown> | undefined;
    const rt = raw.runtime as Record<string, unknown> | undefined;
    const named = [raw.runner, cfg && typeof cfg === "object" ? cfg.runner : undefined, rt && typeof rt === "object" ? rt.runner : undefined, raw.command]
      .map(nodeRunnerIn).find((x) => x) ?? null;
    return { language: "node", testRunner: named };
  }
  return null;
}

/**
 * The project's language and test runner: the onboarding analysis first, else the run; the run's test runner only
 * for the same language. A language without a known runner gets its only runner (python: pytest, go: go test); Node
 * has two, so it waits until one is known. Null: no project yet.
 */
export function projectStack(detected: { language: string | null; testRunner: string | null }, fromRun: Stack | null): { language: Language; testRunner: TestRunner } | null {
  const language = lang(detected.language) ?? fromRun?.language ?? null;
  if (!language) return null;
  const detectedRunner = runner(detected.testRunner);
  const testRunner = (detectedRunner && LANGUAGE_OF[detectedRunner] === language ? detectedRunner : null)
    ?? (fromRun && fromRun.language === language ? fromRun.testRunner : null)
    ?? (language === "python" ? "pytest" : language === "go" ? "go test" : null);
  return testRunner ? { language, testRunner } : null;
}
