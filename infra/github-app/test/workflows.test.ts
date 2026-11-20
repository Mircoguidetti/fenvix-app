// REPORT-deploy-pipeline-5: "only main can deploy" is enforced by AWS. The deploy role trusts the OIDC token of a job
// of .github/workflows/deploy.yml running on refs/heads/main of this repository (sub in GitHub's immutable format, plus
// repository_id and job_workflow_ref), with no GitHub environment in between (GitHub Free, private repository). This
// test limits, in the repository, what may ask GitHub for that token (R-024 F2's concern):
//   - no workflow but deploy.yml has `id-token: write` (at workflow or job level, or a `write-all` / other string);
//   - deploy.yml is triggered by push to main and workflow_dispatch only, and has exactly the jobs test and deploy;
//   - its deploy job is the only one with the token and runs only when github.ref is refs/heads/main;
//   - no workflow reads a GitHub secret or names an environment (none exist for this design).
// Review R-024c K2-K4: the workflows are PARSED (the `yaml` package, YAML 1.2, strict, unique keys), never matched as
// text, so quoted keys and values are seen for what they are. Anything a lenient parser could read differently is
// refused outright: anchors, aliases, merge keys, explicit tags, more than one document, multi-line quoted strings, and
// any line other than the top-level key that looks like an `on:` key (the K4 class, even for a parser more lenient
// than this one).
// This is a tripwire, not a gate: it fails the tests of the pull request (and the deploy) that adds such a workflow; it
// cannot stop a workflow pushed straight to main from running once. AWS's job_workflow_ref condition is what keeps such
// a workflow from getting the role (docs/REPORT-deploy-pipeline-5.md, residual risk).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Document } from "yaml";

/** The `yaml` package, from this package's node_modules (or, when this file is copied elsewhere by a review harness,
 * from the package in the current directory). Never a hand-written parser. */
const YAML = ((): typeof import("yaml") => {
  const from = [import.meta.url, join(process.cwd(), "package.json"), join(process.cwd(), "infra/github-app/package.json")];
  for (const f of from) { try { return createRequire(f)("yaml"); } catch { /* next */ } }
  throw new Error("the yaml package is not installed (npm ci in infra/github-app)");
})();

const dir = new URL("../../../.github/workflows/", import.meta.url);
const files = readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f));
const raw = (f: string) => readFileSync(new URL(f, dir), "utf8");

type Json = null | string | number | boolean | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

/** Parse a workflow strictly; fail on anything a different YAML parser could read differently. */
const parse = (f: string): Obj => {
  const src = raw(f);
  const docs = YAML.parseAllDocuments(src, { version: "1.2", uniqueKeys: true, strict: true, merge: false, prettyErrors: true });
  assert.ok(!("empty" in docs), `${f}: no document`);
  assert.equal((docs as unknown[]).length, 1, `${f}: exactly one YAML document`);
  const doc = (docs as Document.Parsed[])[0]!;
  assert.deepEqual(doc.errors.map((e) => e.message), [], `${f}: YAML errors`);
  assert.deepEqual(doc.warnings.map((e) => e.message), [], `${f}: YAML warnings`);
  const bad: string[] = [];
  YAML.visit(doc, {
    Alias: () => { bad.push("an alias"); },
    Node: (_k, n) => {
      if ("anchor" in n && n.anchor) bad.push(`an anchor &${n.anchor}`);
      if ("tag" in n && n.tag) bad.push(`an explicit tag ${n.tag}`);
      if (YAML.isScalar(n) && (n.type === "QUOTE_DOUBLE" || n.type === "QUOTE_SINGLE") && n.range && src.slice(n.range[0], n.range[1]).includes("\n")) {
        bad.push(`a multi-line quoted string at offset ${n.range[0]}`);
      }
    },
    Pair: (_k, p) => {
      if (YAML.isScalar(p.key) && p.key.value === "<<") bad.push("a merge key <<");
      if (p.key !== null && !YAML.isScalar(p.key)) bad.push("a non-scalar key");
    },
  });
  assert.deepEqual(bad, [], `${f}: YAML features that are refused here`);
  // The K4 class, independent of any parser: the only line that looks like an `on` key is the top-level `on:`.
  const onLines = src.split("\n").filter((l) => /^\s*["']?on["']?\s*:/.test(l));
  assert.deepEqual(onLines, ["on:"], `${f}: one top-level "on:" line and no other line that looks like an on key`);
  const v = doc.toJS({ maxAliasCount: 0 }) as unknown;
  assert.ok(isObj(v), `${f}: a mapping`);
  return v;
};

/** Does a `permissions` value grant the OIDC token? Any string but read-all does (write-all, or anything unexpected). */
const grantsToken = (p: Json | undefined): boolean => {
  if (p === undefined || p === null) return false;
  if (typeof p === "string") return p !== "read-all";
  if (!isObj(p)) return true;
  return Object.keys(p).some((k) => /id[-_]?token/i.test(k));
};
const jobsOf = (w: Obj): Record<string, Obj> => {
  assert.ok(isObj(w.jobs), "jobs is a mapping");
  for (const [n, j] of Object.entries(w.jobs)) assert.ok(isObj(j), `job ${n} is a mapping`);
  return w.jobs as Record<string, Obj>;
};
/** Every string anywhere in a value (keys included). */
const strings = (x: Json, out: string[] = []): string[] => {
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) x.forEach((y) => strings(y, out));
  else if (isObj(x)) for (const [k, y] of Object.entries(x)) { out.push(k); strings(y, out); }
  return out;
};

describe("workflows: who may ask GitHub for the AWS deploy token", () => {
  it("the workflows directory holds deploy.yml and test.yml (a new file must be added to this test on purpose)", () => {
    assert.deepEqual(files.sort(), ["deploy.yml", "test.yml"]);
  });

  it("every workflow parses as one strict YAML 1.2 document with no alias, anchor, tag, merge key or multi-line quote", () => {
    for (const f of files) parse(f);
  });

  it("no workflow other than deploy.yml asks for the OIDC token, at workflow or job level", () => {
    for (const f of files.filter((x) => x !== "deploy.yml")) {
      const w = parse(f);
      assert.ok(!grantsToken(w.permissions), `${f}: workflow-level permissions grant id-token`);
      for (const [n, j] of Object.entries(jobsOf(w))) assert.ok(!grantsToken(j.permissions), `${f}: job ${n} asks for id-token`);
    }
  });

  it("deploy.yml: triggers are push to main and workflow_dispatch only", () => {
    const w = parse("deploy.yml");
    // The one input: a roll back to an earlier commit of main (G-1706); a string, never anything a job interpolates in a script.
    assert.deepEqual(w.on, { push: { branches: ["main"] }, workflow_dispatch: { inputs: { rollback_to: { description: "Roll back: the full commit SHA of an earlier commit of main to deploy (empty: main as it is)", required: false, default: "", type: "string" } } } });
    assert.deepEqual(w.permissions, { contents: "read" });
  });

  it("deploy.yml: jobs test and deploy only; only deploy has id-token: write; it runs on refs/heads/main only", () => {
    const w = parse("deploy.yml");
    const jobs = jobsOf(w);
    assert.deepEqual(Object.keys(jobs).sort(), ["deploy", "test"], "a new job must be added to this test on purpose");
    assert.deepEqual(Object.entries(jobs).filter(([, j]) => grantsToken(j.permissions)).map(([n]) => n), ["deploy"]);
    assert.deepEqual(jobs.deploy!.permissions, { contents: "read", "id-token": "write" });
    assert.equal(jobs.deploy!.if, "github.ref == 'refs/heads/main'");
    assert.equal(jobs.deploy!.needs, "test");
    assert.equal(jobs.deploy!.uses, undefined, "the deploy job is written in deploy.yml (job_workflow_ref), not a reusable workflow");
    assert.equal(jobs.test!.uses, "./.github/workflows/test.yml");
    assert.deepEqual(jobs.test!.permissions, { contents: "read" });
    // Roll back (G-1706): the SHA reaches the script only through env, is checked to be a full SHA and an ancestor of
    // main's commit; the migrations are skipped then.
    const steps = jobs.deploy!.steps as Obj[];
    const rb = steps.find((s) => String(s.name).startsWith("0. Roll back"))!;
    assert.deepEqual([rb.if, (rb.env as Obj).ROLLBACK_TO], ["inputs.rollback_to != ''", "${{ inputs.rollback_to }}"]);
    assert.doesNotMatch(String(rb.run), /\$\{\{/, "no expression inside the script");
    assert.match(String(rb.run), /\^\[0-9a-f\]\{40\}\$/);
    assert.match(String(rb.run), /git merge-base --is-ancestor "\$ROLLBACK_TO" "\$GITHUB_SHA"/);
    assert.equal(steps.find((s) => String(s.name).startsWith("2. Database migrations"))!.if, "inputs.rollback_to == ''");
    for (const s of steps) if (s !== rb && typeof s.run === "string") assert.doesNotMatch(s.run, /inputs\./, `${String(s.name)}: no input in a script`);
    for (const s of (jobs.deploy!.steps as Obj[])) {
      if (typeof s.uses === "string" && !s.uses.startsWith("./")) assert.match(s.uses, /@[0-9a-f]{40}$/, `step ${s.uses} pinned to a commit`);
    }
  });

  it("no workflow reads a GitHub secret or names an environment (the founder's values are in SSM)", () => {
    for (const f of files) {
      const w = parse(f);
      for (const s of strings(w)) assert.doesNotMatch(s, /\$\{\{[^}]*\bsecrets\b/, `${f} reads a GitHub secret`);
      for (const [n, j] of Object.entries(jobsOf(w))) {
        assert.ok(!("environment" in j), `${f}: job ${n} names an environment`);
        assert.ok(!("secrets" in j), `${f}: job ${n} passes secrets on`);
      }
    }
  });

  it("test.yml: pull requests and the deploy's call only; read-only token; its jobs call no other workflow", () => {
    const w = parse("test.yml");
    assert.deepEqual(w.on, { pull_request: null, workflow_call: null });
    assert.deepEqual(w.permissions, { contents: "read" });
    for (const [n, j] of Object.entries(jobsOf(w))) assert.equal(j.uses, undefined, `test.yml: job ${n} calls a workflow`);
  });

  it("dependencies (G-2287, G-2328): CI audits all four lock files, build tools included; Dependabot proposes updates for them and the actions", () => {
    const steps = (jobsOf(parse("test.yml")).test?.steps ?? Object.values(jobsOf(parse("test.yml")))[0]!.steps) as Obj[];
    const audit = String(steps.find((x) => String(x.name).startsWith("Dependency audit"))!.run);
    assert.match(audit, /for d in \. github-app deploy infra\/github-app; do/);
    assert.match(audit, /npm audit --audit-level=high/);
    assert.doesNotMatch(audit, /--omit=dev/, "the build and deploy tools are audited too");
    const dep = YAML.parse(readFileSync(new URL("../dependabot.yml", dir), "utf8")) as { updates: { "package-ecosystem": string; directories?: string[] }[] };
    assert.deepEqual(dep.updates.find((u) => u["package-ecosystem"] === "npm")!.directories, ["/", "/github-app", "/deploy", "/infra/github-app"]);
    assert.ok(dep.updates.some((u) => u["package-ecosystem"] === "github-actions"));
  });
});
