import { call } from "./explorer-http";
import type { IpAllowlist, NetworkBlock, NetworkClient } from "./network";

/** The Network tab over HTTP, to the control plane at VITE_API_URL, the same way as the Data Explorer and database users. */
const base = (db: string) => `/databases/${encodeURIComponent(db)}`;

export const httpNetwork: NetworkClient = {
  getAllowlist: (db) => call<IpAllowlist>("GET", `${base(db)}/ip-allowlist`),
  setAllowlist: (db, entries) => call<IpAllowlist>("PUT", `${base(db)}/ip-allowlist`, { entries }),
  reapplyAllowlist: (db) => call<IpAllowlist>("POST", `${base(db)}/ip-allowlist/reapply`),
  async listBlocks(db) {
    return (await call<{ items: NetworkBlock[] }>("GET", `${base(db)}/network/blocks`)).items;
  },
  async unblock(db, ip) {
    await call("POST", `${base(db)}/network/unblock`, { ip });
  },
};
