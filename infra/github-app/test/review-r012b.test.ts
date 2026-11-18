// Review R-012b (docs/REVIEW-R-012b.md): one failing test per new defect found in the fixes of review R-012. Each test
// states the property the scripts or the policies must have; it fails on the delivery as reviewed (44d2a33).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const runJob = read("../../customer-mode/spike/run-job.sh");
const hostSetup = read("../../customer-mode/spike/host-setup.sh");
const readResult = read("../../customer-mode/spike/read-result.py");

type Stmt = { Effect: string; Action: string | string[]; Resource: string | string[]; Sid?: string; Condition?: Record<string, Record<string, unknown>> };
const arr = <T,>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);
const boundary = (JSON.parse(read("../permissions-boundary.json")) as { Statement: Stmt[] }).Statement;
const condKeys = (s: Stmt) => Object.values(s.Condition ?? {}).flatMap((o) => Object.keys(o));
const covers = (s: Stmt, kind: string) => arr(s.Resource).some((r) => r === "*" || r.includes(`:${kind}/`) || r.endsWith(":*"));

describe("R-012b review: customer-mode spike (F9, F17 fixes)", () => {
  it("N1 the host reads a guest's result disk without following a symlink the jail's uid could plant", () => {
    // The jail root (/srv/jailer/firecracker/<id>/root) is chown'ed to the jail's uid, so a Firecracker process that
    // escaped the guest (the case the jailer exists for, F17) can replace result.img with a symlink to another
    // sandbox's result.img (/srv/jailer/firecracker/fenvix-sbx-2/root/result.img). The root shell's `<"$jail/result.img"`
    // follows it: the other tenant's summary is parsed and posted with this job's credential, i.e. it appears in the
    // attacker's own pull request. Same class as F9 (a guest-controlled path followed on the host).
    const lines = runJob.split("\n").filter((l) => /result\.img/.test(l) && (/read-result\.py/.test(l) || /<\s*"?\$jail\/result\.img/.test(l)));
    assert.ok(lines.length > 0, "run-job.sh no longer reads result.img: update this test");
    const noFollow = /O_NOFOLLOW/.test(readResult) || /O_NOFOLLOW/.test(runJob);
    for (const l of lines) {
      const rootRedirect = /<\s*"?\$jail\/result\.img/.test(l);
      const asJailUid = /(setpriv\s+[^|]*--reuid[= ]"?\$uid|runuser\s+-u\s+"?#?\$uid|sudo\s+-u\s+"?#\$uid)/.test(l);
      assert.ok(!rootRedirect || asJailUid || noFollow,
        `root opens the jail-owned path with a shell redirect, following symlinks: ${l.trim()}. Read it as the jail's uid (setpriv --reuid "$uid" ... cat), or open it with O_NOFOLLOW and check it is a regular file of the jail's uid`);
    }
  });

  it("N3 a jailed Firecracker (its own uid) cannot reach the parent's metadata service (the queue role's credentials)", () => {
    // The jailer runs without --netns, so each Firecracker shares the parent's network namespace, and no OUTPUT rule
    // keeps the jail uids (20001-20250) from 169.254.169.254. Hop limit 1 stops forwarded packets only, not a local
    // process. After a VMM escape the queue role's credentials are one HTTP call away, and the queue carries every
    // customer's just-in-time config and per-job credentials. DEPLOY-AWS.md: "One escape there must not reach other
    // tenants or our credentials".
    const netns = /--netns\s/.test(runJob);
    const v4 = /--uid-owner[^\n]*169\.254\.169\.254|169\.254\.169\.254[^\n]*--uid-owner/.test(hostSetup + runJob);
    const v6 = /--uid-owner[^\n]*fd00:ec2::254|fd00:ec2::254[^\n]*--uid-owner/.test(hostSetup + runJob);
    assert.ok(netns || (v4 && v6),
      "give each jail its own network namespace (jailer --netns, the TAP inside it), or block the jail uids' range from 169.254.169.254 and fd00:ec2::254 (iptables/ip6tables OUTPUT -m owner --uid-owner 20001-20250 -j REJECT)");
  });
});

describe("R-012b review: the permissions boundary (F4, F7 fixes)", () => {
  it("N2 the boundary is no wider than the execution policy for EC2: allowed instance types only, terminate only runner machines", () => {
    // The boundary is the ceiling of any role a deployer's template can create. Its RunnerMachines statement allows
    // ec2:RunInstances and ec2:TerminateInstances on "*" (region only): a bounded role may start any instance type
    // (p5.48xlarge: the F7 class) and terminate any instance in the region (the cache machine, anything else in the
    // account), although the execution policy itself denies every type but the allowed list.
    const runDenyByType = boundary.some((s) => s.Effect === "Deny" && arr(s.Action).includes("ec2:RunInstances") && condKeys(s).includes("ec2:InstanceType"));
    const runAllows = boundary.filter((s) => s.Effect === "Allow" && arr(s.Action).includes("ec2:RunInstances") && covers(s, "instance"));
    assert.ok(runDenyByType || runAllows.every((s) => condKeys(s).includes("ec2:InstanceType")),
      `the boundary allows ec2:RunInstances of any instance type (${runAllows.map((s) => s.Sid).join(", ")}): add a Deny on instance/* with StringNotEquals ec2:InstanceType (the list of cfn-exec-policy-fleet.json)`);
    const termAllows = boundary.filter((s) => s.Effect === "Allow" && arr(s.Action).includes("ec2:TerminateInstances") && covers(s, "instance"));
    for (const s of termAllows) {
      assert.ok(condKeys(s).includes("aws:ResourceTag/fenvix:role"),
        `${s.Sid}: ec2:TerminateInstances on any instance of the region; condition it on aws:ResourceTag/fenvix:role as the stack's own roles are`);
    }
  });
});
