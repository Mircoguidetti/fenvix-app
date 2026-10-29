import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { MongoClient } from "mongodb";
import { engineName } from "../../src/engine/names.ts";
import { parseNetwork, validateEntries } from "../../src/engine/netlist.ts";
import { AuthFailureGuard } from "../../src/engine/auth-guard.ts";
import { dataTarget } from "../../src/engine/data.ts";
import { json, sleep } from "../helpers/harness.ts";
import { type EngineEnv, startEngines } from "../helpers/engine-proc.ts";
import { ADMIN_BIN, AUTH_BIN, SKIP, type World, cookie, startWorld } from "./common.ts";

/**
 * The IP allowlist and the network limits of the engine (test5 network-limits @ 1c9fee7) with the whole control plane
 * (docs/network-allowlist.md). The network is simulated on the loopback interface:
 *
 *  - the control plane (Data Explorer, provisioner, admin calls) connects from 127.0.0.1: it stands for the Docker
 *    network of the control-plane container on the server;
 *  - "a customer's application" connects from 127.0.0.2 (the driver's localAddress): an address outside it;
 *  - engine T (trusted) runs with --trusted-networks 127.0.0.1/32: the deployment with infra/'s flag;
 *  - engine U (untrusted) runs with --trusted-networks= (nothing trusted): the deployment without the flag, or with a
 *    Docker network the flag does not cover. The control plane is then an address like any other.
 *
 * Point 3 of the brief: (a) a list without the application's address refuses it with the error of a wrong password;
 * (b) the Data Explorer and the provisioner keep working on T; (c) what breaks on U.
 * Point 4: the control plane's own failed sign-ins (a wrong provisioner password, a customer's list without the control
 * plane, a key rotation) never get its address blocked on U, thanks to the guard (src/engine/auth-guard.ts); without the
 * guard they do, and then the provisioner cannot work for anyone. On T nothing is ever counted.
 */
const APP = "127.0.0.2";
const CP = "127.0.0.1";
type Created = { id: string; connectionString: string; initialUser: { username: string; password: string; connectionString: string } };

describe("engine-real: IP allowlist and network limits", { skip: SKIP }, () => {
  let T: EngineEnv;
  let U: EngineEnv;
  const clients: MongoClient[] = [];
  before(async () => {
    T = await startEngines(ADMIN_BIN!, AUTH_BIN, { extraArgs: [`--trusted-networks=${CP}/32`] });
    U = await startEngines(ADMIN_BIN!, AUTH_BIN, { extraArgs: ["--trusted-networks="] });
  });
  after(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await T?.stop();
    await U?.stop();
  });

  const admin = async (e: EngineEnv, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${e.adminUrl}${path}`, { method, headers: { authorization: `Bearer ${e.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const network = async (e: EngineEnv) => (await admin(e, "GET", "/v1/network")).body;
  /** Failures and blocks the engine holds against an address. */
  const against = async (e: EngineEnv, ip: string) => {
    const n = await network(e);
    return {
      failures: (n.failing as { ip: string; database: string | null; failures_in_window: number }[]).filter((f) => f.ip === ip),
      blocks: (n.blocked as { ip: string; database: string | null }[]).filter((b) => b.ip === ip),
    };
  };
  const forget = (e: EngineEnv, ip: string) => admin(e, "DELETE", `/v1/network/blocks/${ip}`);

  const create = async (w: World, name: string): Promise<Created> => {
    const d = await w.settle(await w.h.as(w.u).post("/databases", { name, region: "eu-central-1" }, cookie));
    assert.ok([200, 201].includes(d.status), JSON.stringify(d.body));
    return (d.body.result ?? d.body) as Created;
  };
  /** The customer's application, with the user and password of the connection string, from `from`. */
  const app = (w: World, cs: string, from = APP) => {
    const u = new URL(cs);
    u.host = `localhost:${w.e.dataAddr.split(":")[1]}`;
    const c = new MongoClient(u.toString(), { tlsCAFile: w.e.caFile, serverSelectionTimeoutMS: 4000, localAddress: from } as never);
    clients.push(c);
    return c;
  };
  const code = async (p: Promise<unknown>) => p.then(() => 0, (e: { code?: number }) => e.code ?? -1);
  const setList = async (w: World, id: string, entries: string[]) => {
    const r = await w.h.as(w.u).put(`/databases/${id}/ip-allowlist`, { entries }, cookie);
    assert.equal(r.statusCode, 200, r.body);
    return json(r);
  };

  // ------------------------------------------------------------------------------------------------ the rules

  test("validation: the control plane accepts and writes every entry exactly as the engine does (corpus of 130)", async () => {
    const w = await startWorld({}, { engines: T });
    try {
      const d = await create(w, "net-corpus");
      const key = engineName(d.id);
      const corpus = [
        "10.0.0.0/8", "1.2.3.4", "2001:DB8::/32", "2001:db8::1", "::ffff:10.0.0.0/104", "::ffff:1.2.3.4", "::ffff:0:0/96", "0.0.0.0/0", "::/0", "::1",
        "", " ", "10.0.0.0/33", "::/129", "10.0.0.1/8", "2001:db8::1/32", "300.1.1.1", "1.2.3", "010.0.0.1", "10.0.0.0/08", "10.0.0.0/+8",
        "10.0.0.0/-1", "10.0.0.0/", "/8", " 10.0.0.0/8", "10.0.0.0/8 ", "fe80::1%eth0", "::ffff:1.2.3.4/200", "::ffff:10.0.0.0/90", "abc", "*",
        "١٠.0.0.0/8", "1.2.3.4/32/32", "0x0a.0.0.1", "10.0.0.0/0008", "1:2:3:4:5:6:7:8:9",
        "2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:db8:0:1:0:0:0:1", "2001:db8:0:0:1:0:0:1", "2001:db8:1:1:1:1:0:1", "1:2:3:4:5:6:7::", "::",
        "fe80::/10", "::1.2.3.4", "::ffff:a00:0/104", "2001:db8::/48", "0:0:0:0:0:0:0:0/0", "1:2:3:4:5:6:7::8", "1::2::3", ":::", "1:2:3:4:5:6:7",
        "12345::", "::1.2.3", "::1.2.3.04", "1.2.3.4::", "::1.2.3.4:5", "1:2:3:4:5:6:1.2.3.4:8", "[::1]", "::g", "1.2.3.4.5", "1..2.3", "256.0.0.0",
        "1.2.3.4/", "1.2.3.4/1/", "a".repeat(50), "1:2:3:4:5:6:7:8/129", "1:2:3:4:5:6:1.2.3.4", "0001:0002::", "255.255.255.255/32", "0.0.0.0",
        "0:0:1::", "1:0:0:2:0:0:0:3", "10.0.0.0/0", "192.168.1.0/24", "192.168.1.128/25", "192.168.1.129/25", "172.16.0.0/12", "172.17.0.1/16",
        "fd00::/8", "FD00::/8", "fd00::1/8", "::ffff:192.168.1.1/128", "::ffff:192.168.1.0/120", "::ffff:192.168.1.1/120", "64:ff9b::1.2.3.4",
        "1.2.3.4/0", "0.0.0.0/32", "8.8.8.8/32", "8.8.8.8/31", "8.8.8.9/31", "2001:db8::/127", "2001:db8::1/127", "2001:db8::/128", "2001:db8::/0",
        "::/1", "8000::/1", "8000::/0", "1.2.3.4 ", "\t1.2.3.4", "1.2.3.4\n", "１.2.3.4", "1.2.3.4/3 2", "1,2,3,4", "1.2.3.4;", "1.2.3.4/32a",
        "abcd:ef01:2345:6789:abcd:ef01:2345:6789", "ABCD:EF01:2345:6789:ABCD:EF01:2345:6789/64", "abcd:ef01:2345:6789::/64",
        "0:0:0:0:0:ffff:7f00:1", "::ffff:127.0.0.1/104", "::ffff:127.0.0.0/104", "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8/128", "1:2:3:4:5:6:7:8/112",
        "1:2:3:4:5:6:7:0/112", "::0", "0::", "0::0", "::0:0:0:0:0:0:0", "::0:0:0:0:0:0", "1::", "::1:2:3:4:5:6:7", "::1:2:3:4:5:6:7:8",
        "1.2.3.4/9", "1.0.0.0/9", "0.128.0.0/9", "127.0.0.1/8", "127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10",
      ];
      let mismatches: string[] = [];
      for (const entry of corpus) {
        const eng = await admin(T, "PUT", `/v1/databases/${key}/ip-allowlist`, { entries: [entry] });
        const ours = parseNetwork(entry);
        const theirs = eng.status === 200 ? (eng.body.entries as string[])[0] : null;
        if (eng.status !== 200 && eng.status !== 400) throw new Error(`engine answered ${eng.status} for ${JSON.stringify(entry)}`);
        const mine = ours.ok ? ours.text : null;
        if (mine !== theirs) mismatches.push(`${JSON.stringify(entry)}: engine ${theirs ?? "refused"}, control plane ${mine ?? "refused"}`);
      }
      assert.deepEqual(mismatches, []);
      // Lists: duplicates once normalized, 100 and 101 entries, non-strings.
      const lists: unknown[][] = [["1.2.3.4", "1.2.3.4/32"], ["10.0.0.0/8", "::ffff:10.0.0.0/104"], Array.from({ length: 100 }, (_, i) => `10.0.${i}.0/24`),
        Array.from({ length: 101 }, (_, i) => `10.0.${i}.0/24`), [5], ["2001:db8::/32", "2001:DB8::/32"], ["10.0.0.0/8", "10.0.0.0/9"]];
      mismatches = [];
      for (const l of lists) {
        const eng = await admin(T, "PUT", `/v1/databases/${key}/ip-allowlist`, { entries: l });
        let mine: string[] | null = null;
        try { mine = validateEntries(l); } catch { mine = null; }
        const theirs = eng.status === 200 ? eng.body.entries : null;
        if (JSON.stringify(mine) !== JSON.stringify(theirs)) mismatches.push(`${JSON.stringify(l).slice(0, 80)}: engine ${eng.status}`);
      }
      assert.deepEqual(mismatches, []);
      console.log(`NETWORK corpus: ${corpus.length} entries and ${lists.length} lists, same answer from the engine and the control plane`);
    } finally { await w.close(); }
  });

  // ------------------------------------------------------------------------------------------------ point 3, engine T

  describe("trusted control plane (--trusted-networks 127.0.0.1/32)", () => {
    let w: World;
    before(async () => { w = await startWorld({}, { engines: T }); });
    after(async () => { await w?.close(); });

    test("(a) a list without the application's address: the right password is refused with the error of a wrong one", async () => {
      const d = await create(w, "net-app-a");
      const ok = app(w, d.initialUser.connectionString);
      await ok.db(engineName(d.id)).collection("c").insertOne({ _id: 1 } as never);
      await ok.close();
      const view = await setList(w, d.id, ["203.0.113.0/24"]);
      assert.equal(view.engine.status, "in_sync");
      assert.equal(view.engine.enforced, true);
      assert.equal(view.dataExplorer.trusted, true, "the control plane's address is in the engine's trusted networks");
      const refused = await code(app(w, d.initialUser.connectionString).db(engineName(d.id)).collection("c").findOne({}));
      assert.equal(refused, 18, "AuthenticationFailed, as for a wrong password");
      const wrongPw = new URL(d.initialUser.connectionString);
      wrongPw.password = "not-the-password-0123456789";
      await setList(w, d.id, []);
      assert.equal(await code(app(w, wrongPw.toString()).db(engineName(d.id)).collection("c").findOne({})), 18, "the same code for a wrong password");
      await setList(w, d.id, [`${APP}/32`]);
      assert.equal(await code(app(w, d.initialUser.connectionString).db(engineName(d.id)).collection("c").findOne({})), 0, "with its address in the list it works");
      await forget(w.e, APP);
    });

    test("(b) with a list that leaves the control plane out, the Data Explorer and the provisioner keep working", async () => {
      const d = await create(w, "net-app-b");
      await setList(w, d.id, ["203.0.113.0/24"]);
      const base = `/databases/${d.id}/data/collections`;
      assert.equal((await w.h.as(w.u).post(`${base}/items/documents`, { document: { name: "one" } }, cookie)).statusCode, 201);
      const list = await w.h.as(w.u).get(`${base}/items/documents`);
      assert.equal(list.statusCode, 200, list.body);
      assert.equal(json(list).items.length, 1);
      const made = await w.h.as(w.u).post(`/databases/${d.id}/users`, { username: "reporting", role: "read" }, cookie);
      assert.equal(made.statusCode, 201, made.body);
      assert.equal((await w.h.as(w.u).post(`/databases/${d.id}/users/reporting/reset-password`, undefined, cookie)).statusCode, 200);
      const f = await w.settle(await w.h.as(w.u).post(`/databases/${d.id}/fork`, { name: "net-app-b-fork" }, cookie));
      assert.ok([200, 201].includes(f.status), JSON.stringify(f.body));
      assert.deepEqual((await against(T, CP)).failures, [], "nothing of the control plane is ever counted");
    });

    test("create, fork, erase and restore with the real engine: the fork has no list, erase removes it, restore keeps it", async () => {
      const d = await create(w, "net-life");
      await setList(w, d.id, ["198.51.100.0/24", "2001:db8::/32"]);
      const key = engineName(d.id);
      assert.deepEqual((await admin(T, "GET", `/v1/databases/${key}/ip-allowlist`)).body.entries, ["198.51.100.0/24", "2001:db8::/32"]);
      // history for the restore
      await w.h.as(w.u).post(`/databases/${d.id}/data/collections/h/documents`, { document: { _id: "before" } }, cookie);
      await sleep(1500);
      const at = new Date().toISOString();
      await sleep(1500);
      const f = await w.settle(await w.h.as(w.u).post(`/databases/${d.id}/fork`, { name: "net-life-fork" }, cookie));
      const fork = (f.body.result ?? f.body).id as string;
      assert.deepEqual((await admin(T, "GET", `/v1/databases/${engineName(fork)}/ip-allowlist`)).body.entries, [], "the engine's fork has no list");
      const fv = json(await w.h.as(w.u).get(`/databases/${fork}/ip-allowlist`));
      assert.equal(fv.allowAll, true);
      assert.equal(fv.engine.status, "in_sync");
      const r = await w.settle(await w.h.as(w.u).post(`/databases/${d.id}/restore`, { at }, cookie));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual((await admin(T, "GET", `/v1/databases/${key}/ip-allowlist`)).body.entries, ["198.51.100.0/24", "2001:db8::/32"], "restore keeps the list");
      assert.equal(json(await w.h.as(w.u).get(`/databases/${d.id}/ip-allowlist`)).engine.status, "in_sync");
      await setList(w, fork, ["192.0.2.0/24"]);
      const e1 = await w.settle(await w.h.as(w.u).post("/databases/erase", { ids: [fork] }, cookie));
      assert.equal(e1.status, 200, JSON.stringify(e1.body));
      assert.equal((await admin(T, "GET", `/v1/databases/${engineName(fork)}/ip-allowlist`)).status, 404, "erased with the database");
      assert.equal((await w.h.admin.query("select count(*)::int n from public.database_ip_allowlists where database_id = $1", [fork])).rows[0].n, 0);
      const again = await create(w, "net-life-fork");
      assert.deepEqual((await admin(T, "GET", `/v1/databases/${engineName(again.id)}/ip-allowlist`)).body.entries, []);
    });

    test("a list changed in the engine behind the control plane's back is shown as different; apply again repairs it", async () => {
      const d = await create(w, "net-drift");
      await setList(w, d.id, ["198.51.100.0/24"]);
      await admin(T, "PUT", `/v1/databases/${engineName(d.id)}/ip-allowlist`, { entries: ["0.0.0.0/0"] });
      const g = json(await w.h.as(w.u).get(`/databases/${d.id}/ip-allowlist`));
      assert.equal(g.engine.status, "different");
      assert.deepEqual(g.engine.entries, ["0.0.0.0/0"]);
      assert.equal((await w.h.as(w.u).post(`/databases/${d.id}/ip-allowlist/reapply`, undefined, cookie)).statusCode, 200);
      assert.deepEqual((await admin(T, "GET", `/v1/databases/${engineName(d.id)}/ip-allowlist`)).body.entries, ["198.51.100.0/24"]);
    });

    test("blocks: wrong passwords from the application's address block it on this database; the owner sees it and unblocks it", async () => {
      const d = await create(w, "net-blocks");
      const wrong = new URL(d.initialUser.connectionString);
      wrong.password = "wrong-password-0123456789abcdef";
      for (let i = 0; i < 5; i++) assert.equal(await code(app(w, wrong.toString()).db(engineName(d.id)).collection("c").findOne({})), 18);
      const right = app(w, d.initialUser.connectionString);
      assert.equal(await code(right.db(engineName(d.id)).collection("c").findOne({})), 18, "blocked: even the right password is refused");
      const b = await w.h.as(w.u).get(`/databases/${d.id}/network/blocks`);
      assert.equal(b.statusCode, 200, b.body);
      const items = json(b).items as { ip: string; until: string; remainingSecs: number }[];
      assert.deepEqual(items.map((x) => x.ip), [APP]);
      assert.deepEqual(Object.keys(items[0]!).sort(), ["ip", "remainingSecs", "until"]);
      assert.ok(items[0]!.remainingSecs > 250 && items[0]!.remainingSecs <= 300);
      assert.ok(!b.body.includes(d.initialUser.username) && !b.body.includes("wrong-password"), "no user name, no password");
      const un = await w.h.as(w.u).post(`/databases/${d.id}/network/unblock`, { ip: APP }, cookie);
      assert.equal(un.statusCode, 200, un.body);
      assert.equal(await code(app(w, d.initialUser.connectionString).db(engineName(d.id)).collection("c").findOne({})), 0, "unblocked: the right password works again");
      assert.deepEqual(json(await w.h.as(w.u).get(`/databases/${d.id}/network/blocks`)).items, []);
      const a = (await w.h.admin.query("select metadata from public.audit_log where target_id = $1 and action = 'database.network.unblock'", [d.id])).rows;
      assert.deepEqual(a.map((x) => x.metadata), [{ ip: APP }]);
    });

    test("(point 4) a wrong provisioner password on a trusted control plane: failures, but nothing is ever counted against it", async () => {
      const bad = await startWorld({ ENGINE_PROVISIONER_PASSWORD: "wrong-provisioner-password-0123" }, { engines: T, guard: new AuthFailureGuard({ perDatabase: 1000, total: 1000, reserve: 0 }) });
      try {
        for (let i = 0; i < 12; i++) await bad.settle(await bad.h.as(bad.u).post("/databases", { name: `net-tp-${i}`, region: "eu-central-1" }, cookie), 1);
        const n = await against(T, CP);
        assert.deepEqual(n, { failures: [], blocks: [] });
      } finally { await bad.close(); }
    });
  });

  // ------------------------------------------------------------------------------------------------ point 3 (c) and point 4, engine U

  describe("untrusted control plane (--trusted-networks empty: the bridge is not covered)", () => {
    test("(c) what breaks: the page says the Data Explorer is affected; with a list that leaves the control plane out the Data Explorer fails and its failures are counted", async () => {
      await forget(U, CP);
      const w = await startWorld({}, { engines: U });
      try {
        const d = await create(w, "net-u-c");
        const before = json(await w.h.as(w.u).get(`/databases/${d.id}/ip-allowlist`));
        assert.equal(before.dataExplorer.trusted, false, "the control plane can tell the engine does not trust it");
        await setList(w, d.id, ["203.0.113.0/24"]);
        const r = await w.h.as(w.u).get(`/databases/${d.id}/data/collections`);
        assert.equal(r.statusCode, 503, r.body);
        const n = await against(U, CP);
        assert.ok(n.failures.some((f) => f.database === engineName(d.id)), JSON.stringify(n));
        // the provisioner signs in on admin, which has no list: user changes still work while the address is not blocked
        assert.equal((await w.h.as(w.u).post(`/databases/${d.id}/users`, { username: "still-ok", role: "read" }, cookie)).statusCode, 201);
        await setList(w, d.id, []);
      } finally { await w.close(); await forget(U, CP); }
    });

    const scenarios: { name: string; run: (w: World) => Promise<void>; env?: Record<string, string> }[] = [
      {
        name: "a wrong provisioner password (changed in SSM, not in the engine)",
        env: { ENGINE_PROVISIONER_PASSWORD: "wrong-provisioner-password-0123" },
        async run(w) {
          for (let i = 0; i < 14; i++) await w.settle(await w.h.as(w.u).post("/databases", { name: `net-pw-${i}`, region: "eu-central-1" }, cookie), 1);
        },
      },
      {
        name: "customers' allowlists that leave the control plane out, and the Data Explorer used on them",
        async run(w) {
          const ids: string[] = [];
          for (let i = 0; i < 3; i++) ids.push((await create(w, `net-list-${i}`)).id);
          for (const id of ids) await setList(w, id, ["203.0.113.0/24"]);
          for (let round = 0; round < 6; round++) for (const id of ids) await w.h.as(w.u).get(`/databases/${id}/data/collections`);
        },
      },
    ];

    for (const sc of scenarios) {
      test(`(point 4) WITHOUT the guard, ${sc.name} blocks the provisioner (on admin, or on every database)`, async () => {
        await forget(U, CP);
        const w = await startWorld(sc.env ?? {}, { engines: U, guard: new AuthFailureGuard({ perDatabase: 1000, total: 1000, reserve: 0 }) });
        try {
          await sc.run(w);
          const n = await against(U, CP);
          console.log(`NETWORK without guard, ${sc.name}: ${JSON.stringify(n)}`);
          // The provisioner signs in on admin: 5 failures there block it on admin (the per-database limit), 10 anywhere on
          // every database. Either way no database can get its users any more.
          assert.ok(n.blocks.some((b) => b.database === null || b.database === "admin"), `the provisioner is blocked: ${JSON.stringify(n)}`);
        } finally { await w.close(); }
        // Even with everything fixed (right password, no list), the provisioner is now locked out: no database can be made.
        const fixed = await startWorld({}, { engines: U });
        try {
          const r = await fixed.settle(await fixed.h.as(fixed.u).post("/databases", { name: "net-after-fix", region: "eu-central-1" }, cookie), 2);
          assert.notEqual(r.status, 201, JSON.stringify(r.body));
          assert.ok(r.status !== 200 || r.body.status !== "succeeded", JSON.stringify(r.body));
        } finally { await fixed.close(); await forget(U, CP); }
      });

      test(`(point 4) WITH the guard, ${sc.name} never gets the control plane blocked; once fixed, it works at once`, async () => {
        await forget(U, CP);
        const w = await startWorld(sc.env ?? {}, { engines: U });
        try {
          await sc.run(w);
          const n = await against(U, CP);
          console.log(`NETWORK with guard, ${sc.name}: ${JSON.stringify(n)}`);
          assert.deepEqual(n.blocks, [], "no block");
          const total = n.failures.filter((f) => f.database === null).reduce((x, f) => x + f.failures_in_window, 0);
          assert.ok(total < 10, `failures in the window: ${total}`);
          for (const f of n.failures.filter((x) => x.database !== null)) assert.ok(f.failures_in_window < 5, JSON.stringify(f));
        } finally { await w.close(); }
        const fixed = await startWorld({}, { engines: U });
        try {
          await create(fixed, "net-after-fix-ok");
        } finally { await fixed.close(); await forget(U, CP); }
      });
    }

    test("(point 4) a master key rotation with the guard: databases whose user still has the old key cost at most a few failures, no block", async () => {
      await forget(U, CP);
      const old = await startWorld({}, { engines: U });
      const ids: string[] = [];
      try {
        for (let i = 0; i < 8; i++) ids.push((await create(old, `net-rot-${i}`)).id);
      } finally { await old.close(); }
      const rotated = await startWorld({ ENGINE_USER_KEY: `v2:${"r".repeat(40)}`, ENGINE_USER_KEY_PREVIOUS: U.userKey }, { engines: U });
      try {
        let ok = 0;
        for (const id of ids) {
          // The databases belong to the first world's workspace: the Data Explorer's client is used directly, as a request would.
          const r = await rotated.data.listCollections(dataTarget({ id, region: "eu-central-1" }), { limit: 10, maxTimeMS: 3000 }).then(() => true, () => false);
          if (r) ok++;
        }
        const n = await against(U, CP);
        console.log(`NETWORK key rotation: ${ok}/${ids.length} databases read with the previous key; ${JSON.stringify(n)}`);
        assert.equal(ok, ids.length, "every database is read (with the previous key)");
        assert.deepEqual(n.blocks, []);
        const total = n.failures.filter((f) => f.database === null).reduce((x, f) => x + f.failures_in_window, 0);
        assert.ok(total <= 2, `failed sign-ins: ${total}`);
      } finally { await rotated.close(); await forget(U, CP); }
    });
  });
});
