// Where on GitHub an installation's repositories are chosen (src/lib/github.ts): the link the Connect page offers.
import test from "node:test";
import assert from "node:assert/strict";
import { installationConfigureUrl } from "../../src/lib/github.ts";

test("a personal account configures its installation in its own settings", () => {
  assert.equal(installationConfigureUrl({ installationId: 1234, account: "octocat", accountType: "User" }), "https://github.com/settings/installations/1234");
});

test("an organization configures it in the organization's settings", () => {
  assert.equal(installationConfigureUrl({ installationId: 99, account: "acme-co", accountType: "Organization" }), "https://github.com/organizations/acme-co/settings/installations/99");
});

test("an account name is escaped in the address", () => {
  assert.equal(installationConfigureUrl({ installationId: 5, account: "a b", accountType: "Organization" }), "https://github.com/organizations/a%20b/settings/installations/5");
});
