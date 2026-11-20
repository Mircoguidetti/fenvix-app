import { cacheOrgOf } from "../runners/credentials.ts";
import { type Region, RetryLater, type RunnerLaunch, type RunnerLauncher, type WarmupLaunch, warmupSpec } from "../runners/launcher.ts";
import type { MachinePool } from "./pool.ts";

/**
 * Our machines behind the launcher interface the service and the warm-ups already use. `launch` allocates a slot
 * (src/machines/pool.ts) and offers the job's work to it; a job that gets no slot throws RetryLater with the reason,
 * and the service records it as pending (it is dispatched by the next free slot or tick, never by a 12-minute queue
 * retry: audit G-0607, G-1778).
 */
export class PoolLauncher implements RunnerLauncher {
  readonly pooled = true as const;
  readonly pool: MachinePool;
  private readonly machineEnv: Record<string, string>;
  constructor(pool: MachinePool, machineEnv: Record<string, string>) { this.pool = pool; this.machineEnv = machineEnv; }

  canPlace(region: Region): boolean { return this.pool.canPlace(region); }

  /** The pool decides per job (customer caps, slots, reserve); the service asks it in launch(). */
  async hasCapacity(): Promise<boolean> { return true; }

  /** What a job's sandbox gets, besides its credentials: the run mode, the skip switch and the cache of ITS repository. */
  jobEnv(l: RunnerLaunch): Record<string, string> {
    const env: Record<string, string> = {
      FENVIX_MODE: l.mode ?? "enforce",
      FENVIX_SKIP: l.skipWithProof === false ? "0" : "1",
      FENVIX_REGION: l.region ?? "eu",
      FENVIX_RUNNER_NAME: l.runnerName,
      FENVIX_JOB_ID: String(l.jobId),
      FENVIX_RUN_ID: String(l.runId),
      FENVIX_REPOSITORY_ID: String(l.repositoryId),
      FENVIX_CACHE_ACCESS: l.cacheAccess,
    };
    if (this.machineEnv.FENVIX_CACHE_URL && l.cacheToken) {
      const org = cacheOrgOf(l.installationId, l.repositoryId);
      env.FENVIX_CACHE_URL = `${new URL(this.machineEnv.FENVIX_CACHE_URL).origin}/${org}`;
      env.FENVIX_CACHE_ORG = org;
    } else {
      env.FENVIX_CACHE_ACCESS = "none";
    }
    return env;
  }

  async launch(l: RunnerLaunch): Promise<{ instanceId: string | null; already: boolean }> {
    if (!l.workspaceId || !l.size) throw new Error("a pooled job needs its organization and size");
    const a = await this.pool.allocate({ kind: "job", jobId: l.jobId, workspaceId: l.workspaceId, region: l.region ?? "eu", size: l.size });
    if ("wait" in a) throw new RetryLater(a.wait);
    if (!/^[A-Za-z0-9+/=]+$/.test(l.jitConfig)) { await this.pool.release(a.leaseId, "bad just-in-time configuration"); throw new Error("the just-in-time configuration is not base64"); }
    await this.pool.offer(a.leaseId, {
      kind: "job", runnerName: l.runnerName, jitConfig: l.jitConfig, summaryToken: l.summaryToken ?? null, cacheToken: l.cacheToken ?? null, env: this.jobEnv(l),
    });
    return { instanceId: null, already: false, ...{ leaseId: a.leaseId, machineId: a.machineId } };
  }

  async slots(region: Region): Promise<{ running: number; warmups: number; max: number }> {
    const max = this.pool.s.maxMachines * (this.pool.s.sizes[this.pool.s.defaultSize]?.slots ?? 1);
    const r = await this.pool.db.q<{ running: number; warmups: number }>(
      `select count(*)::int as running, count(*) filter (where l.kind = 'warmup')::int as warmups
         from gh_leases l join gh_machines m on m.id = l.machine_id where m.region = $1 and l.state in ('offered', 'running')`, [region]);
    return { running: r[0]?.running ?? 0, warmups: r[0]?.warmups ?? 0, max };
  }

  async launchWarmup(w: WarmupLaunch): Promise<{ instanceId: string | null; already: boolean }> {
    if (!w.workspaceId) throw new RetryLater("a warm-up of an unlinked installation gets no machine");
    const a = await this.pool.allocate({ kind: "warmup", warmupId: w.warmupId, workspaceId: w.workspaceId, region: w.region, size: this.pool.s.defaultSize });
    if ("wait" in a) throw new RetryLater(a.wait);
    const env: Record<string, string> = { FENVIX_KIND: "warmup", FENVIX_MODE: "enforce", FENVIX_SKIP: "1", FENVIX_REGION: w.region, FENVIX_RUNNER_NAME: w.runnerName, FENVIX_WARMUP_ID: String(w.warmupId), FENVIX_CACHE_ACCESS: "write" };
    if (this.machineEnv.FENVIX_CACHE_URL) {
      const org = cacheOrgOf(w.installationId, w.repositoryId);
      env.FENVIX_CACHE_URL = `${new URL(this.machineEnv.FENVIX_CACHE_URL).origin}/${org}`;
      env.FENVIX_CACHE_ORG = org;
    }
    await this.pool.offer(a.leaseId, { kind: "warmup", spec: warmupSpec(w), checkoutToken: w.checkoutToken, summaryToken: w.summaryToken, cacheToken: w.cacheToken ?? null, env });
    return { instanceId: null, already: false };
  }

  async terminateWarmup(_region: Region, warmupId: number): Promise<string[]> {
    return (await this.pool.endWarmup(warmupId, "warm-up ended by the service")).map(String);
  }
}
