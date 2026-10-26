// Usage: npm run build && npx vite preview --port 4173 (other shell) && npm run screenshots
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:4173/";
const SCREENS = [
  ["databases", "#/"],
  ["database-detail", "#/databases/db_01"],
  ["billing", "#/billing"],
  ["api-keys", "#/api-keys"],
  ["settings", "#/settings"],
];
const VIEWPORTS = [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
];
const THEMES = ["light", "dark"];

mkdirSync("screenshots", { recursive: true });
const browser = await chromium.launch();
let failures = 0;
const fail = (msg) => { failures++; console.log("FAIL", msg); };

/** Horizontal overflow and overlapping interactive elements. */
async function layoutProblems(page) {
  return page.evaluate(() => {
    const out = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw) out.push(`page scrolls horizontally (${document.documentElement.scrollWidth} > ${vw})`);
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || el.closest("[hidden],dialog:not([open])")) continue;
      const cs = getComputedStyle(el);
      if (cs.position === "fixed" || el.closest(".sr-only") || el.classList.contains("sr-only") || el.classList.contains("skip-link")) continue;
      if (r.right > vw + 1 && !el.closest(".table-scroll")) out.push(`${el.tagName}.${el.className} extends past viewport (${Math.round(r.right)} > ${vw})`);
    }
    const hit = [...document.querySelectorAll("a, button, input, select, textarea")].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width && r.height && !e.closest("[hidden],dialog:not([open])") && !e.classList.contains("skip-link") && getComputedStyle(e).visibility !== "hidden" && !(e.type === "radio" || e.type === "checkbox");
    });
    for (let i = 0; i < hit.length; i++) for (let j = i + 1; j < hit.length; j++) {
      const a = hit[i].getBoundingClientRect(), b = hit[j].getBoundingClientRect();
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 1 && h > 1 && !hit[i].contains(hit[j]) && !hit[j].contains(hit[i])) out.push(`overlap: ${hit[i].tagName}[${hit[i].textContent.trim().slice(0, 20)}] and ${hit[j].tagName}[${hit[j].textContent.trim().slice(0, 20)}]`);
    }
    return out;
  });
}

for (const [vpName, viewport] of VIEWPORTS) {
  for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("requestfailed", (r) => errors.push(`request failed: ${r.url()}`));

    const check = async (label) => {
      const probs = await layoutProblems(page);
      probs.forEach((p) => fail(`${label}: ${p}`));
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      axe.violations.forEach((v) => fail(`${label}: axe ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target}`));
    };

    for (const [name, hash] of SCREENS) {
      const label = `${name} ${vpName} ${theme}`;
      await page.goto(BASE + hash);
      await page.waitForSelector("main h1");
      await page.waitForFunction(() => !document.body.innerText.match(/^Loading /m));
      await page.evaluate(() => document.fonts.ready);
      if (!(await page.locator(".tag-sample:visible").count())) fail(`${label}: Sample data label not visible`);
      await check(label);
      await page.screenshot({ path: `screenshots/${name}-${vpName}-${theme}.png`, fullPage: true });
    }

    // Revoke confirmation dialog
    await page.goto(BASE + "#/api-keys");
    await page.getByRole("button", { name: "Revoke key CI pipeline" }).click();
    await page.getByRole("dialog").waitFor();
    await check(`revoke-dialog ${vpName} ${theme}`);
    await page.screenshot({ path: `screenshots/api-keys-revoke-dialog-${vpName}-${theme}.png` });
    await page.keyboard.press("Escape");

    // Mobile drawer
    if (vpName === "mobile") {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("navigation", { name: "Main" }).waitFor();
      await check(`drawer ${theme}`);
      await page.screenshot({ path: `screenshots/drawer-${vpName}-${theme}.png` });
    }

    if (errors.length) errors.forEach((e) => fail(`console ${vpName} ${theme}: ${e}`));
    await ctx.close();
  }
}

// Behaviour: filter, sort, create key, revoke, keyboard reachability of the theme toggle.
{
  const page = await (await browser.newContext({ viewport: VIEWPORTS[0][1] })).newPage();
  await page.goto(BASE + "#/");
  await page.waitForSelector("tbody tr");
  await page.getByLabel("State").selectOption("awake");
  const awake = await page.locator("tbody tr").count();
  if (awake !== 4) fail(`filter awake expected 4 rows, got ${awake}`);
  await page.getByLabel("Search by name").fill("billing");
  if ((await page.locator("tbody tr").count()) !== 1) fail("search should leave 1 row");
  await page.getByLabel("State").selectOption("all");
  await page.getByLabel("Search by name").fill("");
  await page.getByRole("button", { name: "Name" }).click();
  const first = await page.locator("tbody tr a").first().textContent();
  if (first !== "agent-memory") fail(`sort by name asc first row was ${first}`);
  await page.goto(BASE + "#/api-keys");
  await page.getByLabel("Key name").fill("Test key");
  await page.getByRole("button", { name: "Create key" }).click();
  await page.getByText("Key “Test key” created.").waitFor();
  await page.getByRole("button", { name: "Revoke key Test key" }).click();
  await page.getByRole("button", { name: "Revoke key", exact: true }).click();
  await page.getByRole("row", { name: /Test key/ }).getByText("Revoked").waitFor();
  await page.goto(BASE + "#/databases/db_01");
  await page.getByRole("button", { name: /Copy connection string/ }).waitFor();
  await page.getByRole("button", { name: "Switch to dark theme" }).or(page.getByRole("button", { name: "Switch to light theme" })).first().focus();
  console.log("behaviour checks done");
}

await browser.close();
console.log(failures ? `${failures} problem(s)` : "all checks passed");
process.exit(failures ? 1 : 0);
