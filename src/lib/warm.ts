import type { WarmCache } from "../data/types";

const short = (sha: string) => sha.slice(0, 7);

/**
 * The shared cache of a repository's default branch in words (Projects and Connect). `lead`: "Cache warm since
 * <commit>" or "Cache cold…"; `sub`: one short line (by whom, or the warm-up in flight, or why the last one did not
 * fill it); `detail`: the warm-up's own words (why it waits, how it ended), for the Connect page; `sha`: the commit the
 * cache is warm since.
 */
export function warmCacheText(c: WarmCache): { lead: string; sub: string | null; detail: string | null; sha: string | null } {
  const w = c.warmup;
  const cold = "Cache cold: the first run fills it";
  if (c.state === "warming" && w) {
    const sub = `${w.status === "pending" ? "Warm-up queued for" : "Warming up"} ${short(w.commitSha)}`;
    return { lead: c.commitSha ? `Cache warm since ${short(c.commitSha)}` : "Cache cold", sub, detail: w.detail || null, sha: c.commitSha };
  }
  if (c.state === "warm" && c.commitSha) {
    const sub = c.source === "warmup" ? "by a fenvix warm-up" : c.source === "run" ? "by your run on the default branch" : null;
    return { lead: `Cache warm since ${short(c.commitSha)}`, sub, detail: null, sha: c.commitSha };
  }
  if (w && (w.status === "failed" || w.status === "unsupported" || w.status === "cancelled")) {
    const how = w.status === "unsupported" ? "Warm-up not possible" : w.status === "failed" ? "Warm-up failed" : "Warm-up cancelled";
    return { lead: cold, sub: `${how} (${short(w.commitSha)})`, detail: w.detail || null, sha: null };
  }
  return { lead: cold, sub: null, detail: null, sha: null };
}
