import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { signState } from "../../src/auth.ts";
import { runWork } from "../../src/work.ts";
import { ACCOUNT, addMember, CI_YAML, completeLink, DASHBOARD, githubSetup, githubUser, Harness, INSTALLATION_ID, installationCreated, makeOrg, REPOS, resetDb } from "../helpers/harness.ts";

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

  it("after 'Choose more repositories' GitHub comes back with setup_action=update and no state: updated, nothing linked", async () => {
    const completions = async () => (await admin.query("select count(*)::int as n from gh_install_completions")).rows[0].n;
    const before = await completions();
    let r = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "update" });
    assert.equal(r.statusCode, 303);
    assert.equal(where(r).pathname, "/projects/connect");
    assert.deepEqual(Object.fromEntries(where(r).searchParams), { github: "updated" });
    assert.equal(await completions(), before, "an update stored a completion");
    assert.equal((await admin.query("select workspace_id from gh_installations")).rows[0].workspace_id, null, "an update linked the installation");
    // The install path keeps its check: no state on an install, or a bad state on an update, is still "expired".
    r = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "install" });
    assert.equal(where(r).searchParams.get("reason"), "expired");
    r = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "update", state: "forged.state" });
    assert.equal(where(r).searchParams.get("reason"), "expired");
  });

  it("a GitHub user who sees the installation but does not administer its account cannot link it (review R-016 F1)", async () => {
    const state = signState(h.cfg.stateSigningKey, { workspaceId: org.workspaceId, userId: org.userId });
    // A member (not an admin) of the acme organization on GitHub.
    githubUser(h, { code: "code-gh-member", token: "gho_ghmember", login: "gh-member", id: 6101, installations: [INSTALLATION_ID] });
    h.gh.orgRoles.set("acme:gh-member", "member");
    let r = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "code-gh-member" });
    assert.deepEqual(Object.fromEntries(where(r).searchParams), { github: "error", reason: "github_not_admin" });
    // Not a member at all (an outside collaborator): GitHub answers 404 for the membership.
    githubUser(h, { code: "code-collab", token: "gho_collab", login: "collab", id: 6102, installations: [INSTALLATION_ID] });
    r = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "code-collab" });
    assert.equal(where(r).searchParams.get("reason"), "github_not_admin");
    assert.equal((await admin.query("select count(*)::int as n from gh_install_completions")).rows[0].n, 0, "nothing to complete");
    assert.equal((await admin.query("select workspace_id from gh_installations")).rows[0].workspace_id, null);
  });

  it("a member (not admin) cannot link even with a valid state and code", async () => {
    const state = signState(h.cfg.stateSigningKey, { workspaceId: org.workspaceId, userId: memberId });
    githubUser(h, { code: "code-member", token: "gho_member", login: "member-on-github", id: 6103, installations: [INSTALLATION_ID], adminOf: ["acme"] });
    const r = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "code-member" });
    assert.equal(where(r).searchParams.get("reason"), "not_admin");
  });

  it("links: OAuth code exchanged, GitHub confirms the person sees the installation and administers its account; the signed-in person completes it", async () => {
    const state = signState(h.cfg.stateSigningKey, { workspaceId: org.workspaceId, userId: org.userId });
    githubUser(h, { code: "code-owner", token: "gho_owner", login: "acme-owner", id: 6104, installations: [111, INSTALLATION_ID], adminOf: ["acme"] });
    const r = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "code-owner" });
    assert.equal(r.statusCode, 303);
    const u = where(r);
    assert.equal(`${u.origin}${u.pathname}`, `${DASHBOARD}/projects/connect`);
    // Not linked yet: the dashboard completes it with the signed-in person's token (review R-016 F2). The one-time code
    // is after "#" (never in a server log or a Referer).
    assert.deepEqual(Object.fromEntries(u.searchParams), { github: "confirm", installation: String(INSTALLATION_ID), account: "acme" });
    const completion = new URLSearchParams(u.hash.slice(1)).get("completion")!;
    assert.match(completion, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await admin.query("select workspace_id from gh_installations")).rows[0].workspace_id, null);
    const stored = (await admin.query("select code_hash, user_id, workspace_id, github_login from gh_install_completions")).rows[0];
    assert.deepEqual({ ...stored, code_hash: stored.code_hash.length }, { code_hash: 64, user_id: org.userId, workspace_id: org.workspaceId, github_login: "acme-owner" });
    // The same state again: used.
    githubUser(h, { code: "code-owner-2", token: "gho_owner", login: "acme-owner", id: 6104, installations: [INSTALLATION_ID], adminOf: ["acme"] });
    const again = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "code-owner-2" });
    assert.deepEqual(Object.fromEntries(where(again).searchParams), { github: "error", reason: "used" });
    // Another fenvix person (an admin of another organization, signed in) cannot complete it.
    assert.equal(await completeLink(h, completion, other.userId), null);
    assert.equal(await completeLink(h, "not-the-code", org.userId), null);
    assert.equal((await admin.query("select workspace_id from gh_installations")).rows[0].workspace_id, null);
    // The person the state names completes it.
    assert.deepEqual(await completeLink(h, completion, org.userId), { workspace_id: org.workspaceId, installation_id: INSTALLATION_ID, account: "acme" });
    assert.equal(await completeLink(h, completion, org.userId), null, "once only");
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
    githubUser(h, { code: "code-other", token: "gho_other", login: "other-admin", id: 6105, installations: [INSTALLATION_ID], adminOf: ["acme"] });
    const r = await setup({ installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "code-other" });
    assert.equal(where(r).searchParams.get("reason"), "other_organization");
    assert.deepEqual(Object.fromEntries(where(r).searchParams), { github: "error", reason: "other_organization" });
    assert.equal((await admin.query("select workspace_id from gh_installations")).rows[0].workspace_id, org.workspaceId);
  });

  it("an expired completion links nothing", async () => {
    // A completion stored for the other organization's owner, then expired.
    await admin.query("update gh_installations set workspace_id = null where installation_id = $1", [INSTALLATION_ID]);
    const state = signState(h.cfg.stateSigningKey, { workspaceId: other.workspaceId, userId: other.userId });
    githubUser(h, { code: "code-late", token: "gho_late", login: "late-admin", id: 6106, installations: [INSTALLATION_ID], adminOf: ["acme"] });
    const r = await githubSetup(h, { installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "code-late" });
    assert.equal(r.url.searchParams.get("github"), "confirm");
    await admin.query("update gh_install_completions set created_at = now() - interval '1 hour', expires_at = now() - interval '1 minute' where user_id = $1", [other.userId]);
    assert.equal(await completeLink(h, r.completion!, other.userId), null);
    assert.equal((await admin.query("select workspace_id from gh_installations")).rows[0].workspace_id, null);
    await admin.query("update gh_installations set workspace_id = $2 where installation_id = $1", [INSTALLATION_ID, org.workspaceId]);
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
