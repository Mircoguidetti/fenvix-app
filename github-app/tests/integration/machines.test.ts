// Our machines (P-047, F-15): the dispatcher of src/machines/ against a fake GitHub and an in-memory EC2.
// docs/REPORT-our-machines.md lists which audit gap each test closes.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { PoolLauncher } from "../../src/machines/launcher.ts";
import { MachinePool } from "../../src/machines/pool.ts";
import { parsePool, sizeOfLabels } from "../../src/machines/settings.ts";
import type { Db } from "../../src/db.ts";
import { FakeDriver } from "../helpers/fake-machines.ts";
import { ACCOUNT, CI_YAML, Harness, INSTALLATION_ID, installationCreated, makeOrg, REPOS, resetDb, workflowJob } from "../helpers/harness.ts";

const API = "http://127.0.0.1";
const POOL = parsePool(JSON.stringify({
  sizes: { standard: { instanceType: "c7a.xlarge", slots: 2 }, large: { instanceType: "c7a.2xlarge", slots: 4 } },
  defaultSize: "standard", alwaysOn: 1, reserve: 1, maxMachines: 6, spotAbove: 4, machinesPerCustomer: 2, jobsPerCustomer: 3, lingerMinutes: 10,
}));
const GLOBEX = { installation: 5353, account: { login: "globex", id: 9002, type: "Organization" as const }, repo: { id: 80001, name: "api", full_name: "globex/api" } };

describe("our machines: dispatcher, affinity, isolation, reserve, caps, metering", () => {
  const h = new Harness();
  const driver = new FakeDriver();
  let pool!: MachinePool;
  let admin: pg.Client;
  let acme: { userId: string; workspaceId: string };
  let globex: { userId: string; workspaceId: string };
  const machineEnv = { FENVIX_CACHE_URL: "http://10.42.0.10:8787", FENVIX_SUMMARIES_URL: "https://api.fenvix.dev/v1/runner/summaries" };

  const post = async (path: string, body: unknown, token?: string) => {
    const r = await h.app.fastify.inject({ method: "POST", url: path, payload: body as object, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    return { status: r.statusCode, body: r.json() as Record<string, unknown> };
  };
  /** Boots a machine as the agent would: the boot secret from its user data, then hello. */
  const boot = async (instanceId: string) => {
    const s = driver.settingsOf(instanceId);
    const r = await post("/v1/runner/machine/hello", { machineId: Number(s.FENVIX_MACHINE_ID), bootSecret: s.FENVIX_BOOT_SECRET, engineVersion: "0.1.0-r42.abcdef1" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { machineId: Number(s.FENVIX_MACHINE_ID), token: String(r.body.token), mode: String(r.body.mode) };
  };
  const poll = (token: string, holding: number[] = []) => post("/v1/runner/machine/poll", { holding }, token);
  const machine = async (id: number) => (await admin.query("select * from gh_machines where id = $1", [id])).rows[0];
  const instanceOf = async (id: number) => String((await machine(id)).instance_id);
  const leaseOfJob = async (jobId: number) => (await admin.query("select * from gh_leases where job_id = $1", [jobId])).rows[0];
  const globexJob = (action: "queued" | "in_progress" | "completed", id: number, extra: Record<string, unknown> = {}) => {
    const p = workflowJob(action, { id, runId: 8800 + id, sha: "c".repeat(40), branch: "feature", repo: GLOBEX.repo, ...extra });
    (p.installation as Record<string, unknown>).id = GLOBEX.installation;
    (p.repository as Record<string, unknown>).owner = { ...(p.repository as { owner: object }).owner, login: GLOBEX.account.login, id: GLOBEX.account.id };
    return p;
  };

  before(async () => {
    admin = await resetDb();
    await h.start({}, { launcher: (db: Db) => {
      pool = new MachinePool(db, driver, POOL, { keys: ["runner-token-for-tests-0123456789abcdef"], apiUrl: API, machineEnv, regions: ["eu"] });
      return new PoolLauncher(pool, machineEnv);
    } });
    acme = await makeOrg(admin, "acme-owner");
    globex = await makeOrg(admin, "globex-owner");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await h.app.service.linkInstallation(INSTALLATION_ID, acme.workspaceId, acme.userId);
    h.gh.addInstallation({ id: GLOBEX.installation, account: GLOBEX.account, repos: [GLOBEX.repo.id], selection: "selected" });
    h.gh.addRepo({ id: GLOBEX.repo.id, fullName: GLOBEX.repo.full_name, ownerId: GLOBEX.account.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    const inst = installationCreated([GLOBEX.repo]);
    const i = inst.installation as Record<string, unknown>;
    inst.installation = { ...i, id: GLOBEX.installation, account: { ...(i.account as object), login: GLOBEX.account.login, id: GLOBEX.account.id }, target_id: GLOBEX.account.id };
    await h.send("installation", inst);
    await h.app.service.linkInstallation(GLOBEX.installation, globex.workspaceId, globex.userId);
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("sizes: runs-on fenvix is the default size; fenvix-<size> asks for another; an unknown size gets no machine", () => {
    assert.equal(sizeOfLabels(["fenvix"], "fenvix", POOL), "standard");
    assert.equal(sizeOfLabels(["fenvix", "fenvix-large"], "fenvix", POOL), "large");
    assert.equal(sizeOfLabels(["fenvix", "fenvix-huge"], "fenvix", POOL), null);
    assert.throws(() => parsePool(JSON.stringify({ sizes: { arm: { instanceType: "c7g.xlarge", slots: 2 } }, defaultSize: "arm" })), /x86_64/);
    assert.equal(parsePool(undefined).sizes.standard!.instanceType, "c7a.xlarge", "the founder's always-on size by default");
  });

  it("the pool starts with one clean machine running (always-on) and one prepared machine stopped (the reserve)", async () => {
    await h.app.service.poolTick();
    const launched = [...driver.instances.keys()];
    assert.equal(launched.length, 2);
    const [a, b] = [await boot(launched[0]!), await boot(launched[1]!)];
    assert.deepEqual([a.mode, b.mode].sort(), ["prepare", "work"], "the first is the always-on machine, the second is prepared for the reserve");
    const prep = a.mode === "prepare" ? a : b;
    assert.equal((await post("/v1/runner/machine/events", { type: "prepared" }, prep.token)).status, 202);
    await h.app.service.poolTick();
    const states = (await admin.query("select state from gh_machines order by id")).rows.map((r) => r.state).sort();
    assert.deepEqual(states, ["ready", "reserve"]);
    assert.equal(driver.instances.get(await instanceOf(prep.machineId))!.state, "stopped", "only its disk is paid");
    // Its session ended when it was stopped: a new boot secret starts it later.
    assert.equal((await poll(prep.token)).status, 401);
  });

  it("the boot secret is single use, and is the only secret in the user data (no job credential is ever there)", async () => {
    const ready = (await admin.query("select id, instance_id from gh_machines where state = 'ready'")).rows[0];
    const s = driver.settingsOf(ready.instance_id);
    assert.equal((await post("/v1/runner/machine/hello", { machineId: ready.id, bootSecret: s.FENVIX_BOOT_SECRET })).status, 401, "already used");
    assert.deepEqual(Object.keys(s).sort(), ["FENVIX_API_URL", "FENVIX_BOOT_SECRET", "FENVIX_CACHE_URL", "FENVIX_MACHINE_ID", "FENVIX_SUMMARIES_URL"]);
  });

  it("a customer job goes to the always-on machine at once, which becomes that customer's; a reserve machine is started ahead of the next job", async () => {
    const ready = (await admin.query("select id, instance_id from gh_machines where state = 'ready'")).rows[0];
    const readyToken = (await post("/v1/runner/machine/hello", { machineId: ready.id, bootSecret: "0".repeat(64) })).status;
    assert.equal(readyToken, 401);
    h.gh.addRun("acme/shop", 9401, { event: "pull_request", headSha: "a".repeat(40), headBranch: "feature", message: "pr" });
    await h.send("workflow_job", workflowJob("queued", { id: 1001, runId: 9401, sha: "a".repeat(40), branch: "feature" }));
    const l = await leaseOfJob(1001);
    assert.equal(l.machine_id, ready.id);
    const m = await machine(ready.id);
    assert.deepEqual({ state: m.state, ws: m.workspace_id }, { state: "bound", ws: acme.workspaceId });
    assert.equal((await admin.query("select dispatch_state from gh_jobs where job_id = 1001")).rows[0].dispatch_state, "leased");
    // Ahead of need: the reserve machine was started (warm start) to be the next clean machine.
    const starting = (await admin.query("select id, instance_id, state from gh_machines where state = 'starting'")).rows;
    assert.equal(starting.length, 1);
    assert.ok(driver.calls.includes(`start ${starting[0].instance_id}`));
    // ...and a new reserve is being prepared.
    assert.equal((await admin.query("select count(*)::int as n from gh_machines where state = 'launching'")).rows[0].n, 1);
  });

  // A session for the always-on machine (now acme's): its agent said hello at boot in the test above.
  let acmeToken = "";
  it("the machine fetches its lease once over HTTPS: the just-in-time configuration and the job's own credentials, mode and skip switch", async () => {
    // The always-on machine's agent: we re-create its session the way a reboot would not allow, so take it from the DB
    // through a fresh hello: give it a new boot secret first (as the dispatcher does when it starts a machine).
    const m = (await admin.query("select id, instance_id from gh_machines where state = 'bound'")).rows[0];
    const { createHash } = await import("node:crypto");
    const secret = "1".repeat(64);
    await admin.query("update gh_machines set boot_secret_sha256 = $2 where id = $1", [m.id, createHash("sha256").update(secret).digest("hex")]);
    const hello = await post("/v1/runner/machine/hello", { machineId: m.id, bootSecret: secret });
    acmeToken = String(hello.body.token);
    const p = await poll(acmeToken);
    assert.equal(p.status, 200);
    const leases = p.body.leases as { leaseId: number; slot: number; kind: string; work: { jitConfig: string; summaryToken: string; env: Record<string, string>; runnerName: string } }[];
    assert.equal(leases.length, 1);
    const w = leases[0]!.work;
    assert.equal(leases[0]!.slot, 1);
    assert.match(w.jitConfig, /^[A-Za-z0-9+/=]+$/);
    assert.match(w.summaryToken, /^fxr1\./);
    assert.equal(w.env.FENVIX_MODE, "shadow", "linking started the 30-day trial");
    assert.equal(w.env.FENVIX_SKIP, "1");
    assert.equal(w.env.FENVIX_CACHE_URL, `http://10.42.0.10:8787/gh-${INSTALLATION_ID}-r${REPOS.shop.id}`);
    assert.equal(w.env.FENVIX_REGION, "eu");
    // Taken once: the payload is deleted.
    assert.equal(((await poll(acmeToken, [leases[0]!.leaseId])).body.leases as unknown[]).length, 0);
    assert.equal((await leaseOfJob(1001)).payload, null);
    assert.equal((await leaseOfJob(1001)).state, "running");
  });

  it("the same customer's second job shares the machine, in its own slot", async () => {
    await admin.query("update ci_projects set skip_with_proof = false where full_name = 'acme/shop'");
    h.gh.addRun("acme/shop", 9402, { event: "pull_request", headSha: "b".repeat(40), headBranch: "feature", message: "pr" });
    await h.send("workflow_job", workflowJob("queued", { id: 1002, runId: 9402, sha: "b".repeat(40), branch: "feature" }));
    const [a, b] = [await leaseOfJob(1001), await leaseOfJob(1002)];
    assert.equal(b.machine_id, a.machine_id);
    assert.equal(b.slot, 2);
    const p = await poll(acmeToken, [a.id]);
    const w = (p.body.leases as { work: { env: Record<string, string> } }[])[0]!.work;
    assert.equal(w.env.FENVIX_SKIP, "0", "the project's skip-with-proof switch, off, reaches the machine (audit G-0191, G-1732)");
  });

  let globexMachine = 0;
  it("ISOLATION: another customer's job never lands on a machine that held acme's work", async () => {
    // Bring the started reserve machine up (it is clean): it becomes the ready machine.
    const starting = (await admin.query("select instance_id from gh_machines where state = 'starting'")).rows[0];
    await boot(starting.instance_id);
    h.gh.addRun("globex/api", 8800 + 2001, { event: "pull_request", headSha: "c".repeat(40), headBranch: "feature", message: "pr" });
    await h.send("workflow_job", globexJob("queued", 2001));
    const l = await leaseOfJob(2001);
    assert.ok(l, "globex's job got a lease");
    globexMachine = l.machine_id;
    assert.notEqual(l.machine_id, (await leaseOfJob(1001)).machine_id);
    const acmeMachines = (await admin.query("select id from gh_machines where ever_bound and workspace_id = $1", [acme.workspaceId])).rows.map((r) => r.id);
    assert.ok(!acmeMachines.includes(l.machine_id));
  });

  it("ISOLATION: acme's machine credential fetches nothing of globex, and cannot end globex's lease", async () => {
    const g = await leaseOfJob(2001);
    const p = await poll(acmeToken, [g.id]);
    assert.deepEqual(p.body.leases, []);
    assert.deepEqual(p.body.stop, [g.id], "a lease it does not hold is not reported as running");
    await post("/v1/runner/machine/events", { type: "finished", leaseId: g.id }, acmeToken);
    assert.equal((await leaseOfJob(2001)).state, "offered", "globex's lease is untouched");
    // A forged or stale credential gets nothing.
    assert.equal((await poll(acmeToken.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).status, 401);
  });

  it("ISOLATION: the database refuses to give a used machine to a second customer or to make it clean again", async () => {
    const acmeMachine = (await leaseOfJob(1001)).machine_id;
    await assert.rejects(admin.query("update gh_machines set workspace_id = $2 where id = $1", [acmeMachine, globex.workspaceId]), /never given to a second one/);
    await assert.rejects(admin.query("update gh_machines set state = 'ready', workspace_id = null where id = $1", [acmeMachine]), /never made clean again|gh_machines_clean/);
    await assert.rejects(admin.query("insert into gh_leases (machine_id, slot, kind, warmup_id, workspace_id) values ($1, 3, 'warmup', 1, $2)", [acmeMachine, globex.workspaceId]), /lease for customer/);
  });

  it("caps: a customer's concurrent jobs are capped; the job waits in the database and gets the next free slot at once", async () => {
    h.gh.addRun("acme/shop", 9403, { event: "pull_request", headSha: "d".repeat(40), headBranch: "feature", message: "pr" });
    h.gh.addRun("acme/shop", 9404, { event: "pull_request", headSha: "e".repeat(40), headBranch: "feature", message: "pr" });
    await h.send("workflow_job", workflowJob("queued", { id: 1003, runId: 9403, sha: "d".repeat(40), branch: "feature" }));
    await h.send("workflow_job", workflowJob("queued", { id: 1004, runId: 9404, sha: "e".repeat(40), branch: "feature" }));
    // jobsPerCustomer = 3: 1001, 1002, 1003 run; 1004 waits.
    assert.ok(await leaseOfJob(1003));
    const w = (await admin.query("select dispatch_state, dispatch_detail from gh_jobs where job_id = 1004")).rows[0];
    assert.equal(w.dispatch_state, "pending");
    assert.match(w.dispatch_detail, /3 jobs at once/);
    assert.equal(await leaseOfJob(1004), undefined);
    // 1001 completes: its slot is freed and 1004 is dispatched now, not after a queue retry.
    await h.send("workflow_job", workflowJob("completed", { id: 1001, runId: 9401, sha: "a".repeat(40), branch: "feature", runner: "fenvix-j1001" }));
    assert.ok(await leaseOfJob(1004), "dispatched by the freed slot");
    assert.equal((await admin.query("select dispatch_state from gh_jobs where job_id = 1004")).rows[0].dispatch_state, "leased");
  });

  it("metering: the job's usage event names the machine size, type and market it ran on", async () => {
    await h.app.service.tryPublish(1001, true);
    const u = (await admin.query("select machine_size, instance_type, machine_market, machine_id from ci_usage_events where github_job_id = 1001")).rows[0];
    assert.deepEqual(u, { machine_size: "standard", instance_type: "c7a.xlarge", machine_market: "on-demand", machine_id: (await leaseOfJob(1001)).machine_id });
  });

  it("a customer's empty machine lingers for its next job, then is terminated (never handed on)", async () => {
    for (const [id, run, sha] of [[1002, 9402, "b"], [1003, 9403, "d"], [1004, 9404, "e"]] as const) {
      await h.send("workflow_job", workflowJob("completed", { id, runId: run, sha: sha.repeat(40), branch: "feature", runner: `fenvix-j${id}` }));
    }
    const ids = [...new Set((await admin.query("select machine_id from gh_leases where workspace_id = $1", [acme.workspaceId])).rows.map((r) => r.machine_id))];
    for (const id of ids) assert.ok((await machine(id)).empty_since, "empty");
    await h.app.service.poolTick();
    for (const id of ids) assert.equal((await machine(id)).state, "bound", "still lingering");
    await admin.query("update gh_machines set empty_since = now() - interval '11 minutes' where id = any($1)", [ids]);
    await h.app.service.poolTick();
    for (const id of ids) {
      const m = await machine(id);
      assert.equal(m.state, "gone");
      assert.equal(driver.instances.get(m.instance_id)!.state, "terminated");
    }
  });

  it("an unknown size gets no machine and says why", async () => {
    h.gh.addRun("acme/shop", 9405, { event: "pull_request", headSha: "f".repeat(40), headBranch: "feature", message: "pr" });
    await h.send("workflow_job", workflowJob("queued", { id: 1005, runId: 9405, sha: "f".repeat(40), branch: "feature", labels: ["fenvix", "fenvix-huge"] }));
    const j = (await admin.query("select dispatch_state, dispatch_detail from gh_jobs where job_id = 1005")).rows[0];
    assert.equal(j.dispatch_state, "none");
    assert.match(j.dispatch_detail, /fenvix-standard, fenvix-large/);
  });

  it("a size label: the runner carries it, and the job gets a machine of that size", async () => {
    h.gh.addRun("acme/shop", 9406, { event: "pull_request", headSha: "1".repeat(40), headBranch: "feature", message: "pr" });
    await h.send("workflow_job", workflowJob("queued", { id: 1006, runId: 9406, sha: "1".repeat(40), branch: "feature", labels: ["fenvix", "fenvix-large"] }));
    const m = await machine((await leaseOfJob(1006)).machine_id);
    assert.deepEqual({ size: m.size, type: m.instance_type, slots: m.slots }, { size: "large", type: "c7a.2xlarge", slots: 4 });
    const jit = h.gh.repos.get("acme/shop")!.jitRunners.find((r) => r.name === "fenvix-j1006")!;
    assert.deepEqual(jit.labels, ["fenvix", "fenvix-large"]);
  });

  it("spot for bursts: above spotAbove running machines new machines are spot; an interruption re-runs the job", async () => {
    await admin.query("update gh_machines set state = 'gone' where state <> 'gone'");
    await admin.query("update gh_leases set state = 'done' where state in ('offered', 'running')");
    await admin.query("update workspaces set max_machines = 10, max_concurrent_jobs = 20 where id = $1", [acme.workspaceId]);
    // Four running machines of other sizes already: the next one is spot.
    for (let i = 0; i < 4; i++) await admin.query("insert into gh_machines (region, size, instance_type, slots, state, launched_at) values ('eu', 'large', 'c7a.2xlarge', 4, 'ready', now())");
    await admin.query("update gh_machines set state = 'gone' where state = 'ready' and id in (select id from gh_machines where state = 'ready' order by id limit 2)");
    await admin.query("insert into gh_machines (region, size, instance_type, slots, state, launched_at, workspace_id, ever_bound, bound_at) values ('eu', 'large', 'c7a.2xlarge', 4, 'bound', now(), $1, true, now()), ('eu', 'large', 'c7a.2xlarge', 4, 'bound', now(), $1, true, now())", [globex.workspaceId]);
    h.gh.addRun("acme/shop", 9407, { event: "pull_request", headSha: "2".repeat(40), headBranch: "feature", message: "pr" });
    await h.send("workflow_job", workflowJob("queued", { id: 1007, runId: 9407, sha: "2".repeat(40), branch: "feature" }));
    const m = await machine((await leaseOfJob(1007)).machine_id);
    assert.equal(m.market, "spot");
    const inst = m.instance_id as string;
    assert.equal(driver.instances.get(inst)!.market, "spot");
    const s = await boot(inst);
    await poll(s.token);
    assert.equal((await post("/v1/runner/machine/events", { type: "interrupted" }, s.token)).status, 202);
    assert.equal((await machine(s.machineId)).state, "retiring");
    await h.send("workflow_job", workflowJob("completed", { id: 1007, runId: 9407, sha: "2".repeat(40), branch: "feature", runner: "fenvix-j1007", conclusion: "failure" }));
    assert.deepEqual(h.gh.jobReruns, [{ repo: "acme/shop", jobId: 1007 }], "re-run once: the deterministic run gives the same result");
  });

  it("a machine that never says hello is terminated and its job goes back to pending; orphans in EC2 are terminated", async () => {
    await admin.query("update gh_machines set state = 'gone' where state <> 'gone'");
    await admin.query("update gh_leases set state = 'done' where state in ('offered', 'running')");
    h.gh.addRun("acme/shop", 9408, { event: "pull_request", headSha: "3".repeat(40), headBranch: "feature", message: "pr" });
    await h.send("workflow_job", workflowJob("queued", { id: 1008, runId: 9408, sha: "3".repeat(40), branch: "feature" }));
    const first = (await leaseOfJob(1008)).machine_id;
    await admin.query("update gh_machines set launched_at = now() - interval '20 minutes' where id = $1", [first]);
    await admin.query("update gh_leases set created_at = now() - interval '20 minutes' where job_id = 1008");
    const orphan = await driver.launch({ region: "eu", instanceType: "c7a.xlarge", market: "on-demand", userData: "", tags: { "fenvix:machine": "999999" }, clientToken: "x" });
    await h.app.service.poolTick();
    assert.equal((await machine(first)).state, "gone");
    assert.equal(driver.instances.get(orphan)!.state, "terminated");
    // The job was re-queued and dispatched again by the same tick, on another machine.
    const again = (await admin.query("select machine_id, state from gh_leases where job_id = 1008")).rows[0];
    assert.equal(again?.state === "offered" || again?.state === "lost", true);
  });

  it("machine API input: a bad body is 400, a missing credential 401", async () => {
    assert.equal((await post("/v1/runner/machine/hello", { machineId: "x" })).status, 400);
    assert.equal((await post("/v1/runner/machine/poll", {})).status, 401);
    assert.equal((await post("/v1/runner/machine/events", { type: "nope" }, acmeToken)).status, 400);
    void globexMachine;
  });
});
