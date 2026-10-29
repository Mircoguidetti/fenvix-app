// The Network tab's rules for IP allowlist entries (src/lib/ip-allowlist.ts): a copy of the control plane's, which is a
// copy of the engine's. control-plane/tests/unit/ip-allowlist.test.ts checks that the two copies agree on a corpus.
//   npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import { addEntries, parseImport, parseNetwork, validateEntries } from "../../src/lib/ip-allowlist.ts";

test("one entry: the engine's form, or a sentence a person can act on", () => {
  assert.deepEqual(parseNetwork("203.0.113.7").ok && parseNetwork("203.0.113.7"), { ok: true, text: "203.0.113.7/32", net: { v6: false, bytes: [203, 0, 113, 7], bits: 32 } });
  const r = parseNetwork("10.0.0.1/8");
  assert.ok(!r.ok && /The network is 10\.0\.0\.0\/8/.test(r.problem));
  assert.ok(!parseNetwork("example.com").ok);
  assert.equal(validateEntries(["2001:DB8::/32"])[0], "2001:db8::/32");
});

test("import: one per line, commas, spaces and tabs all separate; blank lines and # comments are skipped", () => {
  const r = parseImport("203.0.113.7\n10.0.0.0/8, 192.0.2.0/24\t2001:db8::/32\n\n# office\n  198.51.100.1  # the VPN gateway\n");
  assert.deepEqual(r.entries, ["203.0.113.7/32", "10.0.0.0/8", "192.0.2.0/24", "2001:db8::/32", "198.51.100.1/32"]);
  assert.deepEqual(r.problems, []);
});

test("import: every bad entry is reported with its line, good ones are kept, duplicates inside the paste are dropped", () => {
  const r = parseImport("10.0.0.1/8\n1.2.3.4\n1.2.3.4/32\nnope\n");
  assert.deepEqual(r.entries, ["1.2.3.4/32"]);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0]!, /^Line 1: "10\.0\.0\.1\/8" has address bits set/);
  assert.match(r.problems[1]!, /^Line 4: "nope"/);
  assert.equal(r.duplicates, 1);
});

test("adding to a list: the result is checked as a whole (duplicates with what is there, at most 100)", () => {
  assert.deepEqual(addEntries(["10.0.0.0/8"], ["192.0.2.1/32"]), { list: ["10.0.0.0/8", "192.0.2.1/32"], skipped: 0 });
  assert.deepEqual(addEntries(["10.0.0.0/8"], ["10.0.0.0/8", "192.0.2.1/32"]), { list: ["10.0.0.0/8", "192.0.2.1/32"], skipped: 1 });
  const full = Array.from({ length: 100 }, (_, i) => `10.0.${i}.0/24`);
  assert.throws(() => addEntries(full, ["192.0.2.1/32"]), /at most 100/);
});
