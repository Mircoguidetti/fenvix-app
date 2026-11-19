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

  // F2. The deploy job runs in the environment "production", so its token's sub is ...:environment:production and the
  // ...:ref:refs/heads/main entry is never used by it. That entry is what a job WITHOUT an environment gets when it runs
  // on main: any job without an environment in a workflow run by push to main, schedule, workflow_dispatch on main,
  // issue_comment or workflow_run (both run on the default branch; workflow_run is the classic way untrusted fork code
  // reaches a privileged run), none of which the environment's branch rule or reviewers can stop.
  it("F2: the deploy role trusts the production environment only (the one sub the deploy job presents)", () => {
    const tpl = JSON.parse(readFileSync(new URL("../../bootstrap/fenvix-bootstrap.json", import.meta.url), "utf8"));
    const cond = tpl.Resources.DeployerRole.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals;
    const subs = arr(cond["token.actions.githubusercontent.com:sub"]).map((x: { "Fn::Sub": string }) => x["Fn::Sub"]);
    assert.deepEqual(subs, ["repo:${GitHubOwner}/${GitHubRepository}:environment:production"]);
    const workflow = readFileSync(new URL("../../../.github/workflows/deploy.yml", import.meta.url), "utf8");
    // Every job that may request the token is in the environment.
    const jobs = workflow.split(/\n  (?=[a-z-]+:\n)/).slice(1);
    for (const j of jobs.filter((x) => /id-token:\s*write/.test(x))) assert.match(j, /environment:\n\s+name: production/);
  });
});
