import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDocument } from "yaml";
import { analyzeWorkflow, chooseTestJob, setRunsOn, unifiedDiff } from "../../src/onboarding/workflow.ts";

const CI = `# CI for the library
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ruff check .

  test:
    name: Tests (Python)
    runs-on: ubuntu-latest   # the 2-core hosted runner
    strategy:
      matrix:
        python: ["3.11", "3.12"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: \${{ matrix.python }}
      - run: pip install -e . pytest
      # run the suite
      - run: python -m pytest -q

  build:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - run: python -m build
`;

describe("finding the test job", () => {
  it("picks the job that runs pytest, not lint or build", () => {
    const a = analyzeWorkflow({ path: ".github/workflows/ci.yml", text: CI }, "fenvix");
    const c = chooseTestJob([a]);
    assert.equal(c.kind, "change");
    if (c.kind !== "change") return;
    assert.equal(c.job.jobId, "test");
    assert.equal(c.job.language, "python");
    assert.equal(c.job.testRunner, "pytest");
    assert.deepEqual(c.others, []);
  });

  it("does not count `pip install pytest` as running the tests", () => {
    const text = `jobs:\n  setup:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pip install pytest\n`;
    const c = chooseTestJob([analyzeWorkflow({ path: "w.yml", text }, "fenvix")]);
    assert.equal(c.kind, "no_test_job");
  });

  it("knows vitest, jest, node --test, mocha, go test and npm test", () => {
    const cases: [string, string, string | null][] = [
      ["npx vitest run", "node", "vitest"],
      ["yarn jest --ci", "node", "jest"],
      ["go test ./...", "go", "go test"],
      ["npm test", "node", null],
      ["pnpm run test", "node", null],
      ["uv run pytest", "python", "pytest"],
      ["npx jest", "node", "jest"],
      ["npx vitest", "node", "vitest"],
      ["node --test", "node", "node:test"],
      ["node --experimental-strip-types --test test/", "node", "node:test"],
      ["node --test-reporter=spec --test", "node", "node:test"],
      ["npx mocha", "node", "mocha"],
      ["mocha 'test/**/*.spec.js'", "node", "mocha"],
    ];
    for (const [cmd, lang, runner] of cases) {
      const text = `jobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${cmd}\n`;
      const j = analyzeWorkflow({ path: "w.yml", text }, "fenvix").jobs[0]!;
      assert.equal(j.isTestJob, true, cmd);
      assert.equal(j.language, lang, cmd);
      assert.equal(j.testRunner, runner, cmd);
    }
  });

  it("prefers the stronger test job across files and lists the others", () => {
    const a = `jobs:\n  unit:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make test\n`;
    const b = `jobs:\n  tests:\n    runs-on: ubuntu-22.04\n    steps:\n      - run: pytest\n`;
    const c = chooseTestJob([analyzeWorkflow({ path: "a.yml", text: a }, "fenvix"), analyzeWorkflow({ path: "b.yml", text: b }, "fenvix")]);
    assert.equal(c.kind, "change");
    if (c.kind !== "change") return;
    assert.equal(c.job.file, "b.yml");
    assert.deepEqual(c.others.map((j) => j.jobId), ["unit"]);
  });

  it("says when the job already runs on fenvix", () => {
    const text = `jobs:\n  test:\n    runs-on: fenvix\n    steps:\n      - run: pytest\n`;
    assert.equal(chooseTestJob([analyzeWorkflow({ path: "w.yml", text }, "fenvix")]).kind, "already_fenvix");
    const text2 = `jobs:\n  test:\n    runs-on: [self-hosted, fenvix]\n    steps:\n      - run: pytest\n`;
    assert.equal(chooseTestJob([analyzeWorkflow({ path: "w.yml", text: text2 }, "fenvix")]).kind, "already_fenvix");
  });

  it("refuses macOS, Windows, free expressions and reusable workflows", () => {
    for (const ro of ["macos-14", "windows-latest", "${{ inputs.runner }}"]) {
      const text = `jobs:\n  test:\n    runs-on: ${ro}\n    steps:\n      - run: pytest\n`;
      const c = chooseTestJob([analyzeWorkflow({ path: "w.yml", text }, "fenvix")]);
      assert.equal(c.kind, "unsupported", ro);
    }
    const reusable = `jobs:\n  test:\n    uses: org/repo/.github/workflows/test.yml@main\n`;
    const c = chooseTestJob([analyzeWorkflow({ path: "w.yml", text: reusable }, "fenvix")]);
    // No run steps: not recognised as a test job at all.
    assert.ok(c.kind === "no_test_job" || c.kind === "unsupported");
  });

  it("accepts a matrix over Linux machines only", () => {
    const linux = `jobs:\n  test:\n    runs-on: \${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, ubuntu-22.04]\n    steps:\n      - run: pytest\n`;
    const c = chooseTestJob([analyzeWorkflow({ path: "w.yml", text: linux }, "fenvix")]);
    assert.equal(c.kind, "change");
    const mixed = linux.replace("ubuntu-22.04", "windows-latest");
    assert.equal(chooseTestJob([analyzeWorkflow({ path: "w.yml", text: mixed }, "fenvix")]).kind, "unsupported");
  });

  it("reports a file that is not YAML instead of failing", () => {
    const a = analyzeWorkflow({ path: "bad.yml", text: "jobs: [\n" }, "fenvix");
    assert.match(a.error ?? "", /not valid YAML/);
  });
});

describe("changing runs-on", () => {
  it("changes only that value and keeps every comment", () => {
    const out = setRunsOn(CI, "test", "fenvix");
    assert.equal(out, CI.replace("runs-on: ubuntu-latest   # the 2-core", "runs-on: fenvix   # the 2-core"));
    // lint and build still run where they did.
    const js = parseDocument(out).toJS() as { jobs: Record<string, { "runs-on": string }> };
    assert.equal(js.jobs.lint!["runs-on"], "ubuntu-latest");
    assert.equal(js.jobs.build!["runs-on"], "ubuntu-latest");
    assert.equal(js.jobs.test!["runs-on"], "fenvix");
    for (const comment of ["# CI for the library", "# the 2-core hosted runner", "# run the suite"]) assert.ok(out.includes(comment));
  });

  it("handles quoted values, flow lists, block lists and runner groups", () => {
    const head = "jobs:\n  test:\n";
    const tail = "    steps:\n      - run: pytest # go\n";
    const cases: [string, string][] = [
      [`    runs-on: "ubuntu-latest" # q\n`, `    runs-on: fenvix # q\n`],
      [`    runs-on: [self-hosted, linux]\n`, `    runs-on: fenvix\n`],
      [`    runs-on:\n      - self-hosted\n      - linux # x64\n    # keep me\n`, `    runs-on: fenvix\n    # keep me\n`],
      [`    runs-on:\n      group: big-runners\n      labels: [linux]\n`, `    runs-on: fenvix\n`],
      [`    runs-on: { group: big }\n`, `    runs-on: fenvix\n`],
    ];
    for (const [before, after] of cases) {
      assert.equal(setRunsOn(head + before + tail, "test", "fenvix"), head + after + tail, before);
    }
  });

  it("keeps CRLF line endings around the change", () => {
    const text = "jobs:\r\n  test:\r\n    runs-on: ubuntu-latest\r\n    steps:\r\n      - run: pytest\r\n";
    assert.equal(setRunsOn(text, "test", "fenvix"), text.replace("ubuntu-latest", "fenvix"));
  });

  it("does not touch another job with the same runs-on line", () => {
    const text = "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{run: echo}]\n  test:\n    runs-on: ubuntu-latest\n    steps: [{run: pytest}]\n";
    const out = setRunsOn(text, "test", "fenvix");
    assert.equal(out, "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{run: echo}]\n  test:\n    runs-on: fenvix\n    steps: [{run: pytest}]\n");
  });
});

describe("unified diff", () => {
  it("shows the one changed line with three lines of context, git style", () => {
    const out = setRunsOn(CI, "test", "fenvix");
    const d = unifiedDiff(".github/workflows/ci.yml", CI, out);
    const lines = d.split("\n");
    assert.equal(lines[0], "--- a/.github/workflows/ci.yml");
    assert.equal(lines[1], "+++ b/.github/workflows/ci.yml");
    const changedLine = CI.split("\n").findIndex((l) => l.includes("runs-on: ubuntu-latest   #")) + 1;
    assert.equal(lines[2], `@@ -${changedLine - 3},7 +${changedLine - 3},7 @@`);
    assert.equal(lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length, 1);
    assert.equal(lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length, 1);
    assert.ok(lines.includes("-    runs-on: ubuntu-latest   # the 2-core hosted runner"));
    assert.ok(lines.includes("+    runs-on: fenvix   # the 2-core hosted runner"));
  });

  it("counts lines right when a block list collapses to one line", () => {
    const before = "jobs:\n  test:\n    runs-on:\n      - self-hosted\n      - linux\n    steps: [{run: pytest}]\n";
    const after = setRunsOn(before, "test", "fenvix");
    const d = unifiedDiff("w.yml", before, after);
    assert.match(d, /@@ -1,6 \+1,4 @@/);
  });

  it("is empty when nothing changed", () => {
    assert.equal(unifiedDiff("w.yml", "a\n", "a\n"), "");
  });
});
