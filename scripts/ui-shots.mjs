// Redesign check: screenshots of the redesigned screens at six widths, with the phone measurements the brief asks for
// (no horizontal scroll, touch targets of at least 44px on a phone, axe), and the mockup and real pictures at 1440
// (scripts/side-by-side.py puts them next to each other).
// Usage: preview server on :4173 built with VITE_DATA_BACKEND=mock VITE_STYLEGUIDE=1, then
//   MOCKS=<folder with the .dc.html files and support.js> node scripts/ui-shots.mjs [screen ...]
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { BASE, go, settled } from "./lib.mjs";

const SIZES = [[360, 800], [390, 844], [430, 932], [768, 1024], [1024, 768], [1440, 900]];
// name, route, mockup file (for the 1440 comparison), what to do first
const SCREENS = {
  databases: ["databases", "Main"],
  "databases-filtered": ["databases?q=acme-bank-prod&tag=env:prod", null],
  "create-database": ["databases/new", "Create"],
  styleguide: ["styleguide", null],
};
const only = process.argv.slice(2);
const OUT = "docs/ui";
mkdirSync(OUT, { recursive: true });
let problems = 0;
const fail = (m) => (problems++, console.log("FAIL", m));
const rows = [];

const browser = await chromium.launch();
for (const [w, h] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: "reduce", hasTouch: w < 700 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(BASE + "overview");
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await page.locator(".shell").waitFor();
  await settled(page);

  const measure = async (label) => {
    const m = await page.evaluate((phone) => {
      const vw = document.documentElement.clientWidth;
      const scrollWidth = document.documentElement.scrollWidth;
      const small = [];
      if (phone) {
        const sel = 'a[href], button, input, textarea, [role="switch"], [role="option"], [role="combobox"], summary';
        for (const el of document.querySelectorAll(sel)) {
          if (el.closest("[hidden], dialog:not([open])") || el.classList.contains("skip-link") || el.classList.contains("sr-only")) continue;
          if (getComputedStyle(el).visibility === "hidden") continue;
          let box = el;
          if (el.matches("input[type=checkbox], input[type=radio]")) box = el.closest("label") ?? el;
          const r = box.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          if (getComputedStyle(el).display === "inline" && el.closest("p, li, span.help")) continue; // links inside a sentence
          if (r.width < 43.5 || r.height < 43.5) small.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      return { vw, scrollWidth, small };
    }, w <= 640);
    const axe = (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations.map((v) => `${v.id}(${v.nodes.length}) ${v.nodes[0]?.target}`);
    if (m.scrollWidth > m.vw) fail(`${label} ${w}: scrollWidth ${m.scrollWidth} > ${m.vw}`);
    for (const s of m.small.slice(0, 6)) fail(`${label} ${w}: touch target ${s}`);
    for (const a of axe) fail(`${label} ${w}: axe ${a}`);
    rows.push(`${label.padEnd(24)} ${String(w).padStart(4)}  scrollWidth ${m.scrollWidth}/${m.vw}  small targets ${w <= 640 ? m.small.length : "n/a"}  axe ${axe.length}`);
  };

  for (const [name, [route, mock]] of Object.entries(SCREENS)) {
    if (only.length && !only.includes(name)) continue;
    await go(page, route);
    await page.waitForSelector("main h1");
    await settled(page);
    await page.waitForTimeout(300);
    await measure(name);
    await page.mouse.move(2, 2);
    await page.screenshot({ path: `${OUT}/${name}-${w}.png` });
    if (w === 1440 && mock && process.env.MOCKS) {
      const m = await ctx.newPage();
      await m.setViewportSize({ width: 1440, height: 900 });
      await m.route(/googleapis|gstatic/, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
      await m.goto(`file://${process.env.MOCKS}/${mock}.dc.html`);
      const fonts = "/home/user/fenvix-app/node_modules/@fontsource-variable";
      await m.addStyleTag({ content: `@font-face{font-family:'Geist';font-weight:100 900;src:url(file://${fonts}/geist/files/geist-latin-wght-normal.woff2)}@font-face{font-family:'Geist Mono';font-weight:100 900;src:url(file://${fonts}/geist-mono/files/geist-mono-latin-wght-normal.woff2)}` });
      await m.waitForTimeout(1000);
      await m.screenshot({ path: `${OUT}/${name}-mockup-1440.png` });
      await m.close();
    }
  }

  // Phone: the navigation drawer, and a dialog as a full-screen sheet.
  if (!only.length && w < 900) {
    await go(page, "databases");
    await settled(page);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator(".drawer .nav").waitFor();
    await measure("drawer");
    await page.screenshot({ path: `${OUT}/drawer-${w}.png` });
    await page.keyboard.press("Escape");
    await page.locator(".drawer").waitFor({ state: "hidden" });
    const back = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    if (back !== "Open navigation") fail(`drawer ${w}: focus is on ${back} after Escape`);
  }
  if (!only.length) {
    await go(page, "styleguide");
    await page.waitForSelector("main h1");
    await page.getByRole("button", { name: "Open a confirmation" }).click();
    await page.getByRole("dialog").waitFor();
    await measure("dialog");
    await page.screenshot({ path: `${OUT}/dialog-${w}.png` });
    await page.keyboard.press("Escape");
  }
  errors.forEach((e) => fail(`console ${w}: ${e}`));
  await ctx.close();
}
await browser.close();
console.log(rows.join("\n"));
console.log(problems ? `${problems} problem(s)` : "ui-shots: all checks passed");
process.exit(problems ? 1 : 0);
