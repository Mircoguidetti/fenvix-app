// AWS Lambda entry (EventBridge Scheduler): terminates runner machines past their hard limit. REAP is a list of
// role:hours, e.g. "runner-job:6,runner-demo:12" (per-job machines; demo machines nobody took down). With
// DEREGISTER_DEMO_RUNNERS=1 (demo mode) it also deregisters the GitHub runner of every demo machine that is gone, so a
// forgotten or half-finished demo-down never leaves our runner registered (docs/REVIEW-R-012.md F6).
import { EC2Client } from "@aws-sdk/client-ec2";
import { SSMClient } from "@aws-sdk/client-ssm";
import { parsePrivateKey } from "../config.ts";
import { GitHubApp } from "../github/client.ts";
import { deregisterGoneDemoRunners } from "../runners/demo.ts";
import { reap } from "../runners/launcher.ts";
import { jsonLogger } from "../work.ts";
import { refreshing } from "./runtime.ts";
import { loadParameter } from "./secrets.ts";

const ec2 = new EC2Client({});
const log = jsonLogger(process.env.LOG_LEVEL ?? "info");

export function parseReap(v: string | undefined): [string, number][] {
  const out = (v ?? "").split(",").filter(Boolean).map((x) => {
    const [role, h] = x.split(":");
    const hours = Number(h);
    if (!role || !/^runner-[a-z]+$/.test(role) || !(hours > 0)) throw new Error(`REAP: "${x}" is not role:hours`);
    return [role, hours] as [string, number];
  });
  if (!out.length) throw new Error("REAP is required, e.g. runner-job:6,runner-demo:12");
  return out;
}

const github = refreshing(async () => {
  const env = process.env;
  const pem = await loadParameter(new SSMClient({}), `${env.SSM_PREFIX}/private-key`);
  return { gh: new GitHubApp({ apiUrl: env.GITHUB_API_URL || "https://api.github.com", appId: Number(env.GITHUB_APP_ID), privateKey: parsePrivateKey(pem), timeoutMs: 15_000 }), close: async () => undefined };
});

export const handler = async (): Promise<{ terminated: string[]; deregistered: string[] }> => {
  const terminated: string[] = [];
  for (const [role, hours] of parseReap(process.env.REAP)) {
    const t = await reap(ec2, hours, Date.now(), role);
    if (t.length) log.warn({ terminated: t, role, maxHours: hours }, "reaper: machines past the hard limit terminated");
    terminated.push(...t);
  }
  let deregistered: string[] = [];
  if (process.env.DEREGISTER_DEMO_RUNNERS === "1") {
    const { gh } = await github();
    deregistered = await deregisterGoneDemoRunners({ gh, ec2, launchTemplateId: "", machineEnv: {} });
    if (deregistered.length) log.warn({ deregistered }, "reaper: runners of demo machines that are gone deregistered");
  }
  return { terminated, deregistered };
};
