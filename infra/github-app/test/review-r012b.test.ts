// Review R-012b (docs/REVIEW-R-012b.md on claude/review-r012b), carried to main by P-047 (audit G-0001, G-0002, G-0003).
// N2 is the reviewer's test, unchanged in substance. N1 and N3 targeted the Firecracker spike, which the approved
// design of 2026-11-20 replaced (customers never share a kernel: one EC2 machine per customer at a time; the same
// customer's jobs in per-slot sandboxes). The spike is deleted; the two defect CLASSES are tested on the design that
// runs: our-machines.test.ts "N1 family" (root never follows a sandbox-controlled path) and "N3 family" (no non-root
// process reaches the instance metadata service).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
type Stmt = { Effect: string; Action: string | string[]; Resource: string | string[]; Sid?: string; Condition?: Record<string, Record<string, unknown>> };
const arr = <T,>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);
const boundary = (JSON.parse(read("../permissions-boundary.json")) as { Statement: Stmt[] }).Statement;
const fleet = (JSON.parse(read("../cfn-exec-policy-fleet.json")) as { Statement: Stmt[] }).Statement;
const condKeys = (s: Stmt) => Object.values(s.Condition ?? {}).flatMap((o) => Object.keys(o));
const covers = (s: Stmt, kind: string) => arr(s.Resource).some((r) => r === "*" || r.includes(`:${kind}/`) || r.endsWith(":*"));

describe("R-012b review: the permissions boundary (F4, F7 fixes)", () => {
  it("N2 the boundary is no wider than the execution policy for EC2: allowed instance types only, lifecycle only on runner machines", () => {
    const runDenyByType = boundary.some((s) => s.Effect === "Deny" && arr(s.Action).includes("ec2:RunInstances") && condKeys(s).includes("ec2:InstanceType"));
    const runAllows = boundary.filter((s) => s.Effect === "Allow" && arr(s.Action).includes("ec2:RunInstances") && covers(s, "instance"));
    assert.ok(runDenyByType || runAllows.every((s) => condKeys(s).includes("ec2:InstanceType")), "the boundary allows ec2:RunInstances of any instance type");
    // Every action that changes an existing instance (the dispatcher starts, stops, modifies and terminates machines).
    for (const action of ["ec2:TerminateInstances", "ec2:StartInstances", "ec2:StopInstances", "ec2:ModifyInstanceAttribute"]) {
      for (const s of boundary.filter((x) => x.Effect === "Allow" && arr(x.Action).includes(action) && covers(x, "instance"))) {
        assert.ok(condKeys(s).includes("aws:ResourceTag/fenvix:role"), `${s.Sid}: ${action} on any instance of the region`);
      }
    }
  });

  it("N2 the boundary's size list is exactly the execution policy's", () => {
    const types = (ss: Stmt[]) => ss.filter((s) => s.Effect === "Deny" && arr(s.Action).includes("ec2:RunInstances"))
      .flatMap((s) => arr((s.Condition?.StringNotEquals ?? {})["ec2:InstanceType"] as string[] | string)).sort();
    assert.deepEqual(types(boundary), types(fleet));
    assert.ok(types(fleet).includes("c7a.xlarge"), "the always-on size of the 2026-11-20 design (c7a.xlarge) is allowed");
  });
});

describe("R-012b review: N1 and N3 (Firecracker spike)", () => {
  it("the spike they targeted is gone; the classes are tested in our-machines.test.ts", () => {
    assert.equal(existsSync(new URL("../../customer-mode/spike/run-job.sh", import.meta.url)), false);
  });
});
