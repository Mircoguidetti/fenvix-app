// Before and after pictures of the console cleanup (console-cleanup/2026-11-27/shots/). Mock backend, served at
// BASE_URL; PREFIX names the set ("before" from an origin/main build, "after" from this branch). deviceScaleFactor 2,
// light and dark, 1440x900 and 390x844. Prints the console errors it saw (0 expected).
// Usage: BASE_URL=http://localhost:4173/ PREFIX=after node scripts/cleanup-shots.mjs
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:4173/";
const PREFIX = process.env.PREFIX ?? "after";
const OUT = process.env.OUT ?? "console-cleanup/2026-11-27/shots";
mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [["1440", { width: 1440, height: 900 }], ["390", { width: 390, height: 844 }]];
const browser = await chromium.launch();
const errors = [];
let count = 0;

async function context(scheme, viewport, init) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 2, reducedMotion: "reduce" });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.on("console", (m) => m.type() === "error" && errors.push(`${PREFIX} ${scheme} ${viewport.width}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${PREFIX} ${scheme} ${viewport.width}: ${e}`));
  return { ctx, page };
}
const shot = async (page, name, scheme, w) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${PREFIX}-${name}-${w}-${scheme}.png` });
  count++;
};
const settle = (page) => page.waitForFunction(() => !document.body.innerText.match(/^Loading\b/m));
async function nav(page, path) {
  await page.evaluate((p) => {
    history.pushState({}, "", `/${p}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await page.waitForSelector("main h1");
  await settle(page);
}

for (const scheme of ["light", "dark"]) {
  for (const [w, viewport] of VIEWPORTS) {
    // The loading screen: the scripts held back for 4 s, the picture taken at once.
    {
      const { ctx, page } = await context(scheme, viewport);
      await page.route(/\/assets\/.*\.js$/, async (r) => {
        await new Promise((res) => setTimeout(res, 4000));
        await r.continue();
      });
      await page.goto(BASE + "overview", { waitUntil: "commit" });
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${OUT}/${PREFIX}-loading-${w}-${scheme}.png` });
      count++;
      await page.getByRole("button", { name: "Continue with GitHub" }).waitFor();
      await ctx.close();
    }
    const { ctx, page } = await context(scheme, viewport);
    // Signed out: the sign-in (welcome) page.
    await page.goto(BASE + "projects/prj_homehub");
    await page.getByRole("button", { name: "Continue with GitHub" }).waitFor();
    await shot(page, "welcome", scheme, w);
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.locator(".shell").waitFor();
    await settle(page);
    for (const [name, path] of [["connect", "projects/connect"], ["usage", "usage"], ["settings", "settings"], ["coming-soon-nightly", "projects/prj_homehub/nightly"]]) {
      await nav(page, path);
      await shot(page, name, scheme, w);
    }
    // A toast after a change.
    await nav(page, "projects/prj_homehub/settings");
    await page.getByLabel("Test command").fill("pytest tests -q");
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.locator(".toast", { hasText: "Project settings saved" }).waitFor();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${PREFIX}-toast-${w}-${scheme}.png` });
    count++;
    await ctx.close();
  }
}
await browser.close();
console.log(`${count} pictures in ${OUT}/ (${PREFIX}); console errors: ${errors.length}`);
errors.forEach((e) => console.log("console error:", e));
process.exit(errors.length ? 1 : 0);
