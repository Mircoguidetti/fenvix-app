// AWS Lambda entry, invoked by scripts/demo-up.sh and demo-down.sh (aws lambda invoke): {"action": "up" | "down" |
// "status", "repository": "owner/name"}. Holds the App's private key (SSM); never reachable from the internet.
import { EC2Client } from "@aws-sdk/client-ec2";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { parsePrivateKey } from "../config.ts";
import { GitHubApp } from "../github/client.ts";
import { demoDown, demoStatus, demoUp, type DemoDeps } from "../runners/demo.ts";
import { machineEnv, once } from "./runtime.ts";

const deps = once(async (): Promise<DemoDeps> => {
  const env = process.env;
  for (const k of ["SSM_PREFIX", "GITHUB_APP_ID", "RUNNER_LAUNCH_TEMPLATE_ID"]) if (!env[k]) throw new Error(`${k} is required`);
  const name = `${env.SSM_PREFIX}/private-key`;
  const r = await new SSMClient({}).send(new GetParametersCommand({ Names: [name], WithDecryption: true }));
  const pem = r.Parameters?.[0]?.Value;
  if (!pem) throw new Error(`missing SSM parameters: ${name}`);
  const gh = new GitHubApp({ apiUrl: env.GITHUB_API_URL || "https://api.github.com", appId: Number(env.GITHUB_APP_ID), privateKey: parsePrivateKey(pem), timeoutMs: 15_000 });
  const tags: Record<string, string> = { project: "fenvix" };
  if (env.FENVIX_ENV) tags.env = env.FENVIX_ENV;
  return { gh, ec2: new EC2Client({}), launchTemplateId: env.RUNNER_LAUNCH_TEMPLATE_ID!, machineEnv: machineEnv(env), tags };
});

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
