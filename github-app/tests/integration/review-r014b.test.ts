// Review R-014b (docs/REVIEW-R-014b.md): failing tests for defects introduced by the fixes of review R-014.
// On claude/customer-mode-pnap at 854aa44 each test fails for the reason named in its message.
//
// N1 (R5 fix): the lease now refuses a queued job whose installation is in another region, and the scaler moves such
// a job only when the new region is served. A job that can be neither moved nor leased stays `queued` in its old
// region, and the scaler still counts it as that region's demand: it orders (and keeps) job hosts that no job will
// ever use, until GitHub gives up on the job (24 hours).
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
const ENV = { PNAP_REGIONS: "ASH:0:3,NLD:0:2", PNAP_DEFAULT_REGION: "ASH", PNAP_CONTROL_URL: "https://github.fenvix.test", PNAP_FIRECRACKER_SHA256: "f".repeat(64), FENVIX_ENV: "rb", PNAP_IDLE_MINUTES: "20" };

describe("review R-014b: regressions of the R-014 fixes (Postgres, fake GitHub, fake phoenixNAP)", () => {
  const h = new Harness();
  const fake = new FakePnap();
  const { privateKey: cacheKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let admin: pg.Client;
  let s: PnapSettings;
  let api: HttpPnapApi;
  let deps: ScalerDeps;
  let hosts: HostsService;

  const cred = (hostId: string, region: "ASH" | "NLD") =>
    `Bearer ${signHostCredential(HOST_KEY, { hostId, region, gen: 1, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const queue = async (jobId: number, runId: number) => {
    h.gh.addRun(REPOS.shop.full_name, runId, { event: "push", headSha: "e".repeat(40), headBranch: "main", message: "m" });
    await h.send("workflow_job", workflowJob("queued", { id: jobId, runId, sha: "e".repeat(40), branch: "main", repo: REPOS.shop }));
  };
  const orders = (r: Awaited<ReturnType<typeof runScaler>>, region: string) =>
    r.actions.filter((a) => a.kind === "order" && (a as { region: string }).region === region);

  before(async () => {
    admin = await resetDb();
    await fake.start();
    s = loadPnapSettings(ENV);
    await h.start({ CACHE_SIGNING_KEY: cacheKey.export({ type: "pkcs8", format: "pem" }).toString() }, { placer: (db) => new PnapPlacement(db, s, silent) });
    const acme = await makeOrg(admin, "r014b-acme");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await h.app.service.linkInstallation(INSTALLATION_ID, acme.workspaceId, acme.userId);
    api = new HttpPnapApi({ clientId: fake.clientId, clientSecret: fake.clientSecret, bmcUrl: `${fake.url}/bmc/v1`, billingUrl: `${fake.url}/billing/v1`,
      tokenUrl: `${fake.url}/auth/realms/BMC/protocol/openid-connect/token` });
    deps = { db: h.app.db, api, s, log: silent, userData: (x) => userData(s, x) };
    hosts = new HostsService({ db: h.app.db, service: h.app.service, s, log: silent, hostKeys: [HOST_KEY], cacheSigningKey: cacheKey });
  });
  beforeEach(async () => {
    await admin.query("truncate pnap_jobs, pnap_hosts, pnap_region_holds cascade");
    await admin.query("update gh_installations set pnap_region = null where installation_id = $1", [INSTALLATION_ID]);
    for (const srv of fake.servers.values()) srv.status = "deleting";
    fake.tick();
  });
  after(async () => { await h.stop(); await fake.stop(); await admin.end(); });

  it("N1 cost: a queued job that no host may lease (its customer moved to a region with no hosts) orders no job host", async () => {
    await queue(981, 99981);
    assert.equal((await admin.query("select region from pnap_jobs where job_id = 981")).rows[0]?.region, "ASH");
    // The founder sets this customer to SEA, which has no hosts (not in PNAP_REGIONS). hosts.ts now refuses the job
    // in ASH (R5 fix), and the scaler does not move it (SEA is not served): nothing can ever run it.
    await admin.query("update gh_installations set pnap_region = 'SEA' where installation_id = $1", [INSTALLATION_ID]);
    const r = await runScaler(deps);
    assert.deepEqual(r.moved, []);
    assert.deepEqual(orders(r, "ASH"), [],
      `the scaler rents an ASH host ($1.27/h) for a job no ASH host may lease: ${JSON.stringify(r.actions)}`);
  });

  it("N1 cost: the same when the default region is removed after a job was placed there", async () => {
    await queue(982, 99982);
    // Placed in ASH by PNAP_DEFAULT_REGION (the installation has no region of its own). Then the default is removed.
    const noDefault = loadPnapSettings({ ...ENV, PNAP_DEFAULT_REGION: "" });
    const d2: ScalerDeps = { ...deps, s: noDefault, userData: (x) => userData(noDefault, x) };
    const r = await runScaler(d2);
    // Proof that no host would take it: a ready ASH host leases nothing.
    const srv = await api.createServer({ hostname: "fx-rb-ash-h000082", os: "ubuntu/noble", type: "d3.c1.large", location: "ASH" });
    fake.tick(); fake.tick();
    await admin.query(`insert into pnap_hosts (host_id, role, region, server_type, server_id, state, slots, enrolled_at, last_seen_at, provisioned_at, ordered_at)
                       values ('fx-rb-ash-h000082', 'runner', 'ASH', 'd3.c1.large', $1, 'ready', 15, now(), now(), now(), now())`, [srv.id]);
    const h2 = new HostsService({ db: h.app.db, service: h.app.service, s: noDefault, log: silent, hostKeys: [HOST_KEY], cacheSigningKey: cacheKey });
    const l = await h2.lease(cred("fx-rb-ash-h000082", "ASH"), { free: 15, running: [], done: [] });
    assert.deepEqual(l.body.jobs, [], "the lease refuses the job (as the R5 fix intends)");
    assert.deepEqual(orders(r, "ASH"), [],
      `the scaler rents an ASH host for a job no ASH host may lease: ${JSON.stringify(r.actions)}`);
  });

  it("N1 cost: an idle host is not kept up by a job it may not lease", async () => {
    // An idle ASH host, enrolled 2 h ago, 55 min into its paid hour: the scaler drains it (min 0, no demand).
    const srv = await api.createServer({ hostname: "fx-rb-ash-h000083", os: "ubuntu/noble", type: "d3.c1.large", location: "ASH" });
    fake.tick(); fake.tick();
    await admin.query(`insert into pnap_hosts (host_id, role, region, server_type, server_id, state, slots, enrolled_at, last_seen_at, provisioned_at, ordered_at)
                       values ('fx-rb-ash-h000083', 'runner', 'ASH', 'd3.c1.large', $1, 'ready', 15, now() - interval '2 hours', now(),
                               now() - interval '115 minutes', now() - interval '2 hours')`, [srv.id]);
    await queue(983, 99983);
    await admin.query("update gh_installations set pnap_region = 'SEA' where installation_id = $1", [INSTALLATION_ID]);
    const l = await hosts.lease(cred("fx-rb-ash-h000083", "ASH"), { free: 15, running: [], done: [] });
    assert.deepEqual(l.body.jobs, [], "the lease refuses the job (as the R5 fix intends)");
    const r = await runScaler(deps);
    assert.ok(r.actions.some((a) => a.kind === "drain" && a.hostId === "fx-rb-ash-h000083"),
      `an idle host is kept (and paid for) because of a job it may not lease: ${JSON.stringify(r.actions)}`);
  });
});
