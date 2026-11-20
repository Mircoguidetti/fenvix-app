/*
 * The service back-end's operations (P-048): a defect's history, state, bundle and replays; replays of one test; stopping
 * a run; exploration settings and jobs; resuming skip with proof; API keys; deleting a project, the organization or
 * one's own account; unlinking a GitHub installation; the organization's export. Rows are read and written as
 * fenvix_api inside the request's transaction, so row level security (0018) checks the organization again.
 */
import { createHash, randomBytes } from "node:crypto";
import { type Ctx, type Handler, mayAdminister, orgOf, Reply } from "./context.ts";
import { defectById, project, projects } from "./data.ts";
import type { Tx } from "./db.ts";
import { ApiError, conflict, forbidden, notFound } from "./errors.ts";
import { mapDefect, mapExploration, mapProject, mapReplay, mapRun, type Replay } from "./shared.js";

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
      status: String(o.status), seenAt: iso(o.seen_at)!,
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

export const getDefectBundle: Handler = async (ctx) => {
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
  return new Reply(202, await requestReplay(ctx.t, ctx, { projectId: d.project_id, defectId: d.id, runId: null, testId: d.test_id, commitSha: commit, command: d.replay_command }));
};

export const getReplay: Handler = async (ctx) => {
  const r = await ctx.t.one("select * from public.ci_replays where workspace_id = $1 and id = $2", [orgOf(ctx).id, ctx.params.replayId]);
  if (!r) throw notFound("That replay does not exist in this organization.");
  return mapReplay(r);
};

// ---------------------------------------------------------------- the live view: stop a run, replay one test

export const cancelRun: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const userId = person(ctx, "stop a run");
  const r = await ctx.t.one("select * from public.ci_runs where workspace_id = $1 and id = $2", [ws, ctx.params.runId]);
  if (!r) throw notFound("That run does not exist in this organization.");
  if (r.status !== "running") throw conflict("This run has already finished.");
  const u = await ctx.t.one("update public.ci_runs set cancel_requested_at = coalesce(cancel_requested_at, now()), cancel_requested_by = coalesce(cancel_requested_by, $3) where workspace_id = $1 and id = $2 returning *", [ws, ctx.params.runId, userId]);
  return new Reply(202, mapRun(u!));
};

export const requestTestReplay: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const testId = (ctx.body as { testId: string }).testId;
  const r = await ctx.t.one<{ id: string; project_id: string; commit_sha: string }>("select id, project_id, commit_sha from public.ci_runs where workspace_id = $1 and id = $2", [ws, ctx.params.runId]);
  if (!r) throw notFound("That run does not exist in this organization.");
  const d = await ctx.t.one<{ id: string; replay_command: string | null }>("select id, replay_command from public.ci_defects where project_id = $1 and test_id = $2", [r.project_id, testId]);
  return new Reply(202, await requestReplay(ctx.t, ctx, { projectId: r.project_id, defectId: d?.id ?? null, runId: r.id, testId, commitSha: r.commit_sha, command: d?.replay_command ?? null }));
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
