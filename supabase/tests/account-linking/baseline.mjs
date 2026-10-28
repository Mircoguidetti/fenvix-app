// Part 1: what the real GoTrue does with the cases from the report, before any change of ours.
// Prints what happened; it asserts nothing (scenarios.mjs holds the assertions for the fix).
import { oauth, requestEmailLink, openLink, snapshot, gh, google, sql } from "./lab.mjs";

const run = Date.now().toString(36);
const show = (title, r, email) => {
  console.log(`\n### ${title}`);
  console.log("  result:", r.ok ? `signed in as ${r.userId} <${r.email}>` : `refused: ${r.error} / ${r.code} / ${r.description}`);
  for (const u of snapshot(email)) console.log("  user", u.id.slice(0, 8), u.email, "confirmed:", u.confirmed, "identities:", JSON.stringify(u.identities), "workspaces:", (u.workspaces ?? []).length);
};

// A: Google first, then GitHub with the same address verified and primary on GitHub.
{
  const e = `a-${run}@example.com`;
  show("A1 Google, verified", await oauth("keycloak", google(`g-a-${run}`, e)), e);
  show("A2 GitHub, same address, verified + primary", await oauth("github", gh(1000 + Number.parseInt(run.slice(-4), 36), `a${run}`, [{ email: e, verified: true, primary: true }])), e);
}
// B: GitHub where the address is on the account but NOT verified on GitHub.
{
  const e = `b-${run}@example.com`;
  show("B1 Google, verified", await oauth("keycloak", google(`g-b-${run}`, e)), e);
  show("B2 GitHub, same address, UNVERIFIED on GitHub", await oauth("github", gh(2000 + Number.parseInt(run.slice(-4), 36), `b${run}`, [{ email: e, verified: false, primary: true }])), e);
}
// C: GitHub whose primary address is a different one (work vs personal), Google address absent.
{
  const e = `c-${run}@example.com`;
  const other = `c-other-${run}@example.org`;
  show("C1 Google, verified", await oauth("keycloak", google(`g-c-${run}`, e)), e);
  const r = await oauth("github", gh(3000 + Number.parseInt(run.slice(-4), 36), `c${run}`, [{ email: other, verified: true, primary: true }]));
  show("C2 GitHub, primary is another verified address", r, other);
}
// D: GitHub with only the private noreply address (e.g. after "Keep my email addresses private").
{
  const e = `d-${run}@example.com`;
  const noreply = `${run}+d@users.noreply.github.com`;
  show("D1 Google, verified", await oauth("keycloak", google(`g-d-${run}`, e)), e);
  show("D2 GitHub, only noreply verified primary", await oauth("github", gh(4000 + Number.parseInt(run.slice(-4), 36), `d${run}`, [{ email: noreply, verified: true, primary: true }])), noreply);
}
// E: GitHub where the Google address is verified but NOT primary (primary is noreply).
{
  const e = `e-${run}@example.com`;
  const noreply = `${run}+e@users.noreply.github.com`;
  show("E1 Google, verified", await oauth("keycloak", google(`g-e-${run}`, e)), e);
  show("E2 GitHub, primary noreply, same address verified secondary", await oauth("github", gh(5000 + Number.parseInt(run.slice(-4), 36), `e${run}`, [{ email: noreply, verified: true, primary: true }, { email: e, verified: true, primary: false }])), e);
}
// F: email link first (clicked), then Google.
{
  const e = `f-${run}@example.com`;
  const l = await requestEmailLink(e);
  show("F1 email link, clicked", await openLink(l.link), e);
  show("F2 Google, verified", await oauth("keycloak", google(`g-f-${run}`, e)), e);
}
// G: someone asks for a link for the address but never clicks it; then the owner uses Google.
{
  const e = `g-${run}@example.com`;
  await requestEmailLink(e);
  show("G1 email link requested, never clicked", { ok: false, error: "(not clicked)" }, e);
  show("G2 Google, verified", await oauth("keycloak", google(`g-g-${run}`, e)), e);
}
// H: an attacker's provider says the victim's address but it is not verified there.
{
  const e = `h-${run}@example.com`;
  show("H1 victim, Google verified", await oauth("keycloak", google(`g-h-${run}`, e)), e);
  show("H2 attacker, OIDC with the victim's address, email_verified=false", await oauth("keycloak", google(`attacker-h-${run}`, e, false)), e);
}
// I: unverified identity first, then the real owner.
{
  const e = `i-${run}@example.com`;
  show("I1 attacker first, OIDC email_verified=false", await oauth("keycloak", google(`attacker-i-${run}`, e, false)), e);
  show("I2 owner, Google verified", await oauth("keycloak", google(`g-i-${run}`, e)), e);
}
console.log("\nworkspaces in total:", sql("select count(*) as n from public.workspaces")[0].n);
