/*
 * buildSideBySideWorkflow (spec 20261126-side-by-side-runs, AC 1): 19 fixtures. Each built file is parsed back and
 * checked against the structure it must have; each refusal names why. Every test states its card:
 * protects=...; fails_when=...; no_claim=...
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { analyzeWorkflow, buildSideBySideWorkflow, chooseTestJob, SIDE_BY_SIDE_PATH, type SideBySideFile } from "../../src/onboarding/workflow.ts";

type Json = Record<string, any>;
const GATE = { id: "fenvix_gate", shell: "bash", "working-directory": "/tmp", "continue-on-error": true, run: 'if [ -f /etc/fenvix/sbs-skip ]; then echo run=false >> "$GITHUB_OUTPUT"; else echo run=true >> "$GITHUB_OUTPUT"; fi' };
const GATE_IF = "steps.fenvix_gate.outputs.run == 'true'";
const FORK = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";

function build(src: string, job = "test"): { out: SideBySideFile; wf: Json; j: Json } {
  const copy = `${src}`;
  const r = buildSideBySideWorkflow(src, job, "fenvix");
  assert.equal(src, copy, "the customer's text is not changed");
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  const wf = parse(r.text) as Json;
  // The parts every side-by-side file has, whatever the source.
  assert.equal(wf.name, "fenvix side-by-side");
  assert.deepEqual(wf.permissions, { contents: "read" });
  assert.deepEqual(wf.concurrency, { group: "fenvix-side-by-side-${{ github.ref }}", "cancel-in-progress": true });
  assert.deepEqual(Object.keys(wf.jobs), ["fenvix-side-by-side"]);
  const j = wf.jobs["fenvix-side-by-side"] as Json;
  assert.equal(j.name, "fenvix side-by-side (does not gate)");
  assert.equal(j["runs-on"], "fenvix");
  assert.equal(j["continue-on-error"], true);
  assert.deepEqual(j.steps[0], GATE);
  for (const s of j.steps.slice(1)) {
    assert.equal(s["continue-on-error"], true, "every kept step continues on error");
    assert.ok(String(s.if).endsWith(GATE_IF), "every kept step is behind the gate");
  }
  for (const k of ["needs", "concurrency", "outputs", "permissions"]) assert.equal(k in j, false, `job ${k} is not kept`);
  return { out: r, wf, j };
}

function refused(src: string, re: RegExp, job = "test"): void {
  const r = buildSideBySideWorkflow(src, job, "fenvix");
  assert.ok("refused" in r, "refused");
  assert.match(r.refused, re);
}

const PLAIN = `name: CI
on:
  push:
    branches: [main]
  pull_request:
env:
  NODE_ENV: test
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npx eslint .
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    env:
      CI: "true"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm test
`;

describe("buildSideBySideWorkflow: the copy of the test job", () => {
  // protects=a plain Node job copied whole (steps up to the test step, his env, timeout, triggers with their filters);
  // fails_when=a step, a trigger filter, env or timeout is lost or changed, or the gate/fork guard is missing;
  // no_claim=that GitHub runs the file (AC 12, live).
  it("plain: triggers and filters, top-level and job env, timeout, the steps behind the gate, the fork guard", () => {
    const { wf, j, out } = build(PLAIN);
    assert.deepEqual(wf.on, { push: { branches: ["main"] }, pull_request: null });
    assert.deepEqual(wf.env, { NODE_ENV: "test" });
    assert.equal(j["timeout-minutes"], 25);
    assert.deepEqual(j.env, { CI: "true" });
    assert.equal(j.if, FORK);
    assert.deepEqual(j.steps.slice(1).map((s: Json) => s.uses ?? s.run), ["actions/checkout@v4", "actions/setup-node@v4", "npm ci", "npm test"]);
    assert.deepEqual(j.steps[2].with, { "node-version": 20, "package-manager-cache": false });
    assert.equal("strategy" in j, false);
    assert.deepEqual({ name: out.jobName, suffix: out.matrixSuffix, step: out.testStepName, matrix: out.matrix }, { name: "test", suffix: null, step: "Run npm test", matrix: null });
  });

  // protects=his job's name (resolved with the matrix values) and his test step's name are what the pairing reads;
  // fails_when=the name or the step name is not the one GitHub shows; no_claim=GitHub's naming of every job.
  it("named job: his name resolved with the matrix values (no suffix then), our job name fixed, the timeout default 60", () => {
    const src = `on: push
jobs:
  test:
    name: Tests on node \${{ matrix.node }}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - uses: actions/checkout@v4
      - name: Unit tests
        run: npx vitest run
`;
    const { j, out } = build(src);
    assert.equal(j.name, "fenvix side-by-side (does not gate)");
    assert.equal(j["timeout-minutes"], 60);
    assert.deepEqual({ name: out.jobName, suffix: out.matrixSuffix, step: out.testStepName }, { name: "Tests on node 18", suffix: null, step: "Unit tests" });
  });

  // protects=our job's timeout is his, at most 60 minutes (the full machine powers off 10 minutes after that), and
  // the stored timeoutMinutes is what the machine gets; fails_when=a 120-minute job is copied as 120 (GitHub would see
  // the machine vanish), an expression is copied as is, or timeoutMinutes differs from the file; no_claim=-.
  it("timeout: his, at most 60; an expression or a missing one gives 60", () => {
    const at = (t: string) => build(`on: push
jobs:
  test:
    runs-on: ubuntu-latest
${t}    steps:
      - run: npm test
`);
    const long = at("    timeout-minutes: 120\n");
    assert.deepEqual([long.j["timeout-minutes"], long.out.timeoutMinutes], [60, 60]);
    const short = at("    timeout-minutes: 25\n");
    assert.deepEqual([short.j["timeout-minutes"], short.out.timeoutMinutes], [25, 25]);
    const expr = at("    timeout-minutes: ${{ fromJSON(vars.T) }}\n");
    assert.deepEqual([expr.j["timeout-minutes"], expr.out.timeoutMinutes], [60, 60]);
    const none = at("");
    assert.deepEqual([none.j["timeout-minutes"], none.out.timeoutMinutes], [60, 60]);
  });

  // protects=the one matrix combination GitHub runs first, after exclude and include; fails_when=another combination,
  // or include/exclude applied wrong; no_claim=matrices given by expressions (refused, below).
  it("matrix with include and exclude: the first effective combination only, as include of one", () => {
    const src = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest]
        node: [18, 20, 22]
        exclude:
          - node: 18
        include:
          - node: 20
            coverage: true
          - node: 24
            experimental: true
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
    const { j, out } = build(src);
    assert.deepEqual(j.strategy, { matrix: { include: [{ os: "ubuntu-latest", node: 20, coverage: true }] } });
    assert.equal(out.matrixSuffix, " (ubuntu-latest, 20, true)");
    assert.equal(out.matrix, JSON.stringify({ os: "ubuntu-latest", node: 20, coverage: true }));
  });

  // protects=his top-level concurrency (cancel-in-progress) is not copied, so ours never cancels his runs and his never
  // cancel ours; fails_when=his concurrency group appears in our file; no_claim=GitHub's concurrency behaviour.
  it("top-level concurrency with cancel-in-progress: not copied; ours is present", () => {
    const src = `on: [push]
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-latest
    concurrency: job-level
    steps:
      - run: pytest -q
`;
    const { wf, j } = build(src);
    assert.deepEqual(wf.concurrency, { group: "fenvix-side-by-side-${{ github.ref }}", "cancel-in-progress": true });
    assert.equal("concurrency" in j, false);
  });

  // protects=only push, pull_request and workflow_dispatch trigger ours; fails_when=schedule or pull_request_target is
  // kept (ours would run on events his test job does not compare with); no_claim=his other workflows.
  it("on: with schedule and pull_request_target besides push: only push is kept", () => {
    const src = `on:
  schedule:
    - cron: "0 3 * * *"
  pull_request_target:
    types: [opened]
  push:
    branches: [main, "release/**"]
    paths-ignore: ["docs/**"]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: go test ./...
`;
    const { wf } = build(src);
    assert.deepEqual(wf.on, { push: { branches: ["main", "release/**"], "paths-ignore": ["docs/**"] } });
  });

  // protects=a step that runs on failure (always()) keeps its status function inside the parentheses, behind the gate;
  // fails_when=the condition is dropped or the gate can be bypassed; no_claim=GitHub's evaluation of the expression.
  it("step if: ${{ always() }}: kept inside the parentheses, gate added", () => {
    const src = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    if: \${{ github.actor != 'dependabot[bot]' }}
    steps:
      - uses: actions/checkout@v4
      - name: Tests
        if: \${{ always() }}
        run: npm test
`;
    const { j } = build(src);
    assert.equal(j.steps[2].if, `(always()) && ${GATE_IF}`);
    assert.equal(j.steps[1].if, GATE_IF);
    assert.equal(j.if, `(github.actor != 'dependabot[bot]') && (${FORK})`);
  });

  // protects=nothing after the test step is copied (uploads, coverage services, deploys); fails_when=a step after the
  // test step is in our file; no_claim=steps before it (each checked by the allow-list).
  it("upload-artifact and codecov after the test step: dropped", () => {
    const src = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m pytest
      - uses: actions/upload-artifact@v4
        with: { name: report, path: report.xml }
      - uses: codecov/codecov-action@v4
        with:
          token: \${{ secrets.CODECOV_TOKEN }}
`;
    const { j } = build(src);
    assert.deepEqual(j.steps.slice(1).map((s: Json) => s.uses ?? s.run), ["actions/checkout@v4", "python -m pytest"]);
  });

  // protects=ours restores his Actions cache but never saves into it; fails_when=actions/cache (which saves in its post
  // step) is kept; no_claim=the post step's behaviour on GitHub (AC 12 checks it live).
  it("actions/cache@v4 becomes actions/cache/restore@v4, inputs kept", () => {
    const src = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/cache@v4
        with:
          path: ~/.npm
          key: npm-\${{ hashFiles('package-lock.json') }}
      - run: npm test
`;
    const { j } = build(src);
    assert.equal(j.steps[2].uses, "actions/cache/restore@v4");
    assert.deepEqual(j.steps[2].with, { path: "~/.npm", key: "npm-${{ hashFiles('package-lock.json') }}" });
  });

  // protects=a cache action without a restore-only form is refused rather than saving into his cache;
  // fails_when=actions/cache@v2 is accepted; no_claim=-.
  it("actions/cache@v2: refused", () => {
    refused(`on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v2
        with: { path: x, key: y }
      - run: npm test
`, /actions\/cache below v3/);
  });

  // protects=setup-node never saves the package manager's cache (its input removed, package-manager-cache: false);
  // fails_when=cache: npm stays, or the switch is missing; no_claim=setup-node's defaults on GitHub (AC 12).
  it("setup-node with cache: npm: the input removed, package-manager-cache: false", () => {
    const src = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: app/package-lock.json
      - run: npm test
`;
    const { j } = build(src);
    assert.deepEqual(j.steps[1].with, { "node-version": 22, "package-manager-cache": false });
  });

  // protects=setup-go, whose cache is on by default, gets cache: false; fails_when=no cache input is added;
  // no_claim=setup-go's defaults on GitHub.
  it("setup-go with no cache input: cache: false", () => {
    const src = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-go@v5
      - run: go test ./...
`;
    const { j } = build(src);
    assert.deepEqual(j.steps[1].with, { cache: false });
  });

  // protects=the list form of on: becomes the map form with both events; fails_when=an event is lost;
  // no_claim=other list members (dropped like any other event).
  it("on: [push, pull_request]: normalised to the map form", () => {
    const { wf } = build(`on: [push, pull_request, release]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`);
    assert.deepEqual(wf.on, { push: null, pull_request: null });
  });
});

describe("buildSideBySideWorkflow: refusals (no pull request; the detail says why)", () => {
  // protects=a copied checkout never leaves a credential on our machine (persist-credentials: false, whatever he set)
  // and never takes a token: input; fails_when=persist-credentials is missing or true, or a token is copied;
  // no_claim=what actions/checkout does with it.
  it("checkout: persist-credentials false; a token: input refused", () => {
    const src = (w: string) => `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${w}      - run: npm test
`;
    const { j } = build(src("        with:\n          persist-credentials: true\n          fetch-depth: 0\n"));
    const co = (j.steps as Json[]).find((s) => String(s.uses).startsWith("actions/checkout"))!;
    assert.deepEqual(co.with, { "fetch-depth": 0, "persist-credentials": false });
    const bare = build(src("")).j;
    assert.deepEqual((bare.steps as Json[]).find((s) => String(s.uses).startsWith("actions/checkout"))!.with, { "persist-credentials": false });
    refused(src("        with:\n          token: ${{ secrets.PAT }}\n"), /passes a token: to actions\/checkout/);
  });

  // protects=with: keys are matched in any case, as GitHub reads them (Token:, Persist-Credentials:); fails_when=a
  // mixed-case token is copied, or a mixed-case persist-credentials: true survives beside ours; no_claim=-.
  it("checkout: with: keys in any case (Token:, Persist-Credentials:)", () => {
    const src = (w: string) => `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
${w}      - run: npm test
`;
    refused(src("          Token: ${{ secrets.PAT }}\n"), /passes a token: to actions\/checkout/);
    refused(src("          TOKEN: ${{ secrets.PAT }}\n"), /passes a token: to actions\/checkout/);
    const { j } = build(src("          Persist-Credentials: true\n          Fetch-Depth: 0\n"));
    const co = (j.steps as Json[]).find((s) => String(s.uses).startsWith("actions/checkout"))!;
    assert.deepEqual(co.with, { "Fetch-Depth": 0, "persist-credentials": false });
  });

  // protects=an ssh-key: input on checkout is refused (a deploy key would stay on our machine); fails_when=an ssh-key
  // is copied, in any case; no_claim=-.
  it("checkout: an ssh-key: input refused", () => {
    for (const k of ["ssh-key", "SSH-Key"]) {
      refused(`on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ${k}: \${{ secrets.DEPLOY_KEY }}
      - run: npm test
`, /passes an ssh-key: to actions\/checkout/);
    }
  });

  // protects=jobs with service containers are refused (fenvix machines have no Docker, so the job would fail at
  // "Initialize containers" and use a full machine); fails_when=services: is copied; no_claim=-.
  it("services: refused", () => {
    refused(`on: push
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
    steps:
      - run: npm test
`, /jobs with service containers are not supported yet/);
  });

  // protects=a kept step that writes to GitHub refuses the whole file; fails_when=git push before the test step is
  // copied; no_claim=a token passed to a script through env (accepted risk, the PR body says so).
  it("a run: git push step before the test step: refused", () => {
    refused(`on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: git push origin HEAD:refs/heads/bump
      - run: npm test
`, /may write to GitHub/);
  });

  // protects=jobs with a deployment environment (its secrets, its approvals) are never copied; fails_when=accepted.
  // no_claim=-.
  it("environment: refused", () => {
    refused(`on: push
jobs:
  test:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - run: npm test
`, /environment/);
  });

  // protects=a Windows (or macOS) test job is not run on a Linux machine; fails_when=accepted; no_claim=-.
  it("Windows: refused", () => {
    refused(`on: push
jobs:
  test:
    runs-on: windows-latest
    steps:
      - run: npm test
`, /windows-latest; fenvix machines are Linux/);
  });

  // protects=container: jobs are refused (the gate's skip file would not be visible inside the container);
  // fails_when=accepted; no_claim=-.
  it("container: refused", () => {
    refused(`on: push
jobs:
  test:
    runs-on: ubuntu-latest
    container: node:20
    steps:
      - run: npm test
`, /container/);
  });

  // protects=a matrix given by an expression (unknown before the run) is refused; fails_when=accepted; no_claim=-.
  it("a fromJSON matrix: refused", () => {
    refused(`on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix: \${{ fromJSON(needs.setup.outputs.matrix) }}
    steps:
      - run: npm test
`, /matrix is given by an expression/);
  });

  // protects=only allow-listed actions run before the test step; fails_when=an unknown action is copied; no_claim=-.
  it("an unknown action before the test step: refused", () => {
    refused(`on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: some-org/setup-database@v1
      - run: npm test
`, /uses some-org\/setup-database@v1, which fenvix does not run side by side/);
  });

  // protects=needs is not kept, so a kept step or condition that reads needs. would break; fails_when=accepted;
  // no_claim=-.
  it("a needs. reference: refused", () => {
    refused(`on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo
  test:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - run: echo \${{ needs.build.outputs.version }}
      - run: npm test
`, /needs\./);
  });
});

describe("buildSideBySideWorkflow: conditions GitHub would read as text", () => {
  // protects=an if: mixing text and ${{ }} (a string to GitHub, always true) is refused, since the fork guard and the
  // gate would vanish; fails_when=it is copied; no_claim=-.
  it("a job or step if: that mixes text and ${{ }}: refused", () => {
    refused(`on: push
jobs:
  test:
    runs-on: ubuntu-latest
    if: \${{ github.event_name == 'push' }} && \${{ github.ref == 'refs/heads/main' }}
    steps:
      - run: npm test
`, /job's if: mixes text/);
    refused(`on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - if: success() && \${{ env.X == '1' }}
        run: npm test
`, /has an if: that mixes text/);
  });

  // protects=an if: that closes more parentheses than it opens could put || outside our gate; it is refused;
  // fails_when=it is copied; no_claim=-.
  it("an if: whose parentheses do not balance: refused", () => {
    refused(`on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - if: always()) || (true
        run: npm test
`, /parentheses do not balance/);
    const ok = buildSideBySideWorkflow(`on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - if: contains(github.ref, ')')
        run: npm test
`, "test", "fenvix");
    assert.ok(!("refused" in ok), "a parenthesis inside a string literal is fine");
  });
});

describe("our own file is never read as one of the customer's workflows", () => {
  // protects=detection skips .github/workflows/fenvix-side-by-side.yml (it runs tests and is on fenvix); fails_when=our
  // file's job is chosen as the test job, or seen as already on fenvix; no_claim=-.
  it("analyzeWorkflow skips it; chooseTestJob picks his job", () => {
    const ours = build(PLAIN).out.text;
    const choice = chooseTestJob([analyzeWorkflow({ path: SIDE_BY_SIDE_PATH, text: ours }, "fenvix"), analyzeWorkflow({ path: ".github/workflows/ci.yml", text: PLAIN }, "fenvix")]);
    assert.equal(choice.kind, "change");
    assert.equal(choice.kind === "change" && `${choice.job.file}:${choice.job.jobId}`, ".github/workflows/ci.yml:test");
  });
});

describe("the side-by-side pull request's body", () => {
  // protects=the body states the real daily cap (it is what the customer reads about doubled API costs); fails_when=the
  // text shows a placeholder or another number; no_claim=GitHub's rendering.
  it("states the daily cap it is given", async () => {
    const { sideBySidePullRequestBody } = await import("../../src/onboarding/onboard.ts");
    const body = sideBySidePullRequestBody({ job: { jobId: "test", file: ".github/workflows/ci.yml" } as never, file: "x", dashboardUrl: "https://app.fenvix.dev", dailyCap: 7 });
    assert.match(body, /at most 7 a day per repository/);
    assert.doesNotMatch(body, /\$\{/);
  });
});
