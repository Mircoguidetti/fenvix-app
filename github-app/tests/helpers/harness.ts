import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import pg from "pg";
import { buildApp, type App } from "../../src/app.ts";
import { SessionVerifier } from "../../src/auth.ts";
import { type Config, loadConfig } from "../../src/config.ts";
import { sign } from "../../src/github/signature.ts";
import { signSummaryCredential } from "../../src/runners/credentials.ts";
import type { RunnerLauncher } from "../../src/runners/launcher.ts";
import { runWork, type WorkQueue } from "../../src/work.ts";
import { FakeGitHub } from "./fake-github.ts";
import { checkWebhook, recordedWebhook } from "./schemas.ts";

export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:54329/gh_test";
if (/supabase\.(co|com)|pooler/.test(ADMIN_URL)) throw new Error("TEST_DATABASE_URL looks like a hosted Supabase project; the tests need a scratch database.");
const appUrl = () => { const u = new URL(ADMIN_URL); u.username = "fenvix_github_app"; u.password = "local-test-only"; return u.toString(); };

export const APP_ID = 424242;
export const WEBHOOK_SECRET = "test-webhook-secret-0123456789";
export const RUNNER_TOKEN = "runner-token-for-tests-0123456789abcdef";
export const DASHBOARD = "https://app.fenvix.test";
export const SUPABASE = "https://project.supabase.invalid";

type Json = Record<string, unknown>;

/** What a runner machine holds: its own summary credential (src/runners/credentials.ts), signed with RUNNER_TOKEN. */
export function runnerCredential(runnerName: string, repositoryId: number, runId?: number): string {
  return signSummaryCredential(RUNNER_TOKEN, { runnerName, repositoryId, ...(runId ? { runId } : {}), exp: Math.floor(Date.now() / 1000) + 3600 });
}

/** Applies the migrations once (scripts/prepare-test-db.sh) and empties the tables these tests write. */
export async function resetDb(): Promise<pg.Client> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const have = await admin.query("select to_regclass('public.gh_installations') as t");
  if (!have.rows[0].t) {
    await admin.end();
    execFileSync("bash", [fileURLToPath(new URL("../../scripts/prepare-test-db.sh", import.meta.url))], { env: { ...process.env, TEST_DATABASE_URL: ADMIN_URL }, stdio: "inherit" });
    return resetDb();
  }
  // A database prepared before migration 0015 (review R-016), 0016 (review R-016b) or 0017 (warm cache): apply what is missing, in order.
  if (!(await admin.query("select to_regclass('public.ci_trial_accounts') as t")).rows[0].t) {
    execFileSync("psql", [ADMIN_URL, "-v", "ON_ERROR_STOP=1", "-q", "-f", fileURLToPath(new URL("../../../supabase/migrations/0015_review_r016.sql", import.meta.url))], { stdio: ["ignore", "ignore", "inherit"] });
  }
  // A database prepared before migration 0016 (review R-016b).
  if (!(await admin.query("select 1 from information_schema.columns where table_name = 'ci_explorations' and column_name = 'received_at'")).rowCount) {
    execFileSync("psql", [ADMIN_URL, "-v", "ON_ERROR_STOP=1", "-q", "-f", fileURLToPath(new URL("../../../supabase/migrations/0016_review_r016b.sql", import.meta.url))], { stdio: ["ignore", "ignore", "inherit"] });
  }
  // A database prepared before migration 0017 (warm cache).
  if (!(await admin.query("select to_regclass('public.gh_warmups') as t")).rows[0].t) {
    execFileSync("psql", [ADMIN_URL, "-v", "ON_ERROR_STOP=1", "-q", "-f", fileURLToPath(new URL("../../../supabase/migrations/0017_warm_cache.sql", import.meta.url))], { stdio: ["ignore", "ignore", "inherit"] });
  }
  // A database prepared before migrations 0018 (node:test and mocha) and 0019 (parallel with proof): both are safe to repeat.
  if (!(await admin.query("select 1 from information_schema.columns where table_name = 'ci_runs' and column_name = 'exit_code'")).rowCount) {
    for (const m of ["0018_node_test_mocha_runners", "0019_run_proof"]) {
      execFileSync("psql", [ADMIN_URL, "-v", "ON_ERROR_STOP=1", "-q", "-f", fileURLToPath(new URL(`../../../supabase/migrations/${m}.sql`, import.meta.url))], { stdio: ["ignore", "ignore", "inherit"] });
    }
  }
  await admin.query(`truncate gh_install_completions, ci_trial_accounts, gh_webhook_deliveries, gh_run_summaries, gh_run_results, gh_jobs, gh_pushes, gh_pull_requests, ci_usage_events, gh_warmups, gh_repositories,
    gh_installations, ci_test_results, ci_skip_receipts, ci_audit_reruns, ci_defects, ci_explorations, ci_runs, ci_projects, ci_subscriptions cascade`);
  await admin.query("delete from auth.users where email like '%@gh.fenvix.invalid'");
  await admin.query("delete from public.workspaces w where not exists (select 1 from public.workspace_members m where m.workspace_id = w.id)");
  return admin;
}

/** A person and the organization created for them at sign-up (0001's trigger), on the given plan. */
export async function makeOrg(admin: pg.Client, name: string, plan = "team"): Promise<{ userId: string; workspaceId: string }> {
  const u = await admin.query<{ id: string }>("insert into auth.users (email, raw_user_meta_data, email_confirmed_at) values ($1, $2, now()) returning id",
    [`${name}@gh.fenvix.invalid`, JSON.stringify({ full_name: name })]);
  const userId = u.rows[0]!.id;
  const w = await admin.query<{ workspace_id: string }>("select workspace_id from workspace_members where user_id = $1", [userId]);
  const workspaceId = w.rows[0]!.workspace_id;
  await admin.query("insert into ci_subscriptions (workspace_id, plan_id) values ($1, $2)", [workspaceId, plan]);
  return { userId, workspaceId };
}

export async function addMember(admin: pg.Client, workspaceId: string, name: string, role: "admin" | "member"): Promise<string> {
  const u = await admin.query<{ id: string }>("insert into auth.users (email, raw_user_meta_data, email_confirmed_at) values ($1, '{}', now()) returning id", [`${name}@gh.fenvix.invalid`]);
  const id = u.rows[0]!.id;
  await admin.query("delete from workspaces where id in (select workspace_id from workspace_members where user_id = $1)", [id]);
  await admin.query("insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [workspaceId, id, role]);
  return id;
}

// ---------------------------------------------------------------- recorded webhook payloads, made ours

export const ACCOUNT = { login: "acme", id: 9001, type: "Organization" as const };
export const INSTALLATION_ID = 4242;
export const REPOS = {
  shop: { id: 70001, name: "shop", full_name: "acme/shop" },
  web: { id: 70002, name: "web", full_name: "acme/web" },
  docs: { id: 70003, name: "docs", full_name: "acme/docs" },
};

function first(event: string, action: string | null): Json {
  for (let i = 0; i < 40; i++) {
    let ex: Json;
    try { ex = recordedWebhook(event, action, i); } catch { break; }
    if (checkWebhook(event, ex).length === 0) return ex;
  }
  throw new Error(`no recorded ${event}.${action} that GitHub's schema accepts`);
}

function repository(base: Json, r: { id: number; name: string; full_name: string }): Json {
  const owner = { ...(base.owner as Json), login: ACCOUNT.login, id: ACCOUNT.id, type: ACCOUNT.type };
  return { ...base, id: r.id, name: r.name, full_name: r.full_name, owner, private: true, default_branch: "main", html_url: `https://github.com/${r.full_name}` };
}

const installationLite = (id = INSTALLATION_ID) => ({ id, node_id: "MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9uNDI0Mg==" });

/**
 * A webhook payload GitHub recorded (@octokit/webhooks-examples) for this event and action, with our installation,
 * account, repository and values put in; checked against GitHub's webhook schema (@octokit/webhooks-schemas).
 */
export function hook(event: string, action: string | null, patch: (p: Json) => void): Json {
  const p = first(event, action);
  if (p.repository) p.repository = repository(p.repository as Json, REPOS.shop);
  if (event !== "installation" && event !== "installation_repositories") p.installation = installationLite();
  patch(p);
  const problems = checkWebhook(event, p);
  if (problems.length) throw new Error(`${event}.${action} fixture does not match GitHub's schema: ${problems.join("; ")}`);
  return p;
}

export const repoLite = (r: { id: number; name: string; full_name: string }) => ({ id: r.id, node_id: `R_${r.id}`, name: r.name, full_name: r.full_name, private: true });

export function installationCreated(repos: { id: number; name: string; full_name: string }[], selection: "selected" | "all" = "selected"): Json {
  return hook("installation", "created", (p) => {
    const i = p.installation as Json;
    p.installation = { ...i, id: INSTALLATION_ID, app_id: APP_ID, account: { ...(i.account as Json), login: ACCOUNT.login, id: ACCOUNT.id, type: ACCOUNT.type },
      repository_selection: selection, target_id: ACCOUNT.id, target_type: ACCOUNT.type,
      permissions: { checks: "write", pull_requests: "write", contents: "write", workflows: "write", actions: "read", metadata: "read" },
      events: ["push", "pull_request", "workflow_job"] };
    p.repositories = repos.map(repoLite);
  });
}

export function workflowJob(action: "queued" | "in_progress" | "completed", j: {
  id: number; runId: number; attempt?: number; sha: string; branch: string; runner?: string | null; conclusion?: string | null;
  labels?: string[]; repo?: { id: number; name: string; full_name: string }; startedAt?: string; completedAt?: string; name?: string;
}): Json {
  return hook("workflow_job", action, (p) => {
    if (j.repo) p.repository = repository(p.repository as Json, j.repo);
    const w = p.workflow_job as Json;
    const full = (j.repo ?? REPOS.shop).full_name;
    p.workflow_job = {
      ...w, id: j.id, run_id: j.runId, run_attempt: j.attempt ?? 1, head_sha: j.sha, head_branch: j.branch, name: j.name ?? "test", workflow_name: "CI",
      labels: j.labels ?? ["fenvix"], status: action,
      conclusion: action === "completed" ? (j.conclusion ?? "success") : null,
      runner_name: action === "queued" ? null : (j.runner ?? "fenvix-m1"), runner_id: action === "queued" ? null : 77, runner_group_id: action === "queued" ? null : 1, runner_group_name: action === "queued" ? null : "Default",
      started_at: j.startedAt ?? "2026-11-18T10:00:00Z", completed_at: action === "completed" ? (j.completedAt ?? "2026-11-18T10:03:00Z") : null,
      created_at: "2026-11-18T09:59:50Z",
      run_url: `https://api.github.com/repos/${full}/actions/runs/${j.runId}`, url: `https://api.github.com/repos/${full}/actions/jobs/${j.id}`,
      html_url: `https://github.com/${full}/actions/runs/${j.runId}/job/${j.id}`, check_run_url: `https://api.github.com/repos/${full}/check-runs/${j.id}`,
      steps: action === "queued" ? [] : w.steps,
    };
  });
}

export function pullRequest(action: "opened" | "closed" | "synchronize", pr: { number: number; headRef: string; headSha: string; merged?: boolean; mergeSha?: string; mergedAt?: string; repo?: { id: number; name: string; full_name: string } }): Json {
  return hook("pull_request", action, (p) => {
    const r = pr.repo ?? REPOS.shop;
    p.repository = repository(p.repository as Json, r);
    const x = p.pull_request as Json;
    const head = x.head as Json; const base = x.base as Json;
    p.number = pr.number;
    p.pull_request = {
      ...x, number: pr.number, state: action === "closed" ? "closed" : "open", merged: action === "closed" ? !!pr.merged : false,
      ...(pr.mergeSha !== undefined ? { merge_commit_sha: pr.mergeSha } : {}),
      ...(pr.mergedAt !== undefined ? { merged_at: pr.mergedAt } : {}),
      html_url: `https://github.com/${r.full_name}/pull/${pr.number}`,
      head: { ...head, ref: pr.headRef, sha: pr.headSha, repo: repository(head.repo as Json, r) },
      base: { ...base, ref: "main", repo: repository(base.repo as Json, r) },
    };
  });
}

export function push(sha: string, ref = "refs/heads/feature", pushedAt = 1795424000): Json {
  return hook("push", null, (p) => {
    p.after = sha;
    p.ref = ref;
    p.deleted = false;
    (p.repository as Json).pushed_at = pushedAt;
  });
}

// ---------------------------------------------------------------- the App, the fake GitHub, a Supabase signer

// ---------------------------------------------------------------- connecting GitHub (review R-016 F1, F2)

/** A GitHub user (OAuth code → token → GET /user) who sees the installations and administers `adminOf` (organization logins). */
export function githubUser(h: Harness, o: { code: string; token: string; login: string; id: number; installations: number[]; adminOf?: string[] }): void {
  h.gh.oauthCodes.set(o.code, o.token);
  h.gh.userInstallations.set(o.token, o.installations);
  h.gh.users.set(o.token, { login: o.login, id: o.id });
  for (const org of o.adminOf ?? []) h.gh.orgRoles.set(`${org.toLowerCase()}:${o.login.toLowerCase()}`, "admin");
}

/** GitHub's return to /github/setup; the redirect and, when the setup asks the dashboard to complete, the one-time code. */
export async function githubSetup(h: Harness, q: Record<string, string>): Promise<{ status: number; url: URL; completion: string | null }> {
  const r = await h.app.fastify.inject({ method: "GET", url: `/github/setup?${new URLSearchParams(q)}` });
  const url = new URL(String(r.headers.location));
  return { status: r.statusCode, url, completion: new URLSearchParams(url.hash.slice(1)).get("completion") };
}

/**
 * What the dashboard does with the code (POST /v1/github/installations/complete): the API's database function, as
 * fenvix_api for the signed-in person; then the worker's "installation_linked" work. Null when the database refused.
 */
export async function completeLink(h: Harness, completion: string, userId: string): Promise<{ workspace_id: string; installation_id: number; account: string } | null> {
  const u = new URL(ADMIN_URL); u.username = "fenvix_api"; u.password = "local-test-only";
  const api = new pg.Client({ connectionString: u.toString() });
  await api.connect();
  let row: { workspace_id: string; installation_id: string | number; account: string } | undefined;
  try {
    await api.query("begin");
    await api.query("select set_config('app.user_id', $1, true)", [userId]);
    row = (await api.query("select * from public.api_complete_github_link($1)", [createHash("sha256").update(completion).digest("hex")])).rows[0];
    await api.query("commit");
  } catch (e) {
    await api.query("rollback");
    throw e;
  } finally {
    await api.end();
  }
  if (!row) return null;
  await runWork(h.app.service, { kind: "installation_linked", installationId: Number(row.installation_id) });
  return { workspace_id: row.workspace_id, installation_id: Number(row.installation_id), account: row.account };
}

export class Harness {
  /** The newest push time (unix seconds) seen per repository, for the fake's default branch. */
  private readonly lastPush = new Map<string, number>();
  app!: App;
  gh!: FakeGitHub;
  cfg!: Config;
  private signKey!: CryptoKey;
  private n = 0;

  /** `queue`: where the app hands checked work (default: this process, as the node server does). */
  async start(env: Record<string, string> = {}, opts: { queue?: WorkQueue; launcher?: RunnerLauncher } = {}): Promise<void> {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.gh = new FakeGitHub(APP_ID, publicKey);
    await this.gh.start();
    const { privateKey: sk, publicKey: pk } = await generateKeyPair("ES256");
    this.signKey = sk;
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pk)), kid: "k1", alg: "ES256" }] });
    this.cfg = loadConfig({
      NODE_ENV: "test", GITHUB_APP_DATABASE_URL: appUrl(), GITHUB_APP_ID: String(APP_ID), GITHUB_APP_SLUG: "fenvix-test",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(), GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GITHUB_CLIENT_ID: "Iv1.testclient", GITHUB_CLIENT_SECRET: "client-secret-for-tests", GITHUB_API_URL: this.gh.url, GITHUB_OAUTH_URL: this.gh.url,
      DASHBOARD_URL: DASHBOARD, SUPABASE_URL: SUPABASE, STATE_SIGNING_KEY: "state-signing-key-for-tests-0123456789", RUNNER_TOKEN, SWEEP_SECONDS: "0",
      SUMMARY_WAIT_SECONDS: "600", LOG_LEVEL: "silent", ...env,
    });
    this.app = await buildApp({ cfg: this.cfg, sessions: new SessionVerifier(SUPABASE, "", jwks), logger: false, ...(opts.queue ? { queue: opts.queue } : {}), ...(opts.launcher ? { launcher: opts.launcher } : {}) });
  }

  async stop(): Promise<void> {
    await this.app.close();
    await this.gh.stop();
  }

  async token(userId: string): Promise<string> {
    return new SignJWT({ email: "x@gh.fenvix.invalid" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(`${SUPABASE}/auth/v1`)
      .setAudience("authenticated").setSubject(userId).setIssuedAt().setExpirationTime("1h").sign(this.signKey);
  }

  /** Delivers a webhook the way GitHub does (signed, JSON) and waits until the App has handled it. */
  async send(event: string, payload: Json, o: { delivery?: string; secret?: string } = {}) {
    // As on GitHub, a push to the default branch moves it (the files stay those of the branch): the App reads the
    // branch's head back (GET /git/ref/heads/<branch>) before a warm-up machine starts (review R-018 F1). A push
    // delivered late (older than the newest one seen) does not move it back.
    if (event === "push" && typeof payload.after === "string" && !payload.deleted) {
      const r = payload.repository as Json | undefined;
      const repo = this.gh?.repos.get(String(r?.full_name ?? ""));
      const br = repo && payload.ref === `refs/heads/${repo.defaultBranch}` ? repo.branches.get(repo.defaultBranch) : undefined;
      const at = typeof r?.pushed_at === "string" ? Date.parse(r.pushed_at) / 1000 : Number(r?.pushed_at ?? 0);
      if (repo && br && at >= (this.lastPush.get(repo.fullName) ?? 0)) {
        this.lastPush.set(repo.fullName, at);
        repo.branches.set(repo.defaultBranch, { sha: payload.after, files: br.files });
      }
    }
    const body = JSON.stringify(payload);
    const res = await this.app.fastify.inject({
      method: "POST", url: "/webhooks/github", payload: body,
      headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": o.delivery ?? randomUUID(), "x-hub-signature-256": sign(o.secret ?? WEBHOOK_SECRET, body), "user-agent": "GitHub-Hookshot/abc" },
    });
    await this.app.service.idle();
    return res;
  }

  /** What our runner sends when the test step ends, with its own credential (runner name and repository). */
  async summary(o: { repositoryId?: number; runId: number; attempt?: number; runner?: string; summary: Json; receiptsUrl?: string }) {
    const cred = runnerCredential(o.runner ?? "fenvix-m1", o.repositoryId ?? REPOS.shop.id);
    const res = await this.app.fastify.inject({
      method: "POST", url: "/v1/runner/summaries", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" },
      payload: { repositoryId: o.repositoryId ?? REPOS.shop.id, runId: o.runId, runAttempt: o.attempt ?? 1, runnerName: o.runner ?? "fenvix-m1", summary: o.summary, ...(o.receiptsUrl ? { receiptsUrl: o.receiptsUrl } : {}) },
    });
    await this.app.service.idle();
    return res;
  }

  nextSha(): string { this.n++; return this.n.toString(16).padStart(40, "a"); }
}

export const CI_YAML = `# CI for acme/shop
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ruff check .

  test:
    runs-on: ubuntu-latest  # GitHub-hosted, 2 cores
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.13"
      - run: pip install -e . pytest
      - run: python -m pytest -q
`;

export const WEB_YAML = `name: test
on: [push, pull_request]
jobs:
  unit:
    runs-on: [ubuntu-24.04]
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx vitest run
`;
