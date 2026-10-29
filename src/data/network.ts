/**
 * A database's IP allowlist and the addresses the engine has blocked after failed sign-ins (the Network tab). The
 * browser only talks to the control plane (`/v1/databases/:id/ip-allowlist`, `/network/...`), which changes the engine
 * first and then saves the list (control-plane/docs/network-allowlist.md).
 */
export interface IpAllowlist {
  /** The saved list, in the engine's form (`203.0.113.7/32`, `10.0.0.0/8`). Empty: every address is allowed. */
  entries: string[];
  allowAll: boolean;
  maxEntries: number;
  updatedAt: string | null;
  updatedBy: { type: "user" | "api_key" | "system"; id: string | null; name: string | null } | null;
  /** The list the database actually checks: the same as the saved one, another one, or not known right now. */
  engine: { status: "in_sync" | "different" | "unavailable"; entries?: string[]; enforced: boolean | null };
  /** Whether the Data Explorer's own connection skips the list (it should; false means the server is set up wrong). */
  dataExplorer: { trusted: boolean | null };
}

export interface NetworkBlock {
  /** The address, or its /64 for IPv6. */
  ip: string;
  until: string;
  remainingSecs: number;
}

export interface NetworkClient {
  getAllowlist(databaseId: string): Promise<IpAllowlist>;
  setAllowlist(databaseId: string, entries: string[]): Promise<IpAllowlist>;
  reapplyAllowlist(databaseId: string): Promise<IpAllowlist>;
  listBlocks(databaseId: string): Promise<NetworkBlock[]>;
  unblock(databaseId: string, ip: string): Promise<void>;
}
