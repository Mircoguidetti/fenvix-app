import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthFailureGuard, AuthGuardRefusal, ENGINE_LIMITS } from "../../src/engine/auth-guard.ts";

/**
 * The control plane must never get its own address blocked by the engine (docs/network-allowlist.md, "The control plane
 * never blocks itself"). The engine blocks an address after 5 failed sign-ins on one database or 10 on all of them in
 * 60 s, unless the address is in --trusted-networks. When the control plane is not trusted (a wrong --trusted-networks,
 * another Docker network), its failures count: a key rotation half done, a provisioner password changed on one side
 * only, or a customer's allowlist that leaves the control plane out. The guard stops signing in well before the
 * engine's limits and keeps two attempts for the provisioner, which every database needs.
 */
const clock = () => {
  let t = 1_000_000;
  return { now: () => t, add: (ms: number) => { t += ms; } };
};

test("its limits are below the engine's, with room for the provisioner", () => {
  const g = new AuthFailureGuard();
  assert.ok(g.limits.perDatabase < ENGINE_LIMITS.perDatabase);
  assert.ok(g.limits.total < ENGINE_LIMITS.total);
  assert.ok(g.limits.reserve >= 2 && g.limits.reserve < g.limits.total);
  assert.ok(g.limits.windowMs >= ENGINE_LIMITS.windowMs);
});

test("after the per-database budget, that database is not tried again until the window has passed; others still are", () => {
  const c = clock();
  const g = new AuthFailureGuard({ now: c.now });
  for (let i = 0; i < g.limits.perDatabase; i++) g.begin("eu", "db_a", "data").done(false);
  assert.throws(() => g.begin("eu", "db_a", "data"), AuthGuardRefusal);
  g.begin("eu", "db_b", "data").done(true);
  c.add(g.limits.windowMs - 1);
  assert.throws(() => g.begin("eu", "db_a", "data"), AuthGuardRefusal);
  c.add(2);
  g.begin("eu", "db_a", "data").done(true);
});

test("across databases, the Data Explorer stops first and the provisioner keeps its reserve", () => {
  const c = clock();
  const g = new AuthFailureGuard({ now: c.now });
  const forData = g.limits.total - g.limits.reserve;
  for (let i = 0; i < forData; i++) g.begin("eu", `db_${i}`, "data").done(false);
  assert.throws(() => g.begin("eu", "db_new", "data"), AuthGuardRefusal);
  for (let i = 0; i < g.limits.reserve; i++) g.begin("eu", "admin", "provisioner").done(false);
  assert.throws(() => g.begin("eu", "admin", "provisioner"), AuthGuardRefusal);
  assert.equal(g.failuresInWindow("eu"), g.limits.total);
  // another region is another engine, with its own counters
  g.begin("us", "admin", "provisioner").done(true);
});

test("attempts that have not succeeded yet hold their place, so a burst cannot overshoot", () => {
  const c = clock();
  const g = new AuthFailureGuard({ now: c.now });
  const held = [g.begin("eu", "db_a", "data"), g.begin("eu", "db_a", "data")];
  assert.throws(() => g.begin("eu", "db_a", "data"), AuthGuardRefusal, "two in flight already use the budget of db_a");
  held[0]!.done(true);
  const third = g.begin("eu", "db_a", "data");
  held[1]!.done(false);
  third.done(false);
  assert.throws(() => g.begin("eu", "db_a", "data"), AuthGuardRefusal);
});

test("done() twice counts once; a success frees the place without counting", () => {
  const c = clock();
  const g = new AuthFailureGuard({ now: c.now });
  const a = g.begin("eu", "db_a", "data");
  a.done(false);
  a.done(false);
  assert.equal(g.failuresInWindow("eu"), 1);
  g.begin("eu", "db_a", "data").done(true);
  assert.equal(g.failuresInWindow("eu"), 1);
});

test("whatever happens, the failures in any 60 s stay under the engine's limits (random runs)", () => {
  for (let run = 0; run < 200; run++) {
    const c = clock();
    const g = new AuthFailureGuard({ now: c.now });
    const failures: { at: number; db: string }[] = [];
    const open: { db: string; t: ReturnType<AuthFailureGuard["begin"]> }[] = [];
    for (let step = 0; step < 400; step++) {
      c.add(Math.floor(Math.random() * 3000));
      const db = Math.random() < 0.2 ? "admin" : `db_${Math.floor(Math.random() * 4)}`;
      if (Math.random() < 0.6) {
        try { open.push({ db, t: g.begin("eu", db, db === "admin" ? "provisioner" : "data") }); } catch (e) { assert.ok(e instanceof AuthGuardRefusal); }
      }
      if (open.length && Math.random() < 0.7) {
        const [o] = open.splice(Math.floor(Math.random() * open.length), 1);
        const ok = Math.random() < 0.2;
        o!.t.done(ok);
        if (!ok) failures.push({ at: c.now(), db: o!.db });
      }
      const recent = failures.filter((f) => c.now() - f.at < ENGINE_LIMITS.windowMs);
      assert.ok(recent.length < ENGINE_LIMITS.total, `run ${run}: ${recent.length} failures in a window`);
      for (const db of new Set(recent.map((f) => f.db))) assert.ok(recent.filter((f) => f.db === db).length < ENGINE_LIMITS.perDatabase, `run ${run}: ${db}`);
    }
  }
});
