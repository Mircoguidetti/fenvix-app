// Connect a project and its follow-ups (founder, 28 Nov), on desktop and on a phone, against the mock backend (its
// installations are in every state): /projects/connect lists the repositories to set up; each has its own setup page
// (/projects/connect/:repositoryId); repositories in setup show as "Setting up"; Python and four invented project
// tabs are gone; the Projects page has one "Connect a project" button; the screens before the dashboard are centred.
// Usage: npm run check (builds, serves and runs everything), or with a preview server on :4173:
//   node scripts/connect-checks.mjs
import { BASE, VIEWPORTS, go, isMobile, launch, makeReporter, newPage, settled, signIn } from "./lib.mjs";

const { fail, pass, state } = makeReporter();
const browser = await launch();
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** A new person through the email sign-in: stops on "Name your organization". */
async function newPerson(page) {
  await page.goto(BASE);
  await page.getByLabel("Work email").fill("sam.rivera@northwind.cloud");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByText("We sent a sign-in link to sam.rivera@northwind.cloud").waitFor();
  await go(page, "?token=one-time");
  await page.getByRole("heading", { name: "Name your organization" }).waitFor();
}
/** A new organization: no GitHub App installation, no project. */
async function newOrganization(page, route = "projects/connect") {
  await newPerson(page);
  await page.getByLabel("Organization name").fill("Rivera Labs");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator(".shell").waitFor();
  await go(page, route);
  await settled(page);
}
const repoId = (page, fullName) => page.evaluate(async (n) => (await window.__fenvixMock.listGitHubRepositories()).find((r) => r.fullName === n)?.repositoryId, fullName);
const pickNames = (page) => page.locator(".connect-pick .repo-row .repo-name").allInnerTexts();

/** The card of a screen before the dashboard: horizontally centred and wholly inside the viewport. */
async function centred(page, vp, name) {
  await page.evaluate(() => document.fonts.ready);
  const b = await page.locator(".gate-card").boundingBox();
  assert(b, `${name}: no card`);
  const left = b.x;
  const right = vp.width - b.x - b.width;
  assert(Math.abs(left - right) <= 2, `${name}: the card is not centred (left ${Math.round(left)}, right ${Math.round(right)})`);
  assert(b.x >= 0 && b.y >= 0 && b.x + b.width <= vp.width && b.y + b.height <= vp.height, `${name}: the card is outside the viewport (${JSON.stringify(b)})`);
  const logo = await page.locator(".gate-mark").boundingBox();
  assert(logo && logo.y + logo.height <= b.y, `${name}: the logo is not above the card`);
  const foot = await page.locator(".gate-foot").boundingBox();
  assert(foot && foot.y >= b.y + b.height && foot.y - (b.y + b.height) < 60, `${name}: the signed-in line is not right under the card`);
}

const TESTS = {
  // protects=the first time (no installation), the page is one install card with its button, no numbered steps and
  // no repository list; fails_when=the card or its button is missing, or steps, rows or GitHub lines show;
  // no_claim=GitHub's own installation pages (the mock stands in for them).
  async "state A: no installation shows the install card and no repository list"(page) {
    await newOrganization(page);
    const card = page.locator(".connect-install");
    await card.getByRole("heading", { name: "Install the fenvix GitHub App" }).waitFor();
    assert(await card.getByRole("button", { name: "Install the GitHub App" }).isEnabled(), "the install button is disabled for the owner");
    await card.getByText(/sees only the repositories you choose/).waitFor();
    assert(!(await page.locator(".step, ol.steps").count()), "numbered steps show on Connect");
    assert(!(await page.getByRole("heading", { name: "Pick a repository to connect" }).count()), "a repository list shows without an installation");
    assert(!(await page.locator(".repo-row, .gh-line").count()), "repository rows or GitHub lines show without an installation");
    assert((await page.locator("details.connect-what").getAttribute("open")) === null, "What fenvix does with access is not collapsed");
  },

  // protects=with installations, Connect is the list of repositories not on fenvix (not merged/already on fenvix, no
  // open setup pull request, not removed, not on an uninstalled installation), each with Set up to its setup page; no
  // numbered steps, no mode toggle, no list of setup pull requests; removed ones only in the collapsed Removed list;
  // "See your projects" goes to /projects; fails_when=a connected, open or removed repository is offered, Set up goes
  // elsewhere, or the toggle/steps/waiting list are back; no_claim=the API's onboarding states (tested in github-app).
  async "state B: the pick list leaves out connected, open and removed repositories; Set up goes to the setup page"(page) {
    await signIn(page, "projects");
    const removed = await page.evaluate(async () => (await window.__fenvixMock.listProjects())[0]);
    await page.evaluate(async (id) => window.__fenvixMock.removeProject(id), removed.id);
    await go(page, "projects/connect");
    await settled(page);
    await page.getByRole("heading", { name: "Pick a repository to connect" }).waitFor();
    assert(!(await page.locator(".step, ol.steps").count()), "a numbered step shows on Connect");
    assert(!(await page.getByRole("group", { name: "How fenvix runs your tests" }).count()), "the mode toggle is on Connect");
    assert(!(await page.getByRole("heading", { name: "Waiting for your merge" }).count()), "a list of setup pull requests is on Connect");
    const names = await pickNames(page);
    assert(names.includes("northwind/billing-worker") && names.includes("northwind/analytics"), `the pick list misses repositories to connect: ${names.join(", ")}`);
    const repos = await page.evaluate(async () => window.__fenvixMock.listGitHubRepositories());
    const notToPick = repos.filter((r) => ["merged", "already_fenvix", "side_by_side", "pr_open", "side_by_side_pr_open"].includes(r.onboardingState) || r.projectId || r.excludedAt).map((r) => r.fullName);
    assert(notToPick.includes(removed.fullName) && notToPick.includes("northwind/mobile-app") && notToPick.includes("northwind/homehub"), `the mock lacks the cases: ${notToPick.join(", ")}`);
    const offered = notToPick.filter((n) => names.includes(n));
    assert(offered.length === 0, `offered to connect: ${offered.join(", ")}`);
    const removedList = page.locator("details.connect-removed");
    assert((await removedList.getAttribute("open")) === null, "the Removed list is not collapsed");
    await removedList.locator("summary").click();
    await removedList.getByRole("button", { name: `Add ${removed.fullName} again` }).waitFor();
    assert((await page.locator(".gh-lines .gh-line").count()) === 3, `${await page.locator(".gh-line").count()} GitHub lines, not 3`);
    const id = await repoId(page, "northwind/billing-worker");
    assert((await page.getByRole("link", { name: "Set up northwind/billing-worker" }).getAttribute("href")) === `/projects/connect/${id}`, "Set up does not go to the repository's setup page");
    const link = page.getByRole("link", { name: "See your projects" });
    assert((await link.getAttribute("href")) === "/projects", `See your projects goes to ${await link.getAttribute("href")}`);
  },

  // protects=a repository with no test job found: its setup page says why and what to do, offers Check again and no
  // pull request; fails_when=an Open button shows or the reason/what-to-do is missing; no_claim=the App's detection.
  async "setup page: not detected says why and what to do"(page) {
    await signIn(page, "projects/connect");
    await page.getByRole("link", { name: "Set up northwind/design-system" }).click();
    await page.getByRole("heading", { name: "northwind/design-system", level: 1 }).waitFor();
    await page.locator(".page-header .state", { hasText: "No test job found" }).waitFor();
    await page.getByText("The workflows have no job that runs tests").waitFor();
    await page.getByText(/Add a job that runs your tests/).waitFor();
    await page.getByRole("button", { name: "Check again" }).click();
    assert(!(await page.getByRole("button", { name: /Open setup pull request/ }).count()), "a pull request is offered without a test job");
  },

  // protects=a ready repository: steps 1-4 for it alone, "Open setup pull request" queues it, one toast, then step 3
  // offers "Merge it on GitHub" with the new pull request, and the repository shows as "Setting up" on /projects;
  // fails_when=a step is missing, no toast or more than one, the merge link is wrong, or it is not listed as setting up;
  // no_claim=the App's worker on GitHub.
  async "setup page: ready, open the pull request, one toast, then Merge it on GitHub and Setting up"(page) {
    await signIn(page, "projects/connect");
    await page.getByRole("link", { name: "Set up northwind/billing-worker" }).click();
    for (const step of ["How fenvix runs it", "Open the setup pull request", "Merge it on GitHub", "First run"]) await page.getByRole("heading", { name: step, level: 2 }).waitFor();
    assert((await page.locator(".diff").innerText()).includes("+ runs-on: fenvix"), "the diff does not show runs-on: fenvix");
    assert(!(await page.locator(".toast").count()), "a toast shows on opening the page");
    await page.getByRole("button", { name: "Open setup pull request" }).click();
    await page.locator(".toast", { hasText: /Opened pull request #\d+ on northwind\/billing-worker/ }).waitFor({ timeout: 15000 });
    const merge = page.getByRole("link", { name: /^Merge it on GitHub: pull request #\d+$/ });
    assert((await merge.getAttribute("href")).startsWith("https://github.com/northwind/billing-worker/pull/"), "the merge link is wrong");
    await page.waitForTimeout(1600);
    assert((await page.locator(".toast").count()) === 1, `${await page.locator(".toast").count()} toasts, not 1`);
    await go(page, "projects");
    await page.locator(".setting-up").getByRole("link", { name: "northwind/billing-worker" }).waitFor();
  },

  // protects=a repository whose setup pull request is open: reached from "Setting up" on /projects (and the sidebar),
  // step 3 links its pull request; fails_when=it is not listed as setting up or the link is wrong; no_claim=-.
  async "setup page: pull request open, reached from Setting up"(page, vp) {
    await signIn(page, "projects");
    const row = page.locator(".setting-up .setting-up-row", { hasText: "northwind/mobile-app" });
    await row.getByText("Setting up").waitFor();
    if (!isMobile(vp)) await page.locator(".cx-sub .cx-sub-setup", { hasText: "northwind/mobile-app" }).getByText("Setting up").waitFor();
    await row.getByRole("link", { name: "northwind/mobile-app" }).click();
    await page.getByRole("heading", { name: "northwind/mobile-app", level: 1 }).waitFor();
    assert((await page.getByRole("link", { name: "Merge it on GitHub: pull request #812" }).getAttribute("href")) === "https://github.com/northwind/mobile-app/pull/812", "the merge link is wrong");
    await page.getByText("Opened: pull request #812.").waitFor();
  },

  // protects=merged (or already on fenvix) with no project yet: step 4 waits for the first run; with a project, the
  // setup page redirects to it; an unknown repository says so; fails_when=no waiting line, no redirect, or a blank
  // page; no_claim=-.
  async "setup page: merged waits for the first run; active redirects to the project; unknown says not found"(page) {
    await signIn(page, "projects");
    await go(page, `projects/connect/${await repoId(page, "northwind/search-service")}`);
    await page.getByText(/Waiting for the first test run on fenvix/).waitFor();
    await go(page, `projects/connect/${await repoId(page, "northwind/homehub")}`);
    await page.waitForURL((u) => u.pathname === "/projects/prj_homehub");
    await go(page, "projects/connect/999999999");
    await page.getByRole("heading", { name: "Repository not found" }).waitFor();
  },

  // protects=Python and the tabs Detailed proof, Compatibility, Is this red real?, Database copies are gone from the
  // navigation, and their old URLs give the 404 page; fails_when=a link or a page is still there; no_claim=-.
  async "removed: Python and four project tabs, with their old URLs giving 404"(page, vp) {
    await signIn(page, "projects/prj_homehub");
    let nav = page.locator(".cx-sub");
    if (isMobile(vp)) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      nav = page.locator(".cx-drawer");
    }
    await nav.getByRole("link", { name: /^Runs/ }).first().waitFor();
    for (const label of ["Detailed proof", "Compatibility", "Is this red real?", "Database copies", "Python"]) assert(!(await nav.getByRole("link", { name: label }).count()), `the navigation still has ${label}`);
    for (const label of ["Runs", "Parallel with proof", "Cache with proof", "Defects", "Time to green", "Nightly exploration"]) assert(await nav.getByRole("link", { name: new RegExp(`^${label}`) }).count(), `the navigation lost ${label}`);
    if (isMobile(vp)) await page.keyboard.press("Escape");
    for (const path of ["projects/prj_homehub/proof", "projects/prj_homehub/compatibility", "projects/prj_homehub/is-this-red-real", "projects/prj_homehub/database", "python"]) {
      await go(page, path);
      await page.getByRole("heading", { name: "Page not found" }).waitFor();
    }
    // The command palette has no Python either.
    if (!isMobile(vp)) {
      await page.getByRole("combobox").first().fill("Pyth");
      await page.waitForTimeout(400);
      assert(!(await page.getByRole("option", { name: "Python" }).count()), "the search still offers Python");
    }
  },

  // protects=the Projects page shows one "Connect a project" button: the empty state's when there is no project, the
  // header's when there are projects; fails_when=two buttons, or none; no_claim=-.
  async "projects: no project, the empty state's Connect a project button only"(page) {
    await newOrganization(page, "projects");
    await page.getByRole("heading", { name: "No projects yet" }).waitFor();
    assert((await page.locator("main").getByRole("link", { name: "Connect a project" }).count()) === 1, `${await page.locator("main").getByRole("link", { name: "Connect a project" }).count()} Connect buttons on the empty Projects page`);
    assert(await page.locator(".empty").getByRole("link", { name: "Connect a project" }).count(), "the empty state lost its button");
  },
  async "projects: with projects, the header's Connect a project button only"(page) {
    await signIn(page, "projects");
    await page.locator("main tbody tr").first().waitFor();
    assert((await page.locator("main").getByRole("link", { name: "Connect a project" }).count()) === 1, "not exactly one Connect button with projects");
    assert(await page.locator(".page-header").getByRole("link", { name: "Connect a project" }).count(), "the header lost its button");
  },

  // protects=the screens before the dashboard (Name your organization, No organization, Join an organization): logo
  // on top, one card horizontally centred and wholly inside the viewport, the signed-in line right under it;
  // fails_when=the card sits off-centre or is cut, the logo is missing, or the line floats; no_claim=-.
  async "gate screens: the card is centred and inside the viewport"(page, vp) {
    await newPerson(page);
    await centred(page, vp, "Name your organization");
    await page.getByLabel("Organization name").fill("Rivera Labs");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator(".shell").waitFor();
    await page.evaluate(() => {
      const s = JSON.parse(sessionStorage.getItem("fenvix-mock-orgs"));
      s.orgs = s.orgs.filter((o) => !o.members.some((m) => m.email === "sam.rivera@northwind.cloud"));
      sessionStorage.setItem("fenvix-mock-orgs", JSON.stringify(s));
    });
    await page.reload();
    await page.getByRole("heading", { name: "No organization yet" }).waitFor();
    await centred(page, vp, "No organization");
    await page.evaluate(() => sessionStorage.setItem("fenvix-invite", "a".repeat(43)));
    await page.reload();
    await page.getByRole("heading", { name: "Join an organization" }).waitFor();
    await centred(page, vp, "Join an organization");
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
