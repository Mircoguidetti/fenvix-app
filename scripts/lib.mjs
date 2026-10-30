// Shared helpers for the screenshot and behaviour checks. Both need the preview server (see run.mjs).
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

export const BASE = process.env.BASE_URL ?? "http://localhost:4173/";
export const VIEWPORTS = [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
];

/** Nothing in the product may read as a demo, a draft or a stand-in. */
export const BANNED = /sample|demo|test|placeholder|coming soon|planned|preview|lorem/i;

export const launch = () => chromium.launch();

/**
 * Picks `value` in one of the dashboard's selects (src/components/Select.tsx): opens it and clicks the option. Its
 * options may still be loading, so it opens it again until the option is there (as selectOption waits for one).
 */
export async function choose(page, select, value) {
  const list = page.getByRole("listbox");
  const option = list.locator(`[data-value="${value}"]`);
  for (let i = 0; i < 40; i++) {
    if ((await select.getAttribute("aria-expanded")) !== "true") await select.click();
    try {
      await option.waitFor({ timeout: 500 });
    } catch {
      if ((await select.getAttribute("aria-expanded")) === "true") await select.click();
      continue;
    }
    await option.click();
    await list.waitFor({ state: "detached" });
    return;
  }
  throw new Error(`the select has no option ${value}`);
}

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
export async function newPage(browser, { viewport, acceptDownloads = true } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: "light", reducedMotion: "reduce", acceptDownloads });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("requestfailed", (r) => errors.push(`request failed: ${r.url()}`));
  return { ctx, page, errors };
}

/**
 * Moves to a path the way a click on a link does: no page load, so the mock's in-memory data
 * survives (a real load resets it). The first visit of a page is a normal load.
 */
export async function go(page, path) {
  if (!page.url().startsWith("http")) return page.goto(BASE + path);
  await page.evaluate((p) => {
    history.pushState({}, "", `/${p}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await page.waitForTimeout(60);
}

export const isMobile = (viewport) => viewport.width < 760;

/** Signs in with GitHub through the real sign-in page and waits for the dashboard. */
export async function signIn(page, route = "overview") {
  await page.goto(BASE + route);
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await page.locator(".shell").waitFor();
  await settled(page);
}

/** Waits until the shell and the page have their data. */
export async function settled(page) {
  await page.waitForFunction(() => !document.body.innerText.match(/^Loading\b/m));
  // The workspace in the sidebar is drawn only once its name has loaded.
  await page.waitForFunction(() => [...document.querySelectorAll(".workspace-slot")].every((el) => el.dataset.state !== "loading"));
  await page.evaluate(() => document.fonts.ready);
}

/** Visible text of the page, with the text of inputs and selects. */
export async function visibleText(page) {
  return page.evaluate(() => {
    const parts = [document.body.innerText];
    for (const el of document.querySelectorAll("input, textarea")) {
      if (el.type === "checkbox" || el.type === "radio") continue;
      parts.push(el.value, el.placeholder ?? "");
    }
    for (const s of document.querySelectorAll("select")) parts.push(...[...s.options].map((o) => o.textContent));
    for (const el of document.querySelectorAll("[aria-label], [title]")) parts.push(el.getAttribute("aria-label") ?? "", el.getAttribute("title") ?? "");
    return parts.join("\n");
  });
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
    // Elements under a dialog, the drawer or an open menu are not a layout problem.
    const onTop = (e) => {
      const r = e.getBoundingClientRect();
      const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !t || e.contains(t) || t.contains(e);
    };
    const hit = [...document.querySelectorAll("a, button, input, select, textarea")].filter((e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      // Inline links wrap across lines, so their boxes overlap by design.
      if (cs.display === "inline") return false;
      return onTop(e) && r.width && r.height && !e.closest("[hidden],dialog:not([open])") && !e.classList.contains("skip-link") && cs.visibility !== "hidden" && !(e.type === "radio" || e.type === "checkbox") && cs.position !== "absolute";
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

/** Text that is cut off by its own box, and charts with no shape in them. */
export async function renderProblems(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("td, th, .chip, .kpi-value, .hbar-label, .nav-link span, .workspace-name, .plan-head h3, .btn")) {
      if (!el.offsetParent && el.tagName !== "BODY") continue;
      const cs = getComputedStyle(el);
      if (cs.overflow === "visible" || el.children.length > 1) continue;
      if (el.scrollWidth > el.clientWidth + 2 && cs.textOverflow !== "ellipsis") out.push(`clipped text in ${el.tagName}.${el.className}: ${el.textContent.trim().slice(0, 30)}`);
    }
    for (const svg of document.querySelectorAll(".chart svg")) {
      const shapes = svg.querySelectorAll("rect, path, circle, line");
      if (shapes.length < 4) out.push(`chart with almost nothing in it (${shapes.length} shapes)`);
      const labels = [...svg.querySelectorAll("text")].filter((t) => /^[A-Z][a-z]{2} \d+$|^\d{2}:\d{2}$/.test(t.textContent));
      const names = labels.map((t) => t.textContent);
      if (new Set(names).size !== names.length) out.push(`repeated axis label: ${names.join(", ")}`);
      // Labels that sit on top of each other.
      const boxes = labels.map((t) => t.getBoundingClientRect()).sort((a, b) => a.left - b.left);
      for (let i = 1; i < boxes.length; i++) if (boxes[i].left < boxes[i - 1].right + 2) out.push(`axis labels overlap: ${names.join(", ")}`);
    }
    for (const axis of document.querySelectorAll(".timeline-axis")) {
      const boxes = [...axis.querySelectorAll("span")].map((s) => s.getBoundingClientRect()).sort((a, b) => a.left - b.left);
      for (let i = 1; i < boxes.length; i++) if (boxes[i].left < boxes[i - 1].right + 2) out.push(`timeline labels overlap: ${[...axis.querySelectorAll("span")].map((s) => s.textContent).join(", ")}`);
    }
    return out;
  });
}

export async function axeViolations(page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  return axe.violations.map((v) => `axe ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target}`);
}

/** On a phone the state, group, sort and tag filters sit behind the "Filters" button: opens them when they are shut. */
export async function openFilters(page) {
  const toggle = page.getByRole("button", { name: /^Filters/ });
  if ((await toggle.count()) && (await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}
