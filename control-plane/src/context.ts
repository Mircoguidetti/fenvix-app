import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { EngineClient } from "./engine/types.ts";
import type { DataClient } from "./engine/data.ts";
import type { EngineUsers } from "./engine/users.ts";

/** Who is calling and for which workspace. Every service function takes one. */
export interface Caller {
  workspaceId: string;
  actor: { type: "user" | "api_key"; id: string };
  /** Role of the user in the workspace; API keys have none. */
  role: "owner" | "admin" | "member" | null;
  requestId: string;
  ip: string;
}

export interface Services {
  cfg: Config;
  db: Db;
  engine: EngineClient;
  /** The engine's MongoDB listener, for the Data Explorer. */
  data: DataClient;
  /** Per-database engine users (create with the database, drop with it). */
  users: EngineUsers;
  log: FastifyBaseLogger;
}
