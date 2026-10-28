import { createHmac, timingSafeEqual } from "node:crypto";
import { engineName } from "./names.ts";

/**
 * Per-database engine users: names and passwords.
 *
 * Every customer database `db_<hex>` has one engine user, `cp_<hex>`, defined on that database (so its
 * authentication database is the database itself) with the single role `readWrite` on it. The engine refuses that
 * user everything outside `db_<hex>` (docs/data-explorer-security.md, "One engine user per database").
 *
 * The password is never stored anywhere: it is derived, when needed, from a master key and the database id with
 * HMAC-SHA256. The master key has a version so it can be rotated: during a rotation two versions are valid (see
 * docs/data-explorer-security.md, "Rotating the master key").
 */
export interface EngineUserKey {
  /** `v1`, `v2`, ...: part of the derivation, so the same secret under two versions gives two passwords. */
  version: string;
  /** Secret. Never logged, never in an error. */
  secret: Buffer;
}

export interface EngineCredential {
  username: string;
  password: string;
  /** The database the user is defined on: the customer database itself. */
  authSource: string;
  /** Which key version made the password. Not secret. */
  version: string;
}

const VERSION = /^v[1-9][0-9]{0,5}$/;
/** 62 characters: letters and digits only, so the password needs no escaping in a URI and SCRAM's SASLprep leaves it as is. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** 40 characters of a 62-letter alphabet: 238 bits. */
export const PASSWORD_LENGTH = 40;
export const MIN_SECRET_LENGTH = 32;

/**
 * `v<N>:<secret>`, the form of ENGINE_USER_KEY. The error never contains the secret.
 * `what` names the variable in the error message.
 */
export function parseEngineUserKey(raw: string, what: string): EngineUserKey {
  const text = raw.trim();
  const colon = text.indexOf(":");
  if (colon <= 0) throw new Error(`${what} must be written as <version>:<secret>, for example v1:<at least ${MIN_SECRET_LENGTH} random characters>`);
  const version = text.slice(0, colon);
  const secret = text.slice(colon + 1);
  if (!VERSION.test(version)) throw new Error(`${what}: the version must be v1, v2, ... (got a version that is not of that form)`);
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`${what}: the secret must be at least ${MIN_SECRET_LENGTH} characters`);
  return { version, secret: Buffer.from(secret, "utf8") };
}

/** The engine user of a database: `cp_` and the 32 hex digits of its id. */
export function engineUserName(id: string): string {
  return `cp_${engineName(id).slice(3)}`;
}

export const isEngineUserName = (name: string): boolean => /^cp_[0-9a-f]{32}$/.test(name);

/** The database id behind an engine user name, or null for a name this service did not make. */
export function idFromEngineUserName(name: string): string | null {
  if (!isEngineUserName(name)) return null;
  const h = name.slice(3);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Turns HMAC output into PASSWORD_LENGTH letters and digits without bias (rejection sampling over more HMAC blocks). */
function toAlphabet(key: Buffer, label: string): string {
  let out = "";
  for (let block = 0; out.length < PASSWORD_LENGTH; block++) {
    const bytes = createHmac("sha256", key).update(`${label}\u0000${block}`).digest();
    for (const b of bytes) {
      if (b >= 248) continue; // 248 = 4 * 62: larger values would favour the first letters
      out += ALPHABET[b % 62];
      if (out.length === PASSWORD_LENGTH) break;
    }
  }
  return out;
}

/** The password of a database's engine user under one key version. Deterministic: same key, same id, same password. */
export function deriveEnginePassword(key: EngineUserKey, id: string): string {
  const db = engineName(id);
  return toAlphabet(key.secret, `fenvix-engine-user\u0000${key.version}\u0000${db}`);
}

export function engineCredential(key: EngineUserKey, id: string): EngineCredential {
  return { username: engineUserName(id), password: deriveEnginePassword(key, id), authSource: engineName(id), version: key.version };
}

/** Two keys are the same secret (constant time). Used to refuse configurations that reuse one secret for two purposes. */
export function sameSecret(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
