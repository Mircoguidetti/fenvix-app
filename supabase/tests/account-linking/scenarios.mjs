// The account linking rules (0006_account_linking.sql), checked against the real Supabase Auth
// server with made-up people. Every scenario uses fresh addresses, so it can run again on the same
// scratch database. Exits non-zero on the first broken rule.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { oauth, requestEmailLink, openLink, linkIdentity, identities, unlink, snapshot, gh, google, sql, exec, follow, DB, AUTH, FAKE } from "./lab.mjs";
import { SupabaseGateway } from "../../../control-plane/src/auth/gateway.ts";

const mergeScript = (name, vars) => {
  const file = fileURLToPath(new URL(`../../account-merge/${name}`, import.meta.url));
  const r = spawnSync("psql", [DB, ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-f", file], { encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout + r.stderr };
};

const run = Date.now().toString(36);
let ghId = 10_000_000 + Math.floor(Math.random() * 1_000_000);
const nextGh = () => ++ghId;
const addr = (tag) => `${tag}-${run}@example.com`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let passed = 0;

function check(cond, what) {
  if (cond) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}`); }
}
/** Accounts that have the address, their workspaces, and the workspaces in total for them. */
function people(email) {
  const users = snapshot(email);
  return { users, accounts: users.length, workspaces: users.reduce((n, u) => n + (u.workspaces ?? []).length, 0) };
}
const refusedSameWay = (r) => !r.ok && ["provider_email_needs_verification", "unexpected_failure"].includes(r.code);

async function scenario(title, fn) {
  console.log(`\n${title}`);
  try { await fn(); } catch (e) { failed++; console.log(`  FAIL threw: ${e.stack ?? e}`); }
}

await scenario("1. Google, then GitHub with the same verified address: one account, one workspace", async () => {
  const e = addr("s1");
  const a = await oauth("keycloak", google(`g-${e}`, e));
  const b = await oauth("github", gh(nextGh(), `s1${run}`, [{ email: e, verified: true, primary: true }]));
  check(a.ok && b.ok && a.userId === b.userId, "both sign-ins reach the same account");
  const p = people(e);
  check(p.accounts === 1 && p.workspaces === 1, `one account and one workspace (got ${p.accounts} / ${p.workspaces})`);
});

await scenario("2. The reported bug: GitHub address unverified at first, verified later", async () => {
  const e = addr("s2");
  const a = await oauth("keycloak", google(`g-${e}`, e));
  const profile = gh(nextGh(), `s2${run}`, [{ email: e, verified: false, primary: true }]);
  const b = await oauth("github", profile);
  check(refusedSameWay(b), `the unverified GitHub sign-in is refused (${b.code})`);
  check(people(e).accounts === 1, "no shadow account was made");
  profile.emails[0].verified = true;
  const c = await oauth("github", profile);
  check(c.ok && c.userId === a.userId, "once verified on GitHub, GitHub reaches the Google account");
  const p = people(e);
  check(p.accounts === 1 && p.workspaces === 1, `still one account and one workspace (got ${p.accounts} / ${p.workspaces})`);
});

await scenario("3. An unverified address never reaches someone else's account (Google stand-in, email_verified=false)", async () => {
  const e = addr("s3");
  const victim = await oauth("keycloak", google(`g-${e}`, e));
  const attacker = await oauth("keycloak", google(`attacker-${e}`, e, false));
  check(!attacker.ok, "the attacker is refused");
  check(people(e).accounts === 1, "and no account is made for them");
  check(victim.ok, "the owner is unaffected");
});

await scenario("4. Unverified address with no account yet: verification by email is required", async () => {
  const e = addr("s4");
  const r = await oauth("keycloak", google(`g-${e}`, e, false));
  check(!r.ok && r.code === "provider_email_needs_verification", "refused until the address is verified");
  const u = people(e);
  check(u.accounts === 1 && !u.users[0].confirmed && u.workspaces === 0, "an unconfirmed sign-up exists with no workspace and no access");
});

await scenario("5. Someone else's unverified identity is dropped when the owner signs in", async () => {
  const e = addr("s5");
  const attackerProfile = google(`attacker-${e}`, e, false);
  await oauth("keycloak", attackerProfile);
  await wait(1100);
  const link = await requestEmailLink(e);
  const owner = await openLink(link.link);
  check(owner.ok, "the owner signs in with the emailed link");
  const again = await oauth("keycloak", attackerProfile);
  check(!again.ok, "the attacker's identity no longer signs in");
  const p = people(e);
  check(p.accounts === 1 && p.workspaces === 1, `one account and one workspace (got ${p.accounts} / ${p.workspaces})`);
  check(!p.users[0].identities.some((i) => i.provider === "keycloak"), "the attacker's identity is not on the account");
});

await scenario("6. An unclicked email link makes no workspace; Google then makes exactly one", async () => {
  const e = addr("s6");
  await requestEmailLink(e);
  check(people(e).workspaces === 0, "no workspace for an address nobody has confirmed");
  const g = await oauth("keycloak", google(`g-${e}`, e));
  const p = people(e);
  check(g.ok && p.accounts === 1 && p.workspaces === 1, `Google confirms it: one account, one workspace (got ${p.accounts} / ${p.workspaces})`);
});

await scenario("7. Email link first, then Google: one account", async () => {
  const e = addr("s7");
  const a = await openLink((await requestEmailLink(e)).link);
  const b = await oauth("keycloak", google(`g-${e}`, e));
  check(a.ok && b.ok && a.userId === b.userId, "same account");
  check(people(e).workspaces === 1, "one workspace");
});

await scenario("8. GitHub private address: noreply primary, real address verified as a secondary", async () => {
  const e = addr("s8");
  const a = await oauth("keycloak", google(`g-${e}`, e));
  const b = await oauth("github", gh(nextGh(), `s8${run}`, [{ email: `${run}s8@users.noreply.github.com`, verified: true, primary: true }, { email: e, verified: true, primary: false }]));
  check(b.ok && b.userId === a.userId, "GitHub reaches the existing account through the verified secondary address");
});

await scenario("9. GitHub with only a noreply address cannot open a new account", async () => {
  const noreply = `${run}s9@users.noreply.github.com`;
  const r = await oauth("github", gh(nextGh(), `s9${run}`, [{ email: noreply, verified: true, primary: true }]));
  check(!r.ok, `refused (${r.code})`);
  check(people(noreply).accounts === 0, "no account");
});

await scenario("10. Link GitHub from Settings (different, verified address) and unlink it", async () => {
  const e = addr("s10");
  const me = await oauth("keycloak", google(`g-${e}`, e));
  const work = addr("s10-work");
  const l = await linkIdentity(me.accessToken, "github", gh(nextGh(), `s10${run}`, [{ email: work, verified: true, primary: true }]));
  check(l.ok && l.userId === me.userId, "linked to the signed-in account");
  const ids = await identities(me.accessToken);
  check(ids.length === 2, `two sign-in methods (got ${ids.length})`);
  const gid = ids.find((i) => i.provider === "github");
  const out = await unlink(me.accessToken, gid.identity_id);
  check(out.ok, "GitHub unlinked while Google remains");
  const left = await identities(me.accessToken);
  const last = await unlink(me.accessToken, left[0].identity_id);
  check(!last.ok && last.error === "single_identity_not_deletable", "the last sign-in method cannot be unlinked");
  check(people(e).workspaces === 1, "one workspace throughout");
});

await scenario("11. Link GitHub from Settings with the account's own address unverified on GitHub", async () => {
  const e = addr("s11");
  await wait(1100);
  const me = await openLink((await requestEmailLink(e)).link);
  const l = await linkIdentity(me.accessToken, "github", gh(nextGh(), `s11${run}`, [{ email: e, verified: false, primary: true }]));
  check(l.ok && l.userId === me.userId, "allowed: it is the account's own address");
});

await scenario("12. Linking an identity that claims someone else's unverified address is refused", async () => {
  const victim = addr("s12-victim");
  const att = addr("s12-att");
  await wait(1100);
  const a = await openLink((await requestEmailLink(att)).link);
  const l = await linkIdentity(a.accessToken, "github", gh(nextGh(), `s12${run}`, [{ email: victim, verified: false, primary: true }]));
  check(!l.ok, `link refused (${l.code})`);
  const v = await oauth("keycloak", google(`g-${victim}`, victim));
  check(v.ok && v.userId !== a.userId, "the victim gets an account of their own, not the attacker's");
});

await scenario("13. Linking an identity whose address belongs to another account is refused", async () => {
  const other = addr("s13-other");
  const mine = addr("s13-mine");
  const o = await oauth("keycloak", google(`g-${other}`, other));
  const me = await oauth("keycloak", google(`g-${mine}`, mine));
  const l = await linkIdentity(me.accessToken, "github", gh(nextGh(), `s13${run}`, [{ email: other, verified: true, primary: true }]));
  check(o.ok && !l.ok, `refused (${l.code})`);
  check(people(other).accounts === 1, "nothing changed for the other account");
});

await scenario("14. A shadow made before 0006 cannot become a second account", async () => {
  const e = addr("s14");
  await oauth("keycloak", google(`g-${e}`, e));
  const profile = gh(nextGh(), `s14${run}`, [{ email: e, verified: false, primary: true }]);
  exec("alter table auth.identities disable trigger fenvix_guard_identity");
  try { await oauth("github", profile); } finally { exec("alter table auth.identities enable trigger fenvix_guard_identity"); }
  check(people(e).accounts === 2, "(set-up: the old behaviour made a shadow)");
  profile.emails[0].verified = true;
  const r = await oauth("github", profile);
  check(!r.ok, `the shadow cannot be confirmed into a second account (${r.code})`);
  const p = people(e);
  check(p.users.filter((u) => u.confirmed).length === 1, "only one confirmed account; the shadow is left for the merge script");
});

await scenario("15. An email link for an address another account carries on an identity makes no second account", async () => {
  const e = addr("s15");
  const work = addr("s15-work");
  const me = await oauth("keycloak", google(`g-${e}`, e));
  await linkIdentity(me.accessToken, "github", gh(nextGh(), `s15${run}`, [{ email: work, verified: true, primary: true }]));
  await wait(1100);
  const r = await requestEmailLink(work);
  check(r.link === null, `no link is sent (status ${r.status})`);
  check(sql(`select count(*)::int as n from auth.users where email = '${work}'`)[0].n === 0, "no account for the address");
});

await scenario("16. A different verified address on GitHub is a different account (the rule is per address)", async () => {
  const e = addr("s16");
  const other = addr("s16-other");
  const a = await oauth("keycloak", google(`g-${e}`, e));
  const b = await oauth("github", gh(nextGh(), `s16${run}`, [{ email: other, verified: true, primary: true }]));
  check(a.ok && b.ok && a.userId !== b.userId, "two accounts: nothing proves they are the same person (link from Settings instead)");
});

await scenario("17. A duplicate made before 0006, merged with the script: GitHub then reaches the kept account", async () => {
  const e = addr("s17");
  const google1 = await oauth("keycloak", google(`g-${e}`, e));
  const profile = gh(nextGh(), `s17${run}`, [{ email: e, verified: false, primary: true }]);
  // The old behaviour, in full: shadow first, then confirmed when the address is verified on GitHub.
  exec("alter table auth.identities disable trigger fenvix_guard_identity; alter table auth.users disable trigger fenvix_guard_user_confirm");
  let dup;
  try {
    await oauth("github", profile);
    profile.emails[0].verified = true;
    dup = await oauth("github", profile);
  } finally {
    exec("alter table auth.identities enable trigger fenvix_guard_identity; alter table auth.users enable trigger fenvix_guard_user_confirm");
  }
  check(dup.ok && dup.userId !== google1.userId, "(set-up: two accounts, as in the report)");
  sql(`select public.ensure_workspace('${dup.userId}', null, 'GitHub duplicate')`);
  const dry = mergeScript("merge_accounts.sql", { keep_user: google1.userId, drop_user: dup.userId });
  check(dry.ok && /DRY RUN/.test(dry.out) && people(e).accounts === 2, "the dry run changes nothing");
  const done = mergeScript("merge_accounts.sql", { keep_user: google1.userId, drop_user: dup.userId, execute: 1 });
  check(done.ok, "merged");
  const after = await oauth("github", profile);
  check(after.ok && after.userId === google1.userId, "GitHub signs in to the kept account");
  const p = people(e);
  check(p.accounts === 1 && p.workspaces === 1, `one account and one workspace (got ${p.accounts} / ${p.workspaces})`);
  const undo = mergeScript("undo_merge.sql", { merge_id: sql("select max(id) as id from fenvix_account_merge.merges")[0].id, execute: 1 });
  const back = await oauth("github", profile);
  check(undo.ok && back.ok && back.userId === dup.userId, "undo puts the duplicate back exactly (GitHub reaches it again)");
});

await scenario("18. The control plane's Supabase gateway against the real Supabase Auth: PKCE sign-in, link, list, unlink", async () => {
  const gw = new SupabaseGateway(AUTH.replace(/\/auth\/v1$/, ""), "lab-anon-key");
  Object.defineProperty(gw, "base", { value: AUTH }); // the lab serves Supabase Auth at the root, not under /auth/v1
  const pkce = () => { const v = randomBytes(32).toString("base64url"); return { v, c: createHash("sha256").update(v).digest("base64url") }; };
  const e = addr("s18");
  await fetch(`${FAKE}/next`, { method: "POST", body: JSON.stringify({ provider: "keycloak", profile: google(`g-${e}`, e) }) });
  let p = pkce();
  const signIn = await follow(gw.authorizeUrl({ provider: "keycloak", redirectTo: "http://localhost:3000/cb", codeChallenge: p.c }));
  const tokens = await gw.exchangeCode({ code: signIn.code, codeVerifier: p.v });
  check(Boolean(tokens.accessToken), "PKCE sign-in");
  p = pkce();
  await fetch(`${FAKE}/next`, { method: "POST", body: JSON.stringify({ provider: "github", profile: gh(nextGh(), `s18${run}`, [{ email: e, verified: true, primary: true }]) }) });
  const linked = await follow(await gw.linkUrl({ accessToken: tokens.accessToken, provider: "github", redirectTo: "http://localhost:3000/cb", codeChallenge: p.c }));
  const after = await gw.exchangeCode({ code: linked.code, codeVerifier: p.v });
  const list = await gw.identities(after.accessToken);
  check(list.map((i) => i.provider).sort().join() === "github,keycloak", `linked: ${list.map((i) => i.provider).join(", ")}`);
  await gw.unlinkIdentity({ accessToken: after.accessToken, identityId: list.find((i) => i.provider === "github").id });
  const left = await gw.identities(after.accessToken);
  let lastRefused = "";
  try { await gw.unlinkIdentity({ accessToken: after.accessToken, identityId: left[0].id }); } catch (err) { lastRefused = err.code; }
  check(left.length === 1 && lastRefused === "single_identity_not_deletable", `unlinked, and the last one is kept (${lastRefused})`);
  p = pkce();
  const victim = addr("s18-victim");
  await oauth("keycloak", google(`g-${victim}`, victim));
  await fetch(`${FAKE}/next`, { method: "POST", body: JSON.stringify({ provider: "github", profile: gh(nextGh(), `s18b${run}`, [{ email: victim, verified: true, primary: true }]) }) });
  const refused = await follow(await gw.linkUrl({ accessToken: after.accessToken, provider: "github", redirectTo: "http://localhost:3000/cb", codeChallenge: p.c }));
  check(Boolean(refused.error) && !refused.code, `linking another account's address comes back as an error, no code (${refused.error})`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
