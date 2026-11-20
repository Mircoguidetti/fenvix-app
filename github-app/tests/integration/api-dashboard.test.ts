// The dashboard API (src/api/) against the local Supabase: real Supabase Auth tokens (ES256, JWKS), the real Postgres
// with the migrations, the API connected as fenvix_api. Every 2xx answer is validated against its response schema in
// openapi/fenvix-api.yaml (tests/api/helpers.ts `call`), every error against the contract's Error.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { verifyState } from "../../src/auth.ts";
import type { Api } from "../../src/api/server.ts";
import { dashboardOperations } from "../../src/api/spec.ts";
import { addTo, admin as adminClient, at, call, covered, DASHBOARD, githubId, LOCAL, NOW, type Person, RecordingQueue, signUp, SKIP, startApi, STATE_KEY } from "../api/helpers.ts";
import { type Seeded, seedOrg } from "../api/seed.ts";

describe("dashboard API: every operation, real tokens, real database", { skip: SKIP }, () => {
  let admin: pg.Client;
  let api: Api;
  let queue: RecordingQueue;
  let ownerA: Person; let adminA: Person; let memberA: Person; let ownerB: Person;
  let A: Seeded; let B: Seeded;

  before(async () => {
    admin = await adminClient();
    ({ api, queue } = await startApi());
    ownerA = await signUp(admin, "owner-a", "Ada Owner");
    adminA = await signUp(admin, "admin-a", "Abe Admin");
    memberA = await signUp(admin, "member-a", "Mia Member");
    ownerB = await signUp(admin, "owner-b", "Bo Other");
    await addTo(admin, adminA, ownerA.workspaceId, "admin");
    await addTo(admin, memberA, ownerA.workspaceId, "member");
    A = await seedOrg(admin, ownerA.workspaceId, `acme-${githubId()}`);
    B = await seedOrg(admin, ownerB.workspaceId, `beta-${githubId()}`);
  });
  after(async () => {
    await api?.close();
    await admin?.end();
  });

  // ---------------------------------------------------------------- authentication and the organization header

  it("401 without a token, with a malformed one, with one signed by another key, before anything else", async () => {
    assert.equal((await call(api, "getMe")).status, 401);
    assert.equal((await call(api, "getMe", { token: "not-a-jwt" })).status, 401);
    // A token of the same shape, its signature changed.
    const forged = ownerA.token.slice(0, -4) + (ownerA.token.endsWith("AAAA") ? "BBBB" : "AAAA");
    const r = await call(api, "getMe", { token: forged });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, "unauthenticated");
    // 401 comes before the body is even looked at.
    assert.equal((await call(api, "saveSettings", { ws: ownerA.workspaceId, body: { nope: 1 } })).status, 401);
  });

  it("the organization header: missing or malformed is a 400; an organization the person is not in is a 404, like one that does not exist", async () => {
    let r = await call(api, "getOverview", { token: ownerA.token });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.field, "X-Fenvix-Workspace");
    r = await call(api, "getOverview", { token: ownerA.token, ws: "not-a-uuid" });
    assert.equal(r.status, 400);
    const other = await call(api, "getOverview", { token: ownerA.token, ws: ownerB.workspaceId });
    const none = await call(api, "getOverview", { token: ownerA.token, ws: "00000000-0000-4000-8000-000000000000" });
    assert.equal(other.status, 404);
    assert.deepEqual(other.body, none.body, "the same answer: an organization's existence cannot be probed");
  });

  it("GET /me and /organizations: the person and their organizations", async () => {
    const r = await call(api, "getMe", { token: adminA.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.id, adminA.userId);
    assert.equal(r.body.user.email, adminA.email);
    assert.equal(r.body.user.name, "Abe Admin");
    const roles = Object.fromEntries(r.body.organizations.map((o: { id: string; role: string }) => [o.id, o.role]));
    assert.equal(roles[ownerA.workspaceId], "admin");
    assert.equal(roles[adminA.workspaceId], "owner", "their own organization from sign-up");
    const l = await call(api, "listOrganizations", { token: adminA.token });
    assert.deepEqual(l.body.items, r.body.organizations);
  });

  // ---------------------------------------------------------------- reads, as a member

  it("organization, settings and members, as a member", async () => {
    const ws = ownerA.workspaceId;
    const o = await call(api, "getOrganization", { token: memberA.token, ws });
    assert.equal(o.status, 200);
    assert.deepEqual({ role: o.body.role, members: o.body.members, region: o.body.region, limits: o.body.limits }, { role: "member", members: 3, region: "us", limits: { maxMembers: 50, invitationsPerDay: 20 } });
    const s = await call(api, "getSettings", { token: memberA.token, ws });
    assert.equal(s.body.region, "us");
    const m = await call(api, "listMembers", { token: memberA.token, ws });
    assert.equal(m.body.limit, 50);
    assert.deepEqual(m.body.items.map((x: { email: string; role: string; you: boolean }) => [x.email, x.role, x.you]).sort(),
      [[adminA.email, "admin", false], [memberA.email, "member", true], [ownerA.email, "owner", false]].sort());
  });

  it("the overview: trial, runs, units from billable usage events, projects, defects", async () => {
    const r = await call(api, "getOverview", { token: memberA.token, ws: ownerA.workspaceId });
    assert.equal(r.status, 200);
    const o = r.body;
    assert.equal(o.month, "2026-11");
    assert.equal(o.trial.status, "active");
    assert.equal(o.trial.daysLeft, 20);
    assert.equal(o.trial.runs, 1, "one finished shadow run in the trial");
    assert.equal(o.trial.wouldSkipShare, 0.5, "300 s of 600 s");
    assert.equal(o.trial.gate.met, true);
    // Billable this month: 11.5 + 11 + 2.5 + 3 = 28 baseline minutes = 2.8 units, billed as 3.
    assert.deepEqual(o.units, { used: 3, included: null });
    assert.equal(o.projects.length, 2);
    assert.equal(o.openDefects, 1);
    assert.equal(o.recentDefects[0].id, A.defects.open);
    assert.equal(o.cost.plan.id, "team");
    assert.equal(o.runs.thisMonth, 7);
    assert.equal(o.runs.lastMonthSameDays, 0, "the run of last month was on the 24th, after the same days (1 to 18)");
  });

  it("projects: rows with this month's numbers and GitHub's repository id; one project; its setup change", async () => {
    const ws = ownerA.workspaceId;
    const l = await call(api, "listProjects", { token: memberA.token, ws });
    const shop = l.body.items.find((p: { id: string }) => p.id === A.projects.shop);
    assert.equal(shop.repositoryId, A.repoIds.shop);
    assert.equal(shop.runsThisMonth, 6);
    assert.equal(shop.openDefects, 1);
    assert.equal(shop.lastRunStatus, "running");
    const one = await call(api, "getProject", { token: memberA.token, ws, params: { projectId: A.projects.web } });
    assert.equal(one.body.fullName.endsWith("/web"), true);
    assert.equal(one.body.setupPullRequest.number, 4);
    const sc = await call(api, "getSetupChange", { token: memberA.token, ws, params: { projectId: A.projects.web } });
    assert.deepEqual(sc.body, { path: ".github/workflows/test.yml", job: "unit", before: "runs-on: ubuntu-latest", after: "runs-on: fenvix" });
  });

  it("a project page asks the worker to read the default branch again only when the stored one is older than a few minutes", async () => {
    const ws = ownerA.workspaceId;
    const asked = () => queue.sent.filter((w) => w.kind === "refresh_default_branch" && w.repositoryId === A.repoIds.shop).length;
    await admin.query("update gh_repositories set updated_at = $2 where repository_id = $1", [A.repoIds.shop, new Date(NOW.getTime() - 3_600_000)]);
    const before = asked();
    await call(api, "getProject", { token: memberA.token, ws, params: { projectId: A.projects.shop } });
    assert.equal(asked(), before + 1);
    await admin.query("update gh_repositories set updated_at = $2 where repository_id = $1", [A.repoIds.shop, new Date(NOW.getTime() - 60_000)]);
    await call(api, "getProject", { token: memberA.token, ws, params: { projectId: A.projects.shop } });
    assert.equal(asked(), before + 1);
    await admin.query("update gh_repositories set updated_at = $2 where repository_id = $1", [A.repoIds.shop, new Date(NOW.getTime() - 10 * 60_000)]);
    await call(api, "getProject", { token: memberA.token, ws, params: { projectId: A.projects.shop } });
    assert.equal(asked(), before + 2);
  });

  it("runs: paging, scope, status, since", async () => {
    const base = { token: memberA.token, ws: ownerA.workspaceId, params: { projectId: A.projects.shop } };
    let r = await call(api, "listRuns", base);
    assert.equal(r.body.total, 7);
    assert.equal(r.body.items[0].id, A.runs.running, "newest first");
    assert.equal(r.body.items[0].progress.testsDone, 50);
    r = await call(api, "listRuns", { ...base, query: { page: 2, pageSize: 2 } });
    assert.deepEqual([r.body.page, r.body.pageSize, r.body.items.length, r.body.total], [2, 2, 2, 7]);
    r = await call(api, "listRuns", { ...base, query: { scope: "pr" } });
    assert.deepEqual(r.body.items.map((x: { pullRequest: number }) => x.pullRequest), [12]);
    r = await call(api, "listRuns", { ...base, query: { scope: "default", status: "failed" } });
    assert.deepEqual(r.body.items.map((x: { id: string }) => x.id), [A.runs.failed]);
    r = await call(api, "listRuns", { ...base, query: { since: at(4).toISOString() } });
    assert.equal(r.body.items.length, 3);
    assert.equal(r.body.total, 3);
    r = await call(api, "listRuns", { ...base, query: { pageSize: 500 } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.field, "pageSize");
  });

  it("the skip share series, nights of exploration, the audit", async () => {
    const base = { token: memberA.token, ws: ownerA.workspaceId, params: { projectId: A.projects.shop } };
    const s = await call(api, "getSkipShareSeries", { ...base, query: { days: 7 } });
    assert.equal(s.body.items.length, 7);
    assert.equal(s.body.items.reduce((a: number, p: { runs: number }) => a + p.runs, 0), 3, "finished runs of the last 7 days");
    const e = await call(api, "listExplorations", base);
    assert.equal(e.body.items[0].id, A.exploration);
    assert.deepEqual(e.body.items[0].newDefectIds, [A.defects.open]);
    const a = await call(api, "getAudit", base);
    assert.equal(a.body.runs, 3);
    assert.equal(a.body.testsRerun, 23);
    assert.equal(a.body.wrongSkips, 1);
    assert.equal(a.body.ruleOfThreeBound, null);
    assert.equal(a.body.untrustedKeys.length, 1);
    assert.equal(a.body.recent.length, 3);
    assert.ok(a.body.recent.every((x: { runNumber: number }) => x.runNumber > 0));
  });

  it("activity: newest first, for the organization or one project", async () => {
    const r = await call(api, "listActivity", { token: memberA.token, ws: ownerA.workspaceId, query: { limit: 5 } });
    assert.equal(r.body.items.length, 5);
    const sorted = [...r.body.items].sort((x: { at: string }, y: { at: string }) => y.at.localeCompare(x.at));
    assert.deepEqual(r.body.items, sorted);
    const p = await call(api, "listActivity", { token: memberA.token, ws: ownerA.workspaceId, query: { projectId: A.projects.web, limit: 50 } });
    assert.ok(p.body.items.length > 0 && p.body.items.every((x: { projectId: string }) => x.projectId === A.projects.web));
  });

  it("one run: tests (counts from the run), files, a receipt with the reused run's number", async () => {
    const base = { token: memberA.token, ws: ownerA.workspaceId, params: { runId: A.runs.latest } };
    let t = await call(api, "listTestResults", base);
    assert.equal(t.body.total, 3);
    assert.deepEqual(t.body.counts, { passed: 40, failed: 0, skipped_with_proof: 160 });
    assert.equal(t.body.items[0].outcome, "failed", "failures first");
    assert.equal(t.body.items[0].failure.defectId, A.defects.open);
    t = await call(api, "listTestResults", { ...base, query: { outcome: "skipped_with_proof" } });
    assert.equal(t.body.items[0].receiptId, A.receipt);
    t = await call(api, "listTestResults", { ...base, query: { search: "EMPTY" } });
    assert.deepEqual(t.body.items.map((x: { testId: string }) => x.testId), ["tests/test_cart.py::test_empty"]);
    const f = await call(api, "listRunFiles", base);
    assert.deepEqual(f.body.items, [
      { file: "tests/test_cart.py", tests: 2, ran: 1, skipped: 1, failed: 0 },
      { file: "tests/test_orders.py", tests: 1, ran: 1, skipped: 0, failed: 1 },
    ]);
    const rc = await call(api, "getSkipReceipt", { token: memberA.token, ws: ownerA.workspaceId, params: { receiptId: A.receipt } });
    const reusedNumber = (await admin.query("select number from ci_runs where id = $1", [A.runs.reused])).rows[0].number;
    assert.equal(rc.body.reusedRunId, A.runs.reused);
    assert.equal(rc.body.reusedRunNumber, reusedNumber);
    assert.equal(rc.body.runtime.distributions, 42);
  });

  it("the live run view: ETag, If-None-Match → 304; a progress update → 200 with a new ETag", async () => {
    const base = { token: memberA.token, ws: ownerA.workspaceId, params: { runId: A.runs.running } };
    const first = await call(api, "getRun", base);
    assert.equal(first.status, 200);
    assert.equal(first.headers["cache-control"], "private, no-cache");
    const etag = String(first.headers.etag);
    assert.match(etag, /^"r[\w-]+"$/);
    assert.equal(first.body.run.progress.phase, "testing");
    assert.equal(first.body.project.id, A.projects.shop);
    const same = await call(api, "getRun", { ...base, headers: { "if-none-match": etag } });
    assert.equal(same.status, 304);
    assert.equal(same.text, "");
    assert.equal(same.headers.etag, etag);
    // The runner reports progress: the row changes.
    await admin.query("update ci_runs set progress = jsonb_set(progress, '{testsDone}', '120'), progress_at = now() where id = $1", [A.runs.running]);
    const changed = await call(api, "getRun", { ...base, headers: { "if-none-match": etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.etag, etag);
    assert.equal(changed.body.run.progress.testsDone, 120);
    // A change of the project as shown (its settings) also changes the ETag.
    const etag2 = String(changed.headers.etag);
    await admin.query("update ci_projects set test_command = 'pytest -q' where id = $1", [A.projects.shop]);
    const again = await call(api, "getRun", { ...base, headers: { "if-none-match": etag2 } });
    assert.equal(again.status, 200);
    await admin.query("update ci_projects set test_command = '' where id = $1", [A.projects.shop]);
  });

  it("defects, families, one defect", async () => {
    const ws = ownerA.workspaceId;
    let d = await call(api, "listDefects", { token: memberA.token, ws });
    assert.deepEqual(d.body.items.map((x: { id: string }) => x.id), [A.defects.open]);
    assert.match(d.body.items[0].replayCommand, /--det-seed=7/);
    d = await call(api, "listDefects", { token: memberA.token, ws, query: { state: "all", projectId: A.projects.shop } });
    assert.equal(d.body.items.length, 2);
    const fam = await call(api, "listDefectFamilies", { token: memberA.token, ws, query: { state: "all" } });
    assert.equal(fam.body.items.length, 1);
    assert.equal(fam.body.items[0].defects.length, 2);
    const one = await call(api, "getDefect", { token: memberA.token, ws, params: { defectId: A.defects.fixed } });
    assert.equal(one.body.state, "fixed");
    assert.equal(one.body.testRunner, "pytest");
  });

  it("usage: months, a month's report, its CSV; plans with the add-on; billing", async () => {
    const ws = ownerA.workspaceId;
    const m = await call(api, "listUsageMonths", { token: memberA.token, ws });
    assert.deepEqual(m.body.items, ["2026-11", "2026-10"]);
    const u = await call(api, "getUsage", { token: memberA.token, ws, params: { month: "2026-11" } });
    assert.equal(u.body.runsUsed, 4);
    assert.equal(u.body.unitsUsed, 3);
    assert.ok(u.body.rows.some((r: { projectId: string }) => r.projectId === ""), "billable jobs of a repository that is not a project: a row of their own");
    const csv = await call(api, "exportUsage", { token: memberA.token, ws, params: { month: "2026-11" } });
    assert.equal(csv.status, 200);
    assert.match(String(csv.headers["content-type"]), /^text\/csv/);
    assert.equal(csv.headers["content-disposition"], 'attachment; filename="fenvix-usage-2026-11.csv"');
    assert.match(csv.text, /^project,runs,units,test_minutes_ran,minutes_saved,other_step_minutes,github_equivalent_minutes,github_equivalent_usd\n/);
    const bad = await call(api, "getUsage", { token: memberA.token, ws, params: { month: "2026-13" } });
    assert.equal(bad.status, 400);
    const p = await call(api, "listPlans", { token: memberA.token, ws });
    const current = p.body.items.filter((x: { current: boolean }) => x.current).map((x: { id: string }) => x.id).sort();
    assert.deepEqual(current, ["nightly-exploration", "team"]);
    const b = await call(api, "getBilling", { token: memberA.token, ws });
    assert.equal(b.body.plan.id, "team");
    assert.deepEqual(b.body.addons.map((x: { id: string; current: boolean }) => [x.id, x.current]), [["nightly-exploration", true]]);
    assert.equal(b.body.trial.status, "active");
    assert.equal(b.body.projects, 2);
    assert.equal(b.body.unitsUsed, 3);
  });

  it("GitHub: the installations with their status and the first active account; the repositories", async () => {
    const ws = ownerA.workspaceId;
    const g = await call(api, "getGitHubConnection", { token: memberA.token, ws });
    assert.equal(g.body.installations.length, 1);
    assert.equal(g.body.installations[0].installationId, A.installationId);
    assert.equal(g.body.installations[0].repositories, 3);
    assert.equal(g.body.account, g.body.installations[0].account);
    await admin.query("update gh_installations set suspended_at = now() where installation_id = $1", [A.installationId]);
    const s = await call(api, "getGitHubConnection", { token: memberA.token, ws });
    assert.equal(s.body.installations[0].status, "suspended");
    assert.equal(s.body.account, null, "no active installation");
    await admin.query("update gh_installations set suspended_at = null where installation_id = $1", [A.installationId]);
    const r = await call(api, "listGitHubRepositories", { token: memberA.token, ws });
    assert.deepEqual(r.body.items.map((x: { repositoryId: number }) => x.repositoryId).sort(), [A.repoIds.shop, A.repoIds.web, A.repoIds.loose].sort());
    assert.equal(r.body.items.find((x: { repositoryId: number }) => x.repositoryId === A.repoIds.loose).onboardingState, "no_test_job");
  });

  // ---------------------------------------------------------------- two organizations: nobody sees the other's rows

  it("an organization's lists hold none of another organization's rows", async () => {
    const ws = ownerA.workspaceId;
    const all = JSON.stringify(await Promise.all([
      call(api, "listProjects", { token: ownerA.token, ws }), call(api, "listRuns", { token: ownerA.token, ws, params: { projectId: A.projects.shop }, query: { since: at(60).toISOString() } }),
      call(api, "listDefects", { token: ownerA.token, ws, query: { state: "all" } }), call(api, "getUsage", { token: ownerA.token, ws, params: { month: "2026-11" } }),
      call(api, "getGitHubConnection", { token: ownerA.token, ws }), call(api, "listGitHubRepositories", { token: ownerA.token, ws }),
      call(api, "listActivity", { token: ownerA.token, ws, query: { limit: 50 } }), call(api, "getOverview", { token: ownerA.token, ws }),
    ]).then((rs) => rs.map((r) => r.body)));
    for (const id of [B.projects.shop, B.projects.web, B.runs.latest, B.runs.running, B.receipt, B.defects.open, B.defects.fixed, String(B.installationId), String(B.repoIds.shop), B.exploration]) {
      assert.ok(!all.includes(id), `organization A sees ${id} of organization B`);
    }
  });

  it("ids of another organization answer 404, the same as ids that do not exist", async () => {
    const o = { token: ownerA.token, ws: ownerA.workspaceId };
    const cases: [string, Record<string, string | number>, Record<string, string>?][] = [
      ["getProject", { projectId: B.projects.shop }], ["listRuns", { projectId: B.projects.shop }], ["getSkipShareSeries", { projectId: B.projects.shop }],
      ["listExplorations", { projectId: B.projects.shop }], ["getAudit", { projectId: B.projects.shop }], ["getSetupChange", { projectId: B.projects.shop }],
      ["getRun", { runId: B.runs.latest }], ["listTestResults", { runId: B.runs.latest }], ["listRunFiles", { runId: B.runs.latest }],
      ["getSkipReceipt", { receiptId: B.receipt }], ["getDefect", { defectId: B.defects.open }],
      ["listDefects", {}, { projectId: B.projects.shop }], ["listDefectFamilies", {}, { projectId: B.projects.shop }], ["listActivity", {}, { projectId: B.projects.shop }],
    ];
    for (const [op, params, query] of cases) {
      const r = await call(api, op, { ...o, params, ...(query ? { query } : {}) });
      assert.equal(r.status, 404, `${op} with organization B's id`);
      assert.equal(r.body.error.code, "not_found");
    }
    const save = await call(api, "saveProjectSettings", { ...o, params: { projectId: B.projects.shop }, body: { skipWithProof: false, commentOnPullRequests: false, nightlyExploration: false, testCommand: "" } });
    assert.equal(save.status, 404);
    assert.equal((await admin.query("select skip_with_proof from ci_projects where id = $1", [B.projects.shop])).rows[0].skip_with_proof, true, "unchanged");
    const pr = await call(api, "openSetupPullRequest", { ...o, params: { repositoryId: B.repoIds.shop } });
    assert.equal(pr.status, 404);
    assert.equal(queue.sent.filter((w) => w.kind === "onboard" && w.repositoryId === B.repoIds.shop).length, 0);
    // A person of organization B, naming organization A: 404 on every operation that takes the header.
    for (const op of dashboardOperations().filter((x) => x.workspace && x.method === "GET" && !x.route.includes(":"))) {
      const r = await call(api, op.operationId, { token: ownerB.token, ws: ownerA.workspaceId });
      assert.equal(r.status, 404, op.operationId);
    }
  });

  it("row level security, the second barrier: as fenvix_api, a person reads nothing of an organization they are not in", async () => {
    const c = new pg.Client({ connectionString: LOCAL!.apiDbUrl });
    await c.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)", [ownerA.userId, ownerB.workspaceId]);
      for (const t of ["ci_projects", "ci_runs", "ci_skip_receipts", "ci_defects", "ci_usage_events", "gh_installations", "gh_repositories", "ci_test_results", "ci_audit_reruns", "ci_explorations", "ci_subscriptions"]) {
        assert.equal((await c.query(`select count(*)::int as n from public.${t} where workspace_id = $1`, [ownerB.workspaceId])).rows[0].n, 0, t);
      }
      await c.query("rollback");
    } finally { await c.end(); }
  });

  // ---------------------------------------------------------------- the owner and admin operations: member, admin, owner

  describe("every operation marked x-fenvix-role: admin: a member is refused (403), an admin and an owner may", () => {
    let owner: Person; let adm: Person; let mem: Person; let targets: Person[];
    let ws: string;
    let projectId: string; let repositoryId: number; let matrixRun: string;

    before(async () => {
      owner = await signUp(admin, "m-owner"); adm = await signUp(admin, "m-admin"); mem = await signUp(admin, "m-member");
      targets = [await signUp(admin, "m-t1"), await signUp(admin, "m-t2"), await signUp(admin, "m-t3"), await signUp(admin, "m-t4")];
      ws = owner.workspaceId;
      await addTo(admin, adm, ws, "admin");
      await addTo(admin, mem, ws, "member");
      for (const t of targets) await addTo(admin, t, ws, "member");
      const seeded = await seedOrg(admin, ws, `matrix-${githubId()}`);
      projectId = seeded.projects.shop;
      repositoryId = seeded.repoIds.loose;
      matrixRun = (await admin.query("select id from ci_runs where project_id = $1 order by started_at desc limit 1", [projectId])).rows[0].id;
    });

    const matrix: Record<string, (who: Person, role: "member" | "admin" | "owner") => Promise<number>> = {
      renameOrganization: async (who, role) => (await call(api, "renameOrganization", { token: who.token, ws, body: { name: `Renamed by ${role}` } })).status,
      saveSettings: async (who, role) => (await call(api, "saveSettings", { token: who.token, ws, body: { workspaceName: `Set by ${role}`, emailNotices: role !== "owner", region: role === "owner" ? "eu" : "us" } })).status,
      saveProjectSettings: async (who, role) => (await call(api, "saveProjectSettings", { token: who.token, ws, params: { projectId }, body: { skipWithProof: true, commentOnPullRequests: role === "admin", nightlyExploration: true, testCommand: `  pytest -q -k ${role}  ` } })).status,
      listInvitations: async (who) => (await call(api, "listInvitations", { token: who.token, ws })).status,
      createInvitation: async (who, role) => (await call(api, "createInvitation", { token: who.token, ws, body: { email: `invitee-${role}-${githubId()}@api.fenvix.test`, role: role === "owner" ? "admin" : "member" } })).status,
      revokeInvitation: async (who, role) => {
        const inv = await call(api, "createInvitation", { token: owner.token, ws, body: { email: `revoke-${role}-${githubId()}@api.fenvix.test`, role: "member" } });
        return (await call(api, "revokeInvitation", { token: who.token, ws, params: { id: inv.body.invitation.id } })).status;
      },
      changeMemberRole: async (who, role) => (await call(api, "changeMemberRole", { token: who.token, ws, params: { userId: targets[0]!.userId }, body: { role: role === "owner" ? "admin" : "member" } })).status,
      removeMember: async (who, role) => (await call(api, "removeMember", { token: who.token, ws, params: { userId: targets[role === "owner" ? 1 : role === "admin" ? 2 : 3]!.userId } })).status,
      createInstallLink: async (who) => (await call(api, "createInstallLink", { token: who.token, ws })).status,
      openSetupPullRequest: async (who) => (await call(api, "openSetupPullRequest", { token: who.token, ws, params: { repositoryId } })).status,
      // The service back-end (P-048, 0018).
      listApiKeys: async (who) => (await call(api, "listApiKeys", { token: who.token, ws })).status,
      createApiKey: async (who, role) => (await call(api, "createApiKey", { token: who.token, ws, body: { name: `key of ${role}`, scopes: ["read"] } })).status,
      revokeApiKey: async (who, role) => {
        const k = await call(api, "createApiKey", { token: owner.token, ws, body: { name: `revoke ${role}` } });
        return (await call(api, "revokeApiKey", { token: who.token, ws, params: { keyId: k.body.id } })).status;
      },
      listAuditEvents: async (who) => (await call(api, "listAuditEvents", { token: who.token, ws })).status,
      exportOrganization: async (who) => (await call(api, "exportOrganization", { token: who.token, ws })).status,
      saveExplorationSettings: async (who) => (await call(api, "saveExplorationSettings", { token: who.token, ws, params: { projectId }, body: { hourUtc: 3, budgetSeconds: 900, seeds: 10, target: "unstable" } })).status,
      requestExploration: async (who) => {
        await admin.query("update ci_exploration_jobs set status = 'cancelled' where project_id = $1 and status in ('pending', 'dispatched', 'running')", [projectId]);
        return (await call(api, "requestExploration", { token: who.token, ws, params: { projectId }, body: {} })).status;
      },
      resumeSkip: async (who) => (await call(api, "resumeSkip", { token: who.token, ws, params: { projectId } })).status,
      deleteProject: async (who, role) => {
        const p = (await admin.query("insert into ci_projects (workspace_id, full_name, language, test_runner, installation_id) values ($1, $2, 'python', 'pytest', 990001) returning id",
          [ws, `matrix/delete-${role}-${githubId()}`])).rows[0].id;
        return (await call(api, "deleteProject", { token: who.token, ws, params: { projectId: p } })).status;
      },
      stopRun: async (who) => {
        await admin.query("update ci_runs set status = 'running', stop_state = null, stop_when = null where id = $1", [matrixRun]);
        return (await call(api, "stopRun", { token: who.token, ws, params: { runId: matrixRun }, body: { when: "first_failure" } })).status;
      },
      replayTest: async (who, role) => (await call(api, "replayTest", { token: who.token, ws, params: { runId: matrixRun }, body: { testId: `tests/m.py::t_${role}` } })).status,
      unlinkInstallation: async (who) => {
        const id = githubId();
        await admin.query("insert into gh_installations (installation_id, account_id, account_login, account_type, workspace_id, linked_at) values ($1, $1, 'matrix-unlink', 'User', $2, now())", [id, ws]);
        return (await call(api, "unlinkInstallation", { token: who.token, ws, params: { installationId: id } })).status;
      },
    };
    /** Owner only, beyond x-fenvix-role: admin (an admin is refused too): tested on its own below. */
    const OWNER_ONLY = ["deleteOrganization"];

    it("the matrix covers exactly the contract's admin operations", () => {
      assert.deepEqual([...Object.keys(matrix), ...OWNER_ONLY].sort(), dashboardOperations().filter((o) => o.admin).map((o) => o.operationId).sort());
    });

    it("member 403, admin and owner 2xx, for each", async () => {
      for (const [op, run] of Object.entries(matrix)) {
        assert.equal(await run(mem, "member"), 403, `${op}: member`);
        const a = await run(adm, "admin");
        assert.ok(a >= 200 && a < 300, `${op}: admin got ${a}`);
        const o = await run(owner, "owner");
        assert.ok(o >= 200 && o < 300, `${op}: owner got ${o}`);
      }
      // What they did.
      const w = (await admin.query("select name, region, email_notices from workspaces where id = $1", [ws])).rows[0];
      assert.deepEqual(w, { name: "Set by owner", region: "eu", email_notices: false });
      const p = (await admin.query("select comment_on_pull_requests, test_command from ci_projects where id = $1", [projectId])).rows[0];
      assert.deepEqual(p, { comment_on_pull_requests: false, test_command: "pytest -q -k owner" });
      assert.equal((await admin.query("select role from workspace_members where workspace_id = $1 and user_id = $2", [ws, targets[0]!.userId])).rows[0].role, "admin");
      const left = (await admin.query("select user_id from workspace_members where workspace_id = $1", [ws])).rows.map((r) => r.user_id);
      assert.ok(!left.includes(targets[1]!.userId) && !left.includes(targets[2]!.userId) && left.includes(targets[3]!.userId));
      assert.equal(queue.sent.filter((x) => x.kind === "onboard" && x.repositoryId === repositoryId).length, 2);
      assert.deepEqual(queue.sent.at(-1), { kind: "onboard", repositoryId });
    });

    it("what an admin may not do even so: invite or manage admins and owners, change their own role", async () => {
      let r = await call(api, "createInvitation", { token: adm.token, ws, body: { email: `x-${githubId()}@api.fenvix.test`, role: "admin" } });
      assert.equal(r.status, 403);
      r = await call(api, "changeMemberRole", { token: adm.token, ws, params: { userId: mem.userId }, body: { role: "admin" } });
      assert.equal(r.status, 403);
      r = await call(api, "changeMemberRole", { token: adm.token, ws, params: { userId: adm.userId }, body: { role: "member" } });
      assert.equal(r.status, 403);
      r = await call(api, "removeMember", { token: adm.token, ws, params: { userId: owner.userId } });
      assert.equal(r.status, 403);
      r = await call(api, "removeMember", { token: owner.token, ws, params: { userId: "00000000-0000-4000-8000-000000000000" } });
      assert.equal(r.status, 404);
    });

    it("the install link: GitHub's install page with a state signed for this organization and person", async () => {
      const r = await call(api, "createInstallLink", { token: adm.token, ws });
      const u = new URL(r.body.url);
      assert.equal(`${u.origin}${u.pathname}`, "https://github.com/apps/fenvix-test/installations/new");
      const state = verifyState(STATE_KEY, u.searchParams.get("state") ?? undefined);
      assert.deepEqual(state && { w: state.workspaceId, u: state.userId }, { w: ws, u: adm.userId });
    });

    it("the setup pull request: 202 with the repository as it is now; 503 when the queue is down", async () => {
      const r = await call(api, "openSetupPullRequest", { token: owner.token, ws, params: { repositoryId } });
      assert.equal(r.status, 202);
      assert.equal(r.body.repositoryId, repositoryId);
      assert.equal(r.body.onboardingState, "no_test_job");
      queue.fail = true;
      const down = await call(api, "openSetupPullRequest", { token: owner.token, ws, params: { repositoryId } });
      queue.fail = false;
      assert.equal(down.status, 503);
      assert.equal(down.body.error.code, "unavailable");
    });

    it("request validation: unknown fields, wrong types, out-of-range values are a 400 naming the field", async () => {
      let r = await call(api, "saveProjectSettings", { token: owner.token, ws, params: { projectId }, body: { skipWithProof: true, commentOnPullRequests: true, nightlyExploration: true, testCommand: "", extra: 1 } });
      assert.deepEqual([r.status, r.body.error.field], [400, "extra"]);
      r = await call(api, "saveProjectSettings", { token: owner.token, ws, params: { projectId }, body: { skipWithProof: "true", commentOnPullRequests: true, nightlyExploration: true, testCommand: "" } });
      assert.deepEqual([r.status, r.body.error.field], [400, "skipWithProof"]);
      r = await call(api, "saveSettings", { token: owner.token, ws, body: { workspaceName: "Ok name", emailNotices: true, region: "asia" } });
      assert.deepEqual([r.status, r.body.error.field], [400, "region"]);
      r = await call(api, "saveSettings", { token: owner.token, ws, body: { workspaceName: "x", emailNotices: true, region: "us" } });
      assert.deepEqual([r.status, r.body.error.field], [400, "workspaceName"]);
      r = await call(api, "getProject", { token: owner.token, ws, params: { projectId: "nope" } });
      assert.deepEqual([r.status, r.body.error.field], [400, "projectId"]);
      r = await call(api, "openSetupPullRequest", { token: owner.token, ws, params: { repositoryId: 0 } });
      assert.equal(r.status, 400);
    });
  });

  // ---------------------------------------------------------------- organizations: create, invite, accept, leave

  describe("organizations", () => {
    it("create (2 to 64 characters, the person is its owner), rename", async () => {
      const p = await signUp(admin, "creator");
      let r = await call(api, "createOrganization", { token: p.token, body: { name: "x" } });
      assert.deepEqual([r.status, r.body.error.field], [400, "name"]);
      r = await call(api, "createOrganization", { token: p.token, body: { name: "  Second Org  " } });
      assert.equal(r.status, 201);
      assert.deepEqual({ ...r.body.organization, id: "" }, { id: "", name: "Second Org", role: "owner", nameConfirmed: true });
      const id = r.body.organization.id;
      const ren = await call(api, "renameOrganization", { token: p.token, ws: id, body: { name: "Second, renamed" } });
      assert.deepEqual(ren.body, { id, name: "Second, renamed", role: "owner", nameConfirmed: true });
      assert.equal((await call(api, "listOrganizations", { token: p.token })).body.items.length, 2);
    });

    it("an invitation: created by an owner, accepted once by the invited address only; every refusal is the same 404", async () => {
      const owner = await signUp(admin, "inv-owner");
      const ws = owner.workspaceId;
      const email = `api-${process.pid}-${githubId()}@api.fenvix.test`;
      const created = await call(api, "createInvitation", { token: owner.token, ws, body: { email: email.toUpperCase() } });
      assert.equal(created.status, 201);
      assert.equal(created.body.invitation.email, email);
      assert.equal(created.body.invitation.role, "member");
      assert.ok(created.body.link.startsWith(`${DASHBOARD}/invite#token=`));
      const token = created.body.link.split("#token=")[1];
      const dup = await call(api, "createInvitation", { token: owner.token, ws, body: { email } });
      assert.deepEqual([dup.status, dup.body.error.field], [409, "email"]);
      const listed = await call(api, "listInvitations", { token: owner.token, ws });
      assert.deepEqual(listed.body.items.map((i: { email: string }) => i.email), [email]);

      const stranger = await signUp(admin, "inv-stranger");
      const refused = await call(api, "acceptInvitation", { token: stranger.token, body: { token } });
      assert.equal(refused.status, 404);
      const malformed = await call(api, "acceptInvitation", { token: stranger.token, body: { token: "abc" } });
      assert.deepEqual(malformed.body, refused.body, "the same answer for every refusal");

      // The invited person signs up with that address (Supabase Auth confirms it locally) and accepts.
      const res = await fetch(`${LOCAL!.supabaseUrl}/auth/v1/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "pw-invited-0123456789" }) });
      const invited = (await res.json()) as { access_token: string; user: { id: string } };
      const ok = await call(api, "acceptInvitation", { token: invited.access_token, body: { token } });
      assert.equal(ok.status, 200);
      assert.deepEqual({ id: ok.body.organization.id, role: ok.body.organization.role }, { id: ws, role: "member" });
      const again = await call(api, "acceptInvitation", { token: invited.access_token, body: { token } });
      assert.deepEqual([again.status, again.body], [404, refused.body], "used");
      assert.equal((await call(api, "listInvitations", { token: owner.token, ws })).body.items.length, 0);

      // The new member leaves; the last owner cannot.
      assert.equal((await call(api, "leaveOrganization", { token: invited.access_token, ws })).status, 204);
      assert.equal((await call(api, "getOrganization", { token: invited.access_token, ws })).status, 404);
      const last = await call(api, "leaveOrganization", { token: owner.token, ws });
      assert.deepEqual([last.status, last.body.error.code], [409, "conflict"]);
      const demote = await call(api, "changeMemberRole", { token: owner.token, ws, params: { userId: owner.userId }, body: { role: "member" } });
      assert.equal(demote.status, 409);
    });

    it("20 invitations a day per organization, then 429 with Retry-After", async () => {
      const owner = await signUp(admin, "rate-owner");
      const ws = owner.workspaceId;
      for (let i = 0; i < 20; i++) {
        const r = await call(api, "createInvitation", { token: owner.token, ws, body: { email: `rate-${i}-${githubId()}@api.fenvix.test` } });
        assert.equal(r.status, 201);
      }
      const r = await call(api, "createInvitation", { token: owner.token, ws, body: { email: `rate-x-${githubId()}@api.fenvix.test` } });
      assert.equal(r.status, 429);
      assert.equal(r.body.error.code, "rate_limited");
      assert.ok(Number(r.headers["retry-after"]) > 0);
    });
  });

  // ---------------------------------------------------------------- CORS

  it("CORS: the dashboard's origin only; preflight answered; ETag readable", async () => {
    const pre = await api.fastify.inject({ method: "OPTIONS", url: "/v1/runs/x", headers: { origin: DASHBOARD, "access-control-request-method": "GET", "access-control-request-headers": "authorization, x-fenvix-workspace, if-none-match" } });
    assert.equal(pre.statusCode, 204);
    assert.equal(pre.headers["access-control-allow-origin"], DASHBOARD);
    assert.match(String(pre.headers["access-control-allow-headers"]), /authorization.*content-type.*x-fenvix-workspace.*if-none-match/);
    const evil = await api.fastify.inject({ method: "OPTIONS", url: "/v1/me", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    assert.equal(evil.statusCode, 403);
    assert.equal(evil.headers["access-control-allow-origin"], undefined);
    const get = await call(api, "getMe", { token: ownerA.token, headers: { origin: DASHBOARD } });
    assert.equal(get.headers["access-control-allow-origin"], DASHBOARD);
    assert.match(String(get.headers["access-control-expose-headers"]), /etag/);
    const other = await call(api, "getMe", { token: ownerA.token, headers: { origin: "https://evil.example" } });
    assert.equal(other.headers["access-control-allow-origin"], undefined);
    assert.match(String(other.headers.vary), /Origin/);
  });

  it("completing a GitHub link (review R-016 F2): only the person the install link names; once; not after it expired; owner or admin only", async () => {
    const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
    // An installation GitHub told us about, linked to no organization yet (as after GitHub's own Install button).
    const installationId = githubId();
    const login = `globex-${installationId}`;
    await admin.query(`insert into public.gh_installations (installation_id, account_id, account_login, account_type, repository_selection)
                       values ($1, $2, $3, 'Organization', 'selected')`, [installationId, githubId(), login]);
    // What /github/setup stores once GitHub confirmed the GitHub user administers the account: one completion per
    // install-link state, for the fenvix person that state names.
    // The local Supabase keeps rows between runs: codes unique to this run.
    const C = (name: string) => `${name}-${installationId}`;
    const completion = async (who: Person, code: string, expires = "10 minutes") => admin.query(
      `insert into public.gh_install_completions (code_hash, state_hash, installation_id, workspace_id, user_id, github_user_id, github_login, created_at, expires_at)
       values ($1, $2, $3, $4, $5, 1, 'gh-admin', now() - interval '1 hour', now() + $6::interval)`,
      [sha256(code), sha256(`state-${code}`), installationId, ownerA.workspaceId, who.userId, expires]);
    const linkedTo = async () => (await admin.query("select workspace_id from public.gh_installations where installation_id = $1", [installationId])).rows[0].workspace_id;
    await completion(ownerA, C("code-of-ada"));
    await completion(ownerA, C("code-expired"), "-1 minute");
    await completion(memberA, C("code-of-mia"));

    // Another person (the owner of another organization, an admin of this one) presenting ownerA's code: the same 404.
    const stolen = await call(api, "completeGitHubInstall", { token: ownerB.token, body: { completion: C("code-of-ada") } });
    const byAdmin = await call(api, "completeGitHubInstall", { token: adminA.token, body: { completion: C("code-of-ada") } });
    const unknown = await call(api, "completeGitHubInstall", { token: ownerA.token, body: { completion: C("no-such-code") } });
    const expired = await call(api, "completeGitHubInstall", { token: ownerA.token, body: { completion: C("code-expired") } });
    for (const r of [stolen, byAdmin, unknown, expired]) assert.equal(r.status, 404);
    assert.deepEqual(stolen.body, unknown.body, "one answer for every refusal of the code");
    assert.deepEqual(expired.body, unknown.body);
    // A member's own completion (they asked for the link while an admin, then lost the role): 403.
    assert.equal((await call(api, "completeGitHubInstall", { token: memberA.token, body: { completion: C("code-of-mia") } })).status, 403);
    assert.equal(await linkedTo(), null);
    assert.equal((await call(api, "completeGitHubInstall", { body: { completion: C("code-of-ada") } })).status, 401);
    assert.equal((await call(api, "completeGitHubInstall", { token: ownerA.token, body: { completion: "" } })).status, 400);

    // The person the link names: linked; the worker gets the installation's projects to sync, after the commit.
    const sentBefore = queue.sent.length;
    const ok = await call(api, "completeGitHubInstall", { token: ownerA.token, body: { completion: C("code-of-ada") } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { organizationId: ownerA.workspaceId, installationId, account: login });
    assert.equal(await linkedTo(), ownerA.workspaceId);
    assert.deepEqual(queue.sent.slice(sentBefore), [{ kind: "installation_linked", installationId }]);
    // Once only.
    assert.equal((await call(api, "completeGitHubInstall", { token: ownerA.token, body: { completion: C("code-of-ada") } })).status, 404);
  });

  it("the service back-end's operations: defect history, state, bundle and replays; stopping a run; deleting; with real tokens", async () => {
    const ws = ownerA.workspaceId;
    const d = (await admin.query("select id, project_id from ci_defects where workspace_id = $1 order by last_seen_at desc limit 1", [ws])).rows[0];
    const run = (await admin.query("select id, commit_sha from ci_runs where workspace_id = $1 order by started_at desc limit 1", [ws])).rows[0];
    await admin.query("insert into ci_defect_occurrences (workspace_id, defect_id, run_id, source, commit_sha, status, seen_at) values ($1, $2, $3, 'run', $4, 'reproduced', now()) on conflict do nothing",
      [ws, d.id, run.id, run.commit_sha]);
    const b = (await admin.query("insert into ci_defect_bundles (workspace_id, defect_id, sha256, size_bytes, content) values ($1, $2, $3, 3, '\\x010203') returning id", [ws, d.id, "0".repeat(64)])).rows[0];
    await admin.query("update ci_defects set bundle_id = $2 where id = $1", [d.id, b.id]);
    const hist = await call(api, "listDefectOccurrences", { token: memberA.token, ws, params: { defectId: d.id } });
    assert.equal(hist.status, 200);
    assert.ok(hist.body.total >= 1);
    assert.equal((await call(api, "getDefectBundle", { token: memberA.token, ws, params: { defectId: d.id } })).status, 200);
    assert.equal((await call(api, "setDefectState", { token: memberA.token, ws, params: { defectId: d.id }, body: { state: "muted", reason: "tracked" } })).body.state, "muted");
    const rp = await call(api, "requestDefectReplay", { token: memberA.token, ws, params: { defectId: d.id }, body: { commitSha: run.commit_sha } });
    assert.equal(rp.status, 202);
    assert.equal((await call(api, "getReplay", { token: memberA.token, ws, params: { replayId: rp.body.id } })).body.state, "queued");
    assert.equal((await call(api, "listDefectReplays", { token: memberA.token, ws, params: { defectId: d.id } })).body.items.length, 1);
    assert.equal((await call(api, "listReplays", { token: memberA.token, ws, params: { runId: run.id } })).status, 200);
    assert.equal((await call(api, "downloadDefectBundle", { token: memberA.token, ws, params: { defectId: d.id } })).status, 200);
    await admin.query("update ci_runs set status = 'running' where id = $1", [run.id]);
    assert.equal((await call(api, "listLiveTests", { token: memberA.token, ws, params: { runId: run.id } })).status, 200);
    const failures = await call(api, "listFailures", { token: memberA.token, ws, query: { runId: run.id } });
    assert.equal(failures.status, 200);
    await admin.query("insert into ci_test_results (run_id, workspace_id, test_id, outcome, failure_kind, output) values ($1, $2, 'tests/log.py::t', 'failed', 'real', 'the output') on conflict do nothing", [run.id, ws]);
    const log = await call(api, "getTestLog", { token: memberA.token, ws, params: { runId: run.id }, query: { testId: "tests/log.py::t" } });
    assert.deepEqual([log.status, log.body.output], [200, "the output"]);
    const pid = String(d.project_id);
    assert.equal((await call(api, "listExplorationJobs", { token: memberA.token, ws, params: { projectId: pid } })).status, 200);
    // Another organization sees none of it.
    assert.equal((await call(api, "listDefectOccurrences", { token: ownerB.token, ws: ownerB.workspaceId, params: { defectId: d.id } })).status, 404);
    assert.equal((await call(api, "getDefectBundle", { token: ownerB.token, ws: ownerB.workspaceId, params: { defectId: d.id } })).status, 404);
    // Deleting: an admin cannot delete the organization; its owner can (typing its name). An account goes with deleteMe.
    const solo = await signUp(admin, "delete-solo");
    assert.equal((await call(api, "deleteOrganization", { token: adminA.token, ws, body: { confirmName: "x" } })).status, 403);
    const name = (await admin.query("select name from workspaces where id = $1", [solo.workspaceId])).rows[0].name;
    assert.equal((await call(api, "deleteOrganization", { token: solo.token, ws: solo.workspaceId, body: { confirmName: name } })).status, 204);
    assert.equal((await call(api, "deleteMe", { token: solo.token })).status, 204);
    assert.equal((await admin.query("select count(*)::int as n from auth.users where id = $1", [solo.userId])).rows[0].n, 0);
  });

  it("every dashboard operation of the contract was called and answered as the contract says", () => {
    const all = dashboardOperations().map((o) => o.operationId).sort();
    assert.deepEqual(all.filter((x) => !covered.has(x)), []);
    assert.equal(all.length, 68);
    void NOW;
  });
});
