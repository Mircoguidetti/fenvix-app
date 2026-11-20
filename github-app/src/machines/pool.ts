import { createHash, randomBytes } from "node:crypto";
import type { Client, Db } from "../db.ts";
import { signMachineCredential, type MachineScope } from "../runners/credentials.ts";
import type { Region } from "../runners/launcher.ts";
import type { MachineDriver } from "./driver.ts";
import { seal, unseal } from "./seal.ts";
import type { PoolSettings } from "./settings.ts";

/**
 * The dispatcher of our machines (the design of 2026-11-20, docs/REPORT-our-machines.md "Final design").
 *
 *   - A customer's job goes to a machine that already holds that customer's jobs (a free slot, each slot its own
 *     sandbox), else to a clean running machine (the always-on one), else to a reserve machine that is started, else to
 *     a new machine. The machine is then BOUND to that customer: it takes only that customer's work until it is empty,
 *     lingers a few minutes for the customer's next job, and is terminated. It is never given to another customer and
 *     never made clean again (enforced by the database: migration 0018, trigger gh_machines_one_customer).
 *   - Whenever a clean running machine is taken, a reserve machine is started at once, ahead of the next job; whenever
 *     the reserve is short, a new machine is prepared (booted once, then stopped: only its disk is paid).
 *   - Caps: machines and concurrent jobs per customer, machines per region; above `spotAbove` running machines, new
 *     machines are spot. A job that finds no room waits in the database (gh_jobs.dispatch_state = 'pending') and is
 *     dispatched by the next free slot or the next tick, in the order it was queued.
 *   - Credentials: a machine boots with a single-use boot secret (its user data), exchanges it for a session credential,
 *     and fetches each lease's work (the just-in-time runner configuration, the job's own credentials) over HTTPS. A
 *     job's credentials are never in user data, and a machine can fetch only its own leases.
 */

export interface AllocRequest {
  /**
   * exploration: the nightly exploration's hook (F-04, not scheduled yet): it never takes the always-on or a reserve
   * machine (those are for pull-request jobs) and a new machine for it is always spot (a lost machine restarts from the
   * same seed).
   */
  kind: "job" | "warmup" | "replay" | "exploration";
  jobId?: number;
  warmupId?: number;
  replayId?: number;
  workspaceId: string;
  region: Region;
  size: string;
}
export type Alloc = { leaseId: number; machineId: number; slot: number } | { wait: string };

export interface PoolOptions {
  /** RUNNER_TOKEN (current, previous): signs machine credentials and seals lease payloads. */
  keys: string[];
  /** The API the machines call (https://api.fenvix.dev). */
  apiUrl: string;
  /** Plain settings every machine gets (no secret): the cache URL base, the summaries URL. */
  machineEnv: Record<string, string>;
  /** The regions that have a placement. */
  regions: Region[];
  log?: { info(o: object, msg?: string): void; warn(o: object, msg?: string): void };
  now?: () => number;
}

interface MachineRow {
  id: number; region: Region; size: string; instance_type: string; market: string; slots: number; instance_id: string | null; state: string;
  workspace_id: string | null; session_gen: number; boot_secret_sha256: string | null; launched_at: Date | null; hello_at: Date | null;
  last_seen_at: Date | null; empty_since: Date | null; interrupted_at: Date | null; created_at: Date; bound_at: Date | null;
}

type Action =
  | { do: "launch"; machineId: number; region: Region; instanceType: string; market: "on-demand" | "spot"; secret: string }
  | { do: "start"; machineId: number; region: Region; instanceId: string; secret: string }
  | { do: "stop"; machineId: number; region: Region; instanceId: string }
  | { do: "terminate"; machineId: number; region: Region; instanceId: string | null };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const MACHINE_TTL_SECONDS = 3 * 86_400;
const SAFE = /^[A-Za-z0-9_./:@+=-]*$/;

export class MachinePool {
  readonly db: Db;
  readonly s: PoolSettings;
  private readonly driver: MachineDriver;
  private readonly o: PoolOptions;
  constructor(db: Db, driver: MachineDriver, s: PoolSettings, o: PoolOptions) { this.db = db; this.driver = driver; this.s = s; this.o = o; }

  private now(): number { return (this.o.now ?? Date.now)(); }
  canPlace(region: Region): boolean { return this.o.regions.includes(region); }
  instanceTypeOf(size: string): string | null { return this.s.sizes[size]?.instanceType ?? null; }

  /** The machine's user data: plain settings and its single-use boot secret (no job credential, ever). */
  userData(machineId: number, secret: string): string {
    const env: Record<string, string> = { ...this.o.machineEnv, FENVIX_MACHINE_ID: String(machineId), FENVIX_BOOT_SECRET: secret, FENVIX_API_URL: this.o.apiUrl };
    const lines = ["# fenvix machine settings (read by fenvix-agent; not a script)"];
    for (const [k, v] of Object.entries(env)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(k) || !SAFE.test(v)) throw new Error(`machine setting ${k} has characters the settings file does not allow`);
      lines.push(`${k}=${v}`);
    }
    return lines.join("\n") + "\n";
  }

  // ---------------------------------------------------------------- allocation

  /**
   * A slot for one piece of work of one customer, or why it waits. Serialised per region (advisory lock): two jobs
   * never take the same slot, and two customers never race for one clean machine.
   */
  async allocate(r: AllocRequest): Promise<Alloc> {
    if (!this.canPlace(r.region)) return { wait: `no machines in region ${r.region}` };
    const size = this.s.sizes[r.size];
    if (!size) return { wait: `unknown machine size "${r.size}"` };
    const actions: Action[] = [];
    const out = await this.db.tx(null, async (c) => {
      await c.query("select pg_advisory_xact_lock(hashtext('fenvix-pool:' || $1))", [r.region]);
      const caps = (await c.query<{ max_machines: number | null; max_concurrent_jobs: number | null }>(
        "select max_machines, max_concurrent_jobs from public.workspaces where id = $1", [r.workspaceId])).rows[0];
      const maxJobs = caps?.max_concurrent_jobs ?? this.s.jobsPerCustomer;
      const maxMachines = caps?.max_machines ?? this.s.machinesPerCustomer;
      const active = (await c.query<{ n: number }>(
        "select count(*)::int as n from gh_leases where workspace_id = $1 and state in ('offered', 'running')", [r.workspaceId])).rows[0]!.n;
      if (active >= maxJobs) return { wait: `this organization already runs ${active} jobs at once (its limit is ${maxJobs})` };

      // 1. A machine of this customer with a free slot.
      const own = (await c.query<MachineRow & { used: number[] }>(
        `select m.*, coalesce(array_agg(l.slot) filter (where l.id is not null), '{}') as used
           from gh_machines m left join gh_leases l on l.machine_id = m.id and l.state in ('offered', 'running')
          where m.workspace_id = $1 and m.region = $2 and m.size = $3 and m.state = 'bound' and m.interrupted_at is null
          group by m.id order by count(l.id) desc, m.id`, [r.workspaceId, r.region, r.size])).rows;
      for (const m of own) {
        if (m.used.length >= m.slots) continue;
        const slot = firstFree(m.used, m.slots);
        return this.lease(c, m.id, slot, r, "own");
      }
      const mine = (await c.query<{ n: number }>(
        "select count(*)::int as n from gh_machines where workspace_id = $1 and state in ('bound', 'retiring')", [r.workspaceId])).rows[0]!.n;
      if (mine >= maxMachines) return { wait: `this organization's ${mine} machines are busy (its limit is ${maxMachines})` };

      const pr = r.kind !== "exploration";
      // 2. A clean running machine (the always-on one): bound to this customer now.
      const ready = !pr ? undefined : (await c.query<MachineRow>(
        "select * from gh_machines where region = $1 and size = $2 and state = 'ready' order by hello_at nulls last, id limit 1 for update",
        [r.region, r.size])).rows[0];
      if (ready) {
        await c.query("update gh_machines set state = 'bound', workspace_id = $2, bound_at = now(), empty_since = null where id = $1", [ready.id, r.workspaceId]);
        return this.lease(c, ready.id, 1, r, "ready");
      }
      // 3. A reserve machine (stopped, never used): started for this customer with a fresh boot secret.
      const reserve = !pr ? undefined : (await c.query<MachineRow>(
        "select * from gh_machines where region = $1 and size = $2 and state = 'reserve' and instance_id is not null order by id limit 1 for update",
        [r.region, r.size])).rows[0];
      if (reserve) {
        const secret = randomBytes(32).toString("hex");
        await c.query(
          "update gh_machines set state = 'bound', workspace_id = $2, bound_at = now(), empty_since = null, boot_secret_sha256 = $3, hello_at = null, launched_at = now() where id = $1",
          [reserve.id, r.workspaceId, sha256(secret)]);
        actions.push({ do: "start", machineId: reserve.id, region: r.region, instanceId: reserve.instance_id!, secret });
        return this.lease(c, reserve.id, 1, r, "reserve");
      }
      // 4. A new machine, if the region has room: spot above the on-demand threshold (a burst).
      const live = (await c.query<{ n: number; running: number }>(
        "select count(*)::int as n, count(*) filter (where state in ('bound', 'ready', 'starting', 'launching', 'preparing'))::int as running from gh_machines where region = $1 and state <> 'gone'",
        [r.region])).rows[0]!;
      if (live.n >= this.s.maxMachines) return { wait: `all ${live.n} machines of region ${r.region} are in use (limit ${this.s.maxMachines})` };
      const market = !pr || live.running >= this.s.spotAbove ? "spot" as const : "on-demand" as const;
      const secret = randomBytes(32).toString("hex");
      const m = (await c.query<{ id: number }>(
        `insert into gh_machines (region, size, instance_type, market, slots, state, workspace_id, ever_bound, bound_at, boot_secret_sha256, launched_at)
         values ($1, $2, $3, $4, $5, 'bound', $6, true, now(), $7, now()) returning id`,
        [r.region, r.size, size.instanceType, market, size.slots, r.workspaceId, sha256(secret)])).rows[0]!;
      actions.push({ do: "launch", machineId: m.id, region: r.region, instanceType: size.instanceType, market, secret });
      return this.lease(c, m.id, 1, r, "new");
    });
    await this.run(actions);
    if ("leaseId" in out) await this.ensure(r.region);
    return out;
  }

  private async lease(c: Client, machineId: number, slot: number, r: AllocRequest, path: "own" | "ready" | "reserve" | "new"): Promise<Alloc> {
    const l = (await c.query<{ id: number }>(
      `insert into gh_leases (machine_id, slot, kind, job_id, warmup_id, replay_id, workspace_id, path) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [machineId, slot, r.kind, r.jobId ?? null, r.warmupId ?? null, r.replayId ?? null, r.workspaceId, path])).rows[0]!;
    await c.query("update gh_machines set empty_since = null where id = $1", [machineId]);
    return { leaseId: l.id, machineId, slot };
  }

  /** The lease's work, sealed until its machine takes it. */
  async offer(leaseId: number, work: Record<string, unknown>): Promise<void> {
    await this.db.q("update gh_leases set payload = $2 where id = $1 and state = 'offered'", [leaseId, seal(this.o.keys[0]!, leaseId, work)]);
  }

  /** A lease that will not run (its runner could not be registered, the job was cancelled): its slot is free. */
  async release(leaseId: number, why: string, state: "done" | "lost" = "lost"): Promise<void> {
    await this.db.tx(null, async (c) => {
      const l = (await c.query<{ machine_id: number }>(
        "update gh_leases set state = $2, payload = null, finished_at = now(), detail = left($3, 1000) where id = $1 and state in ('offered', 'running') returning machine_id",
        [leaseId, state, why])).rows[0];
      if (l) await this.markEmpty(c, l.machine_id);
    });
  }

  private async markEmpty(c: Client, machineId: number): Promise<void> {
    await c.query(
      `update gh_machines set empty_since = now() where id = $1 and empty_since is null
         and not exists (select 1 from gh_leases where machine_id = $1 and state in ('offered', 'running'))`, [machineId]);
  }

  /** GitHub says the job ended (workflow_job completed): its slot is free. Returns the machine it ran on. */
  async jobCompleted(jobId: number): Promise<{ machineId: number; size: string; instanceType: string; market: string; interrupted: boolean } | null> {
    return this.db.tx(null, async (c) => {
      const l = (await c.query<{ id: number; machine_id: number }>(
        "update gh_leases set state = 'done', payload = null, finished_at = coalesce(finished_at, now()) where job_id = $1 and state in ('offered', 'running') returning id, machine_id",
        [jobId])).rows[0];
      const m = (await c.query<{ id: number; size: string; instance_type: string; market: string; interrupted_at: Date | null }>(
        "select m.id, m.size, m.instance_type, m.market, m.interrupted_at from gh_leases l join gh_machines m on m.id = l.machine_id where l.job_id = $1 order by l.id desc limit 1",
        [jobId])).rows[0];
      if (l) await this.markEmpty(c, l.machine_id);
      return m ? { machineId: m.id, size: m.size, instanceType: m.instance_type, market: m.market, interrupted: !!m.interrupted_at } : null;
    });
  }

  /** The lease of a warm-up (to end it when the warm-up is superseded, cancelled or preempted). */
  async endWarmup(warmupId: number, why: string): Promise<number[]> {
    const ls = await this.db.q<{ id: number }>("select id from gh_leases where warmup_id = $1 and state in ('offered', 'running')", [warmupId]);
    for (const l of ls) await this.release(l.id, why, "done");
    return ls.map((l) => l.id);
  }

  // ---------------------------------------------------------------- the machine's side (API routes)

  /** The single-use boot secret for a session credential. Null: not this machine, already used, or retired. */
  async hello(machineId: number, bootSecret: string, engineVersion: string | null): Promise<{ token: string; mode: "prepare" | "work"; pollSeconds: number } | null> {
    if (!/^[0-9a-f]{64}$/.test(bootSecret) || !Number.isSafeInteger(machineId) || machineId <= 0) return null;
    const res = await this.db.tx(null, async (c) => {
      const m = (await c.query<MachineRow>("select * from gh_machines where id = $1 for update", [machineId])).rows[0];
      if (!m || !m.boot_secret_sha256 || m.boot_secret_sha256 !== sha256(bootSecret) || ["retiring", "gone"].includes(m.state)) return null;
      let state = m.state;
      if (m.state === "launching") {
        const r = (await c.query<{ n: number }>("select count(*)::int as n from gh_machines where region = $1 and size = $2 and state in ('ready', 'starting')", [m.region, m.size])).rows[0]!.n;
        state = r < this.s.alwaysOn ? "ready" : "preparing";
      } else if (m.state === "starting") state = "ready";
      const ev = engineVersion && engineVersion.length <= 200 ? engineVersion : null;
      const u = (await c.query<{ session_gen: number }>(
        `update gh_machines set state = $2, boot_secret_sha256 = null, session_gen = session_gen + 1, hello_at = now(), last_seen_at = now(),
           engine_version = coalesce($3, engine_version) where id = $1 returning session_gen`, [machineId, state, ev])).rows[0]!;
      return { gen: u.session_gen, mode: state === "preparing" ? "prepare" as const : "work" as const, state };
    });
    if (!res) return null;
    this.o.log?.info({ machine: machineId, state: res.state, engine: engineVersion }, "machine said hello");
    const exp = Math.floor(this.now() / 1000) + MACHINE_TTL_SECONDS;
    return { token: signMachineCredential(this.o.keys[0]!, { machineId, gen: res.gen, exp }), mode: res.mode, pollSeconds: 2 };
  }

  /** Whether a machine credential is its machine's current session (not retired, not replaced by a newer hello). */
  async alive(scope: MachineScope): Promise<boolean> {
    return !!(await this.db.q("select 1 from gh_machines where id = $1 and session_gen = $2 and state not in ('retiring', 'gone')", [scope.machineId, scope.gen]))[0];
  }

  /** The machine's current session, or null (a stale credential: retired, or it said hello again). */
  private async session(c: Client | Db, scope: MachineScope): Promise<MachineRow | null> {
    const q = "select * from gh_machines where id = $1 and session_gen = $2";
    const rows = "query" in c ? (await (c as Client).query<MachineRow>(q, [scope.machineId, scope.gen])).rows : await (c as Db).q<MachineRow>(q, [scope.machineId, scope.gen]);
    return rows[0] ?? null;
  }

  /**
   * The machine's poll: the work offered to ITS slots (each taken once, then deleted), the slots it must stop (their
   * lease ended: a warm-up superseded, a job cancelled), and whether it must shut down.
   */
  async poll(scope: MachineScope, holding: number[]): Promise<{ leases: { leaseId: number; slot: number; kind: string; work: unknown }[]; stop: number[]; retire: boolean } | null> {
    return this.db.tx(null, async (c) => {
      const m = await this.session(c, scope);
      if (!m) return null;
      await c.query("update gh_machines set last_seen_at = now() where id = $1", [m.id]);
      if (["retiring", "gone"].includes(m.state)) return { leases: [], stop: holding, retire: true };
      const offered = (await c.query<{ id: number; slot: number; kind: string; payload: string }>(
        "select id, slot, kind, payload from gh_leases where machine_id = $1 and state = 'offered' and payload is not null order by id for update", [m.id])).rows;
      const leases = [];
      for (const l of offered) {
        leases.push({ leaseId: l.id, slot: l.slot, kind: l.kind, work: unseal(this.o.keys, l.id, l.payload) });
        await c.query("update gh_leases set state = 'running', payload = null, taken_at = now() where id = $1", [l.id]);
      }
      const held = holding.filter((x) => Number.isSafeInteger(x) && x > 0).slice(0, 32);
      const live = held.length
        ? new Set((await c.query<{ id: number }>("select id from gh_leases where machine_id = $1 and id = any($2) and state = 'running'", [m.id, held])).rows.map((x) => x.id))
        : new Set<number>();
      return { leases, stop: held.filter((x) => !live.has(x)), retire: false };
    });
  }

  /** What the machine reports: a slot finished, a reserve machine is prepared, EC2 will take a spot machine back. */
  async event(scope: MachineScope, e: { type: "finished" | "prepared" | "interrupted"; leaseId?: number; detail?: string }): Promise<boolean> {
    return this.db.tx(null, async (c) => {
      const m = await this.session(c, scope);
      if (!m) return false;
      const detail = String(e.detail ?? "").slice(0, 1000);
      if (e.type === "finished" && e.leaseId) {
        const l = (await c.query("update gh_leases set state = 'done', finished_at = now(), detail = $3 where id = $1 and machine_id = $2 and state in ('offered', 'running') returning id",
          [e.leaseId, m.id, detail])).rows[0];
        if (l) await this.markEmpty(c, m.id);
        return true;
      }
      if (e.type === "prepared" && m.state === "preparing") {
        // The next tick (the worker, which may call EC2) stops it: it never ran a job, and is started again with a new
        // boot secret when it is needed.
        await c.query("update gh_machines set prepared_at = coalesce(prepared_at, now()) where id = $1", [m.id]);
        return true;
      }
      if (e.type === "interrupted") {
        await c.query("update gh_machines set interrupted_at = coalesce(interrupted_at, now()), state = 'retiring', retire_requested_at = now(), detail = 'spot interruption' where id = $1 and state <> 'gone'", [m.id]);
        // Its work is re-queued: an offered lease at once; a running job is re-run when GitHub reports it failed.
        await this.loseOffered(c, `machine ${m.id} interrupted (spot)`, m.id);
        return true;
      }
      return true;
    });
  }

  /** Offered (not yet taken) leases of a machine are lost; their jobs go back to pending. */
  private async loseOffered(c: Client, why: string, machineId: number): Promise<void> {
    const lost = (await c.query<{ job_id: number | null }>(
      "update gh_leases set state = 'lost', payload = null, finished_at = now(), detail = $2 where machine_id = $1 and state = 'offered' returning job_id", [machineId, why])).rows;
    for (const l of lost) if (l.job_id) await c.query("update gh_jobs set dispatch_state = 'pending', dispatch_detail = $2 where job_id = $1 and status = 'queued'", [l.job_id, why]);
  }

  // ---------------------------------------------------------------- the reserve and the tick

  /**
   * Keeps `alwaysOn` clean machines running (a reserve machine started at once when one is taken: ahead of the next
   * job, not when it waits) and `reserve` prepared machines stopped.
   */
  async ensure(region: Region): Promise<{ started: number; launched: number }> {
    const actions: Action[] = [];
    const size = this.s.defaultSize;
    const st = this.s.sizes[size]!;
    await this.db.tx(null, async (c) => {
      await c.query("select pg_advisory_xact_lock(hashtext('fenvix-pool:' || $1))", [region]);
      const n = (await c.query<{ ready: number; reserve: number; live: number }>(
        `select count(*) filter (where state in ('ready', 'starting'))::int as ready,
                count(*) filter (where state in ('reserve', 'preparing') or (state = 'launching'))::int as reserve,
                count(*) filter (where state <> 'gone')::int as live
           from gh_machines where region = $1 and size = $2`, [region, size])).rows[0]!;
      const all = (await c.query<{ n: number }>("select count(*)::int as n from gh_machines where region = $1 and state <> 'gone'", [region])).rows[0]!.n;
      let live = all;
      let ready = n.ready;
      // Ready short: start a reserve machine (warm start), else launch one (cold).
      while (ready < this.s.alwaysOn && live < this.s.maxMachines) {
        const r = (await c.query<MachineRow>("select * from gh_machines where region = $1 and size = $2 and state = 'reserve' and instance_id is not null order by id limit 1 for update", [region, size])).rows[0];
        const secret = randomBytes(32).toString("hex");
        if (r) {
          await c.query("update gh_machines set state = 'starting', boot_secret_sha256 = $2, hello_at = null, launched_at = now() where id = $1", [r.id, sha256(secret)]);
          actions.push({ do: "start", machineId: r.id, region, instanceId: r.instance_id!, secret });
        } else {
          const m = (await c.query<{ id: number }>(
            "insert into gh_machines (region, size, instance_type, slots, state, boot_secret_sha256, launched_at) values ($1, $2, $3, $4, 'launching', $5, now()) returning id",
            [region, size, st.instanceType, st.slots, sha256(secret)])).rows[0]!;
          actions.push({ do: "launch", machineId: m.id, region, instanceType: st.instanceType, market: "on-demand", secret });
          live++;
        }
        ready++;
      }
      // Reserve short: prepare new machines (they boot once, say hello, and are stopped).
      const reserveNow = (await c.query<{ n: number }>(
        "select count(*)::int as n from gh_machines where region = $1 and size = $2 and (state in ('reserve', 'preparing') or (state = 'launching' and hello_at is null))", [region, size])).rows[0]!.n;
      const readyLaunching = actions.filter((a) => a.do === "launch").length;
      let reserve = reserveNow - readyLaunching;
      while (reserve < this.s.reserve && live < this.s.maxMachines) {
        const secret = randomBytes(32).toString("hex");
        const m = (await c.query<{ id: number }>(
          "insert into gh_machines (region, size, instance_type, slots, state, boot_secret_sha256, launched_at) values ($1, $2, $3, $4, 'launching', $5, now()) returning id",
          [region, size, st.instanceType, st.slots, sha256(secret)])).rows[0]!;
        actions.push({ do: "launch", machineId: m.id, region, instanceType: st.instanceType, market: "on-demand", secret });
        reserve++; live++;
      }
    });
    await this.run(actions);
    return { started: actions.filter((a) => a.do === "start").length, launched: actions.filter((a) => a.do === "launch").length };
  }

  /**
   * Every minute: machines that went silent or away are retired and their offered work re-queued; leases never taken
   * are lost; a customer's empty machine is terminated after its linger; old machines are terminated; instances with
   * no machine row (or a gone one) are terminated; the ready machines and the reserve are topped up.
   */
  async tick(): Promise<{ retired: number; lost: number; orphans: number; started: number; launched: number }> {
    let retired = 0; let lost = 0; let orphans = 0; let started = 0; let launched = 0;
    for (const region of this.o.regions) {
      const actions: Action[] = [];
      await this.db.tx(null, async (c) => {
        await c.query("select pg_advisory_xact_lock(hashtext('fenvix-pool:' || $1))", [region]);
        // Offered leases never taken.
        const stale = (await c.query<{ id: number; job_id: number | null; machine_id: number }>(
          `update gh_leases l set state = 'lost', payload = null, finished_at = now(), detail = 'the machine did not take it in time'
            from gh_machines m where m.id = l.machine_id and m.region = $1 and l.state = 'offered' and l.created_at < now() - make_interval(mins => $2)
           returning l.id, l.job_id, l.machine_id`, [region, this.s.offerMinutes])).rows;
        for (const l of stale) {
          lost++;
          if (l.job_id) await c.query("update gh_jobs set dispatch_state = 'pending', dispatch_detail = 'its machine did not take it in time' where job_id = $1 and status = 'queued'", [l.job_id]);
          await this.markEmpty(c, l.machine_id);
        }
        // Retire: silent, never booted, lingered long enough, too old.
        const toRetire = (await c.query<MachineRow & { why: string }>(
          `select m.*, case
              when m.state in ('bound', 'ready') and m.hello_at is not null and m.last_seen_at < now() - make_interval(mins => $2) then 'silent'
              when m.state in ('bound', 'ready', 'launching', 'starting', 'preparing') and m.hello_at is null and m.launched_at < now() - make_interval(mins => $2) then 'never said hello'
              when m.state = 'bound' and m.empty_since < now() - make_interval(mins => $3) then 'its customer has no more work'
              when m.state <> 'reserve' and m.created_at < now() - make_interval(hours => $4) then 'past its hard limit'
              when m.state = 'reserve' and m.created_at < now() - interval '14 days' then 'reserve renewed (image and packages)'
            end as why
            from gh_machines m where m.region = $1 and m.state not in ('retiring', 'gone') for update`,
          [region, this.s.silentMinutes, this.s.lingerMinutes, this.s.maxHours])).rows.filter((m) => m.why);
        for (const m of toRetire) {
          await c.query("update gh_machines set state = 'retiring', retire_requested_at = now(), detail = $2 where id = $1", [m.id, m.why]);
          await this.loseOffered(c, `machine ${m.id} retired: ${m.why}`, m.id);
          await c.query("update gh_leases set state = 'lost', finished_at = now(), detail = $2 where machine_id = $1 and state = 'running'", [m.id, `machine retired: ${m.why}`]);
          retired++;
        }
        // Prepared reserve machines are stopped (their session ends: a new boot secret starts them).
        const prepared = (await c.query<MachineRow>(
          "update gh_machines set state = 'reserve', session_gen = session_gen + 1 where region = $1 and state = 'preparing' and prepared_at is not null and instance_id is not null returning *", [region])).rows;
        for (const m of prepared) actions.push({ do: "stop", machineId: m.id, region, instanceId: m.instance_id! });
        const retiring = (await c.query<MachineRow>("select * from gh_machines where region = $1 and state = 'retiring' for update", [region])).rows;
        for (const m of retiring) actions.push({ do: "terminate", machineId: m.id, region, instanceId: m.instance_id });
      });
      await this.run(actions);
      // Reconcile with the cloud.
      try {
        const listed = await this.driver.list(region);
        const rows = await this.db.q<{ id: number; instance_id: string | null; state: string; launched_at: Date | null }>(
          "select id, instance_id, state, launched_at from gh_machines where region = $1 and state <> 'gone'", [region]);
        const known = new Map(rows.filter((r) => r.instance_id).map((r) => [r.instance_id!, r]));
        const orphanIds = listed.filter((i) => !known.has(i.instanceId)).map((i) => i.instanceId);
        if (orphanIds.length) { await this.driver.terminate({ region, instanceIds: orphanIds }); orphans += orphanIds.length; }
        const present = new Set(listed.map((i) => i.instanceId));
        for (const r of rows) {
          if (r.instance_id && !present.has(r.instance_id) && r.launched_at && this.now() - r.launched_at.getTime() > 3 * 60_000) {
            await this.db.tx(null, async (c) => {
              await c.query("update gh_machines set state = 'gone', gone_at = now(), detail = left(detail || ' (no longer in EC2)', 1000) where id = $1", [r.id]);
              await this.loseOffered(c, `machine ${r.id} is gone`, r.id);
              await c.query("update gh_leases set state = 'lost', finished_at = now(), detail = 'machine gone' where machine_id = $1 and state = 'running'", [r.id]);
            });
          }
        }
      } catch (e) {
        this.o.log?.warn({ region, err: e instanceof Error ? e.message : String(e) }, "pool: could not reconcile with EC2");
      }
      const en = await this.ensure(region);
      started += en.started; launched += en.launched;
    }
    return { retired, lost, orphans, started, launched };
  }

  /** The cloud calls, after the transaction that decided them. A failed launch or start makes the machine gone. */
  private async run(actions: Action[]): Promise<void> {
    for (const a of actions) {
      try {
        if (a.do === "launch") {
          const id = await this.driver.launch({
            region: a.region, instanceType: a.instanceType, market: a.market, userData: this.userData(a.machineId, a.secret),
            tags: { "fenvix:machine": String(a.machineId), Name: `fenvix-m${a.machineId}` }, clientToken: `fenvix-machine-${a.machineId}`,
          });
          await this.db.q("update gh_machines set instance_id = $2 where id = $1", [a.machineId, id]);
          this.o.log?.info({ machine: a.machineId, instance: id, type: a.instanceType, market: a.market, region: a.region }, "machine launched");
        } else if (a.do === "start") {
          await this.driver.start({ region: a.region, instanceId: a.instanceId, userData: this.userData(a.machineId, a.secret) });
          this.o.log?.info({ machine: a.machineId, instance: a.instanceId }, "reserve machine started");
        } else if (a.do === "stop") {
          await this.driver.stop({ region: a.region, instanceId: a.instanceId });
        } else if (a.do === "terminate") {
          if (a.instanceId) await this.driver.terminate({ region: a.region, instanceIds: [a.instanceId] });
          await this.db.q("update gh_machines set state = 'gone', gone_at = now() where id = $1", [a.machineId]);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.o.log?.warn({ machine: a.machineId, action: a.do, err: msg }, "pool: cloud call failed");
        if (a.do === "launch" || a.do === "start") {
          await this.db.tx(null, async (c) => {
            await c.query("update gh_machines set state = case when instance_id is null then 'gone' else 'retiring' end, gone_at = case when instance_id is null then now() end, detail = left($2, 1000) where id = $1",
              [a.machineId, `${a.do} failed: ${msg}`]);
            await this.loseOffered(c, `machine ${a.machineId}: ${a.do} failed`, a.machineId);
          });
        }
      }
    }
  }
}

function firstFree(used: number[], slots: number): number {
  for (let i = 1; i <= slots; i++) if (!used.includes(i)) return i;
  throw new Error("no free slot");
}
