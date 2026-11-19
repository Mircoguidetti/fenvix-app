// REPORT-deploy-pipeline-4: "only main can deploy" is enforced by AWS alone. The deploy role trusts the OIDC token of
// any job that runs on refs/heads/main of this repository (sub = repo:...:ref:refs/heads/main), with no GitHub
// environment in between (GitHub Free, private repository). So what may ask GitHub for that token is limited here,
// in the repository: R-024 F2's concern (a workflow_run / issue_comment / schedule job on main getting the role).
//   - no workflow but deploy.yml has `id-token: write` (at workflow or job level, or `write-all`);
//   - deploy.yml is triggered by push to main and workflow_dispatch only;
//   - its one job with the token runs only when github.ref is refs/heads/main;
//   - no workflow reads a GitHub secret or names an environment (none exist for this design).
// This is a tripwire, not a gate: it fails the tests of the pull request (and the deploy) that adds such a workflow; it
// cannot stop a workflow pushed straight to main from running once (docs/REPORT-deploy-pipeline-4.md, residual risk).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const dir = new URL("../../../.github/workflows/", import.meta.url);
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
/** A workflow's text without its YAML comments (a comment may name what the code must not do). */
const read = (f: string) => readFileSync(new URL(f, dir), "utf8").replace(/(^|[ \t])#[^\n]*/gm, "$1");
/** The text of the top-level key `on:` (until the next top-level key). */
const onBlock = (text: string) => { const m = /^on:[^\n]*\n((?:[ #][^\n]*\n|\n)*)/m.exec(text); return m ? m[1]! : ""; };
/** Top-level jobs: name → text. */
const jobs = (text: string) => {
  const body = text.slice(text.search(/^jobs:\s*$/m));
  return Object.fromEntries(body.split(/\n(?=  [A-Za-z0-9_-]+:\s*\n)/).slice(1).map((j) => [/^  ([A-Za-z0-9_-]+):/.exec(j)![1]!, j]));
};

describe("workflows: who may ask GitHub for the AWS deploy token", () => {
  it("the workflows directory holds deploy.yml and test.yml (a new file must be added to this test on purpose)", () => {
    assert.deepEqual(files.sort(), ["deploy.yml", "test.yml"]);
  });

  it("no workflow other than deploy.yml asks for id-token: write (or write-all)", () => {
    for (const f of files.filter((x) => x !== "deploy.yml")) {
      const t = read(f);
      assert.doesNotMatch(t, /id-token\s*:\s*write/, `${f} asks for the OIDC token`);
      assert.doesNotMatch(t, /permissions\s*:\s*write-all/, `${f}: write-all includes id-token`);
    }
  });

  it("deploy.yml: triggers are push to main and workflow_dispatch only", () => {
    const t = read("deploy.yml");
    const on = onBlock(t).split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
    assert.deepEqual(on.map((l) => l.trimEnd()), ["  push:", "    branches: [main]", "  workflow_dispatch:"]);
    for (const bad of ["pull_request_target", "workflow_run", "issue_comment", "pull_request", "schedule", "workflow_call", "repository_dispatch", "release", "deployment"]) {
      assert.ok(!new RegExp(`^\\s+${bad}:`, "m").test(onBlock(t)), `deploy.yml must not be triggered by ${bad}`);
    }
    assert.doesNotMatch(t, /permissions\s*:\s*write-all/);
  });

  it("deploy.yml: only the deploy job has id-token: write; it runs on refs/heads/main only, in no environment", () => {
    const t = read("deploy.yml");
    const top = t.slice(0, t.search(/^jobs:\s*$/m));
    assert.doesNotMatch(top, /id-token/, "not at workflow level: every job would get it");
    const all = jobs(t);
    const withToken = Object.entries(all).filter(([, j]) => /id-token\s*:\s*write/.test(j)).map(([n]) => n);
    assert.deepEqual(withToken, ["deploy"]);
    assert.match(all.deploy!, /\n    if: github\.ref == 'refs\/heads\/main'\n/);
    assert.match(all.deploy!, /\n    needs: test\n/);
    assert.match(all.test!, /\n    uses: \.\/\.github\/workflows\/test\.yml\n/);
  });

  it("no workflow reads a GitHub secret or names an environment (the founder's values are in SSM)", () => {
    for (const f of files) {
      const t = read(f);
      assert.doesNotMatch(t, /\$\{\{\s*secrets\./, `${f} reads a GitHub secret`);
      assert.doesNotMatch(t, /^\s+environment\s*:/m, `${f} names an environment`);
      assert.doesNotMatch(t, /secrets\s*:\s*inherit/, `${f} passes secrets on`);
    }
  });

  it("test.yml: pull requests and the deploy's call only; read-only token", () => {
    const t = read("test.yml");
    const on = onBlock(t).split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).map((l) => l.trimEnd());
    assert.deepEqual(on, ["  pull_request:", "  workflow_call:"]);
    assert.match(t, /^permissions:\n  contents: read\n/m);
  });
});
