// Connect a project, built around connecting a new repository (spec "Connect a project, real redesign", 28 Nov),
// on desktop and on a phone, against the mock backend (its installations are in every state).
// Usage: npm run check (builds, serves and runs everything), or with a preview server on :4173:
//   node scripts/connect-checks.mjs
import { BASE, VIEWPORTS, go, launch, makeReporter, newPage, settled, signIn } from "./lib.mjs";

const { fail, pass, state } = makeReporter();
const browser = await launch();
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** A new organization made through the email sign-in: no GitHub App installation yet. */
async function newOrganization(page) {
  await page.goto(BASE);
  await page.getByLabel("Work email").fill("sam.rivera@northwind.cloud");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByText("We sent a sign-in link to sam.rivera@northwind.cloud").waitFor();
  await go(page, "?token=one-time");
  await page.getByRole("heading", { name: "Name your organization" }).waitFor();
  await page.getByLabel("Organization name").fill("Rivera Labs");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator(".shell").waitFor();
  await go(page, "projects/connect");
  await page.getByRole("heading", { name: "Connect a project", exact: true }).waitFor();
  await settled(page);
}

const pickNames = (page) => page.locator(".connect-pick .repo-row .repo-name").allInnerTexts();

const TESTS = {
  // protects=the first time (no installation), the page is one install card with its button and the three numbered
  // steps; fails_when=the card, its button or the steps are missing, or a repository list or a GitHub line shows;
  // no_claim=GitHub's own installation pages (the mock stands in for them).
  async "state A: no installation shows the install card and no repository list"(page) {
    await newOrganization(page);
    const card = page.locator(".connect-install");
    await card.getByRole("heading", { name: "Install the fenvix GitHub App" }).waitFor();
    assert(await card.getByRole("button", { name: "Install the GitHub App" }).isEnabled(), "the install button is disabled for the owner");
    await card.getByText(/sees only the repositories you choose/).waitFor();
    assert((await card.locator(".step").count()) === 3, `the card has ${await card.locator(".step").count()} steps, not 3`);
    assert(!(await page.getByRole("heading", { name: "Pick a repository to connect" }).count()), "a repository list shows without an installation");
    assert(!(await page.locator(".repo-row, .gh-line").count()), "repository rows or GitHub lines show without an installation");
    assert((await page.locator("details.connect-what").getAttribute("open")) === null, "What fenvix does with access is not collapsed");
  },

  // protects=with installations, no numbered checklist; "Pick a repository" lists only repositories not connected
  // (not merged/already on fenvix, no open setup pull request, not removed, not on an uninstalled installation);
  // connected repositories are absent and "See your projects" goes to /projects; fails_when=a step shows, a connected,
  // open or removed repository is offered, or the link is missing or goes elsewhere; no_claim=the API's onboarding
  // states themselves (tested in github-app).
  async "state B: no numbered steps, the pick list leaves out connected, open and removed repositories"(page) {
    await signIn(page, "projects");
    const removed = await page.evaluate(async () => (await window.__fenvixMock.listProjects())[0]);
    await page.evaluate(async (id) => window.__fenvixMock.removeProject(id), removed.id);
    await go(page, "projects/connect");
    await settled(page);
    await page.getByRole("heading", { name: "Pick a repository to connect" }).waitFor();
    assert(!(await page.locator(".step, ol.steps").count()), "a numbered step shows with installations");
    const names = await pickNames(page);
    assert(names.includes("northwind/billing-worker") && names.includes("northwind/analytics"), `the pick list misses repositories to connect: ${names.join(", ")}`);
    const repos = await page.evaluate(async () => window.__fenvixMock.listGitHubRepositories());
    const notToPick = repos.filter((r) => ["merged", "already_fenvix", "side_by_side", "pr_open", "side_by_side_pr_open"].includes(r.onboardingState) || r.projectId || r.excludedAt).map((r) => r.fullName);
    assert(notToPick.includes(removed.fullName) && notToPick.includes("northwind/mobile-app"), `the mock lacks the cases: ${notToPick.join(", ")}`);
    const offered = notToPick.filter((n) => names.includes(n));
    assert(offered.length === 0, `offered to connect: ${offered.join(", ")}`);
    // Connected repositories are not on this page at all (the sidebar's project list aside).
    const main = await page.locator("main").innerText();
    for (const n of ["northwind/homehub", "northwind/search-service"]) assert(!main.includes(n), `${n} is on the Connect page`);
    // The removed one: only in the collapsed "Removed" list.
    const removedList = page.locator("details.connect-removed");
    assert((await removedList.getAttribute("open")) === null, "the Removed list is not collapsed");
    await removedList.locator("summary").click();
    await removedList.getByRole("button", { name: `Add ${removed.fullName} again` }).waitFor();
    // One compact line per installation, not a card.
    assert((await page.locator(".gh-lines .gh-line").count()) === 3, `${await page.locator(".gh-line").count()} GitHub lines, not 3`);
    // See your projects.
    const link = page.getByRole("link", { name: "See your projects" });
    assert((await link.getAttribute("href")) === "/projects", `See your projects goes to ${await link.getAttribute("href")}`);
    await link.click();
    await page.waitForURL((u) => u.pathname === "/projects");
  },

  // protects=Connect on a row opens the setup pull request: queued, then one toast, and the repository moves to
  // "Waiting for your merge" with its pull request link and "Merge it on GitHub"; fails_when=no request, no toast or
  // more than one, the row stays to connect, or the waiting list misses it; no_claim=the App's worker on GitHub.
  async "state B: Connect opens the setup pull request with one toast; Waiting for your merge lists the open pull request"(page) {
    await signIn(page, "projects/connect");
    const waiting = page.locator(".connect-waiting");
    await waiting.getByRole("heading", { name: "Waiting for your merge" }).waitFor();
    const open = waiting.locator(".repo-row", { hasText: "northwind/mobile-app" });
    assert((await open.getByRole("link", { name: "Setup pull request #812" }).getAttribute("href")) === "https://github.com/northwind/mobile-app/pull/812", "the open pull request link is wrong");
    assert((await open.getByRole("link", { name: /^Merge it on GitHub/ }).getAttribute("href")) === "https://github.com/northwind/mobile-app/pull/812", "Merge it on GitHub goes elsewhere");
    assert(!(await page.locator(".toast").count()), "a toast shows on opening the page");
    await page.getByRole("button", { name: "Connect northwind/billing-worker" }).click();
    const toast = page.locator(".toast", { hasText: /Opened pull request #\d+ on northwind\/billing-worker/ });
    await toast.waitFor({ timeout: 15000 });
    await waiting.locator(".repo-row", { hasText: "northwind/billing-worker" }).getByRole("link", { name: /^Setup pull request #\d+$/ }).waitFor();
    assert(!(await pickNames(page)).includes("northwind/billing-worker"), "the connected repository is still offered");
    await page.waitForTimeout(1600);
    assert((await page.locator(".toast").count()) === 1, `${await page.locator(".toast").count()} toasts, not 1`);
  },

};

const only = process.env.ONLY;
for (const [vpName, viewport] of VIEWPORTS) {
  for (const [name, fn] of Object.entries(TESTS)) {
    if (only && !name.includes(only)) continue;
    const { ctx, page, errors } = await newPage(browser, { viewport });
    page.setDefaultTimeout(20000);
    const label = `connect: ${name} (${vpName})`;
    try {
      await fn(page, viewport);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      if (overflow) throw new Error("the page scrolls horizontally");
      if (errors.length) throw new Error(`console: ${errors[0]}`);
      pass(label);
      console.log("ok  ", label);
    } catch (e) {
      fail(`${label}: ${process.env.STACK ? e.stack : String(e.message).split("\n")[0]}`);
      await page.screenshot({ path: `/tmp/fail-connect-${vpName}-${name.replace(/\W+/g, "-").slice(0, 60)}.png`, fullPage: true }).catch(() => {});
    }
    await ctx.close();
  }
}

await browser.close();
console.log(state.failures ? `${state.failures} connect check(s) failed` : `connect checks: all ${state.passes} passed`);
process.exit(state.failures ? 1 : 0);
