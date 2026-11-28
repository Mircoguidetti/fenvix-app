// Every page of the dashboard against the REAL API, locally: the local Supabase (Postgres + Supabase Auth in Docker,
// scripts/local-supabase/up.sh), the API (github-app/src/api/local.ts, connected as fenvix_api), the dashboard built
// for the API (not the mock), signed in with a real Supabase Auth session. For every page: every API answer is 2xx or
// 304, the page shows the seeded records, no console error, no axe violation (WCAG 2 A/AA), a screenshot. Then the live
// run view (polling with ETag/304, stops when the run ends), the Connect page after GitHub's redirect, the install link,
// the region (owner edits, member read only) and an invitation accepted by another person.
//
//   bash scripts/local-supabase/up.sh && node scripts/e2e-real-api.mjs
//
// Writes docs/screenshots-real-api/*.png and docs/screenshots-real-api/RESULTS.md.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { default: AxeBuilder } = await import("@axe-core/playwright");
const pg = (await import("../github-app/node_modules/pg/lib/index.js")).default;
const { seedOrg } = await import("../github-app/tests/api/seed.ts");

const STATE = process.env.LOCAL_SUPABASE_STATE ?? join(tmpdir(), "fenvix-local-supabase");
const env = Object.fromEntries(readFileSync(join(STATE, "env.sh"), "utf8").split("\n").filter((l) => l.startsWith("export ")).map((l) => l.slice(7).split("=")).map(([k, ...v]) => [k, v.join("=")]));
const SUPABASE = env.LOCAL_SUPABASE_URL;
const API_PORT = 8791;
const WEB_PORT = 4174;
const API = `http://127.0.0.1:${API_PORT}/v1`;
const WEB = `http://localhost:${WEB_PORT}`;
const OUT = "docs/screenshots-real-api";
mkdirSync(OUT, { recursive: true });

const results = [];
const failures = [];
const check = (page, ok, what) => { results.push({ page, ok, what }); if (!ok) failures.push(`${page}: ${what}`); console.log(`${ok ? "ok  " : "FAIL"} ${page}: ${what}`); };

// ---------------------------------------------------------------- people and data
const db = new pg.Client({ connectionString: env.LOCAL_DB_URL });
await db.connect();
const run = randomUUID().slice(0, 8);
async function signUp(label, name) {
  const email = `e2e-${run}-${label}@example.com`;
  const password = `pw-${randomUUID()}`;
  const r = await fetch(`${SUPABASE}/auth/v1/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, data: { full_name: name } }) });
  const s = await r.json();
  if (!r.ok || !s.access_token) throw new Error(`sign-up failed: ${JSON.stringify(s)}`);
  const ws = (await db.query("select workspace_id from workspace_members where user_id = $1", [s.user.id])).rows[0].workspace_id;
  return { email, password, session: s, userId: s.user.id, workspaceId: ws };
}
const owner = await signUp("owner", "Olive Owner");
const member = await signUp("member", "Max Member");
await db.query("update workspaces set name = 'Acme Robotics', name_confirmed = true where id = $1", [owner.workspaceId]);
await db.query("insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, member.userId]);
const account = `acme-${run}`;
const seeded = await seedOrg(db, owner.workspaceId, account);
// A second installation, suspended, so the Connect page shows several installations and their status.
const second = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
await db.query(`insert into gh_installations (installation_id, workspace_id, account_id, account_login, account_type, repository_selection, linked_at, suspended_at)
                values ($1, $2, $3, $4, 'User', 'all', now() - interval '3 days', now() - interval '1 day')`, [second, owner.workspaceId, second, `olive-${run}`]);
// Every onboarding state on a repository of that installation.
const STATES = ["pending", "pr_open", "merged", "closed", "no_workflow", "no_test_job", "already_fenvix", "unsupported", "failed"];
for (const [i, st] of STATES.entries()) {
  await db.query(`insert into gh_repositories (repository_id, installation_id, full_name, private, onboarding_state, onboarding_detail, setup_pr_number, setup_pr_url, detected_language, detected_test_runner)
                  values ($1, $2, $3, true, $4, $5, $6, $7, $8, $9)`,
    [second + 1 + i, second, `olive-${run}/repo-${st.replace(/_/g, "-")}`, st, `Detail for ${st}.`, ["pr_open", "merged", "closed"].includes(st) ? 10 + i : null,
      ["pr_open", "merged", "closed"].includes(st) ? `https://github.com/olive-${run}/repo-${st}/pull/${10 + i}` : null, i % 2 ? "node" : "python", i % 2 ? "jest" : "pytest"]);
}

// The shared cache (warm-ups, migration 0017): shop warm since a commit with a warm-up running for the next one; one
// onboarded repository whose last warm-up could not run the job.
const WARM_SHA = "4a7c2e9" + "0".repeat(33);
const NEXT_SHA = "b81f0d3" + "0".repeat(33);
await db.query("update gh_repositories set cache_warm_sha = $2, cache_warm_at = now() - interval '2 hours', cache_warm_source = 'warmup', cache_warm_pushed_at = now() - interval '2 hours' where repository_id = $1", [seeded.repoIds.shop, WARM_SHA]);
await db.query(`insert into gh_warmups (repository_id, installation_id, commit_sha, ref, trigger, status, detail) values ($1, $2, $3, 'refs/heads/main', 'push', 'running', 'running the test job')`,
  [seeded.repoIds.shop, seeded.installationId, NEXT_SHA]);
await db.query(`insert into gh_warmups (repository_id, installation_id, commit_sha, ref, trigger, status, detail, finished_at) values ($1, $2, $3, 'refs/heads/main', 'push', 'unsupported', 'the job needs the outputs of job build', now())`,
  [second + 3, second, "c".repeat(40)]);

// ---------------------------------------------------------------- the API and the dashboard
const apiProc = spawn("node", ["src/api/local.ts"], {
  cwd: "github-app", stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, API_DATABASE_URL: env.LOCAL_API_DATABASE_URL, SUPABASE_URL: SUPABASE, STATE_SIGNING_KEY: `local-state-${randomUUID()}`, DASHBOARD_URL: WEB, GITHUB_APP_SLUG: "fenvix-local", PORT: String(API_PORT), HOST: "127.0.0.1", LOG_LEVEL: "warn", WORK_LOG: "1" },
});
const dist = join(tmpdir(), `fenvix-e2e-dist-${run}`);
const build = spawnSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], { stdio: "inherit", env: { ...process.env, VITE_DATA_BACKEND: "api", VITE_API_URL: API, VITE_SUPABASE_URL: SUPABASE, VITE_SUPABASE_ANON_KEY: "local-anon-key" } });
if (build.status !== 0) throw new Error("dashboard build failed");
// Its own process group, so that stopping it also stops the vite process npx starts (a stale preview server on the port
// would serve an old build).
const web = spawn("npx", ["vite", "preview", "--outDir", dist, "--port", String(WEB_PORT), "--strictPort"], { stdio: "ignore", detached: true });
const stopAll = () => { apiProc.kill(); try { process.kill(-web.pid); } catch { /* gone */ } };
process.on("exit", stopAll);
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${WEB}/`)).ok && (await fetch(`${API}/me`)).status === 401) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 200));
}

// ---------------------------------------------------------------- the browser, signed in with the real session
const browser = await chromium.launch();
const storageKey = `sb-${new URL(SUPABASE).hostname.split(".")[0]}-auth-token`;
async function signedIn(person, { width = 1440, height = 1000, scheme = "light", ws = person.workspaceId } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 1 });
  const s = person.session;
  await ctx.addInitScript(([k, v, ws]) => { localStorage.setItem(k, v); localStorage.setItem("fenvix-org", ws); }, [storageKey, JSON.stringify({ ...s, expires_at: Math.floor(Date.now() / 1000) + 3600 }), ws]);
  const page = await ctx.newPage();
  page.apiLog = [];
  page.consoleErrors = [];
  page.on("response", (r) => { if (r.url().startsWith(API)) page.apiLog.push({ url: r.url().slice(API.length), status: r.status(), method: r.request().method() }); });
  page.on("console", (m) => { if (m.type() === "error") page.consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => page.consoleErrors.push(String(e)));
  return page;
}

const P = seeded.projects.shop;
const pages = [
  ["overview", "/overview", [account, "Proven identical"]],
  ["projects", "/projects", [`${account}/shop`, `${account}/web`, "Cache warm since 4a7c2e9", "Warming up b81f0d3", "Cache cold: the first run fills it"]],
  ["project-runs", `/projects/${P}`, ["Change number"]],
  ["project-defects", `/projects/${P}/defects`, ["test_count"]],
  ["project-skip-with-proof", `/projects/${P}/skip-with-proof`, ["rerun"]],
  ["project-nightly", `/projects/${P}/nightly`, ["Coming soon"]],
  ["project-time-to-green", `/projects/${P}/time-to-green`, ["green"]],
  ["project-settings", `/projects/${P}/settings`, ["Cache with proof"]],
  ["run", `/projects/${P}/runs/${seeded.runs.latest}`, ["test_total", "test_empty"]],
  ["run-failed", `/projects/${P}/runs/${seeded.runs.failed}`, ["failed"]],
  ["run-shadow", `/projects/${P}/runs/${seeded.runs.shadow}`, ["hadow"]],
  ["defects", "/defects", ["test_count"]],
  ["defect", `/defects/${seeded.defects.open}`, ["--det-seed=7", ".fenvix/defects/"]],
  ["usage", "/usage", [`${account}/shop`, "GitHub-hosted"]],
  ["billing", "/billing", ["$129", "$479", "$1,350", "$4,200", "Nightly exploration", "trial"]],
  ["members", "/settings/members", ["Olive Owner", "Max Member"]],
  ["settings", "/settings", ["Acme Robotics", "Region"]],
  ["api-keys", "/api-keys", ["oming soon"]],
  // Connect lists only repositories still to connect (connect redesign, 28 Nov): the warm-cache lines of connected
  // repositories are checked on /projects above, no longer here.
  ["connect", "/projects/connect", [account, `olive-${run}`, "uspended", "Pick a repository to connect", "See your projects"]],
];

async function visit(page, name, path, markers, { shot = true } = {}) {
  page.apiLog.length = 0;
  page.consoleErrors.length = 0;
  await page.goto(`${WEB}${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const text = await page.locator("body").innerText();
  const bad = page.apiLog.filter((r) => ![200, 201, 202, 204, 304].includes(r.status));
  check(name, page.apiLog.length > 0, `called the API (${page.apiLog.length} requests: ${[...new Set(page.apiLog.map((r) => `${r.method} ${r.url.split("?")[0]}`))].join(", ")})`);
  check(name, bad.length === 0, `every API answer 2xx/304${bad.length ? `; got ${bad.map((b) => `${b.status} ${b.method} ${b.url}`).join(", ")}` : ""}`);
  check(name, !/sign in to fenvix|sample data/i.test(text) || name === "never", "signed in, real data (no sign-in page, no sample-data label)");
  for (const m of markers) check(name, text.includes(m), `shows "${m}"`);
  check(name, page.consoleErrors.length === 0, `no console errors${page.consoleErrors.length ? `: ${page.consoleErrors.slice(0, 3).join(" | ")}` : ""}`);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  check(name, axe.violations.length === 0, `axe: ${axe.violations.length ? axe.violations.map((v) => `${v.id} (${v.nodes.map((n) => n.target.join(" ")).join("; ")})`).join(", ") : "no violations"}`);
  if (process.env.DEBUG_AXE) for (const v of axe.violations) for (const n of v.nodes) console.log(`  ${v.id}: ${n.html.slice(0, 400)}\n    ${n.failureSummary}`);
  if (shot) await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  return text;
}

// Every page, as the owner, desktop light; then phone dark for each.
const ownerPage = await signedIn(owner);
for (const [name, path, markers] of pages) await visit(ownerPage, name, path, markers);
const phone = await signedIn(owner, { width: 390, height: 844, scheme: "dark" });
for (const [name, path] of pages) {
  await phone.goto(`${WEB}${path}`, { waitUntil: "networkidle" });
  await phone.waitForTimeout(300);
  await phone.screenshot({ path: `${OUT}/${name}-390-dark.png`, fullPage: true });
}
await phone.context().close();

// ---------------------------------------------------------------- the live run view
{
  const page = ownerPage;
  page.apiLog.length = 0;
  await page.goto(`${WEB}/projects/${P}/runs/${seeded.runs.running}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${OUT}/run-live-before.png`, fullPage: true });
  await page.waitForTimeout(9000);
  const runPath = `/runs/${seeded.runs.running}`;
  const polls = page.apiLog.filter((r) => r.url.startsWith(runPath) && !r.url.includes("/tests") && !r.url.includes("/files"));
  check("run-live", polls.filter((r) => r.status === 304).length >= 1, `polls with If-None-Match and gets 304 while nothing changes (${polls.map((r) => r.status).join(",")})`);
  await db.query(`update ci_runs set progress = progress || '{"testsDone": 137, "passed": 120, "skippedWithProof": 16, "currentTest": "tests/test_live.py::test_moving"}'::jsonb, progress_at = now() where id = $1`, [seeded.runs.running]);
  await page.waitForFunction(() => document.body.innerText.includes("test_moving"), null, { timeout: 10000 }).then(() => check("run-live", true, "a progress update appears within one poll (200 with a new ETag)"), () => check("run-live", false, "progress update did not appear"));
  await page.screenshot({ path: `${OUT}/run-live-after.png`, fullPage: true });
  await db.query(`update ci_runs set status = 'passed', finished_at = now(), tests_ran = 40, tests_passed = 40, tests_skipped = 160, tests_total = 200 where id = $1`, [seeded.runs.running]);
  await page.waitForTimeout(6000);
  const before = page.apiLog.length;
  await page.waitForTimeout(10000);
  const after = page.apiLog.slice(before).filter((r) => r.url.startsWith(runPath));
  check("run-live", after.length === 0, `polling stops once the run finished (${after.length} requests in the 10 s after)`);
  const t = await page.locator("body").innerText();
  check("run-live", !/test_moving/.test(t) || /passed/i.test(t), "shows the finished run");
}

// ---------------------------------------------------------------- Connect: GitHub's redirect, the install link
{
  const page = ownerPage;
  const text = await visit(page, "connect-connected", `/projects/connect?github=connected&installation=${seeded.installationId}&account=${account}`, [account], { shot: true });
  check("connect-connected", text.includes(`The fenvix GitHub App is installed on ${account}`), "says the App is installed on the account GitHub sent back");
  // Connected repositories are on /projects, not on Connect (connect redesign, 28 Nov); every other state is listed,
  // to connect or under "Waiting for your merge".
  const CONNECTED = new Set(["merged", "already_fenvix", "side_by_side"]);
  for (const st of STATES) check("connect", text.includes(`repo-${st.replace(/_/g, "-")}`) !== CONNECTED.has(st), CONNECTED.has(st) ? `leaves out the connected repository in state ${st}` : `lists the repository in state ${st}`);
  await visit(page, "connect-error", "/projects/connect?github=error&reason=not_admin", [], { shot: true });
  let installUrl = null;
  await page.route("https://github.com/**", (route) => { installUrl = route.request().url(); return route.abort(); });
  await page.goto(`${WEB}/projects/connect`, { waitUntil: "networkidle" });
  // "Connect <repo>" opens a setup pull request now: the install link is "Install the GitHub App" or "Add another account".
  const btn = page.getByRole("button", { name: /^(Install the GitHub App|Add another account)$/ }).first();
  if (await btn.count()) {
    await btn.click();
    await page.waitForTimeout(1500);
    check("connect", !!installUrl && installUrl.startsWith("https://github.com/apps/fenvix-local/installations/new?state="), `install button goes to GitHub with a signed state (${installUrl ? installUrl.split("?")[0] : "no navigation"})`);
  } else check("connect", false, "no install button found");
  await page.unroute("https://github.com/**");

  // GitHub's return after the App checked the GitHub side (review R-016 F2): ?github=confirm#completion=<code>. The page
  // completes the link through the API with the signed-in person's session; another person's code links nothing.
  const pending = 990_000_000 + Math.floor(Math.random() * 1_000_000);
  const pendingLogin = `globex-${pending}`;
  await db.query(`insert into public.gh_installations (installation_id, account_id, account_login, account_type, repository_selection) values ($1, $2, $3, 'Organization', 'selected')`, [pending, pending, pendingLogin]);
  const completion = async (userId, code) => db.query(
    `insert into public.gh_install_completions (code_hash, state_hash, installation_id, workspace_id, user_id, github_user_id, github_login, expires_at)
     values (encode(sha256($1::bytea), 'hex'), encode(sha256(('state-' || $1)::bytea), 'hex'), $2, $3, $4, 1, 'gh-admin', now() + interval '10 minutes')`,
    [code, pending, owner.workspaceId, userId]);
  const linked = async () => (await db.query("select workspace_id from public.gh_installations where installation_id = $1", [pending])).rows[0].workspace_id;
  const memberCode = `member-${randomUUID()}`;
  await completion(member.userId, memberCode);
  await page.goto(`${WEB}/projects/connect?github=confirm&installation=${pending}&account=${pendingLogin}#completion=${memberCode}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => /not valid for your account/.test(document.body.innerText), null, { timeout: 10000 }).then(
    () => check("connect-confirm", true, "a code made for another person: refused in words, nothing connected"), () => check("connect-confirm", false, "no refusal shown for another person's code"));
  check("connect-confirm", (await linked()) === null, "another person's code linked nothing");
  check("connect-confirm", !page.url().includes("completion="), "the code left the address bar");
  const ownCode = `owner-${randomUUID()}`;
  await completion(owner.userId, ownCode);
  await page.goto(`${WEB}/projects/connect?github=confirm&installation=${pending}&account=${pendingLogin}#completion=${ownCode}`, { waitUntil: "networkidle" });
  await page.waitForFunction((a) => document.body.innerText.includes(`The fenvix GitHub App is installed on ${a}`), pendingLogin, { timeout: 10000 }).then(
    () => check("connect-confirm", true, "the person's own code: completed through the API, shown as connected"), () => check("connect-confirm", false, "the own code was not completed"));
  check("connect-confirm", (await linked()) === owner.workspaceId, "the installation is linked to the organization that asked");
  check("connect-confirm", !page.url().includes("completion="), "the code left the address bar");
  const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  check("connect-confirm", res.violations.length === 0, `axe: no violations${res.violations.length ? ` (${res.violations.map((v) => v.id).join(", ")})` : ""}`);
}

// ---------------------------------------------------------------- region: the owner changes it, a member cannot
{
  const page = ownerPage;
  await page.goto(`${WEB}/settings`, { waitUntil: "networkidle" });
  const eu = page.locator('input[type=radio][name=region][value=eu]');
  if (await eu.count()) {
    await eu.check();
    await page.getByRole("button", { name: "Save region" }).click();
    await page.waitForTimeout(1500);
    const r = (await db.query("select region from workspaces where id = $1", [owner.workspaceId])).rows[0].region;
    check("settings-region", r === "eu", `the owner sets the region to EU (stored: ${r})`);
  } else check("settings-region", false, "no EU control found");
  const mp = await signedIn(member, { ws: owner.workspaceId });
  await mp.goto(`${WEB}/settings`, { waitUntil: "networkidle" });
  await mp.waitForTimeout(400);
  const mt = await mp.locator("body").innerText();
  check("settings-region", (await mp.locator("input[name=region]").count()) === 0 && mt.includes("European Union") && mt.includes("Only an owner or admin can change the region."), "a member sees the region (European Union) read only, with no control to change it");
  await mp.screenshot({ path: `${OUT}/settings-member.png`, fullPage: true });
  await mp.context().close();
}

// ---------------------------------------------------------------- an invitation, accepted by the invited person
{
  const invitee = await signUp("invitee", "Ivy Invitee");
  const res = await fetch(`${API}/organization/invitations`, { method: "POST", headers: { authorization: `Bearer ${owner.session.access_token}`, "x-fenvix-workspace": owner.workspaceId, "content-type": "application/json" }, body: JSON.stringify({ email: invitee.email, role: "member" }) });
  const inv = await res.json();
  check("invite", res.status === 201 && inv.link?.includes("#token="), `owner creates an invitation (${res.status})`);
  const page = await signedIn(invitee);
  await page.goto(`${WEB}/invite#token=${inv.link.split("#token=")[1]}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/invite.png`, fullPage: true });
  const join = page.getByRole("button", { name: /join|accept/i }).first();
  if (await join.count()) { await join.click(); await page.waitForTimeout(1500); }
  const m = (await db.query("select role from workspace_members where workspace_id = $1 and user_id = $2", [owner.workspaceId, invitee.userId])).rows[0];
  check("invite", m?.role === "member", `the invited person joins as member (${m?.role ?? "not joined"})`);
  await page.context().close();
}

await browser.close();
await db.end();
stopAll();

const lines = [
  "# Every page against the real API (local)",
  "",
  `Run ${new Date().toISOString()} by scripts/e2e-real-api.mjs: local Supabase (Postgres + Supabase Auth in Docker), the API as fenvix_api, the dashboard built with VITE_API_URL, a real Supabase Auth session.`,
  "",
  `${results.filter((r) => r.ok).length} checks passed, ${failures.length} failed.`,
  "",
  "| Page | Check | Result |",
  "| --- | --- | --- |",
  ...results.map((r) => `| ${r.page} | ${r.what.replace(/\|/g, "\\|")} | ${r.ok ? "ok" : "**FAIL**"} |`),
  "",
];
writeFileSync(`${OUT}/RESULTS.md`, lines.join("\n"));
console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
process.exit(0);
