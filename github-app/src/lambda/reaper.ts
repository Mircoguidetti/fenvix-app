// AWS Lambda entry (EventBridge Scheduler): terminates runner machines past their hard limit, a backstop independent
// of the pool's database (the pool retires its machines itself, github-app/src/machines/pool.ts). REAP is a list of
// role:hours, e.g. "runner-pool:7".
import { EC2Client } from "@aws-sdk/client-ec2";
import { reap } from "../runners/launcher.ts";
import { jsonLogger } from "../work.ts";

const ec2 = new EC2Client({});
const log = jsonLogger(process.env.LOG_LEVEL ?? "info");

export function parseReap(v: string | undefined): [string, number][] {
  const out = (v ?? "").split(",").filter(Boolean).map((x) => {
    const [role, h] = x.split(":");
    const hours = Number(h);
    if (!role || !/^runner-[a-z]+$/.test(role) || !(hours > 0)) throw new Error(`REAP: "${x}" is not role:hours`);
    return [role, hours] as [string, number];
  });
  if (!out.length) throw new Error("REAP is required, e.g. runner-pool:7");
  return out;
}

export const handler = async (): Promise<{ terminated: string[] }> => {
  const terminated: string[] = [];
  for (const [role, hours] of parseReap(process.env.REAP)) {
    const t = await reap(ec2, hours, Date.now(), role);
    if (t.length) log.warn({ terminated: t, role, maxHours: hours }, "reaper: machines past the hard limit terminated");
    terminated.push(...t);
  }
  return { terminated };
};
