/*
 * Sample data for VITE_DATA_BACKEND=mock. Every name is made up; the shapes come from what fenvix measured
 * (fenvix-engine-cli, harness/skip_study2/REPORT.md and the Block 2 defect bundles, read 2026-11-17):
 *
 *   project (stands for)              tests   share of test time skipped with proof   time to green before
 *   northwind/homehub (home-assistant) 11,889  median 97%, mean 82%                    417 s
 *   northwind/docs-site (docusaurus)    3,199  median 98%, mean 81%                     30 s
 *   northwind/ledger (prometheus, terraform: Go) 28,526  25% to 56%                    135 s
 *   northwind/storefront (saleor: Django) 1,721  median 0%, mean 9%                    289 s
 *
 * Run durations add the measured capture overhead (x2.13 home-assistant, x1.55 Vitest, x2.8 saleor; Go none).
 * Defects follow real bundles: 2-test minimal orders with a named polluter, seeds the engine used, 32-hex fingerprints.
 * The screens say "Sample data" whenever this client is in use.
 *
 * Three organizations: Northwind Cloud (the signed-in owner's: the Team plan and the Nightly exploration add-on, three
 * GitHub App installations, repositories in all nine onboarding states, a run that is running and advances while the
 * Run page polls it), Harbor Analytics (a member there: in its 30-day shadow trial, every run in shadow mode; set
 * sessionStorage "fenvix-mock-trial" to "below" for a trial under the 35% gate) and any organization made in the tab
 * (empty: nothing connected yet).
 */
import { assertMockCanManage, mockOrgName } from "./orgs-mock";
import { activeOrgId } from "../lib/org";
import { blobUrl } from "../lib/download";
import { ApiError } from "./api-errors";
import type { DataClient, RunLive, RunQuery } from "./client";
import type {
  ActivityItem, AuditRerun, Exploration, Installation, MissKind, RunDetail, RunFile, RunProgress,
  Baseline, Defect, DefectCause, GitHubRate, GitHubRepository, Language, OnboardingState, Page, Plan, Project, Region, Run, RunTrigger, Settings, WarmCache,
  RunProof, SearchResult, SkipReceipt, TestOutcome, TestPage, TestResult, TestRunner,
} from "./types";
import { activityFrom, auditFrom, billingFrom, dayStart, familiesOf, familyKeyOf, finished, median, monthOf, overviewFrom, projectRow, searchFrom, setupChange, trialFrom, usageCsv, usageCsvName, usageFrom, type TrialDates, type UsageEvent } from "./ci";

export const NOW = new Date("2026-11-17T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HISTORY_DAYS = 60;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

/** Small deterministic pseudo-random generator so the screens are stable. */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic lowercase hex of any length, like a digest of `text`. */
function hex(text: string, length = 32): string {
  let out = "";
  let h = hash(text);
  while (out.length < length) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    out += h.toString(16).padStart(8, "0");
    h = (h + hash(out)) >>> 0;
  }
  return out.slice(0, length);
}

// ---------------------------------------------------------------- projects and their test suites

interface Module {
  file: string;
  tests: string[];
  /** Sum of the tests' durations. */
  timeMs: number;
  durations: number[];
}

interface Spec {
  id: string;
  fullName: string;
  language: Language;
  testRunner: TestRunner;
  testCount: number;
  moduleCount: number;
  /** Sum of every test's duration: the time of a full run without fenvix. */
  fullTestMs: number;
  overhead: number;
  setupMs: number;
  /**
   * The job's other steps (checkout, dependency install, build) on a GitHub-hosted runner: the measured median job
   * minus the full test time. fenvix still runs them, so they are never counted as saved.
   */
  otherStepMs: number;
  runsPerWeekday: number;
  /** Skip share of one run: a mixture that matches the measured median and mean. */
  skip: (r: () => number) => number;
  failRate: number;
  baseline: Baseline;
  connectedDaysAgo: number;
  firstRunNumber: number;
  modulePath: (i: number, r: () => number) => string;
  testName: (file: string, j: number, r: () => number) => string;
  env: string[];
  interpreter: string;
  runner: string;
}

const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
const HA = ["mqtt", "zwave_js", "hue", "sonos", "recorder", "automation", "esphome", "shelly", "template", "sensor", "climate", "light", "matter", "zha", "homekit", "unifi", "cast", "google_assistant", "alexa", "tibber", "netatmo", "tado", "fritz", "bluetooth", "http", "websocket_api", "history", "logbook", "energy", "scene"];
const HA_TESTS = ["test_setup_entry", "test_unload_entry", "test_state_update", "test_discovery", "test_config_flow_user", "test_options_flow", "test_reauth", "test_availability", "test_attributes", "test_service_call", "test_reconnect", "test_device_info"];
const DOCS = ["docusaurus", "docusaurus-utils", "docusaurus-mdx-loader", "docusaurus-plugin-content-docs", "docusaurus-plugin-content-blog", "docusaurus-theme-common", "docusaurus-theme-classic", "docusaurus-logger", "docusaurus-types", "create-docusaurus", "docusaurus-plugin-sitemap", "docusaurus-remark-plugin-npm2yarn"];
const DOCS_TESTS = ["handles empty input", "resolves relative links", "keeps front matter", "sorts sidebar items", "localizes paths", "escapes html", "reads versions", "generates ids", "merges config", "validates options"];
const GO = ["promql", "storage/remote", "tsdb", "tsdb/chunkenc", "tsdb/wlog", "scrape", "rules", "notifier", "discovery/kubernetes", "discovery/file", "model/labels", "model/relabel", "web/api/v1", "util/strutil", "config", "cmd/ledger"];
const GO_TESTS = ["TestAppend", "TestQuery", "TestCompaction", "TestReload", "TestEncode", "TestDecode", "TestRelabel", "TestParse", "TestValidate", "TestRoundTrip", "TestConcurrentWrites", "TestTimeout"];
const DJ = ["checkout", "order", "payment", "discount", "product", "account", "shipping", "warehouse", "giftcard", "webhook", "graphql/checkout", "graphql/order", "plugins/stripe", "tax"];
const DJ_TESTS = ["test_create", "test_update", "test_delete", "test_total", "test_permissions", "test_mutation", "test_query", "test_validation", "test_with_voucher", "test_webhook_sent", "test_complete"];

/** Mixture: most runs near the median, a share invalidated (a dependency bump, a conftest change). */
const mixture = (high: number, spread: number, lowShare: number, lowMax: number) => (r: () => number) =>
  r() < lowShare ? r() * lowMax : Math.min(0.995, Math.max(0, high + (r() - 0.5) * spread));

const SPECS: Spec[] = [
  {
    id: "prj_homehub", fullName: "northwind/homehub", language: "python", testRunner: "pytest", testCount: 11889, moduleCount: 776,
    fullTestMs: 410_000, overhead: 2.13, setupMs: 9_000, otherStepMs: 118_000, runsPerWeekday: 24, skip: mixture(0.975, 0.03, 0.18, 0.55), failRate: 0.05,
    baseline: { medianTimeToGreenS: 417, medianJobMinutes: 8.8, runsSampled: 400, from: "2026-08-01", to: "2026-08-31" }, connectedDaysAgo: 80, firstRunNumber: 3104,
    modulePath: (i, r) => `tests/components/${HA[i % HA.length]}/test_${pick(r, ["init", "config_flow", "sensor", "light", "switch", "binary_sensor", "climate", "diagnostics", "services", "coordinator"])}_${i}.py`,
    testName: (file, j, r) => `${file}::${pick(r, HA_TESTS)}_${j}`,
    env: ["TZ", "HOME", "HOMEHUB_TEST_DB_URL", "PYTHONASYNCIODEBUG"], interpreter: "python 3.12.7", runner: "pytest 8.3.3",
  },
  {
    id: "prj_docs", fullName: "northwind/docs-site", language: "node", testRunner: "vitest", testCount: 3199, moduleCount: 202,
    fullTestMs: 29_500, overhead: 1.55, setupMs: 4_000, otherStepMs: 61_000, runsPerWeekday: 13, skip: mixture(0.985, 0.02, 0.2, 0.5), failRate: 0.03,
    baseline: { medianTimeToGreenS: 30, medianJobMinutes: 1.5, runsSampled: 260, from: "2026-08-01", to: "2026-08-31" }, connectedDaysAgo: 70, firstRunNumber: 1408,
    modulePath: (i, r) => `packages/${DOCS[i % DOCS.length]}/src/__tests__/${pick(r, ["utils", "index", "config", "routes", "sidebars", "versions", "markdown", "i18n", "slug", "toc"])}${i}.test.ts`,
    testName: (file, j, r) => `${file} > ${pick(r, ["parse", "load", "render", "resolve", "normalize"])} > ${pick(r, DOCS_TESTS)} ${j}`,
    env: ["NODE_ENV", "CI", "DOCUSAURUS_SITE_URL"], interpreter: "node 22.11.0", runner: "vitest 2.1.4",
  },
  {
    id: "prj_ledger", fullName: "northwind/ledger", language: "go", testRunner: "go test", testCount: 28526, moduleCount: 90,
    fullTestMs: 132_000, overhead: 1.0, setupMs: 8_000, otherStepMs: 204_000, runsPerWeekday: 9, skip: (r) => (r() < 0.15 ? r() * 0.15 : 0.25 + r() * 0.31), failRate: 0.04,
    baseline: { medianTimeToGreenS: 135, medianJobMinutes: 5.6, runsSampled: 180, from: "2026-08-01", to: "2026-08-31" }, connectedDaysAgo: 64, firstRunNumber: 922,
    modulePath: (i) => `${GO[i % GO.length]}${i >= GO.length ? `/part${Math.floor(i / GO.length)}` : ""}`,
    testName: (file, j, r) => `${file}.${pick(r, GO_TESTS)}/case_${j}`,
    env: ["GOFLAGS", "TZ"], interpreter: "go 1.23.3", runner: "go test",
  },
  {
    id: "prj_storefront", fullName: "northwind/storefront", language: "python", testRunner: "pytest", testCount: 1721, moduleCount: 112,
    fullTestMs: 285_000, overhead: 2.8, setupMs: 14_000, otherStepMs: 87_000, runsPerWeekday: 7, skip: (r) => (r() < 0.86 ? 0 : 0.35 + r() * 0.4), failRate: 0.08,
    baseline: { medianTimeToGreenS: 289, medianJobMinutes: 6.2, runsSampled: 150, from: "2026-08-01", to: "2026-08-31" }, connectedDaysAgo: 45, firstRunNumber: 5120,
    modulePath: (i, r) => `storefront/${DJ[i % DJ.length]}/tests/test_${pick(r, ["models", "views", "mutations", "queries", "utils", "tasks", "signals"])}_${i}.py`,
    testName: (file, j, r) => `${file}::${pick(r, DJ_TESTS)}_${j}`,
    env: ["DATABASE_URL", "DJANGO_SETTINGS_MODULE", "SECRET_KEY", "TZ"], interpreter: "python 3.12.7", runner: "pytest 8.3.3",
  },
];

const suites = new Map<string, Module[]>();

/** The project's test files and tests, built once. The test count and total time match the spec exactly. */
function suite(spec: Spec): Module[] {
  const cached = suites.get(spec.id);
  if (cached) return cached;
  const r = rng(hash(spec.id));
  const weights = Array.from({ length: spec.moduleCount }, () => 0.2 + r() ** 3 * 4);
  const wsum = weights.reduce((a, b) => a + b, 0);
  let left = spec.testCount;
  const counts = weights.map((w, i) => {
    const n = i === weights.length - 1 ? left : Math.max(1, Math.min(left - (weights.length - 1 - i), Math.round((w / wsum) * spec.testCount)));
    left -= n;
    return n;
  });
  const perTest = spec.fullTestMs / spec.testCount;
  const modules = counts.map((n, i) => {
    const file = spec.modulePath(i, r);
    const tests = Array.from({ length: n }, (_, j) => spec.testName(file, j, r));
    const durations = tests.map(() => Math.max(1, Math.round(perTest * (0.2 + r() * 1.6))));
    return { file, tests, durations, timeMs: durations.reduce((a, b) => a + b, 0) };
  });
  suites.set(spec.id, modules);
  return modules;
}

// ---------------------------------------------------------------- defects (from real bundle shapes)

interface DefectSeed {
  id: string;
  projectId: string;
  testId: string;
  /** The test file: the defect's test runs whenever this file runs. */
  cause: DefectCause;
  causeTests: string[];
  seed: number | null;
  prefixLength: number;
  exception: Defect["exception"];
  outcome: string;
  divergence: Defect["divergence"];
  status?: Defect["status"];
  fixedDaysAgo?: number;
  firstDaysAgo: number;
}

const OUTCOME_ONLY = "identical observed events, different outcome (passed vs failed): the cause is a source Level 0 does not observe";
const DEFECT_SEEDS: DefectSeed[] = [
  {
    id: "dfx_7c21", projectId: "prj_homehub", testId: "tests/components/mqtt/test_discovery.py::test_discovery_update_attr",
    cause: "polluter", causeTests: ["tests/components/mqtt/test_init.py::test_subscribe_topic_not_initialize"], seed: 3, prefixLength: 412,
    exception: { type: "AssertionError", phase: "call", message: "AssertionError: assert 'unavailable' == 'on'", location: "tests/components/mqtt/test_discovery.py:221" },
    outcome: "failed", divergence: { index: 1, reason: "outcome-only", description: OUTCOME_ONLY }, firstDaysAgo: 38,
  },
  {
    id: "dfx_7c22", projectId: "prj_homehub", testId: "tests/components/mqtt/test_sensor.py::test_expiration_on_discovery_and_discovery_update",
    cause: "polluter", causeTests: ["tests/components/mqtt/test_init.py::test_subscribe_topic_not_initialize"], seed: 7, prefixLength: 655,
    exception: { type: "KeyError", phase: "call", message: "KeyError: 'sensor.test_expiring'", location: "homehub/components/mqtt/discovery.py:148" },
    outcome: "failed", divergence: { index: 1, reason: "outcome-only", description: OUTCOME_ONLY }, firstDaysAgo: 31,
  },
  {
    id: "dfx_7c30", projectId: "prj_homehub", testId: "tests/components/recorder/test_purge.py::test_purge_old_states",
    cause: "state_setter", causeTests: ["tests/components/recorder/test_init.py::test_setup_without_migration"], seed: 16, prefixLength: 98,
    exception: { type: "AssertionError", phase: "call", message: "AssertionError: assert 4 == 2", location: "tests/components/recorder/test_purge.py:96" },
    outcome: "failed", divergence: { index: 7, reason: "time", description: "the runs read a different clock value at homehub/components/recorder/purge.py:61" }, firstDaysAgo: 22,
  },
  {
    id: "dfx_7c41", projectId: "prj_homehub", testId: "tests/helpers/test_event.py::test_track_point_in_time_drift_rearm",
    cause: "fails_alone", causeTests: [], seed: 22, prefixLength: 1,
    exception: { type: "AssertionError", phase: "call", message: "AssertionError: assert 0 == 1", location: "tests/helpers/test_event.py:4410" },
    outcome: "failed", divergence: { index: 3, reason: "time", description: "the runs read a different clock value at homehub/helpers/event.py:1502" }, firstDaysAgo: 55, fixedDaysAgo: 19,
  },
  {
    id: "dfx_9a10", projectId: "prj_storefront", testId: "storefront/checkout/tests/test_checkout_complete.py::test_checkout_complete_with_voucher",
    cause: "polluter", causeTests: ["storefront/discount/tests/test_voucher_cache.py::test_voucher_cache_warm"], seed: 1, prefixLength: 214,
    exception: { type: "AssertionError", phase: "call", message: "assert Decimal('80.00') == Decimal('90.00')", location: "storefront/checkout/tests/test_checkout_complete.py:512" },
    outcome: "failed", divergence: { index: 1, reason: "outcome-only", description: OUTCOME_ONLY }, firstDaysAgo: 29,
  },
  {
    id: "dfx_9a11", projectId: "prj_storefront", testId: "storefront/order/tests/test_order_totals.py::test_order_total_with_voucher",
    cause: "polluter", causeTests: ["storefront/discount/tests/test_voucher_cache.py::test_voucher_cache_warm"], seed: 2, prefixLength: 377,
    exception: { type: "AssertionError", phase: "call", message: "assert 422 == 400", location: "storefront/order/tests/test_order_totals.py:88" },
    outcome: "failed", divergence: { index: 1, reason: "outcome-only", description: OUTCOME_ONLY }, firstDaysAgo: 17,
  },
  {
    id: "dfx_9a17", projectId: "prj_storefront", testId: "storefront/account/tests/test_password_reset.py::test_password_reset_email_sent",
    cause: "polluter", causeTests: ["storefront/webhook/tests/test_tasks.py::test_send_webhook_using_scheme_method"], seed: 32, prefixLength: 61,
    exception: { type: "ValueError", phase: "teardown", message: "ValueError: I/O operation on closed file", location: "storefront/core/emails.py:40" },
    outcome: "error+teardown-error", divergence: { index: 2, reason: "fs", description: "the runs saw a different file at /tmp/storefront-mail/outbox.eml" }, firstDaysAgo: 9,
  },
  {
    id: "dfx_9a20", projectId: "prj_storefront", testId: "storefront/payment/tests/test_webhooks.py::test_webhook_retry_backoff",
    cause: "fails_alone", causeTests: [], seed: 7, prefixLength: 1, status: "replay_unstable",
    exception: { type: "TimeoutError", phase: "call", message: "TimeoutError: webhook worker did not finish", location: "storefront/payment/webhooks.py:203" },
    outcome: "failed", divergence: { index: 12, reason: "thread", description: "a thread outside the engine's control ran in a different order" }, firstDaysAgo: 6,
  },
  {
    id: "dfx_3b05", projectId: "prj_docs", testId: "packages/docusaurus-utils/src/__tests__/i18n7.test.ts > localize > localizes paths 3",
    cause: "fails_alone", causeTests: [], seed: 32, prefixLength: 1,
    exception: { type: "AssertionError", phase: "call", message: "expected '2026-11-02' to be '2026-11-03'", location: "packages/docusaurus-utils/src/__tests__/i18n7.test.ts:41" },
    outcome: "failed", divergence: { index: 2, reason: "time", description: "the runs read a different clock value at packages/docusaurus-utils/src/dateUtils.ts:18" }, firstDaysAgo: 26,
  },
];

const fileOf = (testId: string) => testId.split(/::| > /)[0];

// ---------------------------------------------------------------- the sample organizations

interface Detail {
  ran: Set<number>;
  failures: { testId: string; defectId: string | null }[];
  /** Tests not proven identical to the serial run, with the runner's cause when it gave one. */
  notProven?: { testId: string; cause: string | null }[];
  /** Tests the runner sent no per-test result for. */
  unsent?: string[];
}

/** The running run: what it will be once finished, how many times the live view asked, and how far it is. */
interface Live {
  runId: string;
  final: Run;
  finalDetail: Detail;
  calls: number;
  stage: number;
}

interface Store {
  projects: Project[];
  runs: Run[];
  /** Per run: the test files that ran, and the failed tests. */
  detail: Map<string, Detail>;
  defects: Defect[];
  explorations: Exploration[];
  events: UsageEvent[];
  reruns: AuditRerun[];
  installations: Installation[];
  repos: GitHubRepository[];
  /** Repositories whose setup pull request is queued: list calls left until the App has done it. */
  queued: Map<number, number>;
  planId: string | null;
  addons: string[];
  trial: TrialDates | null;
  settings: Settings;
  live: Live | null;
  /** The account a new installation link would add (mock only). */
  nextAccount: string;
  onboardingKind?: "move" | "side_by_side";
}

const RATE: GitHubRate = { usdPerMinute: 0.008, runner: "GitHub-hosted Linux, 2 cores", source: "GitHub Actions pricing page, as quoted in PRODUCT.md (to verify)", checkedOn: "2026-11-16" };

/** Plans by run units (1 unit = 10 baseline minutes). The units each plan includes are not set yet. */
const PLANS: Omit<Plan, "current">[] = [
  { id: "starter", name: "Starter", kind: "plan", description: "One project with a steady flow of pull requests.", unitsIncluded: null, maxProjects: 1, priceUsdMonth: 129, features: ["Skip with proof", "Flaky tests turned into defects", "Pull request comments"] },
  { id: "team", name: "Team", kind: "plan", description: "A few projects, a team pushing every day.", unitsIncluded: null, maxProjects: 5, priceUsdMonth: 479, features: ["Everything in Starter", "Members and roles", "Usage export"] },
  { id: "scale", name: "Scale", kind: "plan", description: "Many projects and many pushes.", unitsIncluded: null, maxProjects: 25, priceUsdMonth: 1350, features: ["Everything in Team", "Priority machines", "Audit log"] },
  { id: "monorepo", name: "Monorepo", kind: "plan", description: "A very large repository, or many of them.", unitsIncluded: null, maxProjects: null, priceUsdMonth: 4200, features: ["Everything in Scale", "Single sign-on", "Agreed response time"] },
  { id: "nightly", name: "Nightly exploration", kind: "addon", description: "Runs the suite at night in many seeded orders, to find order and timing bugs before a pull request does.", unitsIncluded: null, maxProjects: null, priceUsdMonth: null, features: ["Every night, on fenvix machines", "Defects found before they reach a pull request", "Not counted in your run units"] },
];

const COMMIT_WORDS = ["Fix", "Add", "Update", "Refactor", "Bump", "Handle", "Speed up", "Remove", "Rename", "Document"];
const COMMIT_THINGS: Record<string, string[]> = {
  prj_homehub: ["mqtt discovery payloads", "zwave_js config flow", "recorder purge batching", "hue bridge reconnect", "esphome entity names", "sonos favorites", "energy dashboard units", "matter commissioning", "template sensor availability", "aiohttp to 3.11"],
  prj_docs: ["sidebar autogeneration", "blog pagination", "i18n path helpers", "mdx loader cache", "theme toggle", "search plugin options", "sitemap priority", "front matter validation", "docs versions dropdown", "vitest to 2.1"],
  prj_ledger: ["chunk encoding", "remote write retries", "WAL replay", "rule evaluation", "label matcher cache", "scrape timeouts", "compaction planner", "query engine limits", "config reload", "go to 1.23"],
  prj_storefront: ["checkout totals", "voucher cache", "order webhooks", "stripe payment intents", "gift card balance", "warehouse allocation", "tax rounding", "graphql permissions", "password reset email", "Django to 5.1"],
};

/** Which files run in a run: a seeded walk that stops at the run's share of test time. */
function ranModules(spec: Spec, runSeed: number, skipShare: number, force: number[]): Set<number> {
  const modules = suite(spec);
  const r = rng(runSeed);
  const order = modules.map((_, i) => i).sort(() => r() - 0.5);
  const target = spec.fullTestMs * (1 - skipShare);
  const ran = new Set<number>(force);
  let time = force.reduce((a, i) => a + modules[i].timeMs, 0);
  for (const i of order) {
    if (time >= target) break;
    if (ran.has(i)) continue;
    ran.add(i);
    time += modules[i].timeMs;
  }
  return ran;
}

/** The source a test file exercises, for the reasons a test ran ("code: homehub/components/mqtt/discovery.py::async_discover"). */
function sourceOf(spec: Spec, file: string, r: () => number): string {
  const fn = pick(r, spec.language === "go" ? ["Append", "Select", "Encode", "Compact", "Reload"] : ["setup_entry", "async_update", "build_payload", "validate", "resolve", "load"]);
  if (spec.language === "python") return `${file.replace(/^tests\//, spec.id === "prj_storefront" ? "" : "homehub/").replace(/\/tests\//, "/").replace(/test_([a-z_]+?)(_\d+)?\.py$/, "$1.py")}::${fn}`;
  if (spec.language === "node") return `${file.replace(/\/src\/__tests__\/([a-z]+)\d*\.test\.ts$/, "/src/$1.ts")}::${pick(r, ["resolve", "normalize", "load", "render"])}`;
  return `${file}/${pick(r, ["db", "head", "query", "encode"])}.go::${fn}`;
}

/**
 * Why the tests of a run ran (the engine's "why" of each test that was not reused). An invalidating change (a
 * dependency bump, a config change) makes most tests run for one reason; otherwise the changed code explains most.
 */
function missesFor(spec: Spec, ran: Set<number>, ranTests: number, skipShare: number, failedBefore: boolean, r: () => number): Pick<Run, "skipMisses" | "missDetails"> {
  const modules = suite(spec);
  const split = (shares: [MissKind, number][]) => {
    const out: Partial<Record<MissKind, number>> = {};
    let left = ranTests;
    shares.forEach(([k, w], i) => {
      const n = i === shares.length - 1 ? left : Math.min(left, Math.round(ranTests * w));
      if (n > 0) out[k] = n;
      left -= n;
    });
    return out;
  };
  const top = [...ran].map((i) => modules[i]).sort((a, b) => b.tests.length - a.tests.length).slice(0, 4);
  if (skipShare < 0.6) {
    const kind: MissKind = r() < 0.7 ? "runtime" : "config";
    const detail = kind === "runtime" ? (spec.language === "python" ? "packages: uv.lock changed" : spec.language === "node" ? "packages: package-lock.json changed" : "go.sum changed") : spec.language === "python" ? "pyproject.toml [tool.pytest.ini_options]" : spec.language === "node" ? "vitest.config.ts" : "go.mod";
    return { skipMisses: split([[kind, 0.86], ["code", 0.12], ["new", 0.02]]), missDetails: [{ kind, detail, tests: Math.round(ranTests * 0.86) }, ...top.slice(0, 2).map((m) => ({ kind: "code" as MissKind, detail: sourceOf(spec, m.file, r), tests: m.tests.length }))] };
  }
  const shares: [MissKind, number][] = [["code", 0.72], ["data", 0.1], ["env", 0.03], ["new", 0.06], ...(failedBefore ? ([["failed-before", 0.04]] as [MissKind, number][]) : []), ["clock", 0.05]];
  const details = top.map((m) => ({ kind: "code" as MissKind, detail: sourceOf(spec, m.file, r), tests: m.tests.length }));
  if (r() < 0.4) details.push({ kind: "data", detail: spec.language === "python" ? "tests/fixtures/config_entries.json" : "website/docs/intro.md", tests: Math.max(1, Math.round(ranTests * 0.1)) });
  if (r() < 0.2) details.push({ kind: "env", detail: spec.env[0], tests: Math.max(1, Math.round(ranTests * 0.03)) });
  return { skipMisses: split(shares), missDetails: details.sort((a, b) => b.tests - a.tests).slice(0, 5) };
}

function moduleIndexOf(spec: Spec, testId: string): number {
  return suite(spec).findIndex((m) => m.file === fileOf(testId));
}

/** Defect tests live in files of their own, added to the suite (they keep the test count within a few tests). */
function ensureDefectFiles(spec: Spec) {
  const modules = suite(spec);
  for (const d of DEFECT_SEEDS.filter((x) => x.projectId === spec.id)) {
    for (const t of [d.testId, ...d.causeTests]) {
      const file = fileOf(t);
      let m = modules.find((x) => x.file === file);
      if (!m) {
        m = { file, tests: [], durations: [], timeMs: 0 };
        modules.push(m);
      }
      if (!m.tests.includes(t)) {
        m.tests.push(t);
        m.durations.push(180);
        m.timeMs += 180;
      }
    }
  }
}

const engineOf = (spec: Spec) => (spec.language === "node" ? "detjs 0.1.0" : spec.language === "go" ? "detgo 0.1.0" : "detpy 0.1.0");
const totalTests = (spec: Spec) => suite(spec).reduce((a, m) => a + m.tests.length, 0);

interface RunInput {
  spec: Spec;
  number: number;
  startMs: number;
  sha: string;
  trigger: RunTrigger;
  prNumber: number | null;
  prOf: number;
  skipShare: number;
  defect: DefectSeed | null;
  failing: boolean;
  shadow: boolean;
  region: Region;
  lastFailed: boolean;
  r: () => number;
}

/**
 * One finished run. In shadow mode (the trial) every test runs; the files the engine would have skipped are counted
 * as wouldSkipTests and wouldSaveMs instead. Enforce runs rerun a few skipped tests as an audit (all confirmed).
 */
function makeRun(x: RunInput): { run: Run; detail: Detail } {
  const { spec, r } = x;
  const modules = suite(spec);
  const total = totalTests(spec);
  const force = x.defect ? [moduleIndexOf(spec, x.defect.testId)].filter((i) => i >= 0) : [];
  const seed = hash(`${spec.id}#${x.number}`);
  const would = ranModules(spec, seed, x.skipShare, force);
  const ran = x.shadow ? new Set(modules.map((_, i) => i)) : would;
  let ranTests = 0;
  let ranMs = 0;
  for (const i of ran) {
    ranTests += modules[i].tests.length;
    ranMs += modules[i].timeMs;
  }
  let wouldTests = 0;
  let wouldMs = 0;
  for (const i of would) {
    wouldTests += modules[i].tests.length;
    wouldMs += modules[i].timeMs;
  }
  const failures: Detail["failures"] = [];
  if (x.defect) failures.push({ testId: x.defect.testId, defectId: x.defect.id });
  else if (x.failing) {
    const ranList = [...ran];
    const k = 1 + Math.floor(r() * 3);
    for (let f = 0; f < k; f++) {
      const m = modules[pick(r, ranList)];
      const id = pick(r, m.tests);
      if (!failures.some((y) => y.testId === id)) failures.push({ testId: id, defectId: null });
    }
  }
  // A shadow run skips nothing: every file ran (the suite's files add up to a little more than the measured total).
  const skippedMs = x.shadow ? 0 : Math.max(0, spec.fullTestMs - ranMs);
  const otherStepMinutes = Math.round((spec.otherStepMs * (0.9 + r() * 0.2)) / 600) / 100;
  const durationMs = Math.round(spec.setupMs + ranMs * spec.overhead * (0.9 + r() * 0.2));
  const pushedAt = new Date(x.startMs - (4_000 + r() * 20_000));
  const skippedTests = total - ranTests;
  const id = `run_${spec.id.slice(4)}_${x.number}`;
  const run: Run = {
    id, projectId: spec.id, number: x.number, engineRunId: `${new Date(x.startMs).toISOString().replace(/[-:]/g, "").slice(0, 15)}-${1000 + (hash(id) % 8999)}`,
    commitSha: x.sha, commitMessage: `${pick(r, COMMIT_WORDS)} ${pick(r, COMMIT_THINGS[spec.id])}`,
    branch: x.trigger === "pull_request" ? `${pick(r, ["fix", "feat", "chore", "agent"])}/${hex(`${x.sha}b`, 6)}` : x.trigger === "merge_group" ? `gh-readonly-queue/main/pr-${x.prOf}` : "main",
    pullRequest: x.prNumber, trigger: x.trigger, status: failures.length ? "failed" : "passed", mode: x.shadow ? "shadow" : "enforce",
    pushedAt: pushedAt.toISOString(), startedAt: new Date(x.startMs).toISOString(), finishedAt: new Date(x.startMs + durationMs).toISOString(), durationMs,
    tests: { total, ran: ranTests, passed: ranTests - failures.length, failed: failures.length, skippedWithProof: skippedTests, flakyDefects: failures.filter((f) => f.defectId).length, notProven: 0 },
    testTimeMs: { ran: ranMs, skipped: skippedMs },
    skipShare: Math.round((skippedMs / (ranMs + skippedMs)) * 10000) / 10000,
    minutesSaved: Math.round((skippedMs / MIN) * 100) / 100,
    otherStepMinutes,
    githubEquivalentMinutes: Math.round(((ranMs + skippedMs) / MIN + otherStepMinutes) * 100) / 100,
    engineVersion: engineOf(spec),
    seed: seed % 100,
    ...missesFor(spec, would, wouldTests, x.skipShare, x.lastFailed, rng(seed)),
    wouldSkipTests: x.shadow ? total - wouldTests : 0,
    wouldSaveMs: x.shadow ? Math.max(0, spec.fullTestMs - wouldMs) : 0,
    // A few of the skipped tests run anyway and must pass, as their receipts said (none ever failed).
    audit: { rerun: x.shadow || skippedTests === 0 ? 0 : Math.max(1, Math.round(skippedTests * 0.004)), wrongSkips: 0 },
    region: x.region,
    progress: null,
    proof: null,
    exitCode: failures.length ? 1 : 0,
    notProvenReason: null,
  };
  return { run, detail: { ran, failures } };
}

interface InstallSeed {
  installationId: number;
  account: string;
  accountType: Installation["accountType"];
  status: Installation["status"];
  repositorySelection: Installation["repositorySelection"];
  linkedDaysAgo: number;
}

interface RepoSeed {
  installationId: number;
  name: string;
  state: OnboardingState;
  language: Language | null;
  testRunner: TestRunner | null;
  detail: string;
  workflowPath?: string | null;
  job?: string | null;
  pr?: number;
  isPrivate?: boolean;
  removed?: boolean;
}

/** What the App says about a repository in each onboarding state, as onboardingDetail. */
const DETAILS: Record<OnboardingState, string> = {
  pending: "Not tried yet. fenvix opens the setup pull request when you ask.",
  pr_open: "The setup pull request changes the test job to runs-on: fenvix. Merge it and the next test run goes to fenvix.",
  merged: "The setup pull request was merged: the test job runs on fenvix.",
  closed: "The setup pull request was closed without being merged. Open it again when you are ready.",
  no_workflow: "There is no workflow file in .github/workflows, so there is no test job to move.",
  no_test_job: "The workflows have no job that runs tests (looked for pytest, vitest, jest and go test).",
  already_fenvix: "The test job already uses runs-on: fenvix.",
  unsupported: "The tests run with RSpec (Ruby), which fenvix does not support yet.",
  failed: "GitHub refused to create the branch: the default branch's protection rules require signed commits.",
  side_by_side_pr_open: "The side-by-side pull request adds .github/workflows/fenvix-side-by-side.yml; your workflow is unchanged. Merge it to run side by side.",
  side_by_side: "The side-by-side workflow is merged: a copy of the test job runs on fenvix next to yours.",
};

interface OrgPlan {
  owner: string;
  name: string;
  planId: string | null;
  addons: string[];
  region: Region;
  specs: string[];
  /** Days of history, and a shadow trial over them when set. */
  trialDays: number | null;
  installs: InstallSeed[];
  repos: RepoSeed[];
  /** Billable jobs of repositories that are not a project. */
  strayJobs: number;
}

const NORTHWIND: OrgPlan = {
  owner: "northwind", name: "Northwind Cloud", planId: "team", addons: ["nightly"], region: "us", specs: SPECS.map((s) => s.id), trialDays: null, strayJobs: 12,
  installs: [
    { installationId: 51_204_331, account: "northwind", accountType: "Organization", status: "active", repositorySelection: "selected", linkedDaysAgo: 80 },
    { installationId: 51_377_020, account: "northwind-labs", accountType: "Organization", status: "suspended", repositorySelection: "all", linkedDaysAgo: 30 },
    { installationId: 49_800_112, account: "elena-marsh", accountType: "User", status: "deleted", repositorySelection: "selected", linkedDaysAgo: 120 },
  ],
  repos: [
    { installationId: 51_204_331, name: "northwind/billing-worker", state: "pending", language: "python", testRunner: "pytest", detail: DETAILS.pending, workflowPath: ".github/workflows/test.yml", job: "pytest" },
    { installationId: 51_204_331, name: "northwind/mobile-app", state: "pr_open", language: "node", testRunner: "jest", detail: DETAILS.pr_open, workflowPath: ".github/workflows/ci.yml", job: "unit", pr: 812 },
    { installationId: 51_204_331, name: "northwind/analytics", state: "closed", language: "python", testRunner: "pytest", detail: DETAILS.closed, workflowPath: ".github/workflows/ci.yml", job: "test", pr: 77 },
    { installationId: 51_204_331, name: "northwind/notifications", state: "failed", language: "node", testRunner: "vitest", detail: DETAILS.failed, workflowPath: ".github/workflows/ci.yml", job: "test" },
    { installationId: 51_204_331, name: "northwind/infra-scripts", state: "no_workflow", language: "python", testRunner: "pytest", detail: DETAILS.no_workflow, isPrivate: false },
    { installationId: 51_204_331, name: "northwind/design-system", state: "no_test_job", language: "node", testRunner: null, detail: DETAILS.no_test_job, workflowPath: ".github/workflows/release.yml" },
    { installationId: 51_204_331, name: "northwind/search-service", state: "already_fenvix", language: "go", testRunner: "go test", detail: DETAILS.already_fenvix, workflowPath: ".github/workflows/go.yml", job: "test" },
    { installationId: 51_204_331, name: "northwind/checkout-legacy", state: "unsupported", language: null, testRunner: null, detail: DETAILS.unsupported, workflowPath: ".github/workflows/rspec.yml", job: "rspec" },
    { installationId: 51_377_020, name: "northwind-labs/experiments", state: "pending", language: "python", testRunner: "pytest", detail: DETAILS.pending, workflowPath: ".github/workflows/ci.yml", job: "test" },
    { installationId: 51_377_020, name: "northwind-labs/prototype-ui", state: "pending", language: "node", testRunner: "vitest", detail: DETAILS.pending, workflowPath: ".github/workflows/ci.yml", job: "test" },
    { installationId: 49_800_112, name: "elena-marsh/dotfiles", state: "no_workflow", language: null, testRunner: null, detail: DETAILS.no_workflow, removed: true, isPrivate: false },
  ],
};

const HARBOR: OrgPlan = {
  owner: "harbor-analytics", name: "Harbor Analytics", planId: null, addons: [], region: "eu", specs: ["prj_homehub", "prj_docs"], trialDays: 18, strayJobs: 0,
  installs: [{ installationId: 61_002_418, account: "harbor-analytics", accountType: "Organization", status: "active", repositorySelection: "selected", linkedDaysAgo: 18 }],
  repos: [{ installationId: 61_002_418, name: "harbor-analytics/etl-jobs", state: "pending", language: "python", testRunner: "pytest", detail: DETAILS.pending, workflowPath: ".github/workflows/ci.yml", job: "tests" }],
};

const PR_NUMBERS: Record<string, number> = { prj_homehub: 18204, prj_docs: 10433, prj_ledger: 4412, prj_storefront: 16031 };
const repoId = (fullName: string) => 600_000_000 + (hash(fullName) % 99_000_000);
/** The runner's own replay command, sent with some bundles (the engine's command for the bundle). */
const RUNNER_COMMANDS: Record<string, string> = {
  dfx_9a10: "pytest --det --det-seed=1 --det-order=<bundle>/order.txt -n 0",
  dfx_7c21: "pytest --det --det-seed=3 --det-order=<bundle>/order.txt -n 0",
};

function trialBelow(): boolean {
  try {
    return sessionStorage.getItem("fenvix-mock-trial") === "below";
  } catch {
    return false;
  }
}

/** The causes of the sample's not-proven tests (what the engine reports). */
export const NOT_PROVEN_CAUSES = ["file read outside the project", "environment variable read outside any test"] as const;

/**
 * homehub runs its suite in parallel lanes: most of its last 30 days of finished runs carry a proof with every test
 * proven (a few re-run in one lane); some stay serial (proof null). Among its newest 10 finished runs, never the newest
 * one: two runs not proven with a cause each, and one whose summary reported 2 tests not proven without a proof block
 * (and without a cause).
 */
function addParallelProof(specs: Spec[], runs: Run[], detail: Map<string, Detail>) {
  const spec = specs.find((s) => s.id === "prj_homehub");
  if (!spec) return;
  const mine = runs.filter((r) => r.projectId === spec.id && r.status !== "running").sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const since = new Date(NOW.getTime() - 30 * DAY).toISOString();
  const proofOf = (r: Run, notProven: number, causes: RunProof["notProvenCauses"]): RunProof => {
    const parallelMs = Math.max(1000, r.durationMs - spec.setupMs);
    const h = hash(`proof:${r.id}`);
    return {
      workers: 4, proven: r.tests.ran - notProven, notProven, ranExecuted: r.tests.ran, rerunOneLane: notProven + (h % 6 === 0 ? 1 + (h % 3) : 0), parallelMs,
      serialMsEstimate: h % 9 === 0 ? null : Math.round(parallelMs * 3.6), orderDigest: hex(`order:${r.id}`), notProvenCauses: causes,
    };
  };
  for (const r of mine) {
    if (r.startedAt < since || hash(`lanes:${r.id}`) % 4 === 0) continue;
    r.proof = proofOf(r, 0, []);
  }
  // Not proven: passed runs among the newest 10, never the newest one.
  const candidates = mine.slice(1, 10).filter((r) => r.status === "passed" && r.tests.ran > 20);
  const plans: { notProven: number; causes: RunProof["notProvenCauses"]; proof: boolean; exit: number }[] = [
    { notProven: 14, causes: [{ cause: NOT_PROVEN_CAUSES[0], tests: 14 }], proof: true, exit: 1 },
    { notProven: 3, causes: [{ cause: NOT_PROVEN_CAUSES[1], tests: 3 }], proof: true, exit: 0 },
    { notProven: 2, causes: [], proof: false, exit: 1 },
  ];
  plans.forEach((p, k) => {
    // The second (an environment variable) sends its proof but no per-test rows: the card has no "See the N tests".
    const rows = k !== 1;
    const r = candidates[k * 2] ?? candidates[k];
    if (!r || r.status !== "passed") return;
    const d = detail.get(r.id)!;
    const modules = suite(spec);
    const tests = [...d.ran].sort((a, b) => a - b).flatMap((i) => modules[i].tests).filter((t) => !d.failures.some((f) => f.testId === t));
    const picked = tests.slice(0, p.notProven);
    const causes = p.causes.flatMap((c) => Array.from({ length: c.tests }, () => c.cause));
    d.notProven = rows ? picked.map((testId, i) => ({ testId, cause: causes[i] ?? null })) : [];
    if (!rows) d.unsent = picked;
    r.status = "not_proven";
    r.exitCode = p.exit;
    r.tests.notProven = picked.length;
    r.tests.passed = Math.max(0, r.tests.ran - r.tests.failed - picked.length);
    r.proof = p.proof ? proofOf(r, picked.length, p.causes) : null;
  });
}

function buildSample(plan: OrgPlan): Store {
  const owner = plan.owner;
  const specs = SPECS.filter((s) => plan.specs.includes(s.id));
  const nameOf = (s: Pick<Spec, "fullName">) => `${owner}/${s.fullName.split("/")[1]}`;
  const history = (s: Spec) => plan.trialDays ?? Math.min(HISTORY_DAYS, s.connectedDaysAgo - 1);
  const trialStart = plan.trialDays === null ? null : dayStart(new Date(NOW.getTime() - plan.trialDays * DAY));
  const below = plan.trialDays !== null && trialBelow();
  // Defects found within the history shown, so a younger organization has its own.
  const seeds = DEFECT_SEEDS.filter((d) => plan.specs.includes(d.projectId)).map((d) => {
    const h = history(SPECS.find((s) => s.id === d.projectId)!);
    const first = Math.min(d.firstDaysAgo, h - 1);
    return { ...d, firstDaysAgo: first, fixedDaysAgo: d.fixedDaysAgo === undefined ? undefined : Math.min(d.fixedDaysAgo, first - 1) };
  });
  const runs: Run[] = [];
  const detail: Store["detail"] = new Map();
  const occurrences = new Map<string, Run[]>();
  const projects: Project[] = specs.map((s) => {
    const pr = PR_NUMBERS[s.id];
    return {
      id: s.id, fullName: nameOf(s), language: s.language, testRunner: s.testRunner, defaultBranch: "main", installationId: plan.installs[0].installationId, repositoryId: repoId(nameOf(s)),
      setupState: "active", setupPullRequest: { number: pr, url: `https://github.com/${nameOf(s)}/pull/${pr}`, state: "merged" },
      connectedAt: trialStart ? trialStart.toISOString() : ago(s.connectedDaysAgo * DAY), baseline: s.baseline,
      settings: { skipWithProof: true, commentOnPullRequests: true, nightlyExploration: plan.addons.includes("nightly") && s.id !== "prj_ledger", testCommand: "" },
      warmCache: COLD,
    };
  });

  let live: Live | null = null;
  for (const spec of specs) {
    ensureDefectFiles(spec);
    const r = rng(hash(`runs:${spec.id}`));
    let number = spec.firstRunNumber;
    let pr = { prj_homehub: 129_400, prj_docs: 11_020, prj_ledger: 15_300, prj_storefront: 17_800 }[spec.id]!;
    const projectDefects = seeds.filter((d) => d.projectId === spec.id);
    let lastSha = "";
    let lastFailed = false;
    const next = (t: number, d: number) => {
      const rerun = lastFailed && r() < 0.55;
      const sha = rerun ? lastSha : hex(`${spec.id}:${number}`, 40);
      const trigger: RunTrigger = rerun ? "pull_request" : r() < 0.58 ? "pull_request" : r() < 0.85 ? "push" : r() < 0.6 ? "merge_group" : "workflow_dispatch";
      const prNumber = trigger === "pull_request" ? (rerun ? pr : ++pr) : null;
      const share = spec.skip(r);
      const failing = r() < spec.failRate;
      const open = projectDefects.filter((x) => x.firstDaysAgo >= d && (x.fixedDaysAgo === undefined || x.fixedDaysAgo < d));
      const defect = failing && open.length && r() < 0.6 ? pick(r, open) : null;
      const shadow = trialStart !== null && t >= trialStart.getTime();
      const made = makeRun({ spec, number, startMs: t, sha, trigger, prNumber, prOf: pr, skipShare: below ? share * 0.3 : share, defect, failing, shadow, region: plan.region, lastFailed, r });
      lastSha = sha;
      lastFailed = made.run.status === "failed";
      number++;
      return made;
    };
    for (let d = history(spec); d >= 0; d--) {
      const dayAt = dayStart(new Date(NOW.getTime() - d * DAY));
      const weekday = dayAt.getUTCDay() % 6 !== 0;
      const n = Math.round(spec.runsPerWeekday * (weekday ? 0.8 + r() * 0.4 : 0.25 + r() * 0.2));
      // Spread across working hours (UTC 07 to 20), sorted, and never in the future.
      const times = Array.from({ length: n }, () => dayAt.getTime() + (7 + r() * 13) * HOUR).filter((t) => t < NOW.getTime() - 20 * MIN).sort((a, b) => a - b);
      for (const t of times) {
        const { run, detail: dt } = next(t, d);
        runs.push(run);
        detail.set(run.id, dt);
        const failure = dt.failures.find((f) => f.defectId);
        if (failure) (occurrences.get(failure.defectId!) ?? occurrences.set(failure.defectId!, []).get(failure.defectId!)!).push(run);
      }
    }
    // The newest run of the first project is still running: the Run page polls it and it advances.
    if (spec === specs[0] && plan.trialDays === null) {
      const { run: final, detail: finalDetail } = next(NOW.getTime() - 150_000, 0);
      final.status = "passed";
      final.tests.passed = final.tests.ran;
      final.tests.failed = 0;
      final.tests.flakyDefects = 0;
      finalDetail.failures = [];
      final.finishedAt = new Date(NOW.getTime() + 60_000).toISOString();
      final.durationMs = 210_000;
      live = { runId: final.id, final, finalDetail, calls: 0, stage: 0 };
      runs.push(runningView(live));
    }
  }

  if (plan.trialDays === null) addParallelProof(specs, runs, detail);

  const defects: Defect[] = seeds.map((s) => {
    const seen = occurrences.get(s.id) ?? [];
    const spec = SPECS.find((p) => p.id === s.projectId)!;
    return {
      id: s.id, projectId: s.projectId, projectName: nameOf(spec), testId: s.testId, status: s.status ?? "reproduced", state: s.fixedDaysAgo !== undefined ? "fixed" : "open",
      cause: s.cause, causeTests: s.causeTests, minimalOrder: s.cause === "polluter" ? [...s.causeTests, s.testId] : [s.testId], prefixLength: s.prefixLength,
      seed: s.seed, fingerprint: hex(`fp:${s.id}`), replays: { runs: 10, fails: 10, identicalFingerprint: s.status !== "replay_unstable" },
      outcome: s.outcome, exception: s.exception, divergence: s.divergence, familyKey: familyKeyOf(s.causeTests),
      firstSeenAt: seen[0]?.startedAt ?? ago(s.firstDaysAgo * DAY), lastSeenAt: seen[seen.length - 1]?.startedAt ?? ago(s.firstDaysAgo * DAY),
      firstRunId: seen[0]?.id ?? null, lastRunId: seen[seen.length - 1]?.id ?? null, occurrences: Math.max(1, seen.length),
      engineVersion: engineOf(spec), language: spec.language === "node" ? "node" : "python", testRunner: spec.testRunner,
      replayCommand: RUNNER_COMMANDS[s.id] ?? null,
    };
  });

  // Nights of exploration for the projects that have it on: seeds tried, flaky tests seen, defects found first at night.
  const explorations: Exploration[] = [];
  for (const spec of specs) {
    const project = projects.find((p) => p.id === spec.id)!;
    if (!project.settings.nightlyExploration) continue;
    const modules = suite(spec);
    const total = totalTests(spec);
    const r = rng(hash(`nights:${spec.id}`));
    const nSeeds = spec.id === "prj_docs" ? 100 : 50;
    for (let d = history(spec); d >= 1; d--) {
      const day = dayStart(new Date(NOW.getTime() - d * DAY));
      const open = seeds.filter((x) => x.projectId === spec.id && x.firstDaysAgo >= d && (x.fixedDaysAgo === undefined || x.fixedDaysAgo < d));
      const flaky = open.filter(() => r() < 0.7).map((x) => x.testId);
      const found = seeds.filter((x) => x.projectId === spec.id && x.firstDaysAgo === d).map((x) => x.id);
      const always = r() < 0.06 ? [pick(r, pick(r, modules).tests)] : [];
      const notReproduced = r() < 0.08 ? [pick(r, pick(r, modules).tests)] : [];
      const perSeed = (spec.fullTestMs * spec.overhead) / 1000 / 8;
      const seconds = Math.round(nSeeds * perSeed * (0.9 + r() * 0.2));
      const startedAt = new Date(day.getTime() + 2 * HOUR);
      const fams = new Map<string, number>();
      for (const t of flaky) {
        const k = familyKeyOf(seeds.find((x) => x.testId === t)!.causeTests);
        fams.set(k, (fams.get(k) ?? 0) + 1);
      }
      explorations.push({
        id: `exp_${spec.id.slice(4)}_${d}`, projectId: spec.id, startedAt: startedAt.toISOString(), finishedAt: new Date(startedAt.getTime() + seconds * 1000).toISOString(),
        commitSha: hex(`${spec.id}:night:${d}`, 40), branch: "main", seeds: nSeeds, runs: nSeeds, collected: total, seconds,
        flakyFailing: flaky, alwaysFailing: always, notReproduced, newDefectIds: found,
        familiesByPolluter: [...fams.entries()].map(([key, tests]) => ({ key, tests })),
        seedsLog: Array.from({ length: nSeeds }, (_, i) => ({ seed: i + 1, seconds: Math.round(perSeed * (0.9 + r() * 0.2)), failing: always.length + flaky.filter(() => r() < 0.12).length })),
      });
      // A defect found at night is first seen then, before any pull request hit it.
      for (const id of found) {
        const def = defects.find((x) => x.id === id);
        const at = explorations[explorations.length - 1].finishedAt;
        if (def && at < def.firstSeenAt) def.firstSeenAt = at;
      }
    }
  }
  explorations.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  // Usage events: one billable job per finished run, and a few jobs of repositories that are not projects.
  const events: UsageEvent[] = runs.filter((x) => x.finishedAt && x.status !== "running").map((x) => ({ projectId: x.projectId, occurredAt: x.finishedAt!, billable: true, baselineMinutes: x.githubEquivalentMinutes }));
  const er = rng(hash(`stray:${owner}`));
  for (let i = 0; i < plan.strayJobs; i++) events.push({ projectId: null, occurredAt: ago((1 + er() * 15) * DAY), billable: true, baselineMinutes: Math.round((4 + er() * 3) * 100) / 100 });

  // Audit reruns: a couple of skipped tests of each recent enforce run ran again and passed; a few keys stopped being trusted.
  const reruns: AuditRerun[] = [];
  for (const spec of specs) {
    const modules = suite(spec);
    const recent = runs.filter((x) => x.projectId === spec.id && x.mode === "enforce" && x.status !== "running" && x.audit.rerun > 0).slice(0, 30);
    recent.forEach((x, k) => {
      const ran = detail.get(x.id)!.ran;
      const skipped = modules.map((_, i) => i).filter((i) => !ran.has(i));
      if (!skipped.length) return;
      const rr = rng(hash(`audit:${x.id}`));
      for (let j = 0; j < 2; j++) {
        const m = modules[pick(rr, skipped)];
        const testId = pick(rr, m.tests);
        const untrusted = (spec.id === "prj_homehub" && (k === 3 || k === 11) && j === 0) || (spec.id === "prj_storefront" && k === 5 && j === 0);
        reruns.push({
          runId: x.id, runNumber: x.number, testId, cacheKey: hex(`${x.id}:${testId}:key`), outcome: "confirmed", untrusted, at: x.finishedAt!,
          detail: untrusted
            ? spec.id === "prj_storefront"
              ? "It passed, but its fingerprint differs from the receipt's: the engine no longer reuses this key."
              : "It passed, but it read /etc/localtime, which the receipt did not list: the engine no longer reuses this key."
            : "Ran again and passed, as the receipt said.",
        });
      }
    });
  }

  // The shared cache of each project's default branch: warm since its latest push run on main (the customer's own run,
  // or one of fenvix's warm-ups); the first project has a warm-up running for a newer commit.
  projects.forEach((p, i) => {
    const latest = runs.filter((x) => x.projectId === p.id && x.branch === "main" && x.status === "passed").sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (!latest) return;
    const warmAt = latest.finishedAt ?? latest.startedAt;
    const base = { commitSha: latest.commitSha, warmAt, source: i % 2 ? ("run" as const) : ("warmup" as const) };
    p.warmCache = i === 0
      ? { state: "warming", ...base, warmup: { status: "running", commitSha: hex(`${p.id}:warm`, 40), detail: "running the test job", updatedAt: ago(4 * MIN) } }
      : { state: "warm", ...base, warmup: i % 2 ? { status: "covered", commitSha: latest.commitSha, detail: "the customer's own run of this commit filled the cache", updatedAt: warmAt } : { status: "succeeded", commitSha: latest.commitSha, detail: "the cache holds this commit's proofs", updatedAt: warmAt } };
  });
  const linked = (days: number) => ago(days * DAY);
  const repos: GitHubRepository[] = [
    ...projects.map((p) => ({
      repositoryId: p.repositoryId!, installationId: p.installationId, fullName: p.fullName, private: true, removed: false, language: p.language, testRunner: p.testRunner,
      onboardingState: "merged" as const, onboardingDetail: DETAILS.merged, workflowPath: ".github/workflows/ci.yml", job: "test", setupPullRequest: p.setupPullRequest, projectId: p.id,
      warmCache: p.warmCache,
    })),
    ...plan.repos.map((x) => ({
      repositoryId: repoId(x.name), installationId: x.installationId, fullName: x.name, private: x.isPrivate ?? true, removed: x.removed ?? false, language: x.language, testRunner: x.testRunner,
      onboardingState: x.state, onboardingDetail: x.state === "pr_open" ? `Pull request #${x.pr} changes the test job to runs-on: fenvix. Merge it and the next test run goes to fenvix.` : x.detail,
      workflowPath: x.workflowPath ?? null, job: x.job ?? null,
      setupPullRequest: x.pr ? { number: x.pr, url: `https://github.com/${x.name}/pull/${x.pr}`, state: x.state === "closed" ? ("closed" as const) : ("open" as const) } : null, projectId: null,
      warmCache: COLD,
    })),
  ];
  const installations: Installation[] = plan.installs.map((i) => ({
    installationId: i.installationId, account: i.account, accountType: i.accountType, status: i.status, repositorySelection: i.repositorySelection, linkedAt: linked(i.linkedDaysAgo),
    repositories: repos.filter((x) => x.installationId === i.installationId && !x.removed).length,
  }));

  return {
    projects, runs, detail, defects, explorations, events, reruns, installations, repos, queued: new Map(), planId: plan.planId, addons: plan.addons,
    trial: trialStart ? { startedAt: trialStart.toISOString(), endsAt: new Date(trialStart.getTime() + 30 * DAY).toISOString() } : null,
    settings: { workspaceName: plan.name, emailNotices: true, region: plan.region }, live, nextAccount: `${owner}-sandbox`,
  };
}

/** Another organization: nothing connected yet, so its dashboard starts with "Connect a project". */
function emptyStore(name: string): Store {
  return {
    projects: [], runs: [], detail: new Map(), defects: [], explorations: [], events: [], reruns: [], installations: [], repos: [], queued: new Map(),
    planId: null, addons: [], trial: null, settings: { workspaceName: name, emailNotices: true, region: "us" }, live: null, nextAccount: slug(name),
  };
}

/** A repository whose cache holds nothing yet, with no warm-up in flight. */
const COLD: WarmCache = { state: "cold", commitSha: null, warmAt: null, source: null, warmup: null };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "acme";

// Installations added in this tab (an "Install the GitHub App" round trip): kept in sessionStorage, because the
// browser leaves the page and comes back, which rebuilds the in-memory sample data.
const INSTALLS_KEY = "fenvix-mock-installs";
interface AddedInstall {
  org: string;
  installationId: number;
  account: string;
}
function addedInstalls(): AddedInstall[] {
  try {
    return JSON.parse(sessionStorage.getItem(INSTALLS_KEY) ?? "[]") as AddedInstall[];
  } catch {
    return [];
  }
}
function applyInstall(s: Store, a: AddedInstall) {
  if (s.installations.some((i) => i.installationId === a.installationId)) return;
  const repos: GitHubRepository[] = [
    { name: "api", language: "python" as const, testRunner: "pytest" as const },
    { name: "web", language: "node" as const, testRunner: "vitest" as const },
  ].map((x) => ({
    repositoryId: repoId(`${a.account}/${x.name}`), installationId: a.installationId, fullName: `${a.account}/${x.name}`, private: true, removed: false, language: x.language, testRunner: x.testRunner,
    onboardingState: "pending", onboardingDetail: DETAILS.pending, workflowPath: ".github/workflows/ci.yml", job: "test", setupPullRequest: null, projectId: null, warmCache: COLD,
  }));
  s.repos.push(...repos);
  s.installations.push({ installationId: a.installationId, account: a.account, accountType: "Organization", status: "active", repositorySelection: "selected", linkedAt: NOW.toISOString(), repositories: repos.length });
}

const stores = new Map<string, Store>();
function store(): Store {
  const org = activeOrgId() ?? "org_northwind";
  let s = stores.get(org);
  if (!s) {
    // The two organizations the sample account belongs to have runs; an organization made in this tab starts empty.
    s = org === "org_northwind" ? buildSample(NORTHWIND) : org === "org_harbor" ? buildSample(HARBOR) : emptyStore(mockOrgName() ?? "Acme");
    for (const a of addedInstalls().filter((x) => x.org === org)) applyInstall(s, a);
    stores.set(org, s);
  }
  return s;
}

// ---------------------------------------------------------------- the running run

const STAGES = [0.2, 0.5, 0.85, 1];

/** The running run as the API shows it at its stage: counts so far and the runner's latest progress record. */
function runningView(l: Live): Run {
  const f = l.final;
  const share = STAGES[Math.min(l.stage, STAGES.length - 1)];
  const done = Math.round(f.tests.ran * share);
  const spec = specOf(f.projectId)!;
  const ranList = [...l.finalDetail.ran];
  const m = suite(spec)[ranList[Math.min(ranList.length - 1, Math.floor(share * ranList.length))]];
  const progress: RunProgress = {
    phase: l.stage >= 3 ? "reporting" : "testing",
    testsTotal: f.tests.total, testsDone: f.tests.skippedWithProof + done, passed: done, failed: 0, skippedWithProof: f.tests.skippedWithProof,
    currentTest: l.stage >= 3 ? null : (m?.tests[Math.floor(m.tests.length / 2)] ?? null),
    elapsedMs: 150_000 + l.stage * 15_000, updatedAt: new Date(NOW.getTime() + l.stage * 15_000).toISOString(),
  };
  return {
    ...f, status: "running", finishedAt: null, durationMs: progress.elapsedMs,
    tests: { total: f.tests.total, ran: done, passed: done, failed: 0, skippedWithProof: f.tests.skippedWithProof, flakyDefects: 0, notProven: 0 },
    testTimeMs: { ran: 0, skipped: 0 }, skipShare: 0, minutesSaved: 0, otherStepMinutes: 0, githubEquivalentMinutes: 0, audit: { rerun: 0, wrongSkips: 0 }, progress,
    // The proof and the exit code exist only once the run finished.
    proof: null, exitCode: null, notProvenReason: null,
  };
}

/** Each second question of the live view moves the run on; after the last stage it has finished and passed. */
function advance(s: Store) {
  const l = s.live;
  if (!l) return;
  l.calls++;
  if (l.calls % 2 !== 0) return;
  l.stage++;
  const i = s.runs.findIndex((x) => x.id === l.runId);
  if (i < 0) return;
  if (l.stage < STAGES.length) {
    s.runs[i] = runningView(l);
    return;
  }
  s.runs[i] = l.final;
  s.detail.set(l.runId, l.finalDetail);
  s.events.push({ projectId: l.final.projectId, occurredAt: l.final.finishedAt!, billable: true, baselineMinutes: l.final.githubEquivalentMinutes });
  s.live = { ...l, runId: "" };
}

const etagOf = (r: Run) => `W/"${r.id}-${r.status}-${r.progress?.updatedAt ?? r.finishedAt ?? ""}"`;

// ---------------------------------------------------------------- per-test detail, built when a run is opened

function specOf(projectId: string): Spec | undefined {
  return SPECS.find((s) => s.id === projectId);
}

function testsOf(run: Run): TestResult[] {
  const spec = specOf(run.projectId);
  const d = store().detail.get(run.id);
  if (!spec || !d || run.status === "running") return [];
  const failures = new Map(d.failures.map((f) => [f.testId, f]));
  const notProven = new Map((d.notProven ?? []).map((x) => [x.testId, x.cause]));
  const unsent = new Set(d.unsent ?? []);
  const defects = store().defects;
  const out: TestResult[] = [];
  suite(spec).forEach((m, i) => {
    const ran = d.ran.has(i);
    m.tests.forEach((testId, j) => {
      if (unsent.has(testId)) return;
      const f = failures.get(testId);
      const defect = f?.defectId ? defects.find((x) => x.id === f.defectId) : null;
      const r = rng(hash(`${run.id}:${testId}`));
      const np = !f && notProven.has(testId);
      out.push({
        runId: run.id, testId, file: m.file,
        outcome: f ? "failed" : np ? "not_proven" : ran ? "passed" : "skipped_with_proof",
        durationMs: Math.round(m.durations[j] * (ran ? spec.overhead * (0.85 + r() * 0.3) : 1)),
        failure: f
          ? defect
            ? { kind: "flaky_defect", phase: defect.exception.phase, exceptionType: defect.exception.type, message: defect.exception.message, location: defect.exception.location, defectId: defect.id }
            : { kind: "real", phase: "call", exceptionType: "AssertionError", message: realFailure(testId, r), location: `${m.file}:${20 + Math.floor(r() * 400)}`, defectId: null }
          : null,
        receiptId: ran || f ? null : `rcp_${run.id}_${i}_${j}`,
        notProvenCause: np ? (notProven.get(testId) ?? null) : null,
      });
    });
  });
  return out;
}

function realFailure(testId: string, r: () => number): string {
  const name = testId.split(/::|\.|>/).pop()?.trim() ?? "value";
  return pick(r, [`assert response.status_code == 200 (got 500) in ${name}`, `AssertionError: expected 3 items, got 2`, `TypeError: cannot read properties of undefined (reading 'id')`, `assert total == Decimal("12.40")`]);
}

function receiptOf(id: string): SkipReceipt | null {
  const m = /^rcp_(run_[a-z]+_\d+)_(\d+)_(\d+)$/.exec(id);
  if (!m) return null;
  const s = store();
  const run = s.runs.find((r) => r.id === m[1]);
  const spec = run && specOf(run.projectId);
  if (!run || !spec) return null;
  const mi = Number(m[2]);
  const ti = Number(m[3]);
  const mod = suite(spec)[mi];
  const testId = mod?.tests[ti];
  if (!testId) return null;
  // The run it reuses: the latest earlier run of the project where this file ran and passed.
  const earlier = s.runs.filter((r) => r.projectId === run.projectId && r.startedAt < run.startedAt && r.status === "passed");
  const reused = earlier.find((r) => s.detail.get(r.id)?.ran.has(mi)) ?? earlier[earlier.length - 1] ?? null;
  const r = rng(hash(id));
  const pkg = spec.language === "python" ? mod.file.replace(/^tests\//, "").replace(/\/test_[^/]+$/, "").replace(/^storefront\/([^/]+)\/tests.*/, "storefront/$1") : mod.file.replace(/\/src\/__tests__.*/, "/src");
  const source = spec.language === "python" ? (pkg.startsWith("storefront") ? pkg : `homehub/${pkg}`) : pkg;
  const names = ["setup_entry", "async_update", "_handle_message", "build_payload", "validate", "resolve", "load", "apply"];
  const n = 3 + Math.floor(r() * 6);
  const code = Array.from({ length: n }, (_, k) => {
    const file = spec.language === "python" ? `${source}/${pick(r, ["__init__", "entity", "const", "helpers", "models", "views"])}.py` : spec.language === "go" ? `${mod.file}/${pick(r, ["db", "head", "query", "encode"])}.go` : `${source}/${pick(r, ["index", "utils", "config"])}.ts`;
    const q = spec.language === "python" ? pick(r, names) : spec.language === "go" ? pick(r, ["Append", "Select", "Encode", "Compact"]) : pick(r, ["resolve", "normalize", "load", "render"]);
    return { path: file, qualname: q, digest: hex(`${id}:u${k}`) };
  });
  const modules = [
    { path: mod.file, kind: "skeleton" as const, digest: hex(`${id}:s0`) },
    ...(spec.language === "python" ? [{ path: `${mod.file.split("/").slice(0, -1).join("/")}/conftest.py`, kind: "hooks" as const, digest: hex(`${id}:h0`) }] : []),
    { path: spec.language === "python" ? "pyproject.toml" : spec.language === "go" ? "go.mod" : "package.json", kind: "content" as const, digest: hex(`${id}:c0`) },
  ];
  const filesRead = Array.from({ length: Math.floor(r() * 4) }, (_, k) => ({
    path: spec.language === "python" ? `${mod.file.split("/").slice(0, -1).join("/")}/fixtures/${pick(r, ["config", "payload", "state", "device"])}_${k}.json` : `${mod.file.split("/").slice(0, -1).join("/")}/__fixtures__/${pick(r, ["doc", "sidebar", "site"])}${k}.md`,
    dep: `f:${hex(`${id}:f${k}`)}`,
  }));
  if (r() < 0.3) filesRead.push({ path: spec.language === "python" ? "/etc/localtime" : "/tmp/fenvix-cache", dep: r() < 0.5 ? "missing" : `d:${hex(`${id}:d`)}` });
  const envRead = spec.env.filter(() => r() < 0.6).map((name) => ({ name, digest: name === "PYTHONASYNCIODEBUG" ? "-" : hex(`${id}:e:${name}`) }));
  return {
    id, runId: run.id, testId, cacheKey: hex(`${id}:key`), reusedRunId: reused?.id ?? null, reusedEngineRunId: reused?.engineRunId ?? "20260920T091500-4412",
    reusedRunNumber: reused?.number ?? null, reusedOutcome: "passed", fingerprint: hex(`${spec.id}:${testId}:fp`), reusedDurationMs: mod.durations[ti],
    code, modules, filesRead, envRead,
    runtime: { digest: hex(`${spec.id}:runtime`), interpreter: spec.interpreter, system: "Linux", machine: "x86_64", libc: "glibc 2.39", distributions: spec.language === "python" ? 412 : spec.language === "node" ? 1186 : 64 },
    config: { digest: hex(`${spec.id}:config`), runner: spec.runner, engine: run.engineVersion, inifile: spec.language === "python" ? "pyproject.toml" : spec.language === "node" ? "vitest.config.ts" : "go.mod", options: spec.language === "python" ? "--det --det-cache=/cache -p no:randomly" : "--det" },
    changedFilesProven: Math.floor(r() * 9),
  };
}

// ---------------------------------------------------------------- the mock "server"

const mockError = (code: string, status: number, message: string, field?: string) => new ApiError(code, message, status, field);

const wait = <T,>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 90));
const copy = <T,>(v: T): T => structuredClone(v);

function plans(): Plan[] {
  const s = store();
  return PLANS.map((p) => ({ ...p, features: [...p.features], current: p.kind === "plan" ? p.id === s.planId : s.addons.includes(p.id) }));
}
const currentPlan = () => plans().find((p) => p.kind === "plan" && p.current) ?? null;
const trial = () => trialFrom(store().trial, store().runs, store().events, NOW);

function filterRuns(projectId: string, q: RunQuery): Run[] {
  const s = store();
  const project = s.projects.find((p) => p.id === projectId);
  return s.runs.filter(
    (r) =>
      r.projectId === projectId &&
      (!q.since || r.startedAt >= q.since) &&
      (q.scope === "pr" ? r.pullRequest !== null : q.scope === "default" ? r.branch === project?.defaultBranch : true) &&
      (q.status === "passed" || q.status === "failed" || q.status === "not_proven" ? r.status === q.status : true),
  );
}

function defectsFor(q: { projectId?: string; state?: "open" | "fixed" | "all" } = {}): Defect[] {
  return store()
    .defects.filter((d) => (!q.projectId || d.projectId === q.projectId) && (q.state === "all" ? true : d.state === (q.state ?? "open")))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

/**
 * sessionStorage "fenvix-mock-api" = "before-proof": the mock answers as the API did before console proof (no proof,
 * no not-proven counts, no Overview proof block, no GET /search), so a check can show the console still works against
 * it (src/data/compat.ts).
 */
function olderApi(): boolean {
  try {
    return sessionStorage.getItem("fenvix-mock-api") === "before-proof";
  } catch {
    return false;
  }
}
type Loose = Record<string, unknown>;
function oldRun<T>(r: T): T {
  if (!olderApi()) return r;
  const { proof: _p, exitCode: _e, ...rest } = r as Loose;
  const { notProven: _n, ...tests } = rest.tests as Loose;
  return { ...rest, tests } as T;
}
function oldShape<T>(v: T, strip: (x: Loose) => Loose): T {
  return olderApi() ? (strip(v as Loose) as T) : v;
}

/** Every live-view question, for the checks (polling must stop once the run has finished). */
let liveCount = 0;

/** The mock as the API: the DataClient, and for the checks the number of live-view questions so far. */
export const mockClient: DataClient & { liveCalls(): number } = {
  now: () => NOW,
  sample: true,
  liveCalls: () => liveCount,

  getOverview() {
    const s = store();
    const o = copy(overviewFrom(s.projects, s.runs, s.defects, currentPlan(), RATE, NOW, s.events, trial()));
    return wait(oldShape(o, ({ proof: _p, projects, ...rest }) => ({ ...rest, projects: (projects as Loose[]).map(({ lastRunNotProven: _l, ...p }) => p) })));
  },

  listProjects() {
    const s = store();
    return wait(copy(s.projects.map((p) => oldShape(projectRow(p, s.runs, s.defects, NOW), ({ lastRunNotProven: _l, ...p }) => p))));
  },
  getProject(id) {
    const s = store();
    const p = s.projects.find((x) => x.id === id);
    return wait(p ? copy(projectRow(p, s.runs, s.defects, NOW)) : null);
  },
  async saveProjectSettings(id, settings) {
    assertMockCanManage();
    const s = store();
    const p = s.projects.find((x) => x.id === id);
    if (!p) throw mockError("not_found", 404, "That project does not exist.");
    if (settings.testCommand.length > 500) throw mockError("validation_failed", 400, "Use at most 500 characters for the test command.", "testCommand");
    p.settings = { ...settings, testCommand: settings.testCommand.trim() };
    return wait(copy(p));
  },
  listRuns(projectId, q = {}) {
    if (olderApi() && q.status === "not_proven") return Promise.reject(mockError("validation_failed", 400, "status must be one of all, passed, failed.", "status"));
    const rows = filterRuns(projectId, q);
    if (q.since) return wait<Page<Run>>(copy({ items: rows.map(oldRun), total: rows.length, page: 1, pageSize: rows.length }));
    const { page = 1, pageSize = 25 } = q;
    return wait<Page<Run>>(copy({ items: rows.slice((page - 1) * pageSize, page * pageSize).map(oldRun), total: rows.length, page, pageSize }));
  },
  getSkipShareSeries(projectId, days) {
    const from = dayStart(new Date(NOW.getTime() - (days - 1) * DAY));
    const byDay = new Map<string, number[]>();
    for (const r of store().runs) {
      if (r.projectId !== projectId || r.startedAt < from.toISOString() || !finished(r)) continue;
      const k = dayStart(new Date(r.startedAt)).toISOString();
      (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(r.skipShare);
    }
    const out = [];
    for (let t = from.getTime(); t <= NOW.getTime(); t += DAY) {
      const k = new Date(t).toISOString();
      const v = byDay.get(k) ?? [];
      out.push({ at: k, value: median(v) ?? 0, runs: v.length });
    }
    return wait(out);
  },
  getAudit(projectId, days) {
    const s = store();
    const from = new Date(NOW.getTime() - days * DAY);
    return wait(copy(auditFrom(s.runs.filter((r) => r.projectId === projectId), s.reruns.filter((x) => s.runs.find((r) => r.id === x.runId)?.projectId === projectId), from, NOW)));
  },
  getSetupChange(projectId) {
    const p = store().projects.find((x) => x.id === projectId);
    if (!p) return Promise.reject(mockError("not_found", 404, "That project does not exist."));
    return wait(setupChange(p));
  },

  getRun(id) {
    const s = store();
    const run = s.runs.find((r) => r.id === id);
    const project = run && s.projects.find((p) => p.id === run.projectId);
    return wait<RunDetail | null>(run && project ? copy({ run: oldRun(run), project }) : null);
  },
  getRunLive(id, etag) {
    liveCount++;
    const s = store();
    if (s.live?.runId === id) advance(s);
    const run = s.runs.find((r) => r.id === id);
    const project = run && s.projects.find((p) => p.id === run.projectId);
    if (!run || !project) return Promise.reject(mockError("not_found", 404, "That run does not exist."));
    const tag = etagOf(run);
    return wait<RunLive>(etag === tag ? { notModified: true } : { notModified: false, detail: copy({ run: oldRun(run), project }), etag: tag });
  },
  listTestResults(runId, q = {}) {
    const run = store().runs.find((r) => r.id === runId);
    const all = run ? testsOf(run) : [];
    const counts: Record<TestOutcome, number> = { passed: 0, failed: 0, skipped_with_proof: 0, not_proven: 0 };
    for (const t of all) counts[t.outcome]++;
    const term = q.search?.trim().toLowerCase() ?? "";
    // Failures first, then the tests not proven, then the tests that ran, then the skipped ones.
    const rank: Record<TestOutcome, number> = { failed: 0, not_proven: 1, passed: 2, skipped_with_proof: 3 };
    const rows = all.filter((t) => (!q.outcome || q.outcome === "all" || t.outcome === q.outcome) && (!term || t.testId.toLowerCase().includes(term))).sort((a, b) => rank[a.outcome] - rank[b.outcome]);
    const { page = 1, pageSize = 50 } = q;
    if (olderApi() && q.outcome === "not_proven") return Promise.reject(mockError("validation_failed", 400, "outcome must be one of all, passed, failed, skipped_with_proof.", "outcome"));
    // The run's own counts (as the API's come from the run row), and the per-test rows the filters list.
    const own = run ? { passed: run.tests.passed, failed: run.tests.failed, skipped_with_proof: run.tests.skippedWithProof, not_proven: run.tests.notProven } : counts;
    const out: TestPage = { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, counts: all.length ? own : counts, rowCounts: counts };
    return wait<TestPage>(oldShape(out, (x) => {
      const { not_proven: _n, ...c } = x.counts as Loose;
      return { ...x, counts: c };
    }));
  },
  getSkipReceipt: (id) => wait(receiptOf(id)),
  listRunFiles(runId) {
    const s = store();
    const run = s.runs.find((r) => r.id === runId);
    const spec = run && specOf(run.projectId);
    const d = s.detail.get(runId);
    if (!run || !spec || !d || run.status === "running") return wait<RunFile[]>([]);
    const failed = new Set(d.failures.map((f) => fileOf(f.testId)));
    return wait<RunFile[]>(
      suite(spec).map((m, i) => {
        const nFailed = failed.has(m.file) ? d.failures.filter((f) => fileOf(f.testId) === m.file).length : 0;
        const ran = d.ran.has(i) || nFailed > 0;
        return { file: m.file, tests: m.tests.length, ran: ran ? m.tests.length - nFailed : 0, skipped: ran ? 0 : m.tests.length, failed: nFailed };
      }),
    );
  },
  listExplorations: (projectId) => wait(copy(store().explorations.filter((e) => e.projectId === projectId))),
  listActivity(projectId, limit = 8) {
    const s = store();
    const keep = <T extends { projectId: string }>(xs: T[]) => (projectId ? xs.filter((x) => x.projectId === projectId) : xs);
    return wait<ActivityItem[]>(activityFrom(keep(s.projects.map((p) => ({ ...p, projectId: p.id }))), keep(s.runs), keep(s.defects), keep(s.explorations), limit));
  },

  search(q) {
    if (olderApi()) return Promise.reject(mockError("not_found", 404, "Not found."));
    const s = store();
    return wait<SearchResult[]>(searchFrom(s.projects, s.runs, s.defects, q));
  },

  listDefects: (q) => wait(copy(defectsFor(q))),
  listDefectFamilies: (q) => wait(copy(familiesOf(defectsFor(q)))),
  getDefect: (id) => wait(copy(store().defects.find((d) => d.id === id) ?? null)),

  listUsageMonths() {
    const months = [...new Set(store().runs.map((r) => monthOf(r.startedAt)))].sort().reverse();
    return wait(months.length ? months : [monthOf(NOW)]);
  },
  getUsage(month) {
    const s = store();
    return wait(copy(usageFrom(month, s.projects, s.runs, currentPlan(), RATE, s.events)));
  },
  async exportUsage(month) {
    const s = store();
    const report = usageFrom(month, s.projects, s.runs, currentPlan(), RATE, s.events);
    return wait({ filename: usageCsvName(month), mimeType: "text/csv", downloadUrl: blobUrl(usageCsv(report), "text/csv") });
  },

  listPlans: () => wait(plans()),
  getBilling() {
    const s = store();
    return wait(copy(billingFrom(plans(), s.projects, s.events, trial(), NOW)));
  },

  getGitHubConnection() {
    const s = store();
    return wait(copy({ account: s.installations.find((i) => i.status === "active")?.account ?? null, installations: s.installations }));
  },
  listGitHubRepositories() {
    const s = store();
    // The App works through the queue: a queued setup pull request is open a couple of questions later.
    for (const [id, left] of [...s.queued]) {
      if (left > 1) {
        s.queued.set(id, left - 1);
        continue;
      }
      s.queued.delete(id);
      const repo = s.repos.find((x) => x.repositoryId === id);
      if (!repo) continue;
      const number = 100 + (hash(repo.fullName) % 900);
      Object.assign(repo, {
        onboardingState: "pr_open", setupPullRequest: { number, url: `https://github.com/${repo.fullName}/pull/${number}`, state: "open" },
        onboardingDetail: `Pull request #${number} changes the test job to runs-on: fenvix. Merge it and the next test run goes to fenvix.`,
      } satisfies Partial<GitHubRepository>);
    }
    return wait(copy(s.repos));
  },
  async createInstallLink() {
    assertMockCanManage();
    const s = store();
    const org = activeOrgId() ?? "org_northwind";
    const added: AddedInstall = { org, installationId: 70_000_000 + addedInstalls().length + s.installations.length + 1, account: s.nextAccount };
    try {
      sessionStorage.setItem(INSTALLS_KEY, JSON.stringify([...addedInstalls(), added]));
    } catch {
      /* memory only */
    }
    applyInstall(s, added);
    // Stands in for GitHub and the App's setup step, which sends the browser back here to complete the link.
    return wait(`${window.location.origin}/projects/connect?github=confirm&installation=${added.installationId}&account=${encodeURIComponent(added.account)}#completion=mock-${added.installationId}`);
  },
  async completeGitHubInstall(completion) {
    const added = addedInstalls().find((a) => `mock-${a.installationId}` === completion);
    if (!added) throw mockError("not_found", 404, "This GitHub connection link is not valid for your account: it was started by another fenvix account, has already been used, or has expired. Nothing was connected. Ask for a new link from the Connect page of your own organization.");
    return wait({ organizationId: added.org, installationId: added.installationId, account: added.account });
  },
  async openSetupPullRequest(repositoryId) {
    assertMockCanManage();
    const s = store();
    const repo = s.repos.find((x) => x.repositoryId === repositoryId && !x.removed);
    if (!repo) throw mockError("not_found", 404, "That repository is not given to the fenvix GitHub App.");
    const inst = s.installations.find((i) => i.installationId === repo.installationId);
    if (inst && inst.status !== "active") throw mockError("conflict", 409, `The fenvix GitHub App is ${inst.status} on ${inst.account}: unsuspend it on GitHub first.`);
    if (!["pending", "closed", "failed"].includes(repo.onboardingState)) throw mockError("conflict", 409, "This repository needs no setup pull request.");
    s.queued.set(repositoryId, 2);
    return wait(copy(repo));
  },

  getOnboardingKind: () => wait({ kind: store().onboardingKind ?? "move", sideBySideAvailable: true }),
  async setOnboardingKind(kind) {
    assertMockCanManage();
    store().onboardingKind = kind;
    return wait({ kind });
  },

  getSettings: () => wait({ ...store().settings, workspaceName: mockOrgName() ?? store().settings.workspaceName }),
  async saveSettings(next) {
    assertMockCanManage();
    if (next.region !== "us" && next.region !== "eu") throw mockError("validation_failed", 400, "Choose a region: us or eu.", "region");
    store().settings = { ...next };
    return wait({ ...store().settings, workspaceName: mockOrgName() ?? next.workspaceName });
  },
};
