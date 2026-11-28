// Before/after shots of /projects/connect against the mock backend.
// Usage: node connect-redesign/2026-11-28/shots.mjs <dist dir built with VITE_DATA_BACKEND=mock> <out dir> <label> <port>
// State A: a new organization with no GitHub App installation (made through the email sign-in, as the checks do).
// State B: Northwind Cloud, which has installations in every state (the founder's case).
// 1440x900 light and dark, 390x844 light, deviceScaleFactor 2; prints the console errors seen (expected: 0).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const [dist, out, label, port] = process.argv.slice(2);
const PORT = Number(port);
const BASE = `http://localhost:${PORT}/`;
mkdirSync(out, { recursive: true });

const server = spawn("node_modules/.bin/vite", ["preview", "--outDir", dist, "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
process.on("exit", () => server.kill());
server.on("exit", (code) => code && console.log(`the preview server stopped (${code}): is port ${PORT} taken?`));
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(BASE)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 200));
}

const settled = async (page) => {
  await page.waitForFunction(() => !document.body.innerText.match(/^Loading\b/m));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
};

async function stateB(page) {
  await page.goto(BASE + "projects/connect");
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await page.locator(".shell").waitFor();
  await page.getByRole("heading", { name: "Connect a project", exact: true }).waitFor();
}

async function stateA(page) {
  await page.goto(BASE);
  await page.getByLabel("Work email").fill("sam.rivera@northwind.cloud");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByText("We sent a sign-in link to sam.rivera@northwind.cloud").waitFor();
  const go = (p) => page.evaluate((x) => { history.pushState({}, "", `/${x}`); window.dispatchEvent(new PopStateEvent("popstate")); }, p);
  await go("?token=one-time");
  await page.getByRole("heading", { name: "Name your organization" }).waitFor();
  await page.getByLabel("Organization name").fill("Rivera Labs");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator(".shell").waitFor();
  await go("projects/connect");
  await page.getByRole("heading", { name: "Connect a project", exact: true }).waitFor();
}

const browser = await chromium.launch();
const shots = [
  ["1440", { width: 1440, height: 900 }, "light"],
  ["1440", { width: 1440, height: 900 }, "dark"],
  ["390", { width: 390, height: 844 }, "light"],
];
let errorCount = 0;
for (const [state, open] of [["A", stateA], ["B", stateB]]) {
  for (const [w, viewport, scheme] of shots) {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 2, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await open(page);
    await settled(page);
    const file = `${out}/${label}-${state}-${w}-${scheme}.png`;
    await page.screenshot({ path: file });
    // The page scrolls inside the shell, so a full-length shot makes the viewport as tall as the content.
    const tall = await page.evaluate(() => {
      let el = document.querySelector("main");
      while (el && el !== document.body && !(el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      const box = el && el !== document.body ? el : document.documentElement;
      return Math.ceil(box.scrollHeight + (box === document.documentElement ? 0 : box.getBoundingClientRect().top));
    });
    await page.setViewportSize({ width: viewport.width, height: Math.min(Math.max(tall, viewport.height), 6000) });
    await page.waitForTimeout(200);
    await page.screenshot({ path: file.replace(/\.png$/, "-full.png") });
    errorCount += errors.length;
    console.log(`${file}: ${errors.length} console errors${errors.length ? ` (${errors[0]})` : ""}`);
    await ctx.close();
  }
}
await browser.close();
console.log(`console errors in total: ${errorCount}`);
process.exit(errorCount ? 1 : 0);
