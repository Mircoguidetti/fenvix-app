// The dashboard itself, in a real browser, against the real Supabase Auth of this lab: sign-in,
// the emailed link, "Link GitHub" and "Remove" in Settings, and what a refused sign-in says.
// Run by run.sh after scenarios.mjs (it needs the lab's GoTrue, stand-in providers and database).
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DB, AUTH, FAKE, gh, sql } from "./lab.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { chromium } = createRequire(`${root}package.json`)("playwright");
const API = "http://127.0.0.1:54398";
const APP = "http://127.0.0.1:4176/";
const run = Date.now().toString(36);
let ghId = 20_000_000 + Math.floor(Math.random() * 1_000_000);

const SIGN_IN_REFUSED = /^That sign-in did not work\. If the email address of your GitHub or Google account is not verified there/;
const LINK_REFUSED = /^That account was not linked\./;

const procs = [];
process.on("exit", () => procs.forEach((p) => p.kill()));

console.log("  building the dashboard for this lab …");
const env = { ...process.env, VITE_DATA_BACKEND: "supabase", VITE_SUPABASE_URL: API, VITE_SUPABASE_ANON_KEY: "lab-anon-key" };
if (spawnSync("npx", ["vite", "build", "--outDir", "dist-lab", "--emptyOutDir"], { cwd: root, env, stdio: "ignore" }).status !== 0) throw new Error("build failed");
procs.push(spawn("node", ["scripts/fake-supabase.mjs"], { cwd: root, env: { ...process.env, TEST_DATABASE_URL: DB, REAL_AUTH_URL: AUTH, FAKE_SUPABASE_PORT: "54398" }, stdio: "ignore" }));
procs.push(spawn("npx", ["vite", "preview", "--outDir", "dist-lab", "--port", "4176", "--strictPort", "--host", "127.0.0.1"], { cwd: root, stdio: "ignore" }));
for (const url of [APP, `${API}/auth/v1/health`]) {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 250)); }
}

let passed = 0;
let failed = 0;
const check = (cond, what) => { if (cond) { passed++; console.log(`  ok   ${what}`); } else { failed++; console.log(`  FAIL ${what}`); } };
const next = (provider, profile) => fetch(`${FAKE}/next`, { method: "POST", body: JSON.stringify({ provider, profile }) });
const browser = await chromium.launch();
const fresh = async () => { const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); return { ctx, page: await ctx.newPage() }; };

async function githubSignIn(page, profile) {
  await next("github", profile);
  await page.goto(APP);
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
}
async function emailSignIn(page, email) {
  await fetch(`${FAKE}/mail/clear`);
  await page.goto(APP);
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByText("Check your inbox.").waitFor();
  let link = null;
  for (let i = 0; i < 40 && !link; i++) {
    const mail = await (await fetch(`${FAKE}/mail`)).json();
    const m = mail.find((x) => x.to.includes(email));
    link = m ? m.data.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).match(/http:\/\/127\.0\.0\.1:9998\/verify\?[^"'\s<>]+/)?.[0]?.replace(/&amp;/g, "&") : null;
    if (!link) await new Promise((r) => setTimeout(r, 250));
  }
  await page.goto(link);
}
const signedIn = (page) => page.locator(".shell").waitFor({ timeout: 20_000 });
async function methods(page) {
  await page.goto(`${APP}settings`);
  const card = page.locator("#sign-in");
  await card.locator(".identity").first().waitFor();
  return (await card.locator(".identity strong").allInnerTexts()).sort();
}
const accountsWith = (email) => Number(sql(`select count(*)::int as n from auth.users u where lower(u.email) = '${email}' or exists (select 1 from auth.identities i where i.user_id = u.id and i.email = '${email}')`)[0].n);
const workspacesOf = (email) => Number(sql(`select count(*)::int as n from public.workspace_members m join auth.users u on u.id = m.user_id where lower(u.email) = '${email}'`)[0].n);

async function step(title, fn) {
  console.log(`\n  ${title}`);
  try { await fn(); } catch (e) { failed++; console.log(`  FAIL threw: ${e.message.split("\n")[0]}`); }
}

const first = `ui-first-${run}@example.com`;

await step("GitHub sign-in with a verified address opens the dashboard; Settings lists GitHub", async () => {
  const { ctx, page } = await fresh();
  await githubSignIn(page, gh(++ghId, `ui1${run}`, [{ email: first, verified: true, primary: true }]));
  await signedIn(page);
  check(true, "signed in, the dashboard loaded (its workspace exists)");
  check((await methods(page)).join() === "GitHub", "Settings: GitHub");
  await ctx.close();
});

await step("The report, in the browser: email link first, then GitHub with the same address (unverified, then verified)", async () => {
  const e = `ui-report-${run}@example.com`;
  const { ctx, page } = await fresh();
  await emailSignIn(page, e);
  await signedIn(page);
  await ctx.close();

  const other = await fresh();
  const profile = gh(++ghId, `ui2${run}`, [{ email: e, verified: false, primary: true }]);
  await githubSignIn(other.page, profile);
  await other.page.getByRole("heading", { name: "Sign in to FENVIX" }).waitFor();
  const shown = await other.page.locator("[role=alert]").innerText();
  check(SIGN_IN_REFUSED.test(shown), "unverified on GitHub: refused with the fixed message");
  check(!other.page.url().includes("error"), "the address bar is clean");
  profile.emails[0].verified = true;
  await githubSignIn(other.page, profile);
  await signedIn(other.page);
  check((await methods(other.page)).join() === "Email link,GitHub", "verified: GitHub opens the same account (Settings: Email link, GitHub)");
  check(accountsWith(e) === 1 && workspacesOf(e) === 1, "one account, one workspace");
  await other.ctx.close();
});

await step("A refused sign-in reads the same whether or not the address has an account", async () => {
  const { ctx, page } = await fresh();
  await githubSignIn(page, gh(++ghId, `ui3${run}`, [{ email: first, verified: false, primary: true }]));
  await page.getByRole("heading", { name: "Sign in to FENVIX" }).waitFor();
  const existing = await page.locator("[role=alert]").innerText();
  await githubSignIn(page, gh(++ghId, `ui4${run}`, [{ email: `ui-nobody-${run}@example.com`, verified: false, primary: true }]));
  await page.getByRole("heading", { name: "Sign in to FENVIX" }).waitFor();
  const nobody = await page.locator("[role=alert]").innerText();
  check(existing === nobody && SIGN_IN_REFUSED.test(existing), "identical messages");
  await ctx.close();
});

await step("Settings: Link GitHub, refused for another account's address, then linked, then removed", async () => {
  const e = `ui-link-${run}@example.com`;
  const { ctx, page } = await fresh();
  await emailSignIn(page, e);
  await signedIn(page);
  check((await methods(page)).join() === "Email link", "starts with the email link only");
  const card = page.locator("#sign-in");
  check(await card.getByRole("button", { name: "Remove Email link" }).isDisabled(), "the only way in cannot be removed");

  await next("github", gh(++ghId, `ui5${run}`, [{ email: first, verified: true, primary: true }]));
  await card.getByRole("button", { name: "Link GitHub" }).click();
  await page.waitForURL(`${APP}settings`);
  const refused = await page.locator("#sign-in [role=alert]").innerText({ timeout: 20_000 });
  check(LINK_REFUSED.test(refused), "a GitHub account with another account's address is not linked, with the fixed message");

  await next("github", gh(++ghId, `ui6${run}`, [{ email: `ui-work-${run}@example.org`, verified: true, primary: true }]));
  await card.getByRole("button", { name: "Link GitHub" }).click();
  await page.waitForURL(`${APP}settings`);
  await page.getByText("GitHub is linked. You can sign in with it from now on.").waitFor({ timeout: 20_000 });
  check((await methods(page)).join() === "Email link,GitHub", "linked: Email link, GitHub");

  await page.locator("#sign-in").getByRole("button", { name: "Remove GitHub" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByText("GitHub removed").waitFor();
  check((await methods(page)).join() === "Email link", "removed again");
  check(workspacesOf(e) === 1, "one workspace throughout");
  await ctx.close();
});

await browser.close();
console.log(`\n  dashboard: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
