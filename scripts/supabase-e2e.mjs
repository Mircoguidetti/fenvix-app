// End to end test of the Supabase code path with no real Supabase project.
//
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/fenvix_scratch npm run test:e2e
//
// What runs for real: the built app, the real @supabase/supabase-js client with PKCE, the
// HashRouter redirect handling, the real SQL functions and row level security on a scratch
// Postgres. What is faked (scripts/fake-supabase.mjs): Google, GitHub, the email provider,
// GoTrue and PostgREST. So this proves the dashboard's own code; it cannot prove that your
// Google/GitHub apps, redirect URLs or keys are set up correctly.
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { choose } from "./lib.mjs";

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error("Set TEST_DATABASE_URL to an empty scratch database."); process.exit(2); }
if (/supabase\.(co|com)|pooler/.test(DB)) { console.error("Refusing to run against a hosted Supabase project."); process.exit(2); }

const API = "http://127.0.0.1:54399";
const APP = "http://127.0.0.1:4174/";
const procs = [];
const stopAll = () => procs.forEach((p) => p.kill());
process.on("exit", stopAll);

const psql = (...args) => spawnSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-q", ...args], { encoding: "utf8" });
const query = (text) => psql("-tA", "-c", text).stdout.trim();

// ------------------------------------------------------------------ fresh database, build, servers
console.log("preparing the scratch database …");
psql("-c", "drop schema if exists public cascade; drop schema if exists auth cascade; drop schema if exists extensions cascade; create schema public;");
for (const f of ["supabase/tests/local-stub.sql", "supabase/migrations/0001_init.sql", "supabase/seed.sql"]) {
  if (f.endsWith("seed.sql")) psql("-c", "insert into auth.users (email, raw_user_meta_data) values ('mircoguidetti1994@gmail.com', '{\"full_name\":\"Mirco Guidetti\"}') on conflict do nothing");
  const r = psql("-f", f);
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
}
psql("-c", "analyze");

console.log("building the app for the supabase backend …");
const buildEnv = { ...process.env, VITE_DATA_BACKEND: "supabase", VITE_SUPABASE_URL: API, VITE_SUPABASE_ANON_KEY: "local-anon-key" };
if (spawnSync("npx", ["vite", "build", "--outDir", "dist-e2e", "--emptyOutDir"], { env: buildEnv, stdio: "ignore" }).status !== 0) { console.error("build failed"); process.exit(1); }
console.log("building it once more with no settings at all …");
if (spawnSync("npx", ["vite", "build", "--outDir", "dist-e2e-noenv", "--emptyOutDir"], { env: { ...process.env, VITE_DATA_BACKEND: "supabase", VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "" }, stdio: "ignore" }).status !== 0) { console.error("build failed"); process.exit(1); }

procs.push(spawn("node", ["scripts/fake-supabase.mjs"], { env: { ...process.env, TEST_DATABASE_URL: DB }, stdio: "ignore" }));
procs.push(spawn("npx", ["vite", "preview", "--outDir", "dist-e2e", "--port", "4174", "--strictPort", "--host", "127.0.0.1"], { stdio: "ignore" }));
procs.push(spawn("npx", ["vite", "preview", "--outDir", "dist-e2e-noenv", "--port", "4175", "--strictPort", "--host", "127.0.0.1"], { stdio: "ignore" }));
for (const url of [APP, "http://127.0.0.1:4175/", `${API}/__last_email_link`]) {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 250)); }
}

// ------------------------------------------------------------------ tests
let failures = 0, passes = 0;
const steps = [];
const step = (name, fn) => steps.push([name, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };
const num = (t) => Number(String(t).replace(/[^\d.]/g, ""));

const browser = await chromium.launch();
async function newPage(viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, colorScheme: "light", reducedMotion: "reduce" });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
  page.setDefaultTimeout(20000);
  return { ctx, page };
}
const toast = async (page, text) => { const t = page.locator(".toast", { hasText: text }).first(); await t.waitFor(); await t.getByRole("button", { name: "Dismiss message" }).click(); };
const saved = async (page, trigger) => { const [d] = await Promise.all([page.waitForEvent("download"), trigger()]); return { name: d.suggestedFilename(), text: await readFile(await d.path(), "utf8") }; };
const dashboard = (page) => page.locator(".shell").waitFor();

step("missing settings: the sign-in page explains, it never goes blank", async () => {
  const { ctx, page } = await newPage();
  await page.goto("http://127.0.0.1:4175/");
  await page.locator(".signin-card").waitFor();
  const text = await page.locator("[role=alert]").innerText();
  assert(/VITE_SUPABASE_URL/.test(text) && /VITE_SUPABASE_ANON_KEY/.test(text), `message was: ${text}`);
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  assert((await page.locator("[role=alert]").count()) >= 1, "no message after clicking");
  assert(page.errors.length === 0, `page errors: ${page.errors[0]}`);
  await ctx.close();
});

let ownerContext;
step("sign in with Google: the ?code= is exchanged before the router, the URL ends on /overview", async () => {
  const { ctx, page } = await newPage();
  ownerContext = { ctx, page };
  await page.goto(APP + "databases"); // asked for a deep link while signed out
  await page.getByRole("heading", { name: "Sign in to FENVIX" }).waitFor();
  const seen = [];
  page.on("framenavigated", (f) => f === page.mainFrame() && seen.push(f.url()));
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await dashboard(page);
  assert(seen.some((u) => /[?&]code=/.test(u)), "the provider never sent the browser back with a code");
  const url = page.url();
  assert(!/[?&]code=/.test(url) && !url.includes("?"), `the code is still in the address bar: ${url}`);
  assert(new URL(url).pathname === "/overview", `expected to land on /overview, got ${new URL(url).pathname}`);
  assert(await page.evaluate(() => !!localStorage.getItem(Object.keys(localStorage).find((k) => /auth-token$/.test(k)) ?? "")), "no session was stored");
  // The SDK removes the verifier it used. It keeps a per-flow slot index of its own, which holds no secret that works twice.
  assert(!(await page.evaluate(() => Object.keys(localStorage).some((k) => /auth-token-code-verifier$/.test(k)))), "the PKCE code verifier was left behind");
});

step("the user menu shows the real name, email and photo", async () => {
  const { page } = ownerContext;
  await page.locator(".sidebar .user-btn").click();
  await page.locator(".account-panel .account-who").getByText("Mirco Guidetti").waitFor();
  await page.locator(".account-panel .account-who").getByText("mircoguidetti1994@gmail.com").waitFor();
  const img = page.locator(".sidebar .user-btn img.avatar-photo");
  assert((await img.count()) === 1 && (await img.getAttribute("src")).includes("avatars.githubusercontent.com"), "the avatar is not shown");
  await page.keyboard.press("Escape");
});

step("the session survives a reload and a router navigation", async () => {
  const { page } = ownerContext;
  await page.reload();
  await dashboard(page);
  await page.goto(APP + "billing");
  await page.getByRole("heading", { name: "Month to date" }).waitFor();
});

step("overview shows the seeded fleet", async () => {
  const { page } = ownerContext;
  await page.goto(APP + "overview");
  await page.getByRole("heading", { name: "Northwind Cloud" }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".kpi-value").length === 6 && document.querySelector(".kpi-value").textContent !== "");
  const k = await page.locator(".kpi-value").allTextContents();
  assert(k[0] === "3,000", `fleet size ${k[0]}`);
  assert(num(k[1]) > 150 && num(k[1]) < 400, `awake ${k[1]}`);
  assert(num(k[2]) > 2600, `asleep ${k[2]}`);
  assert((await page.locator(".chart svg").count()) >= 3, "charts are missing");
  assert((await page.locator('tbody td[data-label="Woke"]').count()) === 8, "wake-ups are missing");
  for (const r of ["24 h", "30 d", "7 d"]) { await page.getByRole("button", { name: r, exact: true }).click(); await page.waitForTimeout(400); }
  assert((await page.locator(".chart svg").count()) >= 3, "charts vanished after changing the range");
});

step("databases: 3,000, paged, filtered by tag, grouped by customer", async () => {
  const { page } = ownerContext;
  await page.goto(APP + "databases");
  await page.locator("tbody tr").first().waitFor();
  assert((await page.locator("tbody tr").count()) === 50, "first page is not 50 rows");
  assert(num(await page.locator(".counts-bar b").first().innerText()) === 3000, "count is not 3,000");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByText("Page 2 of 60").waitFor();
  await page.locator("#db-tag").fill("customer:acme-labs");
  await page.getByRole("button", { name: "Add tag filter" }).click();
  await page.waitForFunction(() => document.querySelector(".counts-bar b")?.textContent === "154");
  await page.getByRole("button", { name: "Remove tag filter customer:acme-labs" }).click();
  await choose(page, page.getByLabel("Group by tag"), "customer");
  await page.getByText("3,000 databases in 200 groups, grouped by customer").waitFor();
  await choose(page, page.getByLabel("Group by tag"), "");
});

let createdId;
step("create, duplicate name, tags, keep awake, fork, restore, export, erase", async () => {
  const { page } = ownerContext;
  await page.goto(APP + "databases/new");
  await page.getByLabel("Name", { exact: true }).fill("e2e-created-01");
  await choose(page, page.getByLabel("Region"), "us-east");
  await page.getByLabel("Tags").fill("customer:acme-labs env:prod");
  await page.getByRole("button", { name: "Create database" }).click();
  await page.getByRole("link", { name: "Open database" }).waitFor();
  const conn = await page.getByRole("textbox", { name: "Connection string" }).inputValue();
  assert(conn === "mongodb://app:<password>@e2e-created-01.db.fenvix.dev:27017/e2e_created_01?tls=true&authSource=e2e_created_01&authMechanism=SCRAM-SHA-256", conn);
  await toast(page, "Created database e2e-created-01");
  await page.goto(APP + "databases"); // leave the "created" screen, then open the form again
  await page.getByRole("link", { name: "Create database" }).click();
  await page.getByLabel("Name", { exact: true }).fill("e2e-created-01");
  await page.getByRole("button", { name: "Create database" }).click();
  await page.getByRole("alert").getByText("A database named e2e-created-01 already exists.").waitFor();

  await page.goto(APP + "databases?q=e2e-created-01");
  await page.getByRole("link", { name: "e2e-created-01" }).click();
  await page.getByRole("heading", { name: "e2e-created-01" }).waitFor();
  createdId = page.url().split("/").pop();
  assert(/^[0-9a-f-]{36}$/.test(createdId), `id ${createdId}`);
  await page.getByLabel("Add a tag").fill("team:data");
  await page.getByRole("button", { name: "Add tag", exact: true }).click();
  await toast(page, "Added tag team:data");
  await page.getByRole("button", { name: "Remove tag team:data" }).waitFor();
  await page.getByLabel("Keep awake").check();
  await toast(page, "e2e-created-01 will stay awake");
  await page.locator(".facts").getByText("Awake").first().waitFor();

  await page.getByRole("button", { name: "Fork", exact: true }).click();
  await page.getByLabel("Name of the copy").fill("e2e-created-01-fork");
  await page.getByRole("button", { name: "Fork and open" }).click();
  await page.getByRole("heading", { name: "e2e-created-01-fork" }).waitFor();
  await page.getByText("Forked from").waitFor();
  await page.getByText("customer:acme-labs").first().waitFor();

  await page.goto(APP + "databases/" + createdId);
  await page.getByRole("button", { name: "Restore to a point in time" }).click();
  await page.getByLabel("Date and time (UTC)").fill("2026-01-01T10:00");
  await page.getByRole("button", { name: "Restore database" }).click();
  await page.getByRole("dialog").getByRole("alert").getByText("before this database was created").waitFor();
  await page.keyboard.press("Escape");
  const file = await saved(page, () => page.getByRole("button", { name: "Export", exact: true }).click());
  assert(file.name === "fenvix-export-e2e-created-01.json" && JSON.parse(file.text).databases[0].name === "e2e-created-01", "export content");

  await page.getByRole("button", { name: "Erase", exact: true }).click();
  await page.getByLabel(/^Type e2e-created-01/).fill("e2e-created-01");
  await page.getByRole("button", { name: "Erase database" }).click();
  await toast(page, "Erased e2e-created-01");
  await page.goto(APP + "databases/" + createdId);
  await page.getByRole("heading", { name: "Database not found" }).waitFor();
  assert(query("select count(*) from public.databases where name like 'e2e-created-01%'") === "1", "the fork should remain, the original should be gone");
});

step("bulk actions: tag, keep awake, export, erase with a count", async () => {
  const { page } = ownerContext;
  await page.goto(APP + "databases?q=northwind-dev-0");
  await page.waitForFunction(() => Number(document.querySelector(".counts-bar b")?.textContent?.replace(/\D/g, "")) >= 3);
  const names = (await page.locator("tbody tr td a").allTextContents()).slice(0, 3);
  for (const n of names) await page.getByRole("checkbox", { name: `Select ${n}` }).check();
  await page.getByText("3 selected").waitFor();
  await page.getByRole("button", { name: "Add tag", exact: true }).click();
  await page.getByLabel("Tag (key:value)").fill("batch:e2e");
  await page.getByRole("dialog").getByRole("button", { name: "Add tag" }).click();
  await toast(page, "Added tag batch:e2e to 3 databases");
  await page.goto(APP + "databases?tag=batch:e2e");
  await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 3); // the table, not just the counts
  await page.getByRole("checkbox", { name: "Select all on this page" }).first().check();
  await page.getByRole("button", { name: "Keep awake on" }).click();
  await toast(page, "3 databases will stay awake");
  await page.waitForFunction(() => document.querySelectorAll(".kept").length === 3);
  await page.getByRole("checkbox", { name: "Select all on this page" }).first().check();
  const file = await saved(page, () => page.getByRole("button", { name: "Export", exact: true }).click());
  assert(JSON.parse(file.text).databases.length === 3, "bulk export");
  await page.getByRole("button", { name: "Erase", exact: true }).click();
  await page.getByRole("dialog", { name: "Erase 3 databases?" }).waitFor();
  await page.getByRole("button", { name: "Erase 3 databases" }).click();
  await toast(page, "Erased 3 databases");
  await page.getByText("No databases match these filters").waitFor();
});

step("usage: per database and per tag, sorted, CSV with every row", async () => {
  const { page } = ownerContext;
  await page.goto(APP + "usage");
  await page.locator("tbody tr").first().waitFor();
  const r = async () => (await page.locator('tbody td[data-label="Requests"]').allTextContents()).map(num);
  await choose(page, page.getByLabel("Sort by"), "requests:desc");
  await page.waitForFunction(() => document.querySelectorAll('tbody td[data-label="Requests"]').length === 50);
  await page.waitForTimeout(600); // let the re-sorted page replace the previous one
  const desc = await r();
  assert(desc.length === 50 && desc.every((v, i) => i === 0 || desc[i - 1] >= v), "not sorted high to low");
  const db = await saved(page, () => page.getByRole("button", { name: "Export CSV" }).click());
  const lines = db.text.trim().split("\n");
  const withUsage = Number(query("select count(distinct database_id) from public.usage_daily where day >= date_trunc('month', current_date)"));
  assert(lines[0] === "database,tags,storage_gb_avg,requests" && lines.length === withUsage + 1 && withUsage > 2900, `csv has ${lines.length - 1} rows, the database has ${withUsage} with usage this month`);
  assert(db.name.startsWith("fenvix-usage-") && db.name.endsWith("-databases.csv"), db.name);
  await toast(page, "CSV ready");
  await page.getByRole("button", { name: "Per tag" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".seg button")].some((b) => b.textContent === "Per tag" && b.getAttribute("aria-pressed") === "true"));
  await choose(page, page.locator("#u-key"), "customer");
  await page.getByRole("heading", { name: "Per customer" }).waitFor();
  await page.waitForFunction(() => document.querySelector('tbody td[data-label="Name"]')?.textContent?.startsWith("customer:"));
  const tag = await saved(page, () => page.getByRole("button", { name: "Export CSV" }).click());
  assert(tag.text.trim().split("\n")[0] === "tag,databases,storage_gb_avg,requests" && tag.text.trim().split("\n").length === 201, "per-tag csv");
  await toast(page, "CSV ready");
  assert((await page.locator(".legend-list li").count()) >= 2, "the stacked chart needs a legend");
});

step("billing: month to date, invoices, a real PDF, plans", async () => {
  const { page } = ownerContext;
  await page.goto(APP + "billing");
  await page.getByRole("heading", { name: "Month to date" }).waitFor();
  await page.waitForFunction(() => /\$\d/.test(document.querySelector(".big-number")?.textContent ?? ""));
  await page.waitForFunction(() => document.querySelectorAll("#invoices tbody tr").length === 6);
  assert((await page.locator("#invoices tbody tr").count()) === 6, "six months of invoices expected");
  const file = await saved(page, () => page.getByRole("button", { name: /^Download invoice FNX-/ }).first().click());
  assert(file.name.startsWith("FNX-") && file.text.startsWith("%PDF-"), "invoice download");
  const plans = (await page.locator(".plan-head h3").allTextContents()).join("|");
  assert(plans === "Open source|Managed|Dedicated|In your cloud", plans);
  assert(/current plan/i.test(await page.locator(".plan-current .tag").innerText()), "current plan not marked");
});

step("API keys: without the FENVIX API the page says so and offers no key", async () => {
  // Customers' keys are the public API's (fvx_), made by the control plane only. The dashboard's own fnx_ keys
  // (public.api_keys and its functions) are left as they are, but no screen offers them any more.
  const { page } = ownerContext;
  await page.goto(APP + "api-keys");
  await page.getByText("API keys need the FENVIX API, which this dashboard is not set up for (VITE_API_URL).").waitFor();
  assert(!(await page.getByRole("button", { name: "Create key" }).count()), "a key can be created without the FENVIX API");
});

step("settings: saving renames the workspace everywhere", async () => {
  const { page } = ownerContext;
  await page.goto(APP + "settings");
  await page.getByLabel("Workspace name").fill("Northwind Platform");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByText("Settings saved").waitFor();
  await page.goto(APP + "overview");
  await page.getByRole("heading", { name: "Northwind Platform" }).waitFor();
  assert(query("select name from public.workspaces limit 1") === "Northwind Platform", "not saved in the database");
});

step("sign out clears the session, and the next sign-in is a fresh one", async () => {
  const { page } = ownerContext;
  await page.locator(".sidebar .user-btn").click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in to FENVIX" }).waitFor();
  assert(!(await page.evaluate(() => Object.keys(localStorage).some((k) => /auth-token$/.test(k)))), "the session is still stored");
  await page.reload();
  await page.getByRole("heading", { name: "Sign in to FENVIX" }).waitFor();
  await ownerContext.ctx.close();
});

step("email link: the link comes back with ?code=, finishes before the router, lands on /overview", async () => {
  const { ctx, page } = await newPage();
  await page.goto(APP);
  await page.getByLabel("Work email").fill("not-an-email");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByRole("alert").getByText("valid email").waitFor();
  await page.getByLabel("Work email").fill("elena.marsh@northwind.cloud");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByText("We sent a sign-in link to elena.marsh@northwind.cloud").waitFor();
  const { link } = await (await fetch(`${API}/__last_email_link`)).json();
  assert(/\?code=/.test(link) && link.startsWith(APP), `link ${link}`);
  await page.goto(link); // what clicking the link in the mail does, in the same browser
  await dashboard(page);
  assert(!page.url().includes("code=") && new URL(page.url()).pathname === "/overview", page.url());
  await page.locator(".sidebar .user-btn").click();
  await page.locator(".account-panel .account-who").getByText("elena.marsh@northwind.cloud").waitFor();
  // A brand-new person gets an empty workspace of their own and can see none of the seeded fleet.
  await page.goto(APP + "databases");
  await page.getByText("No databases match these filters").waitFor();
  assert(query("select count(*) from public.workspaces") === "2", "a second workspace should exist");
  await ctx.close();
});

step("a replayed or tampered code is refused with a message, not a blank page", async () => {
  const { ctx, page } = await newPage();
  await page.goto(APP + "?code=does-not-exist");
  await page.getByRole("heading", { name: "Sign in to FENVIX" }).waitFor();
  const text = await page.locator("[role=alert]").innerText();
  assert(/invalid flow state|flow state|code/i.test(text), `message was: ${text}`);
  assert(!page.url().includes("code="), "the bad code was left in the address bar");
  await page.goto(APP + "?error=access_denied&error_description=Access+denied");
  await page.getByRole("heading", { name: "Sign in to FENVIX" }).waitFor();
  assert(/access denied/i.test(await page.locator("[role=alert]").innerText()), "a provider error was not shown");
  await ctx.close();
});

step("on a phone: sign in and the dashboard works", async () => {
  const { ctx, page } = await newPage({ width: 390, height: 844 });
  await page.goto(APP);
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await dashboard(page);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.locator(".drawer .user-btn").click();
  await page.locator(".drawer .account-panel .account-who").getByText("Mirco Guidetti").waitFor();
  assert(!(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)), "the page scrolls sideways");
  await ctx.close();
});

for (const [name, fn] of steps) {
  try { await fn(); passes++; console.log("ok  ", name); }
  catch (e) {
    failures++;
    console.log("FAIL", name, "\n     ", String(e.message).split("\n").slice(0, 3).join("\n      "));
    const pg = ownerContext?.page;
    if (pg && !pg.isClosed()) {
      await pg.screenshot({ path: "e2e-failure.png" }).catch(() => {});
      console.log("      page was at", pg.url(), "| headings:", (await pg.locator("h1, h2").allTextContents().catch(() => [])).join(" / "), "| alerts:", (await pg.locator("[role=alert]").allTextContents().catch(() => [])).join(" / "));
    }
  }
}
await browser.close();
stopAll();
console.log(failures ? `${failures} step(s) failed` : `supabase e2e: all ${passes} steps passed`);
process.exit(failures ? 1 : 0);
