// AWS Lambda entry, invoked by scripts/demo-up.sh and demo-down.sh (aws lambda invoke): {"action": "up" | "down" |
// "status", "repository": "owner/name"}. Holds the App's private key and the summary signing key (SSM); never
// reachable from the internet. Works only on DEMO_REPOSITORY (setting demoRepository): a demo runner is never
// registered on a customer's repository (docs/REVIEW-R-012.md F13).
import { EC2Client } from "@aws-sdk/client-ec2";
import { SSMClient } from "@aws-sdk/client-ssm";
import { parsePrivateKey } from "../config.ts";
import { GitHubApp } from "../github/client.ts";
import { demoDown, demoStatus, demoUp, type DemoDeps } from "../runners/demo.ts";
import { githubAppConfigured, NOT_CONFIGURED_MESSAGE } from "../not-configured.ts";
import { loadParameter } from "./secrets.ts";
import { machineEnv, refreshing } from "./runtime.ts";

export async function demoDeps(env: Record<string, string | undefined>, ssm: Pick<SSMClient, "send"> = new SSMClient({})): Promise<DemoDeps & { close(): Promise<void> }> {
  if (!githubAppConfigured(env)) throw new Error(`${NOT_CONFIGURED_MESSAGE} Demo mode registers its runner through the App: configure it first (docs/DEPLOY-AWS.md).`);
  for (const k of ["SSM_PREFIX", "GITHUB_APP_ID", "RUNNER_LAUNCH_TEMPLATE_ID", "DEMO_REPOSITORY"]) if (!env[k]) throw new Error(`${k} is required (DEMO_REPOSITORY: setting demoRepository)`);
  const pem = await loadParameter(ssm, `${env.SSM_PREFIX}/private-key`);
  const summaryKey = await loadParameter(ssm, `${env.SSM_PREFIX}/runner-token`);
  const gh = new GitHubApp({ apiUrl: env.GITHUB_API_URL || "https://api.github.com", appId: Number(env.GITHUB_APP_ID), privateKey: parsePrivateKey(pem), timeoutMs: 15_000 });
  const tags: Record<string, string> = { project: "fenvix" };
  if (env.FENVIX_ENV) tags.env = env.FENVIX_ENV;
  return {
    gh, ec2: new EC2Client({}), launchTemplateId: env.RUNNER_LAUNCH_TEMPLATE_ID!, machineEnv: machineEnv(env), tags,
    allowedRepositories: [env.DEMO_REPOSITORY!], summaryKey, maxHours: Number(env.DEMO_MAX_HOURS ?? "12") || 12,
    close: async () => undefined,
  };
}

const deps = refreshing(() => demoDeps(process.env));

export const handler = async (event: { action?: string; repository?: string }) => {
  const d = await deps();
  const repository = event.repository || process.env.DEMO_REPOSITORY || null;
  switch (event.action) {
    case "up":
      if (!repository) throw new Error("repository is required (owner/name), or set demoRepository in cdk.json");
      return demoUp(d, repository);
    case "down": return demoDown(d, repository);
    case "status": return demoStatus(d, repository);
    default: throw new Error('action must be "up", "down" or "status"');
  }
};
