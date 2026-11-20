// Review R-012 (docs/REVIEW-R-012.md): one failing test per defect found in the AWS deploy kit. Each test states the
// property the stack or the scripts must have; it fails on the delivery as reviewed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Annotations, Match } from "aws-cdk-lib/assertions";
import { resources, synth } from "./helpers.ts";

type Stmt = { Effect: string; Action: string | string[]; Resource: unknown; Sid?: string; Condition?: Record<string, Record<string, unknown>> };
const arr = <T,>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);
const json = (x: unknown) => JSON.stringify(x);
const PER_JOB: Record<string, string> = {};
const DEMO = PER_JOB; // demo mode was retired (2026-11-20): the checks run on the pool stack

/** Every statement attached to a role (inline policies of the template). */
async function statementsOfRole(over: Record<string, string>, roleMatch: RegExp): Promise<Stmt[]> {
  const { template: t } = await synth(over);
  const roleIds = resources(t, "AWS::IAM::Role").map(([id]) => id).filter((id) => roleMatch.test(id));
  assert.ok(roleIds.length > 0, `no role matches ${roleMatch}`);
  return resources(t, "AWS::IAM::Policy")
    .filter(([, p]) => roleIds.some((id) => json((p.Properties as { Roles: unknown }).Roles).includes(`"${id}"`)))
    .flatMap(([, p]) => (p.Properties as { PolicyDocument: { Statement: Stmt[] } }).PolicyDocument.Statement);
}

describe("R-012 review: IAM", () => {
  it("F2 per-job: the role of every job machine (pull requests and forks included) cannot read the shared-cache WRITE token", async () => {
    // One instance role serves trusted and untrusted jobs alike. The only barrier between a fork's job and this role is
    // an iptables uid rule on the same kernel: one local root escalation on any job machine yields the write token
    // (cache poisoning for every customer: one cache organization) and the fleet-wide RUNNER_TOKEN.
    const st = await statementsOfRole(PER_JOB, /^FleetJobRole/);
    const readable = st.filter((x) => x.Effect === "Allow" && arr(x.Action).some((a) => /^ssm:GetParameters?$/.test(a))).flatMap((x) => arr(x.Resource as string));
    assert.ok(!readable.some((r) => json(r).includes("/cache/write-token")),
      `the machines' single role can read the write token: ${json(readable)}. Untrusted jobs need a role (launch template) without it.`);
  });

  it("F5 the Image Builder build machine cannot read the App's secrets (AmazonSSMManagedInstanceCore grants ssm:GetParameter on *)", async () => {
    const { template: t } = await synth(DEMO);
    const [, role] = resources(t, "AWS::IAM::Role").find(([id]) => /^FleetBuildRole/.test(id))!;
    const managed = json(role.Properties.ManagedPolicyArns);
    const st = await statementsOfRole(DEMO, /^FleetBuildRole/);
    const denies = st.filter((x) => x.Effect === "Deny" && arr(x.Action).some((a) => /^ssm:(GetParameter|GetParameters|GetParametersByPath|\*)$/.test(a))
      && json(x.Resource).includes("parameter/fenvix/"));
    // The build runs third-party code (engine build: pip/uv, cargo; the GitHub runner) and then, as root, a file the
    // `fenvix` user owns (installdependencies.sh): root on the build machine reads /fenvix/prod/github-app/private-key.
    assert.ok(!managed.includes("AmazonSSMManagedInstanceCore") || denies.length > 0,
      "the build role has AmazonSSMManagedInstanceCore (ssm:GetParameter/GetParameters on *) and no Deny on parameter/fenvix/*");
  });

  it("F7 a function that may start machines may start only the launch template's machine (instance type, launch template)", async () => {
    for (const [mode, role] of [[PER_JOB, /^WorkerRole/], [PER_JOB, /^WarmupRole/], [PER_JOB, /^SweepRole/]] as const) {
      const st = await statementsOfRole(mode, role);
      const onInstances = st.filter((x) => x.Effect === "Allow" && arr(x.Action).includes("ec2:RunInstances") && json(x.Resource).includes(":instance/"));
      assert.ok(onInstances.length > 0);
      for (const x of onInstances) {
        const keys = Object.values(x.Condition ?? {}).flatMap((c) => Object.keys(c));
        assert.ok(keys.includes("ec2:LaunchTemplate") || keys.includes("ec2:InstanceType"),
          `${role}: RunInstances on instance/* is conditioned only on ${json(keys)}: any instance type (p5.48xlarge...) can be started without the launch template`);
      }
    }
  });
});

describe("R-012 review: the deploy identity and CloudFormation's execution policies", () => {
  const policy = (f: string) => (JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")) as { Statement: Stmt[] }).Statement;
  const exec = ["cfn-exec-policy-app.json", "cfn-exec-policy-edge.json", "cfn-exec-policy-fleet.json"].flatMap(policy);

  it("F4 the execution role cannot write arbitrary IAM policies on the stack's roles (no permissions boundary = deployer is admin)", () => {
    // deploy-policy.json lets the deployer pass any template to CloudFormation. With iam:CreateRole/PutRolePolicy on
    // fenvix-prod-github-app-* and no iam:PermissionsBoundary condition, a template can create such a role with
    // "Action": "*" and hand it to a Lambda the Scheduler invokes (both allowed): DEPLOY-AWS.md step 11's "It cannot
    // create IAM, Lambda or EC2 resources itself" does not hold.
    const writes = exec.filter((x) => x.Effect === "Allow" && arr(x.Action).some((a) => ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy"].includes(a)));
    assert.ok(writes.length > 0);
    for (const x of writes) assert.match(json(x.Condition ?? {}), /iam:PermissionsBoundary/, `${x.Sid} writes IAM policies without a permissions boundary`);
  });

  it("F4 the execution role cannot read the App's SecureString parameters (ssm:GetParameter on *)", () => {
    const wide = exec.filter((x) => x.Effect === "Allow" && arr(x.Action).some((a) => /^ssm:GetParameters?$/.test(a)) && arr(x.Resource as string).includes("*"));
    assert.deepEqual(wide.map((x) => x.Sid), [], "ssm:GetParameter on * lets CloudFormation's role read /fenvix/prod/github-app/private-key");
  });
});

describe("R-012 review: runner machines", () => {
  it("F8 a fresh runner machine is not held at its CPU baseline: no T3 'standard' credits (T3 gets no launch credits)", async () => {
    // docs.aws.amazon.com burstable-performance-instances-standard-mode-concepts: "T3 instances do not receive launch
    // credits". A t3.medium in standard mode starts with 0 credits and runs at its 20% per-vCPU baseline: a one-job
    // machine never earns enough credits to build or test at full speed.
    for (const mode of [{}, PER_JOB]) {
      const { template: t, s } = await synth(mode);
      const [, lt] = resources(t, "AWS::EC2::LaunchTemplate")[0]!;
      const credits = json((lt.Properties.LaunchTemplateData as Record<string, unknown>).CreditSpecification);
      assert.ok(!(s.runnerInstanceType.startsWith("t3.") && credits.includes('"standard"')),
        `runner machines are ${s.runnerInstanceType} with CPU credits ${credits}`);
    }
  });
});

describe("R-012 review: cdk-nag", () => {
  it("F14 per-job mode: every cdk-nag rule ran (no CdkNagValidationFailure)", async () => {
    const { stack } = await synth(PER_JOB);
    const failures = Annotations.fromStack(stack).findWarning("*", Match.stringLikeRegexp("CdkNagValidationFailure")).map((m) => `${m.id}: ${String(m.entry.data).slice(0, 160)}`);
    assert.deepEqual(failures, []);
  });
});

