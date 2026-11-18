// Every dashboard screen at six widths, with the phone measurements of the redesign brief: no horizontal scroll, touch
// targets of at least 44 px on a phone, axe. Nothing is saved: the pictures are docs/screenshots/ (npm run screenshots).
// Usage: preview server on :4173 built with VITE_DATA_BACKEND=mock VITE_STYLEGUIDE=1, then node scripts/ui-shots.mjs [screen ...]
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { BASE, go, settled } from "./lib.mjs";

const SIZES = [[360, 800], [390, 844], [430, 932], [768, 1024], [1024, 768], [1440, 900]];
const SCREENS = {
  overview: "overview",
  projects: "projects",
  "project-runs": "projects/prj_homehub",
  "project-settings": "projects/prj_homehub/settings",
  "skip-with-proof": "projects/prj_homehub/skip-with-proof",
  nightly: "projects/prj_homehub/nightly",
  "time-to-green": "projects/prj_homehub/time-to-green",
  connect: "projects/connect",
  "connect-error": "projects/connect?github=error&reason=expired",
  defects: "defects",
  defect: "defects/dfx_9a10",
  usage: "usage",
  billing: "billing",
  members: "settings/members",
  settings: "settings",
  "api-keys": "api-keys",
  "not-found": "no-such-page",
  styleguide: "styleguide",
};
const only = process.argv.slice(2);
let problems = 0;
const fail = (m) => (problems++, console.log("FAIL", m));
const rows = [];

async function measure(page, label, w) {
  const m = await page.evaluate((phone) => {
    const vw = document.documentElement.clientWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    const small = [];
    if (phone) {
      const sel = 'a[href], button, input, textarea, [role="switch"], [role="option"], [role="combobox"], summary, select';
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest("[hidden], dialog:not([open])") || el.classList.contains("skip-link") || el.classList.contains("sr-only")) continue;
        if (el.disabled || el.getAttribute("aria-hidden") === "true" || getComputedStyle(el).visibility === "hidden") continue;
        let box = el;
        if (el.matches("input[type=checkbox], input[type=radio]")) box = el.closest("label") ?? el;
        const r = box.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if ((getComputedStyle(el).display === "inline" || el.classList.contains("link-btn")) && el.closest("p, li, dd, td")) continue; // a link inside a sentence (exempt in WCAG 2.2, 2.5.8)
        if (r.width < 43.5 || r.height < 43.5) small.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return { vw, scrollWidth, small };
  }, w <= 640);
  const axe = (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations.map((v) => `${v.id}(${v.nodes.length}) ${v.nodes[0]?.target}`);
  if (m.scrollWidth > m.vw) fail(`${label} ${w}: scrollWidth ${m.scrollWidth} > ${m.vw}`);
  for (const s of m.small.slice(0, 6)) fail(`${label} ${w}: touch target ${s}`);
  for (const a of axe) fail(`${label} ${w}: axe ${a}`);
  rows.push(`${label.padEnd(22)} ${String(w).padStart(4)}  scrollWidth ${m.scrollWidth}/${m.vw}  small targets ${w <= 640 ? m.small.length : "n/a"}  axe ${axe.length}`);
}

const browser = await chromium.launch();
for (const [w, h] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: "reduce", hasTouch: w < 700 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(BASE + "overview");
  await page.getByRole("button", { name: "Continue with GitHub" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  if (!only.length || only.includes("sign-in")) await measure(page, "sign-in", w);
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await page.locator(".shell").waitFor();
  await settled(page);

  for (const [name, route] of Object.entries(SCREENS)) {
    if (only.length && !only.includes(name)) continue;
    await go(page, route);
    await page.waitForSelector("main h1");
    await settled(page);
    await page.waitForTimeout(300);
    await measure(page, name, w);
  }
  errors.forEach((e) => fail(`console ${w}: ${e}`));
  await ctx.close();
}

await browser.close();
console.log(rows.join("\n"));
console.log(problems ? `${problems} problem(s)` : "ui-shots: all checks passed");
process.exit(problems ? 1 : 0);
