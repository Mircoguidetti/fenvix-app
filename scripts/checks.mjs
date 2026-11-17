// Behaviour checks, run on desktop and on a phone-sized screen. Each test gets a fresh browser context
// (fresh data, signed out) and signs in through the real sign-in page unless it is testing sign-in.
// Usage: npm run check (builds, serves and runs everything), or with a preview server on :4173: npm run checks
import { readFile } from "node:fs/promises";
import { BANNED, BASE, VIEWPORTS, go, isMobile, launch, makeReporter, newPage, settled, signIn, visibleText, choose, flakyRun } from "./lib.mjs";

const { fail, pass, state } = makeReporter();
const browser = await launch();

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const num = (text) => Number(String(text).replace(/[^\d.]/g, ""));

/** Waits for a confirmation message and dismisses it so it never covers a button. */
async function toast(page, text) {
  const t = page.locator(".toast", { hasText: text }).first();
  await t.waitFor();
  await t.getByRole("button", { name: "Dismiss message" }).click();
}

async function openUserMenu(page, vp) {
  if (isMobile(vp)) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator(".cx-drawer .user-btn").click();
  } else {
    await page.locator(".cx-account .user-btn").click();
  }
}

async function savedFile(page, trigger) {
  const [download] = await Promise.all([page.waitForEvent("download"), trigger()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), text: await readFile(path, "utf8") };
}

/** Polls until `read` returns true. Lists keep the old rows while new ones load, so asserts must wait. */
async function eventually(read, message) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    try {
      if (await read()) return;
    } catch {
      /* the page is changing under us */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(message);
}


const ROUTES = ["overview", "projects", "projects/prj_homehub", "projects/prj_homehub?tab=setup", "projects/prj_homehub?tab=settings", "projects/connect", "defects", "defects/dfx_9a10", "usage", "billing", "api-keys", "settings", "settings/members"];

const TESTS = {
  async "phone top bar keeps its height on long pages, with room around the menu button"(page, vp) {
    if (!isMobile(vp)) return;
    for (const route of ["overview", "projects", "api-keys", "defects"]) {
      if (route === "overview") await signIn(page, route);
      else {
        await page.goto(BASE + route);
        await page.locator(".shell").waitFor();
        await settled(page);
      }
      const m = await page.evaluate(() => {
        const t = document.querySelector(".cx-top").getBoundingClientRect();
        const b = document.querySelector(".cx-menu").getBoundingClientRect();
        return { bar: t.height, above: b.top - t.top, below: t.bottom - b.bottom, long: document.querySelector(".cx-content").scrollHeight > innerHeight };
      });
      assert(m.bar >= 60, `${route}: the top bar is ${m.bar}px tall, not 60`);
      assert(m.above >= 12 && m.below >= 12, `${route}: the menu button has ${m.above}px above and ${m.below}px below`);
      if (route === "overview") assert(m.long, "overview is not longer than the screen, so it does not test the squeeze");
    }
  },

  async "sign in and out"(page, vp) {
    await go(page, "projects/prj_homehub");
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    assert(!(await page.locator(".shell").count()), "the dashboard is visible while signed out");
    const order = await page.evaluate(() => [...document.querySelectorAll(".signin-card button, .signin-card [type=submit]")].map((b) => b.textContent.trim()));
    assert(/GitHub/.test(order[0]) && /Google/.test(order[1]) && /sign-in link/.test(order[2]), `sign-in buttons out of order: ${order}`);

    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.getByRole("heading", { name: "northwind/homehub" }).waitFor(); // lands on the route that was asked for
    await openUserMenu(page, vp);
    await page.locator(".account-panel .account-who").getByText("Elena Marsh").waitFor();
    await page.reload(); // the session survives a reload
    await page.getByRole("heading", { name: "northwind/homehub" }).waitFor();
    await openUserMenu(page, vp);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    await toast(page, "Signed out");

    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.locator(".shell").waitFor();
    await openUserMenu(page, vp);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    await toast(page, "Signed out");

    await page.getByLabel("Work email").fill("not-an-email");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.getByRole("alert").getByText("valid email").waitFor();
    await page.getByLabel("Work email").fill("sam.rivera@northwind.cloud");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.getByText("We sent a sign-in link to sam.rivera@northwind.cloud").waitFor();
    await go(page, "?token=one-time");
    await page.getByRole("heading", { name: "Name your organization" }).waitFor();
    await page.getByLabel("Organization name").fill("Rivera Labs");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator(".shell").waitFor();
    // A new organization has nothing connected: the dashboard starts with "Connect a project".
    await page.getByRole("heading", { name: "Connect your first project" }).waitFor();
    await page.getByRole("link", { name: "Connect a project" }).first().click();
    await page.getByRole("heading", { name: "Connect a project", exact: true }).waitFor();
    await page.getByRole("button", { name: "Install on GitHub" }).waitFor();
  },

  async "nothing reads as a demo; sample data says so once"(page) {
    await go(page, "overview");
    await settled(page);
    const signedOut = await visibleText(page);
    assert(!BANNED.test(signedOut), `sign-in page says "${signedOut.match(BANNED)?.[0]}"`);
    assert(!(await page.locator(".sample-note").count()), "the sign-in page shows the sample data note");

    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.locator(".shell").waitFor();
    for (const route of ROUTES) {
      await go(page, route);
      await page.waitForSelector("main h1");
      await settled(page);
      await page.waitForTimeout(150);
      const text = await visibleText(page);
      const bad = text.match(BANNED);
      assert(!bad, `${route} says "${bad?.[0]}" in: ${text.split("\n").find((l) => BANNED.test(l))}`);
      assert((await page.locator(".sample-note").count()) === 1, `${route} does not say it shows sample data`);
      assert((await page.locator(".sample-note .sample-badge").innerText()).toLowerCase() === "sample data", `${route}: the note does not read Sample data`);
    }
    assert(!BANNED.test(await page.title()), `the page title says "${(await page.title()).match(BANNED)?.[0]}"`);
  },

  async "overview"(page) {
    await signIn(page, "");
    await page.getByRole("heading", { name: "Northwind Cloud" }).waitFor();
    assert(new URL(page.url()).pathname === "/overview" && !page.url().includes("#"), `the home page is at ${page.url()}`);
    await page.reload();
    await page.getByRole("heading", { name: "Northwind Cloud" }).waitFor();
    const kpis = await page.locator(".kpi").allInnerTexts();
    assert(kpis.length === 6, `expected 6 numbers, got ${kpis.length}`);
    const labels = await page.locator(".kpi-label").allTextContents();
    assert(labels.join("|") === "Runs|Minutes saved|Skipped with proof|Time to green|On GitHub-hosted|Open defects", `numbers read ${labels.join("|")}`);
    const values = await page.locator(".kpi-value").allTextContents();
    assert(num(values[0]) > 300, `runs this month read ${values[0]}`);
    assert(/^\d+%$/.test(values[2]) && num(values[2]) >= 90, `the median share skipped reads ${values[2]} (home-assistant-like runs dominate: about 97%)`);
    assert(/^\$[\d,.]+$/.test(values[4]), `the GitHub cost reads ${values[4]}`);
    assert((await page.locator(".chart svg").count()) >= 2, "the overview is missing charts");
    await page.locator("#cost").getByText("Price not set").waitFor();
    await page.locator("#ttg").getByText("Before fenvix").waitFor();
    const rows = await page.locator("#projects tbody tr").count();
    assert(rows === 4, `the projects table has ${rows} rows`);
    // Measured shapes: the Django project skips about nothing, the docs monorepo nearly everything.
    const share = async (name) => num(await page.locator("#projects tbody tr", { hasText: name }).locator(".skip-share .mono").innerText());
    assert((await share("northwind/storefront")) <= 10, "the Django project skips too much");
    assert((await share("northwind/docs-site")) >= 95, "the docs monorepo skips too little");
    const ledger = await share("northwind/ledger");
    assert(ledger >= 25 && ledger <= 56, `the Go service reads ${ledger}%, not 25 to 56%`);
    await page.locator("#defects .defect-mini a").first().click();
    await page.locator(".order-list").waitFor();
  },

  async "projects, a project, its runs and settings"(page) {
    await signIn(page, "projects");
    assert((await page.locator("main tbody tr").count()) === 4, "the project list is not 4 rows");
    await page.getByRole("link", { name: "northwind/homehub" }).click();
    await page.getByRole("heading", { name: "northwind/homehub" }).waitFor();
    await page.locator("#skip-trend .chart svg").waitFor();
    assert((await page.locator("#runs tbody tr").count()) === 25, "the runs list is not 25 rows a page");
    await page.locator("#runs").getByRole("button", { name: "Failed", exact: true }).click();
    await eventually(async () => new URL(page.url()).searchParams.get("status") === "failed", "the status filter is not in the address");
    await eventually(async () => {
      const states = await page.locator("#runs tbody tr .state").allTextContents();
      return states.length > 0 && states.every((t) => t === "Failed");
    }, "the failed filter shows other runs");
    await page.locator("#runs").getByRole("button", { name: "Pull requests" }).click();
    await eventually(async () => (await page.locator("#runs tbody tr td[data-label='Branch or pull request'] .branch-cell").allTextContents()).every((t) => t.startsWith("#")), "the pull request filter shows branch runs");
    // Setup: the one-line snippet.
    await page.locator(".project-tabs").getByRole("link", { name: "Setup" }).click();
    await page.getByRole("heading", { name: "The test job on fenvix" }).waitFor();
    assert((await page.locator(".codebox pre").innerText()).includes("runs-on: fenvix"), "the setup snippet does not say runs-on: fenvix");
    assert((await page.locator(".diff").innerText()).includes("+ runs-on: fenvix"), "the diff is missing");
    // Settings: an owner saves them.
    await page.locator(".project-tabs").getByRole("link", { name: "Settings" }).click();
    const sw = page.getByRole("switch", { name: /Nightly exploration/ });
    const before = await sw.getAttribute("aria-checked");
    await sw.click();
    await page.getByLabel("Test command").fill("pytest tests -p no:cacheprovider");
    await page.getByRole("button", { name: "Save settings" }).click();
    await toast(page, "Project settings saved");
    const saved = await page.evaluate(async () => (await window.__fenvixMock.getProject("prj_homehub")).settings);
    assert(String(saved.nightlyExploration) !== before && saved.testCommand === "pytest tests -p no:cacheprovider", `the settings were not saved: ${JSON.stringify(saved)}`);
  },

  async "a run: every test's outcome, a flaky failure and a skip receipt"(page) {
    await signIn(page, "overview");
    const { projectId, runId, number } = await flakyRun(page);
    await go(page, `projects/${projectId}/runs/${runId}`);
    await page.getByRole("heading", { name: `Run #${number}` }).waitFor();
    const v = (await page.locator(".kpi-value").allTextContents()).map(num);
    assert(v[0] === v[1] + v[2], `tests ${v[0]} are not ran ${v[1]} plus skipped ${v[2]}`);
    assert(v[3] >= 1, "the run has no failure");
    await page.locator("#tests").getByRole("button", { name: /^Failed/ }).click();
    const failed = page.locator(".test-row").first();
    await failed.getByText("Failed: flaky defect").waitFor();
    await failed.getByRole("link", { name: "open the defect and its replay command" }).waitFor();
    await page.locator("#tests").getByRole("button", { name: /^Skipped/ }).click();
    await eventually(async () => (await page.locator(".test-row").first().getAttribute("data-outcome")) === "skipped_with_proof", "the skipped filter did not apply");
    const counts = num(await page.locator("#tests").getByRole("button", { name: /^Skipped/ }).locator(".seg-count").innerText());
    assert(counts === v[2], `the skipped count ${counts} is not the run's ${v[2]}`);
    await page.locator(".test-row").first().getByRole("button", { name: /^Receipt for / }).click();
    const dialog = page.getByRole("dialog", { name: "Skipped with proof" });
    await dialog.getByText("Cache key").waitFor();
    for (const part of ["Code executed", "Files read", "Environment variables read", "Runtime and configuration"]) await dialog.getByRole("heading", { name: new RegExp(`^${part}`) }).waitFor();
    const hashes = await dialog.locator(".hash").allTextContents();
    assert(hashes.length >= 4 && hashes.filter((h) => /^[0-9a-f]{32}$/.test(h)).length >= 4, `the receipt hashes read ${hashes.slice(0, 3)}`);
    assert(new URL(page.url()).searchParams.get("receipt"), "the receipt is not in the address");
    const reused = dialog.getByRole("link", { name: /^run #\d+$/ });
    const reusedNumber = (await reused.innerText()).replace("run ", "");
    await reused.click();
    await page.getByRole("heading", { name: `Run ${reusedNumber}` }).waitFor();
    await eventually(async () => !new URL(page.url()).searchParams.get("receipt"), "the receipt stays in the address on the reused run");
    await eventually(async () => !(await page.locator("dialog[open]").count()), "the receipt stays open on the reused run");
    await page.getByLabel("Search tests").fill("zzz-nothing");
    await page.getByText("No test matches.").waitFor();
  },

  async "defects: families, the cause named, the minimal order and the replay command"(page) {
    await signIn(page, "defects");
    // The two storefront defects share one polluter: one family.
    const family = page.locator(".card", { hasText: "test_voucher_cache_warm" });
    await family.waitFor();
    assert((await family.locator("tbody tr").count()) === 2, "the voucher-cache family does not hold 2 defects");
    await family.getByText("Polluter").first().waitFor();
    await family.getByRole("link", { name: "test_checkout_complete_with_voucher" }).click();
    await page.getByRole("heading", { name: "test_checkout_complete_with_voucher" }).waitFor();
    await page.locator(".state", { hasText: "Replays 10/10" }).first().waitFor();
    const order = await page.locator(".order-list li .mono").allTextContents();
    assert(order.length === 2 && order[0].endsWith("test_voucher_cache_warm") && order[1].endsWith("test_checkout_complete_with_voucher"), `the minimal order reads ${order}`);
    const replay = await page.locator("#replay pre").innerText();
    assert(replay.includes("pytest --det --det-seed=1 --det-order=.fenvix/defects/dfx_9a10/order.txt"), `the replay command reads ${replay}`);
    assert(/^[0-9a-f]{32}$/.test(await page.locator("#facts .hash").innerText()), "the fingerprint is not 32 hex characters");
    // A Node defect: the seed only, and the page says the order is not replayed.
    await go(page, "defects/dfx_3b05");
    await page.getByRole("heading", { name: "localizes paths 3" }).waitFor();
    assert((await page.locator("#replay pre").innerText()).includes("detjs vitest run --det --det-seed=32"), "the Node replay command is wrong");
    await page.getByText("does not take an order of tests yet").waitFor();
    // Fixed defects are kept apart.
    await go(page, "defects?state=fixed");
    await page.getByRole("link", { name: "test_track_point_in_time_drift_rearm" }).waitFor();
    await go(page, "defects?project=prj_ledger");
    await page.getByRole("heading", { name: "No open defects" }).waitFor();
  },

  async "connect a project: install the app, then open the pull request"(page) {
    await signIn(page, "projects/connect");
    await page.getByRole("button", { name: "Add repositories on GitHub" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("northwind/billing-worker").waitFor();
    assert(await dialog.getByRole("button", { name: "Install" }).isDisabled(), "Install works with nothing chosen");
    await dialog.getByRole("checkbox", { name: /northwind\/billing-worker/ }).check();
    await dialog.getByRole("button", { name: "Install" }).click();
    await eventually(async () => new URL(page.url()).searchParams.get("setup_action") === "install", "GitHub's return address was not used");
    await toast(page, "Connected northwind/billing-worker");
    const row = page.locator(".setup-row", { hasText: "northwind/billing-worker" });
    await row.getByText("Waiting for setup").waitFor();
    assert((await row.locator(".diff").innerText()).includes("- runs-on: ubuntu-latest"), "the diff does not show the old runner");
    await row.getByRole("button", { name: "Open the pull request" }).click();
    await toast(page, /Opened pull request #\d+ on northwind\/billing-worker/);
    const link = row.getByRole("link", { name: /^Pull request #\d+/ });
    assert((await link.getAttribute("href")).startsWith("https://github.com/northwind/billing-worker/pull/"), "the pull request link is wrong");
    await go(page, "projects");
    await page.locator("tbody tr", { hasText: "northwind/billing-worker" }).getByText("Pull request open").waitFor();
    assert((await page.locator("main tbody tr").count()) === 5, "the new project is not listed");
  },

  async "usage: runs against the plan, per project, CSV export"(page) {
    await signIn(page, "usage");
    await page.locator(".meter").waitFor();
    const used = Number(await page.locator(".meter").getAttribute("aria-valuenow"));
    const included = Number(await page.locator(".meter").getAttribute("aria-valuemax"));
    assert(included === 2000 && used > 0, `the meter reads ${used} of ${included}`);
    const runs = (await page.locator("tbody td[data-label='Runs']").allTextContents()).map(num);
    assert(runs.length === 4 && runs.reduce((a, b) => a + b, 0) === used, `per-project runs ${runs} do not add up to ${used}`);
    assert((await page.locator(".chart svg").count()) >= 1, "the runs-per-day chart is missing");
    const file = await savedFile(page, () => page.getByRole("button", { name: "Export CSV" }).click());
    const lines = file.text.trim().split("\n");
    assert(file.name === "fenvix-usage-2026-11.csv", `the file is ${file.name}`);
    assert(lines[0] === "project,runs,minutes_saved,test_minutes_ran,github_equivalent_minutes,github_equivalent_usd" && lines.length === 5, `the CSV reads ${lines[0]} (${lines.length} lines)`);
    await toast(page, "CSV ready");
    await choose(page, page.locator("#u-month"), "2026-10");
    await eventually(async () => new URL(page.url()).searchParams.get("month") === "2026-10", "the month did not change");
  },

  async "billing: plans by runs, sized by project, no prices set"(page) {
    await signIn(page, "billing");
    const plans = await page.locator(".plan-head h3").allTextContents();
    assert(plans.join("|") === "Starter|Team|Scale|Enterprise", `plans read ${plans.join("|")}`);
    const prices = await page.locator(".plan-price strong").allTextContents();
    assert(prices.every((p) => p === "Price not set"), `a plan has a price: ${prices.join("|")}`);
    assert(/current plan/i.test(await page.locator(".plan-current .tag").innerText()), "no plan is marked as the current one");
    assert((await page.locator(".plan-current h3").innerText()) === "Team", "the current plan is not Team");
    await page.locator("#sizing").getByText("Your plan fits").waitFor();
    await page.getByText("No payment method yet").waitFor();
  },

  async "api keys"(page) {
    await signIn(page, "api-keys");
    // The list: prefix, role, expiry and the three statuses.
    for (const [name, status] of [["Release pipeline", "Active"], ["Quarterly report", "Expired"], ["Old laptop", "Revoked"]]) {
      await page.getByRole("row", { name: new RegExp(name) }).getByText(status, { exact: true }).waitFor();
    }
    await page.getByRole("row", { name: /Coding agent/ }).getByText("fvx_Qm3xT8aL…").waitFor();
    await page.getByRole("row", { name: /Coding agent/ }).getByText("Read only").waitFor();
    assert(!(await page.getByRole("button", { name: "Revoke key Old laptop" }).count()), "a revoked key can be revoked again");
    await page.getByRole("button", { name: "Create key" }).click();
    await page.getByRole("alert").getByText("Enter a name for the key").waitFor();

    await page.getByLabel("Key name").fill("Check runner");
    await page.getByRole("combobox", { name: "Role" }).click();
    await page.getByRole("option", { name: "Admin" }).click();
    await page.getByRole("combobox", { name: "Expires" }).click();
    await page.getByRole("option", { name: "Never" }).click();
    await page.getByText("The key works until it is revoked.").waitFor();
    await page.getByRole("button", { name: "Create key" }).click();
    await page.getByText("Key “Check runner” created.").waitFor();
    const secret = await page.locator(".secret").innerText();
    assert(/^fvx_[A-Za-z0-9_-]{43}$/.test(secret), `the new key reads ${secret}`);
    await page.getByText("It will not be shown again.").waitFor();
    const example = await page.getByLabel("Try it: list your open defects").inputValue();
    assert(!example.includes(secret) && example.includes("$FENVIX_KEY"), "the example holds the key");
    const row = page.getByRole("row", { name: /Check runner/ });
    await row.getByText("Admin").waitFor();
    await row.getByText(secret.slice(0, 12) + "…").waitFor();
    assert(!(await row.innerText()).includes(secret), "the list shows the whole key");
    await page.getByRole("button", { name: "Revoke key Check runner" }).click();
    await page.getByRole("dialog").getByText("stops working immediately").waitFor();
    await page.getByRole("button", { name: "Revoke key", exact: true }).click();
    await page.getByRole("row", { name: /Check runner/ }).getByText("Revoked").waitFor();
  },

  async "sidebar: brand and workspace"(page, vp) {
    await signIn(page, "overview");
    const nav = isMobile(vp) ? ".cx-drawer" : ".cx-account";
    const rename = async (name) => {
      await go(page, "settings");
      await settled(page);
      await page.getByLabel("Organization name").fill(name);
      await page.getByRole("button", { name: "Rename" }).click();
      await toast(page, "Organization renamed");
      await go(page, "overview");
      await settled(page);
      await eventually(async () => (await page.locator(`${nav} .workspace-name`).textContent()) === name.trim(), `the sidebar does not show ${name}`);
      if (isMobile(vp)) {
        await page.getByRole("button", { name: "Open navigation" }).click();
        await page.locator(".cx-drawer .cx-drawer-top").waitFor();
      }
      // The block at the bottom: the person, with the organization and role under the name. Its accessible name holds
      // all of it and says what the button does.
      await page.locator(nav).getByRole("button", { name: `Elena Marsh. Organization: ${name.trim()}, Owner. Account and organizations`, exact: true }).waitFor();
      const box = page.locator(`${nav} .account-btn`);
      await box.click();
      const current = page.locator(`${nav} .account-panel .org-item[aria-current="true"]`);
      await current.waitFor();
      const avatarRead = await current.evaluate((el) => {
        const a = el.querySelector(".workspace-avatar");
        return { initial: a.textContent, bg: getComputedStyle(a).backgroundColor, fg: getComputedStyle(a).color };
      });
      await box.click();
      const read = await box.evaluate((el) => {
        const label = el.querySelector(".workspace-name");
        const empty = [...el.querySelectorAll("*")].filter((e) => !e.textContent.trim() && e.tagName !== "svg" && !e.closest("svg")).map((e) => e.className);
        return {
          role: el.querySelector(".workspace-sub")?.textContent,
          title: el.getAttribute("title"),
          clipped: label.scrollWidth > label.clientWidth,
          ellipsis: getComputedStyle(label).textOverflow === "ellipsis" && getComputedStyle(label).whiteSpace === "nowrap",
          inside: label.getBoundingClientRect().right <= el.getBoundingClientRect().right + 0.5,
          empty,
          tag: el.tagName,
          brandInside: !!el.querySelector(".logo"),
        };
      });
      if (isMobile(vp)) await page.getByRole("button", { name: "Close navigation" }).click();
      return { ...read, ...avatarRead };
    };

    // The brand sits on its own at the top, outside the organization.
    if (isMobile(vp)) await page.getByRole("button", { name: "Open navigation" }).click();
    const brand = page.locator(isMobile(vp) ? ".cx-drawer .cx-drawer-top .logo" : ".cx-top .logo");
    await brand.waitFor();
    assert((await brand.innerText()).trim() === "FENVIX", "the brand is missing at the top of the navigation");
    if (isMobile(vp)) await page.getByRole("button", { name: "Close navigation" }).click();

    const mine = await rename("My workspace");
    assert(mine.initial === "M", `My workspace shows ${mine.initial}`);
    assert(mine.role === "Owner", `the role reads ${mine.role}`);
    assert(mine.title === "Elena Marsh · My workspace", `the tooltip reads ${mine.title}`);
    assert(!mine.clipped, "My workspace is cut off");
    assert(!mine.empty.length, `empty elements in the organization box: ${mine.empty.join(", ")}`);
    assert(mine.tag === "BUTTON", "the organization box is not a button");
    assert(!mine.brandInside, "the brand is inside the organization box");
    assert(mine.bg === "rgb(6, 8, 14)" && mine.fg === "rgb(255, 255, 255)", `the avatar is not the dark colour with a white initial: ${mine.bg} ${mine.fg}`);
    // The logo mark is the frame's ink (with its fade) on the light top bar, as in the console mockup; not tinted.
    const mark = await page.evaluate(() => {
      const svg = document.querySelector(".cx-top .logo svg");
      return { svg: getComputedStyle(svg).color, stops: [...svg.querySelectorAll("stop")].map((s) => getComputedStyle(s).stopColor) };
    });
    assert(mark.svg === "rgb(20, 22, 27)" && mark.stops.every((c) => c === "rgb(20, 22, 27)"), `the logo mark in the top bar is ${mark.svg} (${mark.stops})`);

    assert((await rename("🚀 Launch team")).initial === "🚀", "an emoji name does not show the emoji");
    const accented = await rename("élan studio");
    assert(accented.initial === "É", "an accented name does not show É");
    assert(accented.bg === mine.bg, "another name got another colour");

    const long = "Northwind Cloud Platform Engineering, EU West production";
    const l = await rename(long);
    // On a computer the top bar shows the account as an avatar only; the drawer on a phone shows the name, cut.
    if (isMobile(vp)) assert(l.clipped && l.ellipsis, "a long name is not cut with an ellipsis");
    assert(l.inside, "a long name runs out of its box");
    assert(l.title === `Elena Marsh · ${long}`, `the tooltip does not hold the whole name: ${l.title}`);

    // Keyboard order: skip link, then the brand in the top bar (desktop) or the menu button (phone).
    await page.reload(); // a fresh load, so focus starts at the top of the document
    await page.locator(".shell").waitFor();
    await settled(page);
    await page.keyboard.press("Tab");
    assert(await page.evaluate(() => document.activeElement?.classList.contains("skip-link")), "the first Tab does not reach the skip link");
    await page.keyboard.press("Tab");
    const second = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent.trim());
    assert(isMobile(vp) ? second === "Open navigation" : second === "FENVIX, overview", `the second Tab reaches ${second}`);
  },


  async "select: keyboard, mouse and one look for every dropdown"(page) {
    await signIn(page, "defects");
    assert(!(await page.locator("select, datalist").count()), "a native select or datalist is on the page");
    const sel = page.locator("#d-project");
    const value = async () => (await sel.textContent()).trim();
    assert((await sel.getAttribute("role")) === "combobox" && (await sel.getAttribute("aria-haspopup")) === "listbox", "the select is not a combobox");
    await sel.focus();
    await page.keyboard.press("ArrowDown");
    const list = page.getByRole("listbox", { name: "Project" });
    await list.waitFor();
    assert((await list.locator('[aria-selected="true"]').textContent()).trim() === "All projects", "the current choice is not marked");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await list.waitFor({ state: "detached" });
    await eventually(async () => (await value()) === "northwind/homehub", "Enter did not pick the next option");
    assert(await sel.evaluate((e) => e === document.activeElement), "focus left the select");
    await eventually(async () => new URL(page.url()).searchParams.get("project") === "prj_homehub", "the pick did not reach the list");
    await page.keyboard.press("Enter");
    await page.keyboard.press("End");
    await page.keyboard.press("Escape");
    await list.waitFor({ state: "detached" });
    assert((await value()) === "northwind/homehub", "Escape changed the choice");
    await page.keyboard.press(" ");
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await eventually(async () => (await value()) === "All projects", "Home did not reach the first option");
    await sel.click();
    await list.waitFor();
    await page.locator("main h1").click();
    await list.waitFor({ state: "detached" });
  },

  async "settings"(page) {
    await signIn(page, "settings");
    await page.getByLabel("Organization name").fill("Northwind Platform");
    await page.getByRole("button", { name: "Rename" }).click();
    await page.getByText("Organization renamed").waitFor();
    await page.getByLabel(/Email me about new defects/).uncheck();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Settings saved").waitFor();
    await go(page, "overview");
    await settled(page);
    await eventually(async () => (await page.locator(".workspace-name").first().textContent()).includes("Northwind Platform"), "the sidebar still shows the old organization name");
    await page.getByRole("heading", { name: "Northwind Platform" }).waitFor();
  },
};

// ONLY=fleet runs just the tests whose name holds that text.
const only = process.env.ONLY;

for (const [vpName, viewport] of VIEWPORTS) {
  for (const [name, fn] of Object.entries(TESTS)) {
    if (only && !name.includes(only)) continue;
    const { ctx, page, errors } = await newPage(browser, { viewport });
    page.setDefaultTimeout(20000);
    const label = `${name} (${vpName})`;
    try {
      await fn(page, viewport);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      if (overflow) throw new Error("the page scrolls horizontally");
      if (errors.length) throw new Error(`console: ${errors[0]}`);
      pass(label);
      console.log("ok  ", label);
    } catch (e) {
      fail(`${label}: ${process.env.STACK ? e.stack : String(e.message).split("\n")[0]}`);
      await page.screenshot({ path: `/tmp/fail-${vpName}-${name.replace(/\W+/g, "-")}.png` }).catch(() => {});
    }
    await ctx.close();
  }
}

await browser.close();
console.log(state.failures ? `${state.failures} check(s) failed` : `checks: all ${state.passes} passed`);
process.exit(state.failures ? 1 : 0);
