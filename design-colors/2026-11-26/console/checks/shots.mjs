import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire("/opt/node-tools/");
const { chromium } = require("playwright");
const DIR = "/home/user/fenvix-app/design-colors/2026-11-26/console/";
const BASE = "http://localhost:5173/";
const ALLOWED_HOSTS = new Set(["localhost:5173", "fonts.googleapis.com", "fonts.gstatic.com"]);
const kits = (process.env.KITS ?? "K0,K1,K2,K3,K4").split(",");
const browser = await chromium.launch();
const results = [];

const measure = () => {
  const parse = (s) => { const m = s.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 }; };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return +((x + 0.05) / (y + 0.05)).toFixed(2); };
  const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  // Probes: real computed colours of token pairs (an element styled with the app's own classes or vars).
  const probe = (style, cls = "", tag = "div") => { const e = document.createElement(tag); if (cls) e.className = cls; e.style.cssText = style; e.textContent = "Aa"; document.body.appendChild(e); const cs = getComputedStyle(e); const out = { color: cs.color, bg: cs.backgroundColor }; e.remove(); return out; };
  const pair = (fgVar, bgVar, base = "--page") => {
    const pageBg = parse(probe(`background:var(${base})`).bg);
    const p = probe(`color:var(${fgVar});background:var(${bgVar})`);
    const bg = over(parse(p.bg), pageBg); const fg = over(parse(p.color), bg);
    return { fg: hex(fg), bg: hex(bg), ratio: ratio(fg, bg) };
  };
  const btn = probe("", "btn btn-primary", "button");
  const bb = over(parse(btn.bg), parse(probe("background:var(--page)").bg));
  const contrast = {
    "body text on page (--text/--page)": pair("--text", "--page"),
    "body text on card (--text/--bg)": pair("--text", "--bg"),
    "muted text on page (--muted/--page)": pair("--muted", "--page"),
    "muted text on card (--muted/--bg)": pair("--muted", "--bg"),
    "muted text on surface (--muted/--surface)": pair("--muted", "--surface"),
    "primary button text (.btn-primary)": { fg: hex(over(parse(btn.color), bb)), bg: hex(bb), ratio: ratio(over(parse(btn.color), bb), bb) },
    "[info] soft text on card (--muted-2/--bg)": pair("--muted-2", "--bg"),
    "[info] soft text on surface (--muted-2/--surface)": pair("--muted-2", "--surface"),
    "[info] selected nav item (--nav-on/--nav-active over --nav-sub)": pair("--nav-on", "--nav-active", "--nav-sub"),
    "[info] blue (--chart) on page": pair("--chart", "--page"),
    "[info] blue (--chart) on card": pair("--chart", "--bg"),
  };
  // Headings h1-h3: every visible text node's computed colour.
  const headings = [...document.querySelectorAll("h1, h2, h3")].filter((h) => h.getClientRects().length).map((h) => {
    const colors = new Set(); const w = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const n = w.currentNode; if (!n.textContent.trim() || !n.parentElement.getClientRects().length) continue; const cs = getComputedStyle(n.parentElement); colors.add(cs.color + (cs.backgroundClip === "text" ? " (clip-text " + cs.backgroundImage.slice(0, 40) + ")" : "")); if (cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color) colors.add("fill " + cs.webkitTextFillColor); }
    return { tag: h.tagName, text: h.textContent.trim().slice(0, 60), colors: [...colors] };
  });
  const tokens = Object.fromEntries(["--black", "--text", "--page", "--bg", "--muted", "--nav-on", "--chart", "--success", "--danger", "--warning", "--font"].map((t) => [t, getComputedStyle(document.documentElement).getPropertyValue(t).trim()]));
  return { contrast, headings, multiColourHeadings: headings.filter((h) => h.colors.length > 1), tokens, font: getComputedStyle(document.body).fontFamily, fontsLoaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family).filter((v, i, a) => a.indexOf(v) === i) };
};

for (const kit of kits) {
  const css = readFileSync(DIR + kit + ".css", "utf8");
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce" });
    await ctx.addInitScript(({ css, font }) => {
      const add = () => {
        if (font) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,200..800;1,200..800&display=swap"; document.head.appendChild(l); }
        const s = document.createElement("style"); s.id = "kit-override"; s.textContent = css; document.head.appendChild(s);
      };
      if (document.head) add(); else document.addEventListener("DOMContentLoaded", add);
    }, { css, font: kit === "K4" });
    const page = await ctx.newPage();
    const errors = [], foreign = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("requestfailed", (r) => errors.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));
    page.on("request", (r) => { const u = new URL(r.url()); if (/^(data|blob):/.test(u.protocol)) return; if (!ALLOWED_HOSTS.has(u.host)) foreign.push(r.url()); });
    const hosts = new Set(); page.on("request", (r) => { try { const u = new URL(r.url()); if (u.host) hosts.add(u.host); } catch {} });
    await page.goto(BASE + "overview");
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.locator(".shell").waitFor();
    await page.waitForFunction(() => !document.body.innerText.match(/^Loading\b/m));
    await page.waitForFunction(() => [...document.querySelectorAll(".workspace-slot")].every((el) => el.dataset.state !== "loading"));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    const out = { kit, scheme, pages: {} };
    out.pages.overview = await page.evaluate(measure);
    await page.screenshot({ path: `${DIR}shots/${kit}-overview-${scheme}.png` });
    const run = await page.evaluate(async () => (await window.__fenvixMock.listRuns("prj_homehub", { status: "passed", pageSize: 5 })).items[0]);
    const path = `projects/${run.projectId}/runs/${run.id}`;
    await page.evaluate((p) => { history.pushState({}, "", `/${p}`); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
    await page.waitForTimeout(300);
    await page.waitForFunction(() => !document.body.innerText.match(/^Loading\b/m));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    out.runPath = path;
    out.pages.run = await page.evaluate(measure);
    out.pages.run.url = page.url();
    await page.screenshot({ path: `${DIR}shots/${kit}-run-${scheme}.png` });
    out.consoleErrors = errors; out.foreignRequests = foreign; out.hosts = [...hosts];
    results.push(out);
    console.log(kit, scheme, "errors", errors.length, "foreign", foreign.length, "multi-colour headings", out.pages.overview.multiColourHeadings.length + out.pages.run.multiColourHeadings.length, "font", out.pages.overview.font.slice(0, 30));
    await ctx.close();
  }
}
await browser.close();
writeFileSync(DIR + "checks/kit-checks.json", JSON.stringify(results, null, 1));
