/*
 * The organization's GitHub side: its installations of the fenvix GitHub App, their repositories with their
 * onboarding state, the link that installs the App for this organization, and asking for a setup pull request.
 */
import { signState } from "../auth.ts";
import { type Handler, orgOf, Reply } from "./context.ts";
import { notFound, unavailable } from "./errors.ts";
import { mapGitHubRepository, mapInstallation } from "./shared.js";

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
  const state = signState(ctx.cfg.stateSigningKey, { workspaceId: ws, userId: ctx.userId });
  return { url: `${ctx.cfg.webUrl}/apps/${ctx.cfg.appSlug}/installations/new?state=${encodeURIComponent(state)}` };
};

export const listGitHubRepositories: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const rows = await ctx.t.q("select * from public.gh_repositories where workspace_id = $1 order by removed_at nulls first, lower(full_name), repository_id", [ws]);
  return { items: rows.map(mapGitHubRepository) };
};

/**
 * Queues the setup pull request of one repository of this organization (the App's worker opens it, or finds the one
 * already open). 404 for a repository of another organization or unknown: the same answer, so ids cannot be probed.
 */
export const openSetupPullRequest: Handler = async (ctx) => {
  const { id: ws } = orgOf(ctx);
  const repositoryId = Number(ctx.params.repositoryId);
  const row = await ctx.t.one("select * from public.gh_repositories where workspace_id = $1 and repository_id = $2", [ws, repositoryId]);
  if (!row) throw notFound("That repository is not in this organization's GitHub installations.");
  try {
    await ctx.queue.enqueue({ kind: "onboard", repositoryId });
  } catch {
    throw unavailable("The request could not be queued. Try again in a minute.");
  }
  return new Reply(202, mapGitHubRepository(row));
};
