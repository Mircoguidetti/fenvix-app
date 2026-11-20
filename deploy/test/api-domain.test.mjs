// The API's host is ONE setting: infra/github-app/cdk.json domainName (api.fenvix.dev since 2026-11-20, P-037). This
// file fails if the retired name github.fenvix.dev comes back anywhere outside history files, and if a place that names
// the API's URL disagrees with that setting.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const ROOT = new URL("../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");
const CDK = JSON.parse(read("infra/github-app/cdk.json")).context;
const API = CDK.domainName;
const RETIRED = "github.fenvix.dev";

/** Every tracked file (git ls-files), minus history: earlier session reports and reviews are kept as written. */
function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\0").filter(Boolean).filter((f) => !/^docs\/(REPORT|REVIEW)-[^/]+\.md$/.test(f));
}

/**
 * Where the retired name may still be written: the founder's one-time rename steps say which records to remove and
 * that it no longer answers (docs/DEPLOY-AWS.md section B2 and step 11 of section B; docs/DEPLOY-VERCEL.md's note),
 * and the tests of its removal.
 * The count is exact, so a new mention fails here and must be looked at.
 */
const ALLOWED = {
  "docs/DEPLOY-AWS.md": 5, "docs/DEPLOY-VERCEL.md": 1,
  // This file's own constant, and the test that the dns step removes the retired name's CNAME (units.test.mjs).
  "deploy/test/api-domain.test.mjs": 2, "deploy/test/units.test.mjs": 3, "deploy/test/api-certificate.test.mjs": 1,
};

describe("the API's host: one setting", () => {
  it("cdk.json domainName is api.fenvix.dev", () => {
    assert.equal(API, "api.fenvix.dev");
  });

  it(`no hard-coded ${RETIRED} outside history files (and the allowed founder notes)`, () => {
    const found = {};
    for (const f of trackedFiles()) {
      let text;
      try { text = read(f); } catch { continue; } // deleted in the working tree
      if (text.includes("\0")) continue; // binary
      // Plain, or with its dots escaped as in a regular expression (a backslash, or [.]).
      const n = (text.match(/github(?:\.|\\+\.|\[\.\])fenvix(?:\.|\\+\.|\[\.\])dev/g) ?? []).length;
      if (n) found[f] = n;
    }
    for (const [f, n] of Object.entries(found)) {
      assert.ok(f in ALLOWED, `${f} names ${RETIRED} ${n} time(s): the API is ${API} (infra/github-app/cdk.json domainName); derive it or write that name`);
      assert.equal(n, ALLOWED[f], `${f}: ${n} mentions of ${RETIRED}, expected ${ALLOWED[f]} (founder notes only)`);
      // Never as a URL anything would be configured with (webhook, callback, setup, the API, runner reports).
      assert.doesNotMatch(read(f), new RegExp(`https://${RETIRED.replace(/\./g, "\\.")}/(v1|webhooks|github/setup)`), f);
    }
  });

  it("the OpenAPI server, .env.example, README and the Vercel guide use https://<domainName>/v1", () => {
    const url = `https://${API}/v1`;
    assert.match(read("openapi/fenvix-api.yaml"), new RegExp(`servers:\\n  - url: ${url.replace(/[./]/g, "\\$&")}\\n`));
    assert.match(read(".env.example"), new RegExp(`^VITE_API_URL=${url.replace(/[./]/g, "\\$&")}$`, "m"));
    assert.ok(read("README.md").includes(`\`${url}\``));
    assert.ok(read("docs/DEPLOY-VERCEL.md").includes(`\`${url}\``));
  });

  it("the GitHub App's URLs in the founder's guide are on the API's host", () => {
    const guide = read("docs/DEPLOY-AWS.md");
    assert.ok(guide.includes(`| Callback URL | \`https://${API}/github/setup\` |`));
    assert.ok(guide.includes(`| Webhook URL | \`https://${API}/webhooks/github\` |`));
  });

  it("the deploy workflow names no API host: the deploy steps and the stack read domainName", () => {
    for (const f of [".github/workflows/deploy.yml", ".github/workflows/test.yml"]) {
      assert.doesNotMatch(read(f), /\b(api|github)\.fenvix\.dev/, f);
    }
    const cli = read("deploy/cli.mjs");
    assert.match(cli, /const API_DOMAIN = CDK\.domainName;/);
    assert.doesNotMatch(cli, /api\.fenvix\.dev/);
  });

  it("nothing else writes or expects a CNAME for the API's name: the deploy writes api.<zone> from the stack output only", () => {
    // Cloudflare writes happen in deploy/cli.mjs only (dashboard-certificate, api-certificate, dns), never in a workflow.
    for (const f of trackedFiles().filter((x) => x.startsWith(".github/") || x.startsWith("scripts/"))) {
      assert.doesNotMatch(read(f), /api\.cloudflare\.com|dns_records/, f);
    }
  });
});
