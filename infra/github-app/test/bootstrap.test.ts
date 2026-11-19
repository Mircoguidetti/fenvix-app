// The one-click CloudFormation template (infra/bootstrap/fenvix-bootstrap.json): it holds the policy files as they
// are, its roles are the ones the CDK synthesizer and the workflow use, and its deploy role trusts nothing but this
// repository's main branch (no GitHub environment: REPORT-deploy-pipeline-4).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { synth } from "./helpers.ts";

type Tpl = { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>; Parameters: Record<string, { Default?: string }>; Rules: unknown };
const file = new URL("../../bootstrap/fenvix-bootstrap.json", import.meta.url);
const tpl = JSON.parse(readFileSync(file, "utf8")) as Tpl;
const json = (x: unknown) => JSON.stringify(x);
const mod: string = "../../bootstrap/build.mjs";

describe("the one-click AWS template", () => {
  it("is the one infra/bootstrap/build.mjs makes from the policy files (no drift)", async () => {
    const { rendered } = (await import(mod)) as { rendered: () => string };
    assert.equal(readFileSync(file, "utf8"), rendered(), "run: node infra/bootstrap/build.mjs");
  });

  it("embeds the permissions boundary, the four CloudFormation policies and the deployer policy unchanged", () => {
    const byName = (n: string) => Object.values(tpl.Resources).find((r) => r.Type === "AWS::IAM::ManagedPolicy" && r.Properties.ManagedPolicyName === n)!;
    const pol = (f: string) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
    assert.deepEqual(byName("fenvix-prod-github-app-boundary").Properties.PolicyDocument, pol("permissions-boundary.json"));
    for (const x of ["app", "edge", "fleet", "dashboard"]) assert.deepEqual(byName(`fenvix-github-app-cfn-exec-${x}`).Properties.PolicyDocument, pol(`cfn-exec-policy-${x}.json`));
    assert.deepEqual(byName("fenvix-github-deployer").Properties.PolicyDocument, pol("deploy-policy.json"));
  });

  it("the deploy role: GitHub OIDC only, audience sts, this repository's main branch only", () => {
    const role = tpl.Resources.DeployerRole!.Properties;
    assert.equal(role.RoleName, "fenvix-github-deployer");
    const st = (role.AssumeRolePolicyDocument as { Statement: { Action: string; Principal: unknown; Condition: Record<string, Record<string, unknown>> }[] }).Statement;
    assert.equal(st.length, 1);
    assert.equal(st[0]!.Action, "sts:AssumeRoleWithWebIdentity");
    assert.match(json(st[0]!.Principal), /oidc-provider\/token\.actions\.githubusercontent\.com/);
    assert.deepEqual(Object.keys(st[0]!.Condition), ["StringEquals"], "exact matches only: no StringLike wildcard");
    assert.equal(st[0]!.Condition.StringEquals!["token.actions.githubusercontent.com:aud"], "sts.amazonaws.com");
    const key = (k: string) => (st[0]!.Condition.StringEquals![`token.actions.githubusercontent.com:${k}`] as { "Fn::Sub": string }[]).map((x) => x["Fn::Sub"]);
    // REPORT-deploy-pipeline-5: main only, enforced by AWS (no environment exists on GitHub Free for a private
    // repository), in GitHub's immutable subject format (owner and repository ids: review R-024c K1), for this
    // repository's id, and for a job of deploy.yml only (job_workflow_ref: review R-024c K5).
    assert.deepEqual(Object.keys(st[0]!.Condition.StringEquals!).sort(), ["aud", "job_workflow_ref", "repository_id", "sub"].map((k) => `token.actions.githubusercontent.com:${k}`));
    assert.deepEqual(key("sub"), ["repo:${GitHubOwner}@${GitHubOwnerId}/${GitHubRepository}@${GitHubRepositoryId}:ref:refs/heads/main"]);
    assert.deepEqual(key("repository_id"), ["${GitHubRepositoryId}"]);
    assert.deepEqual(key("job_workflow_ref"), ["${GitHubOwner}/${GitHubRepository}/.github/workflows/deploy.yml@refs/heads/main"]);
    assert.ok(!json(st).includes("environment:"), "no environment sub");
    assert.ok(!json(st).includes("*"), "no wildcard");
    assert.equal(tpl.Parameters.GitHubOwner!.Default, "Mircoguidetti");
    assert.equal(tpl.Parameters.GitHubRepository!.Default, "fenvix-app");
    // MEASURED (GitHub API, review R-024c): owner Mircoguidetti is 17613795, repository fenvix-app is 1434576189.
    assert.equal(tpl.Parameters.GitHubOwnerId!.Default, "17613795");
    assert.equal(tpl.Parameters.GitHubRepositoryId!.Default, "1434576189");
    assert.match(json(tpl.Rules), /865859654353/);
    assert.match(json(tpl.Rules), /eu-west-1/);
    // No access key anywhere.
    assert.ok(!Object.values(tpl.Resources).some((r) => r.Type === "AWS::IAM::AccessKey" || r.Type === "AWS::IAM::User"));
  });

  it("the CDK deploy and publishing roles are assumable by the deploy role only; CloudFormation's role by CloudFormation only", () => {
    for (const id of ["CdkDeployRole", "CdkPublishRole"]) {
      assert.equal(json((tpl.Resources[id]!.Properties.AssumeRolePolicyDocument as { Statement: { Principal: unknown }[] }).Statement.map((s) => s.Principal)), json([{ AWS: { "Fn::GetAtt": ["DeployerRole", "Arn"] } }]));
    }
    assert.match(json(tpl.Resources.CfnExecRole!.Properties.AssumeRolePolicyDocument), /"Service":"cloudformation\.amazonaws\.com"/);
    assert.match(json(tpl.Resources.CdkDeployRole!.Properties.Policies), /"iam:PassedToService":"cloudformation\.amazonaws\.com"/);
  });

  it("names what the synthesized stacks expect (roles, assets bucket, version parameter) and what the workflow assumes", async () => {
    const { stack } = await synth();
    const outdir = (stack.node.root as unknown as { outdir: string }).outdir;
    const manifest = JSON.parse(readFileSync(`${outdir}/manifest.json`, "utf8")) as { artifacts: Record<string, { type: string; properties?: Record<string, string> }> };
    const props = Object.values(manifest.artifacts).find((a) => a.type === "aws:cloudformation:stack")!.properties!;
    const names = Object.values(tpl.Resources).map((r) => json(r.Properties));
    for (const arn of [props.assumeRoleArn!, props.cloudFormationExecutionRoleArn!]) {
      const role = arn.split("/").at(-1)!;
      assert.ok(names.some((n) => n.includes(`"RoleName":"${role}"`)), role);
    }
    assert.equal(props.bootstrapStackVersionSsmParameter, "/cdk-bootstrap/fenvix/version");
    assert.equal(tpl.Resources.VersionParameter!.Properties.Name, "/cdk-bootstrap/fenvix/version");
    const assets = JSON.parse(readFileSync(`${outdir}/test-stack.assets.json`, "utf8")) as { files: Record<string, { destinations: Record<string, { bucketName: string; assumeRoleArn: string }> }> };
    const dest = Object.values(Object.values(assets.files)[0]!.destinations)[0]!;
    assert.equal(dest.bucketName, tpl.Resources.AssetsBucket!.Properties.BucketName);
    assert.ok(names.some((n) => n.includes(`"RoleName":"${dest.assumeRoleArn.split("/").at(-1)}"`)));
    const workflow = readFileSync(new URL("../../../.github/workflows/deploy.yml", import.meta.url), "utf8");
    assert.match(workflow, /DEPLOY_ROLE: arn:aws:iam::865859654353:role\/fenvix-github-deployer/);
    assert.doesNotMatch(workflow, /^\s+environment:/m);
  });
});
