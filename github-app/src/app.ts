import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { SessionVerifier, verifyState } from "./auth.ts";
import type { Config } from "./config.ts";
import { Db } from "./db.ts";
import { GitHubApp, GitHubError } from "./github/client.ts";
import { verifySignature } from "./github/signature.ts";
import { parseExploration, parseProgress, parseResults, parseWarmupReport, RecordError, type RunnerJob, type RunnerWarmupReport } from "./results/runner-records.ts";
import { SummaryError, parseSummary, trimSummary } from "./results/summary.ts";

import type { RunnerLauncher } from "./runners/launcher.ts";
import type { MachinePool } from "./machines/pool.ts";
import { verifyMachineCredential, verifySummaryCredential } from "./runners/credentials.ts";
import { GitHubService, type Logger } from "./service.ts";
import { describeWork, InProcessQueue, type Work, type WorkQueue } from "./work.ts";

export interface App {
  fastify: FastifyInstance;
  service: GitHubService;
  db: Db;
  gh: GitHubApp;
  startBackground(): void;
  close(): Promise<void>;
}

export interface Deps {
  cfg: Config;
  sessions?: SessionVerifier;
  logger?: boolean | object;
  /** Where checked webhooks and runner summaries go. Default: this process, in the background (node server mode). */
  queue?: WorkQueue;
  /** "One machine per job": started for each queued fenvix job (in Lambda mode only the worker has one). */
  launcher?: RunnerLauncher | ((db: Db) => RunnerLauncher);
  /** Our machines' API (hello, poll, events) on a server with no launcher (the HTTP function). */
  machines?: (db: Db) => MachinePool;
}

export interface Core { service: GitHubService; db: Db; gh: GitHubApp }

/** The database, the GitHub client and the service: what the HTTP side, the worker and the sweep share. */
export function buildCore(cfg: Config, log: Logger, launcherOrFactory: RunnerLauncher | ((db: Db) => RunnerLauncher) | null = null): Core {
  const db = new Db(cfg.databaseUrl, cfg.dbPoolMax);
  const launcher = typeof launcherOrFactory === "function" ? launcherOrFactory(db) : launcherOrFactory;
  const gh = new GitHubApp({ apiUrl: cfg.apiUrl, appId: cfg.appId, privateKey: cfg.privateKey, timeoutMs: cfg.githubTimeoutMs });
  const service = new GitHubService(db, gh, {
    runsOnLabel: cfg.runsOnLabel, onboardingBranch: cfg.onboardingBranch, onboardAllRepositories: cfg.onboardAllRepositories,
    dashboardUrl: cfg.dashboardUrl, webUrl: cfg.webUrl, summaryWaitSeconds: cfg.summaryWaitSeconds,
    ...(cfg.runnerTokens[0] ? { summaryKey: cfg.runnerTokens[0] } : {}), cacheSigningKey: cfg.cacheSigningKey, warmup: cfg.warmup,
  }, log, launcher);
  return { service, db, gh };
}

declare module "fastify" {
  interface FastifyRequest { rawBody?: Buffer }
}

const EVENTS = new Set(["installation", "installation_repositories", "repository", "push", "pull_request", "workflow_job", "ping"]);

/**
 * The request log: never the Authorization or signature headers, and never the query string, since /github/setup
 * carries the one-time OAuth code and the signed state in it (R-012 F18).
 */
export function loggerOptions(level: string) {
  return {
    level, redact: ["req.headers.authorization", "req.headers[\"x-hub-signature-256\"]"],
    serializers: { req: (r: { method: string; url: string; hostname?: string; ip?: string }) => ({ method: r.method, url: r.url.split("?")[0], hostname: r.hostname, remoteAddress: r.ip }) },
  };
}

export async function buildApp(deps: Deps): Promise<App> {
  const { cfg } = deps;
  if (cfg.surface !== "all") throw new Error("buildApp needs the HTTP secrets (loadConfig with surface \"all\")");
  const fastify = Fastify({
    logger: deps.logger ?? loggerOptions(cfg.logLevel),
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });
  const { service, db, gh } = buildCore(cfg, fastify.log, deps.launcher ?? null);
  const queue = deps.queue ?? new InProcessQueue(service);

  // The raw bytes are kept: the webhook signature is computed over them, not over re-serialised JSON.
  fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, {});
    try { done(null, JSON.parse((body as Buffer).toString("utf8"))); } catch {
      const e = new Error("The body is not JSON.") as Error & { statusCode: number };
      e.statusCode = 400;
      done(e, undefined);
    }
  });

  const fail = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } });

  /** 202 once the work is accepted; 503 if the queue refused it (GitHub shows the delivery as failed; redeliver it). */
  const handOff = async (req: FastifyRequest, reply: FastifyReply, work: Work) => {
    try {
      await queue.enqueue(work);
    } catch (e) {
      req.log.error({ err: e instanceof Error ? e.message : String(e), work: describeWork(work) }, "could not queue the work");
      return fail(reply, 503, "queue_unavailable", "The work could not be queued. Try again.");
    }
    return reply.code(202).send({ ok: true });
  };

  fastify.get("/healthz", async () => ({ ok: true }));

  // ---------------------------------------------------------------- our machines: hello, poll, events
  // src/machines/pool.ts. A machine boots with a single-use boot secret, exchanges it for its session credential, then
  // fetches the work offered to its own slots. docs/data-contract.md "Our machines".
  const machines: MachinePool | null = service.pool?.pool ?? deps.machines?.(db) ?? null;
  if (machines) {
    fastify.post("/v1/runner/machine/hello", { bodyLimit: 4 * 1024 }, async (req, reply) => {
      const b = (req.body ?? {}) as { machineId?: unknown; bootSecret?: unknown; engineVersion?: unknown };
      if (typeof b.machineId !== "number" || typeof b.bootSecret !== "string") return fail(reply, 400, "bad_request", "machineId and bootSecret are required.");
      const ev = typeof b.engineVersion === "string" && /^[\x20-\x7e]{1,200}$/.test(b.engineVersion) ? b.engineVersion : null;
      const r = await machines.hello(b.machineId, b.bootSecret, ev);
      if (!r) return fail(reply, 401, "unauthorized", "Unknown machine, or its boot secret was already used.");
      return reply.send(r);
    });
    fastify.post("/v1/runner/machine/poll", { bodyLimit: 4 * 1024 }, async (req, reply) => {
      const scope = verifyMachineCredential(cfg.runnerTokens, req.headers.authorization);
      if (!scope) return fail(reply, 401, "unauthorized", "This machine's session credential is required.");
      const b = (req.body ?? {}) as { holding?: unknown };
      const holding = Array.isArray(b.holding) ? b.holding.filter((x): x is number => typeof x === "number") : [];
      const r = await machines.poll(scope, holding);
      if (!r) return fail(reply, 401, "unauthorized", "This session ended: say hello again (or retire).");
      return reply.header("cache-control", "no-store").send(r);
    });
    fastify.post("/v1/runner/replays", { bodyLimit: 8 * 1024 }, async (req, reply) => {
      const scope = verifyMachineCredential(cfg.runnerTokens, req.headers.authorization);
      if (!scope || !(await machines.alive(scope))) return fail(reply, 401, "unauthorized", "This machine's current session credential is required.");
      const b = (req.body ?? {}) as Record<string, unknown>;
      const n = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1000;
      if (!n(b.leaseId) || !n(b.done) || !n(b.fails) || (b.fails as number) > (b.done as number) || typeof b.identicalFingerprint !== "boolean"
        || !(b.matchesDefect === null || typeof b.matchesDefect === "boolean") || (b.detail !== undefined && typeof b.detail !== "string")) {
        return fail(reply, 400, "bad_request", "leaseId, done, fails (<= done), identicalFingerprint, matchesDefect (boolean or null) are required.");
      }
      const ok = await service.receiveReplay(scope.machineId, { leaseId: b.leaseId as number, done: b.done as number, fails: b.fails as number,
        identicalFingerprint: b.identicalFingerprint as boolean, matchesDefect: b.matchesDefect as boolean | null, detail: String(b.detail ?? "") });
      if (!ok) return fail(reply, 403, "forbidden", "This lease is not a replay of this machine.");
      return reply.code(202).send({ ok: true });
    });
    fastify.post("/v1/runner/machine/events", { bodyLimit: 8 * 1024 }, async (req, reply) => {
      const scope = verifyMachineCredential(cfg.runnerTokens, req.headers.authorization);
      if (!scope) return fail(reply, 401, "unauthorized", "This machine's session credential is required.");
      const b = (req.body ?? {}) as { type?: unknown; leaseId?: unknown; detail?: unknown };
      if (b.type !== "finished" && b.type !== "prepared" && b.type !== "interrupted") return fail(reply, 400, "bad_request", "type is finished, prepared or interrupted.");
      if (b.leaseId !== undefined && (typeof b.leaseId !== "number" || !Number.isSafeInteger(b.leaseId))) return fail(reply, 400, "bad_request", "leaseId is a number.");
      const ok = await machines.event(scope, { type: b.type, ...(typeof b.leaseId === "number" ? { leaseId: b.leaseId } : {}), ...(typeof b.detail === "string" ? { detail: b.detail } : {}) });
      if (!ok) return fail(reply, 401, "unauthorized", "This session ended.");
      return reply.code(202).send({ ok: true });
    });
  }

  // ---------------------------------------------------------------- GitHub webhooks
  // GitHub caps webhook payloads at 25 MB (an installation on "All repositories" lists every repository).
  fastify.post("/webhooks/github", { bodyLimit: 26 * 1024 * 1024 }, async (req, reply) => {
    const event = String(req.headers["x-github-event"] ?? "");
    const delivery = String(req.headers["x-github-delivery"] ?? "");
    if (!req.rawBody) return fail(reply, 415, "unsupported_media_type", "Set the webhook's content type to application/json.");
    if (!verifySignature(cfg.webhookSecret, req.rawBody, req.headers["x-hub-signature-256"] as string | undefined)) {
      return fail(reply, 401, "bad_signature", "The X-Hub-Signature-256 header does not match the body.");
    }
    if (!event || !delivery || delivery.length > 100) return fail(reply, 400, "bad_request", "X-GitHub-Event and X-GitHub-Delivery are required.");
    if (event === "ping") return reply.code(200).send({ ok: true, pong: true });
    if (!EVENTS.has(event)) return reply.code(202).send({ ok: true, ignored: event });
    const payload = req.body as Record<string, unknown>;
    return handOff(req, reply, { kind: "webhook", event, delivery, payload });
  });

  // ---------------------------------------------------------------- our runners send the run summary
  // Each machine holds its own credential (src/runners/credentials.ts), signed for one runner name and one repository
  // (and, per job, one run). The identity comes from the credential; a body that names another runner, repository or
  // run is refused (R-012 F1). A fleet-wide token is not accepted.
  fastify.post("/v1/runner/summaries", { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    const scope = verifySummaryCredential(cfg.runnerTokens, req.headers.authorization);
    if (!scope) return fail(reply, 401, "unauthorized", "This machine's summary credential is required.");
    // A warm-up machine reports to /v1/runner/warmups only: a warm-up is never a run (no run row, no check, no comment).
    if (scope.warmupId !== undefined) return fail(reply, 403, "forbidden", "A warm-up machine reports to /v1/runner/warmups only.");
    const b = req.body as Record<string, unknown> | undefined;
    const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
    const runId = scope.runId ?? int(b?.runId);
    const runAttempt = b?.runAttempt === undefined ? (scope.runAttempt ?? 1) : int(b.runAttempt);
    const receiptsUrl = b?.receiptsUrl === undefined || b.receiptsUrl === null ? null
      : typeof b.receiptsUrl === "string" && /^https:\/\/[^\s]{1,2000}$/.test(b.receiptsUrl) ? b.receiptsUrl : undefined;
    if (!runId || !runAttempt || receiptsUrl === undefined) {
      return fail(reply, 400, "bad_request", "runId and runAttempt are required (receiptsUrl, if given, is an https URL).");
    }
    if ((b?.repositoryId !== undefined && b.repositoryId !== scope.repositoryId) || (b?.runnerName !== undefined && b.runnerName !== scope.runnerName)
      || (scope.runId !== undefined && b?.runId !== undefined && b.runId !== scope.runId)
      || (scope.runAttempt !== undefined && runAttempt !== scope.runAttempt)) {
      req.log.warn({ runner: scope.runnerName, repositoryId: scope.repositoryId }, "a summary for another runner, repository or run was refused");
      return fail(reply, 403, "forbidden", "This credential is for another runner, repository or run.");
    }
    try { parseSummary(b?.summary); } catch (e) {
      return fail(reply, 422, "bad_summary", e instanceof SummaryError ? e.message : "The summary could not be read.");
    }
    const summary = trimSummary(b!.summary as Record<string, unknown>);
    return handOff(req, reply, { kind: "summary", repositoryId: scope.repositoryId, runId, runAttempt, runnerName: scope.runnerName, receiptsUrl, summary });
  });

  // ---------------------------------------------------------------- our runners: progress, results, explorations
  // openapi/fenvix-api.yaml (tag runner) and docs/data-contract.md "What the runner sends". The same per-machine
  // credential as the summaries; the body is checked against the request schema (400 with the field); a body naming
  // another runner, repository or run is refused (403).
  type Scope = NonNullable<ReturnType<typeof verifySummaryCredential>>;
  const runnerBody = <T>(req: FastifyRequest, reply: FastifyReply, parse: (b: unknown) => T): { scope: Scope; body: T } | null => {
    const scope = verifySummaryCredential(cfg.runnerTokens, req.headers.authorization);
    if (!scope) { void fail(reply, 401, "unauthorized", "This machine's summary credential is required."); return null; }
    if (scope.warmupId !== undefined) { void fail(reply, 403, "forbidden", "A warm-up machine reports to /v1/runner/warmups only."); return null; }
    let body: T;
    try { body = parse(req.body); } catch (e) {
      if (!(e instanceof RecordError)) throw e;
      void reply.code(400).send({ error: { code: "bad_request", message: e.message, field: e.field } });
      return null;
    }
    const j = body as Partial<RunnerJob>;
    // A per-job credential names the job's attempt (review R-016 F7): a record for another attempt is refused.
    if ((j.repositoryId !== undefined && j.repositoryId !== scope.repositoryId) || (j.runnerName !== undefined && j.runnerName !== scope.runnerName)
      || (scope.runId !== undefined && j.runId !== undefined && j.runId !== scope.runId)
      || (scope.runAttempt !== undefined && (j.runAttempt ?? 1) !== scope.runAttempt)) {
      req.log.warn({ runner: scope.runnerName, repositoryId: scope.repositoryId, url: req.url.split("?")[0] }, "a record for another runner, repository or run was refused");
      void fail(reply, 403, "forbidden", "This credential is for another runner, repository or run.");
      return null;
    }
    return { scope, body };
  };

  // Written at once (no queue): the live view polls it. A record older than the stored one is ignored; a job whose
  // run row does not exist yet stores nothing. Both answer 202 like a stored one (the runner does not retry them).
  fastify.post("/v1/runner/progress", { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const r = runnerBody(req, reply, parseProgress);
    if (!r) return reply;
    const p = r.body;
    try {
      await service.receiveProgress({ repositoryId: r.scope.repositoryId, runId: r.scope.runId ?? p.runId, runAttempt: p.runAttempt, runnerName: r.scope.runnerName, progress: p });
    } catch (e) {
      req.log.error({ err: e instanceof Error ? e.message : String(e) }, "progress not stored");
      return fail(reply, 503, "unavailable", "The progress could not be stored. Try again.");
    }
    return reply.code(202).send({ ok: true });
  });

  // One chunk of per-test results (at most 5,000 tests, 2,000 receipts, 6 MB): queued (large ones through the queue's
  // overflow bucket), stored and applied by the worker.
  fastify.post("/v1/runner/results", { bodyLimit: 6 * 1024 * 1024 }, async (req, reply) => {
    const r = runnerBody(req, reply, parseResults);
    if (!r) return reply;
    const results = { ...r.body, runId: r.scope.runId ?? r.body.runId, repositoryId: r.scope.repositoryId, runnerName: r.scope.runnerName };
    // A chunk number at or past the count this chunk declares (chunk 0) is refused here; past the count chunk 0 declared
    // earlier, and past the per-job limits, by the worker (service.receiveResults).
    if (results.chunks !== undefined && results.chunk >= results.chunks) {
      return reply.code(400).send({ error: { code: "bad_request", message: "chunk must be below chunks.", field: "chunk" } });
    }
    return handOff(req, reply, {
      kind: "results", repositoryId: r.scope.repositoryId, runId: results.runId, runAttempt: results.runAttempt, runnerName: r.scope.runnerName, results,
      ...(r.scope.runAttempt !== undefined ? { attemptBound: true } : {}),
    });
  });

  // One night of exploration (at most 6 MB, 500 defects). Not from a CI job's credential (review R-016b G2): a per-job
  // credential names its run, and the job's own steps can read it. Explorations come from a machine whose credential
  // names the repository only; the worker keeps at most one new exploration per project and UTC day, and the newest
  // EXPLORATION_KEEP_NIGHTS of a project (service.receiveExploration).
  fastify.post("/v1/runner/explorations", { bodyLimit: 6 * 1024 * 1024 }, async (req, reply) => {
    const r = runnerBody(req, reply, parseExploration);
    if (!r) return reply;
    if (r.scope.runId !== undefined) {
      req.log.warn({ runner: r.scope.runnerName, repositoryId: r.scope.repositoryId }, "an exploration from a CI job's credential was refused");
      return fail(reply, 403, "forbidden", "A CI job's credential cannot send explorations.");
    }
    return handOff(req, reply, { kind: "exploration", repositoryId: r.scope.repositoryId, runnerName: r.scope.runnerName, exploration: r.body });
  });

  // ---------------------------------------------------------------- warm-up machines report (docs/data-contract.md "Warm-up runs")
  // Only a warm-up machine's own credential (it names the warm-up, the repository and the runner name): written at once,
  // no queue (a few small updates, no GitHub call). 202 for a stored, late or repeated report (the machine does not retry
  // those); 403 for another warm-up's machine; 404 for a warm-up that does not exist.
  fastify.post("/v1/runner/warmups", { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const scope = verifySummaryCredential(cfg.runnerTokens, req.headers.authorization);
    if (!scope) return fail(reply, 401, "unauthorized", "This machine's warm-up credential is required.");
    if (scope.warmupId === undefined) return fail(reply, 403, "forbidden", "Only a warm-up machine reports warm-ups.");
    let body: RunnerWarmupReport;
    try { body = parseWarmupReport(req.body); } catch (e) {
      if (!(e instanceof RecordError)) throw e;
      return reply.code(400).send({ error: { code: "bad_request", message: e.message, field: e.field } });
    }
    if (body.warmupId !== scope.warmupId || (body.repositoryId !== undefined && body.repositoryId !== scope.repositoryId)
      || (body.runnerName !== undefined && body.runnerName !== scope.runnerName)) {
      return fail(reply, 403, "forbidden", "This credential is for another warm-up, repository or runner.");
    }
    if (body.summary) {
      try { parseSummary(body.summary); } catch (e) {
        return fail(reply, 422, "bad_summary", e instanceof SummaryError ? e.message : "The summary could not be read.");
      }
    }
    let res: Awaited<ReturnType<typeof service.warmups.report>>;
    try {
      res = await service.warmups.report({ warmupId: scope.warmupId, repositoryId: scope.repositoryId, runnerName: scope.runnerName }, {
        event: body.event, ...(body.outcome ? { outcome: body.outcome } : {}), ...(body.detail ? { detail: body.detail } : {}),
        ...(body.summary ? { summary: trimSummary(body.summary) } : {}),
      });
    } catch (e) {
      req.log.error({ err: e instanceof Error ? e.message : String(e), warmup: scope.warmupId }, "warm-up report not stored");
      return fail(reply, 503, "unavailable", "The report could not be stored. Try again.");
    }
    if (res === "unknown") return fail(reply, 404, "not_found", "That warm-up does not exist.");
    if (res === "forbidden") return fail(reply, 403, "forbidden", "This credential is for another warm-up's machine.");
    return reply.code(202).send({ ok: true });
  });

  // ---------------------------------------------------------------- connecting an installation to an organization
  // The dashboard asks the dashboard API for the link (POST /v1/github/install-link, src/api/github.ts: a state signed
  // with the same key, naming the organization and the fenvix person who asked).
  // GitHub sends the browser here after the installation ("Setup URL", with "Request user authorization (OAuth) during
  // installation" on). This route does NOT link (review R-016 F1, F2). It checks:
  //   1. the signed state (organization, person, one hour), not used before;
  //   2. the OAuth code, exchanged for the GitHub user's token;
  //   3. that GitHub lists the installation among those this GitHub user can see;
  //   4. that this GitHub user ADMINISTERS the installation's account: the account itself for a User account, an
  //      active organization admin for an Organization (seeing an installation only takes read access to one of its
  //      repositories; F1);
  //   5. (early, for a clear answer) that the fenvix person is an owner or admin of the organization and that the
  //      installation is not another organization's.
  // It then stores a single-use completion (gh_install_completions, 10 minutes, the state consumed) and sends the
  // browser to the dashboard with the completion's one-time code after `#`. The dashboard completes the link through
  // the API with the signed-in person's own token (POST /v1/github/installations/complete), and the database links only
  // if that person is the one the state names (F2): someone who installs the App from another person's link connects
  // nothing to that person's organization.
  fastify.get("/github/setup", async (req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>, reply) => {
    const q = req.query;
    const back = (params: Record<string, string>, fragment?: Record<string, string>) =>
      reply.redirect(`${cfg.dashboardUrl}/projects/connect?${new URLSearchParams(params)}${fragment ? `#${new URLSearchParams(fragment)}` : ""}`, 303);
    if (q.setup_action === "request") return back({ github: "requested" });
    const state = verifyState(cfg.stateSigningKey, q.state);
    if (!state) return back({ github: "error", reason: "expired" });
    const installationId = Number(q.installation_id);
    if (!Number.isInteger(installationId) || installationId <= 0 || !q.code) return back({ github: "error", reason: "incomplete" });
    try {
      const tokenRes = await fetch(`${cfg.oauthUrl}/login/oauth/access_token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "fenvix-github-app" },
        body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code: q.code }),
        signal: AbortSignal.timeout(cfg.githubTimeoutMs),
      });
      const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
      if (!tokenRes.ok || !tok.access_token) return back({ github: "error", reason: "oauth" });
      const user = gh.user(tok.access_token);
      let seen = false;
      for (let page = 1; page <= 10 && !seen; page++) {
        const r = await user.request<{ total_count: number; installations: { id: number }[] }>("GET", "/user/installations", { query: { per_page: 100, page } });
        seen = r.data.installations.some((i) => i.id === installationId);
        if (r.data.installations.length < 100) break;
      }
      if (!seen) return back({ github: "error", reason: "not_yours" });
      // Who the GitHub user is, and the installation's account as GitHub says it now.
      const me = (await user.request<{ id: number; login: string }>("GET", "/user")).data;
      const inst = (await gh.app.request<{ account: { id: number; login: string; type: string } | null }>("GET", `/app/installations/${installationId}`)).data;
      const account = inst.account;
      let administers = false;
      if (account?.type === "User") {
        administers = account.id === me.id;
      } else if (account?.type === "Organization") {
        const m = await user.request<{ role?: string; state?: string }>("GET", `/user/memberships/orgs/${encodeURIComponent(account.login)}`, { allow: [403, 404] });
        administers = m.status === 200 && m.data.role === "admin" && m.data.state === "active";
      }
      if (!administers) {
        req.log.warn({ installationId, account: account?.login ?? null, githubUser: me.login }, "setup refused: the GitHub user does not administer the installation's account");
        return back({ github: "error", reason: "github_not_admin" });
      }
      const pending = await service.prepareLink({ installationId, workspaceId: state.workspaceId, userId: state.userId, stateHash: state.hash, githubUserId: me.id, githubLogin: me.login });
      if (pending.refused !== null) return back({ github: "error", reason: pending.refused });
      return back({ github: "confirm", installation: String(installationId), account: pending.account }, { completion: pending.code });
    } catch (e) {
      const reason = e instanceof GitHubError ? "github" : "error";
      req.log.warn({ err: e instanceof Error ? e.message : String(e), installationId }, "setup failed");
      return back({ github: "error", reason });
    }
  });

  // The setup pull request of one repository: the dashboard API queues it (POST /v1/github/repositories/{id}/setup-pull-request,
  // work kind "onboard").

  let timer: NodeJS.Timeout | null = null;
  let warmTimer: NodeJS.Timeout | null = null;
  return {
    fastify, service, db, gh,
    startBackground() {
      if (cfg.sweepSeconds > 0) {
        timer = setInterval(() => service.background("sweep", () => service.sweep()), cfg.sweepSeconds * 1000);
        timer.unref();
      }
      if (cfg.warmupTickSeconds > 0 && service.warmups.active) {
        warmTimer = setInterval(() => service.background("warm-up tick", () => service.warmups.tick()), cfg.warmupTickSeconds * 1000);
        warmTimer.unref();
      }
    },
    async close() {
      if (timer) clearInterval(timer);
      if (warmTimer) clearInterval(warmTimer);
      await fastify.close();
      await service.idle();
      await db.close();
    },
  };
}
