// The GitHub environment "production" must only be usable from main: its deployment branch rule is the one thing that
// keeps an edited workflow on another branch from reaching its secrets (the database admin's connection string) and
// the AWS deploy role (which trusts the environment). It is a click in GitHub (docs/DEPLOY-AWS.md, step 1); this check
// reads it back through GitHub's API with the job's own token (permission "actions: read") and stops the deploy when the
// rule is missing or allows more than main.
//
// It cannot stop a workflow edited on another branch (that workflow would not run this check): it catches the
// misconfiguration on the first deploy from main, before anything is changed.
import { info, Stop, warning } from "./log.mjs";

const API = "https://api.github.com";

/**
 * Returns "main only" when the rule is exactly the branch main; throws Stop when it is missing or wider; returns
 * "unverified" (with a warning) when the token may not read it (403), so a permission GitHub changes does not block
 * every deploy; the run's summary then says the rule was not checked.
 */
export async function checkBranchRule({ repository, environment = "production", token, fetchImpl = fetch }) {
  const get = async (path) => {
    const r = await fetchImpl(`${API}/repos/${repository}/environments/${encodeURIComponent(environment)}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "fenvix-deploy" },
    });
    return { status: r.status, body: r.status === 200 ? await r.json() : null };
  };
  const env = await get("");
  if (env.status === 403 || env.status === 401) {
    warning(`Could not read the deployment branch rule of the environment ${environment} (HTTP ${env.status}): it was not checked. It must allow the branch main only (docs/DEPLOY-AWS.md, step 1).`);
    return "unverified";
  }
  if (env.status !== 200) throw new Stop(`Could not read the environment ${environment} (HTTP ${env.status}). Nothing was deployed.`);
  const fix = `Set it: GitHub → Settings → Environments → ${environment} → Deployment branches and tags → "Selected branches and tags" → Add deployment branch or tag rule → main (docs/DEPLOY-AWS.md, step 1). Nothing was deployed.`;
  const p = env.body.deployment_branch_policy;
  if (!p) throw new Stop(`The environment ${environment} has no deployment branch rule: any branch's workflow could use its secrets and the AWS deploy role. ${fix}`);
  if (p.protected_branches || !p.custom_branch_policies) throw new Stop(`The environment ${environment} allows every protected branch, not only main. ${fix}`);
  const list = await get("/deployment-branch-policies?per_page=100");
  if (list.status !== 200) throw new Stop(`Could not read the deployment branch rules of ${environment} (HTTP ${list.status}). Nothing was deployed.`);
  const rules = (list.body.branch_policies ?? []).map((x) => `${x.type ?? "branch"}:${x.name}`);
  if (rules.length !== 1 || rules[0] !== "branch:main") throw new Stop(`The environment ${environment} must allow the branch main only; its rules are ${rules.length ? rules.join(", ") : "empty"}. ${fix}`);
  info(`environment ${environment}: deployment branch rule = main only`);
  return "main only";
}
