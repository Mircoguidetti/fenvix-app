// lib/recover.mjs: the first deploy's dashboard stack failed its create (cloudfront:TagResource), was rolled back to
// ROLLBACK_COMPLETE, and may have left its retained bucket behind. The next deploy must go through either way, and must
// never delete a stack in any other state, a bucket some stack holds, a bucket with files, or another account's bucket.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deleteFailedCreate, deleteOrphanBucket, recoverFailedCreates } from "../lib/recover.mjs";
import { Stop } from "../lib/log.mjs";
import { captured } from "./helpers.mjs";

const ACCOUNT = "865859654353";
const APP = "fenvix-prod-github-app";
const DASH = "fenvix-prod-dashboard";
const BUCKET = `fenvix-prod-dashboard-${ACCOUNT}`;

const err = (name, message, status) => Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });

/** CloudFormation in memory: stacks by name, each { id, status }; a deleted stack answers by id only. */
class FakeCfn {
  constructor(stacks = {}, { deleteEndsIn = "DELETE_COMPLETE" } = {}) {
    this.stacks = new Map(Object.entries(stacks).map(([n, status]) => [n, { id: `arn:aws:cloudformation:eu-west-1:${ACCOUNT}:stack/${n}/uuid-1`, status }]));
    this.deleted = new Map();
    this.deleteEndsIn = deleteEndsIn;
    this.calls = [];
  }
  async send(cmd) {
    const name = cmd.constructor.name, i = cmd.input;
    this.calls.push({ name, input: i });
    if (name === "DescribeStacksCommand") {
      const byName = this.stacks.get(i.StackName);
      if (byName) return { Stacks: [{ StackId: byName.id, StackStatus: byName.status }] };
      const byId = [...this.stacks.values(), ...this.deleted.values()].find((s) => s.id === i.StackName);
      if (byId) return { Stacks: [{ StackId: byId.id, StackStatus: byId.status }] };
      throw err("ValidationError", `Stack with id ${i.StackName} does not exist`, 400);
    }
    if (name === "DeleteStackCommand") {
      const [n, s] = [...this.stacks.entries()].find(([, x]) => x.id === i.StackName) ?? [];
      assert.ok(s, `DeleteStack by id of a known stack: ${i.StackName}`);
      if (this.deleteEndsIn === "DELETE_COMPLETE") { this.stacks.delete(n); this.deleted.set(n, { ...s, status: "DELETE_COMPLETE" }); }
      else s.status = this.deleteEndsIn;
      return {};
    }
    throw new Error(`unexpected ${name}`);
  }
}

/** S3 in memory: one bucket or none, its owner and its keys. */
class FakeS3 {
  constructor(bucket = null) { this.bucket = bucket; this.calls = []; }
  async send(cmd) {
    const name = cmd.constructor.name, i = cmd.input;
    this.calls.push({ name, input: i });
    assert.equal(i.Bucket, BUCKET);
    assert.equal(i.ExpectedBucketOwner, ACCOUNT, `${name} always names the expected owner`);
    if (!this.bucket) throw err("NotFound", "Not Found", 404);
    if (this.bucket.owner !== i.ExpectedBucketOwner) throw err("Forbidden", "Forbidden", 403);
    if (name === "HeadBucketCommand") return {};
    if (name === "ListObjectsV2Command") { const keys = this.bucket.keys.slice(0, i.MaxKeys); return { KeyCount: keys.length, Contents: keys.map((Key) => ({ Key })) }; }
    if (name === "DeleteBucketCommand") { if (this.bucket.keys.length) throw err("BucketNotEmpty", "not empty", 409); this.bucket = null; return {}; }
    throw new Error(`unexpected ${name}`);
  }
}

const opts = { stacks: [APP, DASH], dashboardStack: DASH, bucket: BUCKET, account: ACCOUNT };
const quiet = (fn) => captured(fn).then(([r]) => r);
const deletes = (c) => c.calls.filter((x) => /^Delete/.test(x.name));

describe("recover-failed-creates (before CDK): what a failed first create left behind", () => {
  it("the first deploy's state: dashboard in ROLLBACK_COMPLETE, its empty bucket retained → both deleted, by stack id; the app stack untouched", async () => {
    const cfn = new FakeCfn({ [DASH]: "ROLLBACK_COMPLETE" });
    const s3 = new FakeS3({ owner: ACCOUNT, keys: [] });
    const r = await quiet(() => recoverFailedCreates(cfn, s3, opts));
    assert.deepEqual(r, { [APP]: "absent", [DASH]: "deleted", [BUCKET]: "deleted" });
    assert.deepEqual(deletes(cfn).map((c) => c.input.StackName), [`arn:aws:cloudformation:eu-west-1:${ACCOUNT}:stack/${DASH}/uuid-1`]);
    assert.equal(s3.bucket, null);
  });

  it("the second deploy's state: github-app in ROLLBACK_COMPLETE (78 resources rolled back), no dashboard stack or bucket → only the app stack is deleted", async () => {
    const cfn = new FakeCfn({ [APP]: "ROLLBACK_COMPLETE" });
    const s3 = new FakeS3(null);
    assert.deepEqual(await quiet(() => recoverFailedCreates(cfn, s3, opts)), { [APP]: "deleted", [DASH]: "absent", [BUCKET]: "absent" });
    assert.deepEqual(deletes(cfn).map((c) => c.input.StackName), [`arn:aws:cloudformation:eu-west-1:${ACCOUNT}:stack/${APP}/uuid-1`]);
    assert.deepEqual(deletes(s3), []);
  });

  it("ROLLBACK_COMPLETE and S3 never created the bucket → the stack is deleted, nothing else", async () => {
    const cfn = new FakeCfn({ [DASH]: "ROLLBACK_COMPLETE", [APP]: "ROLLBACK_COMPLETE" });
    const s3 = new FakeS3(null);
    assert.deepEqual(await quiet(() => recoverFailedCreates(cfn, s3, opts)), { [APP]: "deleted", [DASH]: "deleted", [BUCKET]: "absent" });
    assert.deepEqual(deletes(s3), []);
  });

  it("nothing failed (no stack yet, or both deployed) → nothing is deleted", async () => {
    for (const [stacks, bucket] of [[{}, null], [{ [APP]: "CREATE_COMPLETE", [DASH]: "UPDATE_COMPLETE" }, { owner: ACCOUNT, keys: ["index.html"] }]]) {
      const cfn = new FakeCfn(stacks), s3 = new FakeS3(bucket);
      const r = await quiet(() => recoverFailedCreates(cfn, s3, opts));
      assert.deepEqual([deletes(cfn), deletes(s3)], [[], []], JSON.stringify(r));
    }
  });

  it("a stack in any state but ROLLBACK_COMPLETE is never deleted (CDK or a person handles it)", async () => {
    for (const status of ["CREATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "UPDATE_ROLLBACK_FAILED", "ROLLBACK_FAILED", "ROLLBACK_IN_PROGRESS", "CREATE_IN_PROGRESS", "REVIEW_IN_PROGRESS", "DELETE_FAILED", "IMPORT_ROLLBACK_COMPLETE"]) {
      const cfn = new FakeCfn({ [DASH]: status });
      assert.equal(await quiet(() => deleteFailedCreate(cfn, DASH)), `kept (${status})`);
      assert.deepEqual(deletes(cfn), [], status);
    }
  });

  it("the bucket is kept while a stack holds it (even one that is not healthy)", async () => {
    for (const status of ["CREATE_COMPLETE", "UPDATE_ROLLBACK_FAILED", "ROLLBACK_COMPLETE"]) {
      const s3 = new FakeS3({ owner: ACCOUNT, keys: [] });
      assert.match(await quiet(() => deleteOrphanBucket(new FakeCfn({ [DASH]: status }), s3, { bucket: BUCKET, stack: DASH, account: ACCOUNT })), /^kept/);
      assert.deepEqual(s3.calls, [], "S3 is not even asked");
    }
  });

  it("a left-over bucket with files is never deleted: the step stops and says what to do", async () => {
    const s3 = new FakeS3({ owner: ACCOUNT, keys: ["index.html"] });
    await assert.rejects(quiet(() => deleteOrphanBucket(new FakeCfn({}), s3, { bucket: BUCKET, stack: DASH, account: ACCOUNT })), (e) => e instanceof Stop && /holds files.*Nothing was deleted/.test(e.message));
    assert.deepEqual(deletes(s3), []);
    assert.ok(s3.bucket);
  });

  it("a bucket of that name this account does not own: stops, deletes nothing", async () => {
    const s3 = new FakeS3({ owner: "111122223333", keys: [] });
    await assert.rejects(quiet(() => deleteOrphanBucket(new FakeCfn({}), s3, { bucket: BUCKET, stack: DASH, account: ACCOUNT })), (e) => e instanceof Stop && /does not own it/.test(e.message));
    assert.deepEqual(deletes(s3), []);
  });

  it("a stack deletion that fails stops the deploy with what to do", async () => {
    const cfn = new FakeCfn({ [DASH]: "ROLLBACK_COMPLETE" }, { deleteEndsIn: "DELETE_FAILED" });
    await assert.rejects(quiet(() => deleteFailedCreate(cfn, DASH, { everyMs: 1 })), (e) => e instanceof Stop && /DELETE_FAILED|failed/.test(e.message));
  });
});

describe("the deploy wires it in before CDK, with exactly the permissions it needs", async () => {
  const { readFileSync } = await import("node:fs");
  const root = new URL("../../", import.meta.url);
  const read = (p) => readFileSync(new URL(p, root), "utf8");

  it("deploy.yml runs recover-failed-creates after the certificate and before cdk deploy", () => {
    const wf = read(".github/workflows/deploy.yml");
    const at = (s) => { const i = wf.indexOf(s); assert.ok(i > 0, s); return i; };
    assert.ok(at("dashboard-certificate --wait-minutes") < at("node deploy/cli.mjs recover-failed-creates"));
    assert.ok(at("node deploy/cli.mjs recover-failed-creates") < at("npx --no-install cdk deploy"));
  });

  it("the deployer may delete only the two fenvix stacks and the dashboard bucket (nothing more)", () => {
    const st = JSON.parse(read("infra/github-app/deploy-policy.json")).Statement;
    const del = st.filter((s) => s.Effect === "Allow" && [s.Action].flat().some((a) => /^(cloudformation:DeleteStack|s3:DeleteBucket)$/.test(a)));
    assert.deepEqual(del.map((s) => s.Sid), ["ClearAFailedFirstCreate"]);
    assert.deepEqual([del[0].Action].flat().sort(), ["cloudformation:DeleteStack", "s3:DeleteBucket"]);
    assert.deepEqual([del[0].Resource].flat().sort(), [
      `arn:aws:cloudformation:eu-west-1:${ACCOUNT}:stack/${DASH}/*`,
      `arn:aws:cloudformation:eu-west-1:${ACCOUNT}:stack/${APP}/*`,
      `arn:aws:s3:::${BUCKET}`,
    ]);
  });
});
