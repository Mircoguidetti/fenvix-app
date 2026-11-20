// Review R-024c (docs/REVIEW-R-024c.md). Each test fails on claude/deploy-pipeline at fc5257d and passes once its
// finding is fixed. Nothing here talks to GitHub or AWS.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const tpl = JSON.parse(readFileSync(join(root, "infra/bootstrap/fenvix-bootstrap.json"), "utf8"));
const trust = tpl.Resources.DeployerRole.Properties.AssumeRolePolicyDocument.Statement[0];
/** A CloudFormation value with the template's parameter defaults substituted (what the founder deploys: defaults). */
const resolve = (v: unknown): string => {
  const s = typeof v === "string" ? v : (v as { "Fn::Sub": string })["Fn::Sub"];
  return s.replace(/\$\{(\w+)\}/g, (_, p: string) => tpl.Parameters[p]?.Default ?? `\${${p}}`);
};
const arr = <T>(x: T | T[]) => (Array.isArray(x) ? x : [x]);

// GitHub facts used below (MEASURED with the session's GitHub access, 2026-11-19):
//   repository Mircoguidetti/fenvix-app: id 1434576189, created 2026-10-26T15:32:56Z, private;
//   owner Mircoguidetti: id 17613795.
const OWNER_ID = "17613795";
const REPO_ID = "1434576189";

describe("review R-024c", () => {
  // K1. GitHub docs (actions/reference/security/oidc, "Immutable subject claims"): repositories created after
  // July 15, 2026 use the default subject repo:OWNER@OWNER-ID/REPO@REPO-ID:ref:refs/heads/BRANCH. This repository was
  // created on 2026-10-26, so the deploy job's token carries
  //   repo:Mircoguidetti@17613795/fenvix-app@1434576189:ref:refs/heads/main
  // and the trust's StringEquals on repo:Mircoguidetti/fenvix-app:ref:refs/heads/main never matches: "AWS credentials"
  // fails on every run (fail-safe, but nothing ever deploys).
  it("K1: the trust's sub is the immutable format this repository's tokens carry", () => {
    const subs = arr(trust.Condition.StringEquals["token.actions.githubusercontent.com:sub"]).map(resolve);
    assert.deepEqual(subs, [`repo:Mircoguidetti@${OWNER_ID}/fenvix-app@${REPO_ID}:ref:refs/heads/main`]);
  });

  // K5. AWS STS matches GitHub's job_workflow_ref claim directly (IAM User Guide, "AWS STS condition keys" → GitHub
  // tab: actor, actor_id, job_workflow_ref, repository, repository_id, repository_owner_id, workflow, ref, environment,
  // enterprise_id). No GitHub subject customization (REST only) is needed. Pinning job_workflow_ref to deploy.yml on
  // main narrows "any job of any workflow on main" to "a job of deploy.yml on main": a new workflow file
  // (issue_comment, workflow_run, schedule...) on main no longer gets the role, tripwire or not.
  it("K5: the trust pins job_workflow_ref to deploy.yml on main", () => {
    const v = arr(trust.Condition.StringEquals["token.actions.githubusercontent.com:job_workflow_ref"] ?? []).map(resolve);
    assert.deepEqual(v, ["Mircoguidetti/fenvix-app/.github/workflows/deploy.yml@refs/heads/main"]);
  });

  // K2-K4. The tripwire (test/workflows.test.ts) matches text with regular expressions. Each case below is a valid
  // workflow (js-yaml and the `yaml` package both parse it, except K4: see below) that does what the tripwire says it
  // forbids, and the tripwire still passes. The test copies the tripwire next to the mutated files and runs it.
  const deploy = readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8");
  const test = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");
  const realOn = "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n";
  const cases: Record<string, [string, string]> = {
    // K2a: a second job with the token in deploy.yml, its name quoted (no `if`, no `needs: test`).
    "K2a quoted job name in deploy.yml": [deploy + '\n  "cleanup":\n    runs-on: ubuntu-24.04\n    permissions:\n      id-token: write\n    steps:\n      - run: echo hi\n', test],
    // K2b: test.yml asks for the token with a quoted key.
    "K2b quoted \"id-token\" key in test.yml": [deploy, test.replace("permissions:\n  contents: read\n", 'permissions:\n  contents: read\n  "id-token": write\n')],
    // K2c: test.yml's job asks for write-all, quoted.
    "K2c quoted \"write-all\" in test.yml": [deploy, test.replace("    runs-on: ubuntu-24.04\n", '    runs-on: ubuntu-24.04\n    permissions: "write-all"\n')],
    // K3: test.yml asks for the token through a YAML alias (GitHub Actions accepts anchors and aliases).
    "K3 YAML alias in test.yml": [deploy, test.replace('env:\n  NODE_VERSION: "22"\n', 'env:\n  NODE_VERSION: "22"\n  W: &w write\n').replace("    runs-on: ubuntu-24.04\n", "    runs-on: ubuntu-24.04\n    permissions:\n      id-token: *w\n")],
    // K4: the tripwire reads the first line starting with `on:`. Here that line is inside a multi-line quoted `name`,
    // and the real triggers are under the quoted key "on", with workflow_run added (runs on main, with the role, after
    // the Tests of any pull request, including one from a fork). js-yaml and PyYAML accept this file; the strict `yaml`
    // package rejects it (continuation line at column 0). Whether GitHub's parser accepts it is UNKNOWN.
    "K4 fake on: inside a quoted name": [deploy.replace("name: Deploy\n\n" + realOn,
      'name: "Deploy\n' + realOn + '"\n\n"on":\n  push:\n    branches: [main]\n  workflow_dispatch:\n  workflow_run:\n    workflows: [Tests]\n    types: [completed]\n'), test],
  };
  for (const [name, [d, t]] of Object.entries(cases)) {
    it(`${name}: the tripwire fails`, () => {
      assert.notEqual(d + t, deploy + test, "the mutation applied");
      const dir = mkdtempSync(join(tmpdir(), "r024c-"));
      try {
        mkdirSync(join(dir, ".github/workflows"), { recursive: true });
        mkdirSync(join(dir, "infra/github-app/test"), { recursive: true });
        writeFileSync(join(dir, ".github/workflows/deploy.yml"), d);
        writeFileSync(join(dir, ".github/workflows/test.yml"), t);
        cpSync(join(root, "infra/github-app/test/workflows.test.ts"), join(dir, "infra/github-app/test/workflows.test.ts"));
        cpSync(join(root, ".github/dependabot.yml"), join(dir, ".github/dependabot.yml"));
        const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join(dir, "infra/github-app/test/workflows.test.ts")], { encoding: "utf8" });
        assert.notEqual(r.status, 0, `workflows.test.ts passed on a workflow that ${name}`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
