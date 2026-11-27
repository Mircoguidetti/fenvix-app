// Removing a project and deleting the account, on desktop and on a phone, against the mock backend: both dialogs keep
// their button disabled until the exact name is typed; after "Remove project" the project is gone from /projects with
// one "Removed <repo>" toast; after "Delete account" the browser is signed out; a member sees neither block.
// Usage: npm run check (builds, serves and runs everything), or with a preview server on :4173:
//   node scripts/remove-delete-checks.mjs
// SHOTS=<dir> also saves both dialogs, light and dark, at 1440x900 and 390x844 (deviceScaleFactor 2).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BASE, VIEWPORTS, go, launch, makeReporter, newPage, settled, signIn, useOrgOf } from "./lib.mjs";

const { fail, pass, state } = makeReporter();
const browser = await launch();
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** The confirm button stays disabled for anything but the exact text, and is enabled by it. */
async function typedGate(dialog, button, expected) {
  const field = dialog.getByTestId("typed-confirm");
  assert(await button.isDisabled(), "the confirm button is enabled before anything is typed");
  for (const wrong of [expected.toUpperCase() === expected ? expected.toLowerCase() : expected.toUpperCase(), expected.slice(0, -1), `${expected} `, ` ${expected}`]) {
    await field.fill(wrong);
    assert(await button.isDisabled(), `the confirm button is enabled for "${wrong}"`);
  }
  await field.fill(expected);
  assert(await button.isEnabled(), "the confirm button stays disabled for the exact name");
}

async function firstProject(page) {
  return page.evaluate(async () => (await window.__fenvixMock.listProjects())[0]);
}

const TESTS = {
  async "remove a project: typed repository name, one toast, gone from /projects"(page) {
    await signIn(page, "projects");
    const p = await firstProject(page);
    await go(page, `projects/${p.id}/settings`);
    await settled(page);
    await page.locator("#remove-project").getByRole("button", { name: "Remove project" }).click();
    const dialog = page.getByRole("dialog", { name: `Remove ${p.fullName}?` });
    await dialog.waitFor();
    await dialog.getByText("stays in your GitHub App installation").waitFor();
    const link = dialog.getByRole("link", { name: "the installation's settings on GitHub" });
    assert(/^https:\/\/github\.com\/(organizations\/[^/]+\/)?settings\/installations\/\d+$/.test(await link.getAttribute("href")), `installation link: ${await link.getAttribute("href")}`);
    const confirm = dialog.getByRole("button", { name: "Remove project" });
    await typedGate(dialog, confirm, p.fullName);
    await confirm.click();
    await page.locator(".toast", { hasText: `Removed ${p.fullName}` }).waitFor();
    assert((await page.locator(".toast", { hasText: `Removed ${p.fullName}` }).count()) === 1, "more than one toast");
    await page.waitForURL((u) => u.pathname === "/projects");
    await settled(page);
    const left = await page.evaluate(async () => (await window.__fenvixMock.listProjects()).map((x) => x.fullName));
    assert(!left.includes(p.fullName), "the project is still listed by the mock");
    assert(!(await page.locator("main").getByText(p.fullName, { exact: true }).count()), "the project is still on /projects");
  },

  async "delete the account: typed organization name, then signed out"(page) {
    await signIn(page, "settings");
    const name = "Northwind Cloud";
    await page.locator("#delete-account").getByRole("button", { name: "Delete account" }).click();
    const dialog = page.getByRole("dialog", { name: `Delete ${name}?` });
    await dialog.waitFor();
    await dialog.getByText("uninstalled from every GitHub account").waitFor();
    const confirm = dialog.getByRole("button", { name: "Delete account" });
    await typedGate(dialog, confirm, name);
    await confirm.click();
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    assert(!(await page.locator(".shell").count()), "the dashboard is still shown after the account was deleted");
    await page.goto(`${BASE}overview`);
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    // The organization is gone from the mock server; the person still belongs to Harbor Analytics.
    const orgs = await page.evaluate(() => JSON.parse(sessionStorage.getItem("fenvix-mock-orgs") ?? "{}").orgs?.map((o) => o.id) ?? []);
    assert(!orgs.includes("org_northwind") && orgs.includes("org_harbor"), `organizations left: ${orgs.join(", ")}`);
  },

  async "cancel keeps everything; a member sees neither block"(page) {
    await signIn(page, "settings");
    await page.locator("#delete-account").getByRole("button", { name: "Delete account" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Northwind Cloud?" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    // Harbor Analytics: the sample person is a member there.
    await useOrgOf(page, "org_harbor", "settings");
    assert(!(await page.locator("#delete-account").count()), "a member sees Delete account");
    const p = await firstProject(page);
    await go(page, `projects/${p.id}/settings`);
    await settled(page);
    assert(!(await page.locator("#remove-project").count()), "a member sees Remove project");
  },
};

const only = process.env.ONLY;
for (const [vpName, viewport] of VIEWPORTS) {
  for (const [name, fn] of Object.entries(TESTS)) {
    if (only && !name.includes(only)) continue;
    const { ctx, page, errors } = await newPage(browser, { viewport });
    page.setDefaultTimeout(20000);
    const label = `remove-delete: ${name} (${vpName})`;
    try {
      await fn(page, viewport);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      if (overflow) throw new Error("the page scrolls horizontally");
      if (errors.length) throw new Error(`console: ${errors[0]}`);
      pass(label);
      console.log("ok  ", label);
    } catch (e) {
      fail(`${label}: ${process.env.STACK ? e.stack : String(e.message).split("\n")[0]}`);
      await page.screenshot({ path: `/tmp/fail-remove-delete-${vpName}-${name.replace(/\W+/g, "-").slice(0, 60)}.png`, fullPage: true }).catch(() => {});
    }
    await ctx.close();
  }
}

// The dialogs as people see them, for the report (not part of npm run check unless SHOTS is set).
if (process.env.SHOTS) {
  mkdirSync(process.env.SHOTS, { recursive: true });
  for (const [vpName, viewport] of VIEWPORTS) {
    for (const scheme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      const errors = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      page.on("pageerror", (e) => errors.push(String(e)));
      const tag = `${vpName}-${viewport.width}x${viewport.height}-${scheme}`;
      try {
        await signIn(page, "projects");
        const p = await firstProject(page);
        await go(page, `projects/${p.id}/settings`);
        await settled(page);
        await page.locator("#remove-project").getByRole("button", { name: "Remove project" }).click();
        const rd = page.getByRole("dialog", { name: `Remove ${p.fullName}?` });
        await rd.getByTestId("typed-confirm").fill(p.fullName);
        await page.screenshot({ path: join(process.env.SHOTS, `remove-project-${tag}.png`) });
        await rd.getByRole("button", { name: "Cancel" }).click();
        await go(page, "settings");
        await settled(page);
        await page.locator("#delete-account").getByRole("button", { name: "Delete account" }).click();
        const dd = page.getByRole("dialog", { name: "Delete Northwind Cloud?" });
        await dd.getByTestId("typed-confirm").fill("Northwind");
        await page.screenshot({ path: join(process.env.SHOTS, `delete-account-${tag}.png`) });
        if (errors.length) throw new Error(`console: ${errors[0]}`);
        console.log("shot", tag, "console errors: 0");
      } catch (e) {
        fail(`shots ${tag}: ${String(e.message).split("\n")[0]}`);
      }
      await ctx.close();
    }
  }
}

await browser.close();
console.log(state.failures ? `${state.failures} remove/delete check(s) failed` : `remove/delete checks: all ${state.passes} passed`);
process.exit(state.failures ? 1 : 0);
