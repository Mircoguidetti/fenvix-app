import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { SessionVerifier, verifyState } from "./auth.ts";
import type { Config } from "./config.ts";
import { Db } from "./db.ts";
import { GitHubApp, GitHubError } from "./github/client.ts";
import { verifySignature } from "./github/signature.ts";
import { parseExploration, parseProgress, parseResults, RecordError, type RunnerJob } from "./results/runner-records.ts";
import { SummaryError, parseSummary, trimSummary } from "./results/summary.ts";
import { verifySummaryCredential } from "./runners/credentials.ts";
import type { RunnerLauncher } from "./runners/launcher.ts";
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
  launcher?: RunnerLauncher;
}

export interface Core { service: GitHubService; db: Db; gh: GitHubApp }

/** The database, the GitHub client and the service: what the HTTP side, the worker and the sweep share. */
export function buildCore(cfg: Config, log: Logger, launcher: RunnerLauncher | null = null): Core {
  const db = new Db(cfg.databaseUrl, cfg.dbPoolMax);
  const gh = new GitHubApp({ apiUrl: cfg.apiUrl, appId: cfg.appId, privateKey: cfg.privateKey, timeoutMs: cfg.githubTimeoutMs });
  const service = new GitHubService(db, gh, {
    runsOnLabel: cfg.runsOnLabel, onboardingBranch: cfg.onboardingBranch, onboardAllRepositories: cfg.onboardAllRepositories,
    dashboardUrl: cfg.dashboardUrl, webUrl: cfg.webUrl, summaryWaitSeconds: cfg.summaryWaitSeconds,
    ...(cfg.runnerTokens[0] ? { summaryKey: cfg.runnerTokens[0] } : {}), cacheSigningKey: cfg.cacheSigningKey,
  }, log, launcher);
  return { service, db, gh };
}

declare module "fastify" {
  interface FastifyRequest { rawBody?: Buffer }
}

const EVENTS = new Set(["installation", "installation_repositories", "push", "pull_request", "workflow_job", "ping"]);

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
    const b = req.body as Record<string, unknown> | undefined;
    const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
    const runId = scope.runId ?? int(b?.runId);
    const runAttempt = b?.runAttempt === undefined ? 1 : int(b.runAttempt);
    const receiptsUrl = b?.receiptsUrl === undefined || b.receiptsUrl === null ? null
      : typeof b.receiptsUrl === "string" && /^https:\/\/[^\s]{1,2000}$/.test(b.receiptsUrl) ? b.receiptsUrl : undefined;
    if (!runId || !runAttempt || receiptsUrl === undefined) {
      return fail(reply, 400, "bad_request", "runId and runAttempt are required (receiptsUrl, if given, is an https URL).");
    }
    if ((b?.repositoryId !== undefined && b.repositoryId !== scope.repositoryId) || (b?.runnerName !== undefined && b.runnerName !== scope.runnerName)
      || (scope.runId !== undefined && b?.runId !== undefined && b.runId !== scope.runId)) {
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
    let body: T;
    try { body = parse(req.body); } catch (e) {
      if (!(e instanceof RecordError)) throw e;
      void reply.code(400).send({ error: { code: "bad_request", message: e.message, field: e.field } });
      return null;
    }
    const j = body as Partial<RunnerJob>;
    if ((j.repositoryId !== undefined && j.repositoryId !== scope.repositoryId) || (j.runnerName !== undefined && j.runnerName !== scope.runnerName)
      || (scope.runId !== undefined && j.runId !== undefined && j.runId !== scope.runId)) {
      req.log.warn({ runner: scope.runnerName, repositoryId: scope.repositoryId, url: req.url.split("?")[0] }, "a record for another runner, repository or run was refused");
      void fail(reply, 403, "forbidden", "This credential is for another runner, repository or run.");
      return null;
    }
    return { scope, body };
  };

  // Written at once (no queue): the live view polls it. A record older than the stored one is ignored; a job whose
  // run row does not exist yet stores nothing. Both answer 202 like a stored one (the runner does not retry them).
  fastify.post("/v1/runner/progress", { bodyLimit: 64 * 1024 }, async (req, reply) => {
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
    return handOff(req, reply, { kind: "results", repositoryId: r.scope.repositoryId, runId: results.runId, runAttempt: results.runAttempt, runnerName: r.scope.runnerName, results });
  });

  fastify.post("/v1/runner/explorations", { bodyLimit: 6 * 1024 * 1024 }, async (req, reply) => {
    const r = runnerBody(req, reply, parseExploration);
    if (!r) return reply;
    return handOff(req, reply, { kind: "exploration", repositoryId: r.scope.repositoryId, runnerName: r.scope.runnerName, exploration: r.body });
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
  return {
    fastify, service, db, gh,
    startBackground() {
      if (cfg.sweepSeconds > 0) {
        timer = setInterval(() => service.background("sweep", () => service.sweep()), cfg.sweepSeconds * 1000);
        timer.unref();
      }
    },
    async close() {
      if (timer) clearInterval(timer);
      await fastify.close();
      await service.idle();
      await db.close();
    },
  };
}
