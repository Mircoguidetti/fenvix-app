/*
 * The remote MCP server (F-14): coding agents reach fenvix with an organization's API key and install nothing.
 *
 * POST /v1/mcp speaks the Model Context Protocol over streamable HTTP (2025-06-18; JSON responses, no server-sent
 * stream): one JSON-RPC 2.0 message per request; `initialize`, `ping`, `tools/list`, `tools/call`; notifications are
 * answered 202. Every tool is one of the API's own operations, run through the same path as an HTTP request (the
 * key's organization, row level security, the key's scopes, the rate limit): what an agent sees is what the API and
 * the dashboard show. Served at https://api.fenvix.dev/v1/mcp, and at https://mcp.fenvix.dev once that host's DNS
 * record and certificate exist (infra).
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Reply } from "./context.ts";
import type { ApiDb } from "./db.ts";
import { ApiError } from "./errors.ts";
import type { Caller, Execute } from "./server.ts";
import type { Operation } from "./spec.ts";

export const MCP_PROTOCOL = "2025-06-18";

/**
 * What the server tells an agent at `initialize`: the loop fenvix is made for (docs: README, "Remote MCP server").
 * The job logs stay in GitHub Actions (our runners stream them there); fenvix gives the structured cause.
 */
export const MCP_INSTRUCTIONS = [
  "fenvix runs this repository's CI tests deterministically and turns every flaky test into a reproducible defect.",
  "The loop for fixing CI: (1) push your fix; (2) wait_for_run with the commit (or the pull request and projectId) until it",
  "says the runs finished (call it again while callAgain is true); (3) read the failures it returns: for each test the error,",
  "a log excerpt, whether it is new or a known defect, and for flaky tests the first divergent event and the replay command;",
  "(4) get_test_log for a test's full output; (5) for a flaky test, pull_bundle and run the replay command locally, or replay",
  "to replay it on a fenvix machine; fix, push, repeat. failures_for answers the same without waiting.",
  "list_projects, list_runs, list_defects and get_defect browse the rest.",
].join(" ");
const SUPPORTED = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The API operations it runs, and how. */
  run(call: (operationId: string, r: { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown }) => Promise<unknown>, args: Record<string, unknown>): Promise<unknown>;
}

const uuid = { type: "string", format: "uuid" };
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const int = (v: unknown, d: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? Math.min(v, max) : d);

/** How long a waiting tool waits in one call (the API function stops at 29 s): past it, it says "call again". */
export const WAIT_SECONDS = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const target = {
  projectId: { ...uuid, description: "the project (needed with pullRequest)" },
  pullRequest: { type: "integer", minimum: 1, description: "the pull request: its newest commit's runs" },
  commitSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
  runId: uuid,
};
const targetQuery = (a: Record<string, unknown>) => Object.fromEntries(Object.entries({ projectId: a.projectId, pullRequest: a.pullRequest, commitSha: a.commitSha, runId: a.runId })
  .filter(([, v]) => v !== undefined));

export const TOOLS: Tool[] = [
  {
    name: "failures_for",
    description: "The failing and flaky tests of a pull request (with projectId), a commit or a run. For each test: the error, a log excerpt, the defect id, the first divergent event (flaky tests), the replay command, and whether it is a new failure or a known one. status says whether the run is still running.",
    inputSchema: { type: "object", additionalProperties: false, properties: target },
    run: (call, a) => call("listFailures", { query: targetQuery(a) }),
  },
  {
    name: "get_test_log",
    description: "The full output of one test of a run (what the test printed and logged, at most 64 KB), with its failure.",
    inputSchema: { type: "object", required: ["runId", "testId"], additionalProperties: false, properties: { runId: uuid, testId: { type: "string", minLength: 1, maxLength: 2000 } } },
    run: (call, a) => call("getTestLog", { params: { runId: a.runId }, query: { testId: a.testId } }),
  },
  {
    name: "wait_for_run",
    description: `Waits until the fenvix runs of a pushed commit (or a pull request's newest commit) finish, then returns their failures, as failures_for. Waits at most ${WAIT_SECONDS} s per call: when status is still running (or none: GitHub has not started it yet), call it again. This lets an agent push, wait and read in one step.`,
    inputSchema: { type: "object", additionalProperties: false, properties: target },
    run: async (call, a) => {
      const until = Date.now() + WAIT_SECONDS * 1000;
      for (;;) {
        const out = (await call("listFailures", { query: targetQuery(a) })) as { status: string };
        if ((out.status !== "running" && out.status !== "none") || Date.now() > until) return { ...out, waitedUpTo: WAIT_SECONDS, callAgain: out.status === "running" || out.status === "none" };
        await sleep(3000);
      }
    },
  },
  {
    name: "replay",
    description: `Replays a defect on a fenvix machine (fenvix replay of its bundle, 10 times) and returns the result: reproduced, flaky or passed. Waits at most ${WAIT_SECONDS} s per call; while the replay is queued or running, call get_replay with its id. Needs a key with the replay scope.`,
    inputSchema: { type: "object", required: ["defectId"], additionalProperties: false, properties: { defectId: uuid, commitSha: { type: "string", pattern: "^[0-9a-f]{40}$" } } },
    run: async (call, a) => {
      const until = Date.now() + WAIT_SECONDS * 1000;
      let r = (await call("requestDefectReplay", { params: { defectId: a.defectId }, body: a.commitSha ? { commitSha: a.commitSha } : {} })) as { body?: { id: string; state: string } } & { id?: string; state?: string };
      let rep = (r.body ?? r) as { id: string; state: string };
      while ((rep.state === "queued" || rep.state === "running") && Date.now() < until) {
        await sleep(3000);
        rep = (await call("getReplay", { params: { replayId: rep.id } })) as { id: string; state: string };
      }
      return rep;
    },
  },
  {
    name: "list_projects",
    description: "The organization's projects (connected GitHub repositories): id, repository, language, test runner, setup state, the shared cache's state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (call) => call("listProjects", {}),
  },
  {
    name: "list_runs",
    description: "A project's runs on fenvix, newest first: status, commit, branch, pull request, tests run and skipped with proof, flaky defects, minutes saved.",
    inputSchema: { type: "object", required: ["projectId"], additionalProperties: false, properties: {
      projectId: uuid, status: { type: "string", enum: ["all", "passed", "failed"] }, limit: { type: "integer", minimum: 1, maximum: 200 } } },
    run: (call, a) => call("listRuns", { params: { projectId: a.projectId }, query: { scope: "all", status: str(a.status) ?? "all", page: 1, pageSize: int(a.limit, 25, 200) } }),
  },
  {
    name: "list_defects",
    description: "Flaky tests turned into reproducible defects, newest first: test, cause (the first divergent event), seed, minimal order, replay command, how often seen.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      projectId: uuid, state: { type: "string", enum: ["open", "fixed", "muted", "all"] }, limit: { type: "integer", minimum: 1, maximum: 1000 } } },
    run: (call, a) => call("listDefects", { query: { ...(a.projectId ? { projectId: a.projectId } : {}), state: str(a.state) ?? "open", limit: int(a.limit, 50, 1000), offset: 0 } }),
  },
  {
    name: "get_defect",
    description: "One defect with its cause (the first divergent event), seed, minimal order, the replay command, the command that pulls its bundle, its newest replay, and the runs, commits and pull requests that saw it.",
    inputSchema: { type: "object", required: ["defectId"], additionalProperties: false, properties: { defectId: uuid } },
    run: async (call, a) => {
      const defect = await call("getDefect", { params: { defectId: a.defectId } });
      const history = await call("listDefectOccurrences", { params: { defectId: a.defectId }, query: { limit: 20, offset: 0 } });
      return { defect, history };
    },
  },
  {
    name: "pull_bundle",
    description: "The defect's replay bundle (.tar.gz of bundle.json, order.txt and the run's traces), base64. Unpack it into .fenvix/defects/<id> and run the replay command.",
    inputSchema: { type: "object", required: ["defectId"], additionalProperties: false, properties: { defectId: uuid } },
    run: (call, a) => call("downloadDefectBundle", { params: { defectId: a.defectId } }),
  },
  {
    name: "request_replay",
    description: "Replays the defect on a fenvix machine (fenvix replay of its bundle, 10 times) at a commit (default: the newest that saw it). Needs a key with the replay scope. Poll get_replay for the result.",
    inputSchema: { type: "object", required: ["defectId"], additionalProperties: false, properties: { defectId: uuid, commitSha: { type: "string", pattern: "^[0-9a-f]{40}$" } } },
    run: (call, a) => call("requestDefectReplay", { params: { defectId: a.defectId }, body: a.commitSha ? { commitSha: a.commitSha } : {} }),
  },
  {
    name: "get_replay",
    description: "A replay's state and result: requested, dispatched, running, passed, failed or error; runs, fails and the fingerprint.",
    inputSchema: { type: "object", required: ["replayId"], additionalProperties: false, properties: { replayId: uuid } },
    run: (call, a) => call("getReplay", { params: { replayId: a.replayId } }),
  },
];

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** The JSON a tool result carries: a Reply's body, a bundle as base64. */
function toolContent(out: unknown, defectId?: unknown): { content: unknown[]; structuredContent?: unknown } {
  if (out instanceof Reply) {
    if (Buffer.isBuffer(out.body)) {
      return {
        content: [{ type: "resource", resource: { uri: `fenvix://defects/${String(defectId)}/bundle.tar.gz`, mimeType: "application/gzip", blob: out.body.toString("base64") } },
          { type: "text", text: `Bundle of defect ${String(defectId)} (${out.body.length} bytes, sha256 ${out.headers["x-fenvix-bundle-sha256"] ?? ""}). Decode the base64 blob and run: tar -xz -C .fenvix/defects/${String(defectId)}` }],
      };
    }
    out = out.body;
  }
  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
}

export function mcpRoute(fastify: FastifyInstance, o: { db: ApiDb; execute: Execute; operations: Operation[] }): void {
  const byId = new Map(o.operations.map((op) => [op.operationId, op]));
  const unauthorized = (reply: import("fastify").FastifyReply, message: string) => reply.code(401)
    .header("www-authenticate", 'Bearer realm="fenvix", error="invalid_token"').send({ error: { code: "unauthenticated", message } });

  fastify.post("/v1/mcp", { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const m = /^Bearer\s+(fxk_[A-Za-z0-9]{40})$/i.exec(String(req.headers.authorization ?? ""));
    if (!m) return unauthorized(reply, "The fenvix MCP server needs an API key: Authorization: Bearer fxk_... (dashboard → API keys).");
    const k = await o.db.tx("", null, (t) => t.one<{ key_id: string; workspace_id: string; scopes: ("read" | "replay")[] }>(
      "select key_id, workspace_id, scopes from public.api_key_lookup($1)", [createHash("sha256").update(m[1]!).digest("hex")]));
    if (!k) return unauthorized(reply, "This API key is not valid: it was revoked, it expired, or it never existed.");
    const caller: Caller = { userId: "", apiKey: { id: k.key_id, workspaceId: k.workspace_id, scopes: k.scopes }, viaMcp: true };

    const msg = req.body as Rpc | Rpc[] | undefined;
    if (Array.isArray(msg)) return reply.code(200).send(rpcError(null, -32600, "Send one JSON-RPC message per request."));
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return reply.code(200).send(rpcError(msg?.id, -32600, "Not a JSON-RPC 2.0 request."));
    }
    // A notification (no id) or a response from the client: accepted, nothing to answer.
    if (msg.id === undefined || msg.id === null) return reply.code(202).send();
    const id = msg.id;
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
    switch (msg.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL;
        return reply.code(200).header("mcp-protocol-version", SUPPORTED.has(asked) ? asked : MCP_PROTOCOL).send({ jsonrpc: "2.0", id, result: {
          protocolVersion: SUPPORTED.has(asked) ? asked : MCP_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fenvix", title: "fenvix", version: "1.0.0" },
          instructions: MCP_INSTRUCTIONS,
        } });
      }
      case "ping": return reply.code(200).send({ jsonrpc: "2.0", id, result: {} });
      case "tools/list":
        return reply.code(200).send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } });
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return reply.code(200).send(rpcError(id, -32602, `Unknown tool ${String(params.name)}.`));
        const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
        const call = async (operationId: string, r: { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown }) => {
          const op = byId.get(operationId);
          if (!op?.key) throw new ApiError(403, "forbidden", "This tool is not available to API keys.");
          if (op.key === "replay" && !caller.apiKey!.scopes.includes("replay")) throw new ApiError(403, "forbidden", "This API key cannot ask for replays (it lacks the replay scope).");
          return o.execute(op, caller, { ...r, headers: { "x-fenvix-workspace": k.workspace_id }, log: req.log });
        };
        try {
          return reply.code(200).send({ jsonrpc: "2.0", id, result: { ...toolContent(await tool.run(call, args), args.defectId), isError: false } });
        } catch (e) {
          if (e instanceof ApiError) return reply.code(200).send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: e.message }], isError: true } });
          const code = (e as { code?: string }).code;
          if (code === "22P02") return reply.code(200).send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "An id in the arguments is not valid." }], isError: true } });
          req.log.error({ err: e instanceof Error ? e.message : String(e), tool: tool.name }, "MCP tool failed");
          return reply.code(200).send(rpcError(id, -32603, "Something went wrong on our side."));
        }
      }
      default: return reply.code(200).send(rpcError(id, -32601, `Method ${msg.method} is not supported.`));
    }
  });
}
