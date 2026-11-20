/**
 * The recorded end to end: an organization connects GitHub, the App opens the onboarding pull request, it is merged,
 * a developer's pull request runs its tests on fenvix twice (a real failure, then the fix), and GitHub gets a check
 * run and one pull request comment, updated in place. Every webhook is a payload GitHub recorded, checked against
 * GitHub's webhook schema; every call the App makes is checked against GitHub's REST description.
 *
 * With RECORD=1 (npm run e2e:record) the whole exchange is written to recordings/e2e.json and a readable
 * recordings/E2E.md.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { signState } from "../../src/auth.ts";
import { checkWebhook } from "../helpers/schemas.ts";
import { ACCOUNT, CI_YAML, completeLink, DASHBOARD, githubSetup, githubUser, Harness, INSTALLATION_ID, installationCreated, makeOrg, pullRequest, push, REPOS, resetDb, workflowJob } from "../helpers/harness.ts";

const summary = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/runner/${name}.summary.json`, import.meta.url), "utf8")) as Record<string, unknown>;

interface Delivered { event: string; action: string | null; status: number; schemaProblems: string[]; payload: Record<string, unknown>; at: number }

describe("recorded end to end: installation → onboarding pull request → workflow_job completed → check run and comment", () => {
  const h = new Harness();
  let admin: pg.Client;
  let org: { userId: string; workspaceId: string };
  const webhooks: Delivered[] = [];
  const runner: { runId: number; summaryFile: string; status: number; at: number }[] = [];
  const deliver = async (event: string, payload: Record<string, unknown>) => {
    const at = performance.now();
    const res = await h.send(event, payload);
    webhooks.push({ event, action: (payload.action as string) ?? null, status: res.statusCode, schemaProblems: checkWebhook(event, payload), payload, at });
    return res;
  };
  // The commits of the three real runner summaries (tests/fixtures/runner/README.md): N on main, N+1 and N+2 on the pull request.
  const MAIN_SHA = "c663f502f475eb0892fa2d8972fd322ce3bba456";
  const DEV_SHA_1 = "4bec63ba31437dbe83826d4643ae63b6ad03fead";
  const DEV_SHA_2 = "e8206072cf839808186d220d829f342a5e080c88";

  before(async () => {
    admin = await resetDb();
    await h.start();
    org = await makeOrg(admin, "e2e-owner");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML, "pyproject.toml": "[project]\nname = \"shop\"\n" } });
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("1. the owner asks the dashboard for the install link", async () => {
    // The dashboard API answers it (POST /v1/github/install-link, src/api/github.ts; tests/integration/api-dashboard.test.ts):
    // the state it signs with the same key.
    (h as unknown as { state: string }).state = signState(h.cfg.stateSigningKey, { workspaceId: org.workspaceId, userId: org.userId });
    assert.ok((h as unknown as { state: string }).state);
  });

  it("2. installation.created → the onboarding pull request is opened", async () => {
    assert.equal((await deliver("installation", installationCreated([REPOS.shop]))).statusCode, 202);
    const pr = h.gh.repos.get("acme/shop")!.pulls[0]!;
    assert.equal(pr.head, "fenvix/runs-on");
    assert.match(pr.body, /```diff[\s\S]*\+    runs-on: fenvix  # GitHub-hosted, 2 cores[\s\S]*```/);
  });

  it("3. GitHub sends the owner back to the setup URL → the installation is the organization's", async () => {
    githubUser(h, { code: "e2e-code", token: "gho_e2eowner", login: "e2e-owner", id: 6301, installations: [INSTALLATION_ID], adminOf: [ACCOUNT.login] });
    const state = (h as unknown as { state: string }).state;
    const r = await githubSetup(h, { installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "e2e-code" });
    assert.equal(r.url.searchParams.get("github"), "confirm");
    // The dashboard completes it as the signed-in owner (review R-016 F2).
    assert.equal((await completeLink(h, r.completion!, org.userId))?.account, ACCOUNT.login);
    const p = (await admin.query("select setup_state, setup_pr_number from ci_projects")).rows[0];
    assert.deepEqual(p, { setup_state: "pr_open", setup_pr_number: 1 });
  });

  it("4. pull_request opened, then merged (the onboarding pull request)", async () => {
    const pr = h.gh.repos.get("acme/shop")!.pulls[0]!;
    await deliver("pull_request", pullRequest("opened", { number: 1, headRef: "fenvix/runs-on", headSha: pr.headSha }));
    pr.state = "closed";
    await deliver("pull_request", pullRequest("closed", { number: 1, headRef: "fenvix/runs-on", headSha: pr.headSha, merged: true }));
    assert.equal((await admin.query("select setup_pr_state from ci_projects")).rows[0].setup_pr_state, "merged");
  });

  it("5. the first run on fenvix, on main after the merge: cold cache, a flaky test found and explained", async () => {
    await deliver("push", push(MAIN_SHA, "refs/heads/main", 1795430000));
    h.gh.addRun("acme/shop", 31000, { event: "push", headSha: MAIN_SHA, headBranch: "main", message: "Merge pull request #1 from acme/fenvix/runs-on" });
    await deliver("workflow_job", workflowJob("queued", { id: 81000, runId: 31000, sha: MAIN_SHA, branch: "main" }));
    await deliver("workflow_job", workflowJob("in_progress", { id: 81000, runId: 31000, sha: MAIN_SHA, branch: "main", startedAt: "2026-11-18T09:40:05Z" }));
    const at0 = performance.now();
    const r = await h.summary({ runId: 31000, summary: summary("job1-cold-flaky"), receiptsUrl: "https://github.com/acme/shop/actions/runs/31000#artifacts" });
    runner.push({ runId: 31000, summaryFile: "tests/fixtures/runner/job1-cold-flaky.summary.json", status: r.statusCode, at: at0 });
    await deliver("workflow_job", workflowJob("completed", { id: 81000, runId: 31000, sha: MAIN_SHA, branch: "main", conclusion: "failure", startedAt: "2026-11-18T09:40:05Z", completedAt: "2026-11-18T09:41:50Z" }));
    const cr = [...h.gh.repos.get("acme/shop")!.checkRuns.values()][0]!;
    assert.match((cr.output as { summary: string }).summary, /Flaky tests, explained[\s\S]*test_default_currency_is_eur[\s\S]*replay: `python -m pytest --det/);
    assert.equal(h.gh.repos.get("acme/shop")!.comments.size, 0, "a push to main has no pull request to comment on");
  });

  it("6. a developer's pull request: push, workflow_job queued → in_progress → summary → completed (a real failure)", async () => {
    const shop = h.gh.repos.get("acme/shop")!;
    shop.pulls.push({ number: 2, title: "Tax change", body: "", head: "tax-change", base: "main", state: "open", headSha: DEV_SHA_1 });
    await deliver("push", push(DEV_SHA_1, "refs/heads/tax-change", 1795431000));
    await deliver("pull_request", pullRequest("opened", { number: 2, headRef: "tax-change", headSha: DEV_SHA_1 }));
    h.gh.addRun("acme/shop", 31001, { event: "pull_request", headSha: DEV_SHA_1, headBranch: "tax-change", message: "Tax change", pullRequests: [2] });
    await deliver("workflow_job", workflowJob("queued", { id: 81001, runId: 31001, sha: DEV_SHA_1, branch: "tax-change" }));
    await deliver("workflow_job", workflowJob("in_progress", { id: 81001, runId: 31001, sha: DEV_SHA_1, branch: "tax-change", startedAt: "2026-11-18T10:00:05Z" }));
    const at1 = performance.now();
    const r = await h.summary({ runId: 31001, summary: summary("job2-warm-real-failure"), receiptsUrl: "https://github.com/acme/shop/actions/runs/31001#artifacts" });
    runner.push({ runId: 31001, summaryFile: "tests/fixtures/runner/job2-warm-real-failure.summary.json", status: r.statusCode, at: at1 });
    await deliver("workflow_job", workflowJob("completed", { id: 81001, runId: 31001, sha: DEV_SHA_1, branch: "tax-change", conclusion: "failure", startedAt: "2026-11-18T10:00:05Z", completedAt: "2026-11-18T10:01:35Z" }));
    const cr = [...shop.checkRuns.values()].find((c) => c.head_sha === DEV_SHA_1)!;
    assert.equal(cr.conclusion, "failure");
    assert.equal(shop.comments.size, 1);
  });

  it("7. the fix: the next run completes green, the same comment is updated in place", async () => {
    const shop = h.gh.repos.get("acme/shop")!;
    shop.pulls[1]!.headSha = DEV_SHA_2;
    await deliver("push", push(DEV_SHA_2, "refs/heads/tax-change", 1795431600));
    await deliver("pull_request", pullRequest("synchronize", { number: 2, headRef: "tax-change", headSha: DEV_SHA_2 }));
    h.gh.addRun("acme/shop", 31002, { event: "pull_request", headSha: DEV_SHA_2, headBranch: "tax-change", message: "Fix the tax for 300", pullRequests: [2] });
    await deliver("workflow_job", workflowJob("in_progress", { id: 81002, runId: 31002, sha: DEV_SHA_2, branch: "tax-change", startedAt: "2026-11-18T10:10:05Z" }));
    const at2 = performance.now();
    const r = await h.summary({ runId: 31002, summary: summary("job3-warm-pass"), receiptsUrl: "https://github.com/acme/shop/actions/runs/31002#artifacts" });
    runner.push({ runId: 31002, summaryFile: "tests/fixtures/runner/job3-warm-pass.summary.json", status: r.statusCode, at: at2 });
    await deliver("workflow_job", workflowJob("completed", { id: 81002, runId: 31002, sha: DEV_SHA_2, branch: "tax-change", conclusion: "success", startedAt: "2026-11-18T10:10:05Z", completedAt: "2026-11-18T10:11:05Z" }));
    assert.equal(shop.comments.size, 1);
    assert.match([...shop.comments.values()][0]!.body, /### ✅ fenvix · all tests passed[\s\S]*\*\*Skip with proof:\*\* 46 of 56 tests skipped/);
  });

  it("8. every webhook matches GitHub's webhook schema; every API call matches GitHub's REST description", async () => {
    assert.deepEqual(webhooks.filter((w) => w.schemaProblems.length).map((w) => `${w.event}.${w.action}: ${w.schemaProblems.join("; ")}`), []);
    const bad = h.gh.validateAll();
    assert.deepEqual(bad.map((x) => `${x.method} ${x.path} ${x.status}: ${JSON.stringify(x.problems)}`), []);
    const ops = h.gh.exchanges.map((x) => x.operationId);
    for (const op of ["apps/create-installation-access-token", "repos/get", "repos/get-content", "pulls/list", "git/get-ref", "git/create-ref",
      "repos/create-or-update-file-contents", "pulls/create", "apps/list-installations-for-authenticated-user", "checks/create", "checks/update",
      "actions/get-workflow-run", "issues/create-comment", "issues/update-comment"]) {
      assert.ok(ops.includes(op), `the end to end did not exercise ${op}`);
    }
    const usage = (await admin.query("select github_job_id, billable, reason, plan_id, workspace_id from ci_usage_events order by github_job_id")).rows;
    assert.deepEqual(usage.map((u) => [u.github_job_id, u.billable, u.reason, u.plan_id, u.workspace_id === org.workspaceId]),
      [[81000, true, "failed", "team", true], [81001, true, "failed", "team", true], [81002, true, "completed", "team", true]]);
    const runs = (await admin.query("select number, branch, status, tests_skipped, tests_flaky_defects, pull_request from ci_runs order by number")).rows;
    assert.deepEqual(runs.map((r) => [r.number, r.branch, r.status, r.tests_skipped, r.tests_flaky_defects, r.pull_request]),
      [[1, "main", "failed", 0, 1, null], [2, "tax-change", "failed", 45, 0, 2], [3, "tax-change", "passed", 46, 0, 2]]);

    if (process.env.RECORD === "1") write(h, webhooks, runner, admin, org.workspaceId);
  });
});

function write(h: Harness, webhooks: Delivered[], runner: { runId: number; summaryFile: string; status: number; at: number }[], admin: pg.Client, ws: string): void {
  const dir = new URL("../../recordings/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  void admin; void ws;
  const api = h.gh.exchanges.map((x) => ({ at: x.at ?? 0, operationId: x.operationId, method: x.method, path: x.path, query: x.query, requestBody: redact(x.body), status: x.status, response: redact(x.response), schemaProblems: x.problems }));
  writeFileSync(new URL("e2e.json", dir), JSON.stringify({
    about: "Recorded by tests/integration/e2e.test.ts (RECORD=1). Webhooks: payloads recorded by GitHub (@octokit/webhooks-examples) with our values, checked against @octokit/webhooks-schemas. API: every request the App sent to the fake GitHub and its answer, checked against GitHub's OpenAPI description (@octokit/openapi, api.github.com.deref.json). Tokens are replaced by <redacted>.",
    webhooks: webhooks.map((w) => ({ event: w.event, action: w.action, appAnswered: w.status, schemaProblems: w.schemaProblems, payload: w.payload })),
    runnerSummaries: runner.map(({ at: _at, ...r }) => r), api: api.map(({ at: _at, ...x }) => x),
  }, null, 1) + "\n");

  const shop = h.gh.repos.get("acme/shop")!;
  const onboarding = shop.pulls[0]!;
  const prCall = api.find((x) => x.operationId === "pulls/create")!;
  const putCall = api.find((x) => x.operationId === "repos/create-or-update-file-contents")!;
  const checks = api.filter((x) => x.operationId === "checks/create" || x.operationId === "checks/update");
  const comments = api.filter((x) => x.operationId === "issues/create-comment" || x.operationId === "issues/update-comment");
  const L: string[] = [
    "# Recorded end to end",
    "",
    "Written by `npm run e2e:record` (tests/integration/e2e.test.ts). Machine-readable: `e2e.json` (every webhook and every API call with its",
    "check against GitHub's schemas). This page shows what a customer sees on GitHub.",
    "",
    "## Sequence",
    "",
    "| # | from | what | answer | schema |",
    "|---|---|---|---|---|",
  ];
  const seq: { at: number; line: (n: number) => string }[] = [];
  for (const w of webhooks) seq.push({ at: w.at, line: (n) => `| ${n} | GitHub → App | webhook \`${w.event}${w.action ? "." + w.action : ""}\` | ${w.status} | ${w.schemaProblems.length ? "✖ " + w.schemaProblems.join("; ") : "✔ webhook schema"} |` });
  for (const r of runner) seq.push({ at: r.at, line: (n) => `| ${n} | runner → App | \`POST /v1/runner/summaries\` run ${r.runId} (\`${r.summaryFile.split("/").pop()}\`) | ${r.status} | — |` });
  for (const x of api) {
    const check = x.path.startsWith("/login/oauth/") ? "— (OAuth on github.com, not the REST API)" : x.schemaProblems?.length ? "✖ " + JSON.stringify(x.schemaProblems) : "✔ REST description";
    seq.push({ at: x.at, line: (n) => `| ${n} | App → GitHub | \`${x.method} ${x.path}\`${x.operationId && !x.path.startsWith("/login/") ? ` (${x.operationId})` : ""} | ${x.status} | ${check} |` });
  }
  seq.sort((a, b) => a.at - b.at);
  L.push(...seq.map((s, n) => s.line(n + 1)));
  L.push("", "## 1. The onboarding pull request", "", `\`POST ${prCall.path}\`, request body:`, "", "```json", JSON.stringify(prCall.requestBody, null, 2), "```", "",
    "Rendered body:", "", "> " + onboarding.body.split("\n").join("\n> "), "",
    `The file on the branch (\`PUT ${putCall.path}\`, branch \`${(putCall.requestBody as { branch: string }).branch}\`, message \`${(putCall.requestBody as { message: string }).message}\`):`, "",
    "```yaml", shop.branches.get("fenvix/runs-on")!.files.get(".github/workflows/ci.yml")!.text.trimEnd(), "```", "");
  L.push("## 2. Check runs", "");
  for (const c of checks) {
    L.push(`### \`${c.method} ${c.path}\` → ${c.status}`, "", "```json", JSON.stringify(c.requestBody, null, 2), "```", "");
    const out = (c.requestBody as { output?: { summary?: string } }).output;
    if (out?.summary) L.push("Rendered summary:", "", "> " + out.summary.split("\n").join("\n> "), "");
  }
  L.push("## 3. The pull request comment (one comment, updated in place)", "");
  for (const c of comments) {
    L.push(`### \`${c.method} ${c.path}\` → ${c.status}`, "", "```json", JSON.stringify(c.requestBody, null, 2), "```", "", "Rendered:", "", "> " + String((c.requestBody as { body: string }).body).split("\n").join("\n> "), "");
  }
  L.push(`Dashboard links in these payloads point at ${DASHBOARD} (the test's dashboard URL).`, "");
  writeFileSync(new URL("E2E.md", dir), L.join("\n"));
}

function redact(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v ?? null, (k, val) => (k === "token" || k === "access_token" ? "<redacted>" : val)));
}
