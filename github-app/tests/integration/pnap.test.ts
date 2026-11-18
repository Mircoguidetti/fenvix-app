import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { HttpPnapApi } from "../../src/pnap/api.ts";
import { HostsService } from "../../src/pnap/hosts.ts";
import { signHostCredential, sha256 } from "../../src/pnap/hostcred.ts";
import { PnapPlacement } from "../../src/pnap/placement.ts";
import { hold, releaseRegion, runScaler, type ScalerDeps } from "../../src/pnap/scaler.ts";
import { loadPnapSettings, type PnapSettings } from "../../src/pnap/settings.ts";
import { userData } from "../../src/pnap/userdata.ts";
import { verifySummaryCredential } from "../../src/runners/credentials.ts";
import { FakePnap } from "../helpers/fake-pnap.ts";
import { ACCOUNT, CI_YAML, Harness, INSTALLATION_ID, installationCreated, makeOrg, REPOS, resetDb, RUNNER_TOKEN, workflowJob } from "../helpers/harness.ts";

const silent = { info() {}, warn() {}, error() {} };
const HOST_KEY = "host-signing-key-for-tests-0123456789abcdef";
const BETA = { login: "beta", id: 9002, type: "Organization" as const };
const BETA_INSTALLATION = 5151;
const THIRD_INSTALLATION = 6161;
const ENV = { PNAP_REGIONS: "ASH:0:3,NLD:0:2,SEA:0:1", PNAP_CONTROL_URL: "https://github.fenvix.test", PNAP_FIRECRACKER_SHA256: "f".repeat(64), FENVIX_ENV: "test", PNAP_IDLE_MINUTES: "20" };

describe("customer mode on phoenixNAP: placement by region, the scaler, enrolment and leases (Postgres, fake GitHub, fake phoenixNAP)", () => {
  const h = new Harness();
  const fake = new FakePnap();
  const { privateKey: cacheKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let admin: pg.Client;
  let s: PnapSettings;
  let deps: ScalerDeps;
  let hosts: HostsService;
  let clock = new Date();
  const userDataOf = new Map<string, string>();

  const run = () => runScaler({ ...deps, now: () => clock });
  const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await admin.query(sql, p)).rows as T[];
  const hostRow = async (region: string, role = "runner") => (await q<{ host_id: string; server_id: string; state: string; cred_gen: number }>(
    "select * from pnap_hosts where region = $1 and role = $2 order by ordered_at", [region, role]));
  const enrolToken = (hostId: string) => {
    const ud = Buffer.from(userDataOf.get(hostId)!, "base64").toString();
    return /printf '%s' '(fxe1\.[^']+)' >\/etc\/fenvix\/enrol/.exec(ud)![1]!;
  };
  const cred = (hostId: string, region: "ASH" | "NLD" | "SEA", gen = 1) =>
    `Bearer ${signHostCredential(HOST_KEY, { hostId, region, gen, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const queue = async (installation: number, repo: { id: number; name: string; full_name: string }, jobId: number, runId: number) => {
    h.gh.addRun(repo.full_name, runId, { event: "push", headSha: "c".repeat(40), headBranch: "main", message: "m" });
    const p = workflowJob("queued", { id: jobId, runId, sha: "c".repeat(40), branch: "main", repo });
    (p.installation as Record<string, unknown>).id = installation;
    await h.send("workflow_job", p);
  };

  before(async () => {
    admin = await resetDb();
    await admin.query("truncate pnap_jobs, pnap_hosts, pnap_region_holds cascade");
    await fake.start();
    s = loadPnapSettings(ENV);
    await h.start({ CACHE_SIGNING_KEY: cacheKey.export({ type: "pkcs8", format: "pem" }).toString() }, { placer: (db) => new PnapPlacement(db, s, silent) });
    // Two customer organizations, one per region, and a third installation with no region.
    const acme = await makeOrg(admin, "pnap-acme");
    const beta = await makeOrg(admin, "pnap-beta");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    h.gh.addInstallation({ id: BETA_INSTALLATION, account: BETA, repos: [REPOS.web.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.web.id, fullName: REPOS.web.full_name, ownerId: BETA.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    h.gh.addInstallation({ id: THIRD_INSTALLATION, account: { login: "gamma", id: 9003, type: "Organization" }, repos: [REPOS.docs.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.docs.id, fullName: REPOS.docs.full_name, ownerId: 9003, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    const b = installationCreated([REPOS.web]);
    Object.assign(b.installation as Record<string, unknown>, { id: BETA_INSTALLATION, account: { ...((b.installation as Record<string, unknown>).account as object), login: BETA.login, id: BETA.id } });
    await h.send("installation", b);
    const g = installationCreated([REPOS.docs]);
    Object.assign(g.installation as Record<string, unknown>, { id: THIRD_INSTALLATION, account: { ...((g.installation as Record<string, unknown>).account as object), login: "gamma", id: 9003 } });
    await h.send("installation", g);
    await h.app.service.linkInstallation(INSTALLATION_ID, acme.workspaceId, acme.userId);
    await h.app.service.linkInstallation(BETA_INSTALLATION, beta.workspaceId, beta.userId);
    const third = await makeOrg(admin, "pnap-gamma");
    await h.app.service.linkInstallation(THIRD_INSTALLATION, third.workspaceId, third.userId);
    await admin.query("update gh_installations set pnap_region = 'ASH' where installation_id = $1", [INSTALLATION_ID]);
    await admin.query("update gh_installations set pnap_region = 'NLD' where installation_id = $1", [BETA_INSTALLATION]);

    const api = new HttpPnapApi({ clientId: fake.clientId, clientSecret: fake.clientSecret, bmcUrl: `${fake.url}/bmc/v1`, billingUrl: `${fake.url}/billing/v1`,
      tokenUrl: `${fake.url}/auth/realms/BMC/protocol/openid-connect/token` });
    deps = {
      db: h.app.db, api, s, log: silent,
      userData: (x) => { const ud = Buffer.from(userData(s, x)).toString("base64"); userDataOf.set(x.hostId, ud); return userData(s, x); },
    };
    hosts = new HostsService({ db: h.app.db, service: h.app.service, s, log: silent, hostKeys: [HOST_KEY], cacheSigningKey: cacheKey });
  });
  after(async () => { await h.stop(); await fake.stop(); await admin.end(); });

  it("a queued job joins its customer's region's queue only; an installation without a region is not placed", async () => {
    await queue(INSTALLATION_ID, REPOS.shop, 801, 9801);
    await queue(INSTALLATION_ID, REPOS.shop, 802, 9802);
    await queue(INSTALLATION_ID, REPOS.shop, 803, 9803);
    await queue(BETA_INSTALLATION, REPOS.web, 811, 9811);
    await queue(THIRD_INSTALLATION, REPOS.docs, 821, 9821);
    await queue(INSTALLATION_ID, REPOS.shop, 801, 9801); // a redelivery: placed once
    const rows = await q<{ job_id: number; region: string; state: string }>("select job_id, region, state from pnap_jobs order by job_id");
    assert.deepEqual(rows, [
      { job_id: 801, region: "ASH", state: "queued" }, { job_id: 802, region: "ASH", state: "queued" }, { job_id: 803, region: "ASH", state: "queued" },
      { job_id: 811, region: "NLD", state: "queued" },
    ]);
    assert.equal(h.gh.repos.get("acme/shop")!.jitRunners.length, 0, "no runner registered before a host takes the job");
  });

  it("the scaler orders one host per region with demand (15 slots each), and none where there is none", async () => {
    const r = await run();
    assert.deepEqual(r.actions.map((a) => [a.kind, (a as { region?: string }).region]).sort(), [["order", "ASH"], ["order", "NLD"]]);
    const servers = [...fake.servers.values()];
    assert.deepEqual(servers.map((x) => [x.location, x.type, x.os, x.pricingModel]).sort(), [["ASH", "d3.c1.large", "ubuntu/noble", "HOURLY"], ["NLD", "d3.c1.large", "ubuntu/noble", "HOURLY"]]);
    for (const srv of servers) assert.ok(srv.hostname.startsWith("fx-test-"));
    assert.deepEqual(fake.problems, [], "every request and response matches phoenixNAP's schemas");
    const [ash] = await hostRow("ASH");
    assert.equal(ash!.state, "provisioning");
    // The user data's enrolment secret is stored only as its hash.
    const tok = enrolToken(ash!.host_id);
    assert.equal((await q<{ enrol_sha256: string }>("select enrol_sha256 from pnap_hosts where host_id = $1", [ash!.host_id]))[0]!.enrol_sha256, sha256(tok));
    assert.equal((await run()).actions.length, 0, "no double order while the hosts install");
  });

  it("enrolment: once, with the secret of that server only; the host gets its region, slots and the cache's public key", async () => {
    fake.tick(); fake.tick();
    await run();
    const [ash] = await hostRow("ASH");
    const [nld] = await hostRow("NLD");
    const bad = await hosts.enrol(`Bearer ${enrolToken(nld!.host_id).replace(nld!.host_id, ash!.host_id)}`);
    assert.equal(bad.status, 401, "another server's secret");
    const ok = await hosts.enrol(`Bearer ${enrolToken(ash!.host_id)}`);
    assert.equal(ok.status, 200);
    const cfg = ok.body.config as Record<string, unknown>;
    assert.deepEqual({ region: cfg.region, slots: cfg.slots, vcpus: cfg.vcpus, mem: cfg.mem_mib, cache: cfg.cache, sums: cfg.summaries_url },
      { region: "ASH", slots: 15, vcpus: 2, mem: 8192, cache: { mode: "colocated", port: 8787 }, sums: "https://github.fenvix.test/v1/runner/summaries" });
    assert.match(String((ok.body.cachePublicKey as { n: string }).n), /^[0-9a-f]{512}$/);
    assert.doesNotMatch(JSON.stringify(ok.body), /PRIVATE KEY/);
    assert.equal((await hosts.enrol(`Bearer ${enrolToken(ash!.host_id)}`)).status, 401, "single use");
    assert.equal((await hosts.enrol(`Bearer ${enrolToken(nld!.host_id)}`)).status, 200);
    assert.deepEqual((await hostRow("ASH")).map((x) => x.state), ["ready"]);
  });

  it("a lease gives only the host's own region's jobs, each with a fresh just-in-time runner and its own credentials", async () => {
    const [ash] = await hostRow("ASH");
    const r = await hosts.lease(cred(ash!.host_id, "ASH"), { free: 2, running: [], done: [] });
    assert.equal(r.status, 200);
    const jobs = r.body.jobs as Record<string, unknown>[];
    assert.deepEqual(jobs.map((j) => j.jobId), [801, 802]);
    const jit = h.gh.repos.get("acme/shop")!.jitRunners;
    assert.deepEqual(jit.map((x) => x.name), ["fenvix-j801", "fenvix-j802"]);
    for (const [i, j] of jobs.entries()) {
      assert.equal(j.jitConfig, jit[i]!.config);
      const scope = verifySummaryCredential([RUNNER_TOKEN], `Bearer ${j.summaryToken}`)!;
      assert.deepEqual({ ...scope, exp: 0 }, { runnerName: j.runnerName, repositoryId: REPOS.shop.id, runId: j.runId, exp: 0 });
      assert.equal(j.cacheOrg, `gh-${INSTALLATION_ID}`);
      const payload = JSON.parse(Buffer.from(String(j.cacheToken).split(".")[1]!, "base64url").toString());
      assert.deepEqual({ org: payload.org, w: payload.w }, { org: `gh-${INSTALLATION_ID}`, w: true }, "push on main: cache write");
      assert.deepEqual([j.vcpus, j.memMib], [2, 8192]);
    }
    // All its free slots: the last ASH job, never the NLD one.
    const r2 = await hosts.lease(cred(ash!.host_id, "ASH"), { free: 28, running: [801, 802], done: [] });
    assert.deepEqual((r2.body.jobs as { jobId: number }[]).map((j) => j.jobId), [803]);
    const r3 = await hosts.lease(cred(ash!.host_id, "ASH"), { free: 27, running: [801, 802, 803], done: [] });
    assert.deepEqual(r3.body.jobs, []);
    assert.equal((await q<{ state: string }>("select state from pnap_jobs where job_id = 811"))[0]!.state, "queued");
    const [nld] = await hostRow("NLD");
    const rn = await hosts.lease(cred(nld!.host_id, "NLD"), { free: 28, running: [], done: [] });
    assert.deepEqual((rn.body.jobs as { jobId: number; cacheOrg: string }[]).map((j) => [j.jobId, j.cacheOrg]), [[811, `gh-${BETA_INSTALLATION}`]]);
  });

  it("a host credential is bound to its host, region and generation; nothing in the body changes the region", async () => {
    const [ash] = await hostRow("ASH");
    assert.equal((await hosts.lease(cred(ash!.host_id, "NLD"), { free: 1 })).status, 403, "a credential naming another region");
    assert.equal((await hosts.lease(cred(ash!.host_id, "ASH", 2), { free: 1 })).status, 403, "an old or future generation");
    assert.equal((await hosts.lease(cred("fx-test-ash-h000000", "ASH"), { free: 1 })).status, 403, "an unknown host");
    assert.equal((await hosts.lease("Bearer fxh1.e30.AAAA", { free: 1 })).status, 401);
    assert.equal((await hosts.lease(undefined, { free: 1 })).status, 401);
  });

  it("a job cancelled before a host took it leaves the queue", async () => {
    await queue(INSTALLATION_ID, REPOS.shop, 804, 9804);
    const p = workflowJob("completed", { id: 804, runId: 9804, sha: "c".repeat(40), branch: "main", conclusion: "cancelled" });
    await h.send("workflow_job", p);
    assert.equal((await q<{ state: string }>("select state from pnap_jobs where job_id = 804"))[0]!.state, "cancelled");
  });

  it("outcomes come back with the lease; an idle host is drained, then released at phoenixNAP, and its credential is revoked", async () => {
    const [ash] = await hostRow("ASH");
    const done = [801, 802, 803].map((jobId, slot) => ({ jobId, slot, result: "summary", summary_sent: true, detail: "summary sent: 202", timings: { start: 1, prepared: 2.5, vm_exit: 60, end: 61 } }));
    await hosts.lease(cred(ash!.host_id, "ASH"), { free: 0, running: [], done });
    const rows = await q<{ state: string; outcome: string; slot: number }>("select state, outcome, slot from pnap_jobs where job_id in (801, 802, 803) order by job_id");
    assert.deepEqual(rows, [{ state: "done", outcome: "summary", slot: 0 }, { state: "done", outcome: "summary", slot: 1 }, { state: "done", outcome: "summary", slot: 2 }]);
    // 25 minutes later, 55 minutes into the billed hour: idle long enough and near the end of the paid hour.
    await admin.query("update pnap_hosts set last_job_at = now() - interval '25 minutes', provisioned_at = now() - interval '55 minutes' where host_id = $1", [ash!.host_id]);
    clock = new Date();
    const r = await run();
    assert.ok(r.actions.some((a) => a.kind === "drain" && a.hostId === ash!.host_id), JSON.stringify(r.actions));
    const l = await hosts.lease(cred(ash!.host_id, "ASH"), { free: 28, running: [], done: [], draining: false });
    assert.deepEqual({ drain: l.body.drain, jobs: l.body.jobs }, { drain: true, jobs: [] });
    await run();
    assert.equal((await hostRow("ASH"))[0]!.state, "released");
    assert.equal(fake.servers.get(ash!.server_id)?.status, "deleting");
    assert.equal((await hosts.lease(cred(ash!.host_id, "ASH"), { free: 1 })).status, 403);
  });

  it("a silent host is released and its job that never started is queued again; a host that never enrols is released", async () => {
    const [nld] = await hostRow("NLD");
    await admin.query("update pnap_jobs set leased_at = now() - interval '10 minutes' where job_id = 811");
    await admin.query("update pnap_hosts set last_seen_at = now() - interval '10 minutes' where host_id = $1", [nld!.host_id]);
    const r = await run();
    assert.ok(r.reconciled.some((x) => x.hostId === nld!.host_id && x.to === "releasing"));
    assert.deepEqual(r.requeued, [811]);
    assert.equal((await hostRow("NLD"))[0]!.state, "released");
    // The NLD job waits again: a new NLD host is ordered for it (and only in NLD).
    assert.ok(r.actions.some((a) => a.kind === "order" && (a as { region: string }).region === "NLD"));
    const fresh = (await hostRow("NLD")).find((x) => x.state === "provisioning")!;
    clock = new Date(Date.now() + (s.provisionTimeoutMinutes + 1) * 60_000);
    const r2 = await run();
    assert.ok(r2.reconciled.some((x) => x.hostId === fresh.host_id && x.to === "releasing"), JSON.stringify(r2.reconciled));
    clock = new Date();
  });

  it("phoenixNAP out of capacity: the order fails cleanly and the region waits before trying again", async () => {
    fake.capacity.set("d3.c1.large@SEA", 0);
    await hold(h.app.db, "SEA", 1, 60, "test");
    const r = await run();
    const order = r.actions.find((a) => a.kind === "order" && (a as { region: string }).region === "SEA")!;
    assert.match(order.result, /^no capacity/);
    assert.equal((await hostRow("SEA"))[0]!.state, "failed");
    const again = await run();
    assert.ok(!again.actions.some((a) => a.kind === "order" && (a as { region: string }).region === "SEA"), "backoff");
    await releaseRegion(h.app.db, "SEA");
  });

  it("a server with our prefix the database does not count as rented is released; anyone else's server is left alone", async () => {
    const api = deps.api;
    const orphan = await api.createServer({ hostname: "fx-test-ash-horphan", os: "ubuntu/noble", type: "d3.c1.large", location: "ASH" });
    const mine = await api.createServer({ hostname: "founders-own-box", os: "ubuntu/noble", type: "s1.c1.small", location: "ASH" });
    const r = await run();
    assert.ok(r.orphans.includes(orphan.id));
    assert.ok(!r.orphans.includes(mine.id));
    assert.equal(fake.servers.get(orphan.id)?.status, "deleting");
    assert.equal(fake.servers.get(mine.id)?.status, "creating");
    assert.deepEqual(fake.problems, []);
  });

  it("the first-test hold: one host for an hour, then released by hand", async () => {
    await hold(h.app.db, "ASH", 1, 60, "first real test");
    const r = await run();
    assert.ok(r.actions.some((a) => a.kind === "order" && (a as { region: string }).region === "ASH"));
    const n = await releaseRegion(h.app.db, "ASH");
    assert.equal(n, 1);
    await run();
    const live = (await hostRow("ASH")).filter((x) => !["released", "failed"].includes(x.state));
    assert.deepEqual(live, []);
  });
});
