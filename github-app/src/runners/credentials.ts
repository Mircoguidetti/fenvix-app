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
  /** Unix seconds. */
  exp: number;
}

const SUMMARY_PREFIX = "fxr1.";
const RUNNER = /^[A-Za-z0-9._-]{1,100}$/;
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

const mac = (key: string, data: string) => createHmac("sha256", key).update(SUMMARY_PREFIX).update(data).digest();

export function signSummaryCredential(key: string, s: SummaryScope): string {
  if (!key) throw new Error("no summary signing key (RUNNER_TOKEN)");
  if (!RUNNER.test(s.runnerName) || !posInt(s.repositoryId) || (s.runId !== undefined && !posInt(s.runId)) || !posInt(s.exp)
    || (s.warmupId !== undefined && (!posInt(s.warmupId) || s.runId !== undefined))
    || (s.runAttempt !== undefined && (!posInt(s.runAttempt) || s.runId === undefined))) {
    throw new Error("bad summary credential scope");
  }
  const body = Buffer.from(JSON.stringify({ n: s.runnerName, r: s.repositoryId, ...(s.runId ? { u: s.runId } : {}), ...(s.runAttempt ? { a: s.runAttempt } : {}), ...(s.warmupId ? { w: s.warmupId } : {}), e: s.exp })).toString("base64url");
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
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { n?: unknown; r?: unknown; u?: unknown; a?: unknown; w?: unknown; e?: unknown };
    if (typeof p.n !== "string" || !RUNNER.test(p.n) || !posInt(p.r) || !posInt(p.e) || (p.u !== undefined && !posInt(p.u))) return null;
    if (p.a !== undefined && (!posInt(p.a) || p.u === undefined)) return null;
    if (p.w !== undefined && (!posInt(p.w) || p.u !== undefined)) return null;
    if (p.e * 1000 < now) return null;
    return { runnerName: p.n, repositoryId: p.r, ...(p.u !== undefined ? { runId: p.u as number } : {}), ...(p.a !== undefined ? { runAttempt: p.a as number } : {}), ...(p.w !== undefined ? { warmupId: p.w as number } : {}), exp: p.e };
  } catch {
    return null;
  }
}

/**
 * One shared-cache organization per customer REPOSITORY (audit G-0192, G-0193): `gh-<installation id>-r<repository id>`.
 * A token names one repository's namespace only, so a job of repository A (a pull request from a fork included) can
 * neither read nor write repository B's entries, receipts or runs, even within the same GitHub account.
 */
export const cacheOrgOf = (installationId: number, repositoryId: number): string => {
  if (!posInt(installationId)) throw new Error("bad installation id");
  if (!posInt(repositoryId)) throw new Error("bad repository id");
  return `gh-${installationId}-r${repositoryId}`;
};

/** `jobId`: the GitHub job; a warm-up's token names its warm-up instead (`warmupId`, field `warm`). */
export function signCacheToken(key: KeyObject, t: { installationId: number; repositoryId: number; write: boolean; exp: number } & ({ jobId: number } | { warmupId: number })): string {
  if (key.type !== "private" || key.asymmetricKeyType !== "rsa") throw new Error("the cache signing key must be an RSA private key");
  const who = "jobId" in t ? { job: t.jobId } : { warm: t.warmupId };
  const body = Buffer.from(JSON.stringify({ org: cacheOrgOf(t.installationId, t.repositoryId), w: t.write, exp: t.exp, ...who })).toString("base64url");
  const sig = sign("sha256", Buffer.from(`fxs1.${body}`), key).toString("base64url");
  return `fxs1.${body}.${sig}`;
}

/**
 * A machine's session credential (our machines, src/machines/): `fxm1.<payload>.<HMAC-SHA256>`, keyed with RUNNER_TOKEN.
 * The payload names the machine and its session generation; the API also checks the generation against gh_machines,
 * so a credential stops working the moment its machine retires or says hello again. It lets the machine fetch work
 * for ITS OWN slots and report on them, nothing else: every job credential comes inside a lease.
 */
export interface MachineScope { machineId: number; gen: number; exp: number }
const MACHINE_PREFIX = "fxm1.";
const machineMac = (key: string, data: string) => createHmac("sha256", key).update(MACHINE_PREFIX).update(data).digest();

export function signMachineCredential(key: string, s: MachineScope): string {
  if (!key) throw new Error("no machine signing key (RUNNER_TOKEN)");
  if (!posInt(s.machineId) || !Number.isSafeInteger(s.gen) || s.gen < 1 || !posInt(s.exp)) throw new Error("bad machine credential scope");
  const body = Buffer.from(JSON.stringify({ m: s.machineId, g: s.gen, e: s.exp })).toString("base64url");
  return `${MACHINE_PREFIX}${body}.${machineMac(key, body).toString("base64url")}`;
}

export function verifyMachineCredential(keys: string[], authorization: string | undefined, now = Date.now()): MachineScope | null {
  const m = /^Bearer\s+(\S{1,600})$/i.exec(authorization ?? "");
  if (!m || !m[1]!.startsWith(MACHINE_PREFIX)) return null;
  const parts = m[1]!.slice(MACHINE_PREFIX.length).split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const given = Buffer.from(sig, "base64url");
  if (!keys.some((k) => { if (!k) return false; const w = machineMac(k, body); return w.length === given.length && timingSafeEqual(w, given); })) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { m?: unknown; g?: unknown; e?: unknown };
    if (!posInt(p.m) || !posInt(p.g) || !posInt(p.e) || p.e * 1000 < now) return null;
    return { machineId: p.m, gen: p.g, exp: p.e };
  } catch {
    return null;
  }
}
