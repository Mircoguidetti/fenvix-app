/**
 * A fake GitHub (REST API + the OAuth token exchange) on a local port. It keeps real state (branches, files, pull
 * requests, check runs, comments), answers with GitHub's own example responses (from GitHub's OpenAPI description)
 * with our values put in, checks authentication the way GitHub does (App JWT signed with the App's key, installation
 * tokens limited to their installation's repositories, user tokens), and records every exchange so the tests can
 * check each one against GitHub's REST description.
 */
import { createHash, createVerify, randomBytes, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { checkExchange, exampleResponse, type Problem } from "./schemas.ts";

type Json = Record<string, unknown>;

export interface Exchange {
  method: string; path: string; query: Record<string, string>; body: unknown; status: number; response: unknown;
  operationId?: string | null; problems?: Problem[];
  /** When it happened (performance.now()), to put webhooks, runner calls and API calls in one order. */
  at?: number;
}

interface Branch { sha: string; files: Map<string, { text: string; sha: string }> }
export interface FakeRepo {
  id: number; owner: string; ownerId: number; name: string; fullName: string; defaultBranch: string; private: boolean; archived: boolean;
  branches: Map<string, Branch>;
  pulls: { number: number; title: string; body: string; head: string; base: string; state: string; headSha: string }[];
  checkRuns: Map<number, Json>;
  comments: Map<number, { id: number; issue: number; body: string; byApp: boolean }>;
  runs: Map<number, { event: string; createdAt: string; headSha: string; headBranch: string; message: string; pullRequests: number[]; headRepoId?: number }>;
  /** Just-in-time runners created (generate-jitconfig). */
  jitRunners: { id: number; name: string; labels: string[]; runnerGroupId: number; config: string }[];
  /** Registration tokens handed out, and the self-hosted runners registered with them (the tests register them). */
  registrationTokens: string[];
  runners: { id: number; name: string; status: "online" | "offline"; busy: boolean }[];
}

export interface FakeInstallation { id: number; account: { login: string; id: number; type: "User" | "Organization" }; repos: number[]; selection: "all" | "selected" }

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
let seq = 1000;
const nextId = () => ++seq;

export class FakeGitHub {
  readonly exchanges: Exchange[] = [];
  readonly repos = new Map<string, FakeRepo>();
  readonly installations = new Map<number, FakeInstallation>();
  /** OAuth codes → user token; user token → installations that person can see. */
  readonly oauthCodes = new Map<string, string>();
  readonly userInstallations = new Map<string, number[]>();
  private readonly tokens = new Map<string, number>();
  private server!: Server;
  url = "";
  /** Answers to force, e.g. a 500 on the next check run: method + path → status. */
  readonly failNext = new Map<string, number>();

  private readonly appId: number;
  private readonly appKey: KeyObject;

  constructor(appId: number, appKey: KeyObject) { this.appId = appId; this.appKey = appKey; }

  async start(): Promise<void> {
    this.server = createServer((req, res) => { void this.serve(req, res); });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const a = this.server.address();
    this.url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  // ---------------------------------------------------------------- setting the scene

  addInstallation(i: FakeInstallation): void { this.installations.set(i.id, i); }

  addRepo(o: { id: number; fullName: string; ownerId: number; defaultBranch?: string; files: Record<string, string>; private?: boolean }): FakeRepo {
    const [owner, name] = o.fullName.split("/") as [string, string];
    const files = new Map(Object.entries(o.files).map(([p, t]) => [p, { text: t, sha: sha1(`blob ${t}`) }]));
    const repo: FakeRepo = {
      id: o.id, owner, ownerId: o.ownerId, name, fullName: o.fullName, defaultBranch: o.defaultBranch ?? "main", private: o.private ?? true, archived: false,
      branches: new Map([[o.defaultBranch ?? "main", { sha: sha1(o.fullName + "base"), files }]]),
      pulls: [], checkRuns: new Map(), comments: new Map(), runs: new Map(), jitRunners: [], registrationTokens: [], runners: [],
    };
    this.repos.set(o.fullName, repo);
    return repo;
  }

  /** `headRepoId`: the repository the run's code comes from (another id: a pull request from a fork). */
  addRun(fullName: string, runId: number, r: { event: string; headSha: string; headBranch: string; message: string; pullRequests?: number[]; createdAt?: string; headRepoId?: number }): void {
    this.repos.get(fullName)!.runs.set(runId, { ...r, pullRequests: r.pullRequests ?? [], createdAt: r.createdAt ?? new Date().toISOString() });
  }

  /** Checks every recorded exchange against GitHub's REST description; returns the ones with problems. */
  validateAll(): Exchange[] {
    const bad: Exchange[] = [];
    for (const x of this.exchanges) {
      if (x.path.startsWith("/login/oauth/")) { x.operationId = "oauth/access-token (not in the REST description)"; x.problems = []; continue; }
      const r = checkExchange(x);
      x.operationId = r.operationId;
      x.problems = r.problems;
      if (r.problems.length) bad.push(x);
    }
    return bad;
  }

  // ---------------------------------------------------------------- serving

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const u = new URL(req.url ?? "/", "http://x");
    const query = Object.fromEntries(u.searchParams);
    let body: unknown = undefined;
    if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
    const method = req.method ?? "GET";
    const path = decodeURIComponent(u.pathname);
    let status = 500; let response: unknown = { message: "fake: unhandled" };
    try {
      const forced = this.failNext.get(`${method} ${u.pathname}`) ?? this.failNext.get(`${method} *`);
      if (forced) { this.failNext.delete(`${method} ${u.pathname}`); this.failNext.delete(`${method} *`); [status, response] = [forced, { message: "fake: forced failure", documentation_url: "https://docs.github.com/rest" }]; }
      else [status, response] = this.route(method, u.pathname, query, body, req.headers.authorization ?? "");
    } catch (e) {
      [status, response] = [500, { message: `fake: ${e instanceof Error ? e.message : String(e)}` }];
    }
    this.exchanges.push({ method, path, query, body, status, response, at: performance.now() });
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(status === 204 ? "" : JSON.stringify(response));
  }

  private appAuth(auth: string): boolean {
    const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(auth);
    if (!m) return false;
    const ok = createVerify("RSA-SHA256").update(`${m[1]}.${m[2]}`).verify(this.appKey, Buffer.from(m[3]!, "base64url"));
    if (!ok) return false;
    const p = JSON.parse(Buffer.from(m[2]!, "base64url").toString()) as { iss: string; exp: number; iat: number };
    const now = Date.now() / 1000;
    return p.iss === String(this.appId) && p.exp > now && p.exp - p.iat <= 600;
  }

  private installationOf(auth: string): number | null {
    const m = /^Bearer (ghs_\w+)$/.exec(auth);
    return m ? (this.tokens.get(m[1]!) ?? null) : null;
  }

  private notFound(): [number, Json] { return [404, { message: "Not Found", documentation_url: "https://docs.github.com/rest", status: "404" }]; }

  private route(method: string, p: string, q: Record<string, string>, body: unknown, auth: string): [number, unknown] {
    let m: RegExpExecArray | null;
    // ---- OAuth (github.com, not the API)
    if (method === "POST" && p === "/login/oauth/access_token") {
      const code = (body as { code?: string })?.code ?? "";
      const token = this.oauthCodes.get(code);
      if (!token) return [200, { error: "bad_verification_code" }];
      this.oauthCodes.delete(code);
      return [200, { access_token: token, token_type: "bearer", scope: "" }];
    }
    // ---- as a person
    if (method === "GET" && p === "/user/installations") {
      const t = /^Bearer (gho_\w+)$/.exec(auth)?.[1];
      if (!t || !this.userInstallations.has(t)) return [401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest", status: "401" }];
      const ex = exampleResponse("GET", "/user/installations", 200);
      const template = (ex.installations as Json[])[0]!;
      const list = this.userInstallations.get(t)!.map((id) => this.installationJson(id, template));
      return [200, { total_count: list.length, installations: list }];
    }
    // ---- as the App
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p)) && method === "POST") {
      if (!this.appAuth(auth)) return [401, { message: "A JSON web token could not be decoded", documentation_url: "https://docs.github.com/rest", status: "401" }];
      const id = Number(m[1]);
      if (!this.installations.has(id)) return this.notFound();
      const token = "ghs_" + randomBytes(18).toString("hex");
      this.tokens.set(token, id);
      const ex = exampleResponse("POST", "/app/installations/{installation_id}/access_tokens", 201);
      delete ex.repositories;
      return [201, { ...ex, token, expires_at: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d+Z$/, "Z"), repository_selection: this.installations.get(id)!.selection }];
    }
    if ((m = /^\/app\/installations\/(\d+)$/.exec(p)) && method === "GET") {
      if (!this.appAuth(auth)) return [401, { message: "A JSON web token could not be decoded", documentation_url: "https://docs.github.com/rest", status: "401" }];
      const id = Number(m[1]);
      if (!this.installations.has(id)) return this.notFound();
      return [200, this.installationJson(id, exampleResponse("GET", "/app/installations/{installation_id}", 200))];
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(p)) && method === "GET") {
      if (!this.appAuth(auth)) return [401, { message: "A JSON web token could not be decoded", documentation_url: "https://docs.github.com/rest", status: "401" }];
      const repo = this.repos.get(`${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`);
      const inst = repo ? [...this.installations.values()].find((i) => i.repos.includes(repo.id)) : undefined;
      if (!inst) return this.notFound();
      return [200, this.installationJson(inst.id, exampleResponse("GET", "/repos/{owner}/{repo}/installation", 200))];
    }
    // ---- as an installation, on a repository
    if (!(m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p))) return this.notFound();
    const inst = this.installationOf(auth);
    const repo = this.repos.get(`${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`);
    if (!inst || !repo || !this.installations.get(inst)!.repos.includes(repo.id)) {
      return inst ? this.notFound() : [401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest", status: "401" }];
    }
    const rest = m[3] ?? "";

    if (method === "GET" && rest === "") return [200, this.repoJson(repo, exampleResponse("GET", "/repos/{owner}/{repo}", 200))];

    if (method === "GET" && (m = /^\/contents\/(.+)$/.exec(rest))) {
      const path = decodeURIComponent(m[1]!);
      const br = repo.branches.get(q.ref ?? repo.defaultBranch);
      if (!br) return this.notFound();
      const file = br.files.get(path);
      if (file) {
        const ex = exampleResponse("GET", "/repos/{owner}/{repo}/contents/{path}", 200, "response-if-content-is-a-file");
        return [200, { ...ex, ...this.entry(repo, path, file.sha, file.text.length, "file"), content: Buffer.from(file.text).toString("base64"), encoding: "base64" }];
      }
      const kids = [...br.files.entries()].filter(([fp]) => fp.startsWith(path + "/") && !fp.slice(path.length + 1).includes("/"));
      if (!kids.length) return this.notFound();
      return [200, kids.map(([fp, f]) => this.entry(repo, fp, f.sha, f.text.length, "file"))];
    }
    if (method === "GET" && rest === "/pulls") {
      const [ownerQ, head] = (q.head ?? "").split(":");
      const list = repo.pulls.filter((pr) => (!q.state || q.state === "all" || pr.state === q.state) && (!q.head || (ownerQ === repo.owner && pr.head === head)));
      const ex = (exampleResponse("GET", "/repos/{owner}/{repo}/pulls", 200) as unknown as Json[])[0]!;
      return [200, list.map((pr) => this.pullJson(repo, pr, ex))];
    }
    if (method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const br = repo.branches.get(decodeURIComponent(m[1]!));
      if (!br) return this.notFound();
      return [200, this.refJson(repo, decodeURIComponent(m[1]!), br.sha)];
    }
    if (method === "POST" && rest === "/git/refs") {
      const b = body as { ref: string; sha: string };
      const name = b.ref.replace(/^refs\/heads\//, "");
      if (repo.branches.has(name)) return [422, { message: "Reference already exists", documentation_url: "https://docs.github.com/rest/git/refs#create-a-reference", status: "422" }];
      const from = [...repo.branches.values()].find((x) => x.sha === b.sha);
      if (!from) return [422, { message: "Object does not exist", documentation_url: "https://docs.github.com/rest", status: "422" }];
      repo.branches.set(name, { sha: b.sha, files: new Map(from.files) });
      return [201, this.refJson(repo, name, b.sha)];
    }
    if (method === "PATCH" && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const name = decodeURIComponent(m[1]!);
      const b = body as { sha: string };
      const from = [...repo.branches.values()].find((x) => x.sha === b.sha);
      if (!repo.branches.has(name) || !from) return [422, { message: "Reference does not exist", documentation_url: "https://docs.github.com/rest", status: "422" }];
      repo.branches.set(name, { sha: b.sha, files: new Map(from.files) });
      return [200, this.refJson(repo, name, b.sha)];
    }
    if (method === "PUT" && (m = /^\/contents\/(.+)$/.exec(rest))) {
      const path = decodeURIComponent(m[1]!);
      const b = body as { message: string; content: string; sha?: string; branch?: string };
      const br = repo.branches.get(b.branch ?? repo.defaultBranch);
      if (!br) return this.notFound();
      const cur = br.files.get(path);
      if (cur && cur.sha !== b.sha) return [409, { message: `${path} does not match ${b.sha}`, documentation_url: "https://docs.github.com/rest", status: "409" }];
      const text = Buffer.from(b.content, "base64").toString("utf8");
      const blob = sha1(`blob ${text}`);
      br.files.set(path, { text, sha: blob });
      br.sha = sha1(br.sha + blob);
      const ex = exampleResponse("PUT", "/repos/{owner}/{repo}/contents/{path}", 200);
      return [200, { ...ex, content: { ...(ex.content as Json), ...this.entry(repo, path, blob, text.length, "file") }, commit: { ...(ex.commit as Json), sha: br.sha, message: b.message } }];
    }
    if (method === "POST" && rest === "/pulls") {
      const b = body as { title: string; head: string; base: string; body?: string };
      if (!repo.branches.has(b.head)) return [422, { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "head", code: "invalid" }], documentation_url: "https://docs.github.com/rest", status: "422" }];
      const number = repo.pulls.length + 1;
      const pr = { number, title: b.title, body: b.body ?? "", head: b.head, base: b.base, state: "open", headSha: repo.branches.get(b.head)!.sha };
      repo.pulls.push(pr);
      return [201, this.pullJson(repo, pr, exampleResponse("POST", "/repos/{owner}/{repo}/pulls", 201))];
    }
    if (method === "GET" && (m = /^\/actions\/runs\/(\d+)$/.exec(rest))) {
      const run = repo.runs.get(Number(m[1]));
      if (!run) return this.notFound();
      const ex = exampleResponse("GET", "/repos/{owner}/{repo}/actions/runs/{run_id}", 200);
      const prTemplate = (ex.pull_requests as Json[])[0] ?? { url: "", id: 1, number: 1, head: { ref: "", sha: "", repo: { id: repo.id, url: "", name: repo.name } }, base: { ref: "", sha: "", repo: { id: repo.id, url: "", name: repo.name } } };
      return [200, {
        ...ex, id: Number(m[1]), event: run.event, head_sha: run.headSha, head_branch: run.headBranch, created_at: run.createdAt,
        repository: { ...(ex.repository as Json), id: repo.id }, head_repository: { ...(ex.head_repository as Json), id: run.headRepoId ?? repo.id },
        head_commit: { ...(ex.head_commit as Json), id: run.headSha, message: run.message },
        pull_requests: run.pullRequests.map((n) => {
          const pr = repo.pulls.find((x) => x.number === n);
          return { ...prTemplate, number: n, head: { ...(prTemplate.head as Json), ref: pr?.head ?? run.headBranch, sha: run.headSha }, base: { ...(prTemplate.base as Json), ref: pr?.base ?? repo.defaultBranch } };
        }),
      }];
    }
    if (method === "POST" && rest === "/actions/runners/registration-token") {
      const token = randomBytes(15).toString("hex").toUpperCase().slice(0, 29);
      repo.registrationTokens.push(token);
      return [201, { ...exampleResponse("POST", "/repos/{owner}/{repo}/actions/runners/registration-token", 201), token, expires_at: new Date(Date.now() + 3600_000).toISOString() }];
    }
    if (method === "GET" && rest === "/actions/runners") {
      const ex = exampleResponse("GET", "/repos/{owner}/{repo}/actions/runners", 200);
      const tpl = (ex.runners as Json[])[0]!;
      return [200, { total_count: repo.runners.length, runners: repo.runners.map((r) => ({ ...tpl, id: r.id, name: r.name, status: r.status, busy: r.busy })) }];
    }
    if (method === "DELETE" && (m = /^\/actions\/runners\/(\d+)$/.exec(rest))) {
      // A just-in-time runner is a registered runner too (offline until its machine connects): deleting removes it.
      const j = repo.jitRunners.findIndex((r) => r.id === Number(m![1]));
      if (j >= 0) { repo.jitRunners.splice(j, 1); return [204, null]; }
      const i = repo.runners.findIndex((r) => r.id === Number(m![1]));
      if (i < 0) return this.notFound();
      if (repo.runners[i]!.busy) return [422, { message: "Bad request - Runner \"x\" is still running a job\"", documentation_url: "https://docs.github.com/rest", status: "422" }];
      repo.runners.splice(i, 1);
      return [204, null];
    }
    if (method === "POST" && rest === "/actions/runners/generate-jitconfig") {
      const b = body as { name: string; runner_group_id: number; labels: string[]; work_folder?: string };
      if (repo.jitRunners.some((r) => r.name === b.name)) return [409, { message: "Already exists - A runner with the name already exists.", documentation_url: "https://docs.github.com/rest", status: "409" }];
      const id = nextId();
      const config = Buffer.from(JSON.stringify({ ".runner": id, name: b.name })).toString("base64");
      repo.jitRunners.push({ id, name: b.name, labels: b.labels, runnerGroupId: b.runner_group_id, config });
      const ex = exampleResponse("POST", "/repos/{owner}/{repo}/actions/runners/generate-jitconfig", 201);
      const runner = ex.runner as Json;
      return [201, { ...ex, runner: { ...runner, id, name: b.name, status: "offline", busy: false,
        labels: [...["self-hosted", "Linux", "X64"].map((n, i) => ({ id: i + 1, name: n, type: "read-only" })), ...b.labels.map((n, i) => ({ id: 10 + i, name: n, type: "custom" }))] },
        encoded_jit_config: config }];
    }
    if (method === "POST" && rest === "/check-runs") {
      const b = body as Json;
      const id = nextId();
      const ex = exampleResponse("POST", "/repos/{owner}/{repo}/check-runs", 201, b.status === "completed" ? "example-of-completed-conclusion" : "example-of-in-progress-conclusion");
      const cr = { ...ex, ...this.checkJson(repo, id, b) };
      repo.checkRuns.set(id, cr);
      return [201, cr];
    }
    if (method === "PATCH" && (m = /^\/check-runs\/(\d+)$/.exec(rest))) {
      const id = Number(m[1]);
      const cur = repo.checkRuns.get(id);
      if (!cur) return this.notFound();
      const b = body as Json;
      const cr = { ...cur, ...this.checkJson(repo, id, { ...b, head_sha: cur.head_sha, name: b.name ?? cur.name }) };
      repo.checkRuns.set(id, cr);
      return [200, cr];
    }
    if (method === "GET" && (m = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
      const issue = Number(m[1]);
      const ex = (exampleResponse("GET", "/repos/{owner}/{repo}/issues/{issue_number}/comments", 200) as unknown as Json[])[0]!;
      return [200, [...repo.comments.values()].filter((c) => c.issue === issue).map((c) => this.commentJson(repo, c, ex))];
    }
    if (method === "POST" && (m = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
      const issue = Number(m[1]);
      if (!repo.pulls.some((pr) => pr.number === issue)) return this.notFound();
      const c = { id: nextId(), issue, body: (body as { body: string }).body, byApp: true };
      repo.comments.set(c.id, c);
      return [201, this.commentJson(repo, c, exampleResponse("POST", "/repos/{owner}/{repo}/issues/{issue_number}/comments", 201))];
    }
    if (method === "PATCH" && (m = /^\/issues\/comments\/(\d+)$/.exec(rest))) {
      const c = repo.comments.get(Number(m[1]));
      if (!c) return this.notFound();
      c.body = (body as { body: string }).body;
      return [200, this.commentJson(repo, c, exampleResponse("PATCH", "/repos/{owner}/{repo}/issues/comments/{comment_id}", 200))];
    }
    return this.notFound();
  }

  // ---------------------------------------------------------------- GitHub-shaped JSON from the examples

  private installationJson(id: number, ex: Json): Json {
    // An installation of someone else's App or account that this test did not set up: a plausible stand-in.
    const i = this.installations.get(id) ?? { id, account: { login: `account-${id}`, id: id + 1_000_000, type: "User" as const }, repos: [], selection: "selected" as const };
    return { ...ex, id, account: { ...(ex.account as Json), login: i.account.login, id: i.account.id, type: i.account.type }, repository_selection: i.selection, app_id: this.appId, target_id: i.account.id, target_type: i.account.type, suspended_at: null, suspended_by: null };
  }

  private repoJson(repo: FakeRepo, ex: Json): Json {
    // GitHub's example of this response lacks `language`, which its schema requires (here and in `source`).
    const source = ex.source ? { language: null, ...(ex.source as Json) } : undefined;
    const parent = ex.parent ? { language: null, ...(ex.parent as Json) } : undefined;
    return {
      ...ex, language: (ex.language as string | undefined) ?? "Python", ...(source ? { source } : {}), ...(parent ? { parent } : {}), id: repo.id, name: repo.name, full_name: repo.fullName, private: repo.private, archived: repo.archived, default_branch: repo.defaultBranch,
      owner: { ...(ex.owner as Json), login: repo.owner, id: repo.ownerId }, html_url: `https://github.com/${repo.fullName}`,
    };
  }

  private entry(repo: FakeRepo, path: string, sha: string, size: number, type: string): Json {
    const name = path.split("/").pop()!;
    const api = `https://api.github.com/repos/${repo.fullName}/contents/${path}`;
    const html = `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${path}`;
    const git = `https://api.github.com/repos/${repo.fullName}/git/blobs/${sha}`;
    return { type, size, name, path, sha, url: api, git_url: git, html_url: html, download_url: `https://raw.githubusercontent.com/${repo.fullName}/${repo.defaultBranch}/${path}`, _links: { self: api, git, html } };
  }

  private refJson(repo: FakeRepo, name: string, sha: string): Json {
    return { ref: `refs/heads/${name}`, node_id: "REF_" + sha.slice(0, 8), url: `https://api.github.com/repos/${repo.fullName}/git/refs/heads/${name}`, object: { type: "commit", sha, url: `https://api.github.com/repos/${repo.fullName}/git/commits/${sha}` } };
  }

  private pullJson(repo: FakeRepo, pr: FakeRepo["pulls"][number], ex: Json): Json {
    const head = ex.head as Json; const base = ex.base as Json;
    // GitHub's own example of this response lacks two newer label fields and a team field its schema requires.
    const labels = (ex.labels as Json[] | undefined ?? []).map((l) => ({ archived_at: null, archived_by: null, ...l }));
    const requestedTeams = (ex.requested_teams as Json[] | undefined ?? []).map((t) => ({ type: "organization", ...t }));
    return {
      ...ex, labels, requested_teams: requestedTeams, number: pr.number, title: pr.title, body: pr.body, state: pr.state,
      html_url: `https://github.com/${repo.fullName}/pull/${pr.number}`, url: `https://api.github.com/repos/${repo.fullName}/pulls/${pr.number}`,
      head: { ...head, ref: pr.head, sha: pr.headSha, label: `${repo.owner}:${pr.head}` }, base: { ...base, ref: pr.base, label: `${repo.owner}:${pr.base}` },
    };
  }

  private checkJson(repo: FakeRepo, id: number, b: Json): Json {
    const out: Json = {
      id, name: b.name, head_sha: b.head_sha, status: b.status ?? "queued", conclusion: b.conclusion ?? null,
      external_id: b.external_id ?? "", details_url: b.details_url ?? null, started_at: b.started_at ?? null, completed_at: b.completed_at ?? null,
      url: `https://api.github.com/repos/${repo.fullName}/check-runs/${id}`, html_url: `https://github.com/${repo.fullName}/runs/${id}`,
    };
    const o = b.output as Json | undefined;
    if (o) out.output = { title: o.title ?? null, summary: o.summary ?? null, text: o.text ?? null, annotations_count: 0, annotations_url: `https://api.github.com/repos/${repo.fullName}/check-runs/${id}/annotations` };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }

  private commentJson(repo: FakeRepo, c: { id: number; issue: number; body: string; byApp: boolean }, ex: Json): Json {
    return {
      ...ex, id: c.id, body: c.body, html_url: `https://github.com/${repo.fullName}/pull/${c.issue}#issuecomment-${c.id}`,
      issue_url: `https://api.github.com/repos/${repo.fullName}/issues/${c.issue}`, url: `https://api.github.com/repos/${repo.fullName}/issues/comments/${c.id}`,
      user: { ...(ex.user as Json), login: c.byApp ? "fenvix[bot]" : "someone", type: c.byApp ? "Bot" : "User" },
    };
  }
}
