// Review R-014 (docs/REVIEW-R-014.md): failing tests for the control-plane defects of customer mode on phoenixNAP.
// Each test states what must hold; on claude/customer-mode-pnap at b7686fd each one fails for the reason named.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";
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
// ASH is the default region: an installation without a region is placed there (PNAP_DEFAULT_REGION).
const ENV = { PNAP_REGIONS: "ASH:0:3,NLD:0:2", PNAP_DEFAULT_REGION: "ASH", PNAP_CONTROL_URL: "https://github.fenvix.test", PNAP_FIRECRACKER_SHA256: "f".repeat(64), FENVIX_ENV: "rv", PNAP_IDLE_MINUTES: "20" };

describe("review R-014: residency, cost leaks and busy hosts (Postgres, fake GitHub, fake phoenixNAP)", () => {
  const h = new Harness();
  const fake = new FakePnap();
  const { privateKey: cacheKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let admin: pg.Client;
  let s: PnapSettings;
  let api: HttpPnapApi;
  let deps: ScalerDeps;
  let hosts: HostsService;

  const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await admin.query(sql, p)).rows as T[];
  const cred = (hostId: string, region: "ASH" | "NLD") =>
    `Bearer ${signHostCredential(HOST_KEY, { hostId, region, gen: 1, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const queue = async (jobId: number, runId: number) => {
    h.gh.addRun(REPOS.shop.full_name, runId, { event: "push", headSha: "c".repeat(40), headBranch: "main", message: "m" });
    await h.send("workflow_job", workflowJob("queued", { id: jobId, runId, sha: "c".repeat(40), branch: "main", repo: REPOS.shop }));
  };
  /** A ready job host rented at phoenixNAP (powered on), as the scaler and an enrolment would have left it. */
  const readyHost = async (hostId: string, region: "ASH" | "NLD", extra = "") => {
    const srv = await api.createServer({ hostname: hostId, os: "ubuntu/noble", type: "d3.c1.large", location: region });
    fake.tick(); fake.tick();
    await admin.query(`insert into pnap_hosts (host_id, role, region, server_type, server_id, state, slots, enrolled_at, last_seen_at, provisioned_at, ordered_at)
                       values ($1, 'runner', $2, 'd3.c1.large', $3, 'ready', 28, now(), now(), now(), now())`, [hostId, region, srv.id]);
    if (extra) await admin.query(`update pnap_hosts set ${extra} where host_id = $1`, [hostId]);
    return srv.id;
  };

  before(async () => {
    admin = await resetDb();
    await admin.query("truncate pnap_jobs, pnap_hosts, pnap_region_holds cascade");
    await fake.start();
    s = loadPnapSettings(ENV);
    await h.start({ CACHE_SIGNING_KEY: cacheKey.export({ type: "pkcs8", format: "pem" }).toString() }, { placer: (db) => new PnapPlacement(db, s, silent) });
    const acme = await makeOrg(admin, "r014-acme");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await h.app.service.linkInstallation(INSTALLATION_ID, acme.workspaceId, acme.userId);
    api = new HttpPnapApi({ clientId: fake.clientId, clientSecret: fake.clientSecret, bmcUrl: `${fake.url}/bmc/v1`, billingUrl: `${fake.url}/billing/v1`,
      tokenUrl: `${fake.url}/auth/realms/BMC/protocol/openid-connect/token` });
    deps = { db: h.app.db, api, s, log: silent, userData: (x) => userData(s, x) };
    hosts = new HostsService({ db: h.app.db, service: h.app.service, s, log: silent, hostKeys: [HOST_KEY], cacheSigningKey: cacheKey });
  });
  after(async () => { await h.stop(); await fake.stop(); await admin.end(); });

  it("R5 residency: a job queued before its installation was set to NLD is never leased by a US (ASH) host", async () => {
    // A new customer: the App is installed and the first push queues a job before the founder runs set-region.
    await queue(951, 99951);
    assert.equal((await q<{ region: string }>("select region from pnap_jobs where job_id = 951"))[0]!.region, "ASH", "placed in the default region");
    // The customer is European: set-region NLD (the scaler function's "set-region" action does exactly this update).
    await admin.query("update gh_installations set pnap_region = 'NLD' where installation_id = $1", [INSTALLATION_ID]);
    await readyHost("fx-rv-ash-h000001", "ASH");
    const r = await hosts.lease(cred("fx-rv-ash-h000001", "ASH"), { free: 28, running: [], done: [] });
    assert.equal(r.status, 200);
    assert.deepEqual((r.body.jobs as { jobId: number }[]).map((j) => j.jobId), [],
      "an ASH host was handed the job (just-in-time runner, cache token) of an installation whose region is now NLD");
  });

  it("R6 cost: a host of a region removed from PNAP_REGIONS is still drained and released when idle", async () => {
    await admin.query("update pnap_jobs set state = 'cancelled' where state in ('queued', 'leased')");
    // NLD served customers until the founder removed it from pnapRegions (e.g. after a test there).
    await readyHost("fx-rv-nld-h000002", "NLD",
      "enrolled_at = now() - interval '3 hours', last_job_at = now() - interval '3 hours', provisioned_at = now() - interval '175 minutes'");
    const ashOnly = loadPnapSettings({ ...ENV, PNAP_REGIONS: "ASH:0:3" });
    const d = { ...deps, s: ashOnly, userData: (x: Parameters<ScalerDeps["userData"]>[0]) => userData(ashOnly, x) };
    for (let i = 0; i < 3; i++) await runScaler(d);
    const [row] = await q<{ state: string }>("select state from pnap_hosts where host_id = 'fx-rv-nld-h000002'");
    assert.notEqual(row!.state, "ready", "an idle host outside the configured regions stays rented for ever ($1.27/h, about $927 a month)");
  });

  it("R7 busy hosts: when every host goes silent at once (the App's host route is down), no host with running jobs is released", async () => {
    await admin.query("update pnap_hosts set state = 'released' where state <> 'released'");
    await admin.query("update gh_installations set pnap_region = 'ASH' where installation_id = $1", [INSTALLATION_ID]);
    await queue(961, 99961);
    await queue(962, 99962);
    const a = await readyHost("fx-rv-ash-h000003", "ASH");
    const b = await readyHost("fx-rv-ash-h000004", "ASH");
    assert.deepEqual(((await hosts.lease(cred("fx-rv-ash-h000003", "ASH"), { free: 1, running: [], done: [] })).body.jobs as { jobId: number }[]).map((j) => j.jobId), [961]);
    assert.deepEqual(((await hosts.lease(cred("fx-rv-ash-h000004", "ASH"), { free: 1, running: [], done: [] })).body.jobs as { jobId: number }[]).map((j) => j.jobId), [962]);
    await admin.query("update pnap_hosts set running = 1 where host_id in ('fx-rv-ash-h000003', 'fx-rv-ash-h000004')");
    // Six minutes without a lease from ANY host, while phoenixNAP reports both servers powered on: the hosts function
    // failed (a bad deploy, throttling, an API Gateway incident), not the hosts.
    await admin.query("update pnap_hosts set last_seen_at = now() - interval '6 minutes' where state = 'ready'");
    await runScaler(deps);
    assert.equal(fake.servers.get(a)?.status, "powered-on", "a busy host was released at phoenixNAP: its customer's running job is killed");
    assert.equal(fake.servers.get(b)?.status, "powered-on", "a busy host was released at phoenixNAP: its customer's running job is killed");
  });
});
