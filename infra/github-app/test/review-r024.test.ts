// Review R-024 (docs/REVIEW-R-024.md): the deploy role's reach. Each test fails on claude/deploy-pipeline at 7b1bb75.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

type Statement = { Sid?: string; Effect: string; Action?: string | string[]; Resource?: string | string[] };
const arr = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const policy = (f: string) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")) as { Statement: Statement[] };

describe("review R-024", () => {
  // F1. ssm:GetParameterHistory returns every version's Value, decrypted with WithDecryption=true (the default aws/ssm
  // key's policy lets any principal of the account decrypt through SSM: the pipeline's own GetParameter calls rely on
  // it). Granted on parameter/fenvix/prod/github-app/* and cache/*, it reads the webhook secret, the state signing
  // key, the runner token and the cache signing key: the "exactly five parameters" of the report are not the limit.
  it("F1: the deployer can read (decrypt) only the five parameters it names, by any SSM read action", () => {
    const five = new Set([
      "arn:aws:ssm:eu-west-1:865859654353:parameter/fenvix/prod/github-app/database-url",
      "arn:aws:ssm:eu-west-1:865859654353:parameter/fenvix/prod/github-app/api-database-url",
      "arn:aws:ssm:eu-west-1:865859654353:parameter/fenvix/prod/github-app/private-key",
      "arn:aws:ssm:eu-west-1:865859654353:parameter/fenvix/prod/github-app/client-secret",
      "arn:aws:ssm:eu-west-1:865859654353:parameter/fenvix/prod/cache/signing-public-key",
      // REPORT-deploy-pipeline-4 (founder decision: GitHub Free, no GitHub secrets): the founder's own values now live in
      // SSM under /fenvix/prod/bootstrap/, and the deployer reads exactly these seven by name (none generated, none
      // readable by the stacks' roles). Before, the same values were GitHub environment secrets/variables.
      ...["supabase-db-url", "supabase-anon-key", "supabase-ca-cert", "cloudflare-api-token", "github-app-id", "github-app-slug", "github-app-client-id"]
        .map((n) => `arn:aws:ssm:eu-west-1:865859654353:parameter/fenvix/prod/bootstrap/${n}`),
    ]);
    const reads = /^ssm:(GetParameter|GetParameters|GetParametersByPath|GetParameterHistory|Get\*|\*)$/;
    const bad: string[] = [];
    for (const st of policy("deploy-policy.json").Statement.filter((s) => s.Effect === "Allow")) {
      for (const a of arr(st.Action).filter((x) => reads.test(x))) {
        for (const r of arr(st.Resource).filter((x) => x.includes(":parameter/fenvix/"))) if (!five.has(r)) bad.push(`${st.Sid}: ${a} on ${r}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  // F2, as REPORT-deploy-pipeline-4 replaced it. The original assertion was "the trust is exactly
  // ...:environment:production, and every job with id-token: write names environment production". The founder chose
  // GitHub Free for a private repository, where environment secrets and deployment branch rules do not exist, so the
  // environment can no longer be what limits the role. The equivalent for the new design: the trust is exactly
  // ...:ref:refs/heads/main (one sub, no wildcard, no environment), and every job with id-token: write is one that runs
  // only on refs/heads/main (its `if`), in no environment. R-024's concern (a job without an environment on main getting
  // the role through workflow_run / issue_comment / schedule / another workflow) is held off by test/workflows.test.ts
  // (no other workflow may ask for id-token: write; deploy.yml's triggers are push to main and workflow_dispatch only).
  it("F2: the deploy role trusts the main branch only (the one sub the deploy job presents)", () => {
    const tpl = JSON.parse(readFileSync(new URL("../../bootstrap/fenvix-bootstrap.json", import.meta.url), "utf8"));
    const cond = tpl.Resources.DeployerRole.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals;
    const subs = arr(cond["token.actions.githubusercontent.com:sub"]).map((x: { "Fn::Sub": string }) => x["Fn::Sub"]);
    assert.deepEqual(subs, ["repo:${GitHubOwner}/${GitHubRepository}:ref:refs/heads/main"]);
    const workflow = readFileSync(new URL("../../../.github/workflows/deploy.yml", import.meta.url), "utf8");
    const jobs = workflow.split(/\n  (?=[a-z-]+:\n)/).slice(1);
    const withToken = jobs.filter((x) => /id-token:\s*write/.test(x));
    assert.equal(withToken.length, 1);
    for (const j of withToken) {
      assert.match(j, /\n    if: github\.ref == 'refs\/heads\/main'\n/);
      assert.doesNotMatch(j, /\n    environment:/);
    }
  });
});
