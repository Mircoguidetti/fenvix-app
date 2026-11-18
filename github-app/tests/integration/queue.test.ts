import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { sign } from "../../src/github/signature.ts";
import type { HttpApiEvent } from "../../src/lambda/apigw.ts";
import { makeHttpHandler, makeSweepHandler, makeWorkerHandler, type SqsEvent } from "../../src/lambda/handlers.ts";
import { SqsWorkQueue } from "../../src/queue/sqs.ts";
import { jsonLogger } from "../../src/work.ts";
import { MemoryBlobs } from "../helpers/memory-aws.ts";
import { ACCOUNT, CI_YAML, Harness, INSTALLATION_ID, installationCreated, makeOrg, REPOS, resetDb, runnerCredential, WEBHOOK_SECRET, workflowJob } from "../helpers/harness.ts";

const summary = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/runner/${name}.summary.json`, import.meta.url), "utf8")) as Record<string, unknown>;

/** An SQS queue in memory: what was sent, and the receive count of each message (as SQS keeps it). */
class MemoryQueue {
  messages: { messageId: string; body: string; receives: number }[] = [];
  failSends = false;
  async send(body: string) {
    if (this.failSends) throw new Error("SQS: ServiceUnavailable");
    this.messages.push({ messageId: randomUUID(), body, receives: 0 });
  }
  /** One receive of everything in the queue, as one batch. */
  batch(): SqsEvent {
    const recs = this.messages.map((m) => ({ messageId: m.messageId, body: m.body, attributes: { ApproximateReceiveCount: String(++m.receives) } }));
    return { Records: recs };
  }
  /** Deletes what the worker did not report as failed (Lambda's event source mapping does this). */
  settle(failures: { itemIdentifier: string }[]) {
    const failed = new Set(failures.map((f) => f.itemIdentifier));
    this.messages = this.messages.filter((m) => failed.has(m.messageId));
  }
}

describe("Lambda mode: webhook → 202 → SQS → worker", () => {
  const h = new Harness();
  const sqs = new MemoryQueue();
  const blobs = new MemoryBlobs();
  let admin: pg.Client;
  let http: ReturnType<typeof makeHttpHandler>;
  let worker: ReturnType<typeof makeWorkerHandler>;
  let sweep: ReturnType<typeof makeSweepHandler>;
  let org: { userId: string; workspaceId: string };

  /** What API Gateway hands the HTTP function for one GitHub delivery. */
  const githubEvent = (event: string, payload: object, o: { secret?: string; delivery?: string } = {}): HttpApiEvent => {
    const body = JSON.stringify(payload);
    return {
      version: "2.0", rawPath: "/webhooks/github", rawQueryString: "", body: Buffer.from(body).toString("base64"), isBase64Encoded: true,
      headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": o.delivery ?? randomUUID(), "x-hub-signature-256": sign(o.secret ?? WEBHOOK_SECRET, body), "user-agent": "GitHub-Hookshot/abc" },
      requestContext: { http: { method: "POST", sourceIp: "140.82.115.1" }, requestId: "r1" },
    };
  };
  const runnerEvent = (body: object, token = runnerCredential("fenvix-m1", REPOS.shop.id)): HttpApiEvent => ({
    version: "2.0", rawPath: "/v1/runner/summaries", rawQueryString: "", body: JSON.stringify(body), isBase64Encoded: false,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    requestContext: { http: { method: "POST", sourceIp: "203.0.113.5" } },
  });
  /** Runs the worker over the queue until it is empty (or `rounds` receives), like Lambda polling SQS. */
  const drain = async (rounds = 1) => {
    for (let i = 0; i < rounds && sqs.messages.length; i++) {
      const res = await worker(sqs.batch());
      sqs.settle(res.batchItemFailures);
    }
  };

  before(async () => {
    admin = await resetDb();
    // The overflow threshold is low here so the S3 path is exercised by an ordinary installation payload.
    await h.start({}, { queue: new SqsWorkQueue({ queue: sqs, blobs, maxInlineBytes: 64 * 1024 }) });
    const core = { service: h.app.service, log: jsonLogger("silent"), blobs };
    http = makeHttpHandler(async () => h.app);
    worker = makeWorkerHandler(async () => core);
    sweep = makeSweepHandler(async () => core);
    org = await makeOrg(admin, "queue-owner");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("a bad signature is refused at the door: 401, nothing queued", async () => {
    const r = await http(githubEvent("installation", installationCreated([REPOS.shop]), { secret: "not-the-secret-at-all-0000" }));
    assert.equal(r.statusCode, 401);
    assert.equal(sqs.messages.length, 0);
  });

  it("a signed webhook is answered 202 with nothing done yet; the worker does the work", async () => {
    const r = await http(githubEvent("installation", installationCreated([REPOS.shop]), { delivery: "q-inst-1" }));
    assert.equal(r.statusCode, 202);
    assert.deepEqual(JSON.parse(r.body), { ok: true });
    assert.equal(sqs.messages.length, 1);
    // No work after the response: nothing in the database, no pull request yet.
    await h.app.service.idle();
    assert.equal((await admin.query("select count(*)::int as n from gh_installations")).rows[0].n, 0);
    assert.equal(h.gh.repos.get("acme/shop")!.pulls.length, 0);

    await drain();
    assert.equal(sqs.messages.length, 0);
    assert.equal((await admin.query("select onboarding_state from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].onboarding_state, "pr_open");
    assert.equal(h.gh.repos.get("acme/shop")!.pulls.length, 1);
    assert.equal((await admin.query("select processed_at is not null as done from gh_webhook_deliveries where delivery_id = 'q-inst-1'")).rows[0].done, true);
  });

  it("the same delivery queued twice (SQS delivers at least once) is handled once", async () => {
    await http(githubEvent("installation", installationCreated([REPOS.shop]), { delivery: "q-inst-1" }));
    await http(githubEvent("installation", installationCreated([REPOS.shop]), { delivery: "q-inst-1" }));
    await drain();
    assert.equal(h.gh.repos.get("acme/shop")!.pulls.length, 1);
  });

  it("a payload above the message limit goes through the overflow bucket and is deleted after", async () => {
    const big = installationCreated([REPOS.shop]);
    (big as Record<string, unknown>).padding = "x".repeat(80 * 1024);
    assert.equal((await http(githubEvent("installation", big, { delivery: "q-big-1" }))).statusCode, 202);
    assert.match(sqs.messages[0]!.body, /"s3Key":"work\//);
    assert.equal(blobs.objects.size, 1);
    await drain();
    assert.equal(blobs.objects.size, 0);
    assert.equal((await admin.query("select processed_at is not null as done from gh_webhook_deliveries where delivery_id = 'q-big-1'")).rows[0].done, true);
  });

  it("the queue unavailable: 503, so GitHub records a failed delivery that can be redelivered", async () => {
    sqs.failSends = true;
    const r = await http(githubEvent("push", { zen: "x" }));
    sqs.failSends = false;
    assert.equal(r.statusCode, 503);
    assert.equal(JSON.parse(r.body).error.code, "queue_unavailable");
  });

  it("runner summary and completed job: each queued, the run published once by the worker", async () => {
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
    const sha = "5".repeat(40);
    h.gh.addRun("acme/shop", 9101, { event: "push", headSha: sha, headBranch: "main", message: "via the queue" });
    assert.equal((await http(runnerEvent({ repositoryId: REPOS.shop.id, runId: 9101, runAttempt: 1, runnerName: "fenvix-m1", summary: summary("job3-warm-pass") }, "wrong-token-0123456789abcdef0123456789"))).statusCode, 401);
    assert.equal((await http(runnerEvent({ repositoryId: REPOS.shop.id, runId: 9101, runAttempt: 1, runnerName: "fenvix-m1", summary: { nope: true } }))).statusCode, 422);
    assert.equal(sqs.messages.length, 0, "refused requests queue nothing");
    assert.equal((await http(runnerEvent({ repositoryId: REPOS.shop.id, runId: 9101, runAttempt: 1, runnerName: "fenvix-m1", summary: summary("job3-warm-pass") }))).statusCode, 202);
    await http(githubEvent("workflow_job", workflowJob("in_progress", { id: 701, runId: 9101, sha, branch: "main" })));
    await http(githubEvent("workflow_job", workflowJob("completed", { id: 701, runId: 9101, sha, branch: "main" })));
    assert.equal(sqs.messages.length, 3);
    await drain();
    const job = (await admin.query("select published_at, check_run_id from gh_jobs where job_id = 701")).rows[0];
    assert.ok(job.published_at);
    assert.equal(h.gh.repos.get("acme/shop")!.checkRuns.get(job.check_run_id)!.conclusion, "success");
    assert.equal((await admin.query("select count(*)::int as n from ci_usage_events where github_job_id = 701")).rows[0].n, 1);
    assert.equal((await admin.query("select count(*)::int as n from ci_runs where commit_sha = $1", [sha])).rows[0].n, 1);
  });

  it("a failing message is reported alone and retried; the others in the batch are done", async () => {
    const sha = "6".repeat(40);
    h.gh.addRun("acme/shop", 9102, { event: "push", headSha: sha, headBranch: "main", message: "retry via SQS" });
    await http(runnerEvent({ repositoryId: REPOS.shop.id, runId: 9102, runAttempt: 1, runnerName: "fenvix-m1", summary: summary("job3-warm-pass") }));
    await http(githubEvent("workflow_job", workflowJob("in_progress", { id: 702, runId: 9102, sha, branch: "main" })));
    await drain();
    await http(githubEvent("workflow_job", workflowJob("completed", { id: 702, runId: 9102, sha, branch: "main" }), { delivery: "q-job-702-done" }));
    sqs.messages.push({ messageId: "poison", body: "{\"v\":1,\"work\":{\"kind\":\"nothing\"}}", receives: 0 });
    h.gh.failNext.set("PATCH *", 502);
    let res = await worker(sqs.batch());
    assert.deepEqual(res.batchItemFailures.map((f) => f.itemIdentifier).sort(), [sqs.messages[0]!.messageId, "poison"].sort());
    sqs.settle(res.batchItemFailures);
    assert.equal((await admin.query("select published_at from gh_jobs where job_id = 702")).rows[0].published_at, null);
    // The next receive: GitHub answers again; the poison message keeps failing (it ends in the dead-letter queue).
    res = await worker(sqs.batch());
    assert.deepEqual(res.batchItemFailures.map((f) => f.itemIdentifier), ["poison"]);
    sqs.settle(res.batchItemFailures);
    assert.ok((await admin.query("select published_at from gh_jobs where job_id = 702")).rows[0].published_at);
    assert.equal((await admin.query("select count(*)::int as n from ci_usage_events where github_job_id = 702")).rows[0].n, 1);
    sqs.messages = [];
  });

  it("the scheduled sweep publishes a job whose summary never came", async () => {
    const sha = "7".repeat(40);
    h.gh.addRun("acme/shop", 9103, { event: "push", headSha: sha, headBranch: "main", message: "no summary" });
    const startedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    const completedAt = new Date().toISOString();
    await http(githubEvent("workflow_job", workflowJob("in_progress", { id: 703, runId: 9103, sha, branch: "main", startedAt })));
    await http(githubEvent("workflow_job", workflowJob("completed", { id: 703, runId: 9103, sha, branch: "main", conclusion: "failure", startedAt, completedAt })));
    await drain();
    assert.deepEqual(await sweep(), { due: 0 });
    await admin.query("update gh_jobs set completed_at = now() - interval '11 minutes' where job_id = 703");
    assert.deepEqual(await sweep(), { due: 1 });
    assert.deepEqual((await admin.query("select billable, reason from ci_usage_events where github_job_id = 703")).rows[0], { billable: true, reason: "no_summary" });
  });

  it("other routes answer directly through the adapter (health, setup redirect)", async () => {
    const health = await http({ rawPath: "/healthz", rawQueryString: "", requestContext: { http: { method: "GET" } } });
    assert.equal(health.statusCode, 200);
    const setup = await http({ rawPath: "/github/setup", rawQueryString: "setup_action=request", requestContext: { http: { method: "GET" } } });
    assert.equal(setup.statusCode, 303);
    assert.match(setup.headers.location!, /\/projects\/connect\?github=requested$/);
  });
});
