import { randomBytes } from "node:crypto";
import type { Db } from "../db.ts";
import type { Logger } from "../service.ts";
import { NoCapacity, PNAP_LOCATIONS, type PnapApi, type Region, type Server } from "./api.ts";
import { newEnrolSecret } from "./hostcred.ts";
import type { PnapSettings } from "./settings.ts";

/**
 * The scaler (a Lambda on a one-minute schedule, reserved concurrency 1). One region is one pool: it keeps the number
 * of job hosts of each region between its min and max, by demand (queued + leased jobs of that region, never another
 * region's), and releases idle hosts. The database is the record of what we rent; phoenixNAP's API is checked against
 * it every run, both ways (a server we forgot is released, a server phoenixNAP lost is closed).
 *
 * Regions: every configured region, and every region that still has a host (a region removed from the settings is
 * planned with min = max = 0, so its hosts drain and are released when idle; R-014 R6). Orphans are looked for in every
 * phoenixNAP location.
 *
 * Silent hosts (R-014 R7): a host that stopped calling is released only if that is about the host, not about us. When
 * several hosts go silent at once (half the fleet or more), the App's host route is the likely cause: nothing is
 * released, an alert is logged, and only the job time limit ends the wait. A silent host that last reported running
 * jobs, and whose server phoenixNAP reports powered on, is kept for the job time limit as well.
 *
 * Host states: ordering → provisioning (phoenixNAP accepted the order; the install runs) → ready (the agent enrolled)
 * → draining (no new jobs) → releasing → released; failed for an order phoenixNAP refused.
 */

export type HostState = "ordering" | "provisioning" | "ready" | "draining" | "releasing" | "released" | "failed";

export interface HostView {
  hostId: string;
  role: "runner" | "cache";
  state: HostState;
  running: number;
  leased: number;
  orderedAt: Date;
  provisionedAt: Date | null;
  enrolledAt: Date | null;
  lastSeenAt: Date | null;
  lastJobAt: Date | null;
  drainRequestedAt: Date | null;
  detail: string | null;
}

export interface RegionView {
  region: Region;
  min: number;
  max: number;
  /** A floor of hosts until a time (the first real test). */
  hold: number;
  /** Queued + leased jobs of this region. */
  demand: number;
  hosts: HostView[];
  /** The last "no capacity" answer for this region. */
  lastNoCapacityAt: Date | null;
}

export type Action =
  | { kind: "order"; region: Region; role: "runner" | "cache" }
  | { kind: "drain"; hostId: string; why: string }
  | { kind: "undrain"; hostId: string }
  | { kind: "release"; hostId: string; why: string };

const LIVE: HostState[] = ["ordering", "provisioning", "ready"];
const minutes = (a: Date, b: Date) => (a.getTime() - b.getTime()) / 60_000;

/** Minutes into the current billed hour of a server (hourly billing from provisioning). */
export function minutesIntoHour(since: Date, now: Date): number {
  const m = minutes(now, since);
  return m < 0 ? 0 : m % 60;
}

/**
 * Pure: what to do in one region now. `liveTotal` is the number of live job hosts in all regions (the global cap).
 */
export function planRegion(v: RegionView, s: PnapSettings, now: Date, liveTotal: number): Action[] {
  const out: Action[] = [];
  const runners = v.hosts.filter((h) => h.role === "runner");
  const live = runners.filter((h) => LIVE.includes(h.state));
  const floor = Math.max(v.min, v.hold);
  const need = Math.ceil(v.demand / s.slotsPerHost);
  const desired = Math.min(v.max, Math.max(need, floor));

  if (desired > live.length) {
    let missing = desired - live.length;
    // A draining host still has its install and its warm disk: take it back before ordering a new one.
    for (const h of runners.filter((x) => x.state === "draining").sort((a, b) => +(b.drainRequestedAt ?? 0) - +(a.drainRequestedAt ?? 0))) {
      if (!missing) break;
      out.push({ kind: "undrain", hostId: h.hostId });
      missing--;
    }
    const backoff = v.lastNoCapacityAt && minutes(now, v.lastNoCapacityAt) < s.noCapacityBackoffMinutes;
    const room = Math.max(0, s.maxHostsTotal - liveTotal);
    const orders = backoff ? 0 : Math.min(missing, s.maxOrdersPerRun, room);
    for (let i = 0; i < orders; i++) out.push({ kind: "order", region: v.region, role: "runner" });
  } else if (desired < live.length) {
    // Only hosts with nothing running or leased, idle long enough; with hourly billing, only near the end of the hour
    // already paid for (keeping the host until then costs nothing and may serve another job).
    const idle = live
      .filter((h) => h.state === "ready" && h.running === 0 && h.leased === 0)
      .filter((h) => minutes(now, h.lastJobAt ?? h.enrolledAt ?? h.orderedAt) >= s.idleMinutes)
      .filter((h) => !s.hourAware || minutesIntoHour(h.provisionedAt ?? h.orderedAt, now) >= 60 - s.releaseWindowMinutes)
      .sort((a, b) => minutesIntoHour(b.provisionedAt ?? b.orderedAt, now) - minutesIntoHour(a.provisionedAt ?? a.orderedAt, now));
    for (const h of idle.slice(0, live.length - desired)) out.push({ kind: "drain", hostId: h.hostId, why: `idle ${s.idleMinutes}+ min` });
  }
  // A drained host (nothing running, nothing leased) is released.
  for (const h of runners.filter((x) => x.state === "draining" && x.running === 0 && x.leased === 0)) {
    if (!out.some((a) => a.kind === "undrain" && a.hostId === h.hostId)) out.push({ kind: "release", hostId: h.hostId, why: "drained" });
  }
  // The region's cache server (dedicated mode): one while the region has job hosts or wants one. A region that wants
  // no host at all (max 0, e.g. removed from the settings) releases its cache server once its job hosts are gone.
  if (v.max === 0 && !runners.some((h) => LIVE.includes(h.state) || h.state === "draining")) {
    for (const c of v.hosts.filter((h) => h.role === "cache" && LIVE.includes(h.state))) out.push({ kind: "release", hostId: c.hostId, why: "region not served" });
  }
  if (s.cacheMode === "dedicated" && v.max > 0 && (live.length > 0 || desired > 0)
    && !v.hosts.some((h) => h.role === "cache" && LIVE.includes(h.state))
    && !(v.lastNoCapacityAt && minutes(now, v.lastNoCapacityAt) < s.noCapacityBackoffMinutes)) {
    out.push({ kind: "order", region: v.region, role: "cache" });
  }
  return out;
}

export interface ScalerDeps {
  db: Db;
  api: PnapApi;
  s: PnapSettings;
  log: Logger;
  /** The cloud-init user data of a new server (userdata.ts). */
  userData: (h: { hostId: string; role: "runner" | "cache"; region: Region; enrolToken: string }) => string;
  now?: () => Date;
}

export interface ScalerReport {
  actions: (Action & { result: string })[];
  reconciled: { hostId: string; from: HostState; to: HostState; why: string }[];
  orphans: string[];
  requeued: number[];
  /** Queued jobs moved to their installation's current region (R-014 R5). */
  moved: number[];
  /** What a person should look at (logged as errors too). */
  alerts: string[];
}

interface HostRow {
  host_id: string; role: "runner" | "cache"; region: Region; server_id: string | null; state: HostState; running: number; leased: number;
  ordered_at: Date; provisioned_at: Date | null; enrolled_at: Date | null; last_seen_at: Date | null; last_job_at: Date | null;
  drain_requested_at: Date | null; detail: string | null; updated_at: Date;
}

export const hostPrefix = (s: PnapSettings) => `fx-${s.env}-`;

export async function runScaler(d: ScalerDeps): Promise<ScalerReport> {
  const now = (d.now ?? (() => new Date()))();
  const rep: ScalerReport = { actions: [], reconciled: [], orphans: [], requeued: [], moved: [], alerts: [] };

  const move = async (h: HostRow, to: HostState, why: string, extra = "") => {
    await d.db.q(`update pnap_hosts set state = $2, detail = $3, updated_at = now()${extra} where host_id = $1`, [h.host_id, to, why]);
    rep.reconciled.push({ hostId: h.host_id, from: h.state, to, why });
    d.log.info({ host: h.host_id, from: h.state, to, why }, "host state");
    h.state = to;
  };

  // 1. What phoenixNAP says about each server we rent.
  const hosts = await loadHosts(d.db);
  const silent: { h: HostRow; srv: Server }[] = [];
  for (const h of hosts) {
    if (h.state === "ordering") {
      // The order call itself never finished (a crash between our insert and phoenixNAP's answer): the orphan check
      // below finds the server, if one exists.
      if (minutes(now, h.ordered_at) > 10) await move(h, "failed", "order never confirmed");
      continue;
    }
    if (!h.server_id || !["provisioning", "ready", "draining"].includes(h.state)) continue;
    let srv: Server | null;
    try { srv = await d.api.getServer(h.server_id); } catch (e) {
      d.log.warn({ host: h.host_id, err: (e as Error).message }, "phoenixNAP: could not read the server");
      continue;
    }
    if (!srv) { await move(h, "released", "phoenixNAP no longer knows this server", ", released_at = now()"); continue; }
    if (srv.status === "error") { await move(h, "releasing", "phoenixNAP reports status error"); continue; }
    if (h.state === "provisioning") {
      if (srv.status === "powered-on" && !h.provisioned_at) {
        await d.db.q(`update pnap_hosts set provisioned_at = coalesce($2::timestamptz, now()), public_ip = $3, private_ip = $4, updated_at = now() where host_id = $1`,
          [h.host_id, srv.provisionedOn ?? null, srv.publicIpAddresses?.[0] ?? null, srv.privateIpAddresses?.[0] ?? null]);
        h.provisioned_at = srv.provisionedOn ? new Date(srv.provisionedOn) : now;
      }
      // A cache server has no agent: it is ready when it is on and has its private address.
      if (h.role === "cache" && srv.status === "powered-on" && srv.privateIpAddresses?.[0]) {
        await move(h, "ready", "powered on", ", enrolled_at = now(), last_seen_at = now()");
      } else if (h.role === "runner" && minutes(now, h.ordered_at) > d.s.provisionTimeoutMinutes) {
        await move(h, "releasing", `no enrolment within ${d.s.provisionTimeoutMinutes} min of the order`);
      }
    } else if (h.role === "runner" && h.state !== "draining" && h.last_seen_at && (now.getTime() - h.last_seen_at.getTime()) / 1000 > d.s.heartbeatTimeoutSeconds) {
      silent.push({ h, srv });
    } else if (h.state === "draining" && h.drain_requested_at && minutes(now, h.drain_requested_at) > d.s.jobTimeoutMinutes + 15) {
      await move(h, "releasing", "still busy after the job time limit");
    }
  }

  // 1b. Silent hosts (R-014 R7): released one by one when the silence is about the host; never the fleet at once.
  const readyRunners = hosts.filter((h) => h.role === "runner" && h.state === "ready").length;
  const mass = silent.length >= 2 && silent.length * 2 >= readyRunners;
  const patience = d.s.jobTimeoutMinutes + 15;
  if (mass) {
    const msg = `${silent.length} of ${readyRunners} job hosts went silent at once: the App's host route (the hosts function, API Gateway, the domain) is the likely cause; no host is released for ${patience} min`;
    rep.alerts.push(msg);
    d.log.error({ hosts: silent.map((x) => x.h.host_id) }, `ALERT: ${msg}`);
  }
  for (const { h, srv } of silent) {
    const quiet = minutes(now, h.last_seen_at!);
    // Busy: the host itself last reported jobs running. A job leased but never reported running probably never
    // started: it is queued again (step 2) when GitHub still has it queued.
    const busy = h.running > 0;
    if (quiet < patience && (mass || (busy && srv.status === "powered-on"))) {
      if (!mass) {
        const msg = `${h.host_id} is silent for ${Math.round(quiet)} min with ${h.running} running job(s) and powered on: kept until ${patience} min`;
        rep.alerts.push(msg);
        d.log.warn({ host: h.host_id }, msg);
      }
      continue;
    }
    await move(h, "releasing", `silent for ${Math.round(quiet * 60)} s${busy ? " with jobs" : ""}`);
  }

  // 2. Jobs leased to a host that is gone: queued again if GitHub still has them queued, closed otherwise.
  const lost = await d.db.q<{ job_id: number; still_queued: boolean }>(
    `select j.job_id, (g.status = 'queued') as still_queued from pnap_jobs j join gh_jobs g using (job_id) join pnap_hosts h on h.host_id = j.host_id
      where j.state = 'leased' and h.state not in ('ready', 'draining')`);
  for (const j of lost) {
    if (j.still_queued) {
      await d.db.q(`update pnap_jobs set state = 'queued', host_id = null, slot = null, leased_at = null, detail = 'host lost before the job started' where job_id = $1`, [j.job_id]);
      rep.requeued.push(j.job_id);
    } else {
      await d.db.q(`update pnap_jobs set state = 'failed', finished_at = now(), detail = 'host lost during the job' where job_id = $1`, [j.job_id]);
    }
  }

  // 2b. Queued jobs whose installation is now in another region (set-region after the job was placed, or placed in
  // the default region): moved to that region's queue, never leased where they were (R-014 R5; hosts.ts checks too).
  const served = PNAP_LOCATIONS.filter((r) => (d.s.regions[r]?.max ?? 0) > 0);
  const moved = await d.db.q<{ job_id: number }>(
    `update pnap_jobs j set region = coalesce(i.pnap_region, $1::text), detail = 'moved to its installation''s current region'
       from gh_installations i
      where i.installation_id = j.installation_id and j.state = 'queued'
        and coalesce(i.pnap_region, $1::text) <> j.region and coalesce(i.pnap_region, $1::text) = any($2::text[])
      returning j.job_id`, [d.s.defaultRegion, served]);
  rep.moved.push(...moved.map((m) => m.job_id));

  // 3. Servers phoenixNAP has with our prefix that the database does not count as rented: released. Every location
  // is listed, not only the configured ones (a region removed from the settings may still hold our servers).
  const known = new Map(hosts.filter((h) => h.server_id).map((h) => [h.server_id!, h]));
  const ordering = new Set(hosts.filter((h) => h.state === "ordering").map((h) => h.host_id));
  for (const region of PNAP_LOCATIONS) {
    let servers: Server[] = [];
    try { servers = await d.api.listServers(region); } catch (e) {
      d.log.warn({ region, err: (e as Error).message }, "phoenixNAP: could not list servers");
      continue;
    }
    for (const srv of servers) {
      if (!srv.hostname.startsWith(hostPrefix(d.s)) || ordering.has(srv.hostname) || srv.status === "deleting") continue;
      const h = known.get(srv.id);
      if (h && h.state !== "released" && h.state !== "failed") continue;
      try {
        await d.api.deprovision(srv.id);
        rep.orphans.push(srv.id);
        d.log.warn({ server: srv.id, hostname: srv.hostname }, "released a server the database does not count as rented");
      } catch (e) { d.log.error({ server: srv.id, err: (e as Error).message }, "could not release an orphan server"); }
    }
  }

  // 4. Plan each region and act.
  const fresh = await loadHosts(d.db);
  const liveTotal = () => fresh.filter((h) => h.role === "runner" && LIVE.includes(h.state)).length;
  const demand = await d.db.q<{ region: string; n: number }>(`select region, count(*)::int as n from pnap_jobs where state in ('queued', 'leased') group by region`);
  const holds = await d.db.q<{ region: string; hosts: number }>(`select region, hosts from pnap_region_holds where until > $1`, [now]);
  const noCap = await d.db.q<{ region: string; at: Date }>(
    `select region, max(updated_at) as at from pnap_hosts where state = 'failed' and detail like 'no capacity%' group by region`);
  // Every configured region, and every region that still has a host (unconfigured: min = max = 0, R-014 R6).
  const regions = PNAP_LOCATIONS.filter((r) => d.s.regions[r] || fresh.some((h) => h.region === r));
  for (const region of regions) {
    const lim = d.s.regions[region] ?? { min: 0, max: 0 };
    const view: RegionView = {
      region, min: lim.min, max: lim.max,
      hold: Math.min(lim.max, holds.find((x) => x.region === region)?.hosts ?? 0),
      demand: demand.find((x) => x.region === region)?.n ?? 0,
      hosts: fresh.filter((h) => h.region === region).map(toView),
      lastNoCapacityAt: noCap.find((x) => x.region === region)?.at ?? null,
    };
    for (const a of planRegion(view, d.s, now, liveTotal())) {
      const result = await act(d, a, now, fresh);
      rep.actions.push({ ...a, result });
    }
  }

  // 5. Everything marked releasing: released at phoenixNAP.
  for (const h of await loadHosts(d.db)) {
    if (h.state !== "releasing") continue;
    try {
      if (h.server_id) await d.api.deprovision(h.server_id);
      await d.db.q(`update pnap_hosts set state = 'released', released_at = now(), cred_gen = cred_gen + 1, updated_at = now() where host_id = $1`, [h.host_id]);
      rep.reconciled.push({ hostId: h.host_id, from: "releasing", to: "released", why: h.detail ?? "" });
    } catch (e) { d.log.error({ host: h.host_id, err: (e as Error).message }, "could not release the server (tried again next run)"); }
  }
  return rep;
}

function toView(h: HostRow): HostView {
  return {
    hostId: h.host_id, role: h.role, state: h.state, running: h.running, leased: h.leased, orderedAt: h.ordered_at,
    provisionedAt: h.provisioned_at, enrolledAt: h.enrolled_at, lastSeenAt: h.last_seen_at, lastJobAt: h.last_job_at,
    drainRequestedAt: h.drain_requested_at, detail: h.detail,
  };
}

async function loadHosts(db: Db): Promise<HostRow[]> {
  return db.q<HostRow>(`select h.*, (select count(*)::int from pnap_jobs j where j.host_id = h.host_id and j.state = 'leased') as leased
                          from pnap_hosts h where h.state not in ('released', 'failed') order by h.ordered_at`);
}

async function act(d: ScalerDeps, a: Action, now: Date, fresh: HostRow[]): Promise<string> {
  if (a.kind === "drain") {
    // Only if still idle (the agent may have leased a job since the plan was made).
    const r = await d.db.q(`update pnap_hosts h set state = 'draining', drain_requested_at = now(), detail = $2, updated_at = now()
                             where host_id = $1 and state = 'ready' and not exists (select 1 from pnap_jobs j where j.host_id = h.host_id and j.state = 'leased')
                             returning host_id`, [a.hostId, a.why]);
    return r.length ? "draining" : "busy again";
  }
  if (a.kind === "undrain") {
    await d.db.q(`update pnap_hosts set state = 'ready', drain_requested_at = null, detail = 'demand again', updated_at = now() where host_id = $1 and state = 'draining'`, [a.hostId]);
    return "ready";
  }
  if (a.kind === "release") {
    await d.db.q(`update pnap_hosts set state = 'releasing', detail = $2, updated_at = now()
                   where host_id = $1 and ((state = 'draining' and running = 0) or (role = 'cache' and state in ('provisioning', 'ready')))`, [a.hostId, a.why]);
    return "releasing";
  }
  // order
  const hostId = `${hostPrefix(d.s)}${a.region.toLowerCase()}-${a.role === "cache" ? "c" : "h"}${randomBytes(3).toString("hex")}`;
  const serverType = a.role === "cache" ? d.s.cacheServerType : d.s.serverType;
  const enrol = newEnrolSecret(hostId);
  await d.db.q(`insert into pnap_hosts (host_id, role, region, server_type, pricing_model, state, slots, enrol_sha256)
                values ($1, $2, $3, $4, $5, 'ordering', $6, $7)`,
  [hostId, a.role, a.region, serverType, d.s.pricingModel, a.role === "runner" ? d.s.slotsPerHost : 0, a.role === "runner" ? enrol.sha256 : null]);
  try {
    const srv = await d.api.createServer({
      hostname: hostId,
      description: `fenvix ${d.s.env} ${a.role} ${a.region}`,
      os: d.s.os, type: serverType, location: a.region, pricingModel: d.s.pricingModel,
      networkType: "PUBLIC_AND_PRIVATE",
      installDefaultSshKeys: d.s.installDefaultSshKeys,
      ...(d.s.sshKeyIds.length ? { sshKeyIds: d.s.sshKeyIds } : {}),
      osConfiguration: { cloudInit: { userData: Buffer.from(d.userData({ hostId, role: a.role, region: a.region, enrolToken: enrol.token })).toString("base64") } },
    });
    await d.db.q(`update pnap_hosts set server_id = $2, state = 'provisioning', updated_at = now() where host_id = $1`, [hostId, srv.id]);
    fresh.push({ host_id: hostId, role: a.role, region: a.region, server_id: srv.id, state: "provisioning", running: 0, leased: 0, ordered_at: now,
      provisioned_at: null, enrolled_at: null, last_seen_at: null, last_job_at: null, drain_requested_at: null, detail: null, updated_at: now });
    d.log.info({ host: hostId, server: srv.id, region: a.region, role: a.role, type: serverType }, "server ordered");
    return `ordered ${srv.id}`;
  } catch (e) {
    const why = e instanceof NoCapacity ? `no capacity: ${e.message}` : `order refused: ${(e as Error).message}`;
    await d.db.q(`update pnap_hosts set state = 'failed', detail = $2, enrol_sha256 = null, updated_at = now() where host_id = $1`, [hostId, why.slice(0, 500)]);
    d.log.error({ host: hostId, region: a.region, err: why }, "server order failed");
    return why;
  }
}

/** Manual actions (the first real test, operations): hold a floor of hosts for a while, release a region, status. */
export async function hold(db: Db, region: Region, hosts: number, minutesFromNow: number, reason: string): Promise<void> {
  await db.q(`insert into pnap_region_holds (region, hosts, until, reason) values ($1, $2, now() + make_interval(mins => $3), $4)
              on conflict (region) do update set hosts = excluded.hosts, until = excluded.until, reason = excluded.reason`, [region, hosts, minutesFromNow, reason]);
}

export async function releaseRegion(db: Db, region: Region): Promise<number> {
  await db.q(`delete from pnap_region_holds where region = $1`, [region]);
  const r = await db.q(`update pnap_hosts set state = case when state = 'ready' then 'draining' else 'releasing' end,
                          drain_requested_at = coalesce(drain_requested_at, now()), detail = 'released by hand', updated_at = now()
                        where region = $1 and state in ('ordering', 'provisioning', 'ready') returning host_id`, [region]);
  return r.length;
}

export async function status(db: Db): Promise<{ hosts: Record<string, unknown>[]; jobs: Record<string, unknown>[] }> {
  const hosts = await db.q(`select host_id, role, region, server_id, state, slots, running, ordered_at, provisioned_at, enrolled_at, last_seen_at,
                                   released_at, detail from pnap_hosts where state not in ('released', 'failed') or updated_at > now() - interval '1 day' order by ordered_at`);
  const jobs = await db.q(`select job_id, region, installation_id, state, host_id, slot, runner_name, queued_at, leased_at, finished_at, outcome, timings, detail
                             from pnap_jobs where queued_at > now() - interval '1 day' order by queued_at`);
  return { hosts, jobs };
}
