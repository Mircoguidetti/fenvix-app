// In-memory IP allowlists and blocks for VITE_DATA_BACKEND=mock (the Playwright checks). Every address is a
// documentation address (RFC 5737, RFC 3849).
import { assertMockCanManage, mockRole } from "./orgs-mock";
import { ExplorerError } from "./explorer";
import { AllowlistError, validateEntries } from "../lib/ip-allowlist";
import type { IpAllowlist, NetworkBlock, NetworkClient } from "./network";

const later = <T>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

/**
 * db_0001 has a list and two blocked addresses; db_0002 has none (every address allowed); db_0003's engine holds
 * another list than the saved one (the "different" state); db_0004's server does not trust the Data Explorer yet (the
 * warning); db_0005's engine never answers (the error state).
 */
interface Stored { entries: string[]; engine: string[] | null; updatedAt: string | null; updatedBy: IpAllowlist["updatedBy"] }
const STORE = new Map<string, Stored>([
  ["db_0001", { entries: ["203.0.113.0/24", "198.51.100.7/32", "2001:db8:4f2a::/48"], engine: null, updatedAt: "2026-10-20T08:12:00Z", updatedBy: { type: "user", id: "u1", name: "Maya Chen" } }],
  ["db_0003", { entries: ["192.0.2.0/24"], engine: ["0.0.0.0/0"], updatedAt: "2026-10-02T15:30:00Z", updatedBy: { type: "api_key", id: "k1", name: "deploy key" } }],
]);
const BLOCKS = new Map<string, NetworkBlock[]>([
  ["db_0001", [
    { ip: "203.0.113.45", until: new Date(Date.now() + 4 * 60_000).toISOString(), remainingSecs: 240 },
    { ip: "2001:db8:4f2a:17::/64", until: new Date(Date.now() + 52 * 60_000).toISOString(), remainingSecs: 3120 },
  ]],
]);

const down = (db: string) => {
  if (db === "db_0005") throw new ExplorerError("unavailable", "The database engine did not answer. Try again in a moment.", 503);
};
const stored = (db: string): Stored => STORE.get(db) ?? { entries: [], engine: null, updatedAt: null, updatedBy: null };

function view(db: string): IpAllowlist {
  const s = stored(db);
  const engine = s.engine ?? s.entries;
  const same = engine.length === s.entries.length && engine.every((e) => s.entries.includes(e));
  return {
    entries: s.entries, allowAll: s.entries.length === 0, maxEntries: 100, updatedAt: s.updatedAt, updatedBy: s.updatedBy,
    engine: { status: same ? "in_sync" : "different", ...(same ? {} : { entries: engine }), enforced: true },
    dataExplorer: { trusted: db !== "db_0004" },
  };
}

function save(db: string, entries: string[]) {
  STORE.set(db, { entries, engine: null, updatedAt: new Date().toISOString(), updatedBy: { type: "user", id: "me", name: "You" } });
}

export const mockNetwork: NetworkClient = {
  async getAllowlist(db) {
    down(db);
    return later(view(db));
  },
  async setAllowlist(db, entries) {
    assertMockCanManage();
    down(db);
    let list: string[];
    try {
      list = validateEntries(entries);
    } catch (e) {
      if (e instanceof AllowlistError) throw new ExplorerError("validation_failed", e.message, 400, e.index === null ? "entries" : `entries[${e.index}]`);
      throw e;
    }
    save(db, list);
    return later(view(db), 250);
  },
  async reapplyAllowlist(db) {
    assertMockCanManage();
    down(db);
    save(db, stored(db).entries);
    return later(view(db));
  },
  async listBlocks(db) {
    if (mockRole() === "member") throw new ExplorerError("forbidden", "Your role in this organization is read only. Ask an owner or admin to do this.", 403);
    down(db);
    return later(BLOCKS.get(db) ?? []);
  },
  async unblock(db, ip) {
    assertMockCanManage();
    const list = BLOCKS.get(db) ?? [];
    const i = list.findIndex((b) => b.ip === ip);
    if (i < 0) throw new ExplorerError("not_found", "That address is not blocked on this database.", 404);
    list.splice(i, 1);
    await later(null);
  },
};
