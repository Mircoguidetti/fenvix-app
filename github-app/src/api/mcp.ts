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

export const TOOLS: Tool[] = [
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
    run: (call, a) => call("getDefectBundle", { params: { defectId: a.defectId } }),
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
          instructions: "fenvix turns flaky CI tests into reproducible defects. list_defects, then get_defect for the cause (first divergent event) and replay command; pull_bundle to replay locally, or request_replay to replay on a fenvix machine.",
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
