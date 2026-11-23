// Regenerates every screenshot of the dashboard in docs/screenshots/ (each page at 1440 and 390 px wide, in the light
// and the dark theme: <name>-<width>-<light|dark>.png) and checks layout, rendering and accessibility (axe, colour
// contrast included) on each one. The sign-in page and the screens before the dashboard are light only, as designed.
// Usage: npm run check (builds, serves and runs everything), or with a preview server on :4173: npm run screenshots
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { BANNED, BASE, VIEWPORTS, axeViolations, flakyRun, go, isMobile, launch, layoutProblems, makeReporter, newPage, proofRuns, renderProblems, runningRun, settled, shadowRun, useOrgOf, visibleText } from "./lib.mjs";

const { fail, state } = makeReporter();
const OUT = "docs/screenshots";
const MAX_HEIGHT = 3200; // long pages are cut here so the files stay a sensible size
const SCHEMES = ["light", "dark"];
const ONLY = process.env.ONLY_SCREENS ? new Set(process.env.ONLY_SCREENS.split(",")) : null;

/** Pages of Northwind Cloud, where the signed-in person is the owner. */
const SCREENS = [
  ["overview", "overview"],
  ["projects", "projects"],
  ["project-runs", "projects/prj_homehub"],
  ["project-runs-failed", "projects/prj_storefront?status=failed"],
  ["project-runs-not-proven", "projects/prj_homehub?status=not_proven"],
  ["parallel-with-proof", "projects/prj_homehub/parallel-with-proof"],
  ["parallel-with-proof-empty", "projects/prj_docs/parallel-with-proof"],
  ["project-settings", "projects/prj_homehub/settings"],
  ["skip-with-proof", "projects/prj_homehub/skip-with-proof"],
  ["nightly", "projects/prj_homehub/nightly"],
  ["time-to-green", "projects/prj_homehub/time-to-green"],
  ["project-defects", "projects/prj_storefront/defects"],
  ["connect", "projects/connect"],
  ["connect-connected", "projects/connect?github=connected&installation=51204331&account=northwind"],
  ["connect-requested", "projects/connect?github=requested"],
  ["connect-error", "projects/connect?github=error&reason=other_organization"],
  ["defects", "defects"],
  ["defect", "defects/dfx_9a10"],
  ["defect-node", "defects/dfx_3b05"],
  ["usage", "usage"],
  ["billing", "billing"],
  ["members", "settings/members"],
  ["settings", "settings"],
  ["api-keys", "api-keys"],
];

/** Pages of Harbor Analytics: in its shadow trial, the signed-in person a member there. */
const TRIAL_SCREENS = [
  ["overview-trial", "overview"],
  ["billing-trial", "billing"],
  ["nightly-addon", "projects/prj_homehub/nightly"],
  ["settings-member", "settings"],
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await launch();
const want = (name) => !ONLY || ONLY.has(name);

for (const scheme of SCHEMES) {
  for (const [, viewport] of VIEWPORTS) {
    const width = viewport.width;
    // The live run must still be running when it is drawn: the page asks once a minute here.
    const { ctx, page, errors } = await newPage(browser, { viewport, colorScheme: scheme, pollMs: 60_000 });
    page.setDefaultTimeout(20000);
    const tag = `${width} ${scheme}`;

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
     * The shell fills the window and the content column scrolls inside it, so a "full page" screenshot is just the
     * window. To show a whole page, the window is grown to fit the content first.
     */
    const shot = async (name, fixed) => {
      await page.mouse.move(2, 2); // no stray hover highlight in the picture
      const path = `${OUT}/${name}-${width}-${scheme}.png`;
      if (fixed) return page.screenshot({ path });
      const needed = await page.evaluate(() => Math.ceil((document.querySelector(".cx-content") ?? document.documentElement).scrollHeight));
      const height = Math.min(Math.max(needed, viewport.height), MAX_HEIGHT);
      if (height !== viewport.height) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(250); // charts measure themselves again
      }
      await page.screenshot({ path });
      if (height !== viewport.height) {
        await page.setViewportSize(viewport);
        await page.waitForTimeout(150);
      }
    };
    const screen = async (name, route, fixed) => {
      if (!want(name)) return;
      await go(page, route);
      await page.waitForSelector("main h1");
      await settled(page);
      await page.waitForTimeout(250);
      await check(`${name} ${tag}`);
      await shot(name, fixed);
    };

    // Signed out (light only, as designed).
    await go(page, "overview");
    await page.getByRole("button", { name: "Continue with GitHub" }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    if (scheme === "light" && want("sign-in")) {
      await check(`sign-in ${tag}`);
      await shot("sign-in");
    }
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.locator(".shell").waitFor();
    await settled(page);

    for (const [name, route] of SCREENS) await screen(name, route);

    // A run with a flaky failure, its failed tests, and a skip receipt.
    const flaky = await flakyRun(page);
    await screen("run", `projects/${flaky.projectId}/runs/${flaky.runId}`);
    if (want("run")) {
      await page.locator("#tests").getByRole("button", { name: /^Failed/ }).click();
      await page.locator(".test-failure").first().waitFor();
      await check(`run-failed ${tag}`);
      await shot("run-failed");
      await page.locator("#tests").getByRole("button", { name: /^Skipped/ }).click();
      await page.waitForFunction(() => document.querySelector(".test-row")?.dataset.outcome === "skipped_with_proof");
      await page.locator(".test-row").first().getByRole("button", { name: /^Receipt for / }).click();
      await page.getByRole("dialog").getByText("Cache key").waitFor();
      await check(`receipt ${tag}`);
      await shot("skip-receipt", true);
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    }

    // Parallel with proof on the run page: every test proven; not proven with a cause (and its tests); not proven
    // without a proof block; a serial run has no card (the "run" screen above).
    const proof = await proofRuns(page);
    await screen("run-proven", `projects/${proof.proven.projectId}/runs/${proof.proven.runId}`);
    await screen("run-not-proven", `projects/${proof.notProven.projectId}/runs/${proof.notProven.runId}`);
    await screen("run-not-proven-tests", `projects/${proof.notProven.projectId}/runs/${proof.notProven.runId}?outcome=not_proven`);
    await screen("run-not-proven-no-proof", `projects/${proof.noProof.projectId}/runs/${proof.noProof.runId}`);

    // The search of the top bar (desktop): a run number gives the run, with its project.
    if (want("search") && !isMobile(viewport)) {
      await go(page, "overview");
      await settled(page);
      await page.getByRole("combobox", { name: "Search or jump to" }).fill(String(proof.proven.number));
      await page.getByRole("option", { name: new RegExp(`^Run #${proof.proven.number}`) }).waitFor();
      await check(`search ${tag}`);
      await shot("search", true);
      await page.keyboard.press("Escape");
    }

    // The run that is still running: the live view.
    const running = await runningRun(page);
    await screen("run-live", `projects/${running.projectId}/runs/${running.runId}`);

    // A select, open: the list under it with the choice ticked.
    if (want("select-open")) {
      await go(page, "defects");
      await settled(page);
      await page.locator("#d-project").click();
      await page.getByRole("listbox").waitFor();
      await check(`select-open ${tag}`);
      await shot("select-open", true);
      await page.keyboard.press("Escape");
    }

    // A confirmation message.
    if (want("confirmation")) {
      await go(page, "projects/prj_homehub/settings");
      await settled(page);
      await page.getByRole("switch", { name: /Comment on pull requests/ }).click();
      await page.getByRole("button", { name: "Save settings" }).click();
      await page.getByText("Project settings saved").waitFor();
      await shot("confirmation", true);
      await page.locator(".toast").getByRole("button", { name: "Dismiss message" }).click();
      await page.locator(".toast").waitFor({ state: "hidden" });
    }

    // Navigation drawer and the account menu.
    if (want("user-menu")) {
      if (isMobile(viewport)) {
        await page.getByRole("button", { name: "Open navigation" }).click();
        await page.locator(".cx-drawer .cx-drawer-top").waitFor();
        await check(`drawer ${tag}`);
        await shot("drawer", true);
        await page.locator(".cx-drawer .user-btn").click();
      } else {
        await page.locator(".cx-account .user-btn").click();
      }
      await page.getByRole("button", { name: "Sign out" }).waitFor();
      await check(`user-menu ${tag}`);
      await shot("user-menu", true);
      await page.keyboard.press("Escape");
    }

    // Harbor Analytics: the shadow trial, a shadow run, the add-on note and the member's read-only settings.
    await useOrgOf(page, "org_harbor", "overview");
    for (const [name, route] of TRIAL_SCREENS) await screen(name, route);
    const shadow = await shadowRun(page);
    await screen("run-shadow", `projects/${shadow.projectId}/runs/${shadow.runId}`);

    // The invitation screen (accept), as an invited person sees it after signing in.
    if (scheme === "light" && want("invite")) {
      await page.evaluate(() => sessionStorage.setItem("fenvix-invite", "A".repeat(43)));
      await page.reload();
      await page.getByRole("heading", { name: "Join an organization" }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await check(`invite ${tag}`);
      await shot("invite", true);
      await page.evaluate(() => sessionStorage.removeItem("fenvix-invite"));
    }

    errors.forEach((e) => fail(`console ${tag}: ${e}`));
    await ctx.close();

    // A brand-new account: the first screen names its organization (light only, like the sign-in page).
    if (scheme === "light" && want("name-organization")) {
      const fresh = await newPage(browser, { viewport });
      await go(fresh.page, "overview");
      await fresh.page.getByLabel("Work email").fill("spazio.milano@example.com");
      await fresh.page.getByRole("button", { name: "Email me a sign-in link" }).click();
      await fresh.page.getByText(/We sent a sign-in link/).waitFor();
      await go(fresh.page, "?token=one-time");
      await fresh.page.getByRole("heading", { name: "Name your organization" }).waitFor();
      await fresh.page.evaluate(() => document.fonts.ready);
      (await layoutProblems(fresh.page)).forEach((x) => fail(`name-organization ${tag}: ${x}`));
      (await axeViolations(fresh.page)).forEach((v) => fail(`name-organization ${tag}: ${v}`));
      const bgs = await fresh.page.evaluate(() => [document.documentElement, document.body, document.querySelector(".signin-page")].map((e) => getComputedStyle(e).backgroundColor));
      if (new Set(bgs).size !== 1) fail(`name-organization ${tag}: more than one background (${bgs.join(" / ")})`);
      const prefill = await fresh.page.getByLabel("Organization name").inputValue();
      if (prefill !== "Spazio Milano") fail(`name-organization ${tag}: the field starts with "${prefill}"`);
      await fresh.page.screenshot({ path: `${OUT}/name-organization-${width}-${scheme}.png` });
      fresh.errors.forEach((e) => fail(`console ${tag}: ${e}`));
      await fresh.ctx.close();
    }
  }
}

await browser.close();
const files = readdirSync(OUT).filter((f) => f.endsWith(".png")).length;
console.log(state.failures ? `${state.failures} screenshot problem(s)` : `screenshots: all checks passed, ${files} pictures in ${OUT}/`);
process.exit(state.failures ? 1 : 0);
