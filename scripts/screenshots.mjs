// Regenerates every screenshot in screenshots/ and checks layout and accessibility on each screen.
// Usage: npm run check (builds, serves and runs everything), or with a preview server on :4173: npm run screenshots
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { BASE, VIEWPORTS, axeViolations, isMobile, launch, layoutProblems, makeReporter, newPage, settled, signIn } from "./lib.mjs";

const { fail, state } = makeReporter();
const THEMES = ["light", "dark"];
const MAX_HEIGHT = 2200; // long lists are cut here so the images stay a sensible size

const SCREENS = [
  ["databases", "#/"],
  ["databases-grouped", "#/?group=customer&q=acme"],
  ["databases-filtered", "#/?tag=customer:acme-labs&tag=env:prod"],
  ["database-detail", "#/databases/db_0001"],
  ["create-database", "#/databases/new"],
  ["usage", "#/usage"],
  ["usage-by-tag", "#/usage?by=tag&key=customer"],
  ["billing", "#/billing"],
  ["api-keys", "#/api-keys"],
  ["settings", "#/settings"],
];

mkdirSync("screenshots", { recursive: true });
for (const f of readdirSync("screenshots")) if (f.endsWith(".png")) rmSync(`screenshots/${f}`);
const browser = await launch();

for (const [vpName, viewport] of VIEWPORTS) {
  for (const theme of THEMES) {
    const { ctx, page, errors } = await newPage(browser, { viewport, theme });

    const check = async (label) => {
      (await layoutProblems(page)).forEach((p) => fail(`${label}: ${p}`));
      (await axeViolations(page)).forEach((v) => fail(`${label}: ${v}`));
    };
    const shot = async (name, label) => {
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      const path = `screenshots/${name}-${vpName}-${theme}.png`;
      if (height > MAX_HEIGHT) await page.screenshot({ path, clip: { x: 0, y: 0, width: viewport.width, height: MAX_HEIGHT } });
      else await page.screenshot({ path, fullPage: true });
      void label;
    };

    // Sign-in page, signed out.
    await page.goto(BASE + "#/");
    await page.getByRole("button", { name: "Continue with GitHub" }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const names = await page.getByRole("button").allTextContents();
    const order = ["Continue with GitHub", "Continue with Google", "Email me a sign-in link"].map((n) => names.findIndex((t) => t.includes(n)));
    if (order.some((i) => i < 0) || order[0] > order[1] || order[1] > order[2]) fail(`sign-in ${vpName} ${theme}: buttons missing or out of order: ${names}`);
    await check(`sign-in ${vpName} ${theme}`);
    await shot("sign-in");

    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.locator("main h1").first().waitFor();
    await settled(page);

    for (const [name, hash] of SCREENS) {
      const label = `${name} ${vpName} ${theme}`;
      await page.goto(BASE + hash);
      await page.waitForSelector("main h1");
      await settled(page);
      if (!(await page.locator(".tag-sample:visible").count())) fail(`${label}: Sample data label not visible`);
      await check(label);
      await shot(name);
    }

    // Grouped list with one group open and bulk bar showing.
    await page.goto(BASE + "#/?group=customer&q=acme");
    await settled(page);
    await page.locator(".group-toggle").first().click();
    await page.getByRole("button", { name: /^Select all \d+ in / }).click();
    await page.getByRole("region", { name: "Bulk actions" }).waitFor();
    await check(`databases-bulk ${vpName} ${theme}`);
    await shot("databases-bulk");

    // Dialogs
    await page.goto(BASE + "#/databases/db_0001");
    await settled(page);
    for (const [name, button, dialogName] of [
      ["fork-dialog", "Fork", "Fork this database"],
      ["restore-dialog", "Restore to a point in time", "Restore to a point in time"],
      ["erase-dialog", "Erase", "Erase this database?"],
    ]) {
      await page.getByRole("button", { name: button, exact: true }).click();
      await page.getByRole("dialog", { name: dialogName }).waitFor();
      await check(`${name} ${vpName} ${theme}`);
      await page.screenshot({ path: `screenshots/${name}-${vpName}-${theme}.png` });
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    }

    await page.goto(BASE + "#/api-keys");
    await settled(page);
    await page.getByRole("button", { name: "Revoke key CI pipeline" }).click();
    await page.getByRole("dialog").waitFor();
    await check(`revoke-dialog ${vpName} ${theme}`);
    await page.screenshot({ path: `screenshots/api-keys-revoke-dialog-${vpName}-${theme}.png` });
    await page.keyboard.press("Escape");

    // A confirmation message
    await page.goto(BASE + "#/databases/db_0001");
    await settled(page);
    await page.getByLabel("Add a tag").fill("team:data");
    await page.getByRole("button", { name: "Add tag", exact: true }).click();
    await page.getByText("Added tag team:data").waitFor();
    await page.screenshot({ path: `screenshots/confirmation-${vpName}-${theme}.png` });

    // Navigation drawer and user menu
    if (isMobile(viewport)) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("navigation", { name: "Main" }).waitFor();
      await check(`drawer ${theme}`);
      await page.screenshot({ path: `screenshots/drawer-${vpName}-${theme}.png` });
      await page.locator(".drawer .user-btn").click();
    } else {
      await page.locator(".sidebar .user-btn").click();
    }
    await page.getByRole("button", { name: "Sign out" }).waitFor();
    await check(`user-menu ${vpName} ${theme}`);
    await page.screenshot({ path: `screenshots/user-menu-${vpName}-${theme}.png` });

    errors.forEach((e) => fail(`console ${vpName} ${theme}: ${e}`));
    await ctx.close();
  }
}

await browser.close();
console.log(state.failures ? `${state.failures} screenshot problem(s)` : "screenshots: all checks passed");
process.exit(state.failures ? 1 : 0);
