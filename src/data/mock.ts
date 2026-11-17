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
 */
import { assertMockCanManage, mockOrgName, mockRole } from "./orgs-mock";
import { activeOrgId } from "../lib/org";
import type { DataClient, RunQuery } from "./client";
import type {
  Baseline, Defect, DefectCause, GitHubRate, GitHubRepository, Language, Page, Plan, Project, Run, RunTrigger, Settings,
  SetupPullRequest, SkipReceipt, TestOutcome, TestPage, TestResult, TestRunner,
} from "./types";
import { ExplorerError } from "./explorer";
import { MAX_ACTIVE_KEYS, PAGE_LIMIT, keyStatus, nameProblem, type PublicApiKey } from "./public-keys";
import { billingFrom, dayStart, familiesOf, familyKeyOf, median, monthOf, overviewFrom, projectRow, setupChange, usageCsv, usageCsvName, usageFrom } from "./ci";
import { blobUrl } from "./files";

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
    fullTestMs: 410_000, overhead: 2.13, setupMs: 9_000, runsPerWeekday: 24, skip: mixture(0.975, 0.03, 0.18, 0.55), failRate: 0.05,
    baseline: { medianTimeToGreenS: 417, medianJobMinutes: 8.8, runsSampled: 400, from: "2026-08-01", to: "2026-08-31" }, connectedDaysAgo: 80, firstRunNumber: 3104,
    modulePath: (i, r) => `tests/components/${HA[i % HA.length]}/test_${pick(r, ["init", "config_flow", "sensor", "light", "switch", "binary_sensor", "climate", "diagnostics", "services", "coordinator"])}_${i}.py`,
    testName: (file, j, r) => `${file}::${pick(r, HA_TESTS)}_${j}`,
    env: ["TZ", "HOME", "HOMEHUB_TEST_DB_URL", "PYTHONASYNCIODEBUG"], interpreter: "python 3.12.7", runner: "pytest 8.3.3",
  },
  {
    id: "prj_docs", fullName: "northwind/docs-site", language: "node", testRunner: "vitest", testCount: 3199, moduleCount: 202,
    fullTestMs: 29_500, overhead: 1.55, setupMs: 4_000, runsPerWeekday: 13, skip: mixture(0.985, 0.02, 0.2, 0.5), failRate: 0.03,
    baseline: { medianTimeToGreenS: 30, medianJobMinutes: 1.5, runsSampled: 260, from: "2026-08-01", to: "2026-08-31" }, connectedDaysAgo: 70, firstRunNumber: 1408,
    modulePath: (i, r) => `packages/${DOCS[i % DOCS.length]}/src/__tests__/${pick(r, ["utils", "index", "config", "routes", "sidebars", "versions", "markdown", "i18n", "slug", "toc"])}${i}.test.ts`,
    testName: (file, j, r) => `${file} > ${pick(r, ["parse", "load", "render", "resolve", "normalize"])} > ${pick(r, DOCS_TESTS)} ${j}`,
    env: ["NODE_ENV", "CI", "DOCUSAURUS_SITE_URL"], interpreter: "node 22.11.0", runner: "vitest 2.1.4",
  },
  {
    id: "prj_ledger", fullName: "northwind/ledger", language: "go", testRunner: "go test", testCount: 28526, moduleCount: 90,
    fullTestMs: 132_000, overhead: 1.0, setupMs: 8_000, runsPerWeekday: 9, skip: (r) => (r() < 0.15 ? r() * 0.15 : 0.25 + r() * 0.31), failRate: 0.04,
    baseline: { medianTimeToGreenS: 135, medianJobMinutes: 5.6, runsSampled: 180, from: "2026-08-01", to: "2026-08-31" }, connectedDaysAgo: 64, firstRunNumber: 922,
    modulePath: (i) => `${GO[i % GO.length]}${i >= GO.length ? `/part${Math.floor(i / GO.length)}` : ""}`,
    testName: (file, j, r) => `${file}.${pick(r, GO_TESTS)}/case_${j}`,
    env: ["GOFLAGS", "TZ"], interpreter: "go 1.23.3", runner: "go test",
  },
  {
    id: "prj_storefront", fullName: "northwind/storefront", language: "python", testRunner: "pytest", testCount: 1721, moduleCount: 112,
    fullTestMs: 285_000, overhead: 2.8, setupMs: 14_000, runsPerWeekday: 7, skip: (r) => (r() < 0.86 ? 0 : 0.35 + r() * 0.4), failRate: 0.08,
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

// ---------------------------------------------------------------- the sample organization

interface Store {
  projects: Project[];
  runs: Run[];
  /** Per run: the test files that ran, and the failed tests. */
  detail: Map<string, { ran: Set<number>; failures: { testId: string; defectId: string | null }[] }>;
  defects: Defect[];
  githubAccount: string | null;
  repos: GitHubRepository[];
  planId: string;
  settings: Settings;
  apiKeys: PublicApiKey[];
  installations: Map<number, string[]>;
}

const RATE: GitHubRate = { usdPerMinute: 0.008, runner: "GitHub-hosted Linux, 2 cores", source: "GitHub Actions pricing page, as quoted in PRODUCT.md (to verify)", checkedOn: "2026-11-16" };

const PLANS: Omit<Plan, "current">[] = [
  { id: "starter", name: "Starter", description: "One project with a steady flow of pull requests.", runsPerMonth: 500, maxProjects: 1, priceUsdMonth: null, features: ["Skip with proof", "Flaky tests turned into defects", "Pull request comments"] },
  { id: "team", name: "Team", description: "A few projects, a team pushing every day.", runsPerMonth: 2000, maxProjects: 5, priceUsdMonth: null, features: ["Everything in Starter", "Nightly exploration", "Members and roles"] },
  { id: "scale", name: "Scale", description: "Many projects or a large monorepo.", runsPerMonth: 10000, maxProjects: 25, priceUsdMonth: null, features: ["Everything in Team", "Priority machines", "Audit log"] },
  { id: "enterprise", name: "Enterprise", description: "Your own limits, agreed with us.", runsPerMonth: null, maxProjects: null, priceUsdMonth: null, features: ["Everything in Scale", "Single sign-on", "Agreed response time"] },
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

function moduleIndexOf(spec: Spec, testId: string): number {
  const file = fileOf(testId);
  const modules = suite(spec);
  const i = modules.findIndex((m) => m.file === file);
  return i;
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

function buildSample(owner: string, orgName: string, planId: string): Store {
  const nameOf = (s: Pick<Spec, "fullName">) => `${owner}/${s.fullName.split("/")[1]}`;
  const runs: Run[] = [];
  const detail: Store["detail"] = new Map();
  const occurrences = new Map<string, Run[]>();
  const projects: Project[] = SPECS.map((s) => ({
    id: s.id, fullName: nameOf(s), language: s.language, testRunner: s.testRunner, defaultBranch: "main", installationId: 51_204_331,
    setupState: "active", setupPullRequest: { number: { prj_homehub: 18204, prj_docs: 10433, prj_ledger: 4412, prj_storefront: 16031 }[s.id]!, url: `https://github.com/${nameOf(s)}/pull/${{ prj_homehub: 18204, prj_docs: 10433, prj_ledger: 4412, prj_storefront: 16031 }[s.id]}`, state: "merged" },
    connectedAt: ago(s.connectedDaysAgo * DAY), baseline: s.baseline,
    settings: { skipWithProof: true, commentOnPullRequests: true, nightlyExploration: s.id !== "prj_ledger", testCommand: "" },
  }));

  for (const spec of SPECS) {
    ensureDefectFiles(spec);
    const modules = suite(spec);
    const total = modules.reduce((a, m) => a + m.tests.length, 0);
    const r = rng(hash(`runs:${spec.id}`));
    const start = Math.min(HISTORY_DAYS, spec.connectedDaysAgo - 1);
    let number = spec.firstRunNumber;
    let pr = { prj_homehub: 129_400, prj_docs: 11_020, prj_ledger: 15_300, prj_storefront: 17_800 }[spec.id]!;
    const projectDefects = DEFECT_SEEDS.filter((d) => d.projectId === spec.id);
    for (let d = start; d >= 0; d--) {
      const dayAt = dayStart(new Date(NOW.getTime() - d * DAY));
      const weekday = dayAt.getUTCDay() % 6 !== 0;
      const n = Math.round(spec.runsPerWeekday * (weekday ? 0.8 + r() * 0.4 : 0.25 + r() * 0.2));
      // Spread across working hours (UTC 07 to 20), sorted, and never in the future.
      const times = Array.from({ length: n }, () => dayAt.getTime() + (7 + r() * 13) * HOUR).filter((t) => t < NOW.getTime() - 20 * MIN).sort((a, b) => a - b);
      let lastSha = "";
      let lastFailed = false;
      for (const t of times) {
        const rerun = lastFailed && r() < 0.55;
        const sha = rerun ? lastSha : hex(`${spec.id}:${number}`, 40);
        const trigger: RunTrigger = rerun ? "pull_request" : r() < 0.58 ? "pull_request" : r() < 0.85 ? "push" : r() < 0.6 ? "merge_group" : "workflow_dispatch";
        const prNumber = trigger === "pull_request" ? (rerun ? pr : ++pr) : null;
        const skipShare = spec.skip(r);
        const failing = r() < spec.failRate;
        const open = projectDefects.filter((x) => x.firstDaysAgo >= d && (x.fixedDaysAgo === undefined || x.fixedDaysAgo < d));
        const defect = failing && open.length && r() < 0.6 ? pick(r, open) : null;
        const force = defect ? [moduleIndexOf(spec, defect.testId)] : [];
        const seed = hash(`${spec.id}#${number}`);
        const ran = ranModules(spec, seed, skipShare, force.filter((i) => i >= 0));
        let ranTests = 0;
        let ranMs = 0;
        for (const i of ran) {
          ranTests += modules[i].tests.length;
          ranMs += modules[i].timeMs;
        }
        const failures: { testId: string; defectId: string | null }[] = [];
        if (defect) failures.push({ testId: defect.testId, defectId: defect.id });
        else if (failing) {
          const ranList = [...ran];
          const k = 1 + Math.floor(r() * 3);
          for (let f = 0; f < k; f++) {
            const m = modules[pick(r, ranList)];
            const id = pick(r, m.tests);
            if (!failures.some((x) => x.testId === id)) failures.push({ testId: id, defectId: null });
          }
        }
        const skippedMs = Math.max(0, spec.fullTestMs - ranMs);
        const durationMs = Math.round(spec.setupMs + ranMs * spec.overhead * (0.9 + r() * 0.2));
        const queuedMs = 4_000 + r() * 20_000;
        const pushedAt = new Date(t - queuedMs);
        const status = failures.length ? "failed" : "passed";
        const id = `run_${spec.id.slice(4)}_${number}`;
        const run: Run = {
          id, projectId: spec.id, number, engineRunId: `${new Date(t).toISOString().replace(/[-:]/g, "").slice(0, 15)}-${1000 + (hash(id) % 8999)}`,
          commitSha: sha, commitMessage: `${pick(r, COMMIT_WORDS)} ${pick(r, COMMIT_THINGS[spec.id])}`,
          branch: trigger === "pull_request" ? `${pick(r, ["fix", "feat", "chore", "agent"])}/${hex(`${sha}b`, 6)}` : trigger === "merge_group" ? `gh-readonly-queue/main/pr-${pr}` : "main",
          pullRequest: prNumber, trigger, status, pushedAt: pushedAt.toISOString(), startedAt: new Date(t).toISOString(),
          finishedAt: new Date(t + durationMs).toISOString(), durationMs,
          tests: { total, ran: ranTests, passed: ranTests - failures.length, failed: failures.length, skippedWithProof: total - ranTests, flakyDefects: failures.filter((x) => x.defectId).length },
          testTimeMs: { ran: ranMs, skipped: skippedMs },
          skipShare: Math.round((skippedMs / (ranMs + skippedMs)) * 10000) / 10000,
          minutesSaved: Math.round((skippedMs / MIN) * 100) / 100,
          githubEquivalentMinutes: spec.baseline.medianJobMinutes,
          engineVersion: spec.language === "node" ? "detjs 0.1.0" : spec.language === "go" ? "detgo 0.1.0" : "detpy 0.1.0",
          seed: seed % 100,
        };
        runs.push(run);
        detail.set(id, { ran, failures });
        if (defect) (occurrences.get(defect.id) ?? occurrences.set(defect.id, []).get(defect.id)!).push(run);
        lastSha = sha;
        lastFailed = status === "failed";
        number++;
      }
    }
  }

  const defects: Defect[] = DEFECT_SEEDS.map((s) => {
    const seen = occurrences.get(s.id) ?? [];
    const spec = SPECS.find((p) => p.id === s.projectId)!;
    const runsN = 10;
    return {
      id: s.id, projectId: s.projectId, projectName: nameOf(spec), testId: s.testId, status: s.status ?? "reproduced", state: s.fixedDaysAgo !== undefined ? "fixed" : "open",
      cause: s.cause, causeTests: s.causeTests, minimalOrder: s.cause === "polluter" ? [...s.causeTests, s.testId] : [s.testId], prefixLength: s.prefixLength,
      seed: s.seed, fingerprint: hex(`fp:${s.id}`), replays: { runs: runsN, fails: 10, identicalFingerprint: s.status !== "replay_unstable" },
      outcome: s.outcome, exception: s.exception, divergence: s.divergence, familyKey: familyKeyOf(s.causeTests),
      firstSeenAt: seen[0]?.startedAt ?? ago(s.firstDaysAgo * DAY), lastSeenAt: seen[seen.length - 1]?.startedAt ?? ago(s.firstDaysAgo * DAY),
      firstRunId: seen[0]?.id ?? null, lastRunId: seen[seen.length - 1]?.id ?? null, occurrences: Math.max(1, seen.length),
      engineVersion: spec.language === "node" ? "detjs 0.1.0" : "detpy 0.1.0", language: spec.language === "node" ? "node" : "python", testRunner: spec.testRunner,
    };
  });

  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return {
    projects, runs, detail, defects, githubAccount: owner,
    repos: [
      ...projects.map((p) => ({ fullName: p.fullName, private: true, language: p.language, testRunner: p.testRunner, connected: true })),
      { fullName: `${owner}/billing-worker`, private: true, language: "python", testRunner: "pytest", connected: false },
      { fullName: `${owner}/mobile-app`, private: true, language: "node", testRunner: "jest", connected: false },
      { fullName: `${owner}/infra-scripts`, private: false, language: "python", testRunner: "pytest", connected: false },
    ],
    planId,
    settings: { workspaceName: orgName, emailNotices: true },
    apiKeys: seedKeys(),
    installations: new Map(),
  };
}

/** Another organization: nothing connected yet, so its dashboard starts with "Connect a project". */
function emptyStore(name: string): Store {
  return {
    projects: [], runs: [], detail: new Map(), defects: [], githubAccount: null,
    repos: [
      { fullName: `${slug(name)}/api`, private: true, language: "python", testRunner: "pytest", connected: false },
      { fullName: `${slug(name)}/web`, private: true, language: "node", testRunner: "vitest", connected: false },
      { fullName: `${slug(name)}/pipelines`, private: true, language: "python", testRunner: "pytest", connected: false },
    ],
    planId: "starter", settings: { workspaceName: name, emailNotices: true }, apiKeys: [], installations: new Map(),
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "acme";

const stores = new Map<string, Store>();
function store(): Store {
  const org = activeOrgId() ?? "org_northwind";
  let s = stores.get(org);
  if (!s) {
    // The two organizations the sample account belongs to have runs; an organization made in this tab starts empty.
    s = org === "org_northwind" ? buildSample("northwind", "Northwind Cloud", "team") : org === "org_harbor" ? buildSample("harbor-analytics", "Harbor Analytics", "scale") : emptyStore(mockOrgName() ?? "Acme");
    stores.set(org, s);
  }
  return s;
}

// ---------------------------------------------------------------- per-test detail, built when a run is opened

function specOf(projectId: string): Spec | undefined {
  return SPECS.find((s) => s.id === projectId);
}

function testsOf(run: Run): TestResult[] {
  const spec = specOf(run.projectId);
  const d = store().detail.get(run.id);
  if (!spec || !d) return [];
  const failures = new Map(d.failures.map((f) => [f.testId, f]));
  const defects = store().defects;
  const out: TestResult[] = [];
  suite(spec).forEach((m, i) => {
    const ran = d.ran.has(i);
    m.tests.forEach((testId, j) => {
      const f = failures.get(testId);
      const defect = f?.defectId ? defects.find((x) => x.id === f.defectId) : null;
      const r = rng(hash(`${run.id}:${testId}`));
      out.push({
        runId: run.id, testId, file: m.file,
        outcome: f ? "failed" : ran ? "passed" : "skipped_with_proof",
        durationMs: Math.round(m.durations[j] * (ran ? spec.overhead * (0.85 + r() * 0.3) : 1)),
        failure: f
          ? defect
            ? { kind: "flaky_defect", phase: defect.exception.phase, exceptionType: defect.exception.type, message: defect.exception.message, location: defect.exception.location, defectId: defect.id }
            : { kind: "real", phase: "call", exceptionType: "AssertionError", message: realFailure(testId, r), location: `${m.file}:${20 + Math.floor(r() * 400)}`, defectId: null }
          : null,
        receiptId: ran || f ? null : `rcp_${run.id}_${i}_${j}`,
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

// ---------------------------------------------------------------- keys and settings (as before)

const later = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const seedKey = (k: Omit<PublicApiKey, "status">): PublicApiKey => ({ ...k, status: keyStatus(k, NOW) });
function seedKeys(): PublicApiKey[] {
  return [
    seedKey({ id: "0b6f2c1e-7a4d-4e1b-9c55-1f2e3d4c5b01", name: "Coding agent", role: "read_only", prefix: "fvx_Qm3xT8aL", createdAt: ago(12 * DAY), lastUsedAt: ago(3 * DAY), expiresAt: later(78 * DAY), revokedAt: null }),
    seedKey({ id: "0b6f2c1e-7a4d-4e1b-9c55-1f2e3d4c5b02", name: "Release pipeline", role: "admin", prefix: "fvx_k2Vd9PqW", createdAt: ago(41 * DAY), lastUsedAt: ago(19 * HOUR), expiresAt: null, revokedAt: null }),
    seedKey({ id: "0b6f2c1e-7a4d-4e1b-9c55-1f2e3d4c5b03", name: "Defect triage bot", role: "read_only", prefix: "fvx_7HcR0ZyN", createdAt: ago(30 * DAY), lastUsedAt: ago(4 * MIN), expiresAt: null, revokedAt: null }),
    seedKey({ id: "0b6f2c1e-7a4d-4e1b-9c55-1f2e3d4c5b04", name: "Quarterly report", role: "read_only", prefix: "fvx_bT5uE1sJ", createdAt: ago(130 * DAY), lastUsedAt: ago(40 * DAY), expiresAt: ago(10 * DAY), revokedAt: null }),
    seedKey({ id: "0b6f2c1e-7a4d-4e1b-9c55-1f2e3d4c5b05", name: "Old laptop", role: "admin", prefix: "fvx_Lw8gY4nC", createdAt: ago(200 * DAY), lastUsedAt: ago(120 * DAY), expiresAt: null, revokedAt: ago(100 * DAY) }),
  ];
}

const mockError = (code: string, status: number, message: string, field?: string) => new ExplorerError(code, message, status, field);

/** `fvx_` and 32 random bytes in base64url (43 characters), like the API's keys. */
function newPublicToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `fvx_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

const wait = <T,>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 90));
const copy = <T,>(v: T): T => structuredClone(v);

function plans(): Plan[] {
  return PLANS.map((p) => ({ ...p, features: [...p.features], current: p.id === store().planId }));
}

function filterRuns(projectId: string, q: RunQuery): Run[] {
  const s = store();
  const project = s.projects.find((p) => p.id === projectId);
  return s.runs.filter(
    (r) =>
      r.projectId === projectId &&
      (q.scope === "pr" ? r.pullRequest !== null : q.scope === "default" ? r.branch === project?.defaultBranch : true) &&
      (q.status === "passed" || q.status === "failed" ? r.status === q.status : true),
  );
}

function defectsFor(q: { projectId?: string; state?: "open" | "fixed" | "all" } = {}): Defect[] {
  return store()
    .defects.filter((d) => (!q.projectId || d.projectId === q.projectId) && (q.state === "all" ? true : d.state === (q.state ?? "open")))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export const mockClient: DataClient = {
  now: () => NOW,
  sample: true,

  getOverview() {
    const s = store();
    return wait(copy(overviewFrom(s.projects, s.runs, s.defects, plans().find((p) => p.current) ?? null, RATE, NOW)));
  },

  listProjects() {
    const s = store();
    return wait(copy(s.projects.map((p) => projectRow(p, s.runs, s.defects, NOW))));
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
    const { page = 1, pageSize = 25 } = q;
    const rows = filterRuns(projectId, q);
    return wait<Page<Run>>(copy({ items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize }));
  },
  getSkipShareSeries(projectId, days) {
    const from = dayStart(new Date(NOW.getTime() - (days - 1) * DAY));
    const byDay = new Map<string, number[]>();
    for (const r of store().runs) {
      if (r.projectId !== projectId || r.startedAt < from.toISOString() || r.status === "running" || r.status === "cancelled") continue;
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

  getRun(id) {
    const s = store();
    const run = s.runs.find((r) => r.id === id);
    const project = run && s.projects.find((p) => p.id === run.projectId);
    return wait(run && project ? copy({ run, project }) : null);
  },
  listTestResults(runId, q = {}) {
    const run = store().runs.find((r) => r.id === runId);
    const all = run ? testsOf(run) : [];
    const counts: Record<TestOutcome, number> = { passed: 0, failed: 0, skipped_with_proof: 0 };
    for (const t of all) counts[t.outcome]++;
    const term = q.search?.trim().toLowerCase() ?? "";
    // Failures first, then the tests that ran, then the skipped ones.
    const rank: Record<TestOutcome, number> = { failed: 0, passed: 1, skipped_with_proof: 2 };
    const rows = all.filter((t) => (!q.outcome || q.outcome === "all" || t.outcome === q.outcome) && (!term || t.testId.toLowerCase().includes(term))).sort((a, b) => rank[a.outcome] - rank[b.outcome]);
    const { page = 1, pageSize = 50 } = q;
    return wait<TestPage>({ items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, counts });
  },
  getSkipReceipt: (id) => wait(receiptOf(id)),

  listDefects: (q) => wait(copy(defectsFor(q))),
  listDefectFamilies: (q) => wait(copy(familiesOf(defectsFor(q)))),
  getDefect: (id) => wait(copy(store().defects.find((d) => d.id === id) ?? null)),

  listUsageMonths() {
    const months = [...new Set(store().runs.map((r) => monthOf(r.startedAt)))].sort().reverse();
    return wait(months.length ? months : [monthOf(NOW)]);
  },
  getUsage(month) {
    const s = store();
    return wait(copy(usageFrom(month, s.projects, s.runs, plans().find((p) => p.current) ?? null, RATE)));
  },
  async exportUsage(month) {
    const s = store();
    const report = usageFrom(month, s.projects, s.runs, plans().find((p) => p.current) ?? null, RATE);
    return wait({ filename: usageCsvName(month), mimeType: "text/csv", downloadUrl: blobUrl(usageCsv(report), "text/csv") });
  },

  listPlans: () => wait(plans()),
  getBilling() {
    const s = store();
    return wait(copy(billingFrom(plans(), s.projects, s.runs, NOW)));
  },

  getGitHubConnection() {
    return wait({ account: store().githubAccount, installUrl: "https://github.com/apps/fenvix/installations/new" });
  },
  listGitHubRepositories: () => wait(copy(store().repos)),
  async installGitHubApp(repositories) {
    assertMockCanManage();
    if (repositories.length === 0) throw mockError("validation_failed", 400, "Choose at least one repository.", "repositories");
    const s = store();
    const id = 60_000_000 + s.installations.size + 1;
    s.installations.set(id, repositories);
    s.githubAccount = s.githubAccount ?? repositories[0].split("/")[0];
    return wait(id);
  },
  async completeInstallation(installationId) {
    assertMockCanManage();
    const s = store();
    const names = s.installations.get(installationId);
    if (!names) throw mockError("not_found", 404, "GitHub did not confirm this installation. Install the app again.");
    const added: Project[] = [];
    for (const name of names) {
      const repo = s.repos.find((r) => r.fullName === name);
      if (!repo || repo.connected) continue;
      repo.connected = true;
      const r = rng(hash(name));
      const project: Project = {
        id: `prj_${slug(name.split("/")[1])}_${installationId % 1000}`, fullName: name, language: repo.language, testRunner: repo.testRunner, defaultBranch: "main",
        installationId, setupState: "app_installed", setupPullRequest: null, connectedAt: NOW.toISOString(),
        baseline: { medianTimeToGreenS: Math.round(90 + r() * 400), medianJobMinutes: Math.round((2 + r() * 9) * 10) / 10, runsSampled: Math.round(60 + r() * 300), from: "2026-10-18", to: "2026-11-16" },
        settings: { skipWithProof: true, commentOnPullRequests: true, nightlyExploration: false, testCommand: "" },
      };
      s.projects.push(project);
      added.push(project);
    }
    s.installations.delete(installationId);
    return wait(copy(added));
  },
  getSetupChange(projectId) {
    const p = store().projects.find((x) => x.id === projectId);
    if (!p) return Promise.reject(mockError("not_found", 404, "That project does not exist."));
    return wait(setupChange(p));
  },
  async openSetupPullRequest(projectId) {
    assertMockCanManage();
    const s = store();
    const p = s.projects.find((x) => x.id === projectId);
    if (!p) throw mockError("not_found", 404, "That project does not exist.");
    if (!p.setupPullRequest) {
      const number = 100 + (hash(p.fullName) % 900);
      p.setupPullRequest = { number, url: `https://github.com/${p.fullName}/pull/${number}`, state: "open" } satisfies SetupPullRequest;
      p.setupState = "pr_open";
    }
    return wait(copy(p.setupPullRequest));
  },

  async listPublicApiKeys(cursor) {
    if (mockRole() === "member") assertMockCanManage();
    const keys = store().apiKeys;
    const from = cursor ? Number(cursor) : 0;
    const items = keys.slice(from, from + PAGE_LIMIT).map((k) => ({ ...k, status: keyStatus(k, NOW) }));
    return wait({ items, nextCursor: from + PAGE_LIMIT < keys.length ? String(from + PAGE_LIMIT) : null });
  },
  async createPublicApiKey({ name, role, expiresAt }) {
    assertMockCanManage();
    const s = store();
    if (nameProblem(name)) throw mockError("validation_failed", 400, `Use 1 to 60 characters for the name, on one line.`, "name");
    if (role !== "admin" && role !== "read_only") throw mockError("validation_failed", 400, "Choose a role: admin or read_only.", "role");
    if (expiresAt !== null) {
      const t = new Date(expiresAt).getTime();
      if (Number.isNaN(t)) throw mockError("validation_failed", 400, "expiresAt must be a date and time, for example 2027-01-31T00:00:00Z.", "expiresAt");
      if (t <= NOW.getTime() + MIN) throw mockError("validation_failed", 400, "expiresAt must be at least a minute from now.", "expiresAt");
      if (t > NOW.getTime() + 3 * 365 * DAY) throw mockError("validation_failed", 400, "expiresAt can be at most 1095 days from now.", "expiresAt");
    }
    if (s.apiKeys.filter((k) => keyStatus(k, NOW) === "active").length >= MAX_ACTIVE_KEYS) {
      throw mockError("conflict", 409, `An organization can have up to ${MAX_ACTIVE_KEYS} active API keys. Revoke one first.`);
    }
    const token = newPublicToken();
    const key: PublicApiKey = { id: crypto.randomUUID(), name: name.trim(), role, prefix: token.slice(0, 12), status: "active", createdAt: NOW.toISOString(), lastUsedAt: null, expiresAt, revokedAt: null };
    s.apiKeys = [key, ...s.apiKeys];
    return wait({ key: { ...key }, token });
  },
  async revokePublicApiKey(id) {
    assertMockCanManage();
    const s = store();
    const found = s.apiKeys.find((k) => k.id === id);
    if (!found) throw mockError("not_found", 404, "That API key does not exist.");
    const next: PublicApiKey = { ...found, revokedAt: found.revokedAt ?? NOW.toISOString(), status: "revoked" };
    s.apiKeys = s.apiKeys.map((k) => (k.id === id ? next : k));
    return wait({ ...next });
  },
  getSettings: () => wait({ ...store().settings, workspaceName: mockOrgName() ?? store().settings.workspaceName }),
  async saveSettings(next) {
    assertMockCanManage();
    store().settings = { ...next };
    return wait({ ...store().settings, workspaceName: mockOrgName() ?? next.workspaceName });
  },
};
