import { parseExploration, parseResults, type RunnerExploration, type RunnerResults } from "./results/runner-records.ts";
import type { Logger } from "./service.ts";
import type { GitHubService } from "./service.ts";

/**
 * The work an HTTP request hands off after it has been checked (signature, runner token, body): the request is
 * answered 202 at once and this runs elsewhere.
 *
 *   - node server mode (src/server.ts, the tests): in the same process, in the background (InProcessQueue);
 *   - AWS Lambda (src/lambda/): sent to an SQS queue and run by the worker Lambda (src/queue/sqs.ts), so no work
 *     happens after the HTTP response, which Lambda would freeze.
 *
 * Running the same Work twice is safe: deliveries are recorded once (gh_webhook_deliveries), summaries and results
 * chunks are upserted and applied idempotently, a run is published once (gh_jobs.published_at) with one usage event
 * per GitHub job, an exploration is stored once per (project, start, commit), and onboarding finds its open pull request.
 */
export type Work =
  | { kind: "webhook"; event: string; delivery: string; payload: Record<string, unknown> }
  | {
    kind: "summary"; repositoryId: number; runId: number; runAttempt: number; runnerName: string; receiptsUrl: string | null;
    summary: Record<string, unknown>;
  }
  /** POST /v1/runner/results: one chunk of a job's per-test results (checked against RunnerResults). */
  | { kind: "results"; repositoryId: number; runId: number; runAttempt: number; runnerName: string; results: RunnerResults; attemptBound?: boolean }
  /** POST /v1/runner/explorations: one night of exploration of the repository (checked against RunnerExploration). */
  | { kind: "exploration"; repositoryId: number; runnerName: string; exploration: RunnerExploration }
  /** The dashboard asked for the setup pull request of one repository (by GitHub's repository id). */
  | { kind: "onboard"; repositoryId: number }
  /** The dashboard API linked an installation (POST /v1/github/installations/complete): its repositories get projects. */
  | { kind: "installation_linked"; installationId: number }
  /** A project page loaded with a default branch older than a few minutes: read it again from GitHub (by repository id). */
  | { kind: "refresh_default_branch"; repositoryId: number }
  /** The dashboard asked to stop a running run (ci_runs.id): now, at its first failed test, or not any more. */
  | { kind: "stop_run"; runId: string; when: "now" | "first_failure" | "off" };

export interface WorkQueue {
  /** Resolves once the work is accepted (queued durably, or started in this process). Rejects if it was not. */
  enqueue(work: Work): Promise<void>;
}

export function describeWork(w: Work): string {
  switch (w.kind) {
    case "webhook": return `webhook ${w.event} ${w.delivery}`;
    case "summary": return `summary ${w.repositoryId}/${w.runId}/${w.runAttempt}`;
    case "results": return `results ${w.repositoryId}/${w.runId}/${w.runAttempt} chunk ${w.results.chunk}`;
    case "exploration": return `exploration ${w.repositoryId} ${w.exploration.startedAt}`;
    case "onboard": return `onboard ${w.repositoryId}`;
    case "installation_linked": return `installation_linked ${w.installationId}`;
    case "refresh_default_branch": return `refresh_default_branch ${w.repositoryId}`;
    case "stop_run": return `stop_run ${w.runId} ${w.when}`;
  }
}

/** Runs one piece of work. Throws if it failed (the queue then retries it). */
export async function runWork(service: GitHubService, w: Work): Promise<void> {
  if (w.kind === "webhook") {
    await service.handle(w.event, w.delivery, w.payload);
    return;
  }
  if (w.kind === "summary") {
    const { repositoryId, runId, runAttempt, runnerName, receiptsUrl, summary } = w;
    await service.receiveSummary({ repositoryId, runId, runAttempt, runnerName, receiptsUrl, summary });
    return;
  }
  if (w.kind === "results") {
    await service.receiveResults({ repositoryId: w.repositoryId, runId: w.runId, runAttempt: w.runAttempt, runnerName: w.runnerName, results: w.results, attemptBound: w.attemptBound === true });
    return;
  }
  if (w.kind === "exploration") {
    await service.receiveExploration({ repositoryId: w.repositoryId, runnerName: w.runnerName, exploration: w.exploration });
    return;
  }
  if (w.kind === "onboard") {
    await service.onboard(w.repositoryId);
    return;
  }
  if (w.kind === "installation_linked") {
    // Only repositories already linked to an organization get projects and warm-ups: a forged message changes nothing else.
    await service.onInstallationLinked(w.installationId);
    return;
  }
  if (w.kind === "refresh_default_branch") {
    await service.refreshDefaultBranch(w.repositoryId);
    return;
  }
  if (w.kind === "stop_run") {
    await service.stopRun(w.runId, w.when);
    return;
  }
  throw new Error(`unknown work kind ${(w as { kind?: unknown }).kind}`);
}

/** Checks a Work read back from a queue (it crossed a process boundary). */
export function parseWork(v: unknown): Work {
  const o = v as Record<string, unknown> | null;
  const posInt = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x > 0;
  const isObj = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x);
  if (o?.kind === "webhook" && typeof o.event === "string" && typeof o.delivery === "string" && isObj(o.payload)) {
    return { kind: "webhook", event: o.event, delivery: o.delivery, payload: o.payload as Record<string, unknown> };
  }
  if (o?.kind === "summary" && posInt(o.repositoryId) && posInt(o.runId) && posInt(o.runAttempt) && typeof o.runnerName === "string"
    && (o.receiptsUrl === null || typeof o.receiptsUrl === "string") && isObj(o.summary)) {
    return {
      kind: "summary", repositoryId: o.repositoryId as number, runId: o.runId as number, runAttempt: o.runAttempt as number,
      runnerName: o.runnerName, receiptsUrl: o.receiptsUrl as string | null, summary: o.summary as Record<string, unknown>,
    };
  }
  if (o?.kind === "results" && posInt(o.repositoryId) && posInt(o.runId) && posInt(o.runAttempt) && typeof o.runnerName === "string" && isObj(o.results)) {
    return {
      kind: "results", repositoryId: o.repositoryId as number, runId: o.runId as number, runAttempt: o.runAttempt as number,
      runnerName: o.runnerName, results: parseResults(o.results), ...(o.attemptBound === true ? { attemptBound: true } : {}),
    };
  }
  if (o?.kind === "exploration" && posInt(o.repositoryId) && typeof o.runnerName === "string" && isObj(o.exploration)) {
    return { kind: "exploration", repositoryId: o.repositoryId as number, runnerName: o.runnerName, exploration: parseExploration(o.exploration) };
  }
  if (o?.kind === "onboard" && posInt(o.repositoryId)) return { kind: "onboard", repositoryId: o.repositoryId as number };
  if (o?.kind === "installation_linked" && posInt(o.installationId)) return { kind: "installation_linked", installationId: o.installationId as number };
  if (o?.kind === "refresh_default_branch" && posInt(o.repositoryId)) return { kind: "refresh_default_branch", repositoryId: o.repositoryId as number };
  if (o?.kind === "stop_run" && typeof o.runId === "string" && /^[0-9a-f-]{36}$/.test(o.runId) && (o.when === "now" || o.when === "first_failure" || o.when === "off")) {
    return { kind: "stop_run", runId: o.runId, when: o.when };
  }
  throw new Error("not a work message");
}

/** Node server mode: the work runs in this process after the response; `service.idle()` waits for it. */
export class InProcessQueue implements WorkQueue {
  private readonly service: GitHubService;
  constructor(service: GitHubService) { this.service = service; }
  async enqueue(work: Work): Promise<void> {
    this.service.background(describeWork(work), () => runWork(this.service, work));
  }
}

/** A minimal JSON-lines logger for the Lambda worker and sweep (the HTTP side uses Fastify's logger). */
export function jsonLogger(level: string, write: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const order = ["debug", "info", "warn", "error"];
  const min = level === "silent" ? Infinity : Math.max(0, order.indexOf(level));
  const at = (lvl: string) => (o: object, msg?: string) => {
    if (order.indexOf(lvl) < min) return;
    write(JSON.stringify({ level: lvl, time: new Date().toISOString(), ...o, ...(msg ? { msg } : {}) }));
  };
  return { info: at("info"), warn: at("warn"), error: at("error") };
}
