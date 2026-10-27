// Shared helpers for the screenshot and behaviour checks. Both need the preview server (see run.mjs).
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

export const BASE = process.env.BASE_URL ?? "http://localhost:4173/";
export const VIEWPORTS = [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
];

export const launch = () => chromium.launch();

export function makeReporter() {
  const state = { failures: 0, passes: 0 };
  return {
    state,
    fail(msg) {
      state.failures++;
      console.log("FAIL", msg);
    },
    pass(msg) {
      state.passes++;
      if (process.env.VERBOSE) console.log("ok  ", msg);
    },
  };
}

/** New page that records console errors and failed requests into `errors`. */
export async function newPage(browser, { viewport, theme = "light", acceptDownloads = true } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: "reduce", acceptDownloads });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("requestfailed", (r) => errors.push(`request failed: ${r.url()}`));
  return { ctx, page, errors };
}

export const isMobile = (viewport) => viewport.width < 760;

/** Signs in with GitHub through the real sign-in page and waits for the dashboard. */
export async function signIn(page, route = "#/") {
  await page.goto(BASE + route);
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await page.locator("main h1").first().waitFor();
  await page.getByRole("button", { name: "Continue with GitHub" }).waitFor({ state: "detached" });
  await settled(page);
}

/** Waits until no "Loading ..." message is left and fonts are ready. */
export async function settled(page) {
  await page.waitForFunction(() => !document.body.innerText.match(/^Loading\b/m));
  await page.evaluate(() => document.fonts.ready);
}

/** Horizontal overflow and overlapping interactive elements. */
export async function layoutProblems(page) {
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
    // Elements covered by a dialog, the drawer or a menu are not a layout problem.
    const onTop = (e) => {
      const r = e.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const t = document.elementFromPoint(x, y);
      return !t || e.contains(t) || t.contains(e);
    };
    const hit = [...document.querySelectorAll("a, button, input, select, textarea")].filter((e) => {
      const r = e.getBoundingClientRect();
      return onTop(e) && r.width && r.height && !e.closest("[hidden],dialog:not([open])") && !e.classList.contains("skip-link") && getComputedStyle(e).visibility !== "hidden" && !(e.type === "radio" || e.type === "checkbox") && getComputedStyle(e).position !== "absolute";
    });
    for (let i = 0; i < hit.length; i++)
      for (let j = i + 1; j < hit.length; j++) {
        const a = hit[i].getBoundingClientRect(), b = hit[j].getBoundingClientRect();
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 1 && h > 1 && !hit[i].contains(hit[j]) && !hit[j].contains(hit[i])) out.push(`overlap: ${hit[i].tagName}[${hit[i].textContent.trim().slice(0, 20)}] and ${hit[j].tagName}[${hit[j].textContent.trim().slice(0, 20)}]`);
      }
    return out;
  });
}

export async function axeViolations(page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  return axe.violations.map((v) => `axe ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target}`);
}
