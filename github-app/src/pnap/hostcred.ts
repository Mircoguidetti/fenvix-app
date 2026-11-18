import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isRegion, type Region } from "./api.ts";

/**
 * Credentials of a phoenixNAP host. No host ever holds a fleet-wide secret, and no guest ever holds a host's.
 *
 * Enrolment secret `fxe1.<host id>.<random>`: made by the scaler for one server, put in that server's cloud-init user
 * data (which phoenixNAP serves on a floppy for the server's whole life), stored here only as its SHA-256, and spent
 * by the first POST /v1/hosts/enrol: a copy read later is worthless.
 *
 * Host credential `fxh1.<payload>.<HMAC-SHA256>`, keyed with HOST_SIGNING_KEY (an SSM parameter only the hosts
 * function reads). The payload names the host, its region and its credential generation, and expires; the App
 * renews it on a lease when it has less than half its life left. A host's credential leases jobs of its own region
 * only, and only while the host is ready (the database decides, not the credential). Bumping pnap_hosts.cred_gen
 * revokes it at once.
 */
export interface HostScope { hostId: string; region: Region; gen: number; exp: number }

const HOST_PREFIX = "fxh1.";
const HOST_ID = /^[a-z0-9-]{3,63}$/;
export const HOST_CREDENTIAL_SECONDS = 12 * 3600;

const mac = (key: string, body: string) => createHmac("sha256", key).update(HOST_PREFIX).update(body).digest();
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export function newEnrolSecret(hostId: string): { token: string; sha256: string } {
  if (!HOST_ID.test(hostId)) throw new Error("bad host id");
  const token = `fxe1.${hostId}.${randomBytes(32).toString("base64url")}`;
  return { token, sha256: sha256(token) };
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The host id named by an enrolment secret (the secret itself is checked against the stored hash). */
export function enrolHostId(authorization: string | undefined): { hostId: string; sha256: string } | null {
  const m = /^Bearer\s+(fxe1\.([a-z0-9-]{3,63})\.[A-Za-z0-9_-]{32,128})$/i.exec(authorization ?? "");
  return m ? { hostId: m[2]!, sha256: sha256(m[1]!) } : null;
}

export function signHostCredential(key: string, s: HostScope): string {
  if (!key || key.length < 32) throw new Error("no host signing key (HOST_SIGNING_KEY)");
  if (!HOST_ID.test(s.hostId) || !isRegion(s.region) || !posInt(s.gen) || !posInt(s.exp)) throw new Error("bad host credential scope");
  const body = Buffer.from(JSON.stringify({ h: s.hostId, r: s.region, g: s.gen, e: s.exp })).toString("base64url");
  return `${HOST_PREFIX}${body}.${mac(key, body).toString("base64url")}`;
}

export function verifyHostCredential(keys: string[], authorization: string | undefined, now = Date.now()): HostScope | null {
  const m = /^Bearer\s+(\S{1,3000})$/i.exec(authorization ?? "");
  if (!m || !m[1]!.startsWith(HOST_PREFIX)) return null;
  const parts = m[1]!.slice(HOST_PREFIX.length).split(".");
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
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { h?: unknown; r?: unknown; g?: unknown; e?: unknown };
    if (typeof p.h !== "string" || !HOST_ID.test(p.h) || !isRegion(p.r) || !posInt(p.g) || !posInt(p.e)) return null;
    if (p.e * 1000 < now) return null;
    return { hostId: p.h, region: p.r, gen: p.g, exp: p.e };
  } catch {
    return null;
  }
}
