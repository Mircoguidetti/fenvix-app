/**
 * When a pending warm-up may take a machine: the scheduling rules, as one pure function (unit-tested on its own).
 * A warm-up is the lowest priority work of the fleet: it only takes a machine nobody else needs.
 */

export interface WarmupSettings {
  /** Off: no warm-up is requested or dispatched (WARMUP_ENABLED=false). */
  enabled: boolean;
  /**
   * A push (or the setup pull request's merge) waits this long before its warm-up may take a machine, so that the
   * customer's own push run on the default branch (which writes the cache) can cover the commit first.
   */
  graceSeconds: number;
  /** At most this many warm-ups of one repository take a machine in any 24 hours. */
  dailyCap: number;
  /** At most this many warm-ups of one organization on machines at once. */
  orgConcurrency: number;
  /** Machines of a region's fleet a warm-up never takes: kept free for customers' jobs. */
  reserve: number;
  /** A machine that has not reported "started" after this long is given up (and the warm-up tried again later). */
  startTimeoutSeconds: number;
  /** A warm-up running longer than this is stopped (failed). */
  maxRunSeconds: number;
  /** A customer's job queued in the region less than this long ago, still without a machine, blocks warm-ups there. */
  waitingJobWindowSeconds: number;
  /** After a preemption, the warm-up waits this long before it may take a machine again. */
  preemptBackoffSeconds: number;
  /** Machines requested for one warm-up before it is given up. */
  maxAttempts: number;
}

export const DEFAULT_WARMUP: WarmupSettings = {
  enabled: true, graceSeconds: 180, dailyCap: 6, orgConcurrency: 1, reserve: 1, startTimeoutSeconds: 900,
  maxRunSeconds: 3 * 3600, waitingJobWindowSeconds: 3600, preemptBackoffSeconds: 300, maxAttempts: 3,
};

export interface DispatchContext {
  /** No placement for the organization's region: the warm-up never runs anywhere else. */
  canPlace: boolean;
  /** Customers' jobs queued in the region without a machine. */
  customerJobsWaiting: number;
  /** The region's machines now (customer jobs and warm-ups, pending or running) and its limit. */
  running: number;
  max: number;
  /** The organization's warm-ups on machines now. */
  orgActive: number;
  /** Warm-ups of this repository that took a machine in the last 24 hours, and when the oldest of them did. */
  repoLast24h: number;
  oldestLast24h: Date | null;
}

export type Decision = { dispatch: true } | { dispatch: false; detail: string; retryAt?: Date };

export function decide(w: WarmupSettings, region: string, c: DispatchContext): Decision {
  if (!c.canPlace) return { dispatch: false, detail: `no fenvix machines in the organization's region (${region}) yet: a warm-up never runs in another region` };
  if (c.customerJobsWaiting > 0) return { dispatch: false, detail: `waiting: ${c.customerJobsWaiting === 1 ? "a customer job is" : `${c.customerJobsWaiting} customer jobs are`} waiting for a machine in ${region} (warm-ups come last)` };
  if (c.running >= c.max - w.reserve) return { dispatch: false, detail: `waiting for a free machine in ${region} (${c.running} of ${c.max} busy; ${w.reserve} kept for customer jobs)` };
  if (c.orgActive >= w.orgConcurrency) return { dispatch: false, detail: `waiting: the organization's other warm-up${w.orgConcurrency === 1 ? " is" : "s are"} running (at most ${w.orgConcurrency} at once)` };
  if (c.repoLast24h >= w.dailyCap) {
    const retryAt = c.oldestLast24h ? new Date(c.oldestLast24h.getTime() + 86_400_000) : undefined;
    return { dispatch: false, detail: `daily cap reached: ${w.dailyCap} warm-ups of this repository in 24 hours${retryAt ? `; the next can start after ${retryAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}`, ...(retryAt ? { retryAt } : {}) };
  }
  return { dispatch: true };
}

/** The warm-up's states (gh_warmups.status). Active: pending, dispatched, running. */
export const ACTIVE = ["pending", "dispatched", "running"] as const;
export const FINAL = ["succeeded", "failed", "unsupported", "covered", "superseded", "cancelled"] as const;
export type WarmupStatus = (typeof ACTIVE)[number] | (typeof FINAL)[number];

/** What the machine reports at the end. */
export type WarmupOutcome = "succeeded" | "failed" | "unsupported";

/** The runner name of a warm-up's machine: one per attempt (a fresh machine after a preemption). */
export const warmupRunnerName = (id: number, attempt: number) => (attempt <= 1 ? `fenvix-w${id}` : `fenvix-w${id}-${attempt}`);

export const short = (sha: string) => sha.slice(0, 7);
