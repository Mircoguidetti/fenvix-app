// Pictures of the top of the navigation (brand and workspace) with a short and a long workspace name,
// on desktop and on a phone (drawer open). Checks layout and clipped text on each one.
// Usage, with a preview server on :4173: node scripts/sidebar-shots.mjs screenshots/sidebar
import { mkdirSync } from "node:fs";
import { VIEWPORTS, go, isMobile, launch, layoutProblems, makeReporter, newPage, renderProblems, settled, signIn } from "./lib.mjs";

const OUT = process.argv[2] ?? "screenshots/sidebar";
const NAMES = [
  ["my-workspace", "My workspace"],
  ["long-name", "Northwind Cloud Platform Engineering, EU West production"],
];

const { fail, state } = makeReporter();
mkdirSync(OUT, { recursive: true });
const browser = await launch();

for (const [vpName, viewport] of VIEWPORTS) {
  const { ctx, page, errors } = await newPage(browser, { viewport });
  await signIn(page, "settings");
  for (const [slug, name] of NAMES) {
    await go(page, "settings");
    await settled(page);
    await page.getByLabel("Workspace name").fill(name);
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Settings saved").waitFor();
    await page.locator(".toast").getByRole("button", { name: "Dismiss message" }).click();
    await go(page, "overview");
    await settled(page);
    await page.waitForFunction((n) => document.querySelector(".workspace-name")?.textContent.includes(n), name);
    if (isMobile(viewport)) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page.locator(".drawer .nav").waitFor();
    }
    await page.mouse.move(viewport.width - 2, viewport.height - 2);
    await page.waitForTimeout(250);
    const label = `${slug} ${vpName}`;
    (await layoutProblems(page)).forEach((p) => fail(`${label}: ${p}`));
    (await renderProblems(page)).forEach((p) => fail(`${label}: ${p}`));
    await page.screenshot({ path: `${OUT}/${slug}-${vpName}.png` });
    if (isMobile(viewport)) await page.getByRole("button", { name: "Close navigation" }).click();
  }
  errors.forEach((e) => fail(`console ${vpName}: ${e}`));
  await ctx.close();
}

await browser.close();
console.log(state.failures ? `${state.failures} problem(s)` : `sidebar shots: saved in ${OUT}`);
process.exit(state.failures ? 1 : 0);
