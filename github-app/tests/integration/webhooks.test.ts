import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { CI_YAML, Harness, installationCreated, makeOrg, REPOS, resetDb, WEB_YAML, ACCOUNT, INSTALLATION_ID, pullRequest, hook, repoLite, push } from "../helpers/harness.ts";

describe("webhooks and onboarding", () => {
  const h = new Harness();
  let admin: pg.Client;

  before(async () => {
    admin = await resetDb();
    await h.start();
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id, REPOS.web.id, REPOS.docs.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML, "README.md": "# shop\n" } });
    h.gh.addRepo({ id: REPOS.web.id, fullName: REPOS.web.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/test.yaml": WEB_YAML } });
    h.gh.addRepo({ id: REPOS.docs.id, fullName: REPOS.docs.full_name, ownerId: ACCOUNT.id, files: { "README.md": "docs\n" } });
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("refuses a delivery without a valid signature", async () => {
    const p = installationCreated([REPOS.shop]);
    assert.equal((await h.send("installation", p, { secret: "not-the-secret-at-all-0000" })).statusCode, 401);
    const res = await h.app.fastify.inject({ method: "POST", url: "/webhooks/github", payload: JSON.stringify(p), headers: { "content-type": "application/json", "x-github-event": "installation", "x-github-delivery": "d-1" } });
    assert.equal(res.statusCode, 401);
    const form = await h.app.fastify.inject({ method: "POST", url: "/webhooks/github", payload: "payload=%7B%7D", headers: { "content-type": "application/x-www-form-urlencoded", "x-github-event": "ping", "x-github-delivery": "d-2" } });
    assert.ok([401, 415].includes(form.statusCode));
    assert.equal((await admin.query("select count(*)::int as n from gh_installations")).rows[0].n, 0);
  });

  it("answers ping and ignores events it does not use", async () => {
    assert.deepEqual((await h.send("ping", { zen: "Keep it logically awesome.", hook_id: 1 })).json(), { ok: true, pong: true });
    assert.equal((await h.send("star", { action: "created" })).statusCode, 202);
  });

  // Rule 3 (spec 20261126-side-by-side-runs item 6): the pull request now comes after the organization link (the kind
  // of pull request is the organization's setting, unknown before it). Before: one pull request at installation.created.
  it("installation.created: stores the installation; no pull request before the link, then one onboarding pull request per chosen repository", async () => {
    const res = await h.send("installation", installationCreated([REPOS.shop, REPOS.web, REPOS.docs]), { delivery: "inst-created-1" });
    assert.equal(res.statusCode, 202);
    const inst = (await admin.query("select * from gh_installations")).rows;
    assert.equal(inst.length, 1);
    assert.equal(inst[0].account_login, "acme");
    assert.equal(inst[0].workspace_id, null);
    assert.equal(inst[0].permissions.workflows, "write");
    const before = (await admin.query("select onboarding_state, awaiting_link, onboarding_detail from gh_repositories order by repository_id")).rows;
    assert.deepEqual(before.map((r) => [r.onboarding_state, r.awaiting_link, r.onboarding_detail]), Array(3).fill(["pending", true, "waiting for the organization link"]));
    assert.equal(h.gh.repos.get("acme/shop")!.pulls.length, 0, "no pull request before the link");
    const org = await makeOrg(admin, "webhooks-owner");
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);

    const repos = Object.fromEntries((await admin.query("select * from gh_repositories order by repository_id")).rows.map((r) => [r.full_name, r]));
    assert.equal(repos["acme/shop"].onboarding_state, "pr_open");
    assert.equal(repos["acme/shop"].onboarding_job, "test");
    assert.equal(repos["acme/shop"].detected_language, "python");
    assert.equal(repos["acme/shop"].setup_pr_url, "https://github.com/acme/shop/pull/1");
    assert.equal(repos["acme/web"].onboarding_state, "pr_open");
    assert.equal(repos["acme/web"].detected_test_runner, "vitest");
    assert.equal(repos["acme/docs"].onboarding_state, "no_workflow");
    assert.equal(repos["acme/shop"].awaiting_link, false);

    const shop = h.gh.repos.get("acme/shop")!;
    assert.equal(shop.pulls.length, 1);
    const pr = shop.pulls[0]!;
    assert.equal(pr.head, "fenvix/runs-on");
    assert.equal(pr.base, "main");
    assert.match(pr.title, /runs-on: fenvix/);
    // The branch differs from main by one line: the test job's runs-on.
    const changed = shop.branches.get("fenvix/runs-on")!.files.get(".github/workflows/ci.yml")!.text;
    assert.equal(changed, CI_YAML.replace("runs-on: ubuntu-latest  # GitHub-hosted", "runs-on: fenvix  # GitHub-hosted"));
    assert.equal(shop.branches.get("main")!.files.get(".github/workflows/ci.yml")!.text, CI_YAML);
    // The PR body shows the diff.
    assert.match(pr.body, /```diff\n--- a\/\.github\/workflows\/ci\.yml\n\+\+\+ b\/\.github\/workflows\/ci\.yml\n@@ /);
    assert.match(pr.body, /^-    runs-on: ubuntu-latest  # GitHub-hosted, 2 cores$/m);
    assert.match(pr.body, /^\+    runs-on: fenvix  # GitHub-hosted, 2 cores$/m);
    assert.match(pr.body, /Why this job: runs pytest, named like a test job/);
    assert.equal(h.gh.repos.get("acme/docs")!.pulls.length, 0);
    assert.deepEqual(h.gh.validateAll().map((x) => `${x.method} ${x.path}: ${JSON.stringify(x.problems)}`), []);
  });

  it("the same delivery twice is handled once; adding the repository again opens no second pull request", async () => {
    assert.equal((await h.send("installation", installationCreated([REPOS.shop]), { delivery: "inst-created-1" })).statusCode, 202);
    const again = hook("installation_repositories", "added", (p) => {
      const i = p.installation as Record<string, unknown>;
      p.installation = { ...i, id: INSTALLATION_ID, account: { ...(i.account as object), login: ACCOUNT.login, id: ACCOUNT.id, type: ACCOUNT.type } };
      p.repository_selection = "selected";
      p.repositories_added = [repoLite(REPOS.shop)];
      p.repositories_removed = [];
    });
    await h.send("installation_repositories", again);
    assert.equal(h.gh.repos.get("acme/shop")!.pulls.length, 1);
    const row = (await admin.query("select onboarding_state, onboarding_detail, setup_pr_number from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0];
    assert.equal(row.onboarding_state, "pr_open");
    assert.equal(row.setup_pr_number, 1);
    assert.match(row.onboarding_detail, /already open/);
  });

  it("pull_request closed and merged: the onboarding is merged", async () => {
    const shop = h.gh.repos.get("acme/shop")!;
    await h.send("pull_request", pullRequest("closed", { number: 1, headRef: "fenvix/runs-on", headSha: shop.pulls[0]!.headSha, merged: true }));
    const row = (await admin.query("select onboarding_state from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0];
    assert.equal(row.onboarding_state, "merged");
    const prRow = (await admin.query("select state from gh_pull_requests where repository_id = $1 and number = 1", [REPOS.shop.id])).rows[0];
    assert.equal(prRow.state, "merged");
  });

  it("push: records when the commit reached GitHub", async () => {
    const sha = "c".repeat(40);
    await h.send("push", push(sha, "refs/heads/feature", 1795424000));
    const row = (await admin.query("select pushed_at from gh_pushes where sha = $1", [sha])).rows[0];
    assert.equal(new Date(row.pushed_at).toISOString(), new Date(1795424000 * 1000).toISOString());
  });

  it("installation_repositories.removed and installation.deleted are recorded", async () => {
    const removed = hook("installation_repositories", "removed", (p) => {
      const i = p.installation as Record<string, unknown>;
      p.installation = { ...i, id: INSTALLATION_ID, account: { ...(i.account as object), login: ACCOUNT.login, id: ACCOUNT.id, type: ACCOUNT.type } };
      p.repository_selection = "selected";
      p.repositories_added = [];
      p.repositories_removed = [repoLite(REPOS.docs)];
    });
    await h.send("installation_repositories", removed);
    assert.ok((await admin.query("select removed_at from gh_repositories where repository_id = $1", [REPOS.docs.id])).rows[0].removed_at);
  });
});

describe("All repositories: no pull requests across the account by themselves", () => {
  const h = new Harness();
  let admin: pg.Client;
  before(async () => {
    admin = await resetDb();
    await h.start();
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "all" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("stores the repositories and waits for the dashboard", async () => {
    await h.send("installation", installationCreated([REPOS.shop], "all"));
    assert.equal(h.gh.repos.get("acme/shop")!.pulls.length, 0);
    const row = (await admin.query("select onboarding_state, onboarding_detail from gh_repositories")).rows[0];
    assert.equal(row.onboarding_state, "pending");
    assert.match(row.onboarding_detail, /dashboard/);
  });
});
