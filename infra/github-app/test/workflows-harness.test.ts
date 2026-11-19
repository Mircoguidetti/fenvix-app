// The tripwire (workflows.test.ts) run the way review R-024c runs it: copied beside mutated workflow files. This file
// proves the review's K2-K4 tests fail for the right reason (an assertion about the workflow, not a module that did not
// load), that the unmutated workflows pass, and adds bypass attempts of the same classes beyond the review's five.
// It also covers a defect of the review's harness: it spawns `node --test` from inside a test, which only works when the
// test file is not in a `node --test` child process (package.json runs the suite with --experimental-test-isolation=none).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const deploy = readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8");
const test = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");

const run = (d: string, t: string, extra: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-harness-"));
  try {
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    mkdirSync(join(dir, "infra/github-app/test"), { recursive: true });
    writeFileSync(join(dir, ".github/workflows/deploy.yml"), d);
    writeFileSync(join(dir, ".github/workflows/test.yml"), t);
    for (const [f, s] of Object.entries(extra)) writeFileSync(join(dir, ".github/workflows", f), s);
    cpSync(join(root, "infra/github-app/test/workflows.test.ts"), join(dir, "infra/github-app/test/workflows.test.ts"));
    // NODE_TEST_CONTEXT is set in a file that node --test runs in its own process; a `node --test` child that inherits it
    // skips every file and exits 0 ("run() is being called recursively"), which would make every case look green.
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join(dir, "infra/github-app/test/workflows.test.ts")], { encoding: "utf8", env });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
/** The tripwire loaded (its first check ran) and failed on a workflow assertion. */
const failsOnAssertion = (d: string, t: string, extra?: Record<string, string>) => {
  assert.notEqual(d + t + JSON.stringify(extra ?? {}), deploy + test + "{}", "the mutation applied");
  const r = run(d, t, extra);
  assert.notEqual(r.status, 0, "the tripwire passed");
  assert.doesNotMatch(r.out, /Cannot find (module|package)|yaml package is not installed/, "the tripwire did not load");
  assert.match(r.out, /\nnot ok \d+ - /, "a check failed");
  assert.match(r.out, /# Subtest: the workflows directory holds/, "the tripwire's checks ran");
};

const realOn = "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n";
const job = "    runs-on: ubuntu-24.04\n";

describe("the workflows tripwire under the review's harness", () => {
  it("control: the real workflows pass", () => {
    const r = run(deploy, test);
    assert.equal(r.status, 0, r.out);
  });

  const cases: Record<string, [string, string, Record<string, string>?]> = {
    // The review's five (review-r024c.test.ts), byte for byte.
    "K2a quoted job name": [deploy + '\n  "cleanup":\n    runs-on: ubuntu-24.04\n    permissions:\n      id-token: write\n    steps:\n      - run: echo hi\n', test],
    "K2b quoted id-token key": [deploy, test.replace("permissions:\n  contents: read\n", 'permissions:\n  contents: read\n  "id-token": write\n')],
    "K2c quoted write-all": [deploy, test.replace(job, job + '    permissions: "write-all"\n')],
    "K3 alias": [deploy, test.replace('env:\n  NODE_VERSION: "22"\n', 'env:\n  NODE_VERSION: "22"\n  W: &w write\n').replace(job, job + "    permissions:\n      id-token: *w\n")],
    "K4 fake on: in a quoted name": [deploy.replace("name: Deploy\n\n" + realOn,
      'name: "Deploy\n' + realOn + '"\n\n"on":\n  push:\n    branches: [main]\n  workflow_dispatch:\n  workflow_run:\n    workflows: [Tests]\n    types: [completed]\n'), test],
    // Beyond the review.
    "unquoted id-token in test.yml": [deploy, test.replace("permissions:\n  contents: read\n", "permissions:\n  contents: read\n  id-token: write\n")],
    "single-quoted id-token key": [deploy, test.replace("permissions:\n  contents: read\n", "permissions:\n  contents: read\n  'id-token': write\n")],
    "flow mapping permissions": [deploy, test.replace(job, job + '    permissions: {"id-token": write}\n')],
    "write-all in deploy.yml's test job": [deploy.replace("    uses: ./.github/workflows/test.yml\n    permissions:\n      contents: read\n", "    uses: ./.github/workflows/test.yml\n    permissions: write-all\n"), test],
    "quoted on key with workflow_run": [deploy.replace(realOn, '"on":\n  push:\n    branches: [main]\n  workflow_dispatch:\n  workflow_run:\n    workflows: [Tests]\n'), test],
    "single-quoted on key": [deploy.replace(realOn, "'on':\n  push:\n    branches: [main]\n  workflow_dispatch:\n"), test],
    "workflow_run added plainly": [deploy.replace(realOn, realOn + "  workflow_run:\n    workflows: [Tests]\n"), test],
    "push to every branch": [deploy.replace("    branches: [main]\n", "    branches: [main, '**']\n"), test],
    "duplicate on key": [deploy.replace("permissions:\n  contents: read\n", "permissions:\n  contents: read\non:\n  issue_comment:\n"), test],
    "second YAML document": [deploy + "---\non:\n  issue_comment:\n", test],
    "document end marker, then more": [deploy + "...\n\"on\":\n  issue_comment:\n", test],
    "merge key": [deploy, test.replace(job, job + "    <<: {permissions: write-all}\n")],
    "explicit tag": [deploy, test.replace(job, job + "    permissions: !!str write-all\n")],
    "deploy job if removed": [deploy.replace("    if: github.ref == 'refs/heads/main'\n", ""), test],
    "deploy job if widened": [deploy.replace("    if: github.ref == 'refs/heads/main'\n", "    if: github.ref == 'refs/heads/main' || true\n"), test],
    "deploy job in an environment": [deploy.replace("    if: github.ref == 'refs/heads/main'\n", "    if: github.ref == 'refs/heads/main'\n    environment: production\n"), test],
    "a GitHub secret read in test.yml": [deploy, test.replace('  NODE_VERSION: "22"\n', '  NODE_VERSION: "22"\n  X: ${{ secrets.X }}\n')],
    "a third workflow file": [deploy, test, { "other.yml": "name: x\non: push\njobs: {}\n" }],
    "an upper-case extension": [deploy, test, { "Other.YML": "name: x\non: push\njobs: {}\n" }],
    "workflow-level id-token in test.yml via write-all": [deploy, test.replace("permissions:\n  contents: read\n", "permissions: write-all\n")],
  };
  for (const [name, [d, t, extra]] of Object.entries(cases)) it(`${name}: the tripwire fails on an assertion`, () => failsOnAssertion(d, t, extra));
});
