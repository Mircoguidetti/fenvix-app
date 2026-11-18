import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { signState } from "../../src/auth.ts";
import { runWork } from "../../src/work.ts";
import { ACCOUNT, addMember, CI_YAML, DASHBOARD, Harness, INSTALLATION_ID, installationCreated, makeOrg, REPOS, resetDb } from "../helpers/harness.ts";

describe("connecting an installation to an organization", () => {
  const h = new Harness();
  let admin: pg.Client;
  let org: { userId: string; workspaceId: string };
  let other: { userId: string; workspaceId: string };
  let memberId: string;

  before(async () => {
    admin = await resetDb();
    await h.start();
    org = await makeOrg(admin, "link-owner");
    other = await makeOrg(admin, "link-other");
    memberId = await addMember(admin, org.workspaceId, "link-member", "member");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "all" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop], "all"));
  });
  after(async () => { await h.stop(); await admin.end(); });

  // The install link itself comes from the dashboard API (POST /v1/github/install-link, src/api/github.ts), tested in
  // tests/integration/api-dashboard.test.ts with its owner, admin and member matrix.

  const setup = (q: Record<string, string>) => h.app.fastify.inject({ method: "GET", url: `/github/setup?${new URLSearchParams(q)}` });
  const where = (res: { headers: Record<string, unknown> }) => new URL(String(res.headers.location));

  it("the setup callback refuses a forged or expired state, a missing code, and an installation the person cannot see", async () => {
    let r = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "install", state: "forged.state", code: "c1" });
    assert.equal(where(r).searchParams.get("reason"), "expired");
    const old = signState(h.cfg.stateSigningKey, { workspaceId: org.workspaceId, userId: org.userId }, Date.now() - 2 * 3600_000);
    r = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "install", state: old, code: "c1" });
    assert.equal(where(r).searchParams.get("reason"), "expired");
    const state = signState(h.cfg.stateSigningKey, { workspaceId: org.workspaceId, userId: org.userId });
    r = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "install", state });
    assert.equal(where(r).searchParams.get("reason"), "incomplete");
    // GitHub says this person cannot see the installation.
    h.gh.oauthCodes.set("code-stranger", "gho_stranger");
    h.gh.userInstallations.set("gho_stranger", [999]);
    r = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "code-stranger" });
    assert.equal(where(r).searchParams.get("reason"), "not_yours");
    r = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "unknown-code" });
    assert.equal(where(r).searchParams.get("reason"), "oauth");
    assert.equal((await admin.query("select workspace_id from gh_installations")).rows[0].workspace_id, null);
  });

  it("a member (not admin) cannot link even with a valid state and code", async () => {
    const state = signState(h.cfg.stateSigningKey, { workspaceId: org.workspaceId, userId: memberId });
    h.gh.oauthCodes.set("code-member", "gho_member");
    h.gh.userInstallations.set("gho_member", [INSTALLATION_ID]);
    const r = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "code-member" });
    assert.equal(where(r).searchParams.get("reason"), "not_admin");
  });

  it("links: OAuth code exchanged, GitHub confirms the person sees the installation, back to the dashboard", async () => {
    const state = signState(h.cfg.stateSigningKey, { workspaceId: org.workspaceId, userId: org.userId });
    h.gh.oauthCodes.set("code-owner", "gho_owner");
    h.gh.userInstallations.set("gho_owner", [111, INSTALLATION_ID]);
    const r = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "code-owner" });
    assert.equal(r.statusCode, 303);
    const u = where(r);
    assert.equal(`${u.origin}${u.pathname}`, `${DASHBOARD}/projects/connect`);
    assert.equal(u.searchParams.get("github"), "connected");
    assert.equal(u.searchParams.get("account"), "acme");
    assert.deepEqual(Object.fromEntries(u.searchParams), { github: "connected", installation: String(INSTALLATION_ID), account: "acme" });
    // Linking starts the organization's 30-day shadow trial (gh_link_installation, migration 0014).
    const trial = (await admin.query("select trial_ends_at - trial_started_at = interval '30 days' as thirty, trial_ends_at > now() as active from ci_subscriptions where workspace_id = $1", [org.workspaceId])).rows[0];
    assert.deepEqual(trial, { thirty: true, active: true });
    const inst = (await admin.query("select workspace_id, linked_by from gh_installations")).rows[0];
    assert.deepEqual(inst, { workspace_id: org.workspaceId, linked_by: org.userId });
    assert.equal((await admin.query("select workspace_id from gh_repositories")).rows[0].workspace_id, org.workspaceId);
    // The OAuth exchange sent the client id and secret, and the code.
    const oauth = h.gh.exchanges.find((x) => x.path === "/login/oauth/access_token" && (x.body as { code: string }).code === "code-owner")!;
    assert.deepEqual(oauth.body, { client_id: "Iv1.testclient", client_secret: "client-secret-for-tests", code: "code-owner" });
  });

  it("another organization cannot take the installation over", async () => {
    const state = signState(h.cfg.stateSigningKey, { workspaceId: other.workspaceId, userId: other.userId });
    h.gh.oauthCodes.set("code-other", "gho_other");
    h.gh.userInstallations.set("gho_other", [INSTALLATION_ID]);
    const r = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "code-other" });
    assert.equal(where(r).searchParams.get("reason"), "other_organization");
    assert.deepEqual(Object.fromEntries(where(r).searchParams), { github: "error", reason: "other_organization" });
    assert.equal((await admin.query("select workspace_id from gh_installations")).rows[0].workspace_id, org.workspaceId);
  });

  it("an organization owner's approval request goes back to the dashboard as 'requested'", async () => {
    const r = await setup({ setup_action: "request" });
    assert.equal(where(r).searchParams.get("github"), "requested");
  });

  it("with All repositories, the dashboard asks for the onboarding pull request of one repository (work kind onboard)", async () => {
    // The dashboard API checks the organization and the role, then queues { kind: "onboard", repositoryId } (src/api/github.ts).
    await runWork(h.app.service, { kind: "onboard", repositoryId: REPOS.shop.id });
    const p = (await admin.query("select setup_state, setup_pr_number, language, test_runner from ci_projects")).rows[0];
    assert.deepEqual(p, { setup_state: "pr_open", setup_pr_number: 1, language: "python", test_runner: "pytest" });
  });

  it("every call the App made matches GitHub's REST description", () => {
    assert.deepEqual(h.gh.validateAll().map((x) => `${x.method} ${x.path} ${x.status}: ${JSON.stringify(x.problems)}`), []);
  });
});
