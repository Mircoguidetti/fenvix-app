// Status colours in the browser, on desktop and on a phone-sized screen, against the mock backend: the colours each
// state is actually drawn in, that a coloured state also has a word or an icon, that no other hue shows anywhere, that
// silver is only where it belongs, and that nothing sticks out of the screen.
// Usage: npm run check (builds, serves and runs everything), or with a preview server on :4173: node scripts/status-colors-checks.mjs
import { VIEWPORTS, go, isMobile, launch, layoutProblems, makeReporter, newPage, settled, signIn } from "./lib.mjs";

const { fail, pass, state } = makeReporter();
const browser = await launch();

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// The tokens of src/styles.css, as the browser reports them.
const SUCCESS = "rgb(6, 122, 58)";
const DANGER = "rgb(214, 20, 10)";
const WARNING = "rgb(161, 92, 0)";
const SUCCESS_DARK = "rgb(61, 220, 132)";
const DANGER_DARK = "rgb(255, 106, 92)";
const BLACK = "rgb(11, 18, 32)"; // --black, the one dark colour (#0b1220)
const WHITE = "rgb(255, 255, 255)";
const CHART = "rgb(11, 18, 32)"; // --chart, the one dark colour of bars and lines
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
    const content = document.querySelector(".content");
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
  async "databases: awake is green with its word, asleep stays grey"(page) {
    await signIn(page, "databases");
    const awake = await paint(page, "table.dbs .state-awake");
    assert(awake.text === "Awake" && awake.border === SUCCESS, `awake badge: "${awake.text}" ${awake.border}`);
    const dot = await paint(page, "table.dbs .state-awake .dot");
    assert(dot.bg === SUCCESS, `awake dot is ${dot.bg}`);
    const asleep = await paint(page, "table.dbs .state-asleep");
    assert(asleep.text === "Asleep" && !STATUS.includes(asleep.border), `asleep badge is coloured: ${asleep.border}`);
    const hollow = await paint(page, "table.dbs .state-asleep .dot");
    assert(hollow.bg === "rgba(0, 0, 0, 0)", "the asleep dot is filled");
    await huesOnPage(page, STATUS);
    await fits(page);
  },

  async "database: erase is red, its dialog has no border and a red confirm button; restore opens the same red dialog from a neutral button; the selected tab is black and bold, with no line under it"(page) {
    await signIn(page, "databases/db_0001");
    await noLine(page, '.tabs button[aria-pressed="true"]');
    const tab = await paint(page, '.tabs button[aria-pressed="true"]');
    assert(tab.color === BLACK, `the selected tab is not the dark colour (${tab.color})`);
    const erase = await paint(page, "#actions .action-erase .action-name");
    assert(erase.text === "Erase" && erase.color === DANGER, `erase action: ${erase.color}`);
    const fork = await paint(page, "#actions .action-btn >> nth=0");
    assert(!STATUS.includes(fork.color), "a plain action is coloured");
    await page.getByRole("button", { name: "Erase", exact: true }).click();
    await noBorder(page, "erase");
    const confirm = await paint(page, "dialog[open] .btn-primary");
    assert(confirm.bg === DANGER && confirm.border === DANGER && confirm.color === WHITE && confirm.text === "Erase database", `the erase confirm is ${confirm.bg} / ${confirm.color}`);
    await huesOnPage(page, STATUS);
    await fits(page);
    await page.getByRole("button", { name: "Cancel" }).click();
    // Restore drops the changes made after the chosen moment: a red dialog, opened from a neutral button.
    const restoreBtn = await paint(page, '#actions .action-btn:has-text("Restore to a point in time")');
    assert(!STATUS.includes(restoreBtn.color) && !STATUS.includes(restoreBtn.border), `the Restore button is coloured (${restoreBtn.color})`);
    await page.getByRole("button", { name: "Restore to a point in time" }).click();
    await noBorder(page, "restore");
    const restore = await paint(page, "dialog[open] .btn-primary");
    assert(restore.bg === DANGER && restore.color === WHITE && restore.text === "Restore database", `the restore confirm is ${restore.bg} / ${restore.color}`);
    await huesOnPage(page, STATUS);
    await fits(page);
    await page.getByRole("button", { name: "Cancel" }).click();
    // A dialog that changes nothing for good is not marked danger, and has no border either.
    await page.getByRole("button", { name: "Fork" }).click();
    await page.locator("dialog[open]").waitFor();
    assert(!(await page.locator("dialog.dialog-danger[open]").count()), "the fork dialog is marked danger");
    await noBorder(page, "fork");
    assert((await paint(page, "dialog[open] .btn-primary")).bg === BLACK, "the fork confirm is not black");
  },

  async "database: the area under the storage line is the silver fill"(page) {
    await signIn(page, "databases/db_0001");
    const area = page.locator("#usage .chart-area").first();
    await area.waitFor();
    const fill = await area.evaluate((e) => e.style.fill);
    const id = /url\("?#([^")]+)"?\)/.exec(fill)?.[1];
    assert(id, `the area is not filled with a gradient (${fill})`);
    const stops = await page.evaluate((i) => [...document.getElementById(i).querySelectorAll("stop")].map((s) => `${getComputedStyle(s).stopColor} ${getComputedStyle(s).stopOpacity}`), id);
    const want = ["rgb(124, 130, 139) 0.32", "rgb(196, 200, 206) 0.22", "rgb(244, 245, 247) 0"];
    assert(stops.join("|") === want.join("|"), `the stops are not the light silver fill: ${stops.join(", ")}`);
    const line = await paint(page, "#usage .chart-line");
    assert(!STATUS.includes(line.color) && (await page.locator("#usage .chart-bar").first().evaluate((e) => getComputedStyle(e).fill)) === CHART, "the charts are not slate and grey");
  },

  async "network: blocked addresses are red with an icon, a bad entry is a red error, unsaved changes are amber, saving says so in green"(page) {
    await signIn(page, "databases/db_0001?tab=network");
    await noLine(page, '.tabs button[aria-pressed="true"]');
    const blocked = await paint(page, "#blocks .blocked-until");
    assert(blocked.color === DANGER && blocked.svg && /^Blocked until/.test(blocked.text), `blocked: ${blocked.color} "${blocked.text}"`);
    const clear = await paint(page, "#allowlist .btn-danger");
    assert(clear.text === "Clear list" && clear.color === DANGER, `clear list: ${clear.color}`);

    await page.getByLabel("Address or network").fill("db.example.com");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const error = await paint(page, "#allowlist .error");
    assert(error.color === DANGER, `the error is ${error.color}`);
    const prefix = await page.locator("#allowlist .error").evaluate((e) => getComputedStyle(e, "::before").content);
    assert(prefix.includes("Error:"), "the error does not say Error:");
    const input = await paint(page, "#net-add");
    assert(input.border === DANGER, `the invalid field's border is ${input.border}`);

    await page.getByRole("button", { name: "Remove 198.51.100.7/32" }).click();
    const tag = await paint(page, "#allowlist .tag-warning");
    assert(tag.text === "Unsaved changes" && tag.border === WARNING, `unsaved: ${tag.border}`);
    await huesOnPage(page, STATUS);
    await fits(page);

    await page.getByRole("button", { name: "Save list" }).click();
    const warn = await paint(page, "dialog[open] .once-warning svg");
    assert(warn.color === WARNING, `the save warning icon is ${warn.color}`);
    await page.getByLabel("I have checked that the addresses of my applications are in the list").check();
    await page.locator("dialog[open]").getByRole("button", { name: "Save list" }).click();
    const toast = page.locator(".toast-success", { hasText: "Saved the IP allowlist" });
    await toast.waitFor();
    const icon = await paint(page, ".toast-success .toast-icon");
    assert(icon.color === SUCCESS_DARK, `the success toast icon is ${icon.color}`);
    await huesOnPage(page, STATUS);
    await fits(page);

    await page.getByRole("button", { name: "Unblock 203.0.113.45" }).click();
    await page.locator(".toast-success", { hasText: "Unblocked 203.0.113.45" }).waitFor();
  },

  async "network: a list different from the engine's and a Data Explorer the server does not trust are amber warnings with an icon"(page) {
    await signIn(page, "databases/db_0003?tab=network");
    const callout = await paint(page, "#allowlist .callout-warning");
    assert(callout.borderWidth === "0px 0px 0px 0px" && callout.shadow === "none" && callout.svg && /different list/.test(callout.text), `different list: ${callout.borderWidth} ${callout.shadow}`);
    assert((await paint(page, "#allowlist .callout-warning svg")).color === WARNING, "the icon is not amber");
    const apply = await paint(page, "#allowlist .callout-warning .btn");
    assert(!STATUS.includes(apply.color), "Apply again is coloured");
    await huesOnPage(page, STATUS);
    await fits(page);

    await page.goto(page.url().replace("db_0003", "db_0004"));
    await settled(page);
    const trust = await paint(page, "#allowlist .once-warning");
    assert(trust.borderWidth === "0px 0px 0px 0px" && trust.shadow === "none" && trust.svg && /Data Explorer/.test(trust.text), `untrusted explorer: ${trust.borderWidth} ${trust.shadow}`);
    assert((await paint(page, "#allowlist .once-warning svg")).color === WARNING, "the icon is not amber");
    await huesOnPage(page, STATUS);
    await fits(page);
  },

  async "network: an engine that does not answer is a red error with an icon"(page) {
    await signIn(page, "databases/db_0005?tab=network");
    const msg = await paint(page, "#allowlist .message-error");
    assert(msg.color === DANGER && msg.svg && msg.text.length > 10, `engine down: ${msg.color}`);
    await huesOnPage(page, STATUS);
    await fits(page);
  },

  async "data: waking a sleeping database is amber, with its words and the spinning icon"(page) {
    await signIn(page, "databases");
    await go(page, "databases/db_0012?tab=data"); // the mock takes a moment to wake a sleeping database
    const waking = await paint(page, ".waking");
    assert(waking.borderWidth === "0px 0px 0px 0px" && waking.shadow === "none" && waking.svg && /Waking the database/.test(waking.text), `waking: ${waking.borderWidth} ${waking.shadow}`);
    assert((await paint(page, ".waking svg")).color === WARNING, "the waking icon is not amber");
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

  async "database users: reset password stays neutral, its dialog is not red and warns in amber with an icon; delete is red"(page) {
    await signIn(page, "databases/db_0001?tab=users");
    const reset = page.getByRole("button", { name: /^Reset password of / }).first();
    await reset.waitFor();
    const resetPaint = await reset.evaluate((e) => ({ color: getComputedStyle(e).color, border: getComputedStyle(e).borderTopColor }));
    assert(!STATUS.includes(resetPaint.color) && !STATUS.includes(resetPaint.border), `the Reset password button is coloured (${resetPaint.color})`);
    await reset.click();
    await page.getByRole("heading", { name: "Reset this password?" }).waitFor();
    assert(!(await page.locator("dialog.dialog-danger[open]").count()), "the reset dialog is marked danger");
    await noBorder(page, "reset");
    const warn = await paint(page, "dialog[open] .once-warning");
    assert(warn.borderWidth === "0px 0px 0px 0px" && warn.svg && warn.text === "Applications using the old password will stop working.", `reset warning: ${warn.borderWidth} "${warn.text}"`);
    assert((await paint(page, "dialog[open] .once-warning svg")).color === WARNING, "the reset warning icon is not amber");
    const confirm = await paint(page, "dialog[open] .btn-primary");
    assert(confirm.bg === BLACK && confirm.text === "Reset password", `the reset confirm is ${confirm.bg}`);
    await huesOnPage(page, STATUS);
    await fits(page);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: /^Delete user / }).first().click();
    await noBorder(page, "delete");
    const del = await paint(page, "dialog[open] .btn-primary");
    assert(del.bg === DANGER && del.color === WHITE && del.text === "Delete user", `the delete confirm is ${del.bg} / ${del.color}`);
    await fits(page);
  },

  async "billing: paid is green with its word; the current plan has the silver border and nothing else is coloured"(page) {
    await signIn(page, "billing");
    const paid = page.locator("#invoices .state", { hasText: "Paid" }).first();
    await paid.waitFor();
    assert((await paid.evaluate((e) => getComputedStyle(e).borderTopColor)) === SUCCESS, "paid is not green");
    const plan = await paint(page, ".plan-current");
    assert(/linear-gradient/.test(plan.bgImage) && plan.bgImage.includes("rgb(124, 130, 139)"), `the current plan has no silver border (${plan.bgImage})`);
    assert(/Current plan/.test(plan.text), "the current plan does not say so");
    await huesOnPage(page, STATUS);
    await fits(page);
  },

  async "overview and navigation: the selected menu item has no line under it, charts are slate, grey and silver"(page, viewport) {
    await signIn(page, "overview");
    if (isMobile(viewport)) await page.getByRole("button", { name: "Open navigation" }).click();
    const scope = isMobile(viewport) ? ".drawer" : ".sidebar";
    await noLine(page, `${scope} .nav-link.active`);
    const item = await paint(page, `${scope} .nav-link.active`);
    assert(!STATUS.includes(item.color) && !STATUS.includes(item.bg), "the selected menu item is coloured");
    if (isMobile(viewport)) await page.getByRole("button", { name: "Close navigation" }).click();
    const area = await page.locator("#awake .chart-area").first().evaluate((e) => e.style.fill);
    assert(/url\(/.test(area), "the awake chart has no silver fill");
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
