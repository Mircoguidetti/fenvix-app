import { createPublicKey, type KeyObject } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.ts";
import type { GitHubService, Logger, MintedJob } from "../service.ts";
import type { Region } from "./api.ts";
import { enrolHostId, HOST_CREDENTIAL_SECONDS, signHostCredential, verifyHostCredential } from "./hostcred.ts";
import type { PnapSettings } from "./settings.ts";

/**
 * The host routes (the "hosts" Lambda; the only App routes a phoenixNAP host calls besides the summary endpoint):
 *
 *   POST /v1/hosts/enrol   Authorization: Bearer fxe1...   once per server: its settings and its host credential
 *   POST /v1/hosts/lease   Authorization: Bearer fxh1...   heartbeat, outcomes of finished jobs, and new jobs of the
 *                                                          host's OWN region for its free slots, each minted now
 *
 * A host's credential names its host and region; the database decides whether the host may lease at all (ready, not
 * draining, current credential generation). Nothing a host says changes which region it serves.
 */
export interface HostsDeps {
  db: Db;
  service: Pick<GitHubService, "mintJob">;
  s: PnapSettings;
  log: Logger;
  /** HOST_SIGNING_KEY (current first, then the previous one during a rotation). */
  hostKeys: string[];
  /** The cache signing key: its PUBLIC half goes to a host running the colocated cache. */
  cacheSigningKey: KeyObject | null;
  now?: () => number;
}

interface HostRow { host_id: string; role: string; region: Region; state: string; slots: number; cred_gen: number }

export interface LeasedJob {
  jobId: number; runnerName: string; repositoryId: number; runId: number; runAttempt: number; jitConfig: string; summaryToken: string;
  cacheAccess: "read" | "write"; cacheToken?: string; cacheOrg?: string; vcpus: number; memMib: number;
}

const MAX_MINT_PER_LEASE = 8;
const MAX_ATTEMPTS = 5;
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export class HostsService {
  private readonly d: HostsDeps;
  constructor(d: HostsDeps) { this.d = d; }

  private now() { return (this.d.now ?? Date.now)(); }

  private credential(h: { host_id: string; region: Region; cred_gen: number }) {
    return signHostCredential(this.d.hostKeys[0]!, { hostId: h.host_id, region: h.region, gen: h.cred_gen, exp: Math.floor(this.now() / 1000) + HOST_CREDENTIAL_SECONDS });
  }

  async enrol(authorization: string | undefined): Promise<{ status: number; body: Record<string, unknown> }> {
    const e = enrolHostId(authorization);
    if (!e) return { status: 401, body: { error: "an enrolment secret is required" } };
    // Single use: the hash is cleared by the same statement that accepts it.
    const [h] = await this.d.db.q<HostRow>(
      `update pnap_hosts set enrol_sha256 = null, state = 'ready', enrolled_at = now(), last_seen_at = now(), updated_at = now()
        where host_id = $1 and role = 'runner' and state = 'provisioning' and enrol_sha256 = $2
        returning host_id, role, region, state, slots, cred_gen`, [e.hostId, e.sha256]);
    if (!h) {
      this.d.log.warn({ host: e.hostId }, "enrolment refused (unknown host, already enrolled, or a wrong secret)");
      return { status: 401, body: { error: "enrolment refused" } };
    }
    const s = this.d.s;
    let cache: Record<string, unknown> = { mode: "off" };
    if (s.cacheMode === "colocated" && this.d.cacheSigningKey) cache = { mode: "colocated", port: s.cachePort };
    if (s.cacheMode === "dedicated" && this.d.cacheSigningKey) {
      const [c] = await this.d.db.q<{ private_ip: string | null }>(
        `select private_ip from pnap_hosts where region = $1 and role = 'cache' and state = 'ready' and private_ip is not null order by enrolled_at desc limit 1`, [h.region]);
      if (c?.private_ip) cache = { mode: "dedicated", ip: c.private_ip, port: s.cachePort };
      else this.d.log.warn({ host: h.host_id, region: h.region }, "no cache server ready in the region yet: this host runs without the shared cache");
    }
    const body: Record<string, unknown> = {
      credential: this.credential(h),
      config: {
        host_id: h.host_id, region: h.region, slots: h.slots, vcpus: s.vcpus, mem_mib: s.memMib, scratch_gib: s.scratchGib,
        job_timeout_minutes: s.jobTimeoutMinutes, control_url: s.controlUrl, summaries_url: `${s.controlUrl}/v1/runner/summaries`, cache,
      },
    };
    if (cache.mode === "colocated" && this.d.cacheSigningKey) body.cachePublicKey = publicKeyJson(this.d.cacheSigningKey);
    this.d.log.info({ host: h.host_id, region: h.region, slots: h.slots, cache: cache.mode }, "host enrolled");
    return { status: 200, body };
  }

  async lease(authorization: string | undefined, b: Record<string, unknown> | undefined): Promise<{ status: number; body: Record<string, unknown> }> {
    const scope = verifyHostCredential(this.d.hostKeys, authorization, this.now());
    if (!scope) return { status: 401, body: { error: "a host credential is required" } };
    const [h] = await this.d.db.q<HostRow>(`select host_id, role, region, state, slots, cred_gen from pnap_hosts where host_id = $1`, [scope.hostId]);
    if (!h || h.role !== "runner" || h.cred_gen !== scope.gen || h.region !== scope.region || !["ready", "draining"].includes(h.state)) {
      return { status: 403, body: { error: "this host may not lease jobs", drain: true } };
    }
    const running = Array.isArray(b?.running) ? (b!.running as unknown[]).filter(posInt).slice(0, 250) : [];
    const free = posInt(b?.free) || b?.free === 0 ? Math.min(b!.free as number, Math.max(0, h.slots - running.length)) : 0;
    await this.d.db.q(`update pnap_hosts set last_seen_at = now(), running = $2, updated_at = now() where host_id = $1`, [h.host_id, running.length]);

    // Outcomes of finished jobs (only this host's own leased jobs).
    const done = Array.isArray(b?.done) ? (b!.done as Record<string, unknown>[]).slice(0, 250) : [];
    for (const o of done) {
      if (!posInt(o?.jobId)) continue;
      const result = typeof o.result === "string" ? o.result.slice(0, 40) : "error";
      const timings = o.timings && typeof o.timings === "object" && JSON.stringify(o.timings).length < 4000 ? o.timings : null;
      const r = await this.d.db.q(`update pnap_jobs set state = $3, outcome = $4, timings = $5, detail = $6, slot = $7, finished_at = now()
                                     where job_id = $1 and host_id = $2 and state = 'leased' returning job_id`,
      [o.jobId, h.host_id, ["summary", "no-summary"].includes(result) ? "done" : "failed", result, timings,
        typeof o.detail === "string" ? o.detail.slice(0, 500) : null, Number.isInteger(o.slot) ? o.slot : null]);
      if (r.length) await this.d.db.q(`update pnap_hosts set last_job_at = now() where host_id = $1`, [h.host_id]);
    }
    // Leased here a while ago, neither running nor reported: the host lost it (restarted). Queued again if GitHub
    // still has it queued.
    const reported = new Set([...running, ...done.map((o) => o?.jobId).filter(posInt)]);
    const mine = await this.d.db.q<{ job_id: number; still_queued: boolean }>(
      `select j.job_id, (g.status = 'queued') as still_queued from pnap_jobs j join gh_jobs g using (job_id)
        where j.host_id = $1 and j.state = 'leased' and j.leased_at < now() - interval '2 minutes'`, [h.host_id]);
    for (const j of mine.filter((x) => !reported.has(x.job_id))) {
      await this.d.db.q(j.still_queued
        ? `update pnap_jobs set state = 'queued', host_id = null, leased_at = null, detail = 'lost by its host before it started' where job_id = $1`
        : `update pnap_jobs set state = 'failed', finished_at = now(), detail = 'lost by its host' where job_id = $1`, [j.job_id]);
    }

    const out: Record<string, unknown> = { jobs: [], drain: h.state === "draining" };
    if (scope.exp * 1000 - this.now() < (HOST_CREDENTIAL_SECONDS * 1000) / 2) out.credential = this.credential(h);
    if (h.state === "draining" || free <= 0) return { status: 200, body: out };

    // Take up to `free` queued jobs of THIS host's region (never another region's), then mint each one.
    // Oldest first (RETURNING does not keep the subquery's order, so the rows are sorted here).
    const ids = await this.d.db.tx(null, async (c) => (await c.query<{ job_id: number; queued_at: Date }>(
      `update pnap_jobs set state = 'leased', host_id = $3, leased_at = now(), attempts = attempts + 1
        where job_id in (select job_id from pnap_jobs where region = $1 and state = 'queued' order by queued_at, job_id limit $2 for update skip locked)
        returning job_id, queued_at`, [h.region, Math.min(free, MAX_MINT_PER_LEASE), h.host_id])).rows
      .sort((a, b) => +a.queued_at - +b.queued_at || a.job_id - b.job_id).map((r) => r.job_id));
    const jobs: LeasedJob[] = [];
    for (const jobId of ids) {
      let m: MintedJob | null;
      try {
        m = await this.d.service.mintJob(jobId);
      } catch (e) {
        await this.d.db.q(`update pnap_jobs set state = case when attempts >= $2 then 'failed' else 'queued' end, host_id = null, leased_at = null,
                             detail = $3 where job_id = $1`, [jobId, MAX_ATTEMPTS, `mint failed: ${(e as Error).message}`.slice(0, 500)]);
        this.d.log.error({ job: jobId, host: h.host_id, err: (e as Error).message }, "could not mint a leased job (queued again)");
        continue;
      }
      if (!m) {
        await this.d.db.q(`update pnap_jobs set state = 'cancelled', finished_at = now(), detail = 'no longer waiting for a runner' where job_id = $1`, [jobId]);
        continue;
      }
      await this.d.db.q(`update pnap_jobs set runner_name = $2, runner_id = $3 where job_id = $1`, [jobId, m.runnerName, m.runnerId]);
      const cache = this.d.s.cacheMode !== "off" && m.cacheToken ? { cacheToken: m.cacheToken, cacheOrg: m.cacheOrg } : {};
      jobs.push({
        jobId, runnerName: m.runnerName, repositoryId: m.repositoryId, runId: m.runId, runAttempt: m.runAttempt, jitConfig: m.jitConfig,
        summaryToken: m.summaryToken, cacheAccess: m.cacheAccess, ...cache, vcpus: this.d.s.vcpus, memMib: this.d.s.memMib,
      });
    }
    if (jobs.length) this.d.log.info({ host: h.host_id, region: h.region, jobs: jobs.map((j) => j.jobId) }, "jobs leased");
    out.jobs = jobs;
    return { status: 200, body: out };
  }
}

/** The public half of the cache signing key as the cache service reads it: {n: modulus hex, e: exponent}. */
export function publicKeyJson(key: KeyObject): { n: string; e: number } {
  const jwk = createPublicKey(key).export({ format: "jwk" });
  const e = Buffer.from(jwk.e!, "base64url");
  return { n: Buffer.from(jwk.n!, "base64url").toString("hex"), e: e.readUIntBE(0, e.length) };
}

export function registerHostRoutes(fastify: FastifyInstance, svc: HostsService): void {
  fastify.post("/v1/hosts/enrol", { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const r = await svc.enrol(req.headers.authorization);
    return reply.code(r.status).send(r.body);
  });
  fastify.post("/v1/hosts/lease", { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const r = await svc.lease(req.headers.authorization, req.body as Record<string, unknown> | undefined);
    return reply.code(r.status).send(r.body);
  });
}
