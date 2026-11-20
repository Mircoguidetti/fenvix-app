/**
 * The service back-end end to end (P-048), against Postgres and the fake GitHub: what the runner sends on our machines
 * reaches the customer the same way everywhere.
 *
 *   runner (progress, results with a defect bundle, the bundle itself, the summary) → the App stores it under row level
 *   security → the pull request's ONE combined comment (a matrix of two jobs: the flaky job's result is never hidden by
 *   the green one, G-0189), one check run per job (G-1645), the API (session and API key), the remote MCP server: all
 *   show the same defect with its cause, replay command and bundle. Then: the same flaky test on another pull request is
 *   the same defect with its history (G-1701, G-1702); a flaky test the summary names without a bundle is a defect
 *   (G-0184); a replay on our machines comes back to the defect and fixes it; stopping a live run ends its machine; a
 *   job that gets no machine says why on GitHub (G-1648); another organization's key sees nothing.
 *
 * Every API answer is checked against the contract (openapi/fenvix-api.yaml).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { SessionVerifier } from "../../src/auth.ts";
import { loadApiConfig } from "../../src/api/config.ts";
import { type Api, buildApi } from "../../src/api/server.ts";
import { dashboardOperations } from "../../src/api/spec.ts";
import { signSummaryCredential } from "../../src/runners/credentials.ts";
import type { Region, RunnerLaunch, RunnerLauncher, TaskLaunch } from "../../src/runners/launcher.ts";
import { responseProblems } from "../api/helpers.ts";
import {
  ACCOUNT, ADMIN_URL, CI_YAML, Harness, INSTALLATION_ID, installationCreated, makeOrg, pullRequest, REPOS, resetDb, RUNNER_TOKEN, runnerCredential,
  SUPABASE, workflowJob,
} from "../helpers/harness.ts";

type Row = Record<string, unknown>;
const H = (c: string) => c.repeat(32);
const EUR = "tests/test_money.py::test_default_currency_is_eur";
const POLLUTER = "tests/test_config.py::test_set_currency";
const SLOW = "tests/test_report.py::test_slow_render";
const summary = (name: string, extra: Row = {}) => ({ ...(JSON.parse(readFileSync(new URL(`../fixtures/runner/${name}.summary.json`, import.meta.url), "utf8")) as Row), ...extra });
const defectA = (fingerprint = H("a")) => ({
  testId: EUR, status: "reproduced", kind: "order", polluters: [POLLUTER], setters: [], order: [POLLUTER, EUR], prefixLength: 31, seed: 3, fingerprint,
  replay: { runs: 10, fails: 10, identicalFingerprint: true }, outcome: "failed",
  exception: { type: "AssertionError", phase: "call", message: "assert 'USD' == 'EUR'", location: "tests/test_money.py:12" },
  divergence: { index: 412, reason: "outcome-only", description: "config.CURRENCY read 'USD' (set by test_set_currency)" },
  engineVersion: "0.1.0", language: "python", replayCommand: "pytest --det --det-seed=3 --det-order=<bundle>/order.txt -n 0",
});
const BUNDLE = Buffer.from("H4sIAAAAAAAAA+3OMQqAMBBE0a2ICtpkS8OyGAqEuX6O4OENQ+Nw4V77Ts2r/b8f3wA=", "base64");

class FakeLauncher implements RunnerLauncher {
  launches: RunnerLaunch[] = [];
  tasks: TaskLaunch[] = [];
  ended: string[] = [];
  canPlace(_r: Region) { return true; }
  async launch(l: RunnerLaunch) { this.launches.push(l); return { instanceId: `i-${l.jobId}`, already: false }; }
  async launchTask(t: TaskLaunch) { this.tasks.push(t); return { instanceId: `i-${t.taskId.slice(0, 8)}`, already: false }; }
  async terminateRunner(_r: Region, name: string) { this.ended.push(name); return [`i-${name}`]; }
}

describe("service back-end: runner → API stores → PR comment + check runs + API + MCP show the same defect", () => {
  const h = new Harness();
  const launcher = new FakeLauncher();
  let admin: pg.Client;
  let api: Api;
  let signKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let org: { userId: string; workspaceId: string };
  let other: { userId: string; workspaceId: string };
  let defectId = "";
  let readKey = "";
  let replayKey = "";
  let otherKey = "";
  const PR_SHA = "1".repeat(40);
  const PR2_SHA = "2".repeat(40);

  const token = (userId: string) => new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(`${SUPABASE}/auth/v1`)
    .setAudience("authenticated").setSubject(userId).setIssuedAt().setExpirationTime("1h").sign(signKey);
  const OPS = new Map(dashboardOperations().map((o) => [o.operationId, o]));
  /** One API call; every answer with a JSON body is checked against the contract. */
  const call = async (operationId: string, url: string, o: { method?: string; auth: string; ws?: string; body?: unknown } ) => {
    const r = await api.fastify.inject({
      method: (o.method ?? "GET") as "GET", url, headers: { authorization: `Bearer ${o.auth}`, ...(o.ws ? { "x-fenvix-workspace": o.ws } : {}), ...(o.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(o.body !== undefined ? { payload: JSON.stringify(o.body) } : {}),
    });
    const op = OPS.get(operationId)!;
    // A 2xx answer matches the operation's response schema; any other answer is the contract's error shape.
    if (/json/.test(String(r.headers["content-type"] ?? ""))) {
      const problems = r.statusCode < 300 ? responseProblems(op, r.statusCode, r.json()) : responseProblems(op, 0, r.json()).length && op.responses.default
        ? responseProblems({ ...op, responses: { "0": op.responses.default } }, 0, r.json()) : [];
      assert.deepEqual(problems, [], `${operationId} ${r.statusCode} ${r.body.slice(0, 300)}`);
    }
    return r;
  };
  const runner = (path: string, name: string, runId: number | undefined, body: Row) => h.app.fastify.inject({
    method: "POST", url: `/v1/runner/${path}`, headers: { authorization: `Bearer ${runnerCredential(name, REPOS.shop.id, runId)}`, "content-type": "application/json" }, payload: body,
  }).then(async (r) => { await h.app.service.idle(); return r; });
  const mcp = (key: string, body: Row) => api.fastify.inject({ method: "POST", url: "/v1/mcp", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, payload: JSON.stringify(body) });
  const comment = () => [...h.gh.repos.get("acme/shop")!.comments.values()];

  before(async () => {
    admin = await resetDb();
    await h.start({ PUBLIC_API_URL: "https://api.fenvix.test" }, { launcher });
    org = await makeOrg(admin, "backend-owner");
    other = await makeOrg(admin, "backend-other");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await admin.query("select public.gh_link_installation($1, $2, $3)", [INSTALLATION_ID, org.workspaceId, org.userId]);
    await h.app.service.onInstallationLinked(INSTALLATION_ID);
    await h.app.service.idle();
    assert.ok((await admin.query("select project_id from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].project_id, "the project exists");
    // The pull request both jobs run for.
    const shop = h.gh.repos.get("acme/shop")!;
    shop.pulls.push({ number: 12, headRef: "feature", headSha: PR_SHA, state: "open", title: "Currency", body: "" } as never);
    h.gh.addRun("acme/shop", 51000, { event: "pull_request", headSha: PR_SHA, headBranch: "feature", message: "Currency", pullRequests: [12] });
    await h.send("pull_request", pullRequest("opened", { number: 12, headRef: "feature", headSha: PR_SHA }));
    // The API, on the same database, as fenvix_api; sessions signed by a local key.
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    signKey = privateKey;
    const u = new URL(ADMIN_URL); u.username = "fenvix_api"; u.password = "local-test-only";
    const cfg = loadApiConfig({ NODE_ENV: "test", API_DATABASE_URL: u.toString(), SUPABASE_URL: SUPABASE, STATE_SIGNING_KEY: "state-signing-key-for-tests-0123456789",
      DASHBOARD_URL: "https://app.fenvix.test", GITHUB_APP_SLUG: "fenvix-test", DB_POOL_MAX: "4", LOG_LEVEL: "silent" });
    api = buildApi({ cfg, queue: { enqueue: async () => {} }, logger: false, sessions: new SessionVerifier(SUPABASE, "", createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" }] })) });
  });
  after(async () => { await api?.close(); await h.stop(); await admin.end(); });

  it("1. a matrix of two jobs starts: two machines, two running runs, two check runs named after their jobs", async () => {
    for (const [id, name] of [[91001, "test (3.11)"], [91002, "test (3.12)"]] as const) {
      await h.send("workflow_job", workflowJob("queued", { id, runId: 51000, sha: PR_SHA, branch: "feature", name }));
      await h.send("workflow_job", workflowJob("in_progress", { id, runId: 51000, sha: PR_SHA, branch: "feature", name, runner: `fenvix-j${id}` }));
    }
    assert.deepEqual(launcher.launches.map((l) => l.runnerName), ["fenvix-j91001", "fenvix-j91002"]);
    const names = [...h.gh.repos.get("acme/shop")!.checkRuns.values()].map((c) => c.name).sort();
    assert.deepEqual(names, ["fenvix / test (3.11)", "fenvix / test (3.12)"]);
    assert.equal((await admin.query("select count(*)::int as n from ci_runs where status = 'running'")).rows[0].n, 2);
  });

  it("2. live progress reaches the API's run (the dashboard's live view)", async () => {
    const r = await runner("progress", "fenvix-j91001", 51000, { runId: 51000, seq: 3, phase: "testing", testsTotal: 56, testsDone: 20, passed: 19, failed: 1, skippedWithProof: 0, currentTest: EUR, elapsedMs: 9000 });
    assert.equal(r.statusCode, 202);
    const run = (await admin.query("select id from ci_runs r join gh_jobs j on j.ci_run_id = r.id where j.job_id = 91001")).rows[0];
    const got = await call("getRun", `/v1/runs/${run.id}`, { auth: await token(org.userId), ws: org.workspaceId });
    assert.equal(got.statusCode, 200);
    assert.deepEqual([got.json().run.progress.phase, got.json().run.progress.testsDone, got.json().run.progress.currentTest], ["testing", 20, EUR]);
  });

  it("3. job 1 sends its results (a flaky defect), its bundle and its summary, then completes: the comment is red and lists job 2 as running", async () => {
    const results = {
      runId: 51000, chunk: 0, chunks: 1, engineRunId: "20261120T100000-1", seed: 3,
      tests: [{ testId: EUR, outcome: "failed", durationMs: 4, failure: { kind: "flaky_defect", defectFingerprint: H("a") } }, { testId: POLLUTER, outcome: "passed", durationMs: 2 }],
      defects: [defectA()],
    };
    assert.equal((await runner("results", "fenvix-j91001", 51000, results)).statusCode, 202);
    const sha = createHash("sha256").update(BUNDLE).digest("hex");
    const b = await runner("bundles", "fenvix-j91001", 51000, { runId: 51000, testId: EUR, fingerprint: H("a"), sha256: sha, content: BUNDLE.toString("base64") });
    assert.equal(b.statusCode, 202, b.body);
    const flaky = summary("job2-warm-real-failure", { failed: [], flaky: [{ nodeid: EUR, replay: "python -m pytest --det -p no:randomly  # whole suite, same order", minimise: null }] });
    assert.equal((await h.summary({ runId: 51000, runner: "fenvix-j91001", summary: flaky })).statusCode, 202);
    await h.send("workflow_job", workflowJob("completed", { id: 91001, runId: 51000, sha: PR_SHA, branch: "feature", name: "test (3.11)", runner: "fenvix-j91001", conclusion: "failure" }));
    const c = comment();
    assert.equal(c.length, 1);
    assert.match(c[0]!.body, /### ❌ fenvix · 1 failed · 1 flaky defect/);
    assert.match(c[0]!.body, /\| CI \/ test \(3\.12\) \| ⏳ running \|/);
    defectId = (await admin.query("select id from ci_defects where test_id = $1", [EUR])).rows[0].id;
    // The defect, with its cause (the first divergent event), the minimal order, its replay command and the replay link.
    assert.match(c[0]!.body, /runs diverge at event 412 \(outcome-only\): config\.CURRENCY read 'USD'/);
    assert.match(c[0]!.body, /seed 3 · minimal order `tests\/test_config\.py::test_set_currency` → `tests\/test_money\.py::test_default_currency_is_eur`/);
    assert.match(c[0]!.body, new RegExp(`pytest --det --det-seed=3 --det-order=\\.fenvix/defects/${defectId}/order\\.txt -n 0`));
    assert.match(c[0]!.body, new RegExp(`curl -fsSL -H "Authorization: Bearer \\$FENVIX_API_KEY" https://api\\.fenvix\\.dev/v1/defects/${defectId}/bundle`));
    assert.match(c[0]!.body, new RegExp(`\\[replay it on fenvix\\]\\(https://app\\.fenvix\\.test/defects/${defectId}\\?replay=1\\)`));
  });

  it("4. job 2 passes: it does not overwrite job 1 (G-0189): the one comment stays red and shows both jobs", async () => {
    assert.equal((await h.summary({ runId: 51000, runner: "fenvix-j91002", summary: summary("job3-warm-pass") })).statusCode, 202);
    await h.send("workflow_job", workflowJob("completed", { id: 91002, runId: 51000, sha: PR_SHA, branch: "feature", name: "test (3.12)", runner: "fenvix-j91002", conclusion: "success" }));
    const c = comment();
    assert.equal(c.length, 1, "one comment for the pull request");
    assert.match(c[0]!.body, /### ❌ fenvix/);
    assert.doesNotMatch(c[0]!.body, /### ✅/);
    assert.match(c[0]!.body, /\| CI \/ test \(3\.11\) \| ❌ 1 failed \(1 flaky\) \|/);
    assert.match(c[0]!.body, /\| CI \/ test \(3\.12\) \| ✅ passed \|/);
    const checks = [...h.gh.repos.get("acme/shop")!.checkRuns.values()];
    assert.deepEqual(checks.map((x) => [x.name, x.conclusion]).sort(), [["fenvix / test (3.11)", "failure"], ["fenvix / test (3.12)", "success"]]);
    // The flaky defect is annotated on its file and line (G-1646).
    const sent = h.gh.exchanges.filter((x) => x.method !== "GET" && /\/check-runs/.test(x.path)).map((x) => (x.body as { output?: { annotations?: Row[] } }).output?.annotations ?? []).flat();
    assert.deepEqual(sent.map((a) => [a.path, a.start_line, a.annotation_level]), [["tests/test_money.py", 12, "warning"]]);
  });

  it("5. the API shows the same defect: cause, replay command, bundle; history; members change its state", async () => {
    const t = await token(org.userId);
    const d = await call("getDefect", `/v1/defects/${defectId}`, { auth: t, ws: org.workspaceId });
    assert.equal(d.statusCode, 200);
    const j = d.json();
    assert.deepEqual([j.testId, j.cause, j.causeTests, j.status, j.occurrences, j.divergence.index], [EUR, "polluter", [POLLUTER], "reproduced", 1, 412]);
    assert.equal(j.replayCommand, defectA().replayCommand);
    assert.equal(j.bundle.sha256, createHash("sha256").update(BUNDLE).digest("hex"));
    const hist = await call("listDefectOccurrences", `/v1/defects/${defectId}/occurrences`, { auth: t, ws: org.workspaceId });
    assert.deepEqual(hist.json().items.map((o: Row) => [o.source, o.pullRequest, o.fingerprint, typeof o.at]), [["run", 12, H("a"), "string"]]);
    // P-049's signed link: { url, expiresAt, sha256, bytes }; the url works without any header, for 5 minutes.
    const link = await call("getDefectBundle", `/v1/defects/${defectId}/bundle`, { auth: t, ws: org.workspaceId });
    assert.equal(link.statusCode, 200);
    assert.deepEqual([link.json().sha256, link.json().bytes], [createHash("sha256").update(BUNDLE).digest("hex"), BUNDLE.length]);
    const u = new URL(link.json().url);
    const got = await api.fastify.inject({ method: "GET", url: u.pathname + u.search });
    assert.deepEqual([got.statusCode, got.rawPayload], [200, BUNDLE]);
    assert.equal((await api.fastify.inject({ method: "GET", url: (u.pathname + u.search).slice(0, -2) + "xx" })).statusCode, 404, "a forged link");
    const bundle = await call("downloadDefectBundle", `/v1/defects/${defectId}/bundle/download`, { auth: t, ws: org.workspaceId });
    assert.equal(bundle.statusCode, 200);
    assert.deepEqual(bundle.rawPayload, BUNDLE);
    // A member mutes it, then reopens it; the audit log says who did (G-1625, G-1632).
    const muted = await call("setDefectState", `/v1/defects/${defectId}/state`, { method: "POST", auth: t, ws: org.workspaceId, body: { state: "muted", reason: "known, tracked in #42" } });
    assert.deepEqual([muted.json().state, muted.json().stateReason], ["muted", "known, tracked in #42"]);
    assert.equal((await call("setDefectState", `/v1/defects/${defectId}/state`, { method: "POST", auth: t, ws: org.workspaceId, body: { state: "open" } })).json().state, "open");
    const log = (await call("listAuditEvents", "/v1/organization/audit-log", { auth: t, ws: org.workspaceId })).json().items;
    assert.deepEqual(log.slice(0, 2).map((e: Row) => [e.action, (e.actor as Row).kind, e.target]), [["defect.open", "person", EUR], ["defect.muted", "person", EUR]]);
    assert.ok(log.some((e: Row) => e.action === "github.linked"), "linking GitHub is in the audit log");
  });

  it("6. API keys: owners create them (shown once); a key reads runs, defects and the bundle of its organization only", async () => {
    const t = await token(org.userId);
    const k1 = await call("createApiKey", "/v1/api-keys", { method: "POST", auth: t, ws: org.workspaceId, body: { name: "ci script" } });
    assert.equal(k1.statusCode, 201);
    readKey = k1.json().key;
    assert.match(readKey, /^fxk_[A-Za-z0-9]{40}$/);
    const list = await call("listApiKeys", "/v1/api-keys", { auth: t, ws: org.workspaceId });
    assert.ok(!JSON.stringify(list.json()).includes(readKey), "the key itself is never listed");
    assert.equal((await admin.query("select count(*)::int as n from ci_api_keys where key_hash = $1", [createHash("sha256").update(readKey).digest("hex")])).rows[0].n, 1);
    // With the key: no organization header needed.
    const ds = await call("listDefects", "/v1/defects", { auth: readKey });
    assert.deepEqual(ds.json().items.map((x: Row) => x.id), [defectId]);
    const b = await call("downloadDefectBundle", `/v1/defects/${defectId}/bundle/download`, { auth: readKey });
    assert.deepEqual(b.rawPayload, BUNDLE);
    // A key cannot do what needs a person, nor ask for replays without the replay scope.
    assert.equal((await call("listApiKeys", "/v1/api-keys", { auth: readKey })).statusCode, 403);
    assert.equal((await call("setDefectState", `/v1/defects/${defectId}/state`, { method: "POST", auth: readKey, body: { state: "muted" } })).statusCode, 403);
    assert.equal((await call("requestDefectReplay", `/v1/defects/${defectId}/replays`, { method: "POST", auth: readKey, body: {} })).statusCode, 403);
    // Another organization's key sees nothing of it.
    const ko = await call("createApiKey", "/v1/api-keys", { method: "POST", auth: await token(other.userId), ws: other.workspaceId, body: { name: "other" } });
    otherKey = ko.json().key;
    assert.equal((await call("getDefect", `/v1/defects/${defectId}`, { auth: otherKey })).statusCode, 404);
    assert.equal((await call("getDefectBundle", `/v1/defects/${defectId}/bundle`, { auth: otherKey })).statusCode, 404);
    assert.equal((await call("downloadDefectBundle", `/v1/defects/${defectId}/bundle/download`, { auth: otherKey })).statusCode, 404);
    assert.equal((await call("listDefects", "/v1/defects", { auth: otherKey, ws: org.workspaceId })).statusCode, 404, "a key cannot name another organization");
    assert.deepEqual((await call("listDefects", "/v1/defects", { auth: otherKey })).json().items, []);
    // Revoked: refused at once.
    const k2 = await call("createApiKey", "/v1/api-keys", { method: "POST", auth: t, ws: org.workspaceId, body: { name: "revoked", scopes: ["read"] } });
    await call("revokeApiKey", `/v1/api-keys/${k2.json().id}/revoke`, { method: "POST", auth: t, ws: org.workspaceId });
    assert.equal((await call("listDefects", "/v1/defects", { auth: k2.json().key })).statusCode, 401);
  });

  it("7. the remote MCP server: initialize, tools, and the same defect with its replay command; the bundle; another key sees nothing", async () => {
    const init = await mcp(readKey, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent", version: "1" } } });
    assert.equal(init.json().result.serverInfo.name, "fenvix");
    assert.equal((await mcp(readKey, { jsonrpc: "2.0", method: "notifications/initialized" })).statusCode, 202);
    const tools = (await mcp(readKey, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json().result.tools.map((t: Row) => t.name);
    assert.deepEqual(tools, ["failures_for", "get_test_log", "wait_for_run", "replay", "list_projects", "list_runs", "list_defects", "get_defect", "pull_bundle", "request_replay", "get_replay"]);
    assert.match(init.json().result.instructions, /push your fix; \(2\) wait_for_run/);
    // The agent's loop: the PR's failures (finished: no wait), the flaky test with its divergent event and replay command.
    const pid = (await admin.query("select project_id from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].project_id;
    const waited = (await mcp(readKey, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "wait_for_run", arguments: { projectId: pid, pullRequest: 12 } } })).json().result.structuredContent;
    assert.deepEqual([waited.status, waited.callAgain], ["failed", false]);
    const flaky = waited.items.find((x: Row) => x.testId === EUR);
    assert.deepEqual([flaky.kind, flaky.defectId, (flaky.divergence as Row).index, flaky.new], ["flaky_defect", defectId, 412, true]);
    assert.match(flaky.replayCommand, /--det-order=\.fenvix\/defects\//);
    const got = (await mcp(readKey, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_defect", arguments: { defectId } } })).json().result;
    assert.equal(got.isError, false);
    assert.equal(got.structuredContent.defect.id, defectId);
    assert.equal(got.structuredContent.defect.replayCommand, defectA().replayCommand);
    assert.equal(got.structuredContent.defect.divergence.index, 412);
    const pulled = (await mcp(readKey, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pull_bundle", arguments: { defectId } } })).json().result;
    assert.deepEqual(Buffer.from(pulled.content[0].resource.blob, "base64"), BUNDLE);
    const stranger = (await mcp(otherKey, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_defect", arguments: { defectId } } })).json().result;
    assert.equal(stranger.isError, true);
    assert.equal((await mcp("fxk_" + "x".repeat(40), { jsonrpc: "2.0", id: 6, method: "tools/list" })).statusCode, 401);
    const noReplay = (await mcp(readKey, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "request_replay", arguments: { defectId } } })).json().result;
    assert.equal(noReplay.isError, true);
  });

  it("8. a replay on our machines (asked through MCP), reported back: 10 of 10 passing on a later commit fixes the defect", async () => {
    const k = await call("createApiKey", "/v1/api-keys", { method: "POST", auth: await token(org.userId), ws: org.workspaceId, body: { name: "agent", scopes: ["read", "replay"] } });
    replayKey = k.json().key;
    const asked = (await mcp(replayKey, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "request_replay", arguments: { defectId, commitSha: PR2_SHA } } })).json().result;
    assert.equal(asked.isError, false, JSON.stringify(asked));
    const replayId = asked.structuredContent.id as string;
    assert.equal(asked.structuredContent.requestedVia, "mcp");
    const tick = await h.app.service.tasks.tick();
    assert.equal(tick.dispatched, 1);
    const task = launcher.tasks.at(-1)!;
    assert.deepEqual([task.kind, task.taskId, task.commitSha, (task.spec as Row).bundleUrl], ["replay", replayId, PR2_SHA, `https://api.fenvix.test/v1/runner/replays/${replayId}/bundle`]);
    // The machine fetches the bundle and reports, with its own task credential.
    const cred = signSummaryCredential(RUNNER_TOKEN, { runnerName: task.runnerName, repositoryId: REPOS.shop.id, task: { kind: "replay", id: replayId }, exp: Math.floor(Date.now() / 1000) + 600 });
    const got = await h.app.fastify.inject({ method: "GET", url: `/v1/runner/replays/${replayId}/bundle`, headers: { authorization: `Bearer ${cred}` } });
    assert.deepEqual(got.rawPayload, BUNDLE);
    // A CI job's credential is refused on the replay routes, and the task credential on the job routes.
    assert.equal((await runner("replays", "fenvix-j91001", 51000, { replayId, event: "started" })).statusCode, 403);
    const asJob = await h.app.fastify.inject({ method: "POST", url: "/v1/runner/results", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" }, payload: { runId: 51000, chunk: 0 } });
    assert.equal(asJob.statusCode, 403);
    const report = (b: Row) => h.app.fastify.inject({ method: "POST", url: "/v1/runner/replays", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" }, payload: b });
    assert.equal((await report({ replayId, event: "started" })).statusCode, 202);
    assert.equal((await report({ replayId, event: "finished", outcome: "passed", runs: 10, fails: 0, fingerprint: H("b"), identicalFingerprint: true })).statusCode, 202);
    const d = (await call("getDefect", `/v1/defects/${defectId}`, { auth: readKey })).json();
    assert.deepEqual([d.state, d.lastReplay.state, d.lastReplay.verdict, d.lastReplay.runs, d.lastReplay.fails], ["fixed", "done", "passed", 10, 0]);
    // The run's replays (P-049's list) show it too, in their shape.
    assert.equal((await call("getReplay", `/v1/replays/${replayId}`, { auth: readKey })).json().verdict, "passed");
  });

  it("9. the same flaky test on another pull request: the same defect (another fingerprint), seen twice across two pull requests; it opens again", async () => {
    const shop = h.gh.repos.get("acme/shop")!;
    shop.pulls.push({ number: 13, headRef: "other", headSha: PR2_SHA, state: "open", title: "Other", body: "" } as never);
    h.gh.addRun("acme/shop", 52000, { event: "pull_request", headSha: PR2_SHA, headBranch: "other", message: "Other", pullRequests: [13] });
    await h.send("pull_request", pullRequest("opened", { number: 13, headRef: "other", headSha: PR2_SHA }));
    await h.send("workflow_job", workflowJob("queued", { id: 92001, runId: 52000, sha: PR2_SHA, branch: "other", name: "test (3.11)" }));
    await h.send("workflow_job", workflowJob("in_progress", { id: 92001, runId: 52000, sha: PR2_SHA, branch: "other", name: "test (3.11)", runner: "fenvix-j92001" }));
    await runner("results", "fenvix-j92001", 52000, { runId: 52000, chunk: 0, chunks: 1, tests: [{ testId: EUR, outcome: "failed", durationMs: 4, failure: { kind: "flaky_defect", defectFingerprint: H("c") } }], defects: [defectA(H("c"))] });
    await h.summary({ runId: 52000, runner: "fenvix-j92001", summary: summary("job2-warm-real-failure", { failed: [], flaky: [{ nodeid: EUR, replay: "x", minimise: null }] }) });
    await h.send("workflow_job", workflowJob("completed", { id: 92001, runId: 52000, sha: PR2_SHA, branch: "other", name: "test (3.11)", runner: "fenvix-j92001", conclusion: "failure" }));
    assert.equal((await admin.query("select count(*)::int as n from ci_defects where test_id = $1", [EUR])).rows[0].n, 1, "one defect per flaky test");
    const d = (await call("getDefect", `/v1/defects/${defectId}`, { auth: readKey })).json();
    assert.deepEqual([d.occurrences, d.fingerprint, d.state], [2, H("c"), "open"]);
    const hist = (await call("listDefectOccurrences", `/v1/defects/${defectId}/occurrences`, { auth: readKey })).json().items;
    assert.deepEqual(hist.map((o: Row) => [o.pullRequest, o.fingerprint, o.fingerprintChanged]), [[13, H("c"), true], [12, H("a"), false]]);
    const pr13 = comment().find((c) => c.issue === 13)!;
    assert.match(pr13.body, /seen in 2 runs across 2 pull requests/);
  });

  it("10. a flaky test the summary names without any bundle is a defect too (G-0184)", async () => {
    const sha = "3".repeat(40);
    h.gh.addRun("acme/shop", 53000, { event: "push", headSha: sha, headBranch: "main", message: "Main", pullRequests: [] });
    await h.send("workflow_job", workflowJob("queued", { id: 93001, runId: 53000, sha, branch: "main" }));
    await h.send("workflow_job", workflowJob("in_progress", { id: 93001, runId: 53000, sha, branch: "main", runner: "fenvix-j93001" }));
    await h.summary({ runId: 53000, runner: "fenvix-j93001", summary: summary("job2-warm-real-failure", { failed: [], flaky: [{ nodeid: SLOW, replay: "python -m pytest --det tests/test_report.py", minimise: null }] }) });
    await h.send("workflow_job", workflowJob("completed", { id: 93001, runId: 53000, sha, branch: "main", runner: "fenvix-j93001", conclusion: "failure" }));
    const run = (await admin.query("select r.tests_flaky_defects from ci_runs r join gh_jobs j on j.ci_run_id = r.id where j.job_id = 93001")).rows[0];
    const ds = (await call("listDefects", "/v1/defects?state=all", { auth: readKey })).json().items.filter((x: Row) => x.testId === SLOW);
    assert.equal(run.tests_flaky_defects, 1);
    assert.equal(ds.length, 1, "the run's flaky defect is in the defect list");
    assert.deepEqual([ds[0].status, ds[0].cause, ds[0].replayCommand], ["reported", "unknown", "python -m pytest --det tests/test_report.py"]);
  });

  it("11. the live view: tests as they finish, workers, a stop armed for the first failure ends the machine; the agent reads the failure and its log", async () => {
    const sha = "4".repeat(40);
    h.gh.addRun("acme/shop", 54000, { event: "push", headSha: sha, headBranch: "main", message: "Main", pullRequests: [] });
    await h.send("workflow_job", workflowJob("queued", { id: 94001, runId: 54000, sha, branch: "main" }));
    await h.send("workflow_job", workflowJob("in_progress", { id: 94001, runId: 54000, sha, branch: "main", runner: "fenvix-j94001" }));
    const runId = (await admin.query("select ci_run_id from gh_jobs where job_id = 94001")).rows[0].ci_run_id;
    assert.equal((await call("stopRun", `/v1/runs/${runId}/stop`, { method: "POST", auth: readKey, body: { when: "now" } })).statusCode, 403, "a key cannot stop runs");
    // Armed for the first failure: nothing yet; the live progress brings a failed test: requested.
    const t = await token(org.userId);
    const armed = await call("stopRun", `/v1/runs/${runId}/stop`, { method: "POST", auth: t, ws: org.workspaceId, body: { when: "first_failure" } });
    assert.deepEqual([armed.statusCode, armed.json().run.stop.state, armed.json().run.stop.when], [202, "armed", "first_failure"]);
    await runner("progress", "fenvix-j94001", 54000, { runId: 54000, seq: 1, phase: "testing", testsTotal: 3, testsDone: 2, passed: 1, failed: 1, skippedWithProof: 0, elapsedMs: 900,
      currentTest: "t::c", workers: [{ id: "gw0", currentTest: "t::c", testsDone: 2, state: "running" }],
      finished: [{ testId: "t::a", outcome: "passed", durationMs: 3, worker: "gw0" }, { testId: "t::b", outcome: "failed", durationMs: 4, worker: "gw0", output: "boom\nTraceback...", failure: { kind: "real", exceptionType: "AssertionError", message: "assert 1 == 2", location: "t.py:9" } }] });
    const live = await call("listLiveTests", `/v1/runs/${runId}/tests/live?afterSeq=0`, { auth: t, ws: org.workspaceId });
    assert.deepEqual(live.json().items.map((x: Row) => [x.testId, x.seq, x.worker]), [["t::a", 1, "gw0"], ["t::b", 2, "gw0"]]);
    assert.equal(live.json().lastSeq, 2);
    assert.deepEqual((await call("listLiveTests", `/v1/runs/${runId}/tests/live?afterSeq=2`, { auth: t, ws: org.workspaceId })).json().items, []);
    const detail = (await call("getRun", `/v1/runs/${runId}`, { auth: t, ws: org.workspaceId })).json().run;
    assert.deepEqual([detail.stop.state, detail.progress.workers[0].id, detail.job.name, detail.githubJobId], ["requested", "gw0", "test", 94001]);
    await h.app.service.sweep();
    assert.deepEqual(launcher.ended, ["fenvix-j94001"]);
    // The coding agent's view of it: the failure with its log excerpt and the full log.
    const f = (await call("listFailures", `/v1/failures?runId=${runId}`, { auth: readKey })).json();
    assert.deepEqual([f.status, f.items[0].testId, f.items[0].new, f.items[0].logExcerpt], ["running", "t::b", true, "boom\nTraceback..."]);
    assert.equal((await call("getTestLog", `/v1/runs/${runId}/tests/log?testId=t::b`, { auth: readKey })).json().output, "boom\nTraceback...");
    await h.send("workflow_job", workflowJob("completed", { id: 94001, runId: 54000, sha: "4".repeat(40), branch: "main", runner: "fenvix-j94001", conclusion: "cancelled" }));
    assert.equal((await call("getRun", `/v1/runs/${runId}`, { auth: t, ws: org.workspaceId })).json().run.stop.state, "done");
    await h.app.service.sweep();
    assert.deepEqual(launcher.ended, ["fenvix-j94001"]);
  });

  it("12. a job that gets no machine says why on GitHub (G-1648): the installation of another account is not linked", async () => {
    const r = { id: 70901, name: "lonely", full_name: "loner/lonely" };
    h.gh.addInstallation({ id: 5151, account: { login: "loner", id: 5150, type: "User" }, repos: [r.id], selection: "selected" });
    h.gh.addRepo({ id: r.id, fullName: r.full_name, ownerId: 5150, files: {} });
    await h.send("installation", { ...installationCreated([r]), installation: { ...(installationCreated([r]).installation as Row), id: 5151, account: { login: "loner", id: 5150, type: "User" } } });
    const queued = workflowJob("queued", { id: 95001, runId: 55000, sha: "5".repeat(40), branch: "main", repo: r });
    queued.installation = { ...(queued.installation as Row), id: 5151 };
    await h.send("workflow_job", queued);
    const checks = [...h.gh.repos.get("loner/lonely")!.checkRuns.values()];
    assert.equal(checks.length, 1);
    assert.deepEqual([checks[0]!.name, checks[0]!.conclusion], ["fenvix / test", "action_required"]);
    assert.match(String((checks[0]!.output as Row).summary), /not connected to a fenvix organization/);
  });
});
