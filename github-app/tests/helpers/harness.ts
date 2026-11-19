import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import pg from "pg";
import { buildApp, type App } from "../../src/app.ts";
import { SessionVerifier } from "../../src/auth.ts";
import { type Config, loadConfig } from "../../src/config.ts";
import { sign } from "../../src/github/signature.ts";
import { signSummaryCredential } from "../../src/runners/credentials.ts";
import type { RunnerLauncher } from "../../src/runners/launcher.ts";
import type { WorkQueue } from "../../src/work.ts";
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
  await admin.query(`truncate gh_webhook_deliveries, gh_run_summaries, gh_run_results, gh_jobs, gh_pushes, gh_pull_requests, ci_usage_events, gh_warmups, gh_repositories,
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

export class Harness {
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
