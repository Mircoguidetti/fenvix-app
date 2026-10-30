// Regenerates every screenshot in screenshots/ and checks layout, rendering and accessibility on each one.
// Usage: npm run check (builds, serves and runs everything), or with a preview server on :4173: npm run screenshots
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { BANNED, BASE, VIEWPORTS, axeViolations, go, isMobile, launch, layoutProblems, makeReporter, newPage, renderProblems, settled, visibleText, openFilters } from "./lib.mjs";

const { fail, state } = makeReporter();
const MAX_HEIGHT = 2600; // long lists are cut here so the files stay a sensible size

const SCREENS = [
  ["overview", "overview"],
  ["databases", "databases"],
  ["databases-filtered", "databases?tag=customer:acme-labs&state=awake"],
  ["databases-grouped", "databases?group=customer&q=acme"],
  ["database-detail", "databases/db_0001"],
  ["database-detail-asleep", "databases/db_0011"],
  ["create-database", "databases/new"],
  ["database-users", "databases/db_0001?tab=users"],
  ["database-users-empty", "databases/db_0002?tab=users"],
  ["database-network", "databases/db_0001?tab=network"],
  ["database-network-empty", "databases/db_0002?tab=network"],
  ["usage", "usage"],
  ["usage-by-tag", "usage?by=tag&key=customer"],
  ["billing", "billing"],
  ["api-keys", "api-keys"],
  ["settings", "settings"],
];

mkdirSync("screenshots", { recursive: true });
for (const f of readdirSync("screenshots")) if (f.endsWith(".png")) rmSync(`screenshots/${f}`);
const browser = await launch();

for (const [vpName, viewport] of VIEWPORTS) {
  const { ctx, page, errors } = await newPage(browser, { viewport });

  const check = async (label) => {
    (await layoutProblems(page)).forEach((p) => fail(`${label}: ${p}`));
    (await renderProblems(page)).forEach((p) => fail(`${label}: ${p}`));
    (await axeViolations(page)).forEach((v) => fail(`${label}: ${v}`));
    const text = await visibleText(page);
    if (BANNED.test(text)) fail(`${label}: says "${text.match(BANNED)?.[0]}"`);
    // No underlined text anywhere, and one background behind full-page screens (no seam between two blacks).
    const underlined = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => getComputedStyle(e).textDecorationLine.includes("underline")).map((e) => `${e.tagName.toLowerCase()}.${e.className}`));
    if (underlined.length) fail(`${label}: underlined ${underlined.slice(0, 3).join(", ")}`);
    const seam = await page.evaluate(() => {
      const full = document.querySelector(".signin-page");
      if (!full) return null;
      const bgs = new Set([document.documentElement, document.body, full].map((e) => getComputedStyle(e).backgroundColor));
      return bgs.size === 1 ? null : [...bgs].join(" / ");
    });
    if (seam) fail(`${label}: the full-page screen has more than one background (${seam})`);
  };
  /**
   * The shell fills the window and the content column scrolls inside it, so a "full page"
   * screenshot is just the window. To show a whole page, the window is grown to fit the
   * content first: the navigation column then still runs the full height of the picture.
   */
  const shot = async (name, fixed) => {
    await page.mouse.move(2, 2); // no stray hover highlight in the picture
    const path = `screenshots/${name}-${vpName}.png`;
    if (fixed) return page.screenshot({ path });
    const needed = await page.evaluate(() => {
      const el = document.querySelector(".content") ?? document.documentElement;
      return Math.ceil(el.scrollHeight);
    });
    const height = Math.min(Math.max(needed, viewport.height), MAX_HEIGHT);
    if (height !== viewport.height) {
      await page.setViewportSize({ width: viewport.width, height });
      await page.waitForTimeout(250); // charts measure themselves again
    }
    await page.screenshot({ path });
    if (height !== viewport.height) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(150);
    }
  };

  // Signed out.
  await go(page, "overview");
  await page.getByRole("button", { name: "Continue with GitHub" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await check(`sign-in ${vpName}`);
  await shot("sign-in");

  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await page.locator(".shell").waitFor();
  await settled(page);

  for (const [name, hash] of SCREENS) {
    const label = `${name} ${vpName}`;
    await go(page, hash);
    await page.waitForSelector("main h1");
    await settled(page);
    await page.waitForTimeout(250);
    await check(label);
    await shot(name);
  }

  // A select, open: the list under it with the choice ticked.
  await go(page, "databases");
  await settled(page);
  await openFilters(page);
  await page.getByLabel("Sort by").click();
  await page.getByRole("listbox").waitFor();
  await check(`select-open ${vpName}`);
  await shot("select-open", true);
  await page.keyboard.press("Escape");

  // Grouped list with a group open and the bulk bar showing.
  await go(page, "databases?group=customer&q=acme");
  await settled(page);
  await page.locator(".group-toggle").first().click();
  await page.getByRole("button", { name: /^Select all \d+ in / }).click();
  await page.getByRole("region", { name: "Bulk actions" }).waitFor();
  await check(`databases-bulk ${vpName}`);
  await shot("databases-bulk");

  // Dialogs
  await go(page, "databases/db_0001");
  await settled(page);
  for (const [name, button, dialogName] of [
    ["fork-dialog", "Fork", "Fork this database"],
    ["restore-dialog", "Restore to a point in time", "Restore to a point in time"],
    ["erase-dialog", "Erase", "Erase this database?"],
  ]) {
    await page.getByRole("button", { name: button, exact: true }).click();
    await page.getByRole("dialog", { name: dialogName }).waitFor();
    await check(`${name} ${vpName}`);
    await shot(name, true);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }

  // Database users: the password shown once, after a user is made and after a database is created.
  await go(page, "databases/db_0001?tab=users");
  await settled(page);
  await page.locator("#users td .user-name").filter({ hasText: /^reporting$/ }).waitFor();
  await page.getByLabel("User name").fill("shot-user");
  await check(`database-users-add ${vpName}`);
  await shot("database-users-new-user");
  await page.getByRole("button", { name: "Create user" }).click();
  await page.getByRole("dialog", { name: "User shot-user created" }).waitFor();
  await check(`database-users-password ${vpName}`);
  await shot("database-users-password-dialog", true);
  await page.getByRole("button", { name: "I have saved it" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Delete user shot-user" }).click();
  await page.getByRole("dialog", { name: "Delete this user?" }).waitFor();
  await check(`database-users-delete ${vpName}`);
  await shot("database-users-delete-dialog", true);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });

  await go(page, "databases/new");
  await settled(page);
  await page.getByLabel("Name", { exact: true }).fill(`shot-created-${vpName}`);
  await page.getByRole("button", { name: "Create database" }).click();
  await page.getByRole("link", { name: "Open database" }).waitFor();
  await page.locator(".toast").getByRole("button", { name: "Dismiss message" }).click();
  await check(`database-created ${vpName}`);
  await shot("database-created");

  await go(page, "api-keys");
  await settled(page);
  await page.getByRole("button", { name: "Revoke key Deploy pipeline" }).click();
  await page.getByRole("dialog").waitFor();
  await check(`revoke-dialog ${vpName}`);
  await shot("api-keys-revoke-dialog", true);
  await page.keyboard.press("Escape");

  // A confirmation message
  await go(page, "databases/db_0001");
  await settled(page);
  await page.getByLabel("Add a tag").fill("team:data");
  await page.getByRole("button", { name: "Add tag", exact: true }).click();
  await page.getByText("Added tag team:data").waitFor();
  await shot("confirmation", true);
  await page.locator(".toast").getByRole("button", { name: "Dismiss message" }).click();
  await page.locator(".toast").waitFor({ state: "hidden" });

  // Navigation drawer and the account menu
  if (isMobile(viewport)) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator(".drawer .nav").waitFor();
    await check(`drawer ${vpName}`);
    await shot("drawer", true);
    await page.locator(".drawer .user-btn").click();
  } else {
    await page.locator(".sidebar .user-btn").click();
  }
  await page.getByRole("button", { name: "Sign out" }).waitFor();
  await check(`user-menu ${vpName}`);
  await shot("user-menu", true);

  errors.forEach((e) => fail(`console ${vpName}: ${e}`));
  await ctx.close();

  // A brand-new account: the first screen names its organization.
  const fresh = await newPage(browser, { viewport });
  await go(fresh.page, "overview");
  await fresh.page.getByLabel("Work email").fill("spazio.milano@example.com");
  await fresh.page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await fresh.page.getByText(/We sent a sign-in link/).waitFor();
  await go(fresh.page, "?token=one-time");
  await fresh.page.getByRole("heading", { name: "Name your organization" }).waitFor();
  await fresh.page.evaluate(() => document.fonts.ready);
  (await layoutProblems(fresh.page)).forEach((x) => fail(`name-organization ${vpName}: ${x}`));
  (await axeViolations(fresh.page)).forEach((v) => fail(`name-organization ${vpName}: ${v}`));
  const bgs = await fresh.page.evaluate(() => [document.documentElement, document.body, document.querySelector(".signin-page")].map((e) => getComputedStyle(e).backgroundColor));
  if (new Set(bgs).size !== 1) fail(`name-organization ${vpName}: more than one background (${bgs.join(" / ")})`);
  const prefill = await fresh.page.getByLabel("Organization name").inputValue();
  if (prefill !== "Spazio Milano") fail(`name-organization ${vpName}: the field starts with "${prefill}"`);
  await fresh.page.screenshot({ path: `screenshots/name-organization-${vpName}.png` });
  fresh.errors.forEach((e) => fail(`console ${vpName}: ${e}`));
  await fresh.ctx.close();
}

await browser.close();
console.log(state.failures ? `${state.failures} screenshot problem(s)` : "screenshots: all checks passed");
process.exit(state.failures ? 1 : 0);
