// Review R-016 (docs/REVIEW-R-016.md): failing tests for defects of the dashboard wiring (branch claude/dashboard-wiring).
// Every test here fails on claude/dashboard-wiring and describes the behaviour a fix must give.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { signState } from "../../src/auth.ts";
import {
  ACCOUNT, ADMIN_URL, APP_ID, CI_YAML, Harness, hook, INSTALLATION_ID, installationCreated, makeOrg, repoLite, REPOS, resetDb, runnerCredential,
  workflowJob,
} from "../helpers/harness.ts";

type Row = Record<string, unknown>;
const SUMMARY = JSON.parse(readFileSync(new URL("../fixtures/runner/job3-warm-pass.summary.json", import.meta.url), "utf8")) as Row;

/** installation.created for any installation id and account (the harness's helper has one fixed installation). */
function installed(id: number, account: { login: string; id: number; type: "User" | "Organization" }, repos: { id: number; name: string; full_name: string }[]) {
  return hook("installation", "created", (p) => {
    const i = p.installation as Row;
    p.installation = { ...i, id, app_id: APP_ID, account: { ...(i.account as Row), login: account.login, id: account.id, type: account.type },
      repository_selection: "selected", target_id: account.id, target_type: account.type,
      permissions: { checks: "write", pull_requests: "write", contents: "write", workflows: "write", actions: "read", metadata: "read" },
      events: ["push", "pull_request", "workflow_job"] };
    p.repositories = repos.map(repoLite);
  });
}

function deleted(id: number, account: { login: string; id: number; type: "User" | "Organization" }) {
  return hook("installation", "deleted", (p) => {
    const i = p.installation as Row;
    p.installation = { ...i, id, app_id: APP_ID, account: { ...(i.account as Row), login: account.login, id: account.id, type: account.type },
      target_id: account.id, target_type: account.type };
  });
}

const setup = (h: Harness, q: Record<string, string>) => h.app.fastify.inject({ method: "GET", url: `/github/setup?${new URLSearchParams(q)}` });
const linkedTo = async (admin: pg.Client, installationId: number) =>
  ((await admin.query("select workspace_id from gh_installations where installation_id = $1", [installationId])).rows[0]?.workspace_id ?? null) as string | null;

// ================================================================ the connect-GitHub flow

describe("R-016 connect GitHub: who may link an installation", () => {
  const h = new Harness();
  let admin: pg.Client;
  let mallory: { userId: string; workspaceId: string };
  const GLOBEX = { login: "globex", id: 9301, type: "Organization" as const };
  const GLOBEX_INSTALLATION = 4343;
  const GLOBEX_REPO = { id: 70301, name: "billing", full_name: "globex/billing" };

  before(async () => {
    admin = await resetDb();
    await h.start();
    mallory = await makeOrg(admin, "r016-mallory");
    // acme (an Organization account) installed the App on acme/shop and acme/web; nobody has linked it yet (GitHub's
    // own "Install" button, a Marketplace install, or an approval of a member's request carries no fenvix state).
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id, REPOS.web.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    h.gh.addRepo({ id: REPOS.web.id, fullName: REPOS.web.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    assert.equal((await h.send("installation", installationCreated([REPOS.shop, REPOS.web]))).statusCode, 202);
    h.gh.addInstallation({ id: GLOBEX_INSTALLATION, account: GLOBEX, repos: [GLOBEX_REPO.id], selection: "selected" });
    h.gh.addRepo({ id: GLOBEX_REPO.id, fullName: GLOBEX_REPO.full_name, ownerId: GLOBEX.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    assert.equal((await h.send("installation", installed(GLOBEX_INSTALLATION, GLOBEX, [GLOBEX_REPO]))).statusCode, 202);
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("F1 a GitHub user who can merely SEE an organization's installation (read access to one repository) cannot link it to their own fenvix organization", async () => {
    // mallory is an outside collaborator with read access to acme/web: GitHub lists acme's installation for her
    // (GET /user/installations lists every installation the person can access a repository of). She is not an owner
    // of the acme organization and could not have installed the App there.
    h.gh.users.set("gho_mallory", { login: "mallory", id: 5550 });
    h.gh.userInstallations.set("gho_mallory", [INSTALLATION_ID]);
    h.gh.oauthCodes.set("mallory-code", "gho_mallory");
    // Her own fenvix organization, her own valid install-link state, her own OAuth code.
    const state = signState(h.cfg.stateSigningKey, { workspaceId: mallory.workspaceId, userId: mallory.userId });
    const r = await setup(h, { installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "mallory-code" });
    assert.equal(r.statusCode, 303);
    const where = await linkedTo(admin, INSTALLATION_ID);
    const projects = (await admin.query("select full_name from ci_projects where workspace_id = $1", [mallory.workspaceId])).rows.map((x) => x.full_name);
    assert.notEqual(where, mallory.workspaceId,
      `acme's installation (every repository in it, private ones included) was linked to mallory's organization by someone who only has read access to one repository: ` +
      `redirect ${String(r.headers.location)}; her organization now lists ${JSON.stringify(projects)} and can open setup pull requests through the App. ` +
      "Only an admin of the installation's account (the account itself for a User, an organization admin for an Organization) may link it.");
  });

  it("F2 the install link's state is not bound to the person who completes the install: a victim who installs the App from an attacker's link connects their organization to the attacker's", async () => {
    // alice is an admin of the globex organization and the owner of her own fenvix organization. mallory sends her the
    // install link she got from POST /v1/github/install-link (a genuine github.com URL carrying mallory's signed state:
    // "install fenvix on globex to set up our CI"). GitHub sends alice back to /github/setup with mallory's state and
    // alice's own OAuth code; every check passes (state valid, code valid, alice can see the installation).
    h.gh.users.set("gho_alice", { login: "alice", id: 5551 });
    h.gh.orgRoles.set("globex:alice", "admin");
    h.gh.userInstallations.set("gho_alice", [GLOBEX_INSTALLATION]);
    h.gh.oauthCodes.set("alice-code", "gho_alice");
    const malloryState = signState(h.cfg.stateSigningKey, { workspaceId: mallory.workspaceId, userId: mallory.userId });
    // alice's browser follows GitHub's redirect: no fenvix session of mallory comes with it.
    const r = await setup(h, { installation_id: String(GLOBEX_INSTALLATION), setup_action: "install", state: malloryState, code: "alice-code" });
    assert.ok(r.statusCode < 500);
    assert.notEqual(await linkedTo(admin, GLOBEX_INSTALLATION), mallory.workspaceId,
      `globex's installation was linked to mallory's organization (redirect ${String(r.headers.location)}). The state proves who ASKED for the link, ` +
      "not who completes it: the link must be completed by the fenvix person named in the state, in their own signed-in session (e.g. the setup " +
      "redirect hands the code to the dashboard, which completes the link through the API with that person's token), and alice must never be " +
      "told her installation is \"connected\" when it went to someone else's organization.");
  });
});

// ================================================================ billing: run units

describe("R-016 billing: run units cannot be talked down by the job", () => {
  const h = new Harness();
  let admin: pg.Client;

  before(async () => {
    admin = await resetDb();
    await h.start();
    const org = await makeOrg(admin, "r016-units");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("F3 a job that held a fenvix machine for 60 minutes is billed at least 60 baseline minutes, whatever its summary.json says", async () => {
    const sha = "e".repeat(40);
    h.gh.addRun("acme/shop", 52001, { event: "push", headSha: sha, headBranch: "main", message: "x" });
    await h.send("workflow_job", workflowJob("queued", { id: 62001, runId: 52001, sha, branch: "main" }));
    await h.send("workflow_job", workflowJob("in_progress", { id: 62001, runId: 52001, sha, branch: "main", runner: "fenvix-m1", startedAt: "2026-11-18T10:00:00Z" }));
    // summary.json is a file the job itself writes ($RUNNER_TEMP/fenvix/summary.json, or FENVIX_SUMMARY_PATH): the
    // customer's workflow decides what it says. Here: no test time and a wall time longer than the job.
    const forged = { ...SUMMARY, test_seconds_run: 0, test_seconds_saved: 0, wall_seconds: 10_000_000 };
    assert.equal((await h.summary({ runId: 52001, runner: "fenvix-m1", summary: forged })).statusCode, 202);
    await h.send("workflow_job", workflowJob("completed", { id: 62001, runId: 52001, sha, branch: "main", runner: "fenvix-m1", conclusion: "success", startedAt: "2026-11-18T10:00:00Z", completedAt: "2026-11-18T11:00:00Z" }));
    const ev = (await admin.query("select billable, baseline_minutes, units from ci_usage_events where github_job_id = 62001")).rows[0];
    assert.ok(ev, "no usage event");
    assert.equal(ev.billable, true);
    assert.ok(Number(ev.baseline_minutes) >= 60,
      `a 60-minute job on our machine is billed ${ev.baseline_minutes} baseline minutes (${ev.units} units): baseline = test_seconds_run + ` +
      "test_seconds_saved + (job minutes - wall_seconds), all three from the job's own summary.json, with no floor. Without a summary the same " +
      "job is billed 60 minutes, so sending a forged summary makes every job free. The minutes the machine was held (GitHub's started_at to " +
      "completed_at) are a floor the job cannot change.");
  });
});

// ================================================================ the trial

describe("R-016 trial: the 30-day shadow trial and its 35% gate", () => {
  const h = new Harness();
  let admin: pg.Client;
  let first: { userId: string; workspaceId: string };
  let second: { userId: string; workspaceId: string };

  before(async () => {
    admin = await resetDb();
    await h.start({ SHADOW_MODE: "true" });
    first = await makeOrg(admin, "r016-trial-1");
    second = await makeOrg(admin, "r016-trial-2");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await h.app.service.linkInstallation(INSTALLATION_ID, first.workspaceId, first.userId);
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("F4a the run's mode is the organization's (shadow during the trial), not what the job reports", async () => {
    const sha = "f".repeat(40);
    h.gh.addRun("acme/shop", 52101, { event: "push", headSha: sha, headBranch: "main", message: "x" });
    await h.send("workflow_job", workflowJob("queued", { id: 62101, runId: 52101, sha, branch: "main" }));
    await h.send("workflow_job", workflowJob("in_progress", { id: 62101, runId: 52101, sha, branch: "main", runner: "fenvix-m1", startedAt: "2026-11-18T10:00:00Z" }));
    // The job's own files say "enforce" (summary.json's mode and the results' mode): the engine skipped tests during
    // the trial, and the run drops out of the trial's numbers.
    const cred = runnerCredential("fenvix-m1", REPOS.shop.id);
    await h.app.fastify.inject({ method: "POST", url: "/v1/runner/results", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" },
      payload: { runId: 52101, runAttempt: 1, chunk: 0, chunks: 1, mode: "enforce", tests: [{ testId: "tests/test_a.py::test_a", outcome: "passed", durationMs: 1_000_000_000, wouldSkip: true }] } });
    await h.app.service.idle();
    assert.equal((await h.summary({ runId: 52101, runner: "fenvix-m1", summary: { ...SUMMARY, mode: "enforce" } })).statusCode, 202);
    await h.send("workflow_job", workflowJob("completed", { id: 62101, runId: 52101, sha, branch: "main", runner: "fenvix-m1", conclusion: "success", startedAt: "2026-11-18T10:00:00Z", completedAt: "2026-11-18T10:05:00Z" }));
    const trial = (await admin.query("select trial_ends_at > now() as active from ci_subscriptions where workspace_id = $1", [first.workspaceId])).rows[0];
    assert.equal(trial.active, true, "the organization is in its trial");
    const run = (await admin.query("select r.mode, r.would_save_ms, r.test_time_ran_ms, r.test_time_skipped_ms from ci_runs r join gh_jobs j on j.ci_run_id = r.id where j.job_id = 62101")).rows[0];
    assert.ok(run, "no run row");
    assert.equal(run.mode, "shadow",
      "during the organization's trial the run was stored as \"" + run.mode + "\" because the job's summary.json / results said so: the trial's " +
      "share, minutes and 35% gate count only the runs the job chose to call shadow. The App knows the organization's mode (orgContext) and " +
      "must store that one.");
  });

  it("F4b a run's would-have-saved time is bounded by its own test time (the trial share stays between 0 and 1)", async () => {
    const run = (await admin.query("select r.would_save_ms, r.test_time_ran_ms, r.test_time_skipped_ms from ci_runs r join gh_jobs j on j.ci_run_id = r.id where j.job_id = 62101")).rows[0];
    const total = Number(run.test_time_ran_ms) + Number(run.test_time_skipped_ms);
    assert.ok(Number(run.would_save_ms) <= total,
      `would_save_ms = ${run.would_save_ms} for a run whose tests took ${total} ms: it is the sum of durationMs of the tests the results call ` +
      "wouldSkip, unbounded, so one test of 1e9 ms makes the trial's would-skip share far above 1 (the contract says shares are 0 to 1) and the " +
      "35% gate met.");
  });

  it("F5 a GitHub account gets one trial: reinstalling the App and linking it to a new fenvix organization does not start another", async () => {
    const t1 = (await admin.query("select trial_started_at from ci_subscriptions where workspace_id = $1", [first.workspaceId])).rows[0];
    assert.ok(t1.trial_started_at, "the first organization's trial started");
    // The same GitHub account (acme, id 9001) uninstalls and installs again: a new installation id, linked to a new
    // fenvix organization (anyone can create one: POST /v1/organizations).
    await h.send("installation", deleted(INSTALLATION_ID, ACCOUNT));
    const again = INSTALLATION_ID + 1;
    h.gh.addInstallation({ id: again, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    await h.send("installation", installed(again, ACCOUNT, [REPOS.shop]));
    await h.app.service.linkInstallation(again, second.workspaceId, second.userId);
    const t2 = (await admin.query("select trial_started_at, trial_ends_at from ci_subscriptions where workspace_id = $1", [second.workspaceId])).rows[0];
    assert.equal(t2.trial_started_at, null,
      `the same GitHub account (acme) got a second 30-day trial (${t2.trial_started_at?.toISOString?.()} to ${t2.trial_ends_at?.toISOString?.()}) ` +
      "by reinstalling and linking to a new organization: units are not billed during a trial, so this repeats every 30 days. ci_subscriptions " +
      "already records github_account; gh_link_installation must not start a trial for an account (account_id) that already had one.");
  });
});

// ================================================================ migration 0014 on existing data

describe("R-016 migration 0014 on existing data: organizations linked before the trial existed", () => {
  const h = new Harness();
  let admin: pg.Client;
  let org: { userId: string; workspaceId: string };
  const SECOND = { login: "acme-labs", id: 9002, type: "Organization" as const };
  const SECOND_INSTALLATION = 4250;
  const LABS_REPO = { id: 70401, name: "lab", full_name: "acme-labs/lab" };

  before(async () => {
    admin = await resetDb();
    await h.start();
    org = await makeOrg(admin, "r016-existing");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    // A customer of the App from before 0014: its installation was linked by 0013's gh_link_installation (no trial
    // columns then), it has runs and billable usage. After 0014 its subscription has trial_started_at = null.
    await admin.query("update gh_installations set workspace_id = $2, linked_by = $3, linked_at = now() - interval '90 days' where installation_id = $1", [INSTALLATION_ID, org.workspaceId, org.userId]);
    await admin.query("update gh_repositories set updated_at = now() where installation_id = $1", [INSTALLATION_ID]);
    await admin.query("update ci_subscriptions set trial_started_at = null, trial_ends_at = null where workspace_id = $1", [org.workspaceId]);
    h.gh.addInstallation({ id: SECOND_INSTALLATION, account: SECOND, repos: [LABS_REPO.id], selection: "selected" });
    h.gh.addRepo({ id: LABS_REPO.id, fullName: LABS_REPO.full_name, ownerId: SECOND.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installed(SECOND_INSTALLATION, SECOND, [LABS_REPO]));
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("F6 an organization that was already a customer (installation linked before 0014) is not put into a 30-day shadow trial when it links another installation", async () => {
    await h.app.service.linkInstallation(SECOND_INSTALLATION, org.workspaceId, org.userId);
    const sub = (await admin.query("select trial_started_at, trial_ends_at > now() as active from ci_subscriptions where workspace_id = $1", [org.workspaceId])).rows[0];
    assert.equal(sub.trial_started_at, null,
      "an existing customer linked a second GitHub account after 0014 and its 30-day shadow trial started now: for 30 days every job of every " +
      "repository runs in shadow mode (FENVIX_MODE=shadow: nothing is skipped), so its CI gets slower and the Overview shows a trial. The report " +
      "says \"linking a second installation does not restart the trial\", which holds only for organizations linked after 0014; 0014 must mark " +
      "organizations that already had a linked installation (e.g. trial dates in the past) so that gh_link_installation's coalesce keeps them.");
  });
});

// ================================================================ the runner's records

describe("R-016 runner records: what one machine's credential may store", () => {
  const h = new Harness();
  let admin: pg.Client;
  const cred = runnerCredential("fenvix-j63001", REPOS.shop.id, 53001);
  const post = (body: Row) => h.app.fastify.inject({ method: "POST", url: "/v1/runner/results", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" }, payload: body })
    .then(async (r) => { await h.app.service.idle(); return r; });

  before(async () => {
    admin = await resetDb();
    await h.start();
    const org = await makeOrg(admin, "r016-records");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("F7 a per-job credential (one job: run 53001, attempt 1) cannot store results for any number of other attempts and chunks", async () => {
    // The machine's job writes the spool files the poster sends (the spool is group-writable by the job user), so
    // whatever the job writes is sent with the machine's credential. runAttempt is not in the credential and chunk
    // goes to 9999: each (attempt, chunk) is a new 6 MB row of gh_run_results, kept for good.
    const big = Array.from({ length: 50 }, (_, i) => ({ testId: `tests/test_${i}.py::test_x`, outcome: "passed", durationMs: 1 }));
    const statuses: number[] = [];
    for (let attempt = 2; attempt <= 41; attempt++) statuses.push((await post({ runId: 53001, runAttempt: attempt, chunk: 9999, tests: big })).statusCode);
    statuses.push((await post({ runId: 53001, runAttempt: 1, chunk: 0, chunks: 1, tests: big })).statusCode);
    statuses.push((await post({ runId: 53001, runAttempt: 1, chunk: 9999, tests: big })).statusCode);
    const stored = (await admin.query("select run_attempt, chunk from gh_run_results where runner_name = 'fenvix-j63001' order by run_attempt, chunk")).rows;
    const foreign = stored.filter((r) => r.run_attempt !== 1 || r.chunk !== 0);
    assert.equal(foreign.length, 0,
      `one job's credential stored ${foreign.length} result chunks for attempts and chunk numbers that are not its job's (answers: ` +
      `${[...new Set(statuses)].join(", ")}). Bind runAttempt to the credential (or to the job the App launched), refuse a chunk number at or above ` +
      "the chunk count chunk 0 declared, and cap what one job may store; otherwise one job can fill the shared database " +
      "(9,999 chunks x 6 MB per attempt, unbounded attempts).");
  });
});

// ================================================================ row level security, the second barrier

describe("R-016 row level security: the owner-only rules hold in the database too", () => {
  let admin: pg.Client;
  let api: pg.Client;
  let ws = "";
  let owner = "";
  let adminUser = "";

  before(async () => {
    admin = await resetDb();
    const o = await makeOrg(admin, "r016-rls-owner");
    const a = await makeOrg(admin, "r016-rls-admin");
    ws = o.workspaceId; owner = o.userId; adminUser = a.userId;
    await admin.query("insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')", [ws, adminUser]);
    const u = new URL(ADMIN_URL); u.username = "fenvix_api"; u.password = "local-test-only";
    api = new pg.Client({ connectionString: u.toString() });
    await api.connect();
  });
  after(async () => { await api.end(); await admin.end(); });

  /** One statement as fenvix_api for (person, organization), rolled back; the rows it changed, or the error. */
  async function asApi(userId: string, sql: string, params: unknown[]): Promise<number | string> {
    await api.query("begin");
    try {
      await api.query("select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)", [userId, ws]);
      return (await api.query(sql, params)).rowCount ?? 0;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await api.query("rollback");
    }
  }

  it("F8 as fenvix_api, an admin cannot make themselves owner, demote or remove an owner, or invite an admin (only owners may)", async () => {
    const outcomes = {
      "admin promotes themselves to owner": await asApi(adminUser, "update workspace_members set role = 'owner' where workspace_id = $1 and user_id = $2", [ws, adminUser]),
      "admin demotes the owner": await asApi(adminUser, "update workspace_members set role = 'member' where workspace_id = $1 and user_id = $2", [ws, owner]),
      "admin invites an admin": await asApi(adminUser,
        "insert into workspace_invites (workspace_id, email, role, token_hash, invited_by, expires_at) values ($1, 'x@r016.test', 'admin', repeat('b', 64), $2, now() + interval '1 day')", [ws, adminUser]),
    };
    // Removing an owner: with a second owner, so that the last-owner trigger is not what stops it.
    const other = await makeOrg(admin, "r016-rls-owner-2");
    await admin.query("insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, other.userId]);
    const removeOwner = await asApi(adminUser, "delete from workspace_members where workspace_id = $1 and user_id = $2", [ws, owner]);
    const allowed = Object.entries({ ...outcomes, "admin removes an owner": removeOwner }).filter(([, v]) => typeof v === "number" && v > 0).map(([k]) => k);
    assert.deepEqual(allowed, [],
      `the database lets the API's role do, for an admin: ${allowed.join("; ")}. The report calls row level security the second barrier ` +
      "(\"changeable only when they are an owner or admin\"), but the owner-only rules (orgs.ts: owners manage admins and owners; only an owner " +
      "invites an admin) live in the API's code alone: one missing check there and an admin takes the organization over.");
  });
});
