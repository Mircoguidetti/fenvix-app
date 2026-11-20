import { createHmac, sign, timingSafeEqual, type KeyObject } from "node:crypto";

/**
 * Credentials minted for ONE runner machine (docs/REVIEW-R-012.md F1, F3). No machine ever holds a fleet-wide secret.
 *
 * Summary credential (POST /v1/runner/summaries): `fxr1.<payload>.<HMAC-SHA256>`, keyed with RUNNER_TOKEN (an SSM
 * parameter only the HTTP, worker and demo functions read). The payload names the runner, the repository and, for a
 * per-job machine, the run. The App takes the runner's identity from the credential, never from the request body, so
 * a machine (or anyone who stole its credential) can publish a summary only for its own job.
 *
 * Cache token (the shared cache, per-job mode): `fxs1.<payload>.<RSA-SHA256 signature>`, signed with the cache
 * signing key (SSM, worker only); the cache machine verifies it with the public half (infra/github-app/lib/cache/
 * fenvix_cache_auth.py). The payload names one cache organization, one per customer installation, and whether the job
 * may write (trusted refs only).
 */
export interface SummaryScope {
  runnerName: string;
  repositoryId: number;
  /** Per-job machines: the one run the job belongs to. A demo runner serves one repository, any run. */
  runId?: number;
  /**
   * Warm-up machines (src/warmup/): the one warm-up it runs. Such a credential is accepted only by
   * POST /v1/runner/warmups, never for a job's summary, progress, results or exploration.
   */
  warmupId?: number;
  /** Per-job machines: the run attempt of the job (review R-016 F7). Credentials made before it have none. */
  runAttempt?: number;
  /**
   * Task machines (src/tasks/): the one replay or exploration it runs. Accepted only by POST /v1/runner/replays (a
   * replay) or POST /v1/runner/explorations (an exploration job), for that task only.
   */
  task?: { kind: "replay" | "exploration"; id: string };
  /** Unix seconds. */
  exp: number;
}

const SUMMARY_PREFIX = "fxr1.";
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUNNER = /^[A-Za-z0-9._-]{1,100}$/;
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

const mac = (key: string, data: string) => createHmac("sha256", key).update(SUMMARY_PREFIX).update(data).digest();

export function signSummaryCredential(key: string, s: SummaryScope): string {
  if (!key) throw new Error("no summary signing key (RUNNER_TOKEN)");
  if (!RUNNER.test(s.runnerName) || !posInt(s.repositoryId) || (s.runId !== undefined && !posInt(s.runId)) || !posInt(s.exp)
    || (s.warmupId !== undefined && (!posInt(s.warmupId) || s.runId !== undefined))
    || (s.runAttempt !== undefined && (!posInt(s.runAttempt) || s.runId === undefined))
    || (s.task !== undefined && (!TASK_ID.test(s.task.id) || !["replay", "exploration"].includes(s.task.kind) || s.runId !== undefined || s.warmupId !== undefined))) {
    throw new Error("bad summary credential scope");
  }
  const body = Buffer.from(JSON.stringify({ n: s.runnerName, r: s.repositoryId, ...(s.runId ? { u: s.runId } : {}), ...(s.runAttempt ? { a: s.runAttempt } : {}), ...(s.warmupId ? { w: s.warmupId } : {}), ...(s.task ? { t: `${s.task.kind}:${s.task.id}` } : {}), e: s.exp })).toString("base64url");
  return `${SUMMARY_PREFIX}${body}.${mac(key, body).toString("base64url")}`;
}

/** The scope of a valid, unexpired credential signed with one of `keys` (current, previous), or null. */
export function verifySummaryCredential(keys: string[], authorization: string | undefined, now = Date.now()): SummaryScope | null {
  const m = /^Bearer\s+(\S{1,2000})$/i.exec(authorization ?? "");
  if (!m || !m[1]!.startsWith(SUMMARY_PREFIX)) return null;
  const parts = m[1]!.slice(SUMMARY_PREFIX.length).split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const given = Buffer.from(sig, "base64url");
  let ok = false;
  for (const k of keys) {
    if (!k) continue;
    const want = mac(k, body);
    if (given.length === want.length && timingSafeEqual(given, want)) ok = true;
  }
  if (!ok) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { n?: unknown; r?: unknown; u?: unknown; a?: unknown; w?: unknown; t?: unknown; e?: unknown };
    if (typeof p.n !== "string" || !RUNNER.test(p.n) || !posInt(p.r) || !posInt(p.e) || (p.u !== undefined && !posInt(p.u))) return null;
    if (p.a !== undefined && (!posInt(p.a) || p.u === undefined)) return null;
    if (p.w !== undefined && (!posInt(p.w) || p.u !== undefined)) return null;
    let task: SummaryScope["task"];
    if (p.t !== undefined) {
      const m2 = typeof p.t === "string" ? /^(replay|exploration):(.+)$/.exec(p.t) : null;
      if (!m2 || !TASK_ID.test(m2[2]!) || p.u !== undefined || p.w !== undefined) return null;
      task = { kind: m2[1] as "replay" | "exploration", id: m2[2]! };
    }
    if (p.e * 1000 < now) return null;
    return { runnerName: p.n, repositoryId: p.r, ...(p.u !== undefined ? { runId: p.u as number } : {}), ...(p.a !== undefined ? { runAttempt: p.a as number } : {}), ...(p.w !== undefined ? { warmupId: p.w as number } : {}), ...(task ? { task } : {}), exp: p.e };
  } catch {
    return null;
  }
}

/** One shared-cache organization per customer installation. */
export const cacheOrgOf = (installationId: number): string => {
  if (!posInt(installationId)) throw new Error("bad installation id");
  return `gh-${installationId}`;
};

/** `jobId`: the GitHub job; a warm-up's token names its warm-up instead (`warmupId`, field `warm`). */
export function signCacheToken(key: KeyObject, t: { installationId: number; write: boolean; exp: number } & ({ jobId: number } | { warmupId: number })): string {
  if (key.type !== "private" || key.asymmetricKeyType !== "rsa") throw new Error("the cache signing key must be an RSA private key");
  const who = "jobId" in t ? { job: t.jobId } : { warm: t.warmupId };
  const body = Buffer.from(JSON.stringify({ org: cacheOrgOf(t.installationId), w: t.write, exp: t.exp, ...who })).toString("base64url");
  const sig = sign("sha256", Buffer.from(`fxs1.${body}`), key).toString("base64url");
  return `fxs1.${body}.${sig}`;
}
