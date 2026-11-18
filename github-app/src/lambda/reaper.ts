// AWS Lambda entry (EventBridge Scheduler): terminates per-job runner machines older than RUNNER_MAX_HOURS.
import { EC2Client } from "@aws-sdk/client-ec2";
import { reap } from "../runners/launcher.ts";
import { jsonLogger } from "../work.ts";

const ec2 = new EC2Client({});
const log = jsonLogger(process.env.LOG_LEVEL ?? "info");

export const handler = async (): Promise<{ terminated: string[] }> => {
  const hours = Number(process.env.RUNNER_MAX_HOURS ?? "6");
  if (!(hours > 0)) throw new Error("RUNNER_MAX_HOURS must be a positive number");
  const terminated = await reap(ec2, hours);
  if (terminated.length) log.warn({ terminated, maxHours: hours }, "reaper: machines past the hard limit terminated");
  return { terminated };
};
