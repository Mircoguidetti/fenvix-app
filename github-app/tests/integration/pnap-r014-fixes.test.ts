// The R-014 fixes of the scaler and the lease beyond the reviewer's own cases (tests/integration/review-r014.test.ts):
// R5 a queued job follows its customer to the new region; R6 orphans are looked for in every location and a region
// that is no longer served gives up its cache server; R7 one silent busy host waits for the job limit, then goes, and
// a silent idle host is still released at once (only a fleet-wide silence holds everything).
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { HttpPnapApi } from "../../src/pnap/api.ts";
import { HostsService } from "../../src/pnap/hosts.ts";
import { signHostCredential } from "../../src/pnap/hostcred.ts";
import { PnapPlacement } from "../../src/pnap/placement.ts";
import { runScaler, type ScalerDeps } from "../../src/pnap/scaler.ts";
import { loadPnapSettings, type PnapSettings } from "../../src/pnap/settings.ts";
import { userData } from "../../src/pnap/userdata.ts";
import { FakePnap } from "../helpers/fake-pnap.ts";
import { ACCOUNT, CI_YAML, Harness, INSTALLATION_ID, installationCreated, makeOrg, REPOS, resetDb, workflowJob } from "../helpers/harness.ts";

const silent = { info() {}, warn() {}, error() {} };
const HOST_KEY = "host-signing-key-for-tests-0123456789abcdef";
const ENV = { PNAP_REGIONS: "ASH:0:3,NLD:0:2", PNAP_DEFAULT_REGION: "ASH", PNAP_CONTROL_URL: "https://github.fenvix.test", PNAP_FIRECRACKER_SHA256: "f".repeat(64), FENVIX_ENV: "rf", PNAP_IDLE_MINUTES: "20" };

describe("R-014 fixes: region at lease, every location, silent hosts one by one (Postgres, fake GitHub, fake phoenixNAP)", () => {
  const h = new Harness();
  const fake = new FakePnap();
  const { privateKey: cacheKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let admin: pg.Client;
  let s: PnapSettings;
  let api: HttpPnapApi;
  let deps: ScalerDeps;
  let hosts: HostsService;
  let clock: Date | null = null;

  const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await admin.query(sql, p)).rows as T[];
  const cred = (hostId: string, region: "ASH" | "NLD") =>
    `Bearer ${signHostCredential(HOST_KEY, { hostId, region, gen: 1, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const queue = async (jobId: number, runId: number) => {
    h.gh.addRun(REPOS.shop.full_name, runId, { event: "push", headSha: "d".repeat(40), headBranch: "main", message: "m" });
    await h.send("workflow_job", workflowJob("queued", { id: jobId, runId, sha: "d".repeat(40), branch: "main", repo: REPOS.shop }));
  };
  const readyHost = async (hostId: string, region: "ASH" | "NLD", extra = "", role = "runner") => {
    const srv = await api.createServer({ hostname: hostId, os: "ubuntu/noble", type: role === "cache" ? "s1.c1.small" : "d3.c1.large", location: region });
    fake.tick(); fake.tick();
    await admin.query(`insert into pnap_hosts (host_id, role, region, server_type, server_id, state, slots, enrolled_at, last_seen_at, provisioned_at, ordered_at, private_ip)
                       values ($1, $4, $2, 'd3.c1.large', $3, 'ready', 15, now(), now(), now(), now(), '10.0.0.9')`, [hostId, region, srv.id, role]);
    if (extra) await admin.query(`update pnap_hosts set ${extra} where host_id = $1`, [hostId]);
    return srv.id;
  };

  before(async () => {
    admin = await resetDb();
    await fake.start();
    s = loadPnapSettings(ENV);
    await h.start({ CACHE_SIGNING_KEY: cacheKey.export({ type: "pkcs8", format: "pem" }).toString() }, { placer: (db) => new PnapPlacement(db, s, silent) });
    const acme = await makeOrg(admin, "r014f-acme");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await h.app.service.linkInstallation(INSTALLATION_ID, acme.workspaceId, acme.userId);
    api = new HttpPnapApi({ clientId: fake.clientId, clientSecret: fake.clientSecret, bmcUrl: `${fake.url}/bmc/v1`, billingUrl: `${fake.url}/billing/v1`,
      tokenUrl: `${fake.url}/auth/realms/BMC/protocol/openid-connect/token` });
    deps = { db: h.app.db, api, s, log: silent, userData: (x) => userData(s, x), now: () => clock ?? new Date() };
    hosts = new HostsService({ db: h.app.db, service: h.app.service, s, log: silent, hostKeys: [HOST_KEY], cacheSigningKey: cacheKey });
  });
  beforeEach(async () => {
    clock = null;
    await admin.query("truncate pnap_jobs, pnap_hosts, pnap_region_holds cascade");
    await admin.query("update gh_installations set pnap_region = null where installation_id = $1", [INSTALLATION_ID]);
    for (const srv of fake.servers.values()) srv.status = "deleting";
    fake.tick();
  });
  after(async () => { await h.stop(); await fake.stop(); await admin.end(); });

  it("R5: the scaler moves a queued job to its installation's new region, where an NLD host then leases it", async () => {
    await queue(971, 99971);
    assert.equal((await q<{ region: string }>("select region from pnap_jobs where job_id = 971"))[0]!.region, "ASH");
    await admin.query("update gh_installations set pnap_region = 'NLD' where installation_id = $1", [INSTALLATION_ID]);
    const r = await runScaler(deps);
    assert.deepEqual(r.moved, [971]);
    assert.equal((await q<{ region: string }>("select region from pnap_jobs where job_id = 971"))[0]!.region, "NLD");
    assert.ok(r.actions.some((a) => a.kind === "order" && (a as { region: string }).region === "NLD"), "demand is counted in NLD now");
    assert.ok(!r.actions.some((a) => a.kind === "order" && (a as { region: string }).region === "ASH"));
    await readyHost("fx-rf-nld-h000071", "NLD");
    const l = await hosts.lease(cred("fx-rf-nld-h000071", "NLD"), { free: 15, running: [], done: [] });
    assert.deepEqual((l.body.jobs as { jobId: number }[]).map((j) => j.jobId), [971]);
  });

  it("R5: a job whose installation now has a region no host serves is neither leased nor moved", async () => {
    await queue(972, 99972);
    await admin.query("update gh_installations set pnap_region = 'SEA' where installation_id = $1", [INSTALLATION_ID]);
    const r = await runScaler(deps);
    assert.deepEqual(r.moved, []);
    await readyHost("fx-rf-ash-h000072", "ASH");
    const l = await hosts.lease(cred("fx-rf-ash-h000072", "ASH"), { free: 15, running: [], done: [] });
    assert.deepEqual(l.body.jobs, []);
  });

  it("R6: a server with our prefix in a location that is not configured is still found and released", async () => {
    const orphan = await api.createServer({ hostname: "fx-rf-sea-horphan", os: "ubuntu/noble", type: "d3.c1.large", location: "SEA" });
    const r = await runScaler(deps);
    assert.ok(r.orphans.includes(orphan.id));
    assert.equal(fake.servers.get(orphan.id)?.status, "deleting");
  });

  it("R6: a region no longer served gives up its dedicated cache server once its job hosts are gone", async () => {
    const ded = loadPnapSettings({ ...ENV, PNAP_REGIONS: "ASH:0:3", PNAP_CACHE_MODE: "dedicated" });
    const cacheSrv = await readyHost("fx-rf-nld-c000073", "NLD", "", "cache");
    const r = await runScaler({ ...deps, s: ded, userData: (x) => userData(ded, x, { n: "ab".repeat(256), e: 65537 }) });
    assert.ok(r.actions.some((a) => a.kind === "release" && a.hostId === "fx-rf-nld-c000073"), JSON.stringify(r.actions));
    assert.ok(!r.actions.some((a) => a.kind === "order" && (a as { region: string }).region === "NLD"), "no new cache server there");
    assert.equal(fake.servers.get(cacheSrv)?.status, "deleting");
  });

  it("R7: one silent host with a running job is kept (alert) until the job limit, then released", async () => {
    await queue(974, 99974);
    const a = await readyHost("fx-rf-ash-h000074", "ASH");
    const b = await readyHost("fx-rf-ash-h000075", "ASH");
    await readyHost("fx-rf-ash-h000076", "ASH");
    assert.deepEqual(((await hosts.lease(cred("fx-rf-ash-h000074", "ASH"), { free: 1, running: [], done: [] })).body.jobs as { jobId: number }[]).map((j) => j.jobId), [974]);
    await admin.query("update pnap_hosts set running = 1, last_seen_at = now() - interval '6 minutes' where host_id = 'fx-rf-ash-h000074'");
    const r = await runScaler(deps);
    assert.equal(fake.servers.get(a)?.status, "powered-on", "kept: its customer's job may still run");
    assert.ok(r.alerts.some((x) => x.includes("fx-rf-ash-h000074")), JSON.stringify(r.alerts));
    // Past the job time limit (+15 min), the host is released, and its job closed.
    clock = new Date(Date.now() + (s.jobTimeoutMinutes + 16) * 60_000);
    await admin.query("update pnap_hosts set last_seen_at = $1 where host_id <> 'fx-rf-ash-h000074'", [clock]);
    await runScaler(deps);
    assert.equal(fake.servers.get(a)?.status, "deleting");
    assert.equal(fake.servers.get(b)?.status, "powered-on");
  });

  it("R7: a silent idle host is still released at once; a fleet-wide silence holds even idle hosts", async () => {
    const a = await readyHost("fx-rf-ash-h000077", "ASH", "last_seen_at = now() - interval '6 minutes'");
    await readyHost("fx-rf-ash-h000078", "ASH");
    await readyHost("fx-rf-nld-h000079", "NLD");
    await runScaler(deps);
    assert.equal(fake.servers.get(a)?.status, "deleting", "one of three, idle: released");
    await admin.query("update pnap_hosts set last_seen_at = now() - interval '6 minutes' where state = 'ready'");
    const r = await runScaler(deps);
    assert.equal((await q("select 1 from pnap_hosts where state = 'ready'")).length, 2, "two of two silent: nothing released");
    assert.ok(r.alerts.some((x) => /2 of 2 job hosts went silent at once/.test(x)), JSON.stringify(r.alerts));
  });
});
