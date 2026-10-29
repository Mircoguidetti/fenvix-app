// Behaviour checks, run on desktop and on a phone-sized screen. Each test gets a fresh browser context
// (fresh data, signed out) and signs in through the real sign-in page unless it is testing sign-in.
// Usage: npm run check (builds, serves and runs everything), or with a preview server on :4173: npm run checks
import { readFile } from "node:fs/promises";
import { BANNED, BASE, VIEWPORTS, go, isMobile, launch, makeReporter, newPage, settled, signIn, visibleText } from "./lib.mjs";

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
    await page.locator(".drawer .user-btn").click();
  } else {
    await page.locator(".sidebar .user-btn").click();
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

/** The cell of a database user's name (on a phone a cell's accessible name also holds its column label). */
const userCell = (page, name) => page.locator("#users td .user-name").filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });

/** Clicks a segmented-control tab and waits for it to actually be the chosen one. */
async function clickTab(page, name) {
  const tab = page.getByRole("button", { name, exact: true });
  await tab.click();
  await eventually(async () => (await tab.getAttribute("aria-pressed")) === "true", `the ${name} tab did not become active`);
}

/** Opens a collection in the Data tab: the list on a wide screen, the select on a phone. */
async function pickCollection(page, vp, name) {
  if (isMobile(vp)) {
    await page.locator("#coll-select").waitFor();
    await eventually(async () => (await page.locator(`#coll-select option[value="${name}"]`).count()) === 1, `no ${name} collection`);
    await page.locator("#coll-select").selectOption(name);
  } else {
    await page.locator(".coll-btn", { hasText: name }).click();
  }
  await page.getByRole("heading", { name, exact: true }).waitFor();
}

const counted = async (page) => num((await page.locator(".counts-bar b").first().innerText()));
const search = async (page, text) => {
  await page.getByLabel("Search by name").fill(text);
  await page.waitForTimeout(200);
  await settled(page);
};

const ROUTES = ["overview", "databases", "databases/db_0001", "databases/new", "usage", "usage?by=tag", "billing", "api-keys", "settings"];

const TESTS = {
  async "phone top bar keeps its height on long pages, with room around the menu button"(page, vp) {
    if (!isMobile(vp)) return;
    for (const route of ["overview", "databases", "api-keys", "databases/db_0001?tab=network"]) {
      await signIn(page, route);
      const m = await page.evaluate(() => {
        const t = document.querySelector(".topbar").getBoundingClientRect();
        const b = document.querySelector(".menu-btn").getBoundingClientRect();
        return { bar: t.height, above: b.top - t.top, below: t.bottom - b.bottom, long: document.querySelector(".content").scrollHeight > innerHeight };
      });
      assert(m.bar >= 68, `${route}: the top bar is ${m.bar}px tall, not 68`);
      assert(m.above >= 12 && m.below >= 12, `${route}: the menu button has ${m.above}px above and ${m.below}px below`);
      if (route === "overview") assert(m.long, "overview is not longer than the screen, so it does not test the squeeze");
    }
  },

  async "sign in and out"(page, vp) {
    await go(page, "databases/db_0001");
    await page.getByRole("heading", { name: "Sign in to FENVIX" }).waitFor();
    assert(!(await page.locator(".shell").count()), "the dashboard is visible while signed out");
    const order = await page.evaluate(() => [...document.querySelectorAll(".signin-card button, .signin-card [type=submit]")].map((b) => b.textContent.trim()));
    assert(/GitHub/.test(order[0]) && /Google/.test(order[1]) && /sign-in link/.test(order[2]), `sign-in buttons out of order: ${order}`);
    assert((await page.locator(".signin-page .signin-card").count()) === 1, "the sign-in card is missing");

    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.getByRole("heading", { name: "orders-prod" }).waitFor(); // lands on the route that was asked for
    await openUserMenu(page, vp);
    await page.locator(".user-panel").getByText("Elena Marsh").waitFor();
    await page.locator(".user-panel").getByText("elena.marsh@northwind.cloud").waitFor();
    await page.reload(); // the session survives a reload
    await page.getByRole("heading", { name: "orders-prod" }).waitFor();
    await openUserMenu(page, vp);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in to FENVIX" }).waitFor();
    await toast(page, "Signed out");

    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.locator(".shell").waitFor();
    await openUserMenu(page, vp);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in to FENVIX" }).waitFor();
    await toast(page, "Signed out");

    await page.getByLabel("Work email").fill("not-an-email");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.getByRole("alert").getByText("valid email").waitFor();
    await page.getByLabel("Work email").fill("sam.rivera@northwind.cloud");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.getByText("We sent a sign-in link to sam.rivera@northwind.cloud").waitFor();
    // The emailed link lands back on the dashboard with a one-time token. A new account names its organization first.
    await go(page, "?token=one-time");
    await page.getByRole("heading", { name: "Name your organization" }).waitFor();
    await page.getByLabel("Organization name").fill("Rivera Labs");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator(".shell").waitFor();
    await openUserMenu(page, vp);
    await page.locator(".user-panel").getByText("Sam Rivera").waitFor();
    await page.locator(".user-panel").getByText("sam.rivera@northwind.cloud").waitFor();
  },

  async "nothing reads as a demo"(page) {
    await go(page, "overview");
    await settled(page);
    const signedOut = await visibleText(page);
    assert(!BANNED.test(signedOut), `sign-in page says "${signedOut.match(BANNED)?.[0]}"`);

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
    }
    // Dialogs too.
    await go(page, "databases/db_0001");
    await settled(page);
    for (const button of ["Fork", "Restore to a point in time", "Erase"]) {
      await page.getByRole("button", { name: button, exact: true }).click();
      await page.getByRole("dialog").waitFor();
      const text = await page.getByRole("dialog").innerText();
      assert(!BANNED.test(text), `the ${button} dialog says "${text.match(BANNED)?.[0]}"`);
      await page.keyboard.press("Escape");
    }
    assert(!BANNED.test(await page.title()), `the page title says "${(await page.title()).match(BANNED)?.[0]}"`);
  },

  async "overview"(page) {
    await signIn(page, "");
    await page.getByRole("heading", { name: "Northwind Cloud" }).waitFor();
    // Real URLs: the root goes to /overview, and there is no # anywhere.
    assert(new URL(page.url()).pathname === "/overview" && !page.url().includes("#"), `the home page is at ${page.url()}`);
    await page.reload(); // a deep link survives a real page load: assets and routes resolve from any path
    await page.getByRole("heading", { name: "Northwind Cloud" }).waitFor();
    const kpis = await page.locator(".kpi-value").allTextContents();
    assert(kpis.length === 6, `expected 6 numbers, got ${kpis.length}`);
    assert(kpis[0] === "3,000", `fleet size reads ${kpis[0]}`);
    assert(num(kpis[1]) > 100 && num(kpis[1]) < 600, `awake count reads ${kpis[1]}`);
    assert(num(kpis[2]) > 2400, `asleep count reads ${kpis[2]}`);
    assert((await page.locator(".kpi .spark").count()) === 6, "every number needs its own trend line");
    assert((await page.locator(".chart svg").count()) >= 3, "the overview is missing charts");
    await page.getByRole("heading", { name: "Recent wake-ups" }).waitFor();
    const woke = await page.locator('tbody td[data-label="Woke"]').allTextContents();
    assert(new Set(woke).size > 3, `wake-up times are all the same: ${woke.join(", ")}`);

    const requests7d = await page.locator(".kpi-value").nth(3).innerText();
    await page.getByRole("button", { name: "24 h" }).click();
    await eventually(async () => (await page.locator(".kpi-value").nth(3).innerText()) !== requests7d, "the range buttons change nothing");
    await page.getByRole("button", { name: "30 d" }).click();
    await eventually(async () => (await page.locator(".kpi-value").nth(3).innerText()) !== requests7d, "30 d shows the same as 7 d");

    await page.locator("#ov-key").selectOption("env");
    await eventually(async () => (await page.locator(".hbar-label").first().innerText()).includes("prod"), "the by-tag chart does not follow the tag key");
    await page.locator(".card#top-h, #top").first().waitFor();
    await page.locator("#top").getByRole("link").first().click();
    await page.waitForSelector("main h1");
    assert(page.url().includes("/databases/db_"), `a top database does not link to its page: ${page.url()}`);
  },

  async "create a database"(page) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await signIn(page, "databases");
    await page.getByRole("link", { name: "Create database" }).click();
    await page.getByLabel("Name", { exact: true }).fill("check-create-01");
    await page.getByLabel("Region").selectOption("us-east");
    await page.getByLabel("Tags").fill("customer:checkco env:dev");
    await page.getByRole("button", { name: "Create database" }).click();
    await page.getByRole("link", { name: "Open database" }).waitFor();
    const conn = await page.getByRole("textbox", { name: "Connection string", exact: true }).inputValue();
    assert(conn.startsWith("mongodb://app:<password>@") && conn.includes("check-create-01.db.fenvix.cloud"), `connection string: ${conn}`);
    await page.getByRole("button", { name: "Copy connection string", exact: true }).click();
    await page.getByRole("button", { name: "Copy connection string", exact: true }).filter({ hasText: "Copied" }).waitFor();
    assert((await page.evaluate(() => navigator.clipboard.readText())) === conn, "clipboard does not hold the connection string");
    await toast(page, "Created database check-create-01");

    // The first database user's password: shown once, here, with a warning and a copy button.
    const password = (await page.getByTestId("once-password").innerText()).trim();
    assert(/^[A-Za-z0-9]{40}$/.test(password), `initial password: ${password}`);
    await page.getByText("This is the only time it is shown").waitFor();
    await page.getByRole("button", { name: "Copy password" }).click();
    assert((await page.evaluate(() => navigator.clipboard.readText())) === password, "clipboard does not hold the password");
    const withPw = await page.getByRole("textbox", { name: "Connection string with this password" }).inputValue();
    assert(withPw === conn.replace("<password>", password), `connection string with the password: ${withPw}`);

    await page.getByRole("link", { name: "Open database" }).click();
    await page.getByRole("heading", { name: "check-create-01" }).waitFor();
    await page.getByText("customer:checkco").first().waitFor();
    await page.getByText("us-east").first().waitFor();
    assert(!(await page.content()).includes(password), "the password is still on the page after leaving the creation screen");
    await page.getByRole("button", { name: "Users", exact: true }).click();
    await userCell(page, "app").waitFor();
    assert(!(await page.content()).includes(password), "the Users tab shows the password again");

    await go(page, "databases/new");
    await page.getByLabel("Name", { exact: true }).fill("check-create-01");
    await page.getByRole("button", { name: "Create database" }).click();
    await page.getByRole("alert").getByText("already exists").waitFor();
    await page.getByLabel("Name", { exact: true }).fill("X");
    await page.getByRole("button", { name: "Create database" }).click();
    await page.getByRole("alert").getByText("3 to 48").waitFor();

    await go(page, "databases");
    await search(page, "check-create-01");
    await eventually(async () => (await counted(page)) === 1, "the new database is not in the list");
  },

  async "tags: add, edit, remove, filter"(page) {
    await signIn(page, "databases/db_0001");
    await page.getByLabel("Add a tag").fill("team:alpha");
    await page.getByRole("button", { name: "Add tag", exact: true }).click();
    await toast(page, "Added tag team:alpha");
    await page.getByRole("button", { name: "Edit tag team:alpha" }).click();
    await page.getByLabel("Edit tag team:alpha").fill("team:beta");
    await page.getByRole("button", { name: "Save tag" }).click();
    await toast(page, "Changed team:alpha to team:beta");
    await page.getByRole("button", { name: "Remove tag team:beta" }).waitFor();
    assert(!(await page.getByRole("button", { name: "Remove tag team:alpha" }).count()), "the old tag is still there");
    await page.getByLabel("Add a tag").fill("customer:acme-labs");
    await page.getByRole("button", { name: "Add tag", exact: true }).click();
    await toast(page, "Updated tag customer:acme-labs"); // one value per key: replaces customer:northwind
    await page.getByRole("button", { name: "Remove tag customer:acme-labs" }).waitFor();
    assert(!(await page.getByRole("button", { name: "Remove tag customer:northwind" }).count()), "customer:northwind was not replaced");
    await page.getByLabel("Add a tag").fill("not a tag");
    await page.getByRole("button", { name: "Add tag", exact: true }).click();
    await page.getByRole("alert").getByText("key:value").waitFor();
    await page.getByRole("button", { name: "Remove tag team:beta" }).click();
    await toast(page, "Removed tag team:beta");

    await go(page, "databases");
    await settled(page);
    await page.locator("#db-tag").fill("customer:acme-labs");
    await page.getByRole("button", { name: "Add tag filter" }).click();
    await eventually(async () => (await counted(page)) < 3000, "the tag filter did not apply");
    const n = await counted(page);
    assert(n > 100, `expected a large customer, got ${n}`);
    assert((await page.locator("tbody tr").count()) === 50, "the first page should hold 50 rows");
    assert((await page.locator("tbody tr").filter({ hasNotText: "customer:acme-labs" }).count()) === 0, "a row without the tag is in a tag-filtered list");
    await page.getByRole("button", { name: "Remove tag filter customer:acme-labs" }).click();
    await eventually(async () => (await counted(page)) === 3000, "removing the filter should show the whole fleet");
  },

  async "fleet size, paging and group by customer"(page) {
    const t0 = Date.now();
    await signIn(page, "databases");
    await page.waitForSelector("tbody tr");
    assert(Date.now() - t0 < 6000, `the list took ${Date.now() - t0} ms to appear`);
    assert((await counted(page)) === 3000, "the fleet should hold 3,000 databases");
    const dom = await page.evaluate(() => document.querySelectorAll("*").length);
    assert(dom < 5000, `${dom} DOM nodes on the list page`);
    const asleep = num(await page.locator(".counts-bar b").nth(2).innerText());
    assert(asleep > 2500, `most databases should be asleep, got ${asleep}`);
    // The default list is by name, so awake and asleep databases are mixed together.
    assert((await page.getByLabel("Sort by").inputValue()) === "name:asc", "the default sort is not by name");
    const names = await page.locator("tbody tr td a").allTextContents();
    assert([...names].sort((a, b) => a.localeCompare(b)).join() === names.join(), "the default list is not in name order");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByText("Page 2 of 60").waitFor();
    await page.getByRole("button", { name: "Previous" }).click();

    await clickTab(page, "Awake");
    await eventually(async () => (await page.locator('tbody td[data-label="State"]').allTextContents()).every((s) => s.includes("Awake")), "the Awake tab still shows asleep databases");
    await clickTab(page, "Kept awake");
    await eventually(async () => (await page.locator("tbody tr").count()) > 0 && (await page.locator(".kept").count()) > 0, "the Kept awake tab shows nothing");
    await clickTab(page, "All");
    await eventually(async () => (await counted(page)) === 3000, "clearing the state tab did not bring the fleet back");

    const t1 = Date.now();
    await page.getByLabel("Group by tag").selectOption("customer");
    await page.getByText("3,000 databases in 200 groups, grouped by customer").waitFor();
    assert(Date.now() - t1 < 4000, "grouping took too long");
    const counts = await page.locator(".group-meta strong").allTextContents();
    assert(counts.length === 200, `expected 200 groups, got ${counts.length}`);
    assert(counts.map(num).reduce((a, b) => a + b, 0) === 3000, "the group counts do not add up to 3,000");
    await page.locator(".group-toggle").first().click();
    await page.locator(".group-body tbody tr").first().waitFor();
    await page.getByRole("button", { name: /^Show more/ }).click();
    await eventually(async () => (await page.locator(".group-body tbody tr").count()) === 50, "show more should load 25 more rows");
    await page.getByLabel("Group by tag").selectOption("env");
    await page.getByText(/in 4 groups, grouped by env/).waitFor();
    await page.getByLabel("Group by tag").selectOption("");
    await page.waitForSelector("tbody tr");
  },

  async "fork"(page) {
    await signIn(page, "databases/db_0002");
    await page.getByRole("button", { name: "Fork", exact: true }).click();
    await page.getByLabel("Name of the copy").fill("orders-prod");
    await page.getByRole("button", { name: "Fork and open" }).click();
    await page.getByRole("dialog").getByRole("alert").getByText("already exists").waitFor();
    await page.getByLabel("Name of the copy").fill("check-fork-a");
    await page.getByRole("button", { name: "Fork and open" }).click();
    // The fork's own first user: its password is shown once before the fork opens.
    const shown = page.getByRole("dialog", { name: "Save the fork's database user" });
    await shown.waitFor();
    assert(/^[A-Za-z0-9]{40}$/.test((await shown.getByTestId("once-password").innerText()).trim()), "the fork's password is not shown");
    await shown.getByRole("button", { name: "I have saved it" }).click();
    await page.getByRole("heading", { name: "check-fork-a" }).waitFor();
    await toast(page, "Forked agent-memory as check-fork-a");
    await page.getByText("customer:northwind").first().waitFor();
    await page.getByText("Forked from").waitFor();
    await go(page, "databases");
    await search(page, "check-fork-a");
    await eventually(async () => (await counted(page)) === 1, "the fork is not in the list");
  },

  async "restore to a point in time"(page) {
    await signIn(page, "databases/db_0001");
    await page.getByRole("button", { name: "Restore to a point in time" }).click();
    await page.getByLabel("Date and time (UTC)").fill("2026-12-01T10:00");
    await page.getByRole("button", { name: "Restore database" }).click();
    await page.getByRole("dialog").getByRole("alert").getByText("in the past").waitFor();
    await page.getByLabel("Date and time (UTC)").fill("2026-10-20T10:00");
    await page.getByRole("button", { name: "Restore database" }).click();
    await toast(page, "Restored orders-prod to Oct 20, 10:00 UTC");
    await page.getByText("Restored to").waitFor();
    await page.getByText("Oct 20, 10:00 UTC").first().waitFor();
  },

  async "export"(page) {
    await signIn(page, "databases/db_0001");
    const file = await savedFile(page, () => page.getByRole("button", { name: "Export", exact: true }).click());
    assert(file.name === "fenvix-export-orders-prod.json", `file name ${file.name}`);
    const json = JSON.parse(file.text);
    assert(json.databases?.[0]?.name === "orders-prod", "the export holds the wrong database");
    await toast(page, "Export ready");
  },

  async "erase"(page) {
    await signIn(page, "databases/db_0003");
    await page.getByRole("button", { name: "Erase", exact: true }).click();
    const confirm = page.getByRole("button", { name: "Erase database" });
    assert(await confirm.isDisabled(), "erase should need the name typed");
    await page.getByLabel(/^Type orders-staging/).fill("orders");
    assert(await confirm.isDisabled(), "erase was enabled for a partial name");
    await page.getByLabel(/^Type orders-staging/).fill("orders-staging");
    await confirm.click();
    await toast(page, "Erased orders-staging");
    await page.getByRole("heading", { name: "Databases", exact: true }).waitFor();
    await search(page, "orders-staging");
    await page.getByText("No databases match these filters").waitFor();
    await go(page, "databases/db_0003");
    await page.getByRole("heading", { name: "Database not found" }).waitFor();
  },

  async "keep awake"(page) {
    await signIn(page, "databases/db_0003");
    await page.getByLabel("Keep awake").check();
    await toast(page, "orders-staging will stay awake");
    await page.locator(".facts").getByText("Awake").first().waitFor();
    await go(page, "databases");
    await settled(page);
    await clickTab(page, "Kept awake");
    await search(page, "orders-staging");
    await eventually(async () => (await counted(page)) === 1, "the kept-awake filter does not find it");
    const row = page.locator("tbody tr").filter({ hasText: "orders-staging" });
    await row.getByText("Kept awake").waitFor();
    await row.getByText("Awake", { exact: true }).waitFor();
    await go(page, "databases/db_0003");
    await page.getByLabel("Keep awake").uncheck();
    await toast(page, "orders-staging can sleep when idle");
    await go(page, "databases?keep=on&q=orders-staging");
    await page.getByText("No databases match these filters").waitFor();
  },

  async "bulk actions"(page) {
    await signIn(page, "databases?q=northwind-dev");
    await eventually(async () => (await counted(page)) < 3000, "the search did not apply");
    const total = await counted(page);
    assert(total > 50, `this test needs more than one page, got ${total}`);
    await page.getByRole("checkbox", { name: "Select all on this page" }).first().check();
    await page.getByText("50 selected").waitFor();
    await page.getByRole("button", { name: `Select all ${total} matching` }).click();
    await page.getByText(`${total} selected`).waitFor();
    await page.getByRole("button", { name: "Clear selection" }).click();

    await search(page, "northwind-dev-0");
    await eventually(async () => (await counted(page)) >= 3, "the search did not apply");
    const names = (await page.locator("tbody tr td a").allTextContents()).slice(0, 3);
    assert(names.length === 3, "this test needs three rows");
    for (const n of names) await page.getByRole("checkbox", { name: `Select ${n}` }).check();
    await page.getByText("3 selected").waitFor();
    await page.getByRole("button", { name: "Add tag", exact: true }).click();
    await page.getByLabel("Tag (key:value)").fill("bad");
    await page.getByRole("dialog").getByRole("button", { name: "Add tag" }).click();
    await page.getByRole("dialog").getByRole("alert").waitFor();
    await page.getByLabel("Tag (key:value)").fill("batch:one");
    await page.getByRole("dialog").getByRole("button", { name: "Add tag" }).click();
    await toast(page, "Added tag batch:one to 3 databases");
    assert(!(await page.getByRole("region", { name: "Bulk actions" }).count()), "the selection should clear after an action");

    await go(page, "databases?tag=batch:one");
    await eventually(async () => (await counted(page)) === 3, "the tagged databases are not found by the new tag");
    await page.getByRole("checkbox", { name: "Select all on this page" }).first().check();
    await page.getByRole("button", { name: "Keep awake on" }).click();
    await toast(page, "3 databases will stay awake");
    await go(page, "databases?tag=batch:one&keep=on&state=awake");
    await eventually(async () => (await counted(page)) === 3, "keep awake on did not apply to all three");
    await page.getByRole("checkbox", { name: "Select all on this page" }).first().check();
    await page.getByRole("button", { name: "Keep awake off" }).click();
    await toast(page, "3 databases can sleep when idle");
    await go(page, "databases?tag=batch:one&keep=on");
    await page.getByText("No databases match these filters").waitFor();

    await go(page, "databases?tag=batch:one");
    await eventually(async () => (await counted(page)) === 3, "the tag filter did not apply");
    await page.getByRole("checkbox", { name: "Select all on this page" }).first().check();
    const file = await savedFile(page, () => page.getByRole("button", { name: "Export", exact: true }).click());
    assert(file.name === "fenvix-export-3-databases.json" && JSON.parse(file.text).databases.length === 3, "bulk export");
    await toast(page, "Export ready");
    await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: "Remove tag" }).click();
    await page.getByLabel(/^Tag \(key:value, or just the key\)/).fill("batch");
    await page.getByRole("dialog").getByRole("button", { name: "Remove tag" }).click();
    await toast(page, "Removed tag key batch from 3 databases");
    await page.getByText("No databases match these filters").waitFor();

    await go(page, "databases?q=northwind-dev-0");
    await eventually(async () => (await counted(page)) >= 3, "the search did not apply");
    const before = await counted(page);
    for (const n of names) await page.getByRole("checkbox", { name: `Select ${n}` }).check();
    await page.getByRole("button", { name: "Erase", exact: true }).click();
    await page.getByRole("dialog", { name: "Erase 3 databases?" }).waitFor();
    await page.getByRole("button", { name: "Erase 3 databases" }).click();
    await toast(page, "Erased 3 databases");
    await eventually(async () => (await counted(page)) === before - 3, "the erased databases are still listed");
  },

  async "usage: sort, chart and CSV export"(page) {
    await signIn(page, "usage");
    await page.waitForSelector("tbody tr");
    assert((await page.locator(".kpi .spark").count()) === 3, "the usage numbers need trend lines");
    await page.getByRole("heading", { name: "Requests by customer" }).waitFor();
    assert((await page.locator(".legend-list li").count()) >= 2, "the stacked chart needs a legend");
    const requests = async () => (await page.locator('tbody td[data-label="Requests"]').allTextContents()).map(num);
    const sortedBy = (cmp) => async () => {
      const r = await requests();
      return r.length === 50 && r.every((v, i) => i === 0 || cmp(r[i - 1], v));
    };
    await page.getByLabel("Sort by").selectOption("requests:desc");
    await eventually(sortedBy((a, b) => a >= b), "requests are not sorted high to low");
    await page.getByLabel("Sort by").selectOption("requests:asc");
    await eventually(sortedBy((a, b) => a <= b), "requests are not sorted low to high");
    await page.getByLabel("Sort by").selectOption("name:asc");
    await eventually(async () => {
      const names = await page.locator('tbody td[data-label="Name"]').allTextContents();
      return names.length === 50 && [...names].sort((a, b) => a.localeCompare(b)).join() === names.join();
    }, "names are not sorted");

    const db = await savedFile(page, () => page.getByRole("button", { name: "Export CSV" }).click());
    assert(db.name === "fenvix-usage-2026-10-databases.csv", `file name ${db.name}`);
    const lines = db.text.trim().split("\n");
    assert(lines[0] === "database,tags,storage_gb_avg,requests", `csv header ${lines[0]}`);
    assert(lines.length === 3001, `the csv should hold all 3,000 databases, it has ${lines.length - 1}`);
    await toast(page, "CSV ready");

    await clickTab(page, "Per tag");
    await page.locator("#u-key").selectOption("customer");
    await page.getByRole("heading", { name: "Per customer" }).waitFor();
    await eventually(async () => (await page.locator('tbody td[data-label="Name"]').first().innerText()).startsWith("customer:"), "the per-tag table did not load");
    const shown = num(await page.locator(".kpi-value").nth(2).innerText().then((t) => t));
    void shown;
    const tag = await savedFile(page, () => page.getByRole("button", { name: "Export CSV" }).click());
    assert(tag.name === "fenvix-usage-2026-10-by-customer.csv", `file name ${tag.name}`);
    const rows = tag.text.trim().split("\n");
    assert(rows[0] === "tag,databases,storage_gb_avg,requests" && rows.length === 201, `tag csv shape: ${rows.length - 1} rows`);
    const sum = rows.slice(1).reduce((a, l) => a + Number(l.split(",").pop()), 0);
    const total = num(await page.locator(".kpi-value").nth(2).innerText());
    assert(Math.abs(sum / 1e6 - total) < 1, `the customer rows add up to ${sum}, the page says ${total}M`);
    await toast(page, "CSV ready");

    const october = await page.locator(".kpi-value").nth(2).innerText();
    await page.locator("#u-month").selectOption("2026-09");
    await eventually(async () => (await page.locator(".kpi-value").nth(2).innerText()) !== october, "another month shows the same totals");
  },

  async "billing"(page) {
    await signIn(page, "billing");
    await page.getByRole("heading", { name: "Month to date" }).waitFor();
    await page.getByText("•••• •••• •••• 4242").waitFor();
    await page.getByRole("cell", { name: "Storage" }).first().waitFor();
    assert((await page.locator(".chart svg").count()) >= 1, "the cost chart is missing");
    const plans = await page.locator(".plan-head h3").allTextContents();
    assert(plans.join("|") === "Open source|Managed|Dedicated|In your cloud", `plans read ${plans.join("|")}`);
    const prices = await page.locator(".plan-price strong").allTextContents();
    assert(prices.join("|") === "Free|$29|$499|Custom", `prices read ${prices.join("|")}`);
    assert(/current plan/i.test(await page.locator(".plan-current .tag").innerText()), "no plan is marked as the current one");
    const file = await savedFile(page, () => page.getByRole("button", { name: "Download invoice FNX-2026-09" }).click());
    assert(file.name === "FNX-2026-09.pdf" && file.text.startsWith("%PDF-"), "invoice download");
    await toast(page, "Downloaded invoice FNX-2026-09");
  },

  async "api keys"(page) {
    await signIn(page, "api-keys");
    await page.getByLabel("Key name").fill("Check runner");
    await page.getByRole("button", { name: "Create key" }).click();
    await page.getByText("Key “Check runner” created.").waitFor();
    const secret = await page.locator(".secret").innerText();
    assert(secret.startsWith("fnx_"), `the new key reads ${secret}`);
    await page.getByRole("button", { name: "Revoke key Check runner" }).click();
    await page.getByRole("button", { name: "Revoke key", exact: true }).click();
    await page.getByRole("row", { name: /Check runner/ }).getByText("Revoked").waitFor();
  },

  async "data explorer: browse, filter and page"(page, vp) {
    await signIn(page, "databases/db_0001?tab=data");
    await page.getByRole("heading", { name: "Collections" }).waitFor();
    await pickCollection(page, vp, "orders");
    await eventually(async () => (await page.locator(".doc").count()) === 25, "the first page does not hold 25 documents");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByText("Page 2", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Next" }).click();
    await eventually(async () => (await page.locator(".doc").count()) === 7, "the last page does not hold the last 7 documents");
    assert(await page.getByRole("button", { name: "Next" }).isDisabled(), "Next is enabled on the last page");

    await page.getByLabel("Filter").fill('{"status": ');
    await page.getByRole("button", { name: "Apply" }).click();
    await page.getByRole("alert").getByText("The filter is not valid JSON").waitFor();
    await page.getByLabel("Filter").fill('{"$where": "1"}');
    await page.getByRole("button", { name: "Apply" }).click();
    await page.getByRole("alert").getByText("$where is not allowed").waitFor();
    await page.getByLabel("Filter").fill('{"status": "paid"}');
    await page.getByRole("button", { name: "Apply" }).click();
    await eventually(async () => (await page.locator(".doc").count()) === 15, "the filter did not narrow the list to the 15 paid orders");
    assert(!(await page.getByRole("alert").count()), "the filter error stayed after a valid filter");

    await page.locator(".doc").first().getByRole("button", { expanded: false }).first().click();
    await page.locator(".json-tree").first().getByText(/^ISODate\("2026-09-/).waitFor();
    await page.getByRole("button", { name: "Reset" }).click();
    await eventually(async () => (await page.locator(".doc").count()) === 25, "Reset did not bring back every document");
  },

  async "data explorer: documents are shown as text, never as markup"(page, vp) {
    let alerted = false;
    page.on("dialog", (d) => ((alerted = true), d.dismiss()));
    await signIn(page, "databases/db_0001?tab=data");
    await page.getByRole("heading", { name: "Collections" }).waitFor();
    await pickCollection(page, vp, "notes");
    await eventually(async () => (await page.locator(".doc").count()) === 2, "the notes did not load");
    for (const t of await page.locator(".doc-toggle").all()) await t.click();
    await page.locator(".json-tree").first().waitFor();
    const text = await page.locator(".explorer").innerText();
    assert(text.includes("<script>window.__xss = 'script'</script>"), "the <script> in the document is not shown as text");
    assert(text.includes("<img src=x onerror="), "the <img onerror> in the document is not shown as text");
    assert((await page.locator(".explorer script, .explorer img, .explorer iframe, .explorer object").count()) === 0, "markup from a document became an element");
    await page.getByRole("button", { name: /^Edit document/ }).first().click();
    const editor = page.getByLabel("Document", { exact: true });
    await editor.waitFor();
    assert((await editor.inputValue()).includes("<script>"), "the editor does not hold the raw text");
    assert((await page.locator("dialog script, dialog img").count()) === 0, "markup became an element in the editor");
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(300);
    assert(!alerted, "a document opened a browser dialog");
    assert((await page.evaluate(() => window.__xss)) === undefined, "code from a document ran");
  },

  async "data explorer: insert, edit, delete and someone else's change"(page, vp) {
    await signIn(page, "databases/db_0001?tab=data");
    await page.getByRole("heading", { name: "Collections" }).waitFor();
    await pickCollection(page, vp, "customers");
    await eventually(async () => (await page.locator(".doc").count()) === 1, "customers did not load");

    await page.getByRole("button", { name: "Insert document" }).click();
    const editor = page.getByLabel("Document", { exact: true });
    await editor.fill('{"name": "Contoso"');
    await page.getByRole("alert").getByText("The document is not valid JSON").waitFor();
    assert(await page.getByRole("button", { name: "Save" }).isDisabled(), "Save is enabled with broken JSON");
    await editor.fill('{"_id": "contoso", "name": "Contoso", "seats": {"$numberInt": "3"}}');
    await page.getByRole("button", { name: "Save" }).click();
    await toast(page, "Document inserted");
    await eventually(async () => (await page.locator(".doc").count()) === 2, "the new document is not listed");

    await page.getByRole("button", { name: 'Edit document "contoso"' }).click();
    await editor.fill('{"_id": "contoso", "name": "Contoso Ltd", "seats": {"$numberInt": "4"}}');
    await page.getByRole("button", { name: "Save" }).click();
    await toast(page, "Document saved");
    await page.locator(".doc", { hasText: "Contoso Ltd" }).waitFor();

    // Someone else changes the document while it is open here: the save is refused, nothing is overwritten.
    await page.getByRole("button", { name: 'Edit document "contoso"' }).click();
    await editor.fill('{"_id": "contoso", "name": "Mine", "seats": {"$numberInt": "9"}}');
    await page.evaluate(() => window.__fenvixExplorerMock.touch("db_0001", "customers", '"contoso"', "name", "Theirs"));
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("alert").getByText("Someone changed this document after you opened it").waitFor();
    await page.getByRole("button", { name: "Load the latest version" }).click();
    await eventually(async () => (await editor.inputValue()).includes("Theirs"), "the latest version was not loaded");
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: 'Delete document "contoso"' }).click();
    await page.getByRole("heading", { name: "Delete this document?" }).waitFor();
    await page.getByRole("button", { name: "Cancel" }).click();
    assert((await page.locator(".doc").count()) === 2, "Cancel deleted the document");
    await page.getByRole("button", { name: 'Delete document "contoso"' }).click();
    await page.getByRole("button", { name: "Delete document", exact: true }).click();
    await toast(page, "Document deleted");
    await eventually(async () => (await page.locator(".doc").count()) === 1, "the document is still listed");
  },

  async "data explorer: a sleeping database is woken"(page, vp) {
    await signIn(page, "databases");
    await go(page, "databases/db_0003?tab=data");
    await page.getByRole("status").getByText("Waking the database").waitFor();
    await pickCollection(page, vp, "orders");
    await eventually(async () => (await page.locator(".doc").count()) === 8, "the woken database did not show its documents");
    assert(!(await page.getByText("Waking the database").count()), "the waking notice stayed");
  },

  async "database users: list, add, reset and delete; the password is shown once"(page) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await signIn(page, "databases/db_0001?tab=users");
    await page.getByRole("heading", { name: "Users", exact: true }).waitFor();
    await userCell(page, "reporting").waitFor();
    await page.getByText("3 of 20 users.").waitFor();
    assert(!/[A-Za-z0-9]{40}/.test(await page.locator("#users table").innerText()), "the list shows something that looks like a password");

    // A name the server would refuse is explained before anything is sent.
    await page.getByRole("button", { name: "Add user" }).click();
    const add = page.getByRole("dialog", { name: "Add a user" });
    await add.getByLabel("User name").fill("Admin!");
    await add.getByRole("button", { name: "Create user" }).click();
    await add.getByRole("alert").getByText("lowercase letters").waitFor();
    await add.getByLabel("User name").fill("check-reader");
    await add.getByLabel("Access").selectOption("read");
    await add.getByRole("button", { name: "Create user" }).click();

    const once = page.getByRole("dialog", { name: "User check-reader created" });
    await once.waitFor();
    await once.getByText("This is the only time it is shown").waitFor();
    const first = (await once.getByTestId("once-password").innerText()).trim();
    assert(/^[A-Za-z0-9]{40}$/.test(first), `password: ${first}`);
    await once.getByRole("button", { name: "Copy password" }).click();
    assert((await page.evaluate(() => navigator.clipboard.readText())) === first, "clipboard does not hold the password");
    assert((await once.getByRole("textbox", { name: "Connection string with this password" }).inputValue()).includes(`check-reader:${first}@`), "connection string with the password");
    await once.getByRole("button", { name: "I have saved it" }).click();
    await once.waitFor({ state: "hidden" });
    await userCell(page, "check-reader").waitFor();
    assert(!(await page.content()).includes(first), "the password is still in the page after the dialog closed");

    // Reset: a confirmation, then a new password, once.
    await page.getByRole("button", { name: "Reset password of check-reader" }).click();
    const confirmReset = page.getByRole("dialog", { name: "Reset this password?" });
    await confirmReset.getByRole("button", { name: "Reset password" }).click();
    const again = page.getByRole("dialog", { name: "New password for check-reader" });
    await again.waitFor();
    const second = (await again.getByTestId("once-password").innerText()).trim();
    assert(/^[A-Za-z0-9]{40}$/.test(second) && second !== first, "the reset did not give a new password");
    await again.getByRole("button", { name: "I have saved it" }).click();
    await again.waitFor({ state: "hidden" });

    // Delete, with a confirmation that can be cancelled.
    await page.getByRole("button", { name: "Delete user check-reader" }).click();
    const confirmDelete = page.getByRole("dialog", { name: "Delete this user?" });
    await confirmDelete.getByRole("button", { name: "Cancel" }).click();
    await userCell(page, "check-reader").waitFor();
    await page.getByRole("button", { name: "Delete user check-reader" }).click();
    await confirmDelete.getByRole("button", { name: "Delete user" }).click();
    await toast(page, "Deleted user check-reader");
    await eventually(async () => (await userCell(page, "check-reader").count()) === 0, "the deleted user is still listed");
    assert(!(await page.content()).includes(second), "a password is still in the page");
  },

  async "database users: names are shown as text, never as markup"(page) {
    let alerted = false;
    page.on("dialog", (d) => ((alerted = true), d.dismiss()));
    await signIn(page, "databases/db_0001?tab=users");
    await userCell(page, "reporting").waitFor();
    const text = await page.locator("#users").innerText();
    assert(text.includes("<script>window.__xss='user'</script>"), "the <script> in a user name is not shown as text");
    assert((await page.locator("#users script, #users img, #users iframe").count()) === 0, "markup in a user name became an element");
    await page.getByRole("button", { name: "Delete user <script>window.__xss='user'</script>" }).click();
    const dlg = page.getByRole("dialog", { name: "Delete this user?" });
    assert((await dlg.innerText()).includes("<script>"), "the dialog does not show the name as text");
    assert((await page.locator("dialog script").count()) === 0, "markup became an element in the dialog");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(300);
    assert(!alerted, "a user name opened a browser dialog");
    assert((await page.evaluate(() => window.__xss)) === undefined, "code from a user name ran");
  },

  async "database users: empty and error states"(page) {
    await signIn(page, "databases/db_0002?tab=users");
    await page.getByRole("heading", { name: "No users yet" }).waitFor();
    await page.getByRole("button", { name: "Add user" }).waitFor();
    await go(page, "databases/db_0005?tab=users");
    await page.getByRole("alert").getByText("The database engine did not answer").waitFor();
    await page.getByRole("button", { name: "Try again" }).waitFor();
    assert(await page.getByRole("button", { name: "Add user" }).isDisabled(), "Add user is enabled while the list could not load");
  },

  async "sidebar: brand and workspace"(page, vp) {
    await signIn(page, "overview");
    const nav = isMobile(vp) ? ".drawer" : ".sidebar";
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
        await page.locator(".drawer .nav").waitFor();
      }
      // The accessible name holds the whole name and the role, and says what the button does.
      await page.locator(nav).getByRole("button", { name: `Organization: ${name.trim()}, Owner. Switch organization`, exact: true }).waitFor();
      const box = page.locator(`${nav} .workspace`);
      const read = await box.evaluate((el) => {
        const avatar = el.querySelector(".workspace-avatar");
        const label = el.querySelector(".workspace-name");
        const empty = [...el.querySelectorAll("*")].filter((e) => !e.textContent.trim() && e.tagName !== "svg" && !e.closest("svg")).map((e) => e.className);
        return {
          initial: avatar?.textContent,
          bg: getComputedStyle(avatar).backgroundColor,
          fg: getComputedStyle(avatar).color,
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
      return read;
    };

    // The brand sits on its own at the top, outside the organization.
    if (isMobile(vp)) await page.getByRole("button", { name: "Open navigation" }).click();
    const brand = page.locator(`${nav} .sidebar-top .logo`);
    await brand.waitFor();
    assert((await brand.innerText()).trim() === "FENVIX", "the brand is missing at the top of the navigation");
    if (isMobile(vp)) await page.getByRole("button", { name: "Close navigation" }).click();

    const mine = await rename("My workspace");
    assert(mine.initial === "M", `My workspace shows ${mine.initial}`);
    assert(mine.role === "Owner", `the role reads ${mine.role}`);
    assert(mine.title === "My workspace", `the tooltip reads ${mine.title}`);
    assert(!mine.clipped, "My workspace is cut off");
    assert(!mine.empty.length, `empty elements in the organization box: ${mine.empty.join(", ")}`);
    assert(mine.tag === "BUTTON", "the organization box is not a button");
    assert(!mine.brandInside, "the brand is inside the organization box");
    assert(mine.bg === "rgb(0, 0, 0)" && mine.fg === "rgb(255, 255, 255)", `the avatar is not black with a white initial: ${mine.bg} ${mine.fg}`);

    assert((await rename("🚀 Launch team")).initial === "🚀", "an emoji name does not show the emoji");
    const accented = await rename("élan studio");
    assert(accented.initial === "É", "an accented name does not show É");
    assert(accented.bg === mine.bg, "another name got another colour");

    const long = "Northwind Cloud Platform Engineering, EU West production";
    const l = await rename(long);
    assert(l.clipped && l.ellipsis, "a long name is not cut with an ellipsis");
    assert(l.inside, "a long name runs out of its box");
    assert(l.title === long, `the tooltip does not hold the whole name: ${l.title}`);

    // Keyboard order: skip link, then the organization switcher (desktop) or the menu button (phone).
    await page.reload(); // a fresh load, so focus starts at the top of the document
    await page.locator(".shell").waitFor();
    await settled(page);
    await page.keyboard.press("Tab");
    assert(await page.evaluate(() => document.activeElement?.classList.contains("skip-link")), "the first Tab does not reach the skip link");
    await page.keyboard.press("Tab");
    const second = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent.trim());
    assert(isMobile(vp) ? second === "Open navigation" : second.startsWith("Organization: "), `the second Tab reaches ${second}`);
  },

  async "settings"(page) {
    await signIn(page, "settings");
    await page.getByLabel("Organization name").fill("Northwind Platform");
    await page.getByRole("button", { name: "Rename" }).click();
    await page.getByText("Organization renamed").waitFor();
    await page.getByLabel("Sleep after idle").selectOption("15");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Settings saved").waitFor();
    await go(page, "overview");
    await settled(page);
    // The sidebar is a drawer on a phone, so read the text instead of waiting for it to be visible.
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
      fail(`${label}: ${String(e.message).split("\n")[0]}`);
      await page.screenshot({ path: `/tmp/fail-${vpName}-${name.replace(/\W+/g, "-")}.png` }).catch(() => {});
    }
    await ctx.close();
  }
}

await browser.close();
console.log(state.failures ? `${state.failures} check(s) failed` : `checks: all ${state.passes} passed`);
process.exit(state.failures ? 1 : 0);
