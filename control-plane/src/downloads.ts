import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived signed links for files this service builds itself (usage CSV, invoice PDF).
 * The link carries what to build and for which workspace; nothing is stored. Anyone holding
 * the link can download that one file until it expires, which is the same as a presigned URL.
 */
export interface DownloadClaim {
  /** Workspace of the file; empty for an engine export, whose link is only ever handed out by an authenticated request. */
  ws: string;
  kind: "usage-csv" | "invoice-pdf" | "engine-export";
  /** Parameters of the file (the usage query, or the invoice id). */
  p: Record<string, unknown>;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signDownload(key: string, claim: DownloadClaim): string {
  const body = b64(JSON.stringify(claim));
  return `${body}.${b64(createHmac("sha256", key).update(body).digest())}`;
}

export function verifyDownload(key: string, token: string, nowMs = Date.now()): DownloadClaim | null {
  const [body, sig] = token.split(".");
  if (!body || !sig || token.split(".").length !== 2) return null;
  const expected = createHmac("sha256", key).update(body).digest();
  let given: Buffer;
  try { given = Buffer.from(sig, "base64url"); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claim = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as DownloadClaim;
    if (typeof claim.exp !== "number" || claim.exp * 1000 < nowMs) return null;
    return claim;
  } catch { return null; }
}
