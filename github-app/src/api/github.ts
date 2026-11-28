/*
 * The organization's GitHub side: its installations of the fenvix GitHub App, their repositories with their
 * onboarding state, the link that installs the App for this organization, and asking for a setup pull request.
 */
import { createHash } from "node:crypto";
import { signState } from "../auth.ts";
import { type Handler, orgOf, Reply } from "./context.ts";
import { conflict, forbidden, githubNotConfigured, notFound, unavailable } from "./errors.ts";
import { mapGitHubRepository, mapInstallation } from "./shared.js";

/**
 * The latest warm-up of a repository `r` (supabase/migrations/0017_warm_cache.sql), the one in flight first: its
 * columns as mapWarmCache (src/data/ci-rows.ts) reads them. Row level security shows the organization's warm-ups only.
 */
export const LATEST_WARMUP = `left join lateral (select w.status as warmup_status, w.commit_sha as warmup_sha, w.detail as warmup_detail, w.updated_at as warmup_updated_at
    from public.gh_warmups w where w.repository_id = r.repository_id
    order by (w.status in ('pending', 'dispatched', 'running')) desc, w.id desc limit 1) wu on true`;
const REPOSITORIES = `select r.*, wu.* from public.gh_repositories r ${LATEST_WARMUP} where r.workspace_id = $1`;

export const getGitHubConnection: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const rows = await ctx.t.q(
    `select i.*, (select count(*)::int from public.gh_repositories r where r.installation_id = i.installation_id and r.removed_at is null) as repositories
       from public.gh_installations i where i.workspace_id = $1 order by i.linked_at nulls last, i.installation_id`, [ws]);
  const installations = rows.map(mapInstallation);
  return { account: installations.find((i) => i.status === "active")?.account ?? null, installations };
};

/** Where to send the browser to install the App for this organization (a signed state: organization, person, 1 hour). */
export const createInstallLink: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  if (!ctx.cfg.githubConfigured) throw githubNotConfigured();
  const state = signState(ctx.cfg.stateSigningKey, { workspaceId: ws, userId: ctx.userId });
  return { url: `${ctx.cfg.webUrl}/apps/${ctx.cfg.appSlug}/installations/new?state=${encodeURIComponent(state)}` };
};

/** Every refusal of a completion code itself: one answer, so a code cannot be probed. */
export const COMPLETION_NOT_FOUND = "This GitHub connection link is not valid for your account: it was started by another fenvix account, " +
  "has already been used, or has expired. Nothing was connected. Ask for a new link from the Connect page of your own organization.";

/**
 * The last step of connecting GitHub (review R-016 F2): /github/setup checked the GitHub side and stored a single-use
 * completion for the fenvix person its state names; the link is made here, for the signed-in person only
 * (api_complete_github_link checks it is theirs, unexpired and unused; gh_link_installation that they are an owner or
 * admin of the organization and that the installation is not another organization's).
 */
export const completeGitHubInstall: Handler = async (ctx) => {
  if (!ctx.cfg.githubConfigured) throw githubNotConfigured();
  const hash = createHash("sha256").update(String(ctx.body.completion)).digest("hex");
  let row: { workspace_id: string; installation_id: number; account: string } | undefined;
  try {
    row = await ctx.t.one("select * from public.api_complete_github_link($1)", [hash]);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "42501") throw forbidden("Only an owner or admin of the organization can connect a GitHub installation.");
    if (code === "23505") throw conflict("This GitHub installation is connected to another fenvix organization.");
    if (code === "55000") throw conflict("This GitHub installation was removed on GitHub. Install the App again.");
    if (code === "P0002") throw notFound(COMPLETION_NOT_FOUND);
    throw e;
  }
  if (!row) throw notFound(COMPLETION_NOT_FOUND);
  const installationId = Number(row.installation_id);
  // Its repositories get their projects (the App's worker); after the commit, so that the worker sees the link.
  ctx.afterCommit(() => ctx.queue.enqueue({ kind: "installation_linked", installationId }));
  return { organizationId: row.workspace_id, installationId, account: row.account };
};

export const listGitHubRepositories: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const rows = await ctx.t.q(`${REPOSITORIES} order by r.removed_at nulls first, lower(r.full_name), r.repository_id`, [ws]);
  return { items: rows.map(mapGitHubRepository) };
};

/**
 * Queues the setup pull request of one repository of this organization (the App's worker opens it, or finds the one
 * already open). 404 for a repository of another organization or unknown: the same answer, so ids cannot be probed.
 */
export const openSetupPullRequest: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const repositoryId = Number(ctx.params.repositoryId);
  if (!ctx.cfg.githubConfigured) throw githubNotConfigured();
  const row = await ctx.t.one(`${REPOSITORIES} and r.repository_id = $2`, [ws, repositoryId]);
  if (!row) throw notFound("That repository is not in this organization's GitHub installations.");
  if (row.excluded_at) throw conflict("This repository was removed from fenvix. Add it again first.");
  try {
    await ctx.queue.enqueue({ kind: "onboard", repositoryId });
  } catch {
    throw unavailable("The request could not be queued. Try again in a minute.");
  }
  return new Reply(202, mapGitHubRepository(row));
};

/**
 * Adds a repository its organization had removed from fenvix again (an owner or admin): api_restore_repository clears
 * excluded_at; after the commit the App's worker creates its project again ("sync_repository"). 404 for a repository of
 * another organization or unknown.
 */
export const restoreRepository: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const repositoryId = Number(ctx.params.repositoryId);
  const r = await ctx.t.one<{ restored: boolean }>("select public.api_restore_repository($1::bigint) as restored", [repositoryId]);
  if (!r?.restored) throw notFound("That repository is not in this organization's GitHub installations.");
  const row = await ctx.t.one(`${REPOSITORIES} and r.repository_id = $2`, [ws, repositoryId]);
  ctx.afterCommit(() => ctx.queue.enqueue({ kind: "sync_repository", repositoryId }));
  return new Reply(202, mapGitHubRepository(row!));
};
