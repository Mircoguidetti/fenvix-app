// Prints the SCRAM-SHA-256 verifier of a password, for `alter role ... password '<verifier>'`: Postgres stores it as
// given, so the password itself never enters the Supabase SQL editor (or its query history). The password is read
// from standard input; nothing is written anywhere else.
//   printf '%s' "$DB_PASSWORD" | node scripts/scram-verifier.mjs
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

export function scramVerifier(password, salt = randomBytes(16), iterations = 4096) {
  // RFC 5802 / 7677 (Postgres: SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>). Postgres applies SASLprep;
  // an ASCII password (openssl rand -base64) is unchanged by it.
  if (!/^[\x20-\x7e]+$/.test(password)) throw new Error("use an ASCII password (openssl rand -base64 36)");
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const pw = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (!pw) { console.error("no password on standard input"); process.exit(2); }
  console.log(scramVerifier(pw));
}
