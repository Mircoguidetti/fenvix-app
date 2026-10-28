// In-memory database users for VITE_DATA_BACKEND=mock (the Playwright checks). Every name is made up.
import { ExplorerError } from "./explorer";
import { connectionStringFor } from "./connection";
import { type DbUser, type DbUserRole, type DbUserSecret, type UsersClient, usernameProblem } from "./users";

const LIMIT = 20;
const later = <T>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

/**
 * db_0001 has a user whose name is markup, on purpose: the server would never accept it, but the checks prove that a
 * name is shown as text whatever it holds. db_0002 has no users (the empty state). db_0005's engine never answers (the
 * error state).
 */
const STORE = new Map<string, DbUser[]>([
  ["db_0001", [
    { username: "app", role: "readWrite", createdAt: "2026-09-02T09:14:00Z" },
    { username: "reporting", role: "read", createdAt: "2026-09-20T16:40:00Z" },
    { username: "<script>window.__xss='user'</script>", role: "other", createdAt: null },
  ]],
  ["db_0002", []],
]);

/** Passwords as the mock "engine" keeps them: only so the checks can see that a reset changed something. */
const PASSWORDS = new Map<string, string>();

function password(): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  while (out.length < 40) for (const b of crypto.getRandomValues(new Uint8Array(64))) if (b < 248 && out.length < 40) out += abc[b % 62];
  return out;
}

const list = (db: string) => {
  if (db === "db_0005") throw new ExplorerError("unavailable", "The database engine did not answer. Try again in a moment.", 503);
  let l = STORE.get(db);
  if (!l) { l = [{ username: "app", role: "readWrite", createdAt: new Date().toISOString() }]; STORE.set(db, l); }
  return l;
};

function secret(db: string, user: DbUser, name: string): DbUserSecret {
  const pw = password();
  PASSWORDS.set(`${db}/${user.username}`, pw);
  const cs = connectionStringFor(name).connectionString.replace("app:<password>", `${encodeURIComponent(user.username)}:${pw}`);
  return { user, password: pw, connectionString: cs };
}

/** The name the mock's databases are reached by: only used to fill in the connection string. */
const dbName = (db: string) => db.replace(/^db_/, "database-");

/** Called by the mock's createDatabase and forkDatabase: the first user and its password, once. */
export function mockInitialUser(db: string, name: string, username = "app") {
  const user: DbUser = { username, role: "readWrite", createdAt: new Date().toISOString() };
  STORE.set(db, [user]);
  const s = secret(db, user, name);
  return { username, role: "readWrite", password: s.password, connectionString: s.connectionString };
}

export const mockUsers: UsersClient = {
  async listUsers(db) {
    const items = list(db);
    return later({ items: [...items].sort((a, b) => a.username.localeCompare(b.username)), limit: LIMIT });
  },
  async createUser(db, username, role: DbUserRole) {
    const items = list(db);
    const problem = usernameProblem(username);
    if (problem) throw new ExplorerError("validation_failed", problem, 400, "username");
    if (items.some((u) => u.username === username)) throw new ExplorerError("conflict", "A user with that name already exists on this database.", 409, "username");
    if (items.length >= LIMIT) throw new ExplorerError("conflict", `A database can have up to ${LIMIT} users. Delete one first.`, 409);
    const user: DbUser = { username, role, createdAt: new Date().toISOString() };
    items.push(user);
    return later(secret(db, user, dbName(db)));
  },
  async resetPassword(db, username) {
    const user = list(db).find((u) => u.username === username);
    if (!user) throw new ExplorerError("not_found", "That user does not exist.", 404);
    return later(secret(db, user, dbName(db)));
  },
  async deleteUser(db, username) {
    const items = list(db);
    const i = items.findIndex((u) => u.username === username);
    if (i < 0) throw new ExplorerError("not_found", "That user does not exist.", 404);
    items.splice(i, 1);
    PASSWORDS.delete(`${db}/${username}`);
    await later(null);
  },
};
