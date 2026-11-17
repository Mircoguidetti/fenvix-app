// Regenerates every screenshot in screenshots/ and checks layout, rendering and accessibility on each one.
// Usage: npm run check (builds, serves and runs everything), or with a preview server on :4173: npm run screenshots
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { BANNED, BASE, VIEWPORTS, axeViolations, flakyRun, go, isMobile, launch, layoutProblems, makeReporter, newPage, renderProblems, settled, visibleText } from "./lib.mjs";

const { fail, state } = makeReporter();
const MAX_HEIGHT = 2600; // long lists are cut here so the files stay a sensible size

const SCREENS = [
  ["overview", "overview"],
  ["projects", "projects"],
  ["project-runs", "projects/prj_homehub"],
  ["project-runs-failed", "projects/prj_storefront?status=failed"],
  ["project-setup", "projects/prj_docs?tab=setup"],
  ["project-settings", "projects/prj_homehub?tab=settings"],
  ["connect", "projects/connect"],
  ["defects", "defects"],
  ["defect", "defects/dfx_9a10"],
  ["defect-node", "defects/dfx_3b05"],
  ["usage", "usage"],
  ["billing", "billing"],
  ["api-keys", "api-keys"],
  ["members", "settings/members"],
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
      const el = document.querySelector(".cx-content") ?? document.documentElement;
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

  // A run with a flaky failure, its failed tests, and a skip receipt.
  const flaky = await flakyRun(page);
  await go(page, `projects/${flaky.projectId}/runs/${flaky.runId}`);
  await page.waitForSelector("main h1");
  await settled(page);
  await page.waitForTimeout(250);
  await check(`run ${vpName}`);
  await shot("run");
  await page.locator("#tests").getByRole("button", { name: /^Failed/ }).click();
  await page.locator(".test-failure").first().waitFor();
  await check(`run-failed ${vpName}`);
  await shot("run-failed");
  await page.locator("#tests").getByRole("button", { name: /^Skipped/ }).click();
  await page.waitForFunction(() => document.querySelector(".test-row")?.dataset.outcome === "skipped_with_proof");
  await page.locator(".test-row").first().getByRole("button", { name: /^Receipt for / }).click();
  await page.getByRole("dialog").getByText("Cache key").waitFor();
  await check(`receipt ${vpName}`);
  await shot("skip-receipt", true);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });

  // A select, open: the list under it with the choice ticked.
  await go(page, "defects");
  await settled(page);
  await page.getByLabel("Project").click();
  await page.getByRole("listbox").waitFor();
  await check(`select-open ${vpName}`);
  await shot("select-open", true);
  await page.keyboard.press("Escape");

  // Onboarding: GitHub's install page (stood in for), then the setup pull request.
  await go(page, "projects/connect");
  await settled(page);
  await page.getByRole("button", { name: "Add repositories on GitHub" }).click();
  await page.getByRole("dialog").getByRole("checkbox").first().check();
  await check(`connect-install ${vpName}`);
  await shot("connect-install-dialog", true);
  await page.getByRole("dialog").getByRole("button", { name: "Install" }).click();
  await page.locator(".setup-row").first().waitFor();
  await page.locator(".toast").getByRole("button", { name: "Dismiss message" }).click();
  await check(`connect-setup ${vpName}`);
  await shot("connect-setup");
  await page.locator(".setup-row").first().getByRole("button", { name: "Open the pull request" }).click();
  await page.locator(".setup-done").first().waitFor();
  await page.locator(".toast").getByRole("button", { name: "Dismiss message" }).click();
  await check(`connect-pr ${vpName}`);
  await shot("connect-pull-request");

  await go(page, "api-keys");
  await settled(page);
  await page.getByRole("button", { name: "Revoke key Release pipeline" }).click();
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(300); // the dialog has finished appearing before its colours are measured
  await page.waitForFunction(() => !document.querySelector(".toast"), null, { timeout: 15000 }).catch(() => {});
  await check(`revoke-dialog ${vpName}`);
  await shot("api-keys-revoke-dialog", true);
  await page.keyboard.press("Escape");

  // A confirmation message
  await go(page, "projects/prj_homehub?tab=settings");
  await settled(page);
  await page.getByRole("switch", { name: /Comment on pull requests/ }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByText("Project settings saved").waitFor();
  await shot("confirmation", true);
  await page.locator(".toast").getByRole("button", { name: "Dismiss message" }).click();
  await page.locator(".toast").waitFor({ state: "hidden" });

  // Navigation drawer and the account menu
  if (isMobile(viewport)) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator(".cx-drawer .cx-drawer-top").waitFor();
    await check(`drawer ${vpName}`);
    await shot("drawer", true);
    await page.locator(".cx-drawer .user-btn").click();
  } else {
    await page.locator(".cx-account .user-btn").click();
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
