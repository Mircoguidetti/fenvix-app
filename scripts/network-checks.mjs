// Behaviour checks of a database's Network tab (IP allowlist and blocked addresses), on desktop and on a phone-sized
// screen, against the mock backend. Each check gets a fresh browser context and signs in through the sign-in page.
// Usage: npm run check (builds, serves and runs everything), or with a preview server on :4173: node scripts/network-checks.mjs
import { VIEWPORTS, launch, makeReporter, newPage, signIn } from "./lib.mjs";

const { fail, pass, state } = makeReporter();
const browser = await launch();

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

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

async function toast(page, text) {
  const t = page.locator(".toast", { hasText: text }).first();
  await t.waitFor();
  await t.getByRole("button", { name: "Dismiss message" }).click();
}

const entries = (page, list = "IP allowlist entries") => page.getByRole("list", { name: list }).locator(".net-entry").allTextContents();

/** Nothing in the tab sticks out of the screen: every button and entry ends inside the window. */
async function insideScreen(page) {
  const out = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    return [...document.querySelectorAll("#allowlist button, #allowlist input, #allowlist .net-entry, #blocks button, #blocks .net-entry, dialog[open] button, dialog[open] textarea")]
      .filter((el) => el.getClientRects().length)
      .filter((el) => el.getBoundingClientRect().right > w + 0.5 || el.getBoundingClientRect().left < -0.5)
      .map((el) => el.textContent?.trim() || el.getAttribute("aria-label") || el.tagName);
  });
  assert(out.length === 0, `outside the screen: ${out.join(", ")}`);
}

async function noWords(page) {
  const text = (await page.locator("main").innerText()).toLowerCase();
  for (const w of ["private network", "vpn", "whitelist"]) assert(!text.includes(w), `the tab says "${w}"`);
}

const TESTS = {
  async "network: an empty list says every address is allowed and what the list does"(page) {
    await signIn(page, "databases/db_0002?tab=network");
    await page.getByRole("heading", { name: "IP allowlist", exact: true }).waitFor();
    await page.getByText("All IP addresses are allowed.").waitFor();
    await page.getByText("Only these addresses can connect to the database. The dashboard's Data Explorer is not affected by the list.").waitFor();
    assert(await page.getByRole("button", { name: "Save list" }).isDisabled(), "Save list is enabled with nothing to save");
    assert(!(await page.getByRole("button", { name: "Clear list" }).count()), "Clear list is offered for an empty list");
    await page.locator("#blocks").getByText("No address is blocked right now.").waitFor();
    await noWords(page);
    await insideScreen(page);
  },

  async "network: add with clear errors, remove, import, then save only after an explicit confirmation"(page) {
    await signIn(page, "databases/db_0002?tab=network");
    const input = page.getByLabel("Address or network");
    const add = page.getByRole("button", { name: "Add", exact: true });
    const error = page.locator("#allowlist .error");

    await input.fill("10.0.0.1/8");
    await add.click();
    await eventually(async () => /bits set after the prefix length\. The network is 10\.0\.0\.0\/8/.test(await error.innerText()), "no clear error for bits after the prefix");
    await input.fill("db.example.com");
    await add.click();
    await eventually(async () => /character that is not allowed/.test(await error.innerText()), "no clear error for a host name");
    await input.fill("10.0.0.0/33");
    await add.click();
    await eventually(async () => /larger than \/32/.test(await error.innerText()), "no clear error for a prefix too long");
    await input.fill("203.0.113.7");
    await add.click();
    await eventually(async () => (await entries(page)).join() === "203.0.113.7/32", "the address was not added in its /32 form");
    assert(!(await error.count()), "the error stayed after a good entry");
    await input.fill("203.0.113.7/32");
    await add.click();
    await eventually(async () => /already in the list/.test(await error.innerText()), "a duplicate was not refused");
    await input.fill("abcd:ef01:2345:6789:abcd:ef01:2345:6789");
    await add.click();
    await eventually(async () => (await entries(page)).length === 2, "the IPv6 address was not added");
    await page.getByText("Unsaved changes").waitFor();
    await insideScreen(page);
    await page.getByRole("button", { name: "Remove abcd:ef01:2345:6789:abcd:ef01:2345:6789/128" }).click();
    await eventually(async () => (await entries(page)).join() === "203.0.113.7/32", "Remove did not remove");

    await page.getByRole("button", { name: "Import" }).click();
    const imp = page.getByRole("dialog", { name: "Import addresses" });
    await imp.getByLabel("Addresses and networks").fill("198.51.100.0/24, 2001:db8::/32\nnot-an-address\n# office\n");
    await imp.getByText('Line 2: "not-an-address"').waitFor();
    assert(await imp.getByRole("button", { name: "Add 2 entries" }).isDisabled(), "import allowed with a bad line");
    await imp.getByLabel("Addresses and networks").fill("198.51.100.0/24, 2001:db8::/32\n203.0.113.7\n# office\n");
    await imp.getByText("3 entries ready to add").waitFor();
    await insideScreen(page);
    await imp.getByRole("button", { name: "Add 3 entries" }).click();
    await toast(page, "Added 2 entries; 1 was already in the list");
    assert((await entries(page)).join() === "203.0.113.7/32,198.51.100.0/24,2001:db8::/32", `after import: ${(await entries(page)).join()}`);

    await page.getByRole("button", { name: "Save list" }).click();
    const save = page.getByRole("dialog", { name: "Save the IP allowlist?" });
    await save.getByText("cannot see the address your applications connect from").waitFor();
    await save.getByText("after a few attempts that address is blocked for a while").waitFor();
    const confirm = save.getByRole("button", { name: "Save list" });
    assert(await confirm.isDisabled(), "Save list works without the confirmation");
    await insideScreen(page);
    await save.getByLabel("I have checked that the addresses of my applications are in the list").check();
    await confirm.click();
    await toast(page, "Saved the IP allowlist");
    await page.getByText("3 addresses and networks can connect. Every other address is refused.").waitFor();
    assert(!(await page.getByText("Unsaved changes").count()), "still marked unsaved");
    await page.getByText(/Last changed .* by You\./).waitFor();
    // Leave and come back: the saved list is what the server has.
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "Network", exact: true }).click();
    await eventually(async () => (await entries(page)).join() === "203.0.113.7/32,198.51.100.0/24,2001:db8::/32", "the saved list did not come back");
    await noWords(page);
  },

  async "network: clear the list after a confirmation; every address is allowed again"(page) {
    await signIn(page, "databases/db_0001?tab=network");
    await eventually(async () => (await entries(page)).length === 3, "the list of db_0001 did not load");
    await page.getByRole("button", { name: "Clear list" }).click();
    const dlg = page.getByRole("dialog", { name: "Clear the IP allowlist?" });
    await dlg.getByText("Every IP address will be able to connect").waitFor();
    await dlg.getByRole("button", { name: "Cancel" }).click();
    assert((await entries(page)).length === 3, "Cancel cleared the list");
    await page.getByRole("button", { name: "Clear list" }).click();
    await dlg.getByRole("button", { name: "Clear list" }).click();
    await toast(page, "Cleared the IP allowlist");
    await page.getByText("All IP addresses are allowed.").waitFor();
  },

  async "network: blocked addresses with their end, and unblocking one"(page) {
    await signIn(page, "databases/db_0001?tab=network");
    const blocks = page.getByRole("list", { name: "Blocked addresses" });
    await blocks.waitFor();
    assert((await entries(page, "Blocked addresses")).join() === "203.0.113.45,2001:db8:4f2a:17::/64", `blocks: ${(await entries(page, "Blocked addresses")).join()}`);
    await blocks.getByText(/^Blocked until /).first().waitFor();
    await insideScreen(page);
    await page.getByRole("button", { name: "Unblock 203.0.113.45" }).click();
    await toast(page, "Unblocked 203.0.113.45");
    await eventually(async () => (await entries(page, "Blocked addresses")).join() === "2001:db8:4f2a:17::/64", "the unblocked address is still listed");
  },

  async "network: a list in the database that is not the saved one is shown, and applied again"(page) {
    await signIn(page, "databases/db_0003?tab=network");
    const callout = page.locator("#allowlist .callout");
    await callout.getByText("The database is checking a different list from the saved one: 0.0.0.0/0").waitFor();
    await insideScreen(page);
    await callout.getByRole("button", { name: "Apply again" }).click();
    await toast(page, "Applied the saved IP allowlist again");
    await eventually(async () => (await callout.count()) === 0, "the warning stayed after Apply again");
  },

  async "network: an engine that does not answer"(page) {
    await signIn(page, "databases/db_0005?tab=network");
    await page.locator("#allowlist").getByRole("alert").getByText("The database engine did not answer").waitFor();
    await page.locator("#allowlist").getByRole("button", { name: "Try again" }).waitFor();
  },
};

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
console.log(state.failures ? `${state.failures} network check(s) failed` : `network checks: all ${state.passes} passed`);
process.exit(state.failures ? 1 : 0);
