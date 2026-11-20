import type { Db } from "../db.ts";
import { GitHubError, type GitHubApp, repoPath } from "../github/client.ts";

/**
 * G-1631: a member sees a project only while GitHub says their GitHub identity can see its repository. The API's row
 * security (migration 0019, section 13) reads the answers kept in gh_repo_access, for 10 minutes at most; this asks
 * GitHub again after 4 (each sweep, the oldest first, at most `batch` answers), with the installation's token:
 * GET /repos/{owner}/{repo}/collaborators/{login}/permission (Metadata: read, which every App has). An error from
 * GitHub writes nothing: the old answer ages out and the project is hidden (deny when unknown).
 */

interface Due { user_id: string; project_id: string; installation_id: string; full_name: string; github_user_id: string | null; github_login: string | null }
type Logger = { warn: (o: object, m: string) => void };

/** Read access or more. `permission` maps maintain to write and triage to read; `none` is no access. */
const SEES = new Set(["admin", "maintain", "write", "triage", "read"]);

export async function refreshRepoAccess(db: Db, gh: GitHubApp, log: Logger, batch = 200): Promise<{ checked: number; denied: number; failed: number }> {
  const due = await db.q<Due>("select * from public.gh_repo_access_due($1)", [batch]);
  let checked = 0, denied = 0, failed = 0;
  const logins = new Map<string, string | null>(); // GitHub user id → current login, once per sweep
  for (const d of due) {
    let canSee = false;
    let basis: string;
    try {
      if (!d.github_user_id || !d.github_login) {
        basis = "no_github_identity";
      } else {
        const http = gh.installation(Number(d.installation_id));
        const ask = (login: string) => http.request<{ permission?: string }>("GET",
          `${repoPath(d.full_name)}/collaborators/${encodeURIComponent(login)}/permission`, { allow: [404] });
        let r = await ask(d.github_login);
        if (r.status === 404) {
          // The login may have changed since the sign-in: the id is what GitHub vouched for.
          if (!logins.has(d.github_user_id)) {
            const u = await http.request<{ login?: string }>("GET", `/user/${encodeURIComponent(d.github_user_id)}`, { allow: [404] });
            logins.set(d.github_user_id, u.status === 200 && u.data.login ? u.data.login : null);
          }
          const now = logins.get(d.github_user_id);
          if (now && now.toLowerCase() !== d.github_login.toLowerCase()) r = await ask(now);
        }
        if (r.status === 404) basis = "not_found";
        else {
          const p = String(r.data.permission ?? "none").toLowerCase();
          canSee = SEES.has(p);
          basis = /^[a-z_]{1,40}$/.test(p) ? p : "none";
        }
      }
    } catch (e) {
      failed++;
      log.warn({ project: d.project_id, err: e instanceof GitHubError ? `${e.status}` : e instanceof Error ? e.message : String(e) }, "repository access: GitHub did not answer (the old answer ages out)");
      continue;
    }
    await db.q(
      `insert into gh_repo_access (user_id, project_id, can_see, basis, github_user_id, checked_at) values ($1, $2, $3, $4, $5, now())
       on conflict (user_id, project_id) do update set can_see = excluded.can_see, basis = excluded.basis,
         github_user_id = excluded.github_user_id, checked_at = now()`,
      [d.user_id, d.project_id, canSee, basis, d.github_user_id]);
    checked++;
    if (!canSee) denied++;
  }
  return { checked, denied, failed };
}

/**
 * A change GitHub tells us about takes the old answers away at once (the next sweep asks again): a collaborator removed
 * from a repository (`member`), a person removed from the organization (`organization`), a team change
 * (`membership`, `team`), a repository made private (`repository.privatized`). Those events reach the App only when
 * they are ticked in its settings (docs/GITHUB-APP.md); without them an answer lives 10 minutes at most.
 */
export async function forgetRepoAccess(db: Db, o: { installationId?: number; repositoryId?: number; githubUserId?: number }): Promise<number> {
  const [r] = await db.q<{ n: number }>("select public.gh_repo_access_forget($1, $2, $3) as n",
    [o.installationId ?? null, o.repositoryId ?? null, o.githubUserId ?? null]);
  return Number(r?.n ?? 0);
}
