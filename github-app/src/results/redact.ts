/**
 * Failure text is stored and shown to every member of the organization (audit G-1787). A test that prints a token, a
 * connection string, a private key or a person's e-mail in its assertion must not keep it there forever: such values
 * are replaced before anything is stored. The rest of the message (what failed, where) is kept.
 */
const RULES: [RegExp, string | ((...m: string[]) => string)][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted private key]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g, "[redacted GitHub token]"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted AWS key id]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "[redacted Slack token]"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted API key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted JWT]"],
  [/\bfx[rsm]1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted fenvix credential]"],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, (_m, scheme) => `${scheme} [redacted]`],
  // user:password@ in any URL (database, broker, git)
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, (_m, head) => `${head}:[redacted]@`],
  // password=..., "secret": "...", api_key: ...
  [/\b((?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"',;)}]{3,})/gi, (_m, k) => `${k}[redacted]`],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, by] of RULES) out = out.replace(re, by as never);
  return out;
}
