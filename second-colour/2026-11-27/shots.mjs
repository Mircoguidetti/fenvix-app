// Second colour board: every page below, for today's colours and for each kit in kits/, injected as a <style> after
// the app's own stylesheet (so nothing in src/ changes). Mock backend preview on :4173 (VITE_DATA_BACKEND=mock).
// Usage: node second-colour/2026-11-27/shots.mjs [kit ...]   (kit names: reference, a, b, c, d, e)
import { chromium } from "playwright";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, go, settled } from "../../scripts/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "shots");
const PAGES = {
  overview: "overview",
  runs: "projects/prj_homehub",
  parallel: "projects/prj_homehub/parallel-with-proof",
  usage: "usage",
  settings: "settings",
};
const VARIANTS = [
  ["desktop-light", { width: 1440, height: 900 }, "light"],
  ["desktop-dark", { width: 1440, height: 900 }, "dark"],
  ["phone-light", { width: 390, height: 844 }, "light"],
];
const kits = { reference: "" };
for (const f of readdirSync(join(HERE, "kits")).sort()) if (f.endsWith(".css")) kits[f.split("-")[0]] = readFileSync(join(HERE, "kits", f), "utf8");
const only = process.argv.slice(2);
let errorsTotal = 0;
let count = 0;

const browser = await chromium.launch();
for (const [kit, css] of Object.entries(kits)) {
  if (only.length && !only.includes(kit)) continue;
  mkdirSync(join(OUT, kit), { recursive: true });
  for (const [vname, viewport, theme] of VARIANTS) {
    const ctx = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: "reduce", deviceScaleFactor: 2, hasTouch: viewport.width < 700 });
    await ctx.addInitScript(([t, kitCss]) => {
      try { localStorage.setItem("fenvix-theme", t); } catch {}
      if (!kitCss) return;
      const add = () => { const s = document.createElement("style"); s.id = "second-colour-kit"; s.textContent = kitCss; document.head.appendChild(s); };
      if (document.head) document.addEventListener("DOMContentLoaded", add); else document.addEventListener("DOMContentLoaded", add);
    }, [theme, css]);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(BASE + "overview");
    await page.getByRole("button", { name: "Continue with GitHub" }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(OUT, kit, `signin-${vname}.png`) }); count++;
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.locator(".shell").waitFor();
    await settled(page);
    for (const [name, route] of Object.entries(PAGES)) {
      await go(page, route);
      await page.waitForSelector("main h1");
      await settled(page);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(OUT, kit, `${name}-${vname}.png`) }); count++;
    }
    const injected = await page.evaluate(() => !!document.getElementById("second-colour-kit"));
    if (css && !injected) errors.push("kit stylesheet not injected");
    for (const e of errors) console.log(`ERROR ${kit} ${vname}: ${e}`);
    errorsTotal += errors.length;
    await ctx.close();
  }
}
await browser.close();
console.log(`${count} shots, ${errorsTotal} console error(s)`);
process.exit(errorsTotal ? 1 : 0);
