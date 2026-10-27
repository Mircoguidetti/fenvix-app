// Behaviour checks, run on desktop and on a phone-sized screen. Each test gets a fresh browser context
// (fresh mock data, signed out) and signs in through the real sign-in page unless it is testing sign-in.
// Usage: npm run check (builds, serves and runs everything), or with a preview server on :4173: npm run checks
import { readFile } from "node:fs/promises";
import { BASE, VIEWPORTS, isMobile, launch, makeReporter, newPage, settled, signIn } from "./lib.mjs";

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
  const end = Date.now() + 6000;
  let last;
  while (Date.now() < end) {
    try {
      if ((last = await read())) return;
    } catch {
      /* page is changing */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(message);
}

const resultCount = async (page) => num((await page.locator(".result-count").first().innerText()).split(" ")[0]);
const search = async (page, text) => {
  await page.getByLabel("Search by name").fill(text);
  await page.waitForTimeout(250);
  await settled(page);
};

const TESTS = {
  async "sign in and out"(page, vp) {
    await page.goto(BASE + "#/databases/db_0001");
    await page.getByRole("heading", { name: "Sign in to FENVIX" }).waitFor();
    assert(!(await page.getByRole("navigation", { name: "Main" }).count()), "dashboard navigation visible while signed out");
    assert((await page.getByText("Placeholder").count()) === 0, "placeholder text on sign-in page");

    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.getByRole("heading", { name: "orders-prod" }).waitFor(); // lands on the route that was asked for
    await openUserMenu(page, vp);
    await page.locator(".user-panel").getByText("Ada Sample").waitFor();
    await page.locator(".user-panel").getByText("ada@example.com").waitFor();
    await page.reload(); // the session survives a reload
    await page.getByRole("heading", { name: "orders-prod" }).waitFor();
    await openUserMenu(page, vp);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in to FENVIX" }).waitFor();
    await toast(page, "Signed out");

    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.locator("main h1").first().waitFor();
    await openUserMenu(page, vp);
    await page.locator(".user-panel").getByText("grace@example.com").waitFor();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in to FENVIX" }).waitFor();
    await toast(page, "Signed out");

    await page.getByLabel("Email").fill("not-an-email");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.getByRole("alert").getByText("valid email").waitFor();
    await page.getByLabel("Email").fill("sam.rivera@example.com");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.getByText("We sent a sign-in link to sam.rivera@example.com").waitFor();
    await page.getByRole("button", { name: "Open the sign-in link" }).click();
    await page.locator("main h1").first().waitFor();
    await openUserMenu(page, vp);
    await page.locator(".user-panel").getByText("Sam Rivera").waitFor();
    await page.locator(".user-panel").getByText("sam.rivera@example.com").waitFor();
  },

  async "create a database"(page, vp) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await signIn(page, "#/");
    await page.getByRole("link", { name: "Create database" }).click();
    await page.getByLabel("Name", { exact: true }).fill("check-create-01");
    await page.getByLabel("Region").selectOption("us-east");
    await page.getByLabel("Tags").fill("customer:checkco env:dev");
    await page.getByRole("button", { name: "Create database" }).click();
    await page.getByRole("link", { name: "Open database" }).waitFor();
    const conn = await page.getByRole("textbox", { name: "Connection string" }).inputValue();
    assert(conn.startsWith("mongodb://") && conn.includes("check-create-01"), `connection string: ${conn}`);
    await page.getByRole("button", { name: "Copy connection string" }).click();
    await page.getByRole("button", { name: "Copy connection string" }).filter({ hasText: "Copied" }).waitFor();
    assert((await page.evaluate(() => navigator.clipboard.readText())) === conn, "clipboard does not hold the connection string");
    await toast(page, "Created database check-create-01");

    await page.getByRole("link", { name: "Open database" }).click();
    await page.getByRole("heading", { name: "check-create-01" }).waitFor();
    await page.getByText("customer:checkco").first().waitFor();
    await page.getByText("us-east").first().waitFor();

    await page.goto(BASE + "#/databases/new");
    await page.getByLabel("Name", { exact: true }).fill("check-create-01");
    await page.getByRole("button", { name: "Create database" }).click();
    await page.getByRole("alert").getByText("already exists").waitFor();
    await page.getByLabel("Name", { exact: true }).fill("X");
    await page.getByRole("button", { name: "Create database" }).click();
    await page.getByRole("alert").getByText("3 to 48").waitFor();

    await page.goto(BASE + "#/");
    await search(page, "check-create-01");
    assert((await resultCount(page)) === 1, "new database not in the list");
  },

  async "tags: add, edit, remove, filter"(page) {
    await signIn(page, "#/databases/db_0001");
    await page.getByLabel("Add a tag").fill("team:alpha");
    await page.getByRole("button", { name: "Add tag", exact: true }).click();
    await toast(page, "Added tag team:alpha");
    await page.getByRole("button", { name: "Edit tag team:alpha" }).click();
    await page.getByLabel("Edit tag team:alpha").fill("team:beta");
    await page.getByRole("button", { name: "Save tag" }).click();
    await toast(page, "Changed team:alpha to team:beta");
    await page.getByRole("button", { name: "Remove tag team:beta" }).waitFor();
    assert(!(await page.getByRole("button", { name: "Remove tag team:alpha" }).count()), "old tag still there");
    await page.getByLabel("Add a tag").fill("customer:acme-labs");
    await page.getByRole("button", { name: "Add tag", exact: true }).click();
    await toast(page, "Updated tag customer:acme-labs"); // one value per key: replaces customer:internal
    await page.getByRole("button", { name: "Remove tag customer:acme-labs" }).waitFor();
    assert(!(await page.getByRole("button", { name: "Remove tag customer:internal" }).count()), "customer:internal not replaced");
    await page.getByLabel("Add a tag").fill("not a tag");
    await page.getByRole("button", { name: "Add tag", exact: true }).click();
    await page.getByRole("alert").getByText("key:value").waitFor();
    await page.getByRole("button", { name: "Remove tag team:beta" }).click();
    await toast(page, "Removed tag team:beta");

    await page.goto(BASE + "#/");
    await page.getByLabel("Filter by tag").fill("customer:acme-labs");
    await page.getByRole("button", { name: "Add tag filter" }).click();
    await eventually(async () => (await resultCount(page)) < 3000, "tag filter did not apply");
    const n = await resultCount(page);
    assert(n > 100, `expected a large customer, got ${n}`);
    assert((await page.locator("tbody tr").count()) === 50, "first page should show 50 rows");
    assert((await page.locator("tbody tr").filter({ hasNotText: "customer:acme-labs" }).count()) === 0, "rows without the tag in a tag-filtered list");
    await page.getByRole("button", { name: "Remove tag filter customer:acme-labs" }).click();
    await eventually(async () => (await resultCount(page)) === 3000, "removing the filter should show the whole fleet");
  },

  async "fleet size, paging and group by customer"(page) {
    const t0 = Date.now();
    await signIn(page, "#/");
    await page.waitForSelector("tbody tr");
    const loadMs = Date.now() - t0;
    assert(loadMs < 4000, `list took ${loadMs} ms`);
    assert((await resultCount(page)) === 3000, "fleet should have 3,000 databases");
    const dom = await page.evaluate(() => document.querySelectorAll("*").length);
    assert(dom < 5000, `${dom} DOM nodes on the list page`);
    const asleep = await (async () => {
      await page.getByLabel("State").selectOption("asleep");
      await settled(page);
      return resultCount(page);
    })();
    assert(asleep > 2500, `most databases should be asleep, got ${asleep}`);
    await page.getByLabel("State").selectOption("all");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByText("Page 2 of 60").waitFor();
    await page.getByRole("button", { name: "Previous" }).click();

    const t1 = Date.now();
    await page.getByLabel("Group by tag").selectOption("customer");
    await page.getByText("3,000 databases in 200 groups, grouped by customer").waitFor();
    assert(Date.now() - t1 < 3000, "grouping took too long");
    const counts = await page.locator(".group-meta strong").allTextContents();
    assert(counts.length === 200, `expected 200 groups, got ${counts.length}`);
    assert(counts.map(num).reduce((a, b) => a + b, 0) === 3000, "group counts do not add up to 3,000");
    await page.locator(".group-toggle").first().click();
    await page.locator(".group-body tbody tr").first().waitFor();
    await page.getByRole("button", { name: /^Show more/ }).click();
    await page.waitForTimeout(300);
    assert((await page.locator(".group-body tbody tr").count()) === 50, "show more should load 25 more rows");
    await page.getByLabel("Group by tag").selectOption("env");
    await page.getByText(/in 4 groups, grouped by env/).waitFor();
    await page.getByLabel("Group by tag").selectOption("");
    await page.waitForSelector("tbody tr");
  },

  async "fork"(page) {
    await signIn(page, "#/databases/db_0002");
    await page.getByRole("button", { name: "Fork", exact: true }).click();
    await page.getByLabel("Name of the copy").fill("orders-prod");
    await page.getByRole("button", { name: "Fork and open" }).click();
    await page.getByRole("dialog").getByRole("alert").getByText("already exists").waitFor();
    await page.getByLabel("Name of the copy").fill("check-fork-a");
    await page.getByRole("button", { name: "Fork and open" }).click();
    await page.getByRole("heading", { name: "check-fork-a" }).waitFor();
    await toast(page, "Forked agent-memory as check-fork-a");
    await page.getByText("customer:internal").first().waitFor();
    await page.goto(BASE + "#/");
    await search(page, "check-fork-a");
    assert((await resultCount(page)) === 1, "fork not in the list");
  },

  async "restore to a point in time"(page) {
    await signIn(page, "#/databases/db_0001");
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
    await signIn(page, "#/databases/db_0001");
    const file = await savedFile(page, () => page.getByRole("button", { name: "Export", exact: true }).click());
    assert(file.name === "fenvix-export-orders-prod.json", `file name ${file.name}`);
    const json = JSON.parse(file.text);
    assert(json.databases?.[0]?.name === "orders-prod", "export content");
    await toast(page, "Export ready");
  },

  async "erase"(page) {
    await signIn(page, "#/databases/db_0003");
    await page.getByRole("button", { name: "Erase", exact: true }).click();
    const confirm = page.getByRole("button", { name: "Erase database" });
    assert(await confirm.isDisabled(), "erase should need the name typed");
    await page.getByLabel(/^Type staging-copy/).fill("staging");
    assert(await confirm.isDisabled(), "erase enabled for a partial name");
    await page.getByLabel(/^Type staging-copy/).fill("staging-copy");
    await confirm.click();
    await toast(page, "Erased staging-copy");
    await page.getByRole("heading", { name: "Databases", exact: true }).waitFor();
    await search(page, "staging-copy");
    await page.getByText("No databases match these filters.").waitFor();
    await page.goto(BASE + "#/databases/db_0003");
    await page.getByRole("heading", { name: "Database not found" }).waitFor();
  },

  async "keep awake"(page) {
    await signIn(page, "#/databases/db_0003");
    await page.getByLabel("Keep awake").check();
    await toast(page, "staging-copy will stay awake");
    await page.getByRole("checkbox", { name: "Keep awake" }).waitFor();
    await page.locator(".facts").getByText("Awake").first().waitFor();
    await page.goto(BASE + "#/");
    await page.getByLabel("Keep awake", { exact: true }).selectOption("on");
    await search(page, "staging-copy");
    await eventually(async () => (await resultCount(page)) === 1, "keep awake filter");
    const row = page.locator("tbody tr").filter({ hasText: "staging-copy" });
    await row.getByText("On", { exact: true }).waitFor();
    await row.getByText("Awake").waitFor();
    await page.goto(BASE + "#/databases/db_0003");
    await page.getByLabel("Keep awake").uncheck();
    await toast(page, "staging-copy can sleep when idle");
    await page.goto(BASE + "#/?keep=on&q=staging-copy");
    await page.getByText("No databases match these filters.").waitFor();
  },

  async "bulk actions"(page) {
    await signIn(page, "#/?q=internal-dev");
    await eventually(async () => (await resultCount(page)) < 3000, "search did not apply");
    const total = await resultCount(page);
    assert(total > 50, `need more than one page for this test, got ${total}`);
    await page.getByRole("checkbox", { name: "Select all on this page" }).check();
    await page.getByText("50 selected").waitFor();
    await page.getByRole("button", { name: `Select all ${total} matching` }).click();
    await page.getByText(`${total} selected`).waitFor();
    await page.getByRole("button", { name: "Clear selection" }).click();

    // Three databases, by name.
    await search(page, "internal-dev-0");
    await eventually(async () => (await resultCount(page)) < total, "search did not apply");
    const names = await page.locator("tbody tr td a").allTextContents();
    assert(names.length >= 3, "need three rows");
    const three = names.slice(0, 3);
    for (const n of three) await page.getByRole("checkbox", { name: `Select ${n}` }).check();
    await page.getByText("3 selected").waitFor();
    await page.getByRole("button", { name: "Add tag", exact: true }).click();
    await page.getByLabel("Tag (key:value)").fill("bad");
    await page.getByRole("dialog").getByRole("button", { name: "Add tag" }).click();
    await page.getByRole("dialog").getByRole("alert").waitFor();
    await page.getByLabel("Tag (key:value)").fill("batch:one");
    await page.getByRole("dialog").getByRole("button", { name: "Add tag" }).click();
    await toast(page, "Added tag batch:one to 3 databases");
    assert(!(await page.getByRole("region", { name: "Bulk actions" }).count()), "selection should clear after an action");

    await page.goto(BASE + "#/?tag=batch:one");
    await eventually(async () => (await resultCount(page)) === 3, "tagged databases not found by the new tag");
    await page.getByRole("checkbox", { name: "Select all on this page" }).check();
    await page.getByRole("button", { name: "Keep awake on" }).click();
    await toast(page, "3 databases will stay awake");
    await page.goto(BASE + "#/?tag=batch:one&keep=on&state=awake");
    await eventually(async () => (await resultCount(page)) === 3, "keep awake on did not apply to all three");
    await page.getByRole("checkbox", { name: "Select all on this page" }).check();
    await page.getByRole("button", { name: "Keep awake off" }).click();
    await toast(page, "3 databases can sleep when idle");
    await page.goto(BASE + "#/?tag=batch:one&keep=on");
    await page.getByText("No databases match these filters.").waitFor();

    await page.goto(BASE + "#/?tag=batch:one");
    await eventually(async () => (await resultCount(page)) === 3, "tag filter did not apply");
    await page.getByRole("checkbox", { name: "Select all on this page" }).check();
    const file = await savedFile(page, () => page.getByRole("button", { name: "Export", exact: true }).click());
    assert(file.name === "fenvix-export-3-databases.json" && JSON.parse(file.text).databases.length === 3, "bulk export");
    await toast(page, "Export ready");
    await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: "Remove tag" }).click();
    await page.getByLabel(/^Tag \(key:value, or just the key\)/).fill("batch");
    await page.getByRole("dialog").getByRole("button", { name: "Remove tag" }).click();
    await toast(page, "Removed tag key batch from 3 databases");
    await page.getByText("No databases match these filters.").waitFor();

    await page.goto(BASE + "#/?q=internal-dev-0");
    await eventually(async () => (await resultCount(page)) >= 3, "search did not apply");
    const before = await resultCount(page);
    for (const n of three) await page.getByRole("checkbox", { name: `Select ${n}` }).check();
    await page.getByRole("button", { name: "Erase", exact: true }).click();
    await page.getByRole("dialog", { name: "Erase 3 databases?" }).waitFor();
    await page.getByRole("button", { name: "Erase 3 databases" }).click();
    await toast(page, "Erased 3 databases");
    await eventually(async () => (await resultCount(page)) === before - 3, "erased databases still listed");
  },

  async "usage: sort and CSV export"(page) {
    await signIn(page, "#/usage");
    await page.waitForSelector("tbody tr");
    await page.getByText("3,000", { exact: true }).first().waitFor();
    const requests = async () => (await page.locator('tbody td[data-label="Requests"]').allTextContents()).map(num);
    const sortedBy = (cmp) => async () => {
      const r = await requests();
      return r.length === 50 && r.every((v, i) => i === 0 || cmp(r[i - 1], v));
    };
    await page.getByLabel("Sort by").selectOption("requests:desc");
    await eventually(sortedBy((a, b) => a >= b), "requests not sorted high to low");
    await page.getByLabel("Sort by").selectOption("requests:asc");
    await eventually(sortedBy((a, b) => a <= b), "requests not sorted low to high");
    await page.getByLabel("Sort by").selectOption("name:asc");
    await eventually(async () => {
      const names = await page.locator('tbody td[data-label="Name"]').allTextContents();
      return names.length === 50 && [...names].sort((a, b) => a.localeCompare(b)).join() === names.join();
    }, "names not sorted");

    const db = await savedFile(page, () => page.getByRole("button", { name: "Export CSV" }).click());
    assert(db.name === "fenvix-usage-2026-10-databases.csv", `file name ${db.name}`);
    const lines = db.text.trim().split("\n");
    assert(lines[0] === "database,tags,storage_gb_avg,requests", `csv header ${lines[0]}`);
    assert(lines.length === 3001, `csv should hold all 3,000 databases, has ${lines.length - 1}`);
    await toast(page, "CSV ready");

    await page.getByRole("button", { name: "Per tag" }).click();
    await page.getByLabel("Tag key").selectOption("customer");
    await page.getByText(/customer:/).first().waitFor();
    const shown = num((await page.locator(".stat").nth(2).locator("strong").innerText()));
    const tag = await savedFile(page, () => page.getByRole("button", { name: "Export CSV" }).click());
    assert(tag.name === "fenvix-usage-2026-10-by-customer.csv", `file name ${tag.name}`);
    const rows = tag.text.trim().split("\n");
    assert(rows[0] === "tag,databases,storage_gb_avg,requests" && rows.length === 201, "tag csv shape");
    const sum = rows.slice(1).reduce((a, l) => a + Number(l.split(",").pop()), 0);
    assert(sum === shown, `customer rows add up to ${sum}, page total ${shown}`);
    await toast(page, "CSV ready");

    await page.getByLabel("Month").selectOption("2026-09");
    await eventually(async () => num(await page.locator(".stat").nth(2).locator("strong").innerText()) !== shown, "another month should show other totals");
  },

  async "billing"(page) {
    await signIn(page, "#/billing");
    await page.getByRole("heading", { name: "Current plan" }).waitFor();
    await page.getByText("Visa ending 4242").waitFor();
    await page.getByRole("cell", { name: "Storage" }).first().waitFor();
    await page.getByRole("cell", { name: "Requests" }).first().waitFor();
    const file = await savedFile(page, () => page.getByRole("button", { name: "Download invoice FNX-2026-09" }).click());
    assert(file.name === "FNX-2026-09.pdf" && file.text.startsWith("%PDF-"), "invoice download");
    await toast(page, "Downloaded invoice FNX-2026-09");
  },

  async "no stale wording on any page"(page) {
    await signIn(page, "#/");
    const routes = ["#/", "#/databases/db_0001", "#/databases/new", "#/usage", "#/billing", "#/api-keys", "#/settings"];
    for (const route of routes) {
      await page.goto(BASE + route);
      await page.waitForSelector("main h1");
      await settled(page);
      const text = (await page.evaluate(() => document.body.innerText)).replace(/password placeholder/gi, "");
      const bad = text.match(/olvix|planned|coming soon|\blater\b|postgres|not built yet|placeholder/i);
      assert(!bad, `${route} contains "${bad?.[0]}"`);
    }
    assert((await page.title()).includes("FENVIX"), `title ${await page.title()}`);
    await page.goto(BASE + "#/databases/db_0001");
    await page.getByRole("textbox", { name: "Connection string" }).waitFor();
    assert((await page.getByRole("textbox", { name: "Connection string" }).inputValue()).startsWith("mongodb://"), "connection string scheme");
    assert((await page.locator("link[rel=icon]").getAttribute("href")).includes("favicon.svg"), "favicon link");
    assert((await page.locator(".tag-sample:visible").count()) > 0, "Sample data label");
  },
};

for (const [vpName, viewport] of VIEWPORTS) {
  for (const [name, fn] of Object.entries(TESTS)) {
    const { ctx, page, errors } = await newPage(browser, { viewport });
    page.setDefaultTimeout(10000);
    const label = `${name} (${vpName})`;
    try {
      await fn(page, viewport);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      if (overflow) throw new Error("page scrolls horizontally");
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
