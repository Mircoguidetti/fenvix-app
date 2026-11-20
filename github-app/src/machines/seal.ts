import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * A lease's work (the just-in-time runner configuration, the job's credentials) waits in gh_leases.payload until its
 * machine takes it, for seconds. It is stored sealed (AES-256-GCM, key derived from the runner signing key with HKDF,
 * the lease id as associated data, so a payload cannot be moved to another lease), and deleted when taken.
 */
const key = (secret: string) => Buffer.from(hkdfSync("sha256", secret, "fenvix-lease-payload", "v1", 32));

export function seal(secret: string, leaseId: number, value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  c.setAAD(Buffer.from(`lease:${leaseId}`));
  const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${body.toString("base64url")}.${c.getAuthTag().toString("base64url")}`;
}

export function unseal<T = unknown>(secrets: string[], leaseId: number, sealed: string): T {
  const [v, iv, body, tag] = sealed.split(".");
  if (v !== "v1" || !iv || !body || !tag) throw new Error("not a sealed payload");
  for (const s of secrets) {
    try {
      const d = createDecipheriv("aes-256-gcm", key(s), Buffer.from(iv, "base64url"));
      d.setAAD(Buffer.from(`lease:${leaseId}`));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8")) as T;
    } catch { /* the next key */ }
  }
  throw new Error("the payload cannot be opened with the current keys");
}
