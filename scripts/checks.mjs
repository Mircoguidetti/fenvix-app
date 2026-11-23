// Behaviour checks, run on desktop and on a phone-sized screen. Each test gets a fresh browser context
// (fresh data, signed out) and signs in through the real sign-in page unless it is testing sign-in.
// Usage: npm run check (builds, serves and runs everything), or with a preview server on :4173: npm run checks
import { readFile } from "node:fs/promises";
import { BANNED, BASE, VIEWPORTS, go, isMobile, launch, makeReporter, newPage, settled, signIn, visibleText, choose, flakyRun, proofRuns, runningRun, shadowRun, useOrgOf } from "./lib.mjs";

const { fail, pass, state } = makeReporter();
const browser = await launch();

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const num = (text) => Number(String(text).replace(/[^\d.]/g, ""));

/** Waits for a confirmation message and dismisses it so it never covers a button. */
async function toast(page, text) {
  const t = page.locator(".toast", { hasText: text }).first();
  await t.waitFor();
  await t.getByRole("button", { name: "Dismiss message" }).click();
}

async function openUserMenu(page, vp) {
  if (isMobile(vp)) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator(".cx-drawer .user-btn").click();
  } else {
    await page.locator(".cx-account .user-btn").click();
  }
}

async function savedFile(page, trigger) {
  const [download] = await Promise.all([page.waitForEvent("download"), trigger()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), text: await readFile(path, "utf8") };
}

/** The "a run + b skipped with proof + c setup and build = d min" sentence in `selector`: its numbers add up. */
async function addsUp(page, selector) {
  const el = page.locator(`${selector} .minute-sum`);
  await el.waitFor();
  const m = await el.evaluate((e) => ({ ran: +e.dataset.ran, skipped: +e.dataset.skipped, other: +e.dataset.other, total: +e.dataset.total, text: e.textContent }));
  const shown = (m.text.match(/[\d,.]+/g) ?? []).map((t) => Number(t.replace(/,/g, "")));
  assert(shown.length === 4, `${selector}: the sentence reads ${m.text}`);
  assert(Math.abs(shown[0] + shown[1] + shown[2] - shown[3]) < 0.001, `${selector}: ${m.text} does not add up`);
  assert(/run \+ .* skipped with proof \+ .* setup and build = .* min/.test(m.text), `${selector}: ${m.text}`);
  return m;
}

/** Polls until `read` returns true. Lists keep the old rows while new ones load, so asserts must wait. */
async function eventually(read, message) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    try {
      if (await read()) return;
    } catch {
      /* the page is changing under us */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(message);
}


const ROUTES = [
  "overview", "projects", "projects/prj_homehub", "projects/prj_homehub/parallel-with-proof", "projects/prj_docs/parallel-with-proof", "projects/prj_homehub/settings", "projects/prj_homehub/skip-with-proof", "projects/prj_homehub/nightly", "projects/prj_homehub/time-to-green",
  "projects/prj_homehub/defects", "projects/connect", "projects/connect?github=connected&installation=1&account=acme", "projects/connect?github=requested", "projects/connect?github=error&reason=expired",
  "defects", "defects/dfx_9a10", "usage", "billing", "api-keys", "settings", "settings/members",
];

const TESTS = {
  // ---------------------------------------------------------------- console proof (parallel with proof, NOT PROVEN, audit F-001 to F-008)

  async "parallel with proof: the card on a parallel run, the note on a not-proven one, none on a serial run"(page) {
    await signIn(page, "projects/prj_homehub");
    const r = await proofRuns(page);
    assert(r.proven && r.notProven && r.noProof && r.serial, `the mock lacks a proof run: ${JSON.stringify(r)}`);
    const runPage = async (x) => {
      await go(page, `projects/${x.projectId}/runs/${x.runId}`);
      await page.getByRole("heading", { name: `Run #${x.number}`, level: 1 }).waitFor();
      await settled(page);
    };
    // Every test proven: the card, "Identical to the serial run", no warning.
    await runPage(r.proven);
    const card = page.locator("#proof");
    await card.getByRole("heading", { name: "Parallel with proof" }).waitFor();
    await card.getByText("Ran in parallel, then checked test by test against the serial run.").waitFor();
    for (const dt of ["Result", "Workers", "Proven", "Re-run in one lane", "Not proven", "Parallel time", "Order digest"]) await card.locator("dt", { hasText: new RegExp(`^${dt}$`) }).waitFor();
    assert((await card.locator("dd").first().innerText()) === "Identical to the serial run", "the proven run's result is not 'Identical to the serial run'");
    assert(!(await page.locator("#not-proven-note").count()), "a proven run shows the not-proven note");
    await card.getByRole("link", { name: "How this was proven" }).waitFor();
    assert((await page.locator(".page-title-row .state").innerText()) === "Passed", "a proven run is not Passed");
    // Not proven, with its cause: the pill with its count, the card's result, the note with the sentence and the link.
    await runPage(r.notProven);
    assert((await page.locator(".page-title-row .state").innerText()) === `Not proven · ${r.notProven.notProven}`, `the pill reads ${await page.locator(".page-title-row .state").innerText()}`);
    assert((await page.locator(".page-title-row .state").getAttribute("data-tone")) === "warn", "not proven is not amber");
    assert((await page.locator("#proof dd").first().innerText()) === `Not proven for ${r.notProven.notProven} tests`, "the card's result does not say how many were not proven");
    const note = page.locator("#proof #not-proven-note.callout-warning");
    const text = await note.innerText();
    assert(new RegExp(`^${r.notProven.notProven} tests read a file outside the project, so the parallel result could not be proven equal to the serial one\\. Their serial result is reported; the run exits 1\\.`).test(text), `the note reads: ${text}`);
    await note.getByRole("link", { name: `See the ${r.notProven.notProven} tests` }).click();
    await eventually(async () => new URL(page.url()).searchParams.get("outcome") === "not_proven", "See the tests does not filter on not proven");
    await eventually(async () => {
      const outcomes = await page.locator(".test-row").evaluateAll((rows) => rows.map((x) => x.dataset.outcome));
      return outcomes.length === r.notProven.notProven && outcomes.every((o) => o === "not_proven");
    }, "the not proven filter does not list exactly the run's not-proven tests");
    const pill = page.locator(".test-row").first().locator(".state");
    assert((await pill.innerText()) === "Not proven", "a not-proven test's pill does not say Not proven");
    assert((await pill.locator("xpath=..").getAttribute("title")) === "file read outside the project", "the test's cause is not its pill's tooltip");
    await page.locator(".test-row").first().getByText(/Not proven identical to the serial run: file read outside the project\./).waitFor();
    assert(/Not proven\s*14/.test(await page.locator("#tests").getByRole("button", { name: /^Not proven/ }).innerText()), "the Not proven filter does not show its count");
    // Not proven without a proof block: no card, the note under the numbers, "The runner did not report why", the pill.
    await runPage(r.noProof);
    assert(!(await page.locator("#proof").count()), "a run without a proof block shows the proof card");
    const bare = page.locator("#not-proven-note.callout-warning");
    await bare.getByRole("link", { name: `See the ${r.noProof.notProven} tests` }).waitFor();
    const bareText = await bare.innerText();
    assert(bareText.startsWith(`${r.noProof.notProven} tests were not proven identical. The runner did not report why. Their serial result is reported; the run exits 1.`), `the note reads: ${bareText}`);
    assert((await page.locator(".page-title-row .state").innerText()) === `Not proven · ${r.noProof.notProven}`, "the pill of the run without a proof block");
    // A serial run: no card, no note.
    await runPage(r.serial);
    assert(!(await page.locator("#proof").count()) && !(await page.locator("#not-proven-note").count()), "a serial run shows the proof card or the note");
    // A running run: no card (the proof exists once it has finished).
    const running = await runningRun(page);
    await go(page, `projects/${running.projectId}/runs/${running.runId}`);
    await page.locator("#live").waitFor();
    assert(!(await page.locator("#proof").count()), "a running run shows the proof card");
  },

  async "not proven filters: the runs list returns exactly the not-proven runs, each with its count"(page) {
    await signIn(page, "projects/prj_homehub");
    const r = await proofRuns(page);
    assert(r.notProvenAll.length === 3, `the mock has ${r.notProvenAll.length} not-proven runs of homehub`);
    await page.locator("#runs").getByRole("button", { name: "Not proven", exact: true }).click();
    await eventually(async () => new URL(page.url()).searchParams.get("status") === "not_proven", "the status filter is not in the address");
    await eventually(async () => {
      const rows = await page.locator("#runs tbody tr").evaluateAll((trs) => trs.map((tr) => [tr.querySelector("td a")?.textContent, tr.querySelector(".state")?.textContent]));
      const want = r.notProvenAll.map((x) => [`#${x.number}`, `Not proven · ${x.notProven}`]);
      return JSON.stringify(rows) === JSON.stringify(want);
    }, "the not proven filter does not list exactly the mock's not-proven runs");
  },

  async "project page parallel with proof: four sections, and the empty state"(page) {
    await signIn(page, "projects/prj_homehub/parallel-with-proof");
    await page.getByRole("heading", { name: "Parallel with proof", level: 1 }).waitFor();
    await settled(page);
    const r = await proofRuns(page);
    await page.locator("#proven-trend .chart svg").waitFor();
    await page.locator("#speed .chart svg").waitFor();
    const causes = await page.locator("#causes tbody tr td:first-child").allTextContents();
    assert(causes.includes("file read outside the project") && causes.includes("environment variable read outside any test") && causes.includes("The runner did not report why"), `the causes read ${causes.join(" | ")}`);
    const rows = await page.locator("#not-proven-runs tbody tr td:first-child a").allTextContents();
    assert(JSON.stringify(rows) === JSON.stringify(r.notProvenAll.map((x) => `#${x.number}`)), `the runs not proven read ${rows.join(", ")}`);
    await page.locator("#not-proven-runs tbody tr", { hasText: `#${r.noProof.number}` }).getByText("The runner did not report why").waitFor();
    // The rail and the second bar have the section, after Runs.
    const links = await page.locator(".cx-sub .cx-sub-link").allTextContents();
    if (links.length) assert(links.indexOf("Parallel with proof") === links.indexOf("Runs") + 1, `the section is not after Runs: ${links.join(", ")}`);
    // A project with no parallel run: the empty state and the test job to copy.
    await go(page, "projects/prj_docs/parallel-with-proof");
    await page.locator("#parallel-empty").getByText("No run has used parallel lanes yet. Runs with parallel lanes show here, with the proof for each.").waitFor();
    await page.locator("#parallel-empty").getByRole("button", { name: "Copy the test job" }).waitFor();
  },

  async "overview: Proven identical, n of m runs, after Runs"(page) {
    await signIn(page, "overview");
    const o = await page.evaluate(async () => (await window.__fenvixMock.getOverview()).proof);
    assert(o.runsWithProof > 0 && o.notProven === 3, `the mock's proof block: ${JSON.stringify(o)}`);
    const kpi = page.locator("#kpi-proof");
    assert((await kpi.locator(".kpi-label").innerText()) === "Proven identical", "the KPI's label");
    assert((await kpi.locator(".kpi-value").innerText()) === `${o.provenIdentical.toLocaleString("en-US")} of ${o.runsWithProof.toLocaleString("en-US")} runs`, `the KPI reads ${await kpi.locator(".kpi-value").innerText()}`);
    assert((await kpi.locator(".kpi-sub").innerText()) === "3 not proven this month", `the KPI's sub-line reads ${await kpi.locator(".kpi-sub").innerText()}`);
    const labels = await page.locator(".kpi-label").allTextContents();
    assert(labels[0] === "Runs" && labels[1] === "Proven identical", `the KPI is not after Runs: ${labels.join(", ")}`);
  },

  async "not proven runs are finished, never green: counted per day, in the activity as not proven, not in time to green"(page) {
    await signIn(page, "projects/prj_homehub");
    const f = await page.evaluate(async () => {
      const m = window.__fenvixMock;
      const o = await m.getOverview();
      const projects = await m.listProjects();
      const since = o.runs.perDay[0].at;
      const all = (await Promise.all(projects.map((p) => m.listRuns(p.id, { since })))).flatMap((x) => x.items);
      const perDay = {};
      for (const r of all) {
        const k = new Date(Date.UTC(...r.startedAt.slice(0, 10).split("-").map((v, i) => (i === 1 ? +v - 1 : +v)))).toISOString();
        perDay[k] = (perDay[k] ?? 0) + 1;
      }
      const np = all.filter((r) => r.status === "not_proven");
      const npDays = np.map((r) => o.runs.perDay.find((p) => p.at.slice(0, 10) === r.startedAt.slice(0, 10)));
      // Time to green: first passing run of each commit; a commit whose only finished run is not proven never turns green.
      const passedCommits = new Set(all.filter((r) => r.status === "passed").map((r) => r.commitSha));
      return {
        perDayMatches: o.runs.perDay.every((p) => (perDay[p.at] ?? 0) === p.value),
        npCounted: npDays.every((d) => d && d.value === perDay[d.at]),
        np: np.length,
        npOnlyCommits: np.filter((r) => !passedCommits.has(r.commitSha)).length,
        ttgCommits: o.timeToGreen.commits,
        activity: (await m.listActivity("prj_homehub", 50)).filter((a) => np.some((r) => a.id === `run-${r.id}`)).map((a) => [a.kind, a.title]),
      };
    });
    assert(f.np === 3, `${f.np} not proven runs this window`);
    assert(f.perDayMatches && f.npCounted, "the Overview's runs per day leave out not-proven runs");
    assert(f.activity.length === 3 && f.activity.every(([k, t]) => k === "run_not_proven" && / not proven$/.test(t)), `the activity shows not-proven runs as ${JSON.stringify(f.activity)}`);
    // The feed on the page: the not-proven icon, and the word, never "failed" or "green".
    await page.locator("#activity .activity-icon[data-kind='run_not_proven']").first().waitFor();
    const titles = await page.locator("#activity li", { has: page.locator("[data-kind='run_not_proven']") }).locator("a").allTextContents();
    assert(titles.length > 0 && titles.every((t) => / not proven$/.test(t)), `the feed reads ${titles.join(", ")}`);
    // Time to green counts passed runs only: recomputed here without the not-proven runs' own commits.
    const ttg = await page.evaluate(async () => {
      const m = window.__fenvixMock;
      const o = await m.getOverview();
      const month = o.month;
      const projects = await m.listProjects();
      const all = (await Promise.all(projects.map((p) => m.listRuns(p.id, { since: `${month}-01T00:00:00.000Z` })))).flatMap((x) => x.items);
      const first = new Map();
      for (const r of all) {
        if (r.status !== "passed" || !r.finishedAt) continue;
        const k = `${r.projectId}:${r.commitSha}`;
        if (!first.has(k) || r.finishedAt < first.get(k).finishedAt) first.set(k, r);
      }
      return { passedOnly: [...first.values()].filter((r) => r.startedAt >= `${month}-01`).length, shown: o.timeToGreen.commits };
    });
    assert(ttg.passedOnly === ttg.shown, `time to green counts ${ttg.shown} commits, passed runs give ${ttg.passedOnly}`);
  },

  async "F-001 F-003 F-008: the Runs title, the tab titles, time to green per day"(page) {
    await signIn(page, "overview");
    await page.getByRole("heading", { name: "Northwind Cloud", level: 1 }).waitFor();
    await eventually(async () => (await page.title()) === "Overview · fenvix", `the overview's tab title is ${await page.title()}`);
    await go(page, "projects/prj_homehub");
    await page.getByRole("heading", { name: "Runs", exact: true, level: 1 }).waitFor();
    assert((await page.locator("main h1").count()) === 1, "the Runs page has more than one h1");
    assert(!(await page.getByRole("button", { name: "Copy replay command" }).count()), "the Runs page still copies a replay command");
    const latest = await page.locator("#latest-run").innerText();
    assert(/^Latest run · #\d+/.test(latest.replace(/\s+/g, " ")), `the latest run line reads ${latest}`);
    await page.locator("#latest-run a").first().waitFor();
    await page.locator(".running-note").getByRole("link", { name: "Watch it live" }).waitFor();
    await eventually(async () => (await page.title()) === "Runs · homehub · fenvix", `the runs page's tab title is ${await page.title()}`);
    await page.locator("#ttg-per-run").getByRole("heading", { name: "Time to green, per day" }).waitFor();
    await page.locator("#ttg-per-run").getByText("Median per day of the time from push to green.").waitFor();
    const points = Number(await page.locator("#ttg-per-run [data-points]").getAttribute("data-points"));
    assert(points > 1 && points <= 30, `the time to green chart draws ${points} points`);
    const r = await proofRuns(page);
    await go(page, `projects/${r.proven.projectId}/runs/${r.proven.runId}`);
    await page.getByRole("heading", { name: `Run #${r.proven.number}`, level: 1 }).waitFor();
    await eventually(async () => (await page.title()) === `Run #${r.proven.number} · homehub · fenvix`, `the run's tab title is ${await page.title()}`);
  },

  async "F-004: search finds a run by number and a defect by test name"(page, vp) {
    await signIn(page, "overview");
    if (isMobile(vp) && !(await page.locator(".cx-search input").isVisible())) return; // the search box is a desktop control
    const r = await proofRuns(page);
    const box = page.getByRole("combobox", { name: "Search or jump to" });
    await box.fill(String(r.proven.number));
    const run = page.getByRole("option", { name: new RegExp(`^Run #${r.proven.number} · homehub`) });
    await run.waitFor();
    assert((await run.locator(".cx-search-kind").innerText()) === "Run", "the run's row is not labelled Run");
    await run.click();
    await page.getByRole("heading", { name: `Run #${r.proven.number}`, level: 1 }).waitFor();
    await box.fill("test_discovery_update_attr");
    const defect = page.getByRole("option", { name: /test_discovery_update_attr · homehub/ });
    await defect.waitFor();
    assert((await defect.locator(".cx-search-kind").innerText()) === "Defect", "the defect's row is not labelled Defect");
    await defect.click();
    await page.waitForURL(/\/defects\/dfx_7c21$/);
  },

  async "F-005 F-006: one All projects in the drawer; card headings 17 px"(page, vp) {
    await signIn(page, "projects/prj_homehub");
    const size = await page.locator(".card h2").first().evaluate((h) => [getComputedStyle(h).fontSize, getComputedStyle(h).fontWeight]);
    assert(size[0] === "17px" && size[1] === "600", `a card heading is ${size.join(" / ")}`);
    if (!isMobile(vp)) return;
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator(".cx-drawer .cx-drawer-top").waitFor();
    const n = await page.locator(".cx-drawer").getByRole("link", { name: "All projects" }).count();
    assert(n === 1, `the drawer lists All projects ${n} times`);
  },

  async "F-007: the run page shows skeletons before its data"(page) {
    await signIn(page, "overview");
    const r = await proofRuns(page);
    const seen = await page.evaluate(async (path) => {
      let skeleton = false;
      const obs = new MutationObserver(() => {
        if (document.querySelector("main [data-skeleton]")) skeleton = true;
      });
      obs.observe(document.body, { childList: true, subtree: true });
      history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
      await new Promise((ok) => setTimeout(ok, 1500));
      obs.disconnect();
      return { skeleton, text: document.querySelector("main h1")?.textContent };
    }, `/projects/${r.proven.projectId}/runs/${r.proven.runId}`);
    assert(seen.skeleton, "no skeleton showed while the run loaded");
    assert(seen.text === `Run #${r.proven.number}`, `the run did not load after its skeleton: ${seen.text}`);
  },

  async "phone top bar keeps its height on long pages, with room around the menu button"(page, vp) {
    if (!isMobile(vp)) return;
    for (const route of ["overview", "projects", "api-keys", "defects"]) {
      if (route === "overview") await signIn(page, route);
      else {
        await page.goto(BASE + route);
        await page.locator(".shell").waitFor();
        await settled(page);
      }
      const m = await page.evaluate(() => {
        const t = document.querySelector(".cx-top").getBoundingClientRect();
        const b = document.querySelector(".cx-menu").getBoundingClientRect();
        return { bar: t.height, above: b.top - t.top, below: t.bottom - b.bottom, long: document.querySelector(".cx-content").scrollHeight > innerHeight };
      });
      assert(m.bar >= 60, `${route}: the top bar is ${m.bar}px tall, not 60`);
      assert(m.above >= 12 && m.below >= 12, `${route}: the menu button has ${m.above}px above and ${m.below}px below`);
      if (route === "overview") assert(m.long, "overview is not longer than the screen, so it does not test the squeeze");
    }
  },

  async "sign in and out"(page, vp) {
    await go(page, "projects/prj_homehub");
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    assert(!(await page.locator(".shell").count()), "the dashboard is visible while signed out");
    const order = await page.evaluate(() => [...document.querySelectorAll(".signin-card button, .signin-card [type=submit]")].map((b) => b.textContent.trim()));
    assert(/GitHub/.test(order[0]) && /Google/.test(order[1]) && /sign-in link/.test(order[2]), `sign-in buttons out of order: ${order}`);

    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.getByRole("heading", { name: "Runs", exact: true, level: 1 }).waitFor(); // lands on the route that was asked for (F-001: titled Runs)
    await page.locator(".page-kicker", { hasText: "northwind/homehub" }).waitFor();
    await openUserMenu(page, vp);
    await page.locator(".account-panel .account-who").getByText("Elena Marsh").waitFor();
    await page.reload(); // the session survives a reload
    await page.getByRole("heading", { name: "Runs", exact: true, level: 1 }).waitFor();
    await openUserMenu(page, vp);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    await toast(page, "Signed out");

    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.locator(".shell").waitFor();
    await openUserMenu(page, vp);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    await toast(page, "Signed out");

    await page.getByLabel("Work email").fill("not-an-email");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.getByRole("alert").getByText("valid email").waitFor();
    await page.getByLabel("Work email").fill("sam.rivera@northwind.cloud");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.getByText("We sent a sign-in link to sam.rivera@northwind.cloud").waitFor();
    await go(page, "?token=one-time");
    await page.getByRole("heading", { name: "Name your organization" }).waitFor();
    await page.getByLabel("Organization name").fill("Rivera Labs");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator(".shell").waitFor();
    // A new organization has nothing connected: the dashboard starts with "Connect a project".
    await page.getByRole("heading", { name: "Connect your first project" }).waitFor();
    await page.getByRole("link", { name: "Connect a project" }).first().click();
    await page.getByRole("heading", { name: "Connect a project", exact: true }).waitFor();
    await page.getByRole("button", { name: "Install the GitHub App" }).waitFor();
    await page.getByText("No installation yet: install the app first.").waitFor();
  },

  async "nothing reads as a demo; sample data says so once"(page) {
    await go(page, "overview");
    await settled(page);
    const signedOut = await visibleText(page);
    assert(!BANNED.test(signedOut), `sign-in page says "${signedOut.match(BANNED)?.[0]}"`);
    assert(!(await page.locator(".sample-note").count()), "the sign-in page shows the sample data note");

    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.locator(".shell").waitFor();
    for (const route of ROUTES) {
      await go(page, route);
      await page.waitForSelector("main h1");
      await settled(page);
      await page.waitForTimeout(150);
      const text = await visibleText(page);
      const bad = text.match(BANNED);
      assert(!bad, `${route} says "${bad?.[0]}" in: ${text.split("\n").find((l) => BANNED.test(l))}`);
      assert((await page.locator(".sample-note").count()) === 1, `${route} does not say it shows sample data`);
      if (route === "api-keys") await page.locator(".coming-soon").getByRole("heading", { name: "Coming soon" }).waitFor();
      assert((await page.locator(".sample-note .sample-badge").innerText()).toLowerCase() === "sample data", `${route}: the note does not read Sample data`);
    }
    assert(!BANNED.test(await page.title()), `the page title says "${(await page.title()).match(BANNED)?.[0]}"`);
  },

  async "overview"(page) {
    // The home page opens the runs of the project opened last (or the first one).
    await signIn(page, "");
    await page.getByRole("heading", { name: "Runs", exact: true, level: 1 }).waitFor();
    assert(new URL(page.url()).pathname === "/projects/prj_homehub" && !page.url().includes("#"), `the home page is at ${page.url()}`);
    await go(page, "overview");
    await page.getByRole("heading", { name: "Northwind Cloud" }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "Northwind Cloud" }).waitFor();
    const kpis = await page.locator(".kpi").allInnerTexts();
    assert(kpis.length === 7, `expected 7 numbers, got ${kpis.length}`);
    const labels = await page.locator(".kpi-label").allTextContents();
    assert(labels.join("|") === "Runs|Proven identical|Minutes saved|Skipped with proof|Time to green|On GitHub-hosted|Open defects", `numbers read ${labels.join("|")}`);
    // "Proven identical" (console proof) is checked in its own check; the six others keep their places in `values`.
    const values = (await page.locator(".kpi-value").allTextContents()).filter((_, i) => i !== 1);
    assert(num(values[0]) > 300, `runs this month read ${values[0]}`);
    assert(/^\d+%$/.test(values[2]) && num(values[2]) >= 90, `the median share skipped reads ${values[2]} (home-assistant-like runs dominate: about 97%)`);
    assert(/^\$[\d,.]+$/.test(values[4]), `the GitHub cost reads ${values[4]}`);
    assert((await page.locator(".chart svg").count()) >= 2, "the overview is missing charts");
    await page.locator("#cost").getByText("$479", { exact: true }).waitFor();
    await page.locator("#cost").getByText(/run units used\. Units included: not set yet\./).waitFor();
    assert(!(await page.locator("#trial").count()), "a paying organization shows a trial");
    const cost = await addsUp(page, "#cost-minutes");
    assert(values[1] === `${cost.skipped.toLocaleString("en-US")} min`, `minutes saved ${values[1]} is not the skipped part ${cost.skipped}`);
    assert((await page.locator(".kpi", { hasText: "On GitHub-hosted" }).innerText()).includes(`${cost.total.toLocaleString("en-US")} min`), "the GitHub KPI does not show the same minutes");
    await page.locator("#cost").getByText("Skipped test time only").waitFor();
    await page.locator("#ttg").getByText("Before fenvix").waitFor();
    const rows = await page.locator("#projects tbody tr").count();
    assert(rows === 4, `the projects table has ${rows} rows`);
    // Measured shapes: the Django project skips about nothing, the docs monorepo nearly everything.
    const share = async (name) => num(await page.locator("#projects tbody tr", { hasText: name }).locator(".skip-share .mono").innerText());
    assert((await share("northwind/storefront")) <= 10, "the Django project skips too much");
    assert((await share("northwind/docs-site")) >= 95, "the docs monorepo skips too little");
    const ledger = await share("northwind/ledger");
    assert(ledger >= 25 && ledger <= 56, `the Go service reads ${ledger}%, not 25 to 56%`);
    await page.locator("#defects .defect-mini a").first().click();
    await page.locator(".order-list").waitFor();
  },

  async "projects, a project, its runs and settings"(page) {
    await signIn(page, "projects");
    assert((await page.locator("main tbody tr").count()) === 4, "the project list is not 4 rows");
    // The newest run of homehub is still running: amber, with its word.
    await page.locator("main tbody tr", { hasText: "northwind/homehub" }).getByText("Running", { exact: true }).waitFor();
    await page.locator("main").getByRole("link", { name: "northwind/homehub" }).click();
    await page.getByRole("heading", { name: "Runs", exact: true, level: 1 }).waitFor();
    await page.locator(".running-note").getByRole("link", { name: "Watch it live" }).waitFor();
    await addsUp(page, "#project-minutes");
    assert((await page.locator("#runs tbody tr").count()) === 25, "the runs list is not 25 rows a page");
    await page.locator("#runs").getByRole("button", { name: "Failed", exact: true }).click();
    await eventually(async () => new URL(page.url()).searchParams.get("status") === "failed", "the status filter is not in the address");
    await eventually(async () => {
      const states = await page.locator("#runs tbody tr .state").allTextContents();
      return states.length > 0 && states.every((t) => t === "Failed");
    }, "the failed filter shows other runs");
    await page.locator("#runs").getByRole("button", { name: "Pull requests" }).click();
    await eventually(async () => (await page.locator("#runs tbody tr td[data-label='Branch or pull request'] .branch-cell").allTextContents()).every((t) => t.startsWith("#")), "the pull request filter shows branch runs");
    // Settings: the one-line snippet, the change the setup pull request makes (from the API), and the switches.
    await go(page, "projects/prj_homehub/settings");
    await page.getByRole("heading", { name: "The test job on fenvix" }).waitFor();
    assert((await page.locator(".codebox pre").innerText()).includes("runs-on: fenvix"), "the setup snippet does not say runs-on: fenvix");
    await page.locator(".diff", { hasText: "+ runs-on: fenvix" }).waitFor();
    const sw = page.getByRole("switch", { name: /Nightly exploration/ });
    await page.getByText(/A paid add-on; not counted in your run units/).waitFor();
    const before = await sw.getAttribute("aria-checked");
    await sw.click();
    await page.getByLabel("Test command").fill("pytest tests -p no:cacheprovider");
    await page.getByRole("button", { name: "Save settings" }).click();
    await toast(page, "Project settings saved");
    const saved = await page.evaluate(async () => (await window.__fenvixMock.getProject("prj_homehub")).settings);
    assert(String(saved.nightlyExploration) !== before && saved.testCommand === "pytest tests -p no:cacheprovider", `the settings were not saved: ${JSON.stringify(saved)}`);
  },

  async "skip with proof: audit reruns, the rule-of-three bound, keys no longer trusted"(page) {
    await signIn(page, "projects/prj_homehub/skip-with-proof");
    const audit = page.locator("#audit");
    await audit.getByText("Skipped tests rerun").waitFor();
    const v = (await audit.locator(".kpi-value").allTextContents()).map(num);
    assert(v[0] >= 1000, `only ${v[0]} skipped tests were rerun`);
    assert(v[1] === 0, `wrong skips read ${v[1]}`);
    assert(v[2] === 2, `${v[2]} untrusted keys, not 2`);
    await audit.getByText("Expected 0").waitFor();
    const bound = await audit.locator(".audit-bound").innerText();
    const n = num(bound.match(/1 in ([\d,]+)/)?.[1]);
    assert(n === Math.floor(v[0] / 3), `the bound reads "${bound}" for ${v[0]} reruns`);
    assert(/95% confidence/.test(bound), `the bound does not say its confidence: ${bound}`);
    assert((await audit.locator(".audit-list").first().locator("li").count()) === 2, "the untrusted keys are not listed");
    assert(/^[0-9a-f]{32}$/.test(await audit.locator(".audit-list .hash").first().innerText()), "an untrusted key is not a 32-hex cache key");
    // Nightly exploration: Northwind has the add-on, so no note about it.
    await go(page, "projects/prj_homehub/nightly");
    await page.getByRole("heading", { name: "Nightly exploration" }).waitFor();
    await page.locator("#nights").waitFor();
    assert(!(await page.locator(".addon-note").count()), "an organization with the add-on is told it is paid");
    await go(page, "projects/prj_homehub/time-to-green");
    await page.locator("#ttg-chart .chart svg").waitFor();
  },

  async "the shadow trial: days left, the 35% gate met and not met, shadow runs, the add-on note"(page) {
    await signIn(page, "overview");
    await useOrgOf(page, "org_harbor", "overview");
    const trial = page.locator("#trial");
    await trial.getByRole("heading", { name: "Shadow trial: 12 days left" }).waitFor();
    const share = num(await trial.locator(".kpi-value").first().innerText());
    assert(share >= 35, `the trial would have skipped ${share}%`);
    await trial.locator(".state-ok", { hasText: "35% gate met" }).waitFor();
    await trial.getByText("Run units", { exact: true }).waitFor();
    await trial.getByText("not billed during the trial").waitFor();
    // The same trial in Billing.
    await go(page, "billing");
    await page.locator("#trial").getByText("35% gate met").waitFor();
    await page.locator("#current").getByText("In trial").waitFor();
    // A shadow run says that nothing was skipped.
    const run = await shadowRun(page);
    await go(page, `projects/${run.projectId}/runs/${run.runId}`);
    await page.getByText(`Shadow run: nothing was skipped; ${run.would.toLocaleString("en-US")} tests would have been.`).waitFor();
    await page.locator(".kpi", { hasText: "Would have skipped" }).waitFor();
    // Nightly exploration is a paid add-on this organization does not have.
    await go(page, "projects/prj_homehub/nightly");
    await page.locator(".addon-note").getByText("Nightly exploration is a paid add-on").waitFor();
    // Below the gate (the mock's switch): the same screen says so, in amber, with words.
    await page.evaluate(() => sessionStorage.setItem("fenvix-mock-trial", "below"));
    await page.goto(BASE + "overview");
    await page.locator("#trial .state-warn", { hasText: "Below the 35% gate" }).waitFor();
    const low = num(await page.locator("#trial .kpi-value").first().innerText());
    assert(low < 35, `below the gate reads ${low}%`);
    await page.locator("#trial").getByText(/under the 35% the trial asks for/).waitFor();
  },

  async "the live run: progress while running, polling stops once it has finished, and while the page is hidden"(page) {
    await signIn(page, "overview");
    const run = await runningRun(page);
    assert(run, "the mock has no running run");
    await go(page, `projects/${run.projectId}/runs/${run.runId}`);
    await page.getByRole("heading", { name: `Run #${run.number}` }).waitFor();
    await page.locator(".page-header .state-warn", { hasText: "Running" }).waitFor();
    const live = page.locator("#live");
    await live.getByText("Running tests").waitFor();
    for (const label of ["Passed", "Failed", "Skipped with proof", "Elapsed"]) await live.locator("dt", { hasText: label }).waitFor();
    await live.getByText("Now running:").waitFor();
    const bar = live.getByRole("progressbar", { name: "Tests done" });
    const first = Number(await bar.getAttribute("aria-valuenow"));
    assert(first > 0 && first < Number(await bar.getAttribute("aria-valuemax")), `the progress reads ${first}`);
    await page.getByText("Per-test results arrive when the run finishes.").waitFor();
    // Hidden: no question until the page is shown again.
    const calls = () => page.evaluate(() => window.__fenvixMock.liveCalls());
    await eventually(async () => (await calls()) >= 1, "the live view never asked");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(400);
    const hidden = await calls();
    await page.waitForTimeout(1500);
    assert((await calls()) === hidden, "the live view asked while the page was hidden");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await eventually(async () => !(await bar.count()) || Number(await bar.getAttribute("aria-valuenow")) > first, "the progress did not move");
    // Finished: passed, the tests and minutes appear, and nobody asks any more.
    await page.locator(".page-header .state-ok", { hasText: "Passed" }).waitFor({ timeout: 20000 });
    assert(!(await page.locator("#live").count()), "the live block stayed after the run finished");
    await addsUp(page, "#run-minutes");
    await page.locator(".test-row").first().waitFor();
    const done = await calls();
    await page.waitForTimeout(1500);
    assert((await calls()) === done, `the live view kept asking after the run finished (${done} then ${await calls()})`);
  },

  async "a run: every test's outcome, a flaky failure and a skip receipt"(page) {
    await signIn(page, "overview");
    const { projectId, runId, number } = await flakyRun(page);
    await go(page, `projects/${projectId}/runs/${runId}`);
    await page.getByRole("heading", { name: `Run #${number}` }).waitFor();
    const v = (await page.locator(".kpi-value").allTextContents()).map(num);
    assert(v[0] === v[1] + v[2], `tests ${v[0]} are not ran ${v[1]} plus skipped ${v[2]}`);
    assert(v[3] >= 1, "the run has no failure");
    const m = await addsUp(page, "#run-minutes");
    assert((await page.locator(".kpi", { hasText: "Saved" }).locator(".kpi-value").innerText()) === `${m.skipped} min`, "the run's Saved is not the skipped part");
    await page.locator("#tests").getByRole("button", { name: /^Failed/ }).click();
    const failed = page.locator(".test-row").first();
    await failed.getByText("Failed: flaky defect").waitFor();
    await failed.getByRole("link", { name: "open the defect and its replay command" }).waitFor();
    await page.locator("#tests").getByRole("button", { name: /^Skipped/ }).click();
    await eventually(async () => (await page.locator(".test-row").first().getAttribute("data-outcome")) === "skipped_with_proof", "the skipped filter did not apply");
    const counts = num(await page.locator("#tests").getByRole("button", { name: /^Skipped/ }).locator(".seg-count").innerText());
    assert(counts === v[2], `the skipped count ${counts} is not the run's ${v[2]}`);
    await page.locator(".test-row").first().getByRole("button", { name: /^Receipt for / }).click();
    const dialog = page.getByRole("dialog", { name: "Skipped with proof" });
    await dialog.getByText("Cache key").waitFor();
    for (const part of ["Code executed", "Files read", "Environment variables read", "Runtime and configuration"]) await dialog.getByRole("heading", { name: new RegExp(`^${part}`) }).waitFor();
    const hashes = await dialog.locator(".hash").allTextContents();
    assert(hashes.length >= 4 && hashes.filter((h) => /^[0-9a-f]{32}$/.test(h)).length >= 4, `the receipt hashes read ${hashes.slice(0, 3)}`);
    assert(new URL(page.url()).searchParams.get("receipt"), "the receipt is not in the address");
    const reused = dialog.getByRole("link", { name: /^run #\d+$/ });
    const reusedNumber = (await reused.innerText()).replace("run ", "");
    await reused.click();
    await page.getByRole("heading", { name: `Run ${reusedNumber}` }).waitFor();
    await eventually(async () => !new URL(page.url()).searchParams.get("receipt"), "the receipt stays in the address on the reused run");
    await eventually(async () => !(await page.locator("dialog[open]").count()), "the receipt stays open on the reused run");
    await page.getByLabel("Search tests").fill("zzz-nothing");
    await page.getByText("No test matches.").waitFor();
  },

  async "defects: families, the cause named, the minimal order and the replay command"(page) {
    await signIn(page, "defects");
    // The two storefront defects share one polluter: one family.
    const family = page.locator(".card", { hasText: "test_voucher_cache_warm" });
    await family.waitFor();
    assert((await family.locator("tbody tr").count()) === 2, "the voucher-cache family does not hold 2 defects");
    await family.getByText("Polluter").first().waitFor();
    await family.getByRole("link", { name: "test_checkout_complete_with_voucher" }).click();
    await page.getByRole("heading", { name: "test_checkout_complete_with_voucher" }).waitFor();
    await page.locator(".state", { hasText: "Replays 10/10" }).first().waitFor();
    const order = await page.locator(".order-list li .mono").allTextContents();
    assert(order.length === 2 && order[0].endsWith("test_voucher_cache_warm") && order[1].endsWith("test_checkout_complete_with_voucher"), `the minimal order reads ${order}`);
    const replay = await page.locator("#replay pre").innerText();
    // The runner sent its own command with this bundle: it is the one shown, with <bundle> where the pull writes it.
    assert(replay.includes("pytest --det --det-seed=1 --det-order=.fenvix/defects/dfx_9a10/order.txt -n 0"), `the replay command reads ${replay}`);
    assert(/^[0-9a-f]{32}$/.test(await page.locator("#facts .hash").innerText()), "the fingerprint is not 32 hex characters");
    // A Node defect: the seed only, and the page says the order is not replayed.
    await go(page, "defects/dfx_3b05");
    await page.getByRole("heading", { name: "localizes paths 3" }).waitFor();
    assert((await page.locator("#replay pre").innerText()).includes("detjs vitest run --det --det-seed=32"), "the Node replay command is wrong");
    await page.getByText("does not take an order of tests yet").waitFor();
    // Fixed defects are kept apart.
    await go(page, "defects?state=fixed");
    await page.getByRole("link", { name: "test_track_point_in_time_drift_rearm" }).waitFor();
    await go(page, "defects?project=prj_ledger");
    await page.getByRole("heading", { name: "No open defects" }).waitFor();
  },

  async "connect a project: installations, every onboarding state, the setup pull request, GitHub's return"(page) {
    await signIn(page, "projects/connect");
    const inst = (account) => page.locator(".install", { has: page.getByRole("heading", { name: account, exact: true }) });
    await inst("northwind").locator(".state-ok", { hasText: "Active" }).waitFor();
    await inst("northwind-labs").locator(".state-warn", { hasText: "Suspended" }).waitFor();
    await inst("elena-marsh").getByText("Uninstalled", { exact: true }).waitFor();
    await inst("elena-marsh").getByText(/Uninstalled from GitHub/).waitFor();
    assert(!(await inst("elena-marsh").locator(".repo-row").count()), "the repositories of an uninstalled installation are listed");
    // All nine onboarding states, each with its words and the App's detail.
    for (const [repo, label] of [["billing-worker", "Not set up yet"], ["mobile-app", "Pull request open"], ["homehub", "On fenvix"], ["analytics", "Pull request closed"], ["infra-scripts", "No workflow file"], ["design-system", "No test job found"], ["search-service", "Already on fenvix"], ["checkout-legacy", "Test runner not supported"], ["notifications", "Could not open the pull request"]]) {
      const row = page.locator(".repo-row", { hasText: `northwind/${repo}` });
      await row.locator(".state", { hasText: label }).waitFor();
      assert((await row.locator(".repo-detail").innerText()).length > 20, `northwind/${repo} has no detail`);
    }
    // Detected, not written in: the language and runner of each repository come from the App.
    await page.locator(".repo-row", { hasText: "northwind/checkout-legacy" }).getByText("Language and test runner not detected").waitFor();
    await page.locator(".repo-row", { hasText: "northwind/mobile-app" }).getByText("Private · TypeScript / Node · jest").waitFor();
    assert((await page.locator(".repo-row", { hasText: "northwind/mobile-app" }).getByRole("link", { name: /Setup pull request #812/ }).getAttribute("href")) === "https://github.com/northwind/mobile-app/pull/812", "the pull request link is wrong");
    // A suspended installation: no pull request can be opened.
    assert(await page.getByRole("button", { name: "Open setup pull request on northwind-labs/experiments" }).isDisabled(), "a pull request can be opened on a suspended installation");
    // Open one: queued, then the list is asked again until the App has opened it.
    const row = page.locator(".repo-row", { hasText: "northwind/billing-worker" });
    assert((await row.locator(".diff").innerText()).includes("- runs-on: ubuntu-latest"), "the diff does not show the old runner");
    await row.getByRole("button", { name: "Open setup pull request on northwind/billing-worker" }).click();
    await row.getByText("Queued: the fenvix GitHub App is opening it.").waitFor();
    await row.locator(".state-warn", { hasText: "Pull request open" }).waitFor({ timeout: 15000 });
    assert((await row.getByRole("link", { name: /^Setup pull request #\d+/ }).getAttribute("href")).startsWith("https://github.com/northwind/billing-worker/pull/"), "the new pull request link is wrong");
    await toast(page, /Opened pull request #\d+ on northwind\/billing-worker/);
    // Another GitHub account: the install link, and GitHub sending the browser back (the mock stands in for GitHub).
    await page.getByRole("button", { name: "Add another GitHub account" }).click();
    await page.locator(".callout-success").getByText("The fenvix GitHub App is installed on northwind-sandbox.").waitFor();
    const url = new URL(page.url());
    assert(url.searchParams.get("github") === "connected" && url.searchParams.get("installation") && url.searchParams.get("account") === "northwind-sandbox", `GitHub's return address was ${page.url()}`);
    await inst("northwind-sandbox").locator(".state-ok", { hasText: "Active" }).waitFor();
    assert((await page.locator(".install").count()) === 4, "four installations are not all shown");
    await page.locator(".callout-success").getByRole("button", { name: "Dismiss" }).click();
    await eventually(async () => !new URL(page.url()).searchParams.get("github"), "the banner stays in the address");
    // Every way back from GitHub reads as a sentence.
    const reasons = { expired: "install link expired", incomplete: "did not finish the installation", oauth: "could not confirm who you are", not_yours: "made for someone else", not_admin: "Only an owner or admin", other_organization: "already linked to another fenvix organization", github: "GitHub did not answer", error: "Something went wrong while the installation" };
    for (const [reason, text] of Object.entries(reasons)) {
      await go(page, `projects/connect?github=error&reason=${reason}`);
      await page.getByRole("alert").getByText(text).waitFor();
    }
    await go(page, "projects/connect?github=error&reason=unheard-of");
    await page.getByRole("alert").getByText("Something went wrong while the installation").waitFor();
    await go(page, "projects/connect?github=requested");
    await page.locator(".callout-warning").getByText("Waiting for an owner of the GitHub organization.").waitFor();
  },

  async "usage: run units, per project, the rows add up, CSV export"(page) {
    await signIn(page, "usage");
    const card = page.locator("#units-used");
    await card.getByText("Units included in your plan: not set yet.").waitFor();
    await card.getByText(/1 run unit = 10 baseline minutes/).waitFor();
    const billed = num(await card.locator(".big-number").innerText());
    const runsUsed = num((await card.locator(".card-desc").innerText()).match(/([\d,]+) billable/)[1]);
    const runs = (await page.locator("tbody td[data-label='Runs']").allTextContents()).map(num);
    assert(runs.length === 5 && runs.reduce((a, b) => a + b, 0) === runsUsed, `per-row runs ${runs} do not add up to ${runsUsed}`);
    await page.locator("tbody tr", { hasText: "Repositories not set up as projects" }).waitFor();
    const unitsTotal = num(await page.locator("tfoot td[data-key='units']").innerText());
    assert(billed >= unitsTotal && billed - unitsTotal < 1.1, `${billed} units billed for ${unitsTotal} used`);
    assert((await page.locator(".chart svg").count()) >= 1, "the runs-per-day chart is missing");
    // The minutes add up on screen: in the sentence, in every row, and down every column (units included).
    await addsUp(page, "#usage-minutes");
    const table = await page.evaluate(() => {
      const val = (td) => Number(td.textContent.replace(/[^\d.]/g, ""));
      const rows = [...document.querySelectorAll("main tbody tr")].map((tr) => Object.fromEntries([...tr.querySelectorAll("td[data-key]")].map((td) => [td.dataset.key, val(td)])));
      const total = Object.fromEntries([...document.querySelectorAll("main tfoot td[data-key]")].map((td) => [td.dataset.key, val(td)]));
      return { rows, total };
    });
    for (const r of [...table.rows, table.total]) assert(Math.abs(r.testMinutesRan + r.minutesSaved + r.otherStepMinutes - r.githubEquivalentMinutes) < 0.001, `a row does not add up: ${JSON.stringify(r)}`);
    for (const k of Object.keys(table.total)) {
      const down = table.rows.reduce((a, r) => a + r[k], 0);
      assert(Math.abs(down - table.total[k]) < 0.011, `the ${k} column adds up to ${down}, the total says ${table.total[k]}`);
    }
    const file = await savedFile(page, () => page.getByRole("button", { name: "Export CSV" }).click());
    const lines = file.text.trim().split("\n");
    assert(file.name === "fenvix-usage-2026-11.csv", `the file is ${file.name}`);
    assert(lines[0] === "project,runs,units,test_minutes_ran,minutes_saved,other_step_minutes,github_equivalent_minutes,github_equivalent_usd" && lines.length === 6, `the CSV reads ${lines[0]} (${lines.length} lines)`);
    for (const l of lines.slice(1)) {
      const [, , , ran, saved, other, gh] = l.split(",").map(Number);
      assert(ran + saved + other === gh, `a CSV row does not add up: ${l}`);
    }
    await toast(page, "CSV ready");
    await choose(page, page.locator("#u-month"), "2026-10");
    await eventually(async () => new URL(page.url()).searchParams.get("month") === "2026-10", "the month did not change");
  },

  async "billing: plans by run units with their prices, units not set yet, the Nightly exploration add-on"(page) {
    await signIn(page, "billing");
    const plans = await page.locator("#plans .plan-head h3").allTextContents();
    assert(plans.join("|") === "Starter|Team|Scale|Monorepo", `plans read ${plans.join("|")}`);
    const prices = await page.locator("#plans .plan-price strong").allTextContents();
    assert(prices.join("|") === "$129|$479|$1,350|$4,200", `prices read ${prices.join("|")}`);
    assert((await page.locator("#plans .plan .small").allTextContents()).filter((t) => t.startsWith("Run units included: not set yet")).length === 4, "a plan's units are not said to be unset");
    assert(/current plan/i.test(await page.locator(".plan-current .tag").innerText()), "no plan is marked as the current one");
    assert((await page.locator(".plan-current h3").innerText()) === "Team", "the current plan is not Team");
    await page.locator("#current").getByText("Units included in your plan: not set yet.").waitFor();
    await page.locator("#sizing").getByText(/not set yet, so no plan is suggested/).waitFor();
    const addon = page.locator("#addons .addon", { hasText: "Nightly exploration" });
    await addon.getByText("Price not set yet").waitFor();
    await addon.getByText("Added", { exact: true }).waitFor();
    assert(!(await page.locator("#trial").count()), "a paying organization shows a trial");
    await page.getByText("No payment method yet").waitFor();
  },

  async "api keys: coming soon, no list and no form"(page) {
    await signIn(page, "api-keys");
    await page.getByRole("heading", { name: "API keys", level: 1 }).waitFor();
    await page.locator(".coming-soon").getByRole("heading", { name: "Coming soon" }).waitFor();
    assert(!(await page.locator("main table, main form, main input").count()), "the API keys page still has a list or a form");
    // The navigation keeps the entry.
    assert(await page.locator('a[href="/api-keys"]').count(), "the API keys entry left the navigation");
  },

  async "sidebar: brand and workspace"(page, vp) {
    await signIn(page, "overview");
    const nav = isMobile(vp) ? ".cx-drawer" : ".cx-account";
    const rename = async (name) => {
      await go(page, "settings");
      await settled(page);
      await page.getByLabel("Organization name").fill(name);
      await page.getByRole("button", { name: "Rename" }).click();
      await toast(page, "Organization renamed");
      await go(page, "overview");
      await settled(page);
      await eventually(async () => (await page.locator(`${nav} .workspace-name`).textContent()) === name.trim(), `the sidebar does not show ${name}`);
      if (isMobile(vp)) {
        await page.getByRole("button", { name: "Open navigation" }).click();
        await page.locator(".cx-drawer .cx-drawer-top").waitFor();
      }
      // The block at the bottom: the person, with the organization and role under the name. Its accessible name holds
      // all of it and says what the button does.
      await page.locator(nav).getByRole("button", { name: new RegExp(`^Elena Marsh\\s*${name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*·\\s*Owner\\s*: account and organizations$`) }).waitFor();
      const box = page.locator(`${nav} .account-btn`);
      await box.click();
      const current = page.locator(`${nav} .account-panel .org-item[aria-current="true"]`);
      await current.waitFor();
      const avatarRead = await current.evaluate((el) => {
        const a = el.querySelector(".workspace-avatar");
        return { initial: a.textContent, bg: getComputedStyle(a).backgroundColor, fg: getComputedStyle(a).color };
      });
      await box.click();
      const read = await box.evaluate((el) => {
        const label = el.querySelector(".workspace-name");
        const empty = [...el.querySelectorAll("*")].filter((e) => !e.textContent.trim() && e.tagName !== "svg" && !e.closest("svg")).map((e) => e.className);
        return {
          role: el.querySelector(".workspace-sub")?.textContent,
          title: el.getAttribute("title"),
          clipped: label.scrollWidth > label.clientWidth,
          ellipsis: getComputedStyle(label).textOverflow === "ellipsis" && getComputedStyle(label).whiteSpace === "nowrap",
          inside: label.getBoundingClientRect().right <= el.getBoundingClientRect().right + 0.5,
          empty,
          tag: el.tagName,
          brandInside: !!el.querySelector(".logo"),
        };
      });
      if (isMobile(vp)) await page.getByRole("button", { name: "Close navigation" }).click();
      return { ...read, ...avatarRead };
    };

    // The brand sits on its own at the top, outside the organization.
    if (isMobile(vp)) await page.getByRole("button", { name: "Open navigation" }).click();
    const brand = page.locator(isMobile(vp) ? ".cx-drawer .cx-drawer-top .logo" : ".cx-top .logo");
    await brand.waitFor();
    assert((await brand.innerText()).trim() === "FENVIX", "the brand is missing at the top of the navigation");
    if (isMobile(vp)) await page.getByRole("button", { name: "Close navigation" }).click();

    const mine = await rename("My workspace");
    assert(mine.initial === "M", `My workspace shows ${mine.initial}`);
    assert(mine.role === "Owner", `the role reads ${mine.role}`);
    assert(mine.title === "Elena Marsh · My workspace", `the tooltip reads ${mine.title}`);
    // On a computer the text is visually hidden (the avatar shows; screen readers still get the name): only the
    // phone's drawer shows it, so only there can it be cut off or run out of its box.
    if (isMobile(vp)) assert(!mine.clipped, "My workspace is cut off");
    assert(!mine.empty.length, `empty elements in the organization box: ${mine.empty.join(", ")}`);
    assert(mine.tag === "BUTTON", "the organization box is not a button");
    assert(!mine.brandInside, "the brand is inside the organization box");
    assert(mine.bg === "rgb(6, 8, 14)" && mine.fg === "rgb(255, 255, 255)", `the avatar is not the dark colour with a white initial: ${mine.bg} ${mine.fg}`);
    // The logo mark is the frame's ink (with its fade) on the light top bar, as in the console mockup; not tinted.
    const mark = await page.evaluate(() => {
      const svg = document.querySelector(".cx-top .logo svg");
      return { svg: getComputedStyle(svg).color, stops: [...svg.querySelectorAll("stop")].map((s) => getComputedStyle(s).stopColor) };
    });
    assert(mark.svg === "rgb(20, 22, 27)" && mark.stops.every((c) => c === "rgb(20, 22, 27)"), `the logo mark in the top bar is ${mark.svg} (${mark.stops})`);

    assert((await rename("🚀 Launch team")).initial === "🚀", "an emoji name does not show the emoji");
    const accented = await rename("élan studio");
    assert(accented.initial === "É", "an accented name does not show É");
    assert(accented.bg === mine.bg, "another name got another colour");

    const long = "Northwind Cloud Platform Engineering, EU West production";
    const l = await rename(long);
    // On a computer the top bar shows the account as an avatar only; the drawer on a phone shows the name, cut.
    if (isMobile(vp)) assert(l.clipped && l.ellipsis, "a long name is not cut with an ellipsis");
    if (isMobile(vp)) assert(l.inside, "a long name runs out of its box");
    assert(l.title === `Elena Marsh · ${long}`, `the tooltip does not hold the whole name: ${l.title}`);

    // Keyboard order: skip link, then the brand in the top bar (desktop) or the menu button (phone).
    await page.reload(); // a fresh load, so focus starts at the top of the document
    await page.locator(".shell").waitFor();
    await settled(page);
    await page.keyboard.press("Tab");
    assert(await page.evaluate(() => document.activeElement?.classList.contains("skip-link")), "the first Tab does not reach the skip link");
    await page.keyboard.press("Tab");
    const second = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent.trim());
    assert(isMobile(vp) ? second === "Open navigation" : second === "FENVIX, overview", `the second Tab reaches ${second}`);
  },


  async "select: keyboard, mouse and one look for every dropdown"(page) {
    await signIn(page, "defects");
    assert(!(await page.locator("select, datalist").count()), "a native select or datalist is on the page");
    const sel = page.locator("#d-project");
    const value = async () => (await sel.textContent()).trim();
    assert((await sel.getAttribute("role")) === "combobox" && (await sel.getAttribute("aria-haspopup")) === "listbox", "the select is not a combobox");
    await sel.focus();
    await page.keyboard.press("ArrowDown");
    const list = page.getByRole("listbox", { name: "Project" });
    await list.waitFor();
    assert((await list.locator('[aria-selected="true"]').textContent()).trim() === "All projects", "the current choice is not marked");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await list.waitFor({ state: "detached" });
    await eventually(async () => (await value()) === "northwind/homehub", "Enter did not pick the next option");
    assert(await sel.evaluate((e) => e === document.activeElement), "focus left the select");
    await eventually(async () => new URL(page.url()).searchParams.get("project") === "prj_homehub", "the pick did not reach the list");
    await page.keyboard.press("Enter");
    await page.keyboard.press("End");
    await page.keyboard.press("Escape");
    await list.waitFor({ state: "detached" });
    assert((await value()) === "northwind/homehub", "Escape changed the choice");
    await page.keyboard.press(" ");
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await eventually(async () => (await value()) === "All projects", "Home did not reach the first option");
    await sel.click();
    await list.waitFor();
    await page.locator("main h1").click();
    await list.waitFor({ state: "detached" });
  },

  async "settings"(page) {
    await signIn(page, "settings");
    await page.getByLabel("Organization name").fill("Northwind Platform");
    await page.getByRole("button", { name: "Rename" }).click();
    await page.getByText("Organization renamed").waitFor();
    await page.getByLabel(/Email me about new defects/).uncheck();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Settings saved").waitFor();
    // The region: an owner chooses where jobs run.
    const region = page.locator("#region");
    assert(await region.getByRole("radio", { name: /United States/ }).isChecked(), "the region is not US");
    assert(await region.getByRole("button", { name: "Save region" }).isDisabled(), "an unchanged region can be saved");
    await region.getByRole("radio", { name: /European Union/ }).check();
    await region.getByRole("button", { name: "Save region" }).click();
    await toast(page, "Region saved: European Union");
    const saved = await page.evaluate(async () => await window.__fenvixMock.getSettings());
    assert(saved.region === "eu" && saved.emailNotices === false, `the settings read ${JSON.stringify(saved)}`);
    await region.getByText("A change applies from the next job on").waitFor();
    await go(page, "overview");
    await settled(page);
    await eventually(async () => (await page.locator(".workspace-name").first().textContent()).includes("Northwind Platform"), "the sidebar still shows the old organization name");
    await page.getByRole("heading", { name: "Northwind Platform" }).waitFor();
  },

  async "navigation: breadcrumb at every level, one way back to all projects, the rail opens above everything"(page, vp) {
    if (isMobile(vp)) return;
    await signIn(page, "projects/prj_homehub/defects");
    const crumbs = page.getByRole("navigation", { name: "Where you are" });
    // Org / Projects / <project> / <section>: each level before the current one is a link.
    await crumbs.getByRole("link", { name: "Defects" }).waitFor();
    assert((await crumbs.getByRole("link", { name: "Defects" }).getAttribute("aria-current")) === "page", "the section is not marked as the current level");
    // ONE sub-navigation: the project's sections replace the projects list, with the way back on top.
    assert((await page.locator(".cx-sub").count()) === 1, "more than one second bar");
    assert(!(await page.getByRole("navigation", { name: "Your projects" }).count()), "the projects list is shown next to the project's sections");
    // The switcher opens a list of projects; choosing one keeps the section.
    await crumbs.getByRole("button", { name: "Switch project" }).click();
    await page.getByRole("group", { name: "Switch project" }).getByRole("link", { name: /docs-site/ }).click();
    await page.waitForURL(/\/projects\/prj_docs\/defects/);
    // Back to all projects in one click, from the breadcrumb or from the second bar.
    await page.locator(".cx-sub").getByRole("link", { name: "All projects" }).click();
    await page.waitForURL(/\/projects$/);
    await page.getByRole("navigation", { name: "Your projects" }).waitFor();
    // Browser back returns to the project, with its sections.
    await page.goBack();
    await page.waitForURL(/\/projects\/prj_docs\/defects/);
    await crumbs.getByRole("link", { name: "Projects", exact: true }).click();
    await page.waitForURL(/\/projects$/);

    // The collapsed rail opens ABOVE the second bar and the content, not under them.
    await page.locator("main").waitFor();
    await page.getByRole("link", { name: "northwind/homehub" }).first().click();
    await page.locator(".cx-sub").waitFor();
    await page.locator(".cx-rail").hover();
    await page.waitForFunction(() => document.querySelector(".cx-rail[data-wide]"));
    const top = await page.evaluate(() => {
      const sub = document.querySelector(".cx-sub").getBoundingClientRect();
      const el = document.elementFromPoint(sub.left + 40, sub.top + 140);
      return el.closest(".cx-rail") ? "rail" : el.className;
    });
    assert(top === "rail", `the open rail is under ${top}`);
    // No part of the second bar shows while the collapsed rail is open: every point of its box belongs to the rail.
    const leaks = await page.evaluate(() => {
      const sub = document.querySelector(".cx-sub").getBoundingClientRect();
      const bad = [];
      for (const x of [sub.left + 2, sub.left + sub.width / 2, sub.right - 2])
        for (let y = sub.top + 2; y < sub.bottom; y += 24) {
          const el = document.elementFromPoint(x, y);
          if (!el || !el.closest(".cx-rail")) bad.push(`${Math.round(x)},${Math.round(y)} ${el ? el.className : "none"}`);
        }
      const rail = document.querySelector(".cx-rail-inner").getBoundingClientRect();
      return { bad: bad.slice(0, 5), covers: rail.right >= sub.right - 0.5 };
    });
    assert(leaks.bad.length === 0, `the second bar shows through the open rail: ${leaks.bad.join("; ")}`);
    assert(leaks.covers, "the open rail does not reach the second bar's right edge");
    await page.mouse.move(900, 400);
    await page.waitForFunction(() => !document.querySelector(".cx-rail[data-wide]"));
  },

  async "the collapsed rail opens on hover and closes on mouse leave, Escape, link click and outside click; it can be pinned and unpinned"(page, vp) {
    if (isMobile(vp)) return;
    await signIn(page, "projects/prj_homehub/defects");
    await page.locator(".cx-sub").waitFor();
    const rail = page.locator(".cx-rail");
    const isWide = () => page.evaluate(() => !!document.querySelector(".cx-rail[data-wide]"));
    const open = () => page.waitForFunction(() => document.querySelector(".cx-rail[data-wide]"));
    const closed = () => page.waitForFunction(() => !document.querySelector(".cx-rail[data-wide]"));
    const elsewhere = async () => page.mouse.move(Math.min(vp.width - 40, 900), 400); // page content beyond the second column
    assert(!(await isWide()), "the rail starts open");
    // Opens on hover, as an overlay covering the second column.
    await rail.hover();
    await open();
    const cover = await page.evaluate(() => document.querySelector(".cx-rail-inner").getBoundingClientRect().right >= document.querySelector(".cx-sub").getBoundingClientRect().right - 0.5);
    assert(cover, "the open rail does not cover the second column");
    // Stays open while the pointer rests on the part over the second column (no flicker), then closes when it leaves.
    await page.mouse.move(200, 300);
    await page.waitForTimeout(300);
    assert(await isWide(), "the rail closed while the pointer was over it");
    await elsewhere();
    await closed();
    // Escape.
    await rail.hover();
    await open();
    await page.keyboard.press("Escape");
    await closed();
    await elsewhere();
    // Link click (pointer stays over the rail's link, then moves away: it must not stay open through focus).
    await rail.hover();
    await open();
    await rail.getByRole("link", { name: "Overview" }).click();
    await page.waitForURL(/\/overview/);
    await closed();
    await elsewhere();
    await page.waitForTimeout(200);
    assert(!(await isWide()), "the rail reopened after the link click");
    // Keyboard focus opens it; a click outside closes it (the pointer is not on the rail here).
    await page.keyboard.press("Tab");
    await page.evaluate(() => document.querySelector(".cx-rail-link").focus());
    await open();
    await page.mouse.click(Math.min(vp.width - 40, 900), 400);
    await closed();
    // Keyboard focus leaving the rail closes it.
    await page.keyboard.press("Tab");
    await page.evaluate(() => document.querySelector(".cx-rail-link").focus());
    await open();
    await page.evaluate(() => document.activeElement.blur());
    await closed();
    // Pin and unpin.
    await rail.hover();
    await open();
    await rail.getByRole("button", { name: "Keep this menu open" }).click();
    await elsewhere();
    await page.waitForTimeout(300);
    assert(await isWide(), "the pinned rail closed");
    assert((await rail.getAttribute("data-open")) !== null, "the pinned rail is not marked pinned");
    await rail.getByRole("button", { name: "Keep this menu open" }).click();
    await elsewhere();
    await closed();
    assert((await rail.getAttribute("data-open")) === null, "the rail is still pinned after unpinning");
  },

  async "connect a project always offers more repositories and another GitHub account"(page, vp) {
    if (isMobile(vp)) return;
    await signIn(page, "projects/connect");
    // An account already connected: GitHub's own page for it, where the repositories are chosen.
    const link = page.getByRole("link", { name: "Choose more repositories for northwind on GitHub" });
    await link.waitFor();
    assert((await link.getAttribute("href")) === "https://github.com/organizations/northwind/settings/installations/" + (await link.getAttribute("href")).split("/").pop(), "the link does not go to the organization's installation page");
    assert((await link.getAttribute("target")) === "_blank", "GitHub's page replaces the dashboard");
    await page.getByRole("button", { name: "Add another GitHub account" }).waitFor();
    await page.getByRole("button", { name: "Refresh repositories" }).click();
    await page.getByText("Setup pull request", { exact: false }).first().waitFor();
  },

  async "the page uses the width it is given, collapsed rail or wide screen"(page, vp) {
    if (isMobile(vp)) return;
    await signIn(page, "overview");
    for (const width of [1100, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await go(page, "overview");
      await settled(page);
      const m = await page.evaluate(() => {
        const c = document.querySelector(".cx-content").getBoundingClientRect();
        const main = document.querySelector("main").getBoundingClientRect();
        return { left: main.left - c.left, right: c.right - main.right, wide: c.width };
      });
      // Gutters are the same on both sides and at most 40 px, unless the screen is wider than the page's cap.
      assert(Math.abs(m.left - m.right) < 2, `${width}px: uneven gutters ${m.left} / ${m.right}`);
      if (width <= 1440) assert(m.left <= 41, `${width}px: ${m.left}px gutter around the content`);
    }
  },
};

// ONLY=fleet runs just the tests whose name holds that text.
const only = process.env.ONLY;

for (const [vpName, viewport] of VIEWPORTS) {
  for (const [name, fn] of Object.entries(TESTS)) {
    if (only && !name.includes(only)) continue;
    // The live run view asks every 400 ms here instead of 4 s, so the run finishes within the check.
    const { ctx, page, errors } = await newPage(browser, { viewport, pollMs: 400 });
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
      fail(`${label}: ${process.env.STACK ? e.stack : String(e.message).split("\n")[0]}`);
      await page.screenshot({ path: `/tmp/fail-${vpName}-${name.replace(/\W+/g, "-")}.png` }).catch(() => {});
    }
    await ctx.close();
  }
}

await browser.close();
console.log(state.failures ? `${state.failures} check(s) failed` : `checks: all ${state.passes} passed`);
process.exit(state.failures ? 1 : 0);
