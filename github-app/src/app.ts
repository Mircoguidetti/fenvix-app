import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { runnerTokenOk, SessionVerifier, signState, verifyState } from "./auth.ts";
import type { Config } from "./config.ts";
import { Db } from "./db.ts";
import { GitHubApp, GitHubError } from "./github/client.ts";
import { verifySignature } from "./github/signature.ts";
import { SummaryError, parseSummary, trimSummary } from "./results/summary.ts";
import { GitHubService } from "./service.ts";

export interface App {
  fastify: FastifyInstance;
  service: GitHubService;
  db: Db;
  gh: GitHubApp;
  startBackground(): void;
  close(): Promise<void>;
}

export interface Deps { cfg: Config; sessions?: SessionVerifier; logger?: boolean | object }

declare module "fastify" {
  interface FastifyRequest { rawBody?: Buffer }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENTS = new Set(["installation", "installation_repositories", "push", "pull_request", "workflow_job", "ping"]);

export async function buildApp(deps: Deps): Promise<App> {
  const { cfg } = deps;
  const fastify = Fastify({
    logger: deps.logger ?? { level: cfg.logLevel, redact: ["req.headers.authorization", "req.headers[\"x-hub-signature-256\"]"] },
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });
  const db = new Db(cfg.databaseUrl, cfg.dbPoolMax);
  const gh = new GitHubApp({ apiUrl: cfg.apiUrl, appId: cfg.appId, privateKey: cfg.privateKey, timeoutMs: cfg.githubTimeoutMs });
  const service = new GitHubService(db, gh, {
    runsOnLabel: cfg.runsOnLabel, onboardingBranch: cfg.onboardingBranch, onboardAllRepositories: cfg.onboardAllRepositories,
    dashboardUrl: cfg.dashboardUrl, webUrl: cfg.webUrl, summaryWaitSeconds: cfg.summaryWaitSeconds,
  }, fastify.log);
  const sessions = deps.sessions ?? new SessionVerifier(cfg.supabaseUrl, cfg.supabaseJwksUrl);

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
    service.background(`webhook ${event} ${delivery}`, () => service.handle(event, delivery, payload));
    return reply.code(202).send({ ok: true });
  });

  // ---------------------------------------------------------------- our runners send the run summary
  fastify.post("/v1/runner/summaries", { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    if (!runnerTokenOk(cfg.runnerTokens, req.headers.authorization)) return fail(reply, 401, "unauthorized", "A runner token is required.");
    const b = req.body as Record<string, unknown> | undefined;
    const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
    const repositoryId = int(b?.repositoryId);
    const runId = int(b?.runId);
    const runAttempt = b?.runAttempt === undefined ? 1 : int(b.runAttempt);
    const runnerName = typeof b?.runnerName === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(b.runnerName) ? b.runnerName : null;
    const receiptsUrl = b?.receiptsUrl === undefined || b.receiptsUrl === null ? null
      : typeof b.receiptsUrl === "string" && /^https:\/\/[^\s]{1,2000}$/.test(b.receiptsUrl) ? b.receiptsUrl : undefined;
    if (!repositoryId || !runId || !runAttempt || !runnerName || receiptsUrl === undefined) {
      return fail(reply, 400, "bad_request", "repositoryId, runId, runAttempt and runnerName are required (receiptsUrl, if given, is an https URL).");
    }
    try { parseSummary(b?.summary); } catch (e) {
      return fail(reply, 422, "bad_summary", e instanceof SummaryError ? e.message : "The summary could not be read.");
    }
    const summary = trimSummary(b!.summary as Record<string, unknown>);
    service.background(`summary ${repositoryId}/${runId}`, () => service.receiveSummary({ repositoryId, runId, runAttempt, runnerName, receiptsUrl, summary }));
    return reply.code(202).send({ ok: true });
  });

  // ---------------------------------------------------------------- connecting an installation to an organization
  fastify.post("/v1/github/install-link", async (req, reply) => {
    const userId = await sessions.userId(req.headers.authorization);
    if (!userId) return fail(reply, 401, "unauthorized", "Sign in first.");
    const workspaceId = (req.body as { workspaceId?: unknown } | undefined)?.workspaceId;
    if (typeof workspaceId !== "string" || !UUID.test(workspaceId)) return fail(reply, 400, "bad_request", "workspaceId is required.");
    if (!(await service.isAdmin(workspaceId, userId))) return fail(reply, 403, "forbidden", "Only an owner or admin of the organization can connect GitHub.");
    const state = signState(cfg.stateSigningKey, { workspaceId, userId });
    return { url: `${cfg.webUrl}/apps/${cfg.appSlug}/installations/new?state=${encodeURIComponent(state)}` };
  });

  // GitHub sends the person here after the installation ("Setup URL", with "Request user authorization (OAuth) during
  // installation" on). Three checks before the link: the signed state, the OAuth code, and that GitHub lists the
  // installation among those the same person can see.
  fastify.get("/github/setup", async (req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>, reply) => {
    const q = req.query;
    const back = (params: Record<string, string>) => reply.redirect(`${cfg.dashboardUrl}/projects/connect?${new URLSearchParams(params)}`, 303);
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
      const login = await service.linkInstallation(installationId, state.workspaceId, state.userId);
      return back({ github: "connected", installation: String(installationId), account: login });
    } catch (e) {
      const code = (e as { code?: string }).code;
      const reason = code === "42501" ? "not_admin" : code === "23505" ? "other_organization" : e instanceof GitHubError ? "github" : "error";
      req.log.warn({ err: e instanceof Error ? e.message : String(e), installationId }, "setup failed");
      return back({ github: "error", reason });
    }
  });

  // The dashboard asks for the onboarding pull request of one repository (e.g. when "All repositories" was chosen).
  fastify.post("/v1/repositories/:repositoryId/onboarding", async (req: FastifyRequest<{ Params: { repositoryId: string } }>, reply) => {
    const userId = await sessions.userId(req.headers.authorization);
    if (!userId) return fail(reply, 401, "unauthorized", "Sign in first.");
    const repositoryId = Number(req.params.repositoryId);
    if (!Number.isInteger(repositoryId) || repositoryId <= 0) return fail(reply, 400, "bad_request", "Not a repository id.");
    const ws = await service.repositoryWorkspace(repositoryId);
    // Unknown, or not this person's organization: the same answer, so ids cannot be probed.
    if (!ws || !(await service.isAdmin(ws, userId))) return fail(reply, 404, "not_found", "No such repository in your organizations.");
    const res = await service.onboard(repositoryId);
    return { state: res.state, detail: res.detail, pullRequest: res.pr ? { number: res.pr.number, url: res.pr.url } : null };
  });

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
