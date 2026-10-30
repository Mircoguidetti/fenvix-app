// Organizations in the dashboard, on desktop and on a phone, against the mock backend: the name screen of a new
// account, an existing account that goes straight in, switching organization, a member's read-only screens and the
// mock server refusing their changes, invite → accept, and hostile names shown as text.
// Usage: npm run check (builds, serves and runs everything), or with a preview server on :4173: node scripts/orgs-checks.mjs
import { BASE, VIEWPORTS, go, isMobile, launch, makeReporter, newPage, settled, signIn, choose } from "./lib.mjs";

const { fail, pass, state } = makeReporter();
const browser = await launch();
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function toast(page, text) {
  const t = page.locator(".toast", { hasText: text }).first();
  await t.waitFor();
  await t.getByRole("button", { name: "Dismiss message" }).click();
}

/** Opens the organization switcher (in the drawer on a phone). */
async function openSwitcher(page, vp) {
  if (isMobile(vp)) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator(".drawer .account-btn").click();
    return page.locator(".drawer .org-panel");
  }
  await page.locator(".sidebar .account-btn").click();
  return page.locator(".sidebar .org-panel");
}

async function signOut(page, vp) {
  if (isMobile(vp)) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator(".drawer .user-btn").click();
  } else {
    await page.locator(".sidebar .user-btn").click();
  }
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in to FENVIX" }).waitFor();
}

/** Signs in through the email link of the mock, as a given address. */
async function signInByEmail(page, email) {
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByText(`We sent a sign-in link to ${email}`).waitFor();
  await go(page, "?token=one-time");
}

/** Nothing on the page may overlap or be cut: every text box fits its parent horizontally. */
async function noClippedText(page, selector) {
  const bad = await page.evaluate((sel) => {
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > window.innerWidth + 0.5 || r.left < -0.5) out.push(`${el.className || el.tagName}: off screen`);
    }
    return out;
  }, selector);
  assert(bad.length === 0, bad.join("; "));
}

const HOSTILE = "<script>window.__xssOrg=1</script><img src=x onerror=window.__xssOrg=2>";

const TESTS = {
  async "a new account names its organization first; hostile names stay text"(page, vp) {
    let alerted = false;
    page.on("dialog", (d) => ((alerted = true), d.dismiss()));
    await go(page, "databases");
    await signInByEmail(page, "nadia.okafor@lumen.example");
    await page.getByRole("heading", { name: "Name your organization" }).waitFor();
    assert(!(await page.locator(".shell").count()), "the dashboard is visible before the organization is named");
    const field = page.getByLabel("Organization name");
    // Blank, one character and only spaces are refused with a message that says what to do.
    for (const v of ["", "a", "     "]) {
      await field.fill(v);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("alert").getByText("Use 2 to 64 characters").waitFor();
    }
    await field.fill("x".repeat(5000));
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("alert").getByText("Use 2 to 64 characters").waitFor();
    await field.fill(HOSTILE.slice(0, 64));
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator(".shell").waitFor();
    await settled(page);
    assert(new URL(page.url()).pathname === "/overview", `after naming it lands on ${page.url()}`);
    const shown = await page.locator(".workspace-name").first().textContent();
    assert(shown === HOSTILE.slice(0, 64), `the sidebar shows ${shown}`);
    await page.getByRole("heading", { name: HOSTILE.slice(0, 64) }).waitFor();
    assert((await page.locator(".workspace script, .workspace img, main h1 script, main h1 img").count()) === 0, "markup in the name became an element");
    await page.waitForTimeout(200);
    assert(!alerted && (await page.evaluate(() => window.__xssOrg)) === undefined, "code from the organization name ran");
    // A reload does not ask again: the name is confirmed.
    await page.reload();
    await page.locator(".shell").waitFor();
    assert(!(await page.getByRole("heading", { name: "Name your organization" }).count()), "the name screen came back");
  },

  async "an existing account goes straight to the dashboard"(page) {
    await signIn(page, "overview");
    await page.getByRole("heading", { name: "Northwind Cloud" }).waitFor();
    assert(!(await page.getByRole("heading", { name: "Name your organization" }).count()), "an existing account saw the name screen");
    assert(!(await page.locator(".readonly-note").count()), "the owner is told they are view-only");
  },

  async "switching organization; a member sees read-only screens and the server refuses"(page, vp) {
    await signIn(page, "overview");
    let panel = await openSwitcher(page, vp);
    const names = await panel.locator(".org-item-name").allTextContents();
    assert(names.join("|") === "Northwind Cloud|Harbor Analytics", `the switcher lists ${names.join(", ")}`);
    await noClippedText(page, ".org-panel, .org-item");
    await panel.getByRole("button", { name: /Harbor Analytics/ }).click();
    await toast(page, "Switched to Harbor Analytics");
    await page.getByRole("heading", { name: "Harbor Analytics" }).waitFor();
    await page.locator(".readonly-note").getByText("view-only access").waitFor();
    assert((await page.locator(".workspace-sub").first().textContent()) === "Member", "the role under the name is not Member");

    // Databases: no create, no selection, no bulk actions.
    await go(page, "databases");
    await settled(page);
    await page.locator("table.dbs tbody tr").first().waitFor();
    assert(!(await page.getByRole("link", { name: "Create database" }).count()), "a member is offered Create database");
    assert(!(await page.locator("table.dbs input[type=checkbox]").count()), "a member can select databases");
    // One database: no actions, tags read only, users and documents read only.
    await go(page, "databases/db_0001");
    await page.getByRole("heading", { name: "orders-prod" }).waitFor();
    for (const name of ["Fork", "Erase", "Export", "Restore to a point in time", "Add tag"]) {
      assert(!(await page.getByRole("button", { name, exact: true }).count()), `a member is offered ${name}`);
    }
    assert(!(await page.getByLabel("Keep awake").count()), "a member can switch keep awake");
    await page.locator("#actions").getByText("view-only access").waitFor();
    await go(page, "databases/db_0001?tab=users");
    await page.locator("#users td .user-name").first().waitFor();
    assert(!(await page.getByRole("button", { name: "Create user" }).count()), "a member can add database users");
    // Network: the list read only, no blocked addresses.
    await go(page, "databases/db_0001?tab=network");
    await page.locator("#allowlist .net-entry").first().waitFor();
    for (const name of ["Add", "Save list", "Import", "Clear list", "Apply again"]) {
      assert(!(await page.getByRole("button", { name, exact: true }).count()), `a member is offered ${name} in Network`);
    }
    assert(!(await page.getByRole("button", { name: /^(Remove|Unblock) / }).count()), "a member can remove entries or unblock");
    await page.locator("#allowlist .readonly-note").getByText("Only an owner or admin can change the IP allowlist.").waitFor();
    await page.locator("#blocks .readonly-note").getByText("Only an owner or admin can see and unblock blocked addresses.").waitFor();
    assert(!(await page.getByRole("list", { name: "Blocked addresses" }).count()), "a member sees blocked addresses");
    assert(!(await page.getByRole("button", { name: /^Reset password of/ }).count()), "a member can reset passwords");
    await go(page, "databases/new");
    await page.getByText("Only an owner or admin of this organization can create databases").waitFor();
    await go(page, "api-keys");
    await page.getByText("Only an owner or admin of this organization can see and manage API keys").waitFor();
    await go(page, "settings");
    await page.locator("#organization").getByText("Harbor Analytics").waitFor();
    assert(!(await page.getByRole("button", { name: "Rename" }).count()), "a member can rename the organization");
    assert(await page.getByLabel("Email me about usage and account notices").isDisabled(), "a member can change settings");
    assert(!(await page.getByText("Sleep after idle").count()), "settings still offer Sleep after idle");
    await go(page, "settings/members");
    await page.locator("#members").getByText("Jonas Weber").waitFor();
    assert(!(await page.getByRole("button", { name: "Invite" }).count()), "a member can invite");
    assert(!(await page.locator("#members .select").count()), "a member can change roles");
    assert(!(await page.getByRole("button", { name: /^Remove / }).count()), "a member can remove people");

    // The screens hide it, and the server refuses it anyway (the mock server, called directly).
    const refused = await page.evaluate(async () => {
      const api = window.__fenvixMock;
      const out = [];
      for (const call of [
        () => api.createDatabase({ name: "member-made-01", region: "eu-west", tags: [] }),
        () => api.eraseDatabases(["db_0001"]),
        () => api.forkDatabase("db_0001", "member-fork-01"),
        () => api.setKeepAwake(["db_0001"], true),
        () => api.createPublicApiKey({ name: "member key", role: "read_only", expiresAt: null }),
        () => api.saveSettings({ workspaceName: "x", idleMinutes: 1, emailNotices: false }),
      ]) {
        try {
          await call();
          out.push("allowed");
        } catch (e) {
          out.push(String(e.message));
        }
      }
      return out;
    });
    assert(refused.every((m) => m.startsWith("Your role in this organization is read only")), `the server allowed: ${refused.join(" | ")}`);

    // Back to the owner's organization: everything is offered again.
    panel = await openSwitcher(page, vp);
    await panel.getByRole("button", { name: /Northwind Cloud/ }).click();
    await page.getByRole("heading", { name: "Northwind Cloud" }).waitFor();
    assert(!(await page.locator(".readonly-note").count()), "the read-only note stayed");
    await go(page, "databases");
    await page.getByRole("link", { name: "Create database" }).waitFor();
  },

  async "invite, copy the link, accept as the invited person; the link works once"(page, vp) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await signIn(page, "settings/members");
    await page.locator("#members").getByText("Priya Natarajan").waitFor();
    await noClippedText(page, "#members td, #members th");
    await page.getByLabel("Email", { exact: true }).fill("not-an-email");
    await page.getByRole("button", { name: "Invite" }).click();
    await page.getByRole("alert").getByText("Enter a valid email address").waitFor();
    await page.getByLabel("Email", { exact: true }).fill("Sam.Rivera@northwind.cloud");
    await choose(page, page.getByLabel("Role", { exact: true }), "member");
    await page.getByRole("button", { name: "Invite" }).click();
    const dialog = page.getByRole("dialog", { name: "Invitation link" });
    await dialog.waitFor();
    const link = await dialog.getByLabel("Link", { exact: true }).inputValue();
    assert(/\/invite#token=[A-Za-z0-9_-]{43}$/.test(link), `the link is ${link}`);
    await dialog.getByRole("button", { name: "Copy link invitation link" }).click();
    await dialog.getByRole("button", { name: "Copy link invitation link" }).filter({ hasText: "Copied" }).waitFor();
    assert((await page.evaluate(() => navigator.clipboard.readText())) === link, "the clipboard does not hold the link");
    await dialog.getByRole("button", { name: "Done" }).click();
    await page.locator("#pending").getByText("sam.rivera@northwind.cloud").waitFor();
    assert(!(await page.locator("#pending").innerText()).includes(link.split("#token=")[1]), "the pending list shows the token");
    // A second invitation to the same address is refused with a clear message.
    await page.getByLabel("Email", { exact: true }).fill("sam.rivera@northwind.cloud");
    await page.getByRole("button", { name: "Invite" }).click();
    await page.getByRole("alert").getByText("already a pending invitation").waitFor();

    // The invited person opens the link while signed out, signs in, and accepts.
    await signOut(page, vp);
    await page.goto(link);
    await page.getByRole("heading", { name: "Sign in to FENVIX" }).waitFor();
    assert(!page.url().includes("token="), `the token stayed in the address bar: ${page.url()}`);
    await signInByEmail(page, "sam.rivera@northwind.cloud");
    await page.getByRole("heading", { name: "Join an organization" }).waitFor();
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await page.locator(".shell").waitFor();
    await toast(page, "You joined Northwind Cloud");
    await page.getByRole("heading", { name: "Northwind Cloud" }).waitFor();
    assert(!(await page.getByRole("heading", { name: "Name your organization" }).count()), "an invited person saw the name screen");
    assert((await page.locator(".workspace-sub").first().textContent()) === "Member", "the invited role is not Member");
    await page.locator(".readonly-note").waitFor();

    // The same link again: refused, with a message that does not say why.
    await page.goto(link);
    await page.getByRole("heading", { name: "Join an organization" }).waitFor();
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await page.getByRole("alert").getByText("This invitation link is not valid").waitFor();
    await page.getByRole("button", { name: "Go to the dashboard" }).click();
    await page.locator(".shell").waitFor();
  },

  async "an invitation for another email, and a revoked one, are refused the same way"(page, vp) {
    await signIn(page, "settings/members");
    const make = async (email) => {
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByRole("button", { name: "Invite" }).click();
      const dialog = page.getByRole("dialog", { name: "Invitation link" });
      const link = await dialog.getByLabel("Link", { exact: true }).inputValue();
      await dialog.getByRole("button", { name: "Done" }).click();
      return link;
    };
    const other = await make("someone.else@harbor-analytics.io");
    const revoked = await make("sam.rivera@northwind.cloud");
    await page.getByRole("button", { name: "Revoke the invitation for sam.rivera@northwind.cloud" }).click();
    await page.getByRole("dialog", { name: "Revoke this invitation?" }).getByRole("button", { name: "Revoke invitation" }).click();
    await toast(page, "Revoked the invitation for sam.rivera@northwind.cloud");
    await page.locator("#pending").getByText("sam.rivera@northwind.cloud").waitFor({ state: "detached" });

    await signOut(page, vp);
    const messages = [];
    for (const link of [other, revoked, `${BASE}invite#token=${"A".repeat(43)}`]) {
      await page.goto(link);
      await page.getByRole("heading", { name: /Sign in to FENVIX|Join an organization/ }).waitFor();
      if (await page.getByRole("heading", { name: "Sign in to FENVIX" }).count()) await signInByEmail(page, "sam.rivera@northwind.cloud");
      await page.getByRole("heading", { name: "Join an organization" }).waitFor();
      await page.getByRole("button", { name: "Accept invitation" }).click();
      messages.push(await page.getByRole("alert").innerText());
    }
    assert(new Set(messages).size === 1, `the refusals differ: ${messages.join(" | ")}`);
  },
};

const only = process.env.ONLY;
for (const [vpName, viewport] of VIEWPORTS) {
  for (const [name, fn] of Object.entries(TESTS)) {
    if (only && !name.includes(only)) continue;
    const { ctx, page, errors } = await newPage(browser, { viewport });
    page.setDefaultTimeout(20000);
    const label = `orgs: ${name} (${vpName})`;
    try {
      await fn(page, viewport);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      if (overflow) throw new Error("the page scrolls horizontally");
      if (errors.length) throw new Error(`console: ${errors[0]}`);
      pass(label);
      console.log("ok  ", label);
    } catch (e) {
      fail(`${label}: ${String(e.message).split("\n")[0]}`);
      await page.screenshot({ path: `/tmp/fail-orgs-${vpName}-${name.replace(/\W+/g, "-").slice(0, 60)}.png`, fullPage: true }).catch(() => {});
    }
    await ctx.close();
  }
}

await browser.close();
console.log(state.failures ? `${state.failures} organization check(s) failed` : `organization checks: all ${state.passes} passed`);
process.exit(state.failures ? 1 : 0);
