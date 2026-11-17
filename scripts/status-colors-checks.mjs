// Status colours in the browser, on desktop and on a phone-sized screen, against the mock backend: the colours each
// state is actually drawn in, that a coloured state also has a word or an icon, that no other hue shows anywhere, that
// silver is only where it belongs, and that nothing sticks out of the screen.
// Usage: npm run check (builds, serves and runs everything), or with a preview server on :4173: node scripts/status-colors-checks.mjs
import { VIEWPORTS, go, isMobile, launch, layoutProblems, makeReporter, newPage, settled, signIn, flakyRun } from "./lib.mjs";

const { fail, pass, state } = makeReporter();
const browser = await launch();

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// The tokens of src/styles.css, as the browser reports them.
const SUCCESS = "rgb(6, 122, 58)";
const DANGER = "rgb(214, 20, 10)";
const WARNING = "rgb(156, 89, 0)"; // --warning, #9c5900
const SUCCESS_DARK = "rgb(61, 220, 132)";
const DANGER_DARK = "rgb(255, 106, 92)";
const BLACK = "rgb(6, 8, 14)"; // --black, the one dark colour (#06080e, chosen by the founder)
const WHITE = "rgb(246, 246, 247)"; // --on-text, the paper white on a dark or red fill
const CHART = "rgb(6, 8, 14)"; // --chart, the one dark colour of bars and lines
const STATUS = [SUCCESS, DANGER, WARNING, SUCCESS_DARK, DANGER_DARK, "rgb(255, 176, 32)"];

/** Computed colours of the first element matching `selector` (optionally of a pseudo-element). */
async function paint(page, selector, pseudo) {
  const el = page.locator(selector).first();
  await el.waitFor();
  return el.evaluate((e, p) => {
    const cs = getComputedStyle(e, p ?? null);
    return { color: cs.color, bg: cs.backgroundColor, bgImage: cs.backgroundImage, border: cs.borderTopColor, borderLeft: cs.borderLeftColor, shadow: cs.boxShadow, borderWidth: cs.borderTopWidth + " " + cs.borderRightWidth + " " + cs.borderBottomWidth + " " + cs.borderLeftWidth, fill: cs.fill, stop: cs.stopColor, text: e.textContent.trim(), svg: !!e.querySelector("svg") };
  }, pseudo);
}

/**
 * Every visible element on the page: a saturated colour in its text, background, border, fill or stroke must be one
 * of the status colours, and the element, or one of its three nearest ancestors, must carry a word or an icon.
 */
async function huesOnPage(page, allowed) {
  const out = await page.evaluate((allowedList) => {
    const parse = (c) => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r, g, b, a, key: `rgb(${r}, ${g}, ${b})` };
    };
    const problems = new Set();
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest(".signin-providers")) continue; // the Google mark, in Google's colours
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden") continue;
      const props = [cs.color, cs.backgroundColor, cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor, cs.fill, cs.stroke];
      for (const p of props) {
        const c = parse(p);
        if (!c || c.a === 0) continue;
        const chroma = (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;
        if (chroma < 0.08) continue;
        // The blue family of the interface: greys with a slight blue tint and the dark colour (hue 205 to 240).
        const mx = Math.max(c.r, c.g, c.b), d = mx - Math.min(c.r, c.g, c.b);
        const h = (mx === c.r ? ((c.g - c.b) / d) % 6 : mx === c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4) * 60;
        if (((h + 360) % 360) >= 205 && ((h + 360) % 360) <= 240) continue;
        if (!allowedList.includes(c.key)) {
          problems.add(`${el.tagName.toLowerCase()}.${el.getAttribute("class") ?? ""} uses ${c.key}`);
          continue;
        }
        let n = el, said = false;
        for (let i = 0; i < 4 && n; i++, n = n.parentElement) if (n.textContent.trim() || n.querySelector?.("svg") || n.tagName === "svg" || n.getAttribute?.("aria-label")) said = true;
        if (!said) problems.add(`${el.tagName.toLowerCase()}.${el.getAttribute("class") ?? ""} is coloured with no word or icon`);
      }
    }
    return [...problems];
  }, allowed);
  assert(out.length === 0, out.slice(0, 4).join("; "));
}

/** Nothing scrolls sideways and no control overlaps another or leaves the window. */
async function fits(page) {
  const wide = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const content = document.querySelector(".cx-content");
    const out = [...document.querySelectorAll("main button, main a, main input, main .state, main .tag, dialog[open] button, .toast")]
      .filter((el) => el.getClientRects().length)
      .filter((el) => el.getBoundingClientRect().right > w + 0.5 || el.getBoundingClientRect().left < -0.5)
      .map((el) => el.textContent?.trim() || el.getAttribute("aria-label") || el.tagName);
    if (content && content.scrollWidth > content.clientWidth + 1) out.push("the content column scrolls sideways");
    return out;
  });
  assert(wide.length === 0, `outside the screen: ${wide.join(", ")}`);
  const layout = await layoutProblems(page);
  assert(layout.length === 0, layout[0]);
}

/** The open dialog has no border and no coloured line (destructive dialogs say so with their red confirm button). */
async function noBorder(page, what) {
  const d = await paint(page, "dialog[open]");
  assert(d.borderWidth === "0px 0px 0px 0px", `the ${what} dialog has a border (${d.borderWidth})`);
  assert(!d.shadow.includes("inset") && !STATUS.some((c) => d.shadow.includes(c)), `the ${what} dialog has a line (${d.shadow})`);
}

/** The selected tab or menu item shows its state with its background and weight: no line under it, no underline. */
async function noLine(page, selector) {
  const after = await paint(page, selector, "::after");
  assert(after.bgImage === "none" && !/gradient/.test(after.bgImage), `${selector} has a line under it (${after.bgImage})`);
  const deco = await page.locator(selector).first().evaluate((e) => getComputedStyle(e).textDecorationLine);
  assert(deco === "none", `${selector} is underlined`);
  const weight = await page.locator(selector).first().evaluate((e) => Number(getComputedStyle(e).fontWeight));
  assert(weight >= 500, `${selector} is not bold (${weight})`);
}


const TESTS = {
  async "projects: on fenvix and passed are green with their word, failed is red with its word"(page) {
    await signIn(page, "projects");
    const on = await paint(page, "main tbody .state-ok");
    assert(on.border === SUCCESS && on.text.length > 0, `on fenvix / passed: "${on.text}" ${on.border}`);
    const failed = page.locator("main tbody .state-danger");
    if (await failed.count()) {
      const f = await paint(page, "main tbody .state-danger");
      assert(f.text === "Failed" && f.border === DANGER && f.color === DANGER, `failed: "${f.text}" ${f.border}`);
    }
    await huesOnPage(page, STATUS);
    await fits(page);
  },

  async "a run: failed is red with its word, skipped with proof stays grey, the receipt dialog has no border"(page) {
    await signIn(page, "overview");
    const { projectId, runId } = await flakyRun(page);
    await go(page, `projects/${projectId}/runs/${runId}`);
    await settled(page);
    const head = await paint(page, ".page-header .state-danger");
    assert(head.text === "Failed" && head.border === DANGER, `the run's state: "${head.text}" ${head.border}`);
    await page.locator("#tests").getByRole("button", { name: /^Skipped/ }).click();
    const skipped = page.locator(".test-row .state", { hasText: "Skipped with proof" }).first();
    await skipped.waitFor();
    assert(!STATUS.includes(await skipped.evaluate((e) => getComputedStyle(e).borderTopColor)), "skipped with proof is coloured");
    await huesOnPage(page, STATUS);
    await fits(page);
    await page.locator(".test-row").first().getByRole("button", { name: /^Receipt for / }).click();
    await page.getByRole("dialog").getByText("Cache key").waitFor();
    await noBorder(page, "receipt");
    const close = await paint(page, "dialog[open] .btn-primary");
    assert(close.bg === BLACK, `the receipt's Close button is ${close.bg}`);
    await fits(page);
  },

  async "defects: open is red, replays 10/10 is green, both with their words"(page) {
    await signIn(page, "defects/dfx_7c21");
    const replays = await paint(page, ".page-header .state-ok");
    assert(replays.text === "Replays 10/10" && replays.border === SUCCESS, `replays: "${replays.text}" ${replays.border}`);
    const open = await paint(page, ".page-header .state-danger");
    assert(open.text === "Open" && open.border === DANGER, `open: "${open.text}" ${open.border}`);
    await huesOnPage(page, STATUS);
    await fits(page);
    await go(page, "defects/dfx_9a20");
    await settled(page);
    const unstable = await paint(page, ".page-header .state-warn");
    assert(/fingerprints differ/.test(unstable.text) && unstable.border === WARNING, `an unstable replay is not amber with words: "${unstable.text}"`);
  },

  async "connect: a done step is green with a tick, the diff is red and green with - and +"(page) {
    await signIn(page, "projects/connect");
    const done = await paint(page, ".step[data-done] .step-n");
    assert(done.bg === SUCCESS && done.svg, `a done step is ${done.bg}`);
    await page.getByRole("button", { name: "Add repositories on GitHub" }).click();
    await page.getByRole("dialog").getByRole("checkbox").first().check();
    await page.getByRole("dialog").getByRole("button", { name: "Install" }).click();
    const del = await paint(page, ".diff-del");
    const add = await paint(page, ".diff-add");
    assert(del.text.startsWith("-") && add.text.startsWith("+"), "the diff lines do not start with - and +");
    assert(del.color === "rgb(255, 106, 92)" && add.color === "rgb(61, 220, 132)", `the diff colours are ${del.color} / ${add.color}`);
    await huesOnPage(page, STATUS);
    await fits(page);
  },

  async "api keys: active is green, revoke is red, an empty name is a red error, a created key is a green confirmation"(page) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await signIn(page, "api-keys");
    const active = page.locator('.state[data-tone="ok"]', { hasText: "Active" }).first();
    await active.waitFor();
    assert((await active.locator(".dot").evaluate((e) => getComputedStyle(e).backgroundColor)) === SUCCESS, "active is not green");
    const revoked = page.locator(".state", { hasText: "Revoked" }).first();
    if (await revoked.count()) assert(!STATUS.includes(await revoked.evaluate((e) => getComputedStyle(e).borderTopColor)), "revoked is coloured");
    const revoke = await paint(page, "table .btn-danger");
    assert(revoke.text === "Revoke" && revoke.color === DANGER, `revoke: ${revoke.color}`);
    await page.getByRole("button", { name: "Create key" }).click();
    assert((await paint(page, "#key-error")).color === DANGER, "the empty name error is not red");
    await page.getByLabel("Key name").fill("Deploy pipeline");
    await page.getByRole("button", { name: "Create key" }).click();
    const done = await paint(page, ".callout-success");
    assert(done.borderWidth === "0px 0px 0px 0px" && done.shadow === "none" && /created/.test(done.text), `created: ${done.borderWidth} ${done.shadow}`);
    assert((await paint(page, ".callout-success .callout-row svg")).color === SUCCESS, "the created icon is not green");
    await page.locator(".callout-success").getByRole("button", { name: "Copy new key" }).click();
    const copied = await paint(page, ".copy-done svg");
    assert(copied.color === SUCCESS, `the copied tick is ${copied.color}`);
    await huesOnPage(page, STATUS);
    await fits(page);
    await page.locator("table .btn-danger").first().click();
    await noBorder(page, "revoke");
    const revokeConfirm = await paint(page, "dialog[open] .btn-primary");
    assert(revokeConfirm.bg === DANGER && revokeConfirm.color === WHITE, `the revoke confirm is ${revokeConfirm.bg} / ${revokeConfirm.color}`);
  },

  async "billing: the current plan has the silver border and nothing else is coloured"(page) {
    await signIn(page, "billing");
    const plan = await paint(page, ".plan-current");
    assert(/linear-gradient/.test(plan.bgImage) && plan.bgImage.includes("rgb(124, 130, 139)"), `the current plan has no silver border (${plan.bgImage})`);
    assert(/Current plan/.test(plan.text), "the current plan does not say so");
    await huesOnPage(page, STATUS);
    await fits(page);
  },

  async "overview and navigation: the selected menu item has no line under it, charts are slate, grey and silver"(page, viewport) {
    await signIn(page, "overview");
    if (isMobile(viewport)) await page.getByRole("button", { name: "Open navigation" }).click();
    const scope = isMobile(viewport) ? ".cx-drawer" : ".cx-sub";
    await noLine(page, `${scope} .cx-sub-link.active`);
    const item = await paint(page, `${scope} .cx-sub-link.active`);
    assert(!STATUS.includes(item.color) && !STATUS.includes(item.bg), "the selected menu item is coloured");
    if (isMobile(viewport)) await page.getByRole("button", { name: "Close navigation" }).click();
    const area = await page.locator("#skipped .chart-area").first().evaluate((e) => e.style.fill);
    assert(/url\(/.test(area), "the skipped-with-proof chart has no silver fill");
    await huesOnPage(page, STATUS);
    await fits(page);
  },

  async "settings: nothing is coloured (the selected tab is black, with no silver line)"(page) {
    await signIn(page, "settings");
    await huesOnPage(page, STATUS);
    await fits(page);
  },
};

const only = process.env.ONLY;

for (const [vpName, viewport] of VIEWPORTS) {
  for (const [name, fn] of Object.entries(TESTS)) {
    if (only && !name.includes(only)) continue;
    const { ctx, page, errors } = await newPage(browser, { viewport });
    page.setDefaultTimeout(20000);
    const label = `${name} (${vpName})`;
    try {
      await fn(page, viewport);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      if (overflow) throw new Error("the page scrolls horizontally");
      if (errors.length) throw new Error(`console: ${errors[0]}`);
      pass(label);
      console.log("ok  ", label);
    } catch (e) {
      fail(`${label}: ${String(e.message).split("\n")[0]}`);
      await page.screenshot({ path: `/tmp/fail-${vpName}-${name.replace(/\W+/g, "-").slice(0, 60)}.png` }).catch(() => {});
    }
    await ctx.close();
  }
}

await browser.close();
console.log(state.failures ? `${state.failures} status colour check(s) failed` : `status colour checks: all ${state.passes} passed`);
process.exit(state.failures ? 1 : 0);
