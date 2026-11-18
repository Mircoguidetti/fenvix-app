import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Checks GitHub's `X-Hub-Signature-256` header: `sha256=` + hex HMAC-SHA256 of the raw request body with the webhook
 * secret. Compared in constant time. The legacy SHA-1 header is never accepted.
 */
export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const given = header.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
}

export function sign(secret: string, rawBody: Buffer | string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}
