/**
 * IP allowlist entries, checked exactly as the engine checks them (Mircoguidetti/test5 @ 1c9fee7,
 * mongo-server/src/netguard.rs: `Net::parse`, `validate_entries`, `Display`), so that a list this service accepts is
 * a list the engine accepts, and what is saved is the engine's own form of every entry.
 *
 * An entry is `a.b.c.d`, `a.b.c.d/n`, or an IPv6 address with or without `/n`, written with hex digits, `.`, `:` and
 * `/` only: no spaces, zone ids, signs, leading zeros in the prefix or in an IPv4 part, and no address bits after the
 * prefix (`10.0.0.1/8` is refused, not corrected). A single address becomes `/32` or `/128`; an IPv4-mapped IPv6
 * network (`::ffff:10.0.0.0/104`) is the IPv4 network (`10.0.0.0/8`); IPv6 is printed in lowercase with the longest
 * run of zero groups as `::`. At most 100 entries, no two the same once in that form.
 *
 * Kept free of imports: the dashboard has a copy (src/lib/ip-allowlist.ts) and tests/unit/ip-allowlist.test.ts checks
 * that both give the same answers. tests/engine-real/network.test.ts checks the answers against the real engine.
 */
export const MAX_ENTRIES = 100;
const MAX_LENGTH = 49;

interface Net { v6: boolean; bytes: number[]; bits: number }

export type ParsedNetwork = { ok: true; text: string; net: Net } | { ok: false; problem: string };

/** `a.b.c.d`: four decimal parts of 1 to 3 digits, 0 to 255, no leading zero. Null when it is not one. */
function ipv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9]{1,3}$/.test(p) || (p.length > 1 && p[0] === "0")) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Groups separated by single colons, each 1 to 4 hex digits, the last pair possibly an IPv4 address. */
function groups(s: string, allowV4: boolean): number[] | null {
  if (s === "") return [];
  const parts = s.split(":");
  const out: number[] = [];
  for (const [i, p] of parts.entries()) {
    if (allowV4 && i === parts.length - 1 && p.includes(".")) {
      const v4 = ipv4(p);
      if (!v4) return null;
      out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
  }
  return out;
}

/** An IPv6 address as 8 groups, as Rust's parser reads it (at most one `::`, which stands for at least one group). */
function ipv6(s: string): number[] | null {
  const halves = s.split("::");
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const g = groups(s, true);
    return g && g.length === 8 ? g : null;
  }
  // An IPv4 address can only end the address, so not before the `::`.
  const head = groups(halves[0]!, false);
  const tail = groups(halves[1]!, true);
  if (!head || !tail || head.length + tail.length > 7) return null;
  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

const toBytes = (g: number[]) => g.flatMap((x) => [x >> 8, x & 0xff]);

function mask(bytes: number[], bits: number): number[] {
  return bytes.map((b, i) => {
    const keep = Math.max(0, Math.min(8, bits - i * 8));
    return keep === 0 ? 0 : b & (0xff << (8 - keep)) & 0xff;
  });
}

function show(n: Net): string {
  if (!n.v6) return `${n.bytes.join(".")}/${n.bits}`;
  const g = Array.from({ length: 8 }, (_, i) => (n.bytes[2 * i]! << 8) | n.bytes[2 * i + 1]!);
  // The longest run of zero groups (the first of equal ones), only when it is longer than one group.
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = (a: number[]) => a.map((x) => x.toString(16)).join(":");
  const text = bestLen > 1 ? `${hex(g.slice(0, best))}::${hex(g.slice(best + bestLen))}` : hex(g);
  return `${text}/${n.bits}`;
}

/** One entry, or the reason it is refused (a sentence without the entry itself; validateEntries adds it). */
export function parseNetwork(s: string): ParsedNetwork {
  const no = (problem: string): ParsedNetwork => ({ ok: false, problem });
  if (s.length === 0) return no("is empty.");
  if (new TextEncoder().encode(s).length > MAX_LENGTH) return no("is too long to be an address or a network.");
  const bad = [...s].find((c) => !/^[0-9a-fA-F.:/]$/.test(c));
  if (bad !== undefined) return no(`contains a character that is not allowed (${JSON.stringify(bad)}). Use digits, a to f, dots, colons and one slash.`);
  const slash = s.indexOf("/");
  const a = slash < 0 ? s : s.slice(0, slash);
  const p = slash < 0 ? null : s.slice(slash + 1);
  const v4 = ipv4(a);
  const v6 = v4 ? null : ipv6(a);
  if (!v4 && !v6) return no("is not an IPv4 or IPv6 address.");
  const max = v4 ? 32 : 128;
  let bits = max;
  if (p !== null) {
    if (!/^[0-9]{1,3}$/.test(p) || (p.length > 1 && p[0] === "0")) return no("has a prefix length that is not a whole number written without leading zeros.");
    bits = Number(p);
    if (bits > max) return no(`has a prefix length /${bits}, larger than /${max}.`);
  }
  let net: Net = v4 ? { v6: false, bytes: v4, bits } : { v6: true, bytes: toBytes(v6!), bits };
  // IPv4-mapped (::ffff:a.b.c.d): the IPv4 network.
  if (net.v6 && net.bytes.slice(0, 10).every((b) => b === 0) && net.bytes[10] === 0xff && net.bytes[11] === 0xff) {
    if (bits < 96) return no(`is an IPv4-mapped network with a prefix /${bits}; it needs at least /96.`);
    net = { v6: false, bytes: net.bytes.slice(12), bits: bits - 96 };
  }
  const masked = mask(net.bytes, net.bits);
  if (masked.some((b, i) => b !== net.bytes[i])) {
    return no(`has address bits set after the prefix length. The network is ${show({ ...net, bytes: masked })}: use that, or a longer prefix.`);
  }
  return { ok: true, text: show(net), net };
}

/** A refused list: the entry (0-based), and a message that names it 1-based for people. */
export class AllowlistError extends Error {
  readonly index: number | null;
  constructor(message: string, index: number | null = null) {
    super(message);
    this.index = index;
  }
}

/** Shown in messages: the entry as given, at most 60 characters, quoted. */
const quote = (s: string) => JSON.stringify([...s].slice(0, 60).join(""));

/** The list in the engine's form, in the order given, or an AllowlistError naming the first faulty entry. */
export function validateEntries(v: unknown): string[] {
  if (!Array.isArray(v)) throw new AllowlistError("entries must be a list of addresses or networks (CIDR).");
  if (v.length > MAX_ENTRIES) throw new AllowlistError(`The list has ${v.length} entries; at most ${MAX_ENTRIES} are allowed.`);
  const out: string[] = [];
  for (const [i, e] of v.entries()) {
    if (typeof e !== "string") throw new AllowlistError(`Entry ${i + 1} is not text. Write each address or network as text, for example 203.0.113.7 or 10.0.0.0/8.`, i);
    const r = parseNetwork(e);
    if (!r.ok) throw new AllowlistError(`Entry ${i + 1} (${quote(e)}) ${r.problem}`, i);
    const j = out.indexOf(r.text);
    if (j >= 0) throw new AllowlistError(`Entry ${i + 1} (${quote(e)}) is the same network as entry ${j + 1} (${out[j]}). Remove one of them.`, i);
    out.push(r.text);
  }
  return out;
}

/** An address as bytes; an IPv4-mapped IPv6 address is the IPv4 address. Null when it is not an address. */
function address(ip: string): Net | null {
  const v4 = ipv4(ip);
  if (v4) return { v6: false, bytes: v4, bits: 32 };
  const v6 = ipv6(ip);
  if (!v6) return null;
  const b = toBytes(v6);
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return { v6: false, bytes: b.slice(12), bits: 32 };
  return { v6: true, bytes: b, bits: 128 };
}

/** Is the address in the network? An IPv4 network holds IPv4 addresses only, an IPv6 network IPv6 ones only (as the engine). */
export function networkContains(network: string, ip: string): boolean {
  const n = parseNetwork(network);
  const a = address(ip);
  if (!n.ok || !a || n.net.v6 !== a.v6) return false;
  return mask(a.bytes, n.net.bits).every((b, i) => b === n.net.bytes[i]);
}

/** One address (no prefix) in the engine's form, or null when the text is not one address. */
export function canonicalAddress(ip: string): string | null {
  if (ip.includes("/")) return null;
  const r = parseNetwork(ip);
  return r.ok ? r.text.slice(0, r.text.lastIndexOf("/")) : null;
}
