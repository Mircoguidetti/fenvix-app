// AWS Lambda entry: the EventBridge schedule that publishes completed jobs whose runner summary never came.
import { SQSClient } from "@aws-sdk/client-sqs";
import { githubAppConfigured } from "../not-configured.ts";
import { sqsDeadLetters } from "../queue/redrive.ts";
import { makeSweepHandler, notConfiguredSweep } from "./handlers.ts";
import { refreshing, workerCore } from "./runtime.ts";

// The sweep is the machine pool's minute too: it dispatches waiting jobs, so it has the launch secrets and rights.
// It also redrives dead-lettered work once (G-1736).
const dl = process.env.DEAD_LETTER_QUEUE_URL && process.env.WORK_QUEUE_URL ? sqsDeadLetters(new SQSClient({}), process.env.DEAD_LETTER_QUEUE_URL, process.env.WORK_QUEUE_URL) : undefined;
const configured = makeSweepHandler(refreshing(() => workerCore(process.env, { launches: true })), dl);
// While the GitHub App is not configured there are no jobs: the schedule's call does nothing.
export const handler = () => (githubAppConfigured(process.env) ? configured() : notConfiguredSweep());
