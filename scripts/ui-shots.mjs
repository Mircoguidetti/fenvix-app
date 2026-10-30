// Redesign check: every redesigned screen at six widths, with the phone measurements the brief asks for (no horizontal
// scroll, touch targets of at least 44px on a phone, axe), and screenshots at 1440 and 390 in docs/ui. At 1440 the
// mockup of the same screen is drawn too (scripts/side-by-side.py puts the two next to each other).
// Usage: preview server on :4173 built with VITE_DATA_BACKEND=mock VITE_STYLEGUIDE=1, then
//   MOCKS=<folder with the .dc.html files and support.js> node scripts/ui-shots.mjs [screen ...]
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { BASE, go, openFilters, settled } from "./lib.mjs";

const SIZES = [[360, 800], [390, 844], [430, 932], [768, 1024], [1024, 768], [1440, 900]];
const SAVE = new Set([390, 1440]);
const click = (page, sel) => page.locator(sel).first().click();
const SCREENS = {
  databases: { route: "databases", mock: "Main" },
  "databases-filtered": { route: "databases?q=acme-bank-prod&tag=env:prod" },
  "create-database": { route: "databases/new", mock: "Create" },
  "database-overview": { route: "databases/db_0001", mock: "DbOverview" },
  "data-collections": { route: "databases/db_0001?tab=data", mock: "Data", pre: async (p) => p.locator(".coll-btn").first().waitFor() },
  "data-documents": { route: "databases/db_0001?tab=data", pre: async (p) => (await click(p, ".coll-btn"), p.locator(".doc-pick").first().waitFor()) },
  "data-document": { route: "databases/db_0001?tab=data", pre: async (p) => (await click(p, ".coll-btn"), await click(p, ".doc-pick"), p.locator(".field-row").first().waitFor()) },
  "data-add-field": { route: "databases/db_0001?tab=data", pre: async (p) => (await click(p, ".coll-btn"), await click(p, ".doc-pick"), await p.getByRole("button", { name: "Add field", exact: true }).click(), p.locator(".add-field").waitFor()) },
  "data-query-builder": { route: "databases/db_0001?tab=data", mock: "Query", pre: async (p) => (await p.getByRole("button", { name: "Query builder" }).click(), await p.getByRole("group", { name: "Condition 1" }).getByLabel("Field").fill("status"), await p.getByRole("group", { name: "Condition 1" }).getByLabel("Value").fill("paid"), await p.getByRole("button", { name: "Run query" }).click(), p.getByText(/documents,/).waitFor()) },
  "database-users": { route: "databases/db_0001?tab=users", mock: "Users" },
  "database-network": { route: "databases/db_0001?tab=network", mock: "Network" },
  overview: { route: "overview", mock: "OrgOverview" },
  usage: { route: "usage", mock: "Usage" },
  billing: { route: "billing", mock: "Billing" },
  members: { route: "settings/members", mock: "Members" },
  settings: { route: "settings", mock: "Settings" },
  "api-keys": { route: "api-keys", mock: "ApiKeys" },
  "not-found": { route: "no-such-page", mock: "States", noH1: true },
  styleguide: { route: "styleguide" },
};
const only = process.argv.slice(2);
const OUT = "docs/ui";
if (!only.length) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
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
        if (el.matches("input[type=range]")) box = el;
        const r = box.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (getComputedStyle(el).display === "inline" && el.closest("p, li")) continue; // a link inside a sentence
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

  // Signed out: the sign-in page.
  if (!only.length || only.includes("sign-in")) {
    await page.goto(BASE + "overview");
    await page.getByRole("button", { name: "Continue with GitHub" }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await measure(page, "sign-in", w);
    if (SAVE.has(w)) await page.screenshot({ path: `${OUT}/sign-in-${w}.png` });
    if (w === 1440 && process.env.MOCKS) await mock(ctx, "Login", "sign-in");
  }
  await page.goto(BASE + "overview");
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await page.locator(".shell").waitFor();
  await settled(page);

  for (const [name, def] of Object.entries(SCREENS)) {
    if (only.length && !only.includes(name)) continue;
    await go(page, def.route);
    if (!def.noH1) await page.waitForSelector("main h1");
    await settled(page);
    await def.pre?.(page);
    await page.waitForTimeout(350);
    await measure(page, name, w);
    await page.mouse.move(2, 2);
    if (SAVE.has(w)) await page.screenshot({ path: `${OUT}/${name}-${w}.png` });
    if (w === 1440 && def.mock && process.env.MOCKS) await mock(ctx, def.mock, name);
  }

  if (!only.length) {
    // The restore dialog, the confirmation with a typed name, and the drawer.
    await go(page, "databases/db_0001");
    await settled(page);
    await page.getByRole("button", { name: "Restore to a point in time" }).click();
    await page.getByRole("dialog").waitFor();
    await measure(page, "restore-dialog", w);
    if (SAVE.has(w)) await page.screenshot({ path: `${OUT}/restore-dialog-${w}.png` });
    if (w === 1440 && process.env.MOCKS) await mock(ctx, "Restore", "restore-dialog", 760, 860);
    await page.keyboard.press("Escape");
    await go(page, "databases/db_0001?tab=data");
    await settled(page);
    await click(page, ".coll-btn");
    await page.getByRole("button", { name: "Insert document" }).click();
    await page.getByRole("dialog").waitFor();
    await measure(page, "insert-dialog", w);
    if (SAVE.has(w)) await page.screenshot({ path: `${OUT}/insert-dialog-${w}.png` });
    await page.keyboard.press("Escape");
    if (w < 900) {
      await go(page, "databases");
      await settled(page);
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page.locator(".drawer .nav").waitFor();
      await measure(page, "drawer", w);
      if (SAVE.has(w)) await page.screenshot({ path: `${OUT}/drawer-${w}.png` });
      await page.keyboard.press("Escape");
      await page.locator(".drawer").waitFor({ state: "hidden" });
      const back = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      if (back !== "Open navigation") fail(`drawer ${w}: focus is on ${back} after Escape`);
    }
    await go(page, "styleguide");
    await page.waitForSelector("main h1");
    await page.getByRole("button", { name: "Open a confirmation" }).click();
    await page.getByRole("dialog").waitFor();
    await measure(page, "confirm-dialog", w);
    if (SAVE.has(w)) await page.screenshot({ path: `${OUT}/confirm-dialog-${w}.png` });
    await page.keyboard.press("Escape");
  }
  errors.forEach((e) => fail(`console ${w}: ${e}`));
  await ctx.close();
}

async function mock(ctx, file, name, mw = 1440, mh = 900) {
  const m = await ctx.newPage();
  await m.setViewportSize({ width: mw, height: mh });
  await m.route(/googleapis|gstatic/, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await m.goto(`file://${process.env.MOCKS}/${file}.dc.html`);
  const fonts = new URL("../node_modules/@fontsource-variable", import.meta.url).pathname;
  await m.addStyleTag({ content: `@font-face{font-family:'Geist';font-weight:100 900;src:url(file://${fonts}/geist/files/geist-latin-wght-normal.woff2)}@font-face{font-family:'Geist Mono';font-weight:100 900;src:url(file://${fonts}/geist-mono/files/geist-mono-latin-wght-normal.woff2)}` });
  await m.waitForTimeout(1000);
  await m.screenshot({ path: `${OUT}/${name}-mockup-1440.png` });
  await m.close();
}

await browser.close();
console.log(rows.join("\n"));
console.log(problems ? `${problems} problem(s)` : "ui-shots: all checks passed");
process.exit(problems ? 1 : 0);
