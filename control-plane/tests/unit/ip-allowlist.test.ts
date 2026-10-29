import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ENTRIES, networkContains, parseNetwork, validateEntries } from "../../src/engine/netlist.ts";

/**
 * The control plane's copy of the engine's rules for an IP allowlist entry (Mircoguidetti/test5 @ 1c9fee7,
 * mongo-server/src/netguard.rs: Net::parse, validate_entries). The first two tests are the engine's own unit test
 * vectors, word for word; the rest pin the corners of Rust's address parser and printer that the engine relies on.
 * tests/engine-real/network.test.ts sends the same corpus to the real engine and compares every answer.
 */
const canon = (s: string) => {
  const r = parseNetwork(s);
  assert.ok(r.ok, `${JSON.stringify(s)} refused: ${r.ok ? "" : r.problem}`);
  return r.text;
};
const refused = (s: string) => {
  const r = parseNetwork(s);
  assert.ok(!r.ok, `${JSON.stringify(s)} accepted as ${r.ok ? r.text : ""}`);
  return r.problem;
};

test("engine vectors: parses and canonicalizes", () => {
  assert.equal(canon("10.0.0.0/8"), "10.0.0.0/8");
  assert.equal(canon("1.2.3.4"), "1.2.3.4/32");
  assert.equal(canon("2001:DB8::/32"), "2001:db8::/32");
  assert.equal(canon("2001:db8::1"), "2001:db8::1/128");
  assert.equal(canon("::ffff:10.0.0.0/104"), "10.0.0.0/8");
  assert.equal(canon("::ffff:1.2.3.4"), "1.2.3.4/32");
  assert.equal(canon("::ffff:0:0/96"), "0.0.0.0/0");
  assert.equal(canon("0.0.0.0/0"), "0.0.0.0/0");
  assert.equal(canon("::/0"), "::/0");
  assert.equal(canon("::1"), "::1/128");
});

test("engine vectors: refuses bad entries", () => {
  for (const bad of ["", " ", "10.0.0.0/33", "::/129", "10.0.0.1/8", "2001:db8::1/32", "300.1.1.1", "1.2.3", "010.0.0.1", "10.0.0.0/08", "10.0.0.0/+8",
    "10.0.0.0/-1", "10.0.0.0/", "/8", " 10.0.0.0/8", "10.0.0.0/8 ", "fe80::1%eth0", "::ffff:1.2.3.4/200", "::ffff:10.0.0.0/90", "abc", "*",
    "١٠.0.0.0/8", "1.2.3.4/32/32", "0x0a.0.0.1", "10.0.0.0/0008", "1:2:3:4:5:6:7:8:9"]) refused(bad);
  assert.throws(() => validateEntries(["10.0.0.0/8", "::ffff:10.0.0.0/104"]));
  assert.throws(() => validateEntries(["1.2.3.4", "1.2.3.4/32"]));
  const hundred = Array.from({ length: 100 }, (_, i) => `10.0.0.${i}`);
  assert.equal(validateEntries(hundred).length, 100);
  assert.throws(() => validateEntries(Array.from({ length: 101 }, (_, i) => `10.0.0.${i}`)));
  assert.throws(() => validateEntries([5]));
  assert.throws(() => validateEntries("10.0.0.0/8"));
  assert.equal(MAX_ENTRIES, 100);
});

test("IPv6 is printed the way the engine prints it (lowercase, longest run of zero groups as ::, a single zero group kept)", () => {
  assert.equal(canon("2001:0DB8:0000:0000:0000:0000:0000:0001"), "2001:db8::1/128");
  assert.equal(canon("2001:db8:0:1:0:0:0:1"), "2001:db8:0:1::1/128");
  assert.equal(canon("2001:db8:0:0:1:0:0:1"), "2001:db8::1:0:0:1/128", "the first of two equal runs");
  assert.equal(canon("2001:db8:1:1:1:1:0:1"), "2001:db8:1:1:1:1:0:1/128", "one zero group is not compressed");
  assert.equal(canon("1:2:3:4:5:6:7::"), "1:2:3:4:5:6:7:0/128");
  assert.equal(canon("::"), "::/128");
  assert.equal(canon("fe80::/10"), "fe80::/10");
  assert.equal(canon("::1.2.3.4"), "::102:304/128", "IPv4-compatible (not mapped) stays IPv6");
  assert.equal(canon("::ffff:a00:0/104"), "10.0.0.0/8", "mapped, written in hex");
  assert.equal(canon("2001:db8::/48"), "2001:db8::/48");
  assert.equal(canon("0:0:0:0:0:0:0:0/0"), "::/0");
});

test("the address parser's corners, as Rust parses them", () => {
  for (const bad of ["1:2:3:4:5:6:7::8", "1::2::3", ":::", "1:2:3:4:5:6:7", "12345::", "::1.2.3", "::1.2.3.04", "1.2.3.4::", "::1.2.3.4:5",
    "1:2:3:4:5:6:1.2.3.4:8", "[::1]", "::g", "1.2.3.4.5", "1..2.3", "256.0.0.0", "1.2.3.4/", "1.2.3.4/1/", "a".repeat(50), "1:2:3:4:5:6:7:8/129"]) refused(bad);
  assert.equal(canon("1:2:3:4:5:6:1.2.3.4"), "1:2:3:4:5:6:102:304/128");
  assert.equal(canon("0001:0002::"), "1:2::/128", "leading zeros in a group are allowed");
  assert.equal(canon("255.255.255.255/32"), "255.255.255.255/32");
  assert.equal(canon("0.0.0.0"), "0.0.0.0/32");
  assert.equal(canon("0:0:1::"), "0:0:1::/128", "the longest run of zero groups, not the first");
  assert.equal(canon("1:0:0:2:0:0:0:3"), "1:0:0:2::3/128");
  refused("10.0.0.0/0x"); // a hex digit, not a digit, in the prefix
  assert.match(refused("10.0.0.0/0"), /bits set after the prefix.*0\.0\.0\.0\/0/);
});

test("messages name the entry and say what is wrong, in words a person can act on", () => {
  assert.match(refused("10.0.0.1/8"), /bits set after the prefix.*10\.0\.0\.0\/8/);
  assert.match(refused("10.0.0.0/33"), /\/32/);
  assert.match(refused("fe80::1%eth0"), /character/);
  assert.match(refused(""), /empty/);
  assert.match(refused("a".repeat(50)), /too long/);
  const refusal = (list: unknown[]) => { try { validateEntries(list); } catch (x) { return x as { index: number; message: string }; } return null; };
  const e = refusal(["10.0.0.0/8", "203.0.113.7", "1.2.3.4/32/32"]);
  assert.equal(e?.index, 2);
  assert.match(e!.message, /^Entry 3 \("1\.2\.3\.4\/32\/32"\)/);
  const d = refusal(["1.2.3.4", "10.0.0.0/8", "1.2.3.4/32"]);
  assert.match(d!.message, /same network as entry 1 \(1\.2\.3\.4\/32\)/);
  assert.match(refusal(Array(101).fill("1.1.1.1"))!.message, /at most 100/);
});

test("the list comes back in the engine's form, in the order given", () => {
  assert.deepEqual(validateEntries(["2001:DB8::1", "10.0.0.0/8", "::ffff:192.0.2.1"]), ["2001:db8::1/128", "10.0.0.0/8", "192.0.2.1/32"]);
  assert.deepEqual(validateEntries([]), []);
});

test("contains: an IPv4 network holds IPv4 peers (mapped ones too), never IPv6 ones; ::/0 holds no IPv4 peer", () => {
  assert.equal(networkContains("10.0.0.0/8", "10.255.1.2"), true);
  assert.equal(networkContains("10.0.0.0/8", "11.0.0.1"), false);
  assert.equal(networkContains("10.0.0.0/8", "::ffff:10.1.1.1"), true);
  assert.equal(networkContains("127.0.0.1/32", "127.0.0.2"), false);
  assert.equal(networkContains("172.17.0.0/16", "172.17.0.1"), true);
  assert.equal(networkContains("::/0", "1.2.3.4"), false);
  assert.equal(networkContains("2001:db8::/32", "2001:db8:ffff::1"), true);
  assert.equal(networkContains("0.0.0.0/0", "8.8.8.8"), true);
});

test("the dashboard's copy (src/lib/ip-allowlist.ts) gives the same answer for every entry and list", async () => {
  const dash = await import("../../../src/lib/ip-allowlist.ts");
  const corpus = [
    "10.0.0.0/8", "1.2.3.4", "2001:DB8::/32", "::ffff:10.0.0.0/104", "::ffff:0:0/96", "::/0", "::1", "", " ", "10.0.0.0/33", "::/129", "10.0.0.1/8",
    "2001:db8::1/32", "300.1.1.1", "010.0.0.1", "10.0.0.0/08", "fe80::1%eth0", "::ffff:10.0.0.0/90", "١٠.0.0.0/8", "1.2.3.4/32/32", "0x0a.0.0.1",
    "1:2:3:4:5:6:7::", "1:2:3:4:5:6:7::8", "::1.2.3.4", "::1.2.3.04", "1:2:3:4:5:6:1.2.3.4", "0:0:1::", "2001:db8:0:0:1:0:0:1", "a".repeat(50),
    "fd00::1/8", "8.8.8.9/31", "::ffff:192.168.1.1/120", "１.2.3.4", "abcd:ef01:2345:6789:abcd:ef01:2345:6789", "::0:0:0:0:0:0:0", "1.0.0.0/9",
  ];
  for (const e of corpus) assert.deepEqual(dash.parseNetwork(e), parseNetwork(e), JSON.stringify(e));
  const lists: unknown[] = [["1.2.3.4", "1.2.3.4/32"], Array.from({ length: 101 }, (_, i) => `10.0.${i}.0/24`), [5], "x", ["2001:db8::/32", "10.0.0.0/8"]];
  for (const l of lists) {
    const a = (() => { try { return validateEntries(l); } catch (e) { return (e as Error).message; } })();
    const b = (() => { try { return dash.validateEntries(l); } catch (e) { return (e as Error).message; } })();
    assert.deepEqual(b, a);
  }
  assert.equal(dash.MAX_ENTRIES, MAX_ENTRIES);
});
