/**
 * A database's own users ("Database Access"): the user names and passwords a customer's application connects with.
 * The browser only ever talks to the control plane (`/v1/databases/:id/users`). A password comes back once, in the
 * answer that made it (create or reset), and is never sent again.
 */
export type DbUserRole = "readWrite" | "read";

export interface DbUser {
  username: string;
  /** "other" when the engine holds a role that is not one of the two (made outside FENVIX). */
  role: DbUserRole | "other";
  createdAt: string | null;
}

export interface DbUserSecret {
  user: DbUser;
  /** Shown once. */
  password: string;
  /** The connection string with this user and this password in it. */
  connectionString: string;
}

export interface UsersClient {
  listUsers(databaseId: string): Promise<{ items: DbUser[]; limit: number }>;
  createUser(databaseId: string, username: string, role: DbUserRole): Promise<DbUserSecret>;
  resetPassword(databaseId: string, username: string): Promise<DbUserSecret>;
  deleteUser(databaseId: string, username: string): Promise<void>;
}

export const ROLE_LABELS: Record<DbUser["role"], string> = { readWrite: "Read and write", read: "Read only", other: "Other" };

/** The control plane's rule (control-plane/src/services/db-users.ts), to explain a refusal before sending. */
export function usernameProblem(name: string): string | null {
  if (!/^[a-z][a-z0-9_-]{2,31}$/.test(name)) return "Use 3 to 32 lowercase letters, numbers, _ or -, starting with a letter.";
  if (/^(cp_|cp-|fenvix|mongo|system|__)/.test(name) || ["admin", "root", "system", "local", "config", "provisioner"].includes(name)) return "That name is reserved. Choose another one.";
  return null;
}
