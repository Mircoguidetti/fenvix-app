// Public DNS, read-only: what a CNAME points at right now, as the world sees it. Used when the pipeline cannot write
// DNS itself (no Cloudflare token): a step then waits for the record the founder adds by hand, and stops with the exact
// record to add if it is not there in time. Asked to public resolvers first (a fresh answer, not the runner's cache).
import { promises as dns } from "node:dns";

const PUBLIC = ["1.1.1.1", "8.8.8.8"];

/** The CNAME target of `name` (lowercase, no trailing dot), or null if it has none (yet). */
export async function cnameOf(name, { servers = PUBLIC, resolver } = {}) {
  const ask = async (r) => {
    try {
      const [t] = await r.resolveCname(name);
      return t ? t.replace(/\.$/, "").toLowerCase() : null;
    } catch (e) {
      const code = /** @type {{ code?: string }} */ (e).code;
      if (code === "ENODATA" || code === "ENOTFOUND" || code === "NXDOMAIN") return null;
      throw e;
    }
  };
  if (resolver) return ask(resolver);
  const pub = new dns.Resolver({ timeout: 5000, tries: 2 });
  pub.setServers(servers);
  try { return await ask(pub); } catch { return ask(dns); } // public resolvers unreachable: the runner's own
}

/** Waits until `name` is a CNAME to `target` (true), or the time is up (false). */
export async function waitForCname(name, target, { timeoutMs, everyMs = 20_000, lookup = cnameOf } = {}) {
  const want = target.replace(/\.$/, "").toLowerCase();
  const end = Date.now() + (timeoutMs ?? 0);
  for (;;) {
    let got = null;
    try { got = (await lookup(name))?.replace(/\.$/, "").toLowerCase() ?? null; } catch { got = null; }
    if (got === want) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
