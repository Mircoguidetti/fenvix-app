/*
 * The service back-end's operations (P-048): a defect's history, state, bundle and replays; replays of one test; stopping
 * a run; exploration settings and jobs; resuming skip with proof; API keys; deleting a project, the organization or
 * one's own account; unlinking a GitHub installation; the organization's export. Rows are read and written as
 * fenvix_api inside the request's transaction, so row level security (0019) checks the organization again.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type Ctx, type Handler, mayAdminister, orgOf, Reply } from "./context.ts";
import { defectById, project, projects, runRow } from "./data.ts";
import type { Tx } from "./db.ts";
import { ApiError, conflict, forbidden, notFound } from "./errors.ts";
import { mapDefect, mapExploration, mapProject, mapReplay, mapRun, mapTestResult, type Replay, replayCommand } from "./shared.js";

/** Replays one defect may get per day, from any source (src/tasks/tasks.ts). */
const REPLAYS_PER_DAY = 10;

/** The person behind the request, or a 403 when it came with an API key (keys never change state but replays). */
function person(ctx: Ctx, what: string): string {
  if (ctx.apiKey) throw forbidden(`An API key cannot ${what}; sign in to the dashboard.`);
  return ctx.userId;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

// ---------------------------------------------------------------- defects

export const listDefectOccurrences: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  await defectById(ctx.t, ws, ctx.params.defectId);
  const q = ctx.query as { limit?: number; offset?: number };
  const total = (await ctx.t.one<{ n: number }>("select count(*)::int as n from public.ci_defect_occurrences where workspace_id = $1 and defect_id = $2", [ws, ctx.params.defectId]))!.n;
  const rows = await ctx.t.q<Record<string, unknown>>(
    `select o.*, r.number as run_number from public.ci_defect_occurrences o left join public.ci_runs r on r.id = o.run_id
     where o.workspace_id = $1 and o.defect_id = $2 order by o.seen_at desc, o.id limit $3 offset $4`,
    [ws, ctx.params.defectId, q.limit ?? 1000, q.offset ?? 0]);
  return {
    total,
    items: rows.map((o) => ({
      id: String(o.id), source: o.source === "exploration" ? "exploration" : "run", runId: o.run_id ? String(o.run_id) : null,
      runNumber: o.run_number === null || o.run_number === undefined ? null : Number(o.run_number), explorationId: o.exploration_id ? String(o.exploration_id) : null,
      commitSha: (o.commit_sha as string | null) ?? null, branch: (o.branch as string | null) ?? null,
      pullRequest: o.pull_request === null || o.pull_request === undefined ? null : Number(o.pull_request),
      fingerprint: (o.fingerprint as string | null) ?? null, fingerprintChanged: o.fingerprint_changed === true,
      divergence: (o.divergence as { index: number; reason: string; description: string } | null) ?? null,
      seed: o.seed === null || o.seed === undefined ? null : Number(o.seed), engineVersion: String(o.engine_version ?? ""),
      status: String(o.status), at: iso(o.seen_at)!,
    })),
  };
};

export const setDefectState: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const userId = person(ctx, "change a defect");
  const b = ctx.body as { state: "open" | "fixed" | "muted"; reason?: string };
  const r = await ctx.t.q(
    `update public.ci_defects set state = $3, state_changed_at = now(), state_changed_by = $4, state_reason = nullif(btrim($5), '')
     where workspace_id = $1 and id = $2 returning id`, [ws, ctx.params.defectId, b.state, userId, b.reason ?? ""]);
  if (!r.length) throw notFound("That defect does not exist in this organization.");
  return defectById(ctx.t, ws, ctx.params.defectId);
};

/** How long the bundle's signed link lives. */
const BUNDLE_LINK_SECONDS = 300;

/** The signed link's token: organization, defect, bundle, expiry, HMAC with the API's state key. */
export function bundleToken(key: string, o: { ws: string; defect: string; bundle: string; exp: number }): string {
  const body = Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(`bundle.${body}`).digest("base64url")}`;
}
export function verifyBundleToken(key: string, token: string, now = Date.now()): { ws: string; defect: string; bundle: string; exp: number } | null {
  const [body, mac] = token.split(".");
  if (!body || !mac || token.length > 1000) return null;
  const want = createHmac("sha256", key).update(`bundle.${body}`).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const o = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { ws: string; defect: string; bundle: string; exp: number };
    return o.exp * 1000 > now ? o : null;
  } catch { return null; }
}

/** P-049's link: { url, expiresAt, sha256, bytes }; the url works without a header for BUNDLE_LINK_SECONDS. */
export const getDefectBundle: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const r = await ctx.t.one<{ found: boolean; id: string | null; sha256: string | null; size_bytes: number | null }>(
    `select true as found, b.id, b.sha256, b.size_bytes from public.ci_defects d left join public.ci_defect_bundles b on b.id = d.bundle_id
     where d.workspace_id = $1 and d.id = $2`, [ws, ctx.params.defectId]);
  if (!r?.found) throw notFound("That defect does not exist in this organization.");
  if (!r.id) throw notFound("This defect has no replay bundle yet: the runner uploads it with the run's results.");
  const exp = Math.floor(ctx.now.getTime() / 1000) + BUNDLE_LINK_SECONDS;
  const token = bundleToken(ctx.cfg.stateSigningKey, { ws, defect: String(ctx.params.defectId), bundle: r.id, exp });
  return { url: `${ctx.cfg.publicApiUrl}/v1/bundles?token=${token}`, expiresAt: new Date(exp * 1000).toISOString(), sha256: r.sha256!, bytes: Number(r.size_bytes) };
};

/** The bundle's bytes (a .tar.gz), for a member or an API key: the pull command and the MCP's pull_bundle. */
export const downloadDefectBundle: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const r = await ctx.t.one<{ content: Buffer | null; sha256: string | null; found: boolean }>(
    `select true as found, b.content, b.sha256 from public.ci_defects d left join public.ci_defect_bundles b on b.id = d.bundle_id
     where d.workspace_id = $1 and d.id = $2`, [ws, ctx.params.defectId]);
  if (!r?.found) throw notFound("That defect does not exist in this organization.");
  if (!r.content) throw notFound("This defect has no replay bundle yet: the runner uploads it with the run's results.");
  return new Reply(200, r.content, {
    "content-type": "application/gzip", "content-disposition": `attachment; filename="fenvix-defect-${ctx.params.defectId}.tar.gz"`,
    "x-fenvix-bundle-sha256": r.sha256!, "cache-control": "private, no-store",
  });
};

export const listDefectReplays: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  await defectById(ctx.t, ws, ctx.params.defectId);
  const rows = await ctx.t.q("select * from public.ci_replays where workspace_id = $1 and defect_id = $2 order by created_at desc limit 50", [ws, ctx.params.defectId]);
  return { items: rows.map(mapReplay) };
};

/** Who asked, as ci_replays.requested_via says it. */
const via = (ctx: Ctx): "dashboard" | "api_key" | "mcp" => (ctx.apiKey ? (ctx.viaMcp ? "mcp" : "api_key") : "dashboard");

/** A replay request, refused past the day's limit or while one is in flight. */
export async function requestReplay(t: Tx, ctx: Ctx, o: { projectId: string; defectId: string | null; runId: string | null; testId: string; commitSha: string; command: string | null }): Promise<Replay> {
  if (o.defectId) {
    const today = (await t.one<{ n: number }>(
      "select count(*)::int as n from public.ci_replays where workspace_id = $1 and defect_id = $2 and created_at > now() - interval '1 day'",
      [orgOf(ctx).id, o.defectId]))!.n;
    if (today >= REPLAYS_PER_DAY) throw new ApiError(429, "rate_limited", `This defect was replayed ${REPLAYS_PER_DAY} times in the last 24 hours. Try again later.`, undefined, { "retry-after": "3600" });
  }
  try {
    const r = await t.one(
      `insert into public.ci_replays (workspace_id, project_id, defect_id, run_id, test_id, commit_sha, requested_via, requested_by, api_key_id, command, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'waiting for a fenvix machine') returning *`,
      [orgOf(ctx).id, o.projectId, o.defectId, o.runId, o.testId, o.commitSha, via(ctx), ctx.apiKey ? null : ctx.userId, ctx.apiKey?.id ?? null, o.command]);
    return mapReplay(r!);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw conflict("A replay of this is already in flight.");
    throw e;
  }
}

export const requestDefectReplay: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const d = await ctx.t.one<{ id: string; project_id: string; test_id: string; replay_command: string | null; commit_sha: string | null }>(
    `select d.id, d.project_id, d.test_id, d.replay_command,
       (select o.commit_sha from public.ci_defect_occurrences o where o.defect_id = d.id and o.commit_sha is not null order by o.seen_at desc limit 1) as commit_sha
     from public.ci_defects d where d.workspace_id = $1 and d.id = $2`, [ws, ctx.params.defectId]);
  if (!d) throw notFound("That defect does not exist in this organization.");
  const commit = (ctx.body as { commitSha?: string } | undefined)?.commitSha ?? d.commit_sha;
  if (!commit) throw conflict("No commit is known for this defect yet; name one (commitSha).", "commitSha");
  const last = await ctx.t.one<{ last_run_id: string | null }>("select last_run_id from public.ci_defects where id = $1", [d.id]);
  return new Reply(202, await requestReplay(ctx.t, ctx, { projectId: d.project_id, defectId: d.id, runId: last?.last_run_id ?? null, testId: d.test_id, commitSha: commit, command: d.replay_command }));
};

export const getReplay: Handler = async (ctx) => {
  const r = await ctx.t.one("select * from public.ci_replays where workspace_id = $1 and id = $2", [orgOf(ctx).id, ctx.params.replayId]);
  if (!r) throw notFound("That replay does not exist in this organization.");
  return mapReplay(r);
};

// ---------------------------------------------------------------- the live view: stop a run, replay one test

/**
 * P-049's stop: now, or armed until the first failed test; off disarms. Owners and admins. The sweep sends a requested
 * stop to the machines (cancel the GitHub job, end the machine); done once GitHub reports the job over.
 */
export const stopRun: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const userId = person(ctx, "stop a run");
  const when = (ctx.body as { when: "now" | "first_failure" | "off" }).when;
  const r = await runRow(ctx.t, ws, ctx.params.runId);
  if (r.status !== "running") throw conflict("This run is not running.");
  if (when === "off") {
    await ctx.t.q("update public.ci_runs set stop_when = null, stop_state = null, stop_detail = '' where workspace_id = $1 and id = $2 and stop_state = 'armed'", [ws, r.id]);
  } else {
    const fire = when === "now" || Number(r.tests_failed) > 0 || Number((r.progress as { failed?: number } | null)?.failed ?? 0) > 0
      || !!(await ctx.t.one("select 1 from public.ci_test_results where run_id = $1 and outcome = 'failed' limit 1", [r.id]));
    await ctx.t.q(
      `update public.ci_runs set stop_when = $3, stop_state = $4, stop_requested_at = now(), stop_requested_by = $5, stop_detail = $6
       where workspace_id = $1 and id = $2 and coalesce(stop_state, '') <> 'requested'`,
      [ws, r.id, when, fire ? "requested" : "armed", userId, fire ? (when === "now" ? "stopping the job on its fenvix machine" : "a test has failed: stopping the job") : "waiting for the first failed test"]);
  }
  return new Reply(202, await runDetail(ctx, ws, String(r.id)));
};

async function runDetail(ctx: Ctx, ws: string, runId: string) {
  const r = await runRow(ctx.t, ws, runId);
  return { run: mapRun(r), project: await project(ctx.t, ws, String(r.project_id)) };
}

export const replayTest: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const testId = (ctx.body as { testId: string }).testId;
  const r = await ctx.t.one<{ id: string; project_id: string; commit_sha: string }>("select id, project_id, commit_sha from public.ci_runs where workspace_id = $1 and id = $2", [ws, ctx.params.runId]);
  if (!r) throw notFound("That run does not exist in this organization.");
  // A replay of this test of this run already queued or running is the answer.
  const live = await ctx.t.one("select * from public.ci_replays where workspace_id = $1 and run_id = $2 and test_id = $3 and status in ('requested', 'dispatched', 'running') order by created_at desc limit 1", [ws, r.id, testId]);
  if (live) return new Reply(202, mapReplay(live));
  const d = await ctx.t.one<{ id: string; replay_command: string | null }>("select id, replay_command from public.ci_defects where project_id = $1 and test_id = $2", [r.project_id, testId]);
  return new Reply(202, await requestReplay(ctx.t, ctx, { projectId: r.project_id, defectId: d?.id ?? null, runId: r.id, testId, commitSha: r.commit_sha, command: d?.replay_command ?? null }));
};

export const listReplays: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const r = await runRow(ctx.t, ws, ctx.params.runId);
  const rows = await ctx.t.q("select * from public.ci_replays where workspace_id = $1 and run_id = $2 order by created_at desc limit 100", [ws, r.id]);
  return { items: rows.map(mapReplay) };
};

/** P-049's live test view: the tests finished after `afterSeq`, in the order they finished, at most 2,000. */
export const listLiveTests: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const r = await runRow(ctx.t, ws, ctx.params.runId);
  const after = Number(ctx.query.afterSeq ?? 0);
  const rows = await ctx.t.q("select * from public.ci_test_results where workspace_id = $1 and run_id = $2 and seq > $3 order by seq limit 2000", [ws, r.id, after]);
  const last = rows.length ? Number(rows[rows.length - 1]!.seq) : after;
  return { items: rows.map(mapTestResult), lastSeq: last, status: String(r.status) };
};

// ---------------------------------------------------------------- explorations, skip with proof

export const saveExplorationSettings: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const b = ctx.body as { hourUtc: number; budgetSeconds: number; seeds: number; target: "all" | "unstable" };
  const r = await ctx.t.q(
    `update public.ci_projects set exploration_hour_utc = $3, exploration_budget_seconds = $4, exploration_seeds = $5, exploration_target = $6
     where workspace_id = $1 and id = $2 returning id`, [ws, ctx.params.projectId, b.hourUtc, b.budgetSeconds, b.seeds, b.target]);
  if (!r.length) throw notFound("That project does not exist in this organization.");
  return b;
};

const mapJob = (j: Record<string, unknown>) => ({
  id: String(j.id), projectId: String(j.project_id), reason: String(j.reason), status: String(j.status), detail: String(j.detail ?? ""),
  commitSha: (j.commit_sha as string | null) ?? null, budgetSeconds: Number(j.budget_seconds), seeds: Number(j.seeds), targets: (j.targets as string[]) ?? [],
  explorationId: j.exploration_id ? String(j.exploration_id) : null, createdAt: iso(j.created_at)!, finishedAt: iso(j.finished_at),
});

export const listExplorationJobs: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  await project(ctx.t, ws, ctx.params.projectId);
  const rows = await ctx.t.q<Record<string, unknown>>("select * from public.ci_exploration_jobs where workspace_id = $1 and project_id = $2 order by created_at desc limit 50", [ws, ctx.params.projectId]);
  return { items: rows.map(mapJob) };
};

export const requestExploration: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const p = await ctx.t.one<{ exploration_budget_seconds: number; exploration_seeds: number; default_branch: string }>(
    "select exploration_budget_seconds, exploration_seeds, default_branch from public.ci_projects where workspace_id = $1 and id = $2", [ws, ctx.params.projectId]);
  if (!p) throw notFound("That project does not exist in this organization.");
  const b = (ctx.body ?? {}) as { commitSha?: string; testIds?: string[] };
  try {
    const j = await ctx.t.one<Record<string, unknown>>(
      `insert into public.ci_exploration_jobs (workspace_id, project_id, reason, commit_sha, branch, budget_seconds, seeds, targets)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [ws, ctx.params.projectId, b.commitSha ? "pull_request" : "manual", b.commitSha ?? null, p.default_branch, p.exploration_budget_seconds, p.exploration_seeds, JSON.stringify(b.testIds ?? [])]);
    return new Reply(202, mapJob(j!));
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw conflict("An exploration of this project is already in flight.");
    throw e;
  }
};

export const resumeSkip: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const r = await ctx.t.q("update public.ci_projects set skip_paused_at = null, skip_paused_reason = null where workspace_id = $1 and id = $2 returning id", [ws, ctx.params.projectId]);
  if (!r.length) throw notFound("That project does not exist in this organization.");
  const row = await ctx.t.one("select * from public.ci_projects where id = $1", [ctx.params.projectId]);
  return mapProject(row!);
};

// ---------------------------------------------------------------- API keys

const mapKey = (k: Record<string, unknown>) => ({
  id: String(k.id), name: String(k.name), prefix: String(k.prefix), scopes: (k.scopes as ("read" | "replay")[]) ?? ["read"],
  createdAt: iso(k.created_at)!, expiresAt: iso(k.expires_at), lastUsedAt: iso(k.last_used_at), revokedAt: iso(k.revoked_at),
});

/** An API key's text: fxk_ and 40 characters from 30 random bytes (base62-ish via base64url without - and _). */
export function newApiKey(): { key: string; prefix: string; hash: string } {
  let body = "";
  while (body.length < 40) body += randomBytes(48).toString("base64").replace(/[^A-Za-z0-9]/g, "");
  const key = `fxk_${body.slice(0, 40)}`;
  return { key, prefix: key.slice(0, 10), hash: createHash("sha256").update(key).digest("hex") };
}

export const listApiKeys: Handler = async (ctx) => {
  person(ctx, "manage API keys");
  const rows = await ctx.t.q<Record<string, unknown>>("select * from public.ci_api_keys where workspace_id = $1 order by created_at desc", [orgOf(ctx).id]);
  return { items: rows.map(mapKey) };
};

export const createApiKey: Handler = async (ctx) => {
  const userId = person(ctx, "manage API keys");
  const b = ctx.body as { name: string; scopes?: ("read" | "replay")[]; expiresInDays?: number };
  const n = (await ctx.t.one<{ n: number }>("select count(*)::int as n from public.ci_api_keys where workspace_id = $1 and revoked_at is null", [orgOf(ctx).id]))!.n;
  if (n >= 50) throw conflict("This organization has 50 API keys. Revoke one first.");
  const k = newApiKey();
  const row = await ctx.t.one<Record<string, unknown>>(
    `insert into public.ci_api_keys (workspace_id, name, prefix, key_hash, scopes, created_by, expires_at)
     values ($1, $2, $3, $4, $5, $6, case when $7::int is null then null else now() + make_interval(days => $7::int) end) returning *`,
    [orgOf(ctx).id, b.name.trim(), k.prefix, k.hash, b.scopes ?? ["read"], userId, b.expiresInDays ?? null]);
  return new Reply(201, { ...mapKey(row!), key: k.key });
};

export const revokeApiKey: Handler = async (ctx) => {
  const userId = person(ctx, "manage API keys");
  const row = await ctx.t.one<Record<string, unknown>>(
    "update public.ci_api_keys set revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, $3) where workspace_id = $1 and id = $2 returning *",
    [orgOf(ctx).id, ctx.params.keyId, userId]);
  if (!row) throw notFound("That API key does not exist in this organization.");
  return mapKey(row);
};

// ---------------------------------------------------------------- deleting, unlinking, exporting

export const deleteProject: Handler = async (ctx) => {
  person(ctx, "disconnect a project");
  const r = await ctx.t.one<{ ok: boolean }>("select public.api_delete_project($1) as ok", [ctx.params.projectId]);
  if (!r?.ok) throw notFound("That project does not exist in this organization.");
  return new Reply(204, null);
};

export const deleteOrganization: Handler = async (ctx) => {
  person(ctx, "delete the organization");
  if (ctx.role !== "owner") throw forbidden("Only an owner can delete the organization.");
  await ctx.t.q("select public.api_delete_organization($1)", [(ctx.body as { confirmName: string }).confirmName]);
  return new Reply(204, null);
};

export const deleteMe: Handler = async (ctx) => {
  person(ctx, "delete an account");
  await ctx.t.q("select public.api_delete_me()");
  return new Reply(204, null);
};

export const unlinkInstallation: Handler = async (ctx) => {
  person(ctx, "disconnect a GitHub account");
  const r = await ctx.t.one<{ ok: boolean }>("select public.api_unlink_installation($1) as ok", [ctx.params.installationId]);
  if (!r?.ok) throw notFound("That GitHub installation is not connected to this organization.");
  return new Reply(204, null);
};

export const exportOrganization: Handler = async (ctx) => {
  const o = orgOf(ctx);
  if (!mayAdminister(o.role)) throw forbidden("Only an owner or admin can export the organization.");
  const all = await projects(ctx.t, o.id);
  const byId = new Map(all.map((p) => [p.id, p]));
  const runs = (await ctx.t.q("select * from public.ci_runs where workspace_id = $1 order by started_at desc limit 5000", [o.id])).map(mapRun);
  const defects = (await ctx.t.q("select * from public.ci_defects where workspace_id = $1 order by last_seen_at desc", [o.id])).map((r) => mapDefect(r, byId.get(String(r.project_id))));
  const occurrences = await ctx.t.q("select id, defect_id, run_id, exploration_id, source, commit_sha, branch, pull_request, fingerprint, fingerprint_changed, divergence, seed, engine_version, status, seen_at from public.ci_defect_occurrences where workspace_id = $1 order by seen_at desc limit 50000", [o.id]);
  const explorations = (await ctx.t.q("select * from public.ci_explorations where workspace_id = $1 order by started_at desc", [o.id])).map(mapExploration);
  return {
    exportedAt: ctx.now.toISOString(), organization: { id: o.id, name: o.name, region: o.region }, projects: all, runs, defects,
    occurrences: occurrences.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]))), explorations,
  };
};

// ---------------------------------------------------------------- the audit log

export const listAuditEvents: Handler = async (ctx) => {
  person(ctx, "read the audit log");
  const q = ctx.query as { limit?: number; offset?: number };
  // Emails of current members only (api_members(): the organization of the request); a former member shows their id.
  const rows = await ctx.t.q<Record<string, unknown>>(
    `select e.*, m.email from public.audit_events e left join public.api_members() m on m.user_id = e.actor_user
     where e.workspace_id = $1 order by e.at desc, e.id desc limit $2 offset $3`, [orgOf(ctx).id, q.limit ?? 200, q.offset ?? 0]);
  return {
    items: rows.map((e) => ({
      id: Number(e.id), at: iso(e.at)!, action: String(e.action), target: String(e.target ?? ""), detail: (e.detail as Record<string, unknown>) ?? {},
      actor: e.actor_user ? { kind: "person", id: String(e.actor_user), email: (e.email as string | null) ?? null }
        : e.actor_key ? { kind: "api_key", id: String(e.actor_key), email: null } : { kind: "fenvix", id: null, email: null },
    })),
  };
};

// ---------------------------------------------------------------- the coding agent's loop (F-14)

const EXCERPT = 2000;

/**
 * The failing and flaky tests of a pull request (its newest commit), a commit or a run: per test the error, a log
 * excerpt, the defect, the first divergent event (flaky tests), the replay command, and whether it is new or known.
 * `status`: running while any of those runs runs; none when no run was found.
 */
export const listFailures: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const q = ctx.query as { projectId?: string; pullRequest?: number; commitSha?: string; runId?: string };
  if (!q.runId && !q.commitSha && !q.pullRequest) throw new ApiError(400, "validation_failed", "Name a pullRequest (with projectId), a commitSha or a runId.");
  if (q.pullRequest && !q.projectId) throw new ApiError(400, "validation_failed", "A pull request is named with its projectId.", "projectId");
  const where = ["r.workspace_id = $1"];
  const params: unknown[] = [ws];
  if (q.projectId) { params.push(q.projectId); where.push(`r.project_id = $${params.length}`); }
  if (q.runId) { params.push(q.runId); where.push(`r.id = $${params.length}`); }
  if (q.commitSha) { params.push(q.commitSha); where.push(`r.commit_sha = $${params.length}`); }
  if (q.pullRequest) {
    params.push(q.pullRequest);
    where.push(`r.pull_request = $${params.length} and r.commit_sha = (select r2.commit_sha from public.ci_runs r2 where r2.workspace_id = $1 and r2.project_id = r.project_id
      and r2.pull_request = $${params.length} order by r2.pushed_at desc, r2.started_at desc limit 1)`);
  }
  const runs = await ctx.t.q<Record<string, unknown>>(
    `select distinct on (coalesce(r.job_workflow, ''), coalesce(r.job_name, ''), r.project_id) r.* from public.ci_runs r where ${where.join(" and ")}
     order by coalesce(r.job_workflow, ''), coalesce(r.job_name, ''), r.project_id, r.started_at desc limit 50`, params);
  const ids = runs.map((r) => String(r.id));
  const rows = ids.length ? await ctx.t.q<Record<string, unknown>>(
    `select t.*, r.number as run_number, r.job_workflow, r.job_name, r.project_id, r.started_at as run_started,
       d.id as d_id, d.divergence, d.replay_command, d.seed, d.language, d.first_run_id, d.cause, d.cause_tests, d.state as d_state,
       exists (select 1 from public.ci_test_results t2 join public.ci_runs r2 on r2.id = t2.run_id
                where r2.project_id = r.project_id and t2.test_id = t.test_id and t2.outcome = 'failed' and r2.started_at < r.started_at) as failed_before
     from public.ci_test_results t join public.ci_runs r on r.id = t.run_id left join public.ci_defects d on d.id = t.defect_id
     where t.workspace_id = $1 and t.run_id = any($2::uuid[]) and t.outcome = 'failed' order by r.started_at, t.seq nulls last, t.test_id limit 500`, [ws, ids]) : [];
  const items = rows.map((t) => {
    const flaky = t.failure_kind === "flaky_defect";
    const out = typeof t.output === "string" ? t.output : null;
    const isNew = flaky ? String(t.first_run_id ?? "") === String(t.run_id) : t.failed_before !== true;
    return {
      runId: String(t.run_id), runNumber: Number(t.run_number), job: t.job_name ? `${t.job_workflow ?? "workflow"} / ${t.job_name}` : null,
      testId: String(t.test_id), kind: flaky ? "flaky_defect" : "real",
      error: { type: String(t.exception_type ?? ""), message: String(t.failure_message ?? ""), location: String(t.failure_location ?? "") },
      logExcerpt: out ? (out.length > EXCERPT ? `...${out.slice(-EXCERPT)}` : out) : (t.failure_message ? String(t.failure_message) : null),
      defectId: t.d_id ? String(t.d_id) : null,
      divergence: (t.divergence as Record<string, unknown> | null) ?? null,
      replayCommand: t.d_id ? replayCommandOf(t) : null,
      new: isNew, known: !isNew,
    };
  });
  const status = !runs.length ? "none" : runs.some((r) => r.status === "running") ? "running" : runs.some((r) => r.status === "failed") ? "failed" : "passed";
  return { status, runs: runs.map((r) => ({ id: String(r.id), number: Number(r.number), status: String(r.status), commitSha: String(r.commit_sha), job: r.job_name ? String(r.job_name) : null })), items };
};

function replayCommandOf(t: Record<string, unknown>): string {
  return replayCommand({ id: String(t.d_id), seed: t.seed === null || t.seed === undefined ? null : Number(t.seed), language: t.language === "node" ? "node" : "python",
    testRunner: "pytest", replayCommand: (t.replay_command as string | null) ?? null });
}

/** The full captured output of one test of a run (the runner's, at most 64 KB), with its failure. */
export const getTestLog: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const r = await runRow(ctx.t, ws, ctx.params.runId);
  const t = await ctx.t.one<Record<string, unknown>>("select * from public.ci_test_results where workspace_id = $1 and run_id = $2 and test_id = $3", [ws, r.id, String(ctx.query.testId)]);
  if (!t) throw notFound("That test is not in this run.");
  return { runId: r.id, testId: String(t.test_id), outcome: String(t.outcome), output: (t.output as string | null) ?? null, failure: mapTestResult(t).failure };
};
