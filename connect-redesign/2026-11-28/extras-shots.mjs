// Before/after shots for the founder's follow-ups of 28 Nov: Projects empty state (one Connect button), the Projects
// navigation (no Python) and a project's tabs (four removed), the gate screens (Name your organization, No
// organization, Join an organization) and, after only, the setup page of one repository.
// Usage: node connect-redesign/2026-11-28/extras-shots.mjs <dist dir (mock build)> <out dir> <before|after> <port>
// deviceScaleFactor 2; prints console errors per shot (expected: 0) and each gate card's box against the viewport.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const [dist, out, label, port] = process.argv.slice(2);
const BASE = `http://localhost:${port}/`;
mkdirSync(out, { recursive: true });
const server = spawn("node_modules/.bin/vite", ["preview", "--outDir", dist, "--port", port, "--strictPort"], { stdio: "ignore" });
process.on("exit", () => server.kill());
server.on("exit", (code) => code && console.log(`the preview server stopped (${code}): is port ${port} taken?`));
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(BASE)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 200));
}

const go = (page, p) => page.evaluate((x) => { history.pushState({}, "", `/${x}`); window.dispatchEvent(new PopStateEvent("popstate")); }, p);
const settle = async (page) => {
  await page.waitForFunction(() => !document.body.innerText.match(/^Loading\b/m));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
};
async function github(page, route) {
  await page.goto(BASE + route);
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await page.locator(".shell").waitFor();
  await settle(page);
}
/** A new person by the email link: lands on "Name your organization". */
async function newPerson(page) {
  await page.goto(BASE);
  await page.getByLabel("Work email").fill("sam.rivera@northwind.cloud");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByText("We sent a sign-in link to sam.rivera@northwind.cloud").waitFor();
  await go(page, "?token=one-time");
  await page.getByRole("heading", { name: "Name your organization" }).waitFor();
}
async function named(page) {
  await newPerson(page);
  await page.getByLabel("Organization name").fill("Rivera Labs");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator(".shell").waitFor();
}

const SCENES = [
  ["projects-empty", async (page) => { await named(page); await go(page, "projects"); await page.getByRole("heading", { name: "No projects yet" }).waitFor(); }],
  ["projects-nav", async (page) => { await github(page, "projects"); }],
  ["project-tabs", async (page) => { await github(page, "projects/prj_homehub"); }],
  ["gate-name", async (page) => { await newPerson(page); }],
  ["gate-noorg", async (page) => {
    await named(page);
    await page.evaluate(() => {
      const s = JSON.parse(sessionStorage.getItem("fenvix-mock-orgs"));
      s.orgs = s.orgs.filter((o) => !o.members.some((m) => m.email === "sam.rivera@northwind.cloud"));
      sessionStorage.setItem("fenvix-mock-orgs", JSON.stringify(s));
    });
    await page.reload();
    await page.getByRole("heading", { name: "No organization yet" }).waitFor();
  }],
  ["gate-invite", async (page) => {
    await page.addInitScript(() => sessionStorage.setItem("fenvix-invite", "a".repeat(43)));
    await page.goto(BASE);
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.getByRole("heading", { name: "Join an organization" }).waitFor();
  }],
  ["setup-ready", async (page) => { await github(page, "projects/connect"); await page.getByRole("link", { name: "Set up northwind/billing-worker" }).click(); await page.getByRole("heading", { name: "Open the setup pull request" }).waitFor(); }, "after"],
  ["setup-pr-open", async (page) => { await github(page, "projects"); await page.locator(".setting-up").getByRole("link", { name: "northwind/mobile-app" }).click(); await page.getByRole("heading", { name: "Merge it on GitHub" }).waitFor(); }, "after"],
  ["setup-not-detected", async (page) => { await github(page, "projects/connect"); await page.getByRole("link", { name: "Set up northwind/design-system" }).click(); await page.getByRole("button", { name: "Check again" }).waitFor(); }, "after"],
];
const shots = [
  ["1440", { width: 1440, height: 900 }, "light"],
  ["1440", { width: 1440, height: 900 }, "dark"],
  ["390", { width: 390, height: 844 }, "light"],
];

const browser = await chromium.launch();
let errorCount = 0;
for (const [name, open, only] of SCENES) {
  if (only && only !== label) continue;
  for (const [w, viewport, scheme] of shots) {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 2, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    try {
      await open(page);
      await settle(page);
      const file = `${out}/${label}-${name}-${w}-${scheme}.png`;
      await page.screenshot({ path: file });
      let box = "";
      if (name.startsWith("gate-")) {
        const b = await page.locator(".signin-card, .gate-card").first().boundingBox();
        box = b ? ` card x=${Math.round(b.x)} y=${Math.round(b.y)} w=${Math.round(b.width)} h=${Math.round(b.height)} (left gap ${Math.round(b.x)}, right gap ${Math.round(viewport.width - b.x - b.width)})` : " card not found";
      }
      errorCount += errors.length;
      console.log(`${file}: ${errors.length} console errors${errors.length ? ` (${errors[0]})` : ""}${box}`);
    } catch (e) {
      errorCount++;
      console.log(`${label}-${name}-${w}-${scheme}: FAILED ${String(e.message).split("\n")[0]}`);
    }
    await ctx.close();
  }
}
await browser.close();
console.log(`console errors or failures in total: ${errorCount}`);
process.exit(errorCount ? 1 : 0);
