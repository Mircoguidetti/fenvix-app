import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { LightMyRequestResponse as Res } from "fastify";
import { type Fixture, type Harness, json, startHarness } from "../helpers/harness.ts";
import { INVITE_INVALID } from "../../src/services/orgs.ts";

/**
 * Organizations, members, invitations and roles (docs/organizations.md), against the real migrations on a scratch
 * Postgres: isolation between organizations, invitations that cannot be told apart when they fail, every changing
 * route refused to a member, the owner/admin rules, the last owner, hostile names, limits, and no token in logs.
 */
let h: Harness;
const H = (ws: string) => ({ "x-fenvix-workspace": ws });
const err = (r: Res) => json<{ error: { code: string; message: string } }>(r).error;

/** A signed-in person whose e-mail is NOT verified. */
async function unverified(name: string): Promise<Fixture> {
  const u = await h.user(name);
  await h.admin.query("update auth.users set email_confirmed_at = null where id = $1", [u.userId]);
  return u;
}

async function invite(by: Fixture, ws: string, email: string, role: "admin" | "member" = "member"): Promise<{ id: string; token: string; link: string }> {
  const r = await h.as(by).post("/organization/invitations", { email, role }, H(ws));
  assert.equal(r.statusCode, 201, r.body);
  const b = json(r);
  const token = String(b.link).split("#token=")[1]!;
  return { id: b.invitation.id, token, link: b.link };
}

const accept = (who: Fixture, token: unknown) => h.as(who).post("/invitations/accept", { token });

before(async () => {
  h = await startHarness({ RATE_LIMIT_PER_MINUTE: "100000", RATE_LIMIT_ANON_PER_MINUTE: "100000" });
});
after(async () => { await h.close(); });

// ---------------------------------------------------------------- the person's organizations

describe("organizations of a person", () => {
  test("a new account has one organization, named by the sign-up trigger and not confirmed; the owner can confirm it", async () => {
    const u = await h.user("Nora Field");
    const list = json(await h.as(u).get("/organizations"));
    assert.equal(list.items.length, 1);
    assert.deepEqual(list.items[0], { id: u.workspaceId, name: "Nora Field", role: "owner", nameConfirmed: false });
    const r = await h.as(u).put("/organization", { name: "  Field Labs  " });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(json(r).name, "Field Labs");
    assert.equal(json(r).nameConfirmed, true);
    const audit = (await h.admin.query("select action, actor_id from public.audit_log where workspace_id = $1 and action like 'organization.%'", [u.workspaceId])).rows;
    assert.deepEqual(audit, [{ action: "organization.rename", actor_id: u.userId }]);
  });

  test("create, switch with the header, and every call is checked against the membership", async () => {
    const u = await h.user("Omar");
    const c = await h.as(u).post("/organizations", { name: "Second Org" });
    assert.equal(c.statusCode, 201, c.body);
    const second = json(c).organization;
    assert.equal(second.role, "owner");
    assert.equal(second.nameConfirmed, true);
    const list = json(await h.as(u).get("/organizations")).items.map((o: { id: string }) => o.id);
    assert.deepEqual(list, [u.workspaceId, second.id], "oldest first");

    // Without the header: the oldest. With it: the one named.
    assert.equal(json(await h.as(u).get("/organization")).id, u.workspaceId);
    assert.equal(json(await h.as(u).get("/organization", H(second.id))).id, second.id);
    const made = await h.as(u).post("/databases", { name: "in-second-01", region: "eu-central-1" }, H(second.id));
    assert.equal(made.statusCode, 201, made.body);
    assert.equal((await h.admin.query("select workspace_id from public.databases where id = $1", [json(made).id])).rows[0].workspace_id, second.id);
    assert.equal(json(await h.as(u).get("/databases", H(u.workspaceId))).total, 0, "the first organization has none");
    assert.equal(json(await h.as(u).get("/databases", H(second.id))).total, 1);
    const audit = (await h.admin.query("select action from public.audit_log where workspace_id = $1 and action = 'organization.create'", [second.id])).rows;
    assert.equal(audit.length, 1);
  });

  test("a person with no organization can still list (none), create one and accept an invitation", async () => {
    const u = await h.user("Lone");
    await h.admin.query("delete from public.workspaces where id = $1", [u.workspaceId]);
    assert.deepEqual(json(await h.as(u).get("/organizations")).items, []);
    const r = await h.as(u).get("/databases");
    assert.equal(r.statusCode, 403);
    assert.match(err(r).message, /Create one or accept an invitation/);
    assert.equal((await h.as(u).post("/organizations", { name: "Fresh Start" })).statusCode, 201);
    assert.equal((await h.as(u).get("/databases")).statusCode, 200);
  });

  test("API keys cannot list, create, join or manage organizations", async () => {
    const u = await h.user("Keyholder");
    const key = await h.apiKey(u.workspaceId, "k", "read_write", "manage");
    for (const [m, url, body] of [
      ["GET", "/organizations"], ["POST", "/organizations", { name: "By key" }], ["POST", "/invitations/accept", { token: "x" }],
      ["GET", "/organization"], ["PUT", "/organization", { name: "By key" }], ["GET", "/organization/members"],
      ["GET", "/organization/invitations"], ["POST", "/organization/invitations", { email: "k@example.invalid" }], ["POST", "/organization/leave"],
    ] as const) {
      const c = h.as(key);
      const r = m === "GET" ? await c.get(url) : await c.post(url, body);
      if (m === "PUT") continue;
      assert.equal(r.statusCode, 403, `${m} ${url}: ${r.body}`);
    }
    assert.equal((await h.as(key).put("/organization", { name: "By key" })).statusCode, 403);
    // A key that names another organization gets the same 404 as anyone naming one that is not theirs.
    const other = await h.user("Other");
    const r = await h.as(key).get("/databases", H(other.workspaceId));
    assert.equal(r.statusCode, 404);
  });
});

// ---------------------------------------------------------------- isolation

describe("isolation: A never sees B's organization, members or invitations", () => {
  let a: Fixture;
  let b: Fixture;
  let bInvite = "";
  before(async () => {
    a = await h.user("Alice Org");
    b = await h.user("Bob Org");
    await h.addMember(b.workspaceId, "Bob's colleague", "member");
    bInvite = (await invite(b, b.workspaceId, "someone@b.example.invalid")).id;
  });

  test("A's lists contain only A", async () => {
    const orgs = json(await h.as(a).get("/organizations")).items;
    assert.deepEqual(orgs.map((o: { id: string }) => o.id), [a.workspaceId]);
    const members = json(await h.as(a).get("/organization/members")).items;
    assert.deepEqual(members.map((m: { userId: string }) => m.userId), [a.userId]);
    assert.deepEqual(json(await h.as(a).get("/organization/invitations")).items, []);
    assert.ok(!JSON.stringify(members).includes("colleague"));
  });

  test("B's organization id, an unknown one and a malformed one give the same 404", async () => {
    const answers: string[] = [];
    for (const ws of [b.workspaceId, randomUUID(), "not-a-uuid", "' or 1=1 --", b.workspaceId.toUpperCase().replace(/-/g, "")]) {
      for (const url of ["/organization", "/organization/members", "/databases"]) {
        const r = await h.as(a).get(url, H(ws));
        assert.equal(r.statusCode, 404, `${url} ${ws}`);
        answers.push(r.body);
      }
      const p = await h.as(a).put("/organization", { name: "Taken over" }, H(ws));
      assert.equal(p.statusCode, 404);
      answers.push(p.body);
    }
    assert.equal(new Set(answers).size, 1, "one body for all of them");
    assert.equal((await h.admin.query("select name from public.workspaces where id = $1", [b.workspaceId])).rows[0].name, "Bob Org");
  });

  test("B's member ids and invitation ids, unknown and malformed ones: the same 404 for each kind", async () => {
    const bMember = (await h.admin.query("select user_id from public.workspace_members where workspace_id = $1 and role = 'member'", [b.workspaceId])).rows[0].user_id;
    const bodies = new Set<string>();
    for (const id of [bMember, b.userId, randomUUID(), "x", "%27", "00000000-0000-0000-0000-000000000000"]) {
      const r1 = await h.as(a).put(`/organization/members/${encodeURIComponent(id)}`, { role: "member" });
      const r2 = await h.as(a).del(`/organization/members/${encodeURIComponent(id)}`);
      assert.equal(r1.statusCode, 404, id);
      assert.equal(r2.statusCode, 404, id);
      bodies.add(r1.body).add(r2.body);
    }
    assert.equal(bodies.size, 1);
    const ib = new Set<string>();
    for (const id of [bInvite, randomUUID(), "nope"]) {
      const r = await h.as(a).post(`/organization/invitations/${encodeURIComponent(id)}/revoke`);
      assert.equal(r.statusCode, 404, id);
      ib.add(r.body);
    }
    assert.equal(ib.size, 1);
    assert.equal((await h.admin.query("select revoked_at from public.workspace_invites where id = $1", [bInvite])).rows[0].revoked_at, null);
    assert.equal(Number((await h.admin.query("select count(*) from public.workspace_members where workspace_id = $1", [b.workspaceId])).rows[0].count), 2);
  });
});

// ---------------------------------------------------------------- invitations

describe("invitations", () => {
  let owner: Fixture;
  let ws: string;
  before(async () => {
    owner = await h.user("Inviting Owner");
    ws = owner.workspaceId;
  });

  test("the link is shown once, only a hash is stored, and accepting adds that person to that organization only", async () => {
    const ivy = await h.user("Ivy");
    const inv = await invite(owner, ws, ivy.email.toUpperCase());
    assert.match(inv.token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes");
    assert.ok(inv.link.startsWith("https://app.fenvix.test/invite#token="));
    const stored = (await h.admin.query("select * from public.workspace_invites where id = $1", [inv.id])).rows[0];
    assert.equal(stored.email, ivy.email, "lower case");
    assert.match(stored.token_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(stored).includes(inv.token));
    const listed = json(await h.as(owner).get("/organization/invitations")).items;
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes(inv.token), "the list never has the token");
    const exp = new Date(listed[0].expiresAt).getTime() - new Date(listed[0].createdAt).getTime();
    assert.ok(Math.abs(exp - 7 * 86_400_000) < 5000, "7 days");

    const r = await accept(ivy, inv.token);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(json(r).organization, { id: ws, name: "Inviting Owner", role: "member", nameConfirmed: false });
    const roles = (await h.admin.query("select workspace_id, role from public.workspace_members where user_id = $1 order by created_at", [ivy.userId])).rows;
    assert.deepEqual(roles, [{ workspace_id: ivy.workspaceId, role: "owner" }, { workspace_id: ws, role: "member" }], "only that organization, with that role");
    assert.deepEqual(json(await h.as(owner).get("/organization/invitations")).items, [], "no longer pending");
    // Single use.
    const again = await accept(ivy, inv.token);
    assert.equal(again.statusCode, 404);
    const actions = (await h.admin.query("select action, outcome from public.audit_log where workspace_id = $1 and action like 'invitation.%' order by id", [ws])).rows;
    assert.deepEqual(actions.slice(0, 2), [{ action: "invitation.create", outcome: "ok" }, { action: "invitation.accept", outcome: "ok" }]);
  });

  test("every unusable invitation gets the same answer, and guessing tokens shows no difference", async () => {
    const ok = await h.user("Right Person");
    const wrong = await h.user("Wrong Person");
    const unver = await unverified("Unverified Person");

    const expired = await invite(owner, ws, ok.email);
    await h.admin.query("update public.workspace_invites set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id = $1", [expired.id]);
    const revoked = await invite(owner, ws, `r-${ok.email}`);
    assert.equal((await h.as(owner).post(`/organization/invitations/${revoked.id}/revoke`)).statusCode, 200);
    const used = await invite(owner, ws, ok.email);
    assert.equal((await accept(ok, used.token)).statusCode, 200);
    const forUnverified = await invite(owner, ws, unver.email);
    const forOther = await invite(owner, ws, `other-${wrong.email}`);

    // Guesses come from two other accounts (each person has 10 tries a minute).
    const g1 = await h.user("Guess One");
    const g2 = await h.user("Guess Two");
    const cases: [Fixture, unknown][] = [
      [ok, randomBytes(32).toString("base64url")], // random, well formed
      [g1, randomBytes(32).toString("base64url")], [g1, "short"], [g1, ""], [g1, 42], [g1, null],
      [g2, { $ne: null }], [g2, ["a"]], [g2, "x".repeat(5000)], [g2, `${used.token.slice(0, 42)}A`],
      [ok, expired.token], [ok, used.token], [ok, revoked.token],
      [wrong, forOther.token], // another e-mail
      [unver, forUnverified.token], // the right e-mail, not verified
    ];
    const seen = new Set<string>();
    for (const [who, token] of cases) {
      const r = await accept(who, token);
      assert.equal(r.statusCode, 404, `${JSON.stringify(token).slice(0, 40)}: ${r.body}`);
      assert.equal(err(r).message, INVITE_INVALID);
      const { "x-request-id": _id, date: _d, "content-length": _l, ...headers } = r.headers;
      seen.add(JSON.stringify([r.body, headers]));
    }
    assert.equal(seen.size, 1, "status, body and headers are identical");
    // None of them made anyone a member of anything.
    const n = Number((await h.admin.query("select count(*) from public.workspace_members where workspace_id = $1 and user_id = any($2)", [ws, [wrong.userId, unver.userId]])).rows[0].count);
    assert.equal(n, 0);
    // Once verified, the same person can accept.
    await h.admin.query("update auth.users set email_confirmed_at = now() where id = $1", [unver.userId]);
    assert.equal((await accept(unver, forUnverified.token)).statusCode, 200);
  });

  test("tampered roles are refused; an admin can invite members only", async () => {
    const adm = await h.addMember(ws, "Ada Admin", "admin");
    for (const role of ["owner", "superuser", "ADMIN", ["admin"], { $eq: "admin" }, 1]) {
      const r = await h.as(owner).post("/organization/invitations", { email: "t@example.invalid", role });
      assert.equal(r.statusCode, 400, JSON.stringify(role));
    }
    const r = await h.as(adm).post("/organization/invitations", { email: "t2@example.invalid", role: "admin" });
    assert.equal(r.statusCode, 403);
    const m = await h.as(adm).post("/organization/invitations", { email: "t3@example.invalid", role: "member" });
    assert.equal(m.statusCode, 201);
    // An admin cannot revoke an invitation of an admin (the owner's).
    const ownersAdminInvite = await invite(owner, ws, "future-admin@example.invalid", "admin");
    assert.equal((await h.as(adm).post(`/organization/invitations/${ownersAdminInvite.id}/revoke`)).statusCode, 403);
    assert.equal((await h.as(adm).post(`/organization/invitations/${json(m).invitation.id}/revoke`)).statusCode, 200);
    assert.equal((await h.as(owner).post(`/organization/invitations/${ownersAdminInvite.id}/revoke`)).statusCode, 200);
  });

  test("a second pending invitation for the same e-mail, or one for a member, is refused", async () => {
    const o = await h.user("Dup Owner");
    await invite(o, o.workspaceId, "dup@example.invalid");
    assert.equal((await h.as(o).post("/organization/invitations", { email: "DUP@example.invalid" })).statusCode, 409);
    assert.equal((await h.as(o).post("/organization/invitations", { email: o.email })).statusCode, 409);
  });

  test("accepting is rate limited per person with Retry-After", async () => {
    const g = await h.user("Guesser");
    let last: Res | undefined;
    for (let i = 0; i < 11; i++) last = await accept(g, randomBytes(32).toString("base64url"));
    assert.equal(last!.statusCode, 429);
    assert.ok(Number(last!.headers["retry-after"]) > 0);
  });
});

// ---------------------------------------------------------------- roles

describe("roles: a member reads, an admin manages members, an owner manages everyone", () => {
  let owner: Fixture;
  let admin: Fixture;
  let member: Fixture;
  let ws: string;
  let dbId = "";
  before(async () => {
    owner = await h.user("Role Owner");
    ws = owner.workspaceId;
    admin = await h.addMember(ws, "Role Admin", "admin");
    member = await h.addMember(ws, "Role Member", "member");
    const r = await h.as(owner).post("/databases", { name: "roles-db-01", region: "eu-central-1" });
    assert.equal(r.statusCode, 201, r.body);
    dbId = json(r).id;
  });

  const snapshot = async () => {
    const q = async (sql: string) => JSON.stringify((await h.admin.query(sql, [ws])).rows);
    return [
      await q("select id, name, state, keep_awake, restored_to, engine_state from public.databases where workspace_id = $1 order by id"),
      await q("select database_id, key, value from public.database_tags where workspace_id = $1 order by 1, 2"),
      await q("select id, revoked_at from public.api_keys where workspace_id = $1 order by id"),
      await q("select name, name_confirmed from public.workspaces where id = $1"),
      await q("select idle_minutes, email_notices from public.workspace_settings where workspace_id = $1"),
      await q("select user_id, role from public.workspace_members where workspace_id = $1 order by user_id"),
      await q("select id, revoked_at, accepted_at from public.workspace_invites where workspace_id = $1 order by id"),
    ].join("\n");
  };

  test("a member gets 403 from every changing route, and nothing changes", async () => {
    const before = await snapshot();
    const pending = await invite(owner, ws, "pending@example.invalid");
    const beforeWithInvite = await snapshot();
    assert.notEqual(before, beforeWithInvite);
    // Changing routes a member may call: about their own account (create, join, leave), or signing in and out.
    const allowed = new Set(["POST /v1/organizations", "POST /v1/invitations/accept", "POST /v1/organization/leave"]);
    // The public API's routes take keys only (a session gets 401; read-only keys are tested in public-api.test.ts),
    // except /v1/public/api-keys, which a session may call and which stays in here.
    const keyOnly = (r: string) => r.includes(" /v1/public/") && !r.includes(" /v1/public/api-keys");
    const changing = h.app.routes.filter((r) => !r.startsWith("GET ") && !r.includes("/session") && !allowed.has(r) && !keyOnly(r));
    assert.ok(changing.length >= 24, `${changing.length} changing routes`);
    const fill = (url: string) => url
      .replace("/v1", "")
      .replace(":id/revoke", `${pending.id}/revoke`)
      .replace("/organization/members/:userId", `/organization/members/${admin.userId}`)
      .replace(":id", dbId).replace(":collection", "orders").replace(":docId", encodeURIComponent('{"$oid":"64b7f0000000000000000001"}'))
      .replace(":username", "app");
    const bodies: Record<string, unknown> = {
      "POST /v1/databases": { name: "member-made-01", region: "eu-central-1" },
      "PUT /v1/organization": { name: "Member renamed" },
      "PUT /v1/organization/members/:userId": { role: "owner" },
      "POST /v1/organization/invitations": { email: "by-member@example.invalid", role: "member" },
      "PUT /v1/settings": { workspaceName: "Member", idleMinutes: 1, emailNotices: false },
      "POST /v1/api-keys": { name: "member key" },
      "POST /v1/public/api-keys": { name: "member key", role: "admin" },
    };
    const results: string[] = [];
    for (const r of changing) {
      const [method, url] = r.split(" ") as ["POST" | "PUT" | "DELETE", string];
      const path = fill(url);
      const body = bodies[r] ?? { ids: [dbId], enabled: true, tags: ["a:b"], name: "x-member-01", at: new Date().toISOString(), document: { a: 1 }, username: "member-user", role: "readWrite" };
      const c = h.as(member);
      const res = method === "DELETE" ? await c.del(path) : method === "PUT" ? await c.put(path, body) : await c.post(path, body);
      results.push(`${res.statusCode} ${r}`);
      assert.equal(res.statusCode, 403, `${r} → ${res.statusCode} ${res.body}`);
      assert.ok(!/password/i.test(res.body), `${r} said something about a password`);
    }
    assert.equal(await snapshot(), beforeWithInvite, "nothing changed");
    // And it still reads.
    for (const url of ["/databases", `/databases/${dbId}`, "/overview?range=7d", "/organization", "/organization/members", `/databases/${dbId}/data/collections`]) {
      assert.equal((await h.as(member).get(url)).statusCode, 200, url);
    }
    for (const url of ["/api-keys", "/organization/invitations"]) assert.equal((await h.as(member).get(url)).statusCode, 403, url);
  });

  test("a member never receives a password: the database view has none", async () => {
    const d = json(await h.as(member).get(`/databases/${dbId}`));
    assert.ok(String(d.connectionString).includes("<password>"));
    const users = json(await h.as(member).get(`/databases/${dbId}/users`));
    assert.ok(!/password/i.test(JSON.stringify(users)));
  });

  test("an admin cannot promote themselves, touch the owner or other admins, or make admins", async () => {
    const admin2 = await h.addMember(ws, "Second Admin", "admin");
    const cases: [string, string, unknown][] = [
      ["PUT", `/organization/members/${admin.userId}`, { role: "owner" }],
      ["PUT", `/organization/members/${admin.userId}`, { role: "admin" }],
      ["PUT", `/organization/members/${owner.userId}`, { role: "member" }],
      ["PUT", `/organization/members/${owner.userId}`, { role: "admin" }],
      ["PUT", `/organization/members/${admin2.userId}`, { role: "member" }],
      ["PUT", `/organization/members/${member.userId}`, { role: "admin" }],
      ["PUT", `/organization/members/${member.userId}`, { role: "owner" }],
      ["DELETE", `/organization/members/${owner.userId}`, undefined],
      ["DELETE", `/organization/members/${admin2.userId}`, undefined],
    ];
    for (const [m, url, body] of cases) {
      const r = m === "PUT" ? await h.as(admin).put(url, body) : await h.as(admin).del(url);
      assert.equal(r.statusCode, 403, `${m} ${url} ${JSON.stringify(body)}: ${r.body}`);
    }
    // Tampered role values: refused before anything else.
    for (const role of ["superowner", "", ["owner"], { role: "owner" }, null, 7]) {
      assert.equal((await h.as(owner).put(`/organization/members/${member.userId}`, { role })).statusCode, 400, JSON.stringify(role));
    }
    // Extra fields that look like a way in are ignored: the role comes from the membership.
    const sneaky = await h.as(admin).put(`/organization/members/${admin.userId}`, { role: "owner", actingRole: "owner", userId: owner.userId, workspaceId: ws });
    assert.equal(sneaky.statusCode, 403);
    const roles = Object.fromEntries((await h.admin.query("select user_id, role from public.workspace_members where workspace_id = $1", [ws])).rows.map((r) => [r.user_id, r.role]));
    assert.equal(roles[admin.userId], "admin");
    assert.equal(roles[owner.userId], "owner");
    assert.equal(roles[member.userId], "member");
    assert.equal(roles[admin2.userId], "admin");
    // What an admin may do: remove a member.
    const extra = await h.addMember(ws, "Removable", "member");
    assert.equal((await h.as(admin).del(`/organization/members/${extra.userId}`)).statusCode, 200);
    const audit = (await h.admin.query("select action, actor_id, target_id from public.audit_log where workspace_id = $1 and action = 'member.remove'", [ws])).rows;
    assert.deepEqual(audit, [{ action: "member.remove", actor_id: admin.userId, target_id: extra.userId }]);
  });

  test("an owner manages admins and owners; the last owner can neither leave, be removed nor demoted", async () => {
    const o = await h.user("Only Owner");
    const w = o.workspaceId;
    const a2 = await h.addMember(w, "Promotable", "member");
    assert.equal((await h.as(o).post("/organization/leave")).statusCode, 409);
    assert.equal((await h.as(o).del(`/organization/members/${o.userId}`)).statusCode, 409);
    assert.equal((await h.as(o).put(`/organization/members/${o.userId}`, { role: "admin" })).statusCode, 409);
    assert.equal((await h.as(o).put(`/organization/members/${a2.userId}`, { role: "admin" })).statusCode, 200);
    assert.equal((await h.as(o).put(`/organization/members/${a2.userId}`, { role: "owner" })).statusCode, 200);
    // Two owners: now the first may step down, then the second is the last one.
    assert.equal((await h.as(o).put(`/organization/members/${o.userId}`, { role: "member" })).statusCode, 200);
    assert.equal((await h.as(a2).put(`/organization/members/${a2.userId}`, { role: "member" })).statusCode, 409);
    assert.equal((await h.as(a2).post("/organization/leave")).statusCode, 409);
    // The member that was the owner leaves.
    assert.equal((await h.as(o).post("/organization/leave", undefined, H(w))).statusCode, 200);
    assert.deepEqual(json(await h.as(o).get("/organizations")).items, []);
    const actions = (await h.admin.query("select action, metadata from public.audit_log where workspace_id = $1 and action in ('member.role_change', 'organization.leave') order by id", [w])).rows;
    assert.deepEqual(actions.map((r) => r.action), ["member.role_change", "member.role_change", "member.role_change", "organization.leave"]);
    assert.deepEqual(actions[0].metadata, { from: "member", to: "admin" });
    // The database refuses it too, whoever asks.
    await assert.rejects(h.admin.query("delete from public.workspace_members where workspace_id = $1", [w]), /at least one owner/);
    await assert.rejects(h.admin.query("update public.workspace_members set role = 'member' where workspace_id = $1", [w]), /at least one owner/);
  });

  test("a member can leave; then every call to that organization is a 404", async () => {
    const m = await h.addMember(ws, "Leaving Member", "member");
    const own = json(await h.as(m).post("/organizations", { name: "My Own" })).organization.id;
    assert.equal((await h.as(m).post("/organization/leave", undefined, H(ws))).statusCode, 200);
    assert.equal((await h.as(m).get("/databases", H(ws))).statusCode, 404);
    assert.deepEqual(json(await h.as(m).get("/organizations")).items.map((o: { id: string }) => o.id), [own]);
  });
});

// ---------------------------------------------------------------- names

describe("hostile organization names are text, within limits", () => {
  test("markup and emoji are kept as text; too short, too long, blank and control characters are refused", async () => {
    const u = await h.user("Namer");
    for (const name of ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "Ünïcödé & Co. 👩‍💻🚀", "a".repeat(64), "  ok  "]) {
      const r = await h.as(u).put("/organization", { name });
      assert.equal(r.statusCode, 200, `${name}: ${r.body}`);
      assert.equal(json(r).name, name.trim());
      assert.equal(r.headers["content-type"], "application/json; charset=utf-8", "never HTML");
      assert.equal(json(await h.as(u).get("/organizations")).items[0].name, name.trim());
    }
    for (const name of ["", "   ", "a", " b ", "a".repeat(65), "x".repeat(5000), "line\nbreak", "tab\there", "bidi‮evil", "nul\u0000x", 42, null, ["Org"], { name: "Org" }]) {
      const r = await h.as(u).put("/organization", { name });
      assert.equal(r.statusCode, 400, JSON.stringify(name).slice(0, 30));
      const c = await h.as(u).post("/organizations", { name });
      assert.equal(c.statusCode, 400, JSON.stringify(name).slice(0, 30));
    }
    // 64 emoji are 64 characters; 65 are too many.
    assert.equal((await h.as(u).put("/organization", { name: "🚀".repeat(64) })).statusCode, 200);
    assert.equal((await h.as(u).put("/organization", { name: "🚀".repeat(65) })).statusCode, 400);
  });
});

// ---------------------------------------------------------------- limits

describe("limits", () => {
  test("20 invitations a day per organization, then 429 with Retry-After", async () => {
    const o = await h.user("Busy Inviter");
    for (let i = 0; i < 20; i++) await invite(o, o.workspaceId, `p${i}@example.invalid`);
    const r = await h.as(o).post("/organization/invitations", { email: "p20@example.invalid" });
    assert.equal(r.statusCode, 429, r.body);
    const retry = Number(r.headers["retry-after"]);
    assert.ok(retry > 0 && retry <= 86_400, `Retry-After ${retry}`);
    // Revoking does not give the day's budget back.
    const first = json(await h.as(o).get("/organization/invitations")).items[0].id;
    await h.as(o).post(`/organization/invitations/${first}/revoke`);
    assert.equal((await h.as(o).post("/organization/invitations", { email: "p21@example.invalid" })).statusCode, 429);
  });

  test("at most 50 members (pending invitations count), and accepting into a full organization is refused", async () => {
    const o = await h.user("Full House");
    const w = o.workspaceId;
    const late = await h.user("Late Joiner");
    const inv = await invite(o, w, late.email);
    // 48 more members: 1 owner + 48 + 1 pending = 50.
    const ids = Array.from({ length: 48 }, () => randomUUID());
    await h.admin.query("insert into auth.users (id, email, email_confirmed_at) select x, x::text || '@fill.invalid', now() from unnest($1::uuid[]) x", [ids]);
    await h.admin.query("delete from public.workspaces where id in (select workspace_id from public.workspace_members where user_id = any($1::uuid[]))", [ids]);
    await h.admin.query("insert into public.workspace_members (workspace_id, user_id, role) select $1, x, 'member' from unnest($2::uuid[]) x", [w, ids]);
    const full = await h.as(o).post("/organization/invitations", { email: "one-more@example.invalid" });
    assert.equal(full.statusCode, 409, full.body);
    assert.match(err(full).message, /50 members/);
    // One more member arrives by hand: the pending invitation can no longer be accepted.
    const extra = randomUUID();
    await h.admin.query("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [extra, `${extra}@fill.invalid`]);
    await h.admin.query("delete from public.workspaces where id in (select workspace_id from public.workspace_members where user_id = $1)", [extra]);
    await h.admin.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [w, extra]);
    const r = await accept(late, inv.token);
    assert.equal(r.statusCode, 409);
    assert.equal(Number((await h.admin.query("select count(*) from public.workspace_members where workspace_id = $1", [w])).rows[0].count), 50);
  });
});

// ---------------------------------------------------------------- nothing secret is kept

describe("tokens and passwords never reach logs or audit rows", () => {
  test("after inviting, accepting, revoking and creating database users, no token, link or password is stored or logged", async () => {
    const o = await h.user("Careful Owner");
    const p = await h.user("Careful Person");
    const tokens: string[] = [];
    const a = await invite(o, o.workspaceId, p.email, "admin");
    tokens.push(a.token, a.link);
    const b = await invite(o, o.workspaceId, "never@example.invalid");
    tokens.push(b.token, b.link);
    await h.as(o).post(`/organization/invitations/${b.id}/revoke`);
    await accept(p, b.token); // refused
    assert.equal((await accept(p, a.token)).statusCode, 200);
    const created = await h.as(o).post("/databases", { name: "careful-db-01", region: "eu-central-1" });
    const pw = json(created).initialUser?.password as string | undefined;
    if (pw) tokens.push(pw);
    const tables = ["audit_log", "data_audit_log", "workspace_invites", "operations", "idempotency_keys", "workspaces", "workspace_members"];
    let dump = "";
    for (const t of tables) dump += JSON.stringify((await h.admin.query(`select * from public.${t}`)).rows);
    const logs = h.logs.text();
    for (const t of tokens) {
      assert.ok(!dump.includes(t), "a token or password is in a table");
      assert.ok(!logs.includes(t), "a token or password is in the logs");
    }
    assert.ok(!logs.includes(p.email) && !logs.includes("never@example.invalid"), "no invited e-mail in the logs");
    const audit = (await h.admin.query("select action, metadata from public.audit_log where workspace_id = $1 and action like 'invitation.%' order by id", [o.workspaceId])).rows;
    assert.deepEqual(audit.map((r) => r.action), ["invitation.create", "invitation.create", "invitation.revoke", "invitation.accept", "invitation.accept"]);
    assert.deepEqual(audit[3].metadata, { reason: "revoked" }, "the refusal is recorded for the organization, with its reason, without the token");
  });
});
