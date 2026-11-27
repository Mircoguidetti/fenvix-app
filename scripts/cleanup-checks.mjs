// Checks of the console cleanup (console-cleanup/2026-11-27): toasts only after a change and top right, the usage
// table at three widths, billing hidden but reachable by its URL, the welcome redirect and its return path, the loading
// screen before and while the app loads, and the coming-soon pages. Mock backend, preview server on :4173 (run.mjs).
import { readFile } from "node:fs/promises";
import { BASE, VIEWPORTS, go, isMobile, launch, makeReporter, newPage, settled, signIn } from "./lib.mjs";

const { fail, pass, state } = makeReporter();
const browser = await launch();
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const path = (page) => {
  const u = new URL(page.url());
  return `${u.pathname}${u.search}`;
};

/** Counts every toast shown from now on (a toast may come and go between two looks). */
async function watchToasts(page) {
  await page.evaluate(() => {
    window.__toasts = [];
    const seen = new WeakSet();
    const look = () => {
      for (const t of document.querySelectorAll(".toast")) {
        if (seen.has(t)) continue;
        seen.add(t);
        const r = t.getBoundingClientRect();
        window.__toasts.push({ text: t.textContent.trim(), top: r.top, right: innerWidth - r.right, left: r.left });
      }
    };
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true });
    look();
  });
}
const toasts = (page) => page.evaluate(() => window.__toasts);

async function openAccount(page, vp) {
  if (isMobile(vp)) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator(".cx-drawer .account-btn").click();
    return page.locator(".cx-drawer .account-panel");
  }
  await page.locator(".cx-account .account-btn").click();
  return page.locator(".cx-account .account-panel");
}

async function signInWelcome(page) {
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await page.locator(".shell").waitFor();
  await settled(page);
}

const TESTS = {
  async "toasts: none after sign-in, sign-out, org switch or navigation"(page, vp) {
    await page.goto(BASE + "overview");
    await page.getByRole("button", { name: "Continue with GitHub" }).waitFor();
    await watchToasts(page);
    await signInWelcome(page);
    await go(page, "projects");
    await settled(page);
    await go(page, "usage");
    await settled(page);
    let panel = await openAccount(page, vp);
    await panel.getByRole("button", { name: /Harbor Analytics/ }).click();
    await page.getByRole("heading", { name: "Harbor Analytics" }).waitFor();
    panel = await openAccount(page, vp);
    await panel.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    // Sign in again and sign out from the Settings account card (a double click: it used to toast twice).
    await signInWelcome(page);
    await go(page, "settings");
    await page.locator("#account").getByRole("button", { name: "Sign out" }).dblclick();
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    await page.waitForTimeout(500);
    const seen = await toasts(page);
    assert(seen.length === 0, `toasts shown: ${seen.map((t) => t.text).join(" | ")}`);
  },

  async "toasts: one, top right, after Project settings saved"(page, vp) {
    await signIn(page, "projects/prj_homehub/settings");
    await watchToasts(page);
    await page.getByLabel("Test command").fill("pytest tests -q");
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.locator(".toast", { hasText: "Project settings saved" }).waitFor();
    await page.waitForTimeout(400);
    const seen = await toasts(page);
    assert(seen.length === 1 && seen[0].text.includes("Project settings saved"), `toasts: ${JSON.stringify(seen)}`);
    const t = seen[0];
    assert(Math.abs(t.top - 16) <= 1 && Math.abs(t.right - 16) <= 1, `the toast is at top ${t.top}, right ${t.right}`);
    if (vp.width < 600) assert(Math.abs(t.left - 16) <= 1, `below 600 px the toast does not span the width: left ${t.left}`);
  },

  async "usage table at 400, 1280 and 1920 px: one-line cells, no column past the card"(page) {
    await signIn(page, "usage");
    for (const width of [400, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      await page.locator(".usage-table tbody tr").first().waitFor();
      const m = await page.evaluate(() => {
        const card = document.querySelector(".usage-table-card").getBoundingClientRect();
        const line = parseFloat(getComputedStyle(document.querySelector(".usage-table td")).lineHeight) || 20;
        const tall = [];
        const past = [];
        for (const c of document.querySelectorAll(".usage-table td, .usage-table th")) {
          const r = c.getBoundingClientRect();
          if (!r.width) continue;
          // The text inside the cell, not the cell's own min-height or padding.
          const range = document.createRange();
          range.selectNodeContents(c);
          const lines = [...range.getClientRects()].reduce((s, x) => s.add(Math.round(x.top)), new Set()).size;
          if (lines > 2) tall.push(`${c.dataset.label ?? c.textContent.trim()}: ${lines} lines`);
          if (r.right > card.right + 0.5) past.push(`${c.dataset.label ?? c.textContent.trim()} ends at ${Math.round(r.right)}, card at ${Math.round(card.right)}`);
        }
        const name = document.querySelector(".usage-project-name");
        return { tall, past, line, title: name?.getAttribute("title"), text: name?.textContent, pageWide: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      });
      assert(m.tall.length === 0, `${width}px: ${m.tall.slice(0, 3).join("; ")}`);
      assert(m.past.length === 0, `${width}px: ${m.past.slice(0, 3).join("; ")}`);
      assert(m.title && m.title === m.text, `${width}px: the project cell has no full name in its title`);
      assert(!m.pageWide, `${width}px: the page scrolls sideways`);
    }
  },

  async "billing: no link to it anywhere in the navigation; /billing still renders"(page, vp) {
    await signIn(page, "usage");
    if (isMobile(vp)) await page.getByRole("button", { name: "Open navigation" }).click();
    for (const route of ["usage", "overview", "settings", "projects/prj_homehub/settings"]) {
      await go(page, route);
      await settled(page);
      const n = await page.locator('a[href="/billing"]').count();
      assert(n === 0, `${route}: ${n} link(s) to /billing`);
      assert(!(await page.getByText("Usage and billing").count()), `${route}: the area is still called Usage and billing`);
    }
    if (!isMobile(vp)) {
      await page.getByRole("combobox", { name: /Search or jump to/i }).or(page.getByPlaceholder(/Search or jump to/i)).first().fill("bill");
      await page.waitForTimeout(300);
      assert(!(await page.getByRole("option", { name: /Billing/ }).count()), "the command palette offers Billing");
      await page.keyboard.press("Escape");
    }
    await go(page, "billing");
    await page.getByRole("heading", { name: "Billing", level: 1 }).waitFor();
  },

  async "signed out: /projects/x goes to /welcome?next=…, and back there after sign-in"(page) {
    await page.goto(BASE + "projects/prj_homehub/time-to-green?x=1");
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    assert(path(page) === "/welcome?next=%2Fprojects%2Fprj_homehub%2Ftime-to-green%3Fx%3D1", `signed out at ${path(page)}`);
    await page.getByText("Welcome to fenvix. Sign in to see your runs.").waitFor();
    await signInWelcome(page);
    await page.getByRole("heading", { name: "Time to green", level: 1 }).waitFor();
    assert(path(page) === "/projects/prj_homehub/time-to-green?x=1", `after sign-in at ${path(page)}`);
    // The literal path of the spec.
    const fresh = await newPage(browser, { viewport: { width: 1280, height: 800 } });
    await fresh.page.goto(BASE + "projects/x");
    await fresh.page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    assert(path(fresh.page) === "/welcome?next=%2Fprojects%2Fx", `signed out at ${path(fresh.page)}`);
    await signInWelcome(fresh.page);
    assert(path(fresh.page) === "/projects/x", `after sign-in at ${path(fresh.page)}`);
    await fresh.ctx.close();
    // Signed in, /welcome goes to / (which opens the last project).
    await go(page, "welcome");
    await page.waitForURL((u) => u.pathname !== "/welcome");
    // "/" then opens the last project (App.tsx, Home).
    assert(["/", "/projects/prj_homehub"].includes(new URL(page.url()).pathname), `signed in, /welcome went to ${page.url()}`);
    await page.waitForURL((u) => u.pathname === "/projects/prj_homehub");
  },

  async "welcome: a next to another site goes to /"(page) {
    for (const bad of ["//evil.example/x", "/\\evil.example", "https://evil.example/", "javascript:alert(1)"]) {
      const { ctx, page: p } = await newPage(browser, { viewport: { width: 1280, height: 800 } });
      await p.goto(`${BASE}welcome?next=${encodeURIComponent(bad)}`);
      await signInWelcome(p);
      const u = new URL(p.url());
      assert(u.origin === new URL(BASE).origin, `${bad}: left the site for ${u.origin}`);
      assert(u.pathname === "/" || u.pathname.startsWith("/projects/") || u.pathname === "/overview", `${bad}: landed on ${u.pathname}`);
      await ctx.close();
    }
  },

  async "loading screen: in the built index.html, visible at once with a slow start, never an empty #root"(page) {
    const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
    assert(/<div id="root"><div class="boot"[^>]*role="status"/.test(html), "dist/index.html has no loading screen inside #root");
    const { ctx, page: p } = await newPage(browser, { viewport: { width: 1280, height: 800 } });
    // A cold start: the scripts arrive 3 s late and the API mock answers after 3 s.
    await ctx.addInitScript(() => {
      window.__fenvixMockDelayMs = 3000;
      window.__emptyRoot = 0;
      window.__frames = 0;
      const tick = () => {
        const r = document.getElementById("root");
        if (r) {
          window.__frames++;
          if (r.children.length === 0) window.__emptyRoot++;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      new MutationObserver(() => {
        const r = document.getElementById("root");
        if (r && r.children.length === 0 && document.readyState !== "loading") window.__emptyRoot++;
      }).observe(document, { childList: true, subtree: true });
    });
    await p.route(/\/assets\/.*\.js$/, async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.continue();
    });
    const t0 = Date.now();
    await p.goto(BASE + "overview", { waitUntil: "commit" });
    await p.locator(".boot").waitFor({ state: "visible", timeout: 300 });
    const shownAfter = Date.now() - t0;
    assert(shownAfter <= 300 + 50, `the loading screen appeared after ${shownAfter} ms`);
    await p.getByRole("button", { name: "Continue with GitHub" }).waitFor({ timeout: 15000 });
    const m = await p.evaluate(() => ({ empty: window.__emptyRoot, frames: window.__frames }));
    assert(m.frames > 10, `only ${m.frames} frames were looked at`);
    assert(m.empty === 0, `#root was empty in ${m.empty} frame(s)`);
    await ctx.close();
  },

  async "loading screen: after 8 s still loading it says the service is waking up"(page) {
    const { ctx, page: p } = await newPage(browser, { viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => (window.__fenvixMockDelayMs = 10000));
    await p.goto(BASE + "overview");
    const note = p.locator(".boot .boot-note");
    await p.waitForTimeout(2000);
    assert(!(await note.isVisible()), "the waking-up line shows before 8 s");
    await note.waitFor({ state: "visible", timeout: 8000 });
    assert((await note.innerText()) === "Waking up the service...", `the line reads ${await note.innerText()}`);
    await ctx.close();
  },

  async "coming soon: every live-list item has a nav entry that opens its page"(page, vp) {
    await signIn(page, "projects/prj_homehub");
    const items = [
      ["Detailed proof", "/projects/prj_homehub/proof"],
      ["Compatibility", "/projects/prj_homehub/compatibility"],
      ["Is this red real?", "/projects/prj_homehub/is-this-red-real"],
      ["Database copies", "/projects/prj_homehub/database"],
      ["Nightly exploration", "/projects/prj_homehub/nightly"],
      ["Python", "/python"],
    ];
    for (const [label, to] of items) {
      // Python belongs to the Projects area (no project needed); the others are sections of the open project.
      await go(page, to === "/python" ? "projects" : "projects/prj_homehub");
      await settled(page);
      let nav = page.locator(".cx-sub");
      if (isMobile(vp)) {
        await page.getByRole("button", { name: "Open navigation" }).click();
        nav = page.locator(".cx-drawer");
      }
      await nav.getByRole("link", { name: new RegExp(`^${label.replace(/[?]/g, "\\?")}`) }).first().click();
      await page.waitForURL((u) => u.pathname === to);
      await page.getByRole("heading", { name: label, level: 1 }).waitFor();
      await page.locator(".coming-soon").getByRole("heading", { name: "Coming soon" }).waitFor();
    }
    // Cache with proof is the existing page, renamed.
    await go(page, "projects/prj_homehub/skip-with-proof");
    await page.getByRole("heading", { name: "Cache with proof", level: 1 }).waitFor();
  },
};

const only = process.env.ONLY;
for (const [vpName, viewport] of VIEWPORTS) {
  for (const [name, fn] of Object.entries(TESTS)) {
    if (only && !name.includes(only)) continue;
    // The loading-screen and redirect checks open their own pages; run them once.
    if (vpName === "mobile" && /^(loading screen|welcome:)/.test(name)) continue;
    const { ctx, page, errors } = await newPage(browser, { viewport });
    page.setDefaultTimeout(20000);
    const label = `${name} (${vpName})`;
    try {
      await fn(page, viewport);
      if (errors.length) throw new Error(`console: ${errors[0]}`);
      pass(label);
      console.log("ok  ", label);
    } catch (e) {
      fail(`${label}: ${process.env.STACK ? e.stack : String(e.message).split("\n")[0]}`);
      await page.screenshot({ path: `/tmp/fail-cleanup-${vpName}-${name.replace(/\W+/g, "-")}.png` }).catch(() => {});
    }
    await ctx.close();
  }
}
await browser.close();
console.log(state.failures ? `${state.failures} cleanup check(s) failed` : `cleanup checks: all ${state.passes} passed`);
process.exit(state.failures ? 1 : 0);
