// Before CDK deploys: undo what a failed first create of a stack leaves behind, so the next deploy goes through.
//
// A stack whose first create failed ends in ROLLBACK_COMPLETE. CloudFormation cannot update it; the CDK CLI would
// delete it itself, but through its deploy role, which has no cloudformation:DeleteStack. The dashboard's bucket has
// a fixed name and DeletionPolicy Retain, so the rollback keeps it (DELETE_SKIPPED) if S3 had created it: the next
// create would then fail with "already exists". This step:
//   1. deletes a fenvix stack ONLY if it is in ROLLBACK_COMPLETE (a stack that never existed: every resource it
//      created was deleted by the rollback, or retained and no longer part of it), and waits for DELETE_COMPLETE;
//   2. deletes the dashboard bucket ONLY if no stack holds it any more (the dashboard stack does not exist), it is
//      owned by this account (ExpectedBucketOwner) and it is empty (the dashboard's files are uploaded after CDK, so
//      a bucket left by a failed create has none). A bucket with files in it is never touched: the step stops.
// Anything else (a stack in any other state, a bucket of another account) is left alone for CDK or a person.
// The alternative, importing the bucket into the new stack (cdk import), needs a two-phase deploy for one empty
// bucket that CloudFormation then creates again in a second; deleting it is the smaller, checkable step.
import { DeleteStackCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DeleteBucketCommand, HeadBucketCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { info, Stop } from "./log.mjs";

const gone = (e) => e?.name === "ValidationError" && /does not exist/.test(e.message ?? "");

/** The stack's { id, status }, or null when there is no such stack (or it is deleted). */
export async function stackState(cfn, name) {
  try {
    const s = (await cfn.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
    return s && s.StackStatus !== "DELETE_COMPLETE" ? { id: s.StackId, status: s.StackStatus } : null;
  } catch (e) {
    if (gone(e)) return null;
    throw e;
  }
}

/** Deletes `name` only if it is in ROLLBACK_COMPLETE; waits for the deletion. Returns what it did. */
export async function deleteFailedCreate(cfn, name, { everyMs = 5000, timeoutMs = 15 * 60_000 } = {}) {
  const s = await stackState(cfn, name);
  if (!s) return "absent";
  if (s.status !== "ROLLBACK_COMPLETE") return `kept (${s.status})`;
  info(`${name}: its first create failed and was rolled back (ROLLBACK_COMPLETE); deleting the empty stack so that it can be created again`);
  await cfn.send(new DeleteStackCommand({ StackName: s.id }));
  const end = Date.now() + timeoutMs;
  for (;;) {
    // By id: once deleted, the name no longer resolves, the id still answers DELETE_COMPLETE.
    const now = (await cfn.send(new DescribeStacksCommand({ StackName: s.id }))).Stacks?.[0]?.StackStatus;
    if (!now || now === "DELETE_COMPLETE") return "deleted";
    if (now === "DELETE_FAILED") throw new Stop(`Deleting the stack ${name} (left in ROLLBACK_COMPLETE by a failed first create) failed: look at its events in the CloudFormation console, delete it there, and run the deploy again.`);
    if (Date.now() > end) throw new Stop(`The stack ${name} is still ${now} after ${Math.round(timeoutMs / 60_000)} minutes: run the deploy again once it is deleted.`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Deletes the bucket only if no stack holds it, this account owns it, and it is empty. Returns what it did. */
export async function deleteOrphanBucket(cfn, s3, { bucket, stack, account }) {
  const s = await stackState(cfn, stack);
  if (s) return `kept (held by ${stack}, ${s.status})`;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket, ExpectedBucketOwner: account }));
  } catch (e) {
    const code = e?.$metadata?.httpStatusCode;
    if (e?.name === "NotFound" || e?.name === "NoSuchBucket" || code === 404) return "absent";
    if (code === 403) throw new Stop(`The bucket name ${bucket} exists but this account (${account}) does not own it or may not read it: the dashboard stack cannot create it. Nothing was changed.`);
    throw e;
  }
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1, ExpectedBucketOwner: account }));
  if ((listed.KeyCount ?? listed.Contents?.length ?? 0) > 0) {
    throw new Stop(`The bucket ${bucket} is not part of any stack but holds files, so the dashboard stack cannot create it. Nothing was deleted. Empty it (S3 console → ${bucket} → Empty) if those files are not needed, then run the deploy again.`);
  }
  info(`${bucket}: left empty by a failed create of ${stack} (no stack holds it); deleting it so that the stack can create it`);
  await s3.send(new DeleteBucketCommand({ Bucket: bucket, ExpectedBucketOwner: account }));
  return "deleted";
}

/** Both, in order: the failed stacks first (so that the bucket's stack is gone), then the dashboard bucket. */
export async function recoverFailedCreates(cfn, s3, { stacks, dashboardStack, bucket, account }) {
  const result = {};
  for (const name of stacks) result[name] = await deleteFailedCreate(cfn, name);
  result[bucket] = await deleteOrphanBucket(cfn, s3, { bucket, stack: dashboardStack, account });
  return result;
}
