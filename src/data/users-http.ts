import { call } from "./explorer-http";
import type { DbUserSecret, UsersClient } from "./users";

/** Database users over HTTP, to the control plane at VITE_API_URL, the same way as the Data Explorer (explorer-http.ts). */
const base = (db: string) => `/databases/${encodeURIComponent(db)}/users`;
const one = (db: string, name: string) => `${base(db)}/${encodeURIComponent(name)}`;

export const httpUsers: UsersClient = {
  listUsers: (db) => call("GET", base(db)),
  createUser: (db, username, role) => call<DbUserSecret>("POST", base(db), { username, role }),
  resetPassword: (db, username) => call<DbUserSecret>("POST", `${one(db, username)}/reset-password`),
  async deleteUser(db, username) {
    await call("DELETE", one(db, username));
  },
};
