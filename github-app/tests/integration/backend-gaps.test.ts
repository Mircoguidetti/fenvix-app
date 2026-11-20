/**
 * Regression tests of the service back-end's audit rows (docs/REPORT-service-backend.md), one or more per row family,
 * against Postgres and the fake GitHub:
 *
 *   webhooks: a replayed installation.created (G-2301), ignored events recorded (G-2302), repository renamed / archived
 *   (G-2297), installation_target (G-2298), check_run and check_suite re-runs (G-1647, G-2295), lost deliveries
 *   redelivered and lost jobs read back (G-1729, G-2296); a missing App permission says so (G-1725); the shadow label
 *   is not given without a runner that runs shadow mode (G-0187); setup pull requests only for jobs the engine runs
 *   (G-0617); a wrong skip pauses skipping and the next machine gets no cache (G-1757); nightly explorations are
 *   scheduled, dispatched and stored, several a day (G-0597, G-0630, G-1720, G-1721, G-1722); retention and the purge
 *   after an uninstall (G-1699, G-1812, G-1816, G-2309, G-2337); deleting a project, the organization, an account and
 *   unlinking an installation (G-0634, G-1626, G-1700, G-1810), usage events kept (G-1813); defects paginated
 *   (G-1628); the export (G-2283); a signed-out session refused at once (G-2234); an HS256 project told why (G-2237).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { SessionVerifier } from "../../src/auth.ts";
import { loadApiConfig } from "../../src/api/config.ts";
import { type Api, buildApi } from "../../src/api/server.ts";
import { rateLimitWait } from "../../src/github/client.ts";
import { engineRuns, permissionNote } from "../../src/onboarding/onboard.ts";
import { analyzeWorkflow } from "../../src/onboarding/workflow.ts";
import { projectStack, stackFromSummary } from "../../src/results/detect.ts";
import { parseResults } from "../../src/results/runner-records.ts";
import { parseSummary } from "../../src/results/summary.ts";
import { signSummaryCredential } from "../../src/runners/credentials.ts";
import type { Region, RunnerLaunch, RunnerLauncher, TaskLaunch } from "../../src/runners/launcher.ts";
import {
  ACCOUNT, ADMIN_URL, CI_YAML, Harness, hook, INSTALLATION_ID, installationCreated, makeOrg, REPOS, resetDb, RUNNER_TOKEN, runnerCredential, SUPABASE,
  workflowJob,
} from "../helpers/harness.ts";

type Row = Record<string, unknown>;
const GRADLE = "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./gradlew test\n";

class FakeLauncher implements RunnerLauncher {
  launches: RunnerLaunch[] = [];
  tasks: TaskLaunch[] = [];
  canPlace(_r: Region) { return true; }
  async launch(l: RunnerLaunch) { this.launches.push(l); return { instanceId: `i-${l.jobId}`, already: false }; }
  async launchTask(t: TaskLaunch) { this.tasks.push(t); return { instanceId: "i-t", already: false }; }
}

describe("service back-end: the audit rows, one regression test per family", () => {
  const h = new Harness();
  const launcher = new FakeLauncher();
  let admin: pg.Client;
  let api: Api;
  let org: { userId: string; workspaceId: string };
  let signKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let projectId = "";
  const token = (userId: string, claims: Row = {}) => new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(`${SUPABASE}/auth/v1`)
    .setAudience("authenticated").setSubject(userId).setIssuedAt().setExpirationTime("1h").sign(signKey);
  // The App's sweep asks GitHub who sees which private project (G-1631) every minute; here before each call.
  const call = async (method: string, url: string, auth: string, ws: string | null, body?: unknown) => h.app.service.refreshRepoAccess().then(() => api.fastify.inject({
    method: method as "GET", url, headers: { authorization: `Bearer ${auth}`, ...(ws ? { "x-fenvix-workspace": ws } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  }));
  const shop = () => h.gh.repos.get("acme/shop")!;

  before(async () => {
    admin = await resetDb();
    await h.start({}, { launcher });
    org = await makeOrg(admin, "gaps-owner");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id, REPOS.web.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    h.gh.addRepo({ id: REPOS.web.id, fullName: REPOS.web.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": GRADLE } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await admin.query("select public.gh_link_installation($1, $2, $3)", [INSTALLATION_ID, org.workspaceId, org.userId]);
    await h.app.service.onboard(REPOS.shop.id);
    await h.app.service.onInstallationLinked(INSTALLATION_ID);
    projectId = (await admin.query("select project_id from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].project_id;
    assert.ok(projectId);
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    signKey = privateKey;
    const u = new URL(ADMIN_URL); u.username = "fenvix_api"; u.password = "local-test-only";
    api = buildApi({
      cfg: loadApiConfig({ NODE_ENV: "test", API_DATABASE_URL: u.toString(), SUPABASE_URL: SUPABASE, STATE_SIGNING_KEY: "state-signing-key-for-tests-0123456789",
        DASHBOARD_URL: "https://app.fenvix.test", GITHUB_APP_SLUG: "fenvix-test", DB_POOL_MAX: "4", LOG_LEVEL: "silent" }),
      queue: { enqueue: async () => {} }, logger: false,
      sessions: new SessionVerifier(SUPABASE, "", createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" }] })),
    });
  });
  after(async () => { await api?.close(); await h.stop(); await admin.end(); });

  // ---------------------------------------------------------------- the shadow label (G-0187)

  it("G-0187: in the trial, without a runner that runs shadow mode, the machine and the run say enforce (what really happens)", async () => {
    assert.equal((await admin.query("select trial_ends_at > now() as t from ci_subscriptions where workspace_id = $1", [org.workspaceId])).rows[0].t, true, "the trial runs");
    const sha = "a1".repeat(20);
    h.gh.addRun("acme/shop", 61000, { event: "push", headSha: sha, headBranch: "main", message: "m" });
    await h.send("workflow_job", workflowJob("queued", { id: 96001, runId: 61000, sha, branch: "main" }));
    await h.send("workflow_job", workflowJob("in_progress", { id: 96001, runId: 61000, sha, branch: "main", runner: "fenvix-j96001" }));
    assert.equal(launcher.launches.at(-1)!.mode, "enforce");
    assert.equal((await admin.query("select r.mode from ci_runs r join gh_jobs j on j.ci_run_id = r.id where j.job_id = 96001")).rows[0].mode, "enforce");
  });

  // ---------------------------------------------------------------- skip with proof: the setting and the pause (G-1757)

  it("G-1757: a wrong skip found by an audit rerun pauses skipping; the next machine gets no cache; an admin resumes it", async () => {
    await (await h.app.fastify.inject({ method: "POST", url: "/v1/runner/results", headers: { authorization: `Bearer ${runnerCredential("fenvix-j96001", REPOS.shop.id, 61000)}`, "content-type": "application/json" },
      payload: { runId: 61000, chunk: 0, chunks: 1, audit: [{ testId: "tests/t.py::t", cacheKey: "e".repeat(32), outcome: "wrong_skip", untrusted: true, detail: "failed on rerun" }] } }));
    await h.app.service.idle();
    await h.summary({ runId: 61000, runner: "fenvix-j96001", summary: (await import("../fixtures/runner/job3-warm-pass.summary.json", { with: { type: "json" } })).default as Row });
    await h.send("workflow_job", workflowJob("completed", { id: 96001, runId: 61000, sha: "a1".repeat(20), branch: "main", runner: "fenvix-j96001" }));
    const p = (await admin.query("select skip_paused_at, skip_paused_reason from ci_projects where id = $1", [projectId])).rows[0];
    assert.ok(p.skip_paused_at);
    assert.match(p.skip_paused_reason, /wrong skip: tests\/t\.py::t/);
    const sha = "a2".repeat(20);
    h.gh.addRun("acme/shop", 61001, { event: "push", headSha: sha, headBranch: "main", message: "m" });
    await h.send("workflow_job", workflowJob("queued", { id: 96002, runId: 61001, sha, branch: "main" }));
    const l = launcher.launches.at(-1)!;
    assert.deepEqual([l.jobId, l.cacheAccess, l.cacheToken], [96002, "none", undefined]);
    const resumed = await call("POST", `/v1/projects/${projectId}/skip/resume`, await token(org.userId), org.workspaceId);
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.json().skipPaused, null);
  });

  it("G-2343: a run started by another event (release) is 'other', not a manual run", async () => {
    const sha = "a7".repeat(20);
    h.gh.addRun("acme/shop", 61007, { event: "release", headSha: sha, headBranch: "main", message: "v1" });
    await h.send("workflow_job", workflowJob("queued", { id: 96007, runId: 61007, sha, branch: "main" }));
    await h.send("workflow_job", workflowJob("in_progress", { id: 96007, runId: 61007, sha, branch: "main", runner: "fenvix-j96007" }));
    assert.equal((await admin.query("select r.trigger from ci_runs r join gh_jobs j on j.ci_run_id = r.id where j.job_id = 96007")).rows[0].trigger, "other");
  });

  it("G-2318: a commit that is the head of two open pull requests gets the comment on both", async () => {
    const sha = "a8".repeat(20);
    for (const n of [41, 42]) {
      shop().pulls.push({ number: n, headRef: `b${n}`, headSha: sha, state: "open", title: "t", body: "" } as never);
      await h.send("pull_request", (await import("../helpers/harness.ts")).pullRequest("opened", { number: n, headRef: `b${n}`, headSha: sha }));
    }
    h.gh.addRun("acme/shop", 61008, { event: "pull_request", headSha: sha, headBranch: "b41", message: "m", pullRequests: [41] });
    await h.send("workflow_job", workflowJob("queued", { id: 96008, runId: 61008, sha, branch: "b41" }));
    await h.send("workflow_job", workflowJob("in_progress", { id: 96008, runId: 61008, sha, branch: "b41", runner: "fenvix-j96008" }));
    await h.summary({ runId: 61008, runner: "fenvix-j96008", summary: (await import("../fixtures/runner/job3-warm-pass.summary.json", { with: { type: "json" } })).default as Row });
    await h.send("workflow_job", workflowJob("completed", { id: 96008, runId: 61008, sha, branch: "b41", runner: "fenvix-j96008" }));
    const on = [...shop().comments.values()].filter((c) => c.issue === 41 || c.issue === 42).map((c) => c.issue).sort();
    assert.deepEqual(on, [41, 42]);
  });

  // ---------------------------------------------------------------- webhooks

  it("G-2301: installation.created sent again after the uninstall does not bring the installation back", async () => {
    const created = installationCreated([REPOS.web]);
    (created.installation as Row).id = 7777;
    await h.send("installation", created);
    const deleted = { ...created, action: "deleted" };
    await h.send("installation", deleted);
    await h.send("installation", created);
    assert.ok((await admin.query("select deleted_at from gh_installations where installation_id = 7777")).rows[0].deleted_at, "still uninstalled");
  });

  it("G-2302: an event the App does not handle is recorded", async () => {
    const r = await h.send("star", { action: "created", installation: { id: INSTALLATION_ID } }, { delivery: "ignored-delivery-1" });
    assert.equal(r.statusCode, 202);
    const row = (await admin.query("select event, action, processed_at is not null as done, error from gh_webhook_deliveries where delivery_id = 'ignored-delivery-1'")).rows[0];
    assert.deepEqual([row.event, row.action, row.done], ["star", "created", true]);
    assert.match(row.error, /^ignored/);
  });

  it("G-2297: repository renamed renames the project; archived removes it (no machine, no warm-up); unarchived brings it back", async () => {
    const renamed = hook("repository", "renamed", (p) => { (p.repository as Row).full_name = "acme/shop2"; (p.repository as Row).name = "shop2"; });
    await h.send("repository", renamed);
    assert.equal((await admin.query("select full_name from ci_projects where id = $1", [projectId])).rows[0].full_name, "acme/shop2");
    const back = hook("repository", "renamed", (p) => { (p.repository as Row).full_name = "acme/shop"; (p.repository as Row).name = "shop"; });
    await h.send("repository", back);
    const raw = (action: string) => ({ ...hook("repository", "renamed", () => {}), action, changes: undefined });
    await h.send("repository", raw("archived"));
    assert.ok((await admin.query("select removed_at from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].removed_at);
    await h.send("repository", raw("unarchived"));
    assert.equal((await admin.query("select removed_at from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].removed_at, null);
  });

  it("G-2298: installation_target.renamed: the account's new login", async () => {
    await h.send("installation_target", { action: "renamed", installation: { id: INSTALLATION_ID }, account: { login: "acme-renamed", id: ACCOUNT.id }, changes: { login: { from: "acme" } }, target_type: "Organization" });
    assert.equal((await admin.query("select account_login from gh_installations where installation_id = $1", [INSTALLATION_ID])).rows[0].account_login, "acme-renamed");
    await admin.query("update gh_installations set account_login = 'acme' where installation_id = $1", [INSTALLATION_ID]);
  });

  it("G-1647, G-2295: the check run's Re-run (and Re-run all checks) re-runs the job; without Actions: write, the check run says how", async () => {
    const job = (await admin.query("select job_id, check_run_id, head_sha from gh_jobs where job_id = 96001")).rows[0];
    const reruns: string[] = [];
    h.gh.extra.push({ method: "POST", path: /^\/repos\/acme\/shop\/actions\/jobs\/(\d+)\/rerun$/, answer: (m) => { reruns.push(m[1]!); return [201, {}]; } });
    await h.send("check_run", { action: "rerequested", check_run: { id: job.check_run_id, external_id: String(job.job_id), head_sha: job.head_sha }, repository: { id: REPOS.shop.id }, installation: { id: INSTALLATION_ID } });
    assert.deepEqual(reruns, ["96001"]);
    await h.send("check_suite", { action: "rerequested", check_suite: { head_sha: job.head_sha }, repository: { id: REPOS.shop.id, full_name: "acme/shop" }, installation: { id: INSTALLATION_ID } });
    assert.deepEqual(reruns, ["96001", "96001"]);
    h.gh.extra.unshift({ method: "POST", path: /^\/repos\/acme\/shop\/actions\/jobs\/\d+\/rerun$/, answer: () => [403, { message: "Resource not accessible by integration" }] });
    await h.send("check_run", { action: "rerequested", check_run: { id: job.check_run_id, external_id: String(job.job_id), head_sha: job.head_sha }, repository: { id: REPOS.shop.id }, installation: { id: INSTALLATION_ID } });
    const cr = shop().checkRuns.get(job.check_run_id)!;
    assert.match(String((cr.output as Row).summary), /Actions: Read and write/);
    h.gh.extra.length = 0;
  });

  it("G-1729, G-2296: failed deliveries are sent again, a lost queued job is read back from GitHub and gets its machine", async () => {
    const attempts: string[] = [];
    h.gh.extra.push(
      { method: "GET", path: /^\/app\/hook\/deliveries$/, answer: () => [200, [
        { id: 1, guid: "lost-1", status_code: 502, redelivery: false, delivered_at: new Date().toISOString(), event: "workflow_job", action: "queued" },
        { id: 2, guid: "ok-1", status_code: 202, redelivery: false, delivered_at: new Date().toISOString(), event: "push", action: null },
        { id: 3, guid: "lost-2", status_code: 500, redelivery: false, delivered_at: new Date().toISOString(), event: "push", action: null },
        { id: 4, guid: "lost-2", status_code: 202, redelivery: true, delivered_at: new Date().toISOString(), event: "push", action: null },
      ]] },
      { method: "POST", path: /^\/app\/hook\/deliveries\/(\d+)\/attempts$/, answer: (m) => { attempts.push(m[1]!); return [202, {}]; } },
    );
    // A job the App saw queued, whose machine was never asked for (the event that would have done it was lost).
    await admin.query(`insert into gh_jobs (job_id, repository_id, installation_id, run_id, run_attempt, job_name, workflow_name, head_sha, head_branch, labels, status, created_at)
      values (96009, $1, $2, 61009, 1, 'test', 'CI', $3, 'main', '{fenvix}', 'queued', now() - interval '10 minutes')`, [REPOS.shop.id, INSTALLATION_ID, "a9".repeat(20)]);
    h.gh.addRun("acme/shop", 61009, { event: "push", headSha: "a9".repeat(20), headBranch: "main", message: "m" });
    const live = workflowJob("queued", { id: 96009, runId: 61009, sha: "a9".repeat(20), branch: "main" }).workflow_job as Row;
    h.gh.extra.push({ method: "GET", path: /^\/repos\/acme\/shop\/actions\/jobs\/96009$/, answer: () => [200, live] });
    const out = await h.app.service.recoverLostWebhooks();
    await h.app.service.idle();
    assert.deepEqual(attempts, ["1"], "only the delivery that failed and was never delivered later");
    assert.equal(out.jobs, 1);
    assert.ok(launcher.launches.some((l) => l.jobId === 96009), "the lost job got its machine");
    h.gh.extra.length = 0;
  });

  it("G-1725: an installation that has not accepted Administration: write gets a check run that says so, not silent retries", async () => {
    h.gh.extra.push({ method: "POST", path: /^\/repos\/acme\/shop\/actions\/runners\/generate-jitconfig$/, answer: () => [403, { message: "Resource not accessible by integration" }] });
    const sha = "a3".repeat(20);
    h.gh.addRun("acme/shop", 61003, { event: "push", headSha: sha, headBranch: "main", message: "m" });
    await h.send("workflow_job", workflowJob("queued", { id: 96003, runId: 61003, sha, branch: "main" }));
    const check = [...shop().checkRuns.values()].find((c) => c.head_sha === sha)!;
    assert.deepEqual([check.conclusion, (check.output as Row).title], ["action_required", "No fenvix machine for this job"]);
    // G-1726: an organization's check run names the organization permission first.
    assert.match(String((check.output as Row).summary), /organization permission "Self-hosted runners: Read and write" \(or, without it, the repository permission "Administration: Read and write"\)/);
    h.gh.extra.length = 0;
  });

  it("G-1727: GitHub's rate limits are read (retry-after, x-ratelimit-remaining)", () => {
    const res = (status: number, h2: Record<string, string>) => ({ status, headers: { get: (k: string) => h2[k] ?? null } });
    assert.equal(rateLimitWait(res(403, { "retry-after": "30" })), 30);
    assert.equal(rateLimitWait(res(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000" }), 990_000), 10);
    assert.equal(rateLimitWait(res(403, {})), null, "a 403 that is no rate limit");
    assert.equal(rateLimitWait(res(429, {})), 60);
    assert.equal(rateLimitWait(res(200, { "retry-after": "5" })), null);
  });

  it("G-1726: the onboarding pull request says which permission runs the machines: Self-hosted runners for an organization, Administration only for a personal account", () => {
    assert.match(permissionNote("Organization"), /organization permission \*\*Self-hosted runners: Read and write\*\*.*does not need the repository permission Administration/);
    assert.match(permissionNote("User"), /personal account.*no narrower permission.*\*\*Administration: Read and write\*\*/);
    // The onboarding pull request the App opened on acme/shop (acme is an organization).
    const pr = shop().pulls.find((p) => p.body.includes("<!-- fenvix:onboarding -->"));
    assert.ok(pr, "the onboarding pull request was opened");
    assert.match(pr.body, /\*\*Permissions\.\*\* On an organization.*Self-hosted runners: Read and write/);
  });

  // ---------------------------------------------------------------- onboarding (G-0617)

  it("G-0617: a setup pull request only for jobs the engine runs (pytest, Vitest, Jest); Gradle, go test, mocha, make: unsupported", () => {
    assert.deepEqual(engineRuns("python", "pytest"), { ok: true });
    assert.deepEqual(engineRuns("node", "jest"), { ok: true });
    for (const [lang, runner] of [["go", "go test"], [null, null], ["python", null], ["node", null]] as const) {
      const r = engineRuns(lang, runner);
      assert.equal(r.ok, false, `${lang} ${runner}`);
    }
  });

  it("G-0617: a Gradle test job is refused with a reason, no pull request is opened", async () => {
    const r = REPOS.web;
    await admin.query("insert into gh_repositories (repository_id, installation_id, full_name) values ($1, $2, $3) on conflict (repository_id) do update set installation_id = excluded.installation_id, removed_at = null", [r.id, INSTALLATION_ID, r.full_name]);
    const out = await h.app.service.onboard(r.id);
    assert.equal(out.state, "unsupported", out.detail);
    assert.match(out.detail, /pytest \(Python\) and Vitest or Jest \(Node\)/);
    assert.equal(h.gh.repos.get(REPOS.web.full_name)!.pulls.length, 0);
  });

  // ---------------------------------------------------------------- every runner, every defect kind, the run's own language (P-047's hand-over)

  it("G-0616, G-1750: every runner is recognised (unittest is no longer pytest); a runner fenvix does not run gets no setup pull request, with why", async () => {
    const job = (cmd: string) => analyzeWorkflow({ path: ".github/workflows/ci.yml", text: `name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${cmd}\n` }, "fenvix").jobs[0]!;
    const seen = Object.fromEntries([
      "python -m unittest discover", "python manage.py test", "nose2 -v", "ward test", "npx playwright test", "npx cypress run", "npx mocha", "node --test",
      "npx ava", "npx tap", "bun test", "pytest -q", "npx vitest run", "npx jest",
    ].map((c) => [c, `${job(c).language}/${job(c).testRunner}`]));
    assert.deepEqual(seen, {
      "python -m unittest discover": "python/unittest", "python manage.py test": "python/django", "nose2 -v": "python/nose2", "ward test": "python/ward",
      "npx playwright test": "node/playwright", "npx cypress run": "node/cypress", "npx mocha": "node/mocha", "node --test": "node/node:test",
      "npx ava": "node/ava", "npx tap": "node/tap", "bun test": "node/bun", "pytest -q": "python/pytest", "npx vitest run": "node/vitest", "npx jest": "node/jest",
    });
    assert.deepEqual(projectStack({ language: "python", testRunner: "unittest" }, null), { language: "python", testRunner: "unittest" }, "not pytest");
    assert.deepEqual(stackFromSummary({ test_runner: "playwright" }), { language: "node", testRunner: "playwright" });
    const r = engineRuns("python", "unittest");
    assert.equal(r.ok, false);
    assert.match((r as { why: string }).why, /unittest/);
    // A repository whose tests run with unittest: recognised and stored as such, no pull request, the reason given.
    const repo = REPOS.docs;
    h.gh.addRepo({ id: repo.id, fullName: repo.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: python -m unittest discover\n" } });
    h.gh.installations.get(INSTALLATION_ID)!.repos.push(repo.id);
    await admin.query("insert into gh_repositories (repository_id, installation_id, full_name) values ($1, $2, $3) on conflict (repository_id) do update set installation_id = excluded.installation_id, removed_at = null", [repo.id, INSTALLATION_ID, repo.full_name]);
    const out = await h.app.service.onboard(repo.id);
    assert.equal(out.state, "unsupported", out.detail);
    assert.match(out.detail, /unittest/);
    assert.deepEqual((await admin.query("select detected_language, detected_test_runner from gh_repositories where repository_id = $1", [repo.id])).rows[0],
      { detected_language: "python", detected_test_runner: "unittest" });
    assert.equal(h.gh.repos.get(repo.full_name)!.pulls.length, 0);
  });

  it("G-1752: a summary's flaky test may be named by testId (any runner), not only pytest's nodeid", async () => {
    const base = (await import("../fixtures/runner/job3-warm-pass.summary.json", { with: { type: "json" } })).default as Row;
    const s = parseSummary({ ...base, flaky: [{ testId: "src/money.test.ts > eur", replay: "npx vitest run --sequence.seed=3" }] });
    assert.deepEqual(s.flaky.map((f) => f.nodeid), ["src/money.test.ts > eur"]);
  });

  it("G-1754: a Level 1 or Level 2 defect (threads, async order, clock, network) is stored without an order; an order defect still needs one", () => {
    const d = (kind: string, order?: string[]) => ({
      testId: "tests/t.py::t", status: "reproduced", kind, ...(order ? { order } : {}), fingerprint: "a".repeat(32), seed: 1,
      replay: { runs: 10, fails: 10, identicalFingerprint: true }, exception: { type: "AssertionError", phase: "call", message: "boom", location: "t.py:1" },
    });
    for (const kind of ["thread", "async-order", "clock", "network"]) {
      const c = parseResults({ runId: 1, chunk: 0, chunks: 1, defects: [d(kind)] });
      assert.deepEqual(c.defects?.[0]?.order, ["tests/t.py::t"], kind);
    }
    assert.throws(() => parseResults({ runId: 1, chunk: 0, chunks: 1, defects: [d("order")] }), /order/);
  });

  it("G-1755: two test jobs of one repository, Python and TypeScript: each run carries its own language and runner", async () => {
    const t = await token(org.userId);
    const node = { ...((await import("../fixtures/runner/job3-warm-pass.summary.json", { with: { type: "json" } })).default as Row), language: "node", test_runner: "vitest" };
    const sha = "a7".repeat(20);
    h.gh.addRun("acme/shop", 61070, { event: "push", headSha: sha, headBranch: "main", message: "two jobs" });
    await h.send("workflow_job", workflowJob("queued", { id: 96070, runId: 61070, sha, branch: "main", name: "ts" }));
    await h.send("workflow_job", workflowJob("in_progress", { id: 96070, runId: 61070, sha, branch: "main", name: "ts", runner: "fenvix-j96070" }));
    await h.summary({ runId: 61070, runner: "fenvix-j96070", summary: node });
    await h.send("workflow_job", workflowJob("completed", { id: 96070, runId: 61070, sha, branch: "main", name: "ts", runner: "fenvix-j96070" }));
    const run = (await admin.query("select r.id, r.language, r.test_runner, p.language as project_language from ci_runs r join ci_projects p on p.id = r.project_id join gh_jobs j on j.ci_run_id = r.id where j.job_id = 96070")).rows[0];
    assert.deepEqual([run.language, run.test_runner, run.project_language], ["node", "vitest", "python"], "the run's own, the project keeps its first");
    const got = (await call("GET", `/v1/runs/${run.id}`, t, org.workspaceId)).json().run;
    assert.deepEqual([got.language, got.testRunner], ["node", "vitest"]);
  });

  // ---------------------------------------------------------------- explorations (G-0597, G-0630, G-1720, G-1721, G-1722)

  it("G-1720, G-1721: the nightly switch schedules one exploration a day at its hour, targeting unstable tests; it gets a machine", async () => {
    const t = await token(org.userId);
    assert.equal((await call("PUT", `/v1/projects/${projectId}/exploration-settings`, t, org.workspaceId, { hourUtc: 0, budgetSeconds: 600, seeds: 5, target: "unstable" })).statusCode, 200);
    await admin.query("update ci_projects set nightly_exploration = true where id = $1", [projectId]);
    await admin.query(`insert into ci_defects (workspace_id, project_id, test_id, status, cause, minimal_order, family_key, first_seen_at, last_seen_at, language)
      values ($1, $2, 'tests/flaky.py::t', 'reported', 'unknown', '{tests/flaky.py::t}', '<none>', now(), now(), 'python')`, [org.workspaceId, projectId]);
    const first = await h.app.service.tasks.tick();
    const second = await h.app.service.tasks.tick();
    assert.deepEqual([first.scheduled, second.scheduled], [1, 0], "once a day");
    const job = (await admin.query("select * from ci_exploration_jobs where project_id = $1", [projectId])).rows[0];
    assert.deepEqual([job.reason, job.budget_seconds, job.seeds, job.targets, job.status], ["nightly", 600, 5, ["tests/flaky.py::t"], "dispatched"]);
    const task = launcher.tasks.at(-1)!;
    assert.deepEqual([task.kind, task.taskId, (task.spec as Row).budgetSeconds, (task.spec as Row).seeds], ["exploration", job.id, 600, 5]);
  });

  it("G-0597, G-1722: the exploration machine reports with its task credential: stored as that job's night, even with another one stored today", async () => {
    const job = (await admin.query("select * from ci_exploration_jobs where project_id = $1", [projectId])).rows[0];
    const task = launcher.tasks.at(-1)!;
    const send = (cred: string, startedAt: string) => h.app.fastify.inject({ method: "POST", url: "/v1/runner/explorations", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" },
      payload: { startedAt, finishedAt: startedAt.replace("T02", "T03"), commitSha: "c".repeat(40), branch: "main", seeds: 5, runs: 5, collected: 10, seconds: 600 } }).then(async (r) => { await h.app.service.idle(); return r; });
    // One unscheduled exploration today already (a machine whose credential names the repository).
    const now = new Date(); const day = now.toISOString().slice(0, 10);
    assert.equal((await send(runnerCredential("fenvix-explore", REPOS.shop.id), `${day}T02:00:00Z`)).statusCode, 202);
    const cred = signSummaryCredential(RUNNER_TOKEN, { runnerName: task.runnerName, repositoryId: REPOS.shop.id, task: { kind: "exploration", id: job.id }, exp: Math.floor(Date.now() / 1000) + 600 });
    assert.equal((await send(cred, `${day}T02:10:00Z`)).statusCode, 202);
    const j = (await admin.query("select status, exploration_id from ci_exploration_jobs where id = $1", [job.id])).rows[0];
    assert.equal(j.status, "finished");
    assert.ok(j.exploration_id);
    assert.equal((await admin.query("select count(*)::int as n from ci_explorations where project_id = $1", [projectId])).rows[0].n, 2);
    // A task credential is refused for another task's exploration, and on job routes.
    const wrong = signSummaryCredential(RUNNER_TOKEN, { runnerName: "fenvix-x-other", repositoryId: REPOS.shop.id, task: { kind: "exploration", id: job.id }, exp: Math.floor(Date.now() / 1000) + 600 });
    await send(wrong, `${day}T02:20:00Z`);
    assert.equal((await admin.query("select count(*)::int as n from ci_explorations where project_id = $1", [projectId])).rows[0].n, 2);
  });

  // ---------------------------------------------------------------- the API: pagination, export, sessions

  it("G-1628: defects are paginated (limit, offset, total)", async () => {
    const t = await token(org.userId);
    for (let i = 0; i < 3; i++) {
      await admin.query(`insert into ci_defects (workspace_id, project_id, test_id, status, cause, minimal_order, family_key, first_seen_at, last_seen_at, language)
        values ($1, $2, $3, 'reported', 'unknown', array[$3], '<none>', now(), now() - make_interval(mins => $4), 'python')`, [org.workspaceId, projectId, `tests/p.py::t${i}`, i]);
    }
    const page = (await call("GET", "/v1/defects?state=all&limit=2&offset=1", t, org.workspaceId)).json();
    assert.equal(page.items.length, 2);
    assert.equal(page.total, 4);
  });

  it("G-2283: an owner exports the organization's data", async () => {
    const r = await call("GET", "/v1/organization/export", await token(org.userId), org.workspaceId);
    assert.equal(r.statusCode, 200);
    const j = r.json();
    assert.ok(j.projects.length >= 1 && j.runs.length >= 1 && j.defects.length >= 4);
  });

  it("G-2234: a token whose session was signed out is refused at once; G-2237: an HS256 project is told why", async () => {
    await admin.query("create table if not exists auth.sessions (id uuid primary key, user_id uuid, not_after timestamptz)");
    try {
      const sid = "5e5510e0-0000-4000-8000-000000000001";
      await admin.query("insert into auth.sessions (id, user_id) values ($1, $2)", [sid, org.userId]);
      const t = await token(org.userId, { session_id: sid });
      assert.equal((await call("GET", "/v1/me", t, null)).statusCode, 200);
      await admin.query("delete from auth.sessions where id = $1", [sid]);
      assert.equal((await call("GET", "/v1/me", t, null)).statusCode, 401, "signed out: refused before the token expires");
    } finally {
      await admin.query("drop table if exists auth.sessions");
    }
    const hs = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: org.userId })).toString("base64url")}.c2ln`;
    const r = await call("GET", "/v1/me", hs, null);
    assert.equal(r.statusCode, 401);
    assert.match(r.json().error.message, /HS256/);
  });

  // ---------------------------------------------------------------- deleting, unlinking, retention

  it("G-1810: an admin disconnects a project: its data goes, no project is made again, its jobs get no machine", async () => {
    const t = await token(org.userId);
    assert.equal((await call("POST", `/v1/projects/${projectId}/disconnect`, t, org.workspaceId)).statusCode, 204);
    assert.equal((await admin.query("select count(*)::int as n from ci_projects where id = $1", [projectId])).rows[0].n, 0);
    assert.equal((await admin.query("select count(*)::int as n from ci_runs where project_id = $1", [projectId])).rows[0].n, 0);
    assert.ok((await admin.query("select count(*)::int as n from ci_usage_events where repository_id = $1", [REPOS.shop.id])).rows[0].n >= 1, "usage events stay");
    const sha = "a4".repeat(20);
    h.gh.addRun("acme/shop", 61004, { event: "push", headSha: sha, headBranch: "main", message: "m" });
    await h.send("workflow_job", workflowJob("queued", { id: 96004, runId: 61004, sha, branch: "main" }));
    assert.ok(!launcher.launches.some((l) => l.jobId === 96004));
    assert.match((await admin.query("select no_machine from gh_jobs where job_id = 96004")).rows[0].no_machine, /disconnected/);
    // Asking for the setup again connects it again.
    await h.app.service.onboard(REPOS.shop.id);
    assert.equal((await admin.query("select disconnected_at from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].disconnected_at, null);
  });

  it("G-1699, G-1812, G-1816, G-2337: retention: results of old runs, old deliveries, and 30 days after an uninstall everything of it", async () => {
    await h.app.service.syncInstallation(INSTALLATION_ID);
    const pid = (await admin.query("select project_id from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].project_id;
    const run = (await admin.query(`insert into ci_runs (workspace_id, project_id, number, commit_sha, branch, trigger, status, pushed_at, started_at, finished_at, tests_total, tests_ran, tests_passed)
      values ($1, $2, 99, $3, 'main', 'push', 'passed', now() - interval '200 days', now() - interval '200 days', now() - interval '200 days', 1, 1, 1) returning id`, [org.workspaceId, pid, "b".repeat(40)])).rows[0].id;
    await admin.query("insert into ci_test_results (run_id, workspace_id, test_id, outcome) values ($1, $2, 'tests/old.py::t', 'passed')", [run, org.workspaceId]);
    await admin.query("insert into gh_webhook_deliveries (delivery_id, event, received_at) values ('old-delivery', 'push', now() - interval '40 days')");
    let out = (await admin.query("select public.gh_retention_sweep() as o")).rows[0].o;
    assert.ok(out.test_results >= 1 && out.webhook_deliveries >= 1);
    assert.equal((await admin.query("select count(*)::int as n from ci_runs where id = $1", [run])).rows[0].n, 1, "the run row and its totals stay");
    // Uninstalled 31 days ago: the purge.
    await admin.query("update gh_installations set deleted_at = now() - interval '31 days' where installation_id = $1", [INSTALLATION_ID]);
    out = (await admin.query("select public.gh_retention_sweep() as o")).rows[0].o;
    assert.equal(out.purged_installations, 1);
    assert.equal((await admin.query("select count(*)::int as n from ci_projects where installation_id = $1", [INSTALLATION_ID])).rows[0].n, 0);
    assert.equal((await admin.query("select workspace_id from gh_installations where installation_id = $1", [INSTALLATION_ID])).rows[0].workspace_id, null);
    assert.ok((await admin.query("select count(*)::int as n from ci_usage_events")).rows[0].n >= 1, "usage events stay (G-1813)");
  });

  it("G-1700, G-0634, G-1626: unlink an installation; delete the organization (owner, typing its name); delete one's account", async () => {
    // A fresh organization with a linked installation.
    const o2 = await makeOrg(admin, "gaps-second");
    h.gh.addInstallation({ id: 8888, account: { login: "second", id: 8800, type: "User" }, repos: [], selection: "selected" });
    const created = installationCreated([]);
    (created.installation as Row).id = 8888;
    ((created.installation as Row).account as Row).login = "second";
    await h.send("installation", created);
    await admin.query("select public.gh_link_installation(8888, $1, $2)", [o2.workspaceId, o2.userId]);
    const t2 = await token(o2.userId);
    assert.equal((await call("POST", "/v1/github/installations/8888/unlink", t2, o2.workspaceId)).statusCode, 204);
    assert.equal((await admin.query("select workspace_id from gh_installations where installation_id = 8888")).rows[0].workspace_id, null);
    assert.equal((await call("POST", "/v1/organization/delete", t2, o2.workspaceId, { confirmName: "wrong name" })).statusCode, 409);
    const name = (await admin.query("select name from workspaces where id = $1", [o2.workspaceId])).rows[0].name;
    assert.equal((await call("POST", "/v1/organization/delete", t2, o2.workspaceId, { confirmName: name })).statusCode, 204);
    assert.equal((await admin.query("select count(*)::int as n from workspaces where id = $1", [o2.workspaceId])).rows[0].n, 0);
    // The person, now in no organization, deletes their account.
    assert.equal((await call("POST", "/v1/me/delete", t2, null)).statusCode, 204);
    assert.equal((await admin.query("select count(*)::int as n from auth.users where id = $1", [o2.userId])).rows[0].n, 0);
  });

  it("G-1626, G-1811: the only owner of an organization with other members cannot delete their account; an only member's organization goes with them", async () => {
    const o3 = await makeOrg(admin, "gaps-third");
    const member = (await admin.query<{ id: string }>("insert into auth.users (email, raw_user_meta_data, email_confirmed_at) values ('gaps-m@gh.fenvix.invalid', '{}', now()) returning id")).rows[0]!.id;
    await admin.query("delete from workspaces where id in (select workspace_id from workspace_members where user_id = $1)", [member]);
    await admin.query("insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [o3.workspaceId, member]);
    const r = await call("POST", "/v1/me/delete", await token(o3.userId), null);
    assert.equal(r.statusCode, 409);
    assert.match(r.json().error.message, /only owner/);
    // The member leaves by deleting their account; the owner then deletes theirs: the organization goes with them.
    assert.equal((await call("POST", "/v1/me/delete", await token(member), null)).statusCode, 204);
    assert.equal((await call("POST", "/v1/me/delete", await token(o3.userId), null)).statusCode, 204);
    assert.equal((await admin.query("select count(*)::int as n from workspaces where id = $1", [o3.workspaceId])).rows[0].n, 0, "no orphan organization");
  });

});
